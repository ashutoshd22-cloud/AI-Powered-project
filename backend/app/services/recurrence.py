"""Recurring tasks using a safe subset of RFC 5545 RRULE.

Supported: FREQ=DAILY|WEEKLY|MONTHLY|YEARLY, INTERVAL=1..365, BYDAY (e.g. MO,WE or 1MO / -1FR for
monthly), BYMONTHDAY=1..31 or -1. Occurrences are computed in the user's local wall-clock time, so a
"9:00 every Monday" task stays at 9:00 across daylight-saving changes.
"""

import re
from datetime import datetime, time, timedelta

from dateutil.rrule import DAILY, FR, MO, MONTHLY, SA, SU, TH, TU, WE, WEEKLY, YEARLY, rrule, weekday

from app.services.timeutil import local_to_utc, zone

_FREQ = {"DAILY": DAILY, "WEEKLY": WEEKLY, "MONTHLY": MONTHLY, "YEARLY": YEARLY}
_DAYS = {"MO": MO, "TU": TU, "WE": WE, "TH": TH, "FR": FR, "SA": SA, "SU": SU}
_BYDAY = re.compile(r"^([+-]?[1-4]|-1)?(MO|TU|WE|TH|FR|SA|SU)$")
MAX_LENGTH = 200


class RecurrenceError(ValueError):
    pass


def parse_rule(rule: str) -> dict[str, str]:
    parts: dict[str, str] = {}
    for chunk in rule.strip().upper().removeprefix("RRULE:").split(";"):
        if not chunk:
            continue
        key, sep, value = chunk.partition("=")
        if not sep or not value or key in parts:
            raise RecurrenceError("Malformed repeat rule")
        parts[key] = value
    return parts


def normalise(rule: str) -> str:
    """Validate a rule and return it in canonical form (raises RecurrenceError)."""
    if len(rule) > MAX_LENGTH:
        raise RecurrenceError("Repeat rule is too long")
    parts = parse_rule(rule)
    unknown = set(parts) - {"FREQ", "INTERVAL", "BYDAY", "BYMONTHDAY"}
    if unknown:
        raise RecurrenceError(f"Unsupported repeat option: {', '.join(sorted(unknown))}")
    if parts.get("FREQ") not in _FREQ:
        raise RecurrenceError("Repeat frequency must be DAILY, WEEKLY, MONTHLY or YEARLY")
    out = [f"FREQ={parts['FREQ']}"]
    if "INTERVAL" in parts:
        if not parts["INTERVAL"].isdigit() or not 1 <= int(parts["INTERVAL"]) <= 365:
            raise RecurrenceError("Repeat interval must be between 1 and 365")
        if int(parts["INTERVAL"]) > 1:
            out.append(f"INTERVAL={int(parts['INTERVAL'])}")
    if "BYDAY" in parts:
        days = parts["BYDAY"].split(",")
        if not days or len(days) > 7 or any(not _BYDAY.match(d) for d in days):
            raise RecurrenceError("Invalid weekdays in repeat rule")
        if parts["FREQ"] != "MONTHLY" and any(not d.isalpha() for d in days):
            raise RecurrenceError("Numbered weekdays (like 1MO) are only valid for monthly repeats")
        out.append(f"BYDAY={','.join(days)}")
    if "BYMONTHDAY" in parts:
        value = parts["BYMONTHDAY"]
        if not re.fullmatch(r"-1|[1-9]|[12]\d|3[01]", value):
            raise RecurrenceError("Day of month must be 1–31 or -1 (last day)")
        out.append(f"BYMONTHDAY={value}")
    return ";".join(out)


def _byday(value: str) -> list[weekday]:
    result = []
    for token in value.split(","):
        m = _BYDAY.match(token)
        assert m is not None
        n, day = m.group(1), _DAYS[m.group(2)]
        result.append(day(int(n)) if n else day)
    return result


def build(rule: str, dtstart: datetime) -> rrule:
    parts = parse_rule(normalise(rule))
    kwargs: dict[str, object] = {"dtstart": dtstart, "interval": int(parts.get("INTERVAL", "1"))}
    if "BYDAY" in parts:
        kwargs["byweekday"] = _byday(parts["BYDAY"])
    if "BYMONTHDAY" in parts:
        kwargs["bymonthday"] = int(parts["BYMONTHDAY"])
    return rrule(_FREQ[parts["FREQ"]], **kwargs)  # type: ignore[arg-type]


def next_due(rule: str, due_at: datetime, has_time: bool, tz: str, now: datetime) -> datetime | None:
    """The occurrence after `due_at`, skipping ahead past any days already gone by."""
    zi = zone(tz)
    local_due = due_at.astimezone(zi).replace(tzinfo=None)
    at = local_due.time() if has_time else time(23, 59, 59)
    start = datetime.combine(local_due.date(), at)
    today_start = datetime.combine(now.astimezone(zi).date(), time(0, 0))
    after = max(start, today_start - timedelta(seconds=1))
    candidate = build(rule, start).after(after)
    if candidate is None:
        return None
    return local_to_utc(candidate.date(), candidate.time(), tz)


def first_due(rule: str, at: time | None, tz: str, now: datetime) -> datetime | None:
    """First occurrence at or after now (used when a note says "every monday 9am" with no date)."""
    zi = zone(tz)
    local_now = now.astimezone(zi).replace(tzinfo=None)
    start = datetime.combine(local_now.date(), at or time(23, 59, 59))
    candidate = build(rule, start).after(local_now, inc=True)
    if candidate is None:
        return None
    return local_to_utc(candidate.date(), candidate.time(), tz)


_DAY_NAMES = {"MO": "Mon", "TU": "Tue", "WE": "Wed", "TH": "Thu", "FR": "Fri", "SA": "Sat", "SU": "Sun"}


def describe(rule: str) -> str:
    """Short human description, e.g. "Every 2 weeks on Mon, Thu"."""
    p = parse_rule(normalise(rule))
    n = int(p.get("INTERVAL", "1"))
    unit = {"DAILY": "day", "WEEKLY": "week", "MONTHLY": "month", "YEARLY": "year"}[p["FREQ"]]
    if p.get("BYDAY") == "MO,TU,WE,TH,FR" and p["FREQ"] == "WEEKLY" and n == 1:
        return "Every weekday"
    text = f"Every {unit}" if n == 1 else f"Every {n} {unit}s"
    if "BYDAY" in p:
        text += " on " + ", ".join(_DAY_NAMES.get(d[-2:], d) for d in p["BYDAY"].split(","))
    if "BYMONTHDAY" in p:
        text += " on the last day" if p["BYMONTHDAY"] == "-1" else f" on day {p['BYMONTHDAY']}"
    return text
