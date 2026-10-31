from typing import Annotated

from fastapi import APIRouter, HTTPException, Request, Response, status
from pydantic import BaseModel, StringConstraints
from sqlalchemy import delete, func, select

from app.deps import CurrentUser, DbSession
from app.models import PushSubscription
from app.rate_limit import limiter
from app.services import push

router = APIRouter(prefix="/push", tags=["push"])


class PushKeys(BaseModel):
    p256dh: Annotated[str, StringConstraints(min_length=20, max_length=200, pattern=r"^[A-Za-z0-9_-]+=*$")]
    auth: Annotated[str, StringConstraints(min_length=8, max_length=100, pattern=r"^[A-Za-z0-9_-]+=*$")]


class SubscriptionIn(BaseModel):
    endpoint: Annotated[str, StringConstraints(min_length=10, max_length=1000)]
    keys: PushKeys


class EndpointIn(BaseModel):
    endpoint: Annotated[str, StringConstraints(min_length=10, max_length=1000)]


MAX_SUBSCRIPTIONS_PER_USER = 20


@router.get("/config")
def push_config(user: CurrentUser, db: DbSession) -> dict[str, object]:
    key = push.public_key()
    count = db.scalar(select(func.count()).where(PushSubscription.user_id == user.id)) or 0
    return {"enabled": key is not None, "public_key": key, "subscriptions": int(count)}


@router.post("/subscriptions", status_code=status.HTTP_201_CREATED)
def subscribe(body: SubscriptionIn, request: Request, user: CurrentUser, db: DbSession) -> dict[str, str]:
    limiter.check(f"push-sub:{user.id}", limit=20, window_seconds=3600)
    if push.public_key() is None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail="Push notifications are not configured on this server"
        )
    if not push.endpoint_allowed(body.endpoint):
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail="Unsupported push service")
    sub = db.scalar(select(PushSubscription).where(PushSubscription.endpoint == body.endpoint))
    if sub is None:
        count = db.scalar(select(func.count()).where(PushSubscription.user_id == user.id)) or 0
        if count >= MAX_SUBSCRIPTIONS_PER_USER:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Too many devices; remove one first")
        sub = PushSubscription(endpoint=body.endpoint, user_id=user.id)
        db.add(sub)
    # The same browser may switch accounts: the endpoint then belongs to the signed-in user only.
    sub.user_id = user.id
    sub.p256dh = body.keys.p256dh
    sub.auth = body.keys.auth
    sub.user_agent = request.headers.get("user-agent", "")[:200]
    db.commit()
    return {"status": "subscribed"}


@router.delete("/subscriptions", status_code=status.HTTP_204_NO_CONTENT)
def unsubscribe(body: EndpointIn, user: CurrentUser, db: DbSession) -> Response:
    db.execute(
        delete(PushSubscription).where(PushSubscription.user_id == user.id, PushSubscription.endpoint == body.endpoint)
    )
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/test")
def send_test(user: CurrentUser, db: DbSession) -> dict[str, int]:
    limiter.check(f"push-test:{user.id}", limit=5, window_seconds=300)
    return push.deliver(
        db,
        [
            push.PushMessage(
                user_id=user.id,
                title="LifeOS notifications are on",
                body="You'll get reminders here even when LifeOS is closed.",
                tag="lifeos-test",
            )
        ],
    )
