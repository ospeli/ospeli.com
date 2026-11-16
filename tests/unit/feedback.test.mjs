// Patient feedback (module feedback): every command run without the screen, every refusal, agent
// proposals, attack tests on roles, ids and typed text, the guide switch, and each KPI recomputed
// from the event log with hand-checked numbers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Core } from '../../web/app/core/core.js';
import { MemoryAdapter } from '../../web/app/core/db.js';
import { loadSyntheticHospital, generateHospital, buildModel } from '../../web/app/core/generator.js';
import { runCommand, CommandError } from '../../web/app/core/commands.js';
import * as L from '../../web/app/modules/feedback/logic.js';
import * as pack from '../../web/app/modules/feedback/commands.js';

const END = '2026-11-06T18:00:00.000Z';
const human = (role) => ({ type: 'human', role });
const agent = (role, name = 'feedback-bot') => ({ type: 'agent', role, agent: name });
const code = (c, re) => (err) => err instanceof CommandError && err.code === c && (!re || re.test(err.message));
const run = (core, name, input, role) => runCommand(core, name, input, human(role));
const LOG = 'ospeli_experience_complaint_log';
const UPD = 'ospeli_experience_record_update';
const ACT = 'ospeli_experience_action_set';
const Q = 'ospeli_experience_queue_list';
const GET = 'ospeli_experience_record_get';
const TH = 'ospeli_experience_themes_get';
const GUIDE = 'ospeli_experience_guide_set';

// A clock the test moves by hand.
function clock(iso) {
  let t = Date.parse(iso);
  const fn = () => new Date(t);
  fn.set = (x) => { t = Date.parse(x); };
  fn.add = (ms) => { t += ms; };
  return fn;
}
async function site() {
  const c = clock(END);
  const core = await Core.open({ adapter: new MemoryAdapter(), clock: c });
  await loadSyntheticHospital(core, { end: END });
  c.add(60e3);
  return { core, c };
}
// The hospital model with no events at all, for hand-checked numbers through the commands.
async function bareSite(start) {
  const c = clock(start);
  const core = await Core.open({ adapter: new MemoryAdapter(), clock: c });
  await core.putEntities(buildModel(), 'system');
  return { core, c };
}
const complaint = (extra = {}) => ({ kind: 'complaint', channel: 'letter', serviceId: 'dept-outpatients', theme: 'waiting', ...extra });
const feedbackEvents = async (core) => (await core.events()).filter((e) => e.type.startsWith('feedback.'));

test('the synthetic month has every kind of record, open items, two overdue, and no personal details', () => {
  const { events } = generateHospital({ end: END });
  const mine = events.filter((e) => e.type.startsWith('feedback.'));
  const recs = [...L.deriveRecords(mine, { offsetMinutes: -240 }).values()];
  for (const k of Object.keys(L.KINDS)) assert.ok(recs.some((r) => r.kind === k), `has a ${k}`);
  const open = recs.filter(L.isOpen);
  assert.ok(open.length >= 5, `${open.length} open`);
  const over = open.filter((r) => L.timing(r, END).overdue);
  assert.ok(over.length >= 2 && over.length <= 4, `${over.length} overdue at the end`);
  assert.ok(recs.some((r) => r.clinical), 'some passed to clinical review');
  assert.ok(recs.some((r) => r.actions.length), 'some actions agreed');
  for (const e of mine) {
    assert.match(e.subject, /^fb-\d{5}$/);
    for (const k of Object.keys(e.data || {})) assert.doesNotMatch(k, /name|phone|email|staff|address|birth/i, `${e.type} data key ${k}`);
  }
  // Ids follow the order things were received.
  const logged = mine.filter((e) => e.type === L.EVENT.logged);
  assert.deepEqual(logged.map((e) => e.subject), [...logged].sort((a, b) => (a.data.receivedAt < b.data.receivedAt ? -1 : 1)).map((e) => e.subject));
});

test('working days skip Saturday and Sunday in site local time', () => {
  assert.equal(L.addWorkingDays('2026-11-04T09:00:00.000Z', 10), '2026-11-18T09:00:00.000Z'); // Wed + 10 working days
  assert.equal(L.addWorkingDays('2026-11-13T08:00:00.000Z', 2), '2026-11-17T08:00:00.000Z'); // Fri + 2 = Tue
  assert.equal(L.addWorkingDays('2026-11-07T10:00:00.000Z', 1), '2026-11-09T10:00:00.000Z'); // Sat + 1 = Mon
  // 02:00 UTC on Saturday is still Friday 22:00 four hours behind UTC: one working day on is Monday 22:00 local.
  assert.equal(L.addWorkingDays('2026-11-07T02:00:00.000Z', 1, -240), '2026-11-10T02:00:00.000Z');
});

test('a receptionist logs a concern, a compliment and a card in one call each; the due dates follow the settings', async () => {
  const { core } = await site();
  const before = (await feedbackEvents(core)).length;
  const c = await run(core, LOG, { kind: 'concern', channel: 'in-person', serviceId: 'dept-emergency', theme: 'waiting' }, 'receptionist');
  assert.equal(c.status, 'done');
  assert.match(c.recordId, /^fb-\d{5}$/);
  assert.equal(c.stage, 'received');
  assert.equal(c.ackDueAt, L.addWorkingDays(core.now(), 2, -240));
  assert.equal(c.replyDueAt, L.addWorkingDays(core.now(), 10, -240));
  const k = await run(core, LOG, { kind: 'compliment', channel: 'in-person', serviceId: 'dept-emergency', theme: 'attitude', note: 'Very kind and calm team' }, 'receptionist');
  assert.equal(k.stage, 'recorded');
  assert.equal(k.replyDueAt, null);
  const card = await run(core, LOG, { kind: 'card', channel: 'card', serviceId: 'dept-emergency', rating: 2 }, 'receptionist');
  assert.equal(card.stage, 'recorded');
  const evs = await feedbackEvents(core);
  assert.equal(evs.length, before + 3);
  const got = await run(core, GET, { recordId: card.recordId }, 'patient-liaison');
  assert.deepEqual([got.record.kind, got.record.rating, got.record.theme, got.record.channel], ['card', 2, null, 'card']);
  assert.equal(got.replyTemplate, null, 'no template for a card');
  // A concern sorted out on the spot is closed at once and never timed.
  const spot = await run(core, LOG, { kind: 'concern', channel: 'in-person', serviceId: 'dept-emergency', theme: 'environment', resolvedNow: true }, 'ward-nurse');
  assert.equal(spot.stage, 'closed');
  const g2 = await run(core, GET, { recordId: spot.recordId }, 'patient-liaison');
  assert.deepEqual(g2.timeline.map((x) => x.step), ['received', 'closed']);
  assert.equal(g2.record.outcome, 'resolved');
});

