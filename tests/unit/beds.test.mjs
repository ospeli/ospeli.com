import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveBoard, countStates, bedActions, actionEvents, since, encounterLabel } from '../../web/app/core/beds.js';
import { generateHospital } from '../../web/app/core/generator.js';
import { validateEvent } from '../../web/app/core/model.js';
import { computeKpi } from '../../web/app/core/kpi.js';

const beds = [{ id: 'b1', type: 'bed', name: 'Bed 01', parentId: 'w1' }, { id: 'b2', type: 'bed', name: 'Bed 02', parentId: 'w1' }];
let n = 0;
const ev = (type, subject, data = null, at = `2026-11-01T${String(8 + n).padStart(2, '0')}:00:00.000Z`) => ({ seq: ++n, type, subject, actorRole: 'ward-nurse', at, data });

test('a bed walks the full cycle from the event log', () => {
  n = 0;
  const log = [];
  const state = () => deriveBoard(beds, log).beds.get('b1').state;
  assert.equal(state(), 'available');
  log.push(ev('ae.decision-to-admit', 'e1'), ev('bed.requested', 'e1', { wardId: 'w1' }));
  assert.equal(deriveBoard(beds, log).waiting.length, 1);
  log.push(ev('bed.allocated', 'b1', { encounter: 'e1' }));
  assert.equal(state(), 'allocated');
  assert.equal(deriveBoard(beds, log).waiting[0].allocatedBed, 'b1');
  log.push(ev('patient.admitted', 'e1', { bedId: 'b1', wardId: 'w1' }));
  assert.equal(state(), 'occupied');
  assert.equal(deriveBoard(beds, log).waiting.length, 0, 'admitted patients leave the queue');
  log.push(ev('patient.expected-discharge', 'e1', { bedId: 'b1', expectedAt: '2026-11-01T20:00:00.000Z' }));
  assert.equal(state(), 'expected-discharge');
  log.push(ev('patient.expected-discharge-cancelled', 'e1', { bedId: 'b1' }));
  assert.equal(state(), 'occupied');
  log.push(ev('patient.discharged', 'e1', { bedId: 'b1' }), ev('bed.vacated', 'b1', { encounter: 'e1' }));
  assert.equal(state(), 'vacated');
  log.push(ev('bed.clean-started', 'b1'));
  assert.equal(state(), 'cleaning');
  log.push(ev('bed.cleaned', 'b1'));
  assert.equal(state(), 'available');
  log.push(ev('bed.out-of-service', 'b1', { reason: 'Electrical' }));
  const b = deriveBoard(beds, log).beds.get('b1');
  assert.equal(b.state, 'out-of-service');
  assert.equal(b.reason, 'Electrical');
  log.push(ev('bed.back-in-service', 'b1'));
  assert.equal(state(), 'available');
  assert.deepEqual(countStates(deriveBoard(beds, log).beds.values()).available, 2);
});

test('cancelling an allocation frees the bed and puts the patient back in the queue', () => {
  n = 0;
  const log = [ev('bed.requested', 'e2', { wardId: 'w1' }), ev('bed.allocated', 'b2', { encounter: 'e2' }), ev('bed.allocation-cancelled', 'b2', { encounter: 'e2' })];
  const board = deriveBoard(beds, log);
  assert.equal(board.beds.get('b2').state, 'available');
  assert.equal(board.waiting[0].allocatedBed, null);
});

test('actions produce valid events and follow the allowed next steps', () => {
  const at = '2026-11-01T10:00:00.000Z';
  const occupied = { id: 'b1', state: 'occupied', encounter: 'e1' };
  assert.deepEqual(bedActions(occupied), ['expect-discharge', 'vacate']);
  const out = actionEvents('vacate', occupied, 'w1', 'ward-nurse', at);
  assert.deepEqual(out.map((e) => e.type), ['patient.discharged', 'bed.vacated']);
  for (const e of out) assert.deepEqual(validateEvent(e), []);
  // Finishing a clean straight from "vacated" logs both steps, so turnaround stays measurable.
  assert.deepEqual(actionEvents('finish-clean', { id: 'b1', state: 'vacated' }, 'w1', 'ward-nurse', at).map((e) => e.type), ['bed.clean-started', 'bed.cleaned']);
  assert.throws(() => actionEvents('out-of-service', { id: 'b1', state: 'available' }, 'w1', 'ward-nurse', at), /reason/);
  assert.throws(() => actionEvents('allocate', { id: 'b1', state: 'available' }, 'w1', 'bed-manager', at), /encounter/);
  for (const s of ['occupied', 'expected-discharge', 'vacated', 'cleaning', 'available', 'allocated', 'out-of-service']) assert.ok(bedActions({ state: s }).length > 0, s);
});

test('the board agrees with the occupancy KPI on the synthetic hospital', () => {
  const end = '2026-11-06T18:00:00.000Z';
  const g = generateHospital({ end });
  const bedEntities = g.entities.filter((e) => e.type === 'bed');
  const events = g.events.map((e, i) => ({ ...e, seq: i + 1 }));
  const board = deriveBoard(bedEntities, events);
  const c = countStates(board.beds.values());
  const total = Object.values(c).reduce((a, b) => a + b, 0);
  assert.equal(total, 120);
  const occ = computeKpi('occupancy', events, { until: '2026-11-07T00:00:00.000Z', bedCount: 120 });
  assert.equal(c.occupied + c['expected-discharge'], occ.numerator);
  assert.ok(c['expected-discharge'] > 0, 'some beds are flagged to go home');
  assert.ok(board.waiting.length >= 3 && board.waiting.length <= 6, 'a few patients are waiting for a bed');
});

test('durations and labels', () => {
  const now = Date.parse('2026-11-01T12:00:00Z');
  assert.equal(since('2026-11-01T11:25:00Z', now), '35 min');
  assert.equal(since('2026-11-01T08:55:00Z', now), '3 h 05 min');
  assert.equal(since('2026-10-29T08:00:00Z', now), '3 d 4 h');
  assert.equal(encounterLabel('enc-004512'), 'Patient 4512');
});
