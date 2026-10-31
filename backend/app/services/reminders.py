"""Reminder dispatch, daily digests and data-retention purges (run by the background worker).

Every notification has a deterministic `dedupe_key` protected by a unique constraint, so the jobs
are idempotent: re-running them, or running several workers, never produces duplicates.
"""

import logging
from datetime import datetime, time, timedelta

from sqlalchemy import Delete, delete, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.config import get_settings
from app.models import ActivityLog, AuthSession, Notification, OAuthState, SyncOp, Task, TaskStatus, User, utcnow
from app.services import push
from app.services.timeutil import local_to_utc, now_local

log = logging.getLogger("lifeos.worker")

BATCH_SIZE = 200


def _add_notification(db: Session, notification: Notification) -> bool:
    """Insert in a savepoint; returns False when the dedupe key already exists."""
    try:
        with db.begin_nested():
            db.add(notification)
        return True
    except IntegrityError:
        return False


def _format_due(task: Task, tz: str) -> str:
    if task.due_at is None:
        return ""
    local = task.due_at.astimezone(now_local(tz).tzinfo)
    return f" (due {local:%a %d %b %H:%M})" if task.due_has_time else f" (due {local:%a %d %b})"


def dispatch_due_reminders(db: Session, now: datetime | None = None) -> int:
    now = now or utcnow()
    stmt = (
        select(Task, User.timezone)
        .join(User, User.id == Task.user_id)
        .where(
            Task.remind_at.is_not(None),
            Task.remind_at <= now,
            Task.reminder_sent_at.is_(None),
            Task.deleted_at.is_(None),
            Task.status != TaskStatus.done.value,
        )
        .order_by(Task.remind_at)
        .limit(BATCH_SIZE)
    )
    if db.bind is not None and db.bind.dialect.name == "postgresql":
        stmt = stmt.with_for_update(skip_locked=True, of=Task)
    sent = 0
    outgoing: list[push.PushMessage] = []
    for task, tz in db.execute(stmt).all():
        assert task.remind_at is not None
        created = _add_notification(
            db,
            Notification(
                user_id=task.user_id,
                task_id=task.id,
                kind="reminder",
                title=f"Reminder: {task.title}"[:200],
                body=f"{task.title}{_format_due(task, tz)}",
                dedupe_key=f"reminder:{task.id}:{task.remind_at.isoformat()}",
            ),
        )
        # Not a sync-visible change, so `version`/`updated_at` stay untouched.
        task.reminder_sent_at = now
        sent += int(created)
        if created:
            outgoing.append(
                push.PushMessage(
                    task.user_id, task.title[:120], f"Reminder{_format_due(task, tz)}", f"reminder-{task.id}", "/"
                )
            )
    db.commit()
    push.deliver(db, outgoing)  # after commit: a slow push service never holds DB locks
    return sent


def dispatch_daily_digests(db: Session, now: datetime | None = None) -> int:
    """Send one digest per user per local day, at or after their configured local hour."""
    now = now or utcnow()
    sent = 0
    outgoing: list[push.PushMessage] = []
    users = db.scalars(select(User).where(User.daily_digest_enabled.is_(True)))
    for user in users:
        local_now = now_local(user.timezone, now)
        today = local_now.date()
        if local_now.hour < user.daily_digest_hour or user.last_digest_on == today:
            continue
        end_of_today = local_to_utc(today + timedelta(days=1), time(0, 0), user.timezone)
        open_tasks = select(Task).where(
            Task.user_id == user.id, Task.deleted_at.is_(None), Task.status != TaskStatus.done.value
        )
        overdue = list(db.scalars(open_tasks.where(Task.due_at < now)))
        due_today = list(db.scalars(open_tasks.where(Task.due_at >= now, Task.due_at < end_of_today)))
        planned = list(db.scalars(open_tasks.where(Task.scheduled_for == today)))
        user.last_digest_on = today
        if not (overdue or due_today or planned):
            continue
        parts = []
        if due_today:
            parts.append(f"{len(due_today)} due today")
        if planned:
            parts.append(f"{len(planned)} planned")
        if overdue:
            parts.append(f"{len(overdue)} overdue")
        top = sorted(overdue + due_today, key=lambda t: t.due_at or now)[:3]
        body = ", ".join(parts) + "."
        if top:
            body += " Next up: " + "; ".join(t.title for t in top)
        created = _add_notification(
            db,
            Notification(
                user_id=user.id,
                kind="digest",
                title="Your plan for today",
                body=body[:2000],
                dedupe_key=f"digest:{today.isoformat()}",
            ),
        )
        sent += int(created)
        if created:
            outgoing.append(
                push.PushMessage(user.id, "Your plan for today", body[:300], f"digest-{today.isoformat()}", "/")
            )
    db.commit()
    push.deliver(db, outgoing)
    return sent


def purge_expired_data(db: Session, now: datetime | None = None) -> dict[str, int]:
    """Apply data-retention policies."""
    s = get_settings()
    now = now or utcnow()
    statements: dict[str, Delete] = {
        "activity": delete(ActivityLog).where(ActivityLog.created_at < now - timedelta(days=s.activity_retention_days)),
        "notifications": delete(Notification).where(
            Notification.read_at.is_not(None),
            Notification.created_at < now - timedelta(days=s.notification_retention_days),
        ),
        "tombstones": delete(Task).where(
            Task.deleted_at.is_not(None), Task.deleted_at < now - timedelta(days=s.tombstone_retention_days)
        ),
        "sync_ops": delete(SyncOp).where(SyncOp.created_at < now - timedelta(days=30)),
        "sessions": delete(AuthSession).where(AuthSession.expires_at < now),
        "oauth_states": delete(OAuthState).where(OAuthState.expires_at < now),
    }
    results = {name: int(getattr(db.execute(stmt), "rowcount", 0) or 0) for name, stmt in statements.items()}
    db.commit()
    return results
