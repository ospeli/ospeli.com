// Repeat walks (issue #124 item 1; decision record 18 Nov 2026): a map made from a walk can be
// walked again on its saved step list. The walk is added to the same map, and the map gives the
// lowest and highest value across its walks. Every figure below is worked out by hand from the
// taps the test makes, and the commands run with no screen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Core } from '../../web/app/core/core.js';
import { MemoryAdapter } from '../../web/app/core/db.js';
import { runCommand, commandByName } from '../../web/app/core/commands.js';
import { fmtRange, fmtWholeMin, walkRanges, suggestWalks } from '../../web/app/core/walk.js';

const human = { type: 'human', role: 'ops-manager' };
const code = (c) => (err) => err.code === c;
async function setup(start = '2026-11-16T09:00:00.000Z') {
  let t = Date.parse(start);
  const core = await Core.open({ adapter: new MemoryAdapter(), clock: () => new Date(t) });
  const tick = (s) => { t += s * 1000; };
  const at = (iso) => { t = Date.parse(iso); };
  const tap = (name, input = {}) => runCommand(core, name, input, human);
  // One step: wait, start, work, done.
  const step = async (wait, work) => { tick(wait); await tap('ospeli_walks_step_start'); tick(work); return tap('ospeli_walks_step_done'); };
  return { core, tick, at, tap, step };
}
const NAMES = [['Checked in at reception', 'Reception'], ['Seen by a nurse', 'Nurse'], ['Seen by a doctor', 'Doctor'], ['Medicines collected', 'Pharmacy']];
// Walk 1: waits 120, 600, 1500, 300 s (2520 s = 42 min); hands-on 180, 240, 540, 180 s (1140 s = 19 min); 3660 s = 61 min.
async function firstWalk(x) {
  await x.tap('ospeli_walks_start', { title: 'Morning clinic visit', guidanceSeen: true });
  const times = [[120, 180], [600, 240], [1500, 540], [300, 180]];
  for (let i = 0; i < 4; i++) { await x.step(...times[i]); await x.tap('ospeli_walks_step_name', { name: NAMES[i][0], role: NAMES[i][1] }); }
  return (await x.tap('ospeli_walks_finish')).mapId;
}
// Walk 2, another day and hour: waits 60, 900, 1200, 720 s (2880 s = 48 min); hands-on 240, 300, 480, 120 s (1140 s); 4020 s = 67 min.
async function secondWalk(x, mapId) {
  x.at('2026-11-18T14:00:00.000Z');
  const started = await x.tap('ospeli_walks_start', { mapId, guidanceSeen: true });
  for (const [wait, work] of [[60, 240], [900, 300], [1200, 480], [720, 120]]) await x.step(wait, work);
  return { started, done: await x.tap('ospeli_walks_finish') };
}

