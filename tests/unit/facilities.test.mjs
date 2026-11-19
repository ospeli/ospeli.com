// Facilities and utilities (module facilities): its commands without the screen, every refusal,
// agent proposals, attack tests, both KPIs recomputed from the event log with hand-checked numbers,
// and both guide rules (rule 2 with plant in a building as well as a ward). Fictional data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Core } from '../../web/app/core/core.js';
import { MemoryAdapter } from '../../web/app/core/db.js';
import { loadSyntheticHospital } from '../../web/app/core/generator.js';
import { runCommand, CommandError, commandByName } from '../../web/app/core/commands.js';
import { validate } from '../../web/app/core/schema.js';
import {
  deriveChecks, deriveOutages, plannedChecksDone, outageHours, checkStatus, ruleLowLevel, ruleRepeatFaults, levelsNow, latestReadings,
  slotIndex, SCHEDULE, problemChecks, ruleRepeatFailedTests, AGO_MINUTES,
} from '../../web/app/modules/facilities/logic.js';

const END = '2026-11-19T14:00:00.000Z';
const MIN = 60e3;
const human = (role) => ({ type: 'human', role });
const agent = (role, name = 'fac-bot') => ({ type: 'agent', role, agent: name });
const code = (c) => (err) => err instanceof CommandError && err.code === c;

async function site() {
  let t = Date.parse(END);
  const core = await Core.open({ adapter: new MemoryAdapter(), clock: () => new Date(t += 1000) });
  await loadSyntheticHospital(core, { end: END });
  const run = (name, input, who) => runCommand(core, name, input, typeof who === 'string' ? human(who) : who);
  return { core, run, advance: (m) => { t += m * MIN; } };
}
const out = (name, value) => assert.deepEqual(validate(commandByName(name).output, value), [], `${name}: answer matches its schema`);
const ev = (type, subject, at, data, actorRole = 'estates-tech') => ({ type, subject, at, data, actorRole });

test('the example hospital: a missed generator test, an open outage, a low fuel reading, and the schedule is plain data', async () => {
  const { run } = await site();
  const ov = await run('ospeli_facilities_overview', {}, 'facilities-manager');
  out('ospeli_facilities_overview', ov);
  assert.deepEqual(ov.attention.overdue.map((c) => [c.checkKind, c.targetId]), [['generator-test', 'asset-generator-2']]);
  assert.equal(ov.attention.openOutages.length, 1);
  assert.equal(ov.attention.openOutages[0].utility, 'water');
  assert.ok(ov.readings.some((r) => r.targetId === 'asset-generator-1' && r.below));
  assert.ok(ov.guide.suggestions.some((s) => s.rule === 'low-level'));
  const gen = ov.kpis.find((k) => k.id === 'generator-test-compliance');
  assert.ok(gen.failed >= 1 && gen.missed.length === 1 && gen.value < 100, 'one failed run and one missed week in the history');
  assert.match(gen.source, /D-13/);
  for (const s of SCHEDULE) assert.deepEqual(Object.keys(s).sort(), ['checkKind', 'everyDays', s.assetKind ? 'assetKind' : 'placeId'].sort(), 'shaped { checkKind, assetKind or placeId, everyDays }');
  assert.ok(ov.planned.length >= 2 && ov.readOnly[0].value === undefined, 'planned and read-only measures carry no value');
  assert.match(ov.note, /never switches plant/);
});

