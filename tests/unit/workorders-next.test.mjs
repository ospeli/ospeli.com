// Issue #83: the facilities technician's "do next" queue. The suggestion is a fixed rule (highest
// priority, then most late), not AI; Start job is a command that writes workorder.started.
// Everything here runs without the UI.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Core } from '../../web/app/core/core.js';
import { MemoryAdapter } from '../../web/app/core/db.js';
import { loadSyntheticHospital } from '../../web/app/core/generator.js';
import { runCommand, commandByName, describeCommand, CommandError } from '../../web/app/core/commands.js';
import { validate } from '../../web/app/core/schema.js';
import { computeKpi } from '../../web/app/core/kpi.js';
import {
  deriveWorkOrders, suggestQueue, suggestNext, sortWorkOrders, lateMinutes, lateBar, slaText, SUGGEST_RULE, WO_STATES, teamOfRole,
} from '../../web/app/core/workorders.js';

const END = '2026-11-06T18:00:00.000Z';
const NOW = '2026-11-10T10:00:00.000Z';
const human = (role) => ({ type: 'human', role });
const agent = (role, name = 'fix-bot') => ({ type: 'agent', role, agent: name });
const code = (c) => (err) => err instanceof CommandError && err.code === c;
const schemaOk = (name, out) => assert.deepEqual(validate(commandByName(name).output, out, 'output'), []);
const ago = (hours) => new Date(Date.parse(NOW) - hours * 3600e3).toISOString();

// The synthetic hospital, plus faults reported through the command for the facilities team (two
// urgent, two high, one routine, on wards A1 and B1), then 30 hours pass: the urgent and high ones are late.
async function hospital() {
  let t = Date.parse(END);
  const core = await Core.open({ adapter: new MemoryAdapter(), clock: () => new Date(t += 1000) });
  await loadSyntheticHospital(core, { end: END });
  const want = [['ward-a1', 'sink', 'Tap leaking', 'urgent'], ['ward-b1', 'sink', 'Tap leaking', 'high'], ['ward-a1', 'light', 'Tripped breaker', 'urgent'],
    ['ward-b1', 'door-closer', 'Door will not latch', 'high'], ['ward-a1', 'ac', 'AC not cooling', 'routine']];
  for (const [locationId, kind, fault, priority] of want) {
    const { assets } = await runCommand(core, 'ospeli_assets_list', { locationId, limit: 1000 }, human('ward-nurse'));
    await runCommand(core, 'ospeli_workorders_report_fault', { assetId: assets.find((a) => a.kind === kind).id, fault, priority }, human('ward-nurse'));
    t += 600e3;
  }
  t += 30 * 3600e3;
  return core;
}

// A hand-made log: n is the work-order number, hours is how long ago it was reported.
const report = (n, priority, hours, trade = 'estates', asset = `asset-x-${n}`) => ({
  type: 'asset.fault-reported', subject: asset, actorRole: 'ward-nurse', at: ago(hours),
  data: { workOrder: `wo-${String(n).padStart(5, '0')}`, title: 'Blocked sink', trade, priority },
});
const ids = (list) => list.map((w) => Number(w.id.slice(3)));