test('log refusals: picks that do not fit together are refused with what to do, and nothing is saved', async () => {
  const { core } = await site();
  const n = (await feedbackEvents(core)).length;
  const cases = [
    [{ kind: 'card', channel: 'in-person', serviceId: 'dept-emergency', rating: 3 }, /channel "card"/],
    [{ kind: 'complaint', channel: 'card', serviceId: 'dept-emergency', theme: 'waiting' }, /only for the feedback card/],
    [{ kind: 'card', channel: 'card', serviceId: 'dept-emergency' }, /needs a rating/],
    [complaint({ rating: 4 }), /Only a feedback card has a rating/],
    [{ kind: 'complaint', channel: 'letter', serviceId: 'dept-emergency' }, /Pick what it was about/],
    [{ kind: 'compliment', channel: 'letter', serviceId: 'dept-emergency', theme: 'attitude', clinical: true }, /clinical review/],
    [complaint({ resolvedNow: true }), /Only a concern/],
    [{ kind: 'concern', channel: 'phone', serviceId: 'dept-emergency', theme: 'waiting', resolvedNow: true, clinical: true }, /cannot also be closed/],
    [complaint({ receivedAt: '2026-11-08T10:00:00.000Z' }), /future/],
    [complaint({ receivedAt: '2026-08-01T10:00:00.000Z' }), /more than 60 days/],
    [{ kind: 'card', channel: 'card', serviceId: 'dept-emergency', rating: 3, receivedAt: '2026-11-05T10:00:00.000Z' }, /Leave out receivedAt/],
  ];
  for (const [input, re] of cases) await assert.rejects(run(core, LOG, input, 'receptionist'), code('invalid-input', re), JSON.stringify(input));
  // A received date earlier this week is kept, and the due dates count from it.
  const early = await run(core, LOG, complaint({ receivedAt: '2026-11-02T14:00:00.000Z' }), 'patient-liaison');
  assert.equal(early.replyDueAt, L.addWorkingDays('2026-11-02T14:00:00.000Z', 10, -240));
  assert.equal((await feedbackEvents(core)).length, n + 1);
});

