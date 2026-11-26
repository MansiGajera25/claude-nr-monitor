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

  let body;
  try {
    body = await readBody(req);
  } catch {
    res.setHeader('Connection', 'close');
    return sendJson(res, 413, { error: `body larger than ${MAX_BODY_BYTES} bytes` });
  }

  let alert;
  try {
    alert = JSON.parse(body);
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

// Reads the request body. Rejects (and stops keeping data) once it is larger than MAX_BODY_BYTES.
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length; // real bytes, not characters
      if (size > MAX_BODY_BYTES) {
        req.removeAllListeners('data');
        req.resume(); // throw the rest away instead of storing it
        return reject(new Error('body too large'));
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}
