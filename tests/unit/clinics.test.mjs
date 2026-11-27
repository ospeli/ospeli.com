// Outpatient clinics (module clinics, area A1): its commands without the screen, the five measures
// recomputed from a hand-built event log through the shared helpers (hand-checked numbers), the
// three guide rules and their switch, the service-match rule, an agent's write waiting for a person,
// attack tests, and the synthetic history replaying cleanly through the shared objects.
// Synthetic data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Core } from '../../web/app/core/core.js';
import { MemoryAdapter } from '../../web/app/core/db.js';
import { loadSyntheticHospital, generateHospital } from '../../web/app/core/generator.js';
import { runCommand, CommandError, commandByName } from '../../web/app/core/commands.js';
import { validate } from '../../web/app/core/schema.js';
import { ROLES } from '../../web/app/core/model.js';
import { deriveSlots } from '../../web/app/core/slots.js';
import { deriveCodes, appointmentsByCode } from '../../web/app/core/codes.js';
import * as pack from '../../web/app/modules/clinics/commands.js';
import {
  missedRate, slotUtilisation, usedSlots, referralToFirst, clinicWait, clinicWaitPastBooked, startPunctuality, nextFreeSlots, sessionsFromDerived, waitingReferrals,
  ruleMissedHigh, ruleEmptySoon, ruleArrivalsBunched, guideOn,
} from '../../web/app/modules/clinics/logic.js';

const NOW = '2026-11-06T18:00:00.000Z'; // Friday 14:00 at the example site (UTC-4)
const TUE = '2026-11-10T14:00:00.000Z'; // Tuesday 10:00: clinics running and clinics within two days
const OFFSET = -240;
const MIN = 60e3;
const DAY = 864e5;
const human = (role) => ({ type: 'human', role });
const code = (c) => (err) => err instanceof CommandError && err.code === c;
const out = (name, value) => assert.deepEqual(validate(commandByName(name).output, value), [], `${name}: answer matches its schema`);
// A wall-clock time at the site as a moment.
const at = (date, hhmm) => new Date(Date.parse(`${date}T${hhmm}:00.000Z`) - OFFSET * MIN).toISOString();
const ev = (type, subject, atIso, data = null, actorRole = 'booking-clerk') => ({ type, subject, actorRole, at: atIso, data });
const derive = (events) => deriveSlots(events, { packs: [pack], offsetMinutes: OFFSET });
const codesOf = (events) => deriveCodes(events, { packs: [pack] });

// ---- a small clinic history, built by hand ----
// S1 general medicine, Mon 2 Nov 09:00, three 20-minute slots, held:
//   pc-00001 09:00 arrived 08:55, called 09:05 (wait 10), finished 09:20
//   pc-00002 09:20 arrived 09:10, called 09:25 (wait 15), finished 09:40
//   pc-00003 09:40 missed
// S2 diabetes, Tue 3 Nov 13:00, three slots, held:
//   pc-00004 13:00 arrived 12:50, called 13:30 (wait 40; first call 30 min late), finished 13:45
//   pc-00005 13:20 cancelled by the patient on 1 Nov (before the day: not counted as due)
//   pc-00006 13:40 missed
// S3 eye, Wed 4 Nov 09:00, three slots reduced to two (09:40 out, staff short), held:
//   pc-00007 09:00 arrived 08:58, called 09:10 (wait 12), finished 09:30
// S4 general medicine, Thu 5 Nov, cancelled (staff short) with nobody booked
// S5 antenatal, today Fri 6 Nov 13:00, running (not held): pc-00008 arrived 12:55, called 13:10 (wait 15)
// pc-00009 waits with no appointment at all.
function handLog() {
  const E = [];
  const session = (id, service, date, start, more = {}) => E.push(ev('session.planned', id, '2026-10-20T12:00:00.000Z',
    { sessionType: 'clinic', service, placeId: 'dept-outpatients', date, start, minutes: 60, slotMinutes: 20, slotTypes: ['new', 'follow-up'], runByRole: 'clinic-nurse', released: true, ...more }, 'outpatient-manager'));
  const open = (c, service, atIso) => E.push(ev('code.opened', c, atIso, { kind: 'outpatient-referral', service, source: 'referral', placeId: 'dept-outpatients' }), ev('code.stage', c, atIso, { stage: 'referral.accepted' }));
  let n = 0;
  const book = (sessionId, slotTime, c) => { const id = `apt-${String(++n).padStart(5, '0')}`; E.push(ev('appointment.booked', id, '2026-10-31T12:00:00.000Z', { sessionId, sessionType: 'clinic', slotTime, code: c, slotType: 'new', bookedFrom: 'referral' })); return id; };
  const visit = (id, date, arrived, called, finished) => {
    E.push(ev('appointment.arrived', id, at(date, arrived), null, 'clinic-receptionist'), ev('appointment.called', id, at(date, called), null, 'clinic-nurse'));
    if (finished) E.push(ev('appointment.finished', id, at(date, finished), null, 'clinic-nurse'));
  };
  open('pc-00001', 'general-medicine', '2026-10-26T13:20:00.000Z'); // first seen 7 days later
  open('pc-00002', 'general-medicine', '2026-10-23T13:40:00.000Z'); // 10 days
  open('pc-00003', 'general-medicine', '2026-10-28T12:00:00.000Z');
  open('pc-00004', 'diabetes', '2026-10-30T17:45:00.000Z');         // 4 days
  open('pc-00005', 'diabetes', '2026-10-28T12:00:00.000Z');
  open('pc-00006', 'diabetes', '2026-10-28T12:00:00.000Z');
  open('pc-00007', 'eye', '2026-10-29T13:30:00.000Z');              // 6 days
  open('pc-00008', 'antenatal', '2026-10-28T12:00:00.000Z');
  open('pc-00009', 'eye', '2026-10-28T12:00:00.000Z');
  session('ses-00001', 'general-medicine', '2026-11-02', '09:00');
  session('ses-00002', 'diabetes', '2026-11-03', '13:00');
  session('ses-00003', 'eye', '2026-11-04', '09:00');
  session('ses-00004', 'general-medicine', '2026-11-05', '09:00');
  session('ses-00005', 'antenatal', '2026-11-06', '13:00');
  E.push(ev('session.reduced', 'ses-00003', '2026-10-21T12:00:00.000Z', { reason: 'Staff short', removeSlotTimes: ['09:40'] }, 'outpatient-manager'));
  const a1 = book('ses-00001', '09:00', 'pc-00001'); const a2 = book('ses-00001', '09:20', 'pc-00002'); const a3 = book('ses-00001', '09:40', 'pc-00003');
  const b1 = book('ses-00002', '13:00', 'pc-00004'); const b2 = book('ses-00002', '13:20', 'pc-00005'); const b3 = book('ses-00002', '13:40', 'pc-00006');
  const c1 = book('ses-00003', '09:00', 'pc-00007'); const d1 = book('ses-00005', '13:00', 'pc-00008');
  E.push(ev('appointment.cancelled', b2, '2026-11-01T14:00:00.000Z', { by: 'patient', reason: 'Patient asked to cancel' }));
  visit(a1, '2026-11-02', '08:55', '09:05', '09:20');
  visit(a2, '2026-11-02', '09:10', '09:25', '09:40');
  E.push(ev('appointment.no-show', a3, at('2026-11-02', '10:00'), { reason: 'Did not arrive' }, 'clinic-receptionist'));
  visit(b1, '2026-11-03', '12:50', '13:30', '13:45');
  E.push(ev('appointment.no-show', b3, at('2026-11-03', '14:00'), { reason: 'Did not arrive' }, 'clinic-receptionist'));
  visit(c1, '2026-11-04', '08:58', '09:10', '09:30');
  visit(d1, '2026-11-06', '12:55', '13:10', null);
  E.push(ev('session.cancelled', 'ses-00004', '2026-11-03T12:00:00.000Z', { reason: 'Staff short' }, 'outpatient-manager'));
  for (const [s, date] of [['ses-00001', '2026-11-02'], ['ses-00002', '2026-11-03'], ['ses-00003', '2026-11-04']]) E.push(ev('session.held', s, at(date, '16:00'), null, 'outpatient-manager'));
  return E.sort((x, y) => Date.parse(x.at) - Date.parse(y.at));
}
const SINCE = new Date(Date.parse(NOW) - 28 * DAY).toISOString();

