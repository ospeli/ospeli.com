// Audit: a step stopped twice, both stops answered; undoing the second stop loses the first answer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './walk-177-helper.mjs';

test('undoing a second interruption keeps the answer given for the first', async () => {
  const x = await setup();
  await x.tap('ospeli_walks_start', { guidanceSeen: true });
  x.tick(30); await x.tap('ospeli_walks_step_start'); x.tick(60);
  await x.tap('ospeli_walks_step_done', { interrupted: true });
  await x.tap('ospeli_walks_reason', { of: 'stop', reason: 'staff-busy' });
  x.tick(60); await x.tap('ospeli_walks_step_start', { resume: true }); x.tick(60);
  await x.tap('ospeli_walks_step_done', { interrupted: true });
  await x.tap('ospeli_walks_reason', { of: 'stop', reason: 'transport' }); // second stop answered
  await x.tap('ospeli_walks_undo');                                         // second stop was a wrong tap
  x.tick(5);
  const w = (await x.tap('ospeli_walks_step_done')).walk;
  assert.equal(w.steps[0].interruptions, 1);
  assert.equal(w.steps[0].stopReason, 'staff-busy', 'the first stop was answered "staff-busy"');
});
