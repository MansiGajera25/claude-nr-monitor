// Decides whether a New Relic alert should start Claude.

import { findProject } from './config.js';

const ALLOWED_PRIORITIES = ['CRITICAL', 'HIGH'];
const REPEAT_WINDOW_MS = 6 * 60 * 60 * 1000; // ignore the same issue again for 6 hours
const MAX_ALERT_TEXT = 1500;

const lastSeen = new Map(); // issue key -> time it was last accepted

/**
 * Checks one alert. Returns { accept: true, project, alertText } or { accept: false, reason }.
 */
export function checkAlert(config, alert) {
  const project = findProject(config, alert.app);
  if (!project) return { accept: false, reason: 'unknown app' };

  const priority = String(alert.priority || '').toUpperCase();
  if (!ALLOWED_PRIORITIES.includes(priority)) return { accept: false, reason: 'priority' };

  if (isRepeat(alert)) return { accept: false, reason: 'repeat' };

  return { accept: true, project, alertText: describeAlert(alert) };
}

// A repeat = the same New Relic issue within 6 hours. A priority change (High -> Critical) is not a repeat.
function isRepeat(alert) {
  const key = alert.issueId || `${alert.app}|${alert.condition}`;
  const seenAt = lastSeen.get(key);
  const priorityChanged = String(alert.state || '').toUpperCase() === 'PRIORITY_CHANGED';

  if (seenAt && Date.now() - seenAt < REPEAT_WINDOW_MS && !priorityChanged) return true;
  lastSeen.set(key, Date.now());
  return false;
}

// The one-line alert summary that is passed to Claude.
function describeAlert(alert) {
  const text = [
    'New Relic alert.',
    `Priority: ${alert.priority}.`,
    `Condition: ${alert.condition ?? ''}.`,
    `Title: ${alert.title ?? ''}.`,
    `Issue link: ${alert.link ?? ''}`,
  ].join(' ');
  return text.replace(/[\r\n]+/g, ' ').slice(0, MAX_ALERT_TEXT);
}