test('a facilities technician records a generator test; generator test compliance counts it; a double tap is refused', async () => {
  const { run, advance } = await site();
  const k0 = (await run('ospeli_facilities_overview', {}, 'estates-tech')).kpis[0];
  const r = await run('ospeli_facilities_check_record', { checkKind: 'generator-test', assetId: 'asset-generator-1', result: 'pass', runMinutes: 30 }, 'estates-tech');
  out('ospeli_facilities_check_record', r);
  assert.deepEqual([r.status, r.words, r.reportFault], ['done', 'Pass, 30 min', null]);
  await assert.rejects(run('ospeli_facilities_check_record', { checkKind: 'generator-test', assetId: 'asset-generator-1', result: 'pass', runMinutes: 30 }, 'estates-tech'), code('conflict'), 'a double tap saves nothing');
  const k1 = (await run('ospeli_facilities_overview', {}, 'estates-tech')).kpis[0];
  assert.deepEqual([k1.numerator, k1.denominator], [k0.numerator + 1, k0.denominator + 1], 'the current week is now done, so it counts');
  advance(15);
  // A failed test offers the fault report; it opens no work order by itself.
  const wos = (await run('ospeli_workorders_list', { state: 'all', limit: 500 }, 'estates-tech')).total;
  const f = await run('ospeli_facilities_check_record', { checkKind: 'generator-test', assetId: 'asset-generator-2', result: 'fail', runMinutes: 15 }, 'facilities-manager');
  assert.deepEqual(f.reportFault.input, { assetId: 'asset-generator-2', fault: 'Generator test fault' });
  assert.equal((await run('ospeli_workorders_list', { state: 'all', limit: 500 }, 'estates-tech')).total, wos, 'no work order opened by itself');
  const ov = await run('ospeli_facilities_overview', {}, 'facilities-manager');
  assert.equal(ov.attention.overdue.length, 0, 'the missed generator now has a check: no longer overdue');
  // The new roles may report the fault through Engineering's own command.
  const wo = await run('ospeli_workorders_report_fault', { ...f.reportFault.input, priority: 'high' }, 'facilities-manager');
  assert.equal(wo.status, 'done');
});

test('who records what: the assistant takes readings only; wrong fields, made-up ids and unknown fields are refused', async () => {
  const { run, core } = await site();
  const ok = await run('ospeli_facilities_check_record', { checkKind: 'fuel-level', assetId: 'asset-generator-1', levelPct: 70 }, 'facilities-assistant');
  assert.equal(ok.words, '70 %');
  await run('ospeli_facilities_check_record', { checkKind: 'water-level', placeId: 'bld-main-plant', levelPct: 60 }, 'facilities-assistant');
  await assert.rejects(run('ospeli_facilities_check_record', { checkKind: 'generator-test', assetId: 'asset-generator-1', result: 'pass', runMinutes: 30 }, 'facilities-assistant'), code('forbidden'));
  await assert.rejects(run('ospeli_facilities_check_record', { checkKind: 'gas-check', placeId: 'bld-main-plant', result: 'pass', levelBand: 'high' }, 'facilities-assistant'), code('forbidden'));
  await assert.rejects(run('ospeli_facilities_check_record', { checkKind: 'fuel-level', assetId: 'asset-generator-1', levelPct: 70 }, 'ward-nurse'), code('forbidden'), 'a role outside the list');
  await assert.rejects(run('ospeli_facilities_check_record', { checkKind: 'fuel-level', assetId: 'asset-chiller-1', levelPct: 70 }, 'estates-tech'), code('not-found'), 'not a generator');
  await assert.rejects(run('ospeli_facilities_check_record', { checkKind: 'fuel-level', assetId: 'asset-made-up', levelPct: 70 }, 'estates-tech'), (e) => e.code === 'not-found' && !/made-up/.test(e.message), 'a made-up id is not echoed back');
  await assert.rejects(run('ospeli_facilities_check_record', { checkKind: 'fuel-level', assetId: 'asset-generator-1', levelPct: 75 }, 'estates-tech'), code('invalid-input'), 'levels are picked in tens');
  await assert.rejects(run('ospeli_facilities_check_record', { checkKind: 'fuel-level', assetId: 'asset-generator-1' }, 'estates-tech'), code('invalid-input'), 'missing the level');
  await assert.rejects(run('ospeli_facilities_check_record', { checkKind: 'fuel-level', assetId: 'asset-generator-1', levelPct: 70, result: 'pass' }, 'estates-tech'), code('invalid-input'), 'a field that kind does not take');
  await assert.rejects(run('ospeli_facilities_check_record', { checkKind: 'water-level', assetId: 'asset-generator-1', levelPct: 70 }, 'estates-tech'), code('invalid-input'), 'a place check with an asset');
  await assert.rejects(run('ospeli_facilities_check_record', { checkKind: 'water-level', placeId: 'ward-a1-bed-01', levelPct: 70 }, 'estates-tech'), code('not-found'), 'a bed is not a place for a tank');
  await assert.rejects(run('ospeli_facilities_check_record', { checkKind: 'fuel-level', assetId: 'asset-generator-1', levelPct: 70, note: 'Checked by Dr Jane Smith' }, 'estates-tech'), code('invalid-input'), 'no typed note at all');
  await assert.rejects(run('ospeli_facilities_check_record', { checkKind: 'fuel-level', assetId: '<script>alert(1)</script>', levelPct: 70 }, 'estates-tech'), code('invalid-input'), 'ids are checked for shape');
  // Only facilities events, the role and never a person.
  const mine = (await core.events()).filter((e) => e.type.startsWith('facilities.')).slice(-2);
  for (const e of mine) assert.deepEqual(Object.keys(e.data).sort().filter((k) => /name|staff|person|phone|email/i.test(k)), []);
  assert.equal(mine.at(-1).actorRole, 'facilities-assistant');
});

