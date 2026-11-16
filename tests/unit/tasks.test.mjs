// The shared task object (core/tasks.js, core/task-commands.js): a job asked for at a place,
// done by a team. Derived from the event log; a vacated bed is a clean task by itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Core } from '../../web/app/core/core.js';
import { MemoryAdapter } from '../../web/app/core/db.js';
import { loadSyntheticHospital, generateHospital } from '../../web/app/core/generator.js';
import { runCommand, CommandError } from '../../web/app/core/commands.js';
import { computeKpi } from '../../web/app/core/kpi.js';
import { validate } from '../../web/app/core/schema.js';
import { ROLES } from '../../web/app/core/model.js';
import { taskCommands } from '../../web/app/core/task-commands.js';
import { deriveTasks, taskCatalogue, completionStats, sortQueue, nextTaskId, bedCleanId, CANCEL_REASONS } from '../../web/app/core/tasks.js';

const END = '2026-11-06T18:00:00.000Z';
const clockFrom = (iso) => { let t = Date.parse(iso); return () => new Date(t += 1000); };
const human = (role) => ({ type: 'human', role });
const agent = (role, name = 'task-bot') => ({ type: 'agent', role, agent: name });
const code = (c) => (err) => err instanceof CommandError && err.code === c;
const ROLE_IDS = ROLES.map((r) => r.id);

// A module's kinds of task, written the way a module's commands.js would. It uses roles that
// exist in every build, so the test does not depend on which modules are merged.
const PACK = {
  id: 'testmod',
  TASK_TEAMS: { moving: 'Moving team' },
  TASK_KINDS: [
    { id: 'test-move', name: 'Patient move', team: 'moving', needsTo: true, details: ['Wheelchair', 'Bed', 'Walking'], startLabel: 'Collected', startedName: 'On the way', doneLabel: 'Delivered',
      requestRoles: ['ward-nurse', 'ae-nic'], doRoles: ['estates-tech'] },
    { id: 'test-room-clean', name: 'Room clean', team: 'cleaning', placeTypes: ['ward', 'department'], requestRoles: ['ward-nurse'], doRoles: ['bed-manager'], leadRoles: ['coo'] },
  ],
};
const CMDS = Object.fromEntries(taskCommands([PACK]).map((c) => [c.name, c]));
// Run a command the way the command layer does for a person: schema first, then the role list, then the command.
async function run(core, name, input, role) {
  const c = CMDS[name];
  const errs = validate(c.input, input);
  if (errs.length) throw new CommandError('invalid-input', errs.join('; '));
  if (!c.roles.includes(role)) throw new CommandError('forbidden', `${role} cannot run ${name}`);
  return c.run(core, input, { actor: human(role), wards: null });
}

async function site() {
  const core = await Core.open({ adapter: new MemoryAdapter(), clock: clockFrom(END) });
  await loadSyntheticHospital(core, { end: END });
  return core;
}
async function occupiedBed(core) {
  const board = await runCommand(core, 'ospeli_beds_board', {}, human('bed-manager'));
  return board.beds.find((b) => b.state === 'occupied');
}

test('bed cleans are read from the bed events: the task list gives the same bed turnaround as the KPI', () => {
  const { entities, events } = generateHospital({ end: END });
  const beds = new Map(entities.filter((e) => e.type === 'bed').map((b) => [b.id, b.parentId]));
  const { all } = deriveTasks(events, { beds });
  const cleans = all.filter((t) => t.kind === 'bed-clean');
  assert.ok(cleans.length > 300, `${cleans.length} bed cleans in 30 days`);
  assert.ok(cleans.every((t) => t.source === 'bed' && beds.has(t.locationId)));
  const since = new Date(Date.parse(END) - 7 * 864e5).toISOString();
  const stats = completionStats(all, { since, until: END, pick: (t) => t.kind === 'bed-clean' });
  const kpi = computeKpi('bed-turnaround', events, { since, until: END, bedCount: beds.size });
  assert.equal(stats.n, kpi.denominator, 'the same cleans are counted');
  assert.ok(Math.abs(stats.medianMinutes - kpi.value) < 1e-9, `task median ${stats.medianMinutes} equals KPI ${kpi.value}`);
  // Every clean that finished was asked for before it ended; where a start was recorded, it lies between.
  for (const t of cleans.filter((x) => x.state === 'completed')) assert.ok(t.requestedAt <= (t.startedAt ?? t.completedAt) && (t.startedAt ?? t.completedAt) <= t.completedAt, t.id);
});

