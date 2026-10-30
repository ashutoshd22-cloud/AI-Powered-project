"""Explainable task prioritisation.

The score is a transparent weighted sum so users can see *why* a task is ranked highly.
"""

from dataclasses import dataclass
from datetime import datetime, timedelta

from app.models import Task, TaskStatus
from app.services.timeutil import local_date_of, today_local

PRIORITY_WEIGHT = {"urgent": 40.0, "high": 28.0, "medium": 16.0, "low": 6.0}


@dataclass
class Scored:
    task: Task
    score: float
    reasons: list[str]


def score_task(task: Task, now: datetime, tz: str, neglect_days: int) -> Scored:
    score = PRIORITY_WEIGHT.get(task.priority, 16.0)
    reasons = [f"{task.priority.capitalize()} priority"]
    today = today_local(tz, now)

    if task.due_at is not None:
        remaining = task.due_at - now
        if remaining < timedelta(0):
            days_over = max(0, (today - local_date_of(task.due_at, tz)).days)
            score += 35 + min(days_over * 2, 15)
            reasons.append("Overdue" if days_over == 0 else f"Overdue by {days_over} day{'s' * (days_over != 1)}")
        elif remaining <= timedelta(hours=24):
            score += 30
            reasons.append("Due within 24 hours")
        elif remaining <= timedelta(days=3):
            score += 20
            reasons.append("Due within 3 days")
        elif remaining <= timedelta(days=7):
            score += 10
            reasons.append("Due this week")

    if task.scheduled_for is not None and task.scheduled_for <= today:
        score += 12
        reasons.append("Planned for today" if task.scheduled_for == today else "Planned earlier and not done")

    if task.status == TaskStatus.in_progress.value:
        score += 6
        reasons.append("Already in progress")

    idle = now - task.updated_at
    if idle > timedelta(days=neglect_days):
        score += 8
        reasons.append(f"Untouched for {idle.days} days")

    if task.goal_id is not None:
        score += 5
        reasons.append("Moves a goal forward")

    if task.estimated_minutes is not None and task.estimated_minutes <= 15:
        score += 3
        reasons.append("Quick win (≤15 min)")

    return Scored(task=task, score=round(score, 1), reasons=reasons)


def prioritise(tasks: list[Task], now: datetime, tz: str, neglect_days: int) -> list[Scored]:
    open_tasks = [t for t in tasks if t.status != TaskStatus.done.value and t.deleted_at is None]
    scored = [score_task(t, now, tz, neglect_days) for t in open_tasks]
    # Ties: earlier due date first, then oldest task first (stable, deterministic).
    far_future = datetime.max.replace(tzinfo=now.tzinfo)
    scored.sort(key=lambda s: (-s.score, s.task.due_at or far_future, s.task.created_at))
    return scored
