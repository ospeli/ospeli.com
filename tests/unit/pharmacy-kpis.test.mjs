// Pharmacy operations (module pharmacy): every slice 1 measure recomputed from a hand-written event
// log, with numbers worked out by hand in the comments, through the logic functions and through the
// overview command; and both guide rules on hand-written logs. Fictional data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Core } from '../../web/app/core/core.js';
import { MemoryAdapter } from '../../web/app/core/db.js';
import { loadSyntheticHospital } from '../../web/app/core/generator.js';
import { runCommand } from '../../web/app/core/commands.js';
import {
  deriveRequests, dischargeTurnaround, stageTimes, collectionWait, ruleLateRequests, ruleWaitingTooLong, estimateFor, sortQueue, heldMinutes,
} from '../../web/app/modules/pharmacy/logic.js';

const OFF = -240; // the example site's offset: local time is UTC minus 4 hours
const NOW = '2026-11-20T18:00:00.000Z'; // 14:00 local
const SINCE = '2026-11-19T18:00:00.000Z'; // the last day
const z = (s) => `2026-11-${s}:00.000Z`;
const raised = (id, at, data, role = 'ward-nurse') => ({ type: 'pharmacy.request-raised', subject: id, at: z(at), actorRole: role, data });
const step = (id, s, at, data = {}, role = 'pharmacy-technician') => ({ type: `pharmacy.${s}`, subject: id, at: z(at), actorRole: role, data });
const dis = (wardId, bed, planned, items = 4) => ({ wardId, bedId: `${wardId}-bed-${bed}`, kind: 'discharge', priority: 'routine', planned, items });

// The log. Local times in brackets.
const LOG = [
  // H: ready on the 19th before the period, collected inside it: only collection wait counts it (13:00 → 19:00 = 360).
  raised('rx-00001', '19T12:00', dis('ward-a1', '05', 'this-afternoon')),
  step('rx-00001', 'request-started', '19T12:10'), step('rx-00001', 'request-checked', '19T12:40', {}, 'pharmacist'), step('rx-00001', 'request-ready', '19T13:00'),
  step('rx-00001', 'request-collected', '19T19:00', {}, 'ward-nurse'),
  // C: raised 19:30 the evening before for tomorrow (outside the working day). 810 min raised → ready. Stages 780, 15, 15. Collected after 10.
  raised('rx-00002', '19T23:30', dis('ward-a2', '01', 'tomorrow')),
  // E: a ward request, started then cancelled: left out of every measure.
  raised('rx-00003', '20T12:00', { wardId: 'ward-a1', kind: 'ward-request', priority: 'routine', items: 3 }),
  step('rx-00003', 'request-started', '20T12:05'), step('rx-00003', 'request-cancelled', '20T12:10', { reason: 'no-longer-needed' }),
  step('rx-00002', 'request-started', '20T12:30'), step('rx-00002', 'request-checked', '20T12:45', {}, 'pharmacist'), step('rx-00002', 'request-ready', '20T13:00'),
  step('rx-00002', 'request-collected', '20T13:10'),
  // A: raised 09:00 local. 60 min. Stages 20, 30, 10. Collected after 30.
  raised('rx-00004', '20T13:00', dis('ward-a1', '01', 'this-afternoon')),
  step('rx-00004', 'request-started', '20T13:20'), step('rx-00004', 'request-checked', '20T13:50', {}, 'pharmacist'), step('rx-00004', 'request-ready', '20T14:00'),
  step('rx-00004', 'request-collected', '20T14:30', {}, 'ward-nurse'),
  // D: this morning (by 12:00 local = 16:00Z), raised 09:30 local, ready 12:20 local: late. 170 min. Stages 30, 30, 110. Not collected.
  raised('rx-00005', '20T13:30', dis('ward-a2', '02', 'this-morning')),
  step('rx-00005', 'request-started', '20T14:00'), step('rx-00005', 'request-checked', '20T14:30', {}, 'pharmacist'), step('rx-00005', 'request-ready', '20T16:20'),
  // B: held 30 min while started. Raw 100 min raised → ready, 70 with the hold taken out. Stages 10, 60 - 30 = 30, 30. Collected after 50.
  raised('rx-00006', '20T14:00', dis('ward-a1', '02', 'this-afternoon')),
  step('rx-00006', 'request-started', '20T14:10'), step('rx-00006', 'request-on-hold', '20T14:20', { reason: 'waiting-for-ward' }), step('rx-00006', 'request-resumed', '20T14:50'),
  step('rx-00006', 'request-checked', '20T15:10', {}, 'pharmacist'), step('rx-00006', 'request-ready', '20T15:40'), step('rx-00006', 'request-collected', '20T16:30', {}, 'ward-nurse'),
  // F: another kind: not in KPI 1; stages 15, 10, 10; collected after 5.
  raised('rx-00007', '20T15:00', { wardId: 'ward-a1', kind: 'other', priority: 'urgent', items: 1 }),
  step('rx-00007', 'request-started', '20T15:15'), step('rx-00007', 'request-checked', '20T15:25', {}, 'pharmacist'), step('rx-00007', 'request-ready', '20T15:35'),
  step('rx-00007', 'request-collected', '20T15:40'),
  // G: a discharge made ready, then the discharge was postponed: cancelled, left out of every measure.
  raised('rx-00008', '20T15:00', dis('ward-a1', '03', 'this-afternoon')),
  step('rx-00008', 'request-started', '20T15:05'), step('rx-00008', 'request-checked', '20T15:10', {}, 'pharmacist'), step('rx-00008', 'request-ready', '20T15:20'),
  step('rx-00008', 'request-cancelled', '20T15:30', { reason: 'discharge-postponed' }, 'ward-nurse'),
  // I: started by mistake and undone: back to raised, no start time, nothing counted.
  raised('rx-00009', '20T16:00', { wardId: 'ward-a2', kind: 'ward-request', priority: 'routine', items: 2 }),
  step('rx-00009', 'request-started', '20T16:05'), step('rx-00009', 'step-undone', '20T16:06', { step: 'started' }),
  // Steps that do not follow from the state are ignored: Ready before Checked, a second Start.
  step('rx-00009', 'request-ready', '20T16:10'),
  step('rx-00004', 'request-started', '20T16:15'),
];

