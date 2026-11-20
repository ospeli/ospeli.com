// ospeli/ospeli#150 point 4: a file that is not an Ospeli export is refused in plain words, never
// with the browser's own parser message.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { startApp, openPage } from './helpers.mjs';

let env;
before(async () => { env = await startApp(); });
after(async () => { await env.close(); });

test('#150: a text file that is not an export says so in plain words and changes nothing', async () => {
  const { context, page, errors } = await openPage(env, { path: '#/data', width: 390 });
  await page.waitForSelector('[data-test="audit-status"]');
  const before = await page.evaluate(async () => (await window.ospeli.core.events()).length);
  for (const [name, body] of [['hello.txt', 'hello'], ['half.json', '{"entities": ['], ['number.json', '42'], ['list.json', '[1, 2]']]) {
    const file = path.join(os.tmpdir(), `${Date.now()}-${name}`);
    await writeFile(file, body);
    await page.setInputFiles('#import-file', file);
    await page.waitForFunction(() => /Import refused/.test(document.querySelector('[data-test="import-status"]').textContent));
    const said = await page.textContent('[data-test="import-status"]');
    assert.equal(said, 'Import refused. Nothing was changed. This is not an Ospeli export file.', `${name}: ${said}`);
    await page.evaluate(() => { document.querySelector('[data-test="import-status"]').textContent = ''; document.querySelector('#import-file').value = ''; });
  }
  assert.equal(await page.evaluate(async () => (await window.ospeli.core.events()).length), before);
  assert.deepEqual(errors, []);
  await context.close();
});
