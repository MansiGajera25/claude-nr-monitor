#!/usr/bin/env node
// nr-monitor service: a very small server that receives New Relic alert webhooks and starts
// Claude Code (with the nr-monitor plugin) in the right project folder. Also runs the 12-hour check.
// Zero dependencies (Node 18+). Claude must be logged in once on this machine (`claude` → OTP).
//
//   node service/server.js   (config: service/projects.json; per-project settings: service/envs/<app>.env)
// Each run downloads the project into a temporary folder, runs Claude there, and deletes it after.
//
// Endpoints:
//   POST /alert   New Relic webhook. Header `x-nr-monitor-secret` must match the config secret.
//                 Body: {"app":"<New Relic app name>","priority":"CRITICAL","condition":"…","title":"…","link":"…","issueId":"…"}
//   GET  /health  {"ok":true,"queue":n,"running":"<app>|null"}
import { createServer } from 'node:http';
import { readFileSync, appendFileSync, mkdirSync, mkdtempSync, rmSync, copyFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual } from 'node:crypto';

const here = dirname(fileURLToPath(import.meta.url));
const configPath = process.env.NR_MONITOR_CONFIG || join(here, 'projects.json');
const cfg = JSON.parse(readFileSync(configPath, 'utf8'));
const PORT = Number(process.env.PORT || cfg.port || 8787);
const SECRET = process.env.NR_MONITOR_SECRET || cfg.secret;
const DRY_RUN = process.env.NR_MONITOR_DRY_RUN === '1';
const EVERY_H = Number(cfg.scheduleHours ?? 12);
const LOG_DIR = cfg.logDir || join(here, 'logs');
mkdirSync(LOG_DIR, { recursive: true });
if (!SECRET || SECRET.length < 16) throw new Error('Set a secret of at least 16 characters (config "secret" or NR_MONITOR_SECRET).');
for (const p of cfg.projects) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(p.repo || '')) throw new Error(`Project "${p.app}": "repo" must look like owner/repo.`);
}
setTimeout(() => cfg.projects.filter((p) => !existsSync(envFileOf(p))).forEach((p) => log(`warning: no settings file for ${p.app} — create ${envFileOf(p)}`)));

const log = (msg) => {
  const line = `${new Date().toISOString()} ${msg}`;
  console.log(line);
  appendFileSync(join(LOG_DIR, 'service.log'), line + '\n');
};
const projectFor = (app) => cfg.projects.find((p) => p.app === app);

// ---------- queue: one Claude run at a time ----------
const queue = [];
let running = null;
const recentIssues = new Map(); // issueId -> time, to ignore repeats for 6 h

function enqueue(job) {
  if (queue.some((j) => j.app === job.app && j.kind === job.kind)) return log(`skip: ${job.app} ${job.kind} already queued`);
  queue.push(job);
  log(`queued: ${job.app} (${job.kind}) — queue ${queue.length}`);
  next();
}

async function next() {
  if (running || !queue.length) return;
  const job = queue.shift();
  running = job.app;
  try { await runClaude(job); } catch (e) { log(`error: ${job.app}: ${e.message}`); await notifyFailure(job, e.message); }
  running = null;
  next();
}

