"""Data portability (export) and account deletion."""

import csv
import io
import json
from typing import Literal

from fastapi import APIRouter, HTTPException, Response, status
from sqlalchemy import select

from app.api.auth import user_out
from app.config import get_settings
from app.deps import CurrentUser, DbSession
from app.models import ActivityLog, Goal, Notification, Task, utcnow
from app.rate_limit import limiter
from app.schemas import ActivityOut, DeleteAccountIn, GoalOut, NotificationOut, TaskOut
from app.security import CSRF_COOKIE, SESSION_COOKIE, verify_password

router = APIRouter(prefix="/account", tags=["account"])

_CSV_FIELDS = [
    "id",
    "title",
    "description",
    "status",
    "priority",
    "category",
    "due_at",
    "due_has_time",
    "scheduled_for",
    "remind_at",
    "completed_at",
    "estimated_minutes",
    "goal_id",
    "source",
    "created_at",
    "updated_at",
]


def _csv_safe(value: object) -> str:
    """Neutralise spreadsheet formula injection (OWASP CSV injection guidance)."""
    text = "" if value is None else str(value)
    if text and text[0] in ("=", "+", "-", "@", "\t", "\r"):
        return "'" + text
    return text


@router.get("/export")
def export_data(user: CurrentUser, db: DbSession, format: Literal["json", "csv"] = "json") -> Response:
    limiter.check(f"export:{user.id}", limit=10, window_seconds=60)
    stamp = utcnow().strftime("%Y%m%d-%H%M%S")
    tasks = list(
        db.scalars(select(Task).where(Task.user_id == user.id, Task.deleted_at.is_(None)).order_by(Task.created_at))
    )
    if format == "csv":
        buffer = io.StringIO()
        writer = csv.writer(buffer)
        writer.writerow(_CSV_FIELDS)
        for t in tasks:
            data = TaskOut.model_validate(t).model_dump(mode="json")
            writer.writerow([_csv_safe(data.get(f)) for f in _CSV_FIELDS])
        return Response(
            content="﻿" + buffer.getvalue(),  # BOM so Excel detects UTF-8
            media_type="text/csv; charset=utf-8",
            headers={"Content-Disposition": f'attachment; filename="lifeos-tasks-{stamp}.csv"'},
        )

    goals = list(db.scalars(select(Goal).where(Goal.user_id == user.id)))
    notifications = list(db.scalars(select(Notification).where(Notification.user_id == user.id)))
    logs = list(db.scalars(select(ActivityLog).where(ActivityLog.user_id == user.id).order_by(ActivityLog.created_at)))
    document = {
        "format": "lifeos-export",
        "version": 1,
        "exported_at": utcnow().isoformat(),
        "user": user_out(user).model_dump(mode="json"),
        "tasks": [TaskOut.model_validate(t).model_dump(mode="json") for t in tasks],
        "goals": [
            GoalOut.model_validate(g).model_dump(mode="json", exclude={"progress", "tasks_total", "tasks_done"})
            for g in goals
        ],
        "notifications": [NotificationOut.model_validate(n).model_dump(mode="json") for n in notifications],
        "activity": [ActivityOut.model_validate(a).model_dump(mode="json") for a in logs],
    }
    return Response(
        content=json.dumps(document, ensure_ascii=False, indent=2),
        media_type="application/json",
        headers={"Content-Disposition": f'attachment; filename="lifeos-export-{stamp}.json"'},
    )


@router.delete("", status_code=status.HTTP_204_NO_CONTENT)
def delete_account(body: DeleteAccountIn, user: CurrentUser, db: DbSession) -> Response:
    limiter.check(f"delete-account:{user.id}", limit=5, window_seconds=300)
    if not verify_password(user.password_hash, body.password):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Password is incorrect")
    # Every user-owned table references users.id with ON DELETE CASCADE.
    db.delete(user)
    db.commit()
    response = Response(status_code=status.HTTP_204_NO_CONTENT)
    secure = get_settings().cookie_secure
    for name in (SESSION_COOKIE, CSRF_COOKIE):
        response.delete_cookie(name, path="/", secure=secure, samesite="lax")
    return response