test('attacks on the log: roles, ids, unknown fields, long notes and every kind of personal detail are refused; nothing is saved', async () => {
  const { core } = await site();
  const n = (await feedbackEvents(core)).length;
  for (const role of ['bed-manager', 'estates-tech', 'ae-nic', 'coo', 'quality-lead']) {
    await assert.rejects(run(core, LOG, complaint(), role), code('forbidden'), role);
  }
  await assert.rejects(run(core, LOG, complaint({ serviceId: 'ward-zz9' }), 'receptionist'), (e) => code('not-found')(e) && !e.message.includes('zz9'), 'a made-up service is not echoed back');
  await assert.rejects(run(core, LOG, complaint({ serviceId: 'Ward A1; DROP' }), 'receptionist'), code('invalid-input'));
  await assert.rejects(run(core, LOG, complaint({ patientName: 'x' }), 'receptionist'), code('invalid-input', /not allowed/));
  await assert.rejects(run(core, LOG, complaint({ contact: 'x' }), 'receptionist'), code('invalid-input', /not allowed/));
  await assert.rejects(run(core, LOG, complaint({ note: 'x'.repeat(141) }), 'receptionist'), code('invalid-input', /too long/));
  await assert.rejects(run(core, LOG, complaint({ note: '   ' }), 'receptionist'), code('invalid-input', /empty/));
  const personal = [
    ['Dr Sarah Jones was rude', /names a person/],
    ['Mrs Okafor waited three hours', /names a person/],
    ['Please call back on 0123 456 7890', /phone or ID number/],
    ['Call her on 555-0123456', /phone or ID number/],
    ['Reply to someone@example.org', /email address/],
    ['Record number 12345678 was wrong', /record or ID number/],
    ['MRN: 4455667 asked for a copy', /record or ID number/],
    ['Born 12/03/1980, waited long', /date/],
  ];
  for (const [note, re] of personal) {
    await assert.rejects(run(core, LOG, complaint({ note }), 'receptionist'), code('invalid-input', re), note);
    await assert.rejects(run(core, LOG, { kind: 'card', channel: 'card', serviceId: 'dept-emergency', rating: 1, note }, 'receptionist'), code('invalid-input'), `card: ${note}`);
  }
  // notAName cannot be used to keep a titled name or a number.
  await assert.rejects(run(core, LOG, complaint({ note: 'Dr Sarah Jones was rude', notAName: true }), 'receptionist'), code('invalid-input', /names a person/));
  assert.equal((await feedbackEvents(core)).length, n, 'nothing was saved');
  // An untitled name is asked about once; "not a name" saves the same note.
  const looks = 'Sarah Jones at the desk was rude';
  await assert.rejects(run(core, LOG, complaint({ note: looks }), 'receptionist'), (e) => code('invalid-input', /may hold a person's name/)(e) && e.detail.confirm === 'notAName');
  const ok = await run(core, LOG, complaint({ note: 'Front desk was busy', theme: 'attitude' }), 'receptionist');
  assert.equal(ok.status, 'done');
  // The audit entry holds ids and picks, never the typed text.
  const audit = (await core.auditLog()).filter((a) => a.action === 'feedback.logged').at(-1);
  assert.equal(audit.detail.hasNote, true);
  assert.ok(!JSON.stringify(audit).includes('Front desk was busy'));
});

test('a double tap (or the same form from two tabs) makes one record; the same details later make a second', async () => {
  const { core, c } = await site();
  const a = await run(core, LOG, complaint(), 'receptionist');
  await assert.rejects(run(core, LOG, complaint(), 'receptionist'), (e) => code('conflict')(e) && e.detail.existing === a.recordId);
  c.add(11e3);
  const b = await run(core, LOG, complaint(), 'receptionist');
  assert.notEqual(a.recordId, b.recordId);
});

test('a complaint moves received, acknowledged, replied, closed; each step only from the right stage and by the right role', async () => {
  const { core, c } = await site();
  const { recordId: id } = await run(core, LOG, complaint({ serviceId: 'ward-a1' }), 'patient-liaison');
  // Before an owner is set, the ward nurse is not the owner and cannot act.
  await assert.rejects(run(core, UPD, { recordId: id, step: 'acknowledge', channel: 'letter' }, 'ward-nurse'), code('forbidden', /owner role is Patient liaison officer/));
  await assert.rejects(run(core, UPD, { recordId: id, step: 'close', outcome: 'resolved' }, 'patient-liaison'), code('conflict', /no reply recorded yet/));
  await assert.rejects(run(core, UPD, { recordId: id, step: 'acknowledge' }, 'patient-liaison'), code('invalid-input', /needs channel/));
  await assert.rejects(run(core, UPD, { recordId: id, step: 'set-owner', ownerRole: 'ward-nurse', channel: 'letter' }, 'patient-liaison'), code('invalid-input', /takes no channel/));
  await assert.rejects(run(core, UPD, { recordId: id, step: 'share' }, 'patient-liaison'), code('conflict', /Only a compliment or a feedback card/));
  await run(core, UPD, { recordId: id, step: 'acknowledge', channel: 'letter' }, 'patient-liaison');
  await assert.rejects(run(core, UPD, { recordId: id, step: 'acknowledge', channel: 'letter' }, 'patient-liaison'), code('conflict', /already acknowledged/));
  await run(core, UPD, { recordId: id, step: 'set-owner', ownerRole: 'ward-nurse' }, 'patient-liaison');
  await assert.rejects(run(core, UPD, { recordId: id, step: 'set-owner', ownerRole: 'ward-nurse' }, 'patient-liaison'), code('conflict', /already owns/));
  // The owner can reply; the owner cannot close or change the owner.
  await assert.rejects(run(core, UPD, { recordId: id, step: 'set-owner', ownerRole: 'ops-manager' }, 'ward-nurse'), code('forbidden'));
  // Someone else moved it on: a stale expectedState is refused.
  await assert.rejects(run(core, UPD, { recordId: id, step: 'reply', channel: 'email', expectedState: 'received' }, 'ward-nurse'), code('conflict', /changed since you opened it/));
  c.add(3600e3);
  const r = await run(core, UPD, { recordId: id, step: 'reply', channel: 'email', expectedState: 'acknowledged' }, 'ward-nurse');
  assert.equal(r.stage, 'replied');
  await assert.rejects(run(core, UPD, { recordId: id, step: 'close', outcome: 'resolved' }, 'ward-nurse'), code('forbidden'));
  await assert.rejects(run(core, UPD, { recordId: id, step: 'close', outcome: 'resolved' }, 'coo'), code('forbidden'));
  await run(core, UPD, { recordId: id, step: 'close', outcome: 'partly-resolved' }, 'quality-lead');
  await assert.rejects(run(core, UPD, { recordId: id, step: 'reply', channel: 'email' }, 'patient-liaison'), code('conflict', /closed/));
  const got = await run(core, GET, { recordId: id }, 'ward-nurse');
  assert.deepEqual(got.timeline.map((x) => [x.step, x.role]), [['received', 'patient-liaison'], ['acknowledged', 'patient-liaison'], ['owner-set', 'patient-liaison'], ['replied', 'ward-nurse'], ['closed', 'quality-lead']]);
  assert.deepEqual(got.next, []);
  // Every step left one audit entry, with picks only.
  const steps = (await core.auditLog()).filter((a) => a.target === id).map((a) => a.action);
  assert.deepEqual(steps, ['feedback.logged', 'feedback.acknowledge', 'feedback.set-owner', 'feedback.reply', 'feedback.close']);
});

test('a reply sent before any acknowledgement also acknowledges; a withdrawn complaint closes without a reply', async () => {
  const { core } = await site();
  const a = await run(core, LOG, complaint(), 'patient-liaison');
  await run(core, UPD, { recordId: a.recordId, step: 'reply', channel: 'phone' }, 'patient-liaison');
  const g = await run(core, GET, { recordId: a.recordId }, 'patient-liaison');
  assert.equal(g.record.acknowledgedAt, g.record.repliedAt);
  const b = await run(core, LOG, complaint({ theme: 'billing' }), 'patient-liaison');
  await run(core, UPD, { recordId: b.recordId, step: 'close', outcome: 'withdrawn' }, 'patient-liaison');
  assert.equal((await run(core, GET, { recordId: b.recordId }, 'patient-liaison')).record.stage, 'closed');
});

test('a compliment or card is shared, not timed; made-up and badly formed ids are refused without echoing them', async () => {
  const { core } = await site();
  const k = await run(core, LOG, { kind: 'compliment', channel: 'email', serviceId: 'ward-b2', theme: 'communication' }, 'ward-nurse');
  await assert.rejects(run(core, UPD, { recordId: k.recordId, step: 'acknowledge', channel: 'letter' }, 'patient-liaison'), code('conflict', /no reply timers/));
  await assert.rejects(run(core, UPD, { recordId: k.recordId, step: 'share' }, 'ward-nurse'), code('forbidden'));
  const s = await run(core, UPD, { recordId: k.recordId, step: 'share' }, 'patient-liaison');
  assert.equal(s.stage, 'shared');
  await assert.rejects(run(core, UPD, { recordId: k.recordId, step: 'share' }, 'patient-liaison'), code('conflict', /already shared/));
  await assert.rejects(run(core, UPD, { recordId: 'fb-99999', step: 'share' }, 'patient-liaison'), (e) => code('not-found')(e) && !e.message.includes('99999'));
  await assert.rejects(run(core, GET, { recordId: 'fb-99999' }, 'patient-liaison'), code('not-found'));
  for (const bad of ['FB-00001', 'fb-1', '../fb-00001', 'fb-00001 ', 'fb-000010']) await assert.rejects(run(core, GET, { recordId: bad }, 'patient-liaison'), code('invalid-input'), bad);
  await assert.rejects(run(core, UPD, { recordId: k.recordId, step: 'escalate' }, 'patient-liaison'), code('invalid-input'));
  await assert.rejects(run(core, UPD, { recordId: k.recordId, step: 'share', note: 'x' }, 'patient-liaison'), code('invalid-input', /not allowed/));
  await assert.rejects(run(core, UPD, { recordId: k.recordId, step: 'share' }, 'receptionist'), code('forbidden'));
});

test('clinical care: the record is only marked as passed to clinical review, and is never overdue here', async () => {
  const { core, c } = await site();
  const a = await run(core, LOG, complaint({ clinical: true, serviceId: 'ward-a3' }), 'patient-liaison');
  const b = await run(core, LOG, complaint({ theme: 'communication', serviceId: 'ward-a3' }), 'patient-liaison');
  c.add(30 * 864e5);
  const q = await run(core, Q, { view: 'open', serviceId: 'ward-a3', limit: 500 }, 'patient-liaison');
  const ra = q.records.find((r) => r.id === a.recordId); const rb = q.records.find((r) => r.id === b.recordId);
  assert.equal(ra.clinical, true);
  assert.equal(ra.overdue, false);
  assert.equal(rb.overdue, true);
  assert.ok(q.records.indexOf(ra) > q.records.indexOf(rb), 'clinical review comes after the timed records');
  assert.ok(!q.suggestions.some((s) => s.recordId === a.recordId), 'the guide does not chase it');
  assert.ok((await run(core, Q, { view: 'clinical', limit: 500 }, 'patient-liaison')).records.some((r) => r.id === a.recordId));
  // Passing a record later: once only, and by the owner role or a lead.
  await run(core, UPD, { recordId: b.recordId, step: 'clinical-review' }, 'quality-lead');
  await assert.rejects(run(core, UPD, { recordId: b.recordId, step: 'clinical-review' }, 'quality-lead'), code('conflict', /already passed/));
  const ev = (await feedbackEvents(core)).filter((e) => e.type === L.EVENT.clinical && e.subject === b.recordId);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].data, null, 'nothing about the care is recorded');
});

