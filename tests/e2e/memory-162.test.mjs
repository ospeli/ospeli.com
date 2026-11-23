// Issue #162: a tab left open all shift must not grow. Leaving a page frees what it held: after a
// forced clean-up, memory after many page changes is about what it was after a few. Each browser
// test opens a fresh page, so before this test none changed page more than a few times.
// Measured in Chromium (heap in use after a forced garbage collection, through the DevTools
// protocol). Before the fix the Bed board kept about 0.4 MB per visit (19 MB before #153) and a
// loop of every built page kept about 29 MB.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, openPage } from './helpers.mjs';

let env;
before(async () => { env = await startApp(); });
after(async () => { await env.close(); });

async function meter(page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('HeapProfiler.enable');
  return async () => {
    for (let i = 0; i < 3; i++) await cdp.send('HeapProfiler.collectGarbage');
    return (await cdp.send('Runtime.getHeapUsage')).usedSize / 1e6;
  };
}

async function go(page, hash) {
  await page.evaluate((h) => { location.hash = h; }, hash);
  // Navigation v2: the shell marks the page on screen on <html> once it has been drawn.
  await page.waitForFunction((h) => document.documentElement.dataset.route === h && !document.querySelector('main .loading'), hash);
  await page.waitForTimeout(250);
}

for (const screen of ['#/beds', '#/engineering']) {
  test(`${screen}: ten more visits keep less than 1 MB in all (before the fix: about 4 MB on the Bed board)`, async () => {
    const { context, page, errors } = await openPage(env, { testHook: false });
    const heap = await meter(page);
    for (let i = 0; i < 3; i++) { await go(page, screen); await go(page, '#/home'); }
    const start = await heap();
    for (let i = 0; i < 10; i++) { await go(page, screen); await go(page, '#/home'); }
    const grew = (await heap()) - start;
    assert.ok(grew < 1, `${screen}: memory after ten more visits grew by ${grew.toFixed(2)} MB`);
    assert.deepEqual(errors, []);
    await context.close();
  });
}

test('every built page in a loop: three more loops keep less than 3 MB in all', async () => {
  const { context, page, errors } = await openPage(env, { testHook: false });
  const heap = await meter(page);
  // Navigation v2: every built page is the dock's places, the Journey page's chips (planned ones
  // are only under "Coming later") and the rows under Me (Agents, Data).
  await go(page, '#/journey');
  const journey = await page.evaluate(() => [...document.querySelectorAll('#main .journey a[data-module]:not([data-planned])')].map((a) => a.getAttribute('href')));
  await go(page, '#/me');
  const me = await page.evaluate(() => [...document.querySelectorAll('#main [data-test="me-agents"], #main [data-test="me-data"]')].map((a) => a.getAttribute('href')));
  const dock = await page.evaluate(() => [...document.querySelectorAll('#dock a[href^="#/"]')].map((a) => a.getAttribute('href')));
  const pages = [...new Set([...dock, ...journey, ...me])];
  assert.equal(me.length, 2, 'Agents and Data are rows under Me');
  assert.ok(pages.length >= 10, `built pages found: ${pages.length}`);
  const loop = async () => { for (const p of pages) await go(page, p); await go(page, '#/home'); };
  await loop(); await loop();
  const start = await heap();
  for (let i = 0; i < 3; i++) await loop();
  const grew = (await heap()) - start;
  assert.ok(grew < 3, `memory after three more loops of ${pages.length} pages grew by ${grew.toFixed(2)} MB`);
  assert.deepEqual(errors, []);
  await context.close();
});
