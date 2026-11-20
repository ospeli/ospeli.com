// Audit finding: each wait and each step is rounded to whole seconds on its own, so with real taps
// (which are never on the whole second) the parts do not add up to start to finish. The walk's own
// totals then disagree with themselves (waiting + hands-on + not seen != elapsedSec), and the map's
// "start to finish" (ospeli_maps_summary elapsedSec, the headline on the map screen) is not the time
// between the walk's stored startedAt and finishedAt. Every existing test ticks in whole seconds.
// Synthetic taps; the clock is moved by hand.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Core } from '../../web/app/core/core.js';
import { MemoryAdapter } from '../../web/app/core/db.js';
import { runCommand } from '../../web/app/core/commands.js';

const START = '2026-11-16T09:00:00.000Z';
const human = { type: 'human', role: 'ops-manager' };

test('with taps between whole seconds, waiting + hands-on + not seen is still start to finish', async () => {
  let t = Date.parse(START);
  const core = await Core.open({ adapter: new MemoryAdapter(), clock: () => new Date(t) });
  const tap = (name, input = {}) => runCommand(core, name, input, human);
  await tap('ospeli_walks_start');
  for (let i = 0; i < 6; i++) { t += 40500; await tap('ospeli_walks_step_start'); t += 61500; await tap('ospeli_walks_step_done'); }
  const done = await tap('ospeli_walks_finish');
  const real = Math.round((Date.parse(done.walk.finishedAt) - Date.parse(done.walk.startedAt)) / 1000); // 612
  const tot = done.walk.totals;
  assert.equal(tot.elapsedSec, real);
  assert.equal(tot.workSec + tot.waitSec + (tot.notSeenSec || 0), tot.elapsedSec, 'the walk: waiting + hands-on + not seen = start to finish');
  const sum = await tap('ospeli_maps_summary', { mapId: done.mapId });
  assert.equal(sum.today.elapsedSec, real, 'the map: start to finish is the time between the first and the last tap');
});