test('outages: one open per utility and place, end is refused twice, cause corrected, the length counts in outage hours', async () => {
  const { run, advance } = await site();
  const h0 = (await run('ospeli_facilities_overview', {}, 'ops-manager')).kpis[1];
  const s = await run('ospeli_facilities_outage_start', { utility: 'power', placeId: 'bld-main-a', cause: 'not-known', startedMinutesAgo: 30 }, 'estates-tech');
  out('ospeli_facilities_outage_start', s);
  await assert.rejects(run('ospeli_facilities_outage_start', { utility: 'power', placeId: 'bld-main-a', cause: 'weather' }, 'estates-tech'), (e) => e.code === 'conflict' && e.detail.existing === s.outageId);
  await run('ospeli_facilities_outage_start', { utility: 'power', placeId: 'bld-main-b', cause: 'not-known' }, 'ops-manager'); // another place: fine
  await assert.rejects(run('ospeli_facilities_outage_start', { utility: 'power', placeId: 'ward-a1', cause: 'not-known' }, 'estates-tech'), code('not-found'), 'an outage is at a site, building or department');
  await assert.rejects(run('ospeli_facilities_outage_start', { utility: 'steam', placeId: 'bld-main-a', cause: 'not-known' }, 'estates-tech'), code('invalid-input'));
  advance(30);
  const e = await run('ospeli_facilities_outage_end', { outageId: s.outageId, cause: 'outside-supply' }, 'facilities-assistant');
  out('ospeli_facilities_outage_end', e);
  assert.ok(e.minutes >= 60 && e.minutes <= 62, `about an hour: started 30 min before it was recorded, ended 30 min later (${e.minutes})`);
  await assert.rejects(run('ospeli_facilities_outage_end', { outageId: s.outageId }, 'estates-tech'), code('conflict'), 'already ended');
  await assert.rejects(run('ospeli_facilities_outage_end', { outageId: 'out-99999' }, 'estates-tech'), code('not-found'));
  await assert.rejects(run('ospeli_facilities_outage_end', { outageId: s.outageId }, 'coo'), code('forbidden'));
  const list = await run('ospeli_facilities_log_list', { kind: 'outages', limit: 50 }, 'coo');
  out('ospeli_facilities_log_list', list);
  const o = list.entries.find((x) => x.id === s.outageId);
  assert.deepEqual([o.cause, o.open, o.minutes], ['outside-supply', false, e.minutes]);
  const h1 = (await run('ospeli_facilities_overview', {}, 'ops-manager')).kpis[1];
  const power = (k) => k.breakdown.find((b) => b.id === 'power').hours;
  assert.ok(power(h1) >= power(h0) + 1, 'the hour shows in power outage hours');
});

