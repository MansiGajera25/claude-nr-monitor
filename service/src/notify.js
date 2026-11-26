// Posts a warning to the project's Slack channel when a run fails (for example, the Claude login expired).

import { readFileSync } from 'node:fs';
import { envFileOf, findProject } from './config.js';

export function createFailureNotifier(config) {
  return async function notifyFailure(job, reason) {
    try {
      const settings = readEnvFile(envFileOf(findProject(config, job.app)));
      if (!settings.SLACK_BOT_TOKEN || !settings.SLACK_CHANNEL_ID) return;

      await fetch('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${settings.SLACK_BOT_TOKEN}`,
          'Content-Type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify({
          channel: settings.SLACK_CHANNEL_ID,
          text: `:warning: NR monitor could not run for ${job.app}: ${reason}`,
        }),
      });
    } catch {
      // A failed notification must never stop the service.
    }
  };
}

// Reads KEY=value lines from a .env file.
function readEnvFile(path) {
  const settings = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?(.*?)"?\s*$/);
    if (match) settings[match[1]] = match[2];
  }
  return settings;
}
