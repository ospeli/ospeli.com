// Finding 1: "Do this next" sticks to a bed. A bed clean's task id is clean-<bed id>, so it is the
// same for every clean of that bed. queueMarks (support/logic.js) never forgets a mark when a
// clean ends, so the NEXT clean of the bed is shown as "do-next" although nobody moved it up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Core } from '../../web/app/core/core.js';
import { MemoryAdapter } from '../../web/app/core/db.js';
import { loadHospital } from './hospital-clock.mjs';
import { runCommand } from '../../web/app/core/commands.js';
import { queueMarks } from '../../web/app/modules/support/logic.js';

const END = '2026-11-06T18:00:00.000Z';
const human = (role) => ({ type: 'human', role });

test('a bed clean moved to the front and then done leaves no "do-next" mark on the next clean of the same bed', async () => {
  let t = Date.parse(END);
  const core = await Core.open({ adapter: new MemoryAdapter(), clock: () => new Date(t += 1000) });
  await loadHospital(core, { end: END });
  const run = (name, input, role) => runCommand(core, name, input, human(role));
  const board = await run('ospeli_beds_board', {}, 'bed-manager');
  const bed = board.beds.find((b) => b.state === 'occupied');
  const taskId = `clean-${bed.id}`;

  // First clean: vacated, a supervisor says "do this next", the cleaner finishes it.
  await run('ospeli_beds_mark_vacated', { bedId: bed.id }, 'ward-nurse');
  await run('ospeli_tasks_set_priority', { taskId, priority: 'urgent' }, 'support-supervisor');
  await run('ospeli_tasks_complete', { taskId }, 'cleaner');
  // The bed is used again and vacated again: a new clean, which nobody has moved up.
  const waiting = (await run('ospeli_beds_board', {}, 'bed-manager')).waiting.find((w) => !w.allocatedBed);
  await run('ospeli_beds_allocate', { bedId: bed.id, encounter: waiting.encounter }, 'bed-manager');
  await run('ospeli_beds_admit', { bedId: bed.id }, 'ward-nurse');
  await run('ospeli_beds_mark_vacated', { bedId: bed.id }, 'ward-nurse');

  const list = await run('ospeli_tasks_list', { locationId: bed.id }, 'support-supervisor');
  const clean = list.tasks.find((x) => x.id === taskId);
  assert.equal(clean.priority, 'routine', 'the new clean is routine: nobody moved it up');
  const ov = await run('ospeli_support_overview', {}, 'support-supervisor');
  assert.equal(ov.marks[taskId], undefined, 'the new clean of the bed carries no mark from the last clean');
  // The screen reads the mark and offers "Undo: back to its place", which sends priority routine.
  assert.equal(queueMarks(await core.events()).get(taskId), undefined);
});
