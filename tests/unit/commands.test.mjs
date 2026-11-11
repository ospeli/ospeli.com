// The command layer (backlog A2) runs without the UI: people and agents use the same commands.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Core, findIdentifierFields } from '../../web/app/core/core.js';
import { MemoryAdapter } from '../../web/app/core/db.js';
import { loadSyntheticHospital } from '../../web/app/core/generator.js';
import { runCommand, listCommands, describeCommand, commandByName, ACTION_COMMANDS, CommandError } from '../../web/app/core/commands.js';
import { validate } from '../../web/app/core/schema.js';
import { deriveBoard, bedActions } from '../../web/app/core/beds.js';
import { computeKpi } from '../../web/app/core/kpi.js';
import { verifyChain } from '../../web/app/core/audit.js';
import { ROLES } from '../../web/app/core/model.js';

const END = '2026-11-06T18:00:00.000Z';
const clockFrom = (iso) => { let t = Date.parse(iso); return () => new Date(t += 1000); };
async function hospital(adapter = new MemoryAdapter(), clock = clockFrom(END)) {
  const core = await Core.open({ adapter, clock });
  await loadSyntheticHospital(core, { end: END });
  return core;
}
const human = (role) => ({ type: 'human', role });
const agent = (role, name = 'test-agent') => ({ type: 'agent', role, agent: name });
const code = (c) => (err) => err instanceof CommandError && err.code === c;

async function freeBed(core, wardId) {
  const board = await runCommand(core, 'beds.board', wardId ? { wardId } : {}, human('bed-manager'));
  return { board, bed: board.beds.find((b) => b.state === 'available'), waiting: board.waiting.find((w) => !w.allocatedBed) };
}

test('every command declares schemas, roles, approval and a valid example', () => {
  const list = listCommands();
  assert.ok(list.length >= 14);
  const names = new Set();
  for (const c of list) {
    assert.match(c.name, /^[a-z]+(\.[a-z-]+)+$/, c.name);
    assert.ok(!names.has(c.name), `duplicate ${c.name}`); names.add(c.name);
    assert.ok(c.summary.length > 10, c.name);
    assert.ok(['read', 'write'].includes(c.kind), c.name);
    assert.equal(c.input.type, 'object', c.name);
    assert.equal(c.output.type, 'object', c.name);
    assert.equal(typeof c.humanApproval, 'boolean', c.name);
    assert.ok(c.roles.length && c.roles.every((r) => ROLES.some((x) => x.id === r)), c.name);
    assert.deepEqual(validate(c.input, c.example.input), [], `${c.name} example`);
    if (c.kind === 'write') assert.equal(c.humanApproval, true, `${c.name}: agent writes wait for a person`);
    assert.doesNotThrow(() => JSON.stringify(c));
  }
  for (const name of Object.values(ACTION_COMMANDS)) assert.ok(commandByName(name), name);
  assert.equal(describeCommand('nope'), null);
});

test('beds.board returns schema-valid JSON that agrees with the occupancy KPI', async () => {
  const core = await hospital();
  const out = await runCommand(core, 'beds.board', {}, human('coo'));
  assert.deepEqual(validate(commandByName('beds.board').output, out, 'output'), []);
  assert.equal(out.synthetic, true);
  assert.equal(out.beds.length, 120);
  assert.equal(out.wards.length, 6);
  assert.deepEqual(out.conflicts, []);
  const occupied = out.beds.filter((b) => b.state === 'occupied' || b.state === 'expected-discharge').length;
  const occ = computeKpi('occupancy', await core.events(), { until: '2026-11-07T00:00:00.000Z', bedCount: 120 });
  assert.equal(occupied, occ.numerator);
  const one = await runCommand(core, 'beds.board', { wardId: 'ward-a1' }, human('ward-nurse'));
  assert.equal(one.beds.length, 20);
  assert.ok(one.beds.every((b) => b.wardId === 'ward-a1'));
  await assert.rejects(runCommand(core, 'beds.board', { wardId: 'ward-zz' }, human('coo')), code('not-found'));
});

