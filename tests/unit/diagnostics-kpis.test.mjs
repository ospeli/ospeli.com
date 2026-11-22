// Diagnostics (A5): every measure recomputed from a small event log with numbers checked by hand,
// and each guide rule (fires, does not fire, its basis says "example setting"). Times are UTC and
// the site clock is UTC here unless a test says otherwise. Fictional data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveRequests, deriveEquipment, labTurnaround, rejectionRate, equipmentAvailability, completeness, missingSteps, percentile,
  ruleNotArrived, ruleEquipmentDown, ruleRejectionReview, GUIDE_RULES, localStartOfDay, NOT_ARRIVED_MINUTES, REVIEW_COUNT,
} from '../../web/app/modules/diagnostics/logic.js';

const ev = (type, subject, at, data = null, actorRole = 'lab-reception') => ({ type, subject, at: `2026-11-03T${at}:00.000Z`, data, actorRole });
const made = (id, at, sourceId, testGroup, urgency = 'routine', extra = {}) => ev('diagnostics.request-made', id, at, { sourceId, testGroup, urgency, ...extra }, 'unit-clerk');
const coll = (id, at, back = 0) => ev('diagnostics.specimen-collected', id, at, back ? { backdatedMinutes: back } : null, 'ward-nurse');
const recv = (id, at) => ev('diagnostics.specimen-received', id, at);
const rej = (id, at, reason, role = 'lab-reception') => ev('diagnostics.specimen-rejected', id, at, { reason }, role);
const rel = (id, at) => ev('diagnostics.result-validated', id, at, null, 'lab-scientist');

// Ten requests on 3 Nov 2026.
const LOG = [
  made('dx-00001', '08:00', 'ward-a1', 'chemistry'), coll('dx-00001', '08:10'), recv('dx-00001', '08:40'), rel('dx-00001', '09:40'), // 60 min
  made('dx-00002', '08:30', 'ward-a1', 'chemistry', 'urgent'), recv('dx-00002', '09:00'), rel('dx-00002', '09:30'), // 30 min, no collection time
  made('dx-00003', '09:00', 'ward-a2', 'blood-count'), coll('dx-00003', '09:10', 30), recv('dx-00003', '10:00'), rel('dx-00003', '10:20'), // 20 min; collection entered late
  made('dx-00004', '09:30', 'ward-a2', 'blood-count'), coll('dx-00004', '09:40'), rej('dx-00004', '10:05', 'haemolysed'), // rejected at the hatch
  made('dx-00005', '09:40', 'ward-a2', 'blood-count'), coll('dx-00005', '09:50'), recv('dx-00005', '10:10'), rej('dx-00005', '10:40', 'clotted', 'lab-scientist'), // rejected after receipt
  made('dx-00006', '10:30', 'ward-a2', 'blood-count', 'routine', { recollectionOf: 'dx-00004' }), coll('dx-00006', '10:40'), recv('dx-00006', '11:00'), rel('dx-00006', '11:50'), // 50 min
  made('dx-00007', '10:00', 'ward-a3', 'urine'), recv('dx-00007', '11:10'), rel('dx-00007', '12:30'), // 80 min, no collection time
  made('dx-00008', '10:00', 'ward-a3', 'urine'), ev('diagnostics.request-cancelled', 'dx-00008', '10:20', { reason: 'not-needed' }, 'unit-clerk'),
  made('dx-00009', '11:00', 'ward-a1', 'chemistry'), coll('dx-00009', '11:05'), recv('dx-00009', '11:20'), ev('diagnostics.specimen-undone', 'dx-00009', '11:21', { reason: 'tapped-by-mistake' }), // receipt undone: on the way
  made('dx-00010', '11:30', 'ward-a1', 'chemistry'), coll('dx-00010', '11:35'), recv('dx-00010', '12:00'), // received, no result yet
];
const DAYWIN = { since: '2026-11-03T00:00:00.000Z', until: '2026-11-04T00:00:00.000Z' };

