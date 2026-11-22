// Pharmacy operations (module pharmacy): its commands without the screen, every refusal, agent
// proposals, attack tests, the guide switch and the synthetic history. The measures are recomputed
// by hand in pharmacy-kpis.test.mjs. Fictional data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Core } from '../../web/app/core/core.js';
import { MemoryAdapter } from '../../web/app/core/db.js';
import { loadSyntheticHospital, generateHospital } from '../../web/app/core/generator.js';
import { runCommand, CommandError, commandByName } from '../../web/app/core/commands.js';
import { validate } from '../../web/app/core/schema.js';
import { deriveRequests, dischargeTurnaround, stageTimes, collectionWait } from '../../web/app/modules/pharmacy/logic.js';

const END = '2026-11-20T18:00:00.000Z'; // 14:00 at the example site
const MIN = 60e3;
const human = (role) => ({ type: 'human', role });
const agent = (role, name) => ({ type: 'agent', role, agent: name });
const code = (c) => (err) => err instanceof CommandError && err.code === c;

async function site() {
  let t = Date.parse(END);
  const core = await Core.open({ adapter: new MemoryAdapter(), clock: () => new Date(t) });
  await loadSyntheticHospital(core, { end: END });
  const run = (name, input, who) => runCommand(core, name, input, typeof who === 'string' ? human(who) : who);
  return { core, run, advance: (m) => { t += m * MIN; } };
}
const out = (name, value) => assert.deepEqual(validate(commandByName(name).output, value), [], `${name}: answer matches its schema`);
const freeBed = async (run, wardId) => (await run('ospeli_pharmacy_ward_requests', { wardId }, 'ward-nurse')).beds.find((b) => !b.request).bedId;
const pharmacyEvents = async (core) => (await core.events()).filter((e) => e.type.startsWith('pharmacy.'));

test('the example hospital: open requests at every stage and one on hold, measures with sources, Ward A3 asks late, and nothing clinical in any event', async () => {
  const { core, run } = await site();
  const q = await run('ospeli_pharmacy_queue_list', {}, 'pharmacy-technician');
  out('ospeli_pharmacy_queue_list', q);
  for (const s of ['raised', 'started', 'checked', 'ready', 'on-hold']) assert.ok(q.counts[s] >= 1, `at least one ${s}`);
  assert.deepEqual([...new Set(q.requests.map((r) => r.section))], ['working', 'on-hold', 'ready'], 'working order, then on hold, then ready');
  assert.match(q.checkNote, /done outside Ospeli; this records the time/);
  const ov = await run('ospeli_pharmacy_overview', {}, 'pharmacy-manager');
  out('ospeli_pharmacy_overview', ov);
  for (const k of ov.kpis) { assert.ok(k.value > 0 && k.n > 0, `${k.id} has a value`); assert.match(k.source, /^local definition/); }
  assert.ok(ov.guide.suggestions.some((s) => s.rule === 'late-requests' && s.wardId === 'ward-a3'), 'Ward A3 asks late in the history');
  assert.deepEqual(ov.planned, [{ id: 'stock', text: 'Stock levels and expiry: planned' }]);
  assert.match(ov.note, /does not hold what was prescribed/);
  const w = await run('ospeli_pharmacy_ward_requests', { wardId: 'ward-a2' }, 'ward-nurse');
  out('ospeli_pharmacy_ward_requests', w);
  assert.ok(w.beds.length > 0 && w.requests.some((r) => r.estimate && r.estimate.minutes > 0), 'beds for the form, and an estimate');
  // Every key any pharmacy event carries: a ward, a bed, the patient's encounter code, picks, a count, a reason, a switch.
  const keys = new Set((await pharmacyEvents(core)).flatMap((e) => Object.keys(e.data || {})));
  for (const k of keys) assert.ok(['wardId', 'bedId', 'encounter', 'kind', 'priority', 'planned', 'items', 'reason', 'front', 'step', 'on'].includes(k), `event field ${k}`);
});

