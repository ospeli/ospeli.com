// Transfers and vehicles (module transfers): its commands without the screen, every refusal, agent
// proposals, attack tests, the guide and its switch, and each KPI recomputed from the event log
// with hand-checked numbers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Core } from '../../web/app/core/core.js';
import { MemoryAdapter } from '../../web/app/core/db.js';
import { loadSyntheticHospital, generateHospital } from '../../web/app/core/generator.js';
import { runCommand, CommandError, commandByName } from '../../web/app/core/commands.js';
import { validate } from '../../web/app/core/schema.js';
import * as pack from '../../web/app/modules/transfers/commands.js';
import {
  deriveTransfers, deriveFleet, transferWait, onTimePickup, handoverTime, fleetAvailability, p90, shiftAt, ruleDischargeLater, ruleEscortCover, ruleCheckFailed,
  CHECK_ITEMS, nextTransferId,
} from '../../web/app/modules/transfers/logic.js';

const END = '2026-11-06T18:00:00.000Z'; // 14:00 at the example site (UTC-4): the day shift
const MIN = 60e3;
const human = (role) => ({ type: 'human', role });
const agent = (role, name = 'transfer-bot') => ({ type: 'agent', role, agent: name });
const code = (c) => (err) => err instanceof CommandError && err.code === c;
const ALL_ITEMS = CHECK_ITEMS.map((x) => x.id);

// A site whose clock stands still while the example hospital loads, then ticks one second a call;
// advance(m) jumps m minutes.
async function site({ load = true } = {}) {
  let t = Date.parse(END); let ticking = false;
  const core = await Core.open({ adapter: new MemoryAdapter(), clock: () => new Date(ticking ? (t += 1000) : t) });
  if (load) await loadSyntheticHospital(core, { end: END });
  ticking = true;
  const run = (name, input, who) => runCommand(core, name, input, typeof who === 'string' ? human(who) : who);
  return { core, run, advance: (m) => { t += m * MIN; } };
}
const out = (name, value) => assert.deepEqual(validate(commandByName(name).output, value), [], `${name}: answer matches its schema`);
const ASK = { type: 'between-sites', fromPlace: 'ward-a3', toSite: 'site-north', needed: 'asap', mobility: 'wheelchair', escort: 'carer', equipment: ['oxygen'] };
const kpi = (b, id) => b.kpis.find((k) => k.id === id);

