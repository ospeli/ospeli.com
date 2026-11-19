// A locked export on the Data page (ospeli/ospeli#93, the browser step): export with a passphrase,
// see that the file cannot be read, that a wrong passphrase and a damaged file change nothing, and
// that the right passphrase brings the data back. The passphrase is made at test time.
// Synthetic data only.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { startApp, openPage } from './helpers.mjs';

let env;
before(async () => { env = await startApp(); });
after(async () => { await env.close(); });

const status = (page, sel, re) => page.waitForFunction(([s, r]) => new RegExp(r).test(document.querySelector(s).textContent), [sel, re.source]);

test('a locked export: weak or mismatched passphrases save nothing; the file is unreadable; wrong passphrase and damage change nothing; the right one imports', async () => {
  const { context, page, errors } = await openPage(env, { path: '#/data' });
  const pass = `test ${randomBytes(9).toString('hex')}`;
  const count = await page.evaluate(async () => (await window.ospeli.core.events()).length);
  const exportsBefore = await page.evaluate(async () => (await window.ospeli.core.auditLog()).filter((e) => e.action === 'data.exported').length);

  await page.click('[data-test="lock-open"]');
  // Refused: too short, then two that differ. Nothing is downloaded and nothing is recorded.
  await page.fill('[data-test="lock-pass-1"]', 'short'); await page.fill('[data-test="lock-pass-2"]', 'short');
  await page.click('[data-test="lock-save"]');
  await status(page, '[data-test="lock-status"]', /at least 12 characters/);
  await page.fill('[data-test="lock-pass-1"]', pass); await page.fill('[data-test="lock-pass-2"]', `${pass}x`);
  await page.click('[data-test="lock-save"]');
  await status(page, '[data-test="lock-status"]', /do not match\. Nothing was saved/);
  assert.equal(await page.evaluate(async () => (await window.ospeli.core.auditLog()).filter((e) => e.action === 'data.exported').length), exportsBefore);

  await page.fill('[data-test="lock-pass-1"]', pass); await page.fill('[data-test="lock-pass-2"]', pass);
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('[data-test="lock-save"]')]);
  assert.match(download.suggestedFilename(), /^ospeli-export-\d{4}-\d\d-\d\d\.ospeli-locked$/);
  const file = path.join(os.tmpdir(), `ospeli-e2e-${Date.now()}.ospeli-locked`);
  await download.saveAs(file);
  await status(page, '[data-test="lock-status"]', /Saved and checked/);
  const bytes = await readFile(file);
  assert.equal(bytes.subarray(0, 16).toString('latin1'), 'OSPELI-LOCKED-1\n');
  for (const word of ['ospeli-export', 'ward-a1', 'bed.', 'entities', pass]) assert.ok(!bytes.includes(Buffer.from(word)), `"${word}" is readable in the locked file`);
  // The passphrase is not left in the page, in the trail or in the browser's storage.
  assert.equal(await page.inputValue('[data-test="lock-pass-1"]'), '');
  assert.equal(await page.inputValue('[data-test="lock-pass-2"]'), '');
  const kept = await page.evaluate(async (p) => JSON.stringify(await window.ospeli.core.auditLog()).includes(p) || JSON.stringify({ ...localStorage }).includes(p) || JSON.stringify({ ...sessionStorage }).includes(p), pass);
  assert.equal(kept, false, 'the passphrase is kept nowhere');
  assert.match(await page.locator('tbody td[data-action="data.exported"]').first().textContent(), /Data exported, locked with a passphrase/);

  // A change after the export, so that an import that worked is visible.
  await page.evaluate(() => window.ospeli.core.appendEvent({ type: 'bed.cleaned', subject: 'bed-x', actorRole: 'ward-nurse' }));
  const dialogs = [];
  page.on('dialog', (d) => { dialogs.push(d.message()); d.accept(); });

  // Wrong passphrase: nothing changes, no "replace all data" question is even asked.
  await page.setInputFiles('#import-file', file);
  await page.waitForSelector('[data-test="import-locked-form"]:not([hidden])');
  await page.fill('[data-test="import-passphrase"]', `${pass} wrong`);
  await page.click('[data-test="import-open"]');
  await status(page, '[data-test="import-status"]', /does not open this file\. Nothing was changed/);
  assert.equal(await page.evaluate(async () => (await window.ospeli.core.events()).length), count + 1);
  assert.deepEqual(dialogs, []);

  // A damaged copy: told apart from a wrong passphrase, and nothing changes.
  const damaged = Buffer.from(bytes); damaged[damaged.length - 100] ^= 1;
  const badFile = `${file}.damaged.ospeli-locked`;
  await writeFile(badFile, damaged);
  await page.setInputFiles('#import-file', badFile);
  await page.waitForSelector('[data-test="import-locked-form"]:not([hidden])');
  await page.fill('[data-test="import-passphrase"]', pass);
  await page.click('[data-test="import-open"]');
  await status(page, '[data-test="import-status"]', /damaged or was cut short/);
  assert.equal(await page.evaluate(async () => (await window.ospeli.core.events()).length), count + 1);
  assert.deepEqual(dialogs, []);

  // The right passphrase: the usual question, then the data as it was at the export.
  await page.setInputFiles('#import-file', file);
  await page.waitForSelector('[data-test="import-locked-form"]:not([hidden])');
  await page.fill('[data-test="import-passphrase"]', pass);
  await page.click('[data-test="import-open"]');
  await status(page, '[data-test="import-status"]', /^Imported /);
  assert.equal(dialogs.length, 1);
  assert.equal(await page.evaluate(async () => (await window.ospeli.core.events()).length), count, 'the event added after the export is gone');
  assert.equal(await page.inputValue('[data-test="import-passphrase"]'), '');
  assert.deepEqual(errors, []);
  await context.close();
});

test('the locked export form fits a 360 px phone and its fields are named', async () => {
  const { context, page, errors } = await openPage(env, { path: '#/data', width: 360, height: 640, touch: true });
  await page.tap('[data-test="lock-open"]');
  await page.waitForSelector('[data-test="lock-form"]:not([hidden])');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'no sideways scroll');
  for (const id of ['lock-pass-1', 'lock-pass-2']) {
    assert.ok((await page.locator(`label[for="${id}"]`).textContent()).length > 3);
    const box = await page.locator(`#${id}`).boundingBox();
    assert.ok(box.height >= 44, 'a field a thumb can hit');
  }
  assert.match(await page.textContent('[data-test="lock-note"]'), /The copy this browser keeps on the device is not locked/);
  assert.deepEqual(errors, []);
  await context.close();
});