test('the synthetic history: repeatable, peaks late morning, most collected with a long tail, cancels mostly postponed discharges, holds mostly waiting for the ward', () => {
  const a = generateHospital({ end: END }).events.filter((e) => e.type.startsWith('pharmacy.'));
  const b = generateHospital({ end: END }).events.filter((e) => e.type.startsWith('pharmacy.'));
  assert.deepEqual(a, b);
  const all = [...deriveRequests(a).values()];
  assert.ok(all.length > 500, `${all.length} requests in 30 days`);
  const hour = (r) => (new Date(r.raisedAt).getUTCHours() + 24 - 4) % 24;
  const by = (f) => all.filter(f).length;
  assert.ok(by((r) => hour(r) >= 10 && hour(r) < 16) > by((r) => hour(r) < 10 || hour(r) >= 16), 'busier late morning and afternoon');
  assert.ok(by((r) => r.kind === 'discharge' && hour(r) >= 17) > 0, 'a few discharge requests late in the day');
  assert.ok(by((r) => r.stage === 'collected') / all.length > 0.85);
  const cancels = all.filter((r) => r.stage === 'cancelled');
  assert.ok(cancels.length > 10 && cancels.filter((r) => r.cancelReason === 'discharge-postponed').length > cancels.length / 2);
  const holds = all.flatMap((r) => r.holds.map((x) => x.reason).concat(r.held ? [r.holdReason] : []));
  assert.ok(holds.filter((x) => x === 'waiting-for-ward').length > holds.length / 2);
  assert.ok(holds.every((x) => x !== 'waiting-for-collection'), 'never held waiting for collection');
});

test('the main task: a nurse asks, the technician starts, the pharmacist records Checked, the technician makes it Ready, the ward collects; measures and the ward view follow', async () => {
  const { core, run, advance } = await site();
  // The measures over a fixed window, so the clock moving on drops nothing out of it.
  const win = { since: '2026-11-13T18:00:00.000Z', until: '2026-11-21T18:00:00.000Z', offsetMinutes: -240 };
  const kpiN = async () => { const all = deriveRequests(await core.events()); return { turn: dischargeTurnaround(all, win).n, stages: stageTimes(all, win).n, coll: collectionWait(all, win).n }; };
  const k0 = await kpiN();
  const bedId = await freeBed(run, 'ward-b2');
  const made = await run('ospeli_pharmacy_request_raise', { wardId: 'ward-b2', bedId, kind: 'discharge', priority: 'routine', planned: 'this-afternoon', items: 5 }, 'ward-nurse');
  out('ospeli_pharmacy_request_raise', made);
  const id = made.requestId;
  assert.match(id, /^rx-\d{5}$/);
  const raisedEv = (await pharmacyEvents(core)).at(-1);
  assert.deepEqual([raisedEv.actorRole, raisedEv.data.kind, raisedEv.data.items], ['ward-nurse', 'discharge', 5], 'the role is recorded, never a person');
  advance(10);
  const s = await run('ospeli_pharmacy_request_step', { requestId: id, step: 'start', expectedState: 'raised' }, 'pharmacy-technician');
  out('ospeli_pharmacy_request_step', s);
  assert.equal(s.state, 'started');
  // A double tap: the same Start again saves nothing and says so.
  await assert.rejects(run('ospeli_pharmacy_request_step', { requestId: id, step: 'start', expectedState: 'raised' }, 'pharmacy-technician'), (e) => code('conflict')(e) && /Already changed: .* is now Started/.test(e.message));
  // Ready cannot come before Checked, whatever the order of taps.
  await assert.rejects(run('ospeli_pharmacy_request_step', { requestId: id, step: 'ready' }, 'pharmacy-technician'), (e) => code('conflict')(e) && /Ready needs Checked first/.test(e.message));
  // Only a pharmacist records Checked.
  for (const role of ['pharmacy-technician', 'pharmacy-manager', 'ward-nurse']) await assert.rejects(run('ospeli_pharmacy_request_check', { requestId: id }, role), code('forbidden'), role);
  advance(15);
  const c = await run('ospeli_pharmacy_request_check', { requestId: id, expectedState: 'started' }, 'pharmacist');
  assert.equal(c.state, 'checked');
  await assert.rejects(run('ospeli_pharmacy_request_check', { requestId: id }, 'pharmacist'), code('conflict'), 'checked twice');
  advance(5);
  await run('ospeli_pharmacy_request_step', { requestId: id, step: 'ready', expectedState: 'checked' }, 'pharmacy-technician');
  const ward = await run('ospeli_pharmacy_ward_requests', { wardId: 'ward-b2' }, 'ward-nurse');
  const mine = ward.requests.find((r) => r.id === id);
  assert.deepEqual([mine.state, mine.nextStep], ['ready', 'collect']);
  const k1 = await kpiN();
  assert.equal(k1.turn, k0.turn + 1, 'the turnaround counts it (raised 14:00, in the working day)');
  assert.equal(k1.stages, k0.stages + 3);
  const ov = await run('ospeli_pharmacy_overview', {}, 'pharmacy-manager');
  assert.ok(ov.kpis.find((k) => k.id === 'discharge-turnaround').byWard.some((w) => w.wardId === 'ward-b2' && w.n > 0));
  advance(20);
  await assert.rejects(run('ospeli_pharmacy_request_collect', { requestId: id }, 'bed-manager'), code('forbidden'));
  const col = await run('ospeli_pharmacy_request_collect', { requestId: id, expectedState: 'ready' }, 'ward-nurse');
  out('ospeli_pharmacy_request_collect', col);
  await assert.rejects(run('ospeli_pharmacy_request_collect', { requestId: id, expectedState: 'ready' }, 'ward-nurse'), code('conflict'), 'collected twice');
  assert.equal((await kpiN()).coll, k1.coll + 1);
  // Each write left one audit entry, by role.
  const trail = (await core.db.getAll('audit')).filter((a) => a.target === id);
  assert.deepEqual(trail.map((a) => a.action), ['pharmacy.request-raised', 'pharmacy.request-started', 'pharmacy.request-checked', 'pharmacy.request-ready', 'pharmacy.request-collected']);
});

