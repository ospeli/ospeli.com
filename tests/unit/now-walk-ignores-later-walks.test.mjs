// Audit: home.js latestWalk says it uses "the same longest-wait rule as the map screen", but it
// reads ospeli_maps_summary, which works from the map's own step times (walk 1's). After a second
// walk whose longest wait was at another step, the Result tab says the longest wait moved; Now
// still names walk 1's step alone, with walk 1's time. Synthetic taps and step names only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Core } from '../../web/app/core/core.js';
import { MemoryAdapter } from '../../web/app/core/db.js';
import { runCommand } from '../../web/app/core/commands.js';
import { latestWalk } from '../../web/app/modules/home.js';
import { longestWalks } from '../../web/app/modules/result-words.js';

const NAMES = [['Checked in at reception', 'Reception'], ['Seen by a nurse', 'Nurse'], ['Seen by a doctor', 'Doctor'], ['Medicines collected', 'Pharmacy']];

test('Now: after a second walk whose longest wait moved, the line does not name walk 1\'s step alone', async () => {
  let t = Date.parse('2026-11-16T09:00:00.000Z');
  const core = await Core.open({ adapter: new MemoryAdapter(), clock: () => new Date(t) });
  const tick = (s) => { t += s * 1000; };
  const tap = (name, input = {}) => runCommand(core, name, input, { type: 'human', role: 'ops-manager' });
  const step = async (wait, work) => { tick(wait); await tap('ospeli_walks_step_start'); tick(work); return tap('ospeli_walks_step_done'); };
  await tap('ospeli_walks_start', { title: 'Morning clinic visit', guidanceSeen: true });
  const w1 = [[120, 180], [600, 240], [1500, 540], [300, 180]]; // longest: before the doctor (25 min)
  for (let i = 0; i < 4; i++) { await step(...w1[i]); await tap('ospeli_walks_step_name', { name: NAMES[i][0], role: NAMES[i][1] }); }
  const { mapId } = await tap('ospeli_walks_finish');
  t = Date.parse('2026-11-18T14:00:00.000Z');
  await tap('ospeli_walks_start', { mapId, guidanceSeen: true });
  for (const [wait, work] of [[60, 240], [2400, 300], [300, 480], [120, 120]]) await step(wait, work); // longest: before the nurse (40 min)
  await tap('ospeli_walks_finish');
  const rg = (await tap('ospeli_maps_get', { mapId })).range;
  const result = longestWalks(rg);
  assert.equal(result.lead, 'Longest wait moved: ', 'setup: the Result tab says the longest wait moved');
  const line = await latestWalk(tap);
  assert.doesNotMatch(line.text, /^longest wait 25 min before Seen by a doctor$/, `Now says "${line.text}"; Result says "${result.lead}${result.text}"`);
});
