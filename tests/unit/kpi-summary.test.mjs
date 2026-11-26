// Issue #105: every command input says what it means; ospeli_kpi_get returns the tile's own text
// beside the number; ospeli_kpi_summary gives a COO's agent all the tiles in one read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Core } from '../../web/app/core/core.js';
import { MemoryAdapter } from '../../web/app/core/db.js';
import { loadHospital } from './hospital-clock.mjs';
import { runCommand, commandByName, listCommands } from '../../web/app/core/commands.js';
import { KPIS, kpiById, formatKpi, meetsTarget } from '../../web/app/core/kpi.js';
import { validate } from '../../web/app/core/schema.js';

const END = '2026-11-08T12:00:00.000Z';
const human = (role) => ({ type: 'human', role });
const ok = (name, out) => assert.deepEqual(validate(commandByName(name).output, out, 'output'), [], name);

async function setup() {
  let t = Date.parse(END);
  const core = await Core.open({ adapter: new MemoryAdapter(), clock: () => new Date(t += 1000) });
  await loadHospital(core, { end: END });
  return core;
}

test('#105: every input of every command has a description an agent can act on', () => {
  const missing = [];
  for (const c of listCommands()) {
    const cmd = commandByName(c.name ?? c);
    for (const [k, v] of Object.entries(cmd.input?.properties || {})) if (!v.description || v.description.length < 15) missing.push(`${cmd.name}.${k}`);
  }
  assert.deepEqual(missing, []);
});

test('#105: ospeli_kpi_get returns the unit, the text on the tile and whether it is on target', async () => {
  const core = await setup();
  assert.ok(KPIS.length > 0, 'there are measures to check');
  for (const kpi of KPIS) {
    const out = await runCommand(core, 'ospeli_kpi_get', { id: kpi.id }, human('coo'));
    ok('ospeli_kpi_get', out);
    assert.equal(out.name, kpi.name);
    assert.equal(out.unit, kpi.unit);
    assert.equal(out.display, formatKpi(kpi, out.value), `${kpi.id}: the same text as the tile`);
    assert.equal(out.onTarget, meetsTarget(kpi, out.value));
    assert.equal(out.targetText, kpi.targetText);
  }
});

test('#105 journey: a COO\'s agent reads all seven tiles in one call, short by default, definitions on request', async () => {
  const core = await setup();
  await runCommand(core, 'ospeli_agents_set_access', { allowed: true, wards: { 'ward-a1': true } }, human('ops-manager'));
  await runCommand(core, 'ospeli_agents_add', { name: 'morning-helper', role: 'coo', wards: ['ward-a1'], days: 30 }, human('ops-manager'));
  const calls = [];
  const agent = (cmd, input = {}) => { calls.push(cmd); return runCommand(core, cmd, input, { type: 'agent', agent: 'morning-helper', role: 'coo' }); };
  const out = await agent('ospeli_kpi_summary');
  ok('ospeli_kpi_summary', out);
  assert.equal(calls.length, 1);
  assert.deepEqual(out.kpis.map((k) => k.id), KPIS.map((k) => k.id));
  assert.equal(out.total, KPIS.length);
  for (const k of out.kpis) {
    const one = await runCommand(core, 'ospeli_kpi_get', { id: k.id }, human('coo'));
    assert.equal(k.value, one.value, `${k.id}: same number as ospeli_kpi_get`);
    assert.equal(k.display, formatKpi(kpiById(k.id), k.value));
    assert.equal(k.onTarget, meetsTarget(kpiById(k.id), k.value));
    assert.equal('definition' in k, false, 'short: no definition');
  }
  assert.match(out.note, /a person/i);
  const full = await agent('ospeli_kpi_summary', { format: 'detailed', days: 14 });
  ok('ospeli_kpi_summary', full);
  assert.equal(full.days, 14);
  for (const k of full.kpis) assert.equal(k.definition.id, k.id);
  // Audited as the agent's read.
  const reads = (await core.auditLog()).filter((e) => e.action === 'agent.read' && e.detail.command === 'ospeli_kpi_summary');
  assert.equal(reads.length, 2);
  assert.ok(reads.every((e) => e.actorType === 'agent'));
  // The schema says what each input means.
  const p = commandByName('ospeli_kpi_summary').input.properties;
  assert.deepEqual(Object.keys(p).sort(), ['days', 'format']);
});

test('#119: inputs inside arrays and nested objects have a description too', () => {
  const missing = [];
  const walk = (schema, path) => {
    const props = schema?.properties || {};
    for (const [k, v] of Object.entries(props)) {
      const p = `${path}.${k}`;
      if (!v.description || v.description.length < 15) missing.push(p);
      if (v.type === 'object' || v.properties) walk(v, p);
      if (v.items) walk(v.items, `${p}[]`);
    }
  };
  for (const c of listCommands()) {
    const cmd = commandByName(c.name ?? c);
    for (const [k, v] of Object.entries(cmd.input?.properties || {})) {
      if (v.properties) walk(v, `${cmd.name}.${k}`);
      if (v.items) walk(v.items, `${cmd.name}.${k}[]`);
    }
  }
  assert.deepEqual(missing, []);
});
