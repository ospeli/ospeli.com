import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateHospital, loadSyntheticHospital, rng, HOSPITAL_NAME, currentHour, setupUnfinished } from '../../web/app/core/generator.js';
import { validateEntity, validateEvent } from '../../web/app/core/model.js';
import { Core } from '../../web/app/core/core.js';
import { MemoryAdapter } from '../../web/app/core/db.js';

const END = '2026-11-06T04:00:00.000Z';
const g = generateHospital({ end: END });

test('the generator is reproducible for the same seed and end time', () => {
  const again = generateHospital({ end: END });
  assert.deepEqual(again, g);
  const other = generateHospital({ end: END, seed: 7 });
  assert.notDeepEqual(other.events, g.events);
  assert.deepEqual(other.entities, g.entities);
  assert.throws(() => generateHospital({}), /end time is required/);
});

test('rng is deterministic and in range', () => {
  const a = rng(1); const b = rng(1);
  const xs = Array.from({ length: 1000 }, () => a.next());
  assert.deepEqual(xs.slice(0, 5), Array.from({ length: 5 }, () => b.next()));
  assert.ok(xs.every((x) => x >= 0 && x < 1));
});

test('Example General Hospital: 3 sites, 6 wards, 120 beds, assets, roles and shifts', () => {
  const count = (t) => g.entities.filter((e) => e.type === t).length;
  assert.equal(count('site'), 3);
  assert.equal(count('ward'), 6);
  assert.equal(count('bed'), 120);
  assert.ok(count('department') >= 8);
  assert.ok(count('asset') >= 60);
  assert.equal(count('role'), 6);
  assert.equal(count('shift'), 2);
  assert.equal(g.entities.find((e) => e.id === 'site-main').hospital, HOSPITAL_NAME);
  for (const e of g.entities) assert.deepEqual(validateEntity(e), [], e.id);
});

test('events are valid, sorted, and none fall after the end time', () => {
  assert.ok(g.events.length > 5000);
  let prev = '';
  for (const ev of g.events) {
    assert.deepEqual(validateEvent(ev), []);
    assert.ok(ev.at >= prev, 'events out of order');
    assert.ok(ev.at <= END, `event after end: ${ev.at}`);
    prev = ev.at;
  }
  // Only the admissions of patients already in a bed at the start may predate the 30-day window.
  const start = new Date(Date.parse(END) - 30 * 864e5).toISOString();
  const early = g.events.filter((e) => e.at < start);
  assert.ok(early.every((e) => e.type === 'patient.admitted'), 'only start-of-window admissions predate the window');
  assert.ok(early.length > 80 && early.length <= 120);
});

test('no bed ever holds two patients, and each discharge follows an admission', () => {
  const inBed = new Map();
  const admittedAt = new Map();
  for (const ev of g.events) {
    if (ev.type === 'patient.admitted') {
      assert.ok(!inBed.has(ev.data.bedId), `${ev.data.bedId} double-booked at ${ev.at}`);
      inBed.set(ev.data.bedId, ev.subject);
      admittedAt.set(ev.subject, ev.at);
    }
    if (ev.type === 'patient.discharged') {
      assert.equal(inBed.get(ev.data.bedId), ev.subject);
      assert.ok(ev.at > admittedAt.get(ev.subject));
      inBed.delete(ev.data.bedId);
    }
  }
  const occupancy = inBed.size / 120;
  assert.ok(occupancy > 0.75 && occupancy <= 1, `occupancy at end ${occupancy}`);
});

test('A&E journeys run in order: arrived, triaged, seen, decision', () => {
  const steps = ['ae.arrived', 'ae.triaged', 'ae.seen'];
  const byEnc = new Map();
  for (const ev of g.events) if (ev.type.startsWith('ae.')) {
    if (!byEnc.has(ev.subject)) byEnc.set(ev.subject, []);
    byEnc.get(ev.subject).push(ev.type);
  }
  let complete = 0;
  for (const seq of byEnc.values()) {
    if (seq[0] !== 'ae.arrived') continue;
    // Patients still in A&E at the end time have a partial journey; it must still be in order.
    assert.deepEqual(seq.slice(0, 3), steps.slice(0, Math.min(3, seq.length)));
    if (seq.length >= 4) {
      assert.match(seq[3], /^ae\.decision-to-(admit|discharge)$/);
      complete++;
    }
  }
  assert.ok(complete > 1500);
});

test('patterns are plausible: few discharges before noon, turnaround under a few hours', () => {
  const dis = g.events.filter((e) => e.type === 'patient.discharged');
  const beforeNoon = dis.filter((e) => new Date(Date.parse(e.at) - 240 * 60e3).getUTCHours() < 12).length / dis.length;
  assert.ok(beforeNoon > 0.05 && beforeNoon < 0.35, `before-noon share ${beforeNoon}`);
  const vacated = new Map();
  const turnaround = [];
  for (const ev of g.events) {
    if (ev.type === 'bed.vacated') vacated.set(ev.subject, Date.parse(ev.at));
    if (ev.type === 'bed.cleaned' && vacated.has(ev.subject)) turnaround.push((Date.parse(ev.at) - vacated.get(ev.subject)) / 60e3);
  }
  turnaround.sort((a, b) => a - b);
  const median = turnaround[Math.floor(turnaround.length / 2)];
  assert.ok(median > 30 && median < 180, `median turnaround ${median} min`);
});

test('no person names: subjects are ids, and only roles act', () => {
  for (const ev of g.events) {
    assert.match(ev.subject, /^(enc|wo|asset|ward)-[a-z0-9-]+$/);
    assert.ok(!('name' in (ev.data || {})));
  }
});

test('loads into the core with an intact audit trail', async () => {
  const core = await Core.open({ adapter: new MemoryAdapter() });
  const res = await loadSyntheticHospital(core, { end: END });
  assert.equal(res.entities, g.entities.length);
  assert.equal((await core.events()).length, g.events.length);
  assert.equal((await core.listEntities('bed')).length, 120);
  assert.deepEqual(await core.verifyAudit(), { ok: true });
  assert.equal(await core.getMeta('synthetic'), true);
  assert.equal((await core.getMeta('generator')).seed, res.meta.seed);
});

test('currentHour floors to the hour', () => {
  assert.equal(currentHour(Date.parse('2026-11-06T04:37:12.345Z')), '2026-11-06T04:00:00.000Z');
});

test('an interrupted setup is detected, a finished one is not (issue #1)', async () => {
  const core = await Core.open({ adapter: new MemoryAdapter() });
  assert.equal(await setupUnfinished(core), false, 'an empty device is not unfinished');
  await loadSyntheticHospital(core, { end: END });
  assert.equal(await core.getMeta('setup'), 'done');
  assert.equal(await setupUnfinished(core), false);
  await core.setMeta('setup', 'started');
  assert.equal(await setupUnfinished(core), true);
  // Devices left half loaded by older builds: beds, no events, no generator record.
  const old = await Core.open({ adapter: new MemoryAdapter() });
  await old.putEntities(g.entities, 'system');
  assert.equal(await setupUnfinished(old), true);
});
