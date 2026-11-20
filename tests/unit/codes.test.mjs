// The shared patient code with a stage timeline (core/codes.js, core/code-commands.js): one
// reference code for one episode, never a name, with timed stages. Shared-objects proposal
// section 6; A1 and E2 briefs. Built 19 Nov 2026 (module crew, night 5). Synthetic data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Core } from '../../web/app/core/core.js';
import { MemoryAdapter } from '../../web/app/core/db.js';
import { loadSyntheticHospital, generateHospital } from '../../web/app/core/generator.js';
import { runCommand, listCommands, CommandError } from '../../web/app/core/commands.js';
import { validate } from '../../web/app/core/schema.js';
import { ROLES } from '../../web/app/core/model.js';
import { MODULE_PACKS } from '../../web/app/core/modules.js';

import * as codes from '../../web/app/core/codes.js';
import { codeCommands } from '../../web/app/core/code-commands.js';
import * as slots from '../../web/app/core/slots.js';
import { slotCommands } from '../../web/app/core/slot-commands.js';
const t = test;

const END = '2026-11-06T18:00:00.000Z'; // a Friday, 14:00 on the example site (UTC-4)
const MON = '2026-11-09';
const OFFSET = -240;
const human = (role) => ({ type: 'human', role });
const agent = (role, name = 'code-bot') => ({ type: 'agent', role, agent: name });
const code = (c) => (err) => err instanceof CommandError && err.code === c;
const ROLE_IDS = ROLES.map((r) => r.id);

// Kinds of episode written the way a module pack would, with roles that exist in every build.
const PACK = {
  id: 'testcodes',
  CODE_KINDS: [
    { id: 'test-referral', word: 'Outpatient referral', services: { 'test-eyes': 'Eye clinic', 'test-skin': 'Skin clinic' }, sources: ['referral', 'walk-in'], placeTypes: ['department'],
      openRoles: ['receptionist', 'ops-manager'], stageRoles: ['receptionist'], closeRoles: ['receptionist', 'ops-manager'],
      stages: [
        { id: 'referral.accepted', word: 'Referral accepted', after: [] },
        { id: 'on-hold', word: 'On hold', after: ['referral.accepted'] },
        { id: 'back-on-list', word: 'Back on the list', after: ['on-hold'], roles: ['ops-manager'] },
      ],
      openStage: 'referral.accepted' },
    { id: 'test-programme', word: 'Follow-up programme', services: { 'test-wound': 'Wound care' }, sources: ['referral', 'transfer-in'], placeTypes: ['site', 'department'],
      openRoles: ['ward-nurse'], stageRoles: ['ward-nurse'], closeRoles: ['ward-nurse'], dueBy: true, dueRoles: ['ward-nurse'], links: true,
      stages: [{ id: 'enrolled', word: 'Enrolled', after: [] }, { id: 'moved', word: 'Moved', after: ['enrolled', 'moved'] }] },
  ],
  CODE_CLOSE_REASONS: ['Programme finished'],
  SESSION_TYPES: [{ id: 'test-clinic', word: 'Clinic', timed: true, placeTypes: ['department'], runByRoles: ['ops-manager'], planRoles: ['ops-manager'], bookRoles: ['receptionist'], stepRoles: ['receptionist'] }],
  SLOT_TYPES: { 'test-new': 'New' },
};
const CMDS = Object.fromEntries([...codeCommands([PACK]), ...slotCommands([PACK])].map((c) => [c.name, c]));

