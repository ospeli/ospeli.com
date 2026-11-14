// Engineering (backlog item 7): fault report, work-order queue with SLA timers, assign and
// close, repeat-fault detection. Every action runs as a command without the UI.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Core } from '../../web/app/core/core.js';
import { MemoryAdapter } from '../../web/app/core/db.js';
import { loadSyntheticHospital } from '../../web/app/core/generator.js';
import { runCommand, commandByName, CommandError } from '../../web/app/core/commands.js';
import { validate } from '../../web/app/core/schema.js';
import { computeKpi } from '../../web/app/core/kpi.js';
import { deriveWorkOrders, slaText, nextWorkOrderId, FAULT_TYPES, ALL_FAULTS, OTHER_FAULT, repeatText, repeatBadge } from '../../web/app/core/workorders.js';

const END = '2026-11-06T18:00:00.000Z';
const clockFrom = (iso) => { let t = Date.parse(iso); return () => new Date(t += 1000); };
const human = (role) => ({ type: 'human', role });
const agent = (role, name = 'fix-bot') => ({ type: 'agent', role, agent: name });
const code = (c) => (err) => err instanceof CommandError && err.code === c;
const schemaOk = (name, out) => assert.deepEqual(validate(commandByName(name).output, out, 'output'), []);

async function hospital() {
  const core = await Core.open({ adapter: new MemoryAdapter(), clock: clockFrom(END) });
  await loadSyntheticHospital(core, { end: END });
  return core;
}

test('the queue matches the open and overdue work-order KPIs and is most urgent first', async () => {
  const core = await hospital();
  const q = await runCommand(core, 'ospeli_workorders_list', {}, human('estates-tech'));
  schemaOk('ospeli_workorders_list', q);
  assert.equal(q.synthetic, true);
  const events = await core.events();
  const until = core.now();
  assert.equal(q.counts.open, computeKpi('open-work-orders', events, { until }).value);
  assert.equal(q.counts.overdue, computeKpi('overdue-work-orders', events, { until }).value);
  assert.ok(q.workOrders.every((w) => w.state !== 'completed' && w.assetName && w.locationName));
  for (let i = 1; i < q.workOrders.length; i++) {
    const [a, b] = [q.workOrders[i - 1], q.workOrders[i]];
    assert.ok(a.overdue >= b.overdue, 'overdue first');
  }
  const done = await runCommand(core, 'ospeli_workorders_list', { state: 'completed', limit: 500 }, human('coo'));
  assert.ok(done.workOrders.length > 30, 'a month of completed work orders');
  assert.ok(done.workOrders.every((w) => typeof w.metSla === 'boolean'));
  // Every generated fault title is one people can pick.
  for (const w of done.workOrders) assert.ok(ALL_FAULTS.includes(w.title), w.title);
});

