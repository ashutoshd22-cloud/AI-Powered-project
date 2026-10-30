"""Test fixtures.

By default tests run against a temporary SQLite database. Set TEST_DATABASE_URL to a PostgreSQL
URL (as CI does) to run the same suite against PostgreSQL.
"""

import os
import tempfile
import uuid
from collections.abc import Iterator
from pathlib import Path
from typing import Any

_tmpdir = tempfile.mkdtemp(prefix="lifeos-tests-")
os.environ["DATABASE_URL"] = os.environ.get("TEST_DATABASE_URL", f"sqlite:///{Path(_tmpdir) / 'test.db'}")
os.environ["ENVIRONMENT"] = "test"
os.environ["LIFEOS_ENV_FILE"] = ""  # never read a developer .env during tests
os.environ["RUN_WORKER_IN_API"] = "false"
os.environ["LLM_ENABLED"] = "false"

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from sqlalchemy import delete  # noqa: E402

from app import db as database  # noqa: E402
from app.db import Base  # noqa: E402
from app.main import app  # noqa: E402
from app.rate_limit import limiter  # noqa: E402
from app.services.llm import get_llm  # noqa: E402


class FakeLLM:
    """Scriptable stand-in for Ollama."""

    def __init__(self) -> None:
        self.json_responses: list[dict[str, Any] | None] = []
        self.text_responses: list[str | None] = []
        self.calls: list[tuple[str, str]] = []
        self.up = False

    def status(self) -> dict[str, Any]:
        return {"enabled": True, "available": self.up, "model": "fake", "model_installed": self.up}

    def available(self) -> bool:
        return self.up

    def chat_json(self, system: str, user: str, schema: dict[str, Any]) -> dict[str, Any] | None:
        self.calls.append(("json", user))
        return self.json_responses.pop(0) if self.json_responses else None

    def chat_text(self, system: str, user: str) -> str | None:
        self.calls.append(("text", user))
        return self.text_responses.pop(0) if self.text_responses else None


@pytest.fixture(scope="session", autouse=True)
def _schema() -> Iterator[None]:
    Base.metadata.drop_all(database.engine)
    Base.metadata.create_all(database.engine)
    yield
    Base.metadata.drop_all(database.engine)
    database.engine.dispose()


@pytest.fixture(autouse=True)
def _clean() -> Iterator[None]:
    limiter.reset()
    yield
    with database.engine.begin() as conn:
        for table in reversed(Base.metadata.sorted_tables):
            conn.execute(delete(table))


@pytest.fixture
def fake_llm() -> Iterator[FakeLLM]:
    llm = FakeLLM()
    app.dependency_overrides[get_llm] = lambda: llm
    yield llm
    app.dependency_overrides.pop(get_llm, None)


@pytest.fixture
def client(fake_llm: FakeLLM) -> Iterator[TestClient]:
    with TestClient(app, raise_server_exceptions=False) as c:
        yield c


def register(
    c: TestClient, email: str | None = None, tz: str = "UTC", password: str = "correct-horse-1"
) -> dict[str, Any]:
    email = email or f"user-{uuid.uuid4().hex[:8]}@example.com"
    resp = c.post(
        "/api/v1/auth/register",
        json={"email": email, "password": password, "display_name": "Test User", "timezone": tz},
    )
    assert resp.status_code == 201, resp.text
    data = resp.json()
    c.headers["X-CSRF-Token"] = data["csrf_token"]
    return {"email": email, "password": password, **data}


@pytest.fixture
def user(client: TestClient) -> dict[str, Any]:
    return register(client)


def new_client(fake_llm: FakeLLM) -> TestClient:
    return TestClient(app, raise_server_exceptions=False)
