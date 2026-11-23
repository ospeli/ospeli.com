// Walk-first week, Builder night 1 (ospeli/ospeli docs/briefs/2026-11-22-walk-first.md, part b).
// A step that was interrupted and then carried on is ONE step. Before this, the second half was
// saved as a second step, so the map's list held the step twice and every later tap of a repeat
// walk was filed one place too early ("Recovery" timed as the second "Scan"). Every figure below
// is worked out by hand from the taps the test makes; the commands run with no screen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Core } from '../../web/app/core/core.js';
import { MemoryAdapter } from '../../web/app/core/db.js';
import { runCommand } from '../../web/app/core/commands.js';

const human = { type: 'human', role: 'radiographer' };
const code = (c) => (err) => err.code === c;
async function setup(start = '2026-11-16T09:00:00.000Z') {
  let t = Date.parse(start);
  const core = await Core.open({ adapter: new MemoryAdapter(), clock: () => new Date(t) });
  const tick = (s) => { t += s * 1000; };
  const at = (iso) => { t = Date.parse(iso); };
  const tap = (name, input = {}) => runCommand(core, name, input, human);
  const step = async (wait, work) => { tick(wait); await tap('ospeli_walks_step_start'); tick(work); return tap('ospeli_walks_step_done'); };
  return { core, tick, at, tap, step };
}
const SIX = [['Arrived', 'Patient'], ['Registered', 'Reception'], ['Safety questions', 'Radiographer'], ['Scan', 'Radiographer'], ['Recovery', 'Radiology nurse'], ['Left', 'Patient']];

// Walk 1: six steps, each after a 60 s wait and 120 s long, but step 4 (Scan) is interrupted after
// 120 s, stands still for 300 s and then carries on for 180 s more.
async function walkOne(x) {
  await x.tap('ospeli_walks_start', { title: 'Outpatient CT', guidanceSeen: true });
  for (let i = 0; i < 6; i++) {
    if (i !== 3) { await x.step(60, 120); await x.tap('ospeli_walks_step_name', { name: SIX[i][0], role: SIX[i][1] }); continue; }
    x.tick(60); await x.tap('ospeli_walks_step_start'); x.tick(120);
    await x.tap('ospeli_walks_step_done', { interrupted: true });
    await x.tap('ospeli_walks_step_name', { name: 'Scan', role: 'Radiographer' });
    x.tick(300);
    // The person taps the main button again: by default it is the same step carrying on.
    const back = await x.tap('ospeli_walks_step_start', { resume: true });
    assert.equal(back.walk.state, 'step');
    assert.equal(back.walk.steps.length, 3, 'the interrupted step is running again, not saved twice');
    x.tick(180); await x.tap('ospeli_walks_step_done');
  }
  return x.tap('ospeli_walks_finish');
}

test('a step interrupted and carried on is one step: its stopped time is waiting, and the interruption is counted', async () => {
  const x = await setup();
  const done = await walkOne(x);
  const steps = done.walk.steps;
  assert.deepEqual(steps.map((s) => s.name), SIX.map((s) => s[0]), 'six steps, each once');
  const scan = steps[3];
  // Hands-on 120 + 180 = 300 s. Waiting: 60 s before it and 300 s while it stood still.
  assert.equal(scan.workSec, 300);
  assert.equal(scan.waitSec, 360);
  assert.equal(scan.interruptedWaitSec, 300);
  assert.equal(scan.interruptions, 1);
  assert.equal(scan.named, true, 'the name given at the interruption is kept');
  assert.ok(!scan.interrupted, 'the step was finished in the end');
  // The parts add up: waiting 6 x 60 + 300 = 660, hands-on 5 x 120 + 300 = 900, start to finish 1560.
  assert.deepEqual({ wait: done.walk.totals.waitSec, work: done.walk.totals.workSec, all: done.walk.totals.elapsedSec, stops: done.walk.totals.interruptions }, { wait: 660, work: 900, all: 1560, stops: 1 });
  const m = await x.tap('ospeli_maps_get', { mapId: done.mapId });
  assert.equal(m.today.steps.length, 6);
  assert.deepEqual([m.today.steps[3].waitSec, m.today.steps[3].workSec, m.today.steps[3].interruptedWaitSec, m.today.steps[3].interruptions], [360, 300, 300, 1]);
  assert.equal(m.today.statsSec.startToFinish, 1560);
});

