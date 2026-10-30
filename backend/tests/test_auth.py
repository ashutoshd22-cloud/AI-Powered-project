from datetime import timedelta

from fastapi.testclient import TestClient
from sqlalchemy import update

from app import db as database
from app.main import app
from app.models import AuthSession, utcnow
from tests.conftest import register


def test_register_sets_httponly_session_and_returns_user(client: TestClient) -> None:
    resp = client.post(
        "/api/v1/auth/register",
        json={
            "email": "Ada@Example.com",
            "password": "a-long-password",
            "display_name": " Ada ",
            "timezone": "Asia/Kolkata",
        },
    )
    assert resp.status_code == 201
    body = resp.json()
    assert body["user"]["email"] == "ada@example.com"
    assert body["user"]["display_name"] == "Ada"
    assert body["user"]["timezone"] == "Asia/Kolkata"
    assert "password_hash" not in body["user"]
    cookies = resp.headers.get_list("set-cookie")
    session_cookie = next(c for c in cookies if c.startswith("lifeos_session="))
    assert "HttpOnly" in session_cookie and "SameSite=lax" in session_cookie
    csrf_cookie = next(c for c in cookies if c.startswith("lifeos_csrf="))
    assert "HttpOnly" not in csrf_cookie


def test_register_rejects_duplicate_email_case_insensitively(client: TestClient) -> None:
    register(client, email="dup@example.com")
    resp = client.post(
        "/api/v1/auth/register",
        json={"email": "DUP@example.com", "password": "another-password", "display_name": "X"},
    )
    assert resp.status_code == 409


def test_register_validation(client: TestClient) -> None:
    base = {"email": "v@example.com", "password": "long-enough-pw", "display_name": "V"}
    assert client.post("/api/v1/auth/register", json={**base, "password": "short"}).status_code == 422
    assert client.post("/api/v1/auth/register", json={**base, "email": "not-an-email"}).status_code == 422
    assert client.post("/api/v1/auth/register", json={**base, "timezone": "Mars/Base"}).status_code == 422
    assert client.post("/api/v1/auth/register", json={**base, "display_name": "   "}).status_code == 422
    assert client.post("/api/v1/auth/register", json={**base, "password": "x" * 129}).status_code == 422
    resp = client.post("/api/v1/auth/register", json={})
    assert resp.status_code == 422 and resp.json()["detail"] == "Validation failed"


def test_login_logout_and_me(client: TestClient) -> None:
    creds = register(client)
    client.cookies.clear()
    assert client.get("/api/v1/auth/me").status_code == 401

    bad = client.post("/api/v1/auth/login", json={"email": creds["email"], "password": "wrong-password"})
    assert bad.status_code == 401
    unknown = client.post("/api/v1/auth/login", json={"email": "nobody@example.com", "password": "whatever-123"})
    assert unknown.status_code == 401
    assert bad.json()["detail"] == unknown.json()["detail"]  # no account enumeration via login

    ok = client.post("/api/v1/auth/login", json={"email": creds["email"].upper(), "password": creds["password"]})
    assert ok.status_code == 200
    client.headers["X-CSRF-Token"] = ok.json()["csrf_token"]
    assert client.get("/api/v1/auth/me").json()["email"] == creds["email"]

    assert client.post("/api/v1/auth/logout").status_code == 204
    assert client.get("/api/v1/auth/me").status_code == 401


def test_csrf_required_for_unsafe_methods(client: TestClient, user: dict) -> None:
    del client.headers["X-CSRF-Token"]
    assert client.post("/api/v1/tasks", json={"title": "x"}).status_code == 403
    client.headers["X-CSRF-Token"] = "forged"
    assert client.post("/api/v1/tasks", json={"title": "x"}).status_code == 403
    client.headers["X-CSRF-Token"] = user["csrf_token"]
    assert client.post("/api/v1/tasks", json={"title": "x"}).status_code == 201
    # Safe methods do not need the header.
    del client.headers["X-CSRF-Token"]
    assert client.get("/api/v1/tasks").status_code == 200


def test_expired_session_is_rejected(client: TestClient, user: dict) -> None:
    with database.engine.begin() as conn:
        conn.execute(update(AuthSession).values(expires_at=utcnow() - timedelta(seconds=1)))
    resp = client.get("/api/v1/auth/me")
    assert resp.status_code == 401
    assert resp.json()["detail"] == "Session expired"


def test_update_profile_and_settings(client: TestClient, user: dict) -> None:
    resp = client.patch(
        "/api/v1/auth/me",
        json={"timezone": "America/New_York", "theme": "dark", "daily_digest_hour": 7, "default_reminder_minutes": 15},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert (body["timezone"], body["theme"], body["daily_digest_hour"]) == ("America/New_York", "dark", 7)
    assert client.patch("/api/v1/auth/me", json={"timezone": "Nowhere/Land"}).status_code == 422
    assert client.patch("/api/v1/auth/me", json={"daily_digest_hour": 24}).status_code == 422
    assert client.patch("/api/v1/auth/me", json={"theme": "neon"}).status_code == 422


def test_change_password_revokes_other_sessions(client: TestClient, user: dict) -> None:
    with TestClient(app) as other:
        login = other.post("/api/v1/auth/login", json={"email": user["email"], "password": user["password"]})
        assert login.status_code == 200
        assert other.get("/api/v1/auth/me").status_code == 200

        wrong = client.post(
            "/api/v1/auth/change-password",
            json={"current_password": "nope-nope-nope", "new_password": "brand-new-pass"},
        )
        assert wrong.status_code == 400
        ok = client.post(
            "/api/v1/auth/change-password",
            json={"current_password": user["password"], "new_password": "brand-new-pass"},
        )
        assert ok.status_code == 204
        assert client.get("/api/v1/auth/me").status_code == 200  # current device stays signed in
        assert other.get("/api/v1/auth/me").status_code == 401

    client.cookies.clear()
    relog = client.post("/api/v1/auth/login", json={"email": user["email"], "password": "brand-new-pass"})
    assert relog.status_code == 200


def test_login_is_rate_limited(client: TestClient, user: dict) -> None:
    statuses = [
        client.post("/api/v1/auth/login", json={"email": user["email"], "password": "bad-password"}).status_code
        for _ in range(11)
    ]
    assert statuses[:10] == [401] * 10
    assert statuses[10] == 429


def test_tampered_or_oversized_session_cookie(client: TestClient) -> None:
    client.cookies.set("lifeos_session", "garbage")
    assert client.get("/api/v1/auth/me").status_code == 401
    client.cookies.set("lifeos_session", "x" * 500)
    assert client.get("/api/v1/auth/me").status_code == 401


def test_registration_is_rate_limited_per_ip(client: TestClient) -> None:
    codes = [
        client.post(
            "/api/v1/auth/register",
            json={"email": f"r{i}@example.com", "password": "long-enough-pw", "display_name": "R"},
        ).status_code
        for i in range(11)
    ]
    assert codes[:10] == [201] * 10 and codes[10] == 429
