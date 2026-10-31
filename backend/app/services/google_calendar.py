"""Two-way sync between LifeOS tasks and a dedicated "LifeOS" Google Calendar.

* OAuth 2.0 authorization-code flow with PKCE and a one-time state; scope
  `calendar.app.created` lets LifeOS manage only the calendar it creates — never the user's
  other calendars.
* Refresh/access tokens are encrypted at rest (Fernet, TOKEN_ENCRYPTION_KEY).
* Each sync pulls Google changes first (incremental `syncToken`), then pushes LifeOS changes.
  When both sides changed the same task since the last sync, the most recent edit wins.
"""

import base64
import hashlib
import logging
import secrets
from datetime import UTC, date, datetime, timedelta
from typing import Any
from urllib.parse import urlencode

import httpx
from cryptography.fernet import Fernet, InvalidToken
from sqlalchemy import ColumnElement, or_, select
from sqlalchemy.orm import Session

from app.config import get_settings
from app.models import GoogleEventLink, GoogleIntegration, OAuthState, Task, TaskSource, TaskStatus, User, utcnow
from app.services import activity
from app.services import tasks as task_service
from app.services.timeutil import end_of_local_day, local_date_of

log = logging.getLogger("lifeos.google")

AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_URL = "https://oauth2.googleapis.com/token"  # noqa: S105 - endpoint URL, not a secret
REVOKE_URL = "https://oauth2.googleapis.com/revoke"
API = "https://www.googleapis.com/calendar/v3"
SCOPE = "https://www.googleapis.com/auth/calendar.app.created"
DONE_PREFIX = "✓ "
MAX_EVENTS_PER_SYNC = 2500


class GoogleError(Exception):
    pass


class NotConfigured(GoogleError):
    pass


def _client() -> httpx.Client:
    """HTTP client factory (replaced in tests with a fake Google)."""
    return httpx.Client(timeout=15.0)


def configured() -> bool:
    s = get_settings()
    return bool(s.google_client_id and s.google_client_secret and s.token_encryption_key)


def redirect_uri() -> str:
    return get_settings().public_base_url.rstrip("/") + "/api/v1/integrations/google/callback"


def _fernet() -> Fernet:
    key = get_settings().token_encryption_key
    if not key:
        raise NotConfigured("TOKEN_ENCRYPTION_KEY is not set")
    return Fernet(key.encode())


def _encrypt(value: str) -> str:
    return _fernet().encrypt(value.encode()).decode()


def _decrypt(value: str) -> str:
    try:
        return _fernet().decrypt(value.encode()).decode()
    except InvalidToken as exc:
        raise GoogleError("Stored Google token could not be decrypted (encryption key changed?)") from exc


