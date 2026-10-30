from datetime import UTC, date, datetime, timedelta

from fastapi.testclient import TestClient
from sqlalchemy import func, select, update

from app import db as database
from app.models import ActivityLog, Notification, Task, User
from app.services import reminders
from tests.conftest import register


def _run(job, now: datetime) -> int:  # type: ignore[no-untyped-def]
    with database.SessionLocal() as db:
        return job(db, now)


def test_reminder_sent_once_and_not_for_done_or_deleted(client: TestClient, user: dict) -> None:
    now = datetime.now(UTC)
    due = (now + timedelta(minutes=60)).isoformat()  # default reminder = due - 30 min
    a = client.post("/api/v1/tasks", json={"title": "Stand-up", "due_at": due, "due_has_time": True}).json()
    b = client.post("/api/v1/tasks", json={"title": "Done already", "remind_at": now.isoformat()}).json()
    c = client.post("/api/v1/tasks", json={"title": "Deleted", "remind_at": now.isoformat()}).json()
    client.patch(f"/api/v1/tasks/{b['id']}", json={"status": "done"})
    client.delete(f"/api/v1/tasks/{c['id']}")
    assert a["remind_at"] is not None

    later = now + timedelta(minutes=45)
    assert _run(reminders.dispatch_due_reminders, later) == 1
    assert _run(reminders.dispatch_due_reminders, later) == 0  # idempotent
    notes = client.get("/api/v1/notifications").json()
    assert [n["title"] for n in notes] == ["Reminder: Stand-up"]
    assert client.get("/api/v1/notifications/unread-count").json() == {"unread": 1}

    # Rescheduling re-arms the reminder.
    new_due = (now + timedelta(days=1)).isoformat()
    task = client.patch(f"/api/v1/tasks/{a['id']}", json={"due_at": new_due}).json()
    assert task["reminder_sent_at"] is None and task["remind_at"] is not None

    assert client.post(f"/api/v1/notifications/{notes[0]['id']}/read").json()["read_at"] is not None
    assert client.get("/api/v1/notifications", params={"unread_only": True}).json() == []


def test_daily_digest_respects_each_users_time_zone(client: TestClient) -> None:
    tokyo = register(client, tz="Asia/Tokyo")
    client.post("/api/v1/tasks", json={"title": "Tokyo task", "scheduled_for": "2026-06-02"})
    client.post("/api/v1/tasks", json={"title": "Late thing", "due_at": "2026-06-01T00:00:00Z"})
    with TestClient(client.app) as ny_client:
        register(ny_client, tz="America/New_York")
        ny_client.post("/api/v1/tasks", json={"title": "NY task", "scheduled_for": "2026-06-02"})

        # 2026-06-01 23:30 UTC = 08:30 on 06-02 in Tokyo, 19:30 on 06-01 in New York.
        moment = datetime(2026, 6, 1, 23, 30, tzinfo=UTC)
        assert _run(reminders.dispatch_daily_digests, moment) == 1
        digest = client.get("/api/v1/notifications").json()
        assert digest[0]["kind"] == "digest" and "1 planned" in digest[0]["body"] and "1 overdue" in digest[0]["body"]
        assert ny_client.get("/api/v1/notifications").json() == []

        # Same local day in Tokyo → no second digest.
        assert _run(reminders.dispatch_daily_digests, moment + timedelta(hours=3)) == 0
        # 08:00 on 06-02 in New York = 12:00 UTC.
        assert _run(reminders.dispatch_daily_digests, datetime(2026, 6, 2, 12, 0, tzinfo=UTC)) == 1
        assert ny_client.get("/api/v1/notifications").json()[0]["kind"] == "digest"
    assert tokyo["user"]["timezone"] == "Asia/Tokyo"


def test_digest_skipped_when_disabled_or_nothing_to_report(client: TestClient, user: dict) -> None:
    moment = datetime(2026, 6, 1, 12, 0, tzinfo=UTC)
    assert _run(reminders.dispatch_daily_digests, moment) == 0  # no tasks
    client.patch("/api/v1/auth/me", json={"daily_digest_enabled": False})
    client.post("/api/v1/tasks", json={"title": "x", "scheduled_for": "2026-06-02"})
    assert _run(reminders.dispatch_daily_digests, datetime(2026, 6, 2, 12, 0, tzinfo=UTC)) == 0


def test_retention_purge(client: TestClient, user: dict) -> None:
    tid = client.post("/api/v1/tasks", json={"title": "old"}).json()["id"]
    client.delete(f"/api/v1/tasks/{tid}")
    old = datetime.now(UTC) - timedelta(days=400)
    with database.engine.begin() as conn:
        conn.execute(update(Task).values(deleted_at=old))
        conn.execute(update(ActivityLog).values(created_at=old))
    with database.SessionLocal() as db:
        result = reminders.purge_expired_data(db)
        assert result["tombstones"] == 1 and result["activity"] >= 2
        assert db.scalar(select(func.count()).select_from(Task)) == 0
        assert db.scalar(select(User.last_digest_on)) in (None, date.today())
        assert db.scalar(select(func.count()).select_from(Notification)) == 0
