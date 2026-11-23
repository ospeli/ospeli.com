// Review finding: only laboratory bench staff may reject a specimen already received, but the
// reception role can undo that rejection (checkUndo guards a release only).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveRequests } from '../../web/app/modules/diagnostics/logic.js';
import { site, code, newRequest } from './sec-diagnostics-helper.mjs';

test('a rejection after receipt, made by bench staff, is not undone by the reception role', async () => {
  const { core, run, advance } = await site();
  const id = await newRequest(run);
  await run('ospeli_diagnostics_specimen_receive', { requestId: id, outcome: 'received' }, 'lab-reception');
  advance(20);
  await assert.rejects(run('ospeli_diagnostics_specimen_receive', { requestId: id, outcome: 'rejected', reason: 'clotted' }, 'lab-reception'), code('forbidden'), 'reception may not reject after receipt (the control)');
  await run('ospeli_diagnostics_specimen_receive', { requestId: id, outcome: 'rejected', reason: 'clotted' }, 'lab-scientist');
  advance(1);
  await assert.rejects(run('ospeli_diagnostics_specimen_undo', { requestId: id, reason: 'tapped-by-mistake' }, 'lab-reception'), code('forbidden'), 'the role that may not make this rejection may not take it back');
  assert.equal(deriveRequests(await core.events()).get(id).state, 'rejected');
});
