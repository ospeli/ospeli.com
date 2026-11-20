// The shared appointment or slot object (core/slots.js, core/slot-commands.js): capacity offered
// at a place and time (a session), and the bookings made against it (appointments). One record
// for clinic sessions with timed slots and for capacity sessions such as a home-visit round.
// Shared-objects proposal section 5; A1 and E2 briefs. Synthetic data only.
//
// Started as tests written before the object (swarm, 17 Nov 2026); the object was built on
// 18 Nov (module crew, night 4) and the tests follow the spec's rulings: one answer for a repeated
// booking, site wall-clock times at the example site's UTC-4, sessions site-wide for agents.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Core } from '../../web/app/core/core.js';
import { MemoryAdapter } from '../../web/app/core/db.js';
import { loadSyntheticHospital } from '../../web/app/core/generator.js';
import { runCommand, commandByName, CommandError } from '../../web/app/core/commands.js';
import { validate } from '../../web/app/core/schema.js';
import { ROLES, validateEvent } from '../../web/app/core/model.js';
import { MODULE_PACKS } from '../../web/app/core/modules.js';
import { findIdentifierFields } from '../../web/app/core/core.js';

import * as slots from '../../web/app/core/slots.js';
import * as slotMod from '../../web/app/core/slot-commands.js';
const t = test;

const END = '2026-11-06T18:00:00.000Z'; // a Friday; the sessions below are the next week
const MON = '2026-11-09';
const WED = '2026-11-11';
const NEXT_MON = '2026-11-16';
const human = (role) => ({ type: 'human', role });
const agent = (role, name = 'slot-bot') => ({ type: 'agent', role, agent: name });
const code = (c) => (err) => err instanceof CommandError && err.code === c;
const ROLE_IDS = ROLES.map((r) => r.id);

// A module's session and slot types, written the way a module pack would. Roles that exist in
// every build, so the test does not depend on which modules are merged.
const PACK = {
  id: 'testslots',
  SESSION_TYPES: [
    { id: 'test-clinic', word: 'Clinic', timed: true, placeTypes: ['department'],
      runByRoles: ['ops-manager'], planRoles: ['ops-manager'], bookRoles: ['receptionist', 'ops-manager'], stepRoles: ['receptionist'] },
    { id: 'test-round', word: 'Home-visit round', timed: false, placeTypes: ['site', 'department'], areas: ['North 1', 'North 2'],
      runByRoles: ['ward-nurse'], planRoles: ['ops-manager'], bookRoles: ['ops-manager'], stepRoles: ['ward-nurse'] },
  ],
  SLOT_TYPES: { 'test-new': 'New', 'test-follow-up': 'Follow-up', 'test-home-visit': 'Home visit' },
  NO_SHOW_GRACE_MINUTES: 15, // example setting, not a standard
};
const CMDS = Object.fromEntries(slotMod.slotCommands([PACK]).map((c) => [c.name, c]));

// Run a command the way the command layer does for a person: schema first, then the role list, then the command.
async function run(core, name, input, role) {
  const c = CMDS[name];
  assert.ok(c, `command ${name} exists`);
  const errs = validate(c.input, input);
  if (errs.length) throw new CommandError('invalid-input', errs.join('; '));
  if (!c.roles.includes(role)) throw new CommandError('forbidden', `${role} cannot run ${name}`);
  return c.run(core, input, { actor: human(role), wards: null });
}

// A site with a clock the test moves by hand, and a few synthetic patient codes already open.
async function site(adapter = new MemoryAdapter(), clock = null) {
  const time = { now: END };
  const core = await Core.open({ adapter, clock: clock || (() => new Date(time.now)) });
  await loadSyntheticHospital(core, { end: END });
  const codes = ['pc-00001', 'pc-00002', 'pc-00003', 'pc-00004', 'pc-00005', 'pc-00006'];
  await core.appendEvents(codes.map((c) => ({ type: 'code.opened', subject: c, actorRole: 'ops-manager', at: END, data: { service: 'test-service', placeId: 'dept-outpatients', source: 'referral' } })), 'system', 'synthetic test codes');
  return { core, time };
}
// Times are the site's own wall clock. The example site is four hours behind UTC (generator.js), so
// 09:00 on the site is 13:00Z: a build that read wall-clock times as UTC fails the grace test.
const OFFSET = -240;
const at = (date, hhmm) => new Date(Date.parse(`${date}T${hhmm}:00.000Z`) - OFFSET * 60e3).toISOString();
const derive = async (core) => slots.deriveSlots(await core.events(), { packs: [PACK], offsetMinutes: OFFSET });

// A Monday clinic template: 09:00 for 80 minutes in 20-minute slots, so four slots.
const TEMPLATE = { sessionType: 'test-clinic', placeId: 'dept-outpatients', weekday: 1, start: '09:00', minutes: 80, slotMinutes: 20, slotTypes: ['test-new', 'test-follow-up'], released: true, from: MON };
async function clinic(core, date = MON) {
  const tpl = await run(core, 'ospeli_slots_template_set', TEMPLATE, 'ops-manager');
  const ses = await run(core, 'ospeli_slots_session_plan', { sessionType: 'test-clinic', placeId: 'dept-outpatients', date, start: '09:00', minutes: 80, runByRole: 'ops-manager', templateId: tpl.templateId }, 'ops-manager');
  return { templateId: tpl.templateId, sessionId: ses.sessionId };
}
async function round(core, capacity = 3) {
  const ses = await run(core, 'ospeli_slots_session_plan', { sessionType: 'test-round', placeId: 'site-north', date: MON, start: '08:30', minutes: 240, capacity, runByRole: 'ward-nurse' }, 'ops-manager');
  return ses.sessionId;
}
const book = (core, input, role = 'receptionist') => run(core, 'ospeli_slots_book', { slotType: 'test-new', bookedFrom: 'referral', ...input }, role);
const step = (core, appointmentId, s, role = 'receptionist', extra = {}) => run(core, 'ospeli_slots_step', { appointmentId, step: s, ...extra }, role);
const sessionOf = async (core, sessionId, role = 'coo') => (await run(core, 'ospeli_slots_sessions', { from: MON, to: NEXT_MON }, role)).sessions.find((s) => s.id === sessionId);

t('a pack\'s session and slot types are checked when they are added', () => {
  const type = (over) => ({ id: 'x-type', word: 'X', timed: true, placeTypes: ['department'], runByRoles: ['ops-manager'], planRoles: ['ops-manager'], bookRoles: ['ops-manager'], stepRoles: ['ops-manager'], ...over });
  const bad = (st, why) => assert.throws(() => slots.slotCatalogue([{ id: 'm', SESSION_TYPES: [st] }], ROLE_IDS), why);
  bad(type({ id: 'Bad Id' }), /id must be/);
  bad(type({ bookRoles: ['made-up-role'] }), /unknown role/);
  bad(type({ placeTypes: ['street'] }), /place type/);
  bad(type({ timed: 'yes' }), /timed/);
  bad(type({ areas: ['North 1', ''] }), /areas/);
  assert.throws(() => slots.slotCatalogue([PACK, { id: 'other', SESSION_TYPES: [PACK.SESSION_TYPES[0]] }], ROLE_IDS), /already used/);
  const { sessionTypes, slotTypes } = slots.slotCatalogue([PACK], ROLE_IDS);
  assert.deepEqual([...sessionTypes.keys()], ['test-clinic', 'test-round']);
  assert.equal(slotTypes['test-home-visit'], 'Home visit');
});

