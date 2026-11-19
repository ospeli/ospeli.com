// Finding: an agent given one ward (or none) is shown the ids of journeys that leave from wards it was
// not given. ospeli_transfers_board and ospeli_transfers_jobs filter the journey lists by ward, but each
// vehicle's currentJob and assignedJobs are built from every journey; ospeli_transfers_jobs also counts
// every ward's handovers (handedOverThisShift). With an id in hand, any transfer write then names the
// journey's ward in its refusal ("Agent access is off for ward ..."), so the agent learns which ward each
// journey leaves from. Synthetic data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Core } from '../../web/app/core/core.js';
import { MemoryAdapter } from '../../web/app/core/db.js';
import { loadSyntheticHospital } from '../../web/app/core/generator.js';
import { runCommand } from '../../web/app/core/commands.js';

const END = '2026-11-06T18:00:00.000Z';
async function site() {
  let t = Date.parse(END);
  const core = await Core.open({ adapter: new MemoryAdapter(), clock: () => new Date(t += 1000) });
  await loadSyntheticHospital(core, { end: END });
  const run = (name, input, who) => runCommand(core, name, input, typeof who === 'string' ? { type: 'human', role: who } : who);
  await run('ospeli_agents_set_access', { allowed: true, wards: { 'ward-a2': true } }, 'coo');
  const bot = {};
  for (const role of ['transport-coordinator', 'driver']) {
    await run('ospeli_agents_add', { name: `${role}-bot`, role, wards: ['ward-a2'], days: 30 }, 'coo');
    bot[role] = { type: 'agent', agent: `${role}-bot`, role };
  }
  // What a person sees: the journeys with a vehicle that leave from a ward the agent was not given.
  const board = await run('ospeli_transfers_board', {}, 'transport-coordinator');
  const others = board.open.filter((x) => x.pickup.id !== 'ward-a2');
  assert.ok(others.length > 0, 'the example has journeys with a vehicle from other wards');
  return { run, bot, others };
}

test('the board an agent reads holds no id of a journey from a ward it was not given', async () => {
  const { run, bot, others } = await site();
  const seen = JSON.stringify(await run('ospeli_transfers_board', {}, bot['transport-coordinator']));
  const leaked = others.filter((x) => seen.includes(x.id)).map((x) => `${x.id} (${x.pickup.id})`);
  assert.deepEqual(leaked, [], 'journeys from other wards named on the agent\'s board');
});

test('a vehicle\'s jobs read by an agent holds no id of a journey from a ward it was not given', async () => {
  const { run, bot, others } = await site();
  const leaked = [];
  for (const x of others) {
    const seen = JSON.stringify(await run('ospeli_transfers_jobs', { vehicleId: x.vehicleId }, bot.driver));
    if (seen.includes(x.id)) leaked.push(`${x.id} (${x.pickup.id}) on ${x.vehicleId}`);
  }
  assert.deepEqual(leaked, []);
});

test('a refused transfer write does not tell the agent which ward the journey leaves from', async () => {
  const { run, bot, others } = await site();
  const x = others[0];
  let err = null;
  try { await run('ospeli_transfers_delay', { transferId: x.id, reason: 'no-vehicle' }, bot['transport-coordinator']); } catch (e) { err = e; }
  assert.ok(err, 'the call is refused');
  assert.ok(!err.message.includes(x.pickup.id), `the refusal names the ward the agent was not given: "${err.message}"`);
});
