// The slot object: correct a step marked by mistake, and close out a clinic honestly
// (ospeli/ospeli#144, found by the Outpatients reviewers on 19 Nov 2026). Each test was seen red
// on app head 83e2f24. Every figure is recomputed from the event log. Synthetic data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slots, MON, at, code, run, site, clinic, book, step, correct, derive, appt, CMDS } from './slots-helper.mjs';

const TUE = '2026-11-10';
const sessionAudit = async (core, action) => (await core.auditLog()).filter((e) => e.action === action);

test('a wrong Arrived is undone: back to booked, the arrival time gone from the measures, the wrong tap kept in the history', async () => {
  const { core, time } = await site();
  const s = await clinic(core);
  const a = await book(core, { sessionId: s.sessionId, slotTime: '09:00', code: 'pc-00001' });
  time.now = at(MON, '08:50');
  await step(core, a.appointmentId, 'arrived');
  time.now = at(MON, '08:52');
  const r = await correct(core, a.appointmentId, 'arrived');
  assert.deepEqual([r.status, r.state, r.events.length], ['done', 'booked', 1]);
  const now = await appt(core, a.appointmentId);
  assert.deepEqual([now.state, now.arrivedAt], ['booked', null]);
  assert.deepEqual(now.corrections, [{ undo: 'arrived', reason: 'Marked by mistake', at: at(MON, '08:52'), byRole: 'receptionist', stepAt: at(MON, '08:50') }]);
  const evs = (await core.events()).filter((e) => e.subject === a.appointmentId).map((e) => e.type);
  assert.deepEqual(evs, ['appointment.booked', 'appointment.arrived', 'appointment.step-undone'], 'nothing is erased');
  // The same undo again (a double tap) answers done and writes nothing.
  const again = await correct(core, a.appointmentId, 'arrived');
  assert.deepEqual([again.status, again.state, again.events.length], ['done', 'booked', 0]);
  // The patient then really arrives: the wait runs from the true arrival.
  time.now = at(MON, '09:05'); await step(core, a.appointmentId, 'arrived');
  time.now = at(MON, '09:15'); await step(core, a.appointmentId, 'called');
  const w = slots.waitInClinic(await derive(core), { until: at(MON, '23:00') });
  assert.deepEqual([w.n, w.medianMinutes], [1, 10]);
  const list = await run(core, 'ospeli_slots_appointments', { sessionId: s.sessionId }, 'receptionist');
  assert.equal(list.appointments[0].corrections, 1, 'the list says a step was corrected');
});

test('a wrong Call in is undone back to arrived, keeping the arrival time; a wrong Arrived cannot be undone once called', async () => {
  const { core, time } = await site();
  const s = await clinic(core);
  const a = await book(core, { sessionId: s.sessionId, slotTime: '09:00', code: 'pc-00001' });
  time.now = at(MON, '08:55'); await step(core, a.appointmentId, 'arrived');
  time.now = at(MON, '09:00'); await step(core, a.appointmentId, 'called');
  await assert.rejects(correct(core, a.appointmentId, 'arrived'), (e) => code('conflict')(e) && /called in/.test(e.message) && e.detail.canUndo === 'called');
  time.now = at(MON, '09:01');
  assert.equal((await correct(core, a.appointmentId, 'called')).state, 'arrived');
  const now = await appt(core, a.appointmentId);
  assert.deepEqual([now.state, now.arrivedAt, now.calledAt], ['arrived', at(MON, '08:55'), null]);
  time.now = at(MON, '09:12'); await step(core, a.appointmentId, 'called');
  assert.equal(slots.waitInClinic(await derive(core), { until: at(MON, '23:00') }).medianMinutes, 17);
  time.now = at(MON, '09:30'); await step(core, a.appointmentId, 'finished');
  await assert.rejects(correct(core, a.appointmentId, 'called'), code('conflict'), 'a finished appointment is not corrected');
});

