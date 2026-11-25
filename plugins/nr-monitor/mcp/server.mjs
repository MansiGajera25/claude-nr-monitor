#!/usr/bin/env node
// nr-monitor MCP server: New Relic, Slack and read-only database tools for the nr-monitor agent.
// Zero dependencies (Node 18+). Speaks MCP over stdio (newline-delimited JSON-RPC).
// Settings come from environment variables, or from a `.env` file in the project folder.
import { readFileSync, existsSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { execFile } from 'node:child_process';
import { createInterface } from 'node:readline';

// ---------- settings ----------
function loadDotEnv(dir) {
  const file = join(dir, '.env');
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m || process.env[m[1]] !== undefined) continue;
    let v = m[2];
    if (/^(["']).*\1$/.test(v)) v = v.slice(1, -1);
    process.env[m[1]] = v;
  }
}
loadDotEnv(process.env.CLAUDE_PROJECT_DIR || process.cwd());

const env = (k) => (process.env[k] ?? '').trim();
const NR_URL = env('NEW_RELIC_REGION').toUpperCase() === 'EU' ? 'https://api.eu.newrelic.com/graphql' : 'https://api.newrelic.com/graphql';
const need = (...keys) => {
  const missing = keys.filter((k) => !env(k));
  if (missing.length) throw new Error(`Missing setting(s): ${missing.join(', ')}. Add them to the project's .env (local) or to the environment/secrets (CI).`);
};
const q = (s) => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");

// ---------- New Relic ----------
async function nerdgraph(query, variables = {}) {
  need('NEW_RELIC_USER_API_KEY');
  const r = await fetch(NR_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'API-Key': env('NEW_RELIC_USER_API_KEY') },
    body: JSON.stringify({ query, variables }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.errors) throw new Error(`New Relic: ${JSON.stringify(j.errors ?? r.status)}`);
  return j.data;
}
async function nrql(query) {
  need('NEW_RELIC_ACCOUNT_ID');
  const d = await nerdgraph('query($id:Int!,$q:Nrql!){actor{account(id:$id){nrql(query:$q,timeout:60){results}}}}', {
    id: Number(env('NEW_RELIC_ACCOUNT_ID')),
    q: query,
  });
  return d.actor.account.nrql.results;
}
const appName = (a) => {
  const n = a || env('NEW_RELIC_APP_NAME');
  if (!n) throw new Error('Missing NEW_RELIC_APP_NAME (or pass app).');
  return n;
};
const windowOf = (w) => {
  const s = (w || '1 hour ago').trim();
  if (!/^\d+\s+(minute|minutes|hour|hours|day|days)\s+ago$/i.test(s)) throw new Error(`window must look like "1 hour ago" or "12 hours ago", got "${s}"`);
  return s;
};

async function nrSignals({ window, app }) {
  const A = q(appName(app)), W = windowOf(window);
  const queries = {
    errors: `SELECT count(*) FROM TransactionError WHERE appName = '${A}' FACET error.class, error.message, transactionName SINCE ${W} LIMIT 10`,
    errorLogs: `SELECT count(*) FROM Log WHERE entity.name = '${A}' AND lower(level) IN ('error','fatal','50','60') FACET message SINCE ${W} LIMIT 10`,
    webTransactions: `SELECT percentage(count(*), WHERE error IS true) AS errorRate, percentile(duration, 95) AS p95, count(*) FROM Transaction WHERE appName = '${A}' AND transactionType = 'Web' FACET name SINCE ${W} LIMIT 10`,
  };
  const out = { app: appName(app), window: W };
  for (const [k, v] of Object.entries(queries)) {
    try { out[k] = await nrql(v); } catch (e) { out[k] = { error: e.message }; }
  }
  out.rule = 'Issue exists when: any TransactionError; any error/fatal log; errorRate > 5 or p95 > 2 s with count >= 20; or a project rule from CLAUDE.md.';
  return out;
}

async function nrErrorDetails({ window, app, limit }) {
  const A = q(appName(app)), W = windowOf(window), n = Math.min(Number(limit) || 5, 20);
  return {
    errors: await nrql(`SELECT * FROM TransactionError WHERE appName = '${A}' SINCE ${W} LIMIT ${n}`),
    logs: await nrql(`SELECT timestamp, level, message, trace.id FROM Log WHERE entity.name = '${A}' AND lower(level) IN ('error','fatal','warn','50','60','40') SINCE ${W} LIMIT 50`),
  };
}

// Creates (once) a strict alert policy for the app and, optionally, a webhook that starts the agent.
async function nrSetupAlerts({ app, error_rate_critical = 10, error_rate_high = 3, github_repo }) {
  need('NEW_RELIC_ACCOUNT_ID');
  const A = appName(app), acc = Number(env('NEW_RELIC_ACCOUNT_ID'));
  const policyName = `Claude-Critical: ${A}`;
  const done = [];

  const found = await nerdgraph(`query($a:Int!,$n:String){actor{account(id:$a){alerts{policiesSearch(searchCriteria:{name:$n}){policies{id name}}}}}}`, { a: acc, n: policyName });
  let policy = found.actor.account.alerts.policiesSearch.policies.find((p) => p.name === policyName);
  if (policy) done.push(`Policy "${policyName}" already exists (${policy.id}) — conditions not changed.`);
  else {
    policy = (await nerdgraph(`mutation($a:Int!,$p:AlertsPolicyInput!){alertsPolicyCreate(accountId:$a,policy:$p){id name}}`, {
      a: acc, p: { name: policyName, incidentPreference: 'PER_CONDITION' },
    })).alertsPolicyCreate;
    done.push(`Created policy "${policyName}" (${policy.id}).`);
    const conds = [
      { name: `[Claude] High error rate — ${A}`, desc: `Error rate above ${error_rate_critical}% for 5 min (High: ${error_rate_high}%). The Claude agent investigates.`,
        query: `SELECT percentage(count(*), WHERE error IS true) FROM Transaction WHERE appName = '${q(A)}'`,
        terms: [
          { priority: 'CRITICAL', operator: 'ABOVE', threshold: Number(error_rate_critical), thresholdDuration: 300, thresholdOccurrences: 'ALL' },
          { priority: 'WARNING', operator: 'ABOVE', threshold: Number(error_rate_high), thresholdDuration: 300, thresholdOccurrences: 'ALL' },
        ] },
      { name: `[Claude] Fatal logs — ${A}`, desc: 'Any fatal log line. The Claude agent investigates.',
        query: `SELECT count(*) FROM Log WHERE entity.name = '${q(A)}' AND lower(level) IN ('fatal','60')`,
        terms: [{ priority: 'CRITICAL', operator: 'ABOVE', threshold: 0, thresholdDuration: 300, thresholdOccurrences: 'AT_LEAST_ONCE' }] },
    ];
    for (const c of conds) {
      const r = await nerdgraph(`mutation($a:Int!,$p:ID!,$c:AlertsNrqlConditionStaticInput!){alertsNrqlConditionStaticCreate(accountId:$a,policyId:$p,condition:$c){id name}}`, {
        a: acc, p: policy.id,
        c: { name: c.name, description: c.desc, enabled: true, nrql: { query: c.query }, terms: c.terms,
             signal: { aggregationWindow: 60, aggregationMethod: 'EVENT_TIMER', aggregationTimer: 60 }, violationTimeLimitSeconds: 86400 },
      });
      done.push(`Created condition "${r.alertsNrqlConditionStaticCreate.name}".`);
    }
  }

  // Optional: High/Critical alerts from this policy start the GitHub Action in github_repo.
  if (github_repo) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(github_repo)) throw new Error('github_repo must look like owner/repo');
    if (!env('NR_GITHUB_DISPATCH_TOKEN')) {
      done.push('Webhook NOT created: set NR_GITHUB_DISPATCH_TOKEN (a GitHub fine-grained token with "Contents: read and write" on that repo only), then run again.');
    } else {
      const destName = `Claude agent → ${github_repo}`;
      const dests = (await nerdgraph(`query($a:Int!){actor{account(id:$a){aiNotifications{destinations{entities{id name}}}}}}`, { a: acc })).actor.account.aiNotifications.destinations.entities;
      let dest = dests.find((d) => d.name === destName);
      if (dest) done.push(`Webhook "${destName}" already exists.`);
      else {
        dest = (await nerdgraph(`mutation($a:Int!,$d:AiNotificationsDestinationInput!){aiNotificationsCreateDestination(accountId:$a,destination:$d){destination{id name} error{... on AiNotificationsResponseError{description}}}}`, {
          a: acc, d: { name: destName, type: 'WEBHOOK',
            properties: [{ key: 'url', value: `https://api.github.com/repos/${github_repo}/dispatches` }],
            auth: { type: 'TOKEN', token: { prefix: 'Bearer', token: env('NR_GITHUB_DISPATCH_TOKEN') } } },
        })).aiNotificationsCreateDestination.destination;
        const payload = `{"event_type":"nr-alert","client_payload":{"alert":"New Relic alert. Priority: {{priority}}. Condition: {{#each accumulations.conditionName}}{{escape this}} {{/each}}. Title: {{escape issueTitle}}. State: {{state}}. Issue link: {{issuePageUrl}}"}}`;
        const ch = (await nerdgraph(`mutation($a:Int!,$c:AiNotificationsChannelInput!){aiNotificationsCreateChannel(accountId:$a,channel:$c){channel{id} error{... on AiNotificationsResponseError{description}}}}`, {
          a: acc, c: { name: `Claude agent (${A})`, type: 'WEBHOOK', product: 'IINT', destinationId: dest.id,
            properties: [{ key: 'payload', value: payload }, { key: 'headers', value: JSON.stringify({ Accept: 'application/vnd.github+json' }) }] },
        })).aiNotificationsCreateChannel.channel;
        await nerdgraph(`mutation($a:Int!,$w:AiWorkflowsCreateWorkflowInput!){aiWorkflowsCreateWorkflow(accountId:$a,createWorkflowData:$w){workflow{id} errors{description}}}`, {
          a: acc, w: { name: `Claude agent: ${A} (High + Critical)`, workflowEnabled: true, destinationsEnabled: true, mutingRulesHandling: 'DONT_NOTIFY_FULLY_MUTED_ISSUES',
            issuesFilter: { name: 'claude', type: 'FILTER', predicates: [
              { attribute: 'labels.policyIds', operator: 'EXACTLY_MATCHES', values: [String(policy.id)] },
              { attribute: 'priority', operator: 'EQUAL', values: ['CRITICAL', 'HIGH'] }] },
            destinationConfigurations: [{ channelId: ch.id, notificationTriggers: ['ACTIVATED', 'PRIORITY_CHANGED'] }] },
        });
        done.push(`Created webhook + workflow: High/Critical alerts for ${A} start the "nr-monitor" GitHub Action in ${github_repo}.`);
      }
    }
  }
  return done.join('\n');
}

