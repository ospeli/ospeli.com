// Finding: a wrong wardId is answered with the id of every ward on the site, to an agent too. The
// core's own answer (noWard in core/commands.js) names only the wards the agent may see.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { site, botsOnA1 } from './sec-pharmacy-helper.mjs';

test('a not-found answer tells an agent only about the wards it was given', async () => {
  const { run } = await site();
  const bot = await botsOnA1(run);
  const calls = [
    ['ospeli_pharmacy_request_raise', { wardId: 'ward-zz', kind: 'other', priority: 'routine', items: 1 }, bot['ward-nurse']],
    ['ospeli_pharmacy_ward_requests', { wardId: 'ward-zz' }, bot['ward-nurse']],
  ];
  const leaks = [];
  for (const [name, input, who] of calls) {
    let err = null;
    try { await run(name, input, who); } catch (e) { err = e; }
    assert.equal(err?.code, 'not-found', name);
    const said = `${err.message} ${JSON.stringify(err.detail ?? null)}`;
    const others = ['ward-a2', 'ward-a3', 'ward-b1', 'ward-b2', 'ward-c1'].filter((w) => said.includes(w));
    if (others.length) leaks.push(`${name}: ${others.join(', ')}`);
  }
  assert.deepEqual(leaks, [], 'the agent is listed for ward-a1 only, but the refusal names other wards');
});
