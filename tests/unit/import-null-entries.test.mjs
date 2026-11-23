// Deep pass, import and export. A list in the file that holds null where a record should
// be. validateImport is meant to answer with a list of plain reasons; here it throws a TypeError
// instead, and the Data page shows the engine's own words ("Cannot read properties of null
// (reading 'seq')"), which issue #150 says a person must never be shown. Nothing is changed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exportedFile, empty } from './sec-import-helper.mjs';

for (const list of ['entities', 'events', 'audit']) {
  test(`a null in ${list} is answered with a plain reason, not thrown`, async () => {
    const file = await exportedFile();
    file[list][0] = null;
    const core = await empty();
    let errs;
    try { errs = await core.validateImport(file); } catch (err) { assert.fail(`validateImport threw ${err.constructor.name}: ${err.message}`); }
    assert.ok(Array.isArray(errs) && errs.length > 0, 'the file is refused with a reason');
    assert.ok(!/Cannot read|undefined|null \(/.test(errs.join(' ')), `the reason is in plain words: ${errs[0]}`);
  });
}
