// Security and audit, 21 Nov: a meal count tapped twice is one record, whatever else was logged in between. Synthetic data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Core } from '../../web/app/core/core.js';
import { MemoryAdapter } from '../../web/app/core/db.js';
import { loadSyntheticHospital } from '../../web/app/core/generator.js';
import { runCommand } from '../../web/app/core/commands.js';

const END = '2026-11-06T18:00:00.000Z'; // 14:00 at the example hospital (UTC-4)
const MIN = 60e3;
const human = (role) => ({ type: 'human', role });
async function site() {
  let t = Date.parse(END);
  const core = await Core.open({ adapter: new MemoryAdapter(), clock: () => new Date(t += 1000) });
  await loadSyntheticHospital(core, { end: END });
  const run = (name, input, who) => runCommand(core, name, input, typeof who === 'string' ? human(who) : who);
  return { core, run, advance: (m) => { t += m * MIN; } };
}

test('a double tap on a meal count is refused even when a backdated record from another module lands in between', async () => {
  const { core, run } = await site();
  const meal = { wardId: 'ward-a1', meal: 'midday', ordered: 20, delivered: 19, returned: 3 };
  await run('ospeli_support_meals_record', meal, 'ward-nurse');
  // Someone on the same device logs a waste collection noticed an hour ago (backdated).
  await run('ospeli_facilities_waste_record', { placeId: 'bld-main-a', stream: 'general', outcome: 'collected', containers: 3, minutesAgo: 60 }, 'facilities-assistant');
  const n = (await core.events({ type: 'support.meals-recorded' })).length;
  let refused = false;
  try { await run('ospeli_support_meals_record', meal, 'ward-nurse'); } catch (e) { refused = e.code === 'conflict'; }
  const m = (await core.events({ type: 'support.meals-recorded' })).length;
  assert.ok(refused && m === n, `the same numbers seconds later were saved again as a correction (${m - n} new record)`);
});
