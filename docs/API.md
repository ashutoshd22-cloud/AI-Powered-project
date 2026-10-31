# LifeOS API reference

Base path: `/api/v1`. All bodies are JSON unless noted. Interactive OpenAPI docs are served at
`/api/docs` when `ENABLE_DOCS=true`.

## Conventions

* **Authentication** — `POST /auth/login` or `/auth/register` sets two cookies:
  `lifeos_session` (`HttpOnly`, `SameSite=Lax`) and `lifeos_csrf` (readable by the page).
* **CSRF** — every `POST/PATCH/DELETE` made with a session must send the CSRF cookie value in the
  `X-CSRF-Token` header; otherwise `403`.
* **Times** — instants are ISO‑8601 with an offset and stored in UTC; naive datetimes are rejected
  (`422`). Local dates (`scheduled_for`, `target_date`) are `YYYY-MM-DD` in the user's time zone.
* **Errors** — `{"detail": "..."}`; validation errors add `errors: [{loc, msg, type}]`. Unexpected
  errors return a generic `500` message (details only in server logs).
* **Rate limits** — `429` with `Retry-After`. Login: 30/5 min per IP and 10/5 min per e‑mail;
  sign‑up: `REGISTER_LIMIT_PER_HOUR` per IP; LLM features: 30/min per user; sync: 120/min.

## Health
| Method | Path | Description |
|---|---|---|
| GET | `/api/health` | `200 {"status":"ok"}` when the database answers, else `503` |

## Auth & profile
| Method | Path | Body / query | Notes |
|---|---|---|---|
| POST | `/auth/register` | `email, password (10–128), display_name, timezone` | `201` + session; `409` duplicate e-mail |
| POST | `/auth/login` | `email, password` | `401` generic message for wrong e-mail *or* password |
| POST | `/auth/logout` | – | `204`, deletes the session |
| GET | `/auth/me` | – | current user |
| PATCH | `/auth/me` | `display_name, timezone, theme, default_reminder_minutes, daily_digest_enabled, daily_digest_hour` | partial |
| POST | `/auth/change-password` | `current_password, new_password` | signs out all *other* sessions |

## Tasks
| Method | Path | Notes |
|---|---|---|
| GET | `/tasks` | Query: `q, status, priority, category, goal_id, include_done, overdue, due_from, due_to, sort (due, -due, priority, created, -created, updated, -updated), page, page_size (≤200)` |
| GET | `/tasks/categories` | Distinct categories |
| POST | `/tasks` | `title` required; optional `id` (client UUID → idempotent: replay returns `200` with the existing task), `description, priority, category, status, due_at, due_has_time, scheduled_for, remind_at, estimated_minutes, goal_id, recurrence, source`. Omitting `remind_at` on a timed due date applies the user's default reminder; `remind_at: null` disables it |
| GET | `/tasks/{id}` | `404` for other users' tasks |
| PATCH | `/tasks/{id}` | Partial update; optional `version` → `409` with `detail.current` when stale. Setting `status: done` on a task with `recurrence` creates the next occurrence (same `series_id`) |
| DELETE | `/tasks/{id}` | Soft delete (tombstone, synced to other devices) |
| POST | `/tasks/{id}/restore` | Undo a delete |
| GET | `/planning?view=day\|week\|month&date=YYYY-MM-DD` | Tasks grouped by local day (due date, else planned date) + overdue when the range includes today |

## Goals
| Method | Path | Notes |
|---|---|---|
| GET | `/goals?include_archived=` | Each goal includes `progress (0–1), tasks_total, tasks_done` |
| POST | `/goals` | `title, description, target_date, target_value, current_value, unit` |
| GET/PATCH/DELETE | `/goals/{id}` | Reaching `target_value` marks the goal completed. Delete unlinks tasks (they get a new `version`) |