// A site with no clinic history of its own: the example hospital's places, then the given events.
async function site(events = [], { modules = false, end = NOW } = {}) {
  let t = Date.parse(end); let ticking = false;
  const core = await Core.open({ adapter: new MemoryAdapter(), clock: () => new Date(ticking ? (t += 1000) : t) });
  await loadSyntheticHospital(core, { end, modules });
  if (events.length) await core.appendEvents(events, 'system', 'hand-built clinic history');
  ticking = true;
  const run = (name, input, who) => runCommand(core, name, input, typeof who === 'string' ? human(who) : who);
  return { core, run, advance: (m) => { t += m * MIN; } };
}

test('the five measures, recomputed from a hand-built log through the shared helpers, with hand-checked numbers', () => {
  const E = handLog();
  const d = derive(E);
  const p = { since: SINCE, until: NOW };
  // 1. Missed: due in the period 3 + 2 (the cancel before the day left out) + 1 + 1 = 7; missed 2.
  assert.deepEqual(missedRate(d, p), { value: 2 / 7, numerator: 2, denominator: 7 });
  assert.deepEqual(missedRate(d, { ...p, service: 'diabetes' }), { value: 1 / 2, numerator: 1, denominator: 2 });
  // 2. Utilisation: held sessions only. 3 of 3 + 2 of 3 (a missed slot is used; the cancelled one is not) + 1 of 2 (after the reduction) = 6 of 8.
  //    The cancelled session and today's running one are not in it.
  assert.deepEqual(slotUtilisation(d, p), { value: 0.75, numerator: 6, denominator: 8 });
  assert.deepEqual(slotUtilisation(d, { ...p, service: 'eye' }), { value: 0.5, numerator: 1, denominator: 2 });
  // #184: the same used slots, split: 4 attended (arrived), 2 missed; eye: 1 attended, 0 missed.
  assert.deepEqual(usedSlots(d, p), { used: 6, attended: 4, missed: 2 });
  assert.deepEqual(usedSlots(d, { ...p, service: 'eye' }), { used: 1, attended: 1, missed: 0 });
  // 3. Referral to first appointment: 7, 10, 4 and 6 days; median 6.5. Still waiting: pc-3, 5, 6, 8 and 9 = 5.
  const cd = codesOf(E); const index = appointmentsByCode(d);
  const r = referralToFirst(cd, index, { ...p, minGroup: 1 });
  assert.deepEqual([r.n, r.medianDays, r.waiting], [4, 6.5, 5]);
  assert.deepEqual(r.byService, { 'general-medicine': { n: 2, medianDays: 8.5 }, diabetes: { n: 1, medianDays: 4 }, eye: { n: 1, medianDays: 6 } });
  assert.equal(referralToFirst(cd, index, p).medianDays, null, 'four referrals are fewer than the small-number rule of five: no median');
  // 4. Wait in clinic: 10, 15, 40, 12 and 15 (today's patient called, not yet finished) -> median 15.
  assert.deepEqual(clinicWait(d, p), { n: 5, medianMinutes: 15, leftOut: 0 }, 'nobody closed as "Seen, no times" in this log');
  assert.deepEqual(clinicWait(d, { ...p, service: 'diabetes' }), { n: 1, medianMinutes: 40, leftOut: 0 });
  // 5. Start punctuality: first call 5 min (on time), 30 min (late), 10 min (on time) -> 2 of 3 held.
  assert.deepEqual(startPunctuality(d, p), { value: 2 / 3, numerator: 2, denominator: 3, nobodyCalled: 0, noCallTimes: 0, lateMaybe: 0 });
});

test('#185: beside the waiting time in clinic, the wait past the booked time; arrived to called stays the headline', async () => {
  const E = handLog();
  const p = { since: SINCE, until: NOW };
  // Called minus the later of arrival and booked slot: 09:05-09:00 = 5, 09:25-09:20 = 5, 13:30-13:00 = 30,
  // 09:10-09:00 = 10, 13:10-13:00 = 10 -> median 10 (arrived to called is 15: the early arrivals raise it).
  assert.deepEqual(clinicWaitPastBooked(derive(E), p), { n: 5, medianMinutes: 10 });
  assert.deepEqual(clinicWaitPastBooked(derive(E), { ...p, service: 'diabetes' }), { n: 1, medianMinutes: 30 });
  // A patient who arrives after the booked time is counted from arrival, never from a slot already gone.
  const late = handLog(); const i = late.findIndex((e) => e.type === 'appointment.arrived' && e.subject === 'apt-00007');
  late[i] = { ...late[i], at: at('2026-11-04', '09:06') };
  assert.deepEqual(clinicWaitPastBooked(derive(late), { ...p, service: 'eye' }), { n: 1, medianMinutes: 4 }, 'arrived 09:06 for 09:00, called 09:10');
  const { run } = await site(handLog());
  const s = await run('ospeli_clinics_day_summary', { date: '2026-11-02' }, 'outpatient-manager');
  out('ospeli_clinics_day_summary', s);
  const k = s.kpis.find((x) => x.id === 'clinic-wait');
  assert.deepEqual([k.value, k.pastBooked], [15, { n: 5, medianMinutes: 10 }], 'the headline stays arrived to called; the second figure sits beside it');
  assert.match(k.definition, /headline/i);
  assert.match(k.definition, /past the booked time/);
});

test('the day summary shows the same measures from the log, with definitions and sources, and each clinic\'s day', async () => {
  const { run } = await site(handLog());
  const s = await run('ospeli_clinics_day_summary', { date: '2026-11-02' }, 'outpatient-manager');
  out('ospeli_clinics_day_summary', s);
  const k = Object.fromEntries(s.kpis.map((x) => [x.id, x]));
  assert.deepEqual(Object.keys(k), ['missed-appointment-rate', 'slot-utilisation', 'referral-to-first-appointment', 'clinic-wait', 'clinic-start-punctuality']);
  assert.deepEqual([k['missed-appointment-rate'].numerator, k['missed-appointment-rate'].denominator], [2, 7]);
  assert.deepEqual([k['slot-utilisation'].numerator, k['slot-utilisation'].denominator, k['slot-utilisation'].value], [6, 8, 0.75]);
  // #184: beside slot utilisation, the used slots split into attended and missed (a missed appointment counts as used).
  assert.deepEqual([k['slot-utilisation'].attended, k['slot-utilisation'].missed], [4, 2], 'of the 6 used: 4 attended, 2 missed');
  assert.deepEqual([k['referral-to-first-appointment'].value, k['referral-to-first-appointment'].n, k['referral-to-first-appointment'].waiting], [null, 4, 5], 'still waiting is shown beside the median');
  assert.deepEqual([k['clinic-wait'].value, k['clinic-wait'].n], [15, 5]);
  assert.deepEqual([k['clinic-start-punctuality'].numerator, k['clinic-start-punctuality'].denominator], [2, 3]);
  // The small-number rule: no clinic has five cases, so no per-clinic figure is shown.
  assert.ok(k['clinic-wait'].byService.every((b) => b.value === null));
  assert.equal(k['missed-appointment-rate'].byService.find((b) => b.service === 'general-medicine').value, null, '3 due is too few to show');
  for (const x of s.kpis) {
    assert.ok(x.definition && x.counts && x.outOf && x.leavesOut, `${x.id} has a written definition`);
    assert.match(x.source, /local definition/, `${x.id}: source`);
    assert.equal(x.targetText, 'No target set: track the trend.');
  }
  assert.match(k['clinic-start-punctuality'].definition, /example setting, not a standard/);
  assert.match(k['missed-appointment-rate'].name, /Missed appointment rate/);
  // Monday's clinic, hand-checked: 3 in the template, 3 used, none empty, 1 missed; first call 5 min after the start; last finished 20 min before the end.
  const c = s.clinics[0];
  assert.deepEqual([c.name, c.templateSlots, c.used, c.empty, c.cancelled, c.missed, c.firstCalledMinutes, c.overrunMinutes], ['General medicine clinic, Outpatients', 3, 3, 0, 0, 1, 5, -20]);
  const tue = (await run('ospeli_clinics_day_summary', { date: '2026-11-03' }, 'outpatient-manager')).clinics[0];
  assert.deepEqual([tue.used, tue.empty, tue.cancelled, tue.missed, tue.firstCalledMinutes, tue.overrunMinutes], [2, 1, 1, 1, 30, -15]);
  const thu = (await run('ospeli_clinics_day_summary', { date: '2026-11-05' }, 'ops-manager')).clinics[0];
  assert.deepEqual([thu.state, thu.reason, thu.empty], ['cancelled', 'Staff short', 0], 'a cancelled clinic shows with its reason');
  const wed = (await run('ospeli_clinics_day_summary', { date: '2026-11-04' }, 'ops-manager')).clinics[0];
  assert.deepEqual([wed.state, wed.templateSlots, wed.capacity, wed.reason], ['held', 3, 2, 'Staff short'], 'a reduced clinic keeps its template count and its reason');
});

