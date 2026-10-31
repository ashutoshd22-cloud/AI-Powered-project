"""Deterministic natural-language task parser.

Always available (no LLM required) and used as the fallback when Ollama is unreachable or
returns invalid output. Handles English phrases such as:

    "Call mom tomorrow at 6pm #family"
    "remind me to pay rent on Nov 1 !high"
    "Submit report by friday urgent"
    "stretch in 30 minutes"

All dates are interpreted in the user's time zone and returned as UTC instants.
"""

import calendar
import re
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, time, timedelta

from app.models import Priority
from app.services.timeutil import end_of_local_day, local_to_utc, now_local

MAX_TASKS_PER_REQUEST = 20

_WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]
_WEEKDAY_ABBR = {"mon": 0, "tue": 1, "tues": 1, "wed": 2, "thu": 3, "thur": 3, "thurs": 3, "fri": 4, "sat": 5, "sun": 6}
_MONTHS = {
    "jan": 1,
    "january": 1,
    "feb": 2,
    "february": 2,
    "mar": 3,
    "march": 3,
    "apr": 4,
    "april": 4,
    "may": 5,
    "jun": 6,
    "june": 6,
    "jul": 7,
    "july": 7,
    "aug": 8,
    "august": 8,
    "sep": 9,
    "sept": 9,
    "september": 9,
    "oct": 10,
    "october": 10,
    "nov": 11,
    "november": 11,
    "dec": 12,
    "december": 12,
}
_MONTH_RE = (
    r"jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?"
    r"|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?"
)
_PREFIX = r"(?:\b(?:by|on|due|before|at|for)\s+)?"

_PRIORITY_PATTERNS: list[tuple[re.Pattern[str], Priority]] = [
    (re.compile(r"(?:\b(?:urgent(?:ly)?|asap)\b|!urgent\b|!!!)", re.I), Priority.urgent),
    (re.compile(r"(?:\b(?:high[- ]priority|important)\b|!high\b|!!)", re.I), Priority.high),
    (re.compile(r"(?:\blow[- ]priority\b|!low\b)", re.I), Priority.low),
    (re.compile(r"(?:\bmedium[- ]priority\b|!medium\b)", re.I), Priority.medium),
]
_CATEGORY = re.compile(r"(?<![\w&])#([\w-]{1,50})", re.UNICODE)
_REMIND_PREFIX = re.compile(r"^\s*(?:please\s+)?remind me\s+(?:to\s+)?", re.I)
_RECURRENCE = re.compile(
    r"\bevery\s+(?:day|week|month|year|morning|evening|weekday|(?:%s))(?:\s+(?:morning|afternoon|evening))?\b"
    % "|".join(_WEEKDAYS),
    re.I,
)
_ESTIMATE = re.compile(r"\bfor\s+(\d{1,3})\s*(min(?:ute)?s?|h(?:ou)?rs?)\b", re.I)
_RELATIVE = re.compile(r"\bin\s+(\d{1,3}|an?|one|two|three)\s+(min(?:ute)?s?|h(?:ou)?rs?|days?|weeks?)\b", re.I)
_DAY_AFTER_TOMORROW = re.compile(_PREFIX + r"\bday after tomorrow\b", re.I)
_TOMORROW = re.compile(_PREFIX + r"\b(?:tomorrow|tmrw?|tmw)\b", re.I)
_TODAY = re.compile(_PREFIX + r"\b(?:today|tonight)\b", re.I)
_NEXT_WEEK = re.compile(_PREFIX + r"\bnext week\b", re.I)
_NEXT_MONTH = re.compile(_PREFIX + r"\bnext month\b", re.I)
_END_OF_MONTH = re.compile(_PREFIX + r"\b(?:the\s+)?end of (?:the\s+)?month\b", re.I)
_WEEKEND = re.compile(_PREFIX + r"\b(?:this\s+)?weekend\b", re.I)
_WEEKDAY_FULL = re.compile(_PREFIX + r"\b(?:(next|this)\s+)?(%s)\b" % "|".join(_WEEKDAYS), re.I)
_WEEKDAY_ABBR_RE = re.compile(
    r"\b(?:by|on|next|this)\s+(%s)\b" % "|".join(sorted(_WEEKDAY_ABBR, key=len, reverse=True)), re.I
)
_ISO_DATE = re.compile(_PREFIX + r"\b(\d{4})-(\d{1,2})-(\d{1,2})\b")
_MONTH_DAY = re.compile(_PREFIX + r"\b(%s)\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?\b" % _MONTH_RE, re.I)
_DAY_MONTH = re.compile(_PREFIX + r"\b(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?(%s)\b(?:,?\s+(\d{4}))?" % _MONTH_RE, re.I)
_TIME_AMPM = re.compile(r"(?:\bat\s+)?\b(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)(?!\w)", re.I)
_TIME_24 = re.compile(r"(?:\bat\s+)?\b([01]?\d|2[0-3]):([0-5]\d)\b")
_TIME_WORD = re.compile(r"(?:\bat\s+)?\b(noon|midday|midnight)\b", re.I)
_DAYPART = re.compile(r"\b(?:in the\s+|this\s+)?(morning|afternoon|evening)\b", re.I)
_DAYPART_TIMES = {"morning": time(9, 0), "afternoon": time(14, 0), "evening": time(18, 0)}
_TRAILING_CONNECTOR = re.compile(
    r"(?:\s+|^)(?:by|on|at|due|before|for|to|and|in|it'?s|it is|this is|please|pls)\s*$", re.I
)
_LEADING_CONNECTOR = re.compile(r"^\s*(?:to|and)\s+", re.I)
_BULLET = re.compile(r"^\s*(?:[-*•]|\d{1,2}[.)])\s+")
_WORD_NUMBERS = {"a": 1, "an": 1, "one": 1, "two": 2, "three": 3}