test('the requests derived from the log: states, the recollection link, the undo', () => {
  const r = deriveRequests(LOG);
  assert.deepEqual([...r.values()].map((x) => x.state), ['released', 'released', 'released', 'rejected', 'rejected', 'released', 'released', 'cancelled', 'collected', 'received']);
  assert.deepEqual([r.get('dx-00004').recollectedBy, r.get('dx-00006').recollectionOf], ['dx-00006', 'dx-00004']);
  assert.deepEqual([r.get('dx-00005').rejectedAfterReceipt, r.get('dx-00004').rejectedAfterReceipt], [true, false]);
  assert.deepEqual([r.get('dx-00009').receivedAt, r.get('dx-00009').undone], [null, 1]);
  assert.equal(r.get('dx-00003').collectedRecordedAt, '2026-11-03T09:40:00.000Z', 'taken 09:10, recorded 30 minutes later');
});

test('KPI laboratory turnaround time, by hand: received to released, median 50, 90th percentile 80, n 5; by test group and urgency', () => {
  const r = deriveRequests(LOG);
  // Released: 60 (1), 30 (2), 20 (3), 50 (6), 80 (7). Sorted 20 30 50 60 80: median 50.
  // Nearest rank 90th: rank ceil(0.9 x 5) = 5, so 80. Rejected (4, 5), cancelled (8), undone (9) and open (10) are left out.
  assert.deepEqual(labTurnaround(r, DAYWIN), { value: 50, median: 50, p90: 80, n: 5, numerator: null, denominator: null });
  assert.deepEqual([labTurnaround(r, { ...DAYWIN, testGroup: 'chemistry' }).median, labTurnaround(r, { ...DAYWIN, testGroup: 'chemistry' }).n], [45, 2], '60 and 30');
  assert.deepEqual([labTurnaround(r, { ...DAYWIN, testGroup: 'chemistry', urgency: 'urgent' }).median, labTurnaround(r, { ...DAYWIN, testGroup: 'chemistry', urgency: 'routine' }).median], [30, 60], 'urgent and routine apart');
  // The window is by release time: until 10:00 only 1 and 2 are released.
  assert.equal(labTurnaround(r, { since: DAYWIN.since, until: '2026-11-03T10:00:00.000Z' }).n, 2);
  // Blood culture is never part of a figure across test groups (reported over days): a culture
  // released 2,880 minutes after receipt changes the median only when it is let in.
  const culture = deriveRequests([...LOG, made('dx-00011', '08:00', 'ward-a1', 'culture'), recv('dx-00011', '08:30'), rel('dx-00011', '20:30')]); // 720 min
  // In: 20 30 50 60 80 720, median (50 + 60) / 2 = 55, n 6. Left out: back to 50, n 5.
  assert.deepEqual([labTurnaround(culture, DAYWIN).median, labTurnaround(culture, DAYWIN).n], [55, 6]);
  assert.deepEqual([labTurnaround(culture, { ...DAYWIN, leaveOut: ['culture'] }).median, labTurnaround(culture, { ...DAYWIN, leaveOut: ['culture'] }).n], [50, 5]);
  assert.deepEqual([labTurnaround(culture, { ...DAYWIN, testGroup: 'culture' }).median, labTurnaround(culture, { ...DAYWIN, testGroup: 'culture' }).n], [720, 1], 'its own row');
  // A release undone leaves the turnaround: 80 (dx-00007) goes, median of 20 30 50 60 is 40, n 4.
  const undone = deriveRequests([...LOG, ev('diagnostics.specimen-undone', 'dx-00007', '12:32', { reason: 'tapped-by-mistake' }, 'lab-scientist')]);
  assert.deepEqual([undone.get('dx-00007').state, undone.get('dx-00007').releasedAt], ['received', null]);
  assert.deepEqual([labTurnaround(undone, DAYWIN).median, labTurnaround(undone, DAYWIN).n], [40, 4]);
  // A collection undone goes back to "not collected".
  const cu = deriveRequests([...LOG, made('dx-00012', '12:00', 'ward-a1', 'urine'), coll('dx-00012', '12:05'), ev('diagnostics.collection-undone', 'dx-00012', '12:06', { reason: 'wrong-request' }, 'unit-clerk')]);
  assert.deepEqual([cu.get('dx-00012').state, cu.get('dx-00012').collectedAt], ['requested', null]);
  assert.deepEqual([percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9), percentile([7], 0.9), percentile([], 0.9)], [9, 7, null]);
});

