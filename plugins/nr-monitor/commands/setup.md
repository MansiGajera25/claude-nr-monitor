---
description: One-time setup of the New Relic monitor for this project (CLAUDE.md section, settings, alerts, automatic runs)
argument-hint: "[owner/repo for automatic runs]"
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

3. **Alerts** — ask the user before creating anything in New Relic. Then call `nr_setup_alerts` (with `github_repo` = `$ARGUMENTS` or this repo's `owner/repo` if they want automatic runs). It creates the strict `Claude-Critical: <app>` policy. Existing alerts are not touched.

4. **Automatic runs (optional)** — copy `${CLAUDE_PLUGIN_ROOT}/templates/nr-monitor.yml` from the plugin into `.github/workflows/nr-monitor.yml` and tell the user to add these repo secrets (Settings → Secrets → Actions): `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token` on the monitor's Claude account), `NEW_RELIC_USER_API_KEY`, `NEW_RELIC_ACCOUNT_ID`, `NEW_RELIC_APP_NAME`, `SLACK_BOT_TOKEN`, `SLACK_CHANNEL_ID`, optional `DATABASE_URL_READONLY`. For alert-started runs, `nr_setup_alerts` needs `NR_GITHUB_DISPATCH_TOKEN` (fine-grained GitHub token, this repo only, "Contents: read and write").

5. Open one PR with the `CLAUDE.md` section (and the workflow file, if added). Then suggest a first run: `/nr-monitor:check`.