// Run a command the way the command layer does for a person: schema first, then the role list, then the command.
async function run(core, name, input, role) {
  const c = CMDS[name];
  assert.ok(c, `command ${name} exists`);
  const errs = validate(c.input, input);
  if (errs.length) throw new CommandError('invalid-input', errs.join('; '));
  if (!c.roles.includes(role)) throw new CommandError('forbidden', `${role} cannot run ${name}`);
  return c.run(core, input, { actor: human(role), wards: null });
}
async function site() {
  const time = { now: END };
  const core = await Core.open({ adapter: new MemoryAdapter(), clock: () => new Date(time.now) });
  // The object on its own: no module's history, so the first code, session and appointment are 00001.
  await loadSyntheticHospital(core, { end: END, modules: false });
  return { core, time };
}
const later = (time, minutes) => { time.now = new Date(Date.parse(time.now) + minutes * 60e3).toISOString(); };
const open = (core, over = {}, role = 'receptionist') => run(core, 'ospeli_codes_open', { kind: 'test-referral', service: 'test-eyes', source: 'referral', ...over }, role);
const derive = async (core) => codes.deriveCodes(await core.events(), { packs: [PACK] });
const get = async (core, c, role = 'coo') => run(core, 'ospeli_codes_get', { code: c }, role);
async function clinic(core, date = MON) {
  const ses = await run(core, 'ospeli_slots_session_plan', { sessionType: 'test-clinic', placeId: 'dept-outpatients', date, start: '09:00', minutes: 80, slotMinutes: 20, runByRole: 'ops-manager' }, 'ops-manager');
  return ses.sessionId;
}
const at = (date, hhmm) => new Date(Date.parse(`${date}T${hhmm}:00.000Z`) - OFFSET * 60e3).toISOString();

t('a pack\'s kinds of episode are checked when they are added', () => {
  const kind = (over) => ({ id: 'x-kind', word: 'X', services: { 'x-one': 'One' }, sources: ['referral'], placeTypes: ['department'], openRoles: ['ops-manager'], stageRoles: ['ops-manager'], closeRoles: ['ops-manager'], stages: [], ...over });
  const bad = (k, why) => assert.throws(() => codes.codeCatalogue([{ id: 'm', CODE_KINDS: [k] }], ROLE_IDS), why);
  bad(kind({ id: 'Bad Id' }), /id must be/);
  bad(kind({ services: {} }), /services/);
  bad(kind({ sources: ['typed-in'] }), /sources/);
  bad(kind({ placeTypes: ['street'] }), /place type/);
  bad(kind({ openRoles: ['made-up-role'] }), /unknown role/);
  bad(kind({ stages: [{ id: 'aa', word: 'A', after: ['nowhere'] }] }), /not a stage/);
  bad(kind({ stages: [{ id: 'aa', word: 'A', after: [] }, { id: 'bb', word: 'B', after: ['aa'] }], openStage: 'bb' }), /first stage/);
  bad(kind({ dueBy: true }), /dueRoles/);
  bad(kind({ dueRoles: ['ops-manager'] }), /dueBy: true/);
  assert.throws(() => codes.codeCatalogue([PACK, { id: 'other', CODE_KINDS: [PACK.CODE_KINDS[0]] }], ROLE_IDS), /already used/);
  const { kinds, closeReasons } = codes.codeCatalogue([PACK], ROLE_IDS);
  assert.deepEqual([...kinds.keys()], ['test-referral', 'test-programme']);
  assert.deepEqual(closeReasons.slice(-2), ['Programme finished', 'Other'], 'a pack\'s reason goes in before Other');
});

t('opening makes the code: numbered by Ospeli, labelled without a name, with the kind\'s first stage', async () => {
  const { core, time } = await site();
  const a = await open(core, { placeId: 'dept-outpatients' });
  assert.deepEqual([a.status, a.code, a.label, a.state, a.stage], ['done', 'pc-00001', 'Patient P1', 'open', 'referral.accepted']);
  assert.equal(a.events.length, 2, 'code.opened and its first stage, written together');
  later(time, 5);
  const b = await open(core, { service: 'test-skin' });
  assert.equal(b.code, 'pc-00002');
  const d = await derive(core);
  const c1 = d.codes.get('pc-00001');
  assert.deepEqual([c1.kind, c1.service, c1.source, c1.placeId, c1.stage, c1.openedByRole], ['test-referral', 'test-eyes', 'referral', 'dept-outpatients', 'referral.accepted', 'receptionist']);
  assert.equal(codes.codeLabel('enc-004512'), 'Patient 4512', 'a stay keeps the bed board\'s label');
  // Nothing personal can ride along: unknown fields and a typed code are refused by the schema.
  for (const extra of [{ name: 'A Person' }, { code: 'pc-00077' }, { note: 'urgent' }, { recordNumber: '12345' }]) {
    await assert.rejects(open(core, extra), code('invalid-input'));
  }
  await assert.rejects(open(core, { service: 'test-wound' }), code('invalid-input'), 'a service of another kind');
  await assert.rejects(open(core, { source: 'transfer-in' }), code('invalid-input'), 'a source this kind does not begin from');
  await assert.rejects(open(core, { placeId: 'ward-a1' }), code('invalid-input'), 'a referral sits in a department');
  await assert.rejects(open(core, { placeId: 'dept-nowhere' }), code('not-found'));
  await assert.rejects(open(core, {}, 'ward-nurse'), code('forbidden'));
  await assert.rejects(open(core, { kind: 'test-programme', service: 'test-wound' }, 'receptionist'), code('forbidden'), 'the role check is per kind');
});

