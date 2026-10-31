"""Pydantic request/response models."""

import uuid
from datetime import date, datetime
from typing import Annotated, Literal
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError, available_timezones

from pydantic import (
    AfterValidator,
    AwareDatetime,
    BaseModel,
    ConfigDict,
    EmailStr,
    Field,
    StringConstraints,
    field_validator,
)

from app.models import GoalStatus, Priority, TaskSource, TaskStatus

_VALID_TIMEZONES = available_timezones()


def _check_timezone(value: str) -> str:
    if value not in _VALID_TIMEZONES:
        raise ValueError("Unknown time zone; use an IANA name such as 'Europe/London'")
    try:
        ZoneInfo(value)
    except ZoneInfoNotFoundError as exc:  # pragma: no cover - guarded by the set above
        raise ValueError("Unknown time zone") from exc
    return value


def _check_reasonable_datetime(value: datetime | None) -> datetime | None:
    if value is not None and not (1970 <= value.year <= 2200):
        raise ValueError("Date is out of the supported range (1970-2200)")
    return value


def _check_recurrence(value: str | None) -> str | None:
    if value is None or not value.strip():
        return None
    from app.services.recurrence import RecurrenceError, normalise

    try:
        return normalise(value)
    except RecurrenceError as exc:
        raise ValueError(str(exc)) from exc


def _check_reasonable_date(value: date | None) -> date | None:
    if value is not None and not (1970 <= value.year <= 2200):
        raise ValueError("Date is out of the supported range (1970-2200)")
    return value


TimeZoneName = Annotated[str, AfterValidator(_check_timezone)]
Title = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]
Description = Annotated[str, StringConstraints(max_length=5000)]
OptDateTime = Annotated[AwareDatetime | None, AfterValidator(_check_reasonable_datetime)]
OptDate = Annotated[date | None, AfterValidator(_check_reasonable_date)]
Recurrence = Annotated[str | None, StringConstraints(max_length=200), AfterValidator(_check_recurrence)]
Password = Annotated[str, StringConstraints(min_length=10, max_length=128)]


class ORMModel(BaseModel):
    model_config = ConfigDict(from_attributes=True)


# --------------------------------------------------------------------------- auth / user
class RegisterIn(BaseModel):
    email: EmailStr
    password: Password
    display_name: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=80)]
    timezone: TimeZoneName = "UTC"

    @field_validator("email")
    @classmethod
    def _lower(cls, v: str) -> str:
        return v.lower()


class LoginIn(BaseModel):
    email: EmailStr
    password: Annotated[str, StringConstraints(min_length=1, max_length=128)]

    @field_validator("email")
    @classmethod
    def _lower(cls, v: str) -> str:
        return v.lower()


class UserOut(ORMModel):
    id: uuid.UUID
    email: str
    display_name: str
    timezone: str
    theme: str
    default_reminder_minutes: int
    daily_digest_enabled: bool
    daily_digest_hour: int
    has_calendar_feed: bool = False
    created_at: datetime


class UserUpdate(BaseModel):
    display_name: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=80)] | None = None
    timezone: TimeZoneName | None = None
    theme: Literal["system", "light", "dark"] | None = None
    default_reminder_minutes: Annotated[int, Field(ge=0, le=10080)] | None = None
    daily_digest_enabled: bool | None = None
    daily_digest_hour: Annotated[int, Field(ge=0, le=23)] | None = None


class ChangePasswordIn(BaseModel):
    current_password: Annotated[str, StringConstraints(min_length=1, max_length=128)]
    new_password: Password


class DeleteAccountIn(BaseModel):
    password: Annotated[str, StringConstraints(min_length=1, max_length=128)]
    confirm: Literal["DELETE"]


class SessionInfo(BaseModel):
    user: UserOut
    csrf_token: str


# --------------------------------------------------------------------------- tasks
class TaskFields(BaseModel):
    """Fields shared by create and update; all optional so they can be used as a patch."""

    description: Description | None = None
    priority: Priority | None = None
    category: Annotated[str, StringConstraints(strip_whitespace=True, max_length=50)] | None = None
    status: TaskStatus | None = None
    due_at: OptDateTime = None
    due_has_time: bool | None = None
    scheduled_for: OptDate = None
    remind_at: OptDateTime = None
    estimated_minutes: Annotated[int, Field(ge=1, le=1440)] | None = None
    goal_id: uuid.UUID | None = None
    recurrence: Recurrence = Field(default=None, description="Repeat rule, e.g. FREQ=WEEKLY;BYDAY=MO")


class TaskCreate(TaskFields):
    id: uuid.UUID | None = Field(
        default=None, description="Optional client-generated id; makes the request idempotent."
    )
    title: Title
    source: TaskSource = TaskSource.manual


class TaskUpdate(TaskFields):
    title: Title | None = None
    version: int | None = Field(default=None, description="If set, the update fails with 409 when stale.")


class TaskOut(ORMModel):
    id: uuid.UUID
    title: str
    description: str
    priority: Priority
    category: str | None
    status: TaskStatus
    due_at: datetime | None
    due_has_time: bool
    scheduled_for: date | None
    remind_at: datetime | None
    reminder_sent_at: datetime | None
    completed_at: datetime | None
    estimated_minutes: int | None
    goal_id: uuid.UUID | None
    recurrence: str | None = None
    series_id: uuid.UUID | None = None
    source: str
    version: int
    deleted_at: datetime | None
    created_at: datetime
    updated_at: datetime


