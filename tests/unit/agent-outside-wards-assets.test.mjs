// Issue #26 (and #126, point 1): an agent listed for one ward could act on, and learn about,
// assets and work orders in places outside any ward (a department, plant, a lift). The ward gate
// was skipped when the target was not in a ward, so a proposal was queued and a refusal named the
// asset. Now such a target is refused (agents-off, recorded as agent.refused) unless the agent is
// allowed on every ward of the site. Checked in the browser's runCommand and on the site server.
// The first three tests are the audit's proofs (docs/audit/2026-11-18 in ospeli/ospeli). Synthetic data only.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Core } from '../../web/app/core/core.js';
import { MemoryAdapter } from '../../web/app/core/db.js';
import { loadSyntheticHospital } from '../../web/app/core/generator.js';
import { runCommand } from '../../web/app/core/commands.js';
import { faultsFor } from '../../web/app/core/workorders.js';

const END = '2026-11-08T12:00:00.000Z';
const coo = { type: 'human', role: 'coo' };
const bot = { type: 'agent', role: 'estates-tech', agent: 'fault-helper' };

async function setup(wards = ['ward-a1']) {
  let t = Date.parse(END);
  const core = await Core.open({ adapter: new MemoryAdapter(), clock: () => new Date(t += 1000) });
  await loadSyntheticHospital(core, { end: END });
  if (wards === 'all') wards = (await core.listEntities('ward')).map((w) => w.id);
  await runCommand(core, 'ospeli_agents_add', { name: 'fault-helper', role: 'estates-tech', wards, days: 30 }, coo);
  await runCommand(core, 'ospeli_agents_set_access', { allowed: true, wards: Object.fromEntries(wards.map((w) => [w, true])) }, coo);
  const wardIds = new Set((await core.listEntities('ward')).map((w) => w.id));
  const outside = (await core.listEntities('asset')).filter((a) => !wardIds.has(a.parentId));
  assert.ok(outside.length, 'the example hospital has assets outside a ward');
  return { core, outside };
}

test('an agent cannot propose a fault report on an asset outside the wards it was given', async () => {
  const { core, outside } = await setup();
  const asset = outside[0];
  const seen = await runCommand(core, 'ospeli_assets_list', { limit: 1000 }, bot);
  assert.ok(!seen.assets.some((a) => a.id === asset.id), 'the agent\'s own read does not show this asset');
  let out = null; let err = null;
  try { out = await runCommand(core, 'ospeli_workorders_report_fault', { assetId: asset.id, fault: faultsFor(asset.kind).at(-1), priority: 'urgent' }, bot); } catch (e) { err = e; }
  assert.equal(out, null, `a proposal was queued for an asset the agent may not see: ${out?.proposal?.id} on ${asset.id}`);
  assert.ok(err);
});

test('a refusal does not tell the agent the name of an asset outside its wards', async () => {
  const { core, outside } = await setup();
  const asset = outside.find((a) => faultsFor(a.kind).length > 1);
  const wrong = 'Blocked sink' === faultsFor(asset.kind)[0] ? 'IV pump alarm' : 'Blocked sink';
  let err = null;
  try { await runCommand(core, 'ospeli_workorders_report_fault', { assetId: asset.id, fault: wrong, priority: 'routine' }, bot); } catch (e) { err = e; }
  assert.ok(err);
  assert.ok(!err.message.includes(asset.name), `the refusal names an asset outside the agent's wards: ${err.message}`);
});

test('an agent cannot propose closing, or read the state of, a work order outside its wards', async () => {
  const { core, outside } = await setup();
  const asset = outside[0];
  const made = await runCommand(core, 'ospeli_workorders_report_fault', { assetId: asset.id, fault: faultsFor(asset.kind).at(-1), priority: 'routine' }, { type: 'human', role: 'estates-tech' });
  const list = await runCommand(core, 'ospeli_workorders_list', { state: 'all', limit: 500 }, bot);
  assert.ok(!list.workOrders.some((w) => w.id === made.workOrderId), 'the agent\'s own read does not show this work order');
  let out = null;
  try { out = await runCommand(core, 'ospeli_workorders_complete', { workOrderId: made.workOrderId, outcome: 'fixed' }, bot); } catch { /* refused: correct */ }
  assert.equal(out, null, `a proposal to close ${made.workOrderId} was queued by an agent that may not see it (seenState ${out?.proposal?.seenState})`);
});

