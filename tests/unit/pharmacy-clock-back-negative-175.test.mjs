// Finding: when the device clock is set back between two steps, the stage time is negative and goes
// into the median as it is (activeMinutes in logic.js has no floor), so "Time by stage" can show a
// time below zero or be pulled down by it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { site } from './rev-a-helper.mjs';
import { deriveRequests, stageTimes } from '../../web/app/modules/pharmacy/logic.js';

test('a step recorded after the clock was set back never gives a stage time below zero', async () => {
  const { core, run, advance } = await site();
  const { requestId } = await run('ospeli_pharmacy_request_raise', { wardId: 'ward-b1', kind: 'other', priority: 'routine', items: 7 }, 'ward-nurse');
  advance(-60); // the clock is corrected back by an hour
  await run('ospeli_pharmacy_request_step', { requestId, step: 'start' }, 'pharmacy-technician');
  const only = new Map([[requestId, deriveRequests(await core.events()).get(requestId)]]);
  const stage = stageTimes(only, { since: '2026-11-01T00:00:00.000Z', until: '2026-12-01T00:00:00.000Z' }).stages.find((s) => s.id === 'raised-started');
  assert.equal(stage.n === 0 || stage.value >= 0, true, `raised to started is ${stage.value} min (n ${stage.n})`);
});
