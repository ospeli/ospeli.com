// Finding: the transfers module (and one facilities guide rule) decides "is this a ward?" by whether
// the id starts with "ward-", not by the entity's type. A ward's id may be any lower-case id (model.js
// validateEntity; an import or a site's own set-up can name a ward "unit-z9"). For such a ward the
// agent ward gate never runs: an agent that was given ward-a2 only can propose a journey out of it,
// propose changes to its journeys, and is shown its repeat faults by name. Synthetic data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Core } from '../../web/app/core/core.js';
import { MemoryAdapter } from '../../web/app/core/db.js';
import { loadSyntheticHospital } from '../../web/app/core/generator.js';
import { runCommand } from '../../web/app/core/commands.js';

const END = '2026-11-06T18:00:00.000Z';
const WARD = 'unit-z9';
async function site() {
  let t = Date.parse(END);
  const core = await Core.open({ adapter: new MemoryAdapter(), clock: () => new Date(t += 1000) });
  await loadSyntheticHospital(core, { end: END });
  await core.putEntity({ id: WARD, type: 'ward', name: 'Unit Z9 (example)', parentId: 'dept-medicine', beds: 0 }, 'ops-manager');
  for (const i of [1, 2]) await core.putEntity({ id: `asset-z9-sink-${i}`, type: 'asset', name: `Sink ${i}`, parentId: WARD, kind: 'sink' }, 'ops-manager');
  const run = (name, input, who) => runCommand(core, name, input, typeof who === 'string' ? { type: 'human', role: who } : who);
  // Agents are on for ward-a2 only. The new ward is never switched on and no agent is given it.
  await run('ospeli_agents_set_access', { allowed: true, wards: { 'ward-a2': true } }, 'coo');
  const bot = {};
  for (const role of ['ward-nurse', 'transport-coordinator', 'estates-tech']) {
    await run('ospeli_agents_add', { name: `${role}-bot`, role, wards: ['ward-a2'], days: 30 }, 'coo');
    bot[role] = { type: 'agent', agent: `${role}-bot`, role };
  }
  return { core, run, bot };
}
const JOURNEY = { type: 'discharge', fromPlace: WARD, toOutside: 'home', needed: 'asap', mobility: 'walks', escort: 'none', equipment: ['none'] };
const gate = (e) => ['agents-off', 'forbidden'].includes(e.code);

test('the gate works for a ward whose id starts with ward- (control)', async () => {
  const { run, bot } = await site();
  await assert.rejects(run('ospeli_transfers_request', { ...JOURNEY, fromPlace: 'ward-a1' }, bot['ward-nurse']), gate);
});

test('an agent cannot propose a journey out of a ward it was not given, whatever the ward\'s id', async () => {
  const { core, run, bot } = await site();
  let out = null; let err = null;
  try { out = await run('ospeli_transfers_request', JOURNEY, bot['ward-nurse']); } catch (e) { err = e; }
  assert.ok(err && gate(err), `expected the ward gate to refuse; got ${err ? `${err.code}: ${err.message}` : `status "${out.status}", ${out.proposal?.id} queued with wardId ${JSON.stringify(out.proposal?.wardId)}`}`);
  assert.equal((await core.proposals()).length, 0);
});

test('an agent cannot propose a change to a journey from a ward it was not given, whatever the ward\'s id', async () => {
  const { run, bot } = await site();
  const { transferId } = await run('ospeli_transfers_request', JOURNEY, 'ward-nurse');
  for (const [name, input] of [['ospeli_transfers_assign', { transferId, vehicleId: 'asset-vehicle-3' }], ['ospeli_transfers_delay', { transferId, reason: 'no-vehicle' }], ['ospeli_transfers_cancel', { transferId, reason: 'not-needed' }]]) {
    let out = null; let err = null;
    try { out = await run(name, input, bot['transport-coordinator']); } catch (e) { err = e; }
    assert.ok(err && gate(err), `${name}: expected the ward gate to refuse; got ${err ? `${err.code}: ${err.message}` : `status "${out.status}" (${out.proposal?.id})`}`);
  }
});

test('the facilities guide does not show an agent the repeat faults of a ward it was not given', async () => {
  const { run, bot } = await site();
  for (const i of [1, 2]) await run('ospeli_workorders_report_fault', { assetId: `asset-z9-sink-${i}`, fault: 'Tap leaking', priority: 'routine' }, 'ward-nurse');
  const person = await run('ospeli_facilities_overview', {}, 'facilities-manager');
  assert.ok(person.guide.suggestions.some((s) => s.id === `repeat-faults:${WARD}:water`), 'a person sees the suggestion');
  const seen = await run('ospeli_facilities_overview', {}, bot['estates-tech']);
  const leaked = seen.guide.suggestions.filter((s) => JSON.stringify(s).includes(WARD) || JSON.stringify(s).includes('Unit Z9'));
  assert.deepEqual(leaked.map((s) => `${s.id}: ${s.text} ${s.why}`), [], 'the agent is shown the other ward\'s faults');
});
