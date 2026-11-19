// Audit finding: the stale-count fix (#128 point 2) trusts a seenSeq the agent sends. A number above
// the newest stock event is kept as it is, so the check on accept can never fire and a delivery saved
// in between is wiped out, exactly as before the fix.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { site, agentsOnA2 } from './review-helper.mjs';

test('an agent cannot switch the stale-count check off by sending a seenSeq from the future', async () => {
  const { run } = await site();
  await run('ospeli_stock_receive', { placeId: 'ward-a2', lines: [{ itemId: 'gloves-m', qty: 3 }], source: 'Purchase' }, 'storekeeper');
  const bot = await agentsOnA2(run);
  let p = null;
  try { p = await run('ospeli_stock_count', { placeId: 'ward-a2', lines: [{ itemId: 'gloves-m', qty: 3 }], raiseRequest: false, seenSeq: 999999 }, bot['ward-nurse']); } catch { return; } // refusing the number is a fair answer
  await run('ospeli_stock_receive', { placeId: 'ward-a2', lines: [{ itemId: 'gloves-m', qty: 20 }], source: 'Purchase' }, 'storekeeper');
  const res = await run('ospeli_proposals_accept', { id: p.proposal.id }, 'ward-nurse');
  const usable = (await run('ospeli_stock_levels', { placeId: 'ward-a2', itemId: 'gloves-m' }, 'ward-nurse')).levels[0].usable;
  assert.equal(usable, 23, `3 counted, then 20 delivered; the acceptance answered "${res.status}" and usable is now`);
});
