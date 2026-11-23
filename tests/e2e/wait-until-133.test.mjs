// Issue #133, point 2: the shared waitUntil() helper really waits for an async check in the page,
// where page.waitForFunction with an async check returns at once. Shown on the app's own role setting.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, openPage, waitUntil } from './helpers.mjs';

let env;
before(async () => { env = await startApp(); });
after(async () => { await env.close(); });

test('#133: waitUntil waits for an async check that becomes true a second later; waitForFunction with an async check does not', async () => {
  const { context, page, errors } = await openPage(env, { width: 390 });
  await page.evaluate(() => { window.__later = false; setTimeout(() => { window.__later = true; }, 1000); });
  let t = Date.now();
  // The pattern the tests used: it should wait about a second, and it returns at once.
  const asyncCheck = async () => window.__later === true;
  await page.waitForFunction(asyncCheck);
  const asyncWait = Date.now() - t;
  assert.equal(await page.evaluate(() => window.__later), false, 'waitForFunction with an async check went on before the check was true (this is the fault in #133)');
  t = Date.now();
  assert.equal(await waitUntil(page, async () => window.__later === true), true);
  const helperWait = Date.now() - t;
  assert.ok(helperWait >= 700, `waitUntil waited ${helperWait} ms for a check that turned true a second after it was set up`);
  assert.ok(asyncWait < helperWait, `waitForFunction with an async check took ${asyncWait} ms, waitUntil ${helperWait} ms`);
  // On the app's own data: a role change is stored, and waitUntil sees it.
  await page.evaluate(() => window.ospeli.core.setMeta('role', 'bed-manager'));
  assert.equal(await waitUntil(page, async (r) => (await window.ospeli.core.getMeta('role')) === r, 'bed-manager'), true);
  await assert.rejects(waitUntil(page, async () => false, undefined, { timeout: 300 }), /still not true after 300 ms/);
  assert.deepEqual(errors, []);
  await context.close();
});
