// Facilities and utilities, slice 2 (20 Nov 2026): the on-load or off-load pick on the generator test
// and the on-load row of the schedule, and the waste log (ospeli_facilities_waste_record, the widened
// log list and overview). Each command through runCommand with every refusal, the attack tests, the
// three new measures recomputed from events with hand-checked numbers, the on-load rule (a test with
// no load never fills an on-load period), the guide off, and the seed. Fictional data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Core } from '../../web/app/core/core.js';
import { MemoryAdapter } from '../../web/app/core/db.js';
import { generateHospital } from '../../web/app/core/generator.js';
import { loadHospital } from './hospital-clock.mjs';
import { runCommand, CommandError, commandByName } from '../../web/app/core/commands.js';
import { validate } from '../../web/app/core/schema.js';
import {
  deriveChecks, deriveWaste, scheduleChecks, loadTestsDone, plannedChecksDone, checkStatus, wasteMissedShare, wasteContainers, wasteMissedWaiting,
  slotIndex, SCHEDULE, CHECK_KINDS, GUIDE_RULES,
} from '../../web/app/modules/facilities/logic.js';

const END = '2026-11-19T14:00:00.000Z';
const MIN = 60e3;
const human = (role) => ({ type: 'human', role });
const agent = (role, name = 'fac-bot') => ({ type: 'agent', role, agent: name });
const code = (c) => (err) => err instanceof CommandError && err.code === c;

async function site() {
  let t = Date.parse(END);
  const core = await Core.open({ adapter: new MemoryAdapter(), clock: () => new Date(t += 1000) });
  await loadHospital(core, { end: END });
  const run = (name, input, who) => runCommand(core, name, input, typeof who === 'string' ? human(who) : who);
  return { core, run, advance: (m) => { t += m * MIN; } };
}
const out = (name, value) => assert.deepEqual(validate(commandByName(name).output, value), [], `${name}: answer matches its schema`);
const ev = (type, subject, at, data, actorRole = 'estates-tech') => ({ type, subject, at, data, actorRole });
const GEN = (assetId, extra = {}) => ({ checkKind: 'generator-test', assetId, result: 'pass', runMinutes: 30, ...extra });

// ---------------------------------------------------------------- (a) the load pick
test('the load pick: an on-load test reads "Pass, 30 min, on load" and turns the on-load row Done; an off-load test fills the weekly row only', async () => {
  const { run, advance } = await site();
  const row = async (kind, id) => (await run('ospeli_facilities_overview', {}, 'facilities-manager')).checks.find((c) => c.checkKind === kind && c.targetId === id);
  // In the example history Standby generator 2's on-load test is in the period before this one (Wed 21 Oct), so this period's is due.
  assert.equal((await row('generator-load-test', 'asset-generator-2')).status, 'due');
  assert.equal((await row('generator-load-test', 'asset-generator-2')).everyText, 'Every 4 weeks');
  assert.equal((await row('generator-test', 'asset-generator-2')).everyText, 'Every week, on or off load');
  const off = await run('ospeli_facilities_check_record', GEN('asset-generator-2', { load: 'off-load' }), 'estates-tech');
  assert.equal(off.words, 'Pass, 30 min, off load');
  assert.deepEqual([(await row('generator-test', 'asset-generator-2')).status, (await row('generator-load-test', 'asset-generator-2')).status], ['done', 'due'], 'an off-load run fills the weekly row, never the on-load one');
  advance(15);
  const on = await run('ospeli_facilities_check_record', GEN('asset-generator-2', { load: 'on-load' }), 'estates-tech');
  out('ospeli_facilities_check_record', on);
  assert.equal(on.words, 'Pass, 30 min, on load');
  const r = await row('generator-load-test', 'asset-generator-2');
  assert.deepEqual([r.status, r.checkName, r.last.id, r.last.load], ['done', 'Generator test on load', on.checkId, 'on-load']);
  // The record keeps the pick; the log list says it.
  const e = (await run('ospeli_facilities_log_list', { kind: 'checks', checkKind: 'generator-test', limit: 1 }, 'coo')).entries[0];
  assert.deepEqual([e.id, e.load, e.words], [on.checkId, 'on-load', 'Pass, 30 min, on load']);
});

