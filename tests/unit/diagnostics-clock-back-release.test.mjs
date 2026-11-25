// #176: a release on a clock set back is refused for a person; one already in the log (an edited
// import) is left out of the turnaround and counted against data completeness; "rejected today" counts
// a rejection after receipt by the time it reached the lab, as the rejection rate does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveRequests, completeness } from '../../web/app/modules/diagnostics/logic.js';
import { site, newRequest, code } from './rev-b-helpers.mjs';

test('a person releasing a result on a clock set back before the receipt is refused, and nothing is saved', async () => {
  const { core, run, advance } = await site();
  const id = await newRequest(run);
  await run('ospeli_diagnostics_specimen_receive', { requestId: id, outcome: 'received' }, 'lab-reception');
  advance(-30);
  await assert.rejects(run('ospeli_diagnostics_result_record', { requestId: id }, 'lab-scientist'), code('conflict'));
  assert.equal(deriveRequests(await core.events()).get(id).state, 'received');
  advance(31);
  const res = await run('ospeli_diagnostics_result_record', { requestId: id }, 'lab-scientist');
  assert.equal(res.turnaroundMinutes, 1, 'once the clock is right again it saves');
});

test('a release timed before its receipt is not a full record in data completeness', () => {
  const e = (type, at, data = null) => ({ type, subject: 'dx-00001', actorRole: 'lab-scientist', at, data });
  const reqs = deriveRequests([
    e('diagnostics.request-made', '2026-11-19T07:00:00.000Z', { sourceId: 'ward-a2', testGroup: 'chemistry', urgency: 'routine' }),
    e('diagnostics.specimen-collected', '2026-11-19T07:10:00.000Z'),
    e('diagnostics.specimen-received', '2026-11-19T09:00:00.000Z'),
    e('diagnostics.result-validated', '2026-11-19T08:00:00.000Z'),
  ]);
  assert.deepEqual(completeness(reqs, {}), { value: 0, numerator: 0, denominator: 1, n: 1 });
});

test('"rejected today" counts a rejection after receipt by its receipt, so one received before midnight is not today\'s', async () => {
  const { core, run, advance } = await site();
  const { today } = await run('ospeli_diagnostics_specimen_log', {}, 'lab-reception');
  const before = (await run('ospeli_diagnostics_specimen_log', {}, 'lab-reception')).counts.rejectedToday;
  // Received 10 minutes before the site's midnight, rejected by a scientist 20 minutes after it.
  const mid = Date.parse(today.since); const nowMs = Date.parse(core.now());
  advance((mid - nowMs) / 60e3 + 24 * 60 - 10 - 1);
  const id = await newRequest(run);
  advance(1);
  await run('ospeli_diagnostics_specimen_receive', { requestId: id, outcome: 'received' }, 'lab-reception');
  advance(30);
  await run('ospeli_diagnostics_specimen_receive', { requestId: id, outcome: 'rejected', reason: 'clotted' }, 'lab-scientist');
  const log = await run('ospeli_diagnostics_specimen_log', {}, 'lab-reception');
  assert.ok(log.today.since > today.since, 'a new day has begun');
  assert.equal(log.counts.rejectedToday, 0, `rejectedToday is ${log.counts.rejectedToday} (was ${before} the day before)`);
});
