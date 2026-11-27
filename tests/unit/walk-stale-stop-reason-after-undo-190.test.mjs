// Audit: a stop reason given for an interruption that was then undone stays on the step, is
// taken as the answer for a later, different interruption, and that later stop is never asked about.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './walk-177-helper.mjs';

test('an undone interruption does not leave its reason on a later interruption', async () => {
  const x = await setup();
  await x.tap('ospeli_walks_start', { guidanceSeen: true });
  x.tick(30); await x.tap('ospeli_walks_step_start'); x.tick(60);
  await x.tap('ospeli_walks_step_done', { interrupted: true });   // wrong tap
  await x.tap('ospeli_walks_reason', { of: 'stop', reason: 'staff-busy' });
  await x.tap('ospeli_walks_undo');                                // taken back: the step runs again, never stopped
  x.tick(120);
  const w = (await x.tap('ospeli_walks_step_done', { interrupted: true })).walk; // a real, different stop
  assert.deepEqual(w.askReason, { of: 'stop' }, 'the real interruption should be asked about');
  assert.equal(w.steps[0].stopReason, undefined, 'the answer for the undone tap should not stand for this stop');
});