test('actions: agree with a pick, an owner role and a due date; close; late is worked out from the due date', async () => {
  const { core, c } = await site();
  const { recordId } = await run(core, LOG, complaint({ serviceId: 'ward-a1' }), 'patient-liaison');
  await run(core, UPD, { recordId, step: 'set-owner', ownerRole: 'ward-nurse' }, 'patient-liaison');
  await assert.rejects(run(core, ACT, { op: 'agree', recordId, what: 'process-change', ownerRole: 'ward-nurse', dueInDays: 30 }, 'receptionist'), code('forbidden'));
  await assert.rejects(run(core, ACT, { op: 'agree', recordId, what: 'process-change', ownerRole: 'ward-nurse' }, 'ward-nurse'), code('invalid-input', /dueInDays/));
  await assert.rejects(run(core, ACT, { op: 'agree', recordId, what: 'process-change', ownerRole: 'ward-nurse', dueInDays: 8 }, 'ward-nurse'), code('invalid-input'));
  await assert.rejects(run(core, ACT, { op: 'agree', recordId, what: 'process-change', ownerRole: 'ward-nurse', dueInDays: 7, note: 'Nurse Smith to fix rota' }, 'ward-nurse'), code('invalid-input', /names a person/));
  const a1 = await run(core, ACT, { op: 'agree', recordId, what: 'information', ownerRole: 'ward-nurse', dueInDays: 7, note: 'New sign at the ward door' }, 'ward-nurse');
  assert.equal(a1.actionId, `${recordId}-a1`);
  assert.equal(Date.parse(a1.dueAt) - Date.parse(core.now()), 7 * 864e5);
  const a2 = await run(core, ACT, { op: 'agree', recordId, what: 'team-learning', ownerRole: 'quality-lead', dueInDays: 14 }, 'patient-liaison');
  assert.equal(a2.actionId, `${recordId}-a2`);
  // The action's owner role may close its own action, even when it does not own the record.
  await assert.rejects(run(core, ACT, { op: 'close', recordId, actionId: a1.actionId }, 'ops-manager'), code('forbidden'));
  c.add(5 * 864e5);
  await run(core, ACT, { op: 'close', recordId, actionId: a1.actionId }, 'ward-nurse');
  await assert.rejects(run(core, ACT, { op: 'close', recordId, actionId: a1.actionId }, 'ward-nurse'), code('conflict', /already closed/));
  await assert.rejects(run(core, ACT, { op: 'close', recordId, actionId: `${recordId}-a9` }, 'ward-nurse'), code('not-found'));
  await assert.rejects(run(core, ACT, { op: 'close', recordId, actionId: a2.actionId, what: 'other' }, 'quality-lead'), code('invalid-input', /only recordId and actionId/));
  c.add(20 * 864e5);
  const g = await run(core, GET, { recordId }, 'quality-lead');
  assert.deepEqual(g.actions.map((a) => [a.id, a.late, !!a.closedAt]), [[a1.actionId, false, true], [a2.actionId, true, false]]);
  assert.equal(g.actions[0].note, 'New sign at the ward door');
  const card = await run(core, LOG, { kind: 'card', channel: 'card', serviceId: 'ward-a1', rating: 5 }, 'receptionist');
  await assert.rejects(run(core, ACT, { op: 'agree', recordId: card.recordId, what: 'other', ownerRole: 'ward-nurse', dueInDays: 7 }, 'patient-liaison'), code('conflict', /complaint or a concern/));
});

