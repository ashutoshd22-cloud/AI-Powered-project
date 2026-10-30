import uuid
from datetime import date, datetime, timedelta
from typing import Annotated, Any, Literal

from fastapi import APIRouter, HTTPException, Query, Response, status
from sqlalchemy import ColumnElement, and_, case, func, or_, select

from app.deps import CurrentUser, DbSession
from app.models import Priority, Task, TaskStatus, utcnow
from app.schemas import TaskCreate, TaskOut, TaskPage, TaskUpdate
from app.services import tasks as task_service
from app.services.timeutil import local_date_of, local_day_bounds, today_local

router = APIRouter(tags=["tasks"])

SortKey = Literal["due", "-due", "priority", "created", "-created", "updated", "-updated"]
_PRIORITY_ORDER = {"urgent": 0, "high": 1, "medium": 2, "low": 3}


def _escape_like(term: str) -> str:
    return term.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


@router.get("/tasks", response_model=TaskPage)
def list_tasks(
    user: CurrentUser,
    db: DbSession,
    q: Annotated[str | None, Query(max_length=200)] = None,
    status_: Annotated[TaskStatus | None, Query(alias="status")] = None,
    priority: Priority | None = None,
    category: Annotated[str | None, Query(max_length=50)] = None,
    goal_id: uuid.UUID | None = None,
    include_done: bool = True,
    overdue: bool = False,
    due_from: datetime | None = None,
    due_to: datetime | None = None,
    sort: SortKey = "due",
    page: Annotated[int, Query(ge=1, le=10_000)] = 1,
    page_size: Annotated[int, Query(ge=1, le=200)] = 50,
) -> TaskPage:
    stmt = select(Task).where(Task.user_id == user.id, Task.deleted_at.is_(None))
    if q:
        pattern = f"%{_escape_like(q.strip())}%"
        stmt = stmt.where(or_(Task.title.ilike(pattern, escape="\\"), Task.description.ilike(pattern, escape="\\")))
    if status_ is not None:
        stmt = stmt.where(Task.status == status_.value)
    elif not include_done:
        stmt = stmt.where(Task.status != TaskStatus.done.value)
    if priority is not None:
        stmt = stmt.where(Task.priority == priority.value)
    if category:
        stmt = stmt.where(Task.category == category)
    if goal_id is not None:
        stmt = stmt.where(Task.goal_id == goal_id)
    if overdue:
        stmt = stmt.where(Task.due_at < utcnow(), Task.status != TaskStatus.done.value)
    if due_from is not None:
        stmt = stmt.where(Task.due_at >= due_from)
    if due_to is not None:
        stmt = stmt.where(Task.due_at < due_to)

    total = db.scalar(select(func.count()).select_from(stmt.subquery())) or 0
    orderings: dict[str, list[ColumnElement[Any]]] = {
        "due": [Task.due_at.is_(None), Task.due_at.asc(), Task.created_at.asc()],
        "-due": [Task.due_at.is_(None), Task.due_at.desc()],
        "created": [Task.created_at.asc()],
        "-created": [Task.created_at.desc()],
        "updated": [Task.updated_at.asc()],
        "-updated": [Task.updated_at.desc()],
        "priority": [case(_PRIORITY_ORDER, value=Task.priority, else_=4), Task.due_at.is_(None), Task.due_at.asc()],
    }
    order = orderings[sort]
    rows = db.scalars(stmt.order_by(*order, Task.id).offset((page - 1) * page_size).limit(page_size))
    return TaskPage(items=[TaskOut.model_validate(t) for t in rows], total=total, page=page, page_size=page_size)


@router.get("/tasks/categories", response_model=list[str])
def list_categories(user: CurrentUser, db: DbSession) -> list[str]:
    rows = db.scalars(
        select(Task.category)
        .where(Task.user_id == user.id, Task.deleted_at.is_(None), Task.category.is_not(None))
        .distinct()
        .order_by(Task.category)
        .limit(200)
    )
    return [c for c in rows if c]