test('without the bed list no bed clean is read, and task events alone still make tasks', () => {
  const ev = (type, subject, at, data = null) => ({ type, subject, actorRole: 'ward-nurse', at, data });
  const events = [
    ev('bed.vacated', 'ward-a1-bed-01', '2026-11-06T10:00:00.000Z'),
    ev('task.requested', 'task-00001', '2026-11-06T10:01:00.000Z', { kind: 'test-move', locationId: 'ward-a1', toLocationId: 'dept-imaging', priority: 'urgent', detail: 'Bed' }),
    ev('task.requested', 'task-00001', '2026-11-06T10:02:00.000Z', { kind: 'test-move', locationId: 'ward-a2' }), // the same id again changes nothing
    ev('task.requested', 'not-a-task', '2026-11-06T10:02:30.000Z', { kind: 'test-move', locationId: 'ward-a2' }),
    ev('task.started', 'task-00001', '2026-11-06T10:11:00.000Z'),
    ev('task.started', 'task-00001', '2026-11-06T10:12:00.000Z'), // a second start is ignored
    ev('task.completed', 'task-00001', '2026-11-06T10:31:00.000Z'),
    ev('task.cancelled', 'task-00001', '2026-11-06T10:40:00.000Z', { reason: 'Other' }), // closed already
  ];
  const { all, open } = deriveTasks(events);
  assert.equal(all.length, 1);
  assert.equal(open.size, 0);
  const [t] = all;
  assert.deepEqual([t.state, t.locationId, t.toLocationId, t.priority, t.detail, t.startedAt, t.completedAt, t.cancelledAt],
    ['completed', 'ward-a1', 'dept-imaging', 'urgent', 'Bed', '2026-11-06T10:11:00.000Z', '2026-11-06T10:31:00.000Z', null]);
  assert.equal(nextTaskId(events), 'task-00002');
  const stats = completionStats(all, { until: '2026-11-07T00:00:00.000Z' });
  assert.deepEqual(stats, { n: 1, medianMinutes: 30, medianWaitMinutes: 10 });
  assert.equal(completionStats(all, { since: '2026-11-06T11:00:00.000Z', until: '2026-11-07T00:00:00.000Z' }).n, 0, 'counted in the period it was completed in');
  assert.throws(() => completionStats(all, {}), /until is required/);
});

test('the queue order is urgent first, then the longest wait', () => {
  const t = (id, priority, requestedAt) => ({ id, priority, requestedAt });
  const order = sortQueue([t('c', 'routine', '2026-11-06T09:00:00Z'), t('a', 'urgent', '2026-11-06T11:00:00Z'), t('b', 'routine', '2026-11-06T08:00:00Z'), t('d', 'urgent', '2026-11-06T10:00:00Z')]).map((x) => x.id);
  assert.deepEqual(order, ['d', 'a', 'b', 'c']);
});

test('a module\'s kinds of task are checked when they are added', () => {
  const kind = (over) => ({ id: 'x-kind', name: 'X', team: 'cleaning', requestRoles: ['ward-nurse'], doRoles: ['ward-nurse'], ...over });
  const bad = (k, why) => assert.throws(() => taskCatalogue([{ id: 'm', TASK_KINDS: [k] }], ROLE_IDS), why);
  bad(kind({ id: 'Bad Id' }), /id must be/);
  bad(kind({ id: 'bed-clean' }), /already used/);
  bad(kind({ team: 'nobody' }), /unknown team/);
  bad(kind({ doRoles: ['made-up-role'] }), /unknown role/);
  bad(kind({ requestRoles: [] }), /requestRoles is required/);
  bad(kind({ derived: true }), /only the core/);
  bad(kind({ details: ['ok', ''] }), /details/);
  assert.throws(() => taskCatalogue([{ id: 'm', TASK_TEAMS: { cleaning: 'Other name' } }], ROLE_IDS), /already exists/);
  const { kinds, teams } = taskCatalogue([PACK], ROLE_IDS);
  assert.deepEqual([...kinds.keys()], ['bed-clean', 'test-move', 'test-room-clean']);
  assert.deepEqual(teams, { cleaning: 'Cleaning', moving: 'Moving team' });
});