test('KPI 1, discharge medicines turnaround, by hand: median 70 of 3 in the working day; 810 outside it; hold 30; ready before the planned time 3 of 4', () => {
  const all = deriveRequests(LOG);
  const k = dischargeTurnaround(all, { since: SINCE, until: NOW, offsetMinutes: OFF });
  // In the working day: A 60, B 70, D 170 → median 70. Outside: C 810. H was ready before the period.
  assert.deepEqual([k.value, k.n], [70, 3]);
  assert.deepEqual(k.outsideWorkDay, { value: 810, n: 1 });
  assert.deepEqual(k.hold, { value: 30, n: 1 }, 'only B was held, for 30 min');
  assert.deepEqual(k.readyBeforePlanned, { numerator: 3, denominator: 4 }, 'D was ready at 12:20 for this morning (by 12:00)');
  assert.deepEqual(k.byPlanned.filter((b) => b.n).map((b) => [b.id, b.value, b.n]), [['this-morning', 170, 1], ['this-afternoon', 65, 2], ['tomorrow', 810, 1]]);
  assert.deepEqual(k.byWard.map((w) => [w.wardId, w.value, w.n]), [['ward-a1', 65, 2], ['ward-a2', 490, 2]]);
  assert.equal(heldMinutes(all.get('rx-00006'), Date.parse(z('20T14:00')), Date.parse(z('20T15:40'))), 30);
});

test('KPI 2, time by stage, by hand: raised → started 20, started → checked 30, checked → ready 15; the longest is started → checked', () => {
  const all = deriveRequests(LOG);
  const k = stageTimes(all, { since: SINCE, until: NOW });
  // r→s: A 20, B 10, C 780, D 30, F 15 → 20. s→c: A 30, B 30 (hold out), C 15, D 30, F 10 → 30. c→r: A 10, B 30, C 15, D 110, F 10 → 15.
  assert.deepEqual(k.stages.map((s) => [s.id, s.value, s.n]), [['raised-started', 20, 5], ['started-checked', 30, 5], ['checked-ready', 15, 5]]);
  assert.deepEqual([k.value, k.longest, k.n], [30, 'started-checked', 15]);
});

test('KPI 3, collection wait, by hand: median 30 of 5 (one ready the day before, collected in the period)', () => {
  const k = collectionWait(deriveRequests(LOG), { since: SINCE, until: NOW });
  // A 30, B 50, C 10, F 5, H 360 → 30.
  assert.deepEqual([k.value, k.n], [30, 5]);
});