t('a double tap on open asks before making a second code; "again" and a later opening go through', async () => {
  const { core, time } = await site();
  const a = await open(core);
  await assert.rejects(open(core), (err) => code('conflict')(err) && err.detail.confirm === 'again' && err.detail.code === a.code);
  assert.equal((await derive(core)).codes.size, 1);
  assert.equal((await open(core, { service: 'test-skin' })).code, 'pc-00002', 'another service is another opening');
  assert.equal((await open(core, { again: true })).code, 'pc-00003', 'really another patient');
  later(time, 3);
  assert.equal((await open(core)).code, 'pc-00004', 'after two minutes it is not a double tap');
});

t('stages go in the kind\'s order; a wrong step is refused and says what may come next', async () => {
  const { core, time } = await site();
  const { code: c } = await open(core);
  const stage = (s, role = 'receptionist', extra = {}) => run(core, 'ospeli_codes_stage', { code: c, stage: s, ...extra }, role);
  await assert.rejects(stage('back-on-list', 'ops-manager'), (err) => code('conflict')(err) && err.detail.stage === 'referral.accepted' && err.detail.next.join() === 'on-hold');
  await assert.rejects(stage('enrolled'), code('invalid-input'), 'a stage of another kind');
  later(time, 10);
  const held = await stage('on-hold', 'receptionist', { expectedStage: 'referral.accepted' });
  assert.deepEqual([held.status, held.stage, held.events.length], ['done', 'on-hold', 1]);
  const again = await stage('on-hold');
  assert.deepEqual([again.status, again.events.length], ['done', 0], 'the same stage twice writes nothing');
  await assert.rejects(stage('back-on-list', 'receptionist'), code('forbidden'), 'a stage may name its own roles');
  await assert.rejects(stage('back-on-list', 'ops-manager', { expectedStage: 'referral.accepted' }), (err) => code('conflict')(err) && err.detail.stage === 'on-hold');
  later(time, 20);
  await stage('back-on-list', 'ops-manager');
  const c1 = (await derive(core)).codes.get(c);
  assert.deepEqual(c1.stages.map((s) => s.stage), ['referral.accepted', 'on-hold', 'back-on-list']);
  // Hand-checked: 10 minutes accepted, 20 on hold, then 15 more to "now".
  later(time, 15);
  assert.deepEqual(codes.stageDurations(c1, time.now).map((s) => s.minutes), [10, 20, 15]);
  const g = await get(core, c);
  assert.deepEqual(g.code.nextStages, [], 'nothing follows the last stage');
  assert.deepEqual(g.timeline.map((x) => x.word), ['Opened', 'Referral accepted', 'On hold', 'Back on the list']);
});

t('a stage that may repeat (a move) is written again only for another place', async () => {
  const { core } = await site();
  const { code: c } = await open(core, { kind: 'test-programme', service: 'test-wound' }, 'ward-nurse');
  const stage = (s, extra = {}) => run(core, 'ospeli_codes_stage', { code: c, stage: s, ...extra }, 'ward-nurse');
  await assert.rejects(stage('moved'), code('conflict'), 'not a first stage');
  await stage('enrolled');
  assert.equal((await stage('moved', { placeId: 'dept-outpatients' })).events.length, 1);
  assert.equal((await stage('moved', { placeId: 'dept-outpatients' })).events.length, 0, 'the same move twice');
  assert.equal((await stage('moved', { placeId: 'site-north' })).events.length, 1, 'a move to another place');
  assert.equal((await derive(core)).codes.get(c).placeId, 'site-north');
});