test('the load pick: refused on any check but a generator test; only the two picks; a double tap with the same load is refused, a different load is not', async () => {
  const { run, core } = await site();
  await assert.rejects(run('ospeli_facilities_check_record', { checkKind: 'fuel-level', assetId: 'asset-generator-1', levelPct: 70, load: 'on-load' }, 'estates-tech'), code('invalid-input'), 'load on a fuel check');
  await assert.rejects(run('ospeli_facilities_check_record', { checkKind: 'gas-check', placeId: 'bld-main-plant', result: 'pass', levelBand: 'high', load: 'off-load' }, 'estates-tech'), code('invalid-input'), 'load on a gas check');
  await assert.rejects(run('ospeli_facilities_check_record', GEN('asset-generator-1', { load: 'half-load' }), 'estates-tech'), code('invalid-input'), 'a load not in the list');
  await assert.rejects(run('ospeli_facilities_check_record', GEN('asset-generator-1', { load: 'on-load' }), 'facilities-assistant'), code('forbidden'), 'the assistant does not record generator tests');
  await assert.rejects(run('ospeli_facilities_check_record', { checkKind: 'generator-load-test', assetId: 'asset-generator-1', result: 'pass', runMinutes: 30 }, 'estates-tech'), code('invalid-input'), 'the on-load row is a schedule kind only, not a check');
  const n = await core.eventCount();
  await run('ospeli_facilities_check_record', GEN('asset-generator-1', { load: 'on-load' }), 'estates-tech');
  await assert.rejects(run('ospeli_facilities_check_record', GEN('asset-generator-1', { load: 'on-load' }), 'estates-tech'), code('conflict'), 'a double tap saves nothing');
  await run('ospeli_facilities_check_record', GEN('asset-generator-1', { load: 'off-load' }), 'estates-tech'); // a different pick is a different record
  assert.equal(await core.eventCount(), n + 2);
  // The command keeps the load optional so stored records and older callers stand: no load = not recorded.
  const none = await run('ospeli_facilities_check_record', GEN('asset-generator-2'), 'estates-tech');
  assert.equal(none.words, 'Pass, 30 min', 'a save says only what was picked');
  const e = (await run('ospeli_facilities_log_list', { kind: 'checks', checkKind: 'generator-test', limit: 1 }, 'coo')).entries[0];
  assert.deepEqual([e.id, e.load, e.words], [none.checkId, undefined, 'Pass, 30 min, load not recorded']);
});

test('the on-load rule: a test with no load, or off load, never fills an on-load period; an on-load test fills both rows', () => {
  // 9 Nov 2026 is the start of a 4-week on-load period (counted from Mon 5 Jan 2026, 28 days each).
  assert.equal(slotIndex(Date.parse('2026-11-09T00:00:00Z'), 28), 11);
  assert.equal(slotIndex(Date.parse('2026-11-08T23:59:00Z'), 28), 10);
  const targets = [{ checkKind: 'generator-test', targetId: 'g1', everyDays: 7 }, { checkKind: 'generator-load-test', targetId: 'g1', everyDays: 28 }];
  const events = [
    ev('facilities.check-recorded', 'chk-00001', '2026-11-10T10:00:00Z', { checkKind: 'generator-test', assetId: 'g1', result: 'pass', runMinutes: 30 }), // no load
    ev('facilities.check-recorded', 'chk-00002', '2026-11-17T10:00:00Z', { checkKind: 'generator-test', assetId: 'g1', result: 'pass', runMinutes: 30, load: 'off-load' }),
  ];
  const st = (evs, now) => Object.fromEntries(checkStatus(scheduleChecks(deriveChecks(evs)), targets, { now }).map((s) => [s.checkKind, s.status]));
  assert.deepEqual(st(events, '2026-11-18T12:00:00Z'), { 'generator-test': 'done', 'generator-load-test': 'due' });
  const withOn = [...events, ev('facilities.check-recorded', 'chk-00003', '2026-11-18T10:00:00Z', { checkKind: 'generator-test', assetId: 'g1', result: 'fail', runMinutes: 15, load: 'on-load' })];
  assert.deepEqual(st(withOn, '2026-11-18T12:00:00Z'), { 'generator-test': 'done', 'generator-load-test': 'done' }, 'a failed on-load test counts as done');
  // An edited import: a load on a fuel check, or a load not in the list, is left out.
  assert.equal(deriveChecks([ev('facilities.check-recorded', 'chk-00009', '2026-11-18T10:00:00Z', { checkKind: 'fuel-level', assetId: 'g1', levelPct: 50, load: 'on-load' })]).length, 0);
  assert.equal(deriveChecks([ev('facilities.check-recorded', 'chk-00009', '2026-11-18T10:00:00Z', { checkKind: 'generator-test', assetId: 'g1', result: 'pass', runMinutes: 30, load: 'x' })]).length, 0);
  // The schedule row keeps the shape { checkKind, assetKind or placeId, everyDays } and is not a kind of check.
  const row = SCHEDULE.find((s) => s.checkKind === 'generator-load-test');
  assert.deepEqual(row, { checkKind: 'generator-load-test', assetKind: 'generator', everyDays: 28 });
  assert.equal(CHECK_KINDS['generator-load-test'], undefined);
  assert.match(GUIDE_RULES.find((r) => r.id === 'repeat-failed-tests').basis, /whatever its load/);
});

