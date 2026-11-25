// Review finding: the rejection rate's own definition counts a specimen in the period in which it
// reached the lab (its receipt; the rejection only when it was never received). The code uses the
// rejection time for a specimen rejected after receipt, so the rate's bottom line and the
// "missing steps" count beside it are taken over different sets of specimens.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveRequests, rejectionRate, missingSteps } from '../../web/app/modules/diagnostics/logic.js';

const e = (type, subject, at, data = null) => ({ type, subject, actorRole: 'lab-scientist', at, data });
const made = (id, at) => e('diagnostics.request-made', id, at, { sourceId: 'ward-a2', testGroup: 'chemistry', urgency: 'routine' });

test('a specimen received before the period and rejected after receipt inside it did not reach the lab in the period', () => {
  const reqs = deriveRequests([
    made('dx-00001', '2026-11-11T22:00:00.000Z'),
    e('diagnostics.specimen-received', 'dx-00001', '2026-11-11T23:50:00.000Z'), // the day before the period
    e('diagnostics.specimen-rejected', 'dx-00001', '2026-11-12T00:20:00.000Z', { reason: 'clotted', afterReceipt: true }),
    made('dx-00002', '2026-11-12T08:00:00.000Z'),
    e('diagnostics.specimen-received', 'dx-00002', '2026-11-12T09:00:00.000Z'),
  ]);
  const period = { since: '2026-11-12T00:00:00.000Z', until: '2026-11-19T00:00:00.000Z' };
  const rate = rejectionRate(reqs, period);
  // The two figures are shown side by side and must be about the same specimens.
  const reached = [...reqs.values()].filter((r) => r.receivedAt >= period.since && r.receivedAt < period.until).length;
  assert.equal(reached, 1, 'one specimen reached the lab in the period (by hand)');
  assert.equal(missingSteps(reqs, period).noCollection, 1, 'missing steps counts by the receipt: one specimen (the control)');
  assert.deepEqual([rate.numerator, rate.denominator], [0, 1], 'the rejection rate counts the same one specimen: 0 of 1');
});