t('a due-by date is set by a person only, and overdue follows the site\'s own calendar', async () => {
  const { core, time } = await site();
  assert.equal(CMDS.ospeli_codes_due_set.agents, false, 'never by an agent or a rule');
  const { code: c } = await open(core, { kind: 'test-programme', service: 'test-wound' }, 'ward-nurse');
  const { code: r } = await open(core);
  const due = (dueBy, target = c, role = 'ward-nurse') => run(core, 'ospeli_codes_due_set', { code: target, dueBy }, role);
  await assert.rejects(due('2026-11-10', r), code('invalid-input'), 'a referral has no due-by date');
  await assert.rejects(due('2026-02-30'), code('invalid-input'));
  await assert.rejects(due('2026-11-05'), code('invalid-input'), 'before the day it was opened');
  await assert.rejects(due('2026-11-10', c, 'receptionist'), code('forbidden'));
  assert.equal((await due('2026-11-10')).dueBy, '2026-11-10');
  assert.equal((await due('2026-11-10')).events.length, 0);
  const list = (extra = {}) => run(core, 'ospeli_codes_list', { kind: 'test-programme', ...extra }, 'coo');
  // 03:00 UTC on the 11th is still 23:00 on the 10th at the site: due today is not overdue.
  time.now = '2026-11-11T03:00:00.000Z';
  assert.deepEqual([(await list()).codes[0].overdue, (await list()).counts.overdue], [false, 0]);
  time.now = '2026-11-11T04:30:00.000Z'; // 00:30 on the 11th at the site
  assert.deepEqual([(await list({ overdue: true })).codes.map((x) => x.code), (await list()).counts.overdue], [[c], 1]);
  assert.deepEqual(codes.overdueFollowUps(await derive(core), '2026-11-11').map((x) => x.code), [c]);
  assert.equal((await due(null)).dueBy, null);
  assert.equal((await list({ overdue: true })).total, 0);
});

t('two codes that move together are linked once, from either side', async () => {
  const { core } = await site();
  const a = (await open(core, { kind: 'test-programme', service: 'test-wound' }, 'ward-nurse')).code;
  const b = (await open(core, { kind: 'test-programme', service: 'test-wound', again: true }, 'ward-nurse')).code;
  const r = (await open(core)).code;
  const link = (x, y, role = 'ward-nurse') => run(core, 'ospeli_codes_link', { code: x, otherCode: y, relation: 'moves-with' }, role);
  await assert.rejects(link(a, a), code('invalid-input'));
  await assert.rejects(link(a, r), code('invalid-input'), 'a kind that is not linked');
  assert.equal((await link(a, b)).events.length, 1);
  assert.equal((await link(b, a)).events.length, 0, 'already linked, from the other side');
  const d = await derive(core);
  assert.deepEqual([d.codes.get(a).links[0].otherCode, d.codes.get(b).links[0].otherCode], [b, a]);
  assert.deepEqual((await get(core, b)).code.linkedCodes, [a]);
});

t('a code is not closed while an appointment is open; closed is final and a closed code takes no booking', async () => {
  const { core, time } = await site();
  const { code: c } = await open(core);
  const sessionId = await clinic(core);
  const appt = await run(core, 'ospeli_slots_book', { sessionId, slotTime: '09:00', code: c, slotType: 'test-new', bookedFrom: 'referral' }, 'receptionist');
  const close = (reason = 'Episode finished', role = 'receptionist', extra = {}) => run(core, 'ospeli_codes_close', { code: c, reason, ...extra }, role);
  await assert.rejects(close(), (err) => code('conflict')(err) && err.detail.openAppointments.join() === appt.appointmentId);
  await assert.rejects(close('Because I say so'), code('invalid-input'), 'a reason is a pick');
  await assert.rejects(close('Episode finished', 'ward-nurse'), code('forbidden'));
  time.now = at(MON, '09:05');
  for (const s of ['arrived', 'called', 'finished']) { later(time, 5); await run(core, 'ospeli_slots_step', { appointmentId: appt.appointmentId, step: s }, 'receptionist'); }
  await assert.rejects(close('Episode finished', 'receptionist', { expectedStage: 'on-hold' }), code('conflict'));
  later(time, 5);
  const done = await close('Programme finished');
  assert.deepEqual([done.status, done.state, done.events.length], ['done', 'closed', 1]);
  assert.equal((await close()).events.length, 0, 'the same close twice');
  await assert.rejects(run(core, 'ospeli_codes_stage', { code: c, stage: 'on-hold' }, 'receptionist'), code('conflict'));
  await assert.rejects(run(core, 'ospeli_slots_book', { sessionId, slotTime: '09:20', code: c, slotType: 'test-new', bookedFrom: 'recall' }, 'receptionist'), code('conflict'), 'the slot object reads the same closing');
  const g = await get(core, c);
  assert.deepEqual([g.code.state, g.code.closeReason, g.code.nextStages.length], ['closed', 'Programme finished', 0]);
  // Each step was written once, on the appointment, and the timeline reads them by code.
  assert.deepEqual(g.timeline.map((x) => `${x.source}:${x.what}`), ['code:opened', 'code:stage', 'appointment:booked', 'appointment:arrived', 'appointment:called', 'appointment:finished', 'code:closed']);
  assert.equal((await core.events({ type: 'code.stage', subject: c })).length, 1, 'arrived, called and finished are not written as stages');
});

