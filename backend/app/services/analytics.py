"""Progress analytics, productivity summaries and personalised insights (deterministic core)."""

import uuid
from collections import Counter
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from typing import Any

from sqlalchemy import case, func, or_, select
from sqlalchemy.orm import Session

from app.models import Goal, GoalStatus, Task, TaskStatus, User, utcnow
from app.services.timeutil import local_date_of, local_day_bounds, today_local, zone

_WEEKDAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]


def _tasks_touching(db: Session, user: User, start: datetime) -> list[Task]:
    """Non-deleted tasks created or completed since `start`, plus all open tasks."""
    return list(
        db.scalars(
            select(Task).where(
                Task.user_id == user.id,
                Task.deleted_at.is_(None),
                or_(
                    Task.created_at >= start,
                    Task.completed_at >= start,
                    Task.status != TaskStatus.done.value,
                ),
            )
        )
    )


def goal_progress(db: Session, user: User, goals: list[Goal]) -> dict[uuid.UUID, tuple[float, int, int]]:
    """Return {goal_id: (progress 0..1, tasks_total, tasks_done)} in a single grouped query."""
    if not goals:
        return {}
    rows = db.execute(
        select(
            Task.goal_id,
            func.count(),
            func.sum(case((Task.status == TaskStatus.done.value, 1), else_=0)),
        )
        .where(Task.user_id == user.id, Task.deleted_at.is_(None), Task.goal_id.in_([g.id for g in goals]))
        .group_by(Task.goal_id)
    ).all()
    counts = {gid: (int(total), int(done or 0)) for gid, total, done in rows}
    out: dict[uuid.UUID, tuple[float, int, int]] = {}
    for g in goals:
        total, done = counts.get(g.id, (0, 0))
        if g.status == GoalStatus.completed.value:
            progress = 1.0
        elif g.target_value:
            progress = min(1.0, g.current_value / g.target_value)
        elif total:
            progress = done / total
        else:
            progress = 0.0
        out[g.id] = (round(progress, 4), total, done)
    return out


def overview(db: Session, user: User, days: int, now: datetime) -> dict[str, Any]:
    tz = user.timezone
    today = today_local(tz, now)
    first_day = today - timedelta(days=days - 1)
    start, _ = local_day_bounds(first_day, today, tz)
    tasks = _tasks_touching(db, user, start)

    created_by_day: Counter[date] = Counter()
    done_by_day: Counter[date] = Counter()
    by_weekday: Counter[int] = Counter()
    by_hour: Counter[int] = Counter()
    by_category: dict[str, dict[str, int]] = {}
    open_by_priority: Counter[str] = Counter()
    on_time = late = overdue = open_count = 0

    for t in tasks:
        if t.created_at >= start:
            created_by_day[local_date_of(t.created_at, tz)] += 1
        cat = by_category.setdefault(t.category or "Uncategorised", {"open": 0, "done": 0})
        if t.status == TaskStatus.done.value and t.completed_at is not None:
            if t.completed_at >= start:
                local_done = t.completed_at.astimezone(zone(tz))
                done_by_day[local_done.date()] += 1
                by_weekday[local_done.weekday()] += 1
                by_hour[local_done.hour] += 1
                cat["done"] += 1
                if t.due_at is not None:
                    if t.completed_at <= t.due_at:
                        on_time += 1
                    else:
                        late += 1
        elif t.status != TaskStatus.done.value:
            open_count += 1
            cat["open"] += 1
            open_by_priority[t.priority] += 1
            if t.due_at is not None and t.due_at < now:
                overdue += 1

    series = []
    for i in range(days):
        d = first_day + timedelta(days=i)
        series.append({"date": d.isoformat(), "created": created_by_day[d], "completed": done_by_day[d]})

    # Streak: consecutive days ending today (or yesterday, so a fresh morning does not reset it).
    completed_days = _completion_days(db, user, tz)
    streak, cursor = 0, today if today in completed_days else today - timedelta(days=1)
    while cursor in completed_days:
        streak += 1
        cursor -= timedelta(days=1)

    created_total = sum(created_by_day.values())
    completed_total = sum(done_by_day.values())
    goals = list(db.scalars(select(Goal).where(Goal.user_id == user.id, Goal.status != GoalStatus.archived.value)))
    progress = goal_progress(db, user, goals)

    return {
        "days": days,
        "start": first_day.isoformat(),
        "end": today.isoformat(),
        "series": series,
        "created_total": created_total,
        "completed_total": completed_total,
        "completion_ratio": round(completed_total / created_total, 3) if created_total else None,
        "on_time_rate": round(on_time / (on_time + late), 3) if (on_time + late) else None,
        "open_total": open_count,
        "overdue_total": overdue,
        "streak_days": streak,
        "by_category": [
            {"category": k, **v}
            for k, v in sorted(by_category.items(), key=lambda kv: -(kv[1]["open"] + kv[1]["done"]))
        ][:12],
        "open_by_priority": {p: open_by_priority.get(p, 0) for p in ("urgent", "high", "medium", "low")},
        "completions_by_weekday": [{"weekday": _WEEKDAY_NAMES[i], "count": by_weekday.get(i, 0)} for i in range(7)],
        "completions_by_hour": [{"hour": h, "count": by_hour.get(h, 0)} for h in range(24)],
        "goals": [
            {"id": str(g.id), "title": g.title, "progress": progress[g.id][0], "status": g.status} for g in goals
        ],
    }


def _completion_days(db: Session, user: User, tz: str, limit_days: int = 400) -> set[date]:
    since = utcnow() - timedelta(days=limit_days)
    stamps = db.scalars(
        select(Task.completed_at).where(
            Task.user_id == user.id,
            Task.deleted_at.is_(None),
            Task.status == TaskStatus.done.value,
            Task.completed_at >= since,
        )
    )
    return {local_date_of(s, tz) for s in stamps if s is not None}


