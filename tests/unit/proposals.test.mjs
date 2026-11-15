// Agent proposals (issue #17, backlog A4): people accept or decline what agents propose, and
// the audit trail tells a person from an agent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Core } from '../../web/app/core/core.js';
import { MemoryAdapter } from '../../web/app/core/db.js';
import { loadSyntheticHospital } from '../../web/app/core/generator.js';
import { runCommand, commandByName, CommandError } from '../../web/app/core/commands.js';
import { validate } from '../../web/app/core/schema.js';

const END = '2026-11-06T18:00:00.000Z';
const clockFrom = (iso) => { let t = Date.parse(iso); return () => new Date(t += 1000); };
const human = (role) => ({ type: 'human', role });
const agent = (role, name = 'flow-bot') => ({ type: 'agent', role, agent: name });
const code = (c) => (err) => err instanceof CommandError && err.code === c;

async function setup() {
  const core = await Core.open({ adapter: new MemoryAdapter(), clock: clockFrom(END) });
  await loadSyntheticHospital(core, { end: END });
  // Switch agents on for a ward that has a free bed right now (the seeded data decides which).
  const all = await runCommand(core, 'ospeli_beds_board', {}, human('bed-manager'));
  const ward = all.wards.find((w) => w.counts.available >= 1).id;
  await runCommand(core, 'ospeli_agents_set_access', { allowed: true, wards: { [ward]: true } }, human('coo'));
  // Agents must also be on the site's list, each for one role (issues #20, #25).
  for (const [name, role] of [['flow-bot', 'bed-manager'], ['other-bot', 'bed-manager'], ['ward-bot', 'ward-nurse']]) {
    await runCommand(core, 'ospeli_agents_add', { name, role, wards: [ward], days: 30 }, human('coo'));
  }
  const board = await runCommand(core, 'ospeli_beds_board', {}, agent('bed-manager'));
  return { core, board: { ...board, waiting: all.waiting }, ward };
}

test('an agent proposes, a patient flow coordinator accepts: the command runs as the person and the trail links them', async () => {
  const { core, board, ward } = await setup();
  const bed = board.beds.find((b) => b.state === 'available');
  const wait = board.waiting.find((w) => !w.allocatedBed);
  assert.ok(bed && wait, 'the synthetic hospital has a free bed and a waiting patient');
  const before = await core.eventCount();
  const prop = await runCommand(core, 'ospeli_beds_allocate', { bedId: bed.id, encounter: wait.encounter }, agent('bed-manager'));
  assert.equal(prop.status, 'proposed');
  assert.equal(prop.proposal.seenState, 'available');
  assert.equal(prop.proposal.wardId, ward);

  // People see it, and whether their role may decide; the agent sees its own.
  const forNurse = await runCommand(core, 'ospeli_proposals_list', { status: 'pending' }, human('ward-nurse'));
  assert.equal(forNurse.proposals.length, 1);
  assert.equal(forNurse.proposals[0].canDecide, true);
  const forCoo = await runCommand(core, 'ospeli_proposals_list', {}, human('coo'));
  assert.equal(forCoo.proposals[0].canDecide, false, 'the COO cannot allocate, so cannot accept an allocation');
  assert.deepEqual(validate(commandByName('ospeli_proposals_list').output, forCoo, 'output'), []);
  assert.equal((await runCommand(core, 'ospeli_proposals_list', {}, agent('bed-manager', 'other-bot'))).proposals.length, 0, 'an agent sees only its own');

  // Agents can't decide; a role that can't run the command can't either.
  await assert.rejects(runCommand(core, 'ospeli_proposals_accept', { id: prop.proposal.id }, agent('bed-manager')), code('forbidden')); // agents are on: people only (issue #89)
  await assert.rejects(runCommand(core, 'ospeli_proposals_accept', { id: prop.proposal.id }, human('coo')), code('forbidden'));
  assert.equal(await core.eventCount(), before, 'nothing has changed yet');

  const out = await runCommand(core, 'ospeli_proposals_accept', { id: prop.proposal.id }, human('bed-manager'));
  assert.deepEqual(validate(commandByName('ospeli_proposals_accept').output, out, 'output'), []);
  assert.equal(out.status, 'accepted');
  assert.equal(out.result.state, 'allocated');
  assert.equal(await core.eventCount(), before + out.result.events.length);
  const ev = (await core.events()).at(-1);
  assert.equal(ev.actorRole, 'bed-manager', 'the event is the person\'s action');
  assert.equal((await runCommand(core, 'ospeli_beds_get', { bedId: bed.id }, human('coo'))).bed.state, 'allocated');

  const log = await core.auditLog();
  const acc = log.at(-1);
  assert.equal(acc.action, 'agent.proposal-accepted');
  assert.equal(acc.target, prop.proposal.id);
  assert.equal(acc.actorType, 'human');
  assert.equal(acc.detail.agent, 'flow-bot');
  assert.deepEqual(acc.detail.events, out.result.events);
  const mine = await runCommand(core, 'ospeli_proposals_list', {}, agent('bed-manager'));
  assert.equal(mine.proposals[0].status, 'accepted', 'the agent can learn its proposal was accepted');
  await assert.rejects(runCommand(core, 'ospeli_proposals_accept', { id: prop.proposal.id }, human('bed-manager')), code('conflict'), 'only once');
  assert.deepEqual(await core.verifyAudit(), { ok: true });
});