t('slots made from a template match hand-checked times, including a template change mid-week', async () => {
  const { core } = await site();
  const { templateId, sessionId } = await clinic(core);
  const times = async (id) => (await sessionOf(core, id)).slots.map((s) => s.time);
  assert.deepEqual(await times(sessionId), ['09:00', '09:20', '09:40', '10:00']);
  // On Wednesday the template changes: from the next Monday the clinic runs 10:00 for 90 minutes in 30-minute slots.
  await run(core, 'ospeli_slots_template_set', { ...TEMPLATE, templateId, start: '10:00', minutes: 90, slotMinutes: 30, from: WED }, 'ops-manager');
  assert.deepEqual(await times(sessionId), ['09:00', '09:20', '09:40', '10:00'], 'a session already planned before the change keeps its slots');
  const next = await run(core, 'ospeli_slots_session_plan', { sessionType: 'test-clinic', placeId: 'dept-outpatients', date: NEXT_MON, start: '10:00', minutes: 90, runByRole: 'ops-manager', templateId }, 'ops-manager');
  assert.deepEqual(await times(next.sessionId), ['10:00', '10:30', '11:00']);
  const read = await run(core, 'ospeli_slots_sessions', { from: MON, to: NEXT_MON }, 'coo');
  assert.deepEqual(validate(CMDS.ospeli_slots_sessions.output, read), []);
  const s = read.sessions.find((x) => x.id === sessionId);
  assert.deepEqual([s.sessionType, s.placeId, s.date, s.state, s.free], ['test-clinic', 'dept-outpatients', MON, 'planned', 4]);
});

t('booking: a taken slot and a full session are refused; the appointment carries its session type', async () => {
  const { core } = await site();
  const { sessionId } = await clinic(core);
  const a = await book(core, { sessionId, slotTime: '09:00', code: 'pc-00001' });
  assert.match(a.appointmentId, /^apt-[0-9]{5,}$/);
  assert.deepEqual([a.status, a.state], ['done', 'booked']);
  const before = await core.eventCount();
  await assert.rejects(book(core, { sessionId, slotTime: '09:00', code: 'pc-00002' }), code('conflict'), 'slot taken');
  await assert.rejects(book(core, { sessionId, slotTime: '09:10', code: 'pc-00002' }), code('invalid-input'), 'not a slot in this session');
  assert.equal(await core.eventCount(), before);
  const ev = (await core.events({ type: 'appointment.booked' })).at(-1);
  assert.equal(ev.data.sessionType, 'test-clinic', 'every appointment carries its session type (E2 overlap 2)');

  const r = await round(core, 2);
  await book(core, { sessionId: r, visitOrder: 1, area: 'North 2', code: 'pc-00003', slotType: 'test-home-visit' }, 'ops-manager');
  await book(core, { sessionId: r, visitOrder: 2, area: 'North 2', code: 'pc-00004', slotType: 'test-home-visit' }, 'ops-manager');
  await assert.rejects(book(core, { sessionId: r, visitOrder: 3, area: 'North 1', code: 'pc-00005', slotType: 'test-home-visit' }, 'ops-manager'), code('conflict'), 'the round is full');
  assert.equal((await sessionOf(core, r)).free, 0);
});

t('home-visit round: visit order is unique within a session; no address, no slot time', async () => {
  const { core } = await site();
  const r = await round(core, 5);
  const hv = (over) => book(core, { sessionId: r, area: 'North 1', slotType: 'test-home-visit', ...over }, 'ops-manager');
  await hv({ visitOrder: 1, code: 'pc-00001' });
  await assert.rejects(hv({ visitOrder: 1, code: 'pc-00002' }), code('conflict'), 'visit order 1 is taken');
  await assert.rejects(hv({ visitOrder: 0, code: 'pc-00002' }), code('invalid-input'));
  await assert.rejects(hv({ visitOrder: 1.5, code: 'pc-00002' }), code('invalid-input'), 'a whole number');
  await assert.rejects(hv({ visitOrder: 2, slotTime: '09:00', code: 'pc-00002' }), code('invalid-input'), 'a capacity session has no slot times');
  await assert.rejects(hv({ visitOrder: 2, area: '12 Example Street', code: 'pc-00002' }), code('invalid-input'), 'an address-like area is refused');
  await assert.rejects(hv({ visitOrder: 2, area: 'Somewhere new', code: 'pc-00002' }), code('invalid-input'), 'an area is a pick, not typed');
  const { sessionId } = await clinic(core);
  await assert.rejects(book(core, { sessionId, visitOrder: 1, code: 'pc-00002' }), code('invalid-input'), 'a timed session takes a slot time, not a visit order');
  // Moving a visit to a free order works; onto a taken one is refused.
  const b = await hv({ visitOrder: 2, code: 'pc-00002' });
  await assert.rejects(run(core, 'ospeli_slots_move', { appointmentId: b.appointmentId, sessionId: r, visitOrder: 1 }, 'ops-manager'), code('conflict'));
  const moved = await run(core, 'ospeli_slots_move', { appointmentId: b.appointmentId, sessionId: r, visitOrder: 3 }, 'ops-manager');
  assert.equal(moved.status, 'done');
});

t('arrived, called and finished go in order; no-show is refused before booked time plus grace', async () => {
  const { core, time } = await site();
  const { sessionId } = await clinic(core);
  const a = await book(core, { sessionId, slotTime: '09:20', code: 'pc-00001' });
  const b = await book(core, { sessionId, slotTime: '09:40', code: 'pc-00002' });
  time.now = at(MON, '09:10');
  await assert.rejects(step(core, a.appointmentId, 'called'), code('conflict'), 'called before arrived');
  await assert.rejects(step(core, a.appointmentId, 'finished'), code('conflict'), 'finished before called');
  await assert.rejects(step(core, a.appointmentId, 'no-show', 'receptionist', { reason: slots.NO_SHOW_REASONS[0] }), code('conflict'), 'before the booked time');
  time.now = at(MON, '09:34'); // booked 09:20 + 15 minutes grace = 09:35
  await assert.rejects(step(core, a.appointmentId, 'no-show', 'receptionist', { reason: slots.NO_SHOW_REASONS[0] }), code('conflict'), 'inside the grace');
  time.now = at(MON, '09:36');
  const dna = await step(core, a.appointmentId, 'no-show', 'receptionist', { reason: slots.NO_SHOW_REASONS[0] });
  assert.equal(dna.state, 'no-show');
  await assert.rejects(step(core, a.appointmentId, 'arrived'), code('conflict'), 'closed: no-show');
  await assert.rejects(step(core, a.appointmentId, 'no-show', 'receptionist'), code('invalid-input'), 'a reason is required');

  await step(core, b.appointmentId, 'arrived');
  time.now = at(MON, '09:50');
  await assert.rejects(step(core, b.appointmentId, 'no-show', 'receptionist', { reason: slots.NO_SHOW_REASONS[0] }), code('conflict'), 'arrived, so not a no-show');
  await assert.rejects(step(core, b.appointmentId, 'called', 'receptionist', { expectedState: 'booked' }), code('conflict'), 'changed since the caller looked');
  assert.equal((await step(core, b.appointmentId, 'called', 'receptionist', { expectedState: 'arrived' })).state, 'called');
  time.now = at(MON, '10:05');
  assert.equal((await step(core, b.appointmentId, 'finished')).state, 'finished');
  await assert.rejects(run(core, 'ospeli_slots_cancel', { appointmentId: b.appointmentId, by: 'site', reason: slots.APPOINTMENT_CANCEL_REASONS[0] }, 'receptionist'), code('conflict'), 'a finished appointment cannot be cancelled');
});