test('a second walk follows the saved step list: nothing is named, no new map is made, and the map gives a range with no percentage', async () => {
  const x = await setup();
  const mapId = await firstWalk(x);
  const one = await x.tap('ospeli_maps_get', { mapId });
  assert.equal(one.range.count, 1);
  assert.deepEqual(one.range.totals.wait, { min: 2520, max: 2520, n: 1 });

  const { started, done } = await secondWalk(x, mapId);
  assert.equal(started.walk.title, 'Morning clinic visit');
  assert.deepEqual({ ...started.walk.repeat, list: undefined, left: undefined }, { mapId, walkNo: 2, aim: 3, next: { n: 1, name: 'Checked in at reception', role: 'Reception' }, now: null, list: undefined, left: undefined });
  assert.deepEqual(started.walk.repeat.list.map((s) => s.state), ['next', 'later', 'later', 'later']);
  // Every step took its name and role from the list.
  assert.deepEqual(done.walk.steps.map((s) => [s.name, s.role, s.listStep, s.named]), NAMES.map((n, i) => [n[0], n[1], i + 1, true]));
  assert.equal(done.mapId, mapId, 'the walk was added to the map it repeats');
  assert.equal((await x.tap('ospeli_maps_list')).maps.length, 1, 'no second map');
  assert.equal((await x.tap('ospeli_maps_list')).maps[0].walkCount, 2);

  const m = await x.tap('ospeli_maps_get', { mapId });
  const r = m.range;
  assert.equal(r.count, 2); assert.equal(r.complete, 2); assert.equal(r.aim, 3); assert.equal(r.sameHour, false);
  assert.deepEqual(r.totals, { elapsed: { min: 3660, max: 4020, n: 2 }, wait: { min: 2520, max: 2880, n: 2 }, work: { min: 1140, max: 1140, n: 2 }, notSeen: { n: 0 } });
  assert.equal(fmtRange(r.totals.elapsed), '1 h 01 to 1 h 07');
  assert.equal(fmtRange(r.totals.wait), '42 to 48 min');
  assert.equal(fmtRange(r.totals.work), '19 min (the same on both walks)');
  // Per step: lowest to highest, with the number of walks it rests on.
  assert.deepEqual(r.steps.map((s) => [s.wait.min, s.wait.max, s.wait.n]), [[60, 120, 2], [600, 900, 2], [1200, 1500, 2], [300, 720, 2]]);
  assert.deepEqual(r.steps.map((s) => [s.work.min, s.work.max]), [[180, 240], [240, 300], [480, 540], [120, 180]]);
  assert.equal(fmtRange(r.steps[1].wait, { count: false }), '10 to 15 min');
  // The hour of day of each walk is on the map.
  assert.deepEqual(r.walks.map((w) => [w.n, w.startedAt]), [[1, '2026-11-16T09:00:00.000Z'], [2, '2026-11-18T14:00:00.000Z']]);
  // Each walk's own longest wait: before "Seen by a doctor" both times.
  assert.deepEqual(r.longest, [{ stepId: `${mapId}-s3`, name: 'Seen by a doctor', walks: [1, 2] }]);
  // No share and no average anywhere in what a range gives.
  assert.doesNotMatch(JSON.stringify(r), /share|percent|mean|median|average/i);
  // The first walk's own figures, on the map's first version, are as they were.
  assert.equal(m.today.statsSec.wait, 2520);
  // The guide reads the range and says how the walks are compared.
  const g = (await x.tap('ospeli_maps_suggest', { mapId, version: 'today' })).suggestions;
  assert.deepEqual(g.map((s) => s.id), ['walks-longest', 'walks-more', 'walks-compare']);
  assert.equal(g[0].title, 'The longest wait was before “Seen by a doctor” on both walks');
  assert.equal(g[1].title, '2 of 3 walks so far');
  assert.ok(g.every((s) => s.basis && s.why), 'every guide line says what it rests on');
  assert.doesNotMatch(JSON.stringify(g), /%/);
});

