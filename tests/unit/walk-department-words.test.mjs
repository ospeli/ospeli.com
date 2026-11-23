// Walk-first week, Builder night 1 (ospeli/ospeli docs/briefs/2026-11-22-walk-first.md, parts c and d):
// the walk's step and role words come from the department chosen on the device, a walk says what
// it follows, and it can be renamed. The commands run with no screen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Core } from '../../web/app/core/core.js';
import { MemoryAdapter } from '../../web/app/core/db.js';
import { runCommand } from '../../web/app/core/commands.js';
import { WALK_VOCAB, WALK_DEPARTMENTS, WALK_STEP_CHIPS, WALK_ROLE_CHIPS } from '../../web/app/core/walk.js';
import { DEPARTMENTS } from '../../web/app/modules/departments.js';

const human = { type: 'human', role: 'radiographer' };
const code = (c) => (err) => err.code === c;
async function setup() {
  let t = Date.parse('2026-11-16T09:00:00.000Z');
  const core = await Core.open({ adapter: new MemoryAdapter(), clock: () => new Date(t) });
  const tick = (s) => { t += s * 1000; };
  const tap = (name, input = {}) => runCommand(core, name, input, human);
  const step = async (wait, work) => { tick(wait); await tap('ospeli_walks_step_start'); tick(work); return tap('ospeli_walks_step_done'); };
  return { core, tick, tap, step };
}

test('the walk departments are the app\'s departments, and every department word is short, has a role and passes the no-names check', async () => {
  assert.deepEqual(WALK_DEPARTMENTS, DEPARTMENTS.map((d) => d.id));
  for (const [id, v] of Object.entries(WALK_VOCAB)) {
    assert.ok(WALK_DEPARTMENTS.includes(id), id);
    assert.ok(v.steps.length >= 6 && v.steps.length <= 9, `${id}: ${v.steps.length} steps`);
    assert.ok(v.roles.length <= 6, `${id}: ${v.roles.length} roles`);
    assert.equal(new Set(v.steps.map((s) => s[0])).size, v.steps.length, `${id}: a step name is used once`);
    for (const [, role] of [...v.steps, ...v.later]) if (role) assert.ok(v.roles.includes(role), `${id}: ${role} is one of its roles`);
    // Every word is saved through the same command a person's tap uses: none is refused or asked about as a name.
    const x = await setup();
    await x.tap('ospeli_walks_start', { department: id, title: v.titles[0] });
    for (const t of v.titles) await x.tap('ospeli_walks_rename', { title: t });
    for (const [name, role] of [...v.steps, ...v.later]) { await x.step(5, 5); await x.tap('ospeli_walks_step_name', { name, role: role || v.roles[0] }); }
    for (const role of v.roles) await x.tap('ospeli_walks_step_name', { role });
  }
});

test('imaging: the next step in the usual order is offered with its usual role, a typed name is offered at once, and the department goes on the map', async () => {
  const x = await setup();
  const before = await x.tap('ospeli_walks_get', { department: 'imaging' });
  assert.deepEqual(before.stepChips, ['Arrived', 'Registered', 'Safety questions', 'Changed into gown', 'Cannula or prep', 'Scan', 'Recovery', 'Left', 'Report signed']);
  assert.deepEqual(before.roleChips, ['Reception', 'Imaging staff', 'Radiology nurse', 'Transport assistant', 'Radiologist', 'Patient']);
  assert.deepEqual(before.titles, ['Outpatient CT', 'Outpatient MRI', 'Walk-in X-ray', 'Inpatient ultrasound']);
  const started = await x.tap('ospeli_walks_start', { department: 'imaging', title: 'Outpatient CT', guidanceSeen: true });
  assert.equal(started.walk.department, 'imaging');
  assert.equal(started.walk.suggest, null, 'nothing to name yet');
  let w = (await x.step(30, 60)).walk;
  assert.deepEqual(w.suggest, { name: 'Arrived', role: 'Patient' });
  await x.tap('ospeli_walks_step_name', w.suggest);
  w = (await x.step(30, 60)).walk;
  assert.deepEqual(w.suggest, { name: 'Registered', role: 'Reception' });
  // The visit differed: the person names the step in words of their own. Nothing was saved by the offer.
  assert.equal(w.steps[1].named, false);
  await x.tap('ospeli_walks_step_name', { name: 'Sent to the other desk', role: 'Reception' });
  let chips = await x.tap('ospeli_walks_get');
  assert.equal(chips.stepChips[0], 'Sent to the other desk', 'a name typed once is offered straight away');
  assert.equal(chips.usualRoles.Scan, 'Imaging staff');
  // A step named out of order moves the offer on from there: Scan, then Recovery.
  await x.step(30, 60); await x.tap('ospeli_walks_step_name', { name: 'Scan', role: 'Imaging staff' });
  w = (await x.step(30, 60)).walk;
  assert.deepEqual(w.suggest, { name: 'Recovery', role: 'Radiology nurse' });
  chips = await x.tap('ospeli_walks_get');
  assert.deepEqual(chips.stepChips.slice(0, 3), ['Sent to the other desk', 'Recovery', 'Left'], 'the step offered comes first of the list, where it can be seen');
  await x.tap('ospeli_walks_step_name', w.suggest);
  await x.step(30, 60); await x.tap('ospeli_walks_step_name', { name: 'Left', role: 'Patient' });
  // After "Left" the list is used up: "Report signed" happens later and is never offered as next.
  w = (await x.step(30, 60)).walk;
  assert.equal(w.suggest, null);
  const done = await x.tap('ospeli_walks_finish');
  const m = await x.tap('ospeli_maps_get', { mapId: done.mapId });
  assert.equal(m.title, 'Outpatient CT');
  assert.equal(m.walk.department, 'imaging');
});

test('a walk with no department keeps the general words and offers nothing as next; a walk is renamed without touching its clock', async () => {
  const x = await setup();
  const got = await x.tap('ospeli_walks_get', {});
  assert.deepEqual(got.stepChips, WALK_STEP_CHIPS);
  assert.deepEqual(got.roleChips, WALK_ROLE_CHIPS);
  await assert.rejects(x.tap('ospeli_walks_rename', { title: 'Outpatient CT' }), code('not-found'));
  const started = await x.tap('ospeli_walks_start', { department: 'wards' });
  assert.equal(started.walk.title, 'Walk 1');
  const w = (await x.step(30, 60)).walk;
  assert.equal(w.suggest, null);
  const renamed = await x.tap('ospeli_walks_rename', { title: 'Discharge from a ward' });
  assert.equal(renamed.walk.title, 'Discharge from a ward');
  assert.deepEqual([renamed.walk.startedAt, renamed.walk.steps[0].workSec], [started.walk.startedAt, 60]);
  await assert.rejects(x.tap('ospeli_walks_rename', { title: 'Mr J. Smith' }), code('invalid-input'));
  await assert.rejects(x.tap('ospeli_walks_rename', {}), code('invalid-input'));
  await assert.rejects(x.tap('ospeli_walks_start', { department: 'radiology-east' }), code('invalid-input'));
  const audit = await x.core.auditLog();
  assert.ok(audit.some((a) => a.action === 'walk.renamed'));
  // A repeat walk carries its map's title.
  const { mapId } = await x.tap('ospeli_walks_finish');
  await x.tap('ospeli_walks_start', { mapId });
  await assert.rejects(x.tap('ospeli_walks_rename', { title: 'Something else' }), code('conflict'));
});