test('a wrong Missed appointment is undone on the clinic\'s own day only, with a reason picked from two, and never once the session is held', async () => {
  const { core, time } = await site();
  const s = await clinic(core);
  const a = await book(core, { sessionId: s.sessionId, slotTime: '09:00', code: 'pc-00001' });
  const b = await book(core, { sessionId: s.sessionId, slotTime: '09:20', code: 'pc-00002' });
  time.now = at(MON, '09:40');
  await step(core, a.appointmentId, 'no-show', { reason: 'Did not arrive' });
  await step(core, b.appointmentId, 'no-show', { reason: 'Did not arrive' });
  assert.equal(slots.noShowRate(await derive(core), { until: at(MON, '23:00') }).numerator, 2);
  await assert.rejects(correct(core, a.appointmentId, 'arrived'), code('conflict'), 'undo names the step it undoes');
  await assert.rejects(correct(core, a.appointmentId, 'no-show', { reason: 'Some typed text' }), code('invalid-input'), 'a reason is a pick');
  await assert.rejects(correct(core, a.appointmentId, 'no-show', { expectedState: 'booked' }), code('conflict'), 'the caller saw another state');
  time.now = at(MON, '09:42');
  const r = await correct(core, a.appointmentId, 'no-show', { reason: 'Patient arrived late', expectedState: 'no-show' });
  assert.equal(r.state, 'booked');
  const now = await appt(core, a.appointmentId);
  assert.deepEqual([now.state, now.closedAt, now.noShowReason, now.corrections[0].reason], ['booked', null, null, 'Patient arrived late']);
  assert.equal(slots.noShowRate(await derive(core), { until: at(MON, '23:00') }).numerator, 1, 'the rate is recomputed');
  await step(core, a.appointmentId, 'arrived');
  await assert.rejects(correct(core, a.appointmentId, 'arrived', { reason: 'Patient arrived late' }), code('invalid-input'), 'that reason is for a missed appointment only');
  // The next day the missed appointment stands: rebook instead.
  time.now = at(TUE, '08:00');
  await assert.rejects(correct(core, b.appointmentId, 'no-show'), (e) => code('conflict')(e) && /same day/.test(e.message));
  // Corrections lock once the session is held.
  const { core: c2, time: t2 } = await site();
  const s2 = await clinic(c2);
  const x = await book(c2, { sessionId: s2.sessionId, slotTime: '09:00', code: 'pc-00001' });
  t2.now = at(MON, '09:40');
  await step(c2, x.appointmentId, 'no-show', { reason: 'Did not arrive' });
  await run(c2, 'ospeli_slots_session_change', { sessionId: s2.sessionId, change: 'held' }, 'ops-manager');
  await assert.rejects(correct(c2, x.appointmentId, 'no-show'), (e) => code('conflict')(e) && /marked as held/.test(e.message));
});

test('undo is for people at the desk only: not an agent, not a role that marks no steps; the audit entry names the step undone', async () => {
  const { core, time } = await site();
  const c = CMDS.ospeli_slots_step_correct;
  assert.equal(c.agents, false, 'people only');
  assert.equal(c.kind, 'write');
  assert.deepEqual([...c.roles].sort(), ['receptionist', 'ward-nurse'], 'the roles that mark steps, and no other');
  assert.equal(c.input.additionalProperties, false);
  assert.ok(!Object.values(c.input.properties).some((p) => p.type === 'string' && !p.enum && !p.pattern), 'no field takes typed text');
  const s = await clinic(core);
  const a = await book(core, { sessionId: s.sessionId, slotTime: '09:00', code: 'pc-00001' });
  time.now = at(MON, '08:50');
  await step(core, a.appointmentId, 'arrived');
  await assert.rejects(correct(core, a.appointmentId, 'arrived', {}, 'ops-manager'), code('forbidden'));
  await correct(core, a.appointmentId, 'arrived');
  const entries = await sessionAudit(core, 'appointment.step-undone');
  assert.equal(entries.length, 1);
  assert.deepEqual([entries[0].actorType, entries[0].actorRole, entries[0].detail.undo, entries[0].detail.reason], ['human', 'receptionist', 'arrived', 'Marked by mistake']);
});

