"""Client for a local Ollama server.

The LLM is advisory only: callers validate every JSON response with Pydantic and fall back
to deterministic logic when the model is disabled, unreachable, slow or returns bad output.
Model output is never executed and never triggers actions on its own.
"""

import json
import logging
import threading
import time
from typing import Any, Protocol

import httpx

from app.config import get_settings

log = logging.getLogger("lifeos.llm")

# Hard cap on how much model text we accept back, to bound memory and UI size.
_MAX_RESPONSE_CHARS = 8000
_BREAKER_SECONDS = 60


class _CircuitBreaker:
    """Remembers that an LLM endpoint was unreachable so requests fail fast for a short period."""

    def __init__(self) -> None:
        self._open_until: dict[str, float] = {}
        self._lock = threading.Lock()

    def is_open(self, key: str) -> bool:
        with self._lock:
            return self._open_until.get(key, 0.0) > time.monotonic()

    def trip(self, key: str) -> None:
        with self._lock:
            self._open_until[key] = time.monotonic() + _BREAKER_SECONDS

    def reset(self, key: str) -> None:
        with self._lock:
            self._open_until.pop(key, None)


_breaker = _CircuitBreaker()


class LLM(Protocol):
    def available(self) -> bool: ...
    def status(self) -> dict[str, Any]: ...
    def chat_json(self, system: str, user: str, schema: dict[str, Any]) -> dict[str, Any] | None: ...
    def chat_text(self, system: str, user: str) -> str | None: ...


class OllamaClient:
    def __init__(self, base_url: str, model: str, timeout: float, enabled: bool = True) -> None:
        self.base_url = base_url.rstrip("/")
        self.model = model
        self.timeout = timeout
        self.enabled = enabled

    def status(self) -> dict[str, Any]:
        if not self.enabled:
            return {"enabled": False, "available": False, "model": self.model, "model_installed": False}
        if _breaker.is_open(self.base_url):
            return {"enabled": True, "available": False, "model": self.model, "model_installed": False}
        try:
            resp = httpx.get(f"{self.base_url}/api/tags", timeout=3.0)
            resp.raise_for_status()
            names = {m.get("name", "") for m in resp.json().get("models", [])}
            installed = any(n == self.model or n.split(":")[0] == self.model for n in names)
            return {"enabled": True, "available": True, "model": self.model, "model_installed": installed}
        except (httpx.HTTPError, ValueError):
            return {"enabled": True, "available": False, "model": self.model, "model_installed": False}

    def available(self) -> bool:
        status = self.status()
        return bool(status["available"] and status["model_installed"])

    def _chat(self, system: str, user: str, fmt: dict[str, Any] | None) -> str | None:
        if not self.enabled:
            return None
        payload: dict[str, Any] = {
            "model": self.model,
            "stream": False,
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
            # Bounded output keeps latency predictable; keep_alive avoids reloading the model per request.
            "options": {"temperature": 0.2, "num_predict": 600},
            "keep_alive": "15m",
        }
        if fmt is not None:
            payload["format"] = fmt
        if _breaker.is_open(self.base_url):
            return None
        try:
            resp = httpx.post(f"{self.base_url}/api/chat", json=payload, timeout=self.timeout)
            resp.raise_for_status()
            content = resp.json().get("message", {}).get("content", "")
        except (httpx.ConnectError, httpx.ConnectTimeout) as exc:
            # Server not running: skip the LLM for a while instead of paying the connect delay per request.
            _breaker.trip(self.base_url)
            log.warning("LLM unreachable (%s); using rule-based fallback for %ss", type(exc).__name__, _BREAKER_SECONDS)
            return None
        except (httpx.HTTPError, ValueError) as exc:
            log.warning("LLM request failed: %s", type(exc).__name__)
            return None
        _breaker.reset(self.base_url)
        if not isinstance(content, str) or not content.strip():
            return None
        return content[:_MAX_RESPONSE_CHARS]

    def chat_json(self, system: str, user: str, schema: dict[str, Any]) -> dict[str, Any] | None:
        content = self._chat(system, user, schema)
        if content is None:
            return None
        try:
            data = json.loads(content)
        except json.JSONDecodeError:
            log.warning("LLM returned invalid JSON")
            return None
        return data if isinstance(data, dict) else None

    def chat_text(self, system: str, user: str) -> str | None:
        content = self._chat(system, user, None)
        return content.strip() if content else None


def get_llm() -> LLM:
    s = get_settings()
    return OllamaClient(s.ollama_url, s.ollama_model, s.ollama_timeout_seconds, s.llm_enabled)
