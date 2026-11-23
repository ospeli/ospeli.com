// Review finding: the encounter on a request is checked only for "exists somewhere on this site".
// An agent given Ward A2 can attach a patient who is in a Ward B1 bed, and the two different
// answers (queued / not-found) tell it which encounter ids exist outside its ward.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { site, agent, code } from './sec-diagnostics-helper.mjs';

test('an agent given Ward A2 cannot record a request for a patient in a Ward B1 bed, and learns nothing from the refusal', async () => {
  const { run } = await site();
  await run('ospeli_agents_set_access', { allowed: true, wards: { 'ward-a2': true } }, 'coo');
  await run('ospeli_agents_add', { name: 'dx-bot', role: 'unit-clerk', wards: ['ward-a2'], days: 30 }, 'coo');
  const b1 = await run('ospeli_diagnostics_requests_list', { sourceId: 'ward-b1' }, 'unit-clerk');
  const enc = b1.picks.patients[0].encounter;
  assert.match(enc, /^enc-\d+$/);
  const ask = (encounter) => run('ospeli_diagnostics_request_record', { sourceId: 'ward-a2', testGroup: 'urine', urgency: 'routine', encounter }, agent('unit-clerk'));
  let made = null; let other = null;
  try { await ask('enc-999999'); } catch (e) { made = e; }
  try { await ask(enc); } catch (e) { other = e; }
  assert.ok(code('not-found')(made), 'a made-up encounter is refused (the control)');
  assert.ok(other, 'a patient in a ward the agent was not given is refused too, not queued as a proposal');
  assert.equal(other.message, made.message, 'with the same answer, so the agent cannot tell which encounters exist elsewhere');
});

test('a person cannot record a Ward A2 request for a patient who is in a Ward B1 bed', async () => {
  const { run } = await site();
  const b1 = await run('ospeli_diagnostics_requests_list', { sourceId: 'ward-b1' }, 'unit-clerk');
  const enc = b1.picks.patients[0].encounter;
  const a2 = await run('ospeli_diagnostics_requests_list', { sourceId: 'ward-a2' }, 'unit-clerk');
  assert.ok(!a2.picks.patients.some((p) => p.encounter === enc), 'the patient is not on Ward A2\'s pick list');
  await assert.rejects(run('ospeli_diagnostics_request_record', { sourceId: 'ward-a2', testGroup: 'urine', urgency: 'routine', encounter: enc }, 'unit-clerk'), code('not-found', 'invalid-input', 'conflict'),
    'the patient code on a ward\'s request is one of that ward\'s patients');
});
