// Cleaning and portering (module support): its commands without the screen, every refusal, agent
// proposals, attack tests, and each KPI recomputed from the event log with hand-checked numbers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Core } from '../../web/app/core/core.js';
import { MemoryAdapter } from '../../web/app/core/db.js';
import { loadSyntheticHospital, generateHospital } from '../../web/app/core/generator.js';
import { runCommand, CommandError, commandByName } from '../../web/app/core/commands.js';
import { computeKpi } from '../../web/app/core/kpi.js';
import { validate } from '../../web/app/core/schema.js';
import { deriveTasks } from '../../web/app/core/tasks.js';
import * as pack from '../../web/app/modules/support/commands.js';
import {
  bedTurnaround, porterRequestToDone, auditScore, deriveAudits, nextAuditId, guideOn, ruleCleansFirst, ruleTeamBusy, ruleAuditFailedTwice,
  AUDIT_ELEMENTS, PASS_MARK,
} from '../../web/app/modules/support/logic.js';

const END = '2026-11-06T18:00:00.000Z';
const MIN = 60e3;
const human = (role) => ({ type: 'human', role });
const agent = (role, name = 'support-bot') => ({ type: 'agent', role, agent: name });
const code = (c) => (err) => err instanceof CommandError && err.code === c;
const ALL_EL = AUDIT_ELEMENTS.map((e) => e.id);

// A site on a clock the test moves: each call ticks one second; advance(m) jumps m minutes.
async function site({ load = true } = {}) {
  let t = Date.parse(END);
  const core = await Core.open({ adapter: new MemoryAdapter(), clock: () => new Date(t += 1000) });
  if (load) await loadSyntheticHospital(core, { end: END });
  const run = (name, input, who) => runCommand(core, name, input, typeof who === 'string' ? human(who) : who);
  return { core, run, advance: (m) => { t += m * MIN; } };
}
const out = (name, value) => assert.deepEqual(validate(commandByName(name).output, value), [], `${name}: answer matches its schema`);

test('the pack adds its kinds of task to the shared task object; porter, cleaner and supervisor do them', async () => {
  const { run } = await site();
  const k = await run('ospeli_tasks_kinds', {}, 'porter');
  assert.deepEqual(k.teams.map((x) => x.id).sort(), ['cleaning', 'portering']);
  const kinds = Object.fromEntries(k.kinds.map((x) => [x.id, x]));
  assert.deepEqual(Object.keys(kinds).sort(), ['bed-clean', 'equipment-move', 'item-run', 'patient-move', 'room-clean']);
  // The first tap says "I am going" and claims the job; a clean keeps its own words.
  assert.deepEqual([kinds['patient-move'].team, kinds['patient-move'].needsTo, kinds['patient-move'].startLabel, kinds['patient-move'].doneLabel], ['portering', true, 'On my way', 'Delivered']);
  assert.deepEqual([kinds['room-clean'].startLabel, kinds['room-clean'].doneLabel], ['Start clean', 'Clean done']);
  assert.deepEqual(Object.keys(kinds).filter((id) => kinds[id].repeatable), ['patient-move'], 'two patients are two moves; a specimen run or an equipment move between the same places is one');
  assert.ok(k.releaseReasons.includes('Patient or item not ready'));
  assert.deepEqual(kinds['patient-move'].details, ['Wheelchair', 'Bed', 'Trolley', 'Walking with help']);
  assert.ok(kinds['room-clean'].details.includes('Extra clean asked for by the ward'), 'the ward picks a neutral extra clean; Ospeli decides nothing clinical');
  assert.deepEqual(kinds['room-clean'].doRoles, ['cleaner', 'support-supervisor']);
  assert.ok(kinds['bed-clean'].doRoles.includes('cleaner'));
  // Nothing in a kind is clinical or free text: every detail is a short pick.
  for (const x of pack.TASK_KINDS) for (const d of x.details) assert.ok(d.length <= 40 && !/isolat|infect|diet/i.test(d), d);
});

test('a porter journey through the commands: asked for, collected, delivered; the measure counts it with hand-checked minutes', async () => {
  const { run, advance } = await site();
  const before = (await run('ospeli_support_overview', {}, 'porter')).kpis.find((x) => x.id === 'porter-request-to-done');
  assert.ok(before.n > 100, 'the example hospital has portering history');
  const ask = await run('ospeli_tasks_request', { kind: 'patient-move', locationId: 'ward-a1-bed-04', toLocationId: 'dept-imaging', detail: 'Wheelchair' }, 'ward-nurse');
  assert.deepEqual([ask.status, ask.team, ask.state], ['done', 'portering', 'requested']);
  const q = await run('ospeli_tasks_list', { team: 'portering' }, 'porter');
  const mine = q.tasks.find((t) => t.id === ask.taskId);
  assert.equal(mine.locationName, 'Ward A1 (acute medicine), Bed 04');
  assert.equal(q.tasks.at(-1).id, ask.taskId, 'a routine job joins the end of the queue (the newest wait is the shortest)');
  advance(5);
  await run('ospeli_tasks_start', { taskId: ask.taskId, expectedState: 'requested' }, 'porter');
  // A double tap: the second start is refused, nothing is written twice.
  await assert.rejects(run('ospeli_tasks_start', { taskId: ask.taskId, expectedState: 'requested' }, 'porter'), code('conflict'));
  advance(25);
  await run('ospeli_tasks_complete', { taskId: ask.taskId, expectedState: 'started' }, 'porter');
  const after = await run('ospeli_support_overview', {}, 'porter');
  out('ospeli_support_overview', after);
  const k = after.kpis.find((x) => x.id === 'porter-request-to-done');
  assert.equal(k.n, before.n + 1, 'the measure counts the job');
  const by = (o) => Object.fromEntries(o.breakdown.map((b) => [b.id, b.n]));
  assert.equal(by(k)['patient-move'], by(before)['patient-move'] + 1);
  assert.equal(by(k)['item-run'], by(before)['item-run']);
  // Asked at T, collected at T+5 min (+ clock ticks), delivered at T+30 min (+ ticks): 30 minutes to the nearest minute.
  const done = (await run('ospeli_tasks_list', { state: 'completed', kind: 'patient-move', limit: 1 }, 'porter')).tasks[0];
  assert.deepEqual([done.id, done.totalMinutes, done.waitMinutes], [ask.taskId, 30, 5]);
  assert.equal(after.teams.find((x) => x.id === 'portering').open, q.counts.open - 1);
});

