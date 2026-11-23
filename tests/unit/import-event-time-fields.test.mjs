// Deep pass, import and export. The two time fields of an imported event. Ospeli itself
// always writes an ISO time stamp in both. On import `at` only has to be something Date.parse
// accepts, which takes free text around a date, and may be left out or null; `recordedAt` is not
// looked at at all. Neither is read by the personal-detail check (that reads subject and data).
// So a name, a phone number or a date of birth passes inside them, and an event with no time
// makes read commands (and the pages built on them) fail after the import.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCommand } from '../../web/app/core/commands.js';
import { exportedFile, empty, TITLED } from './sec-import-helper.mjs';

const refusedWith = async (change) => {
  const file = await exportedFile();
  change(file);
  return (await empty()).validateImport(file);
};

test('control: the same text under an ordinary key is refused', async () => {
  const errs = await refusedWith((d) => { d.events[0].data = { ...d.events[0].data, note: TITLED }; });
  assert.match(errs.join(' '), /personal details/);
});

test('text in an event\'s recordedAt is refused', async () => {
  const errs = await refusedWith((d) => { d.events[0].recordedAt = TITLED; });
  assert.notDeepEqual(errs, [], 'a titled name and a phone number in recordedAt were let through');
});

test('a name and a date of birth in an event\'s at is refused', async () => {
  const errs = await refusedWith((d) => { d.events[0].at = 'Mrs Jane Brown, 5 March 1987'; });
  assert.notDeepEqual(errs, [], 'free text with a name and a birth date in `at` was let through');
});

test('an event with no time, or a number for a time, is refused', async () => {
  for (const [what, change] of [['null', (e) => { e.at = null; }], ['missing', (e) => { delete e.at; }], ['a number', (e) => { e.at = 12345; }]]) {
    const errs = await refusedWith((d) => change(d.events[0]));
    assert.notDeepEqual(errs, [], `an event whose at is ${what} was let through`);
  }
});

test('after an import no read command fails on an event\'s time', async () => {
  const file = await exportedFile();
  const lastOfType = new Map(file.events.map((e) => [e.type, e]));
  for (const e of lastOfType.values()) e.at = null;
  const core = await empty();
  if ((await core.validateImport(file)).length) return; // refused at the door: the right answer
  await core.importData(file, 'coo');
  const failed = [];
  for (const name of ['ospeli_workorders_list', 'ospeli_workorders_next']) {
    try { await runCommand(core, name, {}, { type: 'human', role: 'coo' }); } catch (err) { failed.push(`${name}: ${err.constructor.name} ${err.message}`); }
  }
  assert.deepEqual(failed, [], 'read commands fail on the imported data');
});
