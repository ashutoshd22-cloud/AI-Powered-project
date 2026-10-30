"""Notifications, activity history and analytics endpoints."""

import uuid
from typing import Annotated

from fastapi import APIRouter, HTTPException, Query, Response, status
from sqlalchemy import delete, func, or_, select, update

from app.deps import CurrentUser, DbSession
from app.models import ActivityLog, Notification, utcnow
from app.schemas import ActivityOut, ActivityPage, NotificationOut
from app.services import analytics

router = APIRouter()


# --------------------------------------------------------------------------- notifications
@router.get("/notifications", response_model=list[NotificationOut], tags=["notifications"])
def list_notifications(
    user: CurrentUser,
    db: DbSession,
    unread_only: bool = False,
    limit: Annotated[int, Query(ge=1, le=100)] = 30,
) -> list[Notification]:
    stmt = select(Notification).where(Notification.user_id == user.id)
    if unread_only:
        stmt = stmt.where(Notification.read_at.is_(None))
    return list(db.scalars(stmt.order_by(Notification.created_at.desc()).limit(limit)))


@router.get("/notifications/unread-count", tags=["notifications"])
def unread_count(user: CurrentUser, db: DbSession) -> dict[str, int]:
    count = db.scalar(select(func.count()).where(Notification.user_id == user.id, Notification.read_at.is_(None)))
    return {"unread": int(count or 0)}


@router.post("/notifications/{notification_id}/read", response_model=NotificationOut, tags=["notifications"])
def mark_read(notification_id: uuid.UUID, user: CurrentUser, db: DbSession) -> Notification:
    n = db.get(Notification, notification_id)
    if n is None or n.user_id != user.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Notification not found")
    n.read_at = n.read_at or utcnow()
    db.commit()
    return n


@router.post("/notifications/read-all", status_code=status.HTTP_204_NO_CONTENT, tags=["notifications"])
def mark_all_read(user: CurrentUser, db: DbSession) -> Response:
    db.execute(
        update(Notification)
        .where(Notification.user_id == user.id, Notification.read_at.is_(None))
        .values(read_at=utcnow())
    )
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# --------------------------------------------------------------------------- activity history
@router.get("/activity", response_model=ActivityPage, tags=["activity"])
def list_activity(
    user: CurrentUser,
    db: DbSession,
    q: Annotated[str | None, Query(max_length=200)] = None,
    entity_type: Annotated[str | None, Query(max_length=20)] = None,
    action: Annotated[str | None, Query(max_length=50)] = None,
    page: Annotated[int, Query(ge=1, le=10_000)] = 1,
    page_size: Annotated[int, Query(ge=1, le=100)] = 25,
) -> ActivityPage:
    stmt = select(ActivityLog).where(ActivityLog.user_id == user.id)
    if q:
        term = q.strip().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        pattern = f"%{term}%"
        stmt = stmt.where(
            or_(ActivityLog.summary.ilike(pattern, escape="\\"), ActivityLog.action.ilike(pattern, escape="\\"))
        )
    if entity_type:
        stmt = stmt.where(ActivityLog.entity_type == entity_type)
    if action:
        stmt = stmt.where(ActivityLog.action == action)
    total = db.scalar(select(func.count()).select_from(stmt.subquery())) or 0
    rows = db.scalars(
        stmt.order_by(ActivityLog.created_at.desc(), ActivityLog.id.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
    )
    return ActivityPage(
        items=[ActivityOut.model_validate(r) for r in rows], total=total, page=page, page_size=page_size
    )


@router.delete("/activity", status_code=status.HTTP_204_NO_CONTENT, tags=["activity"])
def clear_activity(user: CurrentUser, db: DbSession) -> Response:
    db.execute(delete(ActivityLog).where(ActivityLog.user_id == user.id))
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# --------------------------------------------------------------------------- analytics
@router.get("/analytics/overview", tags=["analytics"])
def analytics_overview(
    user: CurrentUser, db: DbSession, days: Annotated[int, Query(ge=7, le=365)] = 30
) -> dict[str, object]:
    return analytics.overview(db, user, days, utcnow())