test('report, assign and complete a fault; the SLA clock and the KPIs follow the log', async () => {
  const core = await hospital();
  const before = await runCommand(core, 'ospeli_workorders_list', {}, human('ward-nurse'));
  const assets = await runCommand(core, 'ospeli_assets_list', { locationId: 'ward-a1' }, human('ward-nurse'));
  schemaOk('ospeli_assets_list', assets);
  const sink = assets.assets.find((a) => a.kind === 'sink');
  assert.deepEqual(sink.faults.slice(0, 2), ['Blocked sink', 'Tap leaking']);
  await assert.rejects(runCommand(core, 'ospeli_workorders_report_fault', { assetId: sink.id, fault: 'Lift out of service', priority: 'high' }, human('ward-nurse')), code('invalid-input'));
  await assert.rejects(runCommand(core, 'ospeli_workorders_report_fault', { assetId: sink.id, fault: 'Blocked sink', priority: 'high', note: 'free text' }, human('ward-nurse')), code('invalid-input'));
  await assert.rejects(runCommand(core, 'ospeli_workorders_report_fault', { assetId: sink.id, fault: 'Blocked sink', priority: 'high' }, human('coo')), code('forbidden'));

  const rep = await runCommand(core, 'ospeli_workorders_report_fault', { assetId: sink.id, fault: 'Blocked sink', priority: 'urgent' }, human('ward-nurse'));
  schemaOk('ospeli_workorders_report_fault', rep);
  assert.equal(rep.status, 'done');
  assert.equal(rep.workOrderId, nextWorkOrderId((await core.events()).slice(0, -1)));
  const q = await runCommand(core, 'ospeli_workorders_list', {}, human('estates-tech'));
  assert.equal(q.counts.open, before.counts.open + 1);
  const mine = q.workOrders.find((w) => w.id === rep.workOrderId);
  assert.equal(mine.team, 'estates');
  assert.equal(Date.parse(mine.dueAt) - Date.parse(mine.reportedAt), 4 * 3600e3, 'urgent: 4 h target');
  assert.match(slaText(mine, core.now()), /^Due in (3 h 59 min|4 h)$/);
  assert.match(slaText({ ...mine, dueAt: new Date(Date.parse(core.now()) - 90 * 60e3).toISOString() }, core.now()), /^Late by 1 h 30 min$/);

  await assert.rejects(runCommand(core, 'ospeli_workorders_assign', { workOrderId: rep.workOrderId, team: 'biomed' }, human('ward-nurse')), code('forbidden'));
  const asg = await runCommand(core, 'ospeli_workorders_assign', { workOrderId: rep.workOrderId, team: 'contractor', expectedState: 'open' }, human('estates-tech'));
  schemaOk('ospeli_workorders_assign', asg);
  await assert.rejects(runCommand(core, 'ospeli_workorders_complete', { workOrderId: rep.workOrderId, outcome: 'fixed', expectedState: 'open' }, human('estates-tech')), code('conflict'), 'stale state is refused');
  await runCommand(core, 'ospeli_workorders_complete', { workOrderId: rep.workOrderId, outcome: 'fixed', expectedState: 'assigned' }, human('estates-tech'));
  await assert.rejects(runCommand(core, 'ospeli_workorders_complete', { workOrderId: rep.workOrderId, outcome: 'fixed' }, human('estates-tech')), code('conflict'), 'only once');
  const w = deriveWorkOrders(await core.events(), core.now()).get(rep.workOrderId);
  assert.deepEqual([w.state, w.team, w.outcome, w.metSla], ['completed', 'contractor', 'fixed', true]);
  const after = await runCommand(core, 'ospeli_workorders_list', {}, human('estates-tech'));
  assert.equal(after.counts.open, before.counts.open);
  await assert.rejects(runCommand(core, 'ospeli_workorders_assign', { workOrderId: 'wo-99999', team: 'estates' }, human('estates-tech')), code('not-found'));
});

// Issue #24: reporting the same fault twice opened a second work order, and the duplicate was
// counted as a repeat fault. One open work order per fault per asset; a repeat is a fault that
// came back after the earlier work order was completed.
const openOn = async (core, assetId) => (await runCommand(core, 'ospeli_workorders_list', { assetId, limit: 500 }, human('estates-tech')));
const quietAsset = async (core, kind, locationId) => {
  const used = new Set([...deriveWorkOrders(await core.events(), core.now()).values()].map((w) => w.assetId));
  const a = (await runCommand(core, 'ospeli_assets_list', { locationId }, human('ward-nurse'))).assets.find((x) => x.kind === kind && !used.has(x.id));
  assert.ok(a, `an asset of kind ${kind} with no work orders yet`);
  return a;
};

test('issue #24: the same fault reported twice opens one work order; the second answer names it', async () => {
  const core = await hospital();
  const a = await quietAsset(core, 'sink', 'ward-b1');
  const input = { assetId: a.id, fault: 'Blocked sink', priority: 'high' };
  const first = await runCommand(core, 'ospeli_workorders_report_fault', input, human('ward-nurse'));
  const n = await core.eventCount();
  // A double tap, then a second nurse, then another role with another priority: all the same fault.
  for (const [role, priority] of [['ward-nurse', 'high'], ['ward-nurse', 'high'], ['bed-manager', 'urgent']]) {
    await assert.rejects(runCommand(core, 'ospeli_workorders_report_fault', { ...input, priority }, human(role)), (err) => {
      assert.ok(err instanceof CommandError);
      assert.equal(err.code, 'conflict');
      assert.deepEqual(err.detail, { existing: first.workOrderId });
      assert.match(err.message, new RegExp(`^${first.workOrderId.toUpperCase()} is already open for this fault on this asset \\(reported (just now|\\d+ min ago)\\)\\. No new work order was opened\\.$`));
      return true;
    });
  }
  assert.equal(await core.eventCount(), n, 'a refused report writes no event');
  const q = await openOn(core, a.id);
  assert.deepEqual(q.workOrders.map((w) => w.id), [first.workOrderId], 'one work order for one sink');
  assert.deepEqual([q.counts.open, q.counts.repeat], [1, 0], 'a duplicate is not a repeat fault');

  // A different fault on the same asset is a different job and still opens.
  const other = await runCommand(core, 'ospeli_workorders_report_fault', { ...input, fault: 'Tap leaking' }, human('ward-nurse'));
  assert.equal(other.status, 'done');
  assert.equal(other.repeat, 0, 'two open faults on one asset: neither failed again after a fix');
  // The same fault on another asset still opens too.
  const b = await quietAsset(core, 'sink', 'ward-a1');
  assert.equal((await runCommand(core, 'ospeli_workorders_report_fault', { ...input, assetId: b.id }, human('ward-nurse'))).status, 'done');
  assert.deepEqual((await openOn(core, a.id)).counts, { open: 2, overdue: 0, repeat: 0 });
});

