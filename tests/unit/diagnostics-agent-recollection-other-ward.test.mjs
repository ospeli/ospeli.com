// Review finding: recollectionOf is not checked against the ward of the new request, so an agent
// given Ward A2 only can (1) read the state and step times of a Ward B1 request from the refusal
// text and (2) have a Ward B1 rejection marked "recollected", which also blocks its undo and its
// real recollection.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveRequests } from '../../web/app/modules/diagnostics/logic.js';
import { site, agent, code, newRequest } from './sec-diagnostics-helper.mjs';

async function setup() {
  const s = await site();
  await s.run('ospeli_agents_set_access', { allowed: true, wards: { 'ward-a2': true } }, 'coo');
  await s.run('ospeli_agents_add', { name: 'dx-bot', role: 'unit-clerk', wards: ['ward-a2'], days: 30 }, 'coo');
  return s;
}
const ASK = { sourceId: 'ward-a2', testGroup: 'chemistry', urgency: 'routine' };

test('an agent given Ward A2 is not told the state of a Ward B1 request through recollectionOf', async () => {
  const { run } = await setup();
  const b1 = await newRequest(run, { sourceId: 'ward-b1' });
  await run('ospeli_diagnostics_specimen_collect', { requestId: b1 }, 'ward-nurse');
  let err = null;
  try { await run('ospeli_diagnostics_request_record', { ...ASK, recollectionOf: b1 }, agent('unit-clerk')); } catch (e) { err = e; }
  assert.ok(err, 'the call is refused');
  assert.ok(!/collected at|on its way|received|rejected at|released/i.test(err.message), `the refusal says nothing about the other ward's request, got: ${err.message}`);
});

test('an agent given Ward A2 cannot have a Ward B1 rejection marked as recollected', async () => {
  const { core, run } = await setup();
  const b1 = await newRequest(run, { sourceId: 'ward-b1' });
  await run('ospeli_diagnostics_specimen_receive', { requestId: b1, outcome: 'rejected', reason: 'leaked' }, 'lab-reception');
  await assert.rejects(run('ospeli_diagnostics_request_record', { ...ASK, recollectionOf: b1 }, agent('unit-clerk')), code('forbidden', 'not-found'), 'a request from a ward the agent was not given is out of reach');
  assert.equal(deriveRequests(await core.events()).get(b1).recollectedBy, null);
});

test('a person cannot record a Ward A2 request as the recollection of a Ward B1 rejection', async () => {
  const { run } = await setup();
  const b1 = await newRequest(run, { sourceId: 'ward-b1' });
  await run('ospeli_diagnostics_specimen_receive', { requestId: b1, outcome: 'rejected', reason: 'leaked' }, 'lab-reception');
  await assert.rejects(run('ospeli_diagnostics_request_record', { ...ASK, recollectionOf: b1 }, 'unit-clerk'), code('invalid-input', 'conflict'), 'a recollection comes from the same ward or area as the rejected request');
});