test('the record: an undo goes back one stage and keeps history; a step out of order is ignored; a cancel keeps its reason', () => {
  const all = deriveRequests(LOG);
  const i = all.get('rx-00009');
  assert.deepEqual([i.stage, i.startedAt, i.readyAt, i.undone], ['raised', null, null, 1]);
  assert.equal(all.get('rx-00004').stage, 'collected', 'a second Start on a collected request changes nothing');
  assert.deepEqual([all.get('rx-00008').stage, all.get('rx-00008').cancelReason], ['cancelled', 'discharge-postponed']);
  // An edited import: a sentence where a ward id goes, a dose-like field, 31 items. Never kept as a request.
  const bad = deriveRequests([
    raised('rx-00050', '20T12:00', { wardId: 'Ward of Dr Smith', kind: 'other', priority: 'routine', items: 2 }),
    raised('rx-00051', '20T12:00', { wardId: 'ward-a1', kind: 'other', priority: 'routine', items: 31 }),
    raised('rx-00052', '20T12:00', { wardId: 'ward-a1', kind: 'prescription', priority: 'routine', items: 2 }),
    raised('rx-00053', '20T12:00', { wardId: 'ward-a1', kind: 'other', priority: 'routine', items: 2, dose: '5 mg' }),
  ]);
  assert.deepEqual([...bad.keys()], ['rx-00053']);
  assert.ok(!('dose' in bad.get('rx-00053')), 'a field Ospeli does not write is not read');
});

test('the same three measures through the overview command, on the example hospital with this log and no other pharmacy history', async () => {
  let t = Date.parse(NOW);
  const core = await Core.open({ adapter: new MemoryAdapter(), clock: () => new Date(t) });
  await loadSyntheticHospital(core, { end: NOW, modules: false });
  await core.appendEvents(LOG, 'system', 'hand-written pharmacy log');
  const ov = await runCommand(core, 'ospeli_pharmacy_overview', { days: 1 }, { type: 'human', role: 'pharmacy-manager' });
  const k = Object.fromEntries(ov.kpis.map((x) => [x.id, x]));
  assert.deepEqual([k['discharge-turnaround'].value, k['discharge-turnaround'].n], [70, 3]);
  assert.deepEqual([k['stage-times'].value, k['stage-times'].longest], [30, 'started-checked']);
  assert.deepEqual([k['collection-wait'].value, k['collection-wait'].n, k['collection-wait'].waitingNow], [30, 5, 1]);
  assert.equal(k['discharge-turnaround'].source, 'local definition');
  assert.match(k['stage-times'].source, /36222805/);
  assert.match(k['discharge-turnaround'].targetText, /example setting, not a standard/);
  assert.deepEqual(ov.counts, { raised: 1, started: 0, checked: 0, ready: 1, 'on-hold': 0 }, 'I is raised again; D waits for collection');
});

test('guide rule 1, late discharge requests: more than half of at least 5 same-day requests after 12:00 local in 14 days', () => {
  const ev = [];
  let n = 100;
  const add = (wardId, localHour, planned = 'this-afternoon', daysBack = 1) => {
    const at = new Date(Date.parse(NOW) - daysBack * 864e5);
    at.setUTCHours(localHour + 4, 0, 0, 0);
    ev.push({ type: 'pharmacy.request-raised', subject: `rx-${String(++n).padStart(5, '0')}`, at: at.toISOString(), actorRole: 'ward-nurse', data: { wardId, bedId: `${wardId}-bed-01`, kind: 'discharge', priority: 'routine', planned, items: 2 } });
  };
  // ward-a1: 4 of 6 after 12:00 → fires. ward-a2: 3 of 6 → exactly half, does not. ward-b1: 4 of 4 → too few.
  for (const h of [9, 10, 13, 14, 15, 16]) add('ward-a1', h);
  for (const h of [9, 10, 11, 13, 14, 15]) add('ward-a2', h);
  for (const h of [13, 14, 15, 16]) add('ward-b1', h);
  add('ward-b1', 17, 'tomorrow'); // a request for tomorrow is not a same-day request
  add('ward-b1', 13, 'this-afternoon', 20); // older than 14 days
  const s = ruleLateRequests(deriveRequests(ev), { nowMs: Date.parse(NOW), offsetMinutes: OFF, wardName: (w) => `Ward ${w.slice(5).toUpperCase()}` });
  assert.deepEqual(s.map((x) => [x.wardId, x.late, x.of]), [['ward-a1', 4, 6]]);
  assert.match(s[0].text, /Ward A1: 4 of 6 same-day discharge requests in the last 14 days were raised after 12:00/);
  assert.deepEqual(s[0].times, ['09:00', '10:00', '13:00', '14:00', '15:00', '16:00']);
  assert.match(s[0].basis, /Example setting, not a standard/);
  assert.equal(s[0].action, null, 'advice only');
});