test('raising: every refusal, and an attack with text, made-up ids and unknown fields', async () => {
  const { run } = await site();
  const bedId = await freeBed(run, 'ward-a1');
  const ok = { wardId: 'ward-a1', bedId, kind: 'discharge', priority: 'routine', planned: 'this-evening', items: 3 };
  for (const role of ['pharmacist', 'pharmacy-manager', 'coo', 'estates-tech']) await assert.rejects(run('ospeli_pharmacy_request_raise', ok, role), code('forbidden'), role);
  await assert.rejects(run('ospeli_pharmacy_request_raise', { ...ok, wardId: 'ward-zz' }, 'ward-nurse'), (e) => code('not-found')(e) && !e.message.includes('ward-zz'), 'a made-up ward is not echoed');
  await assert.rejects(run('ospeli_pharmacy_request_raise', { ...ok, bedId: 'ward-b1-bed-01' }, 'ward-nurse'), code('not-found'), 'a bed on another ward');
  await assert.rejects(run('ospeli_pharmacy_request_raise', { ...ok, planned: undefined }, 'ward-nurse'), code('invalid-input'), 'discharge needs a planned pick');
  await assert.rejects(run('ospeli_pharmacy_request_raise', { ...ok, bedId: undefined }, 'ward-nurse'), code('invalid-input'), 'discharge needs a bed');
  await assert.rejects(run('ospeli_pharmacy_request_raise', { wardId: 'ward-a1', kind: 'ward-request', priority: 'routine', planned: 'tomorrow', items: 2 }, 'ward-nurse'), code('invalid-input'), 'planned is for discharge only');
  for (const items of [0, 31, 2.5, '4']) await assert.rejects(run('ospeli_pharmacy_request_raise', { ...ok, items }, 'ward-nurse'), code('invalid-input'), `items ${items}`);
  // Nothing clinical can be sent: no field for it, and no pick takes text.
  await assert.rejects(run('ospeli_pharmacy_request_raise', { ...ok, note: 'Patient John Smith, 5 mg twice a day' }, 'ward-nurse'), code('invalid-input'));
  await assert.rejects(run('ospeli_pharmacy_request_raise', { ...ok, medicine: 'something' }, 'ward-nurse'), code('invalid-input'));
  await assert.rejects(run('ospeli_pharmacy_request_raise', { ...ok, kind: 'Paracetamol 500 mg' }, 'ward-nurse'), code('invalid-input'));
  await assert.rejects(run('ospeli_pharmacy_request_raise', { ...ok, priority: 'stat' }, 'ward-nurse'), code('invalid-input'));
  await assert.rejects(run('ospeli_pharmacy_request_raise', { ...ok, bedId: 'Bed of Mrs Jones' }, 'ward-nurse'), code('invalid-input'), 'an id field takes an id shape only');
  const made = await run('ospeli_pharmacy_request_raise', ok, 'ward-nurse');
  await assert.rejects(run('ospeli_pharmacy_request_raise', { ...ok, items: 4 }, 'ward-nurse'), (e) => code('conflict')(e) && e.detail.existing === made.requestId, 'one open discharge request per bed');
  const wr = { wardId: 'ward-a1', kind: 'ward-request', priority: 'urgent', items: 9 };
  await run('ospeli_pharmacy_request_raise', wr, 'pharmacy-technician');
  await assert.rejects(run('ospeli_pharmacy_request_raise', wr, 'ward-nurse'), (e) => code('conflict')(e) && /Already saved/.test(e.message), 'the same picks again at once');
});

