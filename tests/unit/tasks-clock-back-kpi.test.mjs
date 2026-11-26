// Finding 7: a clock set back between "asked" and "done" gives a negative time in the KPI.
// taskTimes clamps a task's minutes at 0, completionStats (core/tasks.js) does not, so the job
// shows "0 min" in the list and drags the median below zero in "Transport request to completion".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Core } from '../../web/app/core/core.js';
import { MemoryAdapter } from '../../web/app/core/db.js';
import { loadHospital } from './hospital-clock.mjs';
import { runCommand } from '../../web/app/core/commands.js';

const END = '2026-11-06T18:00:00.000Z';
const human = (role) => ({ type: 'human', role });

test('a job finished after the device clock was set back never makes a measure negative', async () => {
  let t = Date.parse(END);
  const core = await Core.open({ adapter: new MemoryAdapter(), clock: () => new Date(t += 1000) });
  await loadHospital(core, { end: END });
  const run = (name, input, role) => runCommand(core, name, input, human(role));
  t += 3 * 864e5; // three quiet days later, so the one-day period below holds only this job
  const made = await run('ospeli_tasks_request', { kind: 'equipment-move', locationId: 'ward-a1', toLocationId: 'ward-b1', detail: 'Other equipment' }, 'ward-nurse');
  t -= 45 * 60e3; // the clock is corrected: set back 45 minutes
  await run('ospeli_tasks_complete', { taskId: made.taskId }, 'porter');
  t += 50 * 60e3;
  const job = (await run('ospeli_tasks_list', { state: 'completed', kind: 'equipment-move', limit: 1 }, 'coo')).tasks[0];
  assert.equal(job.id, made.taskId);
  assert.equal(job.totalMinutes, 0, 'the list shows the job as 0 minutes');
  const ov = await run('ospeli_support_overview', { days: 1 }, 'coo');
  const kpi = ov.kpis.find((k) => k.id === 'porter-request-to-done');
  const eq = kpi.breakdown.find((b) => b.id === 'equipment-move');
  assert.equal(eq.n, 1, 'only this job is in the period');
  assert.ok(eq.value >= 0, `Transport request to completion for equipment moves is ${eq.value} minutes: a time is never below zero`);
});
