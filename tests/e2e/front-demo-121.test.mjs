// Issue #121 part 1: on a phone the one filled button, "Try the live demo", opens the app itself
// in one tap, not the list of design sketches. The desktop button is unchanged (founder, 9 Nov).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './helpers.mjs';

let env;
before(async () => { env = await startApp(); });
after(async () => { await env.close(); });

for (const width of [360, 390]) {
  test(`phone ${width} px: "Try the live demo" opens the app in one tap (#121)`, async () => {
    const context = await env.browser.newContext({ viewport: { width, height: 780 }, hasTouch: true, isMobile: true });
    const page = await context.newPage();
    await page.goto(`${env.base}/`);
    const btn = page.locator('.hero .actions a:visible', { hasText: 'Try the live demo' });
    assert.equal(await btn.count(), 1);
    assert.equal(await btn.getAttribute('href'), 'app/');
    assert.ok((await btn.boundingBox()).height >= 44);
    await btn.tap();
    await page.waitForSelector('html[data-ready="true"]');
    assert.match(page.url(), /\/app\/$/);
    await context.close();
  });
}

test('desktop 1280 px: the hero demo button still opens the demos list (#121 leaves desktop as approved)', async () => {
  const context = await env.browser.newContext({ viewport: { width: 1280, height: 860 } });
  const page = await context.newPage();
  await page.goto(`${env.base}/`);
  const btn = page.locator('.hero .actions a:visible', { hasText: 'Try the live demo' });
  assert.equal(await btn.count(), 1);
  assert.equal(await btn.getAttribute('href'), 'demo/');
  await context.close();
});