test('steps: hold and resume with reasons, cancel, undo within the window, move to the front (manager only), and every refusal', async () => {
  const { core, run, advance } = await site();
  const { requestId: id } = await run('ospeli_pharmacy_request_raise', { wardId: 'ward-c1', kind: 'ward-request', priority: 'routine', items: 2 }, 'ward-nurse');
  const st = (step, extra = {}, role = 'pharmacy-technician') => run('ospeli_pharmacy_request_step', { requestId: id, step, ...extra }, role);
  for (const role of ['ward-nurse', 'bed-manager', 'coo']) await assert.rejects(st('start', {}, role), code('forbidden'), role);
  await assert.rejects(st('hold'), code('invalid-input'), 'a hold needs a reason');
  await assert.rejects(st('start', { reason: 'duplicate' }), code('invalid-input'), 'reason is for hold and cancel');
  await assert.rejects(st('hold', { reason: 'duplicate' }), code('invalid-input'), 'a cancel reason is not a hold reason');
  await assert.rejects(st('hold', { reason: 'waiting-for-collection' }), code('invalid-input'), 'waiting for collection is not a hold reason');
  await assert.rejects(st('resume'), code('conflict'), 'not on hold');
  await assert.rejects(st('undo'), code('conflict'), 'nothing to undo');
  await st('start');
  await st('hold', { reason: 'waiting-for-ward' });
  await assert.rejects(st('start'), code('conflict'));
  await assert.rejects(run('ospeli_pharmacy_request_check', { requestId: id }, 'pharmacist'), (e) => code('conflict')(e) && /on hold/.test(e.message));
  advance(30);
  await st('resume');
  let r = deriveRequests(await core.events()).get(id);
  assert.deepEqual([r.stage, r.held, r.holds.length, r.holds[0].reason], ['started', false, 1, 'waiting-for-ward']);
  // Undo: Started can be undone within 10 minutes of the step (the resume is not a step), and no later.
  await assert.rejects(st('undo'), code('conflict'), 'the last move was a resume, not Start');
  await run('ospeli_pharmacy_request_check', { requestId: id }, 'pharmacist');
  await assert.rejects(st('undo'), (e) => code('conflict')(e) && /ospeli_pharmacy_request_check and undo: true/.test(e.message));
  await run('ospeli_pharmacy_request_check', { requestId: id, undo: true }, 'pharmacist');
  r = deriveRequests(await core.events()).get(id);
  assert.deepEqual([r.stage, r.checkedAt, r.undone], ['started', null, 1], 'undone by a new event; history kept');
  await run('ospeli_pharmacy_request_check', { requestId: id }, 'pharmacist');
  await st('ready');
  advance(11);
  await assert.rejects(st('undo'), code('conflict'), 'past the 10-minute window');
  await assert.rejects(st('hold', { reason: 'not-in-stock' }), (e) => code('conflict')(e) && /collection wait/.test(e.message), 'a ready request is not held');
  // Move to the front: the manager only, and the queue shows it first with its mark.
  const { requestId: other } = await run('ospeli_pharmacy_request_raise', { wardId: 'ward-c1', kind: 'other', priority: 'routine', items: 1 }, 'ward-nurse');
  for (const role of ['pharmacy-technician', 'pharmacist']) await assert.rejects(run('ospeli_pharmacy_request_step', { requestId: other, step: 'front' }, role), code('forbidden'), role);
  await run('ospeli_pharmacy_request_step', { requestId: other, step: 'front' }, 'pharmacy-manager');
  await assert.rejects(run('ospeli_pharmacy_request_step', { requestId: other, step: 'front' }, 'pharmacy-manager'), code('conflict'));
  const q = await run('ospeli_pharmacy_queue_list', {}, 'pharmacy-technician');
  assert.deepEqual([q.requests[0].id, q.requests[0].front, q.requests[0].orderReason], [other, true, 'Moved to the front by the manager']);
  await run('ospeli_pharmacy_request_step', { requestId: other, step: 'back' }, 'pharmacy-manager');
  assert.notEqual((await run('ospeli_pharmacy_queue_list', {}, 'pharmacy-technician')).requests[0].id, other);
  // Cancel with a reason; nothing more after that.
  await run('ospeli_pharmacy_request_step', { requestId: other, step: 'cancel', reason: 'raised-in-error' }, 'pharmacist');
  await assert.rejects(run('ospeli_pharmacy_request_step', { requestId: other, step: 'start' }, 'pharmacy-technician'), (e) => code('conflict')(e) && /cancelled/.test(e.message));
  // Made-up and malformed ids.
  await assert.rejects(run('ospeli_pharmacy_request_step', { requestId: 'rx-99999', step: 'start' }, 'pharmacy-technician'), (e) => code('not-found')(e) && !e.message.includes('rx-99999'));
  await assert.rejects(run('ospeli_pharmacy_request_step', { requestId: 'rx-1; drop', step: 'start' }, 'pharmacy-technician'), code('invalid-input'));
  await assert.rejects(run('ospeli_pharmacy_request_step', { requestId: id, step: 'verify' }, 'pharmacy-technician'), code('invalid-input'));
  await assert.rejects(run('ospeli_pharmacy_request_step', { requestId: id, step: 'start', staffId: 'x' }, 'pharmacy-technician'), code('invalid-input'));
});