t('offline repeat-safety: a repeated Arrived or booking answers done and writes nothing', async () => {
  const { core, time } = await site();
  const { sessionId } = await clinic(core);
  const a = await book(core, { sessionId, slotTime: '09:00', code: 'pc-00001' });
  // The outbox retries a booking whose answer was lost: one appointment, the same id.
  const n0 = await core.eventCount();
  const again = await book(core, { sessionId, slotTime: '09:00', code: 'pc-00001' });
  assert.deepEqual([again.appointmentId, again.status, again.events], [a.appointmentId, 'done', []], 'the answer is the first booking');
  // The same code somewhere else in the same session is a second booking: refused, naming the first.
  await assert.rejects(book(core, { sessionId, slotTime: '09:40', code: 'pc-00001' }), (err) => code('conflict')(err) && err.detail.existing === a.appointmentId);
  assert.equal(await core.eventCount(), n0, 'written once');
  // A second Arrived (double tap, or a reconnect that resends) answers done and writes nothing (E2 outbox point a).
  time.now = at(MON, '08:55');
  const first = await step(core, a.appointmentId, 'arrived', 'receptionist', { expectedState: 'booked' });
  const n1 = await core.eventCount();
  const second = await step(core, a.appointmentId, 'arrived', 'receptionist', { expectedState: 'booked' });
  assert.deepEqual([first.status, second.status, second.state], ['done', 'done', 'arrived']);
  assert.deepEqual(second.events, []);
  assert.equal(await core.eventCount(), n1);
  assert.equal((await core.events({ type: 'appointment.arrived', subject: a.appointmentId })).length, 1);
  // The same for a cancel resent after it went through.
  const b = await book(core, { sessionId, slotTime: '09:20', code: 'pc-00002' });
  const cancel = { appointmentId: b.appointmentId, by: 'patient', reason: slots.APPOINTMENT_CANCEL_REASONS[0] };
  await run(core, 'ospeli_slots_cancel', cancel, 'receptionist');
  const n2 = await core.eventCount();
  assert.equal((await run(core, 'ospeli_slots_cancel', cancel, 'receptionist')).status, 'done');
  assert.equal(await core.eventCount(), n2);
});

t('two tabs booking the last slot write once', async () => {
  const shared = new MemoryAdapter();
  const time = { now: END };
  const clock = () => new Date(time.now);
  const { core: a } = await site(shared, clock);
  const b = await Core.open({ adapter: shared, clock });
  const r = await round(a, 1);
  const n0 = await a.eventCount();
  const tries = await Promise.allSettled([
    book(a, { sessionId: r, visitOrder: 1, area: 'North 1', slotType: 'test-home-visit', code: 'pc-00001' }, 'ops-manager'),
    book(b, { sessionId: r, visitOrder: 2, area: 'North 1', slotType: 'test-home-visit', code: 'pc-00002' }, 'ops-manager'),
  ]);
  assert.equal(tries.filter((x) => x.status === 'fulfilled').length, 1, 'one booking wins');
  assert.ok(code('conflict')(tries.find((x) => x.status === 'rejected').reason), 'the other is told the session is full');
  assert.equal((await a.events({ type: 'appointment.booked' })).length, 1);
  assert.equal(await a.eventCount(), n0 + 1);
});

t('a session with open bookings cannot be cancelled until a person moves or cancels each one', async () => {
  const { core } = await site();
  const { sessionId } = await clinic(core);
  const a = await book(core, { sessionId, slotTime: '09:00', code: 'pc-00001' });
  const b = await book(core, { sessionId, slotTime: '09:20', code: 'pc-00002' });
  const reason = slots.SESSION_CHANGE_REASONS[0];
  const n0 = await core.eventCount();
  await assert.rejects(run(core, 'ospeli_slots_session_change', { sessionId, change: 'cancelled', reason }, 'ops-manager'),
    (err) => code('conflict')(err) && [...err.detail.open].sort().join() === [a.appointmentId, b.appointmentId].sort().join(), 'names the bookings still open, so nobody vanishes from a list');
  assert.equal(await core.eventCount(), n0, 'nothing was cancelled behind anyone\'s back');
  await assert.rejects(run(core, 'ospeli_slots_session_change', { sessionId, change: 'cancelled' }, 'ops-manager'), code('invalid-input'), 'a cancel needs a reason');
  await assert.rejects(run(core, 'ospeli_slots_session_change', { sessionId, change: 'cancelled', reason: 'the doctor is off sick again' }, 'ops-manager'), code('invalid-input'), 'the reason is a pick');

  // A person moves one to next week and cancels the other by site; then the session can go.
  const { sessionId: later } = await clinic(core, NEXT_MON);
  await run(core, 'ospeli_slots_move', { appointmentId: a.appointmentId, sessionId: later, slotTime: '09:00' }, 'receptionist');
  await run(core, 'ospeli_slots_cancel', { appointmentId: b.appointmentId, by: 'site', reason: slots.APPOINTMENT_CANCEL_REASONS[0] }, 'receptionist');
  const out = await run(core, 'ospeli_slots_session_change', { sessionId, change: 'cancelled', reason }, 'ops-manager');
  assert.deepEqual([out.status, out.state], ['done', 'cancelled']);
  const s = await sessionOf(core, sessionId);
  assert.deepEqual([s.state, s.reason], ['cancelled', reason]);
  await assert.rejects(book(core, { sessionId, slotTime: '09:40', code: 'pc-00003' }), code('conflict'), 'a cancelled session takes no bookings');
  await assert.rejects(run(core, 'ospeli_slots_move', { appointmentId: a.appointmentId, sessionId, slotTime: '09:40' }, 'receptionist'), code('conflict'), 'nor moves into it');
  await assert.rejects(run(core, 'ospeli_slots_session_change', { sessionId, change: 'held' }, 'ops-manager'), code('conflict'), 'a cancelled session is not held');
});

