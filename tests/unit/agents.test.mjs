// The Agents screen as commands (issues #25, #20, #27; spec A9 first step), without the UI:
// off by default, only agents on the site's list in the role they were listed for, an end
// date, remove, stop all, and an audit entry for every refused agent call.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Core } from '../../web/app/core/core.js';
import { MemoryAdapter } from '../../web/app/core/db.js';
import { loadSyntheticHospital } from '../../web/app/core/generator.js';
import { runCommand, commandByName, CommandError, MAX_AGENT_DAYS } from '../../web/app/core/commands.js';
import { validate } from '../../web/app/core/schema.js';

const END = '2026-11-08T12:00:00.000Z';
const human = (role) => ({ type: 'human', role });
const agent = (role, name) => ({ type: 'agent', role, agent: name });
const code = (c) => (err) => err instanceof CommandError && err.code === c;
const ok = (name, out) => assert.deepEqual(validate(commandByName(name).output, out, 'output'), []);

// A clock the test can move: each call is one second later; skip() jumps ahead.
async function setup() {
  let t = Date.parse(END);
  const core = await Core.open({ adapter: new MemoryAdapter(), clock: () => new Date(t += 1000) });
  await loadSyntheticHospital(core, { end: END });
  return { core, skip: (ms) => { t += ms; } };
}
const refusals = async (core) => (await core.auditLog()).filter((e) => e.action === 'agent.refused');

test('agents screen: off by default; only a listed agent, in its listed role and wards, may read', async () => {
  const { core } = await setup();
  const start = await runCommand(core, 'ospeli_agents_list', {}, human('ward-nurse'));
  ok('ospeli_agents_list', start);
  assert.deepEqual({ dial: start.dial, agents: start.agents, canChange: start.canChange, keys: start.keys }, { dial: 'off', agents: [], canChange: false, keys: 'none' });
  assert.equal((await runCommand(core, 'ospeli_agents_list', {}, human('coo'))).canChange, true);

  // Only the operations manager or chief operating officer can add an agent; agents never can.
  const add = { name: 'night-flow-helper', role: 'bed-manager', wards: ['ward-a1'], days: 30 };
  await assert.rejects(runCommand(core, 'ospeli_agents_add', add, human('ward-nurse')), code('forbidden'));
  await assert.rejects(runCommand(core, 'ospeli_agents_add', add, agent('coo', 'sneaky')), code('agents-off'));
  await assert.rejects(runCommand(core, 'ospeli_agents_add', { ...add, days: MAX_AGENT_DAYS + 1 }, human('coo')), code('invalid-input'));
  await assert.rejects(runCommand(core, 'ospeli_agents_add', { ...add, wards: ['ward-zz'] }, human('coo')), code('invalid-input'));
  await assert.rejects(runCommand(core, 'ospeli_agents_add', { ...add, name: 'Dr Sarah Jones' }, human('coo')), code('invalid-input'));
  const added = await runCommand(core, 'ospeli_agents_add', add, human('coo'));
  ok('ospeli_agents_add', added);
  assert.equal(Date.parse(added.agent.until) - Date.parse(added.agent.addedAt), 30 * 864e5);
  assert.equal(added.agent.addedByRole, 'coo');

  // On the list, but the dial is still off.
  await assert.rejects(runCommand(core, 'ospeli_beds_board', {}, agent('bed-manager', 'night-flow-helper')), code('agents-off'));
  await runCommand(core, 'ospeli_agents_set_access', { allowed: true, wards: { 'ward-a1': true, 'ward-b1': true } }, human('ops-manager'));
  assert.equal((await runCommand(core, 'ospeli_agents_list', {}, human('coo'))).agents.length, 1, 'changing the dial keeps the list');

  const board = await runCommand(core, 'ospeli_beds_board', {}, agent('bed-manager', 'night-flow-helper'));
  assert.deepEqual(board.wards.map((w) => w.id), ['ward-a1'], 'sees only wards that are switched on AND on its own entry');
  // The name is matched whatever its case; another role, another ward or an unlisted name is refused.
  await runCommand(core, 'ospeli_beds_board', {}, agent('bed-manager', 'Night-Flow-Helper'));
  await assert.rejects(runCommand(core, 'ospeli_kpi_get', { id: 'occupancy' }, agent('coo', 'night-flow-helper')), code('forbidden'));
  await assert.rejects(runCommand(core, 'ospeli_beds_board', { wardId: 'ward-b1' }, agent('bed-manager', 'night-flow-helper')), code('forbidden'));
  await assert.rejects(runCommand(core, 'ospeli_beds_board', {}, agent('bed-manager', 'browser-agent')), code('forbidden'));

  const view = await runCommand(core, 'ospeli_agents_list', {}, human('coo'));
  ok('ospeli_agents_list', view);
  assert.equal(view.dial, 'advise');
  const mine = view.recent.find((r) => r.agent.toLowerCase() === 'night-flow-helper');
  assert.deepEqual({ reads: mine.reads, proposals: mine.proposals, refused: mine.refused, onList: mine.onList }, { reads: 2, proposals: 0, refused: 3, onList: true });
  // A caller that is not on the list is counted, but the name it typed is not kept.
  assert.equal(view.recent.some((r) => r.agent === 'browser-agent'), false);
  assert.deepEqual([view.recent.find((r) => r.agent === 'unlisted').onList, view.recent.find((r) => r.agent === 'unlisted').refused], [false, 2]);
  assert.deepEqual(await core.verifyAudit(), { ok: true });
});

