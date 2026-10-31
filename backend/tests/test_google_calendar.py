"""Two-way Google Calendar sync against an in-memory fake of the Google APIs."""

import json
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from typing import Any
from urllib.parse import parse_qs, urlsplit

import httpx
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from app import db as database
from app.config import get_settings
from app.models import GoogleIntegration, Task
from app.services import google_calendar as gcal


class FakeGoogle:
    def __init__(self) -> None:
        self.calendars: set[str] = set()
        self.events: dict[str, dict[str, Any]] = {}
        self.seq = 0
        self.revoked = False
        self.revoke_calls = 0
        self.token_requests: list[dict[str, list[str]]] = []
        self.expire_sync_token = False

    # -- simulate the user editing in Google Calendar
    def user_edit(self, event_id: str, **changes: Any) -> None:
        ev = self.events[event_id]
        ev.update(changes)
        self._touch(ev, later=True)

    def user_create(self, summary: str, start: dict[str, str]) -> str:
        self.seq += 1
        eid = f"user{self.seq}"
        self.events[eid] = {"id": eid, "summary": summary, "start": start, "end": start, "status": "confirmed"}
        self._touch(self.events[eid], later=True)
        return eid

    def _touch(self, ev: dict[str, Any], later: bool = False) -> None:
        self.seq += 1
        ev["_seq"] = self.seq
        ev["etag"] = f'"{self.seq}"'
        ev["updated"] = (datetime.now(UTC) + timedelta(minutes=5 if later else 0)).isoformat().replace("+00:00", "Z")

    def _public(self, ev: dict[str, Any]) -> dict[str, Any]:
        return {k: v for k, v in ev.items() if not k.startswith("_")}

    def handler(self, request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        if url.startswith(gcal.TOKEN_URL):
            form = parse_qs(request.content.decode())
            self.token_requests.append(form)
            if form["grant_type"] == ["authorization_code"]:
                if form.get("code") != ["good-code"] or not form.get("code_verifier"):
                    return httpx.Response(400, json={"error": "invalid_grant"})
                return httpx.Response(
                    200, json={"access_token": "at-1", "refresh_token": "rt-secret", "expires_in": 3600}
                )
            if self.revoked:
                return httpx.Response(400, json={"error": "invalid_grant"})
            return httpx.Response(200, json={"access_token": "at-2", "expires_in": 3600})
        if url.startswith(gcal.REVOKE_URL):
            self.revoke_calls += 1
            return httpx.Response(200)
        assert request.headers["Authorization"].startswith("Bearer at-")
        path = urlsplit(url).path.removeprefix("/calendar/v3")
        parts = path.strip("/").split("/")
        if parts == ["calendars"] and request.method == "POST":
            self.calendars.add("cal1")
            return httpx.Response(200, json={"id": "cal1"})
        if len(parts) == 2 and parts[0] == "calendars":
            return httpx.Response(200 if parts[1] in self.calendars else 404, json={"id": parts[1]})
        if len(parts) >= 3 and parts[2] == "events":
            if len(parts) == 3 and request.method == "GET":
                q = parse_qs(urlsplit(url).query)
                token = q.get("syncToken", [None])[0]
                if token and self.expire_sync_token:
                    self.expire_sync_token = False
                    return httpx.Response(410)
                since = int(token) if token else 0
                items = [self._public(e) for e in self.events.values() if e["_seq"] > since]
                return httpx.Response(200, json={"items": items, "nextSyncToken": str(self.seq)})
            if len(parts) == 3 and request.method == "POST":
                self.seq += 1
                eid = f"ev{self.seq}"
                ev = {**json.loads(request.content), "id": eid, "status": "confirmed"}
                self.events[eid] = ev
                self._touch(ev)
                return httpx.Response(200, json=self._public(ev))
            eid = parts[3]
            ev = self.events.get(eid)
            if ev is None or ev.get("status") == "cancelled":
                return httpx.Response(404 if ev is None else 410)
            if request.method == "PATCH":
                ev.update(json.loads(request.content))
                self._touch(ev)
                return httpx.Response(200, json=self._public(ev))
            if request.method == "DELETE":
                ev["status"] = "cancelled"
                self._touch(ev)
                return httpx.Response(204)
        return httpx.Response(404)


@pytest.fixture
def google(monkeypatch: pytest.MonkeyPatch) -> Iterator[FakeGoogle]:
    s = get_settings()
    monkeypatch.setattr(s, "google_client_id", "client-id")
    monkeypatch.setattr(s, "google_client_secret", "client-secret")
    monkeypatch.setattr(s, "token_encryption_key", gcal.new_key())
    fake = FakeGoogle()
    monkeypatch.setattr(gcal, "_client", lambda: httpx.Client(transport=httpx.MockTransport(fake.handler)))
    yield fake


def connect(client: TestClient) -> httpx.Response:
    url = client.post("/api/v1/integrations/google/connect").json()["url"]
    q = parse_qs(urlsplit(url).query)
    assert q["scope"] == [gcal.SCOPE] and q["code_challenge_method"] == ["S256"] and q["access_type"] == ["offline"]
    return client.get(
        "/api/v1/integrations/google/callback",
        params={"code": "good-code", "state": q["state"][0]},
        follow_redirects=False,
    )


def sync(client: TestClient) -> dict:
    resp = client.post("/api/v1/integrations/google/sync")
    assert resp.status_code == 200, resp.text
    return resp.json()


def task_by_title(client: TestClient, title: str) -> dict:
    return next(t for t in client.get("/api/v1/tasks", params={"q": title}).json()["items"] if t["title"] == title)


def test_not_configured(client: TestClient, user: dict) -> None:
    assert client.get("/api/v1/integrations/google").json()["configured"] is False
    assert client.post("/api/v1/integrations/google/connect").status_code == 409


def test_connect_encrypts_tokens_and_pushes_existing_tasks(client: TestClient, user: dict, google: FakeGoogle) -> None:
    client.post("/api/v1/tasks", json={"title": "Dentist", "due_at": "2099-05-01T09:00:00Z", "due_has_time": True})
    client.post("/api/v1/tasks", json={"title": "No date"})
    resp = connect(client)
    assert resp.status_code == 303 and resp.headers["location"] == "/settings?google=connected"
    status = client.get("/api/v1/integrations/google").json()
    assert status["connected"] and status["status"] == "active" and status["last_synced_at"]

    with database.SessionLocal() as db:
        row = db.scalar(select(GoogleIntegration))
        assert row is not None and "rt-secret" not in row.refresh_token_enc  # encrypted at rest
    events = list(google.events.values())
    assert [e["summary"] for e in events] == ["Dentist"]
    assert events[0]["start"]["dateTime"].startswith("2099-05-01T09:00")
    assert events[0]["extendedProperties"]["private"]["lifeosTaskId"] == task_by_title(client, "Dentist")["id"]


def test_state_is_single_use_and_bound_to_the_user(client: TestClient, user: dict, google: FakeGoogle) -> None:
    url = client.post("/api/v1/integrations/google/connect").json()["url"]
    state = parse_qs(urlsplit(url).query)["state"][0]
    ok = client.get(
        "/api/v1/integrations/google/callback", params={"code": "good-code", "state": state}, follow_redirects=False
    )
    again = client.get(
        "/api/v1/integrations/google/callback", params={"code": "good-code", "state": state}, follow_redirects=False
    )
    forged = client.get(
        "/api/v1/integrations/google/callback", params={"code": "good-code", "state": "made-up"}, follow_redirects=False
    )
    denied = client.get(
        "/api/v1/integrations/google/callback", params={"error": "access_denied"}, follow_redirects=False
    )
    assert ok.headers["location"].endswith("connected")
    assert again.headers["location"].endswith("error") and forged.headers["location"].endswith("error")
    assert denied.headers["location"].endswith("cancelled")


def test_two_way_changes(client: TestClient, user: dict, google: FakeGoogle) -> None:
    connect(client)
    t = client.post(
        "/api/v1/tasks", json={"title": "Team lunch", "due_at": "2099-06-10T12:00:00Z", "due_has_time": True}
    ).json()
    sync(client)
    eid = next(e["id"] for e in google.events.values() if e["summary"] == "Team lunch")

    # Google → LifeOS: moved to an all-day event the next day and renamed.
    google.user_edit(eid, summary="Team lunch (moved)", start={"date": "2099-06-11"}, end={"date": "2099-06-12"})
    assert sync(client)["pulled"] == 1
    moved = task_by_title(client, "Team lunch (moved)")
    assert moved["id"] == t["id"] and moved["due_has_time"] is False and moved["due_at"].startswith("2099-06-11")
    assert moved["version"] > t["version"]  # offline clients receive it through normal sync

    # LifeOS → Google: completing shows a tick in the calendar.
    client.patch(f"/api/v1/tasks/{t['id']}", json={"status": "done"})
    sync(client)
    assert google.events[eid]["summary"] == "✓ Team lunch (moved)"

    # A new event created in the LifeOS calendar becomes a task, exactly once.
    google.user_create("Pick up parcel", {"dateTime": "2099-06-12T15:00:00Z"})
    sync(client)
    sync(client)
    assert len([x for x in client.get("/api/v1/tasks", params={"q": "parcel"}).json()["items"]]) == 1

    # Deleting in Google deletes the task; deleting in LifeOS cancels the event.
    google.user_edit(eid, status="cancelled")
    sync(client)
    assert client.get(f"/api/v1/tasks/{t['id']}").status_code == 404
    parcel = task_by_title(client, "Pick up parcel")
    client.delete(f"/api/v1/tasks/{parcel['id']}")
    sync(client)
    assert all(e["status"] == "cancelled" for e in google.events.values() if e.get("summary") == "Pick up parcel")


def test_conflict_most_recent_edit_wins(client: TestClient, user: dict, google: FakeGoogle) -> None:
    connect(client)
    t = client.post(
        "/api/v1/tasks", json={"title": "Report", "due_at": "2099-07-01T09:00:00Z", "due_has_time": True}
    ).json()
    sync(client)
    eid = next(iter(google.events))
    google.user_edit(eid, summary="Report (Google)")  # stamped 5 minutes in the future → newer
    client.patch(f"/api/v1/tasks/{t['id']}", json={"title": "Report (LifeOS)"})
    sync(client)
    assert client.get(f"/api/v1/tasks/{t['id']}").json()["title"] == "Report (Google)"
    assert google.events[eid]["summary"] == "Report (Google)"


def test_expired_sync_token_resyncs_without_duplicates(client: TestClient, user: dict, google: FakeGoogle) -> None:
    connect(client)
    google.user_create("From Google", {"date": "2099-08-01"})
    sync(client)
    google.expire_sync_token = True
    sync(client)
    assert client.get("/api/v1/tasks", params={"q": "From Google"}).json()["total"] == 1


def test_revoked_access_is_reported_and_disconnect_revokes(client: TestClient, user: dict, google: FakeGoogle) -> None:
    connect(client)
    with database.SessionLocal() as db:
        row = db.scalar(select(GoogleIntegration))
        assert row is not None
        row.access_expires_at = datetime.now(UTC) - timedelta(seconds=1)
        db.commit()
    google.revoked = True
    assert client.post("/api/v1/integrations/google/sync").status_code == 502
    status = client.get("/api/v1/integrations/google").json()
    assert status["status"] == "error" and "Reconnect" in status["last_error"]

    assert client.delete("/api/v1/integrations/google").status_code == 204
    assert google.revoke_calls == 1 and client.get("/api/v1/integrations/google").json()["connected"] is False


def test_worker_job_syncs_connected_users(client: TestClient, user: dict, google: FakeGoogle) -> None:
    connect(client)
    client.post("/api/v1/tasks", json={"title": "Via worker", "due_at": "2099-09-01T10:00:00Z", "due_has_time": True})
    with database.SessionLocal() as db:
        assert gcal.sync_due(db, datetime.now(UTC) + timedelta(hours=1)) == 1
        assert db.scalar(select(Task).where(Task.title == "Via worker")) is not None
    assert any(e["summary"] == "Via worker" for e in google.events.values())