test('a vacated bed is a clean task at once; starting and finishing it moves the bed on the bed board', async () => {
  const core = await site();
  const bed = await occupiedBed(core);
  const id = bedCleanId(bed.id);
  const openIds = async () => (await run(core, 'ospeli_tasks_list', { locationId: bed.id }, 'bed-manager')).tasks.map((t) => t.id);
  assert.ok(!(await openIds()).includes(id), 'no clean while the patient is in the bed');
  await runCommand(core, 'ospeli_beds_mark_vacated', { bedId: bed.id }, human('ward-nurse'));
  const list = await run(core, 'ospeli_tasks_list', { locationId: bed.wardId, team: 'cleaning' }, 'bed-manager');
  const task = list.tasks.find((t) => t.id === id);
  assert.ok(task, 'nobody had to ask for the clean');
  assert.deepEqual([task.kind, task.source, task.state, task.wardId, task.priority], ['bed-clean', 'bed', 'requested', bed.wardId, 'routine']);
  assert.match(task.locationName, /Ward .*, Bed \d\d/);
  assert.deepEqual(validate(CMDS.ospeli_tasks_list.output, list), []);

  const started = await run(core, 'ospeli_tasks_start', { taskId: id, expectedState: 'requested' }, 'bed-manager');
  assert.equal(started.state, 'started');
  assert.equal((await runCommand(core, 'ospeli_beds_get', { bedId: bed.id }, human('bed-manager'))).bed.state, 'cleaning');
  await assert.rejects(run(core, 'ospeli_tasks_start', { taskId: id }, 'bed-manager'), code('conflict'), 'cannot start twice');
  await assert.rejects(run(core, 'ospeli_tasks_complete', { taskId: id, expectedState: 'requested' }, 'bed-manager'), code('conflict'), 'changed since the caller looked');

  const done = await run(core, 'ospeli_tasks_complete', { taskId: id }, 'ward-nurse');
  assert.equal(done.state, 'completed');
  assert.equal((await runCommand(core, 'ospeli_beds_get', { bedId: bed.id }, human('bed-manager'))).bed.state, 'available');
  assert.ok(!(await openIds()).includes(id));
  await assert.rejects(run(core, 'ospeli_tasks_complete', { taskId: id }, 'ward-nurse'), code('not-found'));

  // The trail says which role did it, and never a person.
  const trail = (await core.auditLog()).filter((a) => a.target === id);
  assert.deepEqual(trail.map((a) => [a.action, a.actorRole, a.actorType, a.detail.kind]), [['task.started', 'bed-manager', 'human', 'bed-clean'], ['task.completed', 'ward-nurse', 'human', 'bed-clean']]);
});

test('the other way round: a clean marked on the bed board closes the clean task', async () => {
  const core = await site();
  const bed = await occupiedBed(core);
  await runCommand(core, 'ospeli_beds_mark_vacated', { bedId: bed.id }, human('ward-nurse'));
  await runCommand(core, 'ospeli_beds_finish_clean', { bedId: bed.id }, human('ward-nurse'));
  const done = await run(core, 'ospeli_tasks_list', { state: 'completed', locationId: bed.id, limit: 1 }, 'coo');
  assert.equal(done.tasks[0].id, bedCleanId(bed.id));
  assert.equal(done.tasks[0].state, 'completed');
  assert.equal(typeof done.tasks[0].totalMinutes, 'number');
});

test('a bed taken out of service no longer waits for its clean, and a bed clean cannot be cancelled by hand', async () => {
  const core = await site();
  const bed = await occupiedBed(core);
  const id = bedCleanId(bed.id);
  await runCommand(core, 'ospeli_beds_mark_vacated', { bedId: bed.id }, human('ward-nurse'));
  await assert.rejects(run(core, 'ospeli_tasks_cancel', { taskId: id, reason: CANCEL_REASONS[0] }, 'ward-nurse'), code('conflict'));
  await runCommand(core, 'ospeli_beds_finish_clean', { bedId: bed.id }, human('ward-nurse'));
  await runCommand(core, 'ospeli_beds_take_out_of_service', { bedId: bed.id, reason: 'Electrical' }, human('ward-nurse'));
  assert.equal((await run(core, 'ospeli_tasks_list', { locationId: bed.id }, 'coo')).tasks.length, 0);
});