test('an agent stops at its end date, when removed, and when anyone presses stop', async () => {
  const { core, skip } = await setup();
  await runCommand(core, 'ospeli_agents_set_access', { allowed: true, wards: { 'ward-a1': true } }, human('coo'));
  await runCommand(core, 'ospeli_agents_add', { name: 'short-job', role: 'bed-manager', wards: ['ward-a1'], days: 1 }, human('coo'));
  await runCommand(core, 'ospeli_agents_add', { name: 'ward-helper', role: 'ward-nurse', wards: ['ward-a1'], days: 90 }, human('coo'));
  const bed = (await runCommand(core, 'ospeli_beds_board', {}, agent('bed-manager', 'short-job'))).beds.find((b) => b.state === 'available');
  const prop = await runCommand(core, 'ospeli_beds_take_out_of_service', { bedId: bed.id, reason: 'Electrical' }, agent('ward-nurse', 'ward-helper'));
  assert.equal((await runCommand(core, 'ospeli_proposals_list', { status: 'pending' }, human('ward-nurse'))).proposals[0].agentOnList, true);

  skip(864e5);
  await assert.rejects(runCommand(core, 'ospeli_beds_board', {}, agent('bed-manager', 'short-job')), code('forbidden'));
  assert.equal((await runCommand(core, 'ospeli_agents_list', {}, human('coo'))).agents.find((a) => a.name === 'short-job').ended, true);

  // Remove: refused from the next call; its waiting proposal is marked, not silently dropped.
  await assert.rejects(runCommand(core, 'ospeli_agents_remove', { name: 'ward-helper' }, human('bed-manager')), code('forbidden'));
  await assert.rejects(runCommand(core, 'ospeli_agents_remove', { name: 'nobody' }, human('coo')), code('not-found'));
  ok('ospeli_agents_remove', await runCommand(core, 'ospeli_agents_remove', { name: 'ward-helper' }, human('ops-manager')));
  await assert.rejects(runCommand(core, 'ospeli_beds_board', {}, agent('ward-nurse', 'ward-helper')), code('forbidden'));
  const waiting = (await runCommand(core, 'ospeli_proposals_list', { status: 'pending' }, human('ward-nurse'))).proposals;
  assert.deepEqual(waiting.map((p) => [p.id, p.agentOnList]), [[prop.proposal.id, false]]);

  // Stop all: any role may stop; agents may not; only the two operations roles start again.
  await runCommand(core, 'ospeli_agents_add', { name: 'ward-helper', role: 'ward-nurse', wards: ['ward-a1'], days: 7 }, human('coo'));
  await runCommand(core, 'ospeli_beds_board', {}, agent('ward-nurse', 'ward-helper'));
  await assert.rejects(runCommand(core, 'ospeli_agents_stop_all', {}, agent('ward-nurse', 'ward-helper')), code('agents-off'));
  const stop = await runCommand(core, 'ospeli_agents_stop_all', {}, human('estates-tech'));
  ok('ospeli_agents_stop_all', stop);
  assert.deepEqual(stop, { status: 'done', dial: 'off', wasOn: true });
  assert.deepEqual(await runCommand(core, 'ospeli_agents_access', {}, human('coo')), { allowed: false, wards: {} });
  await assert.rejects(runCommand(core, 'ospeli_beds_board', {}, agent('ward-nurse', 'ward-helper')), code('agents-off'));
  await assert.rejects(runCommand(core, 'ospeli_agents_set_access', { allowed: true }, human('estates-tech')), code('forbidden'));
  const log = await core.auditLog();
  const stopped = log.find((e) => e.action === 'agents.stopped');
  assert.deepEqual([stopped.actorType, stopped.actorRole], ['human', 'estates-tech']);
  for (const a of ['agents.agent-added', 'agents.agent-removed', 'agents.access-changed']) assert.ok(log.some((e) => e.action === a && e.actorType === 'human'), a);
  assert.deepEqual(await core.verifyAudit(), { ok: true });
});