test('the rule: highest priority first, then the most late; ties by oldest report, then id', () => {
  const events = [
    report(1, 'routine', 200), // late by 128 h
    report(2, 'high', 30), // late by 6 h
    report(3, 'high', 50), // late by 26 h: the most late of the high ones
    report(4, 'urgent', 5), // late by 1 h
    report(5, 'urgent', 3), // due in 1 h
    report(6, 'urgent', 5), // same due time as 4: the lower id goes first
    report(7, 'urgent', 100, 'biomed'), // another team: never suggested to the facilities team
  ];
  const orders = deriveWorkOrders(events, NOW);
  assert.deepEqual(ids(suggestQueue(orders, 'estates')), [4, 6, 5, 3, 2, 1]);
  assert.deepEqual(ids(suggestQueue(orders, 'biomed')), [7]);
  // The same due time, reported at different times (a target changed locally): the oldest report first.
  const a = { id: 'wo-00009', team: 'estates', state: 'open', priority: 'high', dueAt: ago(1), reportedAt: ago(20) };
  const b = { id: 'wo-00008', team: 'estates', state: 'open', priority: 'high', dueAt: ago(1), reportedAt: ago(10) };
  assert.deepEqual(ids(suggestQueue([b, a], 'estates')), [9, 8]);
  // Deterministic: the order of the input does not matter.
  assert.deepEqual(ids(suggestQueue([...orders.values()].reverse(), 'estates')), [4, 6, 5, 3, 2, 1]);
});

test('the suggestion says why in plain words, counts its place, and Pick another cycles', () => {
  const events = [report(1, 'routine', 200), report(2, 'high', 30), report(3, 'high', 50), report(4, 'urgent', 5), report(5, 'urgent', 3)];
  const orders = deriveWorkOrders(events, NOW);
  const first = suggestNext(orders, { team: 'estates', now: NOW });
  assert.equal(first.workOrder.id, 'wo-00004');
  assert.deepEqual([first.position, first.total], [1, 5]);
  assert.equal(first.reason, 'Why this one: urgent, and the most late of the 2 urgent jobs.');
  const second = suggestNext(orders, { team: 'estates', skip: 1, now: NOW });
  assert.equal(second.workOrder.id, 'wo-00005');
  assert.deepEqual([second.position, second.total], [2, 5]);
  assert.equal(second.reason, 'Why this one: next by the same rule (2 of 5). Urgent, due in 1 h.');
  assert.equal(suggestNext(orders, { team: 'estates', skip: 5, now: NOW }).workOrder.id, 'wo-00004', 'after the last job it starts again');
  assert.equal(suggestNext(orders, { team: 'estates', skip: 7, now: NOW }).position, 3);

  // No urgent job: the reason says so. One job only: it says that.
  const calm = deriveWorkOrders([report(1, 'routine', 200), report(2, 'high', 30), report(3, 'high', 50)], NOW);
  assert.equal(suggestNext(calm, { team: 'estates', now: NOW }).reason, 'Why this one: no urgent jobs are open. High priority, and the most late of the 2 high priority jobs.');
  const one = deriveWorkOrders([report(1, 'routine', 10)], NOW);
  assert.equal(suggestNext(one, { team: 'estates', now: NOW }).reason, 'Why this one: it is the only job open for this team.');
  const soon = deriveWorkOrders([report(1, 'urgent', 1), report(2, 'urgent', 2)], NOW);
  assert.equal(suggestNext(soon, { team: 'estates', now: NOW }).reason, 'Why this one: urgent, and due first of the 2 urgent jobs.');
  const none = suggestNext(new Map(), { team: 'estates', now: NOW });
  assert.deepEqual([none.workOrder, none.position, none.total], [null, 0, 0]);
  assert.match(SUGGEST_RULE, /fixed rule, not AI/i);
  assert.match(SUGGEST_RULE, /highest priority first, then the most late/);
});

