// Finding: when the log is read, a request's wardId only has to look like an id. A request whose
// "ward" is another kind of place (an edited import) is hidden from an agent's reads, but the ward
// gate for writes runs only for real wards, so an agent given ward-a1 alone can still queue steps on it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { importedSite, botsOnA1 } from './sec-pharmacy-helper.mjs';

test('an agent given one ward cannot queue a step on a request that belongs to no ward it was given', async () => {
  const { core, run } = await importedSite((add) => add('pharmacy.request-raised', 'rx-00001', 'ward-nurse', { wardId: 'dept-medicine', kind: 'other', priority: 'routine', items: 2 }, '2026-11-20T17:00:00.000Z'));
  const bot = await botsOnA1(run);
  assert.deepEqual((await run('ospeli_pharmacy_queue_list', {}, 'pharmacist')).requests.map((r) => r.id), ['rx-00001'], 'a person sees the request');
  assert.deepEqual((await run('ospeli_pharmacy_queue_list', {}, bot['pharmacy-technician'])).requests, [], 'the agent\'s read does not show it (control)');
  let out = null; let err = null;
  try { out = await run('ospeli_pharmacy_request_step', { requestId: 'rx-00001', step: 'start' }, bot['pharmacy-technician']); } catch (e) { err = e; }
  assert.ok(err && ['agents-off', 'forbidden', 'not-found'].includes(err.code), `expected a refusal; got status "${out?.status}" (${out?.proposal?.id} queued)`);
  assert.equal((await core.proposals()).length, 0);
});