test('a journey through the commands: booked by a ward, given to a vehicle, four steps in order, handed over; wait and handover time count it with hand-checked minutes', async () => {
  const { core, run, advance } = await site();
  const b0 = await run('ospeli_transfers_board', {}, 'transport-coordinator');
  out('ospeli_transfers_board', b0);
  assert.ok(kpi(b0, 'transfer-wait').n > 10 && kpi(b0, 'handover-time').n > 10, 'thirty days of history');
  const req = await run('ospeli_transfers_request', ASK, 'ward-nurse');
  out('ospeli_transfers_request', req);
  assert.equal(req.status, 'done');
  assert.match(req.transferId, /^trf-\d{5}$/);
  assert.ok(req.queuePosition >= 1 && req.queuePosition <= req.waiting, 'its place in the queue');
  // A double tap opens one request; a second patient is sent with again: true.
  await assert.rejects(run('ospeli_transfers_request', ASK, 'ward-nurse'), (e) => code('conflict')(e) && e.detail.existing === req.transferId);
  const ev = (await core.events({ subject: req.transferId })).at(-1);
  assert.deepEqual([ev.type, ev.actorRole, ev.data], ['transfers.requested', 'ward-nurse',
    { type: 'between-sites', fromPlace: 'ward-a3', toSite: 'site-north', needed: 'asap', mobility: 'wheelchair', escort: 'carer', equipment: ['oxygen'], bayMove: false }]);
  const entry = (await core.auditLog()).at(-1);
  assert.deepEqual([entry.action, entry.target, entry.actorRole], ['transfers.requested', req.transferId, 'ward-nurse']);

  advance(10);
  await assert.rejects(run('ospeli_transfers_step', { transferId: req.transferId, step: 'arrived-pickup' }, 'driver'), code('conflict'), 'no vehicle yet');
  const as = await run('ospeli_transfers_assign', { transferId: req.transferId, vehicleId: 'asset-vehicle-3', expectedState: 'waiting' }, 'transport-coordinator');
  out('ospeli_transfers_assign', as);
  assert.equal(as.dispatchMinutes, 10);
  const jobs = await run('ospeli_transfers_jobs', { vehicleId: 'asset-vehicle-3' }, 'driver');
  out('ospeli_transfers_jobs', jobs);
  const job = jobs.jobs.find((j) => j.id === req.transferId);
  assert.deepEqual([job.pickup.name, job.destination.name, job.mobilityName, job.escortName, job.equipment[0].name, job.nextStep.id],
    ['Ward A3 (older adults)', 'North clinic', 'Wheelchair', 'Relative or carer', 'Oxygen', 'arrived-pickup']);
  // A step out of order is refused with the next valid step, and nothing is written.
  await assert.rejects(run('ospeli_transfers_step', { transferId: req.transferId, step: 'departed' }, 'driver'), (e) => code('conflict')(e) && e.detail.nextStep === 'arrived-pickup' && /Arrived at pickup/.test(e.message));
  advance(15);
  await run('ospeli_transfers_step', { transferId: req.transferId, step: 'arrived-pickup' }, 'driver');
  // The same tap again (a double tap) is refused: the next step is now "departed".
  await assert.rejects(run('ospeli_transfers_step', { transferId: req.transferId, step: 'arrived-pickup' }, 'driver'), (e) => e.detail?.nextStep === 'departed');
  advance(10);
  await run('ospeli_transfers_step', { transferId: req.transferId, step: 'departed' }, 'driver');
  await assert.rejects(run('ospeli_transfers_cancel', { transferId: req.transferId, reason: 'not-needed' }, 'ward-nurse'), code('conflict'), 'refused once departed');
  advance(30);
  await run('ospeli_transfers_step', { transferId: req.transferId, step: 'arrived-destination' }, 'driver');
  advance(12);
  const done = await run('ospeli_transfers_step', { transferId: req.transferId, step: 'handed-over' }, 'driver');
  out('ospeli_transfers_step', done);
  assert.deepEqual([done.state, done.nextStep], ['handed-over', null]);
  const steps = (await core.events({ subject: req.transferId })).map((e) => [e.type, e.actorRole]);
  assert.deepEqual(steps.slice(1), [['transfers.assigned', 'transport-coordinator'], ['transfers.arrived-pickup', 'driver'], ['transfers.departed', 'driver'], ['transfers.arrived-destination', 'driver'], ['transfers.handed-over', 'driver']]);
  const b1 = await run('ospeli_transfers_board', {}, 'transport-coordinator');
  // The measures count it: from the end of the example history to now, it is the only journey.
  const all = deriveTransfers(await core.events());
  const sinceEnd = { since: END, until: b1.asOf };
  assert.deepEqual([transferWait(all, sinceEnd).n, Math.round(transferWait(all, sinceEnd).value)], [1, 35]);
  assert.deepEqual([handoverTime(all, sinceEnd).n, Math.round(handoverTime(all, sinceEnd).value)], [1, 12]);
  const mine = all.get(req.transferId);
  // Asked at T, departed at T+35 min (plus a few one-second clock ticks); handed over 12 min after arriving.
  assert.equal(Math.round((Date.parse(mine.steps.departed) - Date.parse(mine.requestedAt)) / MIN), 35);
  assert.equal(Math.round((Date.parse(mine.steps['handed-over']) - Date.parse(mine.steps['arrived-destination'])) / MIN), 12);
  assert.equal(b1.vehicles.find((v) => v.id === 'asset-vehicle-3').state, 'free', 'the handover frees the vehicle');
});

test('refused by role: delay is the coordinator\'s alone (a requesting role is refused); a ward cannot give a vehicle or tap a step; the guide switch is not the driver\'s', async () => {
  const { core, run } = await site();
  const { transferId } = await run('ospeli_transfers_request', ASK, 'ward-nurse');
  const n = await core.eventCount();
  for (const role of ['ward-nurse', 'ae-nic', 'bed-manager', 'driver', 'fleet-supervisor']) {
    await assert.rejects(run('ospeli_transfers_delay', { transferId, reason: 'no-escort' }, role), (e) => code('forbidden')(e) && e.detail.roles.join() === 'transport-coordinator', `${role} cannot mark a delay`);
  }
  await assert.rejects(run('ospeli_transfers_assign', { transferId, vehicleId: 'asset-vehicle-3' }, 'ward-nurse'), code('forbidden'));
  await assert.rejects(run('ospeli_transfers_assign', { transferId, vehicleId: 'asset-vehicle-3' }, 'driver'), code('forbidden'), 'a driver does not pick their own jobs');
  await assert.rejects(run('ospeli_transfers_request', ASK, 'driver'), code('forbidden'));
  await assert.rejects(run('ospeli_transfers_request', ASK, 'coo'), code('forbidden'));
  await assert.rejects(run('ospeli_transfers_guide_set', { on: false }, 'driver'), code('forbidden'));
  await assert.rejects(run('ospeli_transfers_vehicle_status', { vehicleId: 'asset-vehicle-3', status: 'off-road', reason: 'fault' }, 'driver'), code('forbidden'));
  await assert.rejects(run('ospeli_transfers_vehicle_check', { vehicleId: 'asset-vehicle-3', passed: ALL_ITEMS }, 'ward-nurse'), code('forbidden'));
  assert.equal(await core.eventCount(), n, 'nothing written by the refused calls');
  const d = await run('ospeli_transfers_delay', { transferId, reason: 'no-escort' }, 'transport-coordinator');
  out('ospeli_transfers_delay', d);
  assert.equal(d.delays, 1);
  await assert.rejects(run('ospeli_transfers_delay', { transferId, reason: 'no-escort' }, 'transport-coordinator'), code('conflict'), 'the same delay twice in a row is saved once');
  // The ward that asked can cancel before departure, with a picked reason.
  out('ospeli_transfers_cancel', await run('ospeli_transfers_cancel', { transferId, reason: 'patient-not-ready' }, 'ward-nurse'));
  assert.equal(deriveTransfers(await core.events()).get(transferId).state, 'cancelled');
});