test('the queue: today\'s clinic in booked-time order by code, waits, and when a missed appointment may be recorded', async () => {
  const { run, advance } = await site([], { modules: true }); // the example hospital's own clinics: Friday 14:00, the diabetes clinic is running
  const q = await run('ospeli_clinics_queue', {}, 'clinic-receptionist');
  out('ospeli_clinics_queue', q);
  assert.equal(q.clinic.service, 'diabetes');
  assert.ok(q.clinic.runningNow);
  assert.ok(q.patients.length >= 4);
  assert.deepEqual(q.patients.map((p) => p.slotTime), [...q.patients.map((p) => p.slotTime)].sort(), 'booked-time order');
  for (const p of q.patients) {
    assert.match(p.label, /^Patient P\d+$/, 'a code, never a name');
    for (const k of Object.keys(p)) assert.ok(!/name|phone|birth|address|reason/i.test(k) || k === 'stateName', `no personal field (${k})`);
  }
  const booked = q.patients.find((p) => p.state === 'booked' && Date.parse(`2026-11-06T${p.slotTime}:00.000Z`) - OFFSET * MIN > Date.parse(NOW));
  assert.ok(booked && !booked.mayMarkMissed, 'a patient booked later today cannot be marked missed yet');
  const late = q.patients.find((p) => p.mayMarkMissed);
  if (late) assert.equal((await run('ospeli_slots_step', { appointmentId: late.appointmentId, step: 'no-show', reason: 'Did not arrive' }, 'clinic-receptionist')).status, 'done', 'past the booked time plus the grace');
  await assert.rejects(run('ospeli_slots_step', { appointmentId: booked.appointmentId, step: 'no-show', reason: 'Did not arrive' }, 'clinic-receptionist'), code('conflict'));
  // Arrived is one tap; the same tap again writes nothing; the wait then runs.
  const a = await run('ospeli_slots_step', { appointmentId: booked.appointmentId, step: 'arrived', expectedState: 'booked' }, 'clinic-receptionist');
  assert.equal(a.events.length, 1);
  assert.equal((await run('ospeli_slots_step', { appointmentId: booked.appointmentId, step: 'arrived', expectedState: 'booked' }, 'clinic-receptionist')).events.length, 0, 'a double tap is safe');
  advance(12);
  const q2 = await run('ospeli_clinics_queue', { sessionId: q.sessionId }, 'clinic-nurse');
  const me = q2.patients.find((p) => p.appointmentId === booked.appointmentId);
  assert.deepEqual([me.state, me.waitMinutes], ['arrived', 12]);
  assert.equal(q2.clinic.counts.waiting, q.clinic.counts.waiting + 1);
  // Find by number: digits only, exactly that patient.
  const n = me.label.slice('Patient P'.length);
  assert.deepEqual((await run('ospeli_clinics_queue', { sessionId: q.sessionId, find: n }, 'clinic-receptionist')).patients.map((p) => p.label), [me.label]);
  assert.deepEqual(q.picks.missedReasons, ['Did not arrive', 'Other'], 'a round\'s "No answer at the door" is never a clinic\'s reason');
  await assert.rejects(run('ospeli_clinics_queue', { sessionId: 'ses-99999' }, 'clinic-nurse'), code('not-found'));
});

test('attack: typed or hostile text, unknown fields and made-up ids are refused before anything is read or written', async () => {
  const { core, run } = await site([], { modules: true });
  const n = await core.eventCount();
  for (const find of ['<img src=x onerror=alert(1)>', 'P12', '12; DROP', '1234567', '']) {
    await assert.rejects(run('ospeli_clinics_queue', { find }, 'clinic-receptionist'), code('invalid-input'), `find "${find}"`);
  }
  for (const input of [{ name: 'A Person' }, { code: 'pc-00001' }, { note: 'urgent' }, { priority: 'high' }, { sessionId: '<b>x</b>' }, { date: 'tomorrow' }]) {
    await assert.rejects(run('ospeli_clinics_queue', input, 'clinic-receptionist'), code('invalid-input'), JSON.stringify(input));
    await assert.rejects(run('ospeli_clinics_day_summary', input, 'outpatient-manager'), code('invalid-input'), JSON.stringify(input));
  }
  await assert.rejects(run('ospeli_clinics_day_summary', { date: '2026-02-30' }, 'outpatient-manager'), code('invalid-input'));
  await assert.rejects(run('ospeli_clinics_guide_set', { on: false, note: 'x' }, 'outpatient-manager'), code('invalid-input'));
  await assert.rejects(run('ospeli_clinics_guide_set', { on: 'no' }, 'outpatient-manager'), code('invalid-input'));
  // A referral holds no priority, reason or name: the shared command refuses them.
  for (const extra of [{ priority: 'urgent' }, { reason: 'chest pain' }, { name: 'A Person' }]) {
    await assert.rejects(run('ospeli_codes_open', { kind: 'outpatient-referral', service: 'eye', source: 'referral', ...extra }, 'booking-clerk'), code('invalid-input'));
  }
  assert.equal(await core.eventCount(), n, 'nothing written');
  // No command of this module takes typed text at all: every string is a pick, an id, a date or digits.
  for (const c of pack.COMMANDS) for (const [k, s] of Object.entries(c.input.properties || {})) if (s.type === 'string') assert.ok(s.enum || s.pattern, `${c.name}.${k} is a pick or a pattern`);
  // The module writes no booking, step, session or code command of its own.
  assert.deepEqual(pack.COMMANDS.map((c) => c.name), ['ospeli_clinics_queue', 'ospeli_clinics_day_summary', 'ospeli_clinics_guide_set']);
});

test('roles: the desk and the nurse mark steps, the booking clerk books, the manager plans; others are refused', async () => {
  const { core, run } = await site([], { modules: true });
  const q = await run('ospeli_clinics_queue', {}, 'coo');
  const booked = q.patients.find((p) => p.state === 'booked');
  const n = await core.eventCount();
  for (const role of ['booking-clerk', 'receptionist', 'ward-nurse', 'coo']) {
    await assert.rejects(run('ospeli_slots_step', { appointmentId: booked.appointmentId, step: 'arrived' }, role), code('forbidden'), `${role} cannot mark arrived`);
  }
  for (const role of ['clinic-receptionist', 'clinic-nurse', 'booking-clerk', 'ops-manager']) {
    await assert.rejects(run('ospeli_clinics_guide_set', { on: false }, role), code('forbidden'), `${role} cannot switch the guide`);
  }
  await assert.rejects(run('ospeli_codes_open', { kind: 'outpatient-referral', service: 'eye', source: 'referral' }, 'clinic-receptionist'), code('forbidden'));
  await assert.rejects(run('ospeli_slots_session_change', { sessionId: q.sessionId, change: 'held' }, 'booking-clerk'), code('forbidden'));
  assert.equal(await core.eventCount(), n);
  assert.ok(ROLES.filter((r) => r.home === 'clinics').every((r) => ['clinic-receptionist', 'clinic-nurse', 'booking-clerk', 'outpatient-manager'].includes(r.id)));
});

