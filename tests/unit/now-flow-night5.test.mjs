// Now is headed by a person's wait (crew night 5, crew/now-183 items 1 to 3; decision record
// docs/decisions/2026-11-25-now-flow-strip.md in the planning repo): a patient's wait heads the
// strip whenever one is timed, a request never does, and a clinic wait runs from the later of
// arrival and booked time. Made-up read-command answers for the synthetic example hospital.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flowCounts, flowHeadline, waitPastBooked } from '../../web/app/modules/home.js';
import { departmentById } from '../../web/app/modules/departments.js';

const AS_OF = '2026-11-17T14:20:00.000Z';
const ago = (min) => new Date(Date.parse(AS_OF) - min * 60000).toISOString();
const runner = (answers) => async (name, input) => {
  if (!(name in answers)) throw new Error(`no ${name}`);
  const a = typeof answers[name] === 'function' ? answers[name](input) : answers[name];
  return structuredClone(a);
};
const ward = (id, occupied, expected) => ({ id, name: id, counts: { occupied, 'expected-discharge': expected, available: 2 } });
const beds = (...decisionMinutes) => ({ asOf: AS_OF, wards: [ward('ward-a1', 20, 4)], beds: [], waiting: decisionMinutes.map((m, i) => ({ encounter: `enc-${i}`, wardId: null, decisionAt: ago(m), requestedAt: ago(m) })) });
const lab = (...reqs) => ({ asOf: AS_OF, requests: reqs.map(([state, minutesInStep]) => ({ state, minutesInStep })) });
// A clinic day: one clinic, with these arrived patients ([minutes since arrival, minutes past booked time]).
const clinic = (patients, toCome = 3) => ({
  ospeli_clinics_day_summary: { asOf: AS_OF, date: '2026-11-17', clinics: [{ sessionId: 'ses-1', date: '2026-11-17', counts: { toCome, waiting: patients.length, withClinician: 1, longestWaitMinutes: Math.max(0, ...patients.map((p) => p[0])) } }] },
  ospeli_clinics_queue: (input) => ({ asOf: AS_OF, sessionId: input.sessionId, patients: patients.map(([since, past], i) => ({ appointmentId: `apt-${i}`, state: 'arrived', arrivedAt: since == null ? null : ago(since), pastBookedMinutes: past, waitMinutes: since })) }),
});

test('item 2: Laboratory with only requests: no request heads the strip; the headline says there is no timed patient wait and each tile keeps its age', async () => {
  const dept = departmentById('laboratory');
  const flow = await flowCounts(runner({ ospeli_diagnostics_requests_list: lab(['requested', 50], ['received', 1440], ['received', 125], ['collected', 20], ['released', 600]) }), dept);
  const line = flowHeadline(dept, flow);
  assert.equal(line.text, null, 'no "Longest wait now: 24 h for a result"');
  assert.match(line.none, /^No timed patient wait\. /);
  assert.doesNotMatch(line.none, /longest wait/i);
  assert.equal(flow.counts.received.longest, 1440, 'the 24 h request stays on the Received tile');
  assert.equal(flow.counts.asked.longest, 50);
  assert.equal(flow.counts.collected.longest, 20);
  assert.equal(flow.counts.done.longest, undefined, 'released work has no age on the strip');
});

test('item 2: Whole hospital: a 5 h 10 min bed wait heads the strip above a 24 h lab request, named with its unit', async () => {
  const dept = departmentById('whole-hospital');
  const flow = await flowCounts(runner({
    ...clinic([[30, 12]]),
    ospeli_diagnostics_requests_list: lab(['received', 1440], ['requested', 40]),
    ospeli_beds_board: beds(310, 20),
    ospeli_transfers_board: { asOf: AS_OF, waiting: [{ id: 'trf-1', pickup: { id: 'ward-a1' }, waitMinutes: 47 }] },
  }), dept);
  const line = flowHeadline(dept, flow);
  assert.equal(line.text, 'Longest wait now: 5 h 10 min for a bed (1 patient)');
  assert.deepEqual(flow.wait.between, ['test', 'stay']);
  assert.match(line.leftOut, /Requests are not ranked with patient waits/);
  assert.equal(flow.counts.test.longest, 1440, 'the request\'s age is on Test and treat');
  assert.equal(line.none, '');
});