test('attack: picks only; a typed field, an unknown key, a name in a value, a made-up id or a wrong shape is refused before anything is written, and made-up ids are not echoed', async () => {
  const { core, run } = await site();
  const nurse = (input) => run('ospeli_transfers_request', input, 'ward-nurse');
  const n = await core.eventCount();
  await assert.rejects(nurse({ ...ASK, note: 'Mrs Example, call 555 0100' }), code('invalid-input'), 'no field takes free text');
  await assert.rejects(nurse({ ...ASK, patientName: 'Jane Doe' }), code('invalid-input'));
  await assert.rejects(nurse({ ...ASK, mobility: 'Jane Doe' }), code('invalid-input'), 'mobility is a pick');
  await assert.rejects(nurse({ ...ASK, equipment: ['oxygen', 'Mr Smith'] }), code('invalid-input'));
  await assert.rejects(nurse({ ...ASK, equipment: [] }), code('invalid-input'), 'equipment is answered, "none" included: no answer is chosen in advance');
  await assert.rejects(nurse({ ...ASK, equipment: ['none', 'oxygen'] }), code('invalid-input'));
  await assert.rejects(nurse({ ...ASK, toOutside: 'home' }), code('invalid-input'), 'one destination only');
  await assert.rejects(nurse({ ...ASK, toSite: 'site-main' }), code('invalid-input'), 'the same site is a move on foot, not a vehicle journey');
  await assert.rejects(nurse({ ...ASK, needed: 'booked' }), code('invalid-input'), 'a booked journey needs its time');
  await assert.rejects(nurse({ ...ASK, needed: 'booked', bookedFor: '2026-12-30T10:00:00.000Z' }), code('invalid-input'), 'at most seven days ahead');
  await assert.rejects(nurse({ ...ASK, fromPlace: 'ward-a1-bed-04' }), code('not-found'), 'from a ward or department, not a bed');
  await assert.rejects(nurse({ ...ASK, fromPlace: 'ward-<script>' }), code('invalid-input'));
  const made = await nurse({ ...ASK, fromPlace: 'ward-zz9' }).catch((e) => e);
  assert.ok(code('not-found')(made) && !made.message.includes('ward-zz9'), 'a made-up id is not echoed back');
  const t = await run('ospeli_transfers_assign', { transferId: 'trf-99999', vehicleId: 'asset-vehicle-1' }, 'transport-coordinator').catch((e) => e);
  assert.ok(code('not-found')(t) && !t.message.includes('99999'));
  const v = await run('ospeli_transfers_vehicle_check', { vehicleId: 'asset-made-up', passed: ALL_ITEMS }, 'driver').catch((e) => e);
  assert.ok(code('not-found')(v) && !v.message.includes('made-up'));
  await assert.rejects(run('ospeli_transfers_assign', { transferId: 'trf-1; DROP', vehicleId: 'asset-vehicle-1' }, 'transport-coordinator'), code('invalid-input'));
  await assert.rejects(run('ospeli_transfers_step', { transferId: 'trf-00001', step: 'teleported' }, 'driver'), code('invalid-input'));
  await assert.rejects(run('ospeli_transfers_delay', { transferId: 'trf-00001', reason: 'driver was slow' }, 'transport-coordinator'), code('invalid-input'), 'a reason is a pick');
  await assert.rejects(run('ospeli_transfers_vehicle_status', { vehicleId: 'asset-vehicle-1', status: 'off-road', reason: 'repaired' }, 'fleet-supervisor'), code('invalid-input'), 'a "back" reason does not take a vehicle off the road');
  await assert.rejects(run('ospeli_transfers_vehicle_check', { vehicleId: 'asset-vehicle-1', passed: ['tyres'] }, 'driver'), code('invalid-input'), 'a daily check marks every item');
  await assert.rejects(run('ospeli_transfers_vehicle_check', { vehicleId: 'asset-vehicle-1', passed: ALL_ITEMS, failed: ['tyres'] }, 'driver'), code('invalid-input'));
  await assert.rejects(run('ospeli_transfers_board', { days: 99 }, 'driver'), code('invalid-input'));
  assert.equal(await core.eventCount(), n, 'nothing was written');
  // No command of this module takes typed text at all.
  for (const c of pack.COMMANDS) for (const [k, s] of Object.entries(c.input.properties || {})) if (s.type === 'string') assert.ok(s.enum || s.pattern || s.format, `${c.name}.${k} is a pick, an id or a time`);
});

