// ospeli/ospeli#149: one walk has one start-to-finish figure everywhere. A walk with a pause gave
// 15 min 38 s on its map and 13 min 38 s in the list of maps; ospeli_maps_list and ospeli_maps_get
// left the paused time out, and the minute-rounded workShare read 0% on a walked map.
// Synthetic taps; the clock is moved by hand; the expected figures are recomputed from the taps.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Core } from '../../web/app/core/core.js';
import { MemoryAdapter } from '../../web/app/core/db.js';
import { runCommand, commandByName } from '../../web/app/core/commands.js';
import { validate } from '../../web/app/core/schema.js';

const human = { type: 'human', role: 'ops-manager' };

async function pausedWalk() {
  let t = Date.parse('2026-11-16T09:00:00.000Z');
  const core = await Core.open({ adapter: new MemoryAdapter(), clock: () => new Date(t) });
  const tick = (s) => { t += s * 1000; };
  const tap = (name, input = {}) => runCommand(core, name, input, human);
  await tap('ospeli_walks_start', { guidanceSeen: true });
  tick(30); await tap('ospeli_walks_step_start'); tick(20); await tap('ospeli_walks_step_done');
  await tap('ospeli_walks_step_name', { name: 'Booked in', role: 'Receptionist' });
  tick(10); await tap('ospeli_walks_pause'); tick(120); await tap('ospeli_walks_resume'); // 2 min not seen
  tick(25); await tap('ospeli_walks_step_start'); tick(15); await tap('ospeli_walks_step_done');
  await tap('ospeli_walks_step_name', { name: 'Seen by a nurse', role: 'Nurse' });
  const { mapId } = await tap('ospeli_walks_finish');
  // Start to finish from the taps: 30 + 20 + 10 + 120 + 25 + 15 = 220 s, of which 120 s not seen.
  return { tap, mapId, startToFinish: 220, notSeen: 120 };
}

test('#149: the list, the full map, the short map and the summary give the same start to finish', async () => {
  const { tap, mapId, startToFinish, notSeen } = await pausedWalk();
  const sum = await tap('ospeli_maps_summary', { mapId });
  assert.equal(sum.today.elapsedSec, startToFinish, 'ospeli_maps_summary');

  const list = await tap('ospeli_maps_list');
  assert.deepEqual(validate(commandByName('ospeli_maps_list').output, list, 'output'), []);
  const row = list.maps.find((m) => m.id === mapId);
  assert.equal(row.elapsedSecToday, startToFinish, `ospeli_maps_list says ${row.elapsedSecToday} s; the map says ${startToFinish} s`);

  for (const format of ['short', 'detailed']) {
    const map = await tap('ospeli_maps_get', { mapId, format });
    assert.deepEqual(validate(commandByName('ospeli_maps_get').output, map, 'output'), []);
    const s = map.today.statsSec;
    assert.equal(s.startToFinish, startToFinish, `ospeli_maps_get (${format}) startToFinish`);
    assert.equal(s.notSeenSec, notSeen);
    assert.equal(s.elapsed + s.notSeenSec, s.startToFinish, 'the observed time plus the time not seen is start to finish');
    // The minute-rounded share must not read 0% beside a seconds share that does not.
    assert.equal(map.today.stats.workShare, s.workShare, `stats.workShare ${map.today.stats.workShare} vs statsSec.workShare ${s.workShare}`);
    assert.ok(s.workShare > 0);
  }
});

test('#149: a walk with no pause is unchanged in every read', async () => {
  let t = Date.parse('2026-11-16T09:00:00.000Z');
  const core = await Core.open({ adapter: new MemoryAdapter(), clock: () => new Date(t) });
  const tap = (name, input = {}) => runCommand(core, name, input, human);
  await tap('ospeli_walks_start');
  t += 40000; await tap('ospeli_walks_step_start'); t += 60000; await tap('ospeli_walks_step_done');
  const { mapId } = await tap('ospeli_walks_finish');
  const row = (await tap('ospeli_maps_list')).maps.find((m) => m.id === mapId);
  const s = (await tap('ospeli_maps_get', { mapId, format: 'short' })).today.statsSec;
  assert.equal(row.elapsedSecToday, 100);
  assert.equal(s.startToFinish, 100); assert.equal(s.elapsed, 100); assert.equal(s.notSeenSec, 0);
});
