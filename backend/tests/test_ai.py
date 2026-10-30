import uuid
from datetime import UTC, datetime, timedelta

from fastapi.testclient import TestClient
from sqlalchemy import update

from app import db as database
from app.models import Task
from tests.conftest import FakeLLM


def _count(client: TestClient) -> int:
    return client.get("/api/v1/tasks").json()["total"]


def test_parse_is_preview_only_and_flags_duplicates(client: TestClient, user: dict) -> None:
    client.post("/api/v1/tasks", json={"title": "Buy milk"})
    resp = client.post("/api/v1/ai/parse", json={"text": "buy MILK!\nCall Ana tomorrow at 5pm #family"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["parser"] == "rules"
    assert [t["title"] for t in body["tasks"]] == ["Buy MILK!", "Call Ana"]
    assert body["tasks"][0]["duplicate_of"]["title"] == "Buy milk"
    assert body["tasks"][1]["duplicate_of"] is None and body["tasks"][1]["category"] == "family"
    assert _count(client) == 1  # nothing was created


def test_from_text_is_idempotent_and_never_duplicates(client: TestClient, user: dict) -> None:
    request_id = str(uuid.uuid4())
    payload = {"text": "Pay rent tomorrow; pay rent tomorrow; book dentist", "request_id": request_id}
    first = client.post("/api/v1/ai/tasks/from-text", json=payload).json()
    assert [r["reason"] for r in first["results"]] == ["created", "created"]
    assert any("repeated" in w for w in first["warnings"])

    retry = client.post("/api/v1/ai/tasks/from-text", json=payload).json()
    assert {r["reason"] for r in retry["results"]} == {"replayed"}
    assert _count(client) == 2

    # Same content under a new request id → matched to the open tasks, nothing new.
    again = client.post("/api/v1/ai/tasks/from-text", json={**payload, "request_id": str(uuid.uuid4())}).json()
    assert [r["reason"] for r in again["results"]] == ["duplicate", "duplicate"]
    assert _count(client) == 2


def test_completed_task_with_same_title_is_not_a_duplicate(client: TestClient, user: dict) -> None:
    tid = client.post("/api/v1/tasks", json={"title": "Water plants"}).json()["id"]
    client.patch(f"/api/v1/tasks/{tid}", json={"status": "done"})
    out = client.post("/api/v1/ai/tasks/from-text", json={"text": "water plants", "request_id": str(uuid.uuid4())})
    assert out.json()["results"][0]["reason"] == "created"


def test_llm_output_is_used_when_valid(client: TestClient, user: dict, fake_llm: FakeLLM) -> None:
    fake_llm.json_responses.append(
        {
            "tasks": [
                {
                    "title": "Prepare slides",
                    "due_date": "2026-12-01",
                    "due_time": "09:30",
                    "priority": "high",
                    "category": "#work",
                    "remind": True,
                }
            ]
        }
    )
    body = client.post("/api/v1/ai/parse", json={"text": "need slides ready dec 1 morning, important"}).json()
    assert body["parser"] == "llm"
    task = body["tasks"][0]
    assert task["title"] == "Prepare slides" and task["priority"] == "high" and task["category"] == "work"
    assert task["due_at"].startswith("2026-12-01T09:30") and task["remind_at"] == task["due_at"]
    # The note is fenced as data in the prompt.
    assert "<<<" in fake_llm.calls[0][1]


def test_invalid_llm_output_falls_back_to_rules(client: TestClient, user: dict, fake_llm: FakeLLM) -> None:
    for bad in (
        {"tasks": []},
        {"tasks": [{"title": ""}]},
        {"tasks": [{"title": "x", "priority": "galaxy"}]},
        {"nope": 1},
        None,
    ):
        fake_llm.json_responses.append(bad)
        body = client.post("/api/v1/ai/parse", json={"text": "call bob tomorrow"}).json()
        assert body["parser"] == "rules" and body["tasks"][0]["title"] == "Call bob", bad


def test_commands(client: TestClient, user: dict) -> None:
    def cmd(text: str) -> dict:
        resp = client.post("/api/v1/ai/command", json={"text": text, "request_id": str(uuid.uuid4())})
        assert resp.status_code == 200, resp.text
        return resp.json()

    created = cmd("add call Alex tomorrow at 5pm")
    assert created["intent"] == "create_task" and created["tasks"][0]["title"] == "Call Alex"
    assert created["tasks"][0]["source"] == "voice"
    assert cmd("add call alex")["message"].startswith("You already have")

    cmd("add write blog post")
    cmd("add write release notes")
    ambiguous = cmd("complete write")
    assert ambiguous["intent"] == "complete_task" and len(ambiguous["candidates"]) == 2
    done = cmd("mark call alex as done")
    assert done["tasks"][0]["status"] == "done"
    assert "No open task" in cmd("complete feed the dragon")["message"]

    assert cmd("show my goals")["navigate_to"] == "/goals"
    assert cmd("what's due today")["navigate_to"] == "/"
    assert cmd("give me a summary")["intent"] == "summary"
    unknown = cmd("sing me a song")
    assert unknown["intent"] == "unknown" and _count(client) == 3  # nothing created by accident


def test_prioritize_and_attention(client: TestClient, user: dict) -> None:
    now = datetime.now(UTC)
    client.post(
        "/api/v1/tasks",
        json={"title": "Low later", "priority": "low", "due_at": (now + timedelta(days=20)).isoformat()},
    )
    overdue = client.post(
        "/api/v1/tasks",
        json={"title": "Overdue", "priority": "medium", "due_at": (now - timedelta(days=2)).isoformat()},
    ).json()
    client.post(
        "/api/v1/tasks",
        json={"title": "Urgent soon", "priority": "urgent", "due_at": (now + timedelta(hours=3)).isoformat()},
    )
    stale = client.post("/api/v1/tasks", json={"title": "Forgotten"}).json()
    with database.engine.begin() as conn:
        conn.execute(update(Task).where(Task.id == uuid.UUID(stale["id"])).values(updated_at=now - timedelta(days=30)))

    ranked = client.get("/api/v1/ai/prioritize").json()
    titles = [i["task"]["title"] for i in ranked["items"]]
    # urgent+due in 3h (40+30) outranks medium+2 days overdue (16+35+4); low/far-off comes last.
    assert titles == ["Urgent soon", "Overdue", "Forgotten", "Low later"]
    assert any("Overdue by 2 days" in r for r in ranked["items"][1]["reasons"])
    assert any("Untouched for 30 days" in r for r in ranked["items"][2]["reasons"])
    assert ranked["generated_by"] == "rules"

    att = client.get("/api/v1/ai/attention").json()
    assert [t["id"] for t in att["overdue"]] == [overdue["id"]]
    assert [t["title"] for t in att["neglected"]] == ["Forgotten"]


def test_summary_and_insights_with_and_without_llm(client: TestClient, user: dict, fake_llm: FakeLLM) -> None:
    tid = client.post("/api/v1/tasks", json={"title": "Ship feature", "category": "work"}).json()["id"]
    client.patch(f"/api/v1/tasks/{tid}", json={"status": "done"})
    client.post("/api/v1/tasks", json={"title": "Pending"})

    s = client.get("/api/v1/ai/summary", params={"period": "week"}).json()
    assert s["generated_by"] == "rules"
    assert s["stats"]["created"] == 2 and s["stats"]["completed"] == 1
    assert s["highlights"] == ["Ship feature"] and "completed 1 task" in s["narrative"]
    assert s["stats"]["top_category"] == "work" and "“work”" in s["narrative"]

    fake_llm.text_responses.append("Great week! You shipped a feature.")
    s2 = client.get("/api/v1/ai/summary", params={"period": "day"}).json()
    assert s2["generated_by"] == "llm" and s2["narrative"] == "Great week! You shipped a feature."

    ins = client.get("/api/v1/ai/insights").json()
    assert ins["generated_by"] == "rules" and ins["insights"]
    fake_llm.json_responses.append({"insights": ["You do your best work on weekdays."]})
    assert client.get("/api/v1/ai/insights").json()["generated_by"] == "llm"

    assert client.get("/api/v1/ai/summary", params={"period": "year"}).status_code == 422


def test_ai_status_reports_fake(client: TestClient, user: dict) -> None:
    assert client.get("/api/v1/ai/status").json()["available"] is False


def test_ai_endpoints_rate_limited(client: TestClient, user: dict) -> None:
    codes = [client.post("/api/v1/ai/parse", json={"text": "x"}).status_code for _ in range(31)]
    assert codes[-1] == 429 and codes[0] == 200