test('agents: a write becomes a proposal and changes nothing until a person in an allowed role accepts; reads see only the agent\'s wards; the guide switch is people only', async () => {
  const { core, run } = await site();
  await run('ospeli_agents_set_access', { allowed: true, wards: { 'ward-a3': true, 'ward-b1': true } }, 'coo');
  await run('ospeli_agents_add', { name: 'transfer-bot', role: 'transport-coordinator', wards: ['ward-a3'], days: 30 }, 'coo');
  const bot = agent('transport-coordinator');
  const n = await core.eventCount();
  const p = await run('ospeli_transfers_request', ASK, bot);
  assert.equal(p.status, 'proposed');
  assert.equal(await core.eventCount(), n, 'nothing changed');
  await assert.rejects(run('ospeli_transfers_request', { ...ASK, fromPlace: 'ward-b1' }, bot), code('forbidden'), 'not its ward');
  await assert.rejects(run('ospeli_transfers_guide_set', { on: false }, bot), code('forbidden'), 'people only');
  const seen = await run('ospeli_transfers_board', {}, bot);
  assert.ok([...seen.waiting, ...seen.open].every((t) => t.pickup.id === 'ward-a3'), 'only journeys from its own ward');
  await assert.rejects(run('ospeli_proposals_accept', { id: p.proposal.id }, 'driver'), code('forbidden'), 'a role that cannot book cannot accept a booking');
  const acc = await run('ospeli_proposals_accept', { id: p.proposal.id }, 'ward-nurse');
  assert.equal(acc.status, 'accepted');
  const ev = (await core.events({ type: 'transfers.requested' })).at(-1);
  assert.deepEqual([ev.actorRole, ev.data.fromPlace], ['ward-nurse', 'ward-a3']);
  const entry = (await core.auditLog()).filter((a) => a.action === 'transfers.requested').at(-1);
  assert.deepEqual([entry.actorType, entry.actorRole], ['human', 'ward-nurse'], 'recorded as done by the person who accepted');
  // An agent's assignment waits too, and one open proposal per transfer.
  const a1 = await run('ospeli_transfers_assign', { transferId: ev.subject, vehicleId: 'asset-vehicle-3' }, bot);
  assert.equal(a1.status, 'proposed');
  await assert.rejects(run('ospeli_transfers_assign', { transferId: ev.subject, vehicleId: 'asset-vehicle-1' }, bot), code('conflict'));
  assert.equal(deriveTransfers(await core.events()).get(ev.subject).state, 'waiting');
});

test('crewing: a driver\'s vehicle pick writes one crewing event for the shift (role only); a second pick is told it is crewed; release ends it; an off-road vehicle cannot be crewed or given a job', async () => {
  const { core, run } = await site();
  const b = await run('ospeli_transfers_board', { format: 'short' }, 'driver');
  assert.equal(b.shift.id, 'shift-day');
  assert.deepEqual(b.vehicles.map((v) => [v.id, v.crewed]), [['asset-vehicle-1', true], ['asset-vehicle-2', false], ['asset-vehicle-3', true]]);
  const c = await run('ospeli_transfers_vehicle_crew', { vehicleId: 'asset-vehicle-2', crewed: true }, 'driver');
  out('ospeli_transfers_vehicle_crew', c);
  const ev = (await core.events({ subject: 'asset-vehicle-2' })).at(-1);
  assert.deepEqual([ev.type, ev.actorRole, ev.data.shift, ev.data.shiftStart], ['transfers.vehicle-crewed', 'driver', 'shift-day', '2026-11-06T11:00:00.000Z']);
  assert.deepEqual(Object.keys(ev.data).sort(), ['shift', 'shiftEnd', 'shiftStart'], 'vehicle, shift and role: never who');
  await assert.rejects(run('ospeli_transfers_vehicle_crew', { vehicleId: 'asset-vehicle-2', crewed: true }, 'driver'), (e) => code('conflict')(e) && e.detail.alreadyCrewed);
  await run('ospeli_transfers_vehicle_crew', { vehicleId: 'asset-vehicle-2', crewed: false }, 'driver');
  assert.equal((await run('ospeli_transfers_jobs', { vehicleId: 'asset-vehicle-2' }, 'driver')).vehicle.crewed, false);
  await assert.rejects(run('ospeli_transfers_vehicle_crew', { vehicleId: 'asset-vehicle-2', crewed: false }, 'driver'), code('conflict'));
  out('ospeli_transfers_vehicle_status', await run('ospeli_transfers_vehicle_status', { vehicleId: 'asset-vehicle-2', status: 'off-road', reason: 'fault' }, 'fleet-supervisor'));
  await assert.rejects(run('ospeli_transfers_vehicle_crew', { vehicleId: 'asset-vehicle-2', crewed: true }, 'driver'), code('conflict'));
  const { transferId } = await run('ospeli_transfers_request', ASK, 'ward-nurse');
  await assert.rejects(run('ospeli_transfers_assign', { transferId, vehicleId: 'asset-vehicle-2' }, 'transport-coordinator'), code('conflict'));
  // Its journey already given to it shows the vehicle off the road, so it can be given to another.
  const job = (await run('ospeli_transfers_board', {}, 'transport-coordinator')).open.find((t) => t.vehicleId === 'asset-vehicle-2');
  assert.equal(job.vehicleOffRoad, true);
  await run('ospeli_transfers_assign', { transferId: job.id, vehicleId: 'asset-vehicle-3' }, 'transport-coordinator');
  await run('ospeli_transfers_vehicle_status', { vehicleId: 'asset-vehicle-2', status: 'back', reason: 'repaired' }, 'transport-coordinator');
  await assert.rejects(run('ospeli_transfers_vehicle_status', { vehicleId: 'asset-vehicle-2', status: 'back', reason: 'repaired' }, 'fleet-supervisor'), code('conflict'));
});

