from datetime import UTC, datetime

import pytest

from app.models import Priority
from app.services.nlp import parse_line, parse_text
from app.services.timeutil import local_to_utc

# Friday 2026-10-30 14:00 UTC
NOW = datetime(2026, 10, 30, 14, 0, tzinfo=UTC)


def p(text: str, tz: str = "UTC"):  # type: ignore[no-untyped-def]
    return parse_line(text, tz, NOW)


def test_plain_title_has_no_metadata() -> None:
    r = p("buy milk")
    assert (r.title, r.due_at, r.priority, r.category) == ("Buy milk", None, Priority.medium, None)


def test_tomorrow_with_time_in_user_timezone() -> None:
    r = p("Call mom tomorrow at 6pm #family", tz="Asia/Kolkata")
    assert r.title == "Call mom"
    assert r.category == "family"
    assert r.due_has_time
    assert r.due_at == datetime(2026, 10, 31, 12, 30, tzinfo=UTC)  # 18:00 IST


@pytest.mark.parametrize(
    ("text", "priority"),
    [
        ("Fix prod urgent", Priority.urgent),
        ("pay bills !!", Priority.high),
        ("tidy desk !low", Priority.low),
        ("Important: call bank", Priority.high),
        ("asap reply to Sam", Priority.urgent),
    ],
)
def test_priority_markers(text: str, priority: Priority) -> None:
    assert p(text).priority == priority


def test_weekday_is_next_occurrence_and_date_only_is_end_of_local_day() -> None:
    r = p("Submit report by friday", tz="America/New_York")
    assert r.title == "Submit report"
    assert not r.due_has_time
    assert r.due_at == local_to_utc(
        datetime(2026, 11, 6).date(), datetime(2026, 1, 1, 23, 59, 59).time(), "America/New_York"
    )


def test_absolute_dates() -> None:
    assert p("Dentist 2026-11-05 at 14:30").due_at == datetime(2026, 11, 5, 14, 30, tzinfo=UTC)
    assert p("meet Sam on 3rd December").due_at.date().isoformat() == "2026-12-03"  # type: ignore[union-attr]
    # A month/day that already passed this year rolls over to next year.
    assert p("renew passport march 1").due_at.date().isoformat() == "2027-03-01"  # type: ignore[union-attr]
    # Invalid dates are left in the title instead of crashing.
    r = p("party on feb 30")
    assert r.due_at is None and "30" in r.title


def test_relative_and_time_only() -> None:
    assert p("stretch in 30 minutes").due_at == datetime(2026, 10, 30, 14, 30, tzinfo=UTC)
    assert p("deploy in 2 hours").due_at == datetime(2026, 10, 30, 16, 0, tzinfo=UTC)
    # 9am already passed today (14:00 UTC) → tomorrow.
    assert p("email boss at 9am").due_at == datetime(2026, 10, 31, 9, 0, tzinfo=UTC)
    assert p("email boss at 5pm").due_at == datetime(2026, 10, 30, 17, 0, tzinfo=UTC)
    assert p("lunch at noon tomorrow").due_at == datetime(2026, 10, 31, 12, 0, tzinfo=UTC)
    assert p("read tonight").due_at == datetime(2026, 10, 30, 20, 0, tzinfo=UTC)


def test_dst_spring_forward_gap_is_resolved_forward() -> None:
    # 2027-03-14 02:30 does not exist in New York (clocks jump 02:00 → 03:00).
    r = parse_line("Backup 2027-03-14 at 2:30am", "America/New_York", NOW)
    assert r.due_at == datetime(2027, 3, 14, 7, 30, tzinfo=UTC)  # 03:30 EDT


def test_reminder_phrases() -> None:
    r = p("remind me to call the plumber tomorrow at 10am")
    assert r.title == "Call the plumber"
    assert r.remind_at == r.due_at
    date_only = p("remind me to pay rent on Nov 1")
    assert date_only.remind_at == datetime(2026, 11, 1, 9, 0, tzinfo=UTC)
    no_date = p("remind me to stretch")
    assert no_date.remind_at is None and no_date.warnings


def test_recurrence_and_estimates() -> None:
    r = p("gym every monday morning")
    assert r.title == "Gym" and r.warnings and r.due_at is None
    est = p("Review PR for 45 min tomorrow")
    assert est.estimated_minutes == 45 and est.title == "Review PR"
    assert p("deep work for 2 hours").estimated_minutes == 120


def test_splitting_and_bullets() -> None:
    results = parse_text("- buy eggs\n* call Ana tomorrow\n1. pay rent; book flights", "UTC", NOW)
    assert [r.title for r in results] == ["Buy eggs", "Call Ana", "Pay rent", "Book flights"]


def test_words_that_look_like_dates_are_not_consumed() -> None:
    assert p("Watch the movie Sunday Morning Coming Down").title.startswith("Watch the movie")
    assert p("I may go hiking").due_at is None
    assert p("sat down with team #sync").title == "Sat down with team"


def test_title_falls_back_to_original_when_everything_is_metadata() -> None:
    r = p("tomorrow")
    assert r.title == "Tomorrow" and r.due_at is not None