t('reducing a session: never below what is booked; afterwards the removed places are not bookable', async () => {
  const { core } = await site();
  const r = await round(core, 4);
  await book(core, { sessionId: r, visitOrder: 1, area: 'North 1', slotType: 'test-home-visit', code: 'pc-00001' }, 'ops-manager');
  await book(core, { sessionId: r, visitOrder: 2, area: 'North 1', slotType: 'test-home-visit', code: 'pc-00002' }, 'ops-manager');
  const reason = slots.SESSION_CHANGE_REASONS[0];
  await assert.rejects(run(core, 'ospeli_slots_session_change', { sessionId: r, change: 'reduced', capacity: 1, reason }, 'ops-manager'), code('conflict'));
  await assert.rejects(run(core, 'ospeli_slots_session_change', { sessionId: r, change: 'reduced', capacity: 5, reason }, 'ops-manager'), code('invalid-input'), 'a reduction makes it smaller');
  await run(core, 'ospeli_slots_session_change', { sessionId: r, change: 'reduced', capacity: 2, reason }, 'ops-manager');
  const s = await sessionOf(core, r);
  assert.deepEqual([s.state, s.capacity, s.free], ['reduced', 2, 0]);
  await assert.rejects(book(core, { sessionId: r, visitOrder: 3, area: 'North 1', slotType: 'test-home-visit', code: 'pc-00003' }, 'ops-manager'), code('conflict'));
});

t('rebookOf must name a cancelled or missed appointment; the rebook is counted', async () => {
  const { core, time } = await site();
  const { sessionId } = await clinic(core);
  const { sessionId: later } = await clinic(core, NEXT_MON);
  const a = await book(core, { sessionId, slotTime: '09:00', code: 'pc-00001' });
  await assert.rejects(book(core, { sessionId: later, slotTime: '09:00', code: 'pc-00001', bookedFrom: 'recall', rebookOf: a.appointmentId }), code('conflict'), 'still booked: move it instead');
  await assert.rejects(book(core, { sessionId: later, slotTime: '09:00', code: 'pc-00001', bookedFrom: 'recall', rebookOf: 'apt-99999' }), code('not-found'));
  time.now = at(MON, '09:30');
  await step(core, a.appointmentId, 'no-show', 'receptionist', { reason: slots.NO_SHOW_REASONS[0] });
  await assert.rejects(book(core, { sessionId: later, slotTime: '09:00', code: 'pc-00002', bookedFrom: 'recall', rebookOf: a.appointmentId }), code('invalid-input'), 'a rebook keeps the same code');
  const r = await book(core, { sessionId: later, slotTime: '09:00', code: 'pc-00001', bookedFrom: 'recall', rebookOf: a.appointmentId });
  assert.equal(r.status, 'done');
  await assert.rejects(book(core, { sessionId: later, slotTime: '09:20', code: 'pc-00001', bookedFrom: 'recall', rebookOf: a.appointmentId }), code('conflict'), 'one rebook per missed appointment');
  assert.equal(slots.rebookCount(await derive(core), { since: at(MON, '00:00'), until: at(NEXT_MON, '23:59') }), 1);
});

t('utilisation, no-show rate and wait in clinic with hand-checked numbers, filtered by session type', async () => {
  const { core, time } = await site();
  const { sessionId } = await clinic(core); // four slots: 09:00, 09:20, 09:40, 10:00
  const r = await round(core, 2);
  const a = await book(core, { sessionId, slotTime: '09:00', code: 'pc-00001' });
  const b = await book(core, { sessionId, slotTime: '09:20', code: 'pc-00002' });
  const c = await book(core, { sessionId, slotTime: '09:40', code: 'pc-00003' });
  const d = await book(core, { sessionId: r, visitOrder: 1, area: 'North 1', slotType: 'test-home-visit', code: 'pc-00004' }, 'ops-manager');
  const go = async (hhmm, id, s, role = 'receptionist', extra) => { time.now = at(MON, hhmm); return step(core, id, s, role, extra); };
  await go('08:55', a.appointmentId, 'arrived');
  await run(core, 'ospeli_slots_session_change', { sessionId, change: 'held' }, 'ops-manager');
  await go('09:10', a.appointmentId, 'called');
  await go('09:15', b.appointmentId, 'arrived');
  await go('09:25', a.appointmentId, 'finished');
  await go('09:35', b.appointmentId, 'called');
  await go('09:50', b.appointmentId, 'finished');
  await go('09:56', c.appointmentId, 'no-show', 'receptionist', { reason: slots.NO_SHOW_REASONS[0] });
  await go('11:00', d.appointmentId, 'no-show', 'ward-nurse', { reason: slots.NO_SHOW_REASONS[0] });

  const derived = await derive(core);
  const period = { since: at(MON, '00:00'), until: at(MON, '23:59') };
  // Clinic: 3 booked of 4 slots (a no-show still used the slot); 1 no-show of 3 booked.
  assert.equal(slots.utilisation(derived, { ...period, sessionType: 'test-clinic' }).value, 3 / 4);
  assert.equal(slots.noShowRate(derived, { ...period, sessionType: 'test-clinic' }).value, 1 / 3);
  // All session types: 2 no-show of 4 booked. The clinic rate never includes "no answer at the door".
  const all = slots.noShowRate(derived, period);
  assert.deepEqual([all.numerator, all.denominator], [2, 4]);
  // Arrived to called: 15 and 20 minutes, median 17.5.
  assert.equal(slots.waitInClinic(derived, { ...period, sessionType: 'test-clinic' }).medianMinutes, 17.5);
  // First patient called 09:10 against a 09:00 start.
  assert.equal(slots.firstCalledVsStart(derived, { sessionId }).minutes, 10);
  const fill = slots.sessionFill(derived, sessionId);
  assert.deepEqual([fill.capacity, fill.booked, fill.free], [4, 3, 1]);
  assert.throws(() => slots.noShowRate(derived, {}), /until is required/);
});

t('the trail says which role did each step, and never a person', async () => {
  const { core, time } = await site();
  const { sessionId } = await clinic(core);
  const a = await book(core, { sessionId, slotTime: '09:00', code: 'pc-00001' });
  time.now = at(MON, '08:58');
  await step(core, a.appointmentId, 'arrived');
  const trail = (await core.auditLog()).filter((x) => x.target === a.appointmentId);
  assert.deepEqual(trail.map((x) => [x.action, x.actorRole, x.actorType]), [['appointment.booked', 'receptionist', 'human'], ['appointment.arrived', 'receptionist', 'human']]);
  assert.ok(trail.every((x) => !JSON.stringify(x.detail ?? {}).match(/name|address|phone|dob/i)));
  const tpl = (await core.auditLog()).filter((x) => x.action === 'slot.template-set');
  assert.deepEqual(tpl.map((x) => x.actorRole), ['ops-manager']);
  const ses = (await core.auditLog()).filter((x) => x.action === 'session.planned' && x.target === sessionId);
  assert.equal(ses.length, 1);
});

t('attack: a role outside a session type\'s lists cannot plan, book, step or change it', async () => {
  const { core, time } = await site();
  const { sessionId } = await clinic(core);
  const n0 = await core.eventCount();
  await assert.rejects(run(core, 'ospeli_slots_template_set', TEMPLATE, 'receptionist'), code('forbidden'));
  await assert.rejects(run(core, 'ospeli_slots_session_plan', { sessionType: 'test-clinic', placeId: 'dept-outpatients', date: NEXT_MON, start: '09:00', minutes: 80, runByRole: 'ops-manager' }, 'receptionist'), code('forbidden'));
  await assert.rejects(book(core, { sessionId, slotTime: '09:00', code: 'pc-00001' }, 'estates-tech'), code('forbidden'));
  await assert.rejects(book(core, { sessionId, slotTime: '09:00', code: 'pc-00001' }, 'ward-nurse'), code('forbidden'), 'ward-nurse may book nothing; it steps rounds only');
  const a = await book(core, { sessionId, slotTime: '09:00', code: 'pc-00001' });
  time.now = at(MON, '08:58');
  await assert.rejects(step(core, a.appointmentId, 'arrived', 'ward-nurse'), code('forbidden'), 'a round role cannot mark a clinic patient arrived');
  await assert.rejects(run(core, 'ospeli_slots_session_change', { sessionId, change: 'held' }, 'receptionist'), code('forbidden'));
  await assert.rejects(run(core, 'ospeli_slots_session_plan', { sessionType: 'test-clinic', placeId: 'dept-outpatients', date: NEXT_MON, start: '09:00', minutes: 80, runByRole: 'estates-tech' }, 'ops-manager'), code('invalid-input'), 'run by a role the type does not allow');
  assert.equal(await core.eventCount(), n0 + 1, 'only the one allowed booking was written');
});