test('service match: a referral is offered only slots in sessions of its own service, by the screens and by the guide', async () => {
  const { run } = await site([], { modules: true, end: TUE });
  const sessions = (await run('ospeli_slots_sessions', { sessionType: 'clinic', to: '2026-12-01', limit: 500 }, 'booking-clerk')).sessions;
  const services = new Set(sessions.map((s) => s.service));
  assert.equal(services.size, 4, 'clinics of four services in the next three weeks');
  const neutral = (await import('../../web/app/modules/clinics/logic.js')).sessionsFromRead(sessions);
  const byId = new Map(sessions.map((s) => [s.id, s]));
  for (const service of services) {
    const free = nextFreeSlots(neutral, { service, nowMs: Date.parse(TUE), limit: 20 });
    assert.ok(free.length > 0, `${service}: free slots found`);
    assert.ok(free.every((x) => byId.get(x.sessionId).service === service), `${service}: only its own clinics`);
    assert.ok(free.every((x) => x.atMs > Date.parse(TUE)), 'never a slot in the past');
    assert.deepEqual(free.map((x) => x.atMs), [...free.map((x) => x.atMs)].sort((a, b) => a - b), 'earliest first');
  }
  assert.deepEqual(nextFreeSlots(neutral, { service: null, nowMs: Date.parse(NOW) }), [], 'no service, no offer');
  // The guide's prefilled bookings name a session of the referral's own service.
  const s = await run('ospeli_clinics_day_summary', {}, 'outpatient-manager');
  const offers = s.guide.suggestions.filter((x) => x.rule === 'empty-soon');
  assert.ok(offers.length, 'the example hospital has empty slots within two days');
  const list = (await run('ospeli_codes_list', { kind: 'outpatient-referral', limit: 500 }, 'booking-clerk')).codes;
  for (const o of offers) {
    for (const a of o.actions) {
      assert.equal(a.command, 'ospeli_slots_book');
      assert.equal(byId.get(a.input.sessionId)?.service ?? o.service, list.find((c) => c.code === a.input.code).service, 'the same service');
    }
  }
});

test('guide rules on hand-built logs: each fires at its level and not below it, with the numbers shown; rule 2 never books', () => {
  // Five Monday-to-Friday diabetes clinics a week for four weeks... built as twenty one-day sessions of five slots.
  const now = NOW;
  const build = ({ missed, early, service = 'diabetes' }) => {
    const E = [];
    let n = 0; let k = 0;
    for (let day = 1; day <= 5; day++) {
      const date = new Date(Date.parse(now) - day * 5 * DAY).toISOString().slice(0, 10);
      const sid = `ses-${String(day).padStart(5, '0')}`;
      E.push(ev('session.planned', sid, '2026-09-01T12:00:00.000Z', { sessionType: 'clinic', service, placeId: 'dept-outpatients', date, start: '09:00', minutes: 100, slotMinutes: 20, slotTypes: ['new'], runByRole: 'clinic-nurse', released: true }, 'outpatient-manager'));
      for (const slot of ['09:00', '09:20', '09:40', '10:00', '10:20']) {
        const id = `apt-${String(++n).padStart(5, '0')}`;
        E.push(ev('appointment.booked', id, '2026-09-02T12:00:00.000Z', { sessionId: sid, sessionType: 'clinic', slotTime: slot, code: `pc-${String(n).padStart(5, '0')}`, slotType: 'new', bookedFrom: 'referral' }));
        if (k < missed) { k++; E.push(ev('appointment.no-show', id, at(date, '11:00'), { reason: 'Did not arrive' }, 'clinic-receptionist')); continue; }
        const arrived = n - missed <= early ? '08:20' : slot; // early: everyone told to come at the start
        E.push(ev('appointment.arrived', id, at(date, arrived), null, 'clinic-receptionist'), ev('appointment.called', id, at(date, '11:30'), null, 'clinic-nurse'));
      }
    }
    return derive(E.sort((x, y) => Date.parse(x.at) - Date.parse(y.at)));
  };
  // 25 due. 3 missed is 12%: not above the usual level. 4 missed is 16%: above it.
  assert.deepEqual(ruleMissedHigh(build({ missed: 3, early: 0 }), { now }), []);
  const [m] = ruleMissedHigh(build({ missed: 4, early: 0 }), { now, serviceWords: pack.SERVICES });
  assert.equal(m.rule, 'missed-high');
  assert.match(m.text, /Diabetes clinic.*16%/);
  assert.match(m.why, /^4 of 25 appointments due were missed/);
  assert.equal(m.weeks.reduce((s, w) => s + w.due, 0), 25, 'the weeks add up');
  assert.equal(m.action, null, 'advice only');
  assert.match(m.basis, /example setting, not a standard/i);
  // Rule 3: 21 arrivals; 10 early is under half, 11 early is over half.
  assert.deepEqual(ruleArrivalsBunched(build({ missed: 4, early: 10 }), { now }), []);
  const [b] = ruleArrivalsBunched(build({ missed: 4, early: 11 }), { now, serviceWords: pack.SERVICES });
  assert.match(b.why, /^11 of 21 patients \(52%\) arrived 30 minutes or more before their booked slot/);
  assert.match(b.why, /Median wait from arrived to called/);
  assert.match(b.text, /staggered template/);
});

test('rule 2 offers empty slots within two days to the longest-waiting referrals of the same service, as buttons a person taps', async () => {
  const E = handLog();
  // Tomorrow-ish: a diabetes clinic on Sat 7 Nov with three free slots, and an eye clinic on Mon 9 Nov (within 48 hours of Fri 14:00? no: Mon 13:00 is 71 hours).
  E.push(ev('session.planned', 'ses-00006', '2026-11-01T12:00:00.000Z', { sessionType: 'clinic', service: 'diabetes', placeId: 'dept-outpatients', date: '2026-11-07', start: '09:00', minutes: 60, slotMinutes: 20, slotTypes: ['new'], runByRole: 'clinic-nurse', released: true }, 'outpatient-manager'));
  E.push(ev('session.planned', 'ses-00007', '2026-11-01T12:00:00.000Z', { sessionType: 'clinic', service: 'eye', placeId: 'dept-outpatients', date: '2026-11-09', start: '13:00', minutes: 60, slotMinutes: 20, slotTypes: ['new'], runByRole: 'clinic-nurse', released: true }, 'outpatient-manager'));
  // Two diabetes referrals with no appointment: pc-00010 waiting longer than pc-00011.
  E.push(ev('code.opened', 'pc-00010', '2026-10-20T12:00:00.000Z', { kind: 'outpatient-referral', service: 'diabetes', source: 'referral' }), ev('code.stage', 'pc-00010', '2026-10-20T12:00:00.000Z', { stage: 'referral.accepted' }));
  E.push(ev('code.opened', 'pc-00011', '2026-11-02T12:00:00.000Z', { kind: 'outpatient-referral', service: 'diabetes', source: 'referral' }), ev('code.stage', 'pc-00011', '2026-11-02T12:00:00.000Z', { stage: 'referral.accepted' }));
  const sorted = E.sort((x, y) => Date.parse(x.at) - Date.parse(y.at));
  const d = derive(sorted); const cd = codesOf(sorted); const index = appointmentsByCode(d);
  assert.deepEqual(waitingReferrals(cd, index, { service: 'diabetes', now: NOW }).map((r) => [r.code, r.waitingDays, r.rebookOf]),
    [['pc-00010', 17, null], ['pc-00005', 9, 'apt-00005'], ['pc-00006', 9, 'apt-00006'], ['pc-00011', 4, null]], 'oldest first, by wait only; a cancelled or missed one waits too, as a rebook');
  const s = ruleEmptySoon(d, cd, index, { now: NOW, serviceWords: pack.SERVICES, offsetMinutes: OFFSET });
  assert.deepEqual(s.map((x) => x.sessionId), ['ses-00006'], 'only the clinic within two days; the eye clinic on Monday is not yet');
  assert.deepEqual(s[0].actions.map((a) => [a.input.code, a.input.slotTime, a.input.bookedFrom, a.input.rebookOf ?? null]),
    [['pc-00010', '09:00', 'referral', null], ['pc-00005', '09:20', 'rebook', 'apt-00005'], ['pc-00006', '09:40', 'rebook', 'apt-00006']], 'the waiting list\'s own order');
  assert.match(s[0].text, /3 empty slots in the Diabetes clinic on Sat 7 Nov/);
  assert.match(s[0].why, /4 referrals are waiting.*waiting 17 days/);
  assert.match(s[0].actions[0].label, /\(waiting 17 days\)/);
  // The guide never acts: tapping is a person's call, through the shared booking command.
  const { core, run } = await site(sorted);
  const n = await core.eventCount();
  const sum = await run('ospeli_clinics_day_summary', {}, 'booking-clerk');
  assert.equal(await core.eventCount(), n, 'reading the suggestions writes nothing');
  const offer = sum.guide.suggestions.find((x) => x.rule === 'empty-soon').actions[0];
  const done = await run(offer.command, offer.input, 'booking-clerk');
  assert.equal(done.status, 'done');
  const after = await run('ospeli_clinics_day_summary', {}, 'booking-clerk');
  assert.deepEqual(after.guide.suggestions.find((x) => x.rule === 'empty-soon').actions.map((a) => a.input.code), ['pc-00005', 'pc-00006'], 'the booked referral is no longer offered');
});

