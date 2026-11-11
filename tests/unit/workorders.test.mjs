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
import { deriveWorkOrders, slaText, nextWorkOrderId, FAULT_TYPES, ALL_FAULTS } from '../../web/app/core/workorders.js';

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
  const q = await runCommand(core, 'workorders.list', {}, human('estates-tech'));
  schemaOk('workorders.list', q);
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
  const done = await runCommand(core, 'workorders.list', { state: 'completed' }, human('coo'));
  assert.ok(done.workOrders.length > 30, 'a month of completed work orders');
  assert.ok(done.workOrders.every((w) => typeof w.metSla === 'boolean'));
  // Every generated fault title is one people can pick.
  for (const w of done.workOrders) assert.ok(ALL_FAULTS.includes(w.title), w.title);
});

test('report, assign and complete a fault; the SLA clock and the KPIs follow the log', async () => {
  const core = await hospital();
  const before = await runCommand(core, 'workorders.list', {}, human('ward-nurse'));
  const assets = await runCommand(core, 'assets.list', { locationId: 'ward-a1' }, human('ward-nurse'));
  schemaOk('assets.list', assets);
  const sink = assets.assets.find((a) => a.kind === 'sink');
  assert.deepEqual(sink.faults.slice(0, 2), ['Blocked sink', 'Tap leaking']);
  await assert.rejects(runCommand(core, 'fault.report', { assetId: sink.id, fault: 'Lift out of service', priority: 'high' }, human('ward-nurse')), code('invalid-input'));
  await assert.rejects(runCommand(core, 'fault.report', { assetId: sink.id, fault: 'Blocked sink', priority: 'high', note: 'free text' }, human('ward-nurse')), code('invalid-input'));
  await assert.rejects(runCommand(core, 'fault.report', { assetId: sink.id, fault: 'Blocked sink', priority: 'high' }, human('coo')), code('forbidden'));

  const rep = await runCommand(core, 'fault.report', { assetId: sink.id, fault: 'Blocked sink', priority: 'urgent' }, human('ward-nurse'));
  schemaOk('fault.report', rep);
  assert.equal(rep.status, 'done');
  assert.equal(rep.workOrderId, nextWorkOrderId((await core.events()).slice(0, -1)));
  const q = await runCommand(core, 'workorders.list', {}, human('estates-tech'));
  assert.equal(q.counts.open, before.counts.open + 1);
  const mine = q.workOrders.find((w) => w.id === rep.workOrderId);
  assert.equal(mine.team, 'estates');
  assert.equal(Date.parse(mine.dueAt) - Date.parse(mine.reportedAt), 4 * 3600e3, 'urgent: 4 h target');
  assert.match(slaText(mine, core.now()), /^Due in (3 h 59 min|4 h)$/);
  assert.match(slaText({ ...mine, dueAt: new Date(Date.parse(core.now()) - 90 * 60e3).toISOString() }, core.now()), /^Overdue by 1 h 30 min$/);

  await assert.rejects(runCommand(core, 'workorder.assign', { workOrderId: rep.workOrderId, team: 'biomed' }, human('ward-nurse')), code('forbidden'));
  const asg = await runCommand(core, 'workorder.assign', { workOrderId: rep.workOrderId, team: 'contractor', expectedState: 'open' }, human('estates-tech'));
  schemaOk('workorder.assign', asg);
  await assert.rejects(runCommand(core, 'workorder.complete', { workOrderId: rep.workOrderId, outcome: 'fixed', expectedState: 'open' }, human('estates-tech')), code('conflict'), 'stale state is refused');
  await runCommand(core, 'workorder.complete', { workOrderId: rep.workOrderId, outcome: 'fixed', expectedState: 'assigned' }, human('estates-tech'));
  await assert.rejects(runCommand(core, 'workorder.complete', { workOrderId: rep.workOrderId, outcome: 'fixed' }, human('estates-tech')), code('conflict'), 'only once');
  const w = deriveWorkOrders(await core.events(), core.now()).get(rep.workOrderId);
  assert.deepEqual([w.state, w.team, w.outcome, w.metSla], ['completed', 'contractor', 'fixed', true]);
  const after = await runCommand(core, 'workorders.list', {}, human('estates-tech'));
  assert.equal(after.counts.open, before.counts.open);
  await assert.rejects(runCommand(core, 'workorder.assign', { workOrderId: 'wo-99999', team: 'estates' }, human('estates-tech')), code('not-found'));
});

