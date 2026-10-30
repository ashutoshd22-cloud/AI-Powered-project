import uuid
from datetime import UTC, datetime, timedelta

from fastapi.testclient import TestClient

from app.main import app
from app.services import sync as sync_service
from tests.conftest import register


def op(kind: str, task_id: str, base_version: int | None, **data: object) -> dict:
    return {"op_id": str(uuid.uuid4()), "kind": kind, "task_id": task_id, "base_version": base_version, "data": data}


def push(client: TestClient, *ops: dict) -> list[dict]:
    resp = client.post("/api/v1/sync/push", json={"ops": list(ops)})
    assert resp.status_code == 200, resp.text
    return resp.json()["results"]


def test_offline_create_then_update_and_idempotent_replay(client: TestClient, user: dict) -> None:
    tid = str(uuid.uuid4())
    create = op("upsert", tid, None, title="Written offline", priority="high")
    update = op("upsert", tid, 1, title="Edited offline")
    results = push(client, create, update)
    assert [r["status"] for r in results] == ["applied", "applied"]
    assert results[1]["task"]["version"] == 2

    # The connection dropped before the client saw the response: it resends everything.
    replay = push(client, create, update)
    assert [r["status"] for r in replay] == ["duplicate", "duplicate"]
    assert client.get(f"/api/v1/tasks/{tid}").json()["title"] == "Edited offline"
    assert client.get("/api/v1/tasks").json()["total"] == 1


def test_stale_edit_is_a_conflict_and_nothing_is_lost(client: TestClient, user: dict) -> None:
    tid = str(uuid.uuid4())
    push(client, op("upsert", tid, None, title="Original"))
    # Device A edits online (version 1 → 2)...
    client.patch(f"/api/v1/tasks/{tid}", json={"title": "Edited on phone"})
    # ...while device B edited offline from version 1.
    result = push(client, op("upsert", tid, 1, title="Edited on laptop"))[0]
    assert result["status"] == "conflict"
    assert result["task"]["title"] == "Edited on phone"  # server copy returned for the user to compare
    assert client.get(f"/api/v1/tasks/{tid}").json()["title"] == "Edited on phone"

    # User chooses "keep mine": client resends based on the server version.
    resolved = push(client, op("upsert", tid, result["task"]["version"], title="Edited on laptop"))[0]
    assert resolved["status"] == "applied" and resolved["task"]["title"] == "Edited on laptop"


def test_delete_conflicts_with_newer_edit_and_tombstones_sync(client: TestClient, user: dict) -> None:
    tid = str(uuid.uuid4())
    push(client, op("upsert", tid, None, title="To delete"))
    client.patch(f"/api/v1/tasks/{tid}", json={"priority": "urgent"})
    assert push(client, op("delete", tid, 1))[0]["status"] == "conflict"
    since = (datetime.now(UTC) - timedelta(minutes=1)).isoformat()
    assert push(client, op("delete", tid, 2))[0]["status"] == "applied"
    assert push(client, op("delete", tid, 3))[0]["status"] == "applied"  # deleting twice is harmless
    pulled = client.get("/api/v1/sync/pull", params={"since": since}).json()
    assert [t["deleted_at"] is not None for t in pulled["tasks"]] == [True]

    # Editing a task that was deleted elsewhere is surfaced as a conflict, then can be restored.
    conflict = push(client, op("upsert", tid, 2, title="Still needed"))[0]
    assert conflict["status"] == "conflict" and conflict["task"]["deleted_at"] is not None
    restored = push(client, op("upsert", tid, conflict["task"]["version"], title="Still needed", deleted=False))[0]
    assert restored["status"] == "applied" and restored["task"]["deleted_at"] is None


def test_pull_full_incremental_and_pagination(client: TestClient, user: dict, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    monkeypatch.setattr(sync_service, "PULL_PAGE_SIZE", 2)
    ids = [str(uuid.uuid4()) for _ in range(5)]
    push(client, *[op("upsert", i, None, title=f"Task {n}") for n, i in enumerate(ids)])

    seen: list[str] = []
    params: dict[str, str] = {}
    while True:
        page = client.get("/api/v1/sync/pull", params=params).json()
        seen += [t["id"] for t in page["tasks"]]
        if not page["has_more"]:
            break
        params = {"after": page["next"]}
    assert sorted(seen) == sorted(ids)

    cursor = page["cursor"]
    push(client, op("upsert", ids[0], 1, title="Changed"))
    changed: list[dict] = []
    params = {"since": cursor}
    while True:
        page = client.get("/api/v1/sync/pull", params=params).json()
        changed += page["tasks"]
        if not page["has_more"]:
            break
        params = {"since": cursor, "after": page["next"]}
    assert {t["id"]: t["title"] for t in changed}[ids[0]] == "Changed"


def test_pull_requires_reset_when_cursor_older_than_retention(client: TestClient, user: dict) -> None:
    old = (datetime.now(UTC) - timedelta(days=365)).isoformat()
    assert client.get("/api/v1/sync/pull", params={"since": old}).json()["reset_required"] is True
    assert client.get("/api/v1/sync/pull", params={"since": "2026-01-01T00:00:00"}).status_code == 422
    assert client.get("/api/v1/sync/pull", params={"after": "garbage"}).status_code == 422


def test_rejections(client: TestClient, user: dict) -> None:
    assert push(client, op("upsert", str(uuid.uuid4()), None, priority="low"))[0]["status"] == "rejected"
    bad_goal = push(client, op("upsert", str(uuid.uuid4()), None, title="x", goal_id=str(uuid.uuid4())))[0]
    assert bad_goal["status"] == "rejected" and "Goal" in bad_goal["error"]
    tid = str(uuid.uuid4())
    push(client, op("upsert", tid, None, title="mine"))
    with TestClient(app) as other:
        register(other)
        res = other.post("/api/v1/sync/push", json={"ops": [op("upsert", tid, 1, title="stolen")]}).json()["results"][0]
        assert res["status"] == "rejected" and res["task"] is None
    assert client.get(f"/api/v1/tasks/{tid}").json()["title"] == "mine"
    too_many = [op("upsert", str(uuid.uuid4()), None, title="t") for _ in range(201)]
    assert client.post("/api/v1/sync/push", json={"ops": too_many}).status_code == 422
