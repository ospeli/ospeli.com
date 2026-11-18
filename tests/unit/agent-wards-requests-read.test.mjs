// ospeli_stock_requests filters on the asking place only. When the supplying place is a ward the
// agent is not allowed on, each line still carries usableAtSupplier: that ward's balance.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { site, agentsOnA2 } from './review-helper.mjs';

test('a request read does not show an agent the stock of a supplying ward it is not allowed on', async () => {
  const { run } = await site();
  await run('ospeli_stock_receive', { placeId: 'ward-a1', lines: [{ itemId: 'masks', qty: 9 }], source: 'Purchase' }, 'storekeeper');
  await run('ospeli_stock_request', { placeId: 'ward-a2', fromPlaceId: 'ward-a1', lines: [{ itemId: 'masks', qty: 2 }] }, 'ward-nurse');
  const bot = await agentsOnA2(run);
  await assert.rejects(run('ospeli_stock_levels', { placeId: 'ward-a1' }, bot['ward-nurse']), (e) => e.code === 'agents-off');
  const out = await run('ospeli_stock_requests', {}, bot['ward-nurse']);
  const shown = out.requests.flatMap((q) => q.lines.map((l) => l.usableAtSupplier)).filter((n) => n != null);
  assert.deepEqual(shown, [], `ward-a1 is switched off for agents, yet its usable stock was shown: ${JSON.stringify(shown)}`);
});