test('the guide switch: one switch for all three rules, people only; with it off everything else works the same', async () => {
  const { core, run } = await site([], { modules: true });
  const on = await run('ospeli_clinics_day_summary', {}, 'outpatient-manager');
  assert.ok(on.guide.on && on.guide.suggestions.length >= 2);
  assert.deepEqual(on.guide.rules.map((r) => r.id), ['missed-high', 'empty-soon', 'arrivals-bunched']);
  for (const r of on.guide.rules) assert.match(r.basis, /example setting, not a standard/i);
  await assert.rejects(run('ospeli_clinics_guide_set', { on: true }, 'outpatient-manager'), code('conflict'), 'already on');
  const off = await run('ospeli_clinics_guide_set', { on: false }, 'outpatient-manager');
  out('ospeli_clinics_guide_set', off);
  assert.equal(guideOn(await core.events({ type: 'clinics.guide-set' })), false);
  const entry = (await core.auditLog()).at(-1);
  assert.deepEqual([entry.action, entry.actorRole], ['clinics.guide-set', 'outpatient-manager']);
  const s = await run('ospeli_clinics_day_summary', {}, 'outpatient-manager');
  assert.deepEqual([s.guide.on, s.guide.suggestions], [false, []]);
  assert.deepEqual(s.kpis.map((k) => [k.id, k.value]), on.kpis.map((k) => [k.id, k.value]), 'the measures are the same');
  assert.deepEqual(s.clinics.map((c) => c.sessionId), on.clinics.map((c) => c.sessionId));
  const q = await run('ospeli_clinics_queue', {}, 'clinic-receptionist');
  const booked = q.patients.find((p) => p.state === 'booked');
  assert.equal((await run('ospeli_slots_step', { appointmentId: booked.appointmentId, step: 'arrived' }, 'clinic-receptionist')).status, 'done', 'the queue works with the guide off');
  const ref = (await run('ospeli_codes_list', { kind: 'outpatient-referral', booked: false, limit: 1 }, 'booking-clerk')).codes[0];
  assert.ok(ref, 'the waiting list works with the guide off');
});

test('agents: an agent\'s write through the shared commands is a proposal that changes nothing until a person accepts; the guide switch is people only', async () => {
  const { core, run } = await site([], { modules: true, end: TUE });
  const wards = (await core.listEntities('ward')).map((w) => w.id);
  await run('ospeli_agents_set_access', { allowed: true, wards: Object.fromEntries(wards.map((w) => [w, true])) }, 'coo');
  await run('ospeli_agents_add', { name: 'clinic-bot', role: 'booking-clerk', wards, days: 30 }, 'coo');
  const bot = { type: 'agent', role: 'booking-clerk', agent: 'clinic-bot' };
  const s = await run('ospeli_clinics_day_summary', {}, bot);
  const offer = s.guide.suggestions.find((x) => x.rule === 'empty-soon').actions[0];
  const n = await core.eventCount();
  const p = await run('ospeli_slots_book', offer.input, bot);
  assert.equal(p.status, 'proposed');
  assert.equal(await core.eventCount(), n, 'nothing booked');
  await assert.rejects(run('ospeli_clinics_guide_set', { on: false }, { type: 'agent', role: 'outpatient-manager', agent: 'clinic-bot' }), code('forbidden'));
  await assert.rejects(run('ospeli_proposals_accept', { id: p.proposal.id }, 'clinic-nurse'), code('forbidden'), 'a role that cannot book cannot accept a booking');
  const acc = await run('ospeli_proposals_accept', { id: p.proposal.id }, 'booking-clerk');
  assert.equal(acc.status, 'accepted');
  const e = (await core.events({ type: 'appointment.booked' })).at(-1);
  assert.deepEqual([e.actorRole, e.data.code, e.data.sessionId], ['booking-clerk', offer.input.code, offer.input.sessionId]);
  const entry = (await core.auditLog()).filter((a) => a.action === 'appointment.booked').at(-1);
  assert.deepEqual([entry.actorType, entry.actorRole], ['human', 'booking-clerk'], 'recorded as done by the person who accepted');
  // An agent with only some wards cannot read the queue (appointments are site-wide).
  await run('ospeli_agents_add', { name: 'one-ward-bot', role: 'clinic-nurse', wards: [wards[0]], days: 30 }, 'coo');
  await assert.rejects(run('ospeli_clinics_queue', {}, { type: 'agent', role: 'clinic-nurse', agent: 'one-ward-bot' }), (err) => err instanceof CommandError);
});

test('a clinic with bookings is cancelled only after each booking is moved or cancelled; the day summary shows it with the reason', async () => {
  const { run } = await site([], { modules: true, end: TUE });
  // A clinic later this week with bookings in it.
  const ses = (await run('ospeli_slots_sessions', { sessionType: 'clinic', service: 'general-medicine', from: '2026-11-12', to: '2026-11-13', limit: 5 }, 'outpatient-manager')).sessions.find((x) => x.booked > 0);
  assert.ok(ses, 'a booked clinic next week');
  const sum = async () => (await run('ospeli_clinics_day_summary', { date: ses.date }, 'outpatient-manager')).clinics.find((c) => c.sessionId === ses.id);
  let c = await sum();
  assert.equal(c.open.length, ses.booked);
  await assert.rejects(run('ospeli_slots_session_change', { sessionId: ses.id, change: 'cancelled', reason: 'Staff short' }, 'outpatient-manager'), (err) => code('conflict')(err) && err.detail.open.length === ses.booked);
  let moved = 0;
  while ((c = await sum()).open.length) {
    const a = c.open[0];
    const to = c.moves[0].moveTo;
    assert.ok(to, 'a free slot of the same service to move to');
    if (moved < 2) { await run('ospeli_slots_move', { appointmentId: a.appointmentId, sessionId: to.sessionId, slotTime: to.slotTime, expectedState: 'booked' }, 'outpatient-manager'); moved++; }
    else await run('ospeli_slots_cancel', { appointmentId: a.appointmentId, by: 'site', reason: 'Session cancelled or reduced', expectedState: 'booked' }, 'outpatient-manager');
  }
  await run('ospeli_slots_session_change', { sessionId: ses.id, change: 'cancelled', reason: 'Staff short', expectedState: ses.state }, 'outpatient-manager');
  c = await sum();
  assert.deepEqual([c.state, c.reason, c.empty], ['cancelled', 'Staff short', 0]);
  const day = await run('ospeli_clinics_day_summary', { date: ses.date }, 'ops-manager');
  assert.equal(day.counts.cancelled, 1);
});

