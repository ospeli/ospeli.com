// Issue ospeli/ospeli#177 (security and audit review, 23 Nov), test written by that review; fixed by the Builder 25 Nov.
// Review finding (the screen path is browser only; this shows the command half): on the walk
// screen, tapping "Step carries on" with a name chosen saves the name for the interrupted step and
// leaves the line "Step 2 saved as Scan · Change" on screen while step 2 runs again. "Change" opens
// the naming sheet and its next save calls ospeli_walks_step_name. With step 2 running again, that
// command names the last ENDED step, which is now step 1: the correction lands on the wrong step.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './walk-177-helper.mjs';

test('a name corrected just after "Step carries on" goes to the step that carried on, not to the step before it', async () => {
  const x = await setup();
  await x.tap('ospeli_walks_start', { guidanceSeen: true });
  x.tick(30); await x.tap('ospeli_walks_step_start'); x.tick(60); await x.tap('ospeli_walks_step_done');
  await x.tap('ospeli_walks_step_name', { name: 'Registered', role: 'Reception' });
  x.tick(30); await x.tap('ospeli_walks_step_start'); x.tick(60);
  await x.tap('ospeli_walks_step_done', { interrupted: true });
  // What the screen does on "Step carries on" with "Scan" chosen: name, then resume.
  await x.tap('ospeli_walks_step_name', { name: 'Scan', role: 'Imaging staff' });
  x.tick(120); await x.tap('ospeli_walks_step_start', { resume: true });
  // "Change" on the line "Step 2 saved as Scan", then another chip: the screen sends this.
  x.tick(5);
  let changed = null;
  try { changed = (await x.tap('ospeli_walks_step_name', { name: 'Cannula or prep', role: 'Radiology nurse' })).walk; } catch (e) { assert.equal(e.code, 'conflict'); return; } // refused: also right
  assert.equal(changed.steps[0].name, 'Registered', 'step 1, already named and finished, was renamed with the words meant for step 2');
});