test('a visit that differs from the list: a step that did not happen, a step done again and a step not on the list are each said, and a wait is compared only where it is the same wait', async () => {
  const x = await setup();
  const mapId = await firstWalk(x);
  await secondWalk(x, mapId);
  // Walk 3: reception (wait 90, work 200); the nurse step did not happen; doctor (400, 500);
  // reception again (100, 60); pharmacy (2000, 150). Waiting 2590 s, hands-on 910 s, 3500 s in all.
  x.at('2026-11-19T11:00:00.000Z');
  await x.tap('ospeli_walks_start', { mapId, guidanceSeen: true });
  await x.step(90, 200);
  const skipped = await x.tap('ospeli_walks_step_skip');
  assert.equal(skipped.walk.repeat.next.name, 'Seen by a doctor');
  assert.equal(skipped.walk.repeat.list[1].state, 'did-not-happen');
  // The mark is a tap like any other: it can be taken back, and made again.
  assert.equal((await x.tap('ospeli_walks_undo')).undone, 'skip');
  assert.equal((await x.tap('ospeli_walks_get')).walk.repeat.next.name, 'Seen by a nurse');
  await x.tap('ospeli_walks_step_skip');
  await x.step(400, 500);
  const again = await x.step(100, 60);
  assert.equal(again.walk.steps[2].name, 'Medicines collected', 'offered as the next list step');
  const fixed = await x.tap('ospeli_walks_step_name', { listStep: 1 });
  assert.deepEqual([fixed.walk.steps[2].name, fixed.walk.steps[2].role, fixed.walk.steps[2].listStep], ['Checked in at reception', 'Reception', 1]);
  assert.equal(fixed.walk.repeat.next.name, 'Medicines collected', 'a step done again does not use up the next list step');
  await x.step(2000, 150);
  assert.deepEqual((await x.tap('ospeli_walks_get')).walk.repeat.left, []);
  await x.tap('ospeli_walks_finish');

  const r = (await x.tap('ospeli_maps_get', { mapId })).range;
  assert.equal(r.count, 3);
  assert.deepEqual(r.totals, { elapsed: { min: 3500, max: 4020, n: 3 }, wait: { min: 2520, max: 2880, n: 3 }, work: { min: 910, max: 1140, n: 3 }, notSeen: { n: 0 } });
  const [a, b, c, d] = r.steps;
  // Reception: done twice on walk 3, so its hands-on time there is 200 + 60 = 260 s.
  assert.deepEqual([a.happened, a.again, a.work, a.wait], [3, 1, { min: 180, max: 260, n: 3 }, { min: 60, max: 120, n: 3 }]);
  // Nurse: on 2 of 3 walks.
  assert.deepEqual([b.happened, b.of, b.didNotHappen, b.wait.n], [2, 3, 1, 2]);
  // Doctor: on walk 3 the step before it was not the nurse step, so that wait (400 s) is not compared.
  assert.deepEqual([c.happened, c.wait, c.work], [3, { min: 1200, max: 1500, n: 2 }, { min: 480, max: 540, n: 3 }]);
  // Pharmacy: on walk 3 it followed reception, not the doctor: its 2000 s wait belongs to that walk alone.
  assert.deepEqual([d.wait, d.work], [{ min: 300, max: 720, n: 2 }, { min: 120, max: 180, n: 3 }]);
  // But it was that walk's longest wait, and the map says where the longest wait fell on each walk.
  assert.deepEqual(r.longest.map((l) => [l.name, l.walks]), [['Seen by a doctor', [1, 2]], ['Medicines collected', [3]]]);
  const g = (await x.tap('ospeli_maps_suggest', { mapId })).suggestions;
  assert.equal(g[0].title, 'The longest wait was before “Seen by a doctor” on 2 of 3 walks');
  assert.match(g[0].text, /Before “Medicines collected” on walk 3/);
  assert.deepEqual(g.map((s) => s.id), ['walks-longest', 'walks-compare'], 'three walks at different hours: no "walk again" line');
  assert.match(g[1].text, /4 steps were not the same on every walk/);
});

test('a step not on the list is named like a first walk\'s step and stays on that walk alone', async () => {
  const x = await setup();
  const mapId = await firstWalk(x);
  x.at('2026-11-18T14:00:00.000Z');
  await x.tap('ospeli_walks_start', { mapId });
  await x.step(60, 240);
  await x.step(30, 90);
  const off = await x.tap('ospeli_walks_step_name', { offList: true, name: 'Sent to the cashier', role: 'Cashier' });
  assert.deepEqual([off.walk.steps[1].name, off.walk.steps[1].listStep], ['Sent to the cashier', undefined]);
  assert.equal(off.walk.repeat.next.name, 'Seen by a nurse', 'the list step it was offered as is still to come');
  for (const [wait, work] of [[900, 300], [1200, 480], [720, 120]]) await x.step(wait, work);
  await x.tap('ospeli_walks_finish');
  const m = await x.tap('ospeli_maps_get', { mapId });
  assert.equal(m.today.steps.length, 4, 'the saved list is not changed by a repeat walk');
  assert.equal(m.range.walks[1].offList, 1);
  // The nurse step followed the cashier on walk 2, so its wait is compared on one walk only.
  assert.deepEqual(m.range.steps[1].wait, { min: 600, max: 600, n: 1 });
  assert.equal(fmtRange(m.range.steps[1].wait), '10 min (1 walk)');
  // A list step keeps the list's words: its own name with listStep is refused.
  x.at('2026-11-19T10:00:00.000Z');
  await x.tap('ospeli_walks_start', { mapId }); await x.step(10, 20);
  await assert.rejects(x.tap('ospeli_walks_step_name', { listStep: 2, name: 'Something else' }), code('conflict'));
  await assert.rejects(x.tap('ospeli_walks_step_name', { listStep: 9 }), code('conflict'));
});