test('issue #24: two reports at the same moment still open one work order', async () => {
  const core = await hospital();
  const a = await quietAsset(core, 'sink', 'ward-b1');
  const input = { assetId: a.id, fault: 'Blocked sink', priority: 'routine' };
  const both = await Promise.allSettled([1, 2].map(() => runCommand(core, 'ospeli_workorders_report_fault', input, human('ward-nurse'))));
  assert.deepEqual(both.map((x) => x.status).sort(), ['fulfilled', 'rejected']);
  assert.equal(both.find((x) => x.status === 'rejected').reason.code, 'conflict');
  assert.equal((await openOn(core, a.id)).counts.open, 1);
});

test('issue #24: a repeat fault is one that failed again after a fix, within 30 days', async () => {
  const core = await hospital();
  const a = await quietAsset(core, 'sink', 'ward-b1');
  const input = { assetId: a.id, fault: 'Tap leaking', priority: 'high' };
  const first = await runCommand(core, 'ospeli_workorders_report_fault', input, human('ward-nurse'));
  assert.equal(first.repeat, 0);
  await runCommand(core, 'ospeli_workorders_complete', { workOrderId: first.workOrderId, outcome: 'fixed' }, human('estates-tech'));
  const second = await runCommand(core, 'ospeli_workorders_report_fault', input, human('ward-nurse'));
  schemaOk('ospeli_workorders_report_fault', second);
  assert.equal(second.repeat, 1, 'it failed again after one fix');
  await assert.rejects(runCommand(core, 'ospeli_workorders_report_fault', input, human('ward-nurse')), code('conflict'));
  const q = await openOn(core, a.id);
  assert.deepEqual(q.workOrders.map((w) => [w.id, w.repeat]), [[second.workOrderId, 1]]);
  assert.equal(q.counts.repeat, 1);
  await runCommand(core, 'ospeli_workorders_complete', { workOrderId: second.workOrderId, outcome: 'fixed' }, human('estates-tech'));
  const third = await runCommand(core, 'ospeli_workorders_report_fault', input, human('ward-nurse'));
  assert.equal(third.repeat, 2, 'two earlier fixes');
  assert.match(commandByName('ospeli_workorders_list').output.properties.workOrders.items.properties.repeat.description, /^Failed again after a fix/);
});