test('agents: a check or an outage becomes a proposal and changes nothing until a person accepts; levels and the guide are people only', async () => {
  const { core, run } = await site();
  await run('ospeli_agents_set_access', { allowed: true, wards: { 'ward-a1': true } }, 'coo');
  await run('ospeli_agents_add', { name: 'fac-bot', role: 'estates-tech', wards: ['ward-a1'], days: 30 }, 'coo');
  const bot = agent('estates-tech');
  const n = await core.eventCount();
  const p = await run('ospeli_facilities_check_record', { checkKind: 'fuel-level', assetId: 'asset-generator-2', levelPct: 50 }, bot);
  assert.equal(p.status, 'proposed');
  assert.equal(await core.eventCount(), n, 'nothing changed');
  await assert.rejects(run('ospeli_facilities_check_record', { checkKind: 'fuel-level', assetId: 'asset-made-up', levelPct: 50 }, bot), (e) => e instanceof CommandError, 'a proposal is checked before it queues');
  await assert.rejects(run('ospeli_facilities_levels_set', { fuelPct: 30 }, bot), code('forbidden'));
  await assert.rejects(run('ospeli_facilities_guide_set', { on: false }, bot), code('forbidden'));
  const acc = await run('ospeli_proposals_accept', { id: p.proposal.id }, 'facilities-manager');
  assert.equal(acc.status, 'accepted');
  const last = (await core.events({ type: 'facilities.check-recorded' })).at(-1);
  assert.deepEqual([last.data.assetId, last.data.levelPct], ['asset-generator-2', 50]);
});

test('levels and the guide switch: the low-fuel suggestion clears when the level is set lower and when the guide is off; everything else is the same', async () => {
  const { run } = await site();
  const on = await run('ospeli_facilities_overview', {}, 'facilities-manager');
  assert.ok(on.guide.suggestions.some((s) => s.rule === 'low-level' && /Standby generator 1/.test(s.text)));
  await assert.rejects(run('ospeli_facilities_levels_set', { fuelPct: 30 }, 'estates-tech'), code('forbidden'));
  await assert.rejects(run('ospeli_facilities_levels_set', {}, 'facilities-manager'), code('invalid-input'));
  await assert.rejects(run('ospeli_facilities_levels_set', { fuelPct: 50 }, 'facilities-manager'), code('conflict'), 'unchanged');
  const set = await run('ospeli_facilities_levels_set', { fuelPct: 30 }, 'facilities-manager');
  assert.deepEqual([set.fuelPct, set.waterPct], [30, 50]);
  const low = await run('ospeli_facilities_overview', {}, 'facilities-manager');
  assert.ok(!low.guide.suggestions.some((s) => s.rule === 'low-level'), 'the 40 % reading is above 30 %');
  await run('ospeli_facilities_levels_set', { fuelPct: 50 }, 'facilities-manager');
  await run('ospeli_facilities_guide_set', { on: false }, 'facilities-manager');
  await assert.rejects(run('ospeli_facilities_guide_set', { on: false }, 'facilities-manager'), code('conflict'));
  const off = await run('ospeli_facilities_overview', {}, 'facilities-manager');
  assert.deepEqual([off.guide.on, off.guide.suggestions], [false, []]);
  const same = (x) => JSON.stringify([x.attention, x.checks, x.kpis.map((k) => k.value)]);
  assert.equal(same(off), same(on), 'with the guide off the checks, outages and measures are the same');
  await run('ospeli_facilities_check_record', { checkKind: 'fuel-level', assetId: 'asset-generator-1', levelPct: 80 }, 'facilities-assistant');
  await run('ospeli_facilities_guide_set', { on: true }, 'facilities-manager');
  const refilled = await run('ospeli_facilities_overview', {}, 'facilities-manager');
  assert.ok(!refilled.guide.suggestions.some((s) => s.rule === 'low-level'), 'a newer reading above the level clears it');
});

