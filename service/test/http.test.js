// Starts the service in dry-run mode on a free port and checks how /alert and /health answer.
// Run: npm test   (nothing is downloaded and Claude is never started)

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVICE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const SECRET = 'test-secret-1234567890';
const PORT = 8800 + Math.floor(Math.random() * 100);
const URL_BASE = `http://localhost:${PORT}`;

let server;
let tempDir;

before(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'nr-monitor-test-'));
  const configPath = join(tempDir, 'projects.json');
  writeFileSync(configPath, JSON.stringify({
    secret: SECRET,
    scheduleHours: 0,
    logDir: join(tempDir, 'logs'),
    projects: [{ app: 'Test-App', repo: 'example/test-app' }],
  }));

  server = spawn('node', ['server.js'], {
    cwd: SERVICE_DIR,
    env: { ...process.env, NR_MONITOR_CONFIG: configPath, NR_MONITOR_DRY_RUN: '1', PORT: String(PORT) },
    stdio: 'ignore',
  });
  await waitUntilUp();
});

after(() => {
  server.kill();
  rmSync(tempDir, { recursive: true, force: true });
});

function sendAlert(body, secret = SECRET) {
  return fetch(`${URL_BASE}/alert`, {
    method: 'POST',
    headers: { 'x-nr-monitor-secret': secret, 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

async function waitUntilUp() {
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`${URL_BASE}/health`)).ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('service did not start');
}

test('health answers', async () => {
  const res = await fetch(`${URL_BASE}/health`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).ok, true);
});

test('wrong secret is rejected with 401', async () => {
  const res = await sendAlert({ app: 'Test-App', priority: 'CRITICAL' }, 'wrong-secret-000000000');
  assert.equal(res.status, 401);
});

test('bad JSON is rejected with 400', async () => {
  const res = await sendAlert('{not json');
  assert.equal(res.status, 400);
});

test('critical alert is queued', async () => {
  const res = await sendAlert({ app: 'Test-App', priority: 'CRITICAL', issueId: 'a1' });
  assert.deepEqual(await res.json(), { queued: true });
});

test('same issue again is ignored as a repeat', async () => {
  const res = await sendAlert({ app: 'Test-App', priority: 'CRITICAL', issueId: 'a1' });
  assert.deepEqual(await res.json(), { ignored: 'repeat' });
});

test('low priority is ignored', async () => {
  const res = await sendAlert({ app: 'Test-App', priority: 'LOW', issueId: 'a2' });
  assert.deepEqual(await res.json(), { ignored: 'priority' });
});

test('unknown app is ignored', async () => {
  const res = await sendAlert({ app: 'Other-App', priority: 'CRITICAL', issueId: 'a3' });
  assert.deepEqual(await res.json(), { ignored: 'unknown app' });
});

test('body under the limit (50 KB) is accepted', async () => {
  const res = await sendAlert({ app: 'Test-App', priority: 'HIGH', issueId: 'a4', title: 'x'.repeat(50_000) });
  assert.equal(res.status, 202);
});

test('body over the limit (200 KB) gets 413 and the service keeps running', async () => {
  const res = await sendAlert({ app: 'Test-App', priority: 'HIGH', issueId: 'a5', title: 'x'.repeat(200_000) });
  assert.equal(res.status, 413);
  assert.equal((await fetch(`${URL_BASE}/health`)).status, 200);
});
