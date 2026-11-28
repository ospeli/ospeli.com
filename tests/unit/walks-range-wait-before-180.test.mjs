// Review finding: on a map with several walks, "the wait before a step" is compared across walks
// and the guide names where the longest wait was "before". Since an interrupted step that carries
// on is one step, its waitSec also holds the time it stood still INSIDE the step. The range and the
// guide still call all of it the wait before the step (the one-walk guide was changed to say
// "at"; the many-walks guide and the range were not).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './walk-177-helper.mjs';

const NAMES = [['Registered', 'Reception'], ['Scan', 'Imaging staff']];
async function walk(x, mapId) {
  await x.tap('ospeli_walks_start', mapId ? { mapId, guidanceSeen: true } : { title: 'Outpatient CT', guidanceSeen: true });
  // Step 1: 20 s wait, 60 s hands-on.
  x.tick(20); await x.tap('ospeli_walks_step_start'); x.tick(60); await x.tap('ospeli_walks_step_done');
  if (!mapId) await x.tap('ospeli_walks_step_name', { name: NAMES[0][0], role: NAMES[0][1] });
  // Step 2 (Scan): 20 s wait before it, 60 s hands-on, stands still 300 s, 60 s more hands-on.
  x.tick(20); await x.tap('ospeli_walks_step_start'); x.tick(60);
  await x.tap('ospeli_walks_step_done', { interrupted: true });
  if (!mapId) await x.tap('ospeli_walks_step_name', { name: NAMES[1][0], role: NAMES[1][1] });
  x.tick(300); await x.tap('ospeli_walks_step_start', { resume: true }); x.tick(60);
  await x.tap('ospeli_walks_step_done');
  return x.tap('ospeli_walks_finish');
}

test('two walks, each with 20 s before Scan and 300 s stood still inside it: the wait before Scan is 20 s, and the guide does not say "before"', async () => {
  const x = await setup();
  const { mapId } = await walk(x);
  x.tick(3600);
  await walk(x, mapId);
  const m = await x.tap('ospeli_maps_get', { mapId });
  assert.equal(m.range.count, 2);
  const scan = m.range.steps[1];
  const text = JSON.stringify(m);
  const saysBefore = /longest wait was before “Scan”/.test(text);
  assert.ok(scan.wait.max === 20 && !saysBefore,
    `the wait "before" Scan is given as ${scan.wait.min} to ${scan.wait.max} s (20 s was before it, 300 s inside it)${saysBefore ? '; the guide says: The longest wait was before “Scan” on both walks' : ''}`);
});
