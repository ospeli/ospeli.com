// Issue #20 (security): an agent allowed on one ward only still got hospital-wide KPIs from
// ospeli_kpi_get (kpi.value) and ospeli_kpi_summary. KPIs for one ward are not built yet, so a
// hospital-wide number is now read only by an agent allowed on every ward of the site (and
// switched on for each), as for places outside a ward (#26). Any other agent gets a clear
// refusal that names the wards it may see. People and KPI definitions are unchanged.
// Checked in the browser's runCommand and on the site server. Synthetic data only.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Core } from '../../web/app/core/core.js';
import { MemoryAdapter } from '../../web/app/core/db.js';
import { loadSyntheticHospital } from '../../web/app/core/generator.js';
import { runCommand } from '../../web/app/core/commands.js';

const END = '2026-11-08T12:00:00.000Z';
const coo = { type: 'human', role: 'coo' };
const bot = { type: 'agent', role: 'bed-manager', agent: 'flow-bot' };

async function setup(wards = ['ward-a1']) {
  let t = Date.parse(END);
  const core = await Core.open({ adapter: new MemoryAdapter(), clock: () => new Date(t += 1000) });
  await loadSyntheticHospital(core, { end: END });
  if (wards === 'all') wards = (await core.listEntities('ward')).map((w) => w.id);
  await runCommand(core, 'ospeli_agents_add', { name: 'flow-bot', role: 'bed-manager', wards, days: 30 }, coo);
  await runCommand(core, 'ospeli_agents_set_access', { allowed: true, wards: Object.fromEntries(wards.map((w) => [w, true])) }, coo);
  return core;
}
const attempt = async (p) => { try { return { out: await p }; } catch (err) { return { err }; } };

test('#20: a Ward A1 agent does not get hospital-wide KPIs; the refusal names its wards', async () => {
  const core = await setup();
  for (const [name, input] of [['ospeli_kpi_get', { id: 'occupancy' }], ['ospeli_kpi_summary', {}], ['kpi.value', { id: 'occupancy' }]]) {
    const { out, err } = await attempt(runCommand(core, name, input, bot));
    assert.equal(out, undefined, `${name} gave a ward-only agent the whole hospital: ${JSON.stringify(out)?.slice(0, 160)}`);
    assert.equal(err?.code, 'forbidden', `${name}: ${err?.code} ${err?.message}`);
    assert.match(err.message, /ward-a1/, 'the refusal names the wards this agent may see');
    assert.match(err.message, /every ward/, 'and says what would allow it');
  }
  const refused = (await core.auditLog()).filter((e) => e.action === 'agent.refused' && e.detail?.reason === 'site-wide');
  // kpi.value is the old name of ospeli_kpi_get, and the trail counts a repeat within a minute on
  // one entry, so the three calls leave two entries (one per command).
  assert.deepEqual(refused.map((e) => e.detail.command).sort(), ['ospeli_kpi_get', 'ospeli_kpi_summary'], 'each refusal is in the trail as agent.refused');
  assert.ok(refused.every((e) => e.detail.why && !/ward-a1/.test(e.detail.why)), 'the trail keeps fixed words');
  // Definitions hold no numbers, and the agent's own ward board still works.
  assert.ok((await runCommand(core, 'ospeli_kpi_list', {}, bot)).kpis.length > 0);
  assert.deepEqual((await runCommand(core, 'ospeli_beds_board', {}, bot)).wards.map((w) => w.id), ['ward-a1']);
});

test('#20: an agent allowed on every ward still reads hospital KPIs; people are unchanged', async () => {
  const all = await setup('all');
  const mine = await runCommand(all, 'ospeli_kpi_get', { id: 'occupancy' }, bot);
  const person = await runCommand(all, 'ospeli_kpi_get', { id: 'occupancy' }, coo);
  assert.equal(mine.value, person.value);
  assert.equal((await runCommand(all, 'ospeli_kpi_summary', {}, bot)).kpis.length, (await runCommand(all, 'ospeli_kpi_summary', {}, coo)).kpis.length);
  // Listed on every ward but one of them switched off for agents: refused.
  const wards = (await all.listEntities('ward')).map((w) => w.id);
  await runCommand(all, 'ospeli_agents_set_access', { allowed: true, wards: Object.fromEntries(wards.map((w, i) => [w, i > 0])) }, coo);
  const { err } = await attempt(runCommand(all, 'ospeli_kpi_get', { id: 'occupancy' }, bot));
  assert.equal(err?.code, 'forbidden');
});

const dir = mkdtempSync(join(tmpdir(), 'ospeli-20-'));
const sites = [];
after(async () => { for (const s of sites) await s.close().catch(() => {}); rmSync(dir, { recursive: true, force: true }); });

test('#20 on the site server: a one-ward key gets a refusal for ospeli_kpi_get, not the hospital number', async () => {
  const emit = process.emitWarning;
  process.emitWarning = (w, ...rest) => (/SQLite/i.test(String(w?.message || w)) ? undefined : emit.call(process, w, ...rest));
  const { startServer } = await import('../../tools/ospeli-server/site-server.mjs');
  const t = { now: Date.parse(END) };
  const site = await startServer({ file: join(dir, 'site.db'), port: 0, end: END, clock: () => new Date(t.now += 1000) });
  sites.push(site);
  for (const line of ['setup agent', 'kpi-helper', '1', '1']) await site.consoleLine(line);
  const key = /osk_[0-9a-f]{8}_[A-Za-z0-9_-]{32}/.exec(await site.consoleLine(''))[0];
  const listed = (await runCommand(site.core, 'ospeli_agents_list', {}, coo)).agents.find((a) => a.name === 'kpi-helper');
  assert.equal(listed.wards.length, 1, 'the key is for one ward');
  const r = await fetch(`${site.url}/api/v1/commands/ospeli_kpi_get`, {
    method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ input: { id: 'occupancy' } }),
  });
  const body = await r.json();
  assert.equal(body.result, undefined, `a one-ward key got a hospital-wide KPI: ${JSON.stringify(body).slice(0, 200)}`);
  assert.equal(body.error?.code, 'forbidden', JSON.stringify(body).slice(0, 200));
  assert.ok(body.error.message.includes(listed.wards[0]), 'the refusal names the key\'s own ward');
  assert.ok((await site.core.auditLog()).some((e) => e.action === 'agent.refused' && e.detail?.reason === 'site-wide'));
});
