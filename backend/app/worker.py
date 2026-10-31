"""Background worker: `python -m app.worker`.

Runs reminder dispatch every `WORKER_INTERVAL_SECONDS`, daily digests every cycle and retention
purges hourly. Each job uses its own DB session and errors never stop the loop.
"""

import logging
import signal
import threading
import time

from app.db import SessionLocal
from app.logging_setup import configure_logging
from app.services import google_calendar, reminders

log = logging.getLogger("lifeos.worker")

PURGE_INTERVAL_SECONDS = 3600


def run_cycle(include_purge: bool) -> None:
    for name, job in (
        ("reminders", reminders.dispatch_due_reminders),
        ("digests", reminders.dispatch_daily_digests),
        ("google-calendar", google_calendar.sync_due),
    ):
        db = SessionLocal()
        try:
            count = job(db)
            if count:
                log.info("%s: sent %d notification(s)", name, count)
        except Exception:
            db.rollback()
            log.exception("%s job failed", name)
        finally:
            db.close()
    if include_purge:
        db = SessionLocal()
        try:
            log.info("retention purge: %s", reminders.purge_expired_data(db))
        except Exception:
            db.rollback()
            log.exception("retention purge failed")
        finally:
            db.close()


def run_forever(interval: int, stop: threading.Event) -> None:
    last_purge = 0.0
    log.info("worker started (interval=%ss)", interval)
    while not stop.is_set():
        now = time.monotonic()
        include_purge = now - last_purge >= PURGE_INTERVAL_SECONDS
        run_cycle(include_purge)
        if include_purge:
            last_purge = now
        stop.wait(interval)
    log.info("worker stopped")


def main() -> None:
    from app.config import get_settings

    configure_logging(get_settings().log_level)
    stop = threading.Event()
    signal.signal(signal.SIGINT, lambda *_: stop.set())
    signal.signal(signal.SIGTERM, lambda *_: stop.set())
    run_forever(get_settings().worker_interval_seconds, stop)


if __name__ == "__main__":
    main()
