// Runs one job at a time. Other jobs wait in line.

import { log } from './logger.js';

const waiting = [];
let current = null; // app name of the job that is running now
let runJob = null;  // function that does the work for one job
let onFailure = null;

export function setupQueue({ run, onError }) {
  runJob = run;
  onFailure = onError;
}

/** Adds a job ({ app, kind, alertText? }). The same app + kind is never queued twice. Alerts jump ahead of scheduled checks. */
export function addJob(job) {
  const alreadyWaiting = waiting.some((other) => other.app === job.app && other.kind === job.kind);
  if (alreadyWaiting) {
    log(`skip: ${job.app} (${job.kind}) is already waiting`);
    return;
  }
  // Alerts go ahead of scheduled checks (but stay behind earlier alerts). Scheduled checks go to the end.
  const firstScheduled = waiting.findIndex((other) => other.kind !== 'alert');
  if (job.kind === 'alert' && firstScheduled !== -1) waiting.splice(firstScheduled, 0, job);
  else waiting.push(job);
  log(`queued: ${job.app} (${job.kind}) — ${waiting.length} waiting`);
  startNext();
}

export function queueStatus() {
  return { waiting: waiting.length, running: current };
}

async function startNext() {
  if (current || waiting.length === 0) return;

  const job = waiting.shift();
  current = job.app;
  try {
    await runJob(job);
  } catch (error) {
    log(`error: ${job.app}: ${error.message}`);
    await onFailure(job, error.message);
  }
  current = null;
  startNext();
}
