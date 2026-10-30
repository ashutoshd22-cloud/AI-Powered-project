"""iCalendar (RFC 5545) export feed and import."""

import logging
from datetime import UTC, date, datetime, timedelta

from icalendar import Calendar, Event
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import Task, TaskSource, TaskStatus, User, utcnow
from app.services import activity
from app.services import tasks as task_service
from app.services.timeutil import end_of_local_day, local_date_of, local_to_utc

log = logging.getLogger("lifeos.calendar")

MAX_IMPORT_ITEMS = 1000
_PRIORITY_TO_ICS = {"urgent": 1, "high": 3, "medium": 5, "low": 9}


def build_feed(db: Session, user: User, now: datetime | None = None) -> bytes:
    """Open and recently completed tasks that have a due date, as VEVENTs (calendar apps
    such as Google Calendar ignore VTODO)."""
    now = now or utcnow()
    tasks = db.scalars(
        select(Task)
        .where(
            Task.user_id == user.id,
            Task.deleted_at.is_(None),
            Task.due_at.is_not(None),
            Task.due_at >= now - timedelta(days=90),
        )
        .order_by(Task.due_at)
        .limit(5000)
    )
    cal = Calendar()
    cal.add("prodid", "-//LifeOS//Tasks//EN")
    cal.add("version", "2.0")
    cal.add("x-wr-calname", f"LifeOS – {user.display_name}")
    cal.add("x-wr-timezone", user.timezone)
    cal.add("refresh-interval", timedelta(minutes=30), parameters={"VALUE": "DURATION"})
    for task in tasks:
        assert task.due_at is not None
        event = Event()
        event.add("uid", f"{task.id}@lifeos")
        event.add("summary", ("✓ " if task.status == TaskStatus.done.value else "") + task.title)
        if task.description:
            event.add("description", task.description[:2000])
        if task.due_has_time:
            event.add("dtstart", task.due_at)
            event.add("dtend", task.due_at + timedelta(minutes=task.estimated_minutes or 30))
        else:
            day = local_date_of(task.due_at, user.timezone)
            event.add("dtstart", day)
            event.add("dtend", day + timedelta(days=1))
        event.add("dtstamp", task.updated_at)
        event.add("last-modified", task.updated_at)
        event.add("priority", _PRIORITY_TO_ICS.get(task.priority, 5))
        if task.category:
            event.add("categories", [task.category])
        cal.add_component(event)
    return cal.to_ical()


def _to_due(value: object, tz: str) -> tuple[datetime | None, bool]:
    if isinstance(value, datetime):
        if value.tzinfo is None:  # floating time: interpret in the user's zone
            return local_to_utc(value.date(), value.time(), tz), True
        return value.astimezone(UTC), True
    if isinstance(value, date):
        return end_of_local_day(value, tz), False
    return None, False


def import_ics(db: Session, user: User, payload: bytes) -> dict[str, object]:
    try:
        cal = Calendar.from_ical(payload)
    except Exception as exc:  # icalendar raises a variety of errors for malformed input
        raise ValueError("The file is not a valid iCalendar (.ics) file") from exc

    created = skipped = 0
    errors: list[str] = []
    components = [c for c in cal.walk() if c.name in ("VEVENT", "VTODO")]
    if len(components) > MAX_IMPORT_ITEMS:
        raise ValueError(f"Too many items; the limit is {MAX_IMPORT_ITEMS} per import")

    for component in components:
        uid = str(component.get("uid") or "").strip()[:255] or None
        title = str(component.get("summary") or "").strip()[:200]
        if not title:
            skipped += 1
            continue
        if uid and db.scalar(select(Task.id).where(Task.user_id == user.id, Task.external_uid == uid)):
            skipped += 1  # already imported earlier — never duplicate
            continue
        try:
            raw_due = component.get("due") or component.get("dtstart")
            due_at, has_time = _to_due(raw_due.dt if raw_due is not None else None, user.timezone)
            status = TaskStatus.done if str(component.get("status") or "").upper() in {"COMPLETED"} else TaskStatus.todo
            fields = {
                "title": title,
                "description": str(component.get("description") or "")[:5000],
                "due_at": due_at,
                "due_has_time": has_time,
                "status": status,
                "remind_at": None,
            }
            with db.begin_nested():  # a bad item must not roll back the ones before it
                task_service.create_task(db, user, fields, source=TaskSource.calendar_import, external_uid=uid)
            created += 1
        except Exception:
            errors.append(f"Could not import “{title[:60]}”")
            log.info("skipped an unparseable calendar item")
    activity.record(db, user.id, "calendar.imported", "calendar", f"Imported {created} item(s) from a calendar file")
    db.commit()
    return {"created": created, "skipped": skipped, "errors": errors[:20]}