function runClaude(job) {
  const p = projectFor(job.app);
  const prompt = job.kind === 'alert' ? `/nr-monitor:check ${job.alertText}` : `/nr-monitor:check ${EVERY_H} hours ago`;
  const args = ['-p', prompt, '--permission-mode', 'bypassPermissions', '--max-turns', String(cfg.maxTurns ?? 200)];
  log(`start: ${job.app} (${p.repo}) — claude ${JSON.stringify(prompt)}`);
  if (DRY_RUN) { log('dry run: nothing downloaded, Claude not started'); return Promise.resolve(); }

  // Download -> fix -> delete: a fresh temporary copy for every run, removed afterwards.
  const work = mkdtempSync(join(tmpdir(), 'nr-monitor-'));
  const dir = join(work, 'repo');
  const cleanup = () => { rmSync(work, { recursive: true, force: true }); log(`deleted temporary copy of ${job.app}`); };
  try {
    execFileSync('git', ['clone', '-q', '--depth', '50', '--branch', p.branch || 'main', `https://github.com/${p.repo}.git`, dir], { stdio: 'pipe' });
    copyFileSync(envFileOf(p), join(dir, '.env'));
    if (p.install) execFileSync('bash', ['-c', p.install], { cwd: dir, stdio: 'pipe', timeout: 15 * 60_000 });
  } catch (e) { cleanup(); throw new Error(`could not prepare ${p.repo}: ${String(e.stderr || e.message).slice(0, 300)}`); }
  log(`downloaded ${p.repo} to a temporary folder`);

  const out = join(LOG_DIR, `${job.app.replace(/[^\w.-]/g, '_')}-${Date.now()}.log`);
  return new Promise((resolve, reject) => {
    const child = spawn('claude', args, { cwd: dir, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => { child.kill('SIGTERM'); }, (cfg.timeoutMinutes ?? 45) * 60_000);
    child.stdout.on('data', (d) => appendFileSync(out, d));
    child.stderr.on('data', (d) => appendFileSync(out, d));
    child.on('close', (code) => {
      clearTimeout(timer);
      log(`done: ${job.app} exit ${code} — log ${out}`);
      cleanup();
      if (code === 0) return resolve();
      const tail = readFileSync(out, 'utf8').slice(-400);
      reject(new Error(/log ?in|login|auth|unauthori[sz]ed/i.test(tail) ? 'Claude is not logged in on the service machine — run `claude` there and log in again.' : `claude exited ${code}`));
    });
  });
}

// Each project's settings live on the service machine only: service/envs/<app>.env (never in git).
const envFileOf = (p) => p.envFile || join(here, 'envs', `${p.app}.env`);

// Tell the team in Slack when a run fails (e.g. Claude login expired). Uses that project's Slack settings.
async function notifyFailure(job, reason) {
  try {
    const p = projectFor(job.app);
    const env = Object.fromEntries(readFileSync(envFileOf(p), 'utf8').split('\n')
      .map((l) => l.match(/^\s*([A-Z0-9_]+)\s*=\s*"?(.*?)"?\s*$/)).filter(Boolean).map((m) => [m[1], m[2]]));
    if (!env.SLACK_BOT_TOKEN || !env.SLACK_CHANNEL_ID) return;
    await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`, 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ channel: env.SLACK_CHANNEL_ID, text: `:warning: NR monitor could not run for ${job.app}: ${reason}` }),
    });
  } catch { /* never crash the service over a notification */ }
}

// ---------- HTTP ----------
const okSecret = (got) => {
  const a = Buffer.from(String(got || '')), b = Buffer.from(SECRET);
  return a.length === b.length && timingSafeEqual(a, b);
};
const reply = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };

createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') return reply(res, 200, { ok: true, queue: queue.length, running });
  if (req.method !== 'POST' || req.url !== '/alert') return reply(res, 404, { error: 'not found' });
  if (!okSecret(req.headers['x-nr-monitor-secret'])) return reply(res, 401, { error: 'bad secret' });

  let body = '';
  req.on('data', (c) => { body += c; if (body.length > 100_000) req.destroy(); });
  req.on('end', () => {
    let a;
    try { a = JSON.parse(body); } catch { return reply(res, 400, { error: 'bad json' }); }
    const p = projectFor(a.app);
    if (!p) { log(`ignored: unknown app ${JSON.stringify(a.app)}`); return reply(res, 202, { ignored: 'unknown app' }); }
    if (!['CRITICAL', 'HIGH'].includes(String(a.priority).toUpperCase())) return reply(res, 202, { ignored: 'priority' });
    const key = a.issueId || `${a.app}|${a.condition}`;
    const seen = recentIssues.get(key);
    if (seen && Date.now() - seen < 6 * 3600_000 && String(a.state).toUpperCase() !== 'PRIORITY_CHANGED') {
      log(`ignored: repeat of ${key}`);
      return reply(res, 202, { ignored: 'repeat' });
    }
    recentIssues.set(key, Date.now());
    const alertText = `New Relic alert. Priority: ${a.priority}. Condition: ${a.condition ?? ''}. Title: ${a.title ?? ''}. Issue link: ${a.link ?? ''}`
      .replace(/[\r\n]+/g, ' ').slice(0, 1500);
    enqueue({ app: a.app, kind: 'alert', alertText });
    reply(res, 202, { queued: true });
  });
}).listen(PORT, () => log(`nr-monitor service on :${PORT} — ${cfg.projects.length} project(s)${DRY_RUN ? ' (dry run)' : ''}`));

// ---------- every N hours: scheduled check for every project ----------
if (EVERY_H > 0) setInterval(() => cfg.projects.forEach((p) => enqueue({ app: p.app, kind: 'scheduled' })), EVERY_H * 3600_000);