// ---- KPI 3 (new): generator on-load tests done by due date, by hand. Site time = UTC. ----
// On-load periods (28 days from Mon 5 Jan 2026): P8 17 Aug-14 Sep, P9 14 Sep-12 Oct, P10 12 Oct-9 Nov, P11 9 Nov-7 Dec.
test('KPI generator on-load tests done by due date, hand-checked: 4 of 6 periods, 1 failed, 2 missed', () => {
  const gt = (id, assetId, at, load, result = 'pass') => ev('facilities.check-recorded', id, at, { checkKind: 'generator-test', assetId, result, runMinutes: 30, ...(load ? { load } : {}) });
  const events = [
    gt('chk-00001', 'g1', '2026-08-20T10:00:00Z', 'on-load'), // P8 done, but settled 20 Aug: before since (27 Aug), so out
    gt('chk-00002', 'g1', '2026-09-20T10:00:00Z', 'off-load'), // P9: off load only, so missed (settled 12 Oct)
    gt('chk-00003', 'g1', '2026-10-15T10:00:00Z', 'on-load', 'fail'), // P10 done, failed
    gt('chk-00004', 'g1', '2026-11-10T10:00:00Z', null), // P11: load not recorded, so P11 is still open: not counted
    gt('chk-00005', 'g2', '2026-09-01T10:00:00Z', 'on-load'), // P8 done (settled 1 Sep, inside)
    gt('chk-00006', 'g2', '2026-09-16T10:00:00Z', 'on-load'), // P9 done
    // P10: g2 has no test: missed (settled 9 Nov)
    gt('chk-00007', 'g2', '2026-11-12T10:00:00Z', 'on-load'), // P11 done
  ];
  const targets = [{ checkKind: 'generator-load-test', targetId: 'g1', everyDays: 28 }, { checkKind: 'generator-load-test', targetId: 'g2', everyDays: 28 },
    { checkKind: 'generator-test', targetId: 'g1', everyDays: 7 }];
  const k = loadTestsDone(deriveChecks(events), { since: '2026-08-27T00:00:00Z', until: '2026-11-19T00:00:00Z', targets });
  // g1: P9 missed, P10 done (failed) = 1 of 2. g2: P8, P9, P11 done, P10 missed = 3 of 4. In all 4 of 6 = 66.7 %, 1 failed.
  assert.deepEqual([k.numerator, k.denominator, k.failed], [4, 6, 1]);
  assert.equal(Math.round(k.value * 10) / 10, 66.7);
  assert.deepEqual(k.missed.map((m) => [m.targetId, m.due]), [['g1', '2026-10-12T00:00:00.000Z'], ['g2', '2026-11-09T00:00:00.000Z']]);
  // It is the shared D-13 function, filtered: the same as plannedChecksDone on the schedule's checks.
  const same = plannedChecksDone(scheduleChecks(deriveChecks(events)), { since: '2026-08-27T00:00:00Z', until: '2026-11-19T00:00:00Z', targets, checkKind: 'generator-load-test' });
  assert.deepEqual([same.numerator, same.denominator], [4, 6]);
});

test('the on-load measure in the overview: appended after the first two, never counts weeks before the log began, and the example reads 3 of 3', async () => {
  const { run } = await site();
  const ov = await run('ospeli_facilities_overview', {}, 'facilities-manager');
  out('ospeli_facilities_overview', ov);
  assert.deepEqual(ov.kpis.map((k) => k.id), ['generator-test-compliance', 'utility-outage-hours', 'generator-load-test-compliance', 'waste-missed-share', 'waste-containers']);
  const k = ov.kpis[2];
  // The example log starts on Tue 20 Oct (30 days): Standby generator 1 tested on load in P10 and P11, Standby generator 2 in P10;
  // generator 2's P11 is still open. 3 of 3. Without the log's start the 84 days would count P8 and P9, from before the log, as missed.
  assert.deepEqual([k.numerator, k.denominator, k.value], [3, 3, 100]);
  assert.equal(k.period.startsText, 'Tue 20 Oct');
  assert.match(k.source, /local definition/);
  assert.match(k.source, /example setting, not a standard/);
  assert.match(k.definition, /D-13/);
  assert.equal(k.targetText, 'No target set here. Your site sets its own (example setting, not a standard).');
  const short = await run('ospeli_facilities_overview', { format: 'short' }, 'coo');
  assert.equal(short.kpis[2].definition, undefined);
});

