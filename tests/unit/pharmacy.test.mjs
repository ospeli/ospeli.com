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
  await assert.rejects(st('start', { reason: 'waiting-for-ward' }), code('invalid-input'), 'reason is for hold only');
  await assert.rejects(st('hold', { reason: 'duplicate' }), code('invalid-input'), 'a cancel reason is not a hold reason');
  await assert.rejects(st('cancel', { reason: 'duplicate' }), code('invalid-input'), 'a cancel is its own command');
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
  await run('ospeli_pharmacy_request_cancel', { requestId: other, reason: 'raised-in-error' }, 'pharmacist');
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

test('a hold after Checked for stock or supply sends the request back to Started on resume: Ready waits for a new Checked (person and agent); "waiting for the ward" keeps Checked', async () => {
  const { core, run } = await site();
  let n = 0;
  const make = async () => {
    const { requestId } = await run('ospeli_pharmacy_request_raise', { wardId: 'ward-a1', kind: 'other', priority: 'routine', items: 10 + (n += 1) }, 'ward-nurse');
    await run('ospeli_pharmacy_request_step', { requestId, step: 'start' }, 'pharmacy-technician');
    await run('ospeli_pharmacy_request_check', { requestId }, 'pharmacist');
    return requestId;
  };
  for (const reason of ['not-in-stock', 'waiting-for-supply']) {
    const id = await make();
    await run('ospeli_pharmacy_request_step', { requestId: id, step: 'hold', reason }, 'pharmacy-technician');
    const back = await run('ospeli_pharmacy_request_step', { requestId: id, step: 'resume', expectedState: 'on-hold' }, 'pharmacy-technician');
    assert.equal(back.state, 'started', `${reason}: back to Started`);
    const evs = (await pharmacyEvents(core)).filter((e) => e.subject === id).slice(-2);
    assert.deepEqual(evs.map((e) => [e.type, e.data]), [['pharmacy.request-resumed', {}], ['pharmacy.step-undone', { step: 'checked', reason: 'recheck' }]], 'a correcting event, history kept');
    await assert.rejects(run('ospeli_pharmacy_request_step', { requestId: id, step: 'ready' }, 'pharmacy-technician'), (e) => code('conflict')(e) && /needs the pharmacist's check again/.test(e.message));
    const q = (await run('ospeli_pharmacy_queue_list', {}, 'pharmacist')).requests.find((r) => r.id === id);
    assert.deepEqual([q.state, q.recheck, q.nextStep], ['started', true, 'check']);
    await run('ospeli_pharmacy_request_check', { requestId: id }, 'pharmacist');
    assert.equal((await run('ospeli_pharmacy_request_step', { requestId: id, step: 'ready' }, 'pharmacy-technician')).state, 'ready');
  }
  const ward = await make();
  await run('ospeli_pharmacy_request_step', { requestId: ward, step: 'hold', reason: 'waiting-for-ward' }, 'pharmacy-technician');
  assert.equal((await run('ospeli_pharmacy_request_step', { requestId: ward, step: 'resume' }, 'pharmacy-technician')).state, 'checked', 'waiting for the ward keeps Checked');
  // An agent's resume: the proposal changes nothing; accepted, it sends the request back too, and Ready is refused before it queues.
  await run('ospeli_agents_set_access', { allowed: true, wards: { 'ward-a1': true } }, 'coo');
  await run('ospeli_agents_add', { name: 'rx-bench-bot', role: 'pharmacy-technician', wards: ['ward-a1'], days: 30 }, 'coo');
  const bot = agent('pharmacy-technician', 'rx-bench-bot');
  const id = await make();
  await run('ospeli_pharmacy_request_step', { requestId: id, step: 'hold', reason: 'not-in-stock' }, 'pharmacy-technician');
  const p = await run('ospeli_pharmacy_request_step', { requestId: id, step: 'resume' }, bot);
  assert.equal(p.status, 'proposed');
  assert.equal(deriveRequests(await core.events()).get(id).held, true, 'nothing changed');
  assert.equal((await run('ospeli_proposals_accept', { id: p.proposal.id }, 'pharmacy-technician')).status, 'accepted');
  assert.equal(deriveRequests(await core.events()).get(id).stage, 'started');
  await assert.rejects(run('ospeli_pharmacy_request_step', { requestId: id, step: 'ready' }, bot), (e) => code('conflict')(e) && /check again/.test(e.message), 'no Ready proposal queues');
});

test('the replay sends a stock hold at Checked back to Started even with no correcting event (an edited import cannot skip the check)', () => {
  const at = (m) => new Date(Date.parse(END) - (60 - m) * MIN).toISOString();
  const ev = [
    { type: 'pharmacy.request-raised', subject: 'rx-00700', at: at(0), actorRole: 'ward-nurse', data: { wardId: 'ward-a1', kind: 'other', priority: 'routine', items: 1 } },
    { type: 'pharmacy.request-started', subject: 'rx-00700', at: at(1), actorRole: 'pharmacy-technician', data: {} },
    { type: 'pharmacy.request-checked', subject: 'rx-00700', at: at(2), actorRole: 'pharmacist', data: {} },
    { type: 'pharmacy.request-on-hold', subject: 'rx-00700', at: at(3), actorRole: 'pharmacy-technician', data: { reason: 'waiting-for-supply' } },
    { type: 'pharmacy.request-resumed', subject: 'rx-00700', at: at(4), actorRole: 'pharmacy-technician', data: {} },
    { type: 'pharmacy.request-ready', subject: 'rx-00700', at: at(5), actorRole: 'pharmacy-technician', data: {} },
  ];
  const r = deriveRequests(ev).get('rx-00700');
  assert.deepEqual([r.stage, r.readyAt, r.checkedAt, r.recheck], ['started', null, null, true]);
});

test('undo Collected and undo Cancel: within 10 minutes, people only, by a role that may, and every refusal', async () => {
  const { core, run, advance } = await site();
  await run('ospeli_agents_set_access', { allowed: true, wards: { 'ward-a1': true } }, 'coo');
  await run('ospeli_agents_add', { name: 'rx-ward-bot', role: 'ward-nurse', wards: ['ward-a1'], days: 30 }, 'coo');
  const bot = agent('ward-nurse', 'rx-ward-bot');
  const ready = async () => {
    const { requestId } = await run('ospeli_pharmacy_request_raise', { wardId: 'ward-a1', kind: 'other', priority: 'routine', items: 3 }, 'ward-nurse');
    await run('ospeli_pharmacy_request_step', { requestId, step: 'start' }, 'pharmacy-technician');
    await run('ospeli_pharmacy_request_check', { requestId }, 'pharmacist');
    await run('ospeli_pharmacy_request_step', { requestId, step: 'ready' }, 'pharmacy-technician');
    return requestId;
  };
  // Collected.
  const a = await ready();
  await assert.rejects(run('ospeli_pharmacy_request_collect', { requestId: a, undo: true }, 'ward-nurse'), code('conflict'), 'nothing collected yet');
  await run('ospeli_pharmacy_request_collect', { requestId: a }, 'ward-nurse');
  await assert.rejects(run('ospeli_pharmacy_request_collect', { requestId: a, undo: true }, bot), code('forbidden'), 'people only');
  await assert.rejects(run('ospeli_pharmacy_request_collect', { requestId: a, undo: true }, 'bed-manager'), code('forbidden'), 'a role that cannot collect');
  const u = await run('ospeli_pharmacy_request_collect', { requestId: a, undo: true }, 'ward-nurse');
  assert.equal(u.state, 'ready');
  let r = deriveRequests(await core.events()).get(a);
  assert.deepEqual([r.stage, r.collectedAt, r.undone], ['ready', null, 1]);
  await assert.rejects(run('ospeli_pharmacy_request_collect', { requestId: a, undo: true }, 'ward-nurse'), code('conflict'), 'undone once');
  await run('ospeli_pharmacy_request_collect', { requestId: a }, 'pharmacy-technician');
  advance(11);
  await assert.rejects(run('ospeli_pharmacy_request_collect', { requestId: a, undo: true }, 'pharmacy-technician'), code('conflict'), 'past 10 minutes');
  // Cancel: back to the stage it was at.
  const { requestId: b } = await run('ospeli_pharmacy_request_raise', { wardId: 'ward-a1', kind: 'other', priority: 'routine', items: 4 }, 'ward-nurse');
  await run('ospeli_pharmacy_request_step', { requestId: b, step: 'start' }, 'pharmacy-technician');
  await run('ospeli_pharmacy_request_check', { requestId: b }, 'pharmacist');
  await assert.rejects(run('ospeli_pharmacy_request_cancel', { requestId: b }, 'pharmacy-technician'), code('invalid-input'), 'a cancel needs a reason');
  await assert.rejects(run('ospeli_pharmacy_request_cancel', { requestId: b, reason: 'duplicate' }, 'ward-nurse'), code('forbidden'), 'the ward has its own reasons');
  for (const role of ['bed-manager', 'coo']) await assert.rejects(run('ospeli_pharmacy_request_cancel', { requestId: b, reason: 'no-longer-needed' }, role), code('forbidden'), role);
  await run('ospeli_pharmacy_request_cancel', { requestId: b, reason: 'discharge-postponed', expectedState: 'checked' }, 'ward-nurse');
  await assert.rejects(run('ospeli_pharmacy_request_cancel', { requestId: b, reason: 'discharge-postponed' }, 'ward-nurse'), code('conflict'), 'cancelled twice');
  await assert.rejects(run('ospeli_pharmacy_request_cancel', { requestId: b, undo: true }, bot), code('forbidden'), 'people only');
  await assert.rejects(run('ospeli_pharmacy_request_cancel', { requestId: b, undo: true, reason: 'duplicate' }, 'ward-nurse'), code('invalid-input'));
  const back = await run('ospeli_pharmacy_request_cancel', { requestId: b, undo: true }, 'ward-nurse');
  assert.equal(back.state, 'checked', 'back where it was');
  r = deriveRequests(await core.events()).get(b);
  assert.deepEqual([r.cancelReason, r.cancelledAt, r.undone], [null, null, 1]);
  // An agent may propose a cancel (a person decides), never an undo.
  const p = await run('ospeli_pharmacy_request_cancel', { requestId: b, reason: 'no-longer-needed' }, bot);
  assert.equal(p.status, 'proposed');
  assert.equal(deriveRequests(await core.events()).get(b).stage, 'checked');
  await assert.rejects(run('ospeli_pharmacy_request_step', { requestId: b, step: 'undo' }, agent('ward-nurse', 'rx-ward-bot')), code('forbidden'));
});

// Review round 2 (domain lead): no command path from "held at Checked for a stock or supply reason"
// reaches Ready without a new Checked. Each path starts from a fresh request held at Checked.
test('invariant: from a hold at Checked for stock or supply, every command path refuses Ready until a new Checked (incl. cancel then undo, by the pharmacy and by the ward)', async () => {
  const { core, run } = await site();
  let n = 0;
  const heldAtChecked = async (reason) => {
    const { requestId } = await run('ospeli_pharmacy_request_raise', { wardId: 'ward-b2', kind: 'other', priority: 'routine', items: 10 + (n += 1) }, 'ward-nurse');
    await run('ospeli_pharmacy_request_step', { requestId, step: 'start' }, 'pharmacy-technician');
    await run('ospeli_pharmacy_request_check', { requestId }, 'pharmacist');
    await run('ospeli_pharmacy_request_step', { requestId, step: 'hold', reason }, 'pharmacy-technician');
    return requestId;
  };
  const tryAll = async (id, label) => { // every way to Ready or past it, by every role that may: all refused
    await assert.rejects(run('ospeli_pharmacy_request_step', { requestId: id, step: 'ready' }, 'pharmacy-technician'), code('conflict'), `${label}: Ready`);
    await assert.rejects(run('ospeli_pharmacy_request_step', { requestId: id, step: 'ready' }, 'pharmacy-manager'), code('conflict'), `${label}: Ready by the manager`);
    await assert.rejects(run('ospeli_pharmacy_request_collect', { requestId: id }, 'ward-nurse'), code('conflict'), `${label}: Collected`);
    const r = deriveRequests(await core.events()).get(id);
    assert.ok(r.stage !== 'checked' || r.held, `${label}: never at Checked and free to go Ready (${r.stage}, held ${r.held})`);
    assert.equal(r.readyAt, null, label);
  };
  const S = (id, step, extra = {}, role = 'pharmacy-technician') => run('ospeli_pharmacy_request_step', { requestId: id, step, ...extra }, role);
  const cancel = (id, reason, role) => run('ospeli_pharmacy_request_cancel', { requestId: id, reason }, role);
  const undoCancel = (id, role) => run('ospeli_pharmacy_request_cancel', { requestId: id, undo: true }, role);
  const paths = {
    'resume': async (id) => { await S(id, 'resume'); },
    'pharmacy cancel, undo': async (id) => { await cancel(id, 'no-longer-needed', 'pharmacy-technician'); await undoCancel(id, 'pharmacy-technician'); },
    'ward cancel (raised in error), undo': async (id) => { await cancel(id, 'raised-in-error', 'ward-nurse'); await undoCancel(id, 'ward-nurse'); },
    'pharmacy cancel, undo, resume': async (id) => { await cancel(id, 'duplicate', 'pharmacist'); await undoCancel(id, 'pharmacist'); await S(id, 'resume'); },
    'ward cancel, undo, resume': async (id) => { await cancel(id, 'discharge-postponed', 'ward-nurse'); await undoCancel(id, 'ward-nurse'); await S(id, 'resume'); },
    'front, back, resume': async (id) => { await S(id, 'front', {}, 'pharmacy-manager'); await S(id, 'back', {}, 'pharmacy-manager'); await S(id, 'resume'); },
    'undo while held (refused), resume': async (id) => { await assert.rejects(S(id, 'undo'), code('conflict')); await assert.rejects(run('ospeli_pharmacy_request_check', { requestId: id, undo: true }, 'pharmacist'), code('conflict')); await S(id, 'resume'); },
    'check while held (refused), resume, undo (refused)': async (id) => { await assert.rejects(run('ospeli_pharmacy_request_check', { requestId: id }, 'pharmacist'), code('conflict')); await S(id, 'resume'); await assert.rejects(S(id, 'undo'), code('conflict')); },
    'resume, hold again for the ward, resume': async (id) => { await S(id, 'resume'); await S(id, 'hold', { reason: 'waiting-for-ward' }); await S(id, 'resume'); },
  };
  for (const reason of ['not-in-stock', 'waiting-for-supply']) {
    for (const [label, walk] of Object.entries(paths)) {
      const id = await heldAtChecked(reason);
      await walk(id);
      await tryAll(id, `${reason}: ${label}`);
      // A new Checked, and only then Ready.
      let r = deriveRequests(await core.events()).get(id);
      if (r.held) await S(id, 'resume');
      r = deriveRequests(await core.events()).get(id);
      assert.equal(r.stage, 'started', `${reason}: ${label}: back to Started for a new check`);
      await run('ospeli_pharmacy_request_check', { requestId: id }, 'pharmacist');
      assert.equal((await S(id, 'ready')).state, 'ready', `${reason}: ${label}: Ready after a new Checked`);
    }
  }
});

test('the two named cases, as the reviewer probed them: Checked, hold for stock, cancel (pharmacy, or the ward\'s "raised in error"), undo: back on hold with its reason', async () => {
  const { core, run } = await site();
  const cases = [['not-in-stock', 'no-longer-needed', 'pharmacy-technician'], ['waiting-for-supply', 'raised-in-error', 'ward-nurse']];
  for (const [i, [hold, why, who]] of cases.entries()) {
    const { requestId: id } = await run('ospeli_pharmacy_request_raise', { wardId: 'ward-c1', kind: 'other', priority: 'routine', items: 20 + i }, 'ward-nurse');
    await run('ospeli_pharmacy_request_step', { requestId: id, step: 'start' }, 'pharmacy-technician');
    await run('ospeli_pharmacy_request_check', { requestId: id }, 'pharmacist');
    await run('ospeli_pharmacy_request_step', { requestId: id, step: 'hold', reason: hold }, 'pharmacy-technician');
    await run('ospeli_pharmacy_request_cancel', { requestId: id, reason: why }, who);
    const back = await run('ospeli_pharmacy_request_cancel', { requestId: id, undo: true }, who);
    assert.equal(back.state, 'on-hold', 'the undo puts back exactly what was there');
    const r = deriveRequests(await core.events()).get(id);
    assert.deepEqual([r.held, r.holdReason, r.holds.length], [true, hold, 0], 'the same hold, still running');
    await assert.rejects(run('ospeli_pharmacy_request_step', { requestId: id, step: 'ready' }, 'pharmacy-technician'), code('conflict'));
    assert.equal((await run('ospeli_pharmacy_request_step', { requestId: id, step: 'resume' }, 'pharmacy-technician')).state, 'started');
    await assert.rejects(run('ospeli_pharmacy_request_step', { requestId: id, step: 'ready' }, 'pharmacy-technician'), (e) => code('conflict')(e) && /check again/.test(e.message));
  }
  // The replay alone, with no command: a ready step written straight after the undo is ignored.
  const at = (m) => new Date(Date.parse(END) - (60 - m) * MIN).toISOString();
  const e = (m, type, data = {}) => ({ type: `pharmacy.${type}`, subject: 'rx-00800', at: at(m), actorRole: 'pharmacy-technician', data });
  const r = deriveRequests([
    { type: 'pharmacy.request-raised', subject: 'rx-00800', at: at(0), actorRole: 'ward-nurse', data: { wardId: 'ward-a1', kind: 'other', priority: 'routine', items: 1 } },
    e(1, 'request-started'), e(2, 'request-checked'), e(3, 'request-on-hold', { reason: 'not-in-stock' }), e(4, 'request-cancelled', { reason: 'no-longer-needed' }),
    e(5, 'step-undone', { step: 'cancelled' }), e(6, 'request-ready'),
  ]).get('rx-00800');
  assert.deepEqual([r.stage, r.held, r.holdReason, r.readyAt], ['checked', true, 'not-in-stock', null]);
});
