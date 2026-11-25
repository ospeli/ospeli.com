// Finding: an open discharge request is tied to the bed only. The encounter code is stored with the
// request and never read again, so when the patient leaves and the next patient is admitted to the
// same bed, the old request (often Ready and never collected) is shown as the new patient's
// medicines and blocks the ward from asking for the new patient. Synthetic data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { site, bedWithPatient } from './rev-a-helper.mjs';

test('a discharge request left open by the last patient is not shown as, and does not block, the next patient\'s in the same bed', async () => {
  const { run, advance } = await site();
  const bedId = await bedWithPatient(run, 'ward-b2');
  const { requestId } = await run('ospeli_pharmacy_request_raise', { wardId: 'ward-b2', bedId, kind: 'discharge', priority: 'routine', planned: 'this-afternoon', items: 4 }, 'ward-nurse');
  await run('ospeli_pharmacy_request_step', { requestId, step: 'start' }, 'pharmacy-technician');
  await run('ospeli_pharmacy_request_check', { requestId }, 'pharmacist');
  await run('ospeli_pharmacy_request_step', { requestId, step: 'ready' }, 'pharmacy-technician');
  advance(30);
  // The patient goes home without the medicines being marked collected; the bed is cleaned and the next patient admitted.
  await run('ospeli_beds_mark_vacated', { bedId }, 'ward-nurse');
  await run('ospeli_beds_start_clean', { bedId }, 'ward-nurse');
  await run('ospeli_beds_finish_clean', { bedId }, 'ward-nurse');
  const next = (await run('ospeli_beds_board', {}, 'bed-manager')).waiting.find((x) => !x.allocatedBed);
  await run('ospeli_beds_allocate', { bedId, encounter: next.encounter }, 'bed-manager');
  await run('ospeli_beds_admit', { bedId }, 'ward-nurse');
  advance(30);
  const row = (await run('ospeli_pharmacy_ward_requests', { wardId: 'ward-b2' }, 'ward-nurse')).beds.find((b) => b.bedId === bedId);
  assert.equal(row.request, null, `the new patient's bed shows the last patient's request ${row.request?.id} (${row.request?.state}) as already asked`);
  const again = await run('ospeli_pharmacy_request_raise', { wardId: 'ward-b2', bedId, kind: 'discharge', priority: 'routine', planned: 'this-evening', items: 2 }, 'ward-nurse');
  assert.equal(again.status, 'done');
});