t('attack: no typed text, made-up ids, record numbers, unknown types or the wrong kind of place', async () => {
  const { core } = await site();
  const { sessionId } = await clinic(core);
  const n0 = await core.eventCount();
  const plan = { sessionType: 'test-clinic', placeId: 'dept-outpatients', date: NEXT_MON, start: '09:00', minutes: 80, runByRole: 'ops-manager' };
  const p = (over) => run(core, 'ospeli_slots_session_plan', { ...plan, ...over }, 'ops-manager');
  await assert.rejects(p({ sessionType: 'test-theatre' }), code('invalid-input'), 'unknown session type');
  await assert.rejects(p({ placeId: 'dept-zz' }), (err) => code('not-found')(err) && !err.message.includes('dept-zz'), 'a made-up place is not echoed back');
  await assert.rejects(p({ placeId: 'ward-a1-bed-01' }), code('invalid-input'), 'a clinic is not held in a bed');
  await assert.rejects(p({ placeId: 'asset-xray-1' }), code('invalid-input'), 'this type does not take an asset');
  await assert.rejects(p({ assetId: 'asset-zz-1', placeId: undefined }), (err) => code('not-found')(err) || code('invalid-input')(err), 'unknown asset');
  await assert.rejects(p({ date: '2026-02-30' }), code('invalid-input'));
  await assert.rejects(p({ start: '25:00' }), code('invalid-input'));
  await assert.rejects(p({ note: 'Dr Example\'s list' }), code('invalid-input'), 'no field takes free text');

  const b = (over) => book(core, { sessionId, slotTime: '09:00', code: 'pc-00001', ...over });
  await assert.rejects(b({ code: 'MRN 1234567' }), code('invalid-input'), 'a record number is not a code');
  await assert.rejects(b({ code: 'Jane Example' }), code('invalid-input'), 'a name is not a code');
  await assert.rejects(b({ code: 'pc-99999' }), code('not-found'), 'Ospeli makes codes; an unopened one is refused');
  await assert.rejects(b({ bookedFrom: 'friend of the consultant' }), code('invalid-input'));
  await assert.rejects(b({ slotType: 'test-vip' }), code('invalid-input'));
  await assert.rejects(b({ slotType: 'test-home-visit' }), code('invalid-input'), 'not a slot type this template offers');
  await assert.rejects(b({ sessionId: 'ses-1; drop' }), code('invalid-input'));
  await assert.rejects(b({ sessionId: 'ses-99999' }), code('not-found'));
  await assert.rejects(b({ dateOfBirth: '1980-01-01' }), code('invalid-input'));
  await assert.rejects(run(core, 'ospeli_slots_cancel', { appointmentId: 'apt-99999', by: 'site', reason: slots.APPOINTMENT_CANCEL_REASONS[0] }, 'receptionist'), code('not-found'));
  await assert.rejects(run(core, 'ospeli_slots_cancel', { appointmentId: 'apt-00001', by: 'the family', reason: slots.APPOINTMENT_CANCEL_REASONS[0] }, 'receptionist'), code('invalid-input'), 'by is site or patient');
  await assert.rejects(run(core, 'ospeli_slots_step', { appointmentId: 'apt-00001', step: 'discharged' }, 'receptionist'), code('invalid-input'), 'no clinical step');
  await assert.rejects(run(core, 'ospeli_slots_template_set', { ...TEMPLATE, slotMinutes: 0 }, 'ops-manager'), code('invalid-input'));
  await assert.rejects(run(core, 'ospeli_slots_template_set', { ...TEMPLATE, weekday: 8 }, 'ops-manager'), code('invalid-input'));
  assert.equal(await core.eventCount(), n0, 'nothing was written');
});

t('template set is for people only; every write asks for approval when an agent calls it', () => {
  assert.equal(CMDS.ospeli_slots_template_set.agents, false);
  assert.equal(CMDS.ospeli_slots_sessions.kind, 'read');
  for (const name of ['ospeli_slots_session_plan', 'ospeli_slots_session_change', 'ospeli_slots_book', 'ospeli_slots_move', 'ospeli_slots_cancel', 'ospeli_slots_step']) {
    assert.deepEqual([CMDS[name].kind, CMDS[name].approval], ['write', true], name);
  }
});


// ---- added when the object was built (18 Nov) ----
t('wall-clock times become moments with the site\'s offset; weekdays and slot grids are hand-checked', () => {
  assert.equal(new Date(slots.localInstant(MON, '09:00', 0)).toISOString(), '2026-11-09T09:00:00.000Z');
  assert.equal(new Date(slots.localInstant(MON, '09:00', -240)).toISOString(), '2026-11-09T13:00:00.000Z');
  assert.equal(new Date(slots.localInstant(MON, '22:30', 330)).toISOString(), '2026-11-09T17:00:00.000Z');
  assert.equal(slots.localDate('2026-11-10T02:00:00.000Z', -240), MON, 'two in the morning UTC is still Monday evening on the site');
  assert.deepEqual([slots.weekdayOf(MON), slots.weekdayOf(WED), slots.weekdayOf('2026-11-15')], [1, 3, 7]);
  assert.deepEqual(slots.slotGrid('09:00', 80, 20), ['09:00', '09:20', '09:40', '10:00']);
  assert.deepEqual(slots.slotGrid('09:00', 70, 20), ['09:00', '09:20', '09:40'], 'a part slot at the end is not a slot');
  assert.deepEqual(slots.slotGrid('23:30', 90, 30), ['23:30'], 'slots do not run past midnight');
  assert.deepEqual([slots.validDate('2026-02-28'), slots.validDate('2026-02-30'), slots.validDate('26-2-3')], [true, false, false]);
});

