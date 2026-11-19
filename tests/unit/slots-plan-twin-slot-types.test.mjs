import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Core } from '../../web/app/core/core.js';
import { MemoryAdapter } from '../../web/app/core/db.js';
import { loadSyntheticHospital } from '../../web/app/core/generator.js';
import { CommandError } from '../../web/app/core/commands.js';
import { validate } from '../../web/app/core/schema.js';
import * as slots from '../../web/app/core/slots.js';
import { slotCommands } from '../../web/app/core/slot-commands.js';

// Synthetic data only. The same test pack and helpers as tests/unit/slots.test.mjs.
const END = '2026-11-06T18:00:00.000Z';
const MON = '2026-11-09';
const OFFSET = -240; // the example site is four hours behind UTC
const at = (date, hhmm) => new Date(Date.parse(`${date}T${hhmm}:00.000Z`) - OFFSET * 60e3).toISOString();
const code = (c) => (err) => err instanceof CommandError && err.code === c;
const PACK = {
  id: 'testslots',
  SESSION_TYPES: [
    { id: 'test-clinic', word: 'Clinic', timed: true, placeTypes: ['department'],
      runByRoles: ['ops-manager'], planRoles: ['ops-manager'], bookRoles: ['receptionist', 'ops-manager'], stepRoles: ['receptionist'] },
    { id: 'test-round', word: 'Home-visit round', timed: false, placeTypes: ['site', 'department'], areas: ['North 1', 'North 2'],
      runByRoles: ['ward-nurse'], planRoles: ['ops-manager'], bookRoles: ['ops-manager'], stepRoles: ['ward-nurse'] },
  ],
  SLOT_TYPES: { 'test-new': 'New', 'test-follow-up': 'Follow-up' },
  NO_SHOW_GRACE_MINUTES: 15,
};
const CMDS = Object.fromEntries(slotCommands([PACK]).map((c) => [c.name, c]));
async function run(core, name, input, role) {
  const c = CMDS[name];
  const errs = validate(c.input, input);
  if (errs.length) throw new CommandError('invalid-input', errs.join('; '));
  if (!c.roles.includes(role)) throw new CommandError('forbidden', `${role} cannot run ${name}`);
  return c.run(core, input, { actor: { type: 'human', role }, wards: null });
}
async function site() {
  const time = { now: END };
  const core = await Core.open({ adapter: new MemoryAdapter(), clock: () => new Date(time.now) });
  await loadSyntheticHospital(core, { end: END });
  await core.appendEvents(['pc-00001', 'pc-00002'].map((c) => ({ type: 'code.opened', subject: c, actorRole: 'ops-manager', at: END, data: { service: 'test-service', placeId: 'dept-outpatients', source: 'referral' } })), 'system', 'synthetic test codes');
  return { core, time };
}
const clinic = (core, extra = {}) => run(core, 'ospeli_slots_session_plan', { sessionType: 'test-clinic', placeId: 'dept-outpatients', date: MON, start: '09:00', minutes: 80, slotMinutes: 20, runByRole: 'ops-manager', ...extra }, 'ops-manager');
const round = (core, capacity = 3) => run(core, 'ospeli_slots_session_plan', { sessionType: 'test-round', placeId: 'site-north', date: MON, start: '08:30', minutes: 240, capacity, runByRole: 'ward-nurse' }, 'ops-manager');
const book = (core, input, role = 'receptionist') => run(core, 'ospeli_slots_book', { slotType: 'test-new', bookedFrom: 'referral', ...input }, role);
const derive = async (core) => slots.deriveSlots(await core.events(), { packs: [PACK], offsetMinutes: OFFSET });
const settled = (p) => p.then((value) => ({ ok: true, value }), (error) => ({ ok: false, error }));

// Planning a session at the same type, place, date and start as one that exists answers "done" with
// the first one's id when the minutes match, even when the second plan asks for different slot
// types: a planner who asks for a follow-up-only clinic is told done and gets the new-only clinic.
// The twin check compares minutes, runByRole, slotMinutes and capacity, not slotTypes
// (slot-commands.js line 208). Correct: a conflict naming the existing session, as for other differences.
test('planning the same session again with other slot types is a conflict, not a silent done', async () => {
  const { core } = await site();
  const first = await clinic(core, { slotTypes: ['test-new'] });
  await assert.rejects(clinic(core, { slotTypes: ['test-follow-up'] }), (e) => code('conflict')(e) && e.detail?.existing === first.sessionId);
  const s = (await derive(core)).sessions.get(first.sessionId);
  assert.deepEqual(s.slotTypes, ['test-new']);
});