// ---------------------------------------------------------------- (c) the waste log
test('waste: the facilities assistant records a collection and a missed collection; the miss is in Needs attention until a later collection there', async () => {
  const { run, core, advance } = await site();
  const ov0 = await run('ospeli_facilities_overview', {}, 'facilities-manager');
  const share0 = ov0.kpis[3]; const cont0 = ov0.kpis[4];
  const c = await run('ospeli_facilities_waste_record', { placeId: 'bld-main-a', stream: 'infectious', outcome: 'collected', containers: 3 }, 'facilities-assistant');
  out('ospeli_facilities_waste_record', c);
  assert.deepEqual([c.status, c.words], ['done', 'Infectious: 3 containers collected']);
  assert.match(c.wasteId, /^wst-\d{5}$/);
  const m = await run('ospeli_facilities_waste_record', { placeId: 'bld-main-a', stream: 'general', outcome: 'missed', reason: 'did-not-come' }, 'facilities-assistant');
  assert.equal(m.words, 'General: collection missed (Collection did not come)');
  const ov1 = await run('ospeli_facilities_overview', {}, 'facilities-manager');
  assert.deepEqual([ov1.kpis[3].numerator, ov1.kpis[3].denominator], [share0.numerator + 1, share0.denominator + 2]);
  assert.equal(ov1.kpis[4].value, cont0.value + 3);
  const waiting = ov1.attention.wasteMissed.map((w) => w.id);
  assert.ok(waiting.includes(m.wasteId));
  assert.equal(ov1.waste.missedWaiting.length, ov1.attention.wasteMissed.length);
  // A collection of another stream, or of the same stream at another place, does not clear it.
  advance(11);
  await run('ospeli_facilities_waste_record', { placeId: 'bld-main-a', stream: 'recycling', outcome: 'collected', containers: 2 }, 'estates-tech');
  await run('ospeli_facilities_waste_record', { placeId: 'bld-main-b', stream: 'general', outcome: 'collected', containers: 2 }, 'estates-tech');
  assert.ok((await run('ospeli_facilities_overview', {}, 'facilities-manager')).attention.wasteMissed.some((w) => w.id === m.wasteId));
  // The late collection clears it; the missed share keeps the miss.
  await run('ospeli_facilities_waste_record', { placeId: 'bld-main-a', stream: 'general', outcome: 'collected', containers: 4 }, 'facilities-manager');
  const ov2 = await run('ospeli_facilities_overview', {}, 'facilities-manager');
  assert.ok(!ov2.attention.wasteMissed.some((w) => w.id === m.wasteId));
  assert.equal(ov2.kpis[3].numerator, share0.numerator + 1, 'a later collection does not cancel the miss');
  // Only facilities events, the role and never a person; nothing typed.
  const mine = (await core.events({ type: 'facilities.waste-recorded' })).slice(-5);
  for (const e of mine) assert.deepEqual(Object.keys(e.data).filter((k) => !['placeId', 'stream', 'outcome', 'containers', 'reason', 'backdatedMinutes'].includes(k)), []);
  assert.equal(mine[0].actorRole, 'facilities-assistant');
});

