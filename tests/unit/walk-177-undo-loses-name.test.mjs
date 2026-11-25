// Issue ospeli/ospeli#177 (security and audit review, 23 Nov), test written by that review; fixed by the Builder 25 Nov.
// Review finding: a step named when it was interrupted keeps that name when it carries on and is
// marked done. "Undo last tap" on that done tap and then "Step done" again saves the same step
// with no name and no role: undoLast rebuilds the running step without the name it carried.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './walk-177-helper.mjs';

test('undoing "Step done" on a step that carried on keeps the name given at the interruption', async () => {
  const x = await setup();
  await x.tap('ospeli_walks_start', { guidanceSeen: true });
  x.tick(60); await x.tap('ospeli_walks_step_start'); x.tick(120);
  await x.tap('ospeli_walks_step_done', { interrupted: true });
  await x.tap('ospeli_walks_step_name', { name: 'Scan', role: 'Imaging staff' });
  x.tick(300); await x.tap('ospeli_walks_step_start', { resume: true }); x.tick(180);
  let w = (await x.tap('ospeli_walks_step_done')).walk;
  assert.deepEqual([w.steps[0].name, w.steps[0].role, w.steps[0].named], ['Scan', 'Imaging staff', true], 'control: named after the first done');
  x.tick(3);
  w = (await x.tap('ospeli_walks_undo')).walk;
  assert.equal(w.state, 'step');
  x.tick(5);
  w = (await x.tap('ospeli_walks_step_done')).walk;
  assert.deepEqual([w.steps[0].name, w.steps[0].role, w.steps[0].named], ['Scan', 'Imaging staff', true], 'the name and role given at the interruption were lost by the undo');
});
