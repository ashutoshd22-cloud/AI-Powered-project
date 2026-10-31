# LifeOS — QA report

Local runs: 2026-10-30/31 · Windows 11, Python 3.14.6, Node 24.21, Microsoft Edge (Playwright channel `msedge`), SQLite,
Ollama 0.40.11 with `qwen3:4b-instruct`.
CI: GitHub Actions run #1 on commit `f3e86bd` (Ubuntu, Python 3.13, Node 24, PostgreSQL 17) — **all 4 jobs passed**
(backend 1m32s, frontend 29s, e2e 1m38s, docker 36s). PostgreSQL, Docker and Linux results below come from that run.

## Summary

| Category | Status | Evidence |
|---|---|---|
| Functional requirements | **Pass** | 133 backend tests, 39 frontend tests, 8 E2E tests (below); manual walkthrough in the browser |
| Backend | **Pass** | `pytest`: 134 passed, 92 % line coverage; `ruff`: clean; `mypy`: no issues (32 files) |
| Frontend | **Pass** | `vitest`: 39 passed; `tsc -b` (strict): clean; `oxlint`: 0 errors, 3 style warnings; production build OK |
| End-to-end | **Pass** | Playwright, desktop 1280×800 + Pixel 7: 12/12 passed locally (Edge, with the real local model enabled) and in CI (Chromium on Linux) |
| Database (SQLite) | **Pass** | Alembic `upgrade head` → `check` (models match) → `downgrade base` |
| Database (PostgreSQL) | **Pass** | CI: full backend suite on PostgreSQL 17; `alembic upgrade head` → `check` → `downgrade base` on PostgreSQL |
| Security | **Pass (scoped)** | Automated security tests (below); `pip-audit`: 0 known vulns; `npm audit --omit=dev`: 0; secret scan of committable files: 0 hits |
| Performance | **Pass (measured, not load-tested)** | Initial JS ≈ 100 KB gzip (React 81 KB + app 17 KB); pages lazy-loaded (1.5–4 KB gzip each); full backend suite 13 s |
| Responsiveness | **Pass** | No horizontal overflow on all 9 pages at 320, 360, 390, 430, 768, 1024, 1280, 1440, 1920 px widths (scripted `scrollWidth` check) |
| Accessibility | **Partial** | Semantic landmarks, labels, skip link, focus management, reduced motion, 44 px controls; no automated axe audit or screen-reader session was run |
| Offline & sync | **Pass** | Unit (7 sync-engine tests), backend (6 sync tests), E2E offline test, manual: API stopped → edits, reload, conflict, resolution |
| Documentation | **Pass** | README, ARCHITECTURE (SRS, schema, sync protocol, security), API reference, `.env.example`, this report |
| Deployment (Docker / CI) | **Pass (image)** | CI builds the image, starts it, runs migrations and checks `/api/health` and the SPA. `docker compose` (with PostgreSQL + worker) has not been run, and no live deployment exists yet |
| Local LLM | **Pass (evaluated)** | Real model run against fixed cases — see [Local LLM evaluation](#local-llm-evaluation) |

## Test inventory

**Backend (`backend/tests`, 133 tests)**
- Auth: register/login/logout, validation, duplicate e-mail, CSRF enforcement, expired and tampered sessions, password change revoking other sessions, login and sign-up rate limits.
- Tasks: CRUD, validation (empty/oversized/naive datetimes/out-of-range), 2 MB body limit, cross-user isolation, idempotent client ids, optimistic concurrency, filters/search (incl. `%`/`_` escaping), pagination, persistence after engine restart, planning views across time zones.
- NLP: 16 parser tests — relative and absolute dates, times, priorities, categories, estimates, reminders, recurrence warning, bullets/splitting, DST gap, words that resemble dates.
- AI: preview never creates; duplicate flagging; idempotent create-from-text; no duplicates across retries/requests; valid vs. invalid LLM output (fallback); voice commands incl. ambiguity; prioritisation and attention; summaries/insights with and without LLM; rate limit.
- LLM client: request shape, timeouts, connection errors, invalid JSON, truncation, circuit breaker.
- Sync: offline create/update, idempotent replay, stale-edit conflict + "keep mine", delete conflicts, tombstones, restore, pagination, reset after retention, rejections, other users' ids, batch limit.
- Reminders: single dispatch, skips done/deleted, re-arming on reschedule, daily digest per user time zone (Tokyo vs New York), retention purge.
- Calendar & account: ICS import + UID de-dup, bad/large/wrong-type files, feed lifecycle (create, public fetch, revoke), JSON/CSV export with formula-injection guard, account deletion cascades.
- Security/misc: security headers, CORS allow/deny, generic 500 without details, auth required on all private endpoints, SPA serving with path-traversal attempts.

**Frontend (`frontend/src/**/*.test.ts[x]`, 39 tests)** — API client (CSRF header, 502/503/504 → offline, validation messages, 401 event); time-zone helpers incl. DST parity with the server; planning buckets, filters, offline focus order; editor validation and zone conversion; QuickAdd (preview, duplicate unticked, double-click guard, offline fallback); sync engine (offline create, persistence across restart, conflicts both ways, in-flight rebase, remote deletes, tombstones, idempotent retry).

**E2E (`frontend/e2e`, 4 scenarios × desktop + mobile)** — register → natural-language capture → duplicate warning → complete → reload persistence; offline capture with `context.setOffline` → sync on reconnect verified via API; planner/goals/insights/history; JSON export download and account deletion.

## Release 1.1 — appearance, recurring tasks, Web Push, Google Calendar

| Feature | Status | Evidence |
|---|---|---|
| Ambient light (mood from tasks; focus colour while editing) | **Pass** | `mood.test.ts` (5); E2E "appearance"; manual: calm → clear (green) → editing high priority (amber `#f59e0b` measured) |
| Background scenes (Aurora, Dusk, Ocean, Nebula) + frosted panels | **Pass** | E2E scene selection + no horizontal overflow; visual check light/dark; scenes precached for offline |
| Recurring tasks | **Pass** | `test_recurrence.py` (29: rule validation, DST wall-time, skip-ahead, parser phrases, no duplicates on re-complete/retried sync); `recurrence.test.ts` (3); E2E repeat flow |
| Web Push while the app is closed | **Pass (real)** | `test_push.py` (9, incl. SSRF allow-list, 410 cleanup); **real round trip in Microsoft Edge**: subscribe → server push via Microsoft WNS → service worker displayed it |
| Google Calendar two-way sync | **Pass (simulated)** | `test_google_calendar.py` (8) against an in-memory fake Google API: PKCE/state, encrypted tokens, both directions, deletes, new events, conflict (latest wins), sync-token expiry, revoked access, worker job. **Not run against real Google** (needs the owner's OAuth credentials) |
| Migrations 0002–0004 | **Pass** | `upgrade head` → `check` → `downgrade base` on SQLite; startup warns if the database is behind |

Defects found and fixed during this round: CI run #6 exposed that a repeating task created and completed before
its first sync (one combined offline change) did not schedule its next occurrence — fixed in the task service, with a
regression test proven to fail without the fix (likely also the cause of the intermittent CI run #4 failure); dialog showed a double scrollbar; background options lacked accessible
names; the Google section rendered blank when its request failed (now shows the error); an outdated local database
caused a 500 (now a clear startup message telling you to run `alembic upgrade head`).

## Local LLM evaluation

Model `qwen3:4b-instruct` via Ollama on the development PC; reference time Sat 2026-10-31 14:30 Asia/Kolkata. Six notes with
known correct tasks/dates/priorities (single task with date+time+tag+priority; deadline + trailing priority; plain task;
two tasks in one sentence; relative time with reminder; prompt-injection text).

| Approach | Correct | Notes |
|---|---|---|
| Rules only | 5/6 | Always right on dates; could not split “dentist … **and** pick up dry cleaning tomorrow” |
| LLM produces full JSON (first design) | 2/6 | “tomorrow” → today, “by friday” → a past Friday, “in 2 hours” → 3 days later; one 30 s timeout (fell back safely) |
| LLM copies date words, rules resolve them | 1/6 | Dates fixed, but priorities dropped, a phantom “remind” task, and the injected text produced a “spam” task |
| **LLM splits into verbatim pieces, rules interpret each piece (shipped)** | **6/6** | Pieces must occur verbatim in the note and cover ≥ 80 % of it, otherwise the whole note falls back to rules |

Summaries and insights from the same model kept every number correct in 3/3 samples (≈3–6 s each). A number-fidelity guard now
discards any LLM text containing figures not present in the user's data. Latency: single-task notes skip the model (instant); multi-task notes ≈10 s on this PC
(first request includes model load); requests are bounded by a 30 s timeout and a 60 s circuit breaker when Ollama is down.

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
| 11 | Real model produced wrong dates, dropped priorities, followed injected text | Small LLMs are unreliable at date arithmetic and instruction isolation | LLM only segments verbatim; rules interpret; coverage guard | `test_llm_splits_note_and_rules_resolve_dates`, `test_untrustworthy_llm_output_falls_back_to_rules` |
| 12 | Possible invented statistics in AI text | No output check | Number-fidelity guard | `test_llm_text_with_invented_numbers_is_discarded` |
| 14 | Insights page showed a spinner for 10 s+ while the model wrote | Waited for the LLM before showing anything | Rule-based text shown instantly, AI version swapped in | E2E with real model |
| 15 | Quick-add waited ~10 s on single-task notes | LLM consulted even when it cannot help | Only consult it for notes that may hold several tasks | `test_single_task_notes_skip_the_llm` |
| 16 | CI run #2: duplicate warning missing when re-typing a task right after adding it (also offline) | Duplicate check ran only on the server, which had not received the unsynced task yet | Preview and offline quick-add also check this device's tasks (same normalisation as the server) | 2 tests in `QuickAdd.test.tsx`; E2E 24/24 over 3 repeats |
| 13 | Rule parser left “it's” in “submit tax return by friday, it's urgent” | Filler words not stripped | Strip trailing filler | Evaluation case 2 |

## Security checks performed

Argon2id hashing; constant-time login with dummy hash (no user enumeration via login); session tokens and CSRF/feed tokens stored as SHA-256 hashes; CSRF required on unsafe methods; `HttpOnly`/`SameSite=Lax` cookies (`Secure` via config); server-side ownership on every query (tested cross-user); parameterised SQL and escaped `LIKE`; Pydantic length/range limits; 2 MB request cap and 1 MB upload cap with type checks; CSP (`script-src 'self'`, no inline scripts — verified 0 console violations in production mode), `X-Frame-Options`, `nosniff`, `Referrer-Policy`, HSTS in production; restrictive CORS (tested); generic 500 errors; logs contain ids/counts only and redact calendar tokens; CSV formula-injection escaping; LLM output validated and never executed; path traversal on static files (tested); retention purges; dependency audits.

Not performed: penetration test, DAST scanner, axe/Lighthouse audits, load testing.

## Known issues / residual risk

- `npm audit` (including dev dependencies) reports 4 **low** findings in `deepmerge` via `vite-plugin-pwa → workbox-build`; build-time only, not shipped to browsers.
- `oxlint` reports 3 `set-state-in-effect` style warnings (form reset on dialog open); behaviour is correct.
- Frontend unit coverage is 31 % of lines (pages are exercised by the E2E suite rather than unit tests).
- Voice input was not exercised with a real microphone (Web Speech API is not automatable here); its command handling is covered by API tests.
- See README “Known limitations” for product-level limitations.
