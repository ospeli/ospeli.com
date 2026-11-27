// Before and after a change (#189 item 6; lead's specification, module crew night 11): a person
// marks "we changed how this works after walk N" on a walked map. Walks 1 to N are before, later
// walks after; 0 clears the mark. People only, no free text, a revision check and an audit entry,
// as the other map writes. ospeli_maps_get returns the mark (null when none).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Core } from '../../web/app/core/core.js';
import { MemoryAdapter } from '../../web/app/core/db.js';
import { runCommand, commandByName, CommandError } from '../../web/app/core/commands.js';
import { validate } from '../../web/app/core/schema.js';

const human = { type: 'human', role: 'outpatient-manager' };
const code = (c) => (err) => err instanceof CommandError && err.code === c;
const ok = (name, out) => assert.deepEqual(validate(commandByName(name).output, out, 'output'), []);

async function setup() {
  let t = Date.parse('2026-11-16T09:00:00.000Z');
  const core = await Core.open({ adapter: new MemoryAdapter(), clock: () => new Date(t) });
  const tick = (s) => { t += s * 1000; };
  const tap = (name, input = {}, actor = human) => runCommand(core, name, input, actor);
  // One walk of a three-step clinic visit (synthetic names and times).
  const walk = async (mapId = null) => {
    await tap('ospeli_walks_start', mapId ? { mapId, guidanceSeen: true } : { title: 'Morning clinic visit', guidanceSeen: true });
    for (const [i, [name, role]] of [['Arrived', 'Patient'], ['Seen by nurse', 'Clinic nurse'], ['Left', 'Patient']].entries()) {
      tick(60 + i * 120); await tap('ospeli_walks_step_start'); tick(120); await tap('ospeli_walks_step_done');
      if (!mapId) await tap('ospeli_walks_step_name', { name, role });
    }
    tick(10);
    return (await tap('ospeli_walks_finish')).mapId;
  };
  return { core, tap, walk, tick };
}
const get = (x, mapId) => x.tap('ospeli_maps_get', { mapId, format: 'short' });

test('the command is a people-only map write with a revision check, an example and a closed input', () => {
  const c = commandByName('ospeli_maps_change_set');
  assert.equal(c.kind, 'write');
  assert.equal(c.approval, true);
  assert.equal(c.agents, false);
  assert.deepEqual(c.roles, commandByName('ospeli_maps_step_update').roles);
  assert.equal(c.input.additionalProperties, false);
  assert.deepEqual(c.input.required, ['mapId', 'afterWalk']);
  assert.deepEqual(Object.keys(c.input.properties).sort(), ['afterWalk', 'expectedRevision', 'mapId']);
  assert.ok(c.example?.input && validate(c.input, c.example.input).length === 0);
  assert.ok(commandByName('ospeli_maps_get').output.properties.changeAfterWalk, 'ospeli_maps_get says it returns the mark');
});

test('a person marks a change after walk 2, moves it and clears it; ospeli_maps_get returns it; the audit says marked and cleared', async () => {
  const x = await setup();
  const mapId = await x.walk(); await x.walk(mapId); await x.walk(mapId);
  let m = await get(x, mapId);
  assert.equal(m.changeAfterWalk, null, 'no mark yet');
  ok('ospeli_maps_get', m);
  const out = await x.tap('ospeli_maps_change_set', { mapId, afterWalk: 2, expectedRevision: m.revision });
  ok('ospeli_maps_change_set', out);
  assert.equal(out.status, 'done'); assert.equal(out.revision, m.revision + 1);
  m = await get(x, mapId);
  assert.equal(m.changeAfterWalk, 2);
  ok('ospeli_maps_get', m);
  // The walk count itself: the next walk is the first "after" walk.
  await x.tap('ospeli_maps_change_set', { mapId, afterWalk: 3, expectedRevision: m.revision });
  m = await get(x, mapId);
  assert.equal(m.changeAfterWalk, 3);
  await x.tap('ospeli_maps_change_set', { mapId, afterWalk: 0, expectedRevision: m.revision });
  m = await get(x, mapId);
  assert.equal(m.changeAfterWalk, null, '0 clears the mark');
  ok('ospeli_maps_get', m);
  const audit = (await x.core.auditLog()).filter((a) => a.action.startsWith('map.change'));
  assert.deepEqual(audit.map((a) => [a.action, a.target, a.detail?.afterWalk ?? null]), [['map.change-marked', mapId, 2], ['map.change-marked', mapId, 3], ['map.change-cleared', mapId, null]]);
  assert.ok(audit.every((a) => a.actorType === 'human'));
  // A later walk keeps the mark where it was.
  await x.tap('ospeli_maps_change_set', { mapId, afterWalk: 1, expectedRevision: m.revision });
  await x.walk(mapId);
  assert.equal((await get(x, mapId)).changeAfterWalk, 1);
});