test('issue #24: in the log, duplicates never count as repeats and old fixes drop out after 30 days', () => {
  const at = (d, hh) => `2026-10-${String(d).padStart(2, '0')}T${hh}:00:00.000Z`;
  const rep = (when, wo, asset = 'asset-x') => ({ type: 'asset.fault-reported', at: when, subject: asset, actorRole: 'ward-nurse', data: { workOrder: wo, title: 'Blocked sink', priority: 'routine' } });
  const done = (when, wo) => ({ type: 'workorder.completed', at: when, subject: wo, actorRole: 'estates-tech', data: { outcome: 'fixed' } });
  // An older log can hold duplicates (three open work orders for one sink): none is a repeat.
  const dups = deriveWorkOrders([rep(at(1, '09'), 'wo-00001'), rep(at(1, '10'), 'wo-00002'), rep(at(2, '10'), 'wo-00003')], at(3, '00'));
  assert.deepEqual([...dups.values()].map((w) => w.repeat), [0, 0, 0]);
  // Completing them later does not make the earlier duplicates repeats, only what is reported after.
  const log = [rep(at(1, '09'), 'wo-00001'), rep(at(1, '10'), 'wo-00002'), done(at(1, '12'), 'wo-00001'), done(at(1, '12'), 'wo-00002'),
    rep(at(5, '09'), 'wo-00003'), rep(at(5, '09'), 'wo-00004', 'asset-y'), done(at(5, '11'), 'wo-00003'),
    { ...rep('2026-11-03T09:00:00.000Z', 'wo-00005') }, { ...rep('2026-11-20T09:00:00.000Z', 'wo-00006', 'asset-y') }];
  const w = deriveWorkOrders(log, '2026-11-21T00:00:00.000Z');
  assert.deepEqual([...w.values()].map((x) => x.repeat), [0, 0, 2, 0, 1, 0],
    'wo-3 follows two fixes; wo-4 is another asset; wo-5 has one fix left inside 30 days; wo-6 follows no fix');
});

test('issue #24: the open and repeat counts on the queue equal the KPI and the log', async () => {
  const core = await hospital();
  const a = await quietAsset(core, 'sink', 'ward-b1');
  const input = { assetId: a.id, fault: 'Blocked sink', priority: 'routine' };
  const before = await runCommand(core, 'ospeli_workorders_list', {}, human('estates-tech'));
  await runCommand(core, 'ospeli_workorders_report_fault', input, human('ward-nurse'));
  for (let i = 0; i < 2; i++) await assert.rejects(runCommand(core, 'ospeli_workorders_report_fault', input, human('ward-nurse')), code('conflict'));
  const q = await runCommand(core, 'ospeli_workorders_list', { limit: 500 }, human('estates-tech'));
  const events = await core.events();
  assert.equal(q.counts.open, before.counts.open + 1, 'three reports, one more open work order');
  assert.equal(q.counts.open, computeKpi('open-work-orders', events, { until: core.now() }).value);
  assert.equal(q.counts.overdue, computeKpi('overdue-work-orders', events, { until: core.now() }).value);
  assert.equal(q.counts.repeat, before.counts.repeat, 'duplicates add no repeat fault');
  // Counted again straight from the log: an open work order is a repeat when an earlier work order
  // for the same fault on the same asset was closed as Fixed before it was reported, at most 30 days before.
  const completedAt = new Map(events.filter((e) => e.type === 'workorder.completed').map((e) => [e.subject, Date.parse(e.at)]));
  const reports = events.filter((e) => e.type === 'asset.fault-reported');
  // Issue #75: only the same fault, closed as Fixed, counts.
  const fixed = new Set(events.filter((e) => e.type === 'workorder.completed' && (e.data?.outcome || 'fixed') === 'fixed').map((e) => e.subject));
  const fromLog = reports.filter((e) => !completedAt.has(e.data.workOrder) && e.data.title !== OTHER_FAULT && reports.some((o) => o.subject === e.subject
    && o.data.title === e.data.title && fixed.has(o.data.workOrder)
    && completedAt.get(o.data.workOrder) <= Date.parse(e.at) && Date.parse(e.at) - completedAt.get(o.data.workOrder) <= 30 * 864e5)).length;
  assert.equal(q.counts.repeat, fromLog);
  assert.equal(q.workOrders.filter((x) => x.repeat > 0).length, fromLog);
});

test('issue #24: the synthetic hospital has no duplicate open work orders, and some genuine repeat faults', async () => {
  for (const end of [END, '2026-11-10T10:00:00.000Z', '2026-11-13T15:00:00.000Z', '2026-12-01T03:00:00.000Z']) {
    const core = await Core.open({ adapter: new MemoryAdapter(), clock: clockFrom(end) });
    await loadSyntheticHospital(core, { end });
    const all = [...deriveWorkOrders(await core.events(), core.now()).values()];
    const open = all.filter((w) => w.state !== 'completed');
    const keys = open.map((w) => `${w.assetId}|${w.title}`);
    assert.equal(new Set(keys).size, keys.length, `${end}: one open work order per fault per asset`);
    assert.ok(all.filter((w) => w.repeat > 0).length >= 10, `${end}: the month shows faults that came back after a fix`);
    assert.ok(open.some((w) => w.repeat > 0), `${end}: at least one repeat fault is open now`);
  }
});

