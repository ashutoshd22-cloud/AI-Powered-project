# LifeOS — Personal AI Operating System

LifeOS is a privacy-first productivity platform that brings tasks, daily/weekly/monthly planning,
goals, reminders and AI assistance into one place. The AI runs on **your own machine** through
[Ollama](https://ollama.com); when no model is available, every AI feature falls back to
deterministic rules, so the app always works. Tasks keep working **offline** and synchronise
without silently losing changes.

| Today (light) | Today (dark) |
|---|---|
| ![Today, light theme](docs/screenshots/today-light.png) | ![Today, dark theme](docs/screenshots/today-dark.png) |

| Weekly planner | Insights | Mobile |
|---|---|---|
| ![Planner week view](docs/screenshots/planner-week.png) | ![Insights](docs/screenshots/insights.png) | ![Mobile Today](docs/screenshots/mobile-today.png) |

## Problem statement

Personal work is scattered across to-do apps, calendars, notes and reminders. Most "smart"
assistants send private data to cloud AI services and stop working without a connection. LifeOS
offers one place for capturing and planning work, understands plain language, highlights what
needs attention, and keeps data under the user's control — including offline use, export and
deletion.

## Features

**Core**
- Registration and secure sign-in (Argon2id, `HttpOnly` session cookies, CSRF protection, rate limits)
- Tasks with priority, category, status, due date/time, planned day, estimate, reminders and goal links
- Day / week / month planner (works offline)
- Natural-language capture — “Call Mom tomorrow 6pm #family !high” — shown as a **preview** to confirm
- AI productivity summaries (day/week/month) and personalised insights
- Smart reminders: per-task reminders, a default lead time, and a daily digest at your local hour
- Calendar integration: private, revocable iCalendar subscription link + `.ics` import (UID de-duplication)
- Goals with metric progress or linked-task progress; progress analytics and charts
- Searchable activity history with pagination
- Light, dark and system themes

**Advanced**
- Local LLM via Ollama (configurable model), with circuit-breaker and rule-based fallback
- Voice commands (“add call Alex tomorrow at 5pm”, “complete call Alex”, “show goals”) and dictation
- Explainable AI prioritisation (“Overdue by 2 days · High priority · Moves a goal forward”)
- Overdue and neglected task detection
- Offline-first tasks: IndexedDB store + outbox, versioned sync, user-resolved conflicts, installable PWA

**Acceptance criteria → how they are met**

| Criterion | Implementation | Evidence |
|---|---|---|
| Tasks persist after restart | PostgreSQL/SQLite storage; IndexedDB on the client | `test_tasks_persist_after_restart`; E2E reload test |
| AI never creates duplicates unintentionally | Parse = preview only; idempotent `request_id`; open-task title de-duplication; duplicates unticked in the UI; ICS UID de-dup | `test_from_text_is_idempotent_and_never_duplicates`, `QuickAdd.test.tsx`, E2E |
| Reminders respect time zones | IANA zone per user; UTC storage; DST-aware conversion on server and client | `test_daily_digest_respects_each_users_time_zone`, DST tests (Python + TS) |
| Offline changes sync without silent loss | Versioned ops, idempotent `op_id`, conflicts returned not applied, user chooses | `test_sync.py`, `syncEngine.test.ts`, E2E offline test |
| Users can export and delete data | JSON/CSV export; password-confirmed hard delete with cascades | `test_calendar_account.py`, E2E |

## Technology stack

| Layer | Choice |
|---|---|
| Frontend | React 19, TypeScript 7 (strict), Vite 8, Tailwind CSS 4, TanStack Query 5, React Router 8, `idb`, `vite-plugin-pwa` |
| Backend | Python 3.12–3.14, FastAPI 0.162, Pydantic 2, SQLAlchemy 2.1, Alembic |
| Database | PostgreSQL 17 (production), SQLite (local development / tests) |
| AI | Ollama (default model `llama3.2`), deterministic NLP + scoring fallbacks |
| Background jobs | Standalone worker process (`python -m app.worker`) or in-process thread for dev |
| Testing | Pytest, Vitest + Testing Library, Playwright |
| Delivery | Docker (multi-stage), Docker Compose, GitHub Actions |

Exact versions are pinned in [`backend/requirements.txt`](backend/requirements.txt) and
[`frontend/package.json`](frontend/package.json).

## Architecture

```mermaid
flowchart LR
  subgraph Browser
    UI[React UI] --> Store[(IndexedDB tasks + outbox)]
    Store <-->|push / pull| Sync[Sync engine]
    SW[Service worker] -.app shell.-> UI
  end
  Sync --> API[FastAPI]
  UI --> API
  API --> DB[(PostgreSQL)]
  API --> LLM[Ollama]
  Worker[Worker: reminders, digests, retention] --> DB
  Calendar[Calendar apps] -->|.ics feed| API
```

Details — requirements, schema, sync protocol, security design: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
Endpoints: [docs/API.md](docs/API.md). Test evidence: [docs/QA_REPORT.md](docs/QA_REPORT.md).

```
backend/          FastAPI app (app/), Alembic migrations, tests
  app/api/        routers: auth, tasks+planning, goals, ai, calendar, account, sync, misc
  app/services/   domain logic: nlp, llm, ai, prioritization, analytics, reminders, sync, calendar_ics
frontend/         React app (src/), unit tests (*.test.ts[x]), Playwright E2E (e2e/)
  src/offline/    IndexedDB store and sync engine
docs/             architecture, API, QA report, screenshots
```

## Installation (local development)

Prerequisites: Python 3.12+, Node.js 22+ (24 recommended), optionally Ollama.

```bash
# 1. Backend
cd backend
python -m venv .venv
# Windows: .venv\Scripts\activate    macOS/Linux: source .venv/bin/activate
pip install -r requirements-dev.txt
cp ../.env.example .env              # then edit: set DATABASE_URL=sqlite:///./lifeos.db, RUN_WORKER_IN_API=true
alembic upgrade head
uvicorn app.main:app --reload --port 8000
```

```bash
# 2. Frontend (new terminal)
cd frontend
npm ci
npm run dev                          # http://localhost:5173 (proxies /api to :8000)
```

```bash
# 3. Optional: local AI
ollama pull llama3.2                 # then keep `ollama serve` running
```

## Configuration

All settings are environment variables — see [`.env.example`](.env.example) for the full,
commented list. The most important:

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | `sqlite:///./lifeos.db` | `postgresql+psycopg://user:pass@host/db` in production |
| `COOKIE_SECURE` | `false` | **Set `true` behind HTTPS** |
| `PUBLIC_BASE_URL` | `http://localhost:8000` | Used to build calendar subscription links |
| `LLM_ENABLED`, `OLLAMA_URL`, `OLLAMA_MODEL` | `true`, `http://localhost:11434`, `llama3.2` | Local AI |
| `RUN_WORKER_IN_API` | `false` | `true` runs reminders inside the API (single process) |
| `TRUST_PROXY_HEADERS` | `false` | Use `X-Forwarded-For` for rate limiting behind a proxy |
| `*_RETENTION_DAYS` | 365 / 90 / 90 | Activity, read notifications, deleted-task tombstones |

## Usage tips

- Quick add understands: `today`, `tonight`, `tomorrow`, weekdays (`friday`, `next monday`), `next week`,
  `in 3 days`, `in 30 minutes`, dates (`2026-11-05`, `Nov 3`, `3rd December`), times (`5pm`, `17:30`, `noon`),
  priorities (`urgent`, `!high`, `!!`, `!low`), categories (`#work`), estimates (`for 30 min`),
  reminders (`remind me to …`) and several tasks separated by new lines or `;`.
- Calendar: **Settings → Calendar → Create subscription link**, then “Subscribe/From URL” in your calendar app.
- Offline: keep using LifeOS; the sync indicator shows pending changes. If the same task changed elsewhere,
  a banner lets you compare and choose which version to keep.

## Testing

```bash
cd backend && pytest --cov                         # 84 tests (SQLite)
TEST_DATABASE_URL=postgresql+psycopg://… pytest    # same suite on PostgreSQL (CI does this)
ruff check app tests && mypy app

cd frontend
npm run typecheck && npm run lint && npm test      # 29 unit/component tests
# E2E: start the API (port 8000) first, with REGISTER_LIMIT_PER_HOUR raised for repeated sign-ups
npx playwright install chromium && npm run test:e2e
PW_CHANNEL=msedge npm run test:e2e                 # or use an installed Edge/Chrome
```

## Deployment

```bash
cp .env.example .env          # set POSTGRES_PASSWORD, PUBLIC_BASE_URL, COOKIE_SECURE=true (HTTPS)
docker compose up -d --build  # PostgreSQL + app (API + web) + worker on :8000
docker compose --profile ai up -d && docker compose exec ollama ollama pull llama3.2   # optional local AI
```

The image runs `alembic upgrade head` on start, serves the SPA and API from one origin, runs as a
non-root user and exposes `/api/health` for health checks. Put it behind a TLS-terminating reverse
proxy (Caddy, nginx, a cloud load balancer) and set `TRUST_PROXY_HEADERS=true`. Any Linux host or
container service (e.g. AWS ECS/Fargate with RDS PostgreSQL) works; run the `worker` service
alongside the app.

## Privacy

- Data is stored only in your database and the browser's IndexedDB; there is no telemetry.
- AI prompts go only to the Ollama server you configure. Task text in prompts is treated as data and
  model output is validated — it can never trigger actions by itself.
- Voice input uses the browser's speech recogniser. LifeOS never receives audio, but some browsers
  (notably Chrome) send audio to their vendor's speech service; Safari/Edge behaviour varies by OS.
- Export everything from **Settings → Your data**; deleting the account removes all server rows and
  this device's local copy.

## Known limitations

- Recurring tasks are not supported yet (the parser warns when it sees “every …”).
- Calendar integration is a one-way subscription feed plus `.ics` import (no two-way Google/Microsoft sync).
- Reminders appear in-app and as browser notifications while LifeOS is open; there is no Web Push yet.
- Offline editing covers tasks; goals, insights and history need a connection (read-only offline messaging is shown).
- Rate limiting is in-memory, so it is per-instance; use a shared store (e.g. Redis) when scaling out.
- Changing your time zone does not move existing date-only deadlines (they keep their original instant).
- The rule-based parser understands English only.
- `POST /auth/register` reveals whether an e-mail is registered (`409`), a usability trade-off.

## Future improvements

Recurring tasks · Web Push notifications · two-way calendar sync (OAuth) · offline editing for goals ·
shared Redis rate limiting · multilingual parsing · task attachments · collaborative lists.

## License

No license has been chosen yet. Add a `LICENSE` file (e.g. MIT or Apache-2.0) before publishing.
