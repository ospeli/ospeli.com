// A proposal is "checked again when the person accepts", but a count proposed without seenSeq carries
// no snapshot (the stock commands have no cmd.snapshot), so accepting it later sets the balance back
// to what the agent saw and a delivery saved in between vanishes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { site, agentsOnA2 } from './review-helper.mjs';

test('accepting an agent\'s count after a delivery does not wipe the delivery out', async () => {
  const { run } = await site();
  await run('ospeli_stock_receive', { placeId: 'ward-a2', lines: [{ itemId: 'gloves-m', qty: 3 }], source: 'Purchase' }, 'storekeeper');
  const bot = await agentsOnA2(run);
  const p = await run('ospeli_stock_count', { placeId: 'ward-a2', lines: [{ itemId: 'gloves-m', qty: 3 }], raiseRequest: false }, bot['ward-nurse']);
  assert.equal(p.status, 'proposed');
  await run('ospeli_stock_receive', { placeId: 'ward-a2', lines: [{ itemId: 'gloves-m', qty: 20 }], source: 'Purchase' }, 'storekeeper');
  const res = await run('ospeli_proposals_accept', { id: p.proposal.id }, 'ward-nurse');
  const usable = (await run('ospeli_stock_levels', { placeId: 'ward-a2', itemId: 'gloves-m' }, 'ward-nurse')).levels[0].usable;
  assert.equal(usable, 23, `3 counted, then 20 delivered; the acceptance answered "${res.status}" and usable is now`);
});
