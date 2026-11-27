// #189 item 2: a step marked on the walk as done again is shown in its own words with its own
// total, and the CSV says so. From a real walk through the commands, then the result's own model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './walk-177-helper.mjs';
import { stepsInSeconds } from '../../web/app/core/walk.js';
import { recordFromSteps, walkItems, extrasOf, csvOf } from '../../web/app/modules/result-data.js';

test('a list step timed twice on a first walk: the second time is "done again", with its own total, never merged', async () => {
  const x = await setup();
  await x.tap('ospeli_walks_start', { guidanceSeen: true, department: 'outpatients' });
  x.tick(60); await x.tap('ospeli_walks_step_start', { listStep: 1 }); x.tick(120); await x.tap('ospeli_walks_step_done');
  x.tick(60); await x.tap('ospeli_walks_step_start', { listStep: 2 }); x.tick(300); await x.tap('ospeli_walks_step_done');
  // Sent back to the desk: the first list step again, 4 min.
  x.tick(180); await x.tap('ospeli_walks_step_start', { listStep: 1, picked: true }); x.tick(240); await x.tap('ospeli_walks_step_done');
  x.tick(5);
  const { mapId } = await x.tap('ospeli_walks_finish');
  const m = await x.tap('ospeli_maps_get', { mapId });
  const list = stepsInSeconds(m.today.steps);
  const rec = recordFromSteps(list, m.walk);
  const items = walkItems(list, rec);
  assert.deepEqual(items.map((i) => [i.name, i.marked, i.workSec]), [['Checked in at reception', false, 120], ['Seen by a nurse', false, 300], ['Checked in at reception', true, 240]]);
  const e = extrasOf(list, [rec]);
  assert.equal(e.words, '1 step done again');
  assert.deepEqual(e.marked.map((k) => [k.name, k.walk, k.workSec]), [['Checked in at reception', 1, 240]]);
  assert.deepEqual([e.againSec, e.againTimes], [240, 1], 'its own total: the second time only');
  const csv = csvOf({ title: m.title, department: 'outpatients', list, records: [rec], dateOf: () => '2026-11-16' }).trim().split('\r\n');
  const col = csv[0].split(',').indexOf('"done again"');
  assert.deepEqual(csv.slice(1).map((l) => l.split(',')[col]), ['"no"', '"no"', '"yes"']);
});

test('no step done again: no total and no words', async () => {
  const x = await setup();
  await x.tap('ospeli_walks_start', { guidanceSeen: true, department: 'outpatients' });
  x.tick(60); await x.tap('ospeli_walks_step_start', { listStep: 1 }); x.tick(120); await x.tap('ospeli_walks_step_done'); x.tick(5);
  const { mapId } = await x.tap('ospeli_walks_finish');
  const m = await x.tap('ospeli_maps_get', { mapId });
  const list = stepsInSeconds(m.today.steps);
  const e = extrasOf(list, [recordFromSteps(list, m.walk)]);
  assert.deepEqual([e.words, e.againSec, e.againTimes, e.marked.length], ['', 0, 0, 0]);
});
