// Audit finding: "Utility outage hours" rounds the total and each utility's hours to one decimal
// place separately, so the lines under the total do not add up to it: two outages of 15 minutes
// show as 0.3 h + 0.3 h under a total of 0.5 h. Synthetic site; the clock is moved by hand.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Core } from '../../web/app/core/core.js';
import { MemoryAdapter } from '../../web/app/core/db.js';
import { loadSyntheticHospital } from '../../web/app/core/generator.js';
import { runCommand } from '../../web/app/core/commands.js';

const END = '2026-11-19T14:00:00.000Z';

test('the hours shown for each utility add up to the total shown', async () => {
  let t = Date.parse(END);
  const core = await Core.open({ adapter: new MemoryAdapter(), clock: () => new Date(t) });
  await loadSyntheticHospital(core, { end: END, modules: false });
  const run = (name, input, role) => runCommand(core, name, input, { type: 'human', role });
  for (const utility of ['power', 'water']) {
    const o = await run('ospeli_facilities_outage_start', { utility, placeId: 'bld-main-a', cause: 'not-known', startedMinutesAgo: 15 }, 'estates-tech');
    await run('ospeli_facilities_outage_end', { outageId: o.outageId }, 'estates-tech');
  }
  const k = (await run('ospeli_facilities_overview', {}, 'facilities-manager')).kpis.find((x) => x.id === 'utility-outage-hours');
  const lines = k.breakdown.reduce((n, b) => n + b.hours, 0);
  assert.equal(Math.round(lines * 10) / 10, k.value, `the lines (${k.breakdown.filter((b) => b.outages).map((b) => `${b.name} ${b.hours} h`).join(' + ')}) against the total ${k.value} h`);
});

// ospeli/ospeli#140 part 2, as fixed: the screen shows whole minutes, and the lines add up to the total exactly.
test('#140: outage time is given in whole minutes per utility, and they add up to the total minutes', async () => {
  let t = Date.parse(END);
  const core = await Core.open({ adapter: new MemoryAdapter(), clock: () => new Date(t) });
  await loadSyntheticHospital(core, { end: END, modules: false });
  const run = (name, input, role) => runCommand(core, name, input, { type: 'human', role });
  for (const [utility, mins] of [['power', 15], ['water', 15], ['power', 60]]) {
    const o = await run('ospeli_facilities_outage_start', { utility, placeId: 'bld-main-a', cause: 'not-known', startedMinutesAgo: mins }, 'estates-tech');
    await run('ospeli_facilities_outage_end', { outageId: o.outageId }, 'estates-tech');
    t += 60e3 * 60;
  }
  const k = (await run('ospeli_facilities_overview', {}, 'facilities-manager')).kpis.find((x) => x.id === 'utility-outage-hours');
  const byId = Object.fromEntries(k.breakdown.map((b) => [b.id, b.minutes]));
  assert.ok(Math.abs(byId.power - 75) <= 1 && Math.abs(byId.water - 15) <= 1, JSON.stringify(byId));
  assert.equal(k.minutes, k.breakdown.reduce((n, b) => n + b.minutes, 0));
  for (const b of k.breakdown) assert.ok(Number.isInteger(b.minutes));
});