test('a full bed cycle runs through commands alone, each output schema-valid', async () => {
  const core = await hospital();
  const { bed, waiting } = await freeBed(core);
  assert.ok(bed && waiting);
  const steps = [
    ['bed.allocate', 'bed-manager', { encounter: waiting.encounter }, 'allocated'],
    ['bed.admit', 'ward-nurse', {}, 'occupied'],
    ['bed.flag-expected-discharge', 'ward-nurse', {}, 'expected-discharge'],
    ['bed.mark-vacated', 'ward-nurse', {}, 'vacated'],
    ['bed.start-clean', 'ward-nurse', {}, 'cleaning'],
    ['bed.finish-clean', 'ward-nurse', {}, 'available'],
    ['bed.take-out-of-service', 'estates-tech', { reason: 'Electrical' }, 'out-of-service'],
    ['bed.return-to-service', 'estates-tech', {}, 'available'],
  ];
  for (const [name, role, extra, to] of steps) {
    const out = await runCommand(core, name, { bedId: bed.id, ...extra }, human(role));
    assert.deepEqual(validate(commandByName(name).output, out, 'output'), [], name);
    assert.equal(out.status, 'done');
    assert.equal(out.state, to, name);
    const got = await runCommand(core, 'bed.get', { bedId: bed.id }, human(role));
    assert.equal(got.bed.state, to, `${name} leaves the bed ${to}`);
  }
  const mine = (await core.events()).filter((e) => e.subject === bed.id || e.data?.bedId === bed.id).slice(-9);
  assert.deepEqual(mine.map((e) => e.type), ['bed.allocated', 'patient.admitted', 'patient.expected-discharge', 'patient.discharged', 'bed.vacated', 'bed.clean-started', 'bed.cleaned', 'bed.out-of-service', 'bed.back-in-service']);
  assert.equal(mine[0].actorRole, 'bed-manager');
});

test('commands check role and input', async () => {
  const core = await hospital();
  const { bed, waiting } = await freeBed(core);
  await assert.rejects(runCommand(core, 'bed.allocate', { bedId: bed.id, encounter: waiting.encounter }, human('coo')), code('forbidden'));
  await assert.rejects(runCommand(core, 'bed.allocate', { bedId: bed.id }, human('bed-manager')), code('invalid-input'));
  await assert.rejects(runCommand(core, 'bed.take-out-of-service', { bedId: bed.id, reason: 'Gremlins' }, human('ward-nurse')), code('invalid-input'));
  await assert.rejects(runCommand(core, 'bed.admit', { bedId: bed.id, extra: 1 }, human('ward-nurse')), code('invalid-input'));
  await assert.rejects(runCommand(core, 'bed.admit', { bedId: 'no-such-bed' }, human('ward-nurse')), code('not-found'));
  await assert.rejects(runCommand(core, 'bed.admit', { bedId: bed.id }, human('ward-nurse')), code('conflict'), 'nobody is allocated to it');
  await assert.rejects(runCommand(core, 'beds.teleport', {}, human('coo')), code('unknown-command'));
  await assert.rejects(runCommand(core, 'beds.board', {}, { type: 'human', role: 'janitor' }), code('forbidden'));
  const next = await runCommand(core, 'bed.get', { bedId: bed.id }, human('coo'));
  assert.deepEqual(next.next, [], 'the COO can read but not change beds');
  // The same patient cannot be given two beds.
  await runCommand(core, 'bed.allocate', { bedId: bed.id, encounter: waiting.encounter }, human('bed-manager'));
  const other = (await runCommand(core, 'beds.board', {}, human('bed-manager'))).beds.find((b) => b.state === 'available');
  if (other) await assert.rejects(runCommand(core, 'bed.allocate', { bedId: other.id, encounter: waiting.encounter }, human('bed-manager')), code('conflict'));
});

test('issue #9: a stale tab cannot take an occupied bed out of service; board and KPI agree', async () => {
  const shared = new MemoryAdapter();
  const clock = clockFrom(END);
  const a = await hospital(shared, clock);
  const b = await Core.open({ adapter: shared, clock }); // second tab, opened earlier, now stale
  const { bed, waiting } = await freeBed(a);
  await runCommand(a, 'bed.allocate', { bedId: bed.id, encounter: waiting.encounter }, human('bed-manager'));
  await runCommand(a, 'bed.admit', { bedId: bed.id }, human('ward-nurse'));
  // Tab B still thinks the bed is available.
  await assert.rejects(runCommand(b, 'bed.take-out-of-service', { bedId: bed.id, reason: 'Electrical', expectedState: 'available' }, human('ward-nurse')),
    (err) => err.code === 'conflict' && err.detail.state === 'occupied');
  await assert.rejects(runCommand(b, 'bed.take-out-of-service', { bedId: bed.id, reason: 'Electrical' }, human('ward-nurse')), code('conflict'));
  await assert.rejects(runCommand(b, 'bed.allocate', { bedId: bed.id, encounter: waiting.encounter }, human('bed-manager')), code('conflict'));
  const events = await b.events();
  const board = deriveBoard(await b.listEntities('bed'), events);
  assert.equal(board.beds.get(bed.id).state, 'occupied');
  assert.equal(board.beds.get(bed.id).encounter, waiting.encounter);
  const c = [...board.beds.values()].filter((x) => x.state === 'occupied' || x.state === 'expected-discharge').length;
  assert.equal(c, computeKpi('occupancy', events, { until: '2026-11-08T00:00:00.000Z', bedCount: 120 }).numerator);
});

