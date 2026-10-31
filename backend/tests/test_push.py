import json
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import func, select

from app import db as database
from app.config import get_settings
from app.main import app
from app.models import PushSubscription
from app.services import push, reminders
from tests.conftest import register

ENDPOINT = "https://fcm.googleapis.com/fcm/send/abc123"
KEYS = {
    "p256dh": "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM",
    "auth": "tBHItJI5svbpez7KI4CCXg",
}


class Recorder(list[tuple[str, dict]]):
    """Captured pushes; `status` is the HTTP code the fake push service answers with."""

    status = 201


@pytest.fixture
def vapid(monkeypatch: pytest.MonkeyPatch) -> Iterator[Recorder]:
    private, _ = push.generate_keys()
    monkeypatch.setattr(get_settings(), "vapid_private_key", private)
    sent = Recorder()

    def fake_send(sub: PushSubscription, payload: str) -> int:
        sent.append((sub.endpoint, json.loads(payload)))
        return sent.status

    monkeypatch.setattr(push, "_send", fake_send)
    yield sent


def test_config_reports_disabled_without_keys(client: TestClient, user: dict) -> None:
    body = client.get("/api/v1/push/config").json()
    assert body == {"enabled": False, "public_key": None, "subscriptions": 0}
    assert client.post("/api/v1/push/subscriptions", json={"endpoint": ENDPOINT, "keys": KEYS}).status_code == 409


def test_subscribe_test_and_unsubscribe(client: TestClient, user: dict, vapid: Recorder) -> None:
    cfg = client.get("/api/v1/push/config").json()
    assert cfg["enabled"] and len(cfg["public_key"]) > 80
    assert client.post("/api/v1/push/subscriptions", json={"endpoint": ENDPOINT, "keys": KEYS}).status_code == 201
    assert (
        client.post("/api/v1/push/subscriptions", json={"endpoint": ENDPOINT, "keys": KEYS}).status_code == 201
    )  # idempotent
    assert client.get("/api/v1/push/config").json()["subscriptions"] == 1

    assert client.post("/api/v1/push/test").json()["sent"] == 1
    assert vapid[0][0] == ENDPOINT and vapid[0][1]["title"] == "LifeOS notifications are on"

    assert client.request("DELETE", "/api/v1/push/subscriptions", json={"endpoint": ENDPOINT}).status_code == 204
    assert client.get("/api/v1/push/config").json()["subscriptions"] == 0


@pytest.mark.parametrize(
    "endpoint",
    [
        "http://fcm.googleapis.com/fcm/send/x",  # not https
        "https://127.0.0.1/push",  # internal address
        "https://evil.example.com/collect",  # not a push service
        "https://fcm.googleapis.com.evil.com/x",  # look-alike host
        "https://fcm.googleapis.com:8443/x",  # unexpected port
    ],
)
def test_only_real_push_services_are_accepted(client: TestClient, user: dict, vapid: Recorder, endpoint: str) -> None:
    resp = client.post("/api/v1/push/subscriptions", json={"endpoint": endpoint, "keys": KEYS})
    assert resp.status_code == 422


def test_endpoint_moves_to_the_account_signed_in_on_that_browser(
    client: TestClient, user: dict, vapid: Recorder
) -> None:
    client.post("/api/v1/push/subscriptions", json={"endpoint": ENDPOINT, "keys": KEYS})
    with TestClient(app) as other:
        register(other)
        other.post("/api/v1/push/subscriptions", json={"endpoint": ENDPOINT, "keys": KEYS})
        assert other.get("/api/v1/push/config").json()["subscriptions"] == 1
    assert client.get("/api/v1/push/config").json()["subscriptions"] == 0


def test_reminders_are_pushed_and_expired_subscriptions_removed(
    client: TestClient, user: dict, vapid: Recorder
) -> None:
    client.post("/api/v1/push/subscriptions", json={"endpoint": ENDPOINT, "keys": KEYS})
    now = datetime.now(UTC)
    client.post("/api/v1/tasks", json={"title": "Call the bank", "remind_at": (now - timedelta(minutes=1)).isoformat()})
    with database.SessionLocal() as db:
        assert reminders.dispatch_due_reminders(db, now) == 1
    assert [p["title"] for _, p in vapid] == ["Call the bank"]

    vapid.status = 410  # the browser unsubscribed
    client.post("/api/v1/tasks", json={"title": "Second", "remind_at": (now - timedelta(minutes=1)).isoformat()})
    with database.SessionLocal() as db:
        reminders.dispatch_due_reminders(db, now)
        assert db.scalar(select(func.count()).select_from(PushSubscription)) == 0