test('refused by role: a role outside a kind\'s lists cannot ask for, do or reorder it, and the command layer says who can', async () => {
  const { core, run } = await site();
  const move = { kind: 'patient-move', locationId: 'ward-a1', toLocationId: 'dept-imaging', detail: 'Bed' };
  await assert.rejects(run('ospeli_tasks_request', move, 'porter'), code('forbidden'), 'a porter does jobs, the ward asks');
  await assert.rejects(run('ospeli_tasks_request', move, 'coo'), code('forbidden'));
  const { taskId } = await run('ospeli_tasks_request', move, 'ward-nurse');
  await assert.rejects(run('ospeli_tasks_start', { taskId }, 'cleaner'), code('forbidden'), 'a cleaner cannot take a porter job');
  await assert.rejects(run('ospeli_tasks_set_priority', { taskId, priority: 'urgent' }, 'porter'), code('forbidden'), 'the porter works the queue; the supervisor orders it');
  await assert.rejects(run('ospeli_support_audit_record', { locationId: 'ward-a1', riskCategory: 'high', passed: ['floor'] }, 'cleaner'), code('forbidden'), 'no self-audit');
  await assert.rejects(run('ospeli_support_audit_record', { locationId: 'ward-a1', riskCategory: 'high', passed: ['floor'] }, 'porter'), code('forbidden'));
  await assert.rejects(run('ospeli_support_guide_set', { on: false }, 'porter'), code('forbidden'));
  await assert.rejects(run('ospeli_support_guide_set', { on: false }, 'ward-nurse'), code('forbidden'));
  const room = await run('ospeli_tasks_request', { kind: 'room-clean', locationId: 'ward-a3', detail: 'Spill' }, 'ward-nurse');
  await assert.rejects(run('ospeli_tasks_start', { taskId: room.taskId }, 'porter'), code('forbidden'));
  await run('ospeli_tasks_start', { taskId: room.taskId }, 'cleaner');
  await run('ospeli_tasks_set_priority', { taskId, priority: 'urgent' }, 'support-supervisor');
  assert.equal((await run('ospeli_tasks_list', { team: 'portering' }, 'porter')).tasks.find((t) => t.id === taskId).priority, 'urgent');
  assert.equal((await core.events({ type: 'support.audit-recorded' })).filter((e) => e.at > END).length, 0, 'nothing was recorded by the refused calls');
});

test('a cleaning audit: score is elements passed / elements audited; failed elements need action; the trail holds ids and picks only', async () => {
  const { core, run, advance } = await site();
  const before = await run('ospeli_support_audits_list', { locationId: 'ward-a1', limit: 200 }, 'cleaner');
  const res = await run('ospeli_support_audit_record', { locationId: 'ward-a1', riskCategory: 'high', passed: ['floor', 'bins', 'toilet'], failed: ['curtains'] }, 'support-supervisor');
  out('ospeli_support_audit_record', res);
  assert.deepEqual([res.status, res.audited, res.passed, res.score, res.belowPassMark], ['done', 4, 3, 75, true]);
  assert.deepEqual(res.failed, [{ id: 'curtains', name: 'Curtains and screens' }]);
  const n = (await core.events({ type: 'support.audit-recorded' })).length;
  assert.equal(res.auditId, `aud-${String(n).padStart(5, '0')}`, 'the next audit id follows the example hospital\'s');
  const ev = (await core.events({ type: 'support.audit-recorded' })).at(-1);
  assert.deepEqual([ev.subject, ev.actorRole, ev.data], ['ward-a1', 'support-supervisor', { auditId: res.auditId, riskCategory: 'high', passed: ['floor', 'bins', 'toilet'], failed: ['curtains'] }]);
  const entry = (await core.auditLog()).at(-1);
  assert.deepEqual([entry.action, entry.target, entry.actorRole, entry.detail], ['support.audit-recorded', res.auditId, 'support-supervisor', { locationId: 'ward-a1', riskCategory: 'high', audited: 4, passed: 3 }]);
  // The same audit sent twice in a row (a double tap) is saved once.
  await assert.rejects(run('ospeli_support_audit_record', { locationId: 'ward-a1', riskCategory: 'high', passed: ['toilet', 'floor', 'bins'], failed: ['curtains'] }, 'support-supervisor'),
    (err) => code('conflict')(err) && err.detail.existing === res.auditId);
  advance(11);
  await run('ospeli_support_audit_record', { locationId: 'ward-a1', riskCategory: 'high', passed: ['floor', 'bins', 'toilet'], failed: ['curtains'] }, 'support-supervisor');
  const list = await run('ospeli_support_audits_list', { locationId: 'ward-a1', limit: 200 }, 'cleaner');
  out('ospeli_support_audits_list', list);
  assert.equal(list.total, before.total + 2);
  assert.equal(list.audits[1].id, res.auditId, 'newest first');
  const area = list.areas.find((a) => a.locationId === 'ward-a1');
  assert.deepEqual([area.last.score, area.belowPassMark, area.failedTwice], [75, true, true]);
  assert.match(list.checklist.note, /example set, set locally, not a standard/);
  assert.equal(list.checklist.passMark, PASS_MARK);
  // A department is audited the same way.
  const dept = await run('ospeli_support_audit_record', { locationId: 'dept-imaging', riskCategory: 'moderate', passed: ['floor', 'high-touch'] }, 'support-supervisor');
  assert.equal(dept.score, 100);
});

