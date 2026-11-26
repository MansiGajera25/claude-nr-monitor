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

A very small server (`service/server.mjs`, no dependencies) receives New Relic alert webhooks and starts Claude in the right project folder. No Claude token is needed: Claude is logged in once on that machine.

```
New Relic alert → POST https://<service>/alert → service picks the project → claude -p "/nr-monitor:check <alert>" → fix → PR → Slack
Every 12 hours  → service runs the check for every project
```

**On the service machine (once):**
1. Install Node 18+, git, `gh` (`gh auth login`), Claude Code, and log in: run `claude` once (email + OTP).
2. Install the plugin (the 2 commands above).
3. Clone each project into a folder and add its `.env`.
4. `cp service/projects.example.json service/projects.json`, set a long random `secret` and one entry per project (`app` = New Relic app name, `dir` = folder).
5. Start it: `node service/server.mjs` (keep it running with pm2 or systemd). It must be reachable from the internet over HTTPS, e.g. behind a reverse proxy.
6. Check: `curl https://<service>/health`.

**Per project:** add to its `.env`: `NR_MONITOR_SERVICE_URL=https://<service>` and `NR_MONITOR_SECRET=<same secret>`, then run `/nr-monitor:setup`. It connects that project's alerts to the service.

**Behaviour:** one run at a time (others wait in a queue); only High/Critical; repeats of the same New Relic issue ignored for 6 h; skips a project folder with uncommitted changes; posts to Slack if a run fails (for example, the Claude login expired). Logs: `service/logs/`. Test without starting Claude: `NR_MONITOR_DRY_RUN=1 node service/server.mjs`.