test('KPI specimen rejection rate, by hand: rejected out of received plus rejected, 2 of 8 = 25 %, not 2 of 6', () => {
  const r = deriveRequests(LOG);
  // Reached the lab: 1, 2, 3, 6, 7, 10 received; 4 rejected at the hatch; 5 rejected after receipt (counted rejected only).
  // 9's receipt was undone: not reached. 8 cancelled. So 2 rejected of 8 = 25 %.
  assert.deepEqual(rejectionRate(r, DAYWIN), { value: 25, numerator: 2, denominator: 8, n: 8 });
  assert.deepEqual(rejectionRate(r, { ...DAYWIN, sourceId: 'ward-a2' }), { value: 50, numerator: 2, denominator: 4, n: 4 }, 'Ward A2: 3, 4, 5, 6');
  assert.equal(rejectionRate(r, { ...DAYWIN, reason: 'haemolysed' }).numerator, 1);
  // The brief's own case: 3 rejected, 27 received is 3 of 30 = 10 %.
  const big = [];
  for (let i = 1; i <= 30; i++) {
    const id = `dx-${String(i).padStart(5, '0')}`;
    big.push(made(id, '08:00', 'ward-b1', 'blood-count'), i <= 3 ? rej(id, '09:00', 'too-little') : recv(id, '09:00'));
  }
  assert.deepEqual(rejectionRate(deriveRequests(big), DAYWIN), { value: 10, numerator: 3, denominator: 30, n: 30 });
});

test('data completeness (D-21) and missing steps, by hand: 5 of 7 finished requests have every step; 2 reached the lab with no collection time; 1 entered late', () => {
  const r = deriveRequests(LOG);
  // Finished (released or rejected): 1, 2, 3, 4, 5, 6, 7. Missing the collection: 2 and 7. So 5 of 7 = 71.4 %.
  const c = completeness(r, DAYWIN);
  assert.deepEqual([c.numerator, c.denominator, Math.round(c.value * 10) / 10], [5, 7, 71.4]);
  assert.deepEqual(completeness(r, { ...DAYWIN, sourceId: 'ward-a3' }), { value: 0, numerator: 0, denominator: 1, n: 1 }, '7 only (8 was cancelled)');
  // Reached the lab with no collection: 2, 7 (10 had one). Entered late: 3 (30 minutes after).
  assert.deepEqual(missingSteps(r, DAYWIN), { noCollection: 2, enteredLate: 1 });
});