test('the board ignores an event that would push a patient out of a bed, and lists it', () => {
  const beds = [{ id: 'b1', type: 'bed', name: 'Bed 01', parentId: 'w1' }];
  const at = (h) => `2026-11-01T${String(h).padStart(2, '0')}:00:00.000Z`;
  const log = [
    { seq: 1, type: 'patient.admitted', subject: 'e1', actorRole: 'ward-nurse', at: at(8), data: { bedId: 'b1' } },
    { seq: 2, type: 'bed.out-of-service', subject: 'b1', actorRole: 'ward-nurse', at: at(9), data: { reason: 'Electrical' } },
    { seq: 3, type: 'bed.allocated', subject: 'b1', actorRole: 'bed-manager', at: at(10), data: { encounter: 'e2' } },
    { seq: 4, type: 'patient.admitted', subject: 'e3', actorRole: 'ward-nurse', at: at(11), data: { bedId: 'b1' } },
  ];
  const board = deriveBoard(beds, log);
  assert.equal(board.beds.get('b1').state, 'occupied');
  assert.equal(board.beds.get('b1').encounter, 'e1');
  assert.deepEqual(board.conflicts.map((c) => c.seq), [2, 3, 4]);
  assert.deepEqual(bedActions(board.beds.get('b1')), ['expect-discharge', 'vacate']);
});

test('agents: off by default, audited as agents, read only allowed wards, and only propose', async () => {
  const core = await hospital();
  const auditBefore = (await core.auditLog()).length;
  await assert.rejects(runCommand(core, 'beds.board', {}, agent('bed-manager')), code('agents-off'));
  let log = await core.auditLog();
  assert.equal(log.length, auditBefore + 1);
  assert.equal(log.at(-1).action, 'agent.refused');
  assert.equal(log.at(-1).actorType, 'agent');
  assert.equal(log.at(-1).agent, 'test-agent');
  assert.equal(log.at(-1).actorRole, 'bed-manager');

  // Only people (ops manager or COO) can switch agents on.
  await assert.rejects(runCommand(core, 'agents.set-access', { allowed: true }, agent('coo')), code('agents-off'));
  await assert.rejects(runCommand(core, 'agents.set-access', { allowed: true }, human('ward-nurse')), code('forbidden'));
  await runCommand(core, 'agents.set-access', { allowed: true, wards: { 'ward-a1': true } }, human('coo'));
  // Agents must also be on the site's list, each for one role (issues #20, #25).
  await runCommand(core, 'agent.add', { name: 'test-agent', role: 'bed-manager', wards: ['ward-a1', 'ward-b1'], days: 30 }, human('coo'));
  await runCommand(core, 'agent.add', { name: 'night-helper', role: 'ward-nurse', wards: ['ward-a1'], days: 30 }, human('coo'));
  await runCommand(core, 'agent.add', { name: 'coo-helper', role: 'coo', wards: [], days: 30 }, human('coo'));
  assert.deepEqual(await runCommand(core, 'agents.access', {}, agent('coo', 'coo-helper')), { allowed: true, wards: { 'ward-a1': true } });

  const read = await runCommand(core, 'beds.board', {}, agent('bed-manager'));
  assert.deepEqual(read.wards.map((w) => w.id), ['ward-a1'], 'agents see only wards switched on');
  assert.ok(read.beds.every((b) => b.wardId === 'ward-a1'));
  await assert.rejects(runCommand(core, 'beds.board', { wardId: 'ward-b1' }, agent('bed-manager')), code('agents-off'));
  await assert.rejects(runCommand(core, 'bed.get', { bedId: 'ward-b1-bed-01' }, agent('bed-manager')), code('agents-off'));

  const bed = read.beds.find((b) => b.state === 'available') || read.beds[0];
  const eventsBefore = await core.eventCount();
  const out = await runCommand(core, 'bed.take-out-of-service', { bedId: bed.id, reason: 'Electrical' }, agent('ward-nurse', 'night-helper'));
  assert.equal(out.status, 'proposed');
  assert.deepEqual(validate(commandByName('bed.take-out-of-service').output, out, 'output'), []);
  assert.equal(await core.eventCount(), eventsBefore, 'a proposal changes nothing in the event log');
  const props = await core.proposals();
  assert.equal(props.length, 1);
  assert.deepEqual({ ...props[0], at: 0 }, { id: 'prop-0001', command: 'bed.take-out-of-service', input: { bedId: bed.id, reason: 'Electrical' }, agent: 'night-helper', role: 'ward-nurse', at: 0, status: 'pending', wardId: 'ward-a1', seenState: bed.state });
  log = await core.auditLog();
  assert.equal(log.at(-1).action, 'agent.proposed');
  assert.equal(log.at(-1).actorType, 'agent');
  assert.equal(log.at(-1).agent, 'night-helper');
  assert.ok(log.some((e) => e.action === 'agent.read' && e.actorType === 'agent' && e.detail.command === 'beds.board'));
  // An agent's role rules still apply, and an agent must name itself.
  await assert.rejects(runCommand(core, 'bed.admit', { bedId: bed.id }, agent('coo', 'coo-helper')), code('forbidden'));
  await assert.rejects(runCommand(core, 'beds.board', {}, { type: 'agent', role: 'coo' }), code('forbidden'));
  assert.deepEqual(await core.verifyAudit(), { ok: true }, 'agent entries keep the chain intact');
  assert.deepEqual(await verifyChain(await core.auditLog()), { ok: true });
});