test('attack: an audit takes picks only; made-up places are not echoed; wrong shapes are refused before anything is written', async () => {
  const { core, run } = await site();
  const sup = (input) => run('ospeli_support_audit_record', input, 'support-supervisor');
  const ok = { locationId: 'ward-a1', riskCategory: 'high', passed: ['floor'] };
  const n = await core.eventCount();
  await assert.rejects(sup({ ...ok, note: 'Mr Example cleaned it, call 555 0100' }), code('invalid-input'), 'no field takes free text');
  await assert.rejects(sup({ ...ok, passed: ['floor', 'Jane Doe'] }), code('invalid-input'), 'an element is a pick');
  await assert.rejects(sup({ ...ok, riskCategory: 'extreme' }), code('invalid-input'));
  await assert.rejects(sup({ ...ok, locationId: 'ward-zz' }), (err) => code('not-found')(err) && !err.message.includes('ward-zz'));
  await assert.rejects(sup({ ...ok, locationId: 'ward-a1-bed-01' }), code('invalid-input'), 'an audit is of a ward or department, not one bed');
  await assert.rejects(sup({ ...ok, locationId: 'asset-a1-sink-1' }), code('not-found'), 'an asset is not a place');
  await assert.rejects(sup({ locationId: 'ward-a1', riskCategory: 'high' }), code('invalid-input'), 'at least one element');
  await assert.rejects(sup({ ...ok, passed: ['floor', 'floor'] }), code('invalid-input'));
  await assert.rejects(sup({ ...ok, failed: ['floor'] }), code('invalid-input'), 'pass and fail at once');
  await assert.rejects(sup({ ...ok, locationId: 'ward-a1; drop' }), code('invalid-input'));
  await assert.rejects(run('ospeli_support_audits_list', { locationId: 'ward-zz' }, 'coo'), (err) => code('not-found')(err) && !err.message.includes('ward-zz'));
  await assert.rejects(run('ospeli_support_overview', { days: 365 }, 'coo'), code('invalid-input'));
  await assert.rejects(run('ospeli_support_overview', { team: 'portering' }, 'coo'), code('invalid-input'), 'a field the command does not know');
  await assert.rejects(run('ospeli_support_guide_set', { on: 'no' }, 'support-supervisor'), code('invalid-input'));
  await assert.rejects(run('ospeli_support_overview', {}, { type: 'robot', role: 'coo' }), code('forbidden'));
  // A job carries no typed text either: a name or phone in the detail is refused by the task command.
  await assert.rejects(run('ospeli_tasks_request', { kind: 'room-clean', locationId: 'ward-a1', detail: 'Bed 4, Mr Example' }, 'ward-nurse'), code('invalid-input'));
  assert.equal(await core.eventCount(), n, 'nothing was written');
  // No support event can carry a person: every key in the module's events is a plain field name.
  const pattern = /(name|surname|phone|email|staff|employee|address)/i;
  for (const e of await core.events()) if (e.type.startsWith('support.')) for (const key of Object.keys(e.data || {})) assert.ok(!pattern.test(key), key);
});

test('agents: a read is limited to the agent\'s wards; an audit becomes a proposal and changes nothing until a person accepts; the guide switch is people only', async () => {
  const { core, run } = await site();
  await run('ospeli_agents_set_access', { allowed: true, wards: { 'ward-a1': true, 'ward-b2': true } }, 'coo');
  await run('ospeli_agents_add', { name: 'support-bot', role: 'support-supervisor', wards: ['ward-a1'], days: 30 }, 'coo');
  const bot = agent('support-supervisor');
  const seen = await run('ospeli_support_audits_list', { limit: 200 }, bot);
  assert.ok(seen.audits.length > 0 && seen.audits.every((a) => a.locationId === 'ward-a1'), 'only its own ward');
  const ov = await run('ospeli_support_overview', {}, bot);
  assert.ok(!ov.guide.suggestions.some((s) => s.id.includes('ward-b2')), 'no suggestion about a ward it may not see');
  await assert.rejects(run('ospeli_support_audits_list', { locationId: 'ward-b2' }, bot), code('forbidden'));

  const n = await core.eventCount();
  const p = await run('ospeli_support_audit_record', { locationId: 'ward-a1', riskCategory: 'high', passed: ['floor'], failed: ['bins'] }, bot);
  assert.equal(p.status, 'proposed');
  assert.equal(await core.eventCount(), n, 'nothing changed');
  await assert.rejects(run('ospeli_support_audit_record', { locationId: 'ward-a1', riskCategory: 'high', passed: ['floor'] }, bot), code('conflict'), 'one open proposal per area');
  // A department sits in no ward, so the ward switches do not cover it (the same as the core's task
  // requests): the agent can still only propose, and a person decides.
  assert.equal((await run('ospeli_support_audit_record', { locationId: 'dept-imaging', riskCategory: 'moderate', passed: ['floor'] }, bot)).status, 'proposed');
  assert.equal(await core.eventCount(), n, 'still nothing changed');
  await assert.rejects(run('ospeli_support_guide_set', { on: false }, bot), code('forbidden'), 'people only');
  await assert.rejects(run('ospeli_proposals_accept', { id: p.proposal.id }, 'porter'), code('forbidden'), 'a role that cannot record audits cannot accept one');
  const acc = await run('ospeli_proposals_accept', { id: p.proposal.id }, 'support-supervisor');
  assert.equal(acc.status, 'accepted');
  const ev = (await core.events({ type: 'support.audit-recorded' })).at(-1);
  assert.deepEqual([ev.subject, ev.data.failed], ['ward-a1', ['bins']]);
  const entry = (await core.auditLog()).filter((a) => a.action === 'support.audit-recorded').at(-1);
  assert.deepEqual([entry.actorType, entry.actorRole], ['human', 'support-supervisor'], 'recorded as done by the person who accepted');
});