test('the queue: overdue first, then the nearest reply due date; "mine" is the records the role owns; roles outside the list are refused', async () => {
  const { core } = await site();
  const q = await run(core, Q, { limit: 500 }, 'patient-liaison');
  const now = q.asOf;
  assert.ok(q.counts.overdue >= 2, `${q.counts.overdue} overdue`);
  assert.equal(q.records.filter((r) => r.overdue).length, q.counts.overdue);
  const firstNotOver = q.records.findIndex((r) => !r.overdue);
  assert.ok(q.records.slice(firstNotOver).every((r) => !r.overdue), 'overdue first');
  const timed = q.records.filter((r) => !r.overdue && !r.clinical && r.daysToReplyDue != null).map((r) => r.daysToReplyDue);
  assert.deepEqual(timed, [...timed].sort((a, b) => a - b), 'then by reply due');
  assert.equal(q.settings.includes('example settings') || q.settings.includes('Example settings'), true);
  const mine = await run(core, Q, { mine: true, limit: 500 }, 'ward-nurse');
  assert.ok(mine.records.length > 0 && mine.records.every((r) => r.ownerRole === 'ward-nurse'));
  assert.equal(mine.counts.mine, mine.records.length);
  const short = await run(core, Q, { format: 'short', limit: 2 }, 'patient-liaison');
  assert.equal(short.records.length, 2);
  assert.equal(short.truncated, true);
  assert.ok(!('note' in short.records[0]));
  for (const role of ['receptionist', 'bed-manager', 'estates-tech', 'ae-nic']) await assert.rejects(run(core, Q, {}, role), code('forbidden'), role);
  await assert.rejects(run(core, Q, { view: 'everything' }, 'patient-liaison'), code('invalid-input'));
  await assert.rejects(run(core, Q, { limit: 10000 }, 'patient-liaison'), code('invalid-input'));
  assert.ok(now);
});

test('guide rule 1 flags replies due within 3 days to the owner role and the liaison officer; the switch turns the guide off and nothing else changes', async () => {
  const { core } = await site();
  const liaison = await run(core, Q, { limit: 500 }, 'patient-liaison');
  assert.equal(liaison.guideOn, true);
  assert.ok(liaison.suggestions.length >= 2);
  for (const s of liaison.suggestions) {
    const r = liaison.records.find((x) => x.id === s.recordId);
    assert.ok(r && !r.clinical && r.stage !== 'replied' && r.daysToReplyDue <= 3, s.id);
    assert.equal(s.rule, 'reply-due-soon');
    assert.match(s.why, /example settings, not a standard/);
  }
  const nurse = await run(core, Q, {}, 'ward-nurse');
  assert.ok(nurse.suggestions.every((s) => s.ownerRole === 'ward-nurse'));
  const coo = await run(core, Q, {}, 'coo');
  assert.deepEqual(coo.suggestions, [], 'not for a role that neither owns it nor is the liaison officer');
  const id = liaison.suggestions[0].recordId;
  assert.ok((await run(core, GET, { recordId: id }, 'patient-liaison')).replyTemplate.text.includes(id.toUpperCase()));

  await assert.rejects(run(core, GUIDE, { on: false }, 'ward-nurse'), code('forbidden'));
  await assert.rejects(run(core, GUIDE, { on: false }, 'receptionist'), code('forbidden'));
  await run(core, GUIDE, { on: false }, 'quality-lead');
  const off = await run(core, Q, { limit: 500 }, 'patient-liaison');
  assert.equal(off.guideOn, false);
  assert.deepEqual(off.suggestions, []);
  assert.deepEqual(off.records, liaison.records.map((r) => ({ ...r })), 'the queue is the same with the guide off');
  assert.equal((await run(core, GET, { recordId: id }, 'patient-liaison')).replyTemplate, null);
  // Everything still works with the guide off.
  const made = await run(core, LOG, complaint(), 'receptionist');
  await run(core, UPD, { recordId: made.recordId, step: 'acknowledge', channel: 'email' }, 'patient-liaison');
  const th = await run(core, TH, { format: 'short' }, 'quality-lead');
  assert.equal(th.guide.on, false);
  assert.equal(th.kpis.length, 4);
  await run(core, GUIDE, { on: true }, 'patient-liaison');
  assert.equal((await run(core, Q, {}, 'patient-liaison')).guideOn, true);
});