test('kpi commands return the number with its definition', async () => {
  const core = await hospital();
  const list = await runCommand(core, 'kpi.list', {}, human('coo'));
  assert.ok(list.kpis.length >= 7);
  const v = await runCommand(core, 'kpi.value', { id: 'occupancy' }, human('coo'));
  assert.deepEqual(validate(commandByName('kpi.value').output, v, 'output'), []);
  assert.equal(v.definition.id, 'occupancy');
  assert.ok(v.definition.numerator && v.definition.source);
  assert.ok(v.value > 0 && v.value <= 100);
});

test('issue #5: import refuses files not marked synthetic or with personal-detail fields', async () => {
  const core = await hospital();
  const dump = await core.exportData();
  assert.equal(dump.synthetic, true);
  assert.deepEqual(findIdentifierFields(dump), [], 'the synthetic hospital has no personal-detail fields');
  const target = await Core.open({ adapter: new MemoryAdapter(), clock: clockFrom(END) });

  const notSynthetic = structuredClone(dump); notSynthetic.synthetic = false;
  await assert.rejects(target.importData(notSynthetic, 'coo'), /synthetic data only/);
  const missingFlag = structuredClone(dump); delete missingFlag.synthetic;
  await assert.rejects(target.importData(missingFlag, 'coo'), /synthetic data only/);
  for (const key of ['patientName', 'nhsNumber', 'MRN', 'date_of_birth', 'homeAddress', 'phone', 'staffId']) {
    const f = structuredClone(dump);
    f.events[3].data = { ...(f.events[3].data || {}), [key]: 'placeholder' };
    await assert.rejects(target.importData(f, 'coo'), /personal details/, key);
  }
  const ent = structuredClone(dump);
  ent.entities[0].contactEmail = 'placeholder';
  await assert.rejects(target.importData(ent, 'coo'), /personal details.*entities\[0\]\.contactEmail/);
  assert.equal((await target.listEntities()).length, 0, 'nothing was imported');

  await target.importData(structuredClone(dump), 'coo');
  assert.equal(await target.getMeta('synthetic'), true);
  assert.deepEqual((await target.auditLog()).at(-1).detail.checks, { markedSynthetic: true, identifierFields: 0 });
  await target.reset();
  assert.equal(await target.getMeta('synthetic'), null, 'after a reset nothing claims to be synthetic');
  assert.equal(await target.getMeta('generator'), null);
});