test('a stale proposal expires instead of running, and a decline changes nothing', async () => {
  const { core, board } = await setup();
  const free = board.beds.filter((b) => b.state === 'available');
  assert.ok(free.length >= 1);
  const p1 = await runCommand(core, 'ospeli_beds_take_out_of_service', { bedId: free[0].id, reason: 'Electrical' }, agent('ward-nurse', 'ward-bot'));
  // A person changes the bed before anyone looks at the proposal.
  await runCommand(core, 'ospeli_beds_take_out_of_service', { bedId: free[0].id, reason: 'Plumbing or leak' }, human('ward-nurse'));
  const before = await core.eventCount();
  const out = await runCommand(core, 'ospeli_proposals_accept', { id: p1.proposal.id }, human('ward-nurse'));
  assert.equal(out.status, 'expired');
  assert.match(out.message, /changed since/);
  assert.equal(await core.eventCount(), before, 'an out-of-date proposal writes nothing');
  assert.equal((await core.auditLog()).at(-1).action, 'agent.proposal-expired');

  // (Issue #72: a proposal must be possible when it is made. The bed is now out of service, so the
  // agent proposes returning it; before #72 this line queued an impossible "expected discharge".)
  await assert.rejects(runCommand(core, 'ospeli_beds_flag_expected_discharge', { bedId: free[0].id }, agent('ward-nurse', 'ward-bot')), code('conflict'));
  const p2 = await runCommand(core, 'ospeli_beds_return_to_service', { bedId: free[0].id }, agent('ward-nurse', 'ward-bot'));
  await assert.rejects(runCommand(core, 'ospeli_proposals_decline', { id: p2.proposal.id, reason: 'Free text is not allowed' }, human('ward-nurse')), code('invalid-input'));
  const d = await runCommand(core, 'ospeli_proposals_decline', { id: p2.proposal.id, reason: 'Not needed' }, human('ward-nurse'));
  assert.equal(d.proposal.status, 'declined');
  assert.equal(d.proposal.reason, 'Not needed');
  assert.equal(await core.eventCount(), before);
  const last = (await core.auditLog()).at(-1);
  assert.equal(last.action, 'agent.proposal-declined');
  assert.equal(last.detail.reason, 'Not needed');
  assert.equal((await runCommand(core, 'ospeli_proposals_list', { status: 'pending' }, human('ward-nurse'))).proposals.length, 0);
});

test('every audit entry says whether a person, an agent or the system acted', async () => {
  const { core } = await setup();
  await core.record('bed-manager', 'role.changed', null, { from: 'coo', to: 'bed-manager' });
  const log = await core.auditLog();
  assert.ok(log.length > 3);
  for (const e of log) assert.ok(['human', 'agent', 'system'].includes(e.actorType), `${e.seq} ${e.action}: ${e.actorType}`);
  assert.equal(log.at(-1).actorType, 'human');
  assert.ok(log.some((e) => e.actorType === 'system'));
  assert.ok(log.some((e) => e.actorType === 'agent' && e.agent === 'flow-bot'));
  assert.deepEqual(await core.verifyAudit(), { ok: true });
});

// Issue #72: a queue worth reading. A proposal is checked before it is queued, an identical one
// is not queued twice, one agent cannot fill the queue, and a dry run runs the same checks.
test('issue #72: a proposal for a bed, patient or work order that cannot take it is refused before it is queued', async () => {
  const { core, board } = await setup();
  const count = async () => (await core.proposals()).length;
  const bed = board.beds.find((b) => b.state === 'available');
  const occupied = board.beds.find((b) => b.state === 'occupied');
  const wait = board.waiting.find((w) => !w.allocatedBed);
  const A = agent('bed-manager');
  // No such bed; no such waiting patient; a state that does not allow the action.
  await assert.rejects(runCommand(core, 'ospeli_beds_allocate', { bedId: 'ward-zz-bed-99', encounter: wait.encounter }, A), code('not-found'));
  await assert.rejects(runCommand(core, 'ospeli_beds_allocate', { bedId: bed.id, encounter: 'enc-999999' }, A), code('conflict'));
  await assert.rejects(runCommand(core, 'ospeli_beds_start_clean', { bedId: occupied.id }, agent('ward-nurse', 'ward-bot')), code('conflict'));
  // The same checks in a dry run: it does not say "would be queued" for something impossible.
  await assert.rejects(runCommand(core, 'ospeli_beds_allocate', { bedId: 'ward-zz-bed-99', encounter: wait.encounter }, A, { dryRun: true }), code('not-found'));
  await assert.rejects(runCommand(core, 'ospeli_beds_start_clean', { bedId: occupied.id }, agent('ward-nurse', 'ward-bot'), { dryRun: true }), code('conflict'));
  // A map that does not exist.
  await assert.rejects(runCommand(core, 'ospeli_maps_reset_proposed', { mapId: 'map-999' }, A), code('not-found'));
  assert.equal(await count(), 0, 'nothing was queued');
  // Each refusal is in the trail, and nothing the agent typed is.
  const refused = (await core.auditLog()).filter((a) => a.action === 'agent.refused');
  assert.ok(refused.some((a) => a.detail.reason === 'target'), 'refusals are recorded with the reason "target"');
  assert.ok(!JSON.stringify(refused).includes('ward-zz-bed-99') && !JSON.stringify(refused).includes('enc-999999'), 'typed ids are not stored');
  assert.equal((await core.verifyAudit()).ok, true);
});

