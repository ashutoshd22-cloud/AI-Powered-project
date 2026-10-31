"""Task domain logic shared by the REST API, AI features, calendar import and sync."""

import re
import uuid
from datetime import datetime, timedelta
from typing import Any

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import Goal, Task, TaskSource, TaskStatus, User, utcnow
from app.services import activity

_NON_WORD = re.compile(r"[^\w\s]", re.UNICODE)
_SPACES = re.compile(r"\s+")


def normalise_title(title: str) -> str:
    """Key used for duplicate detection: case-, punctuation- and whitespace-insensitive."""
    return _SPACES.sub(" ", _NON_WORD.sub(" ", title.casefold())).strip()[:200]


def get_owned_task(db: Session, user: User, task_id: uuid.UUID, include_deleted: bool = False) -> Task:
    task = db.get(Task, task_id)
    if task is None or task.user_id != user.id or (task.deleted_at is not None and not include_deleted):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Task not found")
    return task


def find_open_duplicate(db: Session, user: User, title: str, exclude: uuid.UUID | None = None) -> Task | None:
    key = normalise_title(title)
    if not key:
        return None
    stmt = select(Task).where(
        Task.user_id == user.id,
        Task.dedupe_key == key,
        Task.deleted_at.is_(None),
        Task.status != TaskStatus.done.value,
    )
    if exclude is not None:
        stmt = stmt.where(Task.id != exclude)
    return db.scalars(stmt.limit(1)).first()


def _check_goal(db: Session, user: User, goal_id: uuid.UUID | None) -> None:
    if goal_id is None:
        return
    goal = db.get(Goal, goal_id)
    if goal is None or goal.user_id != user.id:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail="Goal not found")


def _default_reminder(user: User, due_at: datetime | None, due_has_time: bool) -> datetime | None:
    if not due_at or not due_has_time or user.default_reminder_minutes <= 0:
        return None
    remind = due_at - timedelta(minutes=user.default_reminder_minutes)
    return remind if remind > utcnow() else None


def apply_fields(db: Session, user: User, task: Task, fields: dict[str, Any], creating: bool) -> None:
    """Apply validated fields (only those explicitly provided) to `task`."""
    if "goal_id" in fields:
        _check_goal(db, user, fields["goal_id"])

    old_due = task.due_at
    for name in (
        "title",
        "description",
        "priority",
        "category",
        "status",
        "due_at",
        "due_has_time",
        "scheduled_for",
        "remind_at",
        "estimated_minutes",
        "goal_id",
        "recurrence",
    ):
        if name not in fields:
            continue
        value = fields[name]
        if name in {"priority", "status"} and value is not None:
            value = str(value.value if hasattr(value, "value") else value)
        if name == "category":
            value = (value or "").strip() or None
        if name == "description":
            value = value or ""
        if name in {"title", "priority", "status", "due_has_time"} and value is None:
            continue  # not nullable: treat explicit null as "unchanged"
        setattr(task, name, value)

    if task.due_at is None:
        task.due_has_time = False

    # Smart default reminder: only when the caller did not decide about reminders explicitly.
    if "remind_at" not in fields and task.due_at != old_due:
        if creating or task.remind_at is not None or old_due is None:
            task.remind_at = _default_reminder(user, task.due_at, task.due_has_time)
    if "remind_at" in fields or task.due_at != old_due:
        task.reminder_sent_at = None

    if "status" in fields and fields["status"] is not None:
        if task.status == TaskStatus.done.value:
            task.completed_at = task.completed_at or utcnow()
        else:
            task.completed_at = None

    if task.recurrence and task.due_at is None:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail="A repeating task needs a due date"
        )
    if task.recurrence and task.series_id is None:
        task.series_id = task.id

    task.dedupe_key = normalise_title(task.title)


def create_task(
    db: Session,
    user: User,
    fields: dict[str, Any],
    source: TaskSource | str = TaskSource.manual,
    task_id: uuid.UUID | None = None,
    external_uid: str | None = None,
) -> Task:
    now = utcnow()
    task = Task(
        id=task_id or uuid.uuid4(),
        user_id=user.id,
        title="",
        source=str(source.value if isinstance(source, TaskSource) else source),
        external_uid=external_uid,
        version=1,
        created_at=now,
        updated_at=now,
    )
    apply_fields(db, user, task, fields, creating=True)
    db.add(task)
    activity.record(db, user.id, "task.created", "task", f"Created task “{task.title}”", task.id)
    return task


def update_task(db: Session, user: User, task: Task, fields: dict[str, Any]) -> Task:
    was_done = task.status == TaskStatus.done.value
    apply_fields(db, user, task, fields, creating=False)
    task.version += 1
    task.updated_at = utcnow()
    is_done = task.status == TaskStatus.done.value
    if is_done and not was_done:
        activity.record(db, user.id, "task.completed", "task", f"Completed “{task.title}”", task.id)
        schedule_next_occurrence(db, user, task)
    elif was_done and not is_done:
        activity.record(db, user.id, "task.reopened", "task", f"Reopened “{task.title}”", task.id)
    else:
        changed = ", ".join(sorted(k for k in fields if k != "version")) or "no fields"
        activity.record(db, user.id, "task.updated", "task", f"Updated “{task.title}” ({changed})", task.id)
    return task


def soft_delete_task(db: Session, user: User, task: Task) -> None:
    now = utcnow()
    task.deleted_at = now
    task.updated_at = now
    task.version += 1
    activity.record(db, user.id, "task.deleted", "task", f"Deleted “{task.title}”", task.id)


def restore_task(db: Session, user: User, task: Task) -> None:
    task.deleted_at = None
    task.updated_at = utcnow()
    task.version += 1
    activity.record(db, user.id, "task.restored", "task", f"Restored “{task.title}”", task.id)


def schedule_next_occurrence(db: Session, user: User, task: Task) -> Task | None:
    """Create the next task of a repeating series when one occurrence is completed.

    The new id is derived from the series and the next due date, so completing the same occurrence
    twice (reopen + complete, retried sync, two devices) can never create duplicates.
    """
    if not task.recurrence or task.due_at is None or task.deleted_at is not None:
        return None
    from app.services import recurrence  # local import keeps module dependencies one-way

    try:
        next_at = recurrence.next_due(task.recurrence, task.due_at, task.due_has_time, user.timezone, utcnow())
    except recurrence.RecurrenceError:
        return None
    if next_at is None:
        return None
    series = task.series_id or task.id
    next_id = uuid.uuid5(series, next_at.isoformat())
    existing = db.get(Task, next_id)
    if existing is not None:
        return existing
    fields: dict[str, Any] = {
        "title": task.title,
        "description": task.description,
        "priority": task.priority,
        "category": task.category,
        "due_at": next_at,
        "due_has_time": task.due_has_time,
        "estimated_minutes": task.estimated_minutes,
        "goal_id": task.goal_id,
        "recurrence": task.recurrence,
    }
    if task.remind_at is not None:
        # Keep the same lead time as the completed occurrence.
        fields["remind_at"] = next_at - (task.due_at - task.remind_at)
    nxt = create_task(db, user, fields, source=task.source, task_id=next_id)
    nxt.series_id = series
    db.flush()
    return nxt
