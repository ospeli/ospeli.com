// Audit 18 Nov (#128 item 1), adapted to the Expert panel's decision of 25 Nov: a delivery received
// against an order nobody approved is not refused (some sites receive urgent items before the
// paperwork), but it must not complete the order quietly. The order stays open, waiting for approval,
// marked "received before approval" where the manager sees it; the approver can still decide.
// The mark is read from the log (no new stored field or event).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { site } from './review-helper.mjs';

test('an order nobody approved or placed cannot be completed by the storekeeper who requested it', async () => {
  const { run } = await site();
  const o = await run('ospeli_stores_order_step', { step: 'requested', lines: [{ itemId: 'aprons', qty: 5 }] }, 'storekeeper');
  // The storekeeper cannot approve.
  await assert.rejects(run('ospeli_stores_order_step', { step: 'approved', orderId: o.orderId }, 'storekeeper'), (e) => e.code === 'forbidden');
  // Not refused: the delivery goes into stock.
  await run('ospeli_stock_receive', { placeId: 'store-main', lines: [{ itemId: 'aprons', qty: 5 }], source: 'Purchase', orderRef: o.orderId }, 'storekeeper');
  const row = (await run('ospeli_stores_orders', { state: 'all' }, 'ops-manager')).orders.find((x) => x.id === o.orderId);
  assert.equal(row.state, 'requested', 'the order was never approved or ordered, yet the tracker shows it as');
  assert.equal(row.waitingFor, 'Waiting for approval');
  assert.equal(row.lines[0].received, 5, 'what came is shown on the order');
  assert.equal(row.receivedBeforeApproval?.byRole, 'storekeeper', 'the order is marked received before approval');
  assert.ok(row.receivedBeforeApproval.at);
  // It stays on the open list the manager sees (the order tracker and the manager view both read it).
  const open = (await run('ospeli_stores_orders', { state: 'open', format: 'short' }, 'ops-manager')).orders.find((x) => x.id === o.orderId);
  assert.ok(open, 'the order dropped off the open list');
  assert.ok(open.receivedBeforeApproval, 'the short read (agents, the manager view) carries the mark too');
  await run('ospeli_stores_order_step', { step: 'approved', orderId: o.orderId }, 'ops-manager'); // the approver can still decide
  const after = (await run('ospeli_stores_orders', { state: 'all' }, 'ops-manager')).orders.find((x) => x.id === o.orderId);
  assert.equal(after.state, 'received', 'once approved, the goods already in complete it');
  assert.ok(after.receivedBeforeApproval, 'the mark stays on the order after approval');
  assert.ok(after.steps.every((s) => s.days == null || s.days >= 0), 'no step shows negative days');
});

test('part of an order received before approval: approval leaves it part received, still open', async () => {
  const { run } = await site();
  const o = await run('ospeli_stores_order_step', { step: 'requested', lines: [{ itemId: 'aprons', qty: 5 }] }, 'storekeeper');
  await run('ospeli_stock_receive', { placeId: 'store-main', lines: [{ itemId: 'aprons', qty: 2 }], source: 'Purchase', orderRef: o.orderId }, 'storekeeper');
  await run('ospeli_stores_order_step', { step: 'approved', orderId: o.orderId }, 'ops-manager');
  const row = (await run('ospeli_stores_orders', { state: 'open' }, 'ops-manager')).orders.find((x) => x.id === o.orderId);
  assert.equal(row.state, 'part-received');
  assert.ok(row.receivedBeforeApproval);
});

test('an order received after approval carries no mark', async () => {
  const { run } = await site();
  const o = await run('ospeli_stores_order_step', { step: 'requested', lines: [{ itemId: 'aprons', qty: 5 }] }, 'storekeeper');
  await run('ospeli_stores_order_step', { step: 'approved', orderId: o.orderId }, 'ops-manager');
  await run('ospeli_stores_order_step', { step: 'ordered', orderId: o.orderId }, 'supply-manager');
  await run('ospeli_stock_receive', { placeId: 'store-main', lines: [{ itemId: 'aprons', qty: 5 }], source: 'Purchase', orderRef: o.orderId }, 'storekeeper');
  const row = (await run('ospeli_stores_orders', { state: 'all' }, 'ops-manager')).orders.find((x) => x.id === o.orderId);
  assert.equal(row.state, 'received');
  assert.equal(row.receivedBeforeApproval, null);
});
