// The tap-through walk sheet (walk-first week, Builder nights 4 to 6) and where a name came from
// (#170 point 1), without the screen: every tap is a command.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './walk-177-helper.mjs';

const start = async (x, department = 'imaging') => x.tap('ospeli_walks_start', { guidanceSeen: true, department });

test('a first walk in a department with a list gives the list, and the step offered next is never forced', async () => {
  const x = await setup();
  const w0 = (await start(x)).walk;
  assert.deepEqual(w0.list.map((p) => p.name).slice(0, 3), ['Arrived', 'Registered', 'Safety questions']);
  assert.deepEqual(w0.list.filter((p) => p.state === 'next').map((p) => p.n), [1]);
  assert.ok(w0.list.at(-1).afterVisit, 'the step after the visit is on the list and marked');
  // The person starts step 3 first: out of order, their own choice.
  x.tick(30);
  const w1 = (await x.tap('ospeli_walks_step_start', { listStep: 3, picked: true })).walk;
  assert.equal(w1.list[2].state, 'running'); assert.equal(w1.running.name, 'Safety questions');
  x.tick(60);
  const w2 = (await x.tap('ospeli_walks_step_done')).walk;
  assert.deepEqual([w2.steps[0].name, w2.steps[0].role, w2.steps[0].named], ['Safety questions', 'Imaging staff', true]);
  assert.deepEqual([w2.steps[0].nameFrom, w2.steps[0].roleFrom], ['chosen', 'list'], 'a tapped row confirms the name only, never the role');
  assert.deepEqual([w2.steps[0].waitSec, w2.steps[0].workSec], [30, 60]);
  // Steps 1 and 2 were not seen: they stay untimed, with no time of their own, and step 4 is offered next.
  assert.deepEqual(w2.list.map((p) => p.state).slice(0, 4), ['later', 'later', 'timed', 'next']);
  assert.equal(w2.list[0].workSec, undefined);
  assert.equal(w2.suggest, null, 'a step named as it started is not offered a name again');
});

test('the step offered next, started from the main button, is kept as "from the list": not confirmed', async () => {
  const x = await setup();
  await start(x); x.tick(10);
  await x.tap('ospeli_walks_step_start', { listStep: 1 }); x.tick(20);
  const w = (await x.tap('ospeli_walks_step_done')).walk;
  assert.deepEqual([w.steps[0].name, w.steps[0].nameFrom, w.steps[0].roleFrom], ['Arrived', 'list', 'list']);
  // The person then chooses the role themselves: the role is theirs, the name is still the list's.
  const w2 = (await x.tap('ospeli_walks_step_name', { role: 'Reception', roleFrom: 'chosen' })).walk;
  assert.deepEqual([w2.steps[0].role, w2.steps[0].nameFrom, w2.steps[0].roleFrom], ['Reception', 'list', 'chosen']);
  // The finished map and its record keep both.
  x.tick(5);
  const { mapId } = await x.tap('ospeli_walks_finish');
  const m = await x.tap('ospeli_maps_get', { mapId });
  assert.deepEqual([m.today.steps[0].nameFrom, m.today.steps[0].roleFrom], ['list', 'chosen']);
});

test('undo of "Step done" keeps the name of a step named as it started; undo of its start takes it all back', async () => {
  const x = await setup();
  await start(x); x.tick(10);
  await x.tap('ospeli_walks_step_start', { listStep: 2, picked: true }); x.tick(20);
  await x.tap('ospeli_walks_step_done');
  const u = (await x.tap('ospeli_walks_undo')).walk;
  assert.equal(u.state, 'step'); assert.equal(u.running.name, 'Registered');
  x.tick(20);
  const w = (await x.tap('ospeli_walks_step_done')).walk;
  assert.deepEqual([w.steps[0].name, w.steps[0].nameFrom, w.steps[0].workSec], ['Registered', 'chosen', 40]);
  x.tick(10); await x.tap('ospeli_walks_step_start', { listStep: 3 });
  const u2 = (await x.tap('ospeli_walks_undo')).walk;
  assert.equal(u2.state, 'waiting'); assert.equal(u2.steps.length, 1); assert.equal(u2.list[2].state, 'next');
});