test('list steps left at the finish: by default the walk stopped early and is left out of the totals; "did not happen" must be said', async () => {
  const x = await setup();
  const mapId = await firstWalk(x);
  x.at('2026-11-18T14:00:00.000Z');
  await x.tap('ospeli_walks_start', { mapId });
  await x.step(60, 240); await x.step(900, 300);
  assert.deepEqual((await x.tap('ospeli_walks_get')).walk.repeat.left.map((s) => s.n), [3, 4]);
  await x.tap('ospeli_walks_finish');
  let r = (await x.tap('ospeli_maps_get', { mapId })).range;
  assert.deepEqual([r.count, r.usable, r.complete], [2, 2, 1]);
  assert.equal(r.walks[1].stoppedEarly, true);
  assert.deepEqual(r.totals.elapsed, { min: 3660, max: 3660, n: 1 }, 'a walk that stopped early is not a start-to-finish time');
  assert.deepEqual([r.steps[2].happened, r.steps[2].didNotHappen], [1, 0], 'not seen is not "did not happen"');
  assert.deepEqual(r.steps[1].wait, { min: 600, max: 900, n: 2 }, 'the steps it did time still count');
  // The same visit, said to have ended there.
  x.at('2026-11-19T10:00:00.000Z');
  await x.tap('ospeli_walks_start', { mapId });
  await x.step(60, 240); await x.step(900, 300);
  await x.tap('ospeli_walks_finish', { leftover: 'did-not-happen' });
  r = (await x.tap('ospeli_maps_get', { mapId })).range;
  assert.deepEqual([r.count, r.complete, r.steps[2].didNotHappen], [3, 2, 1]);
  assert.deepEqual(r.totals.elapsed, { min: 1500, max: 3660, n: 2 });
});

test('guards: only a walked map can be walked again, an agent cannot, a first walk has no list, a deleted repeat walk leaves the map as it was', async () => {
  const x = await setup();
  const drawn = (await x.tap('ospeli_maps_create', { from: 'discharge' })).mapId;
  await assert.rejects(x.tap('ospeli_walks_start', { mapId: drawn }), code('conflict'));
  await assert.rejects(x.tap('ospeli_walks_start', { mapId: 'map-099' }), code('not-found'));
  const mapId = await firstWalk(x);
  for (const name of ['ospeli_walks_step_skip']) assert.equal(commandByName(name).agents, false);
  await runCommand(x.core, 'ospeli_agents_set_access', { allowed: true }, { type: 'human', role: 'coo' });
  await runCommand(x.core, 'ospeli_agents_add', { name: 'flow-bot', role: 'ops-manager', days: 30 }, { type: 'human', role: 'coo' });
  await assert.rejects(runCommand(x.core, 'ospeli_walks_start', { mapId }, { type: 'agent', role: 'ops-manager', agent: 'flow-bot' }), code('forbidden'));
  // An agent may read the range.
  assert.equal((await runCommand(x.core, 'ospeli_maps_get', { mapId }, { type: 'agent', role: 'ops-manager', agent: 'flow-bot' })).range.count, 1);
  // A first walk has no list to mark.
  await x.tap('ospeli_walks_start', {});
  await assert.rejects(x.tap('ospeli_walks_step_skip'), code('conflict'));
  await x.step(5, 5);
  await assert.rejects(x.tap('ospeli_walks_step_name', { listStep: 1 }), code('conflict'));
  await x.tap('ospeli_walks_discard');
  // A repeat walk deleted part-way adds nothing.
  await x.tap('ospeli_walks_start', { mapId }); await x.step(5, 5);
  await x.tap('ospeli_walks_discard');
  const m = await x.tap('ospeli_maps_get', { mapId });
  assert.equal(m.range.count, 1);
  assert.ok((await x.core.auditLog()).some((a) => a.action === 'walk.started' && a.detail?.mapId === mapId && a.detail.walkNo === 2), 'the audit entry names the map and the walk number, nothing else');
});

test('a walk whose clock moved back is listed and left out of every range', async () => {
  const x = await setup();
  const mapId = await firstWalk(x);
  x.at('2026-11-18T14:00:00.000Z');
  await x.tap('ospeli_walks_start', { mapId });
  x.tick(60); await x.tap('ospeli_walks_step_start'); x.tick(-3600); x.tick(60); await x.tap('ospeli_walks_step_done');
  for (let i = 0; i < 3; i++) await x.step(60, 60);
  await x.tap('ospeli_walks_finish');
  const r = (await x.tap('ospeli_maps_get', { mapId })).range;
  assert.deepEqual([r.count, r.usable, r.walks[1].clockMoved, r.walks[1].longest.length], [2, 1, true, 0]);
  assert.deepEqual(r.totals.wait, { min: 2520, max: 2520, n: 1 });
  assert.ok(r.steps.every((s) => s.of === 1));
  assert.match(suggestWalks([], r).at(-1).text, /Walk 2 is listed and left out of the totals/);
});

