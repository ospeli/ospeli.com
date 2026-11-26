// #180 point 1 (simulated walks, 23 Nov; design audit, 25 Nov): a person can say, with one tap and
// no typing, what a wait was waiting for or what stopped a step. Run here without the screen.
// Never needed: a walk with no answer keeps nothing. The answer is one person's observation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './walk-177-helper.mjs';
import { WAIT_REASONS, WAIT_REASON_MIN_SEC } from '../../web/app/core/walk.js';
import { runCommand } from '../../web/app/core/commands.js';
import { csvOf, recordFromSteps, walkItems, CSV_HEAD } from '../../web/app/modules/result-data.js';
import { stepsInSeconds } from '../../web/app/core/walk.js';

const start = async () => { const x = await setup(); await x.tap('ospeli_walks_start', { guidanceSeen: true }); return x; };

test('the question is put only after a wait of two minutes or more, and only until it is answered', async () => {
  const x = await start();
  assert.equal(WAIT_REASON_MIN_SEC, 120);
  x.tick(119); let w = (await x.tap('ospeli_walks_step_start')).walk;
  assert.equal(w.askReason, null, 'a wait of 119 s is not asked about');
  x.tick(60); await x.tap('ospeli_walks_step_done'); x.tick(120);
  w = (await x.tap('ospeli_walks_step_start')).walk;
  assert.deepEqual(w.askReason, { of: 'wait', waitSec: 120 });
  w = (await x.tap('ospeli_walks_reason', { of: 'wait', reason: 'room-equipment' })).walk;
  assert.equal(w.askReason, null);
  x.tick(30); w = (await x.tap('ospeli_walks_step_done')).walk;
  assert.equal(w.steps[1].waitReason, 'room-equipment');
  assert.equal(w.steps[0].waitReason, undefined, 'a wait nobody was asked about keeps nothing');
});

test('time not seen (paused) is not part of the wait that is asked about', async () => {
  const x = await start();
  x.tick(60); await x.tap('ospeli_walks_pause'); x.tick(600); await x.tap('ospeli_walks_resume'); x.tick(30);
  const w = (await x.tap('ospeli_walks_step_start')).walk;
  assert.equal(w.askReason, null, '90 s were seen; the 600 s paused are not a wait anyone watched');
});

test('an interrupted step: "stop" is asked, the answer is kept when the step carries on and ends, and the wait before is not asked again', async () => {
  const x = await start();
  x.tick(200); await x.tap('ospeli_walks_step_start');
  await x.tap('ospeli_walks_reason', { of: 'wait', reason: 'others-ahead' });
  x.tick(60); let w = (await x.tap('ospeli_walks_step_done', { interrupted: true })).walk;
  assert.deepEqual(w.askReason, { of: 'stop' });
  w = (await x.tap('ospeli_walks_reason', { of: 'stop', reason: 'staff-busy' })).walk;
  assert.equal(w.askReason, null);
  x.tick(300); w = (await x.tap('ospeli_walks_step_start', { resume: true })).walk;
  assert.equal(w.askReason, null, 'carrying on is not a new wait before the step');
  x.tick(20); w = (await x.tap('ospeli_walks_step_done')).walk;
  assert.deepEqual([w.steps[0].waitReason, w.steps[0].stopReason], ['others-ahead', 'staff-busy']);
  // Undo brings the step back running with what was said about it.
  w = (await x.tap('ospeli_walks_undo')).walk; x.tick(5);
  w = (await x.tap('ospeli_walks_step_done')).walk;
  assert.deepEqual([w.steps[0].waitReason, w.steps[0].stopReason], ['others-ahead', 'staff-busy']);
});

