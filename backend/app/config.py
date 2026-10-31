"""Application configuration loaded from environment variables (see `.env.example`)."""

import os
from functools import lru_cache

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    # LIFEOS_ENV_FILE="" disables the .env file (the test suite does this for isolation).
    model_config = SettingsConfigDict(
        env_file=os.getenv("LIFEOS_ENV_FILE", ".env") or None, env_file_encoding="utf-8", extra="ignore"
    )

    environment: str = Field(default="development", pattern="^(development|test|production)$")
    database_url: str = "sqlite:///./lifeos.db"
    database_echo: bool = False

    # Comma separated list of origins allowed to call the API cross-origin.
    cors_origins: str = "http://localhost:5173"
    cookie_secure: bool = False
    session_ttl_days: int = Field(default=14, ge=1, le=90)
    enable_docs: bool = True
    # Account sign-ups allowed per client IP per hour (raise only for automated testing).
    register_limit_per_hour: int = Field(default=10, ge=1)
    trust_proxy_headers: bool = False

    # Absolute path to the built frontend (`frontend/dist`). Served by the API when set.
    frontend_dist: str | None = None
    public_base_url: str = "http://localhost:8000"

    # Local LLM (Ollama)
    llm_enabled: bool = True
    ollama_url: str = "http://localhost:11434"
    ollama_model: str = "llama3.2"
    ollama_timeout_seconds: float = Field(default=30.0, gt=0, le=300)

    # Background worker
    run_worker_in_api: bool = False
    worker_interval_seconds: int = Field(default=30, ge=5, le=3600)

    # Behaviour
    neglect_days: int = Field(default=14, ge=1, le=365)
    activity_retention_days: int = Field(default=365, ge=1)
    notification_retention_days: int = Field(default=90, ge=1)
    tombstone_retention_days: int = Field(default=90, ge=1)
    max_import_bytes: int = Field(default=1_000_000, ge=1_000)

    # Web Push (notifications while the app is closed). Generate with: python -m app.cli vapid
    vapid_private_key: str | None = None
    vapid_subject: str = "mailto:admin@example.com"
    # Push services the server may contact (prevents server-side request forgery via fake endpoints).
    push_allowed_hosts: str = (
        "fcm.googleapis.com,updates.push.services.mozilla.com,push.services.mozilla.com,"
        "notify.windows.com,web.push.apple.com,push.apple.com"
    )

    # Google Calendar two-way sync (optional). See README "Google Calendar".
    google_client_id: str | None = None
    google_client_secret: str | None = None
    # Fernet key used to encrypt third-party tokens at rest. Generate with: python -m app.cli fernet
    token_encryption_key: str | None = None
    google_sync_interval_seconds: int = Field(default=300, ge=60)

    log_level: str = "INFO"

    @field_validator("database_url")
    @classmethod
    def _normalise_postgres_driver(cls, value: str) -> str:
        # Accept the common `postgres://` / `postgresql://` forms and use psycopg 3.
        if value.startswith("postgres://"):
            value = "postgresql://" + value[len("postgres://") :]
        if value.startswith("postgresql://"):
            value = "postgresql+psycopg://" + value[len("postgresql://") :]
        return value

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]

    @property
    def is_production(self) -> bool:
        return self.environment == "production"


@lru_cache
def get_settings() -> Settings:
    return Settings()