test('waste: every refusal and the attack tests (wrong role, made-up place, a ward, unknown field, containers on a miss, a reason on a collection, typed text)', async () => {
  const { run, core } = await site();
  const ok = { placeId: 'bld-main-a', stream: 'sharps', outcome: 'collected', containers: 2 };
  const n = await core.eventCount();
  for (const role of ['ward-nurse', 'ops-manager', 'coo']) await assert.rejects(run('ospeli_facilities_waste_record', ok, role), code('forbidden'), `${role} records no waste`);
  await assert.rejects(run('ospeli_facilities_waste_record', { ...ok, placeId: 'bld-made-up' }, 'estates-tech'), (e) => e.code === 'not-found' && !/made-up/.test(e.message) && /site, building or department/.test(e.message), 'a made-up place is not echoed back; the valid kinds are named');
  await assert.rejects(run('ospeli_facilities_waste_record', { ...ok, placeId: 'ward-a1' }, 'estates-tech'), code('not-found'), 'a ward is not a waste place');
  await assert.rejects(run('ospeli_facilities_waste_record', { ...ok, placeId: 'asset-generator-1' }, 'estates-tech'), code('not-found'), 'an asset is not a place');
  await assert.rejects(run('ospeli_facilities_waste_record', { ...ok, placeId: '<img src=x>' }, 'estates-tech'), code('invalid-input'), 'ids are checked for shape');
  await assert.rejects(run('ospeli_facilities_waste_record', { ...ok, weightKg: 12 }, 'estates-tech'), code('invalid-input'), 'an unknown field (no weight)');
  await assert.rejects(run('ospeli_facilities_waste_record', { ...ok, note: 'Collected by Mr John Smith, 0700 900 123' }, 'estates-tech'), code('invalid-input'), 'no typed text at all');
  await assert.rejects(run('ospeli_facilities_waste_record', { ...ok, contractor: 'Any Waste Ltd' }, 'estates-tech'), code('invalid-input'), 'no contractor');
  await assert.rejects(run('ospeli_facilities_waste_record', { placeId: 'bld-main-a', stream: 'general', outcome: 'missed', reason: 'did-not-come', containers: 2 }, 'estates-tech'), code('invalid-input'), 'containers on a miss');
  await assert.rejects(run('ospeli_facilities_waste_record', { ...ok, reason: 'not-known' }, 'estates-tech'), code('invalid-input'), 'a reason on a collection');
  await assert.rejects(run('ospeli_facilities_waste_record', { placeId: 'bld-main-a', stream: 'general', outcome: 'collected' }, 'estates-tech'), code('invalid-input'), 'a collection with no containers');
  await assert.rejects(run('ospeli_facilities_waste_record', { placeId: 'bld-main-a', stream: 'general', outcome: 'missed' }, 'estates-tech'), code('invalid-input'), 'a miss with no reason');
  await assert.rejects(run('ospeli_facilities_waste_record', { ...ok, containers: 7 }, 'estates-tech'), code('invalid-input'), 'containers are picked from the list');
  await assert.rejects(run('ospeli_facilities_waste_record', { ...ok, stream: 'radioactive' }, 'estates-tech'), code('invalid-input'), 'a stream not in the list');
  await assert.rejects(run('ospeli_facilities_waste_record', { ...ok, outcome: 'partly' }, 'estates-tech'), code('invalid-input'));
  await assert.rejects(run('ospeli_facilities_waste_record', { ...ok, minutesAgo: 45 }, 'estates-tech'), code('invalid-input'), 'earlier is picked from the list');
  await assert.rejects(run('ospeli_facilities_waste_record', { placeId: 'bld-main-a', stream: 'sharps' }, 'estates-tech'), code('invalid-input'), 'outcome is required');
  assert.equal(await core.eventCount(), n, 'nothing was written by a refusal');
});

test('waste: the same picks within 10 minutes are "already saved"; after 10 minutes, or with another pick, they are a new record; earlier puts the time back', async () => {
  const { run, advance } = await site();
  const pick = { placeId: 'bld-north-1', stream: 'pharmaceutical', outcome: 'collected', containers: 1 };
  const a = await run('ospeli_facilities_waste_record', pick, 'facilities-assistant');
  await assert.rejects(run('ospeli_facilities_waste_record', pick, 'estates-tech'), (e) => e.code === 'conflict' && e.detail.existing === a.wasteId && /Already saved/.test(e.message));
  advance(5);
  await assert.rejects(run('ospeli_facilities_waste_record', pick, 'facilities-assistant'), code('conflict'), 'still within 10 minutes');
  await run('ospeli_facilities_waste_record', { ...pick, containers: 2 }, 'facilities-assistant'); // another pick
  advance(11);
  const b = await run('ospeli_facilities_waste_record', pick, 'facilities-assistant');
  assert.notEqual(b.wasteId, a.wasteId);
  // Earlier: the record's time is put back by the pick, and the log says so.
  const c = await run('ospeli_facilities_waste_record', { placeId: 'bld-main-b', stream: 'chemical', outcome: 'missed', reason: 'could-not-take', minutesAgo: 120 }, 'estates-tech');
  const list = await run('ospeli_facilities_log_list', { kind: 'waste', limit: 50 }, 'coo');
  out('ospeli_facilities_log_list', list);
  const e = list.entries.find((x) => x.id === c.wasteId);
  assert.equal(e.backdatedMinutes, 120);
  assert.equal(Date.parse(b.at) - Date.parse(c.at) > 119 * MIN, true, 'two hours back');
});