test('every refused agent call leaves one audit entry, for each reason, and stores nothing the agent typed (#27)', async () => {
  const { core } = await setup();
  const SECRET = 'Mary Brown 555 0100';
  const tries = [
    ['agents-off', 'ospeli_kpi_get', { id: 'occupancy' }, agent('coo', 'coo-helper')], // dial off
    ['unknown-command', `no.such ${SECRET}`, {}, agent('coo', 'coo-helper')],
    ['forbidden', 'ospeli_kpi_get', { id: 'occupancy' }, agent(`boss ${SECRET}`, 'coo-helper')], // unknown role
    ['forbidden', 'ospeli_beds_board', {}, { type: 'agent', role: 'coo', agent: `<b>${SECRET}</b>` }], // bad name
    ['agents-off', 'ospeli_kpi_list', {}, agent('coo', `Mr ${SECRET.replace(/[0-9 ]/g, '')} in bed four`)], // a name that passes the pattern but is not on the list
    ['agents-off', 'ospeli_agents_set_access', { allowed: true }, agent('coo', 'coo-helper')], // people only
  ];
  for (const [c, name, input, actor] of tries) await assert.rejects(runCommand(core, name, input, actor), code(c));
  await runCommand(core, 'ospeli_agents_set_access', { allowed: true, wards: { 'ward-a1': true } }, human('coo'));
  await runCommand(core, 'ospeli_agents_add', { name: 'coo-helper', role: 'coo', days: 30 }, human('coo'));
  const more = [
    ['forbidden', 'ospeli_kpi_get', { id: 'occupancy' }, agent('coo', 'stranger')], // not on the list
    ['forbidden', 'ospeli_kpi_get', { id: 'occupancy' }, agent('bed-manager', 'coo-helper')], // another role
    ['forbidden', 'ospeli_workorders_report_fault', { assetId: 'asset-a1-sink-1', fault: 'Blocked sink', priority: 'routine' }, agent('coo', 'coo-helper')], // role cannot run it
    ['invalid-input', 'ospeli_kpi_get', { id: SECRET, [SECRET]: 1 }, agent('coo', 'coo-helper')],
  ];
  for (const [c, name, input, actor] of more) await assert.rejects(runCommand(core, name, input, actor), code(c));

  const rows = await refusals(core);
  assert.equal(rows.length, tries.length + more.length, 'one audit entry per refused call');
  assert.ok(rows.every((e) => e.actorType === 'agent' && e.detail.code && e.detail.why));
  assert.deepEqual(rows.map((e) => e.detail.code), [...tries, ...more].map(([c]) => c));
  assert.equal(JSON.stringify(rows).includes('Mary'), false, 'no text the agent typed is stored');
  assert.equal(JSON.stringify(rows).includes('555'), false);
  assert.deepEqual(rows.at(-1).detail.fields, ['id'], 'field names only, never values');
  assert.equal(rows[1].detail.command, '(unknown)');
  assert.ok(rows.slice(0, tries.length).every((e) => e.agent === 'unlisted'), 'a name nobody put on the list is never stored');
  assert.equal(rows.at(-1).agent, 'coo-helper');
  assert.equal(JSON.stringify(await runCommand(core, 'ospeli_agents_list', {}, human('coo'))).includes('Mary'), false, 'nor shown on the screen');
  // A read that runs and fails is audited too, with its outcome.
  await assert.rejects(runCommand(core, 'ospeli_maps_get', { mapId: 'map-999' }, agent('coo', 'coo-helper')), code('not-found'));
  const lastRead = (await core.auditLog()).at(-1);
  assert.deepEqual([lastRead.action, lastRead.actorType, lastRead.detail.command, lastRead.detail.outcome], ['agent.read', 'agent', 'ospeli_maps_get', 'not-found']);
  // An actor that is neither a person nor an agent is refused, never treated as a person.
  await assert.rejects(runCommand(core, 'ospeli_agents_add', { name: 'self-made', role: 'coo', days: 90 }, { type: 'Agent', role: 'coo', agent: 'x' }), code('forbidden'));
  await assert.rejects(runCommand(core, 'ospeli_kpi_list', {}, { role: 'coo' }), code('forbidden'));
  // A refused person leaves no agent entry.
  await assert.rejects(runCommand(core, 'ospeli_agents_set_access', { allowed: true }, human('ward-nurse')), code('forbidden'));
  assert.equal((await refusals(core)).length, rows.length);
  assert.deepEqual(await core.verifyAudit(), { ok: true });
});

