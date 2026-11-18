// An agent listed for ward-a2 only (agent access for ward-a1 is OFF) learns ward-a1's exact stock:
// ospeli_stock_transfer gates only toPlaceId (ward: 'toPlaceId'), and the precheck answers with the
// balance at fromPlaceId.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { site, agentsOnA2 } from './review-helper.mjs';

test('an agent cannot read the stock of a ward it is not allowed on by asking to transfer out of it', async () => {
  const { run } = await site();
  await run('ospeli_stock_receive', { placeId: 'ward-a1', lines: [{ itemId: 'gloves-m', qty: 7 }], source: 'Purchase' }, 'storekeeper');
  const bot = await agentsOnA2(run);
  // The read is refused, as it should be.
  await assert.rejects(run('ospeli_stock_levels', { placeId: 'ward-a1' }, bot['supply-manager']), (e) => e.code === 'agents-off');
  let err = null;
  try { await run('ospeli_stock_transfer', { fromPlaceId: 'ward-a1', toPlaceId: 'ward-a2', lines: [{ itemId: 'gloves-m', qty: 100000 }] }, bot['supply-manager']); } catch (e) { err = e; }
  assert.ok(err, 'the call is refused');
  assert.ok(['agents-off', 'forbidden'].includes(err.code) && err.detail?.have == null && !/\b7\b/.test(err.message),
    `the refusal must be the ward gate and must not carry ward-a1's balance; got ${err.code}: "${err.message}" ${JSON.stringify(err.detail)}`);
});
