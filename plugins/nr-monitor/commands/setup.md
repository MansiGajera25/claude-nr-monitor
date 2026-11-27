---
description: One-time setup of the New Relic monitor for this project (CLAUDE.md section, settings, alerts, automatic runs)
argument-hint: "[service URL for automatic runs]"
---

Set up the nr-monitor plugin for **this project**. Show the plan first, then do it. Never print keys.

1. **Settings** — run `config_check`. For anything missing, tell the user exactly what to add to the project's `.env` (never commit it; make sure `.env` is in `.gitignore`):
   `NEW_RELIC_USER_API_KEY`, `NEW_RELIC_ACCOUNT_ID`, `NEW_RELIC_APP_NAME` (and `NEW_RELIC_REGION=EU` for EU accounts), `SLACK_BOT_TOKEN` (scopes `chat:write`, `files:write`), `SLACK_CHANNEL_ID`, optional `DATABASE_URL_READONLY` (a read-only database user). Stop until New Relic settings are set.

2. **CLAUDE.md** — read the project and add (or update) a short section:
   ```
   ## Monitoring (used by the nr-monitor agent)
   - App: <what it is>. Code <src/>, tests <test/>.
   - Check: <typecheck command>, <test command>.
   - Safe local copy: start <command>, ready at <health URL>, error lines <command>, stop <command>.
   - Replay: <example requests with dummy data>.
   - Not a bug: <outside service errors the app already handles>.
   - Never call: <production DB, real email/SMS/payment, real third-party APIs>.
   ```
   A safe local copy = own throwaway DB, fake outside services, New Relic off. If there is none, propose the smallest one.

3. **Alerts** — ask the user before creating anything in New Relic. Then call `nr_setup_alerts`. It creates the strict `Claude-Critical: <app>` policy. Existing alerts are not touched.

4. **Automatic runs (optional)** — runs are started by the nr-monitor service (see the plugin README, "Service"). If the user has the service address and secret, call `nr_setup_alerts` with `service_url` = that address; `NR_MONITOR_SECRET` must be set in `.env` or the environment. Never ask the user to paste the secret into the chat. Otherwise skip this step and say so.

5. Open one PR with the `CLAUDE.md` section. Then suggest a first run: `/nr-monitor:check`.
