# nr-monitor — Claude Code plugin

A Claude Code agent that watches your app in New Relic. When it finds a real bug, it fixes it, tests the fix on a safe local copy with dummy data, opens a PR and posts the result to Slack with before/after proof. It never merges.

Includes its own MCP server (no dependencies) with tools for New Relic, Slack and a read-only database. Works in any project, from any Claude account, in VS Code, Cursor or the terminal.

## Install (once per person)

```
/plugin marketplace add MansiGajera25/claude-nr-monitor
/plugin install nr-monitor@nr-monitor-marketplace
```

## Set up a project (once per project)

```
/nr-monitor:setup
```
It checks your settings, writes the Monitoring section in `CLAUDE.md`, creates strict New Relic alerts (asks first) and, if you want, adds the GitHub workflow for automatic runs.

## Use

```
/nr-monitor:check                      # last 12 hours
/nr-monitor:check 1 hour ago           # any window
/nr-monitor:check <alert details>      # one alert
```

## Settings

Locally in the project's `.env` (never commit it); in GitHub as repo secrets.

| Setting | Needed for |
|---|---|
| `NEW_RELIC_USER_API_KEY`, `NEW_RELIC_ACCOUNT_ID`, `NEW_RELIC_APP_NAME` | Required. `NEW_RELIC_REGION=EU` for EU accounts |
| `SLACK_BOT_TOKEN` (`chat:write`, `files:write`), `SLACK_CHANNEL_ID` | Slack report |
| `DATABASE_URL_READONLY` | Optional. A read-only database user |
| `NR_GITHUB_DISPATCH_TOKEN` | Only for `nr_setup_alerts` to connect alerts to GitHub (fine-grained token, one repo, "Contents: read and write") |
| `CLAUDE_CODE_OAUTH_TOKEN` | GitHub Actions only. From `claude setup-token` on the monitor's Claude account |
| `PLUGIN_REPO_TOKEN` | GitHub Actions only, while this plugin repo is private: fine-grained token with "Contents: read" on this plugin repo |

## Automatic runs (no server)

`templates/nr-monitor.yml` → `.github/workflows/nr-monitor.yml` in the project:
- every 12 hours;
- when a High/Critical alert from the `Claude-Critical: <app>` policy fires (New Relic → GitHub `repository_dispatch`);
- by hand with **Run workflow**.

## MCP tools

| Tool | What it does |
|---|---|
| `config_check` | Which settings are set (names only) |
| `nr_signals` | Errors, error logs, error rate and p95 for a window |
| `nr_error_details` | Stack traces and log lines |
| `nr_query` | Any NRQL |
| `nr_setup_alerts` | Creates the strict alert policy and, optionally, the alert → GitHub webhook |
| `slack_post` | Report + proof files |
| `db_query` | One read-only SQL statement |

## Safety

- Dummy data only when testing; never real emails, SMS or outside services.
- Database access is read-only (statement check + read-only transaction + timeout).
- Keys are read from `.env` / secrets and never printed.
- Never merges a PR.

## Automatic runs with the nr-monitor service (recommended)

A very small server (`service/server.js`, no dependencies) receives New Relic alert webhooks and starts Claude for the right project. No Claude token is needed: Claude is logged in once on that machine. **No project code is kept on the server**: each run downloads the project into a temporary folder, Claude fixes and tests it there, and the folder is deleted afterwards.

```
New Relic alert → POST https://<service>/alert → service picks the project
  → download the repo to a temporary folder (+ its settings, + install)
  → claude -p "/nr-monitor:check <alert>" → fix → test → PR → Slack
  → temporary folder deleted
Every 12 hours  → the same for every project
```

**On the service machine (once):**
1. Install Node 18+, git, `gh`, Claude Code. Log in once: `claude` (email + OTP) and `gh auth login` then `gh auth setup-git` (so git can download private repos and push fixes).
2. Install the plugin (the 2 commands above).
3. `git clone` this repo, `cp service/projects.example.json service/projects.json`, set a long random `secret`.
4. Start it: `cd service && npm start` (keep it running with pm2 or systemd), reachable over HTTPS (e.g. behind a reverse proxy). Check: `curl https://<service>/health`.

**Add a project:**
1. In `service/projects.json`, one entry: `app` (New Relic app name), `repo` (`owner/repo`), `branch`, `install` (e.g. `npm ci`). Restart the service.
2. On the service machine, create `service/envs/<app>.env` with that project's settings (New Relic, Slack, optional read-only DB). Never committed.
3. On your computer, in the project's `.env`: `NR_MONITOR_SERVICE_URL=https://<service>` and `NR_MONITOR_SECRET=<same secret>`, then run `/nr-monitor:setup`. It connects that project's alerts to the service.

**Behaviour:** one run at a time (others wait in a queue); only High/Critical; repeats of the same New Relic issue ignored for 6 h; posts to Slack if a run fails (for example, the Claude login expired). Logs: `service/logs/`. Test without downloading or starting Claude: `cd service && npm run dry-run`. Automated checks (secret, filters, repeats, body size limit): `cd service && npm test`.

**Code layout** (`service/`): `server.js` starts everything; `src/config.js` settings, `src/http.js` web endpoints, `src/alerts.js` which alerts count, `src/queue.js` one run at a time, `src/runner.js` download → Claude → delete, `src/notify.js` Slack warning on failure, `src/logger.js` logs.
