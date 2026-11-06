import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KPIS, computeKpi, formatKpi, meetsTarget, kpiById, openWorkOrders } from '../../web/app/core/kpi.js';
import { generateHospital } from '../../web/app/core/generator.js';

let seq = 0;
const ev = (at, type, subject, data = null) => ({ seq: ++seq, at: `2026-11-0${at}Z`, type, subject, actorRole: 'system', data });

// A tiny hand-checked hospital: 4 beds, local time = UTC.
const E = [
  ev('1T08:00:00.000', 'ae.decision-to-admit', 'enc-1'),
  ev('1T10:00:00.000', 'patient.admitted', 'enc-1', { bedId: 'b1' }),          // 2 h decision to bed
  ev('1T11:00:00.000', 'patient.admitted', 'enc-2', { bedId: 'b2' }),          // elective
  ev('1T12:00:00.000', 'ae.decision-to-admit', 'enc-3'),
  ev('1T18:00:00.000', 'patient.admitted', 'enc-3', { bedId: 'b3' }),          // 6 h decision to bed
  ev('3T10:00:00.000', 'patient.discharged', 'enc-1', { bedId: 'b1' }),        // 2.0 days, before noon
  ev('3T10:10:00.000', 'bed.vacated', 'b1'),
  ev('3T11:10:00.000', 'bed.cleaned', 'b1'),                                   // 60 min
  ev('4T15:00:00.000', 'patient.discharged', 'enc-2', { bedId: 'b2' }),        // 3.17 days, afternoon
  ev('4T15:00:00.000', 'bed.vacated', 'b2'),
  ev('4T16:30:00.000', 'bed.cleaned', 'b2'),                                   // 90 min
  ev('5T09:00:00.000', 'asset.fault-reported', 'asset-x', { workOrder: 'wo-1', priority: 'urgent' }),
  ev('5T09:30:00.000', 'asset.fault-reported', 'asset-y', { workOrder: 'wo-2', priority: 'routine' }),
  ev('5T10:00:00.000', 'asset.fault-reported', 'asset-z', { workOrder: 'wo-3', priority: 'high' }),
  ev('5T11:00:00.000', 'workorder.completed', 'wo-3'),
];
const opts = { since: '2026-11-01T00:00:00.000Z', until: '2026-11-05T20:00:00.000Z', bedCount: 4, utcOffsetMinutes: 0 };
const val = (id, o = opts, events = E) => computeKpi(id, events, o).value;

test('every KPI has a full definition', () => {
  assert.equal(KPIS.length, 7);
  for (const k of KPIS) {
    for (const f of ['id', 'name', 'unit', 'numerator', 'denominator', 'exclusions', 'source', 'owner', 'targetText']) {
      assert.ok(k[f], `${k.id} is missing ${f}`);
    }
    assert.ok('target' in k);
  }
});

test('occupancy is a point-in-time census', () => {
  assert.equal(val('occupancy'), 25); // only enc-3 left in a bed
  assert.equal(val('occupancy', { ...opts, until: '2026-11-02T00:00:00.000Z' }), 75);
  assert.equal(val('occupancy', { ...opts, bedCount: 0 }), null);
});

test('average length of stay counts only discharges in the period', () => {
  assert.ok(Math.abs(val('alos') - (2 + (3 + 4 / 24)) / 2) < 1e-9);
  assert.ok(Math.abs(val('alos', { ...opts, since: '2026-11-04T00:00:00.000Z' }) - (3 + 4 / 24)) < 1e-9);
});

test('discharges before noon uses local time', () => {
  assert.equal(val('discharges-before-noon'), 50);
  // At UTC-4 the 10:00Z discharge is 06:00 and the 15:00Z one is 11:00: both before noon.
  assert.equal(val('discharges-before-noon', { ...opts, utcOffsetMinutes: -240 }), 100);
  // At UTC+3 neither is before noon.
  assert.equal(val('discharges-before-noon', { ...opts, utcOffsetMinutes: 180 }), 0);
});

test('decision to bed is the median for A&E admissions only', () => {
  assert.equal(val('decision-to-bed'), 4); // median of 2 h and 6 h; the elective is excluded
  assert.equal(computeKpi('decision-to-bed', E, opts).denominator, 2);
});

test('bed turnaround is the median vacated-to-clean time', () => {
  assert.equal(val('bed-turnaround'), 75);
});

test('open and overdue work orders', () => {
  assert.equal(val('open-work-orders'), 2);
  assert.equal(val('overdue-work-orders'), 1); // urgent wo-1 is 11 h old; routine wo-2 is within 72 h
  assert.deepEqual(openWorkOrders(E, opts.until).map((w) => w.id), ['wo-1', 'wo-2']);
  assert.equal(val('overdue-work-orders', { ...opts, until: '2026-11-05T12:00:00.000Z' }), 0);
});

test('results do not depend on the order events were recorded in', () => {
  const shuffled = [...E].reverse();
  for (const k of KPIS) assert.deepEqual(computeKpi(k.id, shuffled, opts), computeKpi(k.id, E, opts), k.id);
});

test('empty logs give "No data", not zero or NaN', () => {
  for (const id of ['alos', 'discharges-before-noon', 'decision-to-bed', 'bed-turnaround']) {
    assert.equal(val(id, opts, []), null);
    assert.equal(formatKpi(kpiById(id), null), 'No data');
  }
  assert.throws(() => computeKpi('nope', E, opts), /unknown KPI/);
  assert.throws(() => computeKpi('alos', E, {}), /until is required/);
});

test('formatting and targets', () => {
  assert.equal(formatKpi(kpiById('occupancy'), 93.4), '93%');
  assert.equal(formatKpi(kpiById('alos'), 4.26), '4.3 days');
  assert.equal(formatKpi(kpiById('bed-turnaround'), 75), '75 min');
  assert.equal(formatKpi(kpiById('decision-to-bed'), 3.25), '3.3 h');
  assert.equal(meetsTarget(kpiById('occupancy'), 90), false);
  assert.equal(meetsTarget(kpiById('discharges-before-noon'), 40), true);
  assert.equal(meetsTarget(kpiById('alos'), 4), null);
});

test('on the synthetic hospital every KPI has a plausible value', () => {
  const end = '2026-11-06T04:00:00.000Z';
  const g = generateHospital({ end });
  const o = { since: new Date(Date.parse(end) - 7 * 864e5).toISOString(), until: end, bedCount: 120, utcOffsetMinutes: -240 };
  const v = Object.fromEntries(KPIS.map((k) => [k.id, computeKpi(k.id, g.events, o).value]));
  assert.ok(v.occupancy > 70 && v.occupancy <= 100, `occupancy ${v.occupancy}`);
  assert.ok(v.alos > 1 && v.alos < 15, `alos ${v.alos}`);
  assert.ok(v['discharges-before-noon'] > 3 && v['discharges-before-noon'] < 40);
  assert.ok(v['decision-to-bed'] > 1 && v['decision-to-bed'] < 10);
  assert.ok(v['bed-turnaround'] > 30 && v['bed-turnaround'] < 180);
  assert.ok(v['open-work-orders'] >= 0 && v['overdue-work-orders'] <= v['open-work-orders']);
});
