// Shared set-up for the slot object's rule tests (issues ospeli/ospeli#142 and #144): the same
// test pack and helpers as tests/unit/slots.test.mjs. Synthetic data only. Not a test file.
import assert from 'node:assert/strict';
import { Core } from '../../web/app/core/core.js';
import { MemoryAdapter } from '../../web/app/core/db.js';
import { loadSyntheticHospital } from '../../web/app/core/generator.js';
import { CommandError } from '../../web/app/core/commands.js';
import { validate } from '../../web/app/core/schema.js';
import * as slots from '../../web/app/core/slots.js';
import { slotCommands } from '../../web/app/core/slot-commands.js';

export { slots };
export const END = '2026-11-06T18:00:00.000Z'; // a Friday; the sessions are the next week
export const MON = '2026-11-09';
export const OFFSET = -240; // the example site is four hours behind UTC
export const at = (date, hhmm) => new Date(Date.parse(`${date}T${hhmm}:00.000Z`) - OFFSET * 60e3).toISOString();
export const code = (c) => (err) => err instanceof CommandError && err.code === c;
export const PACK = {
  id: 'testslots',
  SESSION_TYPES: [
    { id: 'test-clinic', word: 'Clinic', timed: true, placeTypes: ['department'],
      runByRoles: ['ops-manager'], planRoles: ['ops-manager'], bookRoles: ['receptionist', 'ops-manager'], stepRoles: ['receptionist'] },
    { id: 'test-round', word: 'Home-visit round', timed: false, placeTypes: ['site', 'department'], areas: ['North 1', 'North 2'],
      runByRoles: ['ward-nurse'], planRoles: ['ops-manager'], bookRoles: ['ops-manager'], stepRoles: ['ward-nurse'] },
  ],
  SLOT_TYPES: { 'test-new': 'New', 'test-follow-up': 'Follow-up' },
  NO_SHOW_GRACE_MINUTES: 15, // example setting, not a standard
};
export const CMDS = Object.fromEntries(slotCommands([PACK]).map((c) => [c.name, c]));
// Run a command the way the command layer does for a person: schema, then the role list, then the command.
export async function run(core, name, input, role) {
  const c = CMDS[name];
  assert.ok(c, `command ${name} exists`);
  const errs = validate(c.input, input);
  if (errs.length) throw new CommandError('invalid-input', errs.join('; '));
  if (!c.roles.includes(role)) throw new CommandError('forbidden', `${role} cannot run ${name}`);
  return c.run(core, input, { actor: { type: 'human', role }, wards: null });
}
export async function site() {
  const time = { now: END };
  const core = await Core.open({ adapter: new MemoryAdapter(), clock: () => new Date(time.now) });
  await loadSyntheticHospital(core, { end: END, modules: false });
  await core.appendEvents(['pc-00001', 'pc-00002', 'pc-00003', 'pc-00004'].map((c) => ({ type: 'code.opened', subject: c, actorRole: 'ops-manager', at: END, data: { service: 'test-service', placeId: 'dept-outpatients', source: 'referral' } })), 'system', 'synthetic test codes');
  return { core, time };
}
// A Monday clinic: 09:00 for 80 minutes in 20-minute slots, so 09:00, 09:20, 09:40 and 10:00; it ends at 10:20.
export const clinic = (core, extra = {}) => run(core, 'ospeli_slots_session_plan', { sessionType: 'test-clinic', placeId: 'dept-outpatients', date: MON, start: '09:00', minutes: 80, slotMinutes: 20, runByRole: 'ops-manager', ...extra }, 'ops-manager');
export const round = (core, capacity = 3) => run(core, 'ospeli_slots_session_plan', { sessionType: 'test-round', placeId: 'site-north', date: MON, start: '08:30', minutes: 240, capacity, runByRole: 'ward-nurse' }, 'ops-manager');
export const book = (core, input, role = 'receptionist') => run(core, 'ospeli_slots_book', { slotType: 'test-new', bookedFrom: 'referral', ...input }, role);
export const step = (core, appointmentId, s, extra = {}, role = 'receptionist') => run(core, 'ospeli_slots_step', { appointmentId, step: s, ...extra }, role);
export const correct = (core, appointmentId, undo, extra = {}, role = 'receptionist') => run(core, 'ospeli_slots_step_correct', { appointmentId, undo, ...extra }, role);
export const derive = async (core) => slots.deriveSlots(await core.events(), { packs: [PACK], offsetMinutes: OFFSET });
export const appt = async (core, id) => (await derive(core)).appointments.get(id);
export const settled = (p) => p.then((value) => ({ ok: true, value }), (error) => ({ ok: false, error }));