@dataclass
class ParsedFields:
    title: str
    priority: Priority = Priority.medium
    category: str | None = None
    due_at: datetime | None = None
    due_has_time: bool = False
    remind_at: datetime | None = None
    estimated_minutes: int | None = None
    warnings: list[str] = field(default_factory=list)


class _Text:
    """Tracks which character ranges of the input were consumed by a matcher."""

    def __init__(self, text: str) -> None:
        self.text = text
        self.consumed = [False] * len(text)

    def search(self, pattern: re.Pattern[str]) -> re.Match[str] | None:
        for match in pattern.finditer(self.text):
            if not any(self.consumed[match.start() : match.end()]):
                return match
        return None

    def consume(self, match: re.Match[str]) -> None:
        for i in range(match.start(), match.end()):
            self.consumed[i] = True

    def remainder(self) -> str:
        return "".join(" " if used else ch for ch, used in zip(self.text, self.consumed, strict=True))


def _next_weekday(today: date, weekday: int, include_today: bool = False) -> date:
    delta = (weekday - today.weekday()) % 7
    if delta == 0 and not include_today:
        delta = 7
    return today + timedelta(days=delta)


def _safe_date(year: int, month: int, day: int) -> date | None:
    try:
        return date(year, month, day)
    except ValueError:
        return None


def _absolute_date(year: int | None, month: int, day: int, today: date) -> date | None:
    if year is not None:
        return _safe_date(year, month, day)
    candidate = _safe_date(today.year, month, day)
    if candidate is not None and candidate < today:
        candidate = _safe_date(today.year + 1, month, day)
    return candidate


def _extract_date(t: _Text, today: date) -> tuple[date | None, time | None]:
    """Returns (date, implied time). Implied time comes from words like 'tonight'."""
    if m := t.search(_DAY_AFTER_TOMORROW):
        t.consume(m)
        return today + timedelta(days=2), None
    if m := t.search(_TOMORROW):
        t.consume(m)
        return today + timedelta(days=1), None
    if m := t.search(_TODAY):
        t.consume(m)
        return today, (time(20, 0) if "tonight" in m.group(0).lower() else None)
    if m := t.search(_NEXT_WEEK):
        t.consume(m)
        return _next_weekday(today, 0), None
    if m := t.search(_NEXT_MONTH):
        t.consume(m)
        year, month = (today.year + 1, 1) if today.month == 12 else (today.year, today.month + 1)
        return date(year, month, 1), None
    if m := t.search(_END_OF_MONTH):
        t.consume(m)
        return date(today.year, today.month, calendar.monthrange(today.year, today.month)[1]), None
    if m := t.search(_WEEKEND):
        t.consume(m)
        return _next_weekday(today, 5, include_today=True), None
    if m := t.search(_ISO_DATE):
        parsed = _safe_date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
        if parsed:
            t.consume(m)
            return parsed, None
    if m := t.search(_MONTH_DAY):
        explicit_year = int(m.group(3)) if m.group(3) else None
        parsed = _absolute_date(explicit_year, _MONTHS[m.group(1).lower().rstrip(".")], int(m.group(2)), today)
        if parsed:
            t.consume(m)
            return parsed, None
    if m := t.search(_DAY_MONTH):
        explicit_year = int(m.group(3)) if m.group(3) else None
        parsed = _absolute_date(explicit_year, _MONTHS[m.group(2).lower()], int(m.group(1)), today)
        if parsed:
            t.consume(m)
            return parsed, None
    if m := t.search(_WEEKDAY_FULL):
        t.consume(m)
        qualifier = (m.group(1) or "").lower()
        weekday = _WEEKDAYS.index(m.group(2).lower())
        # "next monday" is treated as the coming Monday (the most common reading).
        return _next_weekday(today, weekday, include_today=qualifier == "this"), None
    if m := t.search(_WEEKDAY_ABBR_RE):
        t.consume(m)
        return _next_weekday(today, _WEEKDAY_ABBR[m.group(1).lower()]), None
    return None, None