// ---- KPI 1 by hand. 2 Nov 2026 is a Monday. Site time = UTC here. ----
const GEN = [{ checkKind: 'generator-test', targetId: 'g1', everyDays: 7 }, { checkKind: 'generator-test', targetId: 'g2', everyDays: 7 },
  { checkKind: 'fuel-level', targetId: 'g1', everyDays: 7 }, { checkKind: 'gas-check', targetId: 'plant', everyDays: 1 }];
const gt = (id, assetId, at, result = 'pass') => ev('facilities.check-recorded', id, at, { checkKind: 'generator-test', assetId, result, runMinutes: 30 });
const KPI_EVENTS = [
  gt('chk-00001', 'g1', '2026-11-04T10:00:00Z'), // week 2-8 Nov: done
  gt('chk-00002', 'g1', '2026-11-12T10:00:00Z', 'fail'), // week 9-15: done, failed
  // week 16-22: g1 missed
  gt('chk-00003', 'g1', '2026-11-24T10:00:00Z'), // week 23-29: done (late for the week before; fills its own week only)
  gt('chk-00004', 'g2', '2026-11-02T09:00:00Z'), gt('chk-00005', 'g2', '2026-11-09T09:00:00Z'),
  gt('chk-00006', 'g2', '2026-11-16T09:00:00Z'), gt('chk-00007', 'g2', '2026-11-23T09:00:00Z'),
  ev('facilities.check-recorded', 'chk-00008', '2026-11-03T08:00:00Z', { checkKind: 'gas-check', placeId: 'plant', result: 'pass', levelBand: 'high' }),
];
test('KPI generator test compliance (D-13), hand-checked: 6 of 7 test-weeks done by due, 1 failed, 1 missed', () => {
  const checks = deriveChecks(KPI_EVENTS);
  const k = plannedChecksDone(checks, { since: '2026-11-02T12:00:00Z', until: '2026-11-25T12:00:00Z', targets: GEN, checkKind: 'generator-test' });
  // g1: 4 Nov done, 12 Nov done (fail), week 16-22 missed (settled 23 Nov 00:00), 24 Nov done = 3 of 4.
  // g2: 2 Nov 09:00 is settled before since (12:00), so out; 9, 16, 23 Nov done = 3 of 3. And g2's week 23-29 is done.
  // Total 6 of 7 = 85.7 %.
  assert.deepEqual([k.numerator, k.denominator, k.failed], [6, 7, 1]);
  assert.equal(Math.round(k.value * 10) / 10, 85.7);
  assert.deepEqual(k.missed.map((m) => [m.targetId, m.due]), [['g1', '2026-11-23T00:00:00.000Z']]);
  // A week still open with no test is not counted yet; the other check types are left out by the filter.
  const early = plannedChecksDone(checks, { since: '2026-11-02T12:00:00Z', until: '2026-11-18T12:00:00Z', targets: GEN, checkKind: 'generator-test' });
  assert.deepEqual([early.numerator, early.denominator], [4, 4], 'g1 4 and 12 Nov; g2 9 and 16 Nov; g1\'s week 16-22 is still open on 18 Nov, so not counted');
});
test('KPI D-13 details: due periods follow site time; the status says missed only when a whole period passed with no check', () => {
  // 02:00 UTC on Mon 9 Nov is 22:00 on Sun 8 Nov four hours west of UTC: the week 2-8 Nov.
  assert.equal(slotIndex(Date.parse('2026-11-09T02:00:00Z'), 7, -240), slotIndex(Date.parse('2026-11-05T12:00:00Z'), 7, 0));
  assert.equal(slotIndex(Date.parse('2026-11-09T02:00:00Z'), 7, 0), slotIndex(Date.parse('2026-11-05T12:00:00Z'), 7, 0) + 1);
  const st = checkStatus(deriveChecks(KPI_EVENTS), GEN.slice(0, 2), { now: '2026-11-21T12:00:00Z' });
  const g1 = st.find((s) => s.targetId === 'g1'); const g2 = st.find((s) => s.targetId === 'g2');
  assert.deepEqual([g1.status, g2.status], ['due', 'done'], 'on Sat 21 Nov g1 still has until Sunday night');
  const st2 = checkStatus(deriveChecks(KPI_EVENTS.slice(0, 3)), GEN.slice(0, 1), { now: '2026-11-23T08:00:00Z' });
  assert.deepEqual([st2[0].status, st2[0].overdueSince, st2[0].missedPeriods], ['overdue', '2026-11-23T00:00:00.000Z', 1]);
});