test('a list step timed a second time is its own step, marked done again, and the mark can be taken away', async () => {
  const x = await setup();
  await start(x); x.tick(10);
  await x.tap('ospeli_walks_step_start', { listStep: 2 }); x.tick(60); await x.tap('ospeli_walks_step_done');
  x.tick(30); await x.tap('ospeli_walks_step_start', { listStep: 3 }); x.tick(60); await x.tap('ospeli_walks_step_done');
  x.tick(30);
  const r = (await x.tap('ospeli_walks_step_start', { listStep: 2, picked: true })).walk;
  assert.equal(r.running.again, true);
  x.tick(45);
  const w = (await x.tap('ospeli_walks_step_done')).walk;
  assert.equal(w.steps.length, 3, 'the second time is never merged into the first');
  assert.deepEqual([w.steps[0].again, w.steps[2].again, w.steps[2].workSec, w.steps[0].workSec], [undefined, true, 45, 60]);
  assert.deepEqual([w.list[1].times, w.list[1].workSec], [2, 105]);
  assert.equal(w.list[3].state, 'next', 'a step done again does not move the step offered next back');
  // It was a mis-tap, or an ordinary second time: one command takes the mark away, the step stays.
  const w2 = (await x.tap('ospeli_walks_step_name', { again: false })).walk;
  assert.equal(w2.steps[2].again, undefined); assert.equal(w2.steps.length, 3);
  // And a person can mark any step as done again.
  const w3 = (await x.tap('ospeli_walks_step_name', { again: true })).walk;
  assert.equal(w3.steps[2].again, true);
  x.tick(5);
  const { mapId } = await x.tap('ospeli_walks_finish');
  const m = await x.tap('ospeli_maps_get', { mapId });
  assert.deepEqual(m.today.steps.map((s) => !!s.again), [false, false, true]);
});

test('a step not on the list starts with no name, and listStep is refused where there is no list', async () => {
  const x = await setup();
  await start(x); x.tick(10);
  await x.tap('ospeli_walks_step_start'); x.tick(20);
  const w = (await x.tap('ospeli_walks_step_done')).walk;
  assert.equal(w.steps[0].named, false); assert.equal(w.steps[0].nameFrom, undefined);
  await assert.rejects(x.tap('ospeli_walks_step_start', { listStep: 40 }), /The list has 9 steps/);
  const y = await setup();
  await y.tap('ospeli_walks_start', { guidanceSeen: true, department: 'wards' });
  assert.equal((await y.tap('ospeli_walks_get')).walk.list, undefined);
  await assert.rejects(y.tap('ospeli_walks_step_start', { listStep: 1 }), /no step list/);
});

test('repeat walk: a list step can be started out of order, a "did not happen" mark comes back on undo, and a second time is done again', async () => {
  const x = await setup();
  await start(x); 
  for (const n of [1, 2, 3]) { x.tick(10); await x.tap('ospeli_walks_step_start', { listStep: n }); x.tick(20); await x.tap('ospeli_walks_step_done'); }
  x.tick(5); const { mapId } = await x.tap('ospeli_walks_finish');
  x.tick(60); await x.tap('ospeli_walks_start', { guidanceSeen: true, mapId });
  x.tick(10); await x.tap('ospeli_walks_step_skip');
  const s = (await x.tap('ospeli_walks_step_start', { listStep: 1 })).walk;
  assert.equal(s.repeat.list[0].state, 'running');
  const u = (await x.tap('ospeli_walks_undo')).walk;
  assert.equal(u.repeat.list[0].state, 'did-not-happen');
  x.tick(10); await x.tap('ospeli_walks_step_start', { listStep: 3 }); x.tick(20);
  const d = (await x.tap('ospeli_walks_step_done')).walk;
  assert.deepEqual([d.steps[0].listStep, d.steps[0].name], [3, 'Safety questions']);
  x.tick(10); await x.tap('ospeli_walks_step_start', { listStep: 3 }); x.tick(20);
  const d2 = (await x.tap('ospeli_walks_step_done')).walk;
  assert.deepEqual([d2.steps[1].listStep, d2.steps[1].again], [3, true]);
});
