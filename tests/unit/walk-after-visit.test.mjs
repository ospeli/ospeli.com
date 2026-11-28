// A step after the visit ("Report signed", the department list's "later" step) is kept apart from
// the visit (#169 item 3, #182, crew night 13): timed from the end of the visit's last step, and in
// none of the visit's figures: start to finish, waiting, hands-on, the longest wait, the ranges.
// Also: names confirmed at Finish (#170 point 3), an earlier step named before finishing, and a
// name changed on the map no longer reading "from the list" (#182).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './walk-177-helper.mjs';

const VISIT = 8; // Arrived … Left on the imaging list; step 9 is "Report signed".
async function imagingWalk(x, { mapId = null, report = true, reportWait = 2400, confirm = false } = {}) {
  await x.tap('ospeli_walks_start', mapId ? { mapId, guidanceSeen: true } : { title: 'Outpatient CT', department: 'imaging', guidanceSeen: true });
  for (let n = 1; n <= VISIT; n++) {
    x.tick(n === 6 ? 900 : 60); await x.tap('ospeli_walks_step_start', { listStep: n });
    x.tick(120); await x.tap('ospeli_walks_step_done');
  }
  if (report) { x.tick(reportWait); await x.tap('ospeli_walks_step_start', { listStep: 9, picked: true }); x.tick(120); await x.tap('ospeli_walks_step_done'); }
  return x.tap('ospeli_walks_finish', confirm ? { namesConfirmed: true } : {});
}
const VISIT_WAIT = 7 * 60 + 900; const VISIT_WORK = 8 * 120;

