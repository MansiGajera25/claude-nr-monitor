---
description: New Relic check — scheduled (last 12 h) or for one alert; fix any genuine bug with a PR, post the result to Slack
argument-hint: "[alert details | window like \"12 hours ago\"]"
---

Use the **nr-monitor** agent to check New Relic. Always use the agent.

Input: `$ARGUMENTS`
- **Scheduled run** (no input, or a window like `12 hours ago`): `<WINDOW>` = that window, default `12 hours ago`. Check all signals.
- **Alert run** (input has alert details — priority, condition, issue link): `<WINDOW>` = `1 hour ago`. Investigate the condition that fired first, then the other signals. If the priority is not `CRITICAL` or `HIGH`, stop and post nothing.
- **Skip duplicates:** before investigating, `gh pr list --state open --search "head:bot/"`. If an open PR already covers the same error, stop: no new PR, and in Slack say only "already being fixed in PR #N".

Rules:
- Before working, `git status`: if tracked files have uncommitted changes, report only and create no branches.
- Fix at most one genuine bug, following the agent's rules, and open one PR. Never merge.
- When done, `git checkout main`.

## Report to Slack

Use the `slack_post` tool (skip if `config_check` shows Slack is not set). Slack mrkdwn: `*bold*`, `•` bullets, no tables, no `#` headings. Short. Only real bugs matter:
- *No bug* → exactly one line: `:white_check_mark: NR check (<run>) — no bugs found.`
- *Bug* → `:red_circle: NR check (<run>) — bug found`, then for each real bug: what fails (one line), where (route / file:line), verdict, and the PR link — or why no PR.
- *PR opened* → add `Before/after on local server with dummy data — attached.` and pass every file in `/tmp/nr-monitor/proof/` as `files`.

`<run>` = `last 12 h` (or the window) for a scheduled run, `alert: <condition name>` for an alert run. No counts, percentages, latency, lists of clean signals, or things that are not bugs.
If posting fails, say so at the end. When done: `rm -rf /tmp/nr-monitor`.