test('refused: a number above the walk count, a negative number, a fraction, a stale revision, free text, and any number above 0 on a map with no walks', async () => {
  const x = await setup();
  const mapId = await x.walk(); await x.walk(mapId);
  const m = await get(x, mapId);
  await assert.rejects(x.tap('ospeli_maps_change_set', { mapId, afterWalk: 3, expectedRevision: m.revision }), code('invalid-input'));
  await assert.rejects(x.tap('ospeli_maps_change_set', { mapId, afterWalk: -1, expectedRevision: m.revision }), code('invalid-input'));
  await assert.rejects(x.tap('ospeli_maps_change_set', { mapId, afterWalk: 1.5, expectedRevision: m.revision }), code('invalid-input'));
  await assert.rejects(x.tap('ospeli_maps_change_set', { mapId, afterWalk: 1, expectedRevision: m.revision, note: 'new booking times' }), code('invalid-input'));
  await assert.rejects(x.tap('ospeli_maps_change_set', { mapId, afterWalk: 1, expectedRevision: m.revision - 1 }), code('conflict'));
  await assert.rejects(x.tap('ospeli_maps_change_set', { mapId: 'map-999', afterWalk: 1 }), code('not-found'));
  assert.equal((await get(x, mapId)).changeAfterWalk, null, 'nothing was stored');
  assert.equal((await get(x, mapId)).revision, m.revision);
  // A map typed by hand has no walks.
  const typed = (await x.tap('ospeli_maps_create', { from: 'blank' })).mapId;
  const t = await get(x, typed);
  assert.equal(t.changeAfterWalk, null);
  await assert.rejects(x.tap('ospeli_maps_change_set', { mapId: typed, afterWalk: 1, expectedRevision: t.revision }), code('invalid-input'));
  await x.tap('ospeli_maps_change_set', { mapId: typed, afterWalk: 0, expectedRevision: t.revision });
  assert.equal((await get(x, typed)).changeAfterWalk, null);
});

test('an agent is refused, even a listed one with access on; nothing is proposed or stored', async () => {
  const x = await setup();
  const mapId = await x.walk(); await x.walk(mapId);
  const ops = { type: 'human', role: 'ops-manager' };
  await x.tap('ospeli_agents_add', { name: 'map-helper', role: 'outpatient-manager', days: 30 }, ops);
  await x.tap('ospeli_agents_set_access', { allowed: true }, ops);
  const m = await get(x, mapId);
  await assert.rejects(x.tap('ospeli_maps_change_set', { mapId, afterWalk: 1, expectedRevision: m.revision }, { type: 'agent', role: 'outpatient-manager', agent: 'map-helper' }), code('forbidden'));
  assert.equal((await get(x, mapId)).changeAfterWalk, null);
  assert.equal((await x.tap('ospeli_proposals_list', { status: 'pending' }, ops)).proposals.filter((p) => p.command === 'ospeli_maps_change_set').length, 0);
});

test('an older map with no mark stored reads as null', async () => {
  const x = await setup();
  const mapId = await x.walk();
  await x.core.updateMeta('process-maps', (raw) => ({ ...raw, maps: raw.maps.map((mm) => { const { changeAfterWalk, ...rest } = mm; return rest; }) }));
  const m = await get(x, mapId);
  assert.equal(m.changeAfterWalk, null);
  ok('ospeli_maps_get', m);
});
