// A device clock set back: ospeli_stock_out_end answers "done" (with negative hours) and writes its
// event and audit entry, but deriveStock drops an end earlier than the start, so the stock-out stays open.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { site } from './review-helper.mjs';

test('closing a stock-out either closes it or is refused, also when the clock went back', async () => {
  const { run, skip } = await site();
  const so = await run('ospeli_stock_out_start', { itemId: 'masks', placeId: 'ward-a2', cause: 'Not delivered' }, 'supply-manager');
  skip(-3600e3); // the clock is corrected back by an hour
  let answer = null;
  try { answer = await run('ospeli_stock_out_end', { stockOutId: so.stockOutId, careAffected: false }, 'supply-manager'); } catch { /* refused: fine */ }
  const row = (await run('ospeli_stock_outs', {}, 'supply-manager')).stockOuts.find((s) => s.id === so.stockOutId);
  assert.equal(row.open, answer?.status !== 'done', `the command answered ${JSON.stringify(answer)} but the stock-out's "open" is`);
});
