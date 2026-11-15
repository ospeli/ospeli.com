// AUDIT: the proposal checks (same proposal returned, one per target, 20 waiting per agent) read
// the queue and then write to it in two separate steps, so calls that arrive together (the site
// server handles API requests at the same time) all pass the check before any of them is queued.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Core } from '../../web/app/core/core.js';
import { MemoryAdapter } from '../../web/app/core/db.js';
import { loadSyntheticHospital } from '../../web/app/core/generator.js';
import { runCommand, MAX_PENDING_PER_AGENT } from '../../web/app/core/commands.js';

const END = '2026-11-06T18:00:00.000Z';
const human = (role) => ({ type: 'human', role });
const A = { type: 'agent', role: 'ops-manager', agent: 'map-bot' };
async function setup() {
  let t = Date.parse(END);
  const core = await Core.open({ adapter: new MemoryAdapter(), clock: () => new Date(t += 1000) });
  await loadSyntheticHospital(core, { end: END });
  await runCommand(core, 'ospeli_agents_set_access', { allowed: true, wards: {} }, human('coo'));
  await runCommand(core, 'ospeli_agents_add', { name: 'map-bot', role: 'ops-manager', days: 30 }, human('coo'));
  await runCommand(core, 'ospeli_maps_create', { from: 'blank', title: 'Queue test' }, human('ops-manager'));
  return core;
}
const step = (n) => ({ mapId: 'map-001', name: `Step number ${n}`, role: 'Nurse', wait: 0, work: n });
const pending = async (core) => (await core.proposals()).filter((p) => p.status === 'pending' && p.agent === 'map-bot');

test('30 different proposals sent at once: no more than 20 wait for a person', async () => {
  const core = await setup();
  const results = await Promise.allSettled(Array.from({ length: 30 }, (_, i) => runCommand(core, 'ospeli_maps_step_add', step(i + 1), A)));
  const n = (await pending(core)).length;
  assert.ok(n <= MAX_PENDING_PER_AGENT, `${n} proposals are waiting; the limit is ${MAX_PENDING_PER_AGENT} (${results.filter((r) => r.status === 'rejected').length} refused)`);
});

test('the same proposal sent twice at once is one row, not two', async () => {
  const core = await setup();
  const [a, b] = await Promise.all([runCommand(core, 'ospeli_maps_step_add', step(1), A), runCommand(core, 'ospeli_maps_step_add', step(1), A)]);
  assert.equal((await pending(core)).length, 1, `two rows were queued (${a.proposal.id}, ${b.proposal.id})`);
});
