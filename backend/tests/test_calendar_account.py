import csv
import io
import json
import uuid

from fastapi.testclient import TestClient
from sqlalchemy import func, select

from app import db as database
from app.models import (
    ActivityLog,
    AuthSession,
    Goal,
    GoogleEventLink,
    GoogleIntegration,
    Notification,
    PushSubscription,
    Task,
    User,
)

ICS = b"""BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Test//EN
BEGIN:VEVENT
UID:evt-1@test
SUMMARY:Team offsite
DTSTART:20261203T090000Z
DTEND:20261203T170000Z
END:VEVENT
BEGIN:VEVENT
UID:evt-2@test
SUMMARY:Holiday
DTSTART;VALUE=DATE:20261225
END:VEVENT
BEGIN:VTODO
UID:todo-1@test
SUMMARY:Return library books
DUE;VALUE=DATE:20261110
STATUS:COMPLETED
END:VTODO
BEGIN:VEVENT
UID:evt-3@test
DTSTART:20261203T090000Z
END:VEVENT
END:VCALENDAR
"""


def _upload(client: TestClient, payload: bytes, name: str = "cal.ics"):  # type: ignore[no-untyped-def]
    return client.post("/api/v1/calendar/import", files={"file": (name, payload, "text/calendar")})


def test_calendar_import_creates_tasks_and_deduplicates(client: TestClient, user: dict) -> None:
    first = _upload(client, ICS)
    assert first.status_code == 200, first.text
    assert first.json()["created"] == 3 and first.json()["skipped"] == 1  # untitled event skipped
    tasks = {t["title"]: t for t in client.get("/api/v1/tasks").json()["items"]}
    assert tasks["Team offsite"]["due_at"].startswith("2026-12-03T09:00") and tasks["Team offsite"]["due_has_time"]
    assert not tasks["Holiday"]["due_has_time"]
    assert tasks["Return library books"]["status"] == "done"
    assert tasks["Team offsite"]["source"] == "calendar_import"

    again = _upload(client, ICS)
    assert again.json()["created"] == 0 and again.json()["skipped"] == 4
    assert client.get("/api/v1/tasks").json()["total"] == 3


def test_calendar_import_rejects_bad_files(client: TestClient, user: dict) -> None:
    assert _upload(client, ICS, name="cal.txt").status_code == 415
    assert _upload(client, b"hello world").status_code == 422
    assert _upload(client, b"BEGIN:VCALENDAR\nthis is broken").status_code in (200, 422)
    big = b"BEGIN:VCALENDAR\n" + b"X" * 1_100_000
    assert _upload(client, big).status_code == 413


def test_calendar_feed_lifecycle(client: TestClient, user: dict) -> None:
    client.post("/api/v1/tasks", json={"title": "Timed", "due_at": "2026-12-01T10:00:00Z", "due_has_time": True})
    client.post("/api/v1/tasks", json={"title": "No due"})
    url = client.post("/api/v1/calendar/token").json()["url"]
    path = url[url.index("/api/") :]
    assert client.get("/api/v1/auth/me").json()["has_calendar_feed"] is True

    client.cookies.clear()  # calendar apps have no session cookie
    feed = client.get(path)
    assert feed.status_code == 200 and feed.headers["content-type"].startswith("text/calendar")
    assert b"SUMMARY:Timed" in feed.content and b"No due" not in feed.content

    assert client.get("/api/v1/calendar/feed/not-a-token.ics").status_code == 404
    client.cookies.set("lifeos_session", "")  # sign back in for revoke
    login = client.post("/api/v1/auth/login", json={"email": user["email"], "password": user["password"]})
    client.headers["X-CSRF-Token"] = login.json()["csrf_token"]
    assert client.delete("/api/v1/calendar/token").status_code == 204
    assert client.get(path).status_code == 404


def test_export_json_and_csv(client: TestClient, user: dict) -> None:
    client.post("/api/v1/tasks", json={"title": '=HYPERLINK("http://evil")', "category": "work"})
    client.post("/api/v1/goals", json={"title": "Run 100km", "target_value": 100, "unit": "km"})

    j = client.get("/api/v1/account/export", params={"format": "json"})
    assert j.status_code == 200 and "attachment" in j.headers["content-disposition"]
    doc = json.loads(j.content)
    assert doc["format"] == "lifeos-export" and doc["user"]["email"] == user["email"]
    assert len(doc["tasks"]) == 1 and len(doc["goals"]) == 1 and doc["activity"]
    assert "password_hash" not in json.dumps(doc)

    c = client.get("/api/v1/account/export", params={"format": "csv"})
    rows = list(csv.reader(io.StringIO(c.content.decode("utf-8-sig"))))
    assert rows[0][:2] == ["id", "title"]
    assert rows[1][1].startswith("'=")  # formula injection neutralised


def test_delete_account_removes_all_data(client: TestClient, user: dict) -> None:
    client.post("/api/v1/tasks", json={"title": "t"})
    client.post("/api/v1/goals", json={"title": "g"})
    assert (
        client.request("DELETE", "/api/v1/account", json={"password": "wrong-one", "confirm": "DELETE"}).status_code
        == 400
    )
    assert (
        client.request("DELETE", "/api/v1/account", json={"password": user["password"], "confirm": "yes"}).status_code
        == 422
    )
    resp = client.request("DELETE", "/api/v1/account", json={"password": user["password"], "confirm": "DELETE"})
    assert resp.status_code == 204
    assert client.get("/api/v1/auth/me").status_code == 401
    with database.SessionLocal() as db:
        uid = uuid.UUID(user["user"]["id"])
        for model in (
            Task,
            Goal,
            ActivityLog,
            Notification,
            AuthSession,
            PushSubscription,
            GoogleIntegration,
            GoogleEventLink,
        ):
            assert db.scalar(select(func.count()).select_from(model).where(model.user_id == uid)) == 0, model
        assert db.get(User, uid) is None