test('a job in progress or completed is not suggested; started and re-assigned are derived from the log', () => {
  const started = (n, at, role = 'estates-tech') => ({ type: 'workorder.started', subject: `wo-${String(n).padStart(5, '0')}`, actorRole: role, at, data: {} });
  const events = [report(1, 'urgent', 5), report(2, 'high', 30), report(3, 'routine', 100), started(1, ago(1))];
  let orders = deriveWorkOrders(events, NOW);
  assert.equal(orders.get('wo-00001').state, 'started');
  assert.equal(WO_STATES.started, 'In progress');
  assert.equal(orders.get('wo-00001').startedAt, ago(1));
  assert.equal(orders.get('wo-00001').startedByRole, 'estates-tech', 'the role, never a person');
  assert.equal(orders.get('wo-00001').overdue, true, 'a started job is still open, so it can still be late');
  assert.deepEqual(ids(suggestQueue(orders, 'estates')), [2, 3]);
  // A second start changes nothing; a start after it was completed changes nothing.
  orders = deriveWorkOrders([...events, started(1, ago(0.5))], NOW);
  assert.equal(orders.get('wo-00001').startedAt, ago(1));
  const done = { type: 'workorder.completed', subject: 'wo-00001', actorRole: 'estates-tech', at: ago(0.4), data: { outcome: 'fixed' } };
  orders = deriveWorkOrders([...events, done, started(1, ago(0.2))], NOW);
  assert.equal(orders.get('wo-00001').state, 'completed');
  // Re-assigned to another team while in progress: that team has not started it.
  const moved = { type: 'workorder.assigned', subject: 'wo-00001', actorRole: 'estates-tech', at: ago(0.3), data: { trade: 'contractor' } };
  orders = deriveWorkOrders([...events, moved], NOW);
  assert.deepEqual([orders.get('wo-00001').state, orders.get('wo-00001').team, orders.get('wo-00001').startedAt], ['assigned', 'contractor', null]);
  assert.equal(teamOfRole('estates-tech'), 'estates');
  assert.equal(teamOfRole('ward-nurse'), null);
});

test('lateness is a number and a bar length; the list sorts by priority, most late, or ward', () => {
  const orders = [...deriveWorkOrders([report(1, 'routine', 172), report(2, 'high', 30), report(3, 'urgent', 3), report(4, 'high', 74)], NOW).values()]
    .map((w, i) => ({ ...w, locationName: ['Ward B1', 'Ward A1', 'Plant room', 'Ward A1'][i] }));
  const by = Object.fromEntries(orders.map((w) => [w.id, w]));
  assert.equal(lateMinutes(by['wo-00001'], NOW), 100 * 60);
  assert.equal(lateMinutes(by['wo-00003'], NOW), 0, 'not late yet');
  assert.equal(slaText(by['wo-00001'], NOW), 'Late by 4 d 4 h');
  assert.equal(slaText(by['wo-00002'], NOW), 'Late by 6 h');
  assert.equal(slaText(by['wo-00003'], NOW), 'Due in 1 h');
  // The bar is the share of the most late job in view, 100 at most; a job that is not late has no bar.
  const max = Math.max(...orders.map((w) => lateMinutes(w, NOW)));
  assert.equal(lateBar(by['wo-00001'], NOW, max), 100);
  assert.equal(lateBar(by['wo-00004'], NOW, max), 50);
  assert.equal(lateBar(by['wo-00002'], NOW, max), 6);
  assert.equal(lateBar(by['wo-00003'], NOW, max), 0);
  assert.equal(lateBar(by['wo-00001'], NOW, 10), 100, 'never more than 100');
  assert.equal(lateBar({ ...by['wo-00002'], dueAt: ago(0.02) }, NOW, max), 4, 'a late job always shows some bar');

  const groups = (sort) => sortWorkOrders(orders, sort).map((g) => [g.name, ids(g.items)]);
  assert.deepEqual(groups('priority'), [['Urgent', [3]], ['High', [4, 2]], ['Routine', [1]]]);
  assert.deepEqual(groups('late'), [[null, [1, 4, 2, 3]]]);
  assert.deepEqual(groups('ward'), [['Plant room', [3]], ['Ward A1', [4, 2]], ['Ward B1', [1]]]);
  assert.deepEqual(sortWorkOrders([], 'priority'), []);
});