test('guide rule 2 on the real fleet: a failed check suggests taking the vehicle off the road and a prefilled fault report a person sends (priority picked, none in advance); the driver may send it', async () => {
  const { run } = await site();
  const failed = ALL_ITEMS.filter((x) => x !== 'tyres');
  out('ospeli_transfers_vehicle_check', await run('ospeli_transfers_vehicle_check', { vehicleId: 'asset-vehicle-3', passed: failed, failed: ['tyres'] }, 'driver'));
  const s = (await run('ospeli_transfers_board', {}, 'fleet-supervisor')).guide.suggestions.find((x) => x.rule === 'check-failed');
  assert.match(s.text, /^Vehicle 3 failed its daily check: Tyres and wheels\. Take it off the road/);
  assert.deepEqual(s.actions.map((a) => a.command), ['ospeli_transfers_vehicle_status', 'ospeli_workorders_report_fault']);
  const report = s.actions[1];
  assert.deepEqual(report.input, { assetId: 'asset-vehicle-3', fault: 'Tyre or wheel damage' }, 'no priority chosen in advance');
  assert.equal(report.needs, 'priority');
  assert.match(s.basis, /vehicle check policy \(set locally\)/);
  const wo = await run('ospeli_workorders_report_fault', { ...report.input, priority: 'high' }, 'driver');
  assert.equal(wo.status, 'done');
  await run(s.actions[0].command, s.actions[0].input, 'fleet-supervisor');
  const after = (await run('ospeli_transfers_board', {}, 'fleet-supervisor')).guide.suggestions.filter((x) => x.rule === 'check-failed');
  assert.equal(after.length, 0, 'taken off the road: the suggestion goes');
  // Before it is taken off the road, an open work order for the same fault means no second report is offered.
  const r = ruleCheckFailed({ fleet: new Map([['v', { id: 'v', name: 'Vehicle 9', offRoad: null, lastStatusAt: null, lastCheck: { at: END, passed: [], failed: ['lift'] } }]]), openFaults: new Map([['v', ['Patient lift or ramp not working']]]) });
  assert.deepEqual(r[0].actions.map((a) => a.label), ['Take off the road']);
  assert.match(r[0].why, /already open: Patient lift or ramp not working/);
});

test('the guide switch: off means no suggestions and everything else the same; people only; refused when already in that state', async () => {
  const { run } = await site();
  const on = await run('ospeli_transfers_board', {}, 'transport-coordinator');
  assert.equal(on.guide.on, true);
  assert.deepEqual(on.guide.suggestions.map((s) => s.rule).sort(), ['discharge-later', 'escort-cover'], 'the example hospital gives the guide something to say');
  await assert.rejects(run('ospeli_transfers_guide_set', { on: true }, 'transport-coordinator'), code('conflict'));
  out('ospeli_transfers_guide_set', await run('ospeli_transfers_guide_set', { on: false }, 'fleet-supervisor'));
  const off = await run('ospeli_transfers_board', {}, 'transport-coordinator');
  assert.deepEqual([off.guide.on, off.guide.suggestions], [false, []]);
  assert.deepEqual(off.kpis.map((k) => [k.id, k.n]), on.kpis.map((k) => [k.id, k.n]), 'the measures are the same with the guide off');
  assert.deepEqual(off.waiting.map((t) => t.id), on.waiting.map((t) => t.id));
  const { transferId } = await run('ospeli_transfers_request', ASK, 'ward-nurse');
  await run('ospeli_transfers_assign', { transferId, vehicleId: 'asset-vehicle-3' }, 'transport-coordinator');
  await run('ospeli_transfers_step', { transferId, step: 'arrived-pickup' }, 'driver');
  await run('ospeli_transfers_guide_set', { on: true }, 'transport-coordinator');
});

