from fastapi import APIRouter, HTTPException, Request, Response, UploadFile, status
from sqlalchemy import select

from app.config import get_settings
from app.deps import CurrentUser, DbSession
from app.models import User
from app.rate_limit import client_ip, limiter
from app.security import hash_token, new_token
from app.services import activity, calendar_ics

router = APIRouter(prefix="/calendar", tags=["calendar"])


@router.post("/token")
def create_feed_token(user: CurrentUser, db: DbSession) -> dict[str, str]:
    """Create (or rotate) the private subscription URL. The token is shown only once."""
    token = new_token()
    user.calendar_token_hash = hash_token(token)
    activity.record(db, user.id, "calendar.feed_created", "calendar", "Created a new calendar subscription link")
    db.commit()
    base = get_settings().public_base_url.rstrip("/")
    return {"url": f"{base}/api/v1/calendar/feed/{token}.ics"}


@router.delete("/token", status_code=status.HTTP_204_NO_CONTENT)
def revoke_feed_token(user: CurrentUser, db: DbSession) -> Response:
    user.calendar_token_hash = None
    activity.record(db, user.id, "calendar.feed_revoked", "calendar", "Revoked the calendar subscription link")
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/feed/{token}.ics", include_in_schema=False)
def calendar_feed(token: str, request: Request, db: DbSession) -> Response:
    limiter.check(f"feed:{client_ip(request)}", limit=60, window_seconds=60)
    if len(token) > 128:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")
    user = db.scalar(select(User).where(User.calendar_token_hash == hash_token(token)))
    if user is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")
    return Response(
        content=calendar_ics.build_feed(db, user),
        media_type="text/calendar; charset=utf-8",
        headers={"Cache-Control": "private, max-age=300", "Content-Disposition": 'inline; filename="lifeos.ics"'},
    )


@router.post("/import")
async def import_calendar(file: UploadFile, user: CurrentUser, db: DbSession) -> dict[str, object]:
    limiter.check(f"import:{user.id}", limit=5, window_seconds=60)
    max_bytes = get_settings().max_import_bytes
    filename = (file.filename or "").lower()
    if not filename.endswith(".ics"):
        raise HTTPException(status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE, detail="Please upload an .ics file")
    payload = await file.read(max_bytes + 1)
    if len(payload) > max_bytes:
        raise HTTPException(status_code=status.HTTP_413_CONTENT_TOO_LARGE, detail="File is too large")
    if not payload.lstrip().startswith(b"BEGIN:VCALENDAR"):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail="The file is not a valid iCalendar (.ics) file"
        )
    from starlette.concurrency import run_in_threadpool

    try:
        return await run_in_threadpool(calendar_ics.import_ics, db, user, payload)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail=str(exc)) from None