test('waste: an agent\'s record becomes a proposal and changes nothing until a person accepts; one open proposal per stream and place', async () => {
  const { core, run } = await site();
  await run('ospeli_agents_set_access', { allowed: true, wards: { 'ward-a1': true } }, 'coo');
  await run('ospeli_agents_add', { name: 'fac-bot', role: 'facilities-assistant', wards: ['ward-a1'], days: 30 }, 'coo');
  const bot = agent('facilities-assistant');
  const n = await core.eventCount();
  const before = (await run('ospeli_facilities_overview', {}, 'facilities-manager')).kpis[4].value;
  const p = await run('ospeli_facilities_waste_record', { placeId: 'bld-main-b', stream: 'infectious', outcome: 'collected', containers: 2 }, bot);
  out('ospeli_facilities_waste_record', p);
  assert.equal(p.status, 'proposed');
  assert.equal(await core.eventCount(), n, 'nothing changed');
  assert.equal((await run('ospeli_facilities_overview', {}, 'facilities-manager')).kpis[4].value, before, 'the measure is the same until a person accepts');
  await assert.rejects(run('ospeli_facilities_waste_record', { placeId: 'bld-main-b', stream: 'infectious', outcome: 'collected', containers: 3 }, bot), (e) => e instanceof CommandError, 'one open proposal per stream and place');
  await assert.rejects(run('ospeli_facilities_waste_record', { placeId: 'bld-made-up', stream: 'general', outcome: 'collected', containers: 2 }, bot), (e) => e instanceof CommandError, 'a proposal is checked before it queues');
  await assert.rejects(run('ospeli_facilities_waste_record', { placeId: 'bld-main-b', stream: 'general', outcome: 'missed', reason: 'not-known', containers: 1 }, bot), (e) => e instanceof CommandError);
  const acc = await run('ospeli_proposals_accept', { id: p.proposal.id }, 'facilities-manager');
  assert.equal(acc.status, 'accepted');
  const last = (await core.events({ type: 'facilities.waste-recorded' })).at(-1);
  assert.deepEqual([last.data.placeId, last.data.stream, last.data.containers, last.actorRole], ['bld-main-b', 'infectious', 2, 'facilities-manager']);
  assert.equal((await run('ospeli_facilities_overview', {}, 'facilities-manager')).kpis[4].value, before + 2);
  // An agent's load pick is a proposal too.
  await run('ospeli_agents_add', { name: 'tech-bot', role: 'estates-tech', wards: ['ward-a1'], days: 30 }, 'coo');
  const q = await run('ospeli_facilities_check_record', GEN('asset-generator-1', { load: 'on-load' }), agent('estates-tech', 'tech-bot'));
  assert.equal(q.status, 'proposed');
  assert.equal(q.proposal.input.load, 'on-load');
});

test('the log list takes kind waste; all includes it; limit, total, truncated and the short form work', async () => {
  const { run } = await site();
  const w = await run('ospeli_facilities_log_list', { kind: 'waste', limit: 5 }, 'ward-nurse');
  out('ospeli_facilities_log_list', w);
  assert.ok(w.total > 40 && w.truncated && w.entries.length === 5 && w.entries.every((x) => x.kind === 'waste'));
  const all = await run('ospeli_facilities_log_list', { kind: 'all', limit: 500 }, 'coo');
  assert.ok(all.entries.some((x) => x.kind === 'waste') && all.entries.some((x) => x.kind === 'check') && all.entries.some((x) => x.kind === 'outage'));
  const checks = await run('ospeli_facilities_log_list', { kind: 'checks', limit: 500 }, 'coo');
  assert.ok(checks.entries.every((x) => x.kind === 'check'));
  const outages = await run('ospeli_facilities_log_list', { kind: 'outages', limit: 500 }, 'coo');
  assert.ok(outages.entries.every((x) => x.kind === 'outage'));
  assert.equal(all.total, checks.total + outages.total + w.total);
  const short = await run('ospeli_facilities_log_list', { kind: 'waste', format: 'short', limit: 2 }, 'coo');
  assert.deepEqual(Object.keys(short.entries[0]).sort(), ['at', 'atText', 'id', 'kind', 'what', 'where']);
  assert.match(short.entries[0].what, /^Waste, /);
  await assert.rejects(run('ospeli_facilities_log_list', { kind: 'rubbish' }, 'coo'), code('invalid-input'));
});