def _hash(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


# ------------------------------------------------------------------------------------- OAuth
def authorization_url(db: Session, user: User) -> str:
    if not configured():
        raise NotConfigured("Google Calendar is not configured on this server")
    state = secrets.token_urlsafe(32)
    verifier = secrets.token_urlsafe(64)[:96]
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    db.add(
        OAuthState(
            state_hash=_hash(state),
            user_id=user.id,
            code_verifier=verifier,
            expires_at=utcnow() + timedelta(minutes=10),
        )
    )
    db.commit()
    params = {
        "client_id": get_settings().google_client_id,
        "redirect_uri": redirect_uri(),
        "response_type": "code",
        "scope": SCOPE,
        "access_type": "offline",
        "prompt": "consent",
        "include_granted_scopes": "false",
        "state": state,
        "code_challenge": challenge,
        "code_challenge_method": "S256",
    }
    return f"{AUTH_URL}?{urlencode(params)}"


def complete_authorization(db: Session, user: User, code: str, state: str) -> GoogleIntegration:
    record = db.get(OAuthState, _hash(state))
    if record is None or record.user_id != user.id or record.expires_at < utcnow():
        raise GoogleError("This Google sign-in link has expired. Please try connecting again.")
    verifier = record.code_verifier
    db.delete(record)  # one-time use
    db.flush()
    s = get_settings()
    with _client() as http:
        resp = http.post(
            TOKEN_URL,
            data={
                "client_id": s.google_client_id,
                "client_secret": s.google_client_secret,
                "code": code,
                "code_verifier": verifier,
                "grant_type": "authorization_code",
                "redirect_uri": redirect_uri(),
            },
        )
    if resp.status_code != 200:
        raise GoogleError("Google did not accept the sign-in. Please try again.")
    tokens = resp.json()
    if not tokens.get("refresh_token"):
        raise GoogleError("Google did not grant offline access. Remove LifeOS from your Google account and retry.")
    integration = db.get(GoogleIntegration, user.id) or GoogleIntegration(user_id=user.id)
    integration.refresh_token_enc = _encrypt(tokens["refresh_token"])
    integration.access_token_enc = _encrypt(tokens["access_token"])
    integration.access_expires_at = utcnow() + timedelta(seconds=int(tokens.get("expires_in", 3600)) - 60)
    integration.status, integration.last_error, integration.sync_token = "active", None, None
    db.add(integration)
    activity.record(db, user.id, "google.connected", "calendar", "Connected Google Calendar")
    db.commit()
    return integration


def disconnect(db: Session, user: User) -> None:
    integration = db.get(GoogleIntegration, user.id)
    if integration is None:
        return
    try:
        with _client() as http:
            http.post(REVOKE_URL, data={"token": _decrypt(integration.refresh_token_enc)})
    except (httpx.HTTPError, GoogleError):
        log.info("token revocation failed; deleting local credentials anyway")
    for link in db.scalars(select(GoogleEventLink).where(GoogleEventLink.user_id == user.id)):
        db.delete(link)
    db.delete(integration)
    activity.record(db, user.id, "google.disconnected", "calendar", "Disconnected Google Calendar")
    db.commit()


def _access_token(db: Session, integration: GoogleIntegration, http: httpx.Client) -> str:
    if integration.access_token_enc and integration.access_expires_at and integration.access_expires_at > utcnow():
        return _decrypt(integration.access_token_enc)
    s = get_settings()
    resp = http.post(
        TOKEN_URL,
        data={
            "client_id": s.google_client_id,
            "client_secret": s.google_client_secret,
            "refresh_token": _decrypt(integration.refresh_token_enc),
            "grant_type": "refresh_token",
        },
    )
    if resp.status_code in (400, 401):
        integration.status = "error"
        integration.last_error = "Google access was revoked. Reconnect Google Calendar in Settings."
        db.commit()
        raise GoogleError(integration.last_error)
    if resp.status_code != 200:
        raise GoogleError(f"Google token refresh failed ({resp.status_code})")
    data = resp.json()
    integration.access_token_enc = _encrypt(data["access_token"])
    integration.access_expires_at = utcnow() + timedelta(seconds=int(data.get("expires_in", 3600)) - 60)
    return str(data["access_token"])


# ------------------------------------------------------------------------- mapping helpers
def _event_body(task: Task, tz: str) -> dict[str, Any]:
    assert task.due_at is not None
    body: dict[str, Any] = {
        "summary": (DONE_PREFIX if task.status == TaskStatus.done.value else "") + task.title,
        "description": task.description[:8000],
        "extendedProperties": {"private": {"lifeosTaskId": str(task.id)}},
        "transparency": "transparent",
    }
    if task.due_has_time:
        end = task.due_at + timedelta(minutes=task.estimated_minutes or 30)
        body["start"] = {"dateTime": task.due_at.isoformat(), "timeZone": tz}
        body["end"] = {"dateTime": end.isoformat(), "timeZone": tz}
    else:
        day = local_date_of(task.due_at, tz)
        body["start"] = {"date": day.isoformat()}
        body["end"] = {"date": (day + timedelta(days=1)).isoformat()}
    return body


def _parse_rfc3339(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(UTC)


def _fields_from_event(event: dict[str, Any], tz: str) -> dict[str, Any]:
    title = str(event.get("summary") or "").strip()
    done = title.startswith(DONE_PREFIX.strip())
    title = title.removeprefix(DONE_PREFIX).removeprefix(DONE_PREFIX.strip()).strip()[:200] or "Untitled event"
    start = event.get("start") or {}
    fields: dict[str, Any] = {"title": title, "description": str(event.get("description") or "")[:5000]}
    if "dateTime" in start:
        fields["due_at"], fields["due_has_time"] = _parse_rfc3339(start["dateTime"]), True
    elif "date" in start:
        fields["due_at"], fields["due_has_time"] = end_of_local_day(date.fromisoformat(start["date"]), tz), False
    fields["status"] = TaskStatus.done if done else None
    return fields


# ---------------------------------------------------------------------------------- sync
class _Api:
    def __init__(self, http: httpx.Client, token: str) -> None:
        self.http = http
        self.headers = {"Authorization": f"Bearer {token}"}

    def call(self, method: str, path: str, **kwargs: Any) -> httpx.Response:
        resp = self.http.request(method, API + path, headers=self.headers, **kwargs)
        if resp.status_code >= 500 or resp.status_code == 429:
            raise GoogleError(f"Google Calendar is unavailable ({resp.status_code}); will retry")
        return resp


def _ensure_calendar(api: _Api, integration: GoogleIntegration, user: User) -> str:
    if integration.calendar_id:
        resp = api.call("GET", f"/calendars/{integration.calendar_id}")
        if resp.status_code == 200:
            return integration.calendar_id
    resp = api.call(
        "POST", "/calendars", json={"summary": "LifeOS", "description": "Tasks from LifeOS", "timeZone": user.timezone}
    )
    if resp.status_code != 200:
        raise GoogleError(f"Could not create the LifeOS calendar ({resp.status_code})")
    integration.calendar_id = str(resp.json()["id"])
    integration.sync_token = None
    return integration.calendar_id


def _pull(db: Session, api: _Api, integration: GoogleIntegration, user: User, cal: str) -> int:
    changed = 0
    params: dict[str, Any] = {"showDeleted": "true", "maxResults": 250}
    if integration.sync_token:
        params["syncToken"] = integration.sync_token
    page_token: str | None = None
    seen = 0
    while True:
        if page_token:
            params["pageToken"] = page_token
        resp = api.call("GET", f"/calendars/{cal}/events", params=params)
        if resp.status_code == 410:  # sync token expired: start over with a full listing
            integration.sync_token = None
            params.pop("syncToken", None)
            params.pop("pageToken", None)
            page_token = None
            continue
        if resp.status_code != 200:
            raise GoogleError(f"Could not read Google events ({resp.status_code})")
        data = resp.json()
        for event in data.get("items", []):
            seen += 1
            changed += _apply_event(db, user, event)
        page_token = data.get("nextPageToken")
        if not page_token or seen >= MAX_EVENTS_PER_SYNC:
            integration.sync_token = data.get("nextSyncToken", integration.sync_token)
            return changed


def _apply_event(db: Session, user: User, event: dict[str, Any]) -> int:
    event_id = str(event.get("id") or "")
    if not event_id:
        return 0
    link = db.scalar(
        select(GoogleEventLink).where(GoogleEventLink.user_id == user.id, GoogleEventLink.event_id == event_id)
    )
    if link is None:
        task_ref = ((event.get("extendedProperties") or {}).get("private") or {}).get("lifeosTaskId")
        if task_ref:
            return 0  # created by LifeOS but unknown here (e.g. a link removed on disconnect): ignore
        if event.get("status") == "cancelled" or not event.get("start"):
            return 0
        # A new event the user created in the LifeOS calendar → a new task.
        fields = _fields_from_event(event, user.timezone)
        fields["status"] = fields["status"] or TaskStatus.todo
        task = task_service.create_task(
            db, user, fields, source=TaskSource.calendar_import, external_uid=f"google:{event_id}"
        )
        db.flush()
        db.add(
            GoogleEventLink(
                task_id=task.id,
                user_id=user.id,
                event_id=event_id,
                etag=str(event.get("etag", "")),
                task_version=task.version,
            )
        )
        return 1

    linked = db.get(Task, link.task_id)
    if linked is None:
        db.delete(link)
        return 0
    task = linked
    if event.get("etag") == link.etag:
        return 0  # our own write coming back
    if event.get("status") == "cancelled":
        if task.deleted_at is None:
            task_service.soft_delete_task(db, user, task)
        db.delete(link)
        return 1
    # Both sides changed since the last sync: the most recent edit wins.
    local_changed = task.version != link.task_version
    google_updated = _parse_rfc3339(event["updated"]) if event.get("updated") else utcnow()
    if local_changed and task.updated_at > google_updated:
        return 0
    fields = {k: v for k, v in _fields_from_event(event, user.timezone).items() if v is not None}
    if task.recurrence and "due_at" not in fields:
        fields.pop("due_at", None)
    task_service.update_task(db, user, task, fields)
    link.etag = str(event.get("etag", ""))
    link.task_version = task.version
    link.updated_at = utcnow()
    return 1


def _push(db: Session, api: _Api, user: User, cal: str) -> int:
    links = {
        link.task_id: link for link in db.scalars(select(GoogleEventLink).where(GoogleEventLink.user_id == user.id))
    }
    wanted: ColumnElement[bool] = Task.due_at.is_not(None)
    if links:
        wanted = or_(wanted, Task.id.in_(list(links)))
    candidates = db.scalars(select(Task).where(Task.user_id == user.id, wanted))
    pushed = 0
    for task in candidates:
        link = links.get(task.id)
        if link is not None and link.task_version == task.version:
            continue
        should_exist = task.deleted_at is None and task.due_at is not None
        if not should_exist:
            if link is not None:
                resp = api.call("DELETE", f"/calendars/{cal}/events/{link.event_id}")
                if resp.status_code not in (200, 204, 404, 410):
                    raise GoogleError(f"Could not delete a Google event ({resp.status_code})")
                db.delete(link)
                pushed += 1
            continue
        body = _event_body(task, user.timezone)
        saved: httpx.Response | None = None
        if link is not None:
            saved = api.call("PATCH", f"/calendars/{cal}/events/{link.event_id}", json=body)
            if saved.status_code in (404, 410):  # deleted in Google meanwhile: recreate it
                db.delete(link)
                db.flush()
                link, saved = None, None
        if saved is None:
            saved = api.call("POST", f"/calendars/{cal}/events", json=body)
        resp = saved
        if resp.status_code != 200:
            raise GoogleError(f"Could not save a Google event ({resp.status_code})")
        event = resp.json()
        if link is None:
            link = GoogleEventLink(task_id=task.id, user_id=user.id, event_id=str(event["id"]))
            db.add(link)
        link.etag = str(event.get("etag", ""))
        link.task_version = task.version
        link.updated_at = utcnow()
        pushed += 1
    return pushed


def sync_user(db: Session, user: User) -> dict[str, int]:
    integration = db.get(GoogleIntegration, user.id)
    if integration is None or not configured():
        raise NotConfigured("Google Calendar is not connected")
    try:
        with _client() as http:
            api = _Api(http, _access_token(db, integration, http))
            cal = _ensure_calendar(api, integration, user)
            pulled = _pull(db, api, integration, user, cal)
            db.flush()
            pushed = _push(db, api, user, cal)
        integration.status, integration.last_error, integration.last_synced_at = "active", None, utcnow()
        db.commit()
        return {"pulled": pulled, "pushed": pushed}
    except (GoogleError, httpx.HTTPError) as exc:
        db.rollback()
        integration = db.get(GoogleIntegration, user.id)
        if integration is not None:
            integration.last_error = str(exc)[:300] if isinstance(exc, GoogleError) else "Could not reach Google"
            db.commit()
        raise GoogleError(str(exc)) from exc


def sync_due(db: Session, now: datetime | None = None) -> int:
    """Worker job: sync every active integration whose interval has elapsed."""
    if not configured():
        return 0
    now = now or utcnow()
    cutoff = now - timedelta(seconds=get_settings().google_sync_interval_seconds)
    rows = db.scalars(
        select(GoogleIntegration).where(
            GoogleIntegration.status == "active",
            or_(GoogleIntegration.last_synced_at.is_(None), GoogleIntegration.last_synced_at < cutoff),
        )
    )
    done = 0
    for user_id in [r.user_id for r in rows]:
        user = db.get(User, user_id)
        if user is None:
            continue
        try:
            sync_user(db, user)
            done += 1
        except GoogleError as exc:
            log.warning("google sync failed for a user: %s", exc)
    return done


def status_for(db: Session, user: User) -> dict[str, Any]:
    integration = db.get(GoogleIntegration, user.id)
    return {
        "configured": configured(),
        "connected": integration is not None,
        "status": integration.status if integration else None,
        "last_synced_at": integration.last_synced_at.isoformat()
        if integration and integration.last_synced_at
        else None,
        "last_error": integration.last_error if integration else None,
    }


def new_key() -> str:
    return Fernet.generate_key().decode()
