// Now's flow strip says only what its numbers hold (ospeli/ospeli#183; decision record
// docs/decisions/2026-11-25-now-flow-strip.md in the planning repo). Pure counting and wording,
// fed with made-up read-command answers for the synthetic example hospital.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flowCounts, flowHeadline, wardBedCounts, orderNeeds } from '../../web/app/modules/home.js';
import { departmentById, DEPARTMENTS } from '../../web/app/modules/departments.js';

const AS_OF = '2026-11-17T14:20:00.000Z';
const ago = (min) => new Date(Date.parse(AS_OF) - min * 60000).toISOString();
// A stand-in for ctx.run: answers by command name; anything else is refused, as a missing module would be.
const runner = (answers) => async (name) => { if (!(name in answers)) throw new Error(`no ${name}`); return structuredClone(answers[name]); };
const ward = (id, occupied, expected) => ({ id, name: id, counts: { occupied, 'expected-discharge': expected, available: 2 } });

const wardsAnswers = (over = {}) => ({
  ospeli_beds_board: { asOf: AS_OF, wards: [ward('ward-a1', 20, 4), ward('ward-b2', 32, 5)], beds: [], waiting: [
    { encounter: 'enc-000101', wardId: null, decisionAt: ago(370), requestedAt: ago(365) },
    { encounter: 'enc-000102', wardId: null, decisionAt: ago(30), requestedAt: ago(30) }] },
  ospeli_transfers_board: { asOf: AS_OF, waiting: [{ id: 'trf-1', pickup: { id: 'ward-a1' }, waitMinutes: 47 }] },
  ...over,
});

test('(a) Wards: one bed wait of 6 h 10 min and one vehicle wait of 47 min: the headline is the bed wait, never 47 min', async () => {
  const dept = departmentById('wards');
  const flow = await flowCounts(runner(wardsAnswers()), dept);
  const line = flowHeadline(dept, flow);
  assert.equal(line.text, 'Longest wait now: 6 h 10 min for a bed (1 patient)');
  assert.doesNotMatch(line.text, /47 min/);
  assert.deepEqual(flow.wait.between, ['arrive', 'stay'], 'the mango bar sits before Stay, where the bed wait is');
  assert.equal(line.leftOut, '');
  assert.equal(line.also, '', 'the headline is already a patient\'s wait, and no vehicle wait is longer');
});

// Crew night 5 item 2 changed this rule: a patient's wait heads the strip whenever one is timed, and
// a longer vehicle wait is named under it, with its unit (it was the other way round on night 4).
test('(a) a longer vehicle wait is named under the patient\'s wait, with its unit; equal waits go to the patient waiting for a bed', async () => {
  const dept = departmentById('wards');
  let flow = await flowCounts(runner(wardsAnswers({ ospeli_transfers_board: { asOf: AS_OF, waiting: [{ id: 'trf-1', pickup: { id: 'ward-a1' }, waitMinutes: 400 }] } })), dept);
  assert.equal(flowHeadline(dept, flow).text, 'Longest wait now: 6 h 10 min for a bed (1 patient)');
  assert.equal(flowHeadline(dept, flow).also, 'A vehicle wait is longer: 6 h 40 min (1 journey).', 'the vehicle\'s wait is still named, with its unit');
  flow = await flowCounts(runner(wardsAnswers({ ospeli_transfers_board: { asOf: AS_OF, waiting: [{ id: 'trf-1', pickup: { id: 'ward-a1' }, waitMinutes: 370 }] } })), dept);
  assert.equal(flowHeadline(dept, flow).text, 'Longest wait now: 6 h 10 min for a bed (1 patient)');
});

test('(a) a wait with no start time turns the headline into "Longest timed wait" and says what is not timed', async () => {
  const dept = departmentById('wards');
  const flow = await flowCounts(runner(wardsAnswers({ ospeli_transfers_board: { asOf: AS_OF, waiting: [{ id: 'trf-1', pickup: { id: 'ward-a1' }, waitMinutes: 47 }, { id: 'trf-2', pickup: { id: 'ward-b2' }, waitMinutes: null }] } })), dept);
  const line = flowHeadline(dept, flow);
  assert.equal(line.text, 'Longest timed wait: 6 h 10 min for a bed (1 patient)');
  assert.equal(line.leftOut, 'Not timed: 1 journey waiting for a vehicle.');
});

test('(a) stages that are not counted or planned are named, and the headline never says "Longest wait now" over a part', async () => {
  const imaging = departmentById('imaging');
  const flow = await flowCounts(runner({
    ospeli_tasks_list: { asOf: AS_OF, tasks: [{ id: 't1', toLocationId: 'dept-imaging', locationId: 'ward-a1', waitMinutes: 12 }, { id: 't2', locationId: 'dept-imaging', toLocationId: 'ward-a1', waitMinutes: 25 }] },
    ospeli_transfers_board: { asOf: AS_OF, waiting: [{ id: 'trf-9', pickup: { id: 'dept-imaging' }, waitMinutes: 47 }] },
  }), imaging);
  const line = flowHeadline(imaging, flow);
  assert.equal(line.text, 'Longest timed wait: 25 min to be moved out (1 patient)', 'night 5 item 2: the patient\'s wait heads the strip');
  assert.equal(line.also, 'A vehicle wait is longer: 47 min (1 journey).');
  assert.equal(line.leftOut, 'Prep and Scan are not counted yet.');
  assert.equal(flow.counts.leave.n, 2, 'Leave: one move out and one journey, one patient each');
  // Outpatients: Leave has no count.
  const op = departmentById('outpatients');
  // Night 5 item 3: each waiting patient is read from the clinic's queue, timed from the later of arrival and booked time.
  const day = { asOf: AS_OF, date: '2026-11-17', clinics: [{ sessionId: 'ses-1', date: '2026-11-17', counts: { toCome: 4, waiting: 2, withClinician: 1, longestWaitMinutes: 33 } }] };
  const queue = { asOf: AS_OF, patients: [{ state: 'arrived', arrivedAt: ago(33), pastBookedMinutes: 40 }, { state: 'arrived', arrivedAt: ago(10), pastBookedMinutes: 2 }] };
  const opLine = flowHeadline(op, await flowCounts(runner({ ospeli_clinics_day_summary: day, ospeli_clinics_queue: queue }), op));
  assert.equal(opLine.text, 'Longest timed wait: 33 min to be seen since booked time or later arrival (1 patient)');
  assert.equal(opLine.leftOut, 'Leave is not counted yet.');
});

