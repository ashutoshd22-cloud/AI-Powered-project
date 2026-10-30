from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, HTTPException, Query, status

from app.deps import CurrentUser, DbSession
from app.rate_limit import limiter
from app.schemas import SyncPullOut, SyncPushIn, SyncPushOut
from app.services import sync as sync_service

router = APIRouter(prefix="/sync", tags=["sync"])


@router.post("/push", response_model=SyncPushOut)
def push(body: SyncPushIn, user: CurrentUser, db: DbSession) -> SyncPushOut:
    limiter.check(f"sync:{user.id}", limit=120, window_seconds=60)
    return SyncPushOut(results=sync_service.push(db, user, body.ops))


@router.get("/pull", response_model=SyncPullOut)
def pull(
    user: CurrentUser,
    db: DbSession,
    since: datetime | None = None,
    after: Annotated[str | None, Query(max_length=200)] = None,
) -> SyncPullOut:
    limiter.check(f"sync:{user.id}", limit=120, window_seconds=60)
    if since is not None and since.tzinfo is None:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail="`since` must include a time zone"
        )
    try:
        return SyncPullOut(**sync_service.pull(db, user, since, after))  # type: ignore[arg-type]
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail=str(exc)) from None
