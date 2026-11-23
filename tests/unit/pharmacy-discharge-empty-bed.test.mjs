// Finding: the command layer never checks that the bed of a discharge request has a patient. The
// page offers only beds with a patient, but the command (a person's own call, another client, an
// accepted proposal) saves "discharge medicines" for a bed that is empty or being cleaned.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { site } from './sec-pharmacy-helper.mjs';

test('a discharge request for a bed with no patient in it is refused by the command, not only left off the page', async () => {
  const { run } = await site();
  const bed = (await run('ospeli_beds_board', {}, 'bed-manager')).beds.find((b) => ['available', 'cleaning', 'vacated'].includes(b.state));
  assert.ok(bed, 'the example hospital has a bed with no patient');
  let out = null; let err = null;
  try { out = await run('ospeli_pharmacy_request_raise', { wardId: bed.wardId, bedId: bed.id, kind: 'discharge', priority: 'routine', planned: 'this-afternoon', items: 3 }, 'ward-nurse'); } catch (e) { err = e; }
  assert.ok(err && ['conflict', 'not-found', 'invalid-input'].includes(err.code), `expected a refusal for a bed marked "${bed.state}"; got status "${out?.status}", ${out?.requestId} saved`);
});