test('asking for a task: it joins the team queue, urgent first; a second request for the same job names the first', async () => {
  const core = await site();
  // A module may have given the example hospital some task history: ids carry on from it.
  const n0 = Number(nextTaskId(await core.events()).slice(5));
  const tid = (k) => `task-${String(n0 + k).padStart(5, '0')}`;
  const a = await run(core, 'ospeli_tasks_request', { kind: 'test-move', locationId: 'ward-a1', toLocationId: 'dept-imaging', detail: 'Wheelchair' }, 'ward-nurse');
  assert.deepEqual([a.status, a.taskId, a.state, a.team], ['done', tid(0), 'requested', 'moving']);
  const b = await run(core, 'ospeli_tasks_request', { kind: 'test-move', locationId: 'ward-b1', toLocationId: 'dept-imaging', detail: 'Bed', priority: 'urgent' }, 'ae-nic');
  assert.equal(b.taskId, tid(1));
  await assert.rejects(run(core, 'ospeli_tasks_request', { kind: 'test-move', locationId: 'ward-a1', toLocationId: 'dept-imaging', detail: 'Wheelchair' }, 'ward-nurse'),
    (err) => code('conflict')(err) && err.detail.existing === tid(0));
  const q = await run(core, 'ospeli_tasks_list', { team: 'moving' }, 'estates-tech');
  assert.deepEqual(q.tasks.map((t) => t.id), [tid(1), tid(0)], 'urgent first');
  assert.deepEqual([q.counts.open, q.counts.waiting, q.counts.urgent, q.counts.byTeam.moving], [2, 2, 1, 2]);
  assert.equal(q.tasks[1].toLocationName, 'Imaging');
  assert.equal(q.tasks[0].requestedByRole, 'ae-nic');

  await run(core, 'ospeli_tasks_start', { taskId: tid(1) }, 'estates-tech');
  const mid = await run(core, 'ospeli_tasks_list', { team: 'moving' }, 'estates-tech');
  assert.equal(mid.tasks[0].stateName, 'On the way', 'the kind\'s own word for in progress');
  await run(core, 'ospeli_tasks_complete', { taskId: tid(1) }, 'estates-tech');
  // Done straight from waiting: recorded as started and done at the same moment.
  const straight = await run(core, 'ospeli_tasks_complete', { taskId: tid(0) }, 'estates-tech');
  assert.equal(straight.events.length, 2);
  const done = await run(core, 'ospeli_tasks_list', { team: 'moving', state: 'completed' }, 'coo');
  assert.equal(done.total, 2);
  assert.ok(done.tasks.every((t) => t.startedAt && t.completedAt && t.totalMinutes >= 0));
  assert.equal((await run(core, 'ospeli_tasks_list', { team: 'moving' }, 'coo')).total, 0);
  // The same job can be asked for again once the first is done.
  assert.equal((await run(core, 'ospeli_tasks_request', { kind: 'test-move', locationId: 'ward-a1', toLocationId: 'dept-imaging', detail: 'Wheelchair' }, 'ward-nurse')).taskId, tid(2));
  const cancelled = await run(core, 'ospeli_tasks_cancel', { taskId: tid(2), reason: 'Asked for by mistake' }, 'ward-nurse');
  assert.equal(cancelled.state, 'cancelled');
  const gone = await run(core, 'ospeli_tasks_list', { team: 'moving', state: 'cancelled' }, 'coo');
  assert.deepEqual([gone.tasks[0].id, gone.tasks[0].cancelReason], [tid(2), 'Asked for by mistake']);
});

