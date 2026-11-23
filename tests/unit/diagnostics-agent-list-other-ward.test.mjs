// Review finding: ospeli_diagnostics_requests_list has no ward gate (no wardOf), so an agent that
// names a ward it was not given gets an answer with that ward's name instead of the refusal every
// other ward read gives (ospeli_beds_find_free is the control).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { site, agent, code } from './sec-diagnostics-helper.mjs';

test('an agent given Ward A2 that asks for Ward B1\'s requests is refused, as it is for Ward B1\'s beds', async () => {
  const { run } = await site();
  await run('ospeli_agents_set_access', { allowed: true, wards: { 'ward-a2': true, 'ward-b1': true } }, 'coo');
  await run('ospeli_agents_add', { name: 'dx-bot', role: 'unit-clerk', wards: ['ward-a2'], days: 30 }, 'coo');
  await assert.rejects(run('ospeli_beds_find_free', { wardId: 'ward-b1' }, agent('unit-clerk')), code('forbidden'), 'the bed board refuses (the control)');
  await assert.rejects(run('ospeli_diagnostics_requests_list', { sourceId: 'ward-b1' }, agent('unit-clerk')), code('forbidden'), 'the request tracker refuses and leaves a refusal in the trail');
});
