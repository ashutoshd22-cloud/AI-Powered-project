"""Time-zone helpers. All instants are stored in UTC; local dates use the user's IANA zone."""

from datetime import UTC, date, datetime, time, timedelta
from zoneinfo import ZoneInfo


def zone(name: str) -> ZoneInfo:
    try:
        return ZoneInfo(name)
    except Exception:  # corrupted/unknown value in DB: never crash a request
        return ZoneInfo("UTC")


def now_local(tz: str, now: datetime | None = None) -> datetime:
    return (now or datetime.now(UTC)).astimezone(zone(tz))


def today_local(tz: str, now: datetime | None = None) -> date:
    return now_local(tz, now).date()


def local_to_utc(day: date, at: time, tz: str) -> datetime:
    """Convert a local wall-clock time to UTC.

    Non-existent times (DST spring-forward gap) resolve forward by the gap, and ambiguous
    times (fall-back overlap) use the first occurrence (`fold=0`), matching most calendar apps.
    """
    # With fold=0, zoneinfo applies the pre-transition offset, which gives exactly this behaviour.
    return datetime.combine(day, at).replace(tzinfo=zone(tz), fold=0).astimezone(UTC)


def end_of_local_day(day: date, tz: str) -> datetime:
    return local_to_utc(day, time(23, 59, 59), tz)


def local_day_bounds(start: date, end_inclusive: date, tz: str) -> tuple[datetime, datetime]:
    """UTC half-open interval covering local days [start, end_inclusive]."""
    return (
        local_to_utc(start, time(0, 0), tz),
        local_to_utc(end_inclusive + timedelta(days=1), time(0, 0), tz),
    )


def local_date_of(instant: datetime, tz: str) -> date:
    return instant.astimezone(zone(tz)).date()