test('guide rule 1 on the real board: patients wait on a ward with no free bed; the supervisor moves the cleans to the front, and the suggestion goes', async () => {
  const { run } = await site();
  const board = await run('ospeli_beds_board', {}, 'bed-manager');
  const waitingBy = new Map();
  for (const w of board.waiting) if (!w.allocatedBed && w.wardId) waitingBy.set(w.wardId, (waitingBy.get(w.wardId) || 0) + 1);
  const [wardId, patients] = [...waitingBy].sort((a, b) => b[1] - a[1])[0];
  // No free bed on that ward (out of service for the test), then two beds there are vacated.
  for (const b of board.beds.filter((x) => x.wardId === wardId && x.state === 'available')) await run('ospeli_beds_take_out_of_service', { bedId: b.id, reason: 'Electrical' }, 'bed-manager');
  const occupied = board.beds.filter((x) => x.wardId === wardId && x.state === 'occupied').slice(0, 2);
  for (const b of occupied) await run('ospeli_beds_mark_vacated', { bedId: b.id }, 'ward-nurse');
  const ov = await run('ospeli_support_overview', {}, 'support-supervisor');
  const s = ov.guide.suggestions.find((x) => x.id === `cleans-first:${wardId}`);
  assert.ok(s, 'the rule fires');
  assert.match(s.why, new RegExp(`^${patients} patients? (is|are) waiting for a bed on Ward`));
  assert.match(s.basis, /Example setting, not a standard/);
  const ids = s.action.inputs.map((x) => x.taskId);
  assert.ok(ids.length >= 1 && ids.length <= patients);
  assert.ok(ids.every((id) => id.startsWith('clean-')));
  for (const input of s.action.inputs) await run(s.action.command, input, 'support-supervisor');
  const q = await run('ospeli_tasks_list', { team: 'cleaning' }, 'cleaner');
  assert.deepEqual(q.tasks.slice(0, ids.length).map((t) => t.id).sort(), [...ids].sort(), 'at the front of the cleaning queue');
  assert.ok(!(await run('ospeli_support_overview', {}, 'support-supervisor')).guide.suggestions.some((x) => x.id === `cleans-first:${wardId}`), 'done: the suggestion goes');
});

test('the guide switch: off means no suggestions and everything else the same; one person-only switch, refused when already in that state', async () => {
  const { core, run } = await site();
  const on = await run('ospeli_support_overview', {}, 'support-supervisor');
  assert.equal(on.guide.on, true);
  assert.ok(on.guide.suggestions.some((s) => s.rule === 'audit-failed-twice' && /Ward B2/.test(s.text)), 'the example hospital\'s ward B2 failed twice');
  await assert.rejects(run('ospeli_support_guide_set', { on: true }, 'support-supervisor'), code('conflict'));
  const set = await run('ospeli_support_guide_set', { on: false }, 'support-supervisor');
  out('ospeli_support_guide_set', set);
  const off = await run('ospeli_support_overview', {}, 'support-supervisor');
  assert.deepEqual([off.guide.on, off.guide.suggestions], [false, []]);
  assert.deepEqual(off.kpis, on.kpis, 'the measures are the same with the guide off');
  assert.deepEqual(off.teams, on.teams);
  // The work goes on as before.
  const { taskId } = await run('ospeli_tasks_request', { kind: 'item-run', locationId: 'ward-c1', toLocationId: 'dept-laboratory', detail: 'Specimen' }, 'ward-nurse');
  await run('ospeli_tasks_complete', { taskId }, 'porter');
  await run('ospeli_support_audit_record', { locationId: 'ward-c1', riskCategory: 'high', passed: ALL_EL }, 'support-supervisor');
  const ev = (await core.events({ type: 'support.guide-set' })).at(-1);
  assert.deepEqual([ev.actorRole, ev.data], ['support-supervisor', { on: false }]);
  await run('ospeli_support_guide_set', { on: true }, 'ops-manager');
  assert.equal((await run('ospeli_support_overview', {}, 'coo')).guide.on, true);
});

// ---- the KPIs, recomputed from hand-made event logs ----
const ev = (type, subject, at, data = null, actorRole = 'ward-nurse') => ({ type, subject, actorRole, at: `2026-11-06T${at}:00.000Z`, data });
const PERIOD = { since: '2026-11-06T08:00:00.000Z', until: '2026-11-06T18:00:00.000Z' };

test('KPI porter request to completion, hand-checked: median of 30, 50 and 10 minutes is 30; cancelled, open and earlier jobs left out', () => {
  const ask = (id, at, kind) => ev('task.requested', id, at, { kind, locationId: 'ward-a1', toLocationId: 'dept-imaging', priority: 'routine', detail: 'Bed' });
  const events = [
    ask('task-00001', '07:00', 'patient-move'), ev('task.completed', 'task-00001', '07:40', null, 'porter'), // done before the period
    ask('task-00002', '10:00', 'patient-move'), ev('task.started', 'task-00002', '10:05', null, 'porter'), ev('task.completed', 'task-00002', '10:30', null, 'porter'), // 30
    ask('task-00003', '10:00', 'patient-move'), ev('task.completed', 'task-00003', '10:50', null, 'porter'), // 50
    ask('task-00004', '11:00', 'item-run'), ev('task.completed', 'task-00004', '11:10', null, 'porter'), // 10
    ask('task-00005', '11:00', 'equipment-move'), ev('task.cancelled', 'task-00005', '11:20', { reason: 'Other' }), // cancelled
    ask('task-00006', '12:00', 'patient-move'), ev('task.started', 'task-00006', '12:10', null, 'porter'), // open
    ev('task.requested', 'task-00007', '12:00', { kind: 'room-clean', locationId: 'ward-a1', priority: 'routine', detail: 'Spill' }), ev('task.completed', 'task-00007', '12:05', null, 'cleaner'), // not portering
  ];
  const k = porterRequestToDone(events, PERIOD);
  assert.deepEqual([k.value, k.n], [30, 3]);
  assert.deepEqual(k.breakdown.map((b) => [b.id, b.value, b.n]), [['patient-move', 40, 2], ['item-run', 10, 1], ['equipment-move', null, 0]]);
});

