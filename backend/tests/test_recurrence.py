import uuid
from datetime import UTC, datetime

import pytest
from fastapi.testclient import TestClient

from app.services import recurrence
from app.services.nlp import parse_line
from tests.conftest import register

NOW = datetime(2026, 10, 30, 14, 0, tzinfo=UTC)  # Friday


@pytest.mark.parametrize(
    ("rule", "normalised"),
    [
        ("freq=daily", "FREQ=DAILY"),
        ("RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=MO,TH", "FREQ=WEEKLY;BYDAY=MO,TH"),
        ("FREQ=MONTHLY;BYDAY=-1FR", "FREQ=MONTHLY;BYDAY=-1FR"),
        ("FREQ=MONTHLY;BYMONTHDAY=-1", "FREQ=MONTHLY;BYMONTHDAY=-1"),
    ],
)
def test_rules_are_validated_and_normalised(rule: str, normalised: str) -> None:
    assert recurrence.normalise(rule) == normalised


@pytest.mark.parametrize(
    "bad",
    [
        "FREQ=HOURLY",
        "FREQ=DAILY;COUNT=3",
        "FREQ=WEEKLY;BYDAY=XX",
        "FREQ=WEEKLY;BYDAY=1MO",
        "FREQ=DAILY;INTERVAL=0",
        "FREQ=MONTHLY;BYMONTHDAY=32",
        "BYDAY=MO",
        "FREQ",
        "FREQ=DAILY;FREQ=DAILY",
        "FREQ=DAILY;" + "X" * 300,
    ],
)
def test_invalid_rules_are_rejected(bad: str) -> None:
    with pytest.raises(recurrence.RecurrenceError):
        recurrence.normalise(bad)


def test_next_due_keeps_local_wall_time_across_dst() -> None:
    # 09:00 New York on Fri 2026-10-30 (EDT, 13:00Z) → next Friday 2026-11-06 09:00 EST (14:00Z).
    due = datetime(2026, 10, 30, 13, 0, tzinfo=UTC)
    nxt = recurrence.next_due("FREQ=WEEKLY", due, True, "America/New_York", NOW)
    assert nxt == datetime(2026, 11, 6, 14, 0, tzinfo=UTC)


def test_next_due_skips_missed_occurrences_instead_of_piling_up() -> None:
    due = datetime(2026, 10, 20, 9, 0, tzinfo=UTC)  # a daily task completed 10 days late
    nxt = recurrence.next_due("FREQ=DAILY", due, True, "UTC", NOW)
    assert nxt == datetime(2026, 10, 30, 9, 0, tzinfo=UTC)  # today's slot, not Oct 21


def test_describe() -> None:
    assert recurrence.describe("FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR") == "Every weekday"
    assert recurrence.describe("FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TH") == "Every 2 weeks on Mon, Thu"
    assert recurrence.describe("FREQ=MONTHLY;BYMONTHDAY=-1") == "Every month on the last day"


@pytest.mark.parametrize(
    ("text", "title", "rule", "local"),
    [
        ("gym every monday morning", "Gym", "FREQ=WEEKLY;BYDAY=MO", "2026-11-02 09:00"),
        ("standup every weekday at 9:30am", "Standup", "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR", "2026-11-02 09:30"),
        ("water plants every 3 days", "Water plants", "FREQ=DAILY;INTERVAL=3", "2026-10-30 23:59"),
        ("review goals every other week", "Review goals", "FREQ=WEEKLY;INTERVAL=2", "2026-10-30 23:59"),
        ("call grandma every sun and wed at 6pm", "Call grandma", "FREQ=WEEKLY;BYDAY=SU,WE", "2026-11-01 18:00"),
        ("take vitamins daily at 8am", "Take vitamins", "FREQ=DAILY", "2026-10-31 08:00"),
        ("journal every night", "Journal", "FREQ=DAILY", "2026-10-30 21:00"),
        ("renew domain yearly on 2027-03-01", "Renew domain", "FREQ=YEARLY", "2027-03-01 23:59"),
    ],
)
def test_parser_understands_repeats(text: str, title: str, rule: str, local: str) -> None:
    r = parse_line(text, "UTC", NOW)
    assert (r.title, r.recurrence, f"{r.due_at:%Y-%m-%d %H:%M}") == (title, rule, local)
    assert not r.warnings