test('ospeli_workorders_next: the suggested job for a team, with names, the reason and its place', async () => {
  const core = await hospital();
  const next = await runCommand(core, 'ospeli_workorders_next', {}, human('estates-tech'));
  schemaOk('ospeli_workorders_next', next);
  assert.equal(next.synthetic, true);
  assert.deepEqual([next.team, next.teamName], ['estates', 'Facilities team']);
  assert.equal(next.rule, SUGGEST_RULE);
  // Recomputed from the event log alone.
  const queue = suggestQueue(deriveWorkOrders(await core.events(), next.asOf), 'estates');
  assert.ok(queue.length >= 5, 'the facilities team has open jobs');
  assert.equal(queue[0].priority, 'urgent');
  assert.equal(queue[0].title, 'Tap leaking', 'the urgent job reported first is the most late');
  assert.equal(next.reason, 'Why this one: urgent, and the most late of the 2 urgent jobs.');
  assert.match(next.lateText, /^Late by 26 h \d+ min$/);
  assert.equal(next.total, queue.length);
  assert.equal(next.position, 1);
  assert.equal(next.positionText, `1 of ${queue.length}`);
  assert.equal(next.workOrder.id, queue[0].id);
  assert.equal(next.workOrder.team, 'estates');
  assert.ok(next.workOrder.assetName && next.workOrder.locationName, 'names beside ids');
  assert.equal(next.priorityName, { urgent: 'Urgent', high: 'High', routine: 'Routine' }[queue[0].priority]);
  assert.equal(next.lateText, slaText(queue[0], next.asOf));
  assert.match(next.reason, /^Why this one: /);
  assert.deepEqual(next.inProgress, []);
  // Every job before it in the list has a lower rank: nothing more urgent, nothing later in the same priority.
  const rank = { urgent: 0, high: 1, routine: 2 };
  for (const w of queue) assert.ok(rank[w.priority] > rank[queue[0].priority] || (w.priority === queue[0].priority && w.dueAt >= queue[0].dueAt));

  // Pick another: skip moves through the same order and wraps.
  const second = await runCommand(core, 'ospeli_workorders_next', { skip: 1 }, human('estates-tech'));
  assert.equal(second.workOrder.id, queue[1].id);
  assert.equal(second.positionText, `2 of ${queue.length}`);
  const wrap = await runCommand(core, 'ospeli_workorders_next', { skip: queue.length }, human('estates-tech'));
  assert.equal(wrap.workOrder.id, queue[0].id);

  // Another team, by name; a role with no team of its own gets the facilities team unless it says.
  const biomed = await runCommand(core, 'ospeli_workorders_next', { team: 'biomed' }, human('ops-manager'));
  schemaOk('ospeli_workorders_next', biomed);
  assert.equal(biomed.teamName, 'Medical equipment team');
  assert.ok(biomed.workOrder === null || biomed.workOrder.team === 'biomed');
  assert.equal((await runCommand(core, 'ospeli_workorders_next', {}, human('coo'))).team, 'estates');
  await assert.rejects(runCommand(core, 'ospeli_workorders_next', { team: 'nobody' }, human('estates-tech')), code('invalid-input'));
  await assert.rejects(runCommand(core, 'ospeli_workorders_next', { skip: -1 }, human('estates-tech')), code('invalid-input'));

  // It is a read: nothing is written, and a person needs no approval.
  const n = await core.eventCount();
  await runCommand(core, 'ospeli_workorders_next', { skip: 2 }, human('ward-nurse'));
  assert.equal(await core.eventCount(), n);
  const d = describeCommand('ospeli_workorders_next');
  assert.deepEqual([d.kind, d.humanApproval, d.agentBehaviour], ['read', false, 'runs and is audited as an agent read']);
});