test('the example board: the queue in the order journeys are needed, a booked discharge from a ward with bed demand, vehicles free, on a job and crewed', async () => {
  const { run } = await site();
  const b = await run('ospeli_transfers_board', {}, 'transport-coordinator');
  assert.ok(b.waiting.length >= 4);
  const need = (t) => (t.needed === 'booked' ? t.bookedFor : t.requestedAt);
  assert.deepEqual(b.waiting.map(need), [...b.waiting.map(need)].sort(), 'earliest needed first');
  assert.deepEqual(b.vehicles.map((v) => v.state), ['on-job', 'free', 'free']);
  const s = b.guide.suggestions.find((x) => x.rule === 'discharge-later');
  assert.match(s.text, /^Discharge from Ward A1 \(acute medicine\) is booked for today 18:00, while \d patients? waits? for a bed there\./);
  assert.match(s.why, /Vehicle 3 is free and crewed now/);
  const e = b.guide.suggestions.find((x) => x.rule === 'escort-cover');
  assert.match(e.text, /^Review escort cover from 15:00 to 19:00: 4 journeys/);
  assert.ok(e.pattern.byHour.length && e.pattern.byDay.length);
  assert.match(b.note, /never a driver or a crew/);
  assert.deepEqual(b.planned.map((p) => [p.id, p.note]), [['servicing-plan', 'Planned, not built yet.']]);
  assert.ok(b.slots.length === 48 && b.slots[0].label === 'Today 14:30', `bookable times every half hour (${b.slots[0]?.label})`);
});

// ---- the KPIs, recomputed from hand-made event logs ----
const at = (hm, day = '06') => `2026-11-${day}T${hm}:00.000Z`;
const e = (type, subject, t, data = null, actorRole = 'driver') => ({ type, subject, actorRole, at: t, data });
const ask = (id, t, { needed = 'asap', bookedFor, type = 'discharge' } = {}) => e('transfers.requested', id, t, { type, fromPlace: 'ward-a1', toOutside: 'home', needed, ...(bookedFor ? { bookedFor } : {}), mobility: 'walks', escort: 'none', equipment: ['none'] }, 'ward-nurse');
const go = (id, times, v = 'v1') => [e('transfers.assigned', id, times[0], { vehicle: v }, 'transport-coordinator'),
  ...['arrived-pickup', 'departed', 'arrived-destination', 'handed-over'].slice(0, times.length - 1).map((s, i) => e(`transfers.${s}`, id, times[i + 1], { vehicle: v }))];
const PERIOD = { since: at('08:00'), until: at('20:00') };

