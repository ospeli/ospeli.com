import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, openPage } from './helpers.mjs';

let env;
before(async () => { env = await startApp(); });
after(async () => { await env.close(); });

test('first run loads Example General Hospital quickly, with a clean audit trail', async () => {
  const t0 = Date.now();
  const { context, page, errors } = await openPage(env);
  const ms = Date.now() - t0;
  assert.ok(ms < 8000, `first run took ${ms} ms`);
  const stats = await page.locator('.stat b').allTextContents();
  assert.equal(stats[0], '6');
  assert.equal(stats[1], '120');
  assert.ok(Number(stats[2]) > 5000);
  const audit = await page.evaluate(() => window.ospeli.core.verifyAudit());
  assert.deepEqual(audit, { ok: true });
  assert.deepEqual(errors, []);
  await context.close();
});

test('reset leaves the device empty, and the hospital can be loaded again', async () => {
  const { context, page, errors } = await openPage(env, { path: '#/data' });
  page.on('dialog', (d) => d.accept());
  await page.click('text=Reset device data');
  await page.waitForFunction(() => /Intact: 1 entries/.test(document.querySelector('[data-test="audit-status"]').textContent));
  await page.goto(`${env.appUrl}#/home`);
  await page.reload();
  await page.waitForSelector('html[data-ready="true"]');
  assert.equal((await page.locator('.stat b').allTextContents())[1], '0', 'reset must not auto-reload the hospital');
  await Promise.all([page.waitForEvent('load'), page.click('text=Load Example General Hospital')]);
  await page.waitForSelector('html[data-ready="true"]');
  assert.equal((await page.locator('.stat b').allTextContents())[1], '120');
  assert.deepEqual(errors, []);
  await context.close();
});

test('"Load a fresh copy" replaces the data and is audited', async () => {
  const { context, page, errors } = await openPage(env, { path: '#/data' });
  page.on('dialog', (d) => d.accept());
  await page.evaluate(() => window.ospeli.core.appendEvent({ type: 'bed.vacated', subject: 'bed-x', actorRole: 'ward-nurse' }));
  await Promise.all([page.waitForEvent('load'), page.click('text=Load a fresh copy')]);
  await page.waitForSelector('html[data-ready="true"]');
  const res = await page.evaluate(async () => ({
    beds: (await window.ospeli.core.listEntities('bed')).length,
    stray: (await window.ospeli.core.events({ subject: 'bed-x' })).length,
    last: (await window.ospeli.core.auditLog()).at(-1).action,
  }));
  assert.deepEqual(res, { beds: 120, stray: 0, last: 'data.synthetic-loaded' });
  assert.deepEqual(errors, []);
  await context.close();
});