test('a looping agent cannot flood the trail: repeats within a minute are counted, not written', async () => {
  const { core, skip } = await setup();
  const call = () => runCommand(core, 'ospeli_beds_board', {}, agent('bed-manager', 'looper'));
  for (let i = 0; i < 25; i++) await assert.rejects(call(), code('agents-off'));
  assert.equal((await refusals(core)).length, 1);
  // A different command or reason is a new entry straight away.
  await assert.rejects(runCommand(core, 'ospeli_beds_get', { bedId: 'ward-a1-bed-01' }, agent('bed-manager', 'looper')), code('agents-off'));
  assert.equal((await refusals(core)).length, 2);
  // The screen still counts every refusal, written or not.
  const seen = (await runCommand(core, 'ospeli_agents_list', {}, human('coo'))).recent.find((r) => r.agent === 'unlisted');
  assert.equal(seen.refused, 26);
  // After the minute, the next entry carries the count, so the hash-chained trail has it too.
  skip(61_000);
  await assert.rejects(call(), code('agents-off'));
  const rows = await refusals(core);
  assert.equal(rows.length, 3);
  assert.equal(rows.at(-1).detail.repeats.count, 24);
  assert.equal((await runCommand(core, 'ospeli_agents_list', {}, human('coo'))).recent.find((r) => r.agent === 'unlisted').refused, 27);
  assert.deepEqual(await core.verifyAudit(), { ok: true });
});

// Issue #51: off by default also means a replaced data set starts with agents off.
async function agentsOn(core) {
  await runCommand(core, 'ospeli_agents_set_access', { allowed: true, wards: { 'ward-a1': true } }, human('ops-manager'));
  await runCommand(core, 'ospeli_agents_add', { name: 'flow-helper', role: 'bed-manager', wards: ['ward-a1'], days: 30 }, human('ops-manager'));
  const board = await runCommand(core, 'ospeli_beds_board', { wardId: 'ward-a1' }, agent('bed-manager', 'flow-helper'));
  assert.equal(board.beds.length, 20);
}

test('reset then a fresh copy leaves agents off, the list empty, and one entry in the new trail (issue #51)', async () => {
  const { core } = await setup();
  await agentsOn(core);
  await core.reset('ward-nurse');
  await loadSyntheticHospital(core, { end: END });
  await assert.rejects(runCommand(core, 'ospeli_beds_board', { wardId: 'ward-a1' }, agent('bed-manager', 'flow-helper')), code('agents-off'));
  const view = await runCommand(core, 'ospeli_agents_list', {}, human('ops-manager'));
  ok('ospeli_agents_list', view);
  assert.equal(view.dial, 'off');
  assert.deepEqual(view.wards, {});
  assert.deepEqual(view.agents, []);
  assert.equal(view.cleared.by, 'reset');
  assert.equal(view.cleared.byRole, 'ward-nurse');
  const log = await core.auditLog();
  assert.equal(log[0].action, 'agents.access-cleared');
  assert.deepEqual(log[0].detail, { by: 'reset', was: { dial: 'advise', wards: 1, agents: 1, pendingProposals: 0 } });
  assert.equal(log.filter((e) => e.action === 'agents.access-cleared').length, 1);
  assert.deepEqual(await core.verifyAudit(), { ok: true });
  // Switching agents on again is a person's choice, and clears the notice.
  await runCommand(core, 'ospeli_agents_set_access', { allowed: true }, human('ops-manager'));
  assert.equal((await runCommand(core, 'ospeli_agents_list', {}, human('ops-manager'))).cleared, null);
});