test('KPI bed turnaround, hand-checked: 45 and 75 minutes give 60; a bed still waiting is left out; equals the bed board\'s KPI on the example hospital', () => {
  const beds = new Map([['ward-a1-bed-01', 'ward-a1'], ['ward-a1-bed-02', 'ward-a1'], ['ward-a1-bed-03', 'ward-a1']]);
  const events = [
    ev('bed.vacated', 'ward-a1-bed-01', '10:00'), ev('bed.clean-started', 'ward-a1-bed-01', '10:20', null, 'cleaner'), ev('bed.cleaned', 'ward-a1-bed-01', '10:45', null, 'cleaner'),
    ev('bed.vacated', 'ward-a1-bed-02', '11:00'), ev('bed.cleaned', 'ward-a1-bed-02', '12:15', null, 'cleaner'),
    ev('bed.vacated', 'ward-a1-bed-03', '13:00'),
  ];
  const k = bedTurnaround(events, { ...PERIOD, beds });
  assert.deepEqual([k.value, k.n], [60, 2]);
  assert.equal(k.value, computeKpi('bed-turnaround', events, PERIOD).value);

  const { entities, events: all } = generateHospital({ end: END });
  const map = new Map(entities.filter((e) => e.type === 'bed').map((b) => [b.id, b.parentId]));
  const since = new Date(Date.parse(END) - 7 * 864e5).toISOString();
  const mine = bedTurnaround(all, { since, until: END, beds: map });
  const core = computeKpi('bed-turnaround', all, { since, until: END, bedCount: map.size });
  assert.equal(mine.n, core.denominator);
  assert.ok(Math.abs(mine.value - core.value) < 1e-9, `${mine.value} equals ${core.value}`);
});

test('KPI cleanliness audit score, hand-checked: 13 of 15 elements is 86.7%; by category 80% and 100%; outside the period and malformed entries left out', () => {
  const aud = (id, place, at, riskCategory, passed, failed) => ev('support.audit-recorded', place, at, { auditId: id, riskCategory, passed, failed }, 'support-supervisor');
  const events = [
    aud('aud-00001', 'ward-a1', '07:00', 'high', ['floor'], ['bins']), // before the period
    aud('aud-00002', 'ward-a1', '09:00', 'high', ['floor', 'bed-frame', 'bedside', 'high-touch', 'hand-wash', 'toilet', 'bins', 'dispensers'], ['curtains', 'high-surfaces']), // 8 of 10
    aud('aud-00003', 'dept-theatres', '10:00', 'very-high', ['floor', 'high-touch', 'hand-wash', 'bins', 'dispensers'], []), // 5 of 5
    aud('aud-00004', 'ward-a2', '11:00', 'made-up', ['floor'], []), // not a category on the list
    aud('aud-00002', 'ward-a2', '11:30', 'high', ['floor'], []), // an id used twice
    aud('aud-00005', 'ward-a2', '12:00', 'high', ['not-an-element'], []), // nothing audited
  ];
  const k = auditScore(events, PERIOD);
  assert.deepEqual([k.numerator, k.denominator, k.n], [13, 15, 2]);
  assert.ok(Math.abs(k.value - 86.6667) < 1e-3);
  const by = Object.fromEntries(k.breakdown.map((b) => [b.id, [b.value, b.numerator, b.denominator, b.n]]));
  assert.deepEqual(by, { 'very-high': [100, 5, 5, 1], high: [80, 8, 10, 1], moderate: [null, 0, 0, 0], low: [null, 0, 0, 0] });
  assert.equal(nextAuditId(events), 'aud-00006');
  assert.equal(deriveAudits(events).length, 3);
});

// ---- the guide rules, each a fixed rule with hand-made inputs ----
test('guide rule "which cleans first": one clean per patient with no bed, the longest wait first; a free bed counts; too few cleans or already urgent says nothing', () => {
  const clean = (id, wardId, at, priority = 'routine', state = 'requested') => ({ id, wardId, state, priority, requestedAt: `2026-11-06T${at}:00.000Z`, bedName: id.slice(-6) });
  const wardName = new Map([['ward-a1', 'Ward A1'], ['ward-b1', 'Ward B1']]);
  const openCleans = [clean('clean-ward-a1-bed-03', 'ward-a1', '10:00'), clean('clean-ward-a1-bed-01', 'ward-a1', '09:00'), clean('clean-ward-a1-bed-07', 'ward-a1', '11:00'), clean('clean-ward-b1-bed-02', 'ward-b1', '08:00')];
  const [s] = ruleCleansFirst({ openCleans, patientsWaiting: new Map([['ward-a1', 3]]), freeBeds: new Map([['ward-a1', 1]]), wardName });
  assert.deepEqual(s.action.inputs.map((x) => x.taskId), ['clean-ward-a1-bed-01', 'clean-ward-a1-bed-03'], '3 patients, 1 free bed: 2 cleans, the oldest first');
  assert.equal(s.why, '3 patients are waiting for a bed on Ward A1, 1 bed is free there, and 3 beds wait for a clean.');
  assert.equal(s.text, 'Clean first on Ward A1: bed-01 and bed-03.');
  assert.deepEqual(ruleCleansFirst({ openCleans, patientsWaiting: new Map([['ward-a1', 1]]), freeBeds: new Map([['ward-a1', 1]]), wardName }), [], 'a free bed already takes the patient');
  assert.deepEqual(ruleCleansFirst({ openCleans: openCleans.slice(0, 1), patientsWaiting: new Map([['ward-a1', 2]]), freeBeds: new Map(), wardName }), [], 'one clean is not several');
  const urgent = openCleans.map((c) => ({ ...c, priority: 'urgent' }));
  assert.deepEqual(ruleCleansFirst({ openCleans: urgent, patientsWaiting: new Map([['ward-a1', 2]]), freeBeds: new Map(), wardName }), [], 'already at the front');
  const started = openCleans.map((c) => ({ ...c, state: 'started' }));
  assert.deepEqual(ruleCleansFirst({ openCleans: started, patientsWaiting: new Map([['ward-a1', 2]]), freeBeds: new Map(), wardName }), [], 'cleans in progress need no reordering');
});

