// Walk mode integrity fixes (17 Nov 2026 audit): msg kept, double tap refused, clock moved back
// flagged, a short-wait floor on "Longest wait", and Reset clears walks. Synthetic taps only:
// every time below comes from a clock the test moves by hand; no real walk is ever read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Core } from '../../web/app/core/core.js';
import { MemoryAdapter } from '../../web/app/core/db.js';
import { runCommand, CommandError } from '../../web/app/core/commands.js';
import { newWalk, stepStart, stepDone, nameLast, clockMoved, suggestWalk, MIN_LONGEST_WAIT_SEC } from '../../web/app/core/walk.js';

const START = '2026-11-16T09:00:00.000Z';
const human = { type: 'human', role: 'ops-manager' };
const at = (s) => new Date(Date.parse(START) + s * 1000).toISOString();
async function setup() {
  let t = Date.parse(START);
  const core = await Core.open({ adapter: new MemoryAdapter(), clock: () => new Date(t) });
  const tick = (s) => { t += s * 1000; };
  const tap = (name, input = {}) => runCommand(core, name, input, human);
  return { core, tick, tap };
}

// 1. Naming a step in two calls keeps the "only passed on information" tick (#107).
test('nameLast: a second call that leaves msg out keeps the msg already saved', () => {
  const w = newWalk({ id: 'walk-001', title: 'Synthetic', at: at(0), role: 'ops-manager' });
  stepStart(w, at(5)); stepDone(w, at(10));
  nameLast(w, { name: 'Phoned the ward', msg: true });
  nameLast(w, { role: 'Reception' });
  assert.equal(w.steps[0].msg, true);
  nameLast(w, { msg: false });
  assert.equal(w.steps[0].msg, false, 'msg can still be cleared on purpose');
});

test('ospeli_walks_step_name: role-only second call keeps msg', async () => {
  const { tick, tap } = await setup();
  await tap('ospeli_walks_start', {});
  tick(5); await tap('ospeli_walks_step_start');
  tick(5); await tap('ospeli_walks_step_done');
  await tap('ospeli_walks_step_name', { name: 'Phoned the ward', msg: true });
  const out = await tap('ospeli_walks_step_name', { role: 'Reception' });
  assert.equal(out.walk.steps[0].msg, true);
});

// 2. A double tap does not save a 0-second step (#102).
test('stepDone refuses a tap under a second after the step started', () => {
  const w = newWalk({ id: 'walk-001', title: 'Synthetic', at: at(0), role: 'ops-manager' });
  stepStart(w, at(5));
  assert.throws(() => stepDone(w, at(5)), /less than a second/);
  assert.throws(() => stepDone(w, at(5.4)), /less than a second/);
  assert.equal(w.steps.length, 0); assert.ok(w.current, 'the step is still running');
  stepDone(w, at(6));
  assert.equal(w.steps.length, 1);
});

test('ospeli_walks_step_done at the same second as step_start is a conflict, not a step', async () => {
  const { tick, tap } = await setup();
  await tap('ospeli_walks_start', {});
  tick(5); await tap('ospeli_walks_step_start');
  await assert.rejects(tap('ospeli_walks_step_done'), (e) => e instanceof CommandError && e.code === 'conflict');
  tick(3); const out = await tap('ospeli_walks_step_done');
  assert.equal(out.walk.steps.length, 1); assert.equal(out.walk.steps[0].workSec, 3);
});

// 3. A device clock moving back mid-walk is flagged (#102).
test('clockMoved: false for a normal walk, true when a tap is earlier than the one before', () => {
  const w = newWalk({ id: 'walk-001', title: 'Synthetic', at: at(0), role: 'ops-manager' });
  stepStart(w, at(40)); stepDone(w, at(100));
  assert.equal(clockMoved(w), false);
  stepStart(w, at(-3500)); // the phone corrected its clock by an hour
  assert.equal(clockMoved(w), true);
});

test('a walk whose clock moved back says so on finish', async () => {
  const { tick, tap } = await setup();
  await tap('ospeli_walks_start', {});
  tick(40); await tap('ospeli_walks_step_start');
  tick(-3600);
  tick(60); await tap('ospeli_walks_step_done');
  tick(60); await tap('ospeli_walks_step_start');
  tick(60); await tap('ospeli_walks_step_done');
  const { walk } = await tap('ospeli_walks_finish');
  assert.equal(walk.clockMoved, true);
});

// 4. A short wait is not announced as "Longest wait on this walk" (#99).
test('suggestWalk names no longest wait under the floor, and does at or above it', () => {
  const step = (id, waitSec) => ({ id, name: `Seen ${id}`, role: 'Nurse', wait: 0, work: 1, waitSec, workSec: 60 });
  assert.equal(MIN_LONGEST_WAIT_SEC, 30);
  assert.ok(!suggestWalk([step('a', 3), step('b', 29)]).some((s) => s.id.startsWith('walk-wait-')));
  const out = suggestWalk([step('a', 3), step('b', 30)]);
  assert.match(out[0].title, /^Longest wait on this walk: 30 s before “Seen b”$/);
});

// 5. Reset device data leaves no walk on the phone.
test('reset clears walks as well as maps', async () => {
  const { core, tick, tap } = await setup();
  await tap('ospeli_walks_start', {});
  tick(5); await tap('ospeli_walks_step_start');
  tick(5); await tap('ospeli_walks_step_done');
  await tap('ospeli_walks_finish');
  assert.ok((await core.getMeta('process-walks', null))?.walks.length);
  await core.reset();
  assert.equal(await core.getMeta('process-walks', null), null);
  assert.equal(await core.getMeta('process-maps', null), null);
  assert.equal((await tap('ospeli_walks_get', {})).walk, null);
});