test('agents: a write becomes a proposal and changes nothing until a person accepts; a ward switched off gets nothing queued; the guide is people only; a read sees its own wards', async () => {
  const { core, run } = await site();
  await run('ospeli_agents_set_access', { allowed: true, wards: { 'ward-a1': true, 'ward-b1': false } }, 'coo');
  await run('ospeli_agents_add', { name: 'rx-ward-bot', role: 'ward-nurse', wards: ['ward-a1', 'ward-b1'], days: 30 }, 'coo');
  await run('ospeli_agents_add', { name: 'rx-bench-bot', role: 'pharmacy-technician', wards: ['ward-a1', 'ward-b1'], days: 30 }, 'coo');
  const nurseBot = agent('ward-nurse', 'rx-ward-bot');
  const benchBot = agent('pharmacy-technician', 'rx-bench-bot');
  const n0 = (await pharmacyEvents(core)).length;
  const p = await run('ospeli_pharmacy_request_raise', { wardId: 'ward-a1', kind: 'ward-request', priority: 'routine', items: 3 }, nurseBot);
  assert.equal(p.status, 'proposed');
  assert.equal((await pharmacyEvents(core)).length, n0, 'nothing changed');
  // A ward switched off: refused before anything is queued, for a raise and for a step on that ward's request.
  const pending0 = (await core.proposals()).filter((x) => x.status === 'pending').length;
  await assert.rejects(run('ospeli_pharmacy_request_raise', { wardId: 'ward-b1', kind: 'ward-request', priority: 'routine', items: 3 }, nurseBot), code('agents-off'));
  const { requestId: b1 } = await run('ospeli_pharmacy_request_raise', { wardId: 'ward-b1', kind: 'other', priority: 'routine', items: 1 }, 'ward-nurse');
  await assert.rejects(run('ospeli_pharmacy_request_step', { requestId: b1, step: 'start' }, benchBot), (e) => code('agents-off')(e) && !e.message.includes('ward-b1'), 'the looked-up ward is not named back');
  assert.equal((await core.proposals()).filter((x) => x.status === 'pending').length, pending0, 'nothing queued for ward-b1');
  // A proposal is checked before it queues: Ready before Checked, a made-up request.
  const { requestId: a1 } = await run('ospeli_pharmacy_request_raise', { wardId: 'ward-a1', kind: 'other', priority: 'routine', items: 1 }, 'ward-nurse');
  await run('ospeli_pharmacy_request_step', { requestId: a1, step: 'start' }, 'pharmacy-technician');
  await assert.rejects(run('ospeli_pharmacy_request_step', { requestId: a1, step: 'ready' }, benchBot), code('conflict'));
  await assert.rejects(run('ospeli_pharmacy_request_step', { requestId: 'rx-77777', step: 'start' }, benchBot), code('not-found'));
  await assert.rejects(run('ospeli_pharmacy_request_check', { requestId: a1 }, benchBot), code('forbidden'), 'a technician agent cannot propose Checked');
  await assert.rejects(run('ospeli_pharmacy_guide_set', { on: false }, benchBot), code('forbidden'));
  // People decide: a role outside the command cannot accept; the ward nurse can.
  await assert.rejects(run('ospeli_proposals_accept', { id: p.proposal.id }, 'pharmacist'), code('forbidden'));
  const acc = await run('ospeli_proposals_accept', { id: p.proposal.id }, 'ward-nurse');
  assert.equal(acc.status, 'accepted');
  assert.equal((await pharmacyEvents(core)).filter((e) => e.type === 'pharmacy.request-raised').at(-1).subject, acc.result.requestId);
  // A step proposal keeps the state the agent saw: if a person moved it on first, accepting saves nothing.
  const { requestId: a2 } = await run('ospeli_pharmacy_request_raise', { wardId: 'ward-a1', kind: 'other', priority: 'urgent', items: 2 }, 'ward-nurse');
  const sp = await run('ospeli_pharmacy_request_step', { requestId: a2, step: 'start' }, benchBot);
  assert.equal(sp.status, 'proposed');
  await run('ospeli_pharmacy_request_step', { requestId: a2, step: 'start' }, 'pharmacist');
  const late = await run('ospeli_proposals_accept', { id: sp.proposal.id }, 'pharmacy-technician');
  assert.equal(late.status, 'expired');
  // Reads: only the wards the agent may see.
  const q = await run('ospeli_pharmacy_queue_list', { limit: 500 }, benchBot);
  assert.ok(q.requests.length && q.requests.every((r) => r.wardId === 'ward-a1'));
  const ov = await run('ospeli_pharmacy_overview', {}, benchBot);
  assert.deepEqual(ov.byWard.map((w) => w.wardId), ['ward-a1']);
  await assert.rejects(run('ospeli_pharmacy_ward_requests', { wardId: 'ward-b1' }, nurseBot), code('agents-off'));
});

