"""Activity history recording. Summaries are short, user-facing, and never contain secrets."""

import uuid

from sqlalchemy.orm import Session

from app.models import ActivityLog


def record(
    db: Session,
    user_id: uuid.UUID,
    action: str,
    entity_type: str,
    summary: str,
    entity_id: uuid.UUID | str | None = None,
) -> None:
    db.add(
        ActivityLog(
            user_id=user_id,
            action=action,
            entity_type=entity_type,
            entity_id=str(entity_id) if entity_id else None,
            summary=summary[:300],
        )
    )