test('one walk: the report is timed from the end of the visit and is in none of the visit\'s figures', async () => {
  const x = await setup();
  const out = await imagingWalk(x);
  const w = out.walk;
  assert.equal(w.steps.length, 9);
  assert.deepEqual([w.steps[8].name, w.steps[8].afterVisit, w.steps[8].waitSec, w.steps[8].workSec], ['Report signed', true, 2400, 120]);
  assert.ok(w.steps.slice(0, 8).every((s) => !s.afterVisit));
  assert.deepEqual(w.totals.afterVisit, { steps: 1, waitSec: 2400, workSec: 120 });
  assert.equal(w.totals.waitSec, VISIT_WAIT); assert.equal(w.totals.workSec, VISIT_WORK);
  assert.equal(w.totals.elapsedSec, VISIT_WAIT + VISIT_WORK, 'start to finish ends when the patient left');
  assert.equal(Date.parse(w.finishedAt) - Date.parse(w.startedAt), (VISIT_WAIT + VISIT_WORK) * 1000);
  const m = await x.tap('ospeli_maps_get', { mapId: out.mapId });
  const guide = JSON.stringify(await x.tap('ospeli_maps_suggest', { mapId: out.mapId }));
  assert.doesNotMatch(guide, /Longest wait[^"]*Report signed/);
  assert.match(guide, /Longest wait on this walk: 15 min before “Scan”/);
  assert.equal(m.today.steps[8].afterVisit, true);
  assert.deepEqual(m.today.stats.afterVisit, { steps: 1, wait: 40, work: 2 });
  assert.equal(m.today.statsSec.wait, VISIT_WAIT); assert.equal(m.today.statsSec.work, VISIT_WORK);
  assert.equal(m.today.statsSec.startToFinish, VISIT_WAIT + VISIT_WORK);
  assert.equal(m.today.stats.steps, 9);
  const sum = await x.tap('ospeli_maps_summary', { mapId: out.mapId });
  assert.doesNotMatch(JSON.stringify(sum), /Longest wait[^"]*Report signed/);
});

test('a visit step timed after the report still waits from the visit step before it', async () => {
  const x = await setup();
  await x.tap('ospeli_walks_start', { title: 'Outpatient CT', department: 'imaging', guidanceSeen: true });
  x.tick(60); await x.tap('ospeli_walks_step_start', { listStep: 7 }); x.tick(120); await x.tap('ospeli_walks_step_done');
  x.tick(30); await x.tap('ospeli_walks_step_start', { listStep: 9, picked: true }); x.tick(60); await x.tap('ospeli_walks_step_done');
  x.tick(30); await x.tap('ospeli_walks_step_start', { listStep: 8 }); x.tick(60); const out = await x.tap('ospeli_walks_step_done');
  const [rec, rep, left] = out.walk.steps;
  assert.deepEqual([rep.afterVisit, rep.waitSec, rep.workSec], [true, 30, 60]);
  assert.equal(left.waitSec, 120, 'Left waited from the end of Recovery: 30 s, the report\'s 60 s and 30 s more');
  assert.equal(out.walk.totals.waitSec + out.walk.totals.workSec, 60 + 120 + 120 + 60);
  assert.equal(rec.afterVisit, undefined);
});

test('a walk that timed nothing but the report keeps it as an ordinary step', async () => {
  const x = await setup();
  await x.tap('ospeli_walks_start', { title: 'Reports', department: 'imaging', guidanceSeen: true });
  x.tick(60); await x.tap('ospeli_walks_step_start', { listStep: 9, picked: true }); x.tick(60); await x.tap('ospeli_walks_step_done');
  const out = await x.tap('ospeli_walks_finish');
  assert.equal(out.walk.steps[0].afterVisit, undefined);
  assert.equal(out.walk.totals.elapsedSec, 120); assert.equal(out.walk.totals.afterVisit, undefined);
});

test('a step named "Report signed" afterwards is after the visit; named something else, it is not', async () => {
  const x = await setup();
  await x.tap('ospeli_walks_start', { title: 'Outpatient CT', department: 'imaging', guidanceSeen: true });
  x.tick(60); await x.tap('ospeli_walks_step_start', { listStep: 1 }); x.tick(60); await x.tap('ospeli_walks_step_done');
  x.tick(600); await x.tap('ospeli_walks_step_start'); x.tick(60); await x.tap('ospeli_walks_step_done');
  let out = await x.tap('ospeli_walks_step_name', { name: 'Report signed', role: 'Radiologist', nameFrom: 'chosen', roleFrom: 'chosen' });
  assert.equal(out.walk.steps[1].afterVisit, true);
  out = await x.tap('ospeli_walks_step_name', { name: 'Scan', role: 'Imaging staff', nameFrom: 'chosen', roleFrom: 'chosen' });
  assert.equal(out.walk.steps[1].afterVisit, undefined);
});

test('two walks: the ranges, each walk\'s longest wait and the guide leave the report out; not timing it on walk 2 is not stopping early', async () => {
  const x = await setup();
  const { mapId } = await imagingWalk(x);
  x.tick(86400);
  const two = await imagingWalk(x, { mapId, report: false });
  assert.equal(two.walk.repeat.left.length, 0, 'the report is not a list step "left"');
  x.tick(86400);
  await imagingWalk(x, { mapId, reportWait: 3000 });
  const m = await x.tap('ospeli_maps_get', { mapId });
  const r = m.range;
  assert.equal(r.complete, 3, 'all three walks are whole walks');
  assert.deepEqual([r.totals.elapsed.min, r.totals.elapsed.max], [VISIT_WAIT + VISIT_WORK, VISIT_WAIT + VISIT_WORK]);
  assert.deepEqual([r.totals.wait.min, r.totals.wait.max], [VISIT_WAIT, VISIT_WAIT]);
  assert.ok(r.walks.every((w) => w.longest.length === 1 && w.longest[0].name === 'Scan' && w.longest[0].waitSec === 900));
  assert.deepEqual(r.walks.map((w) => w.afterVisit?.waitSec ?? null), [2400, null, 3000]);
  assert.equal(r.steps[8].afterVisit, true);
  assert.deepEqual([r.steps[8].happened, r.steps[8].wait.min, r.steps[8].wait.max], [2, 2400, 3000]);
  assert.match(JSON.stringify(await x.tap('ospeli_maps_suggest', { mapId })), /The longest wait was before “Scan” on all 3 walks/);
});

test('Finish with namesConfirmed: list names and roles become "confirmed", chosen ones stay, and the map says when', async () => {
  const x = await setup();
  const out = await imagingWalk(x, { confirm: true });
  const m = await x.tap('ospeli_maps_get', { mapId: out.mapId });
  assert.deepEqual(m.today.steps.map((s) => s.nameFrom), [...Array(8).fill('confirmed'), 'chosen']);
  assert.ok(m.today.steps.every((s) => s.roleFrom === 'confirmed'));
  assert.ok(m.walk.namesConfirmedAt);
  const audit = (await x.core.auditEntries?.() || []).find?.((e) => e.action === 'walk.finished');
  if (audit) assert.equal(audit.detail.namesConfirmed, 8);
  // Without it the marks stay.
  const y = await setup();
  const plain = await imagingWalk(y);
  const m2 = await y.tap('ospeli_maps_get', { mapId: plain.mapId });
  assert.equal(m2.today.steps.filter((s) => s.nameFrom === 'list').length, 8);
  assert.equal(m2.walk.namesConfirmedAt, undefined);
});

test('before finishing, an earlier step can be given the person\'s own name or role; the walk says how many are still the list\'s', async () => {
  const x = await setup();
  await x.tap('ospeli_walks_start', { title: 'Outpatient CT', department: 'imaging', guidanceSeen: true });
  for (let n = 1; n <= 3; n++) { x.tick(60); await x.tap('ospeli_walks_step_start', { listStep: n }); x.tick(60); await x.tap('ospeli_walks_step_done'); }
  let out = await x.tap('ospeli_walks_get');
  assert.deepEqual(out.walk.fromList, { names: 3, roles: 3 });
  out = await x.tap('ospeli_walks_step_name', { step: 2, role: 'Imaging staff', roleFrom: 'chosen' });
  assert.deepEqual([out.walk.steps[1].name, out.walk.steps[1].role, out.walk.steps[1].nameFrom, out.walk.steps[1].roleFrom], ['Registered', 'Imaging staff', 'list', 'chosen']);
  assert.deepEqual(out.walk.fromList, { names: 3, roles: 2 });
  assert.deepEqual([out.walk.steps[2].name, out.walk.steps[2].roleFrom], ['Safety questions', 'list'], 'the last step is untouched');
  await assert.rejects(() => x.tap('ospeli_walks_step_name', { step: 9, name: 'Scan' }), /3 steps that have ended/);
  await assert.rejects(() => x.tap('ospeli_walks_step_name', { step: 1, name: 'Scan', nextStarted: true }), /send only/);
});

test('a name or role changed on the map is the person\'s own from then on, not "from the list" (#182)', async () => {
  const x = await setup();
  const out = await imagingWalk(x, { report: false });
  const id = `${out.mapId}-s2`;
  await x.tap('ospeli_maps_step_update', { mapId: out.mapId, stepId: id, role: 'Booking clerk' });
  let m = await x.tap('ospeli_maps_get', { mapId: out.mapId });
  assert.deepEqual([m.today.steps[1].nameFrom, m.today.steps[1].roleFrom], ['list', 'typed']);
  await x.tap('ospeli_maps_step_update', { mapId: out.mapId, stepId: id, name: 'Booked in at the desk' });
  m = await x.tap('ospeli_maps_get', { mapId: out.mapId });
  assert.deepEqual([m.today.steps[1].nameFrom, m.today.steps[1].typed], ['typed', true]);
  // The same words sent again change nothing.
  await x.tap('ospeli_maps_step_update', { mapId: out.mapId, stepId: `${out.mapId}-s3`, name: 'Safety questions' });
  m = await x.tap('ospeli_maps_get', { mapId: out.mapId });
  assert.equal(m.today.steps[2].nameFrom, 'list');
});

test('a person can mark a step on the map as after the visit, and take the mark off', async () => {
  const x = await setup();
  const out = await imagingWalk(x, { report: false });
  await x.tap('ospeli_maps_step_update', { mapId: out.mapId, stepId: `${out.mapId}-s8`, afterVisit: true });
  let m = await x.tap('ospeli_maps_get', { mapId: out.mapId });
  assert.equal(m.today.steps[7].afterVisit, true); assert.equal(m.proposed.steps[7].afterVisit, true);
  assert.equal(m.today.statsSec.work, 7 * 120);
  await x.tap('ospeli_maps_step_update', { mapId: out.mapId, stepId: `${out.mapId}-s8`, afterVisit: false });
  m = await x.tap('ospeli_maps_get', { mapId: out.mapId });
  assert.equal(m.today.steps[7].afterVisit, undefined);
});
