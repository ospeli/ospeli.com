// Agent journeys (backlog A7, issue #39): an agent completes a persona's top task with commands
// only, in one or two tool calls, and every call is in the audit trail. Plus the rules that came
// with the new names: one real name per command, old names still work, lists are never dumped whole,
// and errors say how to fix the call.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Core } from '../../web/app/core/core.js';
import { MemoryAdapter } from '../../web/app/core/db.js';
import { loadSyntheticHospital } from '../../web/app/core/generator.js';
import { runCommand, commandByName, canonicalName, listCommands, describeCommand, CommandError } from '../../web/app/core/commands.js';
import { validate } from '../../web/app/core/schema.js';

const END = '2026-11-08T12:00:00.000Z';
const human = (role) => ({ type: 'human', role });
const code = (c) => (err) => err instanceof CommandError && err.code === c;
const ok = (name, out) => assert.deepEqual(validate(commandByName(name).output, out, 'output'), [], name);

async function setup({ wards = ['ward-a1'], role = 'bed-manager', name = 'flow-helper' } = {}) {
  let t = Date.parse(END);
  const core = await Core.open({ adapter: new MemoryAdapter(), clock: () => new Date(t += 1000) });
  await loadSyntheticHospital(core, { end: END });
  await runCommand(core, 'ospeli_agents_set_access', { allowed: true, wards: Object.fromEntries(wards.map((w) => [w, true])) }, human('ops-manager'));
  await runCommand(core, 'ospeli_agents_add', { name, role, wards, days: 30 }, human('ops-manager'));
  // The agent, counting its tool calls.
  const calls = [];
  const agent = async (cmd, input = {}) => { calls.push(cmd); return runCommand(core, cmd, input, { type: 'agent', agent: name, role }); };
  return { core, agent, calls };
}
const reads = async (core) => (await core.auditLog()).filter((e) => e.action === 'agent.read');

test('journey: find a bed on a ward for the longest-waiting patient and propose it, in 2 calls', async () => {
  const { core, agent, calls } = await setup();
  // Make sure Ward A1 has a free bed, as a person would: vacate and clean one.
  const board = await runCommand(core, 'ospeli_beds_board', { wardId: 'ward-a1' }, human('ward-nurse'));
  if (!board.beds.some((b) => b.state === 'available')) {
    const b = board.beds.find((x) => x.state === 'occupied');
    for (const c of ['ospeli_beds_mark_vacated', 'ospeli_beds_start_clean', 'ospeli_beds_finish_clean']) await runCommand(core, c, { bedId: b.id }, human('ward-nurse'));
  }
  const found = await agent('ospeli_beds_find_free', { wardId: 'ward-a1' });
  ok('ospeli_beds_find_free', found);
  assert.ok(found.beds.length >= 1 && found.beds.length <= 5);
  assert.ok(found.beds.every((b) => b.wardId === 'ward-a1'));
  assert.deepEqual(found.wardsSearched.map((w) => w.id), ['ward-a1']);
  assert.ok(found.waiting.length >= 1 && found.waiting.length <= 3, 'the longest-waiting patients, three at most');
  for (let i = 1; i < found.waiting.length; i++) assert.ok(found.waiting[i - 1].decisionAt <= found.waiting[i].decisionAt, 'longest wait first');
  assert.ok(found.waiting[0].waitingMinutes > 0);
  assert.equal(found.nextStep.command, 'ospeli_beds_allocate');
  assert.deepEqual(found.nextStep.input, { bedId: found.beds[0].bedId, encounter: found.waiting[0].encounter, expectedState: 'available' });
  assert.match(found.order, /not a recommendation/);
  assert.equal('best' in found || 'recommended' in found, false, 'no "best bed" field');

  const res = await agent(found.nextStep.command, found.nextStep.input);
  assert.equal(res.status, 'proposed');
  assert.equal(calls.length, 2, `the task took ${calls.length} tool calls`);
  // Nothing changed yet; a person sees the proposal and accepts it.
  const after = await runCommand(core, 'ospeli_beds_get', { bedId: found.beds[0].bedId }, human('bed-manager'));
  assert.equal(after.bed.state, 'available');
  const queue = await runCommand(core, 'ospeli_proposals_list', { status: 'pending' }, human('bed-manager'));
  assert.equal(queue.total, 1);
  assert.equal(queue.proposals[0].command, 'ospeli_beds_allocate');
  const done = await runCommand(core, 'ospeli_proposals_accept', { id: res.proposal.id }, human('bed-manager'));
  assert.equal(done.status, 'accepted');
  // The audit trail has the read (with how much was shown) and the proposal, as the agent.
  const [r] = await reads(core);
  assert.equal(r.actorType, 'agent');
  assert.equal(r.detail.command, 'ospeli_beds_find_free');
  assert.deepEqual([r.detail.returned, r.detail.total], [found.beds.length, found.totalFree]);
  assert.ok((await core.auditLog()).some((e) => e.action === 'agent.proposed' && e.detail.command === 'ospeli_beds_allocate'));
});

