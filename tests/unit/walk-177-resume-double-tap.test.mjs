// Issue ospeli/ospeli#177 (security and audit review, 23 Nov), test written by that review; fixed by the Builder 25 Nov.
// Review finding: a double tap on the main button of the walk screen, when it reads "Step carries
// on", carries the interrupted step on and ends it again 0.3 s later. A plain "Step starts" then
// "Step done" inside one second is refused as a double tap (isDoubleTap); after carrying on it is
// not, because isDoubleTap measures from the step's first start, not from the tap that carried it on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './walk-177-helper.mjs';

test('"Step done" 0.3 s after "Step carries on" is taken as a double tap, like after "Step starts"', async () => {
  const x = await setup();
  await x.tap('ospeli_walks_start', { guidanceSeen: true });
  x.tick(60); await x.tap('ospeli_walks_step_start');
  // The control: a plain start and a done 0.3 s later is refused.
  x.tick(0.3);
  await assert.rejects(x.tap('ospeli_walks_step_done'), (e) => e.code === 'conflict', 'control: a plain double tap is refused');
  x.tick(120); await x.tap('ospeli_walks_step_done', { interrupted: true });
  x.tick(300); await x.tap('ospeli_walks_step_start', { resume: true });
  x.tick(0.3);
  await assert.rejects(x.tap('ospeli_walks_step_done'), (e) => e.code === 'conflict',
    'the second half of a double tap on "Step carries on" ended the step it had just carried on');
});