class TaskPage(BaseModel):
    items: list[TaskOut]
    total: int
    page: int
    page_size: int


# --------------------------------------------------------------------------- goals
class GoalCreate(BaseModel):
    title: Title
    description: Description = ""
    target_date: OptDate = None
    target_value: Annotated[float, Field(gt=0, le=1e9)] | None = None
    current_value: Annotated[float, Field(ge=0, le=1e9)] = 0
    unit: Annotated[str, StringConstraints(strip_whitespace=True, max_length=30)] = ""


class GoalUpdate(BaseModel):
    title: Title | None = None
    description: Description | None = None
    target_date: OptDate = None
    target_value: Annotated[float, Field(gt=0, le=1e9)] | None = None
    current_value: Annotated[float, Field(ge=0, le=1e9)] | None = None
    unit: Annotated[str, StringConstraints(strip_whitespace=True, max_length=30)] | None = None
    status: GoalStatus | None = None


class GoalOut(ORMModel):
    id: uuid.UUID
    title: str
    description: str
    target_date: date | None
    target_value: float | None
    current_value: float
    unit: str
    status: GoalStatus
    created_at: datetime
    updated_at: datetime
    progress: float = 0.0
    tasks_total: int = 0
    tasks_done: int = 0


# --------------------------------------------------------------------------- notifications / activity
class NotificationOut(ORMModel):
    id: uuid.UUID
    task_id: uuid.UUID | None
    kind: str
    title: str
    body: str
    read_at: datetime | None
    created_at: datetime


class ActivityOut(ORMModel):
    id: int
    action: str
    entity_type: str
    entity_id: str | None
    summary: str
    created_at: datetime


class ActivityPage(BaseModel):
    items: list[ActivityOut]
    total: int
    page: int
    page_size: int


# --------------------------------------------------------------------------- AI
class ParseIn(BaseModel):
    text: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=2000)]
    use_llm: bool = True


class ParsedTask(BaseModel):
    title: Title
    priority: Priority = Priority.medium
    category: Annotated[str, StringConstraints(max_length=50)] | None = None
    due_at: datetime | None = None
    due_has_time: bool = False
    scheduled_for: date | None = None
    remind_at: datetime | None = None
    recurrence: str | None = None
    duplicate_of: TaskOut | None = None


class ParseOut(BaseModel):
    tasks: list[ParsedTask]
    parser: Literal["llm", "rules"]
    warnings: list[str] = []


class FromTextIn(ParseIn):
    request_id: uuid.UUID = Field(description="Idempotency key; retries return the same tasks.")
    source: Literal["natural_language", "voice"] = "natural_language"


class FromTextResult(BaseModel):
    task: TaskOut
    created: bool
    reason: Literal["created", "duplicate", "replayed"]


class FromTextOut(BaseModel):
    results: list[FromTextResult]
    parser: Literal["llm", "rules"]
    warnings: list[str] = []


class CommandIn(BaseModel):
    text: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=500)]
    request_id: uuid.UUID


class CommandOut(BaseModel):
    intent: Literal["create_task", "complete_task", "navigate", "summary", "unknown"]
    message: str
    navigate_to: str | None = None
    tasks: list[TaskOut] = []
    candidates: list[TaskOut] = []


class PrioritizedTask(BaseModel):
    task: TaskOut
    score: float
    reasons: list[str]


class PrioritizeOut(BaseModel):
    items: list[PrioritizedTask]
    focus_note: str | None = None
    generated_by: Literal["llm", "rules"]


class AttentionOut(BaseModel):
    overdue: list[TaskOut]
    neglected: list[TaskOut]
    neglect_days: int


class SummaryOut(BaseModel):
    period: Literal["day", "week", "month"]
    start: date
    end: date
    stats: dict[str, float | int | str | None]
    highlights: list[str]
    narrative: str
    generated_by: Literal["llm", "rules"]


class InsightsOut(BaseModel):
    insights: list[str]
    generated_by: Literal["llm", "rules"]
    based_on_days: int


class AIStatusOut(BaseModel):
    enabled: bool
    available: bool
    model: str
    model_installed: bool


# --------------------------------------------------------------------------- sync
class SyncTaskData(TaskFields):
    title: Title | None = None
    deleted: bool | None = None


class SyncOpIn(BaseModel):
    op_id: uuid.UUID
    kind: Literal["upsert", "delete"]
    task_id: uuid.UUID
    base_version: int | None = None
    data: SyncTaskData = SyncTaskData()


class SyncPushIn(BaseModel):
    ops: Annotated[list[SyncOpIn], Field(max_length=200)]


class SyncOpResult(BaseModel):
    op_id: uuid.UUID
    status: Literal["applied", "conflict", "duplicate", "rejected"]
    task: TaskOut | None = None
    error: str | None = None


class SyncPushOut(BaseModel):
    results: list[SyncOpResult]


class SyncPullOut(BaseModel):
    tasks: list[TaskOut]
    has_more: bool
    next: str | None
    cursor: str
    reset_required: bool = False
