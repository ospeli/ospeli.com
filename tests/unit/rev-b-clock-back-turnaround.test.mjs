// Review finding: a device clock set back between "Received" and "Result released" saves a release
// earlier than the receipt; the turnaround is negative and pulls the median down.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveRequests, labTurnaround } from '../../web/app/modules/diagnostics/logic.js';
import { site, newRequest } from './rev-b-helpers.mjs';

test('a result released on a clock set back 30 minutes is refused or kept out of the turnaround, never counted as minus 30 minutes', async () => {
  const { core, run, advance } = await site();
  const id = await newRequest(run);
  await run('ospeli_diagnostics_specimen_receive', { requestId: id, outcome: 'received' }, 'lab-reception');
  advance(-30);
  let res = null;
  try { res = await run('ospeli_diagnostics_result_record', { requestId: id }, 'lab-scientist'); } catch { /* a refusal is a fine answer */ }
  if (res) assert.ok(res.turnaroundMinutes >= 0, `turnaroundMinutes is ${res.turnaroundMinutes}`);
  const one = new Map([[id, deriveRequests(await core.events()).get(id)]]);
  const t = labTurnaround(one, {});
  assert.ok(t.n === 0 || t.median >= 0, `the measure counts a turnaround of ${t.median} minutes`);
});

test('labTurnaround leaves out a release timed before its receipt (an edited import)', () => {
  const e = (type, at, data = null) => ({ type, subject: 'dx-00001', actorRole: 'lab-scientist', at, data });
  const reqs = deriveRequests([
    e('diagnostics.request-made', '2026-11-19T08:00:00.000Z', { sourceId: 'ward-a2', testGroup: 'chemistry', urgency: 'routine' }),
    e('diagnostics.specimen-received', '2026-11-19T09:00:00.000Z'),
    e('diagnostics.result-validated', '2026-11-19T07:00:00.000Z'),
  ]);
  const t = labTurnaround(reqs, {});
  assert.ok(t.n === 0 || t.median >= 0, `median ${t.median} minutes over n ${t.n}`);
});