test('a step interrupted a second time is asked again: the first answer does not stand for both stops (Domain lead, 26 Nov)', async () => {
  const x = await start();
  x.tick(30); await x.tap('ospeli_walks_step_start'); x.tick(60);
  await x.tap('ospeli_walks_step_done', { interrupted: true });
  await x.tap('ospeli_walks_reason', { of: 'stop', reason: 'staff-busy' });
  x.tick(60); await x.tap('ospeli_walks_step_start', { resume: true }); x.tick(60);
  let w = (await x.tap('ospeli_walks_step_done', { interrupted: true })).walk;
  assert.deepEqual(w.askReason, { of: 'stop' });
  assert.equal(w.steps[0].stopReason, undefined);
  assert.equal(w.steps[0].interruptions, 2);
  // A wrong tap taken back: the step runs again and ends with one stop, whose answer still stands.
  w = (await x.tap('ospeli_walks_undo')).walk;
  x.tick(5); w = (await x.tap('ospeli_walks_step_done')).walk;
  assert.deepEqual([w.steps[0].interruptions, w.steps[0].stopReason], [1, 'staff-busy']);
});

test('only a reason on the list is taken; null takes the answer away; nothing can be typed', async () => {
  const x = await start();
  x.tick(130); await x.tap('ospeli_walks_step_start');
  await assert.rejects(x.tap('ospeli_walks_reason', { of: 'wait', reason: 'The doctor was late' }));
  await assert.rejects(x.tap('ospeli_walks_reason', { of: 'stop', reason: 'staff-busy' }), /interrupted/);
  await x.tap('ospeli_walks_reason', { of: 'wait', reason: 'could-not-tell' });
  let w = (await x.tap('ospeli_walks_reason', { of: 'wait', reason: null })).walk;
  x.tick(10); w = (await x.tap('ospeli_walks_step_done')).walk;
  assert.equal('waitReason' in w.steps[0], false);
  assert.ok(WAIT_REASONS.length <= 7 && WAIT_REASONS.some((r) => r.id === 'could-not-tell'));
  const got = await x.tap('ospeli_walks_get');
  assert.deepEqual(got.waitReasons, WAIT_REASONS);
});

test('people only, and audited with ids only', async () => {
  const x = await start();
  x.tick(130); await x.tap('ospeli_walks_step_start');
  await assert.rejects(runCommand(x.core, 'ospeli_walks_reason', { of: 'wait', reason: 'transport' }, { type: 'agent', role: 'radiographer', id: 'agent-1' }));
  await x.tap('ospeli_walks_reason', { of: 'wait', reason: 'transport' });
  const a = (await x.core.auditLog()).find((e) => e.action === 'walk.reason-given');
  assert.deepEqual([a.detail.of, a.detail.reason], ['wait', 'transport']);
});

test('the map, the result and the export carry the reason and whether a step name was typed (#188 item 4)', async () => {
  const x = await start();
  x.tick(60); await x.tap('ospeli_walks_step_start'); x.tick(60); await x.tap('ospeli_walks_step_done');
  await x.tap('ospeli_walks_step_name', { name: 'Checked in at reception', role: 'Reception' });
  x.tick(600); await x.tap('ospeli_walks_step_start');
  await x.tap('ospeli_walks_reason', { of: 'wait', reason: 'information' });
  x.tick(60); await x.tap('ospeli_walks_step_done');
  await x.tap('ospeli_walks_step_name', { name: 'Left the clinic', role: 'Reception', typed: true });
  const out = await x.tap('ospeli_walks_finish');
  const map = await x.tap('ospeli_maps_get', { mapId: out.mapId });
  const list = stepsInSeconds(map.today.steps);
  assert.deepEqual(list.map((s) => [s.name, s.waitReason || null, !!s.typed]), [['Checked in at reception', null, false], ['Left the clinic', 'information', true]]);
  const rec = recordFromSteps(list, map.walk);
  assert.equal(walkItems(list, rec)[1].reason, 'reason recorded on the walk: information or paperwork');
  const csv = csvOf({ title: map.title, department: '', list, records: [rec], dateOf: () => '2026-11-16' }).trim().split('\r\n');
  assert.deepEqual(CSV_HEAD.slice(-3), ['wait reason (recorded on the walk)', 'last stop reason (recorded on the walk)', 'step name typed']);
  assert.match(csv[1], /"","","no"$/);
  assert.match(csv[2], /"Information or paperwork","","yes"$/);
});
