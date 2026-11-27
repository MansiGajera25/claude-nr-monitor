// Posts a warning to the project's Slack channel when a run fails (for example, the Claude login expired).

import { findProject, readProjectSettings } from './config.js';

export function createFailureNotifier(config) {
  return async function notifyFailure(job, reason) {
    try {
      const settings = readProjectSettings(findProject(config, job.app));
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
