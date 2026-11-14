// One vocabulary (ospeli/ospeli#82): the words people see changed, the ids did not. Data made
// before the change (old words inside stored role, asset, department and fault names) still loads
// and reads with the new words, and its stored history is not rewritten.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Core } from '../../web/app/core/core.js';
import { MemoryAdapter } from '../../web/app/core/db.js';
import { ROLES, roleById, currentWords } from '../../web/app/core/model.js';
import { generateHospital, HOSPITAL_NAME } from '../../web/app/core/generator.js';
import { runCommand, listCommands } from '../../web/app/core/commands.js';
import { KPIS } from '../../web/app/core/kpi.js';
import { MODULES } from '../../web/app/modules/registry.js';
import { ALL_FAULTS, TEAMS, deriveWorkOrders } from '../../web/app/core/workorders.js';

const END = '2026-11-06T18:00:00.000Z';
const clockFrom = (iso) => { let t = Date.parse(iso); return () => new Date(t += 1000); };
const human = (role) => ({ type: 'human', role });
// The old words. "Estates" is matched with its capital only: the trade id 'estates' stays.
const OLD = /\b[Bb]ed [Mm]anagers?\b|\b[Ee]states [Tt]ech(?:nician)?s?\b|\bA\s*&(?:amp;)?\s*E\b|\b[Oo]ps [Mm]anagers?\b|\b[Cc]all [Bb]ells?\b|\bEstates\b(?!-)/;
const oldIn = (x) => (JSON.stringify(x).match(OLD) || [null])[0];

// What a device loaded before the change holds: the same hospital, with the old words stored.
const OLD_ROLE_NAMES = { 'bed-manager': 'Bed manager', 'estates-tech': 'Estates tech', 'ae-nic': 'A&E nurse in charge', 'ops-manager': 'Ops manager' };
function oldHospital() {
  const { entities, events, meta } = generateHospital({ end: END });
  const oldEntities = entities.map((e) => {
    if (e.type === 'role') return { ...e, name: OLD_ROLE_NAMES[e.roleId] || e.name };
    if (e.id === 'dept-estates') return { ...e, name: 'Estates and facilities' };
    if (e.kind === 'call-bell') return { ...e, name: e.name.replace('Nurse call', 'Call bell') };
    return e;
  });
  const oldEvents = events.map((e) => (e.data?.title === 'Nurse call not working' ? { ...e, data: { ...e.data, title: 'Call bell not working' } } : e));
  return { entities: oldEntities, events: oldEvents, meta };
}
async function oldDevice() {
  const core = await Core.open({ adapter: new MemoryAdapter(), clock: clockFrom(END) });
  const { entities, events, meta } = oldHospital();
  await core.putEntities(entities, 'system', `${HOSPITAL_NAME}, old words`);
  await core.appendEvents(events, 'system', 'old words');
  await core.setMeta('synthetic', true);
  await core.setMeta('generator', meta);
  await core.setMeta('setup', 'done');
  return core;
}

test('every role shows its new name and keeps its id', () => {
  assert.deepEqual(ROLES.map((r) => [r.id, r.name]), [
    ['ward-nurse', 'Ward nurse'],
    ['bed-manager', 'Patient flow coordinator'],
    ['estates-tech', 'Facilities technician'],
    ['ae-nic', 'Emergency department nurse in charge'],
    ['ops-manager', 'Operations manager'],
    ['coo', 'COO'],
  ]);
  assert.equal(roleById('bed-manager').home, 'beds');
  assert.equal(roleById('estates-tech').home, 'engineering');
  assert.equal(roleById('ae-nic').home, 'ae');
});

test('ids that stored data and callers rely on are unchanged', () => {
  const { entities, events } = generateHospital({ end: END });
  assert.deepEqual(entities.filter((e) => e.type === 'role').map((e) => e.id), ROLES.map((r) => `role-${r.id}`));
  assert.ok(entities.some((e) => e.id === 'dept-estates'));
  assert.ok(entities.some((e) => e.id === 'asset-a1-call-bell-1' && e.kind === 'call-bell'));
  assert.ok(events.some((e) => e.data?.trade === 'estates'));
  assert.ok(Object.keys(TEAMS).includes('estates'));
  assert.ok(MODULES.some((m) => m.id === 'ae' && m.name === 'Emergency department flow'));
  assert.ok(KPIS.some((k) => k.id === 'decision-to-bed'));
});

