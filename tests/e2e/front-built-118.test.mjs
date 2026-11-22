// Issue #118: the front page lists what the app has. Six modules are in the app, so the front page
// shows six Built rows on a desktop, each opening the app; on a phone the three newer ones sit in
// the closed list with a "Built" tag and open the app; nothing in the app is tagged Preview.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './helpers.mjs';

let env;
before(async () => { env = await startApp(); });
after(async () => { await env.close(); });
const ROUTES = ['app/#/beds', 'app/#/engineering', 'app/#/process', 'app/#/stores', 'app/#/support', 'app/#/feedback', 'app/#/facilities', 'app/#/transfers', 'app/#/clinics', 'app/#/diagnostics', 'app/#/pharmacy'];

test('desktop 1280 px: six Built rows, each opening its module in the app; none of them tagged Preview', async () => {
  const context = await env.browser.newContext({ viewport: { width: 1280, height: 860 } });
  const page = await context.newPage();
  await page.goto(`${env.base}/`);
  const rows = await page.$$eval('#modules .mod', (els) => els.map((m) => ({ tag: m.querySelector('.st')?.textContent.trim(), href: m.querySelector('a')?.getAttribute('href'), visible: !!m.getClientRects().length })));
  const built = rows.filter((r) => r.tag === 'Built');
  assert.deepEqual(built.map((r) => r.href).sort(), [...ROUTES].sort());
  assert.ok(built.every((r) => r.visible));
  assert.ok(rows.filter((r) => r.tag === 'Preview').every((r) => !r.href.startsWith('app/')));
  await context.close();
});

for (const width of [360, 390]) {
  test(`phone ${width} px: the closed list names the three newer modules as Built and opens the app`, async () => {
    const context = await env.browser.newContext({ viewport: { width, height: 800 }, hasTouch: true, isMobile: true });
    const page = await context.newPage();
    await page.goto(`${env.base}/`);
    await page.locator('.pv-wrap > summary').tap();
    const links = await page.$$eval('.pv-list a', (els) => els.map((a) => ({ href: a.getAttribute('href'), tag: getComputedStyle(a, '::after').content, h: a.getBoundingClientRect().height })));
    for (const r of ['app/#/stores', 'app/#/support', 'app/#/feedback', 'app/#/facilities', 'app/#/transfers', 'app/#/clinics', 'app/#/diagnostics', 'app/#/pharmacy']) {
      const l = links.find((x) => x.href === r);
      assert.ok(l, `${r} is in the list`);
      assert.equal(l.tag, '"Built"');
      assert.ok(l.h >= 44, `${r} is ${l.h} px tall`);
    }
    assert.ok(links.filter((l) => l.tag === '"Preview"').every((l) => l.href.startsWith('demo/')));
    await context.close();
  });
}