test('repeat walk after an interruption on step 4: every tap of walk 2 is filed under its own step', async () => {
  const x = await setup();
  const { mapId } = await walkOne(x);
  x.at('2026-11-18T14:00:00.000Z');
  const started = await x.tap('ospeli_walks_start', { mapId, guidanceSeen: true });
  assert.deepEqual(started.walk.repeat.list.map((s) => s.name), SIX.map((s) => s[0]), 'the saved list holds Scan once');
  // Walk 2: six plain steps with hands-on times 10, 20, 30, 40, 50, 60 s, so each is known by its time.
  for (let i = 0; i < 6; i++) await x.step(60, 10 * (i + 1));
  const done = await x.tap('ospeli_walks_finish');
  assert.deepEqual(done.walk.steps.map((s) => [s.name, s.workSec]), SIX.map((s, i) => [s[0], 10 * (i + 1)]));
  assert.deepEqual(done.walk.repeat.left, [], 'nothing on the list was left untimed');
  const m = await x.tap('ospeli_maps_get', { mapId });
  assert.equal(m.range.count, 2);
  assert.deepEqual(m.range.steps.map((s) => [s.happened, s.work.max, s.work.min]), [[2, 120, 10], [2, 120, 20], [2, 120, 30], [2, 300, 40], [2, 120, 50], [2, 120, 60]]);
});

test('on a repeat walk an interrupted list step carries on as the same list step, twice over, and can be undone', async () => {
  const x = await setup();
  const { mapId } = await walkOne(x);
  x.at('2026-11-19T10:00:00.000Z');
  await x.tap('ospeli_walks_start', { mapId, guidanceSeen: true });
  for (let i = 0; i < 3; i++) await x.step(60, 30);
  x.tick(60); await x.tap('ospeli_walks_step_start'); x.tick(100);
  let w = (await x.tap('ospeli_walks_step_done', { interrupted: true })).walk;
  assert.equal(w.canResume, true);
  assert.equal(w.repeat.next.name, 'Recovery', 'the list has moved on, as before');
  x.tick(40);
  w = (await x.tap('ospeli_walks_step_start', { resume: true })).walk;
  assert.equal(w.repeat.now.name, 'Scan', 'the same list step is running again');
  assert.equal(w.canResume, false);
  // Undo the coming back: the step is interrupted again, exactly as it was.
  w = (await x.tap('ospeli_walks_undo')).walk;
  assert.deepEqual([w.state, w.steps.length, w.steps[3].interrupted, w.steps[3].workSec, w.canResume], ['waiting', 4, true, 100, true]);
  x.tick(20);
  await x.tap('ospeli_walks_step_start', { resume: true }); x.tick(50);
  await x.tap('ospeli_walks_step_done', { interrupted: true }); x.tick(30);
  await x.tap('ospeli_walks_step_start', { resume: true }); x.tick(25);
  w = (await x.tap('ospeli_walks_step_done')).walk;
  // Hands-on 100 + 50 + 25 = 175 s; stood still 60 s and 30 s; waiting before it 60 s.
  assert.deepEqual([w.steps[3].name, w.steps[3].listStep, w.steps[3].workSec, w.steps[3].interruptedWaitSec, w.steps[3].waitSec, w.steps[3].interruptions], ['Scan', 4, 175, 90, 150, 2]);
  assert.equal(w.repeat.next.name, 'Recovery');
});

test('a new step after an interruption is still possible, and resume is refused when nothing was interrupted', async () => {
  const x = await setup();
  await x.tap('ospeli_walks_start', { guidanceSeen: true });
  await assert.rejects(x.tap('ospeli_walks_step_start', { resume: true }), code('conflict'));
  await x.step(10, 20);
  await assert.rejects(x.tap('ospeli_walks_step_start', { resume: true }), code('conflict'), 'the last step was finished, not interrupted');
  x.tick(10); await x.tap('ospeli_walks_step_start'); x.tick(20);
  await x.tap('ospeli_walks_step_done', { interrupted: true }); x.tick(15);
  // "No, new step": the interrupted step stays as it was and a new one starts.
  const w = (await x.tap('ospeli_walks_step_start')).walk;
  assert.deepEqual([w.state, w.steps.length, w.steps[1].interrupted, w.steps[1].interruptions], ['step', 2, true, 1]);
  // A pause between the interruption and the coming back is not seen, and is not counted as waiting.
  x.tick(20); await x.tap('ospeli_walks_step_done', { interrupted: true }); x.tick(10);
  await x.tap('ospeli_walks_pause'); x.tick(100); await x.tap('ospeli_walks_resume'); x.tick(5);
  await x.tap('ospeli_walks_step_start', { resume: true }); x.tick(30);
  const end = (await x.tap('ospeli_walks_step_done')).walk;
  const s = end.steps[2];
  assert.deepEqual([s.workSec, s.interruptedWaitSec, s.workNotSeenSec, s.interruptions], [50, 15, 100, 1]);
  assert.equal(end.totals.waitSec + end.totals.workSec + end.totals.notSeenSec, end.totals.elapsedSec, 'waiting, hands-on and not seen add up to start to finish');
});