test('agents: a write waits as a proposal and changes nothing until a person accepts; the guide switch is people only; reads stay in the agent\'s wards', async () => {
  const { core } = await site();
  const wards = (await core.listEntities('ward')).map((w) => w.id);
  await run(core, 'ospeli_agents_set_access', { allowed: true, wards: Object.fromEntries(wards.map((w) => [w, true])) }, 'coo');
  await run(core, 'ospeli_agents_add', { name: 'feedback-bot', role: 'patient-liaison', wards: ['ward-a1'], days: 30 }, 'coo');
  const n = (await feedbackEvents(core)).length;
  const p = await runCommand(core, LOG, complaint({ serviceId: 'ward-a1', note: 'Signage to the ward was unclear' }), agent('patient-liaison'));
  assert.equal(p.status, 'proposed');
  assert.equal((await feedbackEvents(core)).length, n, 'nothing written yet');
  await assert.rejects(runCommand(core, LOG, complaint({ serviceId: 'ward-a1', note: 'Dr Sarah Jones was rude' }), agent('patient-liaison')), code('invalid-input'), 'a personal detail never waits in the queue');
  await assert.rejects(runCommand(core, LOG, { kind: 'card', channel: 'card', serviceId: 'dept-emergency', rating: 5 }, agent('patient-liaison')), code('forbidden', /patient or visitor/));
  await assert.rejects(runCommand(core, LOG, complaint({ serviceId: 'ward-b1' }), agent('patient-liaison')), code('forbidden', /not allowed on ward/));
  await assert.rejects(runCommand(core, GUIDE, { on: false }, agent('patient-liaison')), code('forbidden', /People only/));
  // A person accepts: the command runs as that person.
  const acc = await run(core, 'ospeli_proposals_accept', { id: p.proposal.id }, 'patient-liaison');
  assert.equal(acc.status, 'accepted');
  const id = acc.result.recordId;
  assert.equal((await feedbackEvents(core)).length, n + 1);
  // The agent proposes the next step; one proposal per record; a person declines and nothing changes.
  const p2 = await runCommand(core, UPD, { recordId: id, step: 'acknowledge', channel: 'email' }, agent('patient-liaison'));
  assert.equal(p2.status, 'proposed');
  await assert.rejects(runCommand(core, UPD, { recordId: id, step: 'set-owner', ownerRole: 'ward-nurse' }, agent('patient-liaison')), (e) => e instanceof CommandError);
  await assert.rejects(runCommand(core, UPD, { recordId: id, step: 'close', outcome: 'resolved' }, agent('patient-liaison')), code('conflict', /no reply recorded yet/), 'checked before it is queued');
  await run(core, 'ospeli_proposals_decline', { id: p2.proposal.id, reason: 'Not needed' }, 'patient-liaison');
  assert.equal((await run(core, GET, { recordId: id }, 'patient-liaison')).record.stage, 'received');
  // Reads: the agent sees ward A1 and departments, never another ward's records.
  const q = await runCommand(core, Q, { view: 'all', limit: 500 }, agent('patient-liaison'));
  const svc = new Set(q.records.map((r) => r.serviceId));
  assert.ok([...svc].every((s) => s === 'ward-a1' || s.startsWith('dept-')), [...svc].join(','));
  const other = (await run(core, Q, { view: 'all', serviceId: 'ward-a2', limit: 1 }, 'patient-liaison')).records[0];
  await assert.rejects(runCommand(core, GET, { recordId: other.id }, agent('patient-liaison')), (e) => e instanceof CommandError && ['not-found', 'forbidden'].includes(e.code));
  // Every agent read is in the audit trail.
  assert.ok((await core.auditLog()).some((a) => a.action === 'agent.read' && a.detail.command === Q));
});

test('the reads that return typed notes are marked freeText; the themes board returns none', () => {
  const by = Object.fromEntries(pack.COMMANDS.map((c) => [c.name, c]));
  assert.equal(by[Q].freeText, true);
  assert.equal(by[GET].freeText, true);
  assert.notEqual(by[TH].freeText, true);
  assert.equal(by[GUIDE].agents, false);
});

// ---- KPIs, hand-checked. Site local time = UTC here (offset 0). Due dates: 2 and 10 working days.
//  A fb-00001 complaint: received Mon 2 Nov 10:00, acknowledged Tue 3 Nov 10:00 (1.0 day), replied Tue 10 Nov 10:00 (8.0 days).
//    Reply due Mon 16 Nov 10:00: on time. Action due 17 Nov, closed 15 Nov: on time.
//  B fb-00002 complaint: received Wed 4 Nov 09:00, acknowledged Sat 7 Nov 09:00 (3.0 days; due Fri 6 Nov: late), replied Fri 20 Nov 09:00
//    (16.0 days; due Wed 18 Nov: late). Action due 25 Nov, not closed: late.
//  C fb-00003 complaint passed to clinical review: left out of every KPI.
//  D fb-00004 complaint: received Fri 13 Nov 08:00, acknowledged Mon 16 Nov 08:00 (3.0 days), no reply; reply due Fri 27 Nov 08:00 (passed).
//    Action due 10 Dec: not yet due.
//  E fb-00005 concern: left out of KPIs 1 to 3.
//  F fb-00006 complaint: received Tue 3 Nov, withdrawn 5 Nov with no reply: left out of "responses on time".
// Period 1 to 30 Nov, now 30 Nov 12:00.
//  Acknowledgement time: median of 1, 3, 3 = 3.0 days (3 complaints).
//  Response time: median of 8, 16 = 12.0 days (2 complaints).
//  Responses on time: A on time, B late, D not replied = 1 of 3 = 33%.
//  Actions closed on time: A's on time, B's late (D's not due) = 1 of 2 = 50%.
const E = (type, subject, at, data = null, actorRole = 'patient-liaison') => ({ type, subject, at, data, actorRole });
const logged = (id, kind, at, extra = {}) => E(L.EVENT.logged, id, at, { kind, channel: 'letter', serviceId: 'dept-outpatients', theme: 'waiting', rating: null, note: null, ownerRole: 'patient-liaison', receivedAt: at, ...extra });
const KPI_LOG = [
  logged('fb-00001', 'complaint', '2026-11-02T10:00:00.000Z'),
  logged('fb-00002', 'complaint', '2026-11-04T09:00:00.000Z'),
  logged('fb-00003', 'complaint', '2026-11-09T12:00:00.000Z'),
  E(L.EVENT.clinical, 'fb-00003', '2026-11-09T12:05:00.000Z'),
  logged('fb-00004', 'complaint', '2026-11-13T08:00:00.000Z'),
  logged('fb-00005', 'concern', '2026-11-02T11:00:00.000Z'),
  logged('fb-00006', 'complaint', '2026-11-03T10:00:00.000Z'),
  E(L.EVENT.acknowledged, 'fb-00005', '2026-11-02T12:00:00.000Z', { channel: 'phone' }),
  E(L.EVENT.acknowledged, 'fb-00001', '2026-11-03T10:00:00.000Z', { channel: 'letter' }),
  E(L.EVENT.closed, 'fb-00006', '2026-11-05T10:00:00.000Z', { outcome: 'withdrawn' }),
  E(L.EVENT.acknowledged, 'fb-00002', '2026-11-07T09:00:00.000Z', { channel: 'letter' }),
  E(L.EVENT.acknowledged, 'fb-00003', '2026-11-09T18:00:00.000Z', { channel: 'letter' }),
  E(L.EVENT.replied, 'fb-00001', '2026-11-10T10:00:00.000Z', { channel: 'letter' }),
  E(L.EVENT.actionAgreed, 'fb-00001', '2026-11-10T10:10:00.000Z', { actionId: 'fb-00001-a1', what: 'information', ownerRole: 'ward-nurse', dueAt: '2026-11-17T10:00:00.000Z', note: null }),
  E(L.EVENT.actionClosed, 'fb-00001', '2026-11-15T10:00:00.000Z', { actionId: 'fb-00001-a1' }),
  E(L.EVENT.acknowledged, 'fb-00004', '2026-11-16T08:00:00.000Z', { channel: 'email' }),
  E(L.EVENT.replied, 'fb-00002', '2026-11-20T09:00:00.000Z', { channel: 'email' }),
  E(L.EVENT.actionAgreed, 'fb-00002', '2026-11-20T09:10:00.000Z', { actionId: 'fb-00002-a1', what: 'review', ownerRole: 'ward-nurse', dueAt: '2026-11-25T09:00:00.000Z', note: null }),
  E(L.EVENT.actionAgreed, 'fb-00004', '2026-11-26T09:00:00.000Z', { actionId: 'fb-00004-a1', what: 'other', ownerRole: 'ops-manager', dueAt: '2026-12-10T09:00:00.000Z', note: null }),
];
const PERIOD = { since: '2026-11-01T00:00:00.000Z', until: '2026-12-01T00:00:00.000Z', now: '2026-11-30T12:00:00.000Z', offsetMinutes: 0 };

