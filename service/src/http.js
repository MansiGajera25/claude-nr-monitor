// The web part: receives New Relic alerts on POST /alert and answers GET /health.

import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { checkAlert } from './alerts.js';
import { addJob, queueStatus } from './queue.js';
import { log } from './logger.js';

const MAX_BODY_BYTES = 100_000;

export function startHttpServer(config) {
  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      return sendJson(res, 200, { ok: true, ...queueStatus() });
    }
    if (req.method === 'POST' && req.url === '/alert') {
      return handleAlert(config, req, res);
    }
    sendJson(res, 404, { error: 'not found' });
  });

  server.listen(config.port, () => {
    log(`nr-monitor service on port ${config.port} — ${config.projects.length} project(s)${config.dryRun ? ' (dry run)' : ''}`);
  });
}

async function handleAlert(config, req, res) {
  if (!isCorrectSecret(config.secret, req.headers['x-nr-monitor-secret'])) {
    return sendJson(res, 401, { error: 'bad secret' });
  }

  let alert;
  try {
    alert = JSON.parse(await readBody(req));
  } catch {
    return sendJson(res, 400, { error: 'bad json' });
  }

  const result = checkAlert(config, alert);
  if (!result.accept) {
    log(`ignored (${result.reason}): ${JSON.stringify(alert.app)}`);
    return sendJson(res, 202, { ignored: result.reason });
  }

  addJob({ app: result.project.app, kind: 'alert', alertText: result.alertText });
  sendJson(res, 202, { queued: true });
}

// Compares secrets in constant time, so the secret cannot be guessed from response times.
function isCorrectSecret(expected, received) {
  const a = Buffer.from(String(received || ''));
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > MAX_BODY_BYTES) req.destroy(new Error('body too large'));
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}