def _complete(client: TestClient, task_id: str) -> dict:
    resp = client.patch(f"/api/v1/tasks/{task_id}", json={"status": "done"})
    assert resp.status_code == 200, resp.text
    return resp.json()


def _open_titles(client: TestClient) -> list[tuple[str, str]]:
    items = client.get("/api/v1/tasks", params={"include_done": False}).json()["items"]
    return [(t["title"], t["due_at"]) for t in items]


def test_completing_a_repeating_task_schedules_the_next_one_once(client: TestClient, user: dict) -> None:
    created = client.post(
        "/api/v1/tasks",
        json={
            "title": "Weekly review",
            "due_at": "2099-01-02T17:00:00Z",
            "due_has_time": True,
            "remind_at": "2099-01-02T16:45:00Z",
            "recurrence": "FREQ=WEEKLY",
            "priority": "high",
            "category": "work",
        },
    ).json()
    assert created["recurrence"] == "FREQ=WEEKLY" and created["series_id"] == created["id"]

    _complete(client, created["id"])
    assert _open_titles(client) == [("Weekly review", "2099-01-09T17:00:00Z")]
    nxt = client.get("/api/v1/tasks", params={"include_done": False}).json()["items"][0]
    assert nxt["series_id"] == created["id"] and nxt["priority"] == "high" and nxt["category"] == "work"
    assert nxt["remind_at"] == "2099-01-09T16:45:00Z"  # same 15-minute lead time

    # Reopen and complete again: still exactly one next occurrence.
    client.patch(f"/api/v1/tasks/{created['id']}", json={"status": "todo"})
    _complete(client, created["id"])
    assert len(_open_titles(client)) == 1


def test_repeat_needs_a_due_date_and_valid_rule(client: TestClient, user: dict) -> None:
    assert client.post("/api/v1/tasks", json={"title": "x", "recurrence": "FREQ=DAILY"}).status_code == 422
    bad = client.post(
        "/api/v1/tasks", json={"title": "x", "due_at": "2099-01-01T00:00:00Z", "recurrence": "FREQ=HOURLY"}
    )
    assert bad.status_code == 422
    # Removing the rule stops the series.
    t = client.post(
        "/api/v1/tasks", json={"title": "Stop me", "due_at": "2099-01-01T10:00:00Z", "recurrence": "FREQ=DAILY"}
    ).json()
    client.patch(f"/api/v1/tasks/{t['id']}", json={"recurrence": None})
    _complete(client, t["id"])
    assert _open_titles(client) == []


def test_offline_completion_via_sync_creates_next_occurrence_idempotently(client: TestClient, user: dict) -> None:
    tid = str(uuid.uuid4())
    op = {
        "kind": "upsert",
        "task_id": tid,
        "base_version": None,
        "data": {
            "title": "Water plants",
            "due_at": "2099-03-01T08:00:00Z",
            "due_has_time": True,
            "recurrence": "FREQ=DAILY;INTERVAL=3",
        },
    }
    client.post("/api/v1/sync/push", json={"ops": [{**op, "op_id": str(uuid.uuid4())}]})
    done = {"op_id": str(uuid.uuid4()), "kind": "upsert", "task_id": tid, "base_version": 1, "data": {"status": "done"}}
    for _ in range(2):  # retried push
        client.post("/api/v1/sync/push", json={"ops": [done]})
    assert _open_titles(client) == [("Water plants", "2099-03-04T08:00:00Z")]
    pulled = client.get("/api/v1/sync/pull").json()["tasks"]
    assert sorted(t["status"] for t in pulled) == ["done", "todo"]


def test_quick_add_creates_repeating_tasks(client: TestClient) -> None:
    register(client, tz="Europe/London")
    out = client.post(
        "/api/v1/ai/tasks/from-text",
        json={"text": "standup every weekday at 9:30am #work", "request_id": str(uuid.uuid4())},
    ).json()
    task = out["results"][0]["task"]
    assert task["recurrence"] == "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR" and task["due_has_time"]
    preview = client.post("/api/v1/ai/parse", json={"text": "pay rent monthly"}).json()["tasks"][0]
    assert preview["recurrence"] == "FREQ=MONTHLY"