test('find_free keeps to the agent\'s wards, lists only available beds, and treats an unseen patient as not found', async () => {
  const { core, agent } = await setup();
  const all = await agent('ospeli_beds_find_free', { limit: 20 });
  ok('ospeli_beds_find_free', all);
  assert.deepEqual(all.wardsSearched.map((w) => w.id), ['ward-a1'], 'no ward given: still only the wards on the agent\'s list');
  assert.ok(all.beds.every((b) => b.wardId === 'ward-a1'));
  const board = await runCommand(core, 'ospeli_beds_board', {}, human('bed-manager'));
  const state = new Map(board.beds.map((b) => [b.id, b.state]));
  assert.ok(all.beds.every((b) => state.get(b.bedId) === 'available'));
  assert.equal(all.totalFree, board.beds.filter((b) => b.wardId === 'ward-a1' && b.state === 'available').length);
  // A ward that is not open to the agent: refused, and the hint names only its own wards.
  await assert.rejects(agent('ospeli_beds_find_free', { wardId: 'ward-b1' }), (e) => ['agents-off', 'forbidden'].includes(e.code));
  // A ward that does not exist gets the same refusal as one that is closed to the agent.
  const refusal = (wardId) => agent('ospeli_beds_find_free', { wardId }).then(() => null, (e) => [e.code, e.message.replace(wardId, 'X')]);
  assert.deepEqual(await refusal('ward-zz'), await refusal('ward-b1'));
  // A person who mistypes a ward is told which ids exist.
  await assert.rejects(runCommand(core, 'ospeli_beds_find_free', { wardId: 'ward-zz' }, human('bed-manager')), (e) => e.code === 'not-found' && /Use one of: ward-a1, /.test(e.message) && e.detail.wards.length === 6);
  // A patient requested for another ward, and one that does not exist, get the same answer.
  const other = board.waiting.find((x) => x.wardId && x.wardId !== 'ward-a1' && !x.allocatedBed);
  const msg = async (enc) => agent('ospeli_beds_find_free', { forEncounter: enc }).then(() => null, (e) => [e.code, e.message.replace(enc, 'X')]);
  if (other) assert.deepEqual(await msg(other.encounter), await msg('enc-999999'));
  assert.deepEqual((await msg('enc-999999'))[0], 'not-found');
  // A person sees every ward; the requested ward comes first.
  const want = board.waiting.find((x) => x.wardId && !x.allocatedBed);
  if (want) {
    const forOne = await runCommand(core, 'ospeli_beds_find_free', { forEncounter: want.encounter, limit: 20 }, human('bed-manager'));
    ok('ospeli_beds_find_free', forOne);
    assert.equal(forOne.waiting.length, 1);
    const flags = forOne.beds.map((b) => b.requestedWard);
    assert.deepEqual(flags, [...flags].sort((a, b) => b - a), 'requested ward first');
    assert.ok(forOne.beds.every((b) => b.requestedWard === (b.wardId === want.wardId)));
  }
});

test('journey: overdue work orders on a ward, in 1 call, short and limited', async () => {
  const { core, agent, calls } = await setup({ role: 'estates-tech', name: 'night-queue-helper' });
  // Make one fault on Ward A1 overdue: report it as a person, then let its response time pass.
  const assets = await runCommand(core, 'ospeli_assets_list', { locationId: 'ward-a1', limit: 5 }, human('ward-nurse'));
  await runCommand(core, 'ospeli_workorders_report_fault', { assetId: assets.assets[0].id, fault: assets.assets[0].faults[0], priority: 'urgent' }, human('ward-nurse'));
  core.clock = ((c) => () => new Date(c().getTime() + 5 * 3600e3))(core.clock);

  const out = await agent('ospeli_workorders_list', { overdue: true, locationId: 'ward-a1', format: 'short', limit: 10 });
  ok('ospeli_workorders_list', out);
  assert.equal(calls.length, 1);
  assert.ok(out.workOrders.length >= 1);
  assert.ok(out.workOrders.every((w) => w.overdue && w.overdueByMinutes > 0 && w.locationName && w.assetName));
  assert.ok(out.workOrders.every((w) => !('reportedByRole' in w) && !('outcome' in w)), 'short format leaves the detail out');
  assert.equal(out.total, out.workOrders.length);
  assert.equal(out.truncated, false);
  // Counts are for the whole filtered queue, worked out before the limit.
  const one = await agent('ospeli_workorders_list', { locationId: 'ward-a1', limit: 1 });
  assert.equal(one.workOrders.length, 1);
  assert.equal(one.truncated, one.total > 1);
  assert.equal(one.counts.open, one.total);
  // Errors say how to fix the call.
  await assert.rejects(agent('ospeli_workorders_list', { overdue: true, state: 'completed' }), (e) => e.code === 'invalid-input' && /"overdue": true/.test(e.message) && e.detail.example.overdue === true);
  await assert.rejects(runCommand(core, 'ospeli_workorders_list', { locationId: 'ward-zz' }, human('coo')), (e) => e.code === 'not-found' && /Use one of: /.test(e.message) && e.detail.locations.length > 1);
});

