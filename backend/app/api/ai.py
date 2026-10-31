from datetime import date
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select

from app.config import get_settings
from app.deps import CurrentUser, DbSession
from app.models import Task, TaskStatus, User, utcnow
from app.rate_limit import limiter
from app.schemas import (
    AIStatusOut,
    AttentionOut,
    CommandIn,
    CommandOut,
    FromTextIn,
    FromTextOut,
    FromTextResult,
    InsightsOut,
    ParsedTask,
    ParseIn,
    ParseOut,
    PrioritizedTask,
    PrioritizeOut,
    SummaryOut,
    TaskOut,
)
from app.services import ai, analytics
from app.services import tasks as task_service
from app.services.llm import LLM, get_llm
from app.services.prioritization import prioritise
from app.services.timeutil import today_local

router = APIRouter(prefix="/ai", tags=["ai"])

Llm = Annotated[LLM, Depends(get_llm)]


def _limit(user: User) -> None:
    limiter.check(f"ai:{user.id}", limit=30, window_seconds=60)


def _open_tasks(db: DbSession, user: User) -> list[Task]:
    return list(
        db.scalars(
            select(Task)
            .where(Task.user_id == user.id, Task.deleted_at.is_(None), Task.status != TaskStatus.done.value)
            .limit(2000)
        )
    )


@router.get("/status", response_model=AIStatusOut)
def ai_status(user: CurrentUser, llm: Llm) -> AIStatusOut:
    return AIStatusOut(**llm.status())


@router.post("/parse", response_model=ParseOut)
def parse_text(body: ParseIn, user: CurrentUser, db: DbSession, llm: Llm) -> ParseOut:
    """Preview only — never creates tasks. Flags open tasks that look like duplicates."""
    _limit(user)
    items, parser, warnings = ai.parse(llm, body.text, user.timezone, body.use_llm)
    out = []
    for item in items:
        dup = task_service.find_open_duplicate(db, user, item.title)
        out.append(
            ParsedTask(
                title=item.title,
                priority=item.priority,
                category=item.category,
                due_at=item.due_at,
                due_has_time=item.due_has_time,
                remind_at=item.remind_at,
                recurrence=item.recurrence,
                duplicate_of=TaskOut.model_validate(dup) if dup else None,
            )
        )
    return ParseOut(tasks=out, parser=parser, warnings=warnings)


@router.post("/tasks/from-text", response_model=FromTextOut)
def create_from_text(body: FromTextIn, user: CurrentUser, db: DbSession, llm: Llm) -> FromTextOut:
    _limit(user)
    results, parser, warnings = ai.create_from_text(
        db, llm, user, body.text, body.request_id, body.source, body.use_llm
    )
    return FromTextOut(
        results=[
            FromTextResult(task=TaskOut.model_validate(t), created=created, reason=reason)  # type: ignore[arg-type]
            for t, created, reason in results
        ],
        parser=parser,
        warnings=warnings,
    )


@router.post("/command", response_model=CommandOut)
def command(body: CommandIn, user: CurrentUser, db: DbSession, llm: Llm) -> CommandOut:
    _limit(user)
    result = ai.run_command(db, llm, user, body.text, body.request_id)
    return CommandOut(
        intent=result["intent"],
        message=result["message"],
        navigate_to=result.get("navigate_to"),
        tasks=[TaskOut.model_validate(t) for t in result.get("tasks", [])],
        candidates=[TaskOut.model_validate(t) for t in result.get("candidates", [])],
    )


@router.get("/prioritize", response_model=PrioritizeOut)
def prioritize_tasks(
    user: CurrentUser,
    db: DbSession,
    llm: Llm,
    limit: Annotated[int, Query(ge=1, le=100)] = 10,
    use_llm: bool = False,
) -> PrioritizeOut:
    # Deterministic ranking is cheap and the UI re-ranks after every edit; only LLM use is limited.
    if use_llm:
        _limit(user)
    else:
        limiter.check(f"prioritize:{user.id}", limit=120, window_seconds=60)
    ranked = prioritise(_open_tasks(db, user), utcnow(), user.timezone, get_settings().neglect_days)[:limit]
    focus_note = None
    if use_llm and ranked:
        focus_note = ai.llm_narrative(
            llm,
            {
                "request": "Suggest how to approach today's top tasks in order, briefly.",
                "tasks": [{"title": s.task.title, "why": s.reasons} for s in ranked[:5]],
            },
        )
    return PrioritizeOut(
        items=[PrioritizedTask(task=TaskOut.model_validate(s.task), score=s.score, reasons=s.reasons) for s in ranked],
        focus_note=focus_note,
        generated_by="llm" if focus_note else "rules",
    )


@router.get("/attention", response_model=AttentionOut)
def attention(user: CurrentUser, db: DbSession) -> AttentionOut:
    from datetime import timedelta

    now = utcnow()
    neglect_days = get_settings().neglect_days
    today = today_local(user.timezone, now)
    tasks = _open_tasks(db, user)
    overdue = sorted([t for t in tasks if t.due_at is not None and t.due_at < now], key=lambda t: t.due_at)  # type: ignore[arg-type,return-value]
    neglected = sorted(
        [
            t
            for t in tasks
            if t not in overdue
            and now - t.updated_at > timedelta(days=neglect_days)
            and not (t.scheduled_for and t.scheduled_for > today)
        ],
        key=lambda t: t.updated_at,
    )
    return AttentionOut(
        overdue=[TaskOut.model_validate(t) for t in overdue[:50]],
        neglected=[TaskOut.model_validate(t) for t in neglected[:50]],
        neglect_days=neglect_days,
    )


@router.get("/summary", response_model=SummaryOut)
def summary(
    user: CurrentUser,
    db: DbSession,
    llm: Llm,
    period: Literal["day", "week", "month"] = "week",
    date_: Annotated[date | None, Query(alias="date")] = None,
    use_llm: bool = True,
) -> SummaryOut:
    _limit(user)
    now = utcnow()
    anchor = date_ or today_local(user.timezone, now)
    result = analytics.period_summary(db, user, period, anchor, now)
    narrative = None
    if use_llm:
        narrative = ai.llm_narrative(
            llm, {"period": period, "stats": result.stats, "completed_examples": result.highlights}
        )
    return SummaryOut(
        period=period,
        start=result.start,
        end=result.end,
        stats=result.stats,
        highlights=result.highlights,
        narrative=narrative or analytics.template_narrative(period, result),
        generated_by="llm" if narrative else "rules",
    )


@router.get("/insights", response_model=InsightsOut)
def insights(user: CurrentUser, db: DbSession, llm: Llm, use_llm: bool = True) -> InsightsOut:
    _limit(user)
    stats = analytics.overview(db, user, 60, utcnow())
    facts = analytics.rule_insights(stats)
    rewritten = ai.llm_rewrite_insights(llm, facts, stats) if use_llm else None
    return InsightsOut(insights=rewritten or facts, generated_by="llm" if rewritten else "rules", based_on_days=60)
