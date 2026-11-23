// Review finding: the double-tap guard compares a new request with every request made in the last
// two minutes, cancelled ones too. A request cancelled by mistake and entered again is answered
// "Already saved", pointing at the cancelled one, and nothing is saved. The screen never sends
// again: true, so on the ward there is no way round it for two minutes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveRequests } from '../../web/app/modules/diagnostics/logic.js';
import { site } from './sec-diagnostics-helper.mjs';

test('a request entered again after its twin was cancelled is saved, not answered "Already saved"', async () => {
  const { core, run, advance } = await site();
  const ask = { sourceId: 'ward-a2', testGroup: 'coagulation', urgency: 'urgent' };
  const first = await run('ospeli_diagnostics_request_record', ask, 'unit-clerk');
  advance(0.5);
  await run('ospeli_diagnostics_request_cancel', { requestId: first.requestId, reason: 'entered-in-error' }, 'unit-clerk');
  advance(0.5);
  let second = null; let err = null;
  try { second = await run('ospeli_diagnostics_request_record', ask, 'unit-clerk'); } catch (e) { err = e; }
  assert.equal(err, null, `refused: ${err?.message}`);
  assert.equal(deriveRequests(await core.events()).get(second.requestId).state, 'requested');
});
