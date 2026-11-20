// Audit finding: clockMoved() compares step taps with each other and a pause only with the start of
// the walk. A Pause tapped after the device clock was set back is stamped earlier than the tap
// before it, is not noticed, and its "not seen" time is then taken out of an EARLIER step.
// Synthetic taps; the clock is moved by hand.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Core } from '../../web/app/core/core.js';
import { MemoryAdapter } from '../../web/app/core/db.js';
import { runCommand } from '../../web/app/core/commands.js';

const START = '2026-11-16T09:00:00.000Z';
const human = { type: 'human', role: 'ops-manager' };

test('a pause stamped earlier than the tap before it is a clock that moved back, and takes nothing out of an earlier step', async () => {
  let t = Date.parse(START);
  const core = await Core.open({ adapter: new MemoryAdapter(), clock: () => new Date(t) });
  const tick = (s) => { t += s * 1000; };
  const tap = (name, input = {}) => runCommand(core, name, input, human);
  await tap('ospeli_walks_start');
  tick(60); await tap('ospeli_walks_step_start');     // 09:01:00
  tick(600); await tap('ospeli_walks_step_done');     // 09:11:00, ten minutes hands-on, all of it watched
  tick(-300);                                         // the phone's clock is set back five minutes
  tick(10); await tap('ospeli_walks_pause');          // stamped 09:06:10, before the tap before it
  tick(30); await tap('ospeli_walks_resume');         // 09:06:40
  tick(290); await tap('ospeli_walks_step_start');    // 09:11:30: the step taps alone still run forward
  tick(60); const out = await tap('ospeli_walks_step_done');
  assert.equal(out.walk.clockMoved, true, 'the Pause tap was stamped earlier than the Step done tap before it');
  assert.equal(out.walk.steps[0].workNotSeenSec ?? 0, 0, 'nobody paused during step 1, so none of it is "not seen"');
  const done = await tap('ospeli_walks_finish');
  const map = await tap('ospeli_maps_get', { mapId: done.mapId });
  assert.equal(map.walk.clockMoved, true, 'the map says its times cannot be relied on');
});
