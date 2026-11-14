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

  const p2 = await runCommand(core, 'ospeli_beds_flag_expected_discharge', { bedId: free[0].id }, agent('ward-nurse', 'ward-bot'));
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
