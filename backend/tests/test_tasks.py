import uuid
from datetime import UTC, datetime, timedelta

from fastapi.testclient import TestClient

from app import db as database
from app.main import app
from tests.conftest import register


def _future(hours: int = 48) -> str:
    return (datetime.now(UTC) + timedelta(hours=hours)).isoformat()


def test_create_get_update_complete_delete_restore(client: TestClient, user: dict) -> None:
    resp = client.post(
        "/api/v1/tasks",
        json={
            "title": "  Write report  ",
            "priority": "high",
            "category": "work",
            "due_at": _future(),
            "due_has_time": True,
        },
    )
    assert resp.status_code == 201, resp.text
    task = resp.json()
    assert task["title"] == "Write report"
    assert task["version"] == 1 and task["status"] == "todo"
    assert task["remind_at"] is not None  # smart default reminder (30 min before)

    tid = task["id"]
    assert client.get(f"/api/v1/tasks/{tid}").json()["title"] == "Write report"

    done = client.patch(f"/api/v1/tasks/{tid}", json={"status": "done", "version": 1})
    assert done.status_code == 200
    assert done.json()["completed_at"] is not None and done.json()["version"] == 2

    reopened = client.patch(f"/api/v1/tasks/{tid}", json={"status": "todo"})
    assert reopened.json()["completed_at"] is None

    assert client.delete(f"/api/v1/tasks/{tid}").status_code == 204
    assert client.get(f"/api/v1/tasks/{tid}").status_code == 404
    assert client.get("/api/v1/tasks").json()["total"] == 0

    restored = client.post(f"/api/v1/tasks/{tid}/restore")
    assert restored.status_code == 200 and restored.json()["deleted_at"] is None


def test_validation_errors(client: TestClient, user: dict) -> None:
    cases = [
        {"title": ""},
        {"title": "   "},
        {"title": "x" * 201},
        {"title": "ok", "priority": "critical"},
        {"title": "ok", "due_at": "2026-01-01T10:00:00"},  # naive datetimes are rejected
        {"title": "ok", "due_at": "3000-01-01T10:00:00Z"},
        {"title": "ok", "estimated_minutes": 0},
        {"title": "ok", "description": "d" * 5001},
        {"title": "ok", "goal_id": str(uuid.uuid4())},
    ]
    for payload in cases:
        assert client.post("/api/v1/tasks", json=payload).status_code == 422, payload


def test_oversized_body_rejected(client: TestClient, user: dict) -> None:
    resp = client.post(
        "/api/v1/tasks", content=b'{"title":"' + b"a" * 2_100_000 + b'"}', headers={"Content-Type": "application/json"}
    )
    assert resp.status_code == 413


def test_users_cannot_access_each_others_tasks(client: TestClient, user: dict) -> None:
    tid = client.post("/api/v1/tasks", json={"title": "Private"}).json()["id"]
    with TestClient(app) as other:
        register(other)
        assert other.get(f"/api/v1/tasks/{tid}").status_code == 404
        assert other.patch(f"/api/v1/tasks/{tid}", json={"title": "hacked"}).status_code == 404
        assert other.delete(f"/api/v1/tasks/{tid}").status_code == 404
        assert other.get("/api/v1/tasks").json()["total"] == 0
        # Reusing someone else's id for a create must not leak or overwrite.
        assert other.post("/api/v1/tasks", json={"id": tid, "title": "mine"}).status_code == 409
    assert client.get(f"/api/v1/tasks/{tid}").json()["title"] == "Private"


def test_create_with_client_id_is_idempotent(client: TestClient, user: dict) -> None:
    tid = str(uuid.uuid4())
    first = client.post("/api/v1/tasks", json={"id": tid, "title": "Once"})
    second = client.post("/api/v1/tasks", json={"id": tid, "title": "Once"})
    assert (first.status_code, second.status_code) == (201, 200)
    assert client.get("/api/v1/tasks").json()["total"] == 1


def test_optimistic_concurrency_conflict(client: TestClient, user: dict) -> None:
    tid = client.post("/api/v1/tasks", json={"title": "Shared"}).json()["id"]
    assert client.patch(f"/api/v1/tasks/{tid}", json={"title": "Edit A", "version": 1}).status_code == 200
    stale = client.patch(f"/api/v1/tasks/{tid}", json={"title": "Edit B", "version": 1})
    assert stale.status_code == 409
    assert stale.json()["detail"]["current"]["title"] == "Edit A"


