"""Web Push delivery (RFC 8030 + VAPID) for notifications while LifeOS is closed.

The server only ever contacts endpoints on an allow-list of real push services, so a malicious
client cannot make it send requests to arbitrary or internal URLs.
"""

import base64
import json
import logging
import uuid
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlsplit

from cryptography.hazmat.primitives import serialization
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import get_settings
from app.models import PushSubscription, utcnow

log = logging.getLogger("lifeos.push")


@dataclass
class PushMessage:
    user_id: uuid.UUID
    title: str
    body: str
    tag: str
    url: str = "/"


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def public_key() -> str | None:
    """Application server key for `pushManager.subscribe`, derived from the private key."""
    private = get_settings().vapid_private_key
    if not private:
        return None
    from py_vapid import Vapid

    try:
        vapid = Vapid.from_string(private)
    except Exception:
        log.error("VAPID_PRIVATE_KEY is invalid; Web Push is disabled")
        return None
    raw = vapid.public_key.public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
    return _b64url(raw)


def generate_keys() -> tuple[str, str]:
    """Returns (private key for VAPID_PRIVATE_KEY, public key)."""
    from py_vapid import Vapid

    vapid = Vapid()
    vapid.generate_keys()
    der = vapid.private_key.private_bytes(
        serialization.Encoding.DER, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()
    )
    raw = vapid.public_key.public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
    return _b64url(der), _b64url(raw)


def endpoint_allowed(endpoint: str) -> bool:
    try:
        parts = urlsplit(endpoint)
    except ValueError:
        return False
    if parts.scheme != "https" or not parts.hostname or parts.port not in (None, 443):
        return False
    host = parts.hostname.lower()
    allowed = [h.strip().lower() for h in get_settings().push_allowed_hosts.split(",") if h.strip()]
    return any(host == a or host.endswith("." + a) for a in allowed)


def _send(subscription: PushSubscription, payload: str) -> int:
    """Deliver one message; returns the push service's HTTP status (0 on network error)."""
    from pywebpush import WebPushException, webpush

    s = get_settings()
    try:
        webpush(
            subscription_info={
                "endpoint": subscription.endpoint,
                "keys": {"p256dh": subscription.p256dh, "auth": subscription.auth},
            },
            data=payload,
            vapid_private_key=s.vapid_private_key,
            vapid_claims={"sub": s.vapid_subject},
            ttl=6 * 3600,
            timeout=10,
        )
        return 201
    except WebPushException as exc:
        return exc.response.status_code if exc.response is not None else 0
    except Exception:  # network failures must never break the worker
        return 0


def deliver(db: Session, messages: list[PushMessage]) -> dict[str, int]:
    """Send messages to every subscribed browser of each user. Expired subscriptions are removed."""
    stats = {"sent": 0, "failed": 0, "removed": 0}
    if not messages or not get_settings().vapid_private_key:
        return stats
    for message in messages:
        subs = list(db.scalars(select(PushSubscription).where(PushSubscription.user_id == message.user_id)))
        payload = json.dumps({"title": message.title, "body": message.body, "tag": message.tag, "url": message.url})
        for sub in subs:
            if not endpoint_allowed(sub.endpoint):
                db.delete(sub)
                stats["removed"] += 1
                continue
            status = _send(sub, payload)
            if 200 <= status < 300:
                sub.last_success_at = utcnow()
                stats["sent"] += 1
            elif status in (404, 410):  # the browser unsubscribed or the subscription expired
                db.delete(sub)
                stats["removed"] += 1
            else:
                stats["failed"] += 1
    db.commit()
    if stats["failed"]:
        log.warning("web push: %s", stats)
    return stats


def subscription_info(sub: PushSubscription) -> dict[str, Any]:
    return {"endpoint": sub.endpoint, "created_at": sub.created_at.isoformat()}