test('item 2: a vehicle never heads the strip above a patient\'s wait; a longer vehicle wait is said under it', async () => {
  const dept = departmentById('wards');
  const flow = await flowCounts(runner({ ospeli_beds_board: beds(370), ospeli_transfers_board: { asOf: AS_OF, waiting: [{ id: 'trf-1', pickup: { id: 'ward-a1' }, waitMinutes: 400 }] } }), dept);
  const line = flowHeadline(dept, flow);
  assert.equal(line.text, 'Longest wait now: 6 h 10 min for a bed (1 patient)');
  assert.equal(line.also, 'A vehicle wait is longer: 6 h 40 min (1 journey).');
  // No patient waiting for a bed: the vehicle wait may head it.
  const noBed = await flowCounts(runner({ ospeli_beds_board: beds(), ospeli_transfers_board: { asOf: AS_OF, waiting: [{ id: 'trf-1', pickup: { id: 'ward-a1' }, waitMinutes: 47 }] } }), dept);
  assert.equal(flowHeadline(dept, noBed).text, 'Longest wait now: 47 min for a vehicle (1 journey)');
});

test('item 2: Imaging: a patient waiting to be moved out heads the strip above a longer vehicle wait', async () => {
  const dept = departmentById('imaging');
  const flow = await flowCounts(runner({
    ospeli_tasks_list: { asOf: AS_OF, tasks: [{ id: 't1', toLocationId: 'dept-imaging', locationId: 'ward-a1', waitMinutes: 12 }, { id: 't2', locationId: 'dept-imaging', toLocationId: 'ward-a1', waitMinutes: 25 }] },
    ospeli_transfers_board: { asOf: AS_OF, waiting: [{ id: 'trf-9', pickup: { id: 'dept-imaging' }, waitMinutes: 47 }] },
  }), dept);
  const line = flowHeadline(dept, flow);
  assert.equal(line.text, 'Longest timed wait: 25 min to be moved out (1 patient)');
  assert.equal(line.also, 'A vehicle wait is longer: 47 min (1 journey).');
});

test('item 3: the clinic wait runs from the later of arrival and booked time', () => {
  // Arrived 60 min ago, booked 10 min ago: waiting 10 min past the booked time.
  assert.equal(waitPastBooked({ arrivedAt: ago(60), pastBookedMinutes: 10 }, AS_OF), 10);
  // Arrived 20 min ago, 40 min after a booked time 60 min ago: waiting 20 min since arrival.
  assert.equal(waitPastBooked({ arrivedAt: ago(20), pastBookedMinutes: 60 }, AS_OF), 20);
  // Arrived early, before the booked time: no wait yet.
  assert.equal(waitPastBooked({ arrivedAt: ago(30), pastBookedMinutes: 0 }, AS_OF), 0);
  assert.equal(waitPastBooked({ arrivedAt: null, pastBookedMinutes: 5 }, AS_OF), null);
});

test('item 3: Outpatients is headed by time past the booked time, not by a patient who arrived early', async () => {
  const dept = departmentById('outpatients');
  // Early: here 70 min, booked 5 min ago. Late: here 18 min, booked 50 min ago. On time: here 15 min, booked 14 min ago.
  const flow = await flowCounts(runner(clinic([[70, 5], [18, 50], [15, 14]])), dept);
  const line = flowHeadline(dept, flow);
  assert.equal(flow.wait.minutes, 18, 'the late arrival\'s 18 min, not the early arrival\'s 70 min');
  assert.equal(line.text, 'Longest timed wait: 18 min to be seen since booked time or later arrival (1 patient)');
  assert.doesNotMatch(line.text, /1 h 10 min/);
  // An arrived patient with no arrival time is said, not guessed.
  const gap = await flowCounts(runner(clinic([[18, 50], [null, 3]])), dept);
  assert.equal(flowHeadline(dept, gap).leftOut, 'Leave is not counted yet. Not timed: 1 patient waiting with no arrival time.');
});

test('item 1: every counted tile has its meaning in words for the screen, not only for screen readers', async () => {
  const pharmacy = departmentById('pharmacy');
  const f = await flowCounts(runner({ ospeli_pharmacy_overview: { asOf: AS_OF, counts: { raised: 2, started: 1, checked: 0, ready: 1 } } }), pharmacy);
  assert.equal(f.counts.collected.show, 'ready to collect');
  assert.equal(f.counts.received.show, 'not started');
  const op = departmentById('outpatients');
  const o = await flowCounts(runner(clinic([[10, 5]])), op);
  assert.equal(o.counts.arrive.show, 'booked, not here yet', 'Arrive counts bookings, and says so');
  assert.equal(o.counts.wait.show, 'arrived, waiting');
  for (const d of ['wards', 'laboratory', 'whole-hospital']) {
    const dept = departmentById(d);
    const fl = await flowCounts(runner({ ospeli_beds_board: beds(30), ospeli_transfers_board: { asOf: AS_OF, waiting: [] }, ospeli_diagnostics_requests_list: lab(['requested', 5]), ...clinic([[10, 5]]) }), dept);
    for (const [id, c] of Object.entries(fl.counts)) assert.ok(c.show && c.show.length > 2, `${d} ${id}: words on screen`);
  }
});