test('(b) Wards: Stay plus Expected to leave equals every occupied bed, and both tiles count beds', async () => {
  const wards = [ward('ward-a1', 20, 4), ward('ward-b2', 32, 5), ward('ward-c3', 0, 0)];
  const c = wardBedCounts(wards);
  assert.deepEqual(c, { stay: 52, expected: 9, occupied: 61 });
  assert.equal(c.stay + c.expected, c.occupied);
  const dept = departmentById('wards');
  const flow = await flowCounts(runner(wardsAnswers()), dept);
  assert.equal(flow.counts.stay.n + flow.counts.ready.n, 61);
  assert.equal(dept.stages.find((s) => s.id === 'ready').name, 'Expected to leave');
  assert.equal(dept.stages.find((s) => s.id === 'stay').unit, 'bed');
  assert.equal(dept.stages.find((s) => s.id === 'ready').unit, 'bed');
  // Whole hospital's Stay is the same total of occupied beds.
  const whole = departmentById('whole-hospital');
  const wf = await flowCounts(runner({ ospeli_beds_board: wardsAnswers().ospeli_beds_board }), whole);
  assert.equal(wf.counts.stay.n, 61);
});

test('(d) every stage that can carry a number names its unit; planned stages carry none', () => {
  for (const d of DEPARTMENTS) for (const s of d.stages) {
    if (s.planned) { assert.equal(s.unit, undefined, `${d.id} ${s.id}`); continue; }
    if (['prep', 'scan'].includes(s.id) && d.id === 'imaging') continue; // not counted: no source
    if (d.id === 'outpatients' && s.id === 'leave') continue; // not counted: no source
    assert.match(s.unit || '', /^(patient|bed|journey|request)$/, `${d.id} ${s.id}`);
  }
});

test('(e) Emergency: one honest tile, waiting for a ward bed, with its longest wait; the rest planned, not built', async () => {
  const dept = departmentById('emergency');
  assert.deepEqual(dept.stages.filter((s) => !s.planned).map((s) => s.tile), ['Waiting for a ward bed']);
  const flow = await flowCounts(runner(wardsAnswers()), dept);
  assert.deepEqual(Object.keys(flow.counts), ['leave']);
  assert.equal(flow.counts.leave.n, 2);
  assert.equal(flow.counts.leave.longest, 370);
  const line = flowHeadline(dept, flow);
  assert.equal(line.leftOut, 'Arrive, Assess and Treat are planned, not built.');
});

test('(c) the strip carries the time its numbers were read: the earliest asOf of the reads used', async () => {
  const dept = departmentById('wards');
  const flow = await flowCounts(runner(wardsAnswers({ ospeli_transfers_board: { asOf: ago(2), waiting: [] } })), dept);
  assert.equal(flow.asOf, ago(2));
  const none = await flowCounts(runner({}), dept);
  assert.equal(none.asOf, null, 'nothing read, no time claimed');
});

// Night 5 item 2: a request never heads the strip; its age is on its own tile (was the headline on night 4).
test('Laboratory: Done is released in the last 24 h, set apart from open work; open requests keep their age on their tile', async () => {
  const dept = departmentById('laboratory');
  const flow = await flowCounts(runner({ ospeli_diagnostics_requests_list: { asOf: AS_OF, requests: [
    { state: 'requested', minutesInStep: 50 }, { state: 'received', minutesInStep: 125 }, { state: 'released', minutesInStep: 600 }, { state: 'collected', minutesInStep: null }] } }), dept);
  assert.equal(flow.counts.done.n, 1);
  assert.equal(dept.stages.find((s) => s.id === 'done').apart, true);
  const line = flowHeadline(dept, flow);
  assert.equal(line.text, null, 'no request heads the strip');
  assert.match(line.none, /^No timed patient wait\./);
  assert.equal(flow.counts.received.longest, 125, 'the 2 h 5 min request is on the Received tile');
  assert.equal(flow.counts.asked.longest, 50);
  assert.equal(line.leftOut, 'Not timed: 1 request with no step time.');
});

test('(f) Needs you: the agents\' card takes its place in flow order and is never first on a tie', () => {
  const dept = departmentById('imaging');
  const ops = [{ stage: dept.stages[2], order: 2, page: 'engineering' }, { stage: dept.stages[3], order: 3, page: 'transfers' }];
  const at = (pages) => orderNeeds(dept, ops, { pages: pages.map((id) => ({ id })) }).map((x) => x.decisions ? 'decisions' : x.page);
  assert.deepEqual(at(['process']), ['engineering', 'transfers', 'decisions'], 'a page on no stage: after the stages');
  assert.deepEqual(at(['transfers']), ['engineering', 'transfers', 'decisions'], 'same stage and page: after the work card');
  assert.deepEqual(at(['clinics', 'process']), ['decisions', 'engineering', 'transfers'], 'its earliest stage decides');
  assert.deepEqual(orderNeeds(dept, ops, { pages: [] }).map((x) => x.page), ['engineering', 'transfers'], 'agents off: the same cards in the same order');
});