t('a reminder reply is recorded and never changes the appointment', async () => {
  const { core, time } = await site();
  const { sessionId } = await clinic(core);
  const a = await book(core, { sessionId, slotTime: '09:00', code: 'pc-00001' });
  const rec = (reply, role = 'receptionist') => run(core, 'ospeli_slots_reminder_record', { appointmentId: a.appointmentId, reply }, role);
  const one = await rec('cancelled');
  assert.deepEqual([one.status, one.state], ['done', 'booked'], 'a "cancelled" reply does not cancel: a person does that');
  const n = await core.eventCount();
  assert.deepEqual((await rec('cancelled')).events, [], 'a double tap writes nothing');
  assert.equal(await core.eventCount(), n);
  time.now = at(MON, '08:00');
  await rec('confirmed');
  const list = await run(core, 'ospeli_slots_appointments', { sessionId }, 'receptionist');
  assert.deepEqual(validate(CMDS.ospeli_slots_appointments.output, list), []);
  assert.deepEqual([list.appointments[0].state, list.appointments[0].reminderReply], ['booked', 'confirmed']);
  await assert.rejects(rec('sent a text'), code('invalid-input'));
  await assert.rejects(rec('confirmed', 'ward-nurse'), code('forbidden'));
  await step(core, a.appointmentId, 'arrived');
  await assert.rejects(rec('no-reply'), code('conflict'), 'only a booked appointment takes a reminder');
});

t('a patient who arrived and left is cancelled by the patient with one reason; the place stays used', async () => {
  const { core, time } = await site();
  const { sessionId } = await clinic(core);
  const a = await book(core, { sessionId, slotTime: '09:00', code: 'pc-00001' });
  const b = await book(core, { sessionId, slotTime: '09:20', code: 'pc-00002' });
  const cancel = (id, by, reason, role = 'receptionist') => run(core, 'ospeli_slots_cancel', { appointmentId: id, by, reason }, role);
  await assert.rejects(cancel(a.appointmentId, 'patient', slots.LEFT_REASON), code('conflict'), 'not arrived yet');
  time.now = at(MON, '08:55');
  await step(core, a.appointmentId, 'arrived');
  await assert.rejects(cancel(a.appointmentId, 'site', slots.APPOINTMENT_CANCEL_REASONS[0]), code('conflict'), 'once arrived, the site cannot cancel');
  await assert.rejects(cancel(a.appointmentId, 'site', slots.LEFT_REASON), code('conflict'));
  time.now = at(MON, '09:40');
  assert.equal((await cancel(a.appointmentId, 'patient', slots.LEFT_REASON)).state, 'cancelled');
  await assert.rejects(book(core, { sessionId, slotTime: '09:00', code: 'pc-00003' }), code('conflict'), 'the slot was used: it is not free again');
  // A booking cancelled before arriving frees its slot.
  await cancel(b.appointmentId, 'patient', slots.APPOINTMENT_CANCEL_REASONS[0]);
  assert.equal((await book(core, { sessionId, slotTime: '09:20', code: 'pc-00003' })).status, 'done');
  const d = await derive(core);
  const left = slots.leftBeforeSeen(d, { since: at(MON, '00:00'), until: at(MON, '23:59') });
  assert.deepEqual([left.numerator, left.denominator], [1, 1]);
  assert.deepEqual(slots.noShowRate(d, { since: at(MON, '00:00'), until: at(MON, '23:59') }).numerator, 0, 'left before being seen is not a no-show');
});

t('a timed session is reduced by taking out free slots only; a move keeps its type; overrun is hand-checked', async () => {
  const { core, time } = await site();
  const { sessionId } = await clinic(core);
  const a = await book(core, { sessionId, slotTime: '09:00', code: 'pc-00001' });
  const reason = slots.SESSION_CHANGE_REASONS[1];
  const change = (input) => run(core, 'ospeli_slots_session_change', { sessionId, ...input }, 'ops-manager');
  await assert.rejects(change({ change: 'reduced', reason, removeSlotTimes: ['09:00'] }), (err) => code('conflict')(err) && err.detail.booked.join() === '09:00', 'a booked slot stays');
  await assert.rejects(change({ change: 'reduced', reason, removeSlotTimes: ['09:10'] }), code('invalid-input'), 'not a slot');
  await assert.rejects(change({ change: 'reduced', reason, capacity: 2 }), code('invalid-input'), 'timed sessions lose slots, not capacity');
  await assert.rejects(change({ change: 'reduced', removeSlotTimes: ['10:00'] }), code('invalid-input'), 'a reason is needed');
  await assert.rejects(change({ change: 'held' }), code('conflict'), 'held records that it ran: not before its day');
  const out = await change({ change: 'reduced', reason, removeSlotTimes: ['09:40', '10:00'] });
  assert.equal(out.state, 'reduced');
  const s = await sessionOf(core, sessionId);
  assert.deepEqual([s.slots.map((x) => x.time), s.capacity, s.free, s.reason], [['09:00', '09:20'], 2, 1, reason]);
  await assert.rejects(book(core, { sessionId, slotTime: '09:40', code: 'pc-00002' }), code('invalid-input'), 'a slot taken out is not a slot');
  // A move stays within the type of session.
  const r = await round(core, 3);
  await assert.rejects(run(core, 'ospeli_slots_move', { appointmentId: a.appointmentId, sessionId: r, visitOrder: 1 }, 'ops-manager'), code('invalid-input'));
  assert.deepEqual((await run(core, 'ospeli_slots_move', { appointmentId: a.appointmentId, sessionId, slotTime: '09:00' }, 'receptionist')).events, [], 'moved to where it is: nothing written');
  // Held, with the one patient finished at 09:35: planned end 10:20, so 45 minutes early.
  time.now = at(MON, '09:00'); await step(core, a.appointmentId, 'arrived');
  time.now = at(MON, '09:05'); await step(core, a.appointmentId, 'called');
  await assert.rejects(run(core, 'ospeli_slots_move', { appointmentId: a.appointmentId, sessionId, slotTime: '09:20' }, 'receptionist'), code('conflict'), 'an arrived patient is not moved');
  time.now = at(MON, '09:35'); await step(core, a.appointmentId, 'finished');
  assert.equal((await change({ change: 'held' })).state, 'held');
  assert.deepEqual((await change({ change: 'held' })).events, [], 'held twice answers done');
  const d = await derive(core);
  assert.equal(slots.overrun(d, { sessionId }).minutes, -45);
  assert.equal(slots.utilisation(d, { since: at(MON, '00:00'), until: at(MON, '23:59') }).value, 1 / 2, 'one used of the two slots left after the reduction');
  assert.equal(slots.overrun(d, { sessionId: r }).minutes, null);
});