## AI (local LLM with deterministic fallback)
| Method | Path | Notes |
|---|---|---|
| GET | `/ai/status` | `{enabled, available, model, model_installed}` |
| POST | `/ai/parse` | `{text, use_llm}` → preview only; never creates tasks. Each item has `duplicate_of` when an open task has the same normalised title. `parser` is `llm` or `rules` |
| POST | `/ai/tasks/from-text` | `{text, request_id, source}` → creates tasks idempotently (ids derived from `request_id`); duplicates of open tasks are returned with `reason: "duplicate"` instead of being created |
| POST | `/ai/command` | `{text, request_id}` → intents: `create_task, complete_task, navigate, summary, unknown`; ambiguous completions return `candidates` |
| GET | `/ai/prioritize?limit=&use_llm=` | Ranked open tasks with `score` and human-readable `reasons`; optional LLM `focus_note` |
| GET | `/ai/attention` | `overdue` and `neglected` (untouched > `NEGLECT_DAYS`) |
| GET | `/ai/summary?period=day\|week\|month&date=&use_llm=` | Stats, highlights and narrative (`generated_by: llm\|rules`) |
| GET | `/ai/insights?use_llm=` | Personalised insights from the last 60 days |

## Notifications, history, analytics
| Method | Path | Notes |
|---|---|---|
| GET | `/notifications?unread_only=&limit=` | Reminders and daily digests |
| GET | `/notifications/unread-count` | |
| POST | `/notifications/{id}/read`, `/notifications/read-all` | |
| GET | `/activity?q=&entity_type=&action=&page=&page_size=` | Searchable activity history |
| DELETE | `/activity` | Clear history |
| GET | `/analytics/overview?days=7..365` | Daily series, totals, on-time rate, streak, categories, weekday/hour patterns, goals |

## Calendar
| Method | Path | Notes |
|---|---|---|
| POST | `/calendar/token` | Creates/rotates the private feed URL (token shown once, stored hashed) |
| DELETE | `/calendar/token` | Revokes the feed |
| GET | `/calendar/feed/{token}.ics` | Public iCalendar feed of tasks with due dates (no cookie needed) |
| POST | `/calendar/import` | `multipart/form-data` field `file` (`.ics`, ≤ `MAX_IMPORT_BYTES`). Items are de-duplicated by `UID` |

## Web Push
| Method | Path | Notes |
|---|---|---|
| GET | `/push/config` | `{enabled, public_key, subscriptions}` |
| POST | `/push/subscriptions` | `{endpoint, keys: {p256dh, auth}}` from `PushSubscription.toJSON()`; endpoint must be on an allowed push service |
| DELETE | `/push/subscriptions` | `{endpoint}` |
| POST | `/push/test` | Sends a test notification to this user's devices |

## Google Calendar
| Method | Path | Notes |
|---|---|---|
| GET | `/integrations/google` | `{configured, connected, status, last_synced_at, last_error}` |
| POST | `/integrations/google/connect` | Returns the Google sign-in `url` (PKCE + one-time state) |
| GET | `/integrations/google/callback` | Google redirects here; then redirects to `/settings?google=connected\|error\|cancelled` |
| POST | `/integrations/google/sync` | Sync now → `{pulled, pushed}` |
| DELETE | `/integrations/google` | Revoke access and stop syncing |

## Account & data
| Method | Path | Notes |
|---|---|---|
| GET | `/account/export?format=json\|csv` | Download of all data (JSON) or tasks (CSV, formula-injection safe) |
| DELETE | `/account` | `{password, confirm: "DELETE"}` → permanently deletes the user and all their rows |

## Offline sync
| Method | Path | Notes |
|---|---|---|
| POST | `/sync/push` | `{ops: [{op_id, kind: upsert\|delete, task_id, base_version, data}]}` (≤200). Results per op: `applied`, `duplicate` (already processed), `conflict` (stale `base_version`; server copy returned, nothing changed) or `rejected` |
| GET | `/sync/pull?since=&after=` | Changed tasks including tombstones, paginated (`has_more`, `next`). Store `cursor` for the next pull; `reset_required` means do a full pull |

See [ARCHITECTURE.md §4](ARCHITECTURE.md#4-sync-protocol-tasks) for the protocol design.
