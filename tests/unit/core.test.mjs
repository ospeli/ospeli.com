import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Core } from '../../web/app/core/core.js';
import { MemoryAdapter } from '../../web/app/core/db.js';
import { ROLES, validateEntity, validateEvent } from '../../web/app/core/model.js';
import { canonical, verifyChain, GENESIS } from '../../web/app/core/audit.js';

const fixedClock = () => { let t = Date.parse('2026-11-01T08:00:00Z'); return () => new Date(t += 1000); };
const open = () => Core.open({ adapter: new MemoryAdapter(), clock: fixedClock() });

const tree = [
  { id: 'site-a', type: 'site', name: 'Site A' },
  { id: 'dept-med', type: 'department', name: 'Medicine', parentId: 'site-a' },
  { id: 'ward-1', type: 'ward', name: 'Ward 1', parentId: 'dept-med' },
  { id: 'bed-1-01', type: 'bed', name: 'Bed 1', parentId: 'ward-1' },
];

test('the six build-month roles exist', () => {
  assert.deepEqual(ROLES.map((r) => r.name), ['Ward nurse', 'Bed manager', 'Estates tech', 'A&E nurse in charge', 'Ops manager', 'COO']);
});

test('entity validation rejects bad ids, types and names', () => {
  assert.deepEqual(validateEntity({ id: 'ok-1', type: 'ward', name: 'W' }), []);
  assert.ok(validateEntity({ id: 'Bad Id', type: 'ward', name: 'W' }).length);
  assert.ok(validateEntity({ id: 'x', type: 'spaceship', name: 'W' }).length);
  assert.ok(validateEntity({ id: 'x', type: 'ward', name: ' ' }).length);
});

test('event validation needs a dotted type, subject and known role', () => {
  assert.deepEqual(validateEvent({ type: 'bed.vacated', subject: 'bed-1', actorRole: 'ward-nurse' }), []);
  assert.ok(validateEvent({ type: 'vacated', subject: 'bed-1', actorRole: 'ward-nurse' }).length);
  assert.ok(validateEvent({ type: 'bed.vacated', subject: '', actorRole: 'ward-nurse' }).length);
  assert.ok(validateEvent({ type: 'bed.vacated', subject: 'b', actorRole: 'surgeon-general' }).length);
  assert.ok(validateEvent({ type: 'bed.vacated', subject: 'b', actorRole: 'system', at: 'not a date' }).length);
});

test('entities are stored, versioned and audited', async () => {
  const core = await open();
  for (const e of tree) await core.putEntity(e, 'bed-manager');
  const bed = await core.getEntity('bed-1-01');
  assert.equal(bed.version, 1);
  const updated = await core.putEntity({ ...tree[3], name: 'Bed 1A' }, 'bed-manager');
  assert.equal(updated.version, 2);
  assert.equal((await core.children('ward-1', 'bed')).length, 1);
  const log = await core.auditLog();
  assert.equal(log.length, 5);
  assert.equal(log[4].action, 'entity.updated');
  assert.equal(log[4].actorRole, 'bed-manager');
});

test('the hospital model refuses orphans, wrong parents and type changes', async () => {
  const core = await open();
  await assert.rejects(core.putEntity({ id: 'bed-x', type: 'bed', name: 'Bed' }, 'system'), /needs a parent/);
  await assert.rejects(core.putEntity({ id: 'bed-x', type: 'bed', name: 'Bed', parentId: 'nope' }, 'system'), /not found/);
  await core.putEntity(tree[0], 'system');
  await assert.rejects(core.putEntity({ id: 'bed-x', type: 'bed', name: 'Bed', parentId: 'site-a' }, 'system'), /cannot sit under/);
  await assert.rejects(core.putEntity({ id: 'site-a', type: 'ward', name: 'X', parentId: 'site-a' }, 'system'), /type cannot change|cannot sit/);
  await assert.rejects(core.putEntity(tree[0], 'hacker'), /unknown actor role/);
});

test('bulk load accepts parents defined in the same batch', async () => {
  const core = await open();
  assert.equal(await core.putEntities([...tree].reverse(), 'system'), 4);
  assert.equal((await core.listEntities('bed')).length, 1);
  const log = await core.auditLog();
  assert.equal(log.length, 1);
  assert.equal(log[0].detail.count, 4);
  await assert.rejects(core.putEntities([tree[0], tree[0]], 'system'), /duplicate/);
});

test('the event log is append-only, ordered and filterable', async () => {
  const core = await open();
  assert.equal(typeof core.updateEvent, 'undefined');
  assert.equal(typeof core.deleteEvent, 'undefined');
  const a = await core.appendEvent({ type: 'bed.vacated', subject: 'bed-1-01', actorRole: 'ward-nurse', at: '2026-11-01T09:00:00Z' });
  const b = await core.appendEvent({ type: 'bed.cleaned', subject: 'bed-1-01', actorRole: 'ward-nurse', at: '2026-11-01T09:40:00Z', data: { minutes: 40 } });
  await core.appendEvent({ type: 'bed.vacated', subject: 'bed-1-02', actorRole: 'ward-nurse', at: '2026-11-02T09:00:00Z' });
  assert.deepEqual([a.seq, b.seq], [1, 2]);
  assert.equal(b.data.minutes, 40);
  assert.equal((await core.events({ type: 'bed.vacated' })).length, 2);
  assert.equal((await core.events({ subject: 'bed-1-01' })).length, 2);
  assert.equal((await core.events({ since: '2026-11-02T00:00:00Z' })).length, 1);
  assert.equal((await core.events({ type: ['bed.vacated', 'bed.cleaned'], until: '2026-11-02T00:00:00Z' })).length, 2);
  await assert.rejects(core.appendEvent({ type: 'nope', subject: 'x', actorRole: 'coo' }), /invalid event/);
});