@router.post("/tasks", response_model=TaskOut, status_code=status.HTTP_201_CREATED)
def create_task(body: TaskCreate, user: CurrentUser, db: DbSession, response: Response) -> Task:
    if body.id is not None:
        existing = db.get(Task, body.id)
        if existing is not None:
            if existing.user_id != user.id:
                raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Task id already in use")
            response.status_code = status.HTTP_200_OK  # idempotent replay
            return existing
    fields = body.model_dump(exclude_unset=True, exclude={"id", "source"})
    fields["title"] = body.title
    task = task_service.create_task(db, user, fields, source=body.source, task_id=body.id)
    db.commit()
    return task


@router.get("/tasks/{task_id}", response_model=TaskOut)
def get_task(task_id: uuid.UUID, user: CurrentUser, db: DbSession) -> Task:
    return task_service.get_owned_task(db, user, task_id)


@router.patch("/tasks/{task_id}", response_model=TaskOut)
def update_task(task_id: uuid.UUID, body: TaskUpdate, user: CurrentUser, db: DbSession) -> Task:
    task = task_service.get_owned_task(db, user, task_id)
    if body.version is not None and body.version != task.version:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "message": "The task was modified elsewhere",
                "current": TaskOut.model_validate(task).model_dump(mode="json"),
            },
        )
    fields = body.model_dump(exclude_unset=True, exclude={"version"})
    task_service.update_task(db, user, task, fields)
    db.commit()
    return task


@router.delete("/tasks/{task_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_task(task_id: uuid.UUID, user: CurrentUser, db: DbSession) -> Response:
    task = task_service.get_owned_task(db, user, task_id)
    task_service.soft_delete_task(db, user, task)
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/tasks/{task_id}/restore", response_model=TaskOut)
def restore_task(task_id: uuid.UUID, user: CurrentUser, db: DbSession) -> Task:
    task = task_service.get_owned_task(db, user, task_id, include_deleted=True)
    if task.deleted_at is not None:
        task_service.restore_task(db, user, task)
        db.commit()
    return task


# --------------------------------------------------------------------------- planning
@router.get("/planning", tags=["planning"])
def planning(
    user: CurrentUser,
    db: DbSession,
    view: Literal["day", "week", "month"] = "day",
    date_: Annotated[date | None, Query(alias="date")] = None,
) -> dict[str, object]:
    tz = user.timezone
    today = today_local(tz)
    anchor = date_ or today
    if view == "day":
        start = end = anchor
    elif view == "week":
        start = anchor - timedelta(days=anchor.weekday())
        end = start + timedelta(days=6)
    else:
        start = anchor.replace(day=1)
        end = (start + timedelta(days=32)).replace(day=1) - timedelta(days=1)
    range_start, range_end = local_day_bounds(start, end, tz)

    base = select(Task).where(Task.user_id == user.id, Task.deleted_at.is_(None))
    rows = list(
        db.scalars(
            base.where(
                or_(
                    and_(Task.due_at >= range_start, Task.due_at < range_end),
                    Task.scheduled_for.between(start, end),
                )
            ).order_by(Task.due_at.is_(None), Task.due_at, Task.created_at)
        )
    )
    days: dict[str, list[TaskOut]] = {}
    for i in range((end - start).days + 1):
        days[(start + timedelta(days=i)).isoformat()] = []
    for t in rows:
        if t.due_at is not None and range_start <= t.due_at < range_end:
            key = local_date_of(t.due_at, tz).isoformat()
        else:
            assert t.scheduled_for is not None
            key = t.scheduled_for.isoformat()
        if key in days:
            days[key].append(TaskOut.model_validate(t))

    overdue: list[TaskOut] = []
    if start <= today <= end:
        overdue = [
            TaskOut.model_validate(t)
            for t in db.scalars(
                base.where(Task.status != TaskStatus.done.value, Task.due_at < range_start)
                .order_by(Task.due_at)
                .limit(100)
            )
        ]
    return {
        "view": view,
        "start": start.isoformat(),
        "end": end.isoformat(),
        "today": today.isoformat(),
        "timezone": tz,
        "days": [{"date": d, "tasks": items} for d, items in days.items()],
        "overdue": overdue,
    }