t('the list is longest waiting first, with not-booked and attended read from the appointments', async () => {
  const { core, time } = await site();
  const a = (await open(core)).code;
  time.now = '2026-11-07T18:00:00.000Z';
  const b = (await open(core, { service: 'test-skin' })).code;
  time.now = '2026-11-08T18:30:00.000Z';
  const c = (await open(core)).code;
  const sessionId = await clinic(core);
  const appt = await run(core, 'ospeli_slots_book', { sessionId, slotTime: '09:00', code: b, slotType: 'test-new', bookedFrom: 'referral' }, 'receptionist');
  await run(core, 'ospeli_codes_close', { code: c, reason: 'Opened in error' }, 'ops-manager');
  const list = (extra = {}) => run(core, 'ospeli_codes_list', extra, 'coo');
  const all = await list();
  assert.deepEqual(all.codes.map((x) => x.code), [a, b]);
  assert.deepEqual(all.codes.map((x) => x.waitingDays), [2, 1], 'whole days since opening');
  assert.deepEqual(all.counts, { open: 2, closed: 1, notBooked: 1, overdue: 0 });
  assert.deepEqual((await list({ booked: false })).codes.map((x) => x.code), [a], 'the list to book from');
  assert.deepEqual((await list({ booked: true })).codes[0].openAppointments, [appt.appointmentId]);
  assert.deepEqual((await list({ service: 'test-skin' })).codes.map((x) => x.code), [b]);
  assert.deepEqual((await list({ state: 'closed' })).codes.map((x) => x.code), [c]);
  assert.deepEqual([(await list({ limit: 1 })).truncated, (await list({ limit: 1 })).total], [true, 2]);
  assert.equal(all.codes[1].lastAttendedAt, null);
  time.now = at(MON, '09:02');
  await run(core, 'ospeli_slots_step', { appointmentId: appt.appointmentId, step: 'arrived' }, 'receptionist');
  assert.equal((await list({ service: 'test-skin' })).codes[0].lastAttendedAt, at(MON, '09:02'));
  for (const x of all.codes) for (const k of Object.keys(x)) assert.ok(!/name$/i.test(k) || ['placeName', 'stateName'].includes(k), `no personal field in the answer (${k})`);
});