test('the synthetic history replays cleanly through the shared slot and code objects, with a live queue at the end time', () => {
  const { events, entities } = generateHospital({ end: NOW });
  const mine = events.filter((e) => /^(slot|session|appointment|code|clinics)\./.test(e.type));
  const count = (t) => mine.filter((e) => e.type === t).length;
  const d = derive(events);
  const cd = codesOf(events);
  // Every event lands: one record per opening, planning and booking, and every step changed a state.
  assert.equal(d.templates.size, new Set(mine.filter((e) => e.type === 'slot.template-set').map((e) => e.subject)).size);
  assert.equal(d.sessions.size, count('session.planned'));
  assert.equal(d.appointments.size, count('appointment.booked'));
  assert.equal(cd.codes.size, count('code.opened'));
  const appts = [...d.appointments.values()];
  assert.equal(appts.filter((a) => a.arrivedAt).length, count('appointment.arrived'));
  assert.equal(appts.filter((a) => a.calledAt).length, count('appointment.called'));
  assert.equal(appts.filter((a) => a.finishedAt).length, count('appointment.finished'));
  assert.equal(appts.filter((a) => a.state === 'no-show').length, count('appointment.no-show'));
  assert.equal(appts.filter((a) => a.state === 'cancelled').length, count('appointment.cancelled'));
  assert.equal(appts.reduce((s, a) => s + a.moves, 0), count('appointment.moved'));
  assert.equal([...d.sessions.values()].filter((s) => s.state === 'held').length, count('session.held'));
  assert.equal([...d.sessions.values()].filter((s) => s.state === 'cancelled').length, count('session.cancelled'));
  assert.equal([...cd.codes.values()].filter((c) => c.state === 'closed').length, count('code.closed'));
  assert.ok([...cd.codes.values()].every((c) => c.stage === 'referral.accepted'));
  // Every booking is into a session of the code's own service, no slot holds two, and no code was closed with a booking open.
  const index = appointmentsByCode(d);
  const seen = new Set();
  for (const a of appts) {
    assert.equal(d.sessions.get(a.sessionId).service, cd.codes.get(a.code).service, `${a.id}: same service`);
    if (a.state !== 'cancelled' || a.arrivedAt) { const k = `${a.sessionId} ${a.slotTime}`; assert.ok(!seen.has(k), `${k} holds one appointment`); seen.add(k); }
    assert.ok(Date.parse(a.bookedAt) > Date.parse(d.sessions.get(a.sessionId).plannedAt), 'booked after the session was planned');
  }
  for (const c of cd.codes.values()) if (c.state === 'closed') assert.ok(!(index.get(c.code) || []).some((a) => ['booked', 'arrived', 'called'].includes(a.state)));
  // Nothing past: every appointment of a past day is closed.
  const today = '2026-11-06';
  assert.ok(appts.filter((a) => d.sessions.get(a.sessionId).date < today).every((a) => !['booked', 'arrived', 'called'].includes(a.state)));
  // A live queue at the end time: today's clinic has patients waiting or in, and patients still to come.
  const live = [...d.sessions.values()].filter((s) => s.date === today && s.startMs <= Date.parse(NOW) && s.endMs > Date.parse(NOW));
  assert.ok(live.length, 'a clinic running at the end time');
  const states = live.flatMap((s) => s.appointments.map((id) => d.appointments.get(id).state));
  assert.ok(states.includes('booked') && (states.includes('arrived') || states.includes('called')) && states.includes('finished'), states.join());
  // Fictional, by roles only, and only the kinds of event the module may seed.
  const roles = new Set(ROLES.map((r) => r.id));
  for (const e of mine) {
    assert.ok(roles.has(e.actorRole), `${e.type} by a real role`);
    assert.ok(!JSON.stringify(e.data || {}).match(/"(name|phone|email|address|dob|birth|reason for visit|priority|urgency)"/i), 'no personal or clinical field');
  }
  assert.ok(entities.some((x) => x.id === 'dept-outpatients'));
  // The same seed gives the same history.
  assert.deepEqual(generateHospital({ end: NOW }).events.filter((e) => /^(slot|session|appointment|code|clinics)\./.test(e.type)), mine);
});

test('an older example hospital with no outpatients department gets no clinic history, and the reads answer honestly empty', async () => {
  assert.deepEqual(pack.seed({ r: null, startMs: 0, endMs: DAY, days: 1, entities: [] }), []);
  const { run } = await site();
  const q = await run('ospeli_clinics_queue', {}, 'clinic-receptionist');
  assert.deepEqual([q.clinic, q.patients.length, q.clinics.length], [null, 0, 0]);
  const s = await run('ospeli_clinics_day_summary', {}, 'outpatient-manager');
  assert.deepEqual([s.clinics.length, s.templates.length], [0, 0]);
  assert.ok(s.kpis.length > 0, 'the summary still lists its measures');
  assert.ok(s.kpis.every((k) => k.value === null));
});

test('every example in the pack runs as written on a fresh example hospital', async () => {
  for (const c of pack.COMMANDS) {
    const { run } = await site([], { modules: true });
    const role = c.roles.includes('outpatient-manager') ? 'outpatient-manager' : c.roles[0];
    const res = await run(c.name, structuredClone(c.example.input), role);
    out(c.name, res);
  }
});

// ---- the reviewers' points (Domain lead D1 to D4, Adoption lead A2) ----
import { moveTargets, firstAppointmentList, rowsFromList, daysWords, waitedWords, MOVE_NOTICE_HOURS } from '../../web/app/modules/clinics/logic.js';

test('D1: Move-or-Cancel gives each booking its own free slot of the same service, at least the notice ahead and on or after its own date, in booked-time order', () => {
  const H = 3600e3; const now = Date.parse(NOW);
  const ses = (id, service, date, startMs, slots) => ({ id, service, state: 'planned', released: true, start: '09:00', date, startMs, slots: slots.map(([time, taken]) => ({ time, taken })) });
  const sessions = [
    ses('ses-00010', 'eye', '2026-11-06', now + 2 * H, [['09:00', false], ['09:20', false]]),          // today: inside the notice
    ses('ses-00011', 'eye', '2026-11-09', now + 70 * H, [['09:00', false], ['09:20', true], ['09:40', false]]),
    ses('ses-00012', 'diabetes', '2026-11-09', now + 70 * H, [['09:00', false]]),                      // another service
    ses('ses-00013', 'eye', '2026-11-10', now + 94 * H, [['09:00', false]]),
  ];
  const bookings = [{ appointmentId: 'apt-00003', slotTime: '10:00' }, { appointmentId: 'apt-00001', slotTime: '09:00' }, { appointmentId: 'apt-00002', slotTime: '09:30' }, { appointmentId: 'apt-00004', slotTime: '11:00' }];
  const m = moveTargets(sessions, { service: 'eye', exceptSessionId: 'ses-00099', bookings, nowMs: now, fromDate: '2026-11-06' });
  assert.deepEqual(m.map((x) => [x.appointmentId, x.moveTo && `${x.moveTo.sessionId} ${x.moveTo.slotTime}`]),
    [['apt-00001', 'ses-00011 09:00'], ['apt-00002', 'ses-00011 09:40'], ['apt-00003', 'ses-00013 09:00'], ['apt-00004', null]], 'distinct, in order; none left: cancel only');
  assert.ok(m.filter((x) => x.moveTo).every((x) => x.moveTo.atMs >= now + MOVE_NOTICE_HOURS * H), 'never sooner than the notice');
  // On or after the booking's own date: a clinic on the 10th never offers the 9th.
  assert.deepEqual(moveTargets(sessions, { service: 'eye', bookings: [{ appointmentId: 'apt-00001', slotTime: '09:00' }], nowMs: now, fromDate: '2026-11-10' })[0].moveTo.sessionId, 'ses-00013');
  assert.equal(MOVE_NOTICE_HOURS, 24);
});

test('D1 on the example hospital: every Move target is distinct, of the same service, at least 24 hours ahead and not before the clinic\'s date', async () => {
  const { run } = await site([], { modules: true, end: TUE });
  const sessions = (await run('ospeli_slots_sessions', { sessionType: 'clinic', to: '2026-12-15', limit: 500 }, 'outpatient-manager')).sessions;
  const byId = new Map(sessions.map((s) => [s.id, s]));
  let checked = 0;
  for (const date of ['2026-11-10', '2026-11-11', '2026-11-12']) {
    for (const c of (await run('ospeli_clinics_day_summary', { date }, 'outpatient-manager')).clinics) {
      const seen = new Set();
      assert.deepEqual(c.moves.map((x) => x.slotTime), [...c.moves.map((x) => x.slotTime)].sort(), 'booked-time order');
      for (const x of c.moves.filter((y) => y.moveTo)) {
        const to = byId.get(x.moveTo.sessionId);
        const key = `${x.moveTo.sessionId} ${x.moveTo.slotTime}`;
        assert.ok(!seen.has(key), `${key} offered twice`); seen.add(key);
        assert.equal(to.service, c.service);
        assert.ok(x.moveTo.date >= c.date);
        const atMs = Date.parse(to.startsAt) + ((+x.moveTo.slotTime.slice(0, 2) * 60 + +x.moveTo.slotTime.slice(3)) - (+to.start.slice(0, 2) * 60 + +to.start.slice(3))) * MIN;
        assert.ok(atMs >= Date.parse(TUE) + 24 * 3600e3, `${key} is at least 24 hours ahead`);
        checked++;
      }
    }
  }
  assert.ok(checked > 10, `${checked} move targets checked`);
});

