"""FastAPI application factory."""

import logging
import threading
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import APIRouter, FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from sqlalchemy import text
from starlette.exceptions import HTTPException as StarletteHTTPException

from app import db as database
from app.api import account, ai, auth, calendar, goals, misc, sync, tasks
from app.config import get_settings
from app.logging_setup import configure_logging

log = logging.getLogger("lifeos")

API_PREFIX = "/api/v1"
MAX_BODY_BYTES = 2_000_000


class _RedactFeedTokens(logging.Filter):
    """Keep calendar feed tokens (which live in the URL path) out of access logs."""

    def filter(self, record: logging.LogRecord) -> bool:
        if isinstance(record.args, tuple) and any("/calendar/feed/" in str(a) for a in record.args):
            record.args = tuple(
                str(a).split("/calendar/feed/")[0] + "/calendar/feed/[redacted]" if "/calendar/feed/" in str(a) else a
                for a in record.args
            )
        return True


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    settings = get_settings()
    stop = threading.Event()
    worker: threading.Thread | None = None
    if settings.run_worker_in_api:
        from app.worker import run_forever

        worker = threading.Thread(
            target=run_forever, args=(settings.worker_interval_seconds, stop), daemon=True, name="lifeos-worker"
        )
        worker.start()
    yield
    stop.set()
    if worker is not None:
        worker.join(timeout=5)


def create_app() -> FastAPI:
    settings = get_settings()
    configure_logging(settings.log_level)
    logging.getLogger("uvicorn.access").addFilter(_RedactFeedTokens())

    app = FastAPI(
        title="LifeOS API",
        version="1.0.0",
        lifespan=lifespan,
        docs_url="/api/docs" if settings.enable_docs else None,
        redoc_url=None,
        openapi_url="/api/openapi.json" if settings.enable_docs else None,
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origin_list,
        allow_credentials=True,
        allow_methods=["GET", "POST", "PATCH", "DELETE"],
        allow_headers=["Content-Type", "X-CSRF-Token"],
        max_age=600,
    )

    @app.middleware("http")
    async def security_headers(request: Request, call_next):  # type: ignore[no-untyped-def]
        length = request.headers.get("content-length")
        if length and length.isdigit() and int(length) > MAX_BODY_BYTES:
            return JSONResponse(status_code=413, content={"detail": "Request body too large"})
        response = await call_next(request)
        headers = response.headers
        headers.setdefault("X-Content-Type-Options", "nosniff")
        headers.setdefault("X-Frame-Options", "DENY")
        headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
        headers.setdefault("Permissions-Policy", "camera=(), geolocation=(), microphone=(self)")
        headers.setdefault("Cross-Origin-Opener-Policy", "same-origin")
        if request.url.path.startswith("/api/docs"):
            pass  # Swagger UI loads its assets from a CDN; keep its default policy.
        else:
            headers.setdefault(
                "Content-Security-Policy",
                "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; "
                "connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; "
                "form-action 'self'; manifest-src 'self'; worker-src 'self'",
            )
        if settings.is_production:
            headers.setdefault("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
        if request.url.path.startswith("/api/"):
            headers.setdefault("Cache-Control", "no-store")
        return response

    @app.exception_handler(StarletteHTTPException)
    async def http_error(request: Request, exc: StarletteHTTPException) -> JSONResponse:
        return JSONResponse(
            status_code=exc.status_code, content={"detail": exc.detail}, headers=getattr(exc, "headers", None)
        )

    @app.exception_handler(RequestValidationError)
    async def validation_error(request: Request, exc: RequestValidationError) -> JSONResponse:
        errors = [
            {"loc": [str(p) for p in e.get("loc", ())], "msg": e.get("msg", "Invalid value"), "type": e.get("type")}
            for e in exc.errors()
        ]
        return JSONResponse(status_code=422, content={"detail": "Validation failed", "errors": errors})

    @app.exception_handler(Exception)
    async def unhandled_error(request: Request, exc: Exception) -> JSONResponse:
        log.exception("Unhandled error on %s %s", request.method, request.url.path)
        return JSONResponse(status_code=500, content={"detail": "An unexpected error occurred. Please try again."})

    api = APIRouter(prefix=API_PREFIX)
    for module in (auth, tasks, goals, misc, ai, calendar, account, sync):
        api.include_router(module.router)
    app.include_router(api)

    @app.get("/api/health", tags=["health"])
    def health() -> dict[str, str]:
        try:
            with database.engine.connect() as conn:
                conn.execute(text("SELECT 1"))
        except Exception:
            log.exception("health check: database unavailable")
            raise HTTPException(status_code=503, detail="Database unavailable") from None
        return {"status": "ok"}

    @app.api_route("/api/{path:path}", methods=["GET", "POST", "PATCH", "DELETE"], include_in_schema=False)
    def api_not_found(path: str) -> None:
        raise HTTPException(status_code=404, detail="Not found")

    _mount_frontend(app, settings.frontend_dist)
    return app


def _mount_frontend(app: FastAPI, dist: str | None) -> None:
    """Serve the built single-page app (same origin as the API) when configured."""
    if not dist:
        return
    root = Path(dist).resolve()
    index = root / "index.html"
    if not index.is_file():
        log.warning("FRONTEND_DIST=%s has no index.html; not serving the frontend", dist)
        return

    @app.api_route("/{path:path}", methods=["GET", "HEAD"], include_in_schema=False)
    def spa(path: str) -> FileResponse:
        candidate = (root / path).resolve()
        if path and candidate.is_file() and candidate.is_relative_to(root):
            cache = "public, max-age=31536000, immutable" if path.startswith("assets/") else "no-cache"
            return FileResponse(candidate, headers={"Cache-Control": cache})
        return FileResponse(index, headers={"Cache-Control": "no-cache"})


app = create_app()
