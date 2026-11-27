// Now review fixes (crew/now-183, two reviewers, 26 Nov; decision record
// docs/decisions/2026-11-25-now-flow-strip.md in the planning repo): never "longest wait" for a
// subset. "Longest wait now" only when every stage of the department's strip that holds patients is
// timed; otherwise "Longest timed wait" (or "Only timed wait" when there is just one) and what is
// not timed is named, from the stage data. Made-up read-command answers for the synthetic example hospital.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flowCounts, flowHeadline, untimedStages } from '../../web/app/modules/home.js';
import { departmentById, DEPARTMENTS } from '../../web/app/modules/departments.js';

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
const clinic = (patients) => ({
  ospeli_clinics_day_summary: { asOf: AS_OF, date: '2026-11-17', clinics: [{ sessionId: 'ses-1', date: '2026-11-17', counts: { toCome: 3, waiting: patients.length, withClinician: 1 } }] },
  ospeli_clinics_queue: (input) => ({ asOf: AS_OF, sessionId: input.sessionId, patients: patients.map(([since, past], i) => ({ appointmentId: `apt-${i}`, state: 'arrived', arrivedAt: ago(since), pastBookedMinutes: past })) }),
});
const vans = (...m) => ({ asOf: AS_OF, waiting: m.map((w, i) => ({ id: `trf-${i}`, pickup: { id: 'ward-a1' }, waitMinutes: w })) });
const whole = () => ({ ...clinic([[30, 12]]), ospeli_diagnostics_requests_list: lab(['received', 1440]), ospeli_beds_board: beds(349, 20, 10, 5), ospeli_transfers_board: vans(47) });

test('fix 1: every stage that holds patients says whether its wait is timed, in the stage data', () => {
  for (const d of DEPARTMENTS) for (const s of d.stages) {
    if (s.wait != null) assert.match(s.wait, /^(timed|untimed)$/, `${d.id} ${s.id}`);
    if (s.planned) assert.equal(s.wait, 'untimed', `${d.id} ${s.id}: a planned stage that holds patients is not timed`);
  }
  // What the whole hospital cannot time, from the other departments' stages (not a typed sentence).
  assert.deepEqual(untimedStages(departmentById('whole-hospital')), ['emergency department steps', 'imaging prep and scan']);
});

test('fix 1: Whole hospital says "Longest timed wait" and names what is not timed; never "Longest wait now"', async () => {
  const dept = departmentById('whole-hospital');
  const line = flowHeadline(dept, await flowCounts(runner(whole()), dept));
  assert.equal(line.text, 'Longest timed wait: 5 h 49 min for a bed (1 patient)');
  assert.match(line.leftOut, /^Not timed: emergency department steps, imaging prep and scan\./);
  assert.doesNotMatch(`${line.text} ${line.leftOut}`, /Longest wait now/);
});

test('fix 1: Wards keeps "Longest wait now": its four tiles are counted and the bed and vehicle waits are both timed', async () => {
  const dept = departmentById('wards');
  const line = flowHeadline(dept, await flowCounts(runner({ ospeli_beds_board: beds(349, 20), ospeli_transfers_board: vans(47) }), dept));
  assert.equal(line.text, 'Longest wait now: 5 h 49 min for a bed (1 patient)');
  assert.equal(line.leftOut, '');
});

test('fix 2: Whole hospital: the Occupied tile, where the headline points, counts the patients waiting for a bed', async () => {
  const dept = departmentById('whole-hospital');
  const flow = await flowCounts(runner(whole()), dept);
  assert.equal(flow.counts.stay.also, '4 patients waiting for a bed');
  assert.deepEqual(flow.wait.between, ['test', 'stay'], 'the bar sits before Occupied');
  const one = await flowCounts(runner({ ...whole(), ospeli_beds_board: beds(30) }), dept);
  assert.equal(one.counts.stay.also, '1 patient waiting for a bed');
});

test('fix 3: Emergency: the timed wait for a ward bed heads the strip and the planned steps are named as not timed', async () => {
  const dept = departmentById('emergency');
  const line = flowHeadline(dept, await flowCounts(runner({ ospeli_beds_board: beds(349, 20, 10, 5) }), dept));
  assert.equal(line.text, 'Longest timed wait: 5 h 49 min for a ward bed (1 patient)');
  assert.equal(line.leftOut, 'Not timed: arrival, assessment and treatment (planned, not built).');
});

test('fix 4: Imaging with one timed wait: "Only timed wait", never "Longest"', async () => {
  const dept = departmentById('imaging');
  const flow = await flowCounts(runner({ ospeli_tasks_list: { asOf: AS_OF, tasks: [{ id: 't1', toLocationId: 'dept-imaging', locationId: 'ward-a1', waitMinutes: 44 }] }, ospeli_transfers_board: { asOf: AS_OF, waiting: [] } }), dept);
  const line = flowHeadline(dept, flow);
  assert.equal(line.text, 'Only timed wait: 44 min to be moved in (1 patient)');
  assert.equal(line.leftOut, 'Prep and Scan are not counted yet.');
});

test('fix 5: Laboratory says it in one short sentence; Whole hospital keeps one short clause about requests', async () => {
  const dept = departmentById('laboratory');
  const line = flowHeadline(dept, await flowCounts(runner({ ospeli_diagnostics_requests_list: lab(['requested', 50], ['received', 125]) }), dept));
  assert.equal(line.none, 'No timed patient wait. Requests are not ranked; each tile shows its oldest.');
  const w = departmentById('whole-hospital');
  const wl = flowHeadline(w, await flowCounts(runner(whole()), w));
  assert.equal(wl.leftOut, 'Not timed: emergency department steps, imaging prep and scan. Requests are not ranked.');
});