// ---------- Slack ----------
async function slackApi(method, body, form = false) {
  need('SLACK_BOT_TOKEN');
  const r = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env('SLACK_BOT_TOKEN')}`, ...(form ? {} : { 'Content-Type': 'application/json; charset=utf-8' }) },
    body: form ? new URLSearchParams(body) : JSON.stringify(body),
  });
  const j = await r.json();
  if (!j.ok) throw new Error(`Slack ${method}: ${j.error}`);
  return j;
}
async function slackPost({ text, files = [] }) {
  need('SLACK_CHANNEL_ID');
  const channel = env('SLACK_CHANNEL_ID');
  if (!files.length) {
    await slackApi('chat.postMessage', { channel, text, unfurl_links: false });
    return 'Posted to Slack.';
  }
  const uploaded = [];
  for (const f of files) {
    if (!existsSync(f)) throw new Error(`File not found: ${f}`);
    const name = basename(f);
    const up = await slackApi('files.getUploadURLExternal', { filename: name, length: String(statSync(f).size) }, true);
    const fd = new FormData();
    fd.append('file', new Blob([readFileSync(f)]), name);
    const r = await fetch(up.upload_url, { method: 'POST', body: fd });
    if (!r.ok) throw new Error(`Slack upload failed for ${name}: ${r.status}`);
    uploaded.push({ id: up.file_id, title: name });
  }
  await slackApi('files.completeUploadExternal', { files: uploaded, channel_id: channel, initial_comment: text });
  return `Posted to Slack with ${uploaded.length} file(s).`;
}

// ---------- Database (read only) ----------
function dbQuery({ sql }) {
  const url = env('DATABASE_URL_READONLY');
  if (!url) throw new Error('DATABASE_URL_READONLY is not set — skip database checks and say so in the report.');
  const s = String(sql).trim().replace(/;\s*$/, '');
  if (!/^(select|with|explain|show|table)\b/i.test(s) || s.includes(';')) throw new Error('Only one read-only statement (SELECT / WITH / EXPLAIN / SHOW) is allowed.');
  return new Promise((resolve, reject) => {
    execFile('psql', [url, '-X', '-A', '-F', '\t', '-P', 'footer=off', '-c', s], {
      env: { ...process.env, PGOPTIONS: '-c default_transaction_read_only=on -c statement_timeout=10s' },
      timeout: 20000, maxBuffer: 2 * 1024 * 1024,
    }, (err, stdout, stderr) => (err ? reject(new Error((stderr || err.message).replace(url, '<db>'))) : resolve(stdout.split('\n').slice(0, 201).join('\n'))));
  });
}

// ---------- settings check ----------
function configCheck() {
  const keys = ['NEW_RELIC_USER_API_KEY', 'NEW_RELIC_ACCOUNT_ID', 'NEW_RELIC_APP_NAME', 'NEW_RELIC_REGION', 'SLACK_BOT_TOKEN', 'SLACK_CHANNEL_ID', 'DATABASE_URL_READONLY', 'NR_GITHUB_DISPATCH_TOKEN'];
  return keys.map((k) => `${env(k) ? 'set    ' : 'missing'}  ${k}`).join('\n') + '\n(values are never shown)';
}

// ---------- MCP plumbing ----------
const str = (description) => ({ type: 'string', description });
const TOOLS = [
  { name: 'config_check', description: 'Show which nr-monitor settings are set (names only, never values).', inputSchema: { type: 'object', properties: {} }, run: configCheck },
  { name: 'nr_signals', description: 'Check every standard New Relic signal for the app in a time window: errors, error/fatal logs, error rate and p95 per web transaction.',
    inputSchema: { type: 'object', properties: { window: str('e.g. "1 hour ago", "12 hours ago". Default 1 hour ago.'), app: str('New Relic app name. Default NEW_RELIC_APP_NAME.') } }, run: nrSignals },
  { name: 'nr_error_details', description: 'Full error events (stack trace, attributes) and error/warn log lines for the app in a time window.',
    inputSchema: { type: 'object', properties: { window: str('e.g. "1 hour ago"'), app: str('app name'), limit: { type: 'number' } } }, run: nrErrorDetails },
  { name: 'nr_query', description: 'Run any NRQL query (read only) on the configured New Relic account.',
    inputSchema: { type: 'object', properties: { nrql: str('NRQL query') }, required: ['nrql'] }, run: ({ nrql: s }) => nrql(s) },
  { name: 'nr_setup_alerts', description: 'One-time: create the strict "Claude-Critical: <app>" alert policy (error rate + fatal logs) and, if github_repo is given and NR_GITHUB_DISPATCH_TOKEN is set, a webhook so High/Critical alerts start the nr-monitor GitHub Action. Safe to run again (skips what exists).',
    inputSchema: { type: 'object', properties: { app: str('app name'), error_rate_critical: { type: 'number', description: 'default 10 (%)' }, error_rate_high: { type: 'number', description: 'default 3 (%)' }, github_repo: str('owner/repo to start on alerts (optional)') } }, run: nrSetupAlerts },
  { name: 'slack_post', description: 'Post the report to the Slack results channel (SLACK_CHANNEL_ID), optionally with proof files attached (absolute paths).',
    inputSchema: { type: 'object', properties: { text: str('Slack mrkdwn text'), files: { type: 'array', items: { type: 'string' } } }, required: ['text'] }, run: slackPost },
  { name: 'db_query', description: 'Run ONE read-only SQL statement on the database (DATABASE_URL_READONLY, read-only transaction, 10 s timeout, max 200 rows).',
    inputSchema: { type: 'object', properties: { sql: str('SELECT ...') }, required: ['sql'] }, run: dbQuery },
];

const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
createInterface({ input: process.stdin }).on('line', async (line) => {
  if (!line.trim()) return;
  let m;
  try { m = JSON.parse(line); } catch { return; }
  const reply = (result) => m.id !== undefined && send({ jsonrpc: '2.0', id: m.id, result });
  try {
    if (m.method === 'initialize') reply({ protocolVersion: m.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'nr-monitor', version: '1.0.0' } });
    else if (m.method === 'tools/list') reply({ tools: TOOLS.map(({ run, ...t }) => t) });
    else if (m.method === 'tools/call') {
      const tool = TOOLS.find((t) => t.name === m.params?.name);
      if (!tool) return reply({ isError: true, content: [{ type: 'text', text: `Unknown tool ${m.params?.name}` }] });
      try {
        const r = await tool.run(m.params.arguments ?? {});
        reply({ content: [{ type: 'text', text: typeof r === 'string' ? r : JSON.stringify(r, null, 1) }] });
      } catch (e) {
        reply({ isError: true, content: [{ type: 'text', text: e.message }] });
      }
    } else if (m.method === 'ping') reply({});
    else if (m.id !== undefined && !m.method?.startsWith('notifications/')) send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'Method not found' } });
  } catch (e) {
    if (m.id !== undefined) send({ jsonrpc: '2.0', id: m.id, error: { code: -32603, message: e.message } });
  }
});