test('D2: every clinic day of the example history adds up: used + empty = offered; missed and left-before-seen are inside used', async () => {
  const { run } = await site([], { modules: true });
  let days = 0;
  for (let i = -30; i <= 7; i++) {
    const date = new Date(Date.parse('2026-11-06T12:00:00.000Z') + i * DAY).toISOString().slice(0, 10);
    for (const c of (await run('ospeli_clinics_day_summary', { date }, 'outpatient-manager')).clinics) {
      assert.equal(c.used + c.empty, c.capacity, `${c.sessionId} ${date}: ${c.used} + ${c.empty} = ${c.capacity}`);
      assert.ok(c.missed + c.leftBeforeSeen <= c.used, `${c.sessionId}: missed and left are part of used`);
      if (c.state === 'cancelled') assert.deepEqual([c.used, c.empty, c.capacity], [0, 0, 0]);
      else assert.ok(c.capacity <= c.templateSlots);
      days++;
    }
  }
  assert.ok(days > 50, `${days} clinic days checked`);
});

test('D3: the guide offers empty slots in the waiting list\'s own order (one function feeds both), never one patient twice; day words', async () => {
  const { run } = await site([], { modules: true, end: TUE });
  const s = await run('ospeli_clinics_day_summary', {}, 'booking-clerk');
  const offers = s.guide.suggestions.filter((x) => x.rule === 'empty-soon');
  assert.ok(offers.length >= 2);
  const list = (await run('ospeli_codes_list', { kind: 'outpatient-referral', state: 'open', booked: false, limit: 500 }, 'booking-clerk')).codes;
  const rows = rowsFromList(list);
  const firstFor = new Map();
  for (const o of offers) {
    const screen = firstAppointmentList(rows, { service: o.service }).map((r) => r.code).filter((c) => !firstFor.has(c) && ![...firstFor.values()].flat().includes(c));
    const offered = o.actions.map((a) => a.input.code);
    assert.deepEqual(offered, screen.slice(0, offered.length), `${o.id}: the waiting list's first rows for ${o.service}, in order`);
    firstFor.set(o.id, offered);
  }
  const all = offers.flatMap((o) => o.actions.map((a) => a.input.code));
  assert.equal(new Set(all).size, all.length, 'never one patient in two suggestions');
  assert.deepEqual([daysWords(0), daysWords(1), daysWords(12)], ['today', '1 day', '12 days']);
  assert.deepEqual([waitedWords(0), waitedWords(1), waitedWords(3)], ['added today', 'waiting 1 day', 'waiting 3 days']);
  for (const o of offers) assert.ok(!/\b[01] days\b/.test(o.why + o.actions.map((a) => a.label).join()), 'no "1 days" or "0 days"');
});

test('D4: a clinic is marked held only once nobody is still booked, waiting or in; the manager closes each with the shared commands', async () => {
  const { run, advance } = await site([], { modules: true, end: TUE });
  advance(5 * 60); // 15:00 at the site: the general medicine clinic ended at 12:30
  const gm = async () => (await run('ospeli_clinics_day_summary', {}, 'outpatient-manager')).clinics.find((c) => c.service === 'general-medicine');
  let c = await gm();
  assert.ok(c.ended && c.open.length > 0, 'patients still open after the end');
  assert.equal(c.mayMarkHeld, false, 'not offered while anyone is open');
  for (const a of c.open) {
    if (a.state === 'called') await run('ospeli_slots_step', { appointmentId: a.appointmentId, step: 'finished', expectedState: 'called' }, 'outpatient-manager');
    else if (a.state === 'arrived') await run('ospeli_slots_cancel', { appointmentId: a.appointmentId, by: 'patient', reason: 'Left before being seen', expectedState: 'arrived' }, 'outpatient-manager');
    else { assert.ok(a.mayMarkMissed); await run('ospeli_slots_step', { appointmentId: a.appointmentId, step: 'no-show', reason: 'Did not arrive', expectedState: 'booked' }, 'outpatient-manager'); }
    const now = await gm();
    if (now.open.length) assert.equal(now.mayMarkHeld, false);
  }
  c = await gm();
  assert.deepEqual([c.open.length, c.mayMarkHeld], [0, true]);
  assert.equal(c.used + c.empty, c.capacity);
  await run('ospeli_slots_session_change', { sessionId: c.sessionId, change: 'held', expectedState: c.state }, 'outpatient-manager');
  assert.equal((await gm()).state, 'held');
});

test('A2: a booking made by mistake is cancelled by the site as "Booked in error", and a referral added by mistake is closed as "Opened in error"; both go back the way they were', async () => {
  const { run, core } = await site([], { modules: true, end: TUE });
  const list = async () => (await run('ospeli_codes_list', { kind: 'outpatient-referral', state: 'open', booked: false, limit: 500 }, 'booking-clerk')).codes;
  const r = (await list()).find((x) => x.service === 'eye' && !x.appointments);
  const sessions = (await run('ospeli_slots_sessions', { sessionType: 'clinic', service: 'eye', to: '2026-12-15', limit: 100 }, 'booking-clerk')).sessions;
  const free = nextFreeSlots((await import('../../web/app/modules/clinics/logic.js')).sessionsFromRead(sessions), { service: 'eye', nowMs: Date.parse(TUE), limit: 1 })[0];
  const b = await run('ospeli_slots_book', { sessionId: free.sessionId, slotTime: free.slotTime, code: r.code, slotType: 'new', bookedFrom: 'referral' }, 'booking-clerk');
  assert.ok(!(await list()).some((x) => x.code === r.code));
  await run('ospeli_slots_cancel', { appointmentId: b.appointmentId, by: 'site', reason: 'Booked in error', expectedState: 'booked' }, 'booking-clerk');
  const back = (await list()).find((x) => x.code === r.code);
  assert.ok(back, 'back on the waiting list');
  assert.equal((await core.events({ subject: b.appointmentId })).at(-1).data.reason, 'Booked in error');
  const opened = await run('ospeli_codes_open', { kind: 'outpatient-referral', service: 'eye', source: 'referral' }, 'booking-clerk');
  await run('ospeli_codes_close', { code: opened.code, reason: 'Opened in error' }, 'booking-clerk');
  assert.ok(!(await list()).some((x) => x.code === opened.code), 'off the list');
  assert.equal((await core.events({ subject: opened.code })).at(-1).data.reason, 'Opened in error');
});

test('#144 on the module: a wrong Call in is undone, a patient seen but not tapped through is closed as "Seen, no times", and the day says how many and which way its figures lean', async () => {
  // Today's antenatal clinic (13:00 to 14:00) in the hand-built log: pc-00008 arrived 12:55, called 13:10, never finished. Now 14:00.
  const { run } = await site(handLog());
  const q = async () => (await run('ospeli_clinics_queue', { sessionId: 'ses-00005' }, 'clinic-nurse')).patients.find((x) => x.appointmentId === 'apt-00008');
  let p = await q();
  assert.deepEqual([p.state, p.mayUndo, p.noTimes], ['called', true, false]);
  await run('ospeli_slots_step_correct', { appointmentId: 'apt-00008', undo: 'called', expectedState: 'called' }, 'clinic-nurse');
  p = await q();
  assert.deepEqual([p.state, p.clocks.arrived, p.calledAt], ['arrived', '12:55', null], 'back to waiting, the arrival kept');
  await run('ospeli_slots_step', { appointmentId: 'apt-00008', step: 'seen-no-times', expectedState: 'arrived' }, 'outpatient-manager');
  const full = await run('ospeli_clinics_queue', { sessionId: 'ses-00005' }, 'clinic-nurse');
  out('ospeli_clinics_queue', full);
  p = full.patients.find((x) => x.appointmentId === 'apt-00008');
  assert.deepEqual([p.state, p.stateName, p.noTimes, p.mayUndo, p.finishedAt], ['finished', 'Seen, no times', true, false, null]);
  const s = await run('ospeli_clinics_day_summary', { date: '2026-11-06' }, 'outpatient-manager');
  out('ospeli_clinics_day_summary', s);
  const c = s.clinics.find((x) => x.sessionId === 'ses-00005');
  // Hand-checked: one patient, attended with no times; the only call was undone, so no call time; no finish time, so no
  // overrun minutes, and the end can only be "at least"; one step undone; nobody open, so it may be marked held.
  assert.deepEqual([c.used, c.empty, c.capacity, c.attended, c.noTimes, c.corrections, c.firstCalledMinutes, c.firstCalledAtMost, c.overrunMinutes, c.overrunAtLeast, c.openCount, c.mayMarkHeld],
    [1, 2, 3, 1, 1, 1, null, false, null, true, 0, true]);
  assert.equal(s.picks.noTimesName, 'Seen, no times');
  // The wait measure leaves the patient out and says so: the five earlier waits are unchanged.
  const E = handLog();
  E.push(ev('appointment.step-undone', 'apt-00008', at('2026-11-06', '13:50'), { undo: 'called', reason: 'Marked by mistake' }, 'clinic-nurse'),
    ev('appointment.seen-no-times', 'apt-00008', at('2026-11-06', '13:55'), null, 'outpatient-manager'));
  assert.deepEqual(clinicWait(derive(E), { since: SINCE, until: NOW }), { n: 4, medianMinutes: 13.5, leftOut: 1 }, 'waits 10, 12, 15, 40: median 13.5; one left out');
  assert.equal(s.kpis.find((k) => k.id === 'clinic-wait').n, 4, 'four waits (10, 15, 40, 12) once the undone call is gone');
  assert.equal(s.kpis.find((k) => k.id === 'clinic-wait').leftOut, 1, 'the wait measure says how many it left out');
  assert.match(s.kpis.find((k) => k.id === 'clinic-wait').leavesOut, /"Seen, no times"/);
  // Marked held: a clinic whose only patient was seen with no times is not "nobody called".
  await run('ospeli_slots_session_change', { sessionId: 'ses-00005', change: 'held', expectedState: 'planned' }, 'outpatient-manager');
  const sp = (await run('ospeli_clinics_day_summary', { date: '2026-11-06' }, 'outpatient-manager')).kpis.find((k) => k.id === 'clinic-start-punctuality');
  assert.deepEqual([sp.numerator, sp.denominator, sp.nobodyCalled, sp.noCallTimes, sp.lateMaybe], [2, 3, 0, 1, 0]);
});