test('KPI utility outage hours, hand-checked: 5.5 h unplanned in November (power 1, water 4.5 with one open), planned 3 h apart', () => {
  const events = [
    ev('facilities.outage-started', 'out-00001', '2026-10-31T23:00:00Z', { utility: 'power', placeId: 'b', cause: 'not-known' }),
    ev('facilities.outage-ended', 'out-00001', '2026-11-01T01:00:00Z', { cause: 'outside-supply' }), // 1 h in November
    ev('facilities.outage-started', 'out-00002', '2026-11-10T08:00:00Z', { utility: 'water', placeId: 'b', cause: 'equipment-fault' }),
    ev('facilities.outage-ended', 'out-00002', '2026-11-10T10:30:00Z', {}), // 2.5 h
    ev('facilities.outage-started', 'out-00003', '2026-11-12T06:00:00Z', { utility: 'heating-cooling', placeId: 'b', cause: 'planned-shutdown' }),
    ev('facilities.outage-ended', 'out-00003', '2026-11-12T09:00:00Z', {}), // 3 h planned, apart
    ev('facilities.outage-started', 'out-00004', '2026-11-25T10:00:00Z', { utility: 'water', placeId: 'c', cause: 'not-known' }), // open: 2 h to until
    ev('facilities.outage-started', 'out-00005', '2026-10-20T10:00:00Z', { utility: 'power', placeId: 'c', cause: 'weather' }),
    ev('facilities.outage-ended', 'out-00005', '2026-10-20T11:00:00Z', {}), // October: out
    ev('facilities.outage-ended', 'out-00002', '2026-11-11T10:30:00Z', {}), // a second end is ignored
  ];
  const o = deriveOutages(events);
  assert.equal(o.get('out-00001').cause, 'outside-supply', 'the cause corrected at the end');
  const k = outageHours(o, { since: '2026-11-01T00:00:00Z', until: '2026-11-25T12:00:00Z' });
  const by = Object.fromEntries(k.byUtility.map((r) => [r.id, r]));
  assert.equal(k.value, 5.5);
  assert.deepEqual([by.power.hours, by.water.hours, by.water.open, by['heating-cooling'].hours, by['heating-cooling'].plannedHours, k.plannedHours], [1, 4.5, 1, 0, 3, 3]);
});

test('guide rule 1: fuel or water below the site\'s level, newest reading only', () => {
  const checks = deriveChecks([
    ev('facilities.check-recorded', 'chk-00001', '2026-11-10T08:00:00Z', { checkKind: 'fuel-level', assetId: 'g1', levelPct: 30 }),
    ev('facilities.check-recorded', 'chk-00002', '2026-11-12T08:00:00Z', { checkKind: 'fuel-level', assetId: 'g1', levelPct: 90 }),
    ev('facilities.check-recorded', 'chk-00003', '2026-11-12T08:00:00Z', { checkKind: 'water-level', placeId: 'plant', levelPct: 40 }),
  ]);
  const levels = levelsNow([ev('facilities.levels-set', 'facilities-levels', '2026-11-01T00:00:00Z', { fuelPct: 40 })]);
  assert.deepEqual([levels.fuelPct, levels.waterPct], [40, 50]);
  const s = ruleLowLevel(latestReadings(checks), levels, { nameOf: (x) => x });
  assert.deepEqual(s.map((x) => x.id), ['low-level:water-level:plant:chk-00003'], 'fuel was refilled to 90 %; water 40 % is under 50 %');
  assert.match(s[0].why, /40 %.*Thu 12 Nov, 08:00.*50 %/);
  assert.match(s[0].basis, /example setting, not a standard/i);
});

