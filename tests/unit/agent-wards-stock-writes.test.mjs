// Agent access is OFF for ward-a1 and the agents are listed for ward-a2 only, yet they can queue
// writes about ward-a1: a transfer out of it (only toPlaceId is gated), an issue to it and the
// cancelling of its request (ward: 'none', so no ward gate at all).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { site, agentsOnA2 } from './review-helper.mjs';

test('with agent access off for a ward, no agent write about that ward is queued', async () => {
  const { run } = await site();
  await run('ospeli_stock_receive', { placeId: 'store-main', lines: [{ itemId: 'gloves-m', qty: 50 }], source: 'Purchase' }, 'storekeeper');
  await run('ospeli_stock_receive', { placeId: 'ward-a1', lines: [{ itemId: 'gloves-m', qty: 7 }], source: 'Purchase' }, 'storekeeper');
  await run('ospeli_stock_receive', { placeId: 'ward-a1', lines: [{ itemId: 'masks', qty: 4 }], source: 'Purchase' }, 'storekeeper');
  const req = await run('ospeli_stock_request', { placeId: 'ward-a1', lines: [{ itemId: 'gloves-m', qty: 2 }] }, 'ward-nurse');
  const bot = await agentsOnA2(run);
  // The control: the same agents are refused a count on ward-a1.
  await assert.rejects(run('ospeli_stock_count', { placeId: 'ward-a1', lines: [{ itemId: 'gloves-m', qty: 1 }] }, bot['ward-nurse']), (e) => e.code === 'agents-off');
  const queued = [];
  const attempt = async (what, name, input, who) => { try { const r = await run(name, input, who); if (r.status === 'proposed') queued.push(what); } catch { /* refused: good */ } };
  await attempt('transfer out of ward-a1', 'ospeli_stock_transfer', { fromPlaceId: 'ward-a1', toPlaceId: 'ward-a2', lines: [{ itemId: 'masks', qty: 4 }] }, bot['supply-manager']);
  await attempt('issue to ward-a1', 'ospeli_stock_issue', { requestId: req.requestId }, bot.storekeeper);
  await attempt('cancel ward-a1\'s request', 'ospeli_stock_request_cancel', { requestId: req.requestId, reason: 'No longer needed' }, bot['ward-nurse']);
  assert.deepEqual(queued, [], 'agent access is off for ward-a1, but these were queued as proposals about it');
});