test('KPI equipment availability (D-12), by hand: 7.5 h down of 168 h scheduled is 95.5 %; partly down counts as in service, shown apart', () => {
  const at = (d, hm) => `2026-11-0${d}T${hm}:00.000Z`;
  const evs = [
    { type: 'diagnostics.equipment-down', subject: 'asset-analyser-1', at: at(3, '10:00'), actorRole: 'lab-scientist', data: { scope: 'all', reason: 'breakdown', backup: 'hold' } },
    { type: 'diagnostics.equipment-up', subject: 'asset-analyser-1', at: at(3, '14:30'), actorRole: 'lab-scientist', data: null }, // 4.5 h
    { type: 'diagnostics.equipment-down', subject: 'asset-analyser-1', at: at(5, '08:00'), actorRole: 'lab-scientist', data: { scope: 'part', testGroups: ['urine'], reason: 'no-reagent', backup: 'hold' } },
    { type: 'diagnostics.equipment-up', subject: 'asset-analyser-1', at: at(5, '10:00'), actorRole: 'lab-scientist', data: null }, // 2 h partly
    { type: 'diagnostics.equipment-down', subject: 'asset-analyser-1', at: at(8, '21:00'), actorRole: 'diagnostics-manager', data: { scope: 'all', reason: 'no-power-it', backup: 'partner-lab' } }, // open: 3 h to the end
  ];
  const x = deriveEquipment(evs).get('asset-analyser-1');
  const a = equipmentAvailability(x, { since: '2026-11-02T00:00:00.000Z', until: '2026-11-09T00:00:00.000Z' });
  // 7 days x 24 h = 168 h scheduled; down 4.5 + 3 = 7.5 h; in service 160.5 h; 160.5 / 168 = 95.54 %.
  assert.deepEqual(a, { value: 95.5, numerator: 160.5, denominator: 168, downHours: 7.5, partHours: 2, downtimePct: 4.5 });
  // An episode that began before the window counts from the window's start.
  assert.equal(equipmentAvailability(x, { since: '2026-11-03T12:00:00.000Z', until: '2026-11-04T00:00:00.000Z' }).downHours, 2.5);
  assert.equal(equipmentAvailability(undefined, { since: '2026-11-02T00:00:00.000Z', until: '2026-11-03T00:00:00.000Z' }).value, 100, 'never marked down');
});

test('guide rule 1: collected and not received within the example time for its urgency; the timer starts at collection, never at the request', () => {
  const evs = [
    made('dx-00001', '08:00', 'ward-b1', 'blood-count'), coll('dx-00001', '09:00'), // routine, collected 09:00
    made('dx-00002', '11:00', 'ward-b1', 'chemistry', 'urgent'), coll('dx-00002', '11:30'), // urgent, collected 11:30
    made('dx-00003', '06:00', 'ward-b1', 'urine'), // never collected: "not collected", never overdue
  ];
  const r = deriveRequests(evs);
  const at = (hm) => `2026-11-03T${hm}:00.000Z`;
  assert.deepEqual(ruleNotArrived(r, { now: at('11:59') }).map((s) => s.requestId), [], `routine ${NOT_ARRIVED_MINUTES.routine} min not reached (179)`);
  assert.deepEqual(ruleNotArrived(r, { now: at('12:00') }).map((s) => s.requestId), ['dx-00001'], '180 min after collection');
  assert.deepEqual(ruleNotArrived(r, { now: at('12:30') }).map((s) => s.requestId), ['dx-00001', 'dx-00002'], `urgent after ${NOT_ARRIVED_MINUTES.urgent} min`);
  const s = ruleNotArrived(r, { now: at('12:30'), nameOf: () => 'Ward B1' })[0];
  assert.match(s.text, /^Request 1 from Ward B1: not arrived\. Check where it is\.$/);
  assert.match(s.basis, /Example setting, not a standard/);
  assert.equal(s.action, null);
  // Received: gone.
  assert.deepEqual(ruleNotArrived(deriveRequests([...evs, recv('dx-00001', '12:10')]), { now: at('12:20') }), []);
});

