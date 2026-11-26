// Loads and checks the service settings (service/projects.json).

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVICE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_PATTERN = /^[\w.-]+\/[\w.-]+$/; // owner/repo
const MIN_SECRET_LENGTH = 16;

/**
 * Reads projects.json and returns the settings with defaults filled in.
 * Throws a clear error when something required is missing.
 */
export function loadConfig() {
  const configPath = process.env.NR_MONITOR_CONFIG || join(SERVICE_DIR, 'projects.json');
  const file = JSON.parse(readFileSync(configPath, 'utf8'));

  const config = {
    port: Number(process.env.PORT || file.port || 8787),
    secret: process.env.NR_MONITOR_SECRET || file.secret,
    scheduleHours: Number(file.scheduleHours ?? 12),
    timeoutMinutes: Number(file.timeoutMinutes ?? 45),
    maxTurns: Number(file.maxTurns ?? 200),
    logDir: file.logDir || join(SERVICE_DIR, 'logs'),
    dryRun: process.env.NR_MONITOR_DRY_RUN === '1',
    projects: file.projects || [],
  };

  if (!config.secret || config.secret.length < MIN_SECRET_LENGTH) {
    throw new Error(`Set a secret of at least ${MIN_SECRET_LENGTH} characters ("secret" in projects.json).`);
  }
  for (const project of config.projects) {
    if (!project.app) throw new Error('Every project needs an "app" (its New Relic app name).');
    if (!REPO_PATTERN.test(project.repo || '')) throw new Error(`Project "${project.app}": "repo" must look like owner/repo.`);
  }
  return config;
}

/** Finds the project for a New Relic app name, or undefined. */
export function findProject(config, appName) {
  return config.projects.find((project) => project.app === appName);
}

/** Path of a project's settings file (New Relic + Slack keys). Kept on the server only. */
export function envFileOf(project) {
  return project.envFile || join(SERVICE_DIR, 'envs', `${project.app}.env`);
}

/** Names of projects whose settings file is missing. */
export function projectsWithoutEnvFile(config) {
  return config.projects.filter((project) => !existsSync(envFileOf(project))).map((project) => project.app);
}
