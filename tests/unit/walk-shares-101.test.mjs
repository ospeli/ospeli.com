// Audit finding: ospeli_maps_summary gives workShare and waitShare for a walked map, both "as a % of
// the time seen", each rounded on its own. When the split falls on a half per cent both round up and
// the two shares add up to 101 %. Synthetic taps; the clock is moved by hand.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Core } from '../../web/app/core/core.js';
import { MemoryAdapter } from '../../web/app/core/db.js';
import { runCommand } from '../../web/app/core/commands.js';

const START = '2026-11-16T09:00:00.000Z';
const human = { type: 'human', role: 'ops-manager' };

test('waiting share and hands-on share of the time seen add up to 100 %', async () => {
  let t = Date.parse(START);
  const core = await Core.open({ adapter: new MemoryAdapter(), clock: () => new Date(t) });
  const tap = (name, input = {}) => runCommand(core, name, input, human);
  await tap('ospeli_walks_start');
  t += 210e3; await tap('ospeli_walks_step_start');   // 210 s waiting
  t += 30e3; await tap('ospeli_walks_step_done');     // 30 s hands-on: 87.5 % and 12.5 %
  const { mapId } = await tap('ospeli_walks_finish');
  const s = (await tap('ospeli_maps_summary', { mapId })).today;
  assert.equal(s.waitShare + s.workShare, 100, `waitShare ${s.waitShare} + workShare ${s.workShare}`);
});