def _extract_time(t: _Text) -> time | None:
    if m := t.search(_TIME_AMPM):
        hour, minute = int(m.group(1)), int(m.group(2) or 0)
        if 1 <= hour <= 12 and minute < 60:
            t.consume(m)
            is_pm = m.group(3).lower().startswith("p")
            hour = hour % 12 + (12 if is_pm else 0)
            return time(hour, minute)
    if m := t.search(_TIME_24):
        t.consume(m)
        return time(int(m.group(1)), int(m.group(2)))
    if m := t.search(_TIME_WORD):
        t.consume(m)
        return time(23, 59) if m.group(1).lower() == "midnight" else time(12, 0)
    return None


def _clean_title(raw: str, fallback: str) -> str:
    title = re.sub(r"\s+", " ", raw).strip(" ,.;:-–—")
    for _ in range(3):
        title = _TRAILING_CONNECTOR.sub("", title).strip(" ,.;:-–—")
        title = _LEADING_CONNECTOR.sub("", title).strip(" ,.;:-–—")
    title = re.sub(r"\s+([,.;:!?])", r"\1", title)
    if not title:
        title = fallback.strip()
    title = title[:200]
    return title[:1].upper() + title[1:]


def parse_line(line: str, tz: str, now: datetime | None = None) -> ParsedFields:
    now = now or datetime.now(UTC)
    local_now = now_local(tz, now)
    today = local_now.date()
    original = _BULLET.sub("", line).strip()
    t = _Text(original)
    result = ParsedFields(title=original)

    reminder_requested = False
    if m := t.search(_REMIND_PREFIX):
        t.consume(m)
        reminder_requested = True

    if m := t.search(_RECURRENCE):
        t.consume(m)
        result.warnings.append("Recurring tasks are not supported yet; a single task was created.")

    for pattern, priority in _PRIORITY_PATTERNS:
        if m := t.search(pattern):
            t.consume(m)
            result.priority = priority
            break

    if m := t.search(_CATEGORY):
        t.consume(m)
        result.category = m.group(1)[:50]

    if m := t.search(_ESTIMATE):
        t.consume(m)
        amount = int(m.group(1))
        result.estimated_minutes = min(1440, amount * 60 if m.group(2).lower().startswith("h") else amount)

    due_at: datetime | None = None
    has_time = False
    if m := t.search(_RELATIVE):
        t.consume(m)
        raw = m.group(1).lower()
        amount = _WORD_NUMBERS.get(raw) or int(raw)
        unit = m.group(2).lower()
        if unit.startswith("min"):
            due_at, has_time = now + timedelta(minutes=amount), True
        elif unit.startswith("h"):
            due_at, has_time = now + timedelta(hours=amount), True
        else:
            days = amount * (7 if unit.startswith("week") else 1)
            due_at = end_of_local_day(today + timedelta(days=days), tz)

    if due_at is None:
        day, implied_time = _extract_date(t, today)
        at = _extract_time(t)
        if (
            at is None
            and (m := t.search(_DAYPART))
            and (day is not None or m.group(0).lower().startswith(("in the", "this")))
        ):
            t.consume(m)
            at = _DAYPART_TIMES[m.group(1).lower()]
        at = at or implied_time
        if day is None and at is not None:
            day = today if local_to_utc(today, at, tz) > now else today + timedelta(days=1)
        if day is not None:
            if at is not None:
                due_at, has_time = local_to_utc(day, at, tz), True
            else:
                due_at = end_of_local_day(day, tz)

    result.due_at = due_at
    result.due_has_time = has_time
    if reminder_requested and due_at is not None and has_time:
        result.remind_at = due_at
    elif reminder_requested and due_at is not None:
        # Date-only reminder: nudge at 09:00 local on that day (or now, if that has passed).
        result.remind_at = max(local_to_utc(due_at.astimezone(local_now.tzinfo).date(), time(9, 0), tz), now)
    elif reminder_requested:
        result.warnings.append("No time was found for the reminder; add a due time to be reminded.")

    result.title = _clean_title(t.remainder(), fallback=original)
    return result


def split_lines(text: str) -> list[str]:
    parts = [p.strip() for p in re.split(r"[\n;]+", text)]
    return [p for p in parts if p][:MAX_TASKS_PER_REQUEST]


def parse_text(text: str, tz: str, now: datetime | None = None) -> list[ParsedFields]:
    return [parse_line(line, tz, now) for line in split_lines(text)]
