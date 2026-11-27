// Checks the per-project GitHub token helpers. No network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { githubEnv, hideToken } from '../src/github.js';

const TOKEN = 'ghp_exampleExampleExample1234';

test('no token: nothing changes (server default login is used)', () => {
  assert.deepEqual(githubEnv(''), {});
  assert.equal(hideToken('some error', ''), 'some error');
});

test('token: gh and git are both told to use it, server login ignored', () => {
  const env = githubEnv(TOKEN);
  assert.equal(env.GH_TOKEN, TOKEN);
  assert.equal(env.GIT_CONFIG_KEY_0, 'credential.helper');
  assert.equal(env.GIT_CONFIG_VALUE_0, '');
  assert.equal(env.GIT_CONFIG_KEY_1, 'http.https://github.com/.extraheader');
  const basic = Buffer.from(`x-access-token:${TOKEN}`).toString('base64');
  assert.equal(env.GIT_CONFIG_VALUE_1, `AUTHORIZATION: basic ${basic}`);
});

test('token is hidden in error text, in plain and base64 form', () => {
  const basic = Buffer.from(`x-access-token:${TOKEN}`).toString('base64');
  const text = `fatal: auth failed for ${TOKEN} header ${basic}`;
  const safe = hideToken(text, TOKEN);
  assert.ok(!safe.includes(TOKEN));
  assert.ok(!safe.includes(basic));
  assert.match(safe, /<token>.*<token>/);
});