test('a walk that was paused: waiting and hands-on are floors and read "at least" on the right end; start to finish stays exact', async () => {
  const x = await setup();
  const mapId = await firstWalk(x);
  // Walk 2: the person stepped out for 300 s of the wait before the doctor (1200 s gap, 900 s seen)
  // and for 120 s inside the nurse step (300 s, 180 s seen). Other times as walk 2 above.
  x.at('2026-11-18T14:00:00.000Z');
  await x.tap('ospeli_walks_start', { mapId });
  await x.step(60, 240);
  x.tick(900); await x.tap('ospeli_walks_step_start'); x.tick(100); await x.tap('ospeli_walks_pause'); x.tick(120); await x.tap('ospeli_walks_resume'); x.tick(80); await x.tap('ospeli_walks_step_done');
  x.tick(500); await x.tap('ospeli_walks_pause'); x.tick(300); await x.tap('ospeli_walks_resume'); x.tick(400); await x.tap('ospeli_walks_step_start'); x.tick(480); await x.tap('ospeli_walks_step_done');
  await x.step(720, 120);
  await x.tap('ospeli_walks_finish');
  const r = (await x.tap('ospeli_maps_get', { mapId })).range;
  // Seen on walk 2: waiting 60 + 900 + 900 + 720 = 2580 s; hands-on 240 + 180 + 480 + 120 = 1020 s; not seen 420 s; 4020 s in all.
  assert.deepEqual(r.totals.elapsed, { min: 3660, max: 4020, n: 2 });
  assert.deepEqual(r.totals.wait, { min: 2520, max: 2580, n: 2, maxAtLeast: true }, 'walk 1 gave the lowest and was seen in full; the highest is a floor');
  assert.deepEqual(r.totals.work, { min: 1020, max: 1140, n: 2, maxAtLeast: true, minAtLeast: true }, 'the paused walk gave the lowest: both ends are floors');
  assert.deepEqual(r.totals.notSeen, { min: 420, max: 420, n: 1 });
  assert.equal(fmtRange(r.totals.wait), '42 to at least 43 min');
  assert.equal(fmtRange(r.totals.work), 'at least 17 to at least 19 min');
  // Per step: the doctor's wait (900 s seen against 1500 s) and the nurse's hands-on (180 s seen against 240 s).
  assert.deepEqual(r.steps[2].wait, { min: 900, max: 1500, n: 2, maxAtLeast: true, minAtLeast: true });
  assert.deepEqual(r.steps[1].work, { min: 180, max: 240, n: 2, maxAtLeast: true, minAtLeast: true });
  assert.deepEqual(r.steps[0].work, { min: 180, max: 240, n: 2 }, 'a step seen in full on every walk is exact');
});

test('how a range reads: whole minutes, lowest to highest, never a middle value', () => {
  assert.equal(fmtWholeMin(59), 'under 1 min');
  assert.equal(fmtWholeMin(89), '1 min');
  assert.equal(fmtWholeMin(3720), '1 h 02');
  assert.equal(fmtRange({ min: 2460, max: 3480, n: 3 }), '41 to 58 min');
  assert.equal(fmtRange({ min: 3240, max: 4080, n: 2 }), '54 min to 1 h 08');
  assert.equal(fmtRange({ min: 20, max: 50, n: 2 }), 'under 1 min (the same on both walks)');
  assert.equal(fmtRange({ min: 1620, max: 1630, n: 3 }), '27 min (the same on all 3 walks)');
  // A floor reads "at least" on the end it belongs to.
  assert.equal(fmtRange({ min: 1620, max: 1900, n: 2, maxAtLeast: true }), '27 to at least 32 min');
  assert.equal(fmtRange({ min: 1620, max: 1900, n: 2, minAtLeast: true, maxAtLeast: true }), 'at least 27 to at least 32 min');
  assert.equal(fmtRange({ min: 1620, max: 1620, n: 2, minAtLeast: true, maxAtLeast: true }), 'at least 27 min (the same on both walks)');
  assert.equal(fmtRange({ min: 1620, max: 1620, n: 1, minAtLeast: true, maxAtLeast: true }), 'at least 27 min (1 walk)');
  assert.equal(fmtRange({ n: 0 }), 'not timed');
  // A map with no walks gives empty ranges, not an error.
  assert.equal(walkRanges([], []).count, 0);
});