test('guide rule "a team is busier than usual": above the example level, with the numbers; names a quieter team; advice only', () => {
  const teams = [{ id: 'portering', name: 'Portering', waiting: 7, longestWaitMinutes: 42 }, { id: 'cleaning', name: 'Cleaning', waiting: 1, longestWaitMinutes: 10 }];
  const [s] = ruleTeamBusy(teams);
  assert.equal(s.text, 'Portering is busier than usual: 7 jobs waiting, the longest for 42 min.');
  assert.equal(s.why, 'The usual level set here is up to 5 waiting and 30 min (example setting, not a standard). Cleaning has 1 job waiting: look at whether someone there can help.');
  assert.equal(s.action, null);
  assert.equal(ruleTeamBusy([{ ...teams[0], waiting: 5, longestWaitMinutes: 30 }, teams[1]]).length, 0, 'at the level is not above it');
  assert.equal(ruleTeamBusy([{ ...teams[0], waiting: 2, longestWaitMinutes: 31 }, { ...teams[1], waiting: 4 }])[0].why.includes('Cleaning'), false, 'a team that is not quiet is not named');
});

test('guide rule "failed twice": the last two audits under the example pass mark, with the elements failed both times', () => {
  const a = (id, score, failed, at) => ({ id, locationId: 'ward-b2', score, failed, at: `2026-11-0${at}T10:00:00.000Z` });
  const name = () => 'Ward B2';
  const [s] = ruleAuditFailedTwice([a('aud-1', 100, [], '1'), a('aud-2', 70, ['curtains', 'bins'], '2'), a('aud-3', 80, ['curtains', 'floor'], '3')], name);
  assert.equal(s.text, 'Re-audit Ward B2 by 10 Nov 2026.', 'an example date: 7 days after the last audit');
  assert.equal(s.reauditBy, '2026-11-10');
  assert.match(s.basis, /7 days after the last audit, also an example setting/);
  assert.equal(s.why, `The last two audits scored 70% and 80%, under the example pass mark of ${PASS_MARK}%. Failed both times: Curtains and screens.`);
  assert.deepEqual(ruleAuditFailedTwice([a('aud-2', 70, ['bins'], '2'), a('aud-3', 90, [], '3')], name), [], 'passed last time');
  assert.deepEqual(ruleAuditFailedTwice([a('aud-3', 50, ['bins'], '3')], name), [], 'once is not twice');
  assert.equal(guideOn([]), true, 'on until a person switches it off');
});

test('synthetic history: audits for every ward and four departments, ids in time order, ward B2 under the pass mark twice at the end', () => {
  const { events } = generateHospital({ end: END });
  const mine = events.filter((e) => e.type.startsWith('support.'));
  assert.ok(mine.every((e) => e.type === 'support.audit-recorded'));
  const audits = deriveAudits(mine);
  assert.equal(audits.length, mine.length, 'every seeded audit is well formed');
  assert.deepEqual([...new Set(audits.map((x) => x.locationId))].sort(), ['dept-emergency', 'dept-imaging', 'dept-outpatients', 'dept-theatres', 'ward-a1', 'ward-a2', 'ward-a3', 'ward-b1', 'ward-b2', 'ward-c1']);
  assert.deepEqual(audits.map((x) => x.id), audits.map((_, i) => `aud-${String(i + 1).padStart(5, '0')}`));
  const b2 = audits.filter((x) => x.locationId === 'ward-b2').slice(-2);
  assert.deepEqual(b2.map((x) => x.score), [70, 80]);
  assert.ok(audits.every((x) => x.byRole === 'support-supervisor'));
});

test('an older example hospital with none of this module\'s history: honest empty answers, no error', async () => {
  const { core, run } = await site({ load: false });
  const { entities, events } = generateHospital({ end: END });
  await core.putEntities(entities, 'system');
  // What a device made before this module holds: none of its audits and no task someone asked for.
  await core.appendEvents(events.filter((e) => !e.type.startsWith('support.') && !e.type.startsWith('task.')), 'system');
  const ov = await run('ospeli_support_overview', {}, 'porter');
  const k = Object.fromEntries(ov.kpis.map((x) => [x.id, x]));
  assert.deepEqual([k['porter-request-to-done'].value, k['porter-request-to-done'].n], [null, 0]);
  assert.deepEqual([k['cleanliness-audit-score'].value, k['cleanliness-audit-score'].n], [null, 0]);
  assert.ok(k['support-bed-turnaround'].n > 0, 'bed cleans come from the bed events, which it has');
  assert.deepEqual(ov.planned.map((p) => [p.id, p.status, p.value]), [['linen-stock-outs', 'planned', undefined], ['meal-waste', 'planned', undefined]]);
  const list = await run('ospeli_support_audits_list', {}, 'cleaner');
  assert.deepEqual([list.total, list.areas.length], [0, 0]);
  const places = await run('ospeli_support_places', {}, 'ward-nurse');
  out('ospeli_support_places', places);
  assert.equal(places.wards.length, 6);
  assert.equal(places.wards[0].beds.length, 20);
  assert.ok(places.departments.some((d) => d.id === 'dept-imaging'));
});