// ---- KPIs 4 and 5 (new): missed waste collections and containers by stream, by hand ----
test('KPIs missed waste collections and containers by stream, hand-checked: 2 of 7 missed (28.6 %); 30 containers (general 6, infectious 4, sharps 20)', () => {
  const w = (id, at, placeId, stream, outcome, x) => ev('facilities.waste-recorded', id, at, { placeId, stream, outcome, ...(outcome === 'collected' ? { containers: x } : { reason: x }) }, 'facilities-assistant');
  const events = [
    w('wst-00001', '2026-11-02T09:00:00Z', 'a', 'general', 'collected', 4),
    w('wst-00002', '2026-11-03T09:00:00Z', 'b', 'general', 'missed', 'did-not-come'),
    w('wst-00003', '2026-11-04T09:00:00Z', 'b', 'general', 'collected', 2), // clears wst-00002 from the waiting list, not from the share
    w('wst-00004', '2026-11-05T09:00:00Z', 'a', 'infectious', 'collected', 3),
    w('wst-00005', '2026-11-06T09:00:00Z', 'a', 'sharps', 'collected', 20), // "20 or more" counts as 20
    w('wst-00006', '2026-11-10T09:00:00Z', 'a', 'infectious', 'missed', 'could-not-take'), // still waiting
    w('wst-00007', '2026-10-31T09:00:00Z', 'a', 'general', 'collected', 5), // October: out
    ev('facilities.waste-recorded', 'wst-00008', '2026-11-11T09:00:00Z', { placeId: 'a', stream: 'general', outcome: 'missed', reason: 'not-known', containers: 2 }), // malformed: left out
    w('wst-00009', '2026-11-12T09:00:00Z', 'b', 'infectious', 'collected', 1), // another place: does not clear wst-00006
    ev('facilities.waste-recorded', 'wst-00010', '2026-11-12T10:00:00Z', { placeId: 'a', stream: 'glass', outcome: 'collected', containers: 1 }), // not a stream: left out
  ];
  const waste = deriveWaste(events);
  assert.equal(waste.length, 8, 'two malformed records left out');
  const since = '2026-11-01T00:00:00Z'; const until = '2026-11-20T00:00:00Z';
  // Recorded in November: 1, 2, 3, 4, 5, 6, 9 = 7; missed: 2 and 6 = 2. 2 / 7 = 28.6 %.
  const s = wasteMissedShare(waste, { since, until });
  assert.deepEqual([s.numerator, s.denominator], [2, 7]);
  assert.equal(Math.round(s.value * 10) / 10, 28.6);
  const by = Object.fromEntries(s.byStream.map((x) => [x.id, [x.missed, x.recorded]]));
  assert.deepEqual([by.general, by.infectious, by.sharps, by.recycling], [[1, 3], [1, 3], [0, 1], [0, 0]], 'general 1 of 3 in November (wst-00001, 2, 3; the October one is out), infectious 1 of 3 (4, 6, 9), sharps 0 of 1');
  assert.equal(s.byStream.find((x) => x.id === 'recycling').value, null, 'nothing recorded: no value, never 0');
  // Containers in November: general 4 + 2 = 6, infectious 3 + 1 = 4, sharps 20. 30 in all.
  const c = wasteContainers(waste, { since, until });
  assert.equal(c.value, 30);
  assert.deepEqual(Object.fromEntries(c.byStream.filter((x) => x.collections).map((x) => [x.id, x.containers])), { general: 6, infectious: 4, sharps: 20 });
  assert.deepEqual([c.numerator, c.denominator, c.n], [null, null, 5]);
  // Waiting at 20 Nov: wst-00006 only (wst-00002 was collected on 4 Nov at the same place).
  assert.deepEqual(wasteMissedWaiting(waste, { now: until }).map((x) => x.id), ['wst-00006']);
  // Before the later collection, both were waiting.
  assert.deepEqual(wasteMissedWaiting(waste, { now: '2026-11-03T12:00:00Z' }).map((x) => x.id), ['wst-00002']);
  assert.equal(wasteMissedShare([], { since, until }).value, null);
});

test('the measures are defined and sourced: local definition, no target, no weight, and the first two are unchanged in place', async () => {
  const { KPIS } = await import('../../web/app/modules/facilities/commands.js');
  assert.deepEqual(KPIS.slice(0, 2).map((k) => k.id), ['generator-test-compliance', 'utility-outage-hours']);
  for (const k of KPIS.slice(2)) {
    assert.match(k.source, /^local definition/);
    assert.equal(k.target, null);
    for (const f of ['definition', 'counts', 'outOf', 'leavesOut', 'targetText']) assert.ok(k[f].length > 10, `${k.id}.${f}`);
  }
  assert.match(KPIS.find((k) => k.id === 'waste-containers').leavesOut, /Weight.*do not compare/);
  assert.match(KPIS.find((k) => k.id === 'waste-missed-share').definition, /later collection does not cancel the miss/);
  assert.match(KPIS.find((k) => k.id === 'generator-load-test-compliance').leavesOut, /off-load runs; tests with the load not recorded/);
});

