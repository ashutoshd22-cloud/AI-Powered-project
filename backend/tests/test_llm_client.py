"""OllamaClient behaviour against a mocked HTTP layer (no Ollama server needed)."""

import json

import httpx
import pytest

from app.services import llm as llm_module
from app.services.llm import OllamaClient


def _client() -> OllamaClient:
    return OllamaClient("http://ollama:11434/", "llama3.2", timeout=1.0)


def _response(payload: object, status: int = 200) -> httpx.Response:
    return httpx.Response(status, json=payload, request=httpx.Request("POST", "http://ollama"))


def test_chat_json_success_and_request_shape(monkeypatch: pytest.MonkeyPatch) -> None:
    sent: dict = {}

    def fake_post(url: str, json: dict, timeout: float) -> httpx.Response:
        sent.update(url=url, body=json, timeout=timeout)
        return _response({"message": {"content": '{"tasks": [{"title": "A"}]}'}})

    monkeypatch.setattr(llm_module.httpx, "post", fake_post)
    assert _client().chat_json("sys", "user", {"type": "object"}) == {"tasks": [{"title": "A"}]}
    assert sent["url"] == "http://ollama:11434/api/chat"
    assert sent["body"]["stream"] is False and sent["body"]["format"] == {"type": "object"}
    assert sent["timeout"] == 1.0


@pytest.mark.parametrize(
    "behaviour",
    ["invalid-json", "json-list", "http-500", "timeout", "connect-error", "empty"],
)
def test_chat_failures_return_none(monkeypatch: pytest.MonkeyPatch, behaviour: str) -> None:
    def fake_post(url: str, json: dict, timeout: float) -> httpx.Response:
        if behaviour == "timeout":
            raise httpx.ReadTimeout("slow")
        if behaviour == "connect-error":
            raise httpx.ConnectError("down")
        if behaviour == "http-500":
            return _response({"error": "boom"}, status=500)
        content = {"invalid-json": "{not json", "json-list": "[1,2]", "empty": "  "}[behaviour]
        return _response({"message": {"content": content}})

    monkeypatch.setattr(llm_module.httpx, "post", fake_post)
    assert _client().chat_json("s", "u", {}) is None


def test_text_is_truncated(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        llm_module.httpx, "post", lambda url, json, timeout: _response({"message": {"content": "x" * 20000}})
    )
    assert len(_client().chat_text("s", "u") or "") == 8000


def test_status_and_disabled(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        llm_module.httpx,
        "get",
        lambda url, timeout: httpx.Response(
            200, content=json.dumps({"models": [{"name": "llama3.2:latest"}]}), request=httpx.Request("GET", url)
        ),
    )
    status = _client().status()
    assert status["available"] and status["model_installed"]

    disabled = OllamaClient("http://x", "m", 1.0, enabled=False)
    assert disabled.chat_text("s", "u") is None and disabled.status()["enabled"] is False

    def down(url: str, timeout: float) -> httpx.Response:
        raise httpx.ConnectError("down")

    monkeypatch.setattr(llm_module.httpx, "get", down)
    assert _client().status()["available"] is False


@pytest.fixture(autouse=True)
def _reset_breaker() -> None:
    llm_module._breaker._open_until.clear()


def test_unreachable_server_trips_breaker(monkeypatch: pytest.MonkeyPatch) -> None:
    calls = {"n": 0}

    def down(url: str, json: dict, timeout: float) -> httpx.Response:
        calls["n"] += 1
        raise httpx.ConnectError("refused")

    monkeypatch.setattr(llm_module.httpx, "post", down)
    client = _client()
    assert client.chat_text("s", "u") is None
    assert client.chat_text("s", "u") is None  # fails fast without another connection attempt
    assert calls["n"] == 1
    assert client.status()["available"] is False

    llm_module._breaker._open_until.clear()
    monkeypatch.setattr(llm_module.httpx, "post", lambda url, json, timeout: _response({"message": {"content": "ok"}}))
    assert client.chat_text("s", "u") == "ok"
