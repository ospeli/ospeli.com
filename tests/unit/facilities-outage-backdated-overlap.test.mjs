// Audit finding: an outage entered "N minutes ago" may start before the end of the outage before it
// (same utility, same place), so the same hours are counted twice in "Utility outage hours".
// ospeli_facilities_outage_end never lets an end go before its own start; the start has no such floor.
// Synthetic site; the clock is moved by hand.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Core } from '../../web/app/core/core.js';
import { MemoryAdapter } from '../../web/app/core/db.js';
import { loadSyntheticHospital } from '../../web/app/core/generator.js';
import { runCommand, CommandError } from '../../web/app/core/commands.js';

const END = '2026-11-19T14:00:00.000Z';
const MIN = 60e3;

test('a backdated outage start cannot overlap the outage before it: no hour is counted twice', async () => {
  let t = Date.parse(END);
  const core = await Core.open({ adapter: new MemoryAdapter(), clock: () => new Date(t) });
  await loadSyntheticHospital(core, { end: END, modules: false });
  const run = (name, input, role) => runCommand(core, name, input, { type: 'human', role });
  // Power is off in one building for two hours.
  const a = await run('ospeli_facilities_outage_start', { utility: 'power', placeId: 'bld-main-a', cause: 'not-known' }, 'estates-tech');
  t += 120 * MIN;
  await run('ospeli_facilities_outage_end', { outageId: a.outageId }, 'estates-tech');
  // Half an hour later it is off again; the person picks "4 hours ago" by mistake (or by a slip of the list).
  t += 30 * MIN;
  let b = null;
  try { b = await run('ospeli_facilities_outage_start', { utility: 'power', placeId: 'bld-main-a', cause: 'not-known', startedMinutesAgo: 240 }, 'estates-tech'); } catch (err) {
    assert.ok(err instanceof CommandError, 'a refusal is a fair answer'); return;
  }
  await run('ospeli_facilities_outage_end', { outageId: b.outageId }, 'estates-tech');
  const ov = await run('ospeli_facilities_overview', {}, 'facilities-manager');
  const hours = ov.kpis.find((k) => k.id === 'utility-outage-hours');
  // From the earliest start (90 minutes before the first outage began) to now is 4 hours of wall clock.
  assert.ok(hours.value <= 4, `power was off in one building for at most 4 hours of wall-clock time, but the measure shows ${hours.value} h`);
});