test('KPI transfer wait, hand-checked: as-soon-as-possible journeys 30, 50, 10 and 90 min give a median of 40 and a p90 of 90; booked, cancelled, earlier and not departed left out', () => {
  const ev = [
    ask('trf-00001', at('09:00')), ...go('trf-00001', [at('09:05'), at('09:20'), at('09:30')]), // 30
    ask('trf-00002', at('10:00')), ...go('trf-00002', [at('10:05'), at('10:40'), at('10:50')]), // 50
    ask('trf-00003', at('11:00', '06'), { type: 'between-sites' }), ...go('trf-00003', [at('11:02'), at('11:05'), at('11:10')]), // 10
    ask('trf-00004', at('12:00')), ...go('trf-00004', [at('12:10'), at('13:00'), at('13:30')]), // 90
    ask('trf-00005', at('06:00')), ...go('trf-00005', [at('06:10'), at('07:00'), at('07:30')]), // departed before the period
    ask('trf-00006', at('09:00'), { needed: 'booked', bookedFor: at('15:00') }), ...go('trf-00006', [at('14:00'), at('14:40'), at('14:55')]), // booked: not here
    ask('trf-00007', at('09:00')), e('transfers.cancelled', 'trf-00007', at('09:30'), { reason: 'not-needed' }, 'ward-nurse'),
    ask('trf-00008', at('13:00')), ...go('trf-00008', [at('13:10'), at('13:40')]), // at pickup, not departed
  ];
  const w = transferWait(deriveTransfers(ev), PERIOD);
  assert.deepEqual([w.value, w.p90, w.n], [40, 90, 4]);
  const by = Object.fromEntries(w.breakdown.map((b) => [b.id, [b.value, b.n]]));
  assert.deepEqual([by.discharge, by['between-sites']], [[50, 3], [10, 1]]);
  assert.equal(p90([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), 9, 'nearest rank: rank 9 of 10');
  assert.equal(p90([]), null);
});

test('KPI on-time pickup, hand-checked: 2 on time of 4 due is 50%; a requester\'s delay left out; a transport delay and a late departure count as not on time; an open window is pending', () => {
  const b = (id, booked) => ask(id, at('08:00'), { needed: 'booked', bookedFor: at(booked) });
  const ev = [
    b('trf-00001', '10:00'), ...go('trf-00001', [at('09:00'), at('09:50'), at('10:10')]), // departed 10 min after: on time
    b('trf-00002', '11:00'), ...go('trf-00002', [at('10:00'), at('10:40'), at('10:55')]), // early: on time
    b('trf-00003', '12:00'), ...go('trf-00003', [at('11:00'), at('12:10'), at('12:20')]), // 20 min after: late
    b('trf-00004', '13:00'), e('transfers.delayed', 'trf-00004', at('12:30'), { reason: 'no-vehicle' }, 'transport-coordinator'), ...go('trf-00004', [at('12:40'), at('12:50'), at('13:05')]), // transport delay: not on time
    b('trf-00005', '14:00'), e('transfers.delayed', 'trf-00005', at('13:30'), { reason: 'patient-not-ready' }, 'transport-coordinator'), // requester's side: left out
    b('trf-00006', '19:55'), // still waiting, window open at 20:00: pending
    b('trf-00007', '21:00'), // due after the period
    b('trf-00008', '15:00'), e('transfers.cancelled', 'trf-00008', at('14:00'), { reason: 'not-needed' }, 'ward-nurse'), // requester: left out
  ];
  const o = onTimePickup(deriveTransfers(ev), PERIOD);
  assert.deepEqual([o.value, o.numerator, o.denominator, o.leftOut, o.pending, o.transportSide], [50, 2, 4, 2, 1, 1]);
  // Once the window has closed with no departure, the open one is late.
  assert.deepEqual([onTimePickup(deriveTransfers(ev), { since: PERIOD.since, until: at('20:15') }).denominator], [5]);
});

test('KPI handover time, hand-checked: 5, 15 and 40 min give a median of 15 and a p90 of 40; not handed over left out', () => {
  const ev = [
    ask('trf-00001', at('09:00')), ...go('trf-00001', [at('09:01'), at('09:10'), at('09:20'), at('10:00'), at('10:05')]),
    ask('trf-00002', at('09:00')), ...go('trf-00002', [at('09:01'), at('09:10'), at('09:20'), at('10:00'), at('10:15')]),
    ask('trf-00003', at('09:00')), ...go('trf-00003', [at('09:01'), at('09:10'), at('09:20'), at('10:00'), at('10:40')]),
    ask('trf-00004', at('09:00')), ...go('trf-00004', [at('09:01'), at('09:10'), at('09:20'), at('10:00')]),
  ];
  const h = handoverTime(deriveTransfers(ev), PERIOD);
  assert.deepEqual([h.value, h.p90, h.n], [15, 40, 3]);
});

test('KPI fleet availability, hand-checked: two vehicles, one day, one off the road 3 hours in scheduled time: 21 of 24 vehicle-hours is 87.5%; crewed hours apart', () => {
  // Site time = UTC here (offset 0). Scheduled 07:00 to 19:00: 12 h each.
  const ev = [
    e('transfers.vehicle-off-road', 'v2', at('05:00'), { reason: 'fault' }, 'fleet-supervisor'), e('transfers.vehicle-back', 'v2', at('10:00'), { reason: 'repaired' }, 'fleet-supervisor'), // 3 h inside 07-19
    e('transfers.vehicle-crewed', 'v1', at('07:00'), { shift: 'shift-day', shiftStart: at('07:00'), shiftEnd: at('19:00') }),
    e('transfers.vehicle-uncrewed', 'v1', at('15:00'), { shift: 'shift-day', shiftStart: at('07:00') }), // 8 h crewed
  ];
  const fleet = deriveFleet(ev, [{ id: 'v1', name: 'V1', parentId: 's1' }, { id: 'v2', name: 'V2', parentId: 's2' }], { now: at('23:00'), shift: null });
  const f = fleetAvailability(fleet, { since: at('00:00'), until: at('23:59'), offsetMinutes: 0 });
  assert.deepEqual([f.value, f.numerator, f.denominator, f.crewedHours], [87.5, 21, 24, 8]);
  assert.deepEqual(f.breakdown.map((b) => [b.id, b.value]), [['s1', 100], ['s2', 75]]);
  // Still off the road at the end: counted up to the end of the period.
  const still = deriveFleet([e('transfers.vehicle-off-road', 'v1', at('13:00'), { reason: 'service' }, 'fleet-supervisor')], [{ id: 'v1', name: 'V1', parentId: 's1' }], { now: at('23:00'), shift: null });
  assert.equal(fleetAvailability(still, { since: at('00:00'), until: at('23:59') }).value, 50);
});

test('guide rules from hand-made logs: a discharge booked late while beds are needed, with a journey to group; no-escort delays in one band with the pattern; quiet when below the levels', () => {
  const ev = [ask('trf-00001', at('09:00'), { needed: 'booked', bookedFor: at('13:00') }), ask('trf-00002', at('09:30'), { needed: 'booked', bookedFor: at('13:30') }),
    ask('trf-00003', at('09:30'), { needed: 'booked', bookedFor: at('10:30') })];
  const tr = deriveTransfers(ev);
  const args = { transfers: tr, now: at('10:00'), offsetMinutes: 0, placeName: () => 'Ward A1', destName: () => 'Home', freeVehicles: [] };
  const s = ruleDischargeLater({ ...args, waitingByWard: new Map([['ward-a1', 2]]) });
  assert.deepEqual(s.map((x) => x.transferId), ['trf-00001', 'trf-00002'], 'the one booked within the hour is left alone');
  assert.match(s[0].why, /No crewed vehicle is free.*trf-00002 also goes to Home near that time/);
  assert.deepEqual(ruleDischargeLater({ ...args, waitingByWard: new Map() }), [], 'no bed demand: nothing to say');
  const delays = (n, hm) => Array.from({ length: n }, (_, i) => [ask(`trf-1000${i}`, at(hm, String(1 + i).padStart(2, '0'))), e('transfers.delayed', `trf-1000${i}`, at(hm, String(1 + i).padStart(2, '0')), { reason: 'no-escort' }, 'transport-coordinator')]).flat();
  const r = ruleEscortCover({ transfers: deriveTransfers(delays(3, '16:00')), now: at('12:00', '10'), offsetMinutes: 0 });
  assert.equal(r.length, 1);
  assert.match(r[0].text, /from 15:00 to 19:00: 3 journeys/);
  assert.deepEqual(r[0].pattern.byHour, [{ hour: '16:00', n: 3 }]);
  assert.doesNotMatch(r[0].why + r[0].text, /driver|crew member/i);
  assert.deepEqual(ruleEscortCover({ transfers: deriveTransfers(delays(2, '16:00')), now: at('12:00', '10'), offsetMinutes: 0 }), []);
  assert.deepEqual(ruleEscortCover({ transfers: deriveTransfers(delays(3, '16:00')), now: at('12:00', '30'), offsetMinutes: 0 }), [], 'older than 14 days');
});

test('site time and shifts: 14:00 at UTC-4 is in the day shift that started at 07:00; 02:00 is in the night shift that started the evening before', () => {
  assert.deepEqual(shiftAt('2026-11-06T18:00:00.000Z', -240), { id: 'shift-day', name: 'Day shift', start: '2026-11-06T11:00:00.000Z', end: '2026-11-06T23:00:00.000Z' });
  assert.deepEqual(shiftAt('2026-11-07T06:00:00.000Z', -240), { id: 'shift-night', name: 'Night shift', start: '2026-11-06T23:00:00.000Z', end: '2026-11-07T11:00:00.000Z' });
  assert.equal(nextTransferId([{ type: 'transfers.requested', subject: 'trf-00041' }]), 'trf-00042');
});

test('synthetic history: valid ids in time order, steps in order, nothing after the end, role only, vehicle 2 off the road two days after a failed check', () => {
  const { events } = generateHospital({ end: END });
  const mine = events.filter((x) => x.type.startsWith('transfers.'));
  assert.ok(mine.length > 1000);
  assert.ok(mine.every((x) => x.at <= END));
  const tr = deriveTransfers(mine);
  const raw = mine.filter((x) => x.type === 'transfers.requested');
  assert.equal(tr.size, raw.length, 'every request is valid');
  const steps = mine.filter((x) => /arrived|departed|handed/.test(x.type)).length;
  assert.equal([...tr.values()].reduce((s, t) => s + Object.keys(t.steps).length, 0), steps, 'every step was taken in its order');
  for (const x of mine) for (const k of Object.keys(x.data || {})) assert.doesNotMatch(k, /name|phone|email|staff|address|person|driver/i);
  const off = mine.filter((x) => x.subject === 'asset-vehicle-2' && /off-road|back|checked/.test(x.type) && x.data?.failed?.length !== 0);
  assert.ok(off.some((x) => x.type === 'transfers.vehicle-off-road') && off.some((x) => x.type === 'transfers.vehicle-back'));
  const fails = mine.filter((x) => x.type === 'transfers.vehicle-checked' && x.data.failed.length);
  assert.deepEqual(fails.map((x) => [x.subject, x.data.failed]), [['asset-vehicle-2', ['tyres']]]);
  assert.ok([...tr.values()].filter((t) => t.state === 'waiting').length >= 4, 'a real queue at the end');
});

test('an older example hospital with no vehicles and no journeys: honest empty answers, no error; booking still works', async () => {
  const { core, run } = await site({ load: false });
  const { entities, events } = generateHospital({ end: END });
  await core.putEntities(entities.filter((x) => x.kind !== 'vehicle'), 'system');
  await core.appendEvents(events.filter((x) => !x.type.startsWith('transfers.')), 'system');
  const b = await run('ospeli_transfers_board', {}, 'transport-coordinator');
  out('ospeli_transfers_board', b);
  assert.deepEqual([b.vehicles, b.waiting, b.open, b.guide.suggestions], [[], [], [], []]);
  assert.deepEqual(b.kpis.map((k) => [k.id, k.value, k.n]), [['transfer-wait', null, 0], ['on-time-pickup', null, 0], ['handover-time', null, 0], ['fleet-availability', null, 0]]);
  await assert.rejects(run('ospeli_transfers_jobs', { vehicleId: 'asset-vehicle-1' }, 'driver'), code('not-found'));
  assert.equal((await run('ospeli_transfers_request', ASK, 'ward-nurse')).transferId, 'trf-00001');
});

test('every KPI in the pack has a definition, what it leaves out, a source and a target that says when it is an example setting', () => {
  for (const k of pack.KPIS) {
    for (const f of ['definition', 'counts', 'outOf', 'leavesOut', 'source', 'targetText']) assert.ok(k[f]?.length > 5, `${k.id}: ${f}`);
    assert.match(k.source, /^local definition/);
  }
  assert.match(pack.KPIS.find((k) => k.id === 'on-time-pickup').counts, /example setting, not a standard/);
  assert.match(pack.KPIS.find((k) => k.id === 'fleet-availability').definition, /example setting, not a standard/);
});