test('the guide switch: off shows no suggestion and everything else is the same; the pharmacy manager only; people only', async () => {
  const { run } = await site();
  const on = await run('ospeli_pharmacy_overview', {}, 'pharmacy-manager');
  assert.ok(on.guide.on && on.guide.suggestions.length > 0);
  for (const role of ['pharmacist', 'pharmacy-technician', 'ward-nurse']) await assert.rejects(run('ospeli_pharmacy_guide_set', { on: false }, role), code('forbidden'), role);
  await assert.rejects(run('ospeli_pharmacy_guide_set', { on: true }, 'pharmacy-manager'), code('conflict'), 'already on');
  const r = await run('ospeli_pharmacy_guide_set', { on: false }, 'pharmacy-manager');
  out('ospeli_pharmacy_guide_set', r);
  const off = await run('ospeli_pharmacy_overview', {}, 'pharmacy-manager');
  assert.deepEqual([off.guide.on, off.guide.suggestions], [false, []]);
  const same = (x) => JSON.stringify([x.counts, x.byWard, x.oldest, x.kpis]);
  assert.equal(same(off), same(on), 'the queue, the wards and the measures are the same with the guide off');
  // The main task still works with the guide off.
  const { requestId } = await run('ospeli_pharmacy_request_raise', { wardId: 'ward-a1', kind: 'other', priority: 'routine', items: 1 }, 'ward-nurse');
  assert.equal((await run('ospeli_pharmacy_request_step', { requestId, step: 'start' }, 'pharmacy-technician')).state, 'started');
  await run('ospeli_pharmacy_guide_set', { on: true }, 'pharmacy-manager');
  assert.ok((await run('ospeli_pharmacy_overview', {}, 'pharmacy-manager')).guide.suggestions.length > 0);
});

test('a device with an older example hospital and no pharmacy history: every read answers, with empty lists and no figures', async () => {
  let t = Date.parse(END);
  const core = await Core.open({ adapter: new MemoryAdapter(), clock: () => new Date(t) });
  await loadSyntheticHospital(core, { end: END, modules: false });
  const run = (n, i, role) => runCommand(core, n, i, human(role));
  const q = await run('ospeli_pharmacy_queue_list', {}, 'pharmacy-technician');
  assert.deepEqual([q.total, q.requests], [0, []]);
  const ov = await run('ospeli_pharmacy_overview', {}, 'pharmacy-manager');
  assert.ok(ov.kpis.every((k) => k.value === null && k.n === 0));
  assert.deepEqual(ov.guide.suggestions, []);
  const w = await run('ospeli_pharmacy_ward_requests', { wardId: 'ward-a1' }, 'ward-nurse');
  assert.deepEqual(w.requests, []);
});
