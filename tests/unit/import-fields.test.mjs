// Import takes only the fields Ospeli itself writes (security sweep of 17 Nov 2026, finding 2;
// docs/SECURITY.md row I1). A field outside that list was stored as it stood and never read by
// the personal-detail checks. Everything here is made up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Core } from '../../web/app/core/core.js';
import { MemoryAdapter } from '../../web/app/core/db.js';
import { loadSyntheticHospital } from '../../web/app/core/generator.js';

const END = '2026-11-06T18:00:00.000Z';
async function exported() {
  const core = await Core.open({ adapter: new MemoryAdapter(), clock: () => new Date(END) });
  await loadSyntheticHospital(core, { end: END, modules: false });
  return JSON.parse(JSON.stringify(await core.exportData()));
}
const fresh = () => Core.open({ adapter: new MemoryAdapter(), clock: () => new Date(END) });
const MADE_UP = 'Mr Test Person 07700 900123';

test('an untouched export still imports', async () => {
  const file = await exported();
  const core = await fresh();
  assert.deepEqual(await core.validateImport(file), []);
  await core.importData(file, 'coo');
  assert.equal((await core.exportData()).events.length, file.events.length);
});

test('an event with a field Ospeli does not write is refused, and the answer does not repeat it', async () => {
  const file = await exported();
  file.events[3].note = MADE_UP;
  const core = await fresh();
  const errs = await core.validateImport(file);
  assert.ok(errs.length > 0, 'the file is refused');
  assert.ok(!JSON.stringify(errs).includes('Test Person') && !JSON.stringify(errs).includes('07700'), 'the refusal does not carry the text');
  await assert.rejects(core.importData(file, 'coo'), /import refused/);
  assert.ok(!JSON.stringify(await core.exportData()).includes('Test Person'), 'nothing of it was stored');
});

test('an audit entry with a field outside its check code is refused', async () => {
  const file = await exported();
  assert.ok(file.audit.length > 0, 'the example has audit entries to try this on');
  file.audit[0].note = MADE_UP; // the check code does not cover it, so the self-check alone would pass
  const core = await fresh();
  const errs = await core.validateImport(file);
  assert.ok(errs.some((e) => /audit entry 1: has a field Ospeli does not write/.test(e)), JSON.stringify(errs));
  await assert.rejects(core.importData(file, 'coo'), /import refused/);
});

test('exportedAt must be a time stamp: typed text there never reaches the new audit entry', async () => {
  for (const bad of [MADE_UP, 12345, { a: 1 }, 'yesterday']) {
    const file = await exported();
    file.exportedAt = bad;
    const core = await fresh();
    assert.ok((await core.validateImport(file)).some((e) => /exportedAt must be a time stamp/.test(e)), `refused: ${JSON.stringify(bad)}`);
    await assert.rejects(core.importData(file, 'coo'), /import refused/);
    assert.ok(!JSON.stringify(await core.auditLog()).includes('Test Person'));
  }
});