test('concurrent appends keep a gap-free sequence', async () => {
  const core = await open();
  const recs = await Promise.all(Array.from({ length: 25 }, (_, i) => core.appendEvent({ type: 'queue.arrived', subject: `p-${i}`, actorRole: 'ae-nic' })));
  assert.deepEqual(recs.map((r) => r.seq).sort((x, y) => x - y), Array.from({ length: 25 }, (_, i) => i + 1));
});

test('a failed write does not jam later writes', async () => {
  const core = await open();
  await assert.rejects(core.appendEvent({ type: 'bad', subject: 'x', actorRole: 'coo' }));
  const ok = await core.appendEvent({ type: 'bed.vacated', subject: 'x', actorRole: 'coo' });
  assert.equal(ok.seq, 1);
});

test('canonical JSON ignores key order', () => {
  assert.equal(canonical({ b: 1, a: { d: [1, 2], c: null } }), canonical({ a: { c: null, d: [1, 2] }, b: 1 }));
});

test('the audit chain verifies and detects tampering', async () => {
  const core = await open();
  await core.record('coo', 'report.viewed', 'kpi-occupancy');
  await core.record('ops-manager', 'role.changed', null, { to: 'ops-manager' });
  await core.record('coo', 'report.viewed', 'kpi-alos');
  assert.deepEqual(await core.verifyAudit(), { ok: true });
  const log = await core.auditLog();
  assert.equal(log[0].prev, GENESIS);
  const edited = structuredClone(log); edited[1].actorRole = 'coo';
  assert.equal((await verifyChain(edited)).ok, false);
  const dropped = [log[0], log[2]];
  assert.equal((await verifyChain(dropped)).ok, false);
});

test('export then import round-trips and is audited', async () => {
  const core = await open();
  await core.putEntities(tree, 'system');
  await core.appendEvent({ type: 'bed.vacated', subject: 'bed-1-01', actorRole: 'ward-nurse' });
  const dump = await core.exportData();
  assert.equal(dump.format, 'ospeli-export');
  assert.equal(dump.synthetic, true);
  const copy = JSON.parse(JSON.stringify(dump));

  const other = await open();
  await other.appendEvent({ type: 'bed.cleaned', subject: 'old', actorRole: 'ward-nurse' });
  const res = await other.importData(copy, 'ops-manager');
  assert.deepEqual(res, { entities: 4, events: 1 });
  assert.equal((await other.events()).length, 1);
  assert.equal((await other.events())[0].subject, 'bed-1-01');
  const log = await other.auditLog();
  assert.equal(log[log.length - 1].action, 'data.imported');
  assert.deepEqual(await other.verifyAudit(), { ok: true });
  const next = await other.appendEvent({ type: 'bed.cleaned', subject: 'bed-1-01', actorRole: 'ward-nurse' });
  assert.equal(next.seq, 2);
});

test('a bad import file changes nothing', async () => {
  const core = await open();
  await core.putEntities(tree, 'system');
  const dump = await core.exportData();
  const before = await core.exportData();

  await assert.rejects(core.importData({ hello: 'world' }, 'coo'), /not an Ospeli export/);
  const tampered = structuredClone(dump); tampered.audit[0].detail.count = 99;
  await assert.rejects(core.importData(tampered, 'coo'), /audit trail broken/);
  const orphan = structuredClone(dump); orphan.entities = orphan.entities.filter((e) => e.id !== 'ward-1');
  await assert.rejects(core.importData(orphan, 'coo'), /parent ward-1 missing/);
  const gap = structuredClone(dump); gap.events = [{ seq: 5, type: 'bed.vacated', subject: 'x', actorRole: 'coo', at: '2026-11-01T00:00:00Z' }];
  await assert.rejects(core.importData(gap, 'coo'), /sequence broken/);

  const after = await core.exportData();
  assert.deepEqual({ ...after, exportedAt: 0 }, { ...before, exportedAt: 0 });
});

test('settings are kept separately from the audited record', async () => {
  const core = await open();
  assert.equal(await core.getMeta('role', 'ward-nurse'), 'ward-nurse');
  await core.setMeta('role', 'coo');
  assert.equal(await core.getMeta('role'), 'coo');
  assert.equal((await core.auditLog()).length, 0);
});

test('reset empties the device', async () => {
  const core = await open();
  await core.putEntities(tree, 'system');
  await core.reset();
  assert.equal((await core.listEntities()).length, 0);
  assert.equal((await core.auditLog()).length, 0);
  const e = await core.appendEvent({ type: 'bed.vacated', subject: 'x', actorRole: 'coo' });
  assert.equal(e.seq, 1);
});
