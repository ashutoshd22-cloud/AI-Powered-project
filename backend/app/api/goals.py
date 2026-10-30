import uuid

from fastapi import APIRouter, HTTPException, Response, status
from sqlalchemy import select, update

from app.deps import CurrentUser, DbSession
from app.models import Goal, GoalStatus, Task, User, utcnow
from app.schemas import GoalCreate, GoalOut, GoalUpdate
from app.services import activity
from app.services.analytics import goal_progress

router = APIRouter(prefix="/goals", tags=["goals"])


def _out(db: DbSession, user: User, goals: list[Goal]) -> list[GoalOut]:
    progress = goal_progress(db, user, goals)
    result = []
    for g in goals:
        out = GoalOut.model_validate(g)
        out.progress, out.tasks_total, out.tasks_done = progress[g.id]
        result.append(out)
    return result


def _get(db: DbSession, user: User, goal_id: uuid.UUID) -> Goal:
    goal = db.get(Goal, goal_id)
    if goal is None or goal.user_id != user.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Goal not found")
    return goal


@router.get("", response_model=list[GoalOut])
def list_goals(user: CurrentUser, db: DbSession, include_archived: bool = False) -> list[GoalOut]:
    stmt = select(Goal).where(Goal.user_id == user.id)
    if not include_archived:
        stmt = stmt.where(Goal.status != GoalStatus.archived.value)
    goals = list(db.scalars(stmt.order_by(Goal.target_date.is_(None), Goal.target_date, Goal.created_at).limit(500)))
    return _out(db, user, goals)


@router.post("", response_model=GoalOut, status_code=status.HTTP_201_CREATED)
def create_goal(body: GoalCreate, user: CurrentUser, db: DbSession) -> GoalOut:
    goal = Goal(user_id=user.id, **body.model_dump())
    db.add(goal)
    db.flush()
    activity.record(db, user.id, "goal.created", "goal", f"Created goal “{goal.title}”", goal.id)
    db.commit()
    return _out(db, user, [goal])[0]


@router.get("/{goal_id}", response_model=GoalOut)
def get_goal(goal_id: uuid.UUID, user: CurrentUser, db: DbSession) -> GoalOut:
    return _out(db, user, [_get(db, user, goal_id)])[0]


@router.patch("/{goal_id}", response_model=GoalOut)
def update_goal(goal_id: uuid.UUID, body: GoalUpdate, user: CurrentUser, db: DbSession) -> GoalOut:
    goal = _get(db, user, goal_id)
    changes = body.model_dump(exclude_unset=True)
    for key, value in changes.items():
        if key in {"title", "current_value", "unit", "status", "description"} and value is None:
            continue
        setattr(goal, key, value.value if key == "status" else value)
    if goal.status == GoalStatus.active.value and goal.target_value and goal.current_value >= goal.target_value:
        goal.status = GoalStatus.completed.value
        activity.record(db, user.id, "goal.completed", "goal", f"Reached goal “{goal.title}”", goal.id)
    else:
        activity.record(db, user.id, "goal.updated", "goal", f"Updated goal “{goal.title}”", goal.id)
    db.commit()
    return _out(db, user, [goal])[0]


@router.delete("/{goal_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_goal(goal_id: uuid.UUID, user: CurrentUser, db: DbSession) -> Response:
    goal = _get(db, user, goal_id)
    activity.record(db, user.id, "goal.deleted", "goal", f"Deleted goal “{goal.title}”", goal.id)
    # Linked tasks are kept. Unlink them explicitly (not just via the FK) so the change
    # gets a new version and reaches offline clients through sync.
    db.execute(
        update(Task)
        .where(Task.user_id == user.id, Task.goal_id == goal.id)
        .values(goal_id=None, version=Task.version + 1, updated_at=utcnow())
    )
    db.delete(goal)
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
