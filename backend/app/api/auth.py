from fastapi import APIRouter, HTTPException, Request, Response, status
from sqlalchemy import delete, select
from sqlalchemy.exc import IntegrityError

from app.config import get_settings
from app.deps import CurrentSession, CurrentUser, DbSession
from app.models import AuthSession, User, utcnow
from app.rate_limit import client_ip, limiter
from app.schemas import ChangePasswordIn, LoginIn, RegisterIn, SessionInfo, UserOut, UserUpdate
from app.security import (
    CSRF_COOKIE,
    SESSION_COOKIE,
    hash_password,
    hash_token,
    needs_rehash,
    new_token,
    session_expiry,
    verify_password,
)
from app.services import activity

router = APIRouter(prefix="/auth", tags=["auth"])


def user_out(user: User) -> UserOut:
    out = UserOut.model_validate(user)
    out.has_calendar_feed = user.calendar_token_hash is not None
    return out


def _start_session(db: DbSession, user: User, request: Request, response: Response) -> SessionInfo:
    settings = get_settings()
    token, csrf = new_token(), new_token()
    db.add(
        AuthSession(
            user_id=user.id,
            token_hash=hash_token(token),
            csrf_hash=hash_token(csrf),
            user_agent=request.headers.get("user-agent", "")[:200],
            expires_at=session_expiry(settings.session_ttl_days),
        )
    )
    db.commit()
    max_age = settings.session_ttl_days * 86400
    common = {"max_age": max_age, "secure": settings.cookie_secure, "samesite": "lax", "path": "/"}
    response.set_cookie(SESSION_COOKIE, token, httponly=True, **common)  # type: ignore[arg-type]
    response.set_cookie(CSRF_COOKIE, csrf, httponly=False, **common)  # type: ignore[arg-type]
    return SessionInfo(user=user_out(user), csrf_token=csrf)


def _clear_cookies(response: Response) -> None:
    secure = get_settings().cookie_secure
    for name in (SESSION_COOKIE, CSRF_COOKIE):
        response.delete_cookie(name, path="/", secure=secure, samesite="lax")


@router.post("/register", response_model=SessionInfo, status_code=status.HTTP_201_CREATED)
def register(body: RegisterIn, request: Request, response: Response, db: DbSession) -> SessionInfo:
    limiter.check(f"register:{client_ip(request)}", limit=get_settings().register_limit_per_hour, window_seconds=3600)
    if db.scalar(select(User.id).where(User.email == body.email)):
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="An account with this email already exists")
    user = User(
        email=body.email,
        password_hash=hash_password(body.password),
        display_name=body.display_name,
        timezone=body.timezone,
    )
    db.add(user)
    try:
        db.flush()
    except IntegrityError:  # concurrent registration with the same e-mail
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail="An account with this email already exists"
        ) from None
    activity.record(db, user.id, "account.created", "account", "Created your LifeOS account")
    return _start_session(db, user, request, response)


@router.post("/login", response_model=SessionInfo)
def login(body: LoginIn, request: Request, response: Response, db: DbSession) -> SessionInfo:
    limiter.check(f"login-ip:{client_ip(request)}", limit=30, window_seconds=300)
    limiter.check(f"login-email:{body.email}", limit=10, window_seconds=300)
    user = db.scalar(select(User).where(User.email == body.email))
    if not verify_password(user.password_hash if user else None, body.password) or user is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Incorrect email or password")
    if needs_rehash(user.password_hash):
        user.password_hash = hash_password(body.password)
    activity.record(db, user.id, "account.login", "account", "Signed in")
    return _start_session(db, user, request, response)


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
def logout(auth: CurrentSession, response: Response, db: DbSession) -> Response:
    db.delete(auth)
    db.commit()
    response.status_code = status.HTTP_204_NO_CONTENT
    _clear_cookies(response)
    return response


@router.get("/me", response_model=UserOut)
def me(user: CurrentUser) -> UserOut:
    return user_out(user)


@router.patch("/me", response_model=UserOut)
def update_me(body: UserUpdate, user: CurrentUser, db: DbSession) -> UserOut:
    changes = body.model_dump(exclude_unset=True, exclude_none=True)
    for key, value in changes.items():
        setattr(user, key, value)
    if "timezone" in changes or "daily_digest_hour" in changes:
        user.last_digest_on = None  # re-evaluate today's digest in the new local time
    if changes:
        activity.record(db, user.id, "account.updated", "account", "Updated settings: " + ", ".join(sorted(changes)))
    db.commit()
    return user_out(user)


@router.post("/change-password", status_code=status.HTTP_204_NO_CONTENT)
def change_password(body: ChangePasswordIn, auth: CurrentSession, user: CurrentUser, db: DbSession) -> Response:
    limiter.check(f"change-password:{user.id}", limit=5, window_seconds=300)
    if not verify_password(user.password_hash, body.current_password):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Current password is incorrect")
    user.password_hash = hash_password(body.new_password)
    # Sign out every other device.
    db.execute(delete(AuthSession).where(AuthSession.user_id == user.id, AuthSession.id != auth.id))
    activity.record(db, user.id, "account.password_changed", "account", "Changed password; other sessions signed out")
    user.updated_at = utcnow()
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
