// Audit: undo of "Step done" drops the step's name but keeps typed: true, so a step with no
// typed name (unnamed, or named from the offered words by a later tap path) is exported as typed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './walk-177-helper.mjs';

test('a step whose typed name was dropped by undo is not marked typed', async () => {
  const x = await setup();
  await x.tap('ospeli_walks_start', { guidanceSeen: true });
  x.tick(30); await x.tap('ospeli_walks_step_start'); x.tick(60);
  await x.tap('ospeli_walks_step_done');
  await x.tap('ospeli_walks_step_name', { name: 'Sorted the folder', role: 'Clerk', typed: true });
  const u = (await x.tap('ospeli_walks_undo')).walk;                // the step runs again, its name dropped
  assert.equal(u.state, 'step');
  x.tick(30);
  const w = (await x.tap('ospeli_walks_step_done')).walk;            // ends, left unnamed ("Name it later")
  assert.equal(w.steps[0].name, 'Step 1');
  assert.equal(w.steps[0].typed, undefined, '"Step 1" was never typed by anyone');
});
