// Review finding: picks in imported diagnostics.* events are checked with LIST[value], which is
// truthy for names every object inherits ("constructor", "toString"). Such a pick passes the
// import, is shown as JavaScript source text, and one collected request with it stops the hatch
// list, the tracker and the overview for everyone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Core } from '../../web/app/core/core.js';
import { MemoryAdapter } from '../../web/app/core/db.js';
import { runCommand } from '../../web/app/core/commands.js';
import { deriveRequests } from '../../web/app/modules/diagnostics/logic.js';
import { site, human, END } from './sec-diagnostics-helper.mjs';

const at = '2026-11-19T13:00:00.000Z';
const e = (type, subject, actorRole, data = null, t = at) => ({ type, subject, actorRole, at: t, data });

test('a pick named after an inherited property is dropped when the log is read', () => {
  const r = deriveRequests([
    e('diagnostics.request-made', 'dx-90001', 'unit-clerk', { sourceId: 'ward-a2', testGroup: 'constructor', urgency: 'routine' }),
    e('diagnostics.request-made', 'dx-90002', 'unit-clerk', { sourceId: 'ward-a2', testGroup: 'chemistry', urgency: 'toString' }),
    e('diagnostics.request-made', 'dx-90003', 'unit-clerk', { sourceId: 'ward-a2', testGroup: 'chemistry', urgency: 'routine' }),
    e('diagnostics.specimen-rejected', 'dx-90003', 'lab-reception', { reason: 'constructor' }),
    e('diagnostics.request-made', 'dx-90004', 'unit-clerk', { sourceId: 'ward-a2', testGroup: 'chemistry', urgency: 'routine' }),
    e('diagnostics.request-cancelled', 'dx-90004', 'unit-clerk', { reason: 'constructor' }),
  ]);
  assert.deepEqual([...r.keys()], ['dx-90003', 'dx-90004'], 'a request whose test group or urgency is not on the list is left out');
  assert.deepEqual([r.get('dx-90003').state, r.get('dx-90004').state], ['requested', 'requested'], 'a rejection or cancellation whose reason is not on the list is left out');
});

test('an imported file with such picks never shows program text and never stops the lists', async () => {
  const src = await site();
  const data = JSON.parse(JSON.stringify(await src.core.exportData()));
  const add = (type, subject, actorRole, d, t = at) => data.events.push({ seq: data.events.length + 1, type, subject, actorRole, at: t, recordedAt: t, data: d });
  add('diagnostics.request-made', 'dx-90001', 'unit-clerk', { sourceId: 'ward-a2', testGroup: 'constructor', urgency: 'toString' });
  add('diagnostics.specimen-collected', 'dx-90001', 'ward-nurse', null);
  const core = await Core.open({ adapter: new MemoryAdapter(), clock: () => new Date(Date.parse(END) + 5 * 3600e3) });
  assert.deepEqual(await core.validateImport(data), [], 'the import check lets the file through');
  await core.importData(data, 'ops-manager');
  const run = (name, input, role) => runCommand(core, name, input, human(role));
  const list = await run('ospeli_diagnostics_requests_list', { sourceId: 'ward-a2', stage: 'all', limit: 500 }, 'unit-clerk'); // throws today
  assert.ok(!/native code|function /.test(JSON.stringify(list)), 'no JavaScript source text in what the tracker shows');
  await run('ospeli_diagnostics_specimen_log', {}, 'lab-reception');
  await run('ospeli_diagnostics_overview', {}, 'diagnostics-manager');
});

test('an imported equipment-down with an inherited name as its reason or backup is not shown as program text', async () => {
  const src = await site();
  const data = JSON.parse(JSON.stringify(await src.core.exportData()));
  data.events.push({ seq: data.events.length + 1, type: 'diagnostics.equipment-down', subject: 'asset-analyser-1', actorRole: 'lab-scientist', at, recordedAt: at, data: { scope: 'all', reason: 'constructor', backup: 'constructor' } });
  const core = await Core.open({ adapter: new MemoryAdapter(), clock: () => new Date(Date.parse(END) + 5 * 3600e3) });
  assert.deepEqual(await core.validateImport(data), [], 'the import check lets the file through');
  await core.importData(data, 'ops-manager');
  const list = await runCommand(core, 'ospeli_diagnostics_equipment_list', {}, human('lab-scientist'));
  const row = list.equipment.find((x) => x.assetId === 'asset-analyser-1');
  assert.ok(row, 'the analyser is on the list');
  assert.ok(row.reasonName == null || typeof row.reasonName === 'string', `reasonName is ${typeof row.reasonName}`);
  assert.equal(typeof (row.backupText ?? ''), 'string', 'the backup route is words');
  assert.ok(!/native code|function /.test(JSON.stringify(list)), 'no program text in what the equipment list shows');
});
