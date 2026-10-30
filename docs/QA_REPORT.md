# LifeOS — QA report

Run date: 2026-10-30 · Environment: Windows 11, Python 3.14.6, Node 24.21, Microsoft Edge (Playwright channel `msedge`).
Database during testing: **SQLite**. PostgreSQL, Docker and GitHub Actions were **not available on the test machine** —
those rows are marked accordingly and are covered by the CI workflow, which has not been executed yet.

## Summary

| Category | Status | Evidence |
|---|---|---|
| Functional requirements | **Pass** | 84 backend tests, 29 frontend tests, 8 E2E tests (below); manual walkthrough in the browser |
| Backend | **Pass** | `pytest`: 84 passed, 93 % line coverage; `ruff`: clean; `mypy`: no issues (32 files) |
| Frontend | **Pass** | `vitest`: 29 passed; `tsc -b` (strict): clean; `oxlint`: 0 errors, 3 style warnings; production build OK |
| End-to-end | **Pass** | Playwright, desktop 1280×800 + Pixel 7: 8/8 passed |
| Database (SQLite) | **Pass** | Alembic `upgrade head` → `check` (models match) → `downgrade base` |
| Database (PostgreSQL) | **Not verified** | Offline DDL generation succeeds (native UUID, `timestamptz`, `BIGSERIAL`, `FOR UPDATE … SKIP LOCKED`); runtime tests on PostgreSQL run only in CI |
| Security | **Pass (scoped)** | Automated security tests (below); `pip-audit`: 0 known vulns; `npm audit --omit=dev`: 0; secret scan of committable files: 0 hits |
| Performance | **Pass (measured, not load-tested)** | Initial JS ≈ 100 KB gzip (React 81 KB + app 17 KB); pages lazy-loaded (1.5–4 KB gzip each); full backend suite 13 s |
| Responsiveness | **Pass** | No horizontal overflow on all 9 pages at 320, 360, 390, 430, 768, 1024, 1280, 1440, 1920 px widths (scripted `scrollWidth` check) |
| Accessibility | **Partial** | Semantic landmarks, labels, skip link, focus management, reduced motion, 44 px controls; no automated axe audit or screen-reader session was run |
| Offline & sync | **Pass** | Unit (7 sync-engine tests), backend (6 sync tests), E2E offline test, manual: API stopped → edits, reload, conflict, resolution |
| Documentation | **Pass** | README, ARCHITECTURE (SRS, schema, sync protocol, security), API reference, `.env.example`, this report |
| Deployment (Docker / CI) | **Not verified** | `Dockerfile`, `docker-compose.yml`, `.github/workflows/ci.yml` written; Docker is not installed on this machine. Production mode (API serving the built SPA) was verified locally without Docker |

## Test inventory

**Backend (`backend/tests`, 84 tests)**
- Auth: register/login/logout, validation, duplicate e-mail, CSRF enforcement, expired and tampered sessions, password change revoking other sessions, login and sign-up rate limits.
- Tasks: CRUD, validation (empty/oversized/naive datetimes/out-of-range), 2 MB body limit, cross-user isolation, idempotent client ids, optimistic concurrency, filters/search (incl. `%`/`_` escaping), pagination, persistence after engine restart, planning views across time zones.
- NLP: 16 parser tests — relative and absolute dates, times, priorities, categories, estimates, reminders, recurrence warning, bullets/splitting, DST gap, words that resemble dates.
- AI: preview never creates; duplicate flagging; idempotent create-from-text; no duplicates across retries/requests; valid vs. invalid LLM output (fallback); voice commands incl. ambiguity; prioritisation and attention; summaries/insights with and without LLM; rate limit.
- LLM client: request shape, timeouts, connection errors, invalid JSON, truncation, circuit breaker.
- Sync: offline create/update, idempotent replay, stale-edit conflict + "keep mine", delete conflicts, tombstones, restore, pagination, reset after retention, rejections, other users' ids, batch limit.
- Reminders: single dispatch, skips done/deleted, re-arming on reschedule, daily digest per user time zone (Tokyo vs New York), retention purge.
- Calendar & account: ICS import + UID de-dup, bad/large/wrong-type files, feed lifecycle (create, public fetch, revoke), JSON/CSV export with formula-injection guard, account deletion cascades.
- Security/misc: security headers, CORS allow/deny, generic 500 without details, auth required on all private endpoints, SPA serving with path-traversal attempts.