test('repeat faults: a second fault on the same asset within 30 days is flagged', async () => {
  const core = await hospital();
  const a = (await runCommand(core, 'assets.list', { locationId: 'ward-b1' }, human('ward-nurse'))).assets.find((x) => x.kind === 'call-bell');
  const prior = [...deriveWorkOrders(await core.events(), core.now()).values()].filter((w) => w.assetId === a.id
    && Date.parse(core.now()) - Date.parse(w.reportedAt) <= 30 * 864e5).length;
  const first = await runCommand(core, 'fault.report', { assetId: a.id, fault: 'Call bell not working', priority: 'high' }, human('ward-nurse'));
  assert.equal(first.repeat, prior);
  const second = await runCommand(core, 'fault.report', { assetId: a.id, fault: 'Call bell not working', priority: 'high' }, human('ward-nurse'));
  assert.equal(second.repeat, prior + 1);
  const q = await runCommand(core, 'workorders.list', { assetId: a.id }, human('estates-tech'));
  assert.ok(q.counts.repeat >= 1);
  assert.equal(q.workOrders.find((w) => w.id === second.workOrderId).repeat, prior + 1);
});

test('agents: off by default, scoped to wards, and a fault report waits for a person', async () => {
  const core = await hospital();
  await assert.rejects(runCommand(core, 'workorders.list', {}, agent('estates-tech')), code('agents-off'));
  await runCommand(core, 'agents.set-access', { allowed: true, wards: { 'ward-a1': true } }, human('ops-manager'));
  // Agents must also be on the site's list, each for one role (issues #20, #25).
  await runCommand(core, 'agent.add', { name: 'fix-bot', role: 'estates-tech', wards: ['ward-a1', 'ward-b1'], days: 30 }, human('ops-manager'));
  await runCommand(core, 'agent.add', { name: 'ward-bot', role: 'ward-nurse', wards: ['ward-a1', 'ward-b1'], days: 30 }, human('ops-manager'));
  const q = await runCommand(core, 'workorders.list', { state: 'all' }, agent('estates-tech'));
  assert.ok(q.workOrders.length > 0 && q.workOrders.every((w) => w.locationId === 'ward-a1'), 'agents see only wards switched on');
  const assets = await runCommand(core, 'assets.list', {}, agent('ward-nurse', 'ward-bot'));
  assert.ok(assets.assets.every((x) => x.locationId === 'ward-a1'));
  await assert.rejects(runCommand(core, 'fault.report', { assetId: 'asset-b1-sink-1', fault: 'Blocked sink', priority: 'routine' }, agent('ward-nurse', 'ward-bot')), code('agents-off'));

  const n = await core.eventCount();
  const prop = await runCommand(core, 'fault.report', { assetId: 'asset-a1-sink-1', fault: 'Blocked sink', priority: 'routine' }, agent('ward-nurse', 'ward-bot'));
  assert.equal(prop.status, 'proposed');
  assert.equal(await core.eventCount(), n, 'nothing is reported until a person accepts');
  const acc = await runCommand(core, 'proposal.accept', { id: prop.proposal.id }, human('ward-nurse'));
  assert.equal(acc.status, 'accepted');
  assert.match(acc.result.workOrderId, /^wo-\d{5}$/);
  assert.equal((await core.events()).at(-1).actorRole, 'ward-nurse');

  // A work-order proposal goes stale if a person moves it on first.
  const open = (await runCommand(core, 'workorders.list', {}, agent('estates-tech'))).workOrders[0];
  const p2 = await runCommand(core, 'workorder.complete', { workOrderId: open.id, outcome: 'fixed' }, agent('estates-tech'));
  assert.equal(p2.proposal.seenState, open.state);
  await runCommand(core, 'workorder.complete', { workOrderId: open.id, outcome: 'escalated' }, human('estates-tech'));
  const out = await runCommand(core, 'proposal.accept', { id: p2.proposal.id }, human('estates-tech'));
  assert.equal(out.status, 'expired');
});

test('every asset kind in the synthetic hospital has fault types', async () => {
  const core = await hospital();
  for (const a of await core.listEntities('asset')) assert.ok(FAULT_TYPES[a.kind], a.kind);
});