test('issue #24: an agent gets the same answer, before a proposal is queued and when a proposal goes stale', async () => {
  const core = await hospital();
  await runCommand(core, 'ospeli_agents_set_access', { allowed: true, wards: { 'ward-a1': true } }, human('ops-manager'));
  await runCommand(core, 'ospeli_agents_add', { name: 'ward-bot', role: 'ward-nurse', wards: ['ward-a1'], days: 30 }, human('ops-manager'));
  const bot = agent('ward-nurse', 'ward-bot');
  const a = await quietAsset(core, 'sink', 'ward-a1');
  const input = { assetId: a.id, fault: 'Blocked sink', priority: 'routine' };
  // Two proposals for the same fault while nothing is open: both wait for a person.
  const p1 = await runCommand(core, 'ospeli_workorders_report_fault', input, bot);
  const p2 = await runCommand(core, 'ospeli_workorders_report_fault', input, bot);
  assert.deepEqual([p1.status, p2.status], ['proposed', 'proposed']);
  const acc = await runCommand(core, 'ospeli_proposals_accept', { id: p1.proposal.id }, human('ward-nurse'));
  assert.equal(acc.status, 'accepted');
  // The second is stale now: accepting it opens nothing and says why.
  const n = await core.eventCount();
  const stale = await runCommand(core, 'ospeli_proposals_accept', { id: p2.proposal.id }, human('ward-nurse'));
  assert.equal(stale.status, 'expired');
  assert.match(stale.message, new RegExp(`^${acc.result.workOrderId.toUpperCase()} is already open for this fault`));
  assert.equal(await core.eventCount(), n);
  // A new call for the same fault is refused at once, with the open work order, and nothing is queued.
  const pending = async () => (await runCommand(core, 'ospeli_proposals_list', { status: 'pending' }, human('ward-nurse'))).total;
  const waiting = await pending();
  await assert.rejects(runCommand(core, 'ospeli_workorders_report_fault', input, bot), (err) => err instanceof CommandError && err.code === 'conflict' && err.detail.existing === acc.result.workOrderId);
  assert.equal(await pending(), waiting, 'no proposal is queued for a duplicate');
  assert.equal((await openOn(core, a.id)).counts.open, 1);
  const trail = await core.auditLog();
  assert.ok(trail.some((r) => r.action === 'agent.refused' && r.detail?.code === 'conflict'), 'the refusal is on the audit trail');
});

test('agents: off by default, scoped to wards, and a fault report waits for a person', async () => {
  const core = await hospital();
  await assert.rejects(runCommand(core, 'ospeli_workorders_list', {}, agent('estates-tech')), code('agents-off'));
  await runCommand(core, 'ospeli_agents_set_access', { allowed: true, wards: { 'ward-a1': true } }, human('ops-manager'));
  // Agents must also be on the site's list, each for one role (issues #20, #25).
  await runCommand(core, 'ospeli_agents_add', { name: 'fix-bot', role: 'estates-tech', wards: ['ward-a1', 'ward-b1'], days: 30 }, human('ops-manager'));
  await runCommand(core, 'ospeli_agents_add', { name: 'ward-bot', role: 'ward-nurse', wards: ['ward-a1', 'ward-b1'], days: 30 }, human('ops-manager'));
  const q = await runCommand(core, 'ospeli_workorders_list', { state: 'all' }, agent('estates-tech'));
  assert.ok(q.workOrders.length > 0 && q.workOrders.every((w) => w.locationId === 'ward-a1'), 'agents see only wards switched on');
  const assets = await runCommand(core, 'ospeli_assets_list', {}, agent('ward-nurse', 'ward-bot'));
  assert.ok(assets.assets.every((x) => x.locationId === 'ward-a1'));
  await assert.rejects(runCommand(core, 'ospeli_workorders_report_fault', { assetId: 'asset-b1-sink-1', fault: 'Blocked sink', priority: 'routine' }, agent('ward-nurse', 'ward-bot')), code('agents-off'));

  const n = await core.eventCount();
  const prop = await runCommand(core, 'ospeli_workorders_report_fault', { assetId: 'asset-a1-sink-1', fault: 'Blocked sink', priority: 'routine' }, agent('ward-nurse', 'ward-bot'));
  assert.equal(prop.status, 'proposed');
  assert.equal(await core.eventCount(), n, 'nothing is reported until a person accepts');
  const acc = await runCommand(core, 'ospeli_proposals_accept', { id: prop.proposal.id }, human('ward-nurse'));
  assert.equal(acc.status, 'accepted');
  assert.match(acc.result.workOrderId, /^wo-\d{5}$/);
  assert.equal((await core.events()).at(-1).actorRole, 'ward-nurse');

  // A work-order proposal goes stale if a person moves it on first.
  const open = (await runCommand(core, 'ospeli_workorders_list', {}, agent('estates-tech'))).workOrders[0];
  const p2 = await runCommand(core, 'ospeli_workorders_complete', { workOrderId: open.id, outcome: 'fixed' }, agent('estates-tech'));
  assert.equal(p2.proposal.seenState, open.state);
  await runCommand(core, 'ospeli_workorders_complete', { workOrderId: open.id, outcome: 'escalated' }, human('estates-tech'));
  const out = await runCommand(core, 'ospeli_proposals_accept', { id: p2.proposal.id }, human('estates-tech'));
  assert.equal(out.status, 'expired');
});