test('attack: a role outside a kind\'s lists cannot ask for, start, finish or cancel that kind of task', async () => {
  const core = await site();
  // A role that may ask for one kind cannot ask for another kind through the same command.
  await assert.rejects(run(core, 'ospeli_tasks_request', { kind: 'test-room-clean', locationId: 'ward-a1' }, 'ae-nic'), code('forbidden'));
  await assert.rejects(run(core, 'ospeli_tasks_request', { kind: 'test-move', locationId: 'ward-a1', toLocationId: 'dept-imaging', detail: 'Bed' }, 'coo'), code('forbidden'));
  const { taskId } = await run(core, 'ospeli_tasks_request', { kind: 'test-move', locationId: 'ward-a1', toLocationId: 'dept-imaging', detail: 'Bed' }, 'ward-nurse');
  // bed-manager may do a room clean and a bed clean, but not a move.
  await assert.rejects(run(core, 'ospeli_tasks_start', { taskId }, 'bed-manager'), code('forbidden'));
  await assert.rejects(run(core, 'ospeli_tasks_complete', { taskId }, 'bed-manager'), code('forbidden'));
  await assert.rejects(run(core, 'ospeli_tasks_cancel', { taskId, reason: 'Other' }, 'bed-manager'), code('forbidden'));
  await assert.rejects(run(core, 'ospeli_tasks_start', { taskId }, 'coo'), code('forbidden'));
  const before = await core.eventCount();
  assert.equal((await run(core, 'ospeli_tasks_list', { team: 'moving' }, 'coo')).tasks[0].state, 'requested', 'nothing changed');
  assert.equal(await core.eventCount(), before);
});

test('attack: a request cannot carry typed text, a made-up place, a wrong kind of place or a loop', async () => {
  const core = await site();
  const before = (await core.events({ type: 'task.requested' })).length;
  const ask = (input, role = 'ward-nurse') => run(core, 'ospeli_tasks_request', input, role);
  const move = { kind: 'test-move', locationId: 'ward-a1', toLocationId: 'dept-imaging', detail: 'Bed' };
  await assert.rejects(ask({ ...move, detail: 'Mr Example in bed 4, call 555 0100' }), code('invalid-input'), 'detail is a pick list, not a note');
  await assert.rejects(ask({ ...move, detail: undefined }), code('invalid-input'));
  await assert.rejects(ask({ ...move, note: 'anything' }), code('invalid-input'), 'no field takes free text');
  await assert.rejects(ask({ ...move, locationId: 'ward-zz' }), code('not-found'));
  await assert.rejects(ask({ ...move, locationId: 'asset-a1-sink-1' }), code('not-found'), 'an asset is not a place');
  await assert.rejects(ask({ ...move, toLocationId: 'ward-a1' }), code('invalid-input'));
  await assert.rejects(ask({ kind: 'test-move', locationId: 'ward-a1', detail: 'Bed' }), code('invalid-input'), 'a move needs a destination');
  await assert.rejects(ask({ kind: 'test-room-clean', locationId: 'ward-a1', toLocationId: 'dept-imaging' }), code('invalid-input'));
  await assert.rejects(ask({ kind: 'test-room-clean', locationId: 'ward-a1', detail: 'Bed' }), code('invalid-input'));
  await assert.rejects(ask({ kind: 'test-room-clean', locationId: 'ward-a1-bed-01' }), code('invalid-input'), 'this kind is for a ward or department');
  await assert.rejects(ask({ kind: 'bed-clean', locationId: 'ward-a1-bed-01' }), code('invalid-input'), 'a bed clean is never asked for by hand');
  await assert.rejects(ask({ ...move, priority: 'now!!' }), code('invalid-input'));
  await assert.rejects(run(core, 'ospeli_tasks_start', { taskId: 'task-1; drop' }, 'estates-tech'), code('invalid-input'));
  await assert.rejects(run(core, 'ospeli_tasks_start', { taskId: 'task-99999' }, 'estates-tech'), code('not-found'));
  await assert.rejects(run(core, 'ospeli_tasks_list', { locationId: 'ward-zz' }, 'coo'), (err) => code('not-found')(err) && !err.message.includes('ward-zz'), 'a made-up id is not echoed back');
  assert.equal((await core.events({ type: 'task.requested' })).length, before, 'nothing was written');
});