t('referral to first appointment is hand-checked, by service, and the still-waiting are counted beside it', async () => {
  const day = (n, hh = '12') => `2026-11-${String(n).padStart(2, '0')}T${hh}:00:00.000Z`;
  const ev = (type, subject, atIso, data = null) => ({ type, subject, actorRole: 'receptionist', at: atIso, data });
  const opened = (c, service, atIso) => [ev('code.opened', c, atIso, { kind: 'test-referral', service, source: 'referral' }), ev('code.stage', c, atIso, { stage: 'referral.accepted' })];
  const visit = (id, c, atIso, finished = true) => [
    ev('appointment.booked', id, atIso, { sessionId: 'ses-00001', code: c, slotType: 'test-new', slotTime: '09:00' }), ev('appointment.arrived', id, atIso), ev('appointment.called', id, atIso),
    ...(finished ? [ev('appointment.finished', id, atIso)] : [])];
  const events = [
    ev('session.planned', 'ses-00001', day(1), { sessionType: 'test-clinic', placeId: 'dept-outpatients', date: '2026-11-20', start: '09:00', minutes: 600, slotMinutes: 20, runByRole: 'ops-manager' }),
    ...opened('pc-00001', 'test-eyes', day(1)), ...opened('pc-00002', 'test-eyes', day(2)), ...opened('pc-00003', 'test-skin', day(3)), ...opened('pc-00004', 'test-skin', day(4)), ...opened('pc-00005', 'test-eyes', day(5)),
    ...visit('apt-00001', 'pc-00001', day(5)),       // 4 days
    ...visit('apt-00002', 'pc-00002', day(12)),      // 10 days
    ...visit('apt-00003', 'pc-00002', day(14)),      // a second visit does not count
    ...visit('apt-00004', 'pc-00003', day(9)),       // 6 days
    ...visit('apt-00005', 'pc-00004', day(10), false), // called, not finished: still waiting
  ];
  const d = codes.deriveCodes(events, { packs: [PACK] });
  const index = codes.appointmentsByCode(slots.deriveSlots(events, { packs: [PACK] }));
  assert.deepEqual(codes.firstAttendedAfter(d, index, 'pc-00002', 'referral.accepted'), { fromAt: day(2), attendedAt: day(12), appointmentId: 'apt-00002', days: 10 });
  assert.equal(codes.firstAttendedAfter(d, index, 'pc-00005', 'referral.accepted').days, null);
  assert.equal(codes.firstAttendedAfter(d, index, 'pc-00001', 'on-hold'), null, 'a stage never reached');
  const m = codes.stageToFirstAttended(d, index, { stage: 'referral.accepted', since: day(1), until: day(20), kind: 'test-referral' });
  assert.deepEqual(m, { n: 3, medianDays: 6, byService: { 'test-eyes': { n: 2, medianDays: 7 }, 'test-skin': { n: 1, medianDays: 6 } }, waiting: 2 });
  // A period that ends before the 10-day visit, and a small-group rule of two.
  const early = codes.stageToFirstAttended(d, index, { stage: 'referral.accepted', since: day(1), until: day(10), minGroup: 2 });
  assert.deepEqual([early.n, early.medianDays, early.byService['test-eyes'].medianDays, early.byService['test-skin'].medianDays], [2, 5, null, null]);
  assert.deepEqual(codes.attendanceOf(index, 'pc-00002'), { count: 2, open: [], lastAttendedAt: day(14), everAttended: true });
  assert.equal(codes.attendanceOf(index, 'pc-00004').open.length, 1);
});

t('a stay on the bed board is read as a timeline and never written here', async () => {
  const { core } = await site();
  const admitted = (await core.events({ type: 'patient.admitted' })).at(-1);
  const n0 = await core.eventCount();
  const g = await get(core, admitted.subject);
  assert.equal(g.code.label, codes.codeLabel(admitted.subject));
  assert.ok(g.timeline.length && g.timeline.every((x) => x.source === 'bed'));
  assert.ok(g.timeline.some((x) => x.word === 'Admitted'));
  assert.equal(await core.eventCount(), n0);
  await assert.rejects(get(core, 'enc-999999'), code('not-found'));
  await assert.rejects(get(core, 'pc-99999'), code('not-found'));
  // No write takes a stay's id: the bed board owns it.
  for (const name of ['ospeli_codes_stage', 'ospeli_codes_close']) {
    await assert.rejects(run(core, name, { code: admitted.subject, stage: 'on-hold', reason: 'Other' }, 'receptionist'), code('invalid-input'));
  }
});