test('KPIs from a hand-built event log match the numbers worked out by hand', () => {
  const recs = L.deriveRecords(KPI_LOG, { offsetMinutes: 0 });
  assert.equal(recs.get('fb-00002').ackDueAt, '2026-11-06T09:00:00.000Z');
  assert.equal(recs.get('fb-00002').replyDueAt, '2026-11-18T09:00:00.000Z');
  assert.equal(recs.get('fb-00004').replyDueAt, '2026-11-27T08:00:00.000Z');
  assert.deepEqual(L.kpiAckTime(KPI_LOG, PERIOD), { value: 3, numerator: null, denominator: 3 });
  assert.deepEqual(L.kpiResponseTime(KPI_LOG, PERIOD), { value: 12, numerator: null, denominator: 2 });
  assert.deepEqual(L.kpiResponsesOnTime(KPI_LOG, PERIOD), { value: 33, numerator: 1, denominator: 3 });
  assert.deepEqual(L.kpiActionsClosed(KPI_LOG, PERIOD), { value: 50, numerator: 1, denominator: 2 });
  // Earlier "now": only what has fallen due by then counts (A due 16 Nov; B due 18 Nov not yet).
  assert.deepEqual(L.kpiResponsesOnTime(KPI_LOG, { ...PERIOD, now: '2026-11-17T00:00:00.000Z' }), { value: 100, numerator: 1, denominator: 1 });
  // A period with nothing in it gives no number, not zero.
  assert.deepEqual(L.kpiAckTime(KPI_LOG, { ...PERIOD, since: '2026-10-01T00:00:00.000Z', until: '2026-11-01T00:00:00.000Z' }), { value: null, numerator: null, denominator: 0 });
  // Timing at the end of the period.
  assert.equal(L.timing(recs.get('fb-00004'), PERIOD.now).overdue, true);
  assert.equal(L.timing(recs.get('fb-00003'), PERIOD.now).overdue, false, 'clinical review is not timed here');
  const g = L.guideReplyDue([...recs.values()], '2026-11-25T08:00:00.000Z');
  // E (a concern, reply due 16 Nov) is 9 days late and comes first; D is 2 days from its due date.
  // A and B are replied, C is passed to clinical review, F is closed.
  assert.deepEqual(g.map((s) => s.recordId), ['fb-00005', 'fb-00004']);
  assert.deepEqual(g.map((s) => s.title), ['FB-00005: reply 9 days late', 'FB-00004: reply due in 2 days']);
  for (const k of L.KPIS) {
    assert.equal(k.source, 'local definition');
    assert.ok(k.leavesOut && k.definition && k.targetText);
    assert.equal(k.target, null, 'no target without a source');
  }
  assert.match(L.KPIS[0].leavesOut, /clinical review/);
});