test('every asset kind in the synthetic hospital has fault types', async () => {
  const core = await hospital();
  for (const a of await core.listEntities('asset')) assert.ok(FAULT_TYPES[a.kind], a.kind);
});

// Issue #75: a repeat is the same fault on the same asset coming back after it was closed as Fixed.
test('issue #75: "No fault found", "Escalated" and a different fault are not repeats; the badge and the sentence use one number', async () => {
  const core = await hospital();
  const a = await quietAsset(core, 'sink', 'ward-b1');
  const report = (fault) => runCommand(core, 'ospeli_workorders_report_fault', { assetId: a.id, fault, priority: 'routine' }, human('ward-nurse'));
  const close = (id, outcome) => runCommand(core, 'ospeli_workorders_complete', { workOrderId: id, outcome }, human('estates-tech'));
  const before = (await runCommand(core, 'ospeli_workorders_list', {}, human('estates-tech'))).counts.repeat;
  // Closed as "No fault found", then a different fault: not a repeat.
  const first = await report('Blocked sink');
  await close(first.workOrderId, 'no-fault-found');
  const other = await report(OTHER_FAULT);
  assert.equal(other.repeat, 0, 'a different fault after "No fault found"');
  // The same fault again after "No fault found": nothing was fixed, so it did not fail again after a fix.
  const again = await report('Blocked sink');
  assert.equal(again.repeat, 0, 'the same fault after "No fault found"');
  await close(again.workOrderId, 'escalated');
  const afterEscalation = await report('Blocked sink');
  assert.equal(afterEscalation.repeat, 0, 'the same fault after "Escalated"');
  await close(afterEscalation.workOrderId, 'fixed');
  // A different named fault after a fix: not a repeat. "Other fault" twice cannot be told to be the same fault.
  assert.equal((await report('Tap leaking')).repeat, 0, 'a different fault after a fix');
  await close(other.workOrderId, 'fixed');
  assert.equal((await report(OTHER_FAULT)).repeat, 0, '"Other fault" is never counted as the same fault');
  assert.equal((await runCommand(core, 'ospeli_workorders_list', {}, human('estates-tech'))).counts.repeat, before, 'none of these is a repeat fault');
  // The same fault after it was closed as Fixed: a repeat, counted once.
  const back = await report('Blocked sink');
  assert.equal(back.repeat, 1);
  assert.equal((await runCommand(core, 'ospeli_workorders_list', {}, human('estates-tech'))).counts.repeat, before + 1);
  // One number in the badge and in the sentence, and the rule is in the command's own words.
  assert.equal(repeatBadge(1), 'Repeat: 1 earlier fix');
  assert.equal(repeatBadge(4), 'Repeat: 4 earlier fixes');
  assert.match(repeatText(4), /4 earlier fixes of this fault on this asset in 30 days/);
  const words = commandByName('ospeli_workorders_list').output.properties.workOrders.items.properties.repeat.description;
  assert.match(words, /same fault/); assert.match(words, /same asset/); assert.match(words, /closed as Fixed/); assert.match(words, /30 days/);
});
