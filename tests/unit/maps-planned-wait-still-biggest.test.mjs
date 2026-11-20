// Audit finding: a wait marked planned or required "is left out of the longest wait"
// (ospeli_maps_step_update, plannedWait). That holds only in ospeli_maps_summary on a walked map:
//   1. on a map that was not walked the mark is accepted and the same wait is still the biggest wait;
//   2. on a walked map ospeli_maps_get still names the planned wait in today.statsSec.biggestWaitStepId
//      (and ignores the 30 second floor), so two reads of one map give two different answers.
// Synthetic maps and taps; the clock is moved by hand.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Core } from '../../web/app/core/core.js';
import { MemoryAdapter } from '../../web/app/core/db.js';
import { runCommand, CommandError } from '../../web/app/core/commands.js';

const START = '2026-11-16T09:00:00.000Z';
const human = { type: 'human', role: 'ops-manager' };
async function setup() {
  let t = Date.parse(START);
  const core = await Core.open({ adapter: new MemoryAdapter(), clock: () => new Date(t) });
  return { tap: (name, input = {}) => runCommand(core, name, input, human), tick: (s) => { t += s * 1000; } };
}

test('on a map that was not walked, a wait marked planned is not named as the biggest wait (or the mark is refused)', async () => {
  const { tap } = await setup();
  const { mapId } = await tap('ospeli_maps_create', { from: 'discharge' });
  const before = (await tap('ospeli_maps_summary', { mapId })).biggestWait;
  try { await tap('ospeli_maps_step_update', { mapId, stepId: before.stepId, plannedWait: true }); } catch (err) { assert.ok(err instanceof CommandError); return; }
  const after = (await tap('ospeli_maps_summary', { mapId })).biggestWait;
  assert.notEqual(after?.stepId, before.stepId, 'the wait was marked planned or required, and is still named as the biggest wait');
});

test('on a walked map, ospeli_maps_get and ospeli_maps_summary name the same longest wait', async () => {
  const { tap, tick } = await setup();
  await tap('ospeli_walks_start');
  tick(100); await tap('ospeli_walks_step_start'); tick(50); await tap('ospeli_walks_step_done');
  tick(40); await tap('ospeli_walks_step_start'); tick(50); await tap('ospeli_walks_step_done');
  const { mapId } = await tap('ospeli_walks_finish');
  const first = (await tap('ospeli_maps_get', { mapId })).today.steps[0].id;
  await tap('ospeli_maps_step_update', { mapId, stepId: first, plannedWait: true }); // the 100 s wait is planned
  const sum = await tap('ospeli_maps_summary', { mapId });
  const got = await tap('ospeli_maps_get', { mapId });
  assert.notEqual(sum.today.biggestWaitStepId, first, 'the summary leaves the planned wait out');
  assert.equal(got.today.statsSec.biggestWaitStepId, sum.today.biggestWaitStepId, 'ospeli_maps_get names a different longest wait from ospeli_maps_summary');
});
