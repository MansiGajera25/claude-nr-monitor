// Checks the order in which the queue runs jobs. No server, no Claude: a fake run function records the order.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupQueue, addJob } from '../src/queue.js';

test('alerts run before waiting scheduled checks, in arrival order', async () => {
  const order = [];
  let finishFirst;
  const firstJobDone = new Promise((resolve) => { finishFirst = resolve; });
  let allDone;
  const finished = new Promise((resolve) => { allDone = resolve; });

  setupQueue({
    run: async (job) => {
      order.push(`${job.kind}:${job.app}`);
      if (order.length === 1) await firstJobDone; // keep the first job busy so the others wait
      if (order.length === 6) allDone();
    },
    onError: async () => {},
  });

  addJob({ app: 'P1', kind: 'scheduled' }); // starts at once
  addJob({ app: 'P2', kind: 'scheduled' });
  addJob({ app: 'P3', kind: 'scheduled' });
  addJob({ app: 'P4', kind: 'alert' });     // jumps ahead of P2, P3
  addJob({ app: 'P5', kind: 'alert' });     // behind P4, still ahead of P2, P3
  addJob({ app: 'P6', kind: 'scheduled' }); // end of the line

  finishFirst();
  await finished;

  assert.deepEqual(order, [
    'scheduled:P1', 'alert:P4', 'alert:P5', 'scheduled:P2', 'scheduled:P3', 'scheduled:P6',
  ]);
});
