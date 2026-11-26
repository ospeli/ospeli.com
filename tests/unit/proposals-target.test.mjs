// AUDIT: "a proposal is checked before it is queued: the target must exist". Not for an asset
// (ospeli_workorders_report_fault has no check) and not for a step of a map.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Core } from '../../web/app/core/core.js';
import { MemoryAdapter } from '../../web/app/core/db.js';
import { loadHospital } from './hospital-clock.mjs';
import { runCommand, CommandError } from '../../web/app/core/commands.js';

const END = '2026-11-06T18:00:00.000Z';
const human = (role) => ({ type: 'human', role });
async function setup() {
  let t = Date.parse(END);
  const core = await Core.open({ adapter: new MemoryAdapter(), clock: () => new Date(t += 1000) });
  await loadHospital(core, { end: END });
  await runCommand(core, 'ospeli_agents_set_access', { allowed: true, wards: {} }, human('coo'));
  await runCommand(core, 'ospeli_agents_add', { name: 'fix-bot', role: 'estates-tech', days: 30 }, human('coo'));
  await runCommand(core, 'ospeli_agents_add', { name: 'map-bot', role: 'ops-manager', days: 30 }, human('coo'));
  return core;
}
const refused = (c) => (err) => err instanceof CommandError && err.code === c;

test('a fault report for an asset that does not exist is refused before it is queued', async () => {
  const core = await setup();
  const F = { type: 'agent', role: 'estates-tech', agent: 'fix-bot' };
  const input = { assetId: 'asset-that-is-not-here', fault: 'Blocked sink', priority: 'routine' };
  await assert.rejects(runCommand(core, 'ospeli_workorders_report_fault', input, F, { dryRun: true }), refused('not-found'), 'a dry run says it would be queued');
  await assert.rejects(runCommand(core, 'ospeli_workorders_report_fault', input, F), refused('not-found'));
  assert.equal((await core.proposals()).length, 0, 'nothing waits for a person');
  assert.ok(!JSON.stringify(await core.auditLog()).includes('asset-that-is-not-here'), 'the id the agent typed is not in the audit trail');
});

test('a fault that is not one of the asset\'s faults is refused before it is queued', async () => {
  const core = await setup();
  const F = { type: 'agent', role: 'estates-tech', agent: 'fix-bot' };
  // A generator cannot have a blocked sink; a person who tries this is refused (invalid-input).
  await assert.rejects(runCommand(core, 'ospeli_workorders_report_fault', { assetId: 'asset-generator-1', fault: 'Blocked sink', priority: 'routine' }, human('estates-tech')), refused('invalid-input'));
  // The generator is in plant, outside any ward: since #26 only an agent allowed on every ward may
  // name it (an agent with no ward is refused agents-off first), so this agent is given every ward.
  const wards = (await core.listEntities('ward')).map((w) => w.id);
  await runCommand(core, 'ospeli_agents_set_access', { allowed: true, wards: Object.fromEntries(wards.map((w) => [w, true])) }, human('coo'));
  await runCommand(core, 'ospeli_agents_add', { name: 'fix-bot', role: 'estates-tech', wards, days: 30 }, human('coo'));
  await assert.rejects(runCommand(core, 'ospeli_workorders_report_fault', { assetId: 'asset-generator-1', fault: 'Blocked sink', priority: 'routine' }, F), refused('invalid-input'));
});

test('a change to a map step that does not exist is refused before it is queued', async () => {
  const core = await setup();
  await runCommand(core, 'ospeli_maps_create', { from: 'blank', title: 'Target test' }, human('ops-manager'));
  const M = { type: 'agent', role: 'ops-manager', agent: 'map-bot' };
  await assert.rejects(runCommand(core, 'ospeli_maps_step_remove', { mapId: 'map-001', version: 'proposed', stepId: 'map-001-s99' }, M), refused('not-found'));
  assert.equal((await core.proposals()).length, 0);
});