// ---- through the real command layer (the kinds every build has: bed cleans) ----
async function siteWithAgent(role = 'ward-nurse') {
  const core = await site();
  const bed = await occupiedBed(core);
  await runCommand(core, 'ospeli_beds_mark_vacated', { bedId: bed.id }, human('ward-nurse'));
  await runCommand(core, 'ospeli_agents_set_access', { allowed: true, wards: { [bed.wardId]: true } }, human('coo'));
  await runCommand(core, 'ospeli_agents_add', { name: 'task-bot', role, wards: [bed.wardId], days: 30 }, human('coo'));
  return { core, bed, id: bedCleanId(bed.id) };
}

test('an agent may read the queue of its wards; what it asks to change waits for a person', async () => {
  const { core, bed, id } = await siteWithAgent();
  const seen = await runCommand(core, 'ospeli_tasks_list', {}, agent('ward-nurse'));
  assert.ok(seen.tasks.length >= 1);
  assert.ok(seen.tasks.every((t) => t.wardId === bed.wardId), 'only the wards the agent is allowed on');
  const all = await runCommand(core, 'ospeli_tasks_list', { limit: 500 }, human('coo'));
  assert.ok(all.total >= seen.total);

  const before = await core.eventCount();
  const prop = await runCommand(core, 'ospeli_tasks_complete', { taskId: id }, agent('ward-nurse'));
  assert.equal(prop.status, 'proposed');
  assert.equal(prop.taskId, id);
  assert.equal(prop.proposal.seenState, 'requested');
  assert.equal(await core.eventCount(), before, 'nothing changed');
  assert.equal((await runCommand(core, 'ospeli_beds_get', { bedId: bed.id }, human('bed-manager'))).bed.state, 'vacated');
  // The same call again returns the proposal already waiting.
  const again = await runCommand(core, 'ospeli_tasks_complete', { taskId: id }, agent('ward-nurse'));
  assert.equal(again.existing, true);
  // One open proposal per command for one task: a different input for the same task is refused.
  await assert.rejects(runCommand(core, 'ospeli_tasks_complete', { taskId: id, expectedState: 'requested' }, agent('ward-nurse')),
    (err) => code('conflict')(err) && /same task/.test(err.message));

  const out = await runCommand(core, 'ospeli_proposals_accept', { id: prop.proposal.id }, human('ward-nurse'));
  assert.equal(out.status, 'accepted');
  assert.equal((await runCommand(core, 'ospeli_beds_get', { bedId: bed.id }, human('bed-manager'))).bed.state, 'available');
  const entry = (await core.auditLog()).filter((a) => a.action === 'task.completed').at(-1);
  assert.deepEqual([entry.actorType, entry.actorRole], ['human', 'ward-nurse'], 'recorded as done by the person who accepted');
});

test('attack: an agent cannot act outside its role or its wards, or on a task that is not open', async () => {
  const { core, bed, id } = await siteWithAgent('coo');
  // coo is not among the roles that may do a bed clean.
  await assert.rejects(runCommand(core, 'ospeli_tasks_start', { taskId: id }, agent('coo')), code('forbidden'));
  await runCommand(core, 'ospeli_agents_add', { name: 'ward-bot', role: 'ward-nurse', wards: [bed.wardId], days: 30 }, human('coo'));
  // Another ward's clean: the ward is not switched on for agents.
  const other = (await runCommand(core, 'ospeli_beds_board', {}, human('bed-manager'))).beds.find((b) => b.state === 'occupied' && b.wardId !== bed.wardId);
  await runCommand(core, 'ospeli_beds_mark_vacated', { bedId: other.id }, human('ward-nurse'));
  await assert.rejects(runCommand(core, 'ospeli_tasks_start', { taskId: bedCleanId(other.id) }, agent('ward-nurse', 'ward-bot')), code('agents-off'));
  await assert.rejects(runCommand(core, 'ospeli_tasks_list', { locationId: other.wardId }, agent('ward-nurse', 'ward-bot')), code('agents-off'));
  // A task that is not open is refused before it reaches a person's queue.
  await assert.rejects(runCommand(core, 'ospeli_tasks_start', { taskId: 'clean-ward-zz-bed-99' }, agent('ward-nurse', 'ward-bot')), (err) => code('not-found')(err) && !err.message.includes('ward-zz'));
  assert.equal((await core.proposals()).length, 0);
  // A dry run says what would happen and changes nothing.
  const dry = await runCommand(core, 'ospeli_tasks_start', { taskId: id }, agent('ward-nurse', 'ward-bot'), { dryRun: true });
  assert.equal(dry.status, 'dry-run');
  assert.equal((await core.proposals()).length, 0);
});

