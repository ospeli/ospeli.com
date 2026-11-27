// Review 21 Nov: ospeli_slots_cancel lost its `target` (it sits inside a line comment in
// slot-commands.js), so the one-open-proposal-per-appointment rule (#72) no longer applies to it.
// Synthetic data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Core } from '../../web/app/core/core.js';
import { MemoryAdapter } from '../../web/app/core/db.js';
import { loadHospital } from './hospital-clock.mjs';
import { runCommand, commandByName, CommandError } from '../../web/app/core/commands.js';

const TUE = '2026-11-10T14:00:00.000Z';

test('ospeli_slots_cancel names its appointment as the proposal target, like move and step', () => {
  assert.equal(typeof commandByName('ospeli_slots_cancel').target, 'function', 'ospeli_slots_cancel has a target (the appointment)');
});

test('an agent cannot queue two different cancel proposals for the same appointment', async () => {
  let t = Date.parse(TUE);
  const core = await Core.open({ adapter: new MemoryAdapter(), clock: () => new Date((t += 1000)) });
  await loadHospital(core, { end: TUE, modules: true });
  const human = (role) => ({ type: 'human', role });
  const wards = (await core.listEntities('ward')).map((w) => w.id);
  await runCommand(core, 'ospeli_agents_set_access', { allowed: true, wards: Object.fromEntries(wards.map((w) => [w, true])) }, human('coo'));
  await runCommand(core, 'ospeli_agents_add', { name: 'clinic-bot', role: 'booking-clerk', wards, days: 30 }, human('coo'));
  const bot = { type: 'agent', role: 'booking-clerk', agent: 'clinic-bot' };
  const q = await runCommand(core, 'ospeli_clinics_queue', {}, human('booking-clerk'));
  const booked = q.patients.find((p) => p.state === 'booked');
  assert.ok(booked, 'a booked appointment today');
  const first = await runCommand(core, 'ospeli_slots_cancel', { appointmentId: booked.appointmentId, by: 'site', reason: 'Booked in error' }, bot);
  assert.equal(first.status, 'proposed');
  let second = null; let err = null;
  try { second = await runCommand(core, 'ospeli_slots_cancel', { appointmentId: booked.appointmentId, by: 'patient', reason: 'Patient asked to cancel' }, bot); } catch (e) { err = e; }
  assert.ok(err instanceof CommandError && err.code === 'conflict' && err.reason === 'duplicate',
    `a second cancel proposal for the same appointment is refused as a duplicate (got ${second ? second.status + ' ' + second.proposal?.id : err?.code})`);
});
