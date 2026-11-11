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
  const start = await runCommand(core, 'agents.list', {}, human('ward-nurse'));
  ok('agents.list', start);
  assert.deepEqual({ dial: start.dial, agents: start.agents, canChange: start.canChange, keys: start.keys }, { dial: 'off', agents: [], canChange: false, keys: 'none' });
  assert.equal((await runCommand(core, 'agents.list', {}, human('coo'))).canChange, true);

  // Only the operations manager or chief operating officer can add an agent; agents never can.
  const add = { name: 'night-flow-helper', role: 'bed-manager', wards: ['ward-a1'], days: 30 };
  await assert.rejects(runCommand(core, 'agent.add', add, human('ward-nurse')), code('forbidden'));
  await assert.rejects(runCommand(core, 'agent.add', add, agent('coo', 'sneaky')), code('agents-off'));
  await assert.rejects(runCommand(core, 'agent.add', { ...add, days: MAX_AGENT_DAYS + 1 }, human('coo')), code('invalid-input'));
  await assert.rejects(runCommand(core, 'agent.add', { ...add, wards: ['ward-zz'] }, human('coo')), code('invalid-input'));
  await assert.rejects(runCommand(core, 'agent.add', { ...add, name: 'Dr Sarah Jones' }, human('coo')), code('invalid-input'));
  const added = await runCommand(core, 'agent.add', add, human('coo'));
  ok('agent.add', added);
  assert.equal(Date.parse(added.agent.until) - Date.parse(added.agent.addedAt), 30 * 864e5);
  assert.equal(added.agent.addedByRole, 'coo');

  // On the list, but the dial is still off.
  await assert.rejects(runCommand(core, 'beds.board', {}, agent('bed-manager', 'night-flow-helper')), code('agents-off'));
  await runCommand(core, 'agents.set-access', { allowed: true, wards: { 'ward-a1': true, 'ward-b1': true } }, human('ops-manager'));
  assert.equal((await runCommand(core, 'agents.list', {}, human('coo'))).agents.length, 1, 'changing the dial keeps the list');

  const board = await runCommand(core, 'beds.board', {}, agent('bed-manager', 'night-flow-helper'));
  assert.deepEqual(board.wards.map((w) => w.id), ['ward-a1'], 'sees only wards that are switched on AND on its own entry');
  // The name is matched whatever its case; another role, another ward or an unlisted name is refused.
  await runCommand(core, 'beds.board', {}, agent('bed-manager', 'Night-Flow-Helper'));
  await assert.rejects(runCommand(core, 'kpi.value', { id: 'occupancy' }, agent('coo', 'night-flow-helper')), code('forbidden'));
  await assert.rejects(runCommand(core, 'beds.board', { wardId: 'ward-b1' }, agent('bed-manager', 'night-flow-helper')), code('forbidden'));
  await assert.rejects(runCommand(core, 'beds.board', {}, agent('bed-manager', 'browser-agent')), code('forbidden'));

  const view = await runCommand(core, 'agents.list', {}, human('coo'));
  ok('agents.list', view);
  assert.equal(view.dial, 'advise');
  const mine = view.recent.find((r) => r.agent.toLowerCase() === 'night-flow-helper');
  assert.deepEqual({ reads: mine.reads, proposals: mine.proposals, refused: mine.refused, onList: mine.onList }, { reads: 2, proposals: 0, refused: 3, onList: true });
  assert.equal(view.recent.find((r) => r.agent === 'browser-agent').onList, false);
  assert.deepEqual(await core.verifyAudit(), { ok: true });
});

