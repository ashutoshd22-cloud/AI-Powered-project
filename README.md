# LifeOS — Personal AI Operating System

LifeOS is a privacy-first productivity platform that brings tasks, daily/weekly/monthly planning,
goals, reminders and AI assistance into one place. The AI runs on **your own machine** through
[Ollama](https://ollama.com); when no model is available, every AI feature falls back to
deterministic rules, so the app always works. Tasks keep working **offline** and synchronise
without silently losing changes.

| Today (light) | Today (dark) |
|---|---|
| ![Today, light theme](docs/screenshots/today-light.png) | ![Today, dark theme](docs/screenshots/today-dark.png) |

| Aurora scene | Weekly planner | Insights | Mobile |
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
- Light, dark and system themes, plus **ambient light** whose colour follows your tasks (cyan when calm, amber when
  something urgent is due, rose when overdue, green when all clear) or one of four original **background scenes**
- **Recurring tasks** — “every Monday 9am”, “every 2 weeks”, weekdays, monthly, yearly or custom; completing one
  schedules the next without ever creating duplicates

**Advanced**
- Local LLM via Ollama (any model; tested with `qwen3:4b-instruct`). The model splits free-form notes into
  separate tasks using only verbatim pieces of the note; dates and priorities are always resolved by the
  deterministic parser, and AI summaries are rejected if they contain numbers not in your data
  ([evaluation](docs/QA_REPORT.md#local-llm-evaluation)). Circuit breaker + rule-based fallback when offline
- Voice commands (“add call Alex tomorrow at 5pm”, “complete call Alex”, “show goals”) and dictation
- Explainable AI prioritisation (“Overdue by 2 days · High priority · Moves a goal forward”)
- Overdue and neglected task detection
- Offline-first tasks: IndexedDB store + outbox, versioned sync, user-resolved conflicts, installable PWA
- **Notifications while the app is closed** (Web Push via the service worker)
- **Two-way Google Calendar sync** with a dedicated “LifeOS” calendar (it never sees your other calendars)

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
ollama pull llama3.2                 # or any model; set OLLAMA_MODEL (e.g. qwen3:4b-instruct)
```

After pulling new versions of LifeOS, run `alembic upgrade head` in `backend/` again — the API logs an error at
startup if the database is behind the code.

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

## Optional integrations

### Notifications while LifeOS is closed (Web Push)
1. `cd backend` then `python -m app.cli vapid` and copy the printed `VAPID_PRIVATE_KEY=…` / `VAPID_SUBJECT=…` into `.env`.
2. Restart the API. In the app: **Settings → Browser notifications → Turn on for this device**.

Push only works from the production build (the service worker isn't active in `npm run dev`) and on HTTPS or `localhost`.
The server only sends to known push services (Google, Mozilla, Microsoft, Apple) — see `PUSH_ALLOWED_HOSTS`.

### Google Calendar (two-way)
1. In [Google Cloud Console](https://console.cloud.google.com/): create a project → **APIs & Services → Library** → enable
   **Google Calendar API**.
2. **OAuth consent screen**: External, add your e-mail as a test user, add the scope
   `https://www.googleapis.com/auth/calendar.app.created`.
3. **Credentials → Create credentials → OAuth client ID → Web application**. Authorised redirect URI:
   `<PUBLIC_BASE_URL>/api/v1/integrations/google/callback` (locally: `http://localhost:5173/api/v1/integrations/google/callback`
   with `PUBLIC_BASE_URL=http://localhost:5173`).
4. Put `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and `TOKEN_ENCRYPTION_KEY` (from `python -m app.cli fernet`) in `.env`,
   restart, then **Settings → Google Calendar → Connect**.

LifeOS creates a calendar named **LifeOS**. Tasks with due dates appear there; moving, renaming, deleting or adding events
in that calendar updates LifeOS on the next sync (every 5 minutes, or **Sync now**). If both sides changed the same
task, the most recent edit wins.

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
cd backend && pytest --cov                         # 87 tests (SQLite)
TEST_DATABASE_URL=postgresql+psycopg://… pytest    # same suite on PostgreSQL (CI does this)
ruff check app tests && mypy app

cd frontend
npm run typecheck && npm run lint && npm test      # 31 unit/component tests
# E2E: start the API (port 8000) first, with REGISTER_LIMIT_PER_HOUR raised for repeated sign-ups
npx playwright install chromium && npm run test:e2e
PW_CHANNEL=msedge npm run test:e2e                 # or use an installed Edge/Chrome
```

## Deployment

### Quickest: the published image
```bash
docker run -p 8000:8000 -e DATABASE_URL=sqlite:////data/lifeos.db -v lifeos:/data ghcr.io/ashutoshd22-cloud/lifeos:latest
```
Open http://localhost:8000. Versions are listed under [Releases](https://github.com/ashutoshd22-cloud/AI-Powered-project/releases);
see [CHANGELOG.md](CHANGELOG.md). Maintainers publish a new version by pushing a tag (`git tag v1.2.0 && git push origin v1.2.0`).

### Full stack with Docker Compose

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

- Deleting one occurrence of a repeating task deletes only that occurrence; to stop a series, set Repeat to
  “Doesn't repeat”. Completing a repeating task offline schedules the next one when the device syncs.
- Two-way calendar sync is Google-only (Microsoft/Apple calendars get the one-way subscription feed and `.ics` import).
  Google sync was tested against a simulated Google API; it needs your own OAuth credentials to run for real.
- Background (push) notifications need the production build and HTTPS (or localhost); iPhone/iPad support requires
  adding LifeOS to the Home Screen.
- Offline editing covers tasks; goals, insights and history need a connection (read-only offline messaging is shown).
- Rate limiting is in-memory, so it is per-instance; use a shared store (e.g. Redis) when scaling out.
- Changing your time zone does not move existing date-only deadlines (they keep their original instant).
- The rule-based parser understands English only.
- `POST /auth/register` reveals whether an e-mail is registered (`409`), a usability trade-off.

## Future improvements

Microsoft/Outlook two-way sync · offline editing for goals ·
shared Redis rate limiting · multilingual parsing · task attachments · collaborative lists.

## License

Released under the [MIT License](LICENSE).