test('a person in a role that cannot do bed cleans is refused by the command layer', async () => {
  const { core, id } = await siteWithAgent();
  await assert.rejects(runCommand(core, 'ospeli_tasks_start', { taskId: id }, human('estates-tech')), code('forbidden'));
  await assert.rejects(runCommand(core, 'ospeli_tasks_start', { taskId: id, extra: 1 }, human('ward-nurse')), code('invalid-input'));
  assert.equal((await runCommand(core, 'ospeli_tasks_kinds', {}, human('estates-tech'))).kinds.find((k) => k.id === 'bed-clean').askable, false);
});

test('moving a task to the front: only the roles that balance the work, for asked-for tasks and bed cleans alike', async () => {
  const core = await site();
  const a = await run(core, 'ospeli_tasks_request', { kind: 'test-room-clean', locationId: 'ward-a1' }, 'ward-nurse');
  const b = await run(core, 'ospeli_tasks_request', { kind: 'test-room-clean', locationId: 'ward-a2' }, 'ward-nurse');
  const order = async () => (await run(core, 'ospeli_tasks_list', { kind: 'test-room-clean' }, 'coo')).tasks.map((t) => [t.id, t.priority]);
  assert.deepEqual(await order(), [[a.taskId, 'routine'], [b.taskId, 'routine']]);
  // The kind names its own lead roles: here only the coo. The role that does the clean cannot reorder it.
  await assert.rejects(run(core, 'ospeli_tasks_set_priority', { taskId: b.taskId, priority: 'urgent' }, 'bed-manager'), code('forbidden'));
  const out = await run(core, 'ospeli_tasks_set_priority', { taskId: b.taskId, priority: 'urgent' }, 'coo');
  assert.deepEqual([out.status, out.state], ['done', 'requested'], 'the state is left as it was');
  assert.deepEqual(await order(), [[b.taskId, 'urgent'], [a.taskId, 'routine']]);
  await assert.rejects(run(core, 'ospeli_tasks_set_priority', { taskId: b.taskId, priority: 'urgent' }, 'coo'), code('conflict'), 'already urgent');
  await run(core, 'ospeli_tasks_set_priority', { taskId: b.taskId, priority: 'routine' }, 'coo');
  assert.deepEqual(await order(), [[a.taskId, 'routine'], [b.taskId, 'routine']]);
  await assert.rejects(run(core, 'ospeli_tasks_set_priority', { taskId: b.taskId, priority: 'first!' }, 'coo'), code('invalid-input'));
  const entry = (await core.auditLog()).filter((x) => x.action === 'task.prioritised').at(-1);
  assert.deepEqual([entry.target, entry.actorRole, entry.detail.priority], [b.taskId, 'coo', 'routine']);

  // A bed clean: the patient flow coordinator may move it to the front; the mark ends with that clean.
  const bed = await occupiedBed(core);
  const id = bedCleanId(bed.id);
  await runCommand(core, 'ospeli_beds_mark_vacated', { bedId: bed.id }, human('ward-nurse'));
  await assert.rejects(runCommand(core, 'ospeli_tasks_set_priority', { taskId: id, priority: 'urgent' }, human('ward-nurse')), code('forbidden'));
  await runCommand(core, 'ospeli_tasks_set_priority', { taskId: id, priority: 'urgent' }, human('bed-manager'));
  const q = await runCommand(core, 'ospeli_tasks_list', { team: 'cleaning', kind: 'bed-clean' }, human('bed-manager'));
  assert.deepEqual([q.tasks[0].id, q.tasks[0].priority], [id, 'urgent'], 'at the front of the cleaning queue');
  await runCommand(core, 'ospeli_tasks_complete', { taskId: id }, human('bed-manager'));
  assert.equal((await runCommand(core, 'ospeli_beds_get', { bedId: bed.id }, human('bed-manager'))).bed.state, 'available');
});
