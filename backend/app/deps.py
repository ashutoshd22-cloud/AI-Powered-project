"""Shared FastAPI dependencies."""

from datetime import timedelta
from typing import Annotated

from fastapi import Depends, HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import get_settings
from app.db import get_db
from app.models import AuthSession, User, utcnow
from app.security import CSRF_HEADER, SESSION_COOKIE, hash_token, tokens_match

DbSession = Annotated[Session, Depends(get_db)]

_UNSAFE_METHODS = {"POST", "PUT", "PATCH", "DELETE"}


def _unauthorized(detail: str = "Not authenticated") -> HTTPException:
    return HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=detail)


def get_current_session(request: Request, db: DbSession) -> AuthSession:
    token = request.cookies.get(SESSION_COOKIE)
    if not token or len(token) > 128:
        raise _unauthorized()
    auth = db.scalar(select(AuthSession).where(AuthSession.token_hash == hash_token(token)))
    now = utcnow()
    if auth is None:
        raise _unauthorized()
    if auth.expires_at <= now:
        db.delete(auth)
        db.commit()
        raise _unauthorized("Session expired")

    if request.method in _UNSAFE_METHODS:
        csrf = request.headers.get(CSRF_HEADER, "")
        if not csrf or len(csrf) > 128 or not tokens_match(csrf, auth.csrf_hash):
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Invalid CSRF token")

    # Sliding expiry, written at most every five minutes to avoid a write per request.
    if now - auth.last_seen_at > timedelta(minutes=5):
        auth.last_seen_at = now
        auth.expires_at = now + timedelta(days=get_settings().session_ttl_days)
        db.commit()
    return auth


CurrentSession = Annotated[AuthSession, Depends(get_current_session)]


def get_current_user(auth: CurrentSession, db: DbSession) -> User:
    user = db.get(User, auth.user_id)
    if user is None:
        raise _unauthorized()
    return user


CurrentUser = Annotated[User, Depends(get_current_user)]
