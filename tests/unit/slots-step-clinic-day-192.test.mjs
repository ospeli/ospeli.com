// The slot object (ospeli/ospeli#192 point 4, after #163): Arrived and Call in record a moment at the
// desk, so they are marked on the session's own day (the site's date) only. Before #192 the command
// took them for any day, so the clinic queue's "look ahead / look back, read only" was read-only on
// screen only. Closing out after the day (Finished late, Seen no times, a missed appointment) stays
// open until the session is marked held. Synthetic data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MON, at, code, site, clinic, book, step, appt } from './slots-helper.mjs';

const TUE = '2026-11-10';
const subjectEvents = async (core, id) => (await core.events()).filter((e) => e.subject === id).length;

test('#192: Arrived is refused before the session\'s day, and nothing is written', async () => {
  const { core } = await site(); // the clock is Friday 6 Nov; the clinic is Monday 9 Nov
  const s = await clinic(core);
  const a = await book(core, { sessionId: s.sessionId, slotTime: '09:00', code: 'pc-00001' });
  const before = await subjectEvents(core, a.appointmentId);
  await assert.rejects(step(core, a.appointmentId, 'arrived'), (err) => code('conflict')(err) && err.detail?.date === MON && /own day/.test(err.message));
  assert.equal(await subjectEvents(core, a.appointmentId), before);
  assert.equal((await appt(core, a.appointmentId)).state, 'booked');
});

test('#192: Arrived and Call in are refused after the session\'s day; the close-out steps still work', async () => {
  const { core, time } = await site();
  const s = await clinic(core);
  const a = await book(core, { sessionId: s.sessionId, slotTime: '09:00', code: 'pc-00001' });
  const b = await book(core, { sessionId: s.sessionId, slotTime: '09:20', code: 'pc-00002' });
  const c = await book(core, { sessionId: s.sessionId, slotTime: '09:40', code: 'pc-00003' });
  const d = await book(core, { sessionId: s.sessionId, slotTime: '10:00', code: 'pc-00004' });
  time.now = at(MON, '08:55'); await step(core, a.appointmentId, 'arrived');
  time.now = at(MON, '09:10'); await step(core, b.appointmentId, 'arrived');
  time.now = at(MON, '09:15'); await step(core, b.appointmentId, 'called');
  time.now = at(TUE, '08:30');
  await assert.rejects(step(core, c.appointmentId, 'arrived'), (err) => code('conflict')(err) && err.detail?.date === MON);
  await assert.rejects(step(core, a.appointmentId, 'called'), (err) => code('conflict')(err) && err.detail?.date === MON);
  // Close-out after the day, as the clinic day screen does it.
  assert.equal((await step(core, a.appointmentId, 'seen-no-times')).state, 'finished');
  assert.equal((await step(core, b.appointmentId, 'finished')).state, 'finished');
  assert.equal((await step(core, c.appointmentId, 'no-show', { reason: 'Did not arrive' })).state, 'no-show');
  // The same step sent again still answers done, whatever the day.
  assert.equal((await step(core, b.appointmentId, 'finished')).events.length, 0);
  assert.equal((await appt(core, d.appointmentId)).state, 'booked');
});
