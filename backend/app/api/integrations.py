from typing import Annotated

from fastapi import APIRouter, HTTPException, Query, Response, status
from fastapi.responses import RedirectResponse

from app.deps import CurrentUser, DbSession
from app.rate_limit import limiter
from app.services import google_calendar as gcal

router = APIRouter(prefix="/integrations/google", tags=["integrations"])


@router.get("")
def google_status(user: CurrentUser, db: DbSession) -> dict[str, object]:
    return gcal.status_for(db, user)


@router.post("/connect")
def google_connect(user: CurrentUser, db: DbSession) -> dict[str, str]:
    limiter.check(f"google-connect:{user.id}", limit=10, window_seconds=600)
    try:
        return {"url": gcal.authorization_url(db, user)}
    except gcal.NotConfigured as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from None


@router.get("/callback", include_in_schema=False)
def google_callback(
    user: CurrentUser,
    db: DbSession,
    code: Annotated[str | None, Query(max_length=2000)] = None,
    state: Annotated[str | None, Query(max_length=200)] = None,
    error: Annotated[str | None, Query(max_length=200)] = None,
) -> RedirectResponse:
    """Google redirects the browser here; the session cookie identifies the user (SameSite=Lax)."""
    if error or not code or not state:
        return RedirectResponse("/settings?google=cancelled", status_code=status.HTTP_303_SEE_OTHER)
    try:
        gcal.complete_authorization(db, user, code, state)
        gcal.sync_user(db, user)
    except gcal.GoogleError:
        return RedirectResponse("/settings?google=error", status_code=status.HTTP_303_SEE_OTHER)
    return RedirectResponse("/settings?google=connected", status_code=status.HTTP_303_SEE_OTHER)


@router.post("/sync")
def google_sync(user: CurrentUser, db: DbSession) -> dict[str, int]:
    limiter.check(f"google-sync:{user.id}", limit=10, window_seconds=60)
    try:
        return gcal.sync_user(db, user)
    except gcal.NotConfigured as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from None
    except gcal.GoogleError as exc:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc)) from None


@router.delete("", status_code=status.HTTP_204_NO_CONTENT)
def google_disconnect(user: CurrentUser, db: DbSession) -> Response:
    gcal.disconnect(db, user)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
