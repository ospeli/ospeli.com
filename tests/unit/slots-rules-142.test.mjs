// Booking rules settled before the first module switches the slot object on (ospeli/ospeli#142,
// found by the security and audit run of 19 Nov 2026). The first four tests are the audit's own,
// seen red on app head 83e2f24. Synthetic data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slots, MON, at, code, run, site, clinic, round, book, step, derive, appt, CMDS } from './slots-helper.mjs';

test('a timed session that would run past midnight is refused with a plain reason, and so is its template', async () => {
  const { core } = await site();
  const n0 = await core.eventCount();
  await assert.rejects(clinic(core, { start: '22:00', minutes: 240, slotMinutes: 30 }),
    (e) => code('invalid-input')(e) && /midnight/.test(e.message) && e.detail?.latestEnd === '24:00');
  await assert.rejects(run(core, 'ospeli_slots_template_set', { sessionType: 'test-clinic', placeId: 'dept-outpatients', weekday: 1, start: '22:00', minutes: 240, slotMinutes: 30, slotTypes: ['test-new'], released: true, from: MON }, 'ops-manager'),
    (e) => code('invalid-input')(e) && /midnight/.test(e.message));
  assert.equal(await core.eventCount(), n0, 'nothing written');
  // An evening clinic that ends at midnight exactly is planned, with every slot it asked for.
  const s = await clinic(core, { start: '22:00', minutes: 120, slotMinutes: 30 });
  assert.deepEqual(slots.slotTimes((await derive(core)).sessions.get(s.sessionId)), ['22:00', '22:30', '23:00', '23:30']);
  // A round has a capacity and no slot times, so it may run past midnight.
  const r = await run(core, 'ospeli_slots_session_plan', { sessionType: 'test-round', placeId: 'site-north', date: MON, start: '22:00', minutes: 240, capacity: 3, runByRole: 'ward-nurse' }, 'ops-manager');
  assert.equal(r.status, 'done');
});

test('a booking moved into a slot already past cannot at once be a missed appointment: the grace counts from the move', async () => {
  const { core, time } = await site();
  const s = await clinic(core);
  const a = await book(core, { sessionId: s.sessionId, slotTime: '10:00', code: 'pc-00001' });
  time.now = at(MON, '09:30');
  await run(core, 'ospeli_slots_move', { appointmentId: a.appointmentId, sessionId: s.sessionId, slotTime: '09:00' }, 'receptionist');
  await assert.rejects(step(core, a.appointmentId, 'no-show', { reason: 'Did not arrive' }),
    (e) => code('conflict')(e) && e.detail?.from === at(MON, '09:45'), 'refused, and the answer says from when it is allowed');
  const list = await run(core, 'ospeli_slots_appointments', { sessionId: s.sessionId }, 'receptionist');
  assert.equal(list.appointments[0].overdue, false, 'not shown as overdue either');
  assert.equal(list.appointments[0].noShowFrom, at(MON, '09:45'));
  time.now = at(MON, '09:45');
  assert.equal((await step(core, a.appointmentId, 'no-show', { reason: 'Did not arrive' })).state, 'no-show');
});

test('a booking made into a slot already past gets the same grace, from the booking', async () => {
  const { core, time } = await site();
  const s = await clinic(core);
  time.now = at(MON, '09:50');
  const a = await book(core, { sessionId: s.sessionId, slotTime: '09:20', code: 'pc-00001', bookedFrom: 'walk-in' });
  await assert.rejects(step(core, a.appointmentId, 'no-show', { reason: 'Did not arrive' }), code('conflict'));
  time.now = at(MON, '10:05');
  assert.equal((await step(core, a.appointmentId, 'no-show', { reason: 'Did not arrive' })).state, 'no-show');
});

test('a booking made ahead keeps the grace from its slot time', async () => {
  const { core, time } = await site();
  const s = await clinic(core);
  const a = await book(core, { sessionId: s.sessionId, slotTime: '09:00', code: 'pc-00001' });
  time.now = at(MON, '09:14');
  await assert.rejects(step(core, a.appointmentId, 'no-show', { reason: 'Did not arrive' }), code('conflict'));
  time.now = at(MON, '09:15');
  assert.equal((await step(core, a.appointmentId, 'no-show', { reason: 'Did not arrive' })).state, 'no-show');
});

test('a session cannot be marked held while a booking has no final state; the refusal lists each one and what can be done', async () => {
  const { core, time } = await site();
  const s = await clinic(core);
  const a = await book(core, { sessionId: s.sessionId, slotTime: '09:00', code: 'pc-00001' });
  const b = await book(core, { sessionId: s.sessionId, slotTime: '09:20', code: 'pc-00002' });
  time.now = at(MON, '09:21');
  await step(core, b.appointmentId, 'arrived');
  time.now = at(MON, '12:00');
  const n0 = await core.eventCount();
  await assert.rejects(run(core, 'ospeli_slots_session_change', { sessionId: s.sessionId, change: 'held' }, 'ops-manager'), (e) => {
    assert.ok(code('conflict')(e));
    assert.deepEqual(e.detail.open, [{ appointmentId: a.appointmentId, code: 'pc-00001', state: 'booked', can: ['no-show', 'cancel'] }, { appointmentId: b.appointmentId, code: 'pc-00002', state: 'arrived', can: ['seen-no-times', 'left'] }]);
    assert.match(e.message, /2 patients in this session have no final status/);
    return true;
  });
  assert.equal(await core.eventCount(), n0);
  await step(core, a.appointmentId, 'no-show', { reason: 'Did not arrive' });
  await step(core, b.appointmentId, 'seen-no-times');
  assert.equal((await run(core, 'ospeli_slots_session_change', { sessionId: s.sessionId, change: 'held' }, 'ops-manager')).state, 'held');
  const u = slots.utilisation(await derive(core), { until: at(MON, '23:00') });
  assert.deepEqual([u.numerator, u.denominator], [2, 4]);
});

test('a place in the visit order is from 1 to the capacity the round was planned with', async () => {
  const { core } = await site();
  const s = await round(core, 3);
  await assert.rejects(book(core, { sessionId: s.sessionId, visitOrder: 150, area: 'North 1', code: 'pc-00001' }, 'ops-manager'),
    (e) => code('invalid-input')(e) && e.detail?.places === 3, 'visit order 150 in a round of 3');
  const a = await book(core, { sessionId: s.sessionId, visitOrder: 3, area: 'North 1', code: 'pc-00001' }, 'ops-manager');
  await assert.rejects(run(core, 'ospeli_slots_move', { appointmentId: a.appointmentId, sessionId: s.sessionId, visitOrder: 4 }, 'ops-manager'), code('invalid-input'));
  // A round made smaller keeps the places it was planned with, so nobody already booked at place 3 is stranded.
  await run(core, 'ospeli_slots_session_change', { sessionId: s.sessionId, change: 'reduced', capacity: 2, reason: slots.SESSION_CHANGE_REASONS[0] }, 'ops-manager');
  assert.equal((await run(core, 'ospeli_slots_move', { appointmentId: a.appointmentId, sessionId: s.sessionId, visitOrder: 2 }, 'ops-manager')).status, 'done');
  assert.match(CMDS.ospeli_slots_book.input.properties.visitOrder.description, /from 1 to the capacity the session was planned with/);
});