t('a closed code, a not-released template and a date off the template\'s weekday are refused', async () => {
  const { core } = await site();
  const tpl = await run(core, 'ospeli_slots_template_set', { ...TEMPLATE, released: false }, 'ops-manager');
  const plan = (over) => run(core, 'ospeli_slots_session_plan', { sessionType: 'test-clinic', placeId: 'dept-outpatients', date: MON, runByRole: 'ops-manager', templateId: tpl.templateId, ...over }, 'ops-manager');
  await assert.rejects(plan({ date: WED }), code('invalid-input'), 'Wednesday is not this template\'s day');
  await assert.rejects(plan({ date: '2026-11-02' }), code('conflict'), 'before the template starts');
  await assert.rejects(plan({ start: '10:00' }), code('invalid-input'), 'start must match the template');
  await assert.rejects(plan({ templateId: 'tpl-99999' }), code('not-found'));
  const ses = await plan({});
  assert.deepEqual((await plan({})).sessionId, ses.sessionId, 'planned twice: the first is the answer');
  assert.equal((await sessionOf(core, ses.sessionId)).released, false);
  await assert.rejects(book(core, { sessionId: ses.sessionId, slotTime: '09:00', code: 'pc-00001' }), code('conflict'), 'not released: no bookings');
  await assert.rejects(run(core, 'ospeli_slots_session_change', { sessionId: ses.sessionId, change: 'released' }, 'receptionist'), code('forbidden'));
  await run(core, 'ospeli_slots_session_change', { sessionId: ses.sessionId, change: 'released' }, 'ops-manager');
  assert.equal((await book(core, { sessionId: ses.sessionId, slotTime: '09:00', code: 'pc-00001' })).status, 'done');
  await core.appendEvents([{ type: 'code.closed', subject: 'pc-00002', actorRole: 'ops-manager', at: END, data: null }], 'system', 'synthetic test code closed');
  await assert.rejects(book(core, { sessionId: ses.sessionId, slotTime: '09:20', code: 'pc-00002' }), code('conflict'), 'a closed code takes no booking');
  // A one-off timed session with no template, and a template change that goes back in time.
  const extra = await run(core, 'ospeli_slots_session_plan', { sessionType: 'test-clinic', placeId: 'dept-outpatients', date: WED, start: '14:00', minutes: 60, slotMinutes: 30, runByRole: 'ops-manager' }, 'ops-manager');
  assert.deepEqual((await sessionOf(core, extra.sessionId)).slots.map((x) => x.time), ['14:00', '14:30']);
  await assert.rejects(run(core, 'ospeli_slots_session_plan', { sessionType: 'test-clinic', placeId: 'dept-outpatients', date: WED, start: '16:00', minutes: 60, runByRole: 'ops-manager' }, 'ops-manager'), code('invalid-input'), 'timed with no template needs a slot length');
  await run(core, 'ospeli_slots_template_set', { ...TEMPLATE, released: false, templateId: tpl.templateId, start: '10:00', from: NEXT_MON }, 'ops-manager');
  await assert.rejects(run(core, 'ospeli_slots_template_set', { ...TEMPLATE, templateId: tpl.templateId, start: '11:00', from: WED }, 'ops-manager'), code('conflict'), 'a change cannot start before the last one');
  await assert.rejects(run(core, 'ospeli_slots_template_set', { ...TEMPLATE, sessionType: 'test-round', placeId: 'site-north' }, 'ops-manager'), code('invalid-input'), 'a round has no template');
});

t('the appointment list shows the wait and what is overdue; an area only to the roles that work the round', async () => {
  const { core, time } = await site();
  const r = await round(core, 3);
  await book(core, { sessionId: r, visitOrder: 2, area: 'North 2', code: 'pc-00001', slotType: 'test-home-visit' }, 'ops-manager');
  const first = await book(core, { sessionId: r, visitOrder: 1, area: 'North 1', code: 'pc-00002', slotType: 'test-home-visit' }, 'ops-manager');
  time.now = at(MON, '08:40');
  await step(core, first.appointmentId, 'arrived', 'ward-nurse');
  time.now = at(MON, '08:50');
  const nurse = await run(core, 'ospeli_slots_appointments', { sessionId: r }, 'ward-nurse');
  assert.deepEqual(nurse.appointments.map((a) => [a.visitOrder, a.area, a.state, a.waitMinutes, a.overdue]), [[1, 'North 1', 'arrived', 10, false], [2, 'North 2', 'booked', null, true]]);
  assert.deepEqual(nurse.counts, { booked: 1, arrived: 1 });
  const other = await run(core, 'ospeli_slots_appointments', { sessionId: r }, 'estates-tech');
  assert.deepEqual(other.appointments.map((a) => a.area), [null, null], 'a role that neither books nor steps this type is not shown the area');
  const byCode = await run(core, 'ospeli_slots_appointments', { code: 'pc-00002', state: 'open' }, 'ops-manager');
  assert.deepEqual(byCode.appointments.map((a) => a.id), [first.appointmentId]);
  await assert.rejects(run(core, 'ospeli_slots_appointments', {}, 'coo'), code('invalid-input'));
  await assert.rejects(run(core, 'ospeli_slots_appointments', { code: 'pc-99999' }, 'coo'), code('not-found'));
  const read = await run(core, 'ospeli_slots_sessions', { from: MON, to: MON, format: 'short' }, 'coo');
  assert.ok(!JSON.stringify(read).includes('pc-0000'), 'the sessions read shows capacity only, never a patient code');
  await assert.rejects(run(core, 'ospeli_slots_sessions', { from: MON, to: '2027-11-09' }, 'coo'), code('invalid-input'));
  const types = await run(core, 'ospeli_slots_types', {}, 'coo');
  assert.deepEqual(validate(CMDS.ospeli_slots_types.output, types), []);
  assert.deepEqual(types.sessionTypes.map((x) => [x.id, x.timed, x.graceMinutes]), [['test-clinic', true, 15], ['test-round', false, 15]]);
});

t('every event the object writes is a valid event with no key that looks like a person\'s identity', async () => {
  const { core, time } = await site();
  const { sessionId } = await clinic(core);
  const r = await round(core, 2);
  const a = await book(core, { sessionId, slotTime: '09:00', code: 'pc-00001', requestRef: { module: 'diagnostics', id: 'req-00001' } });
  await book(core, { sessionId: r, visitOrder: 1, area: 'North 1', code: 'pc-00002', slotType: 'test-home-visit' }, 'ops-manager');
  await run(core, 'ospeli_slots_reminder_record', { appointmentId: a.appointmentId, reply: 'confirmed' }, 'receptionist');
  await run(core, 'ospeli_slots_move', { appointmentId: a.appointmentId, sessionId, slotTime: '09:20' }, 'receptionist');
  await run(core, 'ospeli_slots_session_change', { sessionId: r, change: 'reduced', capacity: 1, reason: slots.SESSION_CHANGE_REASONS[0] }, 'ops-manager');
  time.now = at(MON, '09:15');
  await step(core, a.appointmentId, 'arrived');
  const events = await core.events({ type: slots.SLOT_EVENT_TYPES.filter((x) => !x.startsWith('code.')) });
  assert.ok(events.length >= 8);
  for (const e of events) assert.deepEqual(validateEvent(e), [], e.type);
  assert.deepEqual(findIdentifierFields({ events }), []);
  assert.ok(events.every((e) => ROLE_IDS.includes(e.actorRole)), 'a role on every event, never a person');
});