test('#26: a one-ward agent is refused (agents-off, audited) on a lab, plant and lift asset, and on their work orders', async () => {
  const { core } = await setup();
  for (const assetId of ['asset-analyser-1', 'asset-boiler-1', 'asset-lift-a']) {
    const asset = await core.getEntity(assetId);
    let err = null;
    try { await runCommand(core, 'ospeli_workorders_report_fault', { assetId, fault: faultsFor(asset.kind)[0], priority: 'urgent' }, bot); } catch (e) { err = e; }
    assert.equal(err?.code, 'agents-off', `${assetId}: ${err?.code} ${err?.message}`);
    assert.ok(!err.message.includes(asset.name));
    let read = null;
    try { await runCommand(core, 'ospeli_workorders_list', { assetId }, bot); } catch (e) { read = e; }
    assert.equal(read?.code, 'agents-off', `${assetId}: reads follow the same rule`);
  }
  const made = await runCommand(core, 'ospeli_workorders_report_fault', { assetId: 'asset-lift-a', fault: faultsFor('lift')[0], priority: 'urgent' }, { type: 'human', role: 'estates-tech' });
  for (const [name, input] of [['ospeli_workorders_assign', { workOrderId: made.workOrderId, team: 'estates' }], ['ospeli_workorders_complete', { workOrderId: made.workOrderId, outcome: 'fixed' }]]) {
    let err = null;
    try { await runCommand(core, name, input, bot); } catch (e) { err = e; }
    assert.equal(err?.code, 'agents-off', `${name}: ${err?.code} ${err?.message}`);
  }
  assert.equal((await core.proposals()).length, 0, 'nothing was queued');
  const refused = (await core.auditLog()).filter((e) => e.action === 'agent.refused' && e.detail?.reason === 'outside-wards');
  assert.ok(refused.length >= 1, 'the refusals are in the trail as agent.refused');
  assert.ok(refused.every((e) => e.detail.code === 'agents-off'));
});

test('#26: an agent allowed on every ward of the site may still propose on a place outside a ward; a ward asset is unchanged', async () => {
  const all = await setup('all');
  const out = await runCommand(all.core, 'ospeli_workorders_report_fault', { assetId: 'asset-analyser-1', fault: faultsFor('lab')[0], priority: 'urgent' }, bot);
  assert.equal(out.status, 'proposed');
  const one = await setup();
  const ward = (await one.core.listEntities('asset')).find((a) => a.parentId === 'ward-a1');
  const mine = await runCommand(one.core, 'ospeli_workorders_report_fault', { assetId: ward.id, fault: faultsFor(ward.kind)[0], priority: 'routine' }, bot);
  assert.equal(mine.status, 'proposed', 'an asset on the agent\'s own ward is proposed as before');
});

// The site server path: a key for Ward A1 only, over HTTP (Critic re-test, 13 Nov).
const dir = mkdtempSync(join(tmpdir(), 'ospeli-26-'));
const sites = [];
after(async () => { for (const s of sites) await s.close().catch(() => {}); rmSync(dir, { recursive: true, force: true }); });

test('#26 on the site server: a Ward A1 key cannot propose an urgent fault on a lift', async () => {
  const emit = process.emitWarning;
  process.emitWarning = (w, ...rest) => (/SQLite/i.test(String(w?.message || w)) ? undefined : emit.call(process, w, ...rest));
  const { startServer } = await import('../../tools/ospeli-server/site-server.mjs');
  const t = { now: Date.parse(END) };
  const site = await startServer({ file: join(dir, 'site.db'), port: 0, end: END, clock: () => new Date(t.now += 1000) });
  sites.push(site);
  for (const line of ['setup agent', 'lift-helper', '1', '1']) await site.consoleLine(line);
  const key = /osk_[0-9a-f]{8}_[A-Za-z0-9_-]{32}/.exec(await site.consoleLine(''))[0];
  const listed = (await runCommand(site.core, 'ospeli_agents_list', {}, coo)).agents.find((a) => a.name === 'lift-helper');
  assert.equal(listed.wards.length, 1, 'the key is for one ward');
  const r = await fetch(`${site.url}/api/v1/commands/ospeli_workorders_report_fault`, {
    method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ input: { assetId: 'asset-lift-a', fault: faultsFor('lift')[0], priority: 'urgent' } }),
  });
  const body = await r.json();
  assert.notEqual(body.result?.status, 'proposed', `a proposal was queued: ${JSON.stringify(body).slice(0, 200)}`);
  assert.equal(body.error?.code, 'agents-off', JSON.stringify(body).slice(0, 200));
  assert.equal((await site.core.proposals()).length, 0);
  assert.ok((await site.core.auditLog()).some((e) => e.action === 'agent.refused' && e.detail?.reason === 'outside-wards'));
});
