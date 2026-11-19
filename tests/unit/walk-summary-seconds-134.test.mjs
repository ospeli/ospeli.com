// Issue ospeli/ospeli#134: on a map made from a walk, ospeli_maps_summary gave its totals in
// whole minutes per step, so a walk of short steps read as "0 minutes hands-on, 0%" while the
// person's screen said 2 min 48 s. The two biggest-wait fields in one answer also named
// different steps. The summary must carry the measured seconds the screen shows, and one answer
// must name one longest wait (or say it is a tie, as the screen does).
// Synthetic taps only; the clock is moved by hand.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Core } from '../../web/app/core/core.js';
import { MemoryAdapter } from '../../web/app/core/db.js';
import { runCommand, commandByName } from '../../web/app/core/commands.js';
import { validate } from '../../web/app/core/schema.js';

const START = '2026-11-16T09:00:00.000Z';
const human = { type: 'human', role: 'ops-manager' };
async function setup() {
  let t = Date.parse(START);
  const core = await Core.open({ adapter: new MemoryAdapter(), clock: () => new Date(t) });
  const tick = (s) => { t += s * 1000; };
  const tap = (name, input = {}) => runCommand(core, name, input, human);
  return { tick, tap };
}
const outputOk = (name, out) => assert.deepEqual(validate(commandByName(name).output, out, 'output'), []);

// The critic's walk: eight steps of 21 s, waits of 40 s, and 41 s before steps 4, 6, 7 and 8.
async function eightStepWalk() {
  const s = await setup();
  await s.tap('ospeli_walks_start', { title: 'Short steps', guidanceSeen: true });
  const waits = [40, 40, 40, 41, 40, 41, 41, 41];
  for (const [i, w] of waits.entries()) {
    s.tick(w); await s.tap('ospeli_walks_step_start');
    s.tick(21); await s.tap('ospeli_walks_step_done');
    await s.tap('ospeli_walks_step_name', { name: `Step ${i + 1}`, role: i % 2 ? 'Nurse' : 'Reception' });
  }
  const { mapId } = await s.tap('ospeli_walks_finish');
  return { ...s, mapId };
}

test('#134: the summary of a walked map gives the measured seconds the screen shows', async () => {
  const { tap, mapId } = await eightStepWalk();
  const map = await tap('ospeli_maps_get', { mapId, format: 'short' });
  const sum = await tap('ospeli_maps_summary', { mapId });
  outputOk('ospeli_maps_summary', sum);
  const screen = map.today.statsSec; // what the map screen draws its headline from
  assert.equal(screen.elapsed + screen.notSeenSec, 492, 'the screen: 8 min 12 s start to finish');
  assert.equal(sum.today.elapsedSec, 492, `start to finish: ${sum.today.elapsedSec} s, the screen says 492 s`);
  assert.equal(sum.today.waitSec, 324, 'waiting 5 min 24 s');
  assert.equal(sum.today.workSec, 168, `hands-on: ${sum.today.workSec} s, the screen says 168 s (minutes field: ${sum.today.work})`);
  assert.equal(sum.today.notSeenSec, 0);
  assert.equal(sum.today.plannedWaitSec, 0);
  assert.equal(sum.today.waitShare, 66, 'waiting as a % of the time seen, as on the screen');
  assert.equal(sum.today.workShare, 34, `workShare ${sum.today.workShare}%: hands-on is 168 of 492 s`);
  assert.equal(sum.difference.elapsedSec, 0, 'Proposed is still the same as Today');
});

test('#134: one answer names one longest wait, and says when it is a tie', async () => {
  const { tap, mapId } = await eightStepWalk();
  const sum = await tap('ospeli_maps_summary', { mapId });
  assert.equal(sum.biggestWait.waitSec, 41);
  assert.equal(sum.today.biggestWaitStepId, sum.biggestWait.stepId, `today.biggestWaitStepId ${sum.today.biggestWaitStepId} vs biggestWait.stepId ${sum.biggestWait.stepId}`);
  assert.equal(sum.biggestWait.name, 'Step 4');
  const names = await tap('ospeli_maps_get', { mapId });
  const idOf = (n) => names.today.steps.find((x) => x.name === n).id;
  assert.deepEqual(sum.biggestWait.tiedWith, [idOf('Step 6'), idOf('Step 7'), idOf('Step 8')]);
  assert.equal(sum.biggestWait.shareOfElapsed, 8, '41 of 492 s');
});

test('#134: a paused walk counts the time not seen inside start to finish only', async () => {
  const { tick, tap } = await setup();
  await tap('ospeli_walks_start', { guidanceSeen: true });
  tick(100); await tap('ospeli_walks_pause');
  tick(300); await tap('ospeli_walks_resume');
  tick(50); await tap('ospeli_walks_step_start');
  tick(90); await tap('ospeli_walks_step_done');
  await tap('ospeli_walks_step_name', { name: 'Seen by a nurse', role: 'Nurse' });
  const { mapId } = await tap('ospeli_walks_finish');
  const sum = await tap('ospeli_maps_summary', { mapId });
  outputOk('ospeli_maps_summary', sum);
  assert.equal(sum.today.elapsedSec, 540);
  assert.equal(sum.today.notSeenSec, 300);
  assert.equal(sum.today.waitSec, 150);
  assert.equal(sum.today.workSec, 90);
  assert.equal(sum.today.waitShare, 63, '150 of the 240 s seen');
  assert.equal(sum.today.workShare, 38, '90 of the 240 s seen');
});

test('#134: a drawn map keeps its minutes and gains no seconds fields', async () => {
  const { tap } = await setup();
  const { examples } = await tap('ospeli_maps_list');
  const made = await tap('ospeli_maps_create', { from: examples[0].from });
  const { mapId } = made;
  const sum = await tap('ospeli_maps_summary', { mapId });
  outputOk('ospeli_maps_summary', sum);
  assert.equal(sum.today.elapsedSec, undefined);
  assert.equal(sum.difference.elapsedSec, undefined);
  assert.equal(typeof sum.today.elapsed, 'number');
});
