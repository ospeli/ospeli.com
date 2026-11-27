// Finding 3: the ward gate for the shared task commands looks only at where a job starts
// (locationId). An agent listed for one ward can queue a proposal that sends a job into a ward it
// was not given, and into a ward where agent access is switched off.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Core } from '../../web/app/core/core.js';
import { MemoryAdapter } from '../../web/app/core/db.js';
import { loadHospital } from './hospital-clock.mjs';
import { runCommand } from '../../web/app/core/commands.js';

const END = '2026-11-06T18:00:00.000Z';
const human = (role) => ({ type: 'human', role });

test('an agent given ward A1 only cannot propose a job that goes into ward B2 (not on its list, agents off there)', async () => {
  let t = Date.parse(END);
  const core = await Core.open({ adapter: new MemoryAdapter(), clock: () => new Date(t += 1000) });
  await loadHospital(core, { end: END });
  const run = (name, input, who) => runCommand(core, name, input, typeof who === 'string' ? human(who) : who);
  await run('ospeli_agents_set_access', { allowed: true, wards: { 'ward-a1': true, 'ward-b2': false } }, 'coo');
  await run('ospeli_agents_add', { name: 'ward-bot', role: 'ward-nurse', wards: ['ward-a1'], days: 30 }, 'coo');
  const bot = { type: 'agent', role: 'ward-nurse', agent: 'ward-bot' };

  // The gate works for the place a job starts from ...
  await assert.rejects(() => run('ospeli_tasks_request', { kind: 'equipment-move', locationId: 'ward-b2', toLocationId: 'ward-a1', detail: 'Empty bed' }, bot), (e) => e.code === 'agents-off' || e.code === 'forbidden');
  // ... but not for the place it goes to.
  let answer;
  try { answer = (await run('ospeli_tasks_request', { kind: 'equipment-move', locationId: 'ward-a1', toLocationId: 'ward-b2', detail: 'Empty bed' }, bot)).status; } catch (e) { answer = e.code; }
  assert.notEqual(answer, 'proposed', 'a job into ward B2 is refused for an agent that was not given ward B2');
  assert.equal((await core.proposals()).length, 0, 'nothing about ward B2 waits in the proposal queue');
});

test('an agent given no ward at all, which the task list shows nothing, cannot queue a write on a job in a department', { todo: 'places outside a ward need their own grant: ospeli/ospeli#126' }, async () => {
  let t = Date.parse(END);
  const core = await Core.open({ adapter: new MemoryAdapter(), clock: () => new Date(t += 1000) });
  await loadHospital(core, { end: END });
  const run = (name, input, who) => runCommand(core, name, input, typeof who === 'string' ? human(who) : who);
  await run('ospeli_agents_set_access', { allowed: true }, 'coo');
  await run('ospeli_agents_add', { name: 'no-ward-bot', role: 'porter', wards: [], days: 30 }, 'coo');
  const bot = { type: 'agent', role: 'porter', agent: 'no-ward-bot' };
  const job = (await run('ospeli_tasks_list', { team: 'transport', limit: 500 }, 'coo')).tasks.find((x) => x.locationId.startsWith('dept-') && x.state === 'requested');
  assert.ok(job, 'the example hospital has a transport job waiting in a department');
  assert.equal((await run('ospeli_tasks_list', { limit: 500 }, bot)).total, 0, 'the agent is shown no job: it was given no ward');
  let answer;
  try { answer = (await run('ospeli_tasks_complete', { taskId: job.id }, bot)).status; } catch (e) { answer = e.code; }
  assert.notEqual(answer, 'proposed', 'a write on a job the agent may not even see is refused, not queued for a person');
});