**Frontend (`frontend/src/**/*.test.ts[x]`, 29 tests)** — API client (CSRF header, 502/503/504 → offline, validation messages, 401 event); time-zone helpers incl. DST parity with the server; planning buckets, filters, offline focus order; editor validation and zone conversion; QuickAdd (preview, duplicate unticked, double-click guard, offline fallback); sync engine (offline create, persistence across restart, conflicts both ways, in-flight rebase, remote deletes, tombstones, idempotent retry).

**E2E (`frontend/e2e`, 4 scenarios × desktop + mobile)** — register → natural-language capture → duplicate warning → complete → reload persistence; offline capture with `context.setOffline` → sync on reconnect verified via API; planner/goals/insights/history; JSON export download and account deletion.

## Defects found during testing and fixed

| # | Defect | Root cause | Fix | Regression test |
|---|---|---|---|---|
| 1 | “lunch at noon tomorrow” lost its time | `on` matched inside “no**on**” | Word-boundary on connector prefix | `test_relative_and_time_only` |
| 2 | Every AI request waited ~4 s when Ollama was down | Connection attempt per request | Circuit breaker (60 s), status honours it | `test_unreachable_server_trips_breaker` |
| 3 | With the API down, quick-add showed an error instead of saving offline | Proxy returned 500/502 which was treated as a server error | 502/503/504 ⇒ offline; dev proxy returns 502 | `api.test.ts` gateway cases |
| 4 | Horizontal scroll at 320 px on Insights | Visually hidden `<table>` ignores `width:1px` | Hidden wrapper `div` | Scripted viewport check |
| 5 | Week planner squeezed titles to one letter per line on desktop | 7 narrow columns + row actions | 4-column grid, compact rows | Visual check at 1440/1920 |
| 6 | Summary said “0 % … done” for deadlines still ahead and picked “Uncategorised” | Wording/aggregation | Counts with “still ahead”; ignore empty category | `test_summary_wording_counts_future_deadlines_as_ahead` |
| 7 | Developer `.env` leaked into the test run | Settings always read `.env` | `LIFEOS_ENV_FILE=""` in tests | `test_registration_is_rate_limited_per_ip` |
| 8 | Focus ring around the whole page after navigation | Unlayered `:focus-visible` beat utility class | Exclude `tabindex=-1` containers | Visual check |
| 9 | `HEAD /` returned 405 in production mode | SPA route was GET-only | Accept HEAD | `test_serves_spa_without_path_traversal` |
| 10 | Prioritisation could hit the AI rate limit while editing | Deterministic endpoint shared the LLM limit | Separate, higher limit unless `use_llm` | — |

## Security checks performed

Argon2id hashing; constant-time login with dummy hash (no user enumeration via login); session tokens and CSRF/feed tokens stored as SHA-256 hashes; CSRF required on unsafe methods; `HttpOnly`/`SameSite=Lax` cookies (`Secure` via config); server-side ownership on every query (tested cross-user); parameterised SQL and escaped `LIKE`; Pydantic length/range limits; 2 MB request cap and 1 MB upload cap with type checks; CSP (`script-src 'self'`, no inline scripts — verified 0 console violations in production mode), `X-Frame-Options`, `nosniff`, `Referrer-Policy`, HSTS in production; restrictive CORS (tested); generic 500 errors; logs contain ids/counts only and redact calendar tokens; CSV formula-injection escaping; LLM output validated and never executed; path traversal on static files (tested); retention purges; dependency audits.

Not performed: penetration test, DAST scanner, axe/Lighthouse audits, load testing.

## Known issues / residual risk

- `npm audit` (including dev dependencies) reports 4 **low** findings in `deepmerge` via `vite-plugin-pwa → workbox-build`; build-time only, not shipped to browsers.
- `oxlint` reports 3 `set-state-in-effect` style warnings (form reset on dialog open); behaviour is correct.
- Frontend unit coverage is 31 % of lines (pages are exercised by the E2E suite rather than unit tests).
- Real LLM quality was not evaluated: Ollama was not running; the LLM path is tested with a scripted fake and mocked HTTP.
- Voice input was not exercised with a real microphone (Web Speech API is not automatable here); its command handling is covered by API tests.
- See README “Known limitations” for product-level limitations.
