# Changelog

All notable changes to LifeOS. Versions follow [Semantic Versioning](https://semver.org/).

## [1.1.0] - 2026-10-31

### Added
- **Ambient light** behind the app whose colour follows your tasks: cyan when calm, amber when something urgent is due
  within 24 hours, rose when tasks are overdue, green when you're all clear; it takes the priority colour of the task
  you are editing.
- **Background scenes** (Aurora, Dusk, Ocean, Nebula) with frosted-glass panels, an intensity switch and a Minimal
  option (Settings → Appearance). Scenes are cached for offline use; motion respects "reduce motion".
- **Recurring tasks**: "every Monday 9am", "every 2 weeks", weekdays, monthly, yearly or custom. Completing an
  occurrence schedules the next one; retries and offline replays can never create duplicates. Times stay correct
  across daylight-saving changes.
- **Notifications while LifeOS is closed** (Web Push through the service worker), with a test button.
- **Two-way Google Calendar sync** with a dedicated "LifeOS" calendar (OAuth 2.0 + PKCE, encrypted tokens; LifeOS
  cannot see your other calendars).
- `python -m app.cli vapid` and `python -m app.cli fernet` to generate the keys these features need.
- The API logs a clear error at startup when the database needs `alembic upgrade head`.
- Published Docker image: `ghcr.io/ashutoshd22-cloud/lifeos`.

### Changed
- The local LLM now only splits notes into tasks (verbatim pieces); dates and priorities are always resolved by the
  rule parser. Accuracy on the evaluation set went from 2/6 to 6/6. AI summaries containing numbers that are not in
  your data are discarded.

### Fixed
- A repeating task completed before it first synced (offline or on a slow connection) stopped repeating.
- Duplicate warning could be missed when re-typing a task that had not synced yet, or while offline.
- Dialogs showed two scrollbars; background options lacked accessible names; the Google section was blank when its
  status request failed.

### Upgrade notes
- Run `alembic upgrade head` (Docker images do this automatically). Three new migrations: recurring tasks, push
  subscriptions, Google Calendar sync.
- Push notifications and Google sync are optional and stay off until configured (see README).

## [1.0.0] - 2026-10-30

First public release: tasks with priorities, categories and deadlines; day/week/month planner; natural-language task
capture with a local LLM and rule-based fallback; AI summaries, insights and prioritisation; reminders and daily
digest in your time zone; iCalendar feed and import; goals and analytics; searchable activity history; dark/light
themes; offline-first sync with conflict resolution; JSON/CSV export and account deletion.

[1.1.0]: https://github.com/ashutoshd22-cloud/AI-Powered-project/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/ashutoshd22-cloud/AI-Powered-project/releases/tag/v1.0.0