test('journey: a process map\'s numbers, biggest wait and top suggestions, in 2 calls', async () => {
  const { core, agent, calls } = await setup({ role: 'ops-manager', name: 'flow-analyst', wards: [] });
  await runCommand(core, 'ospeli_maps_create', { from: 'discharge' }, human('ops-manager'));
  const list = await agent('ospeli_maps_list');
  ok('ospeli_maps_list', list);
  const id = list.maps.find((m) => m.from === 'discharge').id;
  const sum = await agent('ospeli_maps_summary', { mapId: id });
  ok('ospeli_maps_summary', sum);
  assert.equal(calls.length, 2);
  const full = await runCommand(core, 'ospeli_maps_get', { mapId: id }, human('ops-manager'));
  assert.deepEqual(sum.today, full.today.stats);
  assert.deepEqual(sum.proposed, full.proposed.stats);
  const worst = full.today.steps.reduce((a, b) => (b.wait > a.wait ? b : a));
  assert.deepEqual([sum.biggestWait.stepId, sum.biggestWait.wait], [worst.id, worst.wait]);
  assert.equal(sum.biggestWait.shareOfElapsed, Math.round((100 * worst.wait) / full.today.stats.elapsed));
  assert.deepEqual(sum.difference, { elapsed: 0, wait: 0, work: 0, handoffs: 0 });
  assert.ok(sum.suggestions.length >= 1 && sum.suggestions.length <= 3 && sum.suggestionsTotal >= sum.suggestions.length);
  assert.ok(sum.suggestions.every((s) => s.why.length > 10), 'every suggestion says why');
  // With the guide off the numbers and the biggest wait still come back; suggestions do not.
  await runCommand(core, 'ospeli_maps_guide_set', { on: false }, human('ops-manager'));
  const off = await agent('ospeli_maps_summary', { mapId: id, version: 'proposed' });
  ok('ospeli_maps_summary', off);
  assert.deepEqual([off.guideOn, off.suggestions.length, off.suggestionsTotal, off.version], [false, 0, 0, 'proposed']);
  assert.equal(off.biggestWait.stepId, worst.id);
  // A wrong id comes back with the ids that exist.
  await assert.rejects(agent('ospeli_maps_summary', { mapId: 'map-099' }), (e) => e.code === 'not-found' && e.detail.maps[0].id === id);
});

test('one real name per command: old names still run, and the trail and the queue record the new name', async () => {
  const { core, agent } = await setup();
  for (const c of listCommands()) {
    assert.equal(canonicalName(c.name), c.name);
    if (c.deprecatedName) {
      assert.match(c.deprecatedName, /^[a-z]+(\.[a-z-]+)+$/);
      assert.equal(canonicalName(c.deprecatedName), c.name);
      assert.equal(describeCommand(c.deprecatedName).name, c.name);
    }
  }
  const olds = listCommands().map((c) => c.deprecatedName).filter(Boolean);
  assert.equal(olds.length, 40);
  assert.equal(new Set(olds).size, 40);
  assert.ok(olds.every((o) => !listCommands().some((c) => c.name === o)), 'no old name collides with a new one');
  assert.equal(canonicalName('constructor'), null);
  assert.equal(canonicalName('toString'), null);

  // An agent calling by the old name: same answer; audited under the new name with calledAs.
  const a = await agent('beds.board', { wardId: 'ward-a1', format: 'short' });
  const b = await agent('ospeli_beds_board', { wardId: 'ward-a1', format: 'short' });
  assert.deepEqual({ ...a, asOf: 0 }, { ...b, asOf: 0 });
  const [r1, r2] = await reads(core);
  assert.deepEqual([r1.detail.command, r1.detail.calledAs], ['ospeli_beds_board', 'beds.board']);
  assert.deepEqual([r2.detail.command, 'calledAs' in r2.detail], ['ospeli_beds_board', false]);
  const bed = (await runCommand(core, 'ospeli_beds_board', { wardId: 'ward-a1' }, human('bed-manager'))).beds.find((x) => x.state === 'occupied');
  const p = await agent('bed.flag-expected-discharge', { bedId: bed.id });
  assert.equal(p.proposal.command, 'ospeli_beds_flag_expected_discharge');
  assert.equal(p.proposal.calledAs, 'bed.flag-expected-discharge');
  // A refusal by an old name is collapsed and recorded under the new one.
  await assert.rejects(agent('agents.set-access', { allowed: true }), code('agents-off'));
  const refused = (await core.auditLog()).filter((e) => e.action === 'agent.refused').pop();
  assert.deepEqual([refused.detail.command, refused.detail.calledAs], ['ospeli_agents_set_access', 'agents.set-access']);
  // An unknown name: nothing typed is stored.
  await assert.rejects(agent('beds.everything'), (e) => e.code === 'unknown-command' && /ospeli_beds_find_free/.test(e.message));
  assert.equal((await core.auditLog()).filter((e) => e.action === 'agent.refused').pop().detail.command, '(unknown)');
});