test('#144 on the module: a missed appointment marked by mistake is undone at the desk on the same day, with "Patient arrived late", and the patient can then arrive', async () => {
  const { run, advance } = await site([], { modules: true, end: TUE });
  advance(50); // 10:50 at the site: the 10:30 patient is past the booked time and the grace
  const queue = await run('ospeli_clinics_queue', {}, 'clinic-receptionist');
  const p = queue.patients.find((x) => x.mayMarkMissed);
  assert.ok(p, 'a patient past the grace');
  await run('ospeli_slots_step', { appointmentId: p.appointmentId, step: 'no-show', reason: 'Did not arrive', expectedState: 'booked' }, 'clinic-receptionist');
  const missed = (await run('ospeli_clinics_queue', { sessionId: queue.sessionId }, 'clinic-receptionist')).patients.find((x) => x.appointmentId === p.appointmentId);
  assert.deepEqual([missed.state, missed.mayUndo], ['no-show', true]);
  await run('ospeli_slots_step_correct', { appointmentId: p.appointmentId, undo: 'no-show', reason: 'Patient arrived late', expectedState: 'no-show' }, 'clinic-receptionist');
  await run('ospeli_slots_step', { appointmentId: p.appointmentId, step: 'arrived', expectedState: 'booked' }, 'clinic-receptionist');
  const after = (await run('ospeli_clinics_queue', { sessionId: queue.sessionId }, 'clinic-receptionist')).patients.find((x) => x.appointmentId === p.appointmentId);
  assert.equal(after.state, 'arrived');
  const day = (await run('ospeli_clinics_day_summary', {}, 'outpatient-manager')).clinics.find((x) => x.sessionId === queue.sessionId);
  assert.equal(day.corrections, 1, 'the undo is counted');
  assert.equal(day.used + day.empty, day.capacity, 'the figures still add up');
  // An agent cannot undo a step: the command is for people only.
  await assert.rejects(run('ospeli_slots_step_correct', { appointmentId: p.appointmentId, undo: 'arrived' }, { type: 'agent', role: 'clinic-receptionist', agentId: 'agent-x' }), (e) => e instanceof CommandError);
});

test('#144 start punctuality: a clinic counted late on its first recorded call, where a patient seen with no times arrived before that call, is flagged as maybe on time', () => {
  // ses-00001 starts 09:00. Add pc-00010 booked 09:00 in a new held session ses-00009, arrived 08:50, closed "Seen, no times";
  // pc-00011 arrived 09:00, first recorded call 09:40 (40 min late, beyond the 15-minute example window).
  const E = handLog();
  E.push(ev('session.planned', 'ses-00009', '2026-10-20T12:00:00.000Z', { sessionType: 'clinic', service: 'eye', placeId: 'dept-outpatients', date: '2026-11-05', start: '13:00', minutes: 60, slotMinutes: 20, slotTypes: ['new', 'follow-up'], runByRole: 'clinic-nurse', released: true }, 'outpatient-manager'));
  for (const c of ['pc-00010', 'pc-00011']) E.push(ev('code.opened', c, '2026-10-28T12:00:00.000Z', { kind: 'outpatient-referral', service: 'eye', source: 'referral', placeId: 'dept-outpatients' }));
  E.push(ev('appointment.booked', 'apt-00091', '2026-10-31T12:00:00.000Z', { sessionId: 'ses-00009', sessionType: 'clinic', slotTime: '13:00', code: 'pc-00010', slotType: 'new', bookedFrom: 'referral' }),
    ev('appointment.booked', 'apt-00092', '2026-10-31T12:00:00.000Z', { sessionId: 'ses-00009', sessionType: 'clinic', slotTime: '13:20', code: 'pc-00011', slotType: 'new', bookedFrom: 'referral' }),
    ev('appointment.arrived', 'apt-00091', at('2026-11-05', '12:50'), null, 'clinic-receptionist'),
    ev('appointment.arrived', 'apt-00092', at('2026-11-05', '13:00'), null, 'clinic-receptionist'),
    ev('appointment.called', 'apt-00092', at('2026-11-05', '13:40'), null, 'clinic-nurse'),
    ev('appointment.finished', 'apt-00092', at('2026-11-05', '13:55'), null, 'clinic-nurse'),
    ev('appointment.seen-no-times', 'apt-00091', at('2026-11-05', '14:00'), null, 'outpatient-manager'),
    ev('session.held', 'ses-00009', at('2026-11-05', '16:00'), null, 'outpatient-manager'));
  const d = derive(E.sort((x, y) => Date.parse(x.at) - Date.parse(y.at)));
  // Held with a call: S1 (5 min), S2 (30), S3 (10), ses-00009 (40, maybe on time) -> 2 of 4 on time, 1 late-maybe.
  assert.deepEqual(startPunctuality(d, { since: SINCE, until: NOW }), { value: 0.5, numerator: 2, denominator: 4, nobodyCalled: 0, noCallTimes: 0, lateMaybe: 1 });
});

test('#195: Clinic day reads "Running now" between the start and the end once anyone has arrived; "Planned" before the start or with nobody arrived', async () => {
  // S5 antenatal, Fri 6 Nov 13:00 to 14:00; pc-00008 arrived 12:55, called 13:10. The log is cut at the moment looked at.
  const upTo = (iso) => handLog().filter((e) => Date.parse(e.at) <= Date.parse(iso));
  const antenatal = async (iso) => {
    const { run } = await site(upTo(iso), { end: iso });
    const s = await run('ospeli_clinics_day_summary', { date: '2026-11-06' }, 'outpatient-manager');
    out('ospeli_clinics_day_summary', s);
    return s.clinics.find((c) => c.sessionId === 'ses-00005');
  };
  const before = await antenatal(at('2026-11-06', '12:58'));
  assert.deepEqual([before.state, before.stateName], ['planned', 'Planned'], 'before the start it is the booking state, even with someone arrived early');
  const running = await antenatal(at('2026-11-06', '13:40'));
  assert.deepEqual([running.state, running.stateName], ['planned', 'Running now'], 'between the start and the end with a patient arrived');
  const after = await antenatal(at('2026-11-06', '14:10'));
  assert.equal(after.stateName, 'Planned', 'after the end it waits to be marked held');
  // Nobody arrived: a clinic between its start and end still reads Planned.
  const empty = handLog().filter((e) => !(e.subject === 'apt-00008' && /arrived|called/.test(e.type)));
  const { run } = await site(empty.filter((e) => Date.parse(e.at) <= Date.parse(at('2026-11-06', '13:40'))), { end: at('2026-11-06', '13:40') });
  const c = (await run('ospeli_clinics_day_summary', { date: '2026-11-06' }, 'outpatient-manager')).clinics.find((x) => x.sessionId === 'ses-00005');
  assert.equal(c.stateName, 'Planned', 'nobody arrived yet');
});