test('every KPI in the pack has a definition, what it leaves out, a source and a target that says when it is an example setting', () => {
  for (const k of pack.KPIS) {
    for (const key of ['definition', 'counts', 'outOf', 'leavesOut', 'source', 'targetText']) assert.ok(k[key]?.length > 5, `${k.id}.${key}`);
    assert.ok(k.target == null || /example setting, not a standard/.test(k.targetText), `${k.id}: a target is labelled an example setting`);
    assert.ok(/local definition|set locally/.test(k.source), `${k.id}: no claimed standard`);
  }
});

test('synthetic jobs: valid kinds, places and roles; ids unique and in time order; started after asked, done after started, nothing after the end; a real queue open at the end', async () => {
  const { entities, events } = generateHospital({ end: END });
  const places = new Set(entities.filter((e) => ['ward', 'bed', 'department'].includes(e.type)).map((e) => e.id));
  const kinds = new Map(pack.TASK_KINDS.map((k) => [k.id, k]));
  const asks = events.filter((e) => e.type === 'task.requested');
  assert.ok(asks.length > 1000, `${asks.length} jobs in 30 days`);
  assert.deepEqual(asks.map((e) => e.subject), asks.map((_, i) => `task-${String(i + 1).padStart(5, '0')}`), 'ids unique, from task-00001, in time order');
  const at = new Map();
  for (const e of events.filter((x) => x.type.startsWith('task.'))) {
    assert.ok(e.at <= END, `${e.subject} ${e.type} is not after the end time`);
    const d = e.data || {};
    if (e.type === 'task.requested') {
      const k = kinds.get(d.kind);
      assert.ok(k, `${e.subject}: kind ${d.kind} exists`);
      assert.ok(places.has(d.locationId) && k.placeTypes.includes(entities.find((x) => x.id === d.locationId).type), `${e.subject}: place ${d.locationId}`);
      assert.equal(!!d.toLocationId, !!k.needsTo);
      if (d.toLocationId) assert.ok(places.has(d.toLocationId) && d.toLocationId !== d.locationId, `${e.subject}: destination`);
      assert.ok(k.details.includes(d.detail), `${e.subject}: detail ${d.detail}`);
      assert.ok(k.requestRoles.includes(e.actorRole), `${e.subject}: asked by ${e.actorRole}`);
      at.set(e.subject, { asked: e.at, kind: k });
    } else {
      const t = at.get(e.subject);
      assert.ok(t, `${e.subject}: ${e.type} follows a request`);
      if (e.type === 'task.started') { assert.ok(e.at > t.asked); assert.ok(t.kind.doRoles.includes(e.actorRole)); t.started = e.at; }
      if (e.type === 'task.completed') { assert.ok(t.started && e.at > t.started, `${e.subject}: done after started`); assert.ok(t.kind.doRoles.includes(e.actorRole)); }
      if (e.type === 'task.cancelled') assert.ok(!t.started, `${e.subject}: cancelled before it started`);
    }
  }
  const { run } = await site();
  const porter = await run('ospeli_tasks_list', { team: 'portering' }, 'porter');
  assert.ok(porter.counts.waiting >= 3 && porter.counts.inProgress >= 1 && porter.counts.urgent >= 1, JSON.stringify(porter.counts));
  assert.equal(porter.tasks[0].priority, 'urgent', 'the urgent job is first');
  const cleaner = await run('ospeli_tasks_list', { team: 'cleaning' }, 'cleaner');
  assert.ok(cleaner.tasks.some((t) => t.kind === 'room-clean' && t.state === 'requested') && cleaner.tasks.some((t) => t.kind === 'room-clean' && t.state === 'started'));
  const ov = await run('ospeli_support_overview', {}, 'support-supervisor');
  const k = ov.kpis.find((x) => x.id === 'porter-request-to-done');
  assert.ok(k.value > 10 && k.value < 90 && k.n > 200, `porter request to completion ${k.value} min from ${k.n}`);
  assert.ok(k.breakdown.every((b) => b.n > 0 && b.value > 0));
  // At the end time the seeded portering queue is within the usual level. (This test's clock ticks on
  // while the hospital loads, so the waits are worked out at the end time itself.)
  const waiting = deriveTasks(events).all.filter((t) => t.state === 'requested' && pack.TASK_KINDS.find((x) => x.id === t.kind).team === 'portering');
  const longest = Math.max(...waiting.map((t) => (Date.parse(END) - Date.parse(t.requestedAt)) / 60000));
  assert.deepEqual(ruleTeamBusy([{ id: 'portering', name: 'Portering', waiting: waiting.length, longestWaitMinutes: longest }]), [], `${waiting.length} waiting, longest ${longest} min`);
  // A person's next request follows the seeded ids.
  const next = await run('ospeli_tasks_request', { kind: 'equipment-move', locationId: 'ward-a1', toLocationId: 'ward-c1', detail: 'Empty bed' }, 'ward-nurse');
  assert.equal(next.taskId, `task-${String(asks.length + 1).padStart(5, '0')}`);
});

test('two patients from one ward are two moves; one bed asked twice is refused with words that name the open job and its bed', async () => {
  const { run } = await site();
  const move = { kind: 'patient-move', locationId: 'ward-b2', toLocationId: 'dept-imaging', detail: 'Wheelchair' };
  const a = await run('ospeli_tasks_request', move, 'ward-nurse');
  const b = await run('ospeli_tasks_request', move, 'ward-nurse');
  assert.notEqual(a.taskId, b.taskId, 'two jobs');
  const bed = { ...move, locationId: 'ward-b2-bed-05' };
  const c = await run('ospeli_tasks_request', bed, 'ward-nurse');
  await assert.rejects(run('ospeli_tasks_request', bed, 'ward-nurse'), (err) => err.code === 'conflict' && err.detail.existing === c.taskId);
  // A specimen run between the same places is one run.
  const run1 = { kind: 'item-run', locationId: 'ward-c1', toLocationId: 'dept-laboratory', detail: 'Specimen' };
  await run('ospeli_tasks_request', run1, 'ward-nurse');
  await assert.rejects(run('ospeli_tasks_request', run1, 'ward-nurse'), code('conflict'));
});