test('the same KPIs through the commands: people do the steps on screen, the themes board gives the hand-checked numbers', async () => {
  const { core, c } = await bareSite('2026-11-02T10:00:00.000Z');
  const PL = 'patient-liaison';
  // C, D and F are logged with an earlier received date, the way a letter that arrived earlier is logged.
  const at = async (iso, fn) => { c.set(iso); return fn(); };
  const A = (await at('2026-11-02T10:00:00.000Z', () => run(core, LOG, complaint(), PL))).recordId;
  const F = (await at('2026-11-03T10:00:00.000Z', () => run(core, LOG, complaint({ theme: 'billing' }), PL))).recordId;
  const B = (await at('2026-11-04T09:00:00.000Z', () => run(core, LOG, complaint({ theme: 'access' }), PL))).recordId;
  await at('2026-11-03T10:00:00.000Z', () => run(core, UPD, { recordId: A, step: 'acknowledge', channel: 'letter' }, PL));
  await at('2026-11-05T10:00:00.000Z', () => run(core, UPD, { recordId: F, step: 'close', outcome: 'withdrawn' }, PL));
  await at('2026-11-07T09:00:00.000Z', () => run(core, UPD, { recordId: B, step: 'acknowledge', channel: 'letter' }, PL));
  const C2 = (await at('2026-11-09T12:00:00.000Z', () => run(core, LOG, complaint({ clinical: true }), PL))).recordId;
  await at('2026-11-09T18:00:00.000Z', () => run(core, UPD, { recordId: C2, step: 'acknowledge', channel: 'letter' }, PL));
  await at('2026-11-10T10:00:00.000Z', () => run(core, UPD, { recordId: A, step: 'reply', channel: 'letter' }, PL));
  const a1 = await at('2026-11-10T10:10:00.000Z', () => run(core, ACT, { op: 'agree', recordId: A, what: 'information', ownerRole: 'ward-nurse', dueInDays: 7 }, PL));
  await at('2026-11-15T10:00:00.000Z', () => run(core, ACT, { op: 'close', recordId: A, actionId: a1.actionId }, 'ward-nurse'));
  const D = (await at('2026-11-13T08:00:00.000Z', () => run(core, LOG, complaint({ theme: 'food', serviceId: 'ward-a1' }), PL))).recordId;
  await at('2026-11-16T08:00:00.000Z', () => run(core, UPD, { recordId: D, step: 'acknowledge', channel: 'email' }, PL));
  await at('2026-11-20T09:00:00.000Z', () => run(core, UPD, { recordId: B, step: 'reply', channel: 'email' }, PL));
  await at('2026-11-20T09:10:00.000Z', () => run(core, ACT, { op: 'agree', recordId: B, what: 'review', ownerRole: 'ward-nurse', dueInDays: 7 }, PL));
  await at('2026-11-21T09:00:00.000Z', () => run(core, LOG, { kind: 'concern', channel: 'phone', serviceId: 'dept-outpatients', theme: 'waiting' }, 'receptionist'));
  await at('2026-11-22T09:00:00.000Z', () => run(core, LOG, { kind: 'card', channel: 'card', serviceId: 'dept-outpatients', rating: 5, theme: 'attitude' }, 'receptionist'));
  await at('2026-11-22T09:01:00.000Z', () => run(core, LOG, { kind: 'card', channel: 'card', serviceId: 'dept-outpatients', rating: 1 }, 'receptionist'));
  await at('2026-11-22T10:00:00.000Z', () => run(core, LOG, { kind: 'compliment', channel: 'email', serviceId: 'ward-a1', theme: 'attitude' }, 'ward-nurse'));
  c.set('2026-11-30T12:00:00.000Z');
  // The example site's local time is four hours behind UTC: November in local time is 1 Nov 04:00 to 1 Dec 04:00 UTC.
  const t = await run(core, TH, { month: '2026-11' }, 'quality-lead');
  const by = Object.fromEntries(t.kpis.map((k) => [k.id, [k.value, k.numerator, k.denominator]]));
  // Acknowledgement: A 1.0, B 3.0, D 3.0 -> 3.0. Response: A 8.0, B 16.0 -> 12.0.
  // On time (local time does not move any due date across the period edges): A of A, B, D = 33%.
  // Actions: A's (due 17 Nov) on time; B's (due 27 Nov) not closed = 1 of 2.
  assert.deepEqual(by, {
    'feedback-ack-time': [3, null, 3], 'feedback-response-time': [12, null, 2],
    'feedback-responses-on-time': [33, 1, 3], 'feedback-actions-closed': [50, 1, 2],
  });
  // The board counts: 5 complaints (A, B, C, D, F), 1 concern, 1 compliment, 2 cards (1 good, 1 poor).
  assert.deepEqual([t.totals.complaints, t.totals.concerns, t.totals.compliments, t.totals.cards, t.totals.cardsGood, t.totals.cardsPoor], [5, 1, 1, 2, 1, 1]);
  assert.deepEqual(t.ratings, [1, 0, 0, 0, 1]);
  const th = Object.fromEntries(t.byTheme.map((x) => [x.theme, x]));
  assert.deepEqual([th.waiting.complaints, th.waiting.concerns, th.attitude.compliments, th.attitude.cards], [2, 1, 1, 1]);
  assert.equal(t.themeNotGiven.cards, 1);
  assert.deepEqual(t.byService.map((s) => [s.serviceId, s.complaints]), [['dept-outpatients', 4], ['ward-a1', 1]]);
  assert.equal(t.hasHistory, true);
  assert.match(t.method, /Counts only/);
  // The same numbers straight from the event log.
  const evs = await core.events();
  const since = '2026-11-01T04:00:00.000Z'; const until = '2026-12-01T04:00:00.000Z';
  assert.deepEqual(L.kpiAckTime(evs, { since, until, offsetMinutes: -240 }).value, 3);
  assert.deepEqual(L.kpiResponsesOnTime(evs, { since, until, now: core.now(), offsetMinutes: -240 }), { value: 33, numerator: 1, denominator: 3 });
});

test('a device with an older example hospital (no feedback history) gives honest empty answers', async () => {
  const { core } = await bareSite('2026-11-20T10:00:00.000Z');
  const t = await run(core, TH, {}, 'receptionist');
  assert.equal(t.hasHistory, false);
  assert.equal(t.records, 0);
  assert.ok(t.kpis.every((k) => k.value === null && k.denominator === 0));
  assert.ok(t.options.services.length > 10, 'the services still come from the hospital model');
  const q = await run(core, Q, {}, 'patient-liaison');
  assert.deepEqual([q.total, q.counts.open, q.suggestions.length], [0, 0, 0]);
  await assert.rejects(run(core, TH, { serviceId: 'dept-nowhere' }, 'receptionist'), code('not-found'));
  await assert.rejects(run(core, TH, { month: '2026-13' }, 'receptionist'), code('invalid-input'));
});

test('the template reply is a fixed text from the picks: it names no person and carries no typed note', () => {
  const r = L.deriveRecords(KPI_LOG, { offsetMinutes: 0 }).get('fb-00001');
  r.note = 'Signage was unclear';
  const text = L.replyTemplate(r, { serviceName: 'Outpatients' });
  assert.match(text, /^Reference FB-00001/);
  assert.match(text, /about waiting at Outpatients/);
  assert.match(text, /Improve information or signs, by 2026-11-17/);
  assert.ok(!text.includes('Signage was unclear'));
  const c3 = L.deriveRecords(KPI_LOG, { offsetMinutes: 0 }).get('fb-00003');
  assert.match(L.replyTemplate(c3, { serviceName: 'Outpatients' }), /passed to clinical review/);
});
