// Finding 8: the same action sent twice (a double tap, or the form open in two tabs) is saved
// twice. Logging feedback refuses an identical record within 10 seconds; agreeing an action has
// no such check, so "Actions agreed" and the actions-closed-on-time measure count it twice.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Core } from '../../web/app/core/core.js';
import { MemoryAdapter } from '../../web/app/core/db.js';
import { loadSyntheticHospital } from '../../web/app/core/generator.js';
import { runCommand } from '../../web/app/core/commands.js';

const END = '2026-11-06T18:00:00.000Z';
const human = (role) => ({ type: 'human', role });

test('the same action agreed twice in a row, at once, is one action', async () => {
  let t = Date.parse(END);
  const core = await Core.open({ adapter: new MemoryAdapter(), clock: () => new Date(t += 1000) });
  await loadSyntheticHospital(core, { end: END });
  const run = (name, input, role) => runCommand(core, name, input, human(role));
  const made = await run('ospeli_experience_complaint_log', { kind: 'complaint', channel: 'letter', serviceId: 'dept-outpatients', theme: 'waiting' }, 'patient-liaison');
  const input = { op: 'agree', recordId: made.recordId, what: 'review', ownerRole: 'ward-nurse', dueInDays: 7 };
  // Two tabs send the same form at the same moment.
  await Promise.allSettled([run('ospeli_experience_action_set', input, 'patient-liaison'), run('ospeli_experience_action_set', input, 'patient-liaison')]);
  const rec = await run('ospeli_experience_record_get', { recordId: made.recordId }, 'patient-liaison');
  assert.equal(rec.actions.length, 1, 'one action is kept, as one record is kept when feedback is logged twice');
});