test('no old word is left in the words the app and its commands show', () => {
  const { entities, events } = generateHospital({ end: END });
  const shown = [
    ...ROLES.map((r) => r.name), ...MODULES.flatMap((m) => [m.name, m.summary, m.soon]), ...ALL_FAULTS, ...Object.values(TEAMS),
    ...entities.map((e) => e.name), ...events.map((e) => e.data?.title),
    JSON.stringify(KPIS), JSON.stringify(listCommands()),
  ].filter((s) => typeof s === 'string');
  assert.ok(shown.length > 300, `${shown.length} strings checked`);
  assert.deepEqual(shown.filter((s) => OLD.test(s)).map((s) => s.slice(0, 80)), []);
  assert.ok(entities.some((e) => e.name === 'Nurse call panel 1'));
  assert.ok(ALL_FAULTS.includes('Nurse call not working'));
});

test('a data set made before the change still loads and shows the new words; its stored history is untouched', async () => {
  const core = await oldDevice();
  // The old words really are stored on this device.
  assert.equal((await core.getEntity('role-bed-manager')).name, 'Bed manager');
  assert.equal((await core.getEntity('asset-a1-call-bell-1')).name, 'Call bell panel 1');
  const storedOld = (await core.events()).filter((e) => e.data?.title === 'Call bell not working');
  assert.ok(storedOld.length > 0, 'the old fault title is in the stored events');

  // Role names on screen come from ROLES by id, so they are the new ones.
  const added = await runCommand(core, 'ospeli_agents_add', { name: 'night-helper', role: 'bed-manager', wards: ['ward-a1'], days: 7 }, human('ops-manager'));
  const view = await runCommand(core, 'ospeli_agents_list', {}, human('coo'));
  assert.equal(view.agents.find((a) => a.name === 'night-helper').roleName, 'Patient flow coordinator');
  await assert.rejects(runCommand(core, 'ospeli_workorders_list', {}, { type: 'human', role: 'role-bed-manager' }), /Unknown role/);

  // Asset, place and fault names are read with the new words.
  const ward = await runCommand(core, 'ospeli_assets_list', { locationId: 'ward-a1' }, human('ward-nurse'));
  const panel = ward.assets.find((a) => a.kind === 'call-bell');
  assert.deepEqual([panel.id, panel.name, panel.faults[0]], ['asset-a1-call-bell-1', 'Nurse call panel 1', 'Nurse call not working']);
  const everything = await runCommand(core, 'ospeli_assets_list', {}, human('estates-tech'));
  assert.equal(oldIn(everything), null);
  const lists = [await runCommand(core, 'ospeli_workorders_list', { limit: 500 }, human('estates-tech')), await runCommand(core, 'ospeli_workorders_list', { state: 'completed', limit: 500 }, human('coo'))];
  assert.equal(oldIn(lists), null);
  const titles = lists.flatMap((l) => l.workOrders).filter((w) => w.assetId.includes('call-bell')).map((w) => w.title);
  assert.equal(titles.length, storedOld.length, 'every old report is still listed');
  assert.ok(titles.every((t) => t === 'Nurse call not working'));

  // An old report and a new one of the same fault are still the same fault: a new report on an
  // asset whose old work order is open is a duplicate; after an old fix it is a repeat.
  const now = core.now();
  const orders = [...deriveWorkOrders(await core.events(), now).values()].filter((w) => w.assetId.includes('call-bell'));
  const fixed = orders.filter((w) => w.outcome === 'fixed' && Date.parse(now) - Date.parse(w.completedAt) < 29 * 24 * 3600e3).pop();
  const stillOpen = new Set(orders.filter((w) => w.state !== 'completed').map((w) => w.assetId));
  assert.ok(fixed && !stillOpen.has(fixed.assetId), 'the generated month holds a fixed nurse call fault');
  const again = await runCommand(core, 'ospeli_workorders_report_fault', { assetId: fixed.assetId, fault: 'Nurse call not working', priority: 'high' }, human('ward-nurse'));
  assert.ok(again.repeat >= 1, 'counts the fix stored under the old word');

  // Nothing stored was rewritten.
  assert.equal((await core.getEntity('asset-a1-call-bell-1')).name, 'Call bell panel 1');
  assert.equal((await core.events()).filter((e) => e.data?.title === 'Call bell not working').length, storedOld.length);
  assert.equal((await core.auditCheck()).ok, true);
});

test('currentWords swaps old words in stored names only, never ids', () => {
  assert.equal(currentWords('Call bell panel 2'), 'Nurse call panel 2');
  assert.equal(currentWords('Estates and facilities'), 'Facilities');
  assert.equal(currentWords('Call bell not working'), 'Nurse call not working');
  for (const id of ['bed-manager', 'estates-tech', 'ae-nic', 'ops-manager', 'estates', 'call-bell', 'asset-a1-call-bell-1', 'dept-estates']) assert.equal(currentWords(id), id);
  assert.equal(currentWords('Ward A1 (acute medicine)'), 'Ward A1 (acute medicine)');
  assert.equal(currentWords(null), null);
});
