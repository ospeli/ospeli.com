import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Core } from '../../web/app/core/core.js';
import { MemoryAdapter } from '../../web/app/core/db.js';
import { ROLES, validateEntity, validateEvent } from '../../web/app/core/model.js';
import { readFileSync } from 'node:fs';
import { canonical, verifyChain, makeEntry, GENESIS, SELF_CHECK_CASES } from '../../web/app/core/audit.js';

const fixedClock = () => { let t = Date.parse('2026-11-01T08:00:00Z'); return () => new Date(t += 1000); };
const open = () => Core.open({ adapter: new MemoryAdapter(), clock: fixedClock() });

const tree = [
  { id: 'site-a', type: 'site', name: 'Site A' },
  { id: 'dept-med', type: 'department', name: 'Medicine', parentId: 'site-a' },
  { id: 'ward-1', type: 'ward', name: 'Ward 1', parentId: 'dept-med' },
  { id: 'bed-1-01', type: 'bed', name: 'Bed 1', parentId: 'ward-1' },
];

test('the six build-month roles exist', () => {
  assert.deepEqual(ROLES.map((r) => r.name), ['Ward nurse', 'Patient flow coordinator', 'Facilities technician', 'Emergency department nurse in charge', 'Operations manager', 'COO']);
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
  assert.equal(await core.eventCount(), 3);
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

test('two tabs on one device never overwrite each other (issue #2)', async () => {
  const shared = new MemoryAdapter();
  const clock = fixedClock();
  const a = await Core.open({ adapter: shared, clock });
  const b = await Core.open({ adapter: shared, clock });
  // Each "tab" has a stale tail after the other writes.
  await a.record('bed-manager', 'role.changed');
  await b.record('coo', 'role.changed');
  await a.record('estates-tech', 'role.changed');
  await b.appendEvent({ type: 'bed.vacated', subject: 'bed-1', actorRole: 'ward-nurse' });
  await a.appendEvent({ type: 'bed.cleaned', subject: 'bed-1', actorRole: 'ward-nurse' });
  await b.appendEvents([{ type: 'bed.allocated', subject: 'bed-1', actorRole: 'bed-manager' }, { type: 'patient.admitted', subject: 'e-1', actorRole: 'ward-nurse' }], 'bed-manager');
  await Promise.all([a.record('coo', 'x.one'), b.record('coo', 'x.two'), a.record('coo', 'x.three')]);
  const audit = await shared.getAll('audit');
  assert.deepEqual(await verifyChain(audit), { ok: true });
  assert.equal(audit.length, 7); // 3 roles, 1 bulk-events entry, 3 concurrent
  const events = await shared.getAll('events');
  assert.deepEqual(events.map((e) => e.seq), [1, 2, 3, 4]);
  assert.deepEqual(events.map((e) => e.type), ['bed.vacated', 'bed.cleaned', 'bed.allocated', 'patient.admitted']);
});

test('adapters refuse duplicate log keys, all or nothing', async () => {
  const m = new MemoryAdapter();
  await m.addMany('events', [{ seq: 1 }, { seq: 2 }]);
  await assert.rejects(m.addMany('events', [{ seq: 3 }, { seq: 2 }]), { name: 'ConstraintError' });
  assert.equal(await m.count('events'), 2);
  assert.equal((await m.last('events')).seq, 2);
});

// Issue #79: the public table of what the self-check catches must be what the code does.
test('the self-check catches an edit without re-hashing and nothing else, as the published table says', async () => {
  const trail = [];
  for (let i = 0; i < 6; i += 1) trail.push(await makeEntry(trail[i - 1], { at: `2026-11-01T08:00:0${i}Z`, actorRole: 'coo', actorType: 'human', action: 'role.changed', detail: { n: i } }));
  assert.deepEqual(await verifyChain(trail), { ok: true });
  assert.deepEqual(SELF_CHECK_CASES.map((c) => [c.id, c.caught]), [['edit', true], ['edit-rehash', false], ['tail', false], ['middle', false], ['empty', false]]);
  for (const c of SELF_CHECK_CASES) {
    const changed = await c.apply(structuredClone(trail));
    assert.notDeepEqual(changed, trail, `${c.id}: the case must change the trail`);
    assert.equal((await verifyChain(changed)).ok, !c.caught, `${c.id}: ${c.change}`);
  }
  // The site server's README publishes the same rows with the same results.
  const readme = readFileSync(new URL('../../tools/ospeli-server/README.md', import.meta.url), 'utf8');
  for (const c of SELF_CHECK_CASES) assert.ok(readme.includes(`| ${c.change} | ${c.caught ? 'Caught' : 'Not caught'} |`), `README row for ${c.id}`);
});

test('a reset or an import marks the history as replaced; a first trail is not marked (issue #79)', async () => {
  const core = await open();
  await core.record('coo', 'role.changed', null, { to: 'coo' });
  let check = await core.auditCheck();
  assert.equal(check.ok, true); assert.equal(check.entries, 1); assert.equal(check.replaced, null);
  const file = await core.exportData();
  await core.reset('coo');
  check = await core.auditCheck();
  assert.equal(check.entries, 0);
  assert.equal(check.replaced.by, 'reset'); assert.match(check.replaced.at, /^2026-11-01T/);
  // A second reset of an empty trail keeps the mark.
  await core.reset('coo');
  assert.equal((await core.auditCheck()).replaced.by, 'reset');
  const other = await open();
  await other.reset(); // nothing to replace on a new device
  assert.equal((await other.auditCheck()).replaced, null);
  await other.importData(file, 'coo');
  check = await other.auditCheck();
  assert.equal(check.ok, true); assert.equal(check.replaced.by, 'import'); assert.equal(check.entries, 2);
});