test('guide rule 2, waiting too long: a discharge for today with no step for over 60 min, not on hold; it names a request and a stage, never a person', () => {
  const ev = [
    raised('rx-00201', '20T16:30', dis('ward-a3', '01', 'this-afternoon')), step('rx-00201', 'request-started', '20T16:40'), // 80 min since Start → flagged
    raised('rx-00202', '20T17:30', dis('ward-a3', '02', 'this-afternoon')), // 30 min → not
    raised('rx-00203', '20T16:00', dis('ward-a3', '03', 'this-evening')), step('rx-00203', 'request-started', '20T16:10'), step('rx-00203', 'request-on-hold', '20T16:20', { reason: 'not-in-stock' }), // held → not
    raised('rx-00204', '20T15:00', dis('ward-a3', '04', 'tomorrow')), // tomorrow → not
    raised('rx-00205', '20T15:00', { wardId: 'ward-a3', kind: 'ward-request', priority: 'routine', items: 1 }), // not a discharge → not
    raised('rx-00206', '19T23:00', dis('ward-a3', '05', 'tomorrow')), // raised yesterday for today, untouched for 19 h → flagged
  ];
  const s = ruleWaitingTooLong(deriveRequests(ev), { nowMs: Date.parse(NOW), offsetMinutes: OFF });
  assert.deepEqual(s.map((x) => [x.requestId, x.stage, x.minutes]), [['rx-00206', 'raised', 1140], ['rx-00201', 'started', 80]]);
  for (const x of s) assert.ok(!/technician|pharmacist|nurse/i.test(x.text), 'no person or role is named');
});

test('the estimate: the median of the last 20 ready requests of the same kind on the ward, hold left out; none with fewer than 5', () => {
  const ev = [];
  for (let i = 0; i < 6; i++) {
    const id = `rx-${String(300 + i).padStart(5, '0')}`;
    const h = String(10 + i).padStart(2, '0');
    ev.push(raised(id, `20T${h}:00`, dis('ward-b1', String(i + 1).padStart(2, '0'), 'this-afternoon')), step(id, 'request-started', `20T${h}:10`), step(id, 'request-checked', `20T${h}:20`, {}, 'pharmacist'),
      step(id, 'request-ready', `20T${h}:${String(30 + i * 5).padStart(2, '0')}`));
  }
  // Ready after 30, 35, 40, 45, 50, 55 min → median 42.5. A new request raised at 17:40 → about 18:22.5.
  ev.push(raised('rx-00400', '20T17:40', dis('ward-b1', '10', 'this-evening')));
  const all = deriveRequests(ev);
  const e = estimateFor(all, all.get('rx-00400'), Date.parse(NOW));
  assert.deepEqual([e.minutes, e.n, new Date(e.atMs).toISOString(), e.late], [42.5, 6, '2026-11-20T18:22:30.000Z', false]);
  const few = deriveRequests(ev.filter((x) => !['rx-00300', 'rx-00301'].includes(x.subject)));
  assert.equal(estimateFor(few, few.get('rx-00400'), Date.parse(NOW)).minutes, null, '4 ready requests: no estimate');
});

test('the working order: moved to the front, then urgent, then discharge today by planned time, then oldest', () => {
  const ev = [
    raised('rx-00501', '20T12:00', { wardId: 'ward-a1', kind: 'ward-request', priority: 'routine', items: 1 }), // oldest
    raised('rx-00502', '20T13:00', dis('ward-a1', '01', 'this-evening')),
    raised('rx-00503', '20T13:30', dis('ward-a1', '02', 'this-afternoon')),
    raised('rx-00504', '20T14:00', { wardId: 'ward-a1', kind: 'other', priority: 'urgent', items: 1 }),
    raised('rx-00505', '20T15:00', dis('ward-a1', '03', 'tomorrow')),
    raised('rx-00506', '20T16:00', { wardId: 'ward-a1', kind: 'ward-request', priority: 'routine', items: 1 }),
    step('rx-00506', 'priority-set', '20T16:30', { front: true }, 'pharmacy-manager'),
  ];
  const order = sortQueue([...deriveRequests(ev).values()], Date.parse(NOW), OFF).map((r) => r.id);
  assert.deepEqual(order, ['rx-00506', 'rx-00504', 'rx-00503', 'rx-00502', 'rx-00501', 'rx-00505']);
});
