// Writes log lines to the screen and to logs/service.log.

import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

let logFile = null;

export function setupLogger(logDir) {
  mkdirSync(logDir, { recursive: true });
  logFile = join(logDir, 'service.log');
}

export function log(message) {
  const line = `${new Date().toISOString()} ${message}`;
  console.log(line);
  if (logFile) appendFileSync(logFile, line + '\n');
}