test('a started job handed back goes back in its old place with its reason; the measure keeps the first asked-for time', async () => {
  const { run, advance } = await site();
  const { taskId } = await run('ospeli_tasks_request', { kind: 'equipment-move', locationId: 'ward-a1', toLocationId: 'ward-c1', detail: 'Empty bed' }, 'ward-nurse');
  advance(3);
  await run('ospeli_tasks_start', { taskId }, 'porter');
  await assert.rejects(run('ospeli_tasks_release', { taskId, reason: 'Patient or item not ready' }, 'cleaner'), code('forbidden'), 'a cleaner cannot hand back a porter job');
  await run('ospeli_tasks_release', { taskId, reason: 'Patient or item not ready', expectedState: 'started' }, 'porter');
  const t = (await run('ospeli_tasks_list', { team: 'portering', limit: 200 }, 'porter')).tasks.find((x) => x.id === taskId);
  assert.deepEqual([t.state, t.releases, t.lastReleaseReason], ['requested', 1, 'Patient or item not ready']);
  advance(10);
  await run('ospeli_tasks_start', { taskId }, 'porter');
  advance(7);
  await run('ospeli_tasks_complete', { taskId }, 'porter');
  const done = (await run('ospeli_tasks_list', { state: 'completed', kind: 'equipment-move', limit: 1 }, 'coo')).tasks[0];
  assert.deepEqual([done.id, done.totalMinutes], [taskId, 20], 'asked at T, done at T + 20 min: the hand-back did not restart the clock');
});

test('the overview tells a ward\'s urgent ask from a job moved to the front, and shows bed demand with the guide on or off', async () => {
  const { run } = await site();
  const urgent = await run('ospeli_tasks_request', { kind: 'item-run', locationId: 'ward-c1', toLocationId: 'dept-laboratory', detail: 'Supplies', priority: 'urgent' }, 'ward-nurse');
  const plain = await run('ospeli_tasks_request', { kind: 'equipment-move', locationId: 'ward-a3', toLocationId: 'ward-c1', detail: 'Empty bed' }, 'ward-nurse');
  await run('ospeli_tasks_set_priority', { taskId: plain.taskId, priority: 'urgent' }, 'support-supervisor');
  let ov = await run('ospeli_support_overview', { format: 'short' }, 'support-supervisor');
  assert.deepEqual([ov.marks[urgent.taskId], ov.marks[plain.taskId]], ['asked-urgent', 'do-next']);
  await run('ospeli_tasks_set_priority', { taskId: plain.taskId, priority: 'routine' }, 'support-supervisor');
  ov = await run('ospeli_support_overview', { format: 'short' }, 'support-supervisor');
  assert.equal(ov.marks[plain.taskId], undefined, 'back to its place');
  // Bed demand is a fact from the bed board: the same with the guide off.
  const board = await run('ospeli_beds_board', {}, 'bed-manager');
  const ward = board.waiting.find((w) => !w.allocatedBed && w.wardId).wardId;
  const waitingThere = board.waiting.filter((w) => !w.allocatedBed && w.wardId === ward).length;
  const freeThere = board.beds.filter((b) => b.wardId === ward && b.state === 'available').length;
  await run('ospeli_support_guide_set', { on: false }, 'support-supervisor');
  ov = await run('ospeli_support_overview', { format: 'short' }, 'cleaner');
  assert.deepEqual(ov.bedDemand.find((d) => d.wardId === ward), { wardId: ward, patientsWaiting: waitingThere, freeBeds: freeThere });
  assert.equal(ov.bedDemand.length, 6);
});

test('honest measures: beds used again or taken out of service before a clean are counted apart; porter jobs urgent and normal apart', () => {
  const beds = new Map([['ward-a1-bed-01', 'ward-a1'], ['ward-a1-bed-02', 'ward-a1'], ['ward-a1-bed-03', 'ward-a1']]);
  const events = [
    ev('bed.vacated', 'ward-a1-bed-01', '09:00'), ev('bed.cleaned', 'ward-a1-bed-01', '09:40', null, 'cleaner'), // 40
    ev('bed.vacated', 'ward-a1-bed-02', '10:00'), ev('patient.admitted', 'enc-000001', '10:30', { bedId: 'ward-a1-bed-02', wardId: 'ward-a1' }), // used again
    ev('bed.vacated', 'ward-a1-bed-03', '11:00'), ev('bed.out-of-service', 'ward-a1-bed-03', '11:10', { reason: 'Electrical' }), // out of service
  ];
  const k = bedTurnaround(events, { ...PERIOD, beds });
  assert.deepEqual([k.value, k.n, k.leftOut], [40, 1, { total: 2, usedAgain: 1, outOfService: 1 }]);
  const ask = (id, at, priority) => ev('task.requested', id, at, { kind: 'patient-move', locationId: 'ward-a1', toLocationId: 'dept-imaging', priority, detail: 'Bed' });
  const jobs = [
    ask('task-00001', '10:00', 'urgent'), ev('task.completed', 'task-00001', '10:10', null, 'porter'), // 10, urgent
    ask('task-00002', '10:00', 'routine'), ev('task.completed', 'task-00002', '10:40', null, 'porter'), // 40
    ask('task-00003', '10:00', 'routine'), ev('task.prioritised', 'task-00003', '10:05', { priority: 'urgent' }, 'support-supervisor'), ev('task.completed', 'task-00003', '10:20', null, 'porter'), // 20, moved up
  ];
  const p = porterRequestToDone(jobs, PERIOD);
  assert.deepEqual(p.byPriority.map((b) => [b.id, b.value, b.n]), [['urgent', 15, 2], ['routine', 40, 1]]);
  assert.equal(p.value, 20);
});
