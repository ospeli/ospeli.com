// Finding: "finish is one storage step" holds only when both writes succeed. ospeli_walks_finish
// writes the map (setMeta) and then the walk (the put at the end of updateMeta) as two separate
// storage writes. If the second write fails (storage full on a phone), the map is kept and the
// walk stays open, so finishing again makes a second map of the same walk.
// Synthetic taps only; the clock is moved by hand.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Core } from '../../web/app/core/core.js';
import { MemoryAdapter } from '../../web/app/core/db.js';
import { runCommand } from '../../web/app/core/commands.js';

const START = '2026-11-16T09:00:00.000Z';
const human = { type: 'human', role: 'ops-manager' };
async function setup(adapter = new MemoryAdapter()) {
  let t = Date.parse(START);
  const clock = () => new Date(t);
  const core = await Core.open({ adapter, clock });
  const tick = (s) => { t += s * 1000; };
  const tap = (name, input = {}) => runCommand(core, name, input, human);
  await tap('ospeli_walks_start', { title: 'Morning clinic visit' });
  tick(10); await tap('ospeli_walks_step_start');
  tick(20); await tap('ospeli_walks_step_done');
  return { core, tap, adapter, clock };
}

test('a finish whose second write fails leaves no map behind, so a retry makes one map, not two', async () => {
  const { core, tap, adapter } = await setup();
  const put = adapter.put.bind(adapter);
  let failed = false;
  adapter.put = async (store, record) => {
    if (!failed && store === 'meta' && record.id === 'process-walks') { failed = true; const e = new Error('The quota has been exceeded.'); e.name = 'QuotaExceededError'; throw e; }
    return put(store, record);
  };
  await assert.rejects(tap('ospeli_walks_finish'), { name: 'QuotaExceededError' });
  assert.equal((await core.getMeta('process-walks')).walks[0].status, 'walking', 'the walk is still open, as the person was told');
  await tap('ospeli_walks_finish'); // the person taps Finish again
  const maps = (await core.getMeta('process-maps')).maps;
  assert.equal(maps.length, 1, `one walk became ${maps.length} maps (${maps.map((m) => m.id).join(', ')}) after one failed and one good finish`);
});
