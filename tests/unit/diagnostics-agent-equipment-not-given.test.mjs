// Review finding: the equipment commands have no ward gate. The laboratory and imaging are
// departments, which cannot be given to an agent; the engineering reads hide their assets and work
// orders from every agent, but the diagnostics reads show them, and an agent with no ward at all
// can queue a change to the analyser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { site, agent, code } from './sec-diagnostics-helper.mjs';

async function setup() {
  const s = await site();
  await s.run('ospeli_agents_set_access', { allowed: true, wards: { 'ward-a2': true } }, 'coo');
  await s.run('ospeli_agents_add', { name: 'dx-bot', role: 'unit-clerk', wards: ['ward-a2'], days: 30 }, 'coo');
  await s.run('ospeli_agents_add', { name: 'sci-bot', role: 'lab-scientist', wards: [], days: 30 }, 'coo');
  const wo = await s.run('ospeli_workorders_report_fault', { assetId: 'asset-analyser-1', fault: 'Analyser calibration error', priority: 'high' }, 'ops-manager');
  return { ...s, wo };
}

test('an agent given one ward is not shown the laboratory analyser\'s work order by the diagnostics reads, as it is not by the engineering reads', async () => {
  const { run, wo } = await setup();
  const bot = agent('unit-clerk');
  const eng = await run('ospeli_workorders_list', {}, bot);
  assert.ok(!JSON.stringify(eng).includes(wo.workOrderId), 'engineering hides it (the control)');
  const assets = await run('ospeli_assets_list', {}, bot);
  assert.ok(!assets.assets.some((a) => a.id === 'asset-analyser-1'), 'engineering hides the asset (the control)');
  const list = await run('ospeli_diagnostics_equipment_list', {}, bot);
  assert.ok(!JSON.stringify(list).includes(wo.workOrderId), 'ospeli_diagnostics_equipment_list shows the work order of a place the agent was not given');
  const ov = await run('ospeli_diagnostics_overview', {}, bot);
  assert.ok(!JSON.stringify(ov).includes(wo.workOrderId), 'ospeli_diagnostics_overview shows the work order of a place the agent was not given');
});

test('an agent with no ward cannot queue a change to an analyser in a department', async () => {
  const { run } = await setup();
  await assert.rejects(run('ospeli_diagnostics_equipment_set', { assetId: 'asset-analyser-1', state: 'down', reason: 'breakdown', backup: 'hold' }, agent('lab-scientist', 'sci-bot')), code('forbidden'),
    'a department cannot be given to an agent, so its equipment is for people to mark');
});
