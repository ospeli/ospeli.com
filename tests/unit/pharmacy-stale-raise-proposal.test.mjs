// Finding: ospeli_pharmacy_request_raise has no snapshot(), so an agent's proposal to ask for
// discharge medicines keeps nothing of what the agent saw (which patient was in the bed). If the
// patient leaves before a person decides, accepting still saves a discharge request for the bed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { site, botsOnA1, bedWithPatient } from './sec-pharmacy-helper.mjs';
import { deriveRequests } from '../../web/app/modules/pharmacy/logic.js';

test('an agent\'s proposal to ask for discharge medicines is out of date once the patient has left the bed', async () => {
  const { core, run, advance } = await site();
  const bot = await botsOnA1(run);
  const bedId = await bedWithPatient(run, 'ward-a1');
  const p = await run('ospeli_pharmacy_request_raise', { wardId: 'ward-a1', bedId, kind: 'discharge', priority: 'routine', planned: 'this-evening', items: 2 }, bot['ward-nurse']);
  assert.equal(p.status, 'proposed');
  await run('ospeli_beds_mark_vacated', { bedId }, 'ward-nurse'); // the patient has gone home
  advance(5);
  const before = deriveRequests(await core.events()).size;
  const res = await run('ospeli_proposals_accept', { id: p.proposal.id }, 'ward-nurse');
  assert.equal(res.status, 'expired', `the bed has no patient now, yet the proposal ran and saved ${res.result?.requestId}`);
  assert.equal(deriveRequests(await core.events()).size, before);
});