test('an agent stops at its end date, when removed, and when anyone presses stop', async () => {
  const { core, skip } = await setup();
  await runCommand(core, 'agents.set-access', { allowed: true, wards: { 'ward-a1': true } }, human('coo'));
  await runCommand(core, 'agent.add', { name: 'short-job', role: 'bed-manager', wards: ['ward-a1'], days: 1 }, human('coo'));
  await runCommand(core, 'agent.add', { name: 'ward-helper', role: 'ward-nurse', wards: ['ward-a1'], days: 90 }, human('coo'));
  const bed = (await runCommand(core, 'beds.board', {}, agent('bed-manager', 'short-job'))).beds.find((b) => b.state === 'available');
  const prop = await runCommand(core, 'bed.take-out-of-service', { bedId: bed.id, reason: 'Electrical' }, agent('ward-nurse', 'ward-helper'));
  assert.equal((await runCommand(core, 'proposals.list', { status: 'pending' }, human('ward-nurse'))).proposals[0].agentOnList, true);

  skip(864e5);
  await assert.rejects(runCommand(core, 'beds.board', {}, agent('bed-manager', 'short-job')), code('forbidden'));
  assert.equal((await runCommand(core, 'agents.list', {}, human('coo'))).agents.find((a) => a.name === 'short-job').ended, true);

  // Remove: refused from the next call; its waiting proposal is marked, not silently dropped.
  await assert.rejects(runCommand(core, 'agent.remove', { name: 'ward-helper' }, human('bed-manager')), code('forbidden'));
  await assert.rejects(runCommand(core, 'agent.remove', { name: 'nobody' }, human('coo')), code('not-found'));
  ok('agent.remove', await runCommand(core, 'agent.remove', { name: 'ward-helper' }, human('ops-manager')));
  await assert.rejects(runCommand(core, 'beds.board', {}, agent('ward-nurse', 'ward-helper')), code('forbidden'));
  const waiting = (await runCommand(core, 'proposals.list', { status: 'pending' }, human('ward-nurse'))).proposals;
  assert.deepEqual(waiting.map((p) => [p.id, p.agentOnList]), [[prop.proposal.id, false]]);

  // Stop all: any role may stop; agents may not; only the two operations roles start again.
  await runCommand(core, 'agent.add', { name: 'ward-helper', role: 'ward-nurse', wards: ['ward-a1'], days: 7 }, human('coo'));
  await runCommand(core, 'beds.board', {}, agent('ward-nurse', 'ward-helper'));
  await assert.rejects(runCommand(core, 'agents.stop-all', {}, agent('ward-nurse', 'ward-helper')), code('agents-off'));
  const stop = await runCommand(core, 'agents.stop-all', {}, human('estates-tech'));
  ok('agents.stop-all', stop);
  assert.deepEqual(stop, { status: 'done', dial: 'off', wasOn: true });
  assert.deepEqual(await runCommand(core, 'agents.access', {}, human('coo')), { allowed: false, wards: {} });
  await assert.rejects(runCommand(core, 'beds.board', {}, agent('ward-nurse', 'ward-helper')), code('agents-off'));
  await assert.rejects(runCommand(core, 'agents.set-access', { allowed: true }, human('estates-tech')), code('forbidden'));
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
    ['agents-off', 'kpi.value', { id: 'occupancy' }, agent('coo', 'coo-helper')], // dial off
    ['unknown-command', `no.such ${SECRET}`, {}, agent('coo', 'coo-helper')],
    ['forbidden', 'kpi.value', { id: 'occupancy' }, agent(`boss ${SECRET}`, 'coo-helper')], // unknown role
    ['forbidden', 'kpi.value', { id: 'occupancy' }, { type: 'agent', role: 'coo', agent: `<b>${SECRET}</b>` }], // bad name
    ['agents-off', 'agents.set-access', { allowed: true }, agent('coo', 'coo-helper')], // people only
  ];
  for (const [c, name, input, actor] of tries) await assert.rejects(runCommand(core, name, input, actor), code(c));
  await runCommand(core, 'agents.set-access', { allowed: true, wards: { 'ward-a1': true } }, human('coo'));
  await runCommand(core, 'agent.add', { name: 'coo-helper', role: 'coo', days: 30 }, human('coo'));
  const more = [
    ['forbidden', 'kpi.value', { id: 'occupancy' }, agent('coo', 'stranger')], // not on the list
    ['forbidden', 'kpi.value', { id: 'occupancy' }, agent('bed-manager', 'coo-helper')], // another role
    ['forbidden', 'fault.report', { assetId: 'asset-a1-sink-1', fault: 'Blocked sink', priority: 'routine' }, agent('coo', 'coo-helper')], // role cannot run it
    ['invalid-input', 'kpi.value', { id: SECRET, [SECRET]: 1 }, agent('coo', 'coo-helper')],
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
  assert.equal(rows[3].agent, 'unnamed');
  // A refused person leaves no agent entry.
  await assert.rejects(runCommand(core, 'agents.set-access', { allowed: true }, human('ward-nurse')), code('forbidden'));
  assert.equal((await refusals(core)).length, rows.length);
  assert.deepEqual(await core.verifyAudit(), { ok: true });
});

test('a looping agent cannot flood the trail: repeats within a minute are counted, not written', async () => {
  const { core, skip } = await setup();
  const call = () => runCommand(core, 'beds.board', {}, agent('bed-manager', 'looper'));
  for (let i = 0; i < 25; i++) await assert.rejects(call(), code('agents-off'));
  assert.equal((await refusals(core)).length, 1);
  // A different command or reason is a new entry straight away.
  await assert.rejects(runCommand(core, 'bed.get', { bedId: 'ward-a1-bed-01' }, agent('bed-manager', 'looper')), code('agents-off'));
  assert.equal((await refusals(core)).length, 2);
  // The screen still counts every refusal, written or not.
  const seen = (await runCommand(core, 'agents.list', {}, human('coo'))).recent.find((r) => r.agent === 'looper');
  assert.equal(seen.refused, 26);
  // After the minute, the next entry carries the count, so the hash-chained trail has it too.
  skip(61_000);
  await assert.rejects(call(), code('agents-off'));
  const rows = await refusals(core);
  assert.equal(rows.length, 3);
  assert.equal(rows.at(-1).detail.repeats.count, 24);
  assert.equal((await runCommand(core, 'agents.list', {}, human('coo'))).recent.find((r) => r.agent === 'looper').refused, 27);
  assert.deepEqual(await core.verifyAudit(), { ok: true });
});