def test_list_filters_search_sort_pagination(client: TestClient, user: dict) -> None:
    past = (datetime.now(UTC) - timedelta(days=1)).isoformat()
    client.post("/api/v1/tasks", json={"title": "Buy milk", "category": "home", "priority": "low"})
    client.post(
        "/api/v1/tasks", json={"title": "Fix 100% bug_x", "category": "work", "priority": "urgent", "due_at": past}
    )
    client.post(
        "/api/v1/tasks", json={"title": "Plan sprint", "category": "work", "priority": "medium", "due_at": _future()}
    )
    done = client.post("/api/v1/tasks", json={"title": "Old thing"}).json()
    client.patch(f"/api/v1/tasks/{done['id']}", json={"status": "done"})

    def titles(**params: object) -> list[str]:
        return [t["title"] for t in client.get("/api/v1/tasks", params=params).json()["items"]]

    assert set(titles(category="work")) == {"Fix 100% bug_x", "Plan sprint"}
    assert titles(q="MILK") == ["Buy milk"]
    assert titles(q="100%") == ["Fix 100% bug_x"]  # LIKE wildcards are escaped
    assert titles(q="%") == ["Fix 100% bug_x"]
    assert titles(q="bug_") == ["Fix 100% bug_x"]
    assert titles(overdue=True) == ["Fix 100% bug_x"]
    assert "Old thing" not in titles(include_done=False)
    assert titles(status="done") == ["Old thing"]
    assert titles(sort="priority")[0] == "Fix 100% bug_x"
    page = client.get("/api/v1/tasks", params={"page_size": 2, "page": 2}).json()
    assert page["total"] == 4 and len(page["items"]) == 2
    assert client.get("/api/v1/tasks", params={"page_size": 500}).status_code == 422
    assert client.get("/api/v1/tasks/categories").json() == ["home", "work"]


def test_tasks_persist_after_restart(client: TestClient, user: dict) -> None:
    tid = client.post("/api/v1/tasks", json={"title": "Survives restart"}).json()["id"]
    url = database.engine.url.render_as_string(hide_password=False)
    database.configure_engine(url)  # drop every pooled connection, as a process restart would
    assert client.get(f"/api/v1/tasks/{tid}").json()["title"] == "Survives restart"


def test_explicit_null_reminder_disables_default(client: TestClient, user: dict) -> None:
    resp = client.post(
        "/api/v1/tasks", json={"title": "No ping", "due_at": _future(), "due_has_time": True, "remind_at": None}
    )
    assert resp.json()["remind_at"] is None
    # Date-only tasks never get an automatic reminder.
    date_only = client.post("/api/v1/tasks", json={"title": "Date only", "due_at": _future(), "due_has_time": False})
    assert date_only.json()["remind_at"] is None


def test_planning_views_group_by_local_day(client: TestClient) -> None:
    register(client, tz="Asia/Tokyo")
    # 2026-03-10 23:30 UTC is 2026-03-11 08:30 in Tokyo.
    client.post(
        "/api/v1/tasks", json={"title": "Tokyo morning", "due_at": "2026-03-10T23:30:00Z", "due_has_time": True}
    )
    client.post("/api/v1/tasks", json={"title": "Planned", "scheduled_for": "2026-03-12"})
    day = client.get("/api/v1/planning", params={"view": "day", "date": "2026-03-11"}).json()
    assert [t["title"] for t in day["days"][0]["tasks"]] == ["Tokyo morning"]
    week = client.get("/api/v1/planning", params={"view": "week", "date": "2026-03-11"}).json()
    assert week["start"] == "2026-03-09" and week["end"] == "2026-03-15"
    by_day = {d["date"]: [t["title"] for t in d["tasks"]] for d in week["days"]}
    assert by_day["2026-03-11"] == ["Tokyo morning"] and by_day["2026-03-12"] == ["Planned"]
    month = client.get("/api/v1/planning", params={"view": "month", "date": "2026-02-10"}).json()
    assert len(month["days"]) == 28


def test_unknown_api_route_returns_json_404(client: TestClient) -> None:
    resp = client.get("/api/v1/does-not-exist")
    assert resp.status_code == 404 and resp.json() == {"detail": "Not found"}
