// Issue ospeli/ospeli#177 (security and audit review, 23 Nov), test written by that review; fixed by the Builder 25 Nov.
// Review finding: after "Step carries on" the walk screen's big clock reads "Hands-on" with the
// time since the step FIRST started, less only the time not seen. The time the step stood still
// (which the record counts as waiting) is shown as hands-on. The screen computes
//   shown = (now - walk.presentSince) - walk.sinceNotSeenSec      (modules/walk.js, shown())
// and walkView gives it the first start as presentSince and nothing to take the stop out with.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './walk-177-helper.mjs';

test('ten seconds after carrying on, the clock for the running step shows its hands-on time, not the stop as well', async () => {
  const x = await setup();
  await x.tap('ospeli_walks_start', { guidanceSeen: true });
  x.tick(60); await x.tap('ospeli_walks_step_start'); x.tick(120);
  await x.tap('ospeli_walks_step_done', { interrupted: true });
  x.tick(300); await x.tap('ospeli_walks_step_start', { resume: true });
  x.tick(10);
  const got = await x.tap('ospeli_walks_get');
  const w = got.walk;
  assert.equal(w.state, 'step');
  const shown = (Date.parse(got.now) - Date.parse(w.presentSince || w.since)) / 1000 - (w.sinceNotSeenSec || 0) - (w.sinceStoodSec || 0);
  // Hands-on so far: 120 s before the interruption and 10 s since carrying on. The 300 s it stood still is waiting.
  assert.equal(shown, 130, 'the hands-on clock counts the 300 s the step stood still');
});

test('#177 item 3: a pause while the step stood still is taken off once, not twice', async () => {
  const x = await setup();
  await x.tap('ospeli_walks_start', { guidanceSeen: true });
  x.tick(60); await x.tap('ospeli_walks_step_start'); x.tick(120);
  await x.tap('ospeli_walks_step_done', { interrupted: true });
  x.tick(100); await x.tap('ospeli_walks_pause'); x.tick(50); await x.tap('ospeli_walks_resume'); x.tick(150);
  await x.tap('ospeli_walks_step_start', { resume: true });
  x.tick(10);
  const got = await x.tap('ospeli_walks_get');
  const w = got.walk;
  const shown = (Date.parse(got.now) - Date.parse(w.presentSince)) / 1000 - w.sinceNotSeenSec - w.sinceStoodSec;
  assert.equal(shown, 130, 'hands-on: 120 s before the stop and 10 s since carrying on');
});