test('a proposal queued under an old name before the rename is listed under the new name and can still be accepted', async () => {
  const { core } = await setup();
  const bed = (await runCommand(core, 'ospeli_beds_board', { wardId: 'ward-a1' }, human('bed-manager'))).beds.find((x) => x.state === 'occupied');
  // As stored by an earlier build: the dotted name.
  await core.setMeta('agent-proposals', [{ id: 'prop-0001', command: 'bed.flag-expected-discharge', input: { bedId: bed.id }, agent: 'flow-helper', role: 'bed-manager', at: END, status: 'pending', wardId: 'ward-a1', seenState: 'occupied' }]);
  const q = await runCommand(core, 'ospeli_proposals_list', { status: 'pending' }, human('ward-nurse'));
  ok('ospeli_proposals_list', q);
  assert.equal(q.proposals[0].command, 'ospeli_beds_flag_expected_discharge');
  assert.equal(q.proposals[0].canDecide, true);
  const done = await runCommand(core, 'ospeli_proposals_accept', { id: 'prop-0001' }, human('ward-nurse'));
  assert.equal(done.status, 'accepted');
  assert.equal((await runCommand(core, 'ospeli_beds_get', { bedId: bed.id }, human('ward-nurse'))).bed.state, 'expected-discharge');
});

test('list reads are never dumped whole: limit, total and truncated, with counts worked out before the cut', async () => {
  const { core } = await setup();
  const who = human('coo');
  const full = await runCommand(core, 'ospeli_beds_board', {}, who);
  ok('ospeli_beds_board', full);
  assert.deepEqual([full.beds.length, full.total, full.truncated], [120, 120, false]);
  const cut = await runCommand(core, 'ospeli_beds_board', { limit: 7 }, who);
  assert.deepEqual([cut.beds.length, cut.total, cut.truncated], [7, 120, true]);
  assert.deepEqual(cut.wards, full.wards, 'ward counts are for every bed, not the seven listed');
  const short = await runCommand(core, 'ospeli_beds_board', { format: 'short' }, who);
  ok('ospeli_beds_board', short);
  assert.deepEqual([short.beds.length, short.total, short.truncated], [0, 120, false]);
  assert.deepEqual(short.wards, full.wards);

  const kpis = await runCommand(core, 'ospeli_kpi_list', { format: 'short', limit: 3 }, who);
  ok('ospeli_kpi_list', kpis);
  assert.equal(kpis.kpis.length, 3);
  assert.equal(kpis.truncated, kpis.total > 3);
  assert.ok(kpis.kpis.every((k) => !('numerator' in k)));

  const assets = await runCommand(core, 'ospeli_assets_list', { format: 'short', limit: 4 }, who);
  ok('ospeli_assets_list', assets);
  assert.deepEqual([assets.assets.length, assets.truncated, 'faults' in assets.assets[0]], [4, true, false]);
  assert.ok(assets.total > 4);

  const wo = await runCommand(core, 'ospeli_workorders_list', { state: 'completed' }, who);
  assert.equal(wo.workOrders.length, 20, 'default limit');
  assert.ok(wo.total > 30 && wo.truncated);
  for (const c of listCommands().filter((x) => x.kind === 'read' && /_(list|board)$/.test(x.name) && x.agentsMayCall)) {
    assert.ok(c.input.properties.limit, `${c.name} takes a limit`);
    assert.ok(c.output.required.includes('total') && c.output.required.includes('truncated'), `${c.name} says total and truncated`);
  }
});
