// Result, crew night 6: a step done again has its own line; where step names and roles came from
// is said once (and is in the CSV); a longest wait under 5 minutes keeps its seconds. Synthetic
// walks through the commands (an imaging and an outpatients visit at no real site).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './walk-177-helper.mjs';
import { stepsInSeconds } from '../../web/app/core/walk.js';
import { recordFromSteps, againLines, sourceLine, csvOf, CSV_HEAD } from '../../web/app/modules/result-data.js';
import { waitWords, longestOneWalk, longestWalks } from '../../web/app/modules/result-words.js';

// A first imaging walk: list steps 1 to 5 offered next, step 5 (Cannula or prep) done again (picked),
// then step 6 offered next; one step named later with words of its own.
async function imagingWalk({ named = true } = {}) {
  const x = await setup();
  await x.tap('ospeli_walks_start', { guidanceSeen: true, department: 'imaging', title: 'Outpatient CT' });
  for (const n of [1, 2, 3, 4, 5]) { x.tick(60); await x.tap('ospeli_walks_step_start', { listStep: n }); x.tick(120); await x.tap('ospeli_walks_step_done'); }
  x.tick(90); await x.tap('ospeli_walks_step_start', { listStep: 5, picked: true }); x.tick(360); await x.tap('ospeli_walks_step_done');
  x.tick(150); await x.tap('ospeli_walks_step_start', { listStep: 6 }); x.tick(600); await x.tap('ospeli_walks_step_done');
  x.tick(40); await x.tap('ospeli_walks_step_start'); x.tick(60); await x.tap('ospeli_walks_step_done');
  if (named) await x.tap('ospeli_walks_step_name', { name: 'Images checked', role: 'Imaging staff', typed: true, roleFrom: 'chosen' });
  x.tick(5);
  const { mapId } = await x.tap('ospeli_walks_finish');
  const m = await x.tap('ospeli_maps_get', { mapId });
  const list = stepsInSeconds(m.today.steps);
  return { m, list, rec: recordFromSteps(list, m.walk) };
}

test('item 1: a step done again has its own line, with how many times and the hands-on of the times after the first', async () => {
  const { list, rec } = await imagingWalk();
  assert.equal(againLines(list, [rec]), 'Done again: Cannula or prep, 2 times, 6 min hands-on after the first time.');
});

test('item 1: no step done again, no line', async () => {
  const x = await setup();
  await x.tap('ospeli_walks_start', { guidanceSeen: true, department: 'outpatients' });
  x.tick(60); await x.tap('ospeli_walks_step_start', { listStep: 1 }); x.tick(120); await x.tap('ospeli_walks_step_done'); x.tick(5);
  const { mapId } = await x.tap('ospeli_walks_finish');
  const m = await x.tap('ospeli_maps_get', { mapId });
  const list = stepsInSeconds(m.today.steps);
  assert.equal(againLines(list, [recordFromSteps(list, m.walk)]), null);
});

test('item 2: how many step names and roles came from the list, said once; nothing for a walk without the fields', async () => {
  const { list, rec } = await imagingWalk();
  // 8 steps: 6 started as the step offered next (list), 1 picked (chosen), 1 typed.
  assert.equal(sourceLine(list, [rec], 'imaging'),
    '6 of 8 step names came from the list and were not confirmed on the walk. 7 of 8 roles came with the list step and were not chosen on the walk.');
  // A walk recorded before the fields existed: nothing is said.
  const old = { ...rec, steps: rec.steps.map(({ nameFrom, roleFrom, ...s }) => s) };
  assert.equal(sourceLine(list, [old], 'imaging'), null);
  // Every name chosen or typed and every role chosen: nothing is said.
  const all = { ...rec, steps: rec.steps.map((s) => ({ ...s, nameFrom: 'chosen', roleFrom: 'chosen' })) };
  assert.equal(sourceLine(list, [all], 'imaging'), null);
  // A name changed on the map after the walk is no longer the list's words: not counted.
  const renamed = list.map((s, i) => (i === 0 ? { ...s, name: 'Came to the desk' } : s));
  assert.match(sourceLine(renamed, [rec], 'imaging'), /^5 of 8 step names/);
  // Two walks: only the walk with the fields is counted, and it is named.
  assert.equal(sourceLine(list, [rec, old], 'imaging'),
    'On walk 1, 6 of 8 step names came from the list and were not confirmed on the walk. 7 of 8 roles came with the list step and were not chosen on the walk.');
});

test('item 2: the CSV has "name from" and "role from" columns, before the walk Builder\'s last three', async () => {
  const { m, list, rec } = await imagingWalk();
  assert.deepEqual(CSV_HEAD.slice(-5), ['name from', 'role from', 'wait reason (recorded on the walk)', 'last stop reason (recorded on the walk)', 'step name typed']);
  const lines = csvOf({ title: m.title, department: 'Imaging', list, records: [rec], dateOf: () => '2026-11-16' }).trim().split('\r\n');
  const a = CSV_HEAD.indexOf('name from'); const b = CSV_HEAD.indexOf('role from');
  const cols = lines.slice(1).map((l) => [l.split(',')[a], l.split(',')[b]].map((v) => v.replace(/"/g, '')));
  assert.deepEqual(cols, [['list', 'list'], ['list', 'list'], ['list', 'list'], ['list', 'list'], ['list', 'list'], ['chosen', 'list'], ['list', 'list'], ['typed', 'chosen']]);
});

test('item 3: a longest wait under 5 minutes keeps its seconds; from 5 minutes, whole minutes', () => {
  assert.equal(waitWords(150), '2 min 30 s');
  assert.equal(waitWords(120), '2 min');
  assert.equal(waitWords(45), '45 s');
  assert.equal(waitWords(299), '4 min 59 s');
  assert.equal(waitWords(300), '5 min');
  assert.equal(waitWords(330), '6 min');
  assert.equal(waitWords(150, { floor: true }), '2 min 30 s');
  assert.deepEqual(longestOneWalk([{ name: 'Scan', wait: 150 }]), { lead: 'Longest wait: ', text: '2 min 30 s before “Scan”' });
  assert.deepEqual(longestOneWalk([{ name: 'Scan', wait: 150, waitNotSeenSec: 60 }]), { lead: 'Longest wait: ', text: 'at least 2 min 30 s before “Scan” (1 min more of it not seen)' });
  assert.deepEqual(longestOneWalk([{ name: 'Scan', wait: 400 }]), { lead: 'Longest wait: ', text: '7 min before “Scan”' });
  const rg = { usable: 2, steps: [{ stepId: 's5', happened: 2 }], walks: [{ n: 1, usable: true, longest: [{ key: 's5', waitSec: 150 }] }, { n: 2, usable: true, longest: [{ key: 's5', waitSec: 200 }] }],
    longest: [{ stepId: 's5', name: 'Scan', walks: [1, 2] }] };
  assert.equal(longestWalks(rg).text, '2 min 30 s to 3 min 20 s before “Scan”, on both walks');
});