test('guide rule 2: an analyser down shows on each ward with open requests for what it runs, with the backup route', () => {
  const evs = [
    made('dx-00001', '08:00', 'ward-a1', 'chemistry'), made('dx-00002', '08:10', 'ward-a1', 'urine'), made('dx-00003', '08:20', 'ward-a2', 'blood-count'),
    made('dx-00004', '08:30', 'ward-a2', 'chemistry'), recv('dx-00004', '08:50'), // already at the lab: not the ward's worry
    { type: 'diagnostics.equipment-down', subject: 'asset-analyser-1', at: '2026-11-03T09:00:00.000Z', actorRole: 'lab-scientist', data: { scope: 'all', reason: 'breakdown', backup: 'partner-lab' } },
  ];
  const eq = deriveEquipment(evs);
  const list = [{ assetId: 'asset-analyser-1', kind: 'lab', name: 'Chemistry analyser 1', x: eq.get('asset-analyser-1') }];
  const out = ruleEquipmentDown(deriveRequests(evs), list, { nameOf: (x) => x, backupText: () => 'Send to: the partner laboratory', offsetMinutes: -240 });
  assert.deepEqual(out.map((s) => [s.sourceId, s.requestIds]), [['ward-a1', ['dx-00001', 'dx-00002']], ['ward-a2', ['dx-00004']]], 'blood count is not run by it; a specimen already received waits for it too');
  assert.match(out[1].text, /1 already at the lab, waiting for it/);
  assert.match(out[0].text, /^Chemistry analyser 1 is down: 2 open requests from ward-a1 \(blood chemistry, urine tests\)\. Send to: the partner laboratory\.$/);
  assert.match(out[0].why, /at 05:00/, 'site clock four hours west of UTC');
  // Partly down, urine only.
  const part = deriveEquipment([{ ...evs[5], data: { scope: 'part', testGroups: ['urine'], reason: 'no-reagent', backup: 'hold' } }]);
  const p = ruleEquipmentDown(deriveRequests(evs), [{ ...list[0], x: part.get('asset-analyser-1') }], {});
  assert.deepEqual(p.map((s) => s.requestIds), [['dx-00002']]);
  // Back: nothing.
  const up = deriveEquipment([...evs, { type: 'diagnostics.equipment-up', subject: 'asset-analyser-1', at: '2026-11-03T10:00:00.000Z', actorRole: 'lab-scientist', data: null }]);
  assert.deepEqual(ruleEquipmentDown(deriveRequests(evs), [{ ...list[0], x: up.get('asset-analyser-1') }], {}), []);
});

test(`guide rule 3: ${REVIEW_COUNT} rejections for one reason from one area in seven days suggest a review; a plain count`, () => {
  const day = (d, id, src, reason) => [
    { type: 'diagnostics.request-made', subject: id, at: `2026-11-${d}T08:00:00.000Z`, actorRole: 'unit-clerk', data: { sourceId: src, testGroup: 'blood-count', urgency: 'routine' } },
    { type: 'diagnostics.specimen-rejected', subject: id, at: `2026-11-${d}T09:00:00.000Z`, actorRole: 'lab-reception', data: { reason } },
  ];
  const evs = [...day('01', 'dx-00001', 'ward-a3', 'haemolysed'), // 9 days before now: out
    ...day('05', 'dx-00002', 'ward-a3', 'haemolysed'), ...day('08', 'dx-00003', 'ward-a3', 'haemolysed'),
    ...day('09', 'dx-00004', 'ward-a3', 'clotted'), ...day('09', 'dx-00005', 'ward-b1', 'haemolysed')];
  const now = '2026-11-10T12:00:00.000Z';
  assert.deepEqual(ruleRejectionReview(deriveRequests(evs), { now }), [], 'two in seven days: not yet');
  const more = [...evs, ...day('10', 'dx-00006', 'ward-a3', 'haemolysed')];
  const s = ruleRejectionReview(deriveRequests(more), { now, nameOf: () => 'Ward A3' });
  assert.deepEqual(s.map((x) => [x.sourceId, x.reason, x.count]), [['ward-a3', 'haemolysed', 3]]);
  assert.match(s[0].text, /Suggest a short review with Ward A3: "Haemolysed \(hemolyzed\)" 3 times in 7 days\./);
  assert.match(s[0].basis, /plain count/);
});

test('every guide rule states its basis as an example setting, not a standard', () => {
  assert.equal(GUIDE_RULES.length, 3);
  for (const g of GUIDE_RULES) assert.match(g.basis, /^Example setting, not a standard/);
});

test('"today" on the site clock: since 00:00 local, which a night shift crosses', () => {
  assert.equal(localStartOfDay('2026-11-19T03:30:00.000Z', -240), '2026-11-18T04:00:00.000Z', '23:30 on the 18th, site time');
  assert.equal(localStartOfDay('2026-11-19T04:30:00.000Z', -240), '2026-11-19T04:00:00.000Z', '00:30 on the 19th');
});
