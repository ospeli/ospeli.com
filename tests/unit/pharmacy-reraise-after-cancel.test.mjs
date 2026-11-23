// Finding: the "same picks within two minutes" guard also matches a request that was cancelled in
// the meantime. A ward that cancels and asks again straight away is told "already saved" and
// pointed at a request that is cancelled; nothing is open for it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { site } from './sec-pharmacy-helper.mjs';

test('asking again straight after cancelling is not refused as "already saved"', async () => {
  const { run, advance } = await site();
  const ask = { wardId: 'ward-b2', kind: 'other', priority: 'routine', items: 9 };
  const first = await run('ospeli_pharmacy_request_raise', ask, 'ward-nurse');
  advance(0.5);
  await run('ospeli_pharmacy_request_cancel', { requestId: first.requestId, reason: 'raised-in-error' }, 'ward-nurse');
  advance(0.5);
  let out = null; let err = null;
  try { out = await run('ospeli_pharmacy_request_raise', ask, 'ward-nurse'); } catch (e) { err = e; }
  assert.equal(out?.status, 'done', `refused: ${err?.code}: ${err?.message}`);
});
