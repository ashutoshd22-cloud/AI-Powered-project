"""Offline synchronisation for tasks (protocol described in docs/ARCHITECTURE.md §4).

Guarantees:
* An operation based on a stale version is never applied — it is returned as a conflict with
  the server copy so the user can choose, i.e. no silent overwrites in either direction.
* Every operation is recorded by `op_id`, so retried pushes are idempotent.
"""

import uuid
from datetime import datetime, timedelta

from fastapi import HTTPException
from sqlalchemy import and_, or_, select
from sqlalchemy.orm import Session

from app.config import get_settings
from app.models import SyncOp, Task, User, utcnow
from app.schemas import SyncOpIn, SyncOpResult, TaskOut
from app.services import tasks as task_service

PULL_PAGE_SIZE = 500
CURSOR_OVERLAP = timedelta(seconds=10)


def _result(op: SyncOpIn, status: str, task: Task | None = None, error: str | None = None) -> SyncOpResult:
    return SyncOpResult(
        op_id=op.op_id,
        status=status,  # type: ignore[arg-type]
        task=TaskOut.model_validate(task) if task is not None else None,
        error=error,
    )


def _apply(db: Session, user: User, op: SyncOpIn, task: Task | None) -> tuple[str, Task | None, str | None]:
    fields = op.data.model_dump(exclude_unset=True, exclude={"deleted"})
    if op.kind == "delete":
        if task is None:
            return "applied", None, None
        if op.base_version is not None and op.base_version != task.version:
            return "conflict", task, "The task changed on another device before it was deleted here."
        if task.deleted_at is None:
            task_service.soft_delete_task(db, user, task)
        return "applied", task, None

    if task is None:
        if not fields.get("title"):
            return "rejected", None, "A title is required to create a task."
        # base_version set but row missing means the server purged it; recreating keeps the user's data.
        created = task_service.create_task(db, user, fields, task_id=op.task_id)
        return "applied", created, None

    if op.base_version is None or op.base_version != task.version:
        return "conflict", task, "The task was changed elsewhere since this edit was made."
    if op.data.deleted is False and task.deleted_at is not None:
        task_service.restore_task(db, user, task)
        task.version -= 1  # restore + update count as a single change
    task_service.update_task(db, user, task, fields)
    return "applied", task, None


def push(db: Session, user: User, ops: list[SyncOpIn]) -> list[SyncOpResult]:
    results: list[SyncOpResult] = []
    for op in ops:
        task = db.get(Task, op.task_id)
        if task is not None and task.user_id != user.id:
            results.append(_result(op, "rejected", error="This id belongs to another record."))
            continue
        if db.get(SyncOp, (user.id, op.op_id)) is not None:
            results.append(_result(op, "duplicate", task))
            continue
        try:
            with db.begin_nested():
                status, out_task, error = _apply(db, user, op, task)
                if status in ("applied", "rejected"):
                    # Conflicts are not recorded: the client may legitimately resend a resolved op.
                    db.add(SyncOp(user_id=user.id, op_id=op.op_id, status=status))
                db.flush()
        except HTTPException as exc:
            status, out_task, error = "rejected", db.get(Task, op.task_id), str(exc.detail)
        results.append(_result(op, status, out_task, error))
    db.commit()
    return results


def _parse_after(token: str | None) -> tuple[datetime, uuid.UUID] | None:
    if not token:
        return None
    try:
        stamp, raw_id = token.split("|", 1)
        return datetime.fromisoformat(stamp), uuid.UUID(raw_id)
    except ValueError as exc:
        raise ValueError("Invalid page token") from exc


def pull(db: Session, user: User, since: datetime | None, after: str | None) -> dict[str, object]:
    now = utcnow()
    cursor = (now - CURSOR_OVERLAP).isoformat()
    if since is not None and since < now - timedelta(days=get_settings().tombstone_retention_days):
        return {"tasks": [], "has_more": False, "next": None, "cursor": cursor, "reset_required": True}

    stmt = select(Task).where(Task.user_id == user.id)
    if since is None:
        stmt = stmt.where(Task.deleted_at.is_(None))  # a fresh client has nothing to delete
    else:
        stmt = stmt.where(Task.updated_at >= since)
    position = _parse_after(after)
    if position is not None:
        stamp, last_id = position
        stmt = stmt.where(or_(Task.updated_at > stamp, and_(Task.updated_at == stamp, Task.id > last_id)))
    rows = list(db.scalars(stmt.order_by(Task.updated_at, Task.id).limit(PULL_PAGE_SIZE + 1)))
    has_more = len(rows) > PULL_PAGE_SIZE
    rows = rows[:PULL_PAGE_SIZE]
    next_token = f"{rows[-1].updated_at.isoformat()}|{rows[-1].id}" if has_more and rows else None
    return {
        "tasks": [TaskOut.model_validate(t) for t in rows],
        "has_more": has_more,
        "next": next_token,
        "cursor": cursor,
        "reset_required": False,
    }