test('issue #72: a work order that does not exist, or is closed, is refused before it is queued', async () => {
  const { core } = await setup();
  await runCommand(core, 'ospeli_agents_add', { name: 'fix-bot', role: 'estates-tech', days: 30 }, human('coo'));
  const F = agent('estates-tech', 'fix-bot');
  await assert.rejects(runCommand(core, 'ospeli_workorders_complete', { workOrderId: 'wo-99999', outcome: 'fixed' }, F), code('not-found'));
  await assert.rejects(runCommand(core, 'ospeli_workorders_complete', { workOrderId: 'wo-99999', outcome: 'fixed' }, F, { dryRun: true }), code('not-found'));
  assert.equal((await core.proposals()).length, 0);
});

test('issue #72: the same proposal is returned, not queued again; one target has one open proposal per agent; 20 at most wait per agent', async () => {
  const { core, board } = await setup();
  const free = board.beds.filter((b) => b.state === 'available');
  const waits = board.waiting.filter((w) => !w.allocatedBed);
  const A = agent('bed-manager');
  const input = { bedId: free[0].id, encounter: waits[0].encounter };
  const first = await runCommand(core, 'ospeli_beds_allocate', input, A);
  const again = await runCommand(core, 'ospeli_beds_allocate', { encounter: waits[0].encounter, bedId: free[0].id }, A);
  const third = await runCommand(core, 'ospeli_beds_allocate', input, A);
  assert.equal(again.status, 'proposed');
  assert.equal(again.existing, true);
  assert.equal(again.proposal.id, first.proposal.id);
  assert.equal(third.proposal.id, first.proposal.id);
  assert.equal((await core.proposals()).length, 1, 'three identical calls make one row');
  // A dry run of the same call says so.
  const dry = await runCommand(core, 'ospeli_beds_allocate', input, A, { dryRun: true });
  assert.match(dry.would, new RegExp(first.proposal.id));
  // Same command and bed, another patient: refused, and the answer names the one that is waiting.
  if (waits[1]) {
    await assert.rejects(runCommand(core, 'ospeli_beds_allocate', { bedId: free[0].id, encounter: waits[1].encounter }, A),
      (err) => err.code === 'conflict' && err.detail?.existing === first.proposal.id && /waiting for a person/.test(err.message));
  }
  // Another agent may still propose for the same bed: the limit is per agent.
  const other = await runCommand(core, 'ospeli_beds_allocate', input, agent('bed-manager', 'other-bot'));
  assert.notEqual(other.proposal.id, first.proposal.id);
  // Once a person has answered, the agent may ask again.
  await runCommand(core, 'ospeli_proposals_decline', { id: first.proposal.id, reason: 'Not needed' }, human('bed-manager'));
  const fresh = await runCommand(core, 'ospeli_beds_allocate', input, A);
  assert.notEqual(fresh.proposal.id, first.proposal.id);
  // No more than 20 waiting per agent. Maps are an easy way to make many different valid proposals.
  await runCommand(core, 'ospeli_maps_create', { from: 'blank', title: 'Queue test' }, human('ops-manager'));
  const step = (n) => ({ mapId: 'map-001', name: `Step number ${n}`, role: 'Nurse', wait: 0, work: n });
  let queued = (await core.proposals()).filter((p) => p.status === 'pending' && p.agent === 'flow-bot').length;
  let n = 1;
  for (; queued < 20; queued++, n++) assert.equal((await runCommand(core, 'ospeli_maps_step_add', step(n), A)).status, 'proposed');
  await assert.rejects(runCommand(core, 'ospeli_maps_step_add', step(n), A),
    (err) => err.code === 'conflict' && /20/.test(err.message) && err.reason === 'queue-full');
  await assert.rejects(runCommand(core, 'ospeli_maps_step_add', step(n), A, { dryRun: true }), code('conflict'));
  assert.equal((await core.proposals()).filter((p) => p.status === 'pending' && p.agent === 'flow-bot').length, 20);
  // The other agent is not held back by the first one's queue.
  assert.equal((await runCommand(core, 'ospeli_maps_step_add', step(99), agent('bed-manager', 'other-bot'))).status, 'proposed');
  assert.equal((await core.verifyAudit()).ok, true);
});