t('agents: every write is a proposal, sessions are site-wide, and tonight no module declares a session type', async () => {
  // Site-wide: a write (and the appointment read, which shows codes) names every ward of the site, so
  // the command layer lets an agent through only when it is allowed on all of them.
  const { core } = await site();
  const wards = (await core.listEntities('ward')).map((w) => w.id).sort();
  for (const c of Object.values(CMDS)) {
    if (c.kind === 'write') {
      assert.equal(c.approval, true, c.name);
      assert.equal(typeof c.precheck, 'function', `${c.name}: checked before a proposal is queued`);
      assert.deepEqual((await c.wardOf(core, {})).sort(), wards, `${c.name}: site-wide`);
    }
    for (const [k, v] of Object.entries(c.input.properties)) assert.ok(v.description || v.enum, `${c.name}.${k} is described`);
    assert.equal(c.input.additionalProperties, false, c.name);
  }
  assert.deepEqual((await CMDS.ospeli_slots_appointments.wardOf(core, {})).sort(), wards);
  // What an agent's proposal is checked with: the same refusals a person gets, and nothing written.
  const { sessionId } = await clinic(core);
  const n0 = await core.eventCount();
  await assert.rejects(CMDS.ospeli_slots_book.precheck(core, { sessionId, slotTime: '09:10', code: 'pc-00001', slotType: 'test-new', bookedFrom: 'referral' }, { actor: agent('receptionist') }), code('invalid-input'));
  await assert.rejects(CMDS.ospeli_slots_book.precheck(core, { sessionId, slotTime: '09:00', code: 'pc-00001', slotType: 'test-new', bookedFrom: 'referral' }, { actor: agent('ward-nurse') }), code('forbidden'));
  await CMDS.ospeli_slots_book.precheck(core, { sessionId, slotTime: '09:00', code: 'pc-00001', slotType: 'test-new', bookedFrom: 'referral' }, { actor: agent('receptionist') });
  assert.equal(await core.eventCount(), n0, 'a check writes nothing');
  // Through the real command layer. With no session type in any module the commands are not offered
  // at all (as stock with no category); once a module declares one, an agent's booking must be a proposal.
  const declared = MODULE_PACKS.some((p) => (p.SESSION_TYPES || []).length);
  assert.equal(Boolean(commandByName('ospeli_slots_book')), declared, 'slot commands are offered exactly when a module declares a session type');
  assert.equal(slotMod.slotCommands([]).length, 0);
  if (!declared) return;
  await runCommand(core, 'ospeli_agents_set_access', { allowed: true, wards: Object.fromEntries(wards.map((w) => [w, true])) }, human('coo'));
  const role = commandByName('ospeli_slots_book').roles[0];
  await runCommand(core, 'ospeli_agents_add', { name: 'slot-bot', role, wards: ['ward-a1'], days: 30 }, human('coo'));
  await assert.rejects(runCommand(core, 'ospeli_slots_book', { sessionId: 'ses-00001', slotTime: '09:00', code: 'pc-00001', slotType: commandByName('ospeli_slots_book').input.properties.slotType.enum[0], bookedFrom: 'referral' }, agent(role)),
    code('forbidden'), 'an agent allowed on one ward only cannot propose a site-wide booking');
  assert.equal(await core.eventCount() >= n0, true);
});

// ---- added 19 Nov (module crew, night 5): a session may be held for a service ----
t('a type of session that lists services names one on every template and session, so two clinics can share a place and a time', async () => {
  const SPACK = { id: 'testservices', SESSION_TYPES: [
    { id: 'svc-clinic', word: 'Clinic', timed: true, placeTypes: ['department'], services: { 'svc-eyes': 'Eye clinic', 'svc-skin': 'Skin clinic' },
      runByRoles: ['ops-manager'], planRoles: ['ops-manager'], bookRoles: ['receptionist'], stepRoles: ['receptionist'] },
    { id: 'svc-round', word: 'Round', timed: false, placeTypes: ['site'], runByRoles: ['ward-nurse'], planRoles: ['ops-manager'], bookRoles: ['ops-manager'], stepRoles: ['ward-nurse'] }],
    SLOT_TYPES: { 'svc-new': 'New' } };
  assert.throws(() => slots.slotCatalogue([{ id: 'm', SESSION_TYPES: [{ ...SPACK.SESSION_TYPES[0], services: {} }] }], ROLE_IDS), /services/);
  const S = Object.fromEntries(slotMod.slotCommands([SPACK]).map((c) => [c.name, c]));
  const go = async (core, name, input, role = 'ops-manager') => {
    const errs = validate(S[name].input, input);
    if (errs.length) throw new CommandError('invalid-input', errs.join('; '));
    return S[name].run(core, input, { actor: human(role), wards: null });
  };
  const { core } = await site();
  const plan = (over) => go(core, 'ospeli_slots_session_plan', { sessionType: 'svc-clinic', placeId: 'dept-outpatients', date: MON, start: '09:00', minutes: 80, slotMinutes: 20, runByRole: 'ops-manager', ...over });
  await assert.rejects(plan({}), (err) => code('invalid-input')(err) && err.detail.services.join() === 'svc-eyes,svc-skin');
  await assert.rejects(plan({ service: 'svc-teeth' }), code('invalid-input'));
  const eyes = await plan({ service: 'svc-eyes' });
  const skin = await plan({ service: 'svc-skin' });
  assert.notEqual(eyes.sessionId, skin.sessionId, 'same place, date and start, another service: another session');
  assert.deepEqual([(await plan({ service: 'svc-eyes' })).sessionId, (await plan({ service: 'svc-eyes' })).events.length], [eyes.sessionId, 0], 'the same session planned twice answers with the first');
  await assert.rejects(go(core, 'ospeli_slots_session_plan', { sessionType: 'svc-round', service: 'svc-eyes', placeId: 'site-north', date: MON, start: '08:30', minutes: 240, capacity: 4, runByRole: 'ward-nurse' }), code('invalid-input'), 'a type with no services takes none');
  const list = await go(core, 'ospeli_slots_sessions', { from: MON, to: MON, service: 'svc-skin' }, 'coo');
  assert.deepEqual(list.sessions.map((s) => [s.id, s.service, s.serviceWord]), [[skin.sessionId, 'svc-skin', 'Skin clinic']]);
  // A template carries its service to the sessions planned from it, and keeps it when changed.
  const tpl = { sessionType: 'svc-clinic', service: 'svc-eyes', placeId: 'dept-outpatients', weekday: 3, start: '09:00', minutes: 80, slotMinutes: 20, slotTypes: ['svc-new'], released: true, from: MON };
  const t1 = await go(core, 'ospeli_slots_template_set', tpl);
  const t2 = await go(core, 'ospeli_slots_template_set', { ...tpl, service: 'svc-skin' });
  assert.notEqual(t1.templateId, t2.templateId);
  await assert.rejects(go(core, 'ospeli_slots_template_set', { ...tpl, templateId: t1.templateId, service: 'svc-skin', minutes: 100 }), code('invalid-input'), 'a change keeps the service');
  await assert.rejects(go(core, 'ospeli_slots_template_set', { ...tpl, service: undefined }), code('invalid-input'));
  const fromTpl = await go(core, 'ospeli_slots_session_plan', { sessionType: 'svc-clinic', placeId: 'dept-outpatients', date: WED, runByRole: 'ops-manager', templateId: t2.templateId });
  await assert.rejects(go(core, 'ospeli_slots_session_plan', { sessionType: 'svc-clinic', service: 'svc-eyes', placeId: 'dept-outpatients', date: WED, runByRole: 'ops-manager', templateId: t2.templateId }), code('invalid-input'));
  const d = slots.deriveSlots(await core.events(), { packs: [SPACK], offsetMinutes: OFFSET });
  assert.equal(d.sessions.get(fromTpl.sessionId).service, 'svc-skin');
  assert.equal(d.templates.get(t1.templateId).service, 'svc-eyes');
  const types = await go(core, 'ospeli_slots_types', {}, 'coo');
  assert.deepEqual(types.sessionTypes.map((x) => x.services && x.services.map((v) => v.id)), [['svc-eyes', 'svc-skin'], null]);
});
