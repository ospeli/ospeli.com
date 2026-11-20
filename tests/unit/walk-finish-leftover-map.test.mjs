// Audit finding: the finish retry fix (#129) writes the map before the walk. When the walk's own
// write fails, the map is left behind as a live map while the walk is still open. Two things follow:
//   1. deleting the walk ("its taps are not kept") leaves that map, with the taps, in the list;
//   2. anything a person changes on that map before finishing again is thrown away by the retry,
//      which builds the map again in place (its revision goes back to 1).
// Synthetic taps; the clock is moved by hand.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Core } from '../../web/app/core/core.js';
import { MemoryAdapter } from '../../web/app/core/db.js';
import { runCommand } from '../../web/app/core/commands.js';

const START = '2026-11-16T09:00:00.000Z';
const human = { type: 'human', role: 'ops-manager' };
async function failedFinish() {
  let t = Date.parse(START);
  const adapter = new MemoryAdapter();
  const core = await Core.open({ adapter, clock: () => new Date(t) });
  const tap = (name, input = {}) => runCommand(core, name, input, human);
  await tap('ospeli_walks_start', { title: 'Morning clinic visit' });
  t += 60e3; await tap('ospeli_walks_step_start');
  t += 60e3; await tap('ospeli_walks_step_done');
  const put = adapter.put.bind(adapter);
  let failed = false;
  adapter.put = async (store, record) => {
    if (!failed && store === 'meta' && record.id === 'process-walks') { failed = true; const e = new Error('The quota has been exceeded.'); e.name = 'QuotaExceededError'; throw e; }
    return put(store, record);
  };
  await assert.rejects(tap('ospeli_walks_finish'), { name: 'QuotaExceededError' });
  return { core, tap };
}

test('a walk deleted after a failed finish leaves no map of it behind', async () => {
  const { core, tap } = await failedFinish();
  await tap('ospeli_walks_discard'); // "Delete the walk in progress without making a map. Its taps are not kept."
  const maps = (await core.getMeta('process-maps')).maps;
  assert.equal(maps.length, 0, `the walk was deleted, but ${maps.map((m) => m.id).join(', ')} made from it is still in the list`);
});

test('what a person changed on the left-behind map is still there after the finish is tried again', async () => {
  const { tap } = await failedFinish();
  const left = (await tap('ospeli_maps_list')).maps[0];
  assert.ok(left, 'the map from the failed finish is in the list, where a person can open and change it');
  const stepId = (await tap('ospeli_maps_get', { mapId: left.id })).today.steps[0].id;
  await tap('ospeli_maps_step_update', { mapId: left.id, stepId, name: 'Checked in at reception', role: 'Reception' });
  await tap('ospeli_walks_finish'); // the person taps Finish again
  const step = (await tap('ospeli_maps_get', { mapId: left.id })).today.steps[0];
  assert.equal(step.name, 'Checked in at reception', 'the name a person gave the step was thrown away by the second finish');
});
