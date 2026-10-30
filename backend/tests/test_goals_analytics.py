from fastapi.testclient import TestClient

from app.main import app
from tests.conftest import register


def test_goal_crud_and_progress(client: TestClient, user: dict) -> None:
    metric = client.post("/api/v1/goals", json={"title": "Read 12 books", "target_value": 12, "unit": "books"}).json()
    assert metric["progress"] == 0 and metric["status"] == "active"
    halfway = client.patch(f"/api/v1/goals/{metric['id']}", json={"current_value": 6}).json()
    assert halfway["progress"] == 0.5
    reached = client.patch(f"/api/v1/goals/{metric['id']}", json={"current_value": 12}).json()
    assert reached["status"] == "completed" and reached["progress"] == 1.0

    linked = client.post("/api/v1/goals", json={"title": "Launch site", "target_date": "2026-12-31"}).json()
    ids = [
        client.post("/api/v1/tasks", json={"title": f"Step {i}", "goal_id": linked["id"]}).json()["id"]
        for i in range(4)
    ]
    client.patch(f"/api/v1/tasks/{ids[0]}", json={"status": "done"})
    got = client.get(f"/api/v1/goals/{linked['id']}").json()
    assert (got["tasks_total"], got["tasks_done"], got["progress"]) == (4, 1, 0.25)

    client.patch(f"/api/v1/goals/{linked['id']}", json={"status": "archived"})
    assert [g["title"] for g in client.get("/api/v1/goals").json()] == ["Read 12 books"]
    assert len(client.get("/api/v1/goals", params={"include_archived": True}).json()) == 2

    assert client.post("/api/v1/goals", json={"title": "x", "target_value": -1}).status_code == 422


def test_deleting_goal_unlinks_tasks_with_new_version(client: TestClient, user: dict) -> None:
    goal = client.post("/api/v1/goals", json={"title": "G"}).json()
    task = client.post("/api/v1/tasks", json={"title": "T", "goal_id": goal["id"]}).json()
    assert client.delete(f"/api/v1/goals/{goal['id']}").status_code == 204
    after = client.get(f"/api/v1/tasks/{task['id']}").json()
    assert after["goal_id"] is None and after["version"] == task["version"] + 1
    assert client.get(f"/api/v1/goals/{goal['id']}").status_code == 404


def test_goals_are_private(client: TestClient, user: dict) -> None:
    goal = client.post("/api/v1/goals", json={"title": "Mine"}).json()
    with TestClient(app) as other:
        register(other)
        assert other.get(f"/api/v1/goals/{goal['id']}").status_code == 404
        assert other.post("/api/v1/tasks", json={"title": "x", "goal_id": goal["id"]}).status_code == 422


def test_analytics_overview(client: TestClient, user: dict) -> None:
    for i in range(3):
        tid = client.post("/api/v1/tasks", json={"title": f"Done {i}", "category": "work", "priority": "high"}).json()[
            "id"
        ]
        client.patch(f"/api/v1/tasks/{tid}", json={"status": "done"})
    client.post("/api/v1/tasks", json={"title": "Open", "priority": "urgent", "due_at": "2020-01-01T00:00:00Z"})
    stats = client.get("/api/v1/analytics/overview", params={"days": 7}).json()
    assert len(stats["series"]) == 7
    assert stats["completed_total"] == 3 and stats["created_total"] == 4
    assert stats["overdue_total"] == 1 and stats["open_total"] == 1
    assert stats["streak_days"] == 1
    assert stats["open_by_priority"]["urgent"] == 1
    assert stats["by_category"][0] == {"category": "work", "open": 0, "done": 3}
    assert client.get("/api/v1/analytics/overview", params={"days": 3}).status_code == 422


def test_activity_history_search_pagination_and_clear(client: TestClient, user: dict) -> None:
    client.post("/api/v1/tasks", json={"title": "Alpha report"})
    client.post("/api/v1/tasks", json={"title": "Beta plan"})
    page = client.get("/api/v1/activity", params={"page_size": 2}).json()
    assert page["total"] == 3 and len(page["items"]) == 2  # account.created + 2 tasks
    found = client.get("/api/v1/activity", params={"q": "alpha"}).json()
    assert [i["summary"] for i in found["items"]] == ["Created task “Alpha report”"]
    assert client.get("/api/v1/activity", params={"entity_type": "account"}).json()["total"] == 1
    assert client.delete("/api/v1/activity").status_code == 204
    assert client.get("/api/v1/activity").json()["total"] == 0


def test_summary_wording_counts_future_deadlines_as_ahead(client: TestClient, user: dict) -> None:
    from datetime import UTC, datetime, timedelta

    soon = (datetime.now(UTC) + timedelta(minutes=5)).isoformat()
    client.post("/api/v1/tasks", json={"title": "Later today", "due_at": soon, "due_has_time": True})
    s = client.get("/api/v1/ai/summary", params={"period": "day", "use_llm": False}).json()
    assert s["stats"]["due_done"] == 0 and s["stats"]["top_category"] is None
    assert "Of the 1 task due today, 0 are done and 1 still ahead." in s["narrative"]
    assert "Uncategorised" not in s["narrative"]