test('guide rule 2: repeat leak or power faults in one place, for plant in a building as well as on a ward, within 30 days; a generator test fault is not a power fault', () => {
  const assets = new Map([['db1', { parentId: 'bld-plant' }], ['db2', { parentId: 'bld-plant' }], ['g1', { parentId: 'bld-plant' }], ['g2', { parentId: 'bld-plant' }],
    ['s1', { parentId: 'ward-a1' }], ['s2', { parentId: 'ward-a1' }], ['s3', { parentId: 'ward-b1' }], ['l1', { parentId: 'ward-b1' }]]);
  const f = (wo, asset, title, at) => ev('asset.fault-reported', asset, at, { workOrder: wo, title, trade: 'estates', priority: 'routine' }, 'ward-nurse');
  const events = [
    f('wo-00001', 'db1', 'Tripped breaker', '2026-11-02T10:00:00Z'), f('wo-00002', 'db2', 'Tripped breaker', '2026-11-15T10:00:00Z'), // building: 2
    f('wo-00009', 'g1', 'Generator test fault', '2026-11-03T10:00:00Z'), f('wo-00010', 'g2', 'Generator test fault', '2026-11-16T10:00:00Z'), // not power faults
    f('wo-00003', 's1', 'Tap leaking', '2026-11-05T10:00:00Z'), f('wo-00004', 's2', 'Tap leaking', '2026-11-18T10:00:00Z'), // ward A1: 2
    f('wo-00005', 's3', 'Tap leaking', '2026-10-01T10:00:00Z'), f('wo-00006', 's3', 'Tap leaking', '2026-11-18T10:00:00Z'), // ward B1: one is too old
    f('wo-00007', 'l1', 'Light fitting out', '2026-11-17T10:00:00Z'), f('wo-00008', 'l1', 'Light fitting out', '2026-11-18T10:00:00Z'), // not a leak or power fault
  ];
  const s = ruleRepeatFaults(events, { assets, now: '2026-11-20T12:00:00Z', nameOf: (x) => x });
  assert.deepEqual(s.map((x) => [x.id, x.workOrders]).sort(), [
    ['repeat-faults:bld-plant:power', ['wo-00001', 'wo-00002']], ['repeat-faults:ward-a1:water', ['wo-00003', 'wo-00004']]]);
  assert.match(s.find((x) => x.id.includes('bld-plant')).text, /electrical supply in bld-plant/);
  // An agent sees the ward groups of its own wards only.
  assert.deepEqual(ruleRepeatFaults(events, { assets, now: '2026-11-20T12:00:00Z', nameOf: (x) => x, wards: new Set(['ward-b1']) }).map((x) => x.id), ['repeat-faults:bld-plant:power']);
});

test('guide rule 3: two or more failed tests on one generator within 30 days suggest reviewing its maintenance', () => {
  const checks = deriveChecks([
    gt('chk-00001', 'g1', '2026-10-10T10:00:00Z', 'fail'), // older than 30 days
    gt('chk-00002', 'g1', '2026-11-04T10:00:00Z', 'fail'), gt('chk-00003', 'g1', '2026-11-11T10:00:00Z'), gt('chk-00004', 'g1', '2026-11-18T10:00:00Z', 'fail'),
    gt('chk-00005', 'g2', '2026-10-28T10:00:00Z', 'fail'), gt('chk-00006', 'g2', '2026-11-18T10:00:00Z'), // one only
  ]);
  const s = ruleRepeatFailedTests(checks, { now: '2026-11-20T12:00:00Z', nameOf: (x) => x });
  assert.deepEqual(s.map((x) => [x.id, x.checks]), [['repeat-failed-tests:g1:chk-00004', ['chk-00002', 'chk-00004']]]);
  assert.match(s[0].text, /Review the maintenance of g1/);
  assert.match(s[0].why, /2 failed tests in 30 days: Wed 4 Nov; Wed 18 Nov/);
  assert.match(s[0].basis, /Example setting, not a standard/);
});

