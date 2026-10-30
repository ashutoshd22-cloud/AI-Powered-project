"""Logging configuration. Application code logs identifiers and counts, never secrets or task content."""

import logging


def configure_logging(level: str = "INFO") -> None:
    logging.basicConfig(
        level=level.upper(),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    # Uvicorn access logs include query strings; the calendar feed token lives in the path,
    # so access logs are filtered (see main.py) rather than disabled.
