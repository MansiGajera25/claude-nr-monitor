#!/usr/bin/env node
// nr-monitor service — start here.
//
// A very small server that receives New Relic alerts and starts Claude Code (with the nr-monitor plugin)
// for the right project. Every run downloads the project into a temporary folder and deletes it after.
// It also checks every project every 12 hours. No dependencies: Node 18+ only.
//
//   cd service && npm start        (or: npm run dry-run — no download, no Claude)
//
// Files:
//   src/config.js   read projects.json, find a project, find its settings file
//   src/http.js     POST /alert (from New Relic) and GET /health
//   src/alerts.js   decide whether an alert should start Claude
//   src/queue.js    run one job at a time
//   src/runner.js   download project → run Claude → delete copy
//   src/notify.js   Slack warning when a run fails
//   src/logger.js   log lines

import { loadConfig, projectsWithoutEnvFile } from './src/config.js';
import { setupLogger, log } from './src/logger.js';
import { setupQueue, addJob } from './src/queue.js';
import { createRunner } from './src/runner.js';
import { createFailureNotifier } from './src/notify.js';
import { startHttpServer } from './src/http.js';

const config = loadConfig();
setupLogger(config.logDir);

for (const app of projectsWithoutEnvFile(config)) {
  log(`warning: no settings file for ${app} — create service/envs/${app}.env`);
}

setupQueue({ run: createRunner(config), onError: createFailureNotifier(config) });
startHttpServer(config);

// Every N hours: a check for every project.
if (config.scheduleHours > 0) {
  setInterval(() => {
    for (const project of config.projects) addJob({ app: project.app, kind: 'scheduled' });
  }, config.scheduleHours * 60 * 60 * 1000);
}