test('ospeli_workorders_start: writes workorder.started as the role, the job shows "In progress", and the next one is suggested', async () => {
  const core = await hospital();
  const tech = human('estates-tech');
  const before = await runCommand(core, 'ospeli_workorders_next', {}, tech);
  const id = before.workOrder.id;
  const openBefore = (await runCommand(core, 'ospeli_workorders_list', {}, tech)).counts;

  await assert.rejects(runCommand(core, 'ospeli_workorders_start', { workOrderId: id }, human('ward-nurse')), code('forbidden'));
  await assert.rejects(runCommand(core, 'ospeli_workorders_start', { workOrderId: id }, human('coo')), code('forbidden'));
  await assert.rejects(runCommand(core, 'ospeli_workorders_start', { workOrderId: 'wo-99999' }, tech), code('not-found'));
  await assert.rejects(runCommand(core, 'ospeli_workorders_start', { workOrderId: id, by: 'a name' }, tech), code('invalid-input'));
  await assert.rejects(runCommand(core, 'ospeli_workorders_start', { workOrderId: id, expectedState: 'completed' }, tech), code('conflict'));

  const n = await core.eventCount();
  const out = await runCommand(core, 'ospeli_workorders_start', { workOrderId: id, expectedState: before.workOrder.state }, tech);
  schemaOk('ospeli_workorders_start', out);
  assert.deepEqual([out.status, out.workOrderId, out.state], ['done', id, 'started']);
  assert.equal(await core.eventCount(), n + 1);
  const ev = (await core.events()).at(-1);
  assert.deepEqual([ev.type, ev.subject, ev.actorRole], ['workorder.started', id, 'estates-tech']);
  assert.deepEqual(Object.keys(ev.data).sort(), ['asset'], 'the event names the asset and nothing about a person');
  assert.equal(out.events[0], ev.seq);

  // The queue shows it in progress; it is still open and still counted (the KPIs do not move).
  const list = await runCommand(core, 'ospeli_workorders_list', { limit: 500 }, tech);
  schemaOk('ospeli_workorders_list', list);
  const mine = list.workOrders.find((w) => w.id === id);
  assert.equal(mine.state, 'started');
  assert.equal(WO_STATES[mine.state], 'In progress');
  assert.deepEqual(list.counts, openBefore);
  const events = await core.events();
  assert.equal(list.counts.open, computeKpi('open-work-orders', events, { until: core.now() }).value);
  assert.equal(list.counts.overdue, computeKpi('overdue-work-orders', events, { until: core.now() }).value);

  // The suggestion moves on, and the job in progress is listed beside it.
  const after = await runCommand(core, 'ospeli_workorders_next', {}, tech);
  schemaOk('ospeli_workorders_next', after);
  assert.notEqual(after.workOrder.id, id);
  assert.equal(after.total, before.total - 1);
  assert.deepEqual(after.inProgress.map((w) => w.id), [id]);

  // Starting it twice is refused, in words a person can act on. Nothing is written.
  const m = await core.eventCount();
  await assert.rejects(runCommand(core, 'ospeli_workorders_start', { workOrderId: id }, tech),
    (err) => code('conflict')(err) && /already in progress/i.test(err.message) && /close it|assign/i.test(err.message) && err.detail.state === 'started');
  assert.equal(await core.eventCount(), m);

  // A job in progress can be closed; then it cannot be started.
  const done = await runCommand(core, 'ospeli_workorders_complete', { workOrderId: id, outcome: 'fixed', expectedState: 'started' }, tech);
  assert.equal(done.state, 'completed');
  await assert.rejects(runCommand(core, 'ospeli_workorders_start', { workOrderId: id }, tech),
    (err) => code('conflict')(err) && /already completed/i.test(err.message));
  assert.deepEqual((await runCommand(core, 'ospeli_workorders_next', {}, tech)).inProgress, []);

  // A job in progress can be given to another team: it is theirs to start.
  const id2 = after.workOrder.id;
  await runCommand(core, 'ospeli_workorders_start', { workOrderId: id2 }, human('ops-manager'));
  const moved = await runCommand(core, 'ospeli_workorders_assign', { workOrderId: id2, team: 'contractor', expectedState: 'started' }, tech);
  assert.equal(moved.state, 'assigned');
  const w2 = (await runCommand(core, 'ospeli_workorders_list', { limit: 500 }, tech)).workOrders.find((w) => w.id === id2);
  assert.deepEqual([w2.state, w2.team], ['assigned', 'contractor']);
  // No person anywhere: the events for these work orders carry a role and no name field.
  for (const e of (await core.events()).filter((x) => [id, id2].includes(x.subject))) {
    assert.ok(['estates-tech', 'ops-manager'].includes(e.actorRole));
    assert.ok(!('actor' in e) && !('by' in (e.data || {})) && !('person' in (e.data || {})));
  }
  assert.deepEqual(await core.verifyAudit(), { ok: true });
});