test('needs attention: the newest check failed, or a gas supply level picked low or on reserve, until a later normal check on the same asset or place', () => {
  const gas = (id, at, result, levelBand, placeId = 'plant') => ev('facilities.check-recorded', id, at, { checkKind: 'gas-check', placeId, result, levelBand });
  const events = [
    gt('chk-00001', 'g1', '2026-11-04T10:00:00Z', 'fail'), gt('chk-00002', 'g1', '2026-11-11T10:00:00Z'), // failed, then passed: clear
    gt('chk-00003', 'g2', '2026-11-11T10:00:00Z'), gt('chk-00004', 'g2', '2026-11-18T10:00:00Z', 'fail'), // newest failed: listed
    gas('chk-00005', '2026-11-17T08:00:00Z', 'pass', 'low'), gas('chk-00006', '2026-11-18T08:00:00Z', 'pass', 'half'), // low, then normal: clear
    gas('chk-00007', '2026-11-18T08:00:00Z', 'pass', 'reserve', 'plant-b'), // on reserve: listed
    ev('facilities.check-recorded', 'chk-00008', '2026-11-18T08:00:00Z', { checkKind: 'fuel-level', assetId: 'g1', levelPct: 10 }), // a reading is the refill rule's, not this list's
  ];
  const p = problemChecks(deriveChecks(events));
  assert.deepEqual(p.map((x) => [x.check.targetId, x.problem.id]).sort(), [['g2', 'failed'], ['plant-b', 'reserve']]);
  assert.ok(p.every((x) => !/safe/i.test(x.problem.words)), 'nothing is worded as a supply being safe');
  const after = problemChecks(deriveChecks([...events, gt('chk-00009', 'g2', '2026-11-19T10:00:00Z')]));
  assert.deepEqual(after.map((x) => x.check.targetId), ['plant-b'], 'a later pass clears the generator');
});

test('needs attention in the overview: a failed generator test is listed and its check reads as done with a failure; a gas supply on reserve keeps the procedure line', async () => {
  const { run } = await site();
  await run('ospeli_facilities_check_record', { checkKind: 'generator-test', assetId: 'asset-generator-1', result: 'fail', runMinutes: 15 }, 'estates-tech');
  await run('ospeli_facilities_check_record', { checkKind: 'gas-check', placeId: 'bld-main-plant', result: 'pass', levelBand: 'reserve' }, 'estates-tech');
  const ov = await run('ospeli_facilities_overview', {}, 'facilities-manager');
  out('ospeli_facilities_overview', ov);
  assert.deepEqual(ov.attention.problems.map((x) => [x.targetId, x.problem.id]), [['asset-generator-1', 'failed'], ['bld-main-plant', 'reserve']]);
  assert.match(ov.attention.problems[1].procedure, /Follow your site's medical gas procedure first/);
  const row = ov.checks.find((c) => c.checkKind === 'generator-test' && c.targetId === 'asset-generator-1');
  assert.deepEqual([row.status, row.problem.id], ['done', 'failed'], 'done for the measure, failed on screen');
  assert.match(ov.kpis[0].definition, /counts as done for this measure.*Needs attention until a later test passes/);
});

test('an outage found at shift change can be recorded up to 12 hours back, and the log says the start was entered later', async () => {
  const { run } = await site();
  assert.equal(AGO_MINUTES.at(-1), 720);
  const s = await run('ospeli_facilities_outage_start', { utility: 'heating-cooling', placeId: 'bld-north-1', cause: 'not-known', startedMinutesAgo: 720 }, 'estates-tech');
  const e = (await run('ospeli_facilities_log_list', { kind: 'outages', limit: 50 }, 'estates-tech')).entries.find((x) => x.id === s.outageId);
  assert.equal(e.startBackdatedMinutes, 720);
  assert.ok(e.minutes >= 720);
});