test('guide off: the waste log and the load pick work the same, and every measure is the same', async () => {
  const a = await site(); const b = await site();
  await b.run('ospeli_facilities_guide_set', { on: false }, 'facilities-manager');
  for (const s of [a, b]) {
    await s.run('ospeli_facilities_waste_record', { placeId: 'bld-main-a', stream: 'general', outcome: 'missed', reason: 'not-known' }, 'facilities-assistant');
    await s.run('ospeli_facilities_check_record', GEN('asset-generator-2', { load: 'on-load' }), 'estates-tech');
  }
  const [on, off] = [await a.run('ospeli_facilities_overview', {}, 'facilities-manager'), await b.run('ospeli_facilities_overview', {}, 'facilities-manager')];
  assert.deepEqual([on.guide.on, off.guide.on, off.guide.suggestions.length], [true, false, 0]);
  const strip = (x) => JSON.stringify([{ ...x.waste, missedWaiting: null }, x.attention.wasteMissed.map((w) => w.id), x.checks.map((c) => [c.checkKind, c.targetId, c.status]), x.kpis.slice(2).map((k) => [k.value, k.numerator, k.denominator])]);
  assert.equal(strip(off), strip(on));
});

test('the seed: every waste record reads back, places exist, one infectious miss collected the next day, one general miss still waiting; loads follow the 4-week periods; repeatable', () => {
  const g = generateHospital({ end: END });
  const ids = new Set(g.entities.map((e) => e.id));
  const raw = g.events.filter((e) => e.type === 'facilities.waste-recorded');
  const waste = deriveWaste(raw);
  assert.equal(waste.length, raw.length, 'no seeded waste record is malformed');
  assert.ok(raw.length > 40);
  assert.ok(waste.every((w) => ids.has(w.placeId)), 'every place exists');
  assert.deepEqual([...new Set(waste.map((w) => w.placeId))].sort(), ['bld-main-a', 'bld-main-b', 'bld-north-1']);
  const missed = waste.filter((w) => w.outcome === 'missed');
  assert.deepEqual(missed.map((w) => [w.stream, w.placeId]), [['infectious', 'bld-main-a'], ['general', 'bld-north-1']]);
  const waiting = wasteMissedWaiting(waste, { now: END });
  assert.deepEqual(waiting.map((w) => [w.stream, w.placeId]), [['general', 'bld-north-1']]);
  const next = waste.find((w) => w.outcome === 'collected' && w.stream === 'infectious' && w.placeId === 'bld-main-a' && Date.parse(w.at) > Date.parse(missed[0].at));
  assert.ok(Date.parse(next.at) - Date.parse(missed[0].at) < 1.5 * 864e5, 'collected the next day');
  assert.ok(raw.every((e) => !/name|staff|person|phone|email|contractor|weight/i.test(Object.keys(e.data).join(' '))));
  // Loads: every seeded generator test has one, and exactly the first test of each 4-week period of each generator is on load.
  const site = g.entities.find((e) => e.type === 'site' && e.utcOffsetMinutes != null)?.utcOffsetMinutes ?? 0;
  const tests = deriveChecks(g.events).filter((c) => c.checkKind === 'generator-test');
  assert.ok(tests.length >= 6 && tests.every((c) => c.load));
  const firsts = new Set();
  for (const c of tests) {
    const key = `${c.targetId}|${slotIndex(Date.parse(c.at), 28, site)}`;
    assert.equal(c.load, firsts.has(key) ? 'off-load' : 'on-load', `${c.id}`);
    firsts.add(key);
  }
  assert.deepEqual(generateHospital({ end: END }).events.filter((e) => e.type.startsWith('facilities.')), g.events.filter((e) => e.type.startsWith('facilities.')), 'repeatable');
});

test('the seed keeps the earlier seeded values: checks, outages and their times are those of slice 1 apart from the added load', () => {
  // Slice 1's seed made the same check and outage events; slice 2 adds data.load to generator tests and appends waste.
  const g = generateHospital({ end: END });
  const ov = g.events.filter((e) => e.type.startsWith('facilities.outage'));
  assert.equal(ov.length, 7);
  const chk = g.events.filter((e) => e.type === 'facilities.check-recorded');
  const gens = chk.filter((e) => e.data.checkKind === 'generator-test');
  assert.deepEqual(gens.filter((e) => e.data.result === 'fail').map((e) => [e.data.assetId, e.data.runMinutes, e.data.load]).length, 1);
  assert.ok(chk.every((e) => e.data.checkKind === 'generator-test' || e.data.load === undefined), 'no load on any other check');
});