test('ospeli_workorders_start from an agent queues a proposal and writes nothing until a person accepts', async () => {
  const core = await hospital();
  const d = describeCommand('ospeli_workorders_start');
  const assign = describeCommand('ospeli_workorders_assign');
  assert.deepEqual([d.kind, d.humanApproval, d.agentsMayCall, d.agentBehaviour], [assign.kind, assign.humanApproval, assign.agentsMayCall, assign.agentBehaviour]);
  assert.deepEqual(d.roles, assign.roles, 'whoever may assign may start');
  assert.ok(d.roles.includes('estates-tech'));
  assert.deepEqual(validate(d.input, d.example.input), []);

  await runCommand(core, 'ospeli_agents_set_access', { allowed: true, wards: { 'ward-a1': true, 'ward-b1': true } }, human('ops-manager'));
  await runCommand(core, 'ospeli_agents_add', { name: 'fix-bot', role: 'estates-tech', wards: ['ward-a1', 'ward-b1'], days: 30 }, human('ops-manager'));
  const bot = agent('estates-tech');
  // An agent reads the suggestion without approval; the read is audited.
  const next = await runCommand(core, 'ospeli_workorders_next', {}, bot);
  schemaOk('ospeli_workorders_next', next);
  assert.ok((await core.auditLog()).some((r) => r.action === 'agent.read' && r.detail?.command === 'ospeli_workorders_next'));
  assert.ok(next.workOrder, 'a job on a ward the agent may see');
  assert.ok(['ward-a1', 'ward-b1'].includes(next.workOrder.locationId), 'an agent is only shown jobs on its wards');

  const n = await core.eventCount();
  const prop = await runCommand(core, 'ospeli_workorders_start', { workOrderId: next.workOrder.id }, bot);
  assert.equal(prop.status, 'proposed');
  assert.equal(prop.proposal.seenState, next.workOrder.state);
  assert.equal(await core.eventCount(), n, 'nothing is written');
  assert.notEqual((await runCommand(core, 'ospeli_workorders_list', { limit: 500 }, human('estates-tech'))).workOrders.find((w) => w.id === next.workOrder.id).state, 'started');
  await assert.rejects(runCommand(core, 'ospeli_workorders_start', { workOrderId: next.workOrder.id }, agent('ward-nurse', 'fix-bot')), code('forbidden'));

  const acc = await runCommand(core, 'ospeli_proposals_accept', { id: prop.proposal.id }, human('estates-tech'));
  assert.equal(acc.status, 'accepted');
  const ev = (await core.events()).at(-1);
  assert.deepEqual([ev.type, ev.subject, ev.actorRole], ['workorder.started', next.workOrder.id, 'estates-tech']);
  // A second proposal for a job a person has started since goes stale.
  const other = await runCommand(core, 'ospeli_workorders_next', {}, bot);
  const p2 = await runCommand(core, 'ospeli_workorders_start', { workOrderId: other.workOrder.id }, bot);
  await runCommand(core, 'ospeli_workorders_start', { workOrderId: other.workOrder.id }, human('estates-tech'));
  assert.equal((await runCommand(core, 'ospeli_proposals_accept', { id: p2.proposal.id }, human('estates-tech'))).status, 'expired');
});