test('"Seen, no times": a patient seen but not tapped through is closed as attended, and is left out of the wait, the start and the overrun, which say how many', async () => {
  const { core, time } = await site();
  const s = await clinic(core);
  const [a, b, c] = await Promise.all(['09:00', '09:20', '09:40'].map((slotTime, i) => book(core, { sessionId: s.sessionId, slotTime, code: `pc-0000${i + 1}` })));
  // Patient 1 is tapped through properly: arrived 08:55, called 09:05, finished 09:25.
  time.now = at(MON, '08:55'); await step(core, a.appointmentId, 'arrived');
  time.now = at(MON, '09:05'); await step(core, a.appointmentId, 'called');
  time.now = at(MON, '09:10'); await step(core, b.appointmentId, 'arrived');
  // Too early: before the patient's own slot time it is refused, and the answer says from when.
  await assert.rejects(step(core, b.appointmentId, 'seen-no-times'), (e) => code('conflict')(e) && e.detail.from === at(MON, '09:20'));
  time.now = at(MON, '09:25'); await step(core, a.appointmentId, 'finished');
  time.now = at(MON, '09:35'); await step(core, c.appointmentId, 'arrived');
  time.now = at(MON, '09:50'); await step(core, c.appointmentId, 'called');
  // 10:50, half an hour after the planned end (10:20): the desk tidies up.
  time.now = at(MON, '10:50');
  await assert.rejects(step(core, b.appointmentId, 'seen-no-times', { reason: 'Did not arrive' }), code('invalid-input'), 'it takes no reason');
  const r = await step(core, b.appointmentId, 'seen-no-times');
  assert.deepEqual([r.status, r.state, r.events.length], ['done', 'finished', 1]);
  assert.equal((await step(core, b.appointmentId, 'seen-no-times')).events.length, 0, 'a double tap writes nothing');
  await step(core, c.appointmentId, 'seen-no-times'); // called at a true time, finish not tapped
  const d = await derive(core);
  const B = d.appointments.get(b.appointmentId); const C = d.appointments.get(c.appointmentId);
  assert.deepEqual([B.state, B.noTimes, B.arrivedAt, B.calledAt, B.finishedAt, B.closedAt], ['finished', true, at(MON, '09:10'), null, null, at(MON, '10:50')]);
  assert.deepEqual([C.state, C.noTimes, C.calledAt, C.finishedAt], ['finished', true, at(MON, '09:50'), null]);
  // Waiting in clinic: patients 1 (10 min) and 3 (15 min) have a true call time; patient 2 is left out and counted.
  const w = slots.waitInClinic(d, { until: at(MON, '23:00') });
  assert.deepEqual([w.n, w.medianMinutes, w.leftOut], [2, 12.5, 1]);
  // Overrun: only patient 1 has a true finish (09:25, 55 minutes before the planned end). The tidy-up at 10:50 is not an overrun.
  assert.deepEqual(slots.overrun(d, { sessionId: s.sessionId }), { minutes: -55, leftOut: 2 });
  // Start: first true call 09:05 against 09:00.
  assert.equal(slots.firstCalledVsStart(d, { sessionId: s.sessionId }).minutes, 5);
  // Attendance: all three attended; none missed, none left.
  assert.equal(slots.noShowRate(d, { until: at(MON, '23:00') }).numerator, 0);
  assert.deepEqual(slots.leftBeforeSeen(d, { until: at(MON, '23:00') }), { value: 0, numerator: 0, denominator: 3 });
  assert.deepEqual(slots.noTimesCount(d, { sessionId: s.sessionId }), { noTimes: 2, attended: 3 });
  // The list shows it under its own words and with no made-up wait.
  const list = await run(core, 'ospeli_slots_appointments', { sessionId: s.sessionId }, 'receptionist');
  assert.deepEqual(list.appointments.map((x) => [x.stateName, x.noTimes, x.waitMinutes]), [['Finished', false, 10], ['Seen, no times', true, null], ['Seen, no times', true, 15]]);
  // And now the session can be marked held.
  assert.equal((await run(core, 'ospeli_slots_session_change', { sessionId: s.sessionId, change: 'held' }, 'ops-manager')).state, 'held');
});

test('a Finished tapped at its true time after the planned end still counts as an overrun; a booked patient cannot be "seen, no times"', async () => {
  const { core, time } = await site();
  const s = await clinic(core);
  const a = await book(core, { sessionId: s.sessionId, slotTime: '10:00', code: 'pc-00001' });
  const b = await book(core, { sessionId: s.sessionId, slotTime: '09:00', code: 'pc-00002' });
  time.now = at(MON, '10:30');
  await assert.rejects(step(core, b.appointmentId, 'seen-no-times'), (e) => code('conflict')(e) && /not been marked arrived/.test(e.message));
  await step(core, a.appointmentId, 'arrived'); await step(core, a.appointmentId, 'called');
  time.now = at(MON, '10:40'); await step(core, a.appointmentId, 'finished');
  assert.deepEqual(slots.overrun(await derive(core), { sessionId: s.sessionId }), { minutes: 20, leftOut: 0 });
});

test('start punctuality shows both: against the planned start, and against the later of the start and the first arrival', async () => {
  const { core, time } = await site();
  const s = await clinic(core);
  const a = await book(core, { sessionId: s.sessionId, slotTime: '09:00', code: 'pc-00001' });
  const b = await book(core, { sessionId: s.sessionId, slotTime: '09:20', code: 'pc-00002' });
  // The 09:00 patient never comes. The 09:20 patient arrives at 09:18 and is called at 09:22.
  time.now = at(MON, '09:18'); await step(core, b.appointmentId, 'arrived');
  time.now = at(MON, '09:22'); await step(core, b.appointmentId, 'called');
  assert.deepEqual(slots.firstCalledVsStart(await derive(core), { sessionId: s.sessionId }), { minutes: 22, minutesFromFirstArrival: 4, nobodyHereAtStart: true, leftOut: 0 });
  assert.equal(a.state, 'booked');
});

test('an older log replays as before: an appointment with no correction has an empty list and noTimes false', async () => {
  const { core, time } = await site();
  const s = await clinic(core);
  const a = await book(core, { sessionId: s.sessionId, slotTime: '09:00', code: 'pc-00001' });
  time.now = at(MON, '09:00'); await step(core, a.appointmentId, 'arrived');
  const x = await appt(core, a.appointmentId);
  assert.deepEqual([x.corrections, x.noTimes], [[], false]);
  // An undo that does not fit the record (an imported log) is ignored.
  await core.appendEvents([{ type: 'appointment.step-undone', subject: a.appointmentId, actorRole: 'receptionist', at: at(MON, '09:01'), data: { undo: 'no-show' } }], 'system', 'synthetic bad import');
  assert.equal((await appt(core, a.appointmentId)).state, 'arrived');
});
