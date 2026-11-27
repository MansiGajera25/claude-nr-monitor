// Does one run: download the project, start Claude in it, delete the copy.

import { mkdtempSync, rmSync, writeFileSync, appendFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { envFileOf, readProjectSettings } from './config.js';
import { githubEnv, hideToken } from './github.js';
import { log } from './logger.js';

const CLONE_DEPTH = '50';
const INSTALL_TIMEOUT_MS = 15 * 60 * 1000;

/** Returns the function the queue calls for each job. */
export function createRunner(config) {
  return async function runJob(job) {
    const project = config.projects.find((p) => p.app === job.app);
    const prompt = buildPrompt(job, config);
    log(`start: ${job.app} (${project.repo}) — ${prompt}`);

    if (config.dryRun) {
      log('dry run: nothing downloaded, Claude not started');
      return;
    }

    // The project's own GitHub token (client repos), or none = the server's default login.
    const token = readProjectSettings(project).GITHUB_TOKEN || '';
    const runEnv = { ...process.env, ...githubEnv(token) };
    if (token) log(`using the project's own GitHub token for ${job.app}`);

    const workDir = mkdtempSync(join(tmpdir(), 'nr-monitor-'));
    try {
      const projectDir = downloadProject(project, workDir, runEnv, token);
      await runClaude({ config, job, prompt, projectDir, runEnv });
    } finally {
      rmSync(workDir, { recursive: true, force: true });
      log(`deleted temporary copy of ${job.app}`);
    }
  };
}

// What Claude is asked to do: check one alert, or the last N hours.
function buildPrompt(job, config) {
  return job.kind === 'alert'
    ? `/nr-monitor:check ${job.alertText}`
    : `/nr-monitor:check ${config.scheduleHours} hours ago`;
}

// Step 1: fresh copy of the project + its settings file + its packages.
function downloadProject(project, workDir, runEnv, token) {
  const projectDir = join(workDir, 'repo');
  try {
    execFileSync('git', [
      'clone', '-q', '--depth', CLONE_DEPTH, '--branch', project.branch || 'main',
      `https://github.com/${project.repo}.git`, projectDir,
    ], { stdio: 'pipe', env: runEnv });

    writeFileSync(join(projectDir, '.env'), settingsWithoutToken(project));

    if (project.install) {
      execFileSync('bash', ['-c', project.install], { cwd: projectDir, stdio: 'pipe', timeout: INSTALL_TIMEOUT_MS });
    }
  } catch (error) {
    const stderr = String(error.stderr || '').trim();
    const details = hideToken(stderr || error.message, token).slice(0, 300);
    throw new Error(`could not prepare ${project.repo}: ${details}`);
  }
  log(`downloaded ${project.repo} to a temporary folder`);
  return projectDir;
}

// The project's .env for the copy, without GITHUB_TOKEN (Claude gets it from the environment instead,
// so it is never in a file inside the project folder).
function settingsWithoutToken(project) {
  return readFileSync(envFileOf(project), 'utf8')
    .split('\n')
    .filter((line) => !/^\s*(?:export\s+)?GITHUB_TOKEN\s*=/.test(line))
    .join('\n');
}

// Step 2: start Claude in the project folder and wait until it finishes.
function runClaude({ config, job, prompt, projectDir, runEnv }) {
  const args = ['-p', prompt, '--permission-mode', 'bypassPermissions', '--max-turns', String(config.maxTurns)];
  const outputFile = join(config.logDir, `${safeName(job.app)}-${Date.now()}.log`);

  return new Promise((resolve, reject) => {
    const claude = spawn('claude', args, { cwd: projectDir, env: runEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    const stopTimer = setTimeout(() => claude.kill('SIGTERM'), config.timeoutMinutes * 60 * 1000);

    claude.stdout.on('data', (chunk) => appendFileSync(outputFile, chunk));
    claude.stderr.on('data', (chunk) => appendFileSync(outputFile, chunk));

    claude.on('close', (exitCode) => {
      clearTimeout(stopTimer);
      log(`done: ${job.app} exit ${exitCode} — log ${outputFile}`);
      if (exitCode === 0) return resolve();
      reject(new Error(explainFailure(outputFile, exitCode)));
    });
  });
}

// Turn a failed run into a message people can act on.
function explainFailure(outputFile, exitCode) {
  const lastLines = readFileSync(outputFile, 'utf8').slice(-400);
  if (/log ?in|login|auth|unauthori[sz]ed/i.test(lastLines)) {
    return 'Claude is not logged in on the service machine — run `claude` there and log in again.';
  }
  return `claude exited ${exitCode}`;
}

function safeName(text) {
  return text.replace(/[^\w.-]/g, '_');
}
