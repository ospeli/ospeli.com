// Deep pass, import and export (rev-d). What an export file and the Data page say about the data.
//  1. After a reset the device claims nothing about its data: the setting is cleared, and the app's
//     badge and every command answer `synthetic: false`. exportData() reads the same setting with
//     the opposite default, so the file it writes says `synthetic: true`. That mark is the only
//     thing the import gate ("this file is not marked synthetic") looks at.
//  2. An import replaces the data but leaves the example hospital's "Seed N, data up to ..." setting
//     from the data that was there before, so the Data page goes on describing the new data with it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSynthetic } from '../../web/app/core/kit.js';
import { loaded, exportedFile } from './rev-d-helper.mjs';

test('an export does not mark data synthetic when the device itself does not', async () => {
  const core = await loaded();
  await core.reset('ops-manager');
  await core.putEntity({ id: 'site-typed-here', type: 'site', name: 'Second Site' }, 'ops-manager');
  assert.equal(await isSynthetic(core), false, 'the control: after a reset the app does not call this data synthetic');
  assert.notEqual((await core.exportData()).synthetic, true, 'the export file marks the same data synthetic: true');
});

test('after an import the device no longer describes the data with the old generator settings', async () => {
  const core = await loaded();
  assert.ok(await core.getMeta('generator'), 'the control: the example hospital left its seed and end time');
  const file = await exportedFile();
  file.entities = file.entities.filter((e) => e.type === 'site'); file.events = []; // some other, smaller data set
  assert.deepEqual(await core.validateImport(file), []);
  await core.importData(file, 'ops-manager');
  assert.equal(await core.getMeta('generator'), null, 'the Data page still says "Seed N, data up to ..." about data that an import replaced');
});
