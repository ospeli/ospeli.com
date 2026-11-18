// AUDIT: finishing a walk is not one atomic step. Two finishes at once (two tabs, two devices on a
// site server, a retry) each make a map; a tap that lands between the read and the write is lost.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Core } from '../../web/app/core/core.js';
import { MemoryAdapter } from '../../web/app/core/db.js';
import { runCommand } from '../../web/app/core/commands.js';

const START = '2026-11-16T09:00:00.000Z';
const human = { type: 'human', role: 'ops-manager' };
async function setup() {
  let t = Date.parse(START);
  const core = await Core.open({ adapter: new MemoryAdapter(), clock: () => new Date(t) });
  const tick = (s) => { t += s * 1000; };
  const tap = (name, input = {}) => runCommand(core, name, input, human);
  await tap('ospeli_walks_start', { title: 'Morning clinic visit' });
  tick(10); await tap('ospeli_walks_step_start');
  tick(20); await tap('ospeli_walks_step_done');
  return { core, tick, tap };
}

test('two finishes at the same moment make one map, not two', async () => {
  const { core, tap } = await setup();
  const results = await Promise.allSettled([tap('ospeli_walks_finish'), tap('ospeli_walks_finish')]);
  const maps = (await core.getMeta('process-maps')).maps;
  assert.equal(maps.length, 1, `one walk became ${maps.length} maps (${results.map((r) => r.status).join(', ')})`);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1, 'the second finish is refused');
});

test('a walk deleted while it is being finished does not also become a map', async () => {
  const { core, tap } = await setup();
  const results = await Promise.allSettled([tap('ospeli_walks_finish'), tap('ospeli_walks_discard')]);
  const maps = (await core.getMeta('process-maps'))?.maps || [];
  const walk = (await core.getMeta('process-walks')).walks[0];
  const ok = results.filter((r) => r.status === 'fulfilled').length;
  assert.equal(ok, 1, `finish and delete both said "done" (walk is now ${walk.status}, ${maps.length} map(s))`);
});

test('a step started while the walk is being finished is not lost', async () => {
  const { core, tap } = await setup();
  const results = await Promise.allSettled([tap('ospeli_walks_finish'), tap('ospeli_walks_step_start')]);
  const walk = (await core.getMeta('process-walks')).walks[0];
  assert.ok(!(walk.status === 'finished' && walk.current), `the walk is finished with a step still running (${results.map((r) => r.status).join(', ')})`);
});