test('import leaves agents off, drops waiting proposals, and says so in the trail (issue #51)', async () => {
  const { core } = await setup();
  const file = JSON.parse(JSON.stringify(await core.exportData())); // exported before agents were switched on
  await agentsOn(core);
  const bed = (await runCommand(core, 'ospeli_beds_board', { wardId: 'ward-a1' }, human('bed-manager'))).beds.find((b) => b.state === 'occupied');
  await runCommand(core, 'ospeli_beds_flag_expected_discharge', { bedId: bed.id }, agent('bed-manager', 'flow-helper'));
  await core.importData(file, 'ward-nurse');
  await assert.rejects(runCommand(core, 'ospeli_beds_board', { wardId: 'ward-a1' }, agent('bed-manager', 'flow-helper')), code('agents-off'));
  const view = await runCommand(core, 'ospeli_agents_list', {}, human('coo'));
  assert.equal(view.dial, 'off');
  assert.deepEqual(view.agents, []);
  assert.equal(view.cleared.by, 'import');
  assert.deepEqual((await runCommand(core, 'ospeli_proposals_list', {}, human('bed-manager'))).proposals, []);
  const log = await core.auditLog();
  const entry = log.find((e) => e.action === 'agents.access-cleared');
  assert.deepEqual(entry.detail, { by: 'import', was: { dial: 'advise', wards: 1, agents: 1, pendingProposals: 1 } });
  assert.equal(entry.actorRole, 'ward-nurse');
  assert.deepEqual(await core.verifyAudit(), { ok: true });
});

test('a reset with agents never switched on writes nothing about agents (issue #51)', async () => {
  const { core } = await setup();
  await core.reset('ward-nurse');
  assert.equal((await core.auditLog()).length, 0);
  assert.equal(await core.agentAccessInUse(), null);
});

// Issue #65: audit entries by agents read in words; the stored detail is the only source.
test('audit labels: an agent read, a refusal and a proposal are said in words (issue #65)', async () => {
  const { actionLabel } = await import('../../web/app/modules/data.js');
  const places = new Map([['ward-a1', { id: 'ward-a1', type: 'ward', name: 'Ward A1 (acute medicine)' }], ['ward-a1-bed-03', { id: 'ward-a1-bed-03', type: 'bed', name: 'Bed 03', parentId: 'ward-a1' }]]);
  const e = (action, detail) => ({ action, detail });
  assert.equal(actionLabel(e('agent.read', { command: 'ospeli_beds_find_free', input: { wardId: 'ward-a1' } }), places), 'Read free beds and the waiting list: Ward A1');
  assert.equal(actionLabel(e('agent.read', { command: 'ospeli_kpi_get', input: { id: 'occupancy' } }), places), 'Read a KPI: Bed occupancy');
  assert.equal(actionLabel(e('agent.read', { command: 'ospeli_beds_get', input: { bedId: '(unknown)' }, outcome: 'not-found' }), places), 'Read one bed: an id that names nothing here (failed: not-found)');
  assert.equal(actionLabel(e('agent.refused', { command: 'ospeli_beds_board', code: 'forbidden', why: 'Ward B1 is off for agents.', repeats: { count: 2 } }), places),
    'Refused: the bed board. Ward B1 is off for agents. (and 2 more like it just before)');
  assert.equal(actionLabel(e('agent.refused', { command: '(unknown)', code: 'unknown-command', why: 'There is no such command.' }), places), 'Refused: a command that does not exist. There is no such command.');
  assert.equal(actionLabel(e('agent.proposed', { command: 'ospeli_beds_allocate', input: { bedId: 'ward-a1-bed-03', encounter: 'enc-1' } }), places), 'Proposed: Hold an available bed for a patient waiting for a bed (Ward A1, Bed 03)');
  // Anything else keeps its action id; entries without detail are not guessed at.
  assert.equal(actionLabel(e('role.changed', null), places), 'role.changed');
  assert.equal(actionLabel(e('agent.read', null), places), 'agent.read');
});