@dataclass
class PeriodSummary:
    start: date
    end: date
    stats: dict[str, Any]
    highlights: list[str]


def period_bounds(period: str, anchor: date) -> tuple[date, date]:
    if period == "day":
        return anchor, anchor
    if period == "week":
        start = anchor - timedelta(days=anchor.weekday())
        return start, start + timedelta(days=6)
    start = anchor.replace(day=1)
    next_month = (start + timedelta(days=32)).replace(day=1)
    return start, next_month - timedelta(days=1)


def period_summary(db: Session, user: User, period: str, anchor: date, now: datetime) -> PeriodSummary:
    tz = user.timezone
    start_d, end_d = period_bounds(period, anchor)
    start, end = local_day_bounds(start_d, end_d, tz)
    base = select(Task).where(Task.user_id == user.id, Task.deleted_at.is_(None))
    created = list(db.scalars(base.where(Task.created_at >= start, Task.created_at < end)))
    completed = list(
        db.scalars(
            base.where(
                Task.completed_at >= start, Task.completed_at < end, Task.status == TaskStatus.done.value
            ).order_by(Task.completed_at)
        )
    )
    due_in_period = list(db.scalars(base.where(Task.due_at >= start, Task.due_at < end)))
    missed = [t for t in due_in_period if t.status != TaskStatus.done.value and t.due_at and t.due_at < now]
    # Only real categories count; "no category" is not a meaningful focus area.
    categories = Counter(t.category for t in completed if t.category)
    days = Counter(local_date_of(t.completed_at, tz) for t in completed if t.completed_at)
    busiest = max(days.items(), key=lambda kv: kv[1])[0] if days else None

    stats: dict[str, Any] = {
        "created": len(created),
        "completed": len(completed),
        "due_in_period": len(due_in_period),
        "due_done": sum(1 for t in due_in_period if t.status == TaskStatus.done.value),
        "missed_deadlines": len(missed),
        "completion_rate": round(
            sum(1 for t in due_in_period if t.status == TaskStatus.done.value) / len(due_in_period), 3
        )
        if due_in_period
        else None,
        "top_category": categories.most_common(1)[0][0] if categories else None,
        "busiest_day": busiest.isoformat() if busiest else None,
    }
    highlights = [t.title for t in sorted(completed, key=lambda t: _priority_rank(t.priority))[:5]]
    return PeriodSummary(start=start_d, end=end_d, stats=stats, highlights=highlights)


def _priority_rank(priority: str) -> int:
    return {"urgent": 0, "high": 1, "medium": 2, "low": 3}.get(priority, 4)


def template_narrative(period: str, summary: PeriodSummary) -> str:
    s = summary.stats
    label = {"day": "today", "week": "this week", "month": "this month"}[period]
    if not s["created"] and not s["completed"] and not s["due_in_period"]:
        return f"No task activity {label} yet. Add a few tasks to start building momentum."
    parts = [f"You completed {s['completed']} task{'s' * (s['completed'] != 1)} {label}"]
    parts[0] += f" and added {s['created']}." if s["created"] else "."
    if s["due_in_period"]:
        upcoming = s["due_in_period"] - s["due_done"] - s["missed_deadlines"]
        noun = "task" if s["due_in_period"] == 1 else "tasks"
        verb = "is" if s["due_done"] == 1 else "are"
        sentence = f"Of the {s['due_in_period']} {noun} due {label}, {s['due_done']} {verb} done"
        parts.append(sentence + (f" and {upcoming} still ahead." if upcoming > 0 else "."))
    if s["missed_deadlines"]:
        parts.append(
            f"{s['missed_deadlines']} deadline{'s were' if s['missed_deadlines'] != 1 else ' was'} missed — "
            "consider rescheduling or breaking those tasks down."
        )
    if s["top_category"]:
        parts.append(f"Most of your progress was in “{s['top_category']}”.")
    return " ".join(parts)


def rule_insights(stats: dict[str, Any]) -> list[str]:
    out: list[str] = []
    weekdays = [w for w in stats["completions_by_weekday"] if w["count"]]
    if weekdays:
        best = max(weekdays, key=lambda w: w["count"])
        out.append(f"{best['weekday']} is your most productive day ({best['count']} tasks completed).")
    hours = [h for h in stats["completions_by_hour"] if h["count"]]
    if hours:
        best_h = max(hours, key=lambda h: h["count"])["hour"]
        out.append(f"You finish the most tasks around {best_h:02d}:00 — protect that time for deep work.")
    if stats["on_time_rate"] is not None:
        rate = round(stats["on_time_rate"] * 100)
        out.append(
            f"You meet {rate}% of your deadlines."
            + (" Great consistency!" if rate >= 80 else " Try adding buffers or earlier reminders.")
        )
    if stats["overdue_total"]:
        out.append(f"{stats['overdue_total']} task(s) are overdue. Reschedule or drop what no longer matters.")
    if stats["streak_days"] >= 2:
        out.append(f"You're on a {stats['streak_days']}-day completion streak — keep it going!")
    worst = max(stats["by_category"], key=lambda c: c["open"], default=None)
    if worst and worst["open"] >= 5:
        out.append(f"“{worst['category']}” has {worst['open']} open tasks; it may need a dedicated planning block.")
    urgent_open = stats["open_by_priority"]["urgent"] + stats["open_by_priority"]["high"]
    if urgent_open > 7:
        out.append(f"{urgent_open} open tasks are high or urgent priority — when everything is urgent, nothing is.")
    if not out:
        out.append("Complete a few tasks to unlock personalised insights about your work patterns.")
    return out
