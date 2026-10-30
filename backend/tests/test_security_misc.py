from fastapi.testclient import TestClient

from app.main import create_app


def test_security_headers_present(client: TestClient) -> None:
    resp = client.get("/api/health")
    assert resp.status_code == 200 and resp.json() == {"status": "ok"}
    h = resp.headers
    assert h["x-content-type-options"] == "nosniff"
    assert h["x-frame-options"] == "DENY"
    assert "default-src 'self'" in h["content-security-policy"]
    assert h["cache-control"] == "no-store"


def test_cors_only_allows_configured_origins(client: TestClient) -> None:
    allowed = client.options(
        "/api/v1/tasks", headers={"Origin": "http://localhost:5173", "Access-Control-Request-Method": "POST"}
    )
    assert allowed.headers.get("access-control-allow-origin") == "http://localhost:5173"
    denied = client.options(
        "/api/v1/tasks", headers={"Origin": "https://evil.example", "Access-Control-Request-Method": "POST"}
    )
    assert "access-control-allow-origin" not in denied.headers


def test_unhandled_errors_do_not_leak_details() -> None:
    isolated = create_app()

    @isolated.get("/api/test-boom")
    def boom() -> None:
        raise RuntimeError("secret internal detail")

    isolated.router.routes.insert(0, isolated.router.routes.pop())  # ahead of the /api catch-all
    resp = TestClient(isolated, raise_server_exceptions=False).get("/api/test-boom")
    assert resp.status_code == 500
    assert "secret" not in resp.text
    assert resp.json() == {"detail": "An unexpected error occurred. Please try again."}


def test_requires_authentication(client: TestClient) -> None:
    for method, path in [
        ("GET", "/api/v1/tasks"),
        ("GET", "/api/v1/goals"),
        ("GET", "/api/v1/activity"),
        ("GET", "/api/v1/analytics/overview"),
        ("GET", "/api/v1/account/export"),
        ("GET", "/api/v1/sync/pull"),
        ("POST", "/api/v1/ai/parse"),
        ("GET", "/api/v1/notifications"),
    ]:
        assert client.request(method, path).status_code == 401, path


def test_serves_spa_without_path_traversal(tmp_path) -> None:  # type: ignore[no-untyped-def]
    dist = tmp_path / "dist"
    (dist / "assets").mkdir(parents=True)
    (dist / "index.html").write_text("<div id=root></div>")
    (dist / "assets" / "app.js").write_text("console.log(1)")
    (tmp_path / "secret.txt").write_text("TOP SECRET")
    import os

    os.environ["FRONTEND_DIST"] = str(dist)
    from app.config import get_settings

    get_settings.cache_clear()
    try:
        spa = TestClient(create_app())
        assert spa.get("/").text == "<div id=root></div>"
        assert spa.get("/planner").text == "<div id=root></div>"  # client-side route
        asset = spa.get("/assets/app.js")
        assert asset.text == "console.log(1)" and "immutable" in asset.headers["cache-control"]
        assert spa.head("/").status_code == 200
        for attempt in ("/../secret.txt", "/%2e%2e/secret.txt", "/assets/../../secret.txt"):
            assert "TOP SECRET" not in spa.get(attempt).text
        assert spa.get("/api/v1/unknown").status_code == 404  # API 404s are not swallowed by the SPA
    finally:
        del os.environ["FRONTEND_DIST"]
        get_settings.cache_clear()