t('replay ignores an event that does not fit, so a bad import cannot bend a list', () => {
  const ev = (type, subject, data = null, atIso = END) => ({ type, subject, actorRole: 'receptionist', at: atIso, data });
  const d = codes.deriveCodes([
    ev('code.stage', 'pc-00009', { stage: 'on-hold' }), // never opened
    ev('code.opened', 'record-12345', { kind: 'test-referral' }), // not a code Ospeli makes
    ev('code.opened', 'pc-00001', { kind: 'test-referral', service: 'test-eyes', source: 'referral' }),
    ev('code.opened', 'pc-00001', { kind: 'test-programme' }), // a second opening
    ev('code.stage', 'pc-00001', { stage: 'back-on-list' }), // out of order
    ev('code.stage', 'pc-00001', { stage: 'referral.accepted' }),
    ev('code.due-set', 'pc-00001', { dueBy: 'soon' }),
    ev('code.linked', 'pc-00001', { otherCode: 'pc-00001', relation: 'moves-with' }),
    ev('code.closed', 'pc-00001', { reason: 'Other' }),
    ev('code.stage', 'pc-00001', { stage: 'on-hold' }), // after closing
    ev('code.closed', 'pc-00001', { reason: 'Episode finished' }),
  ], { packs: [PACK] });
  assert.deepEqual([...d.codes.keys()], ['pc-00001']);
  const c = d.codes.get('pc-00001');
  assert.deepEqual([c.kind, c.stage, c.stages.length, c.dueBy, c.links.length, c.state, c.closeReason], ['test-referral', 'referral.accepted', 1, null, 0, 'closed', 'Other']);
});

t('agents: every write is a proposal checked like a person\'s, codes are site-wide, and no kind means no commands', async () => {
  const { core } = await site();
  const wards = (await core.listEntities('ward')).map((w) => w.id).sort();
  for (const c of Object.values(CMDS).filter((x) => x.name.startsWith('ospeli_codes_'))) {
    if (c.kind === 'write') {
      assert.equal(c.approval, true, c.name);
      assert.equal(typeof c.precheck, 'function', `${c.name}: checked before a proposal is queued`);
      assert.deepEqual((await c.wardOf(core, {})).sort(), wards, `${c.name}: site-wide`);
    }
    for (const [k, v] of Object.entries(c.input.properties)) assert.ok(v.description || v.enum, `${c.name}.${k} is described`);
    assert.equal(c.input.additionalProperties, false, c.name);
    assert.ok(c.example, `${c.name} has an example`);
    assert.deepEqual(validate(c.input, c.example.input), [], `${c.name}: the example fits the schema`);
  }
  for (const name of ['ospeli_codes_list', 'ospeli_codes_get']) assert.deepEqual((await CMDS[name].wardOf(core, {})).sort(), wards, `${name}: site-wide`);
  const n0 = await core.eventCount();
  await assert.rejects(CMDS.ospeli_codes_open.precheck(core, { kind: 'test-referral', service: 'test-wound', source: 'referral' }, { actor: agent('receptionist') }), code('invalid-input'));
  await assert.rejects(CMDS.ospeli_codes_open.precheck(core, { kind: 'test-referral', service: 'test-eyes', source: 'referral' }, { actor: agent('ward-nurse') }), code('forbidden'));
  await CMDS.ospeli_codes_open.precheck(core, { kind: 'test-referral', service: 'test-eyes', source: 'referral' }, { actor: agent('receptionist') });
  assert.equal(await core.eventCount(), n0, 'a check writes nothing');
  // Through the real command layer: the commands are offered only when a module declares a kind.
  const declared = MODULE_PACKS.flatMap((p) => p.CODE_KINDS || []);
  const offered = listCommands().filter((c) => c.name.startsWith('ospeli_codes_')).map((c) => c.name);
  assert.deepEqual(offered, codeCommands(MODULE_PACKS).map((c) => c.name));
  assert.equal(offered.length > 0, declared.length > 0);
  assert.equal(codeCommands([]).length, 0);
  if (!declared.length) await assert.rejects(runCommand(core, 'ospeli_codes_list', {}, human('coo')), code('unknown-command'));
});

t('a module\'s seed may write code and appointment events only when it declares a kind or a type of session', () => {
  // The rule lives in the generator; this checks it with the modules as merged (none may slip one in).
  const { events } = generateHospital({ end: END });
  const kinds = MODULE_PACKS.some((p) => (p.CODE_KINDS || []).length);
  const sessions = MODULE_PACKS.some((p) => (p.SESSION_TYPES || []).length);
  if (!kinds) assert.equal(events.filter((e) => e.type.startsWith('code.')).length, 0);
  if (!sessions) assert.equal(events.filter((e) => /^(slot|session|appointment)\./.test(e.type)).length, 0);
  const d = codes.deriveCodes(events, { packs: MODULE_PACKS });
  const written = events.filter((e) => e.type === 'code.opened').length;
  assert.equal(d.codes.size, written, 'every seeded opening is a code Ospeli could have made');
});
