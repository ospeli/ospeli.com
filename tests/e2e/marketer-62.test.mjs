// Issue #62 (marketer, 12 Nov), items 1 to 4: the agents notices in kit v3.1 colours, the header
// never shows a hospital name beside "No data loaded", the phone footer says the agent guide is a
// text file, and the audit table keeps its Action column readable on a phone.
// Website v2 (25 Nov 2026): the old front page, with these sections, moved whole to /overview.html;
// the homepage itself is checked in home-v2.test.mjs. The assertions below are unchanged.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, openPage, setRole } from './helpers.mjs';

let env;
before(async () => { env = await startApp(); });
after(async () => { await env.close(); });

const NAVY = 'rgb(11, 47, 78)';
const KIT_EDGES = ['rgb(224, 88, 62)', 'rgb(238, 155, 0)']; // coral, mango

for (const width of [360, 390, 1280]) {
  test(`#62: after a reset the header shows "No data loaded" alone, at ${width} px`, async () => {
    const { context, page, errors } = await openPage(env, { width, height: 800, path: '#/data', touch: width < 600 });
    page.on('dialog', (d) => d.accept());
    // Before: the site's name beside "Synthetic data".
    await page.waitForFunction(() => document.querySelector('#synthetic-badge').textContent === 'Synthetic data');
    assert.equal(await page.locator('.hospital-name').isVisible(), true);
    assert.equal(await page.textContent('.hospital-name'), 'Example General Hospital');
    await page.getByRole('button', { name: 'Reset device data' }).click();
    await page.waitForFunction(() => document.querySelector('#synthetic-badge').textContent === 'No data loaded');
    assert.equal(await page.locator('.hospital-name').isVisible(), false, 'no hospital name beside "No data loaded"');
    await page.reload();
    await page.waitForSelector('html[data-ready="true"]');
    await page.waitForFunction(() => document.querySelector('#synthetic-badge').textContent === 'No data loaded');
    assert.equal(await page.locator('.hospital-name').isVisible(), false, 'still none after a reload');
    await page.getByRole('button', { name: 'Load a fresh copy' }).click();
    await page.waitForLoadState('load');
    await page.waitForSelector('html[data-ready="true"]');
    await page.waitForFunction(() => document.querySelector('#synthetic-badge').textContent === 'Synthetic data');
    assert.equal(await page.locator('.hospital-name').isVisible(), true, 'back with the fresh copy');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.deepEqual(errors, []);
    await context.close();
  });
}

test('#62: the agents notices ("All agents stopped", and the reset one, which shares its style) are navy on a kit tint with a coral edge', async () => {
  const { context, page, errors } = await openPage(env, { width: 390, height: 800, path: '#/agents', touch: true });
  page.on('dialog', (d) => d.accept());
  await setRole(page, 'ops-manager');
  await page.waitForSelector('[data-dial="advise"]:not([disabled])');
  await page.locator('[data-dial="advise"]').tap();
  await page.waitForSelector('[data-test="agents-dial"][data-dial-now="advise"]');
  await page.getByRole('button', { name: /stop all/i }).first().tap();
  await page.waitForSelector('[data-test="agents-stopped"]');
  const s = await page.$eval('[data-test="agents-stopped"]', (el) => { const c = getComputedStyle(el); return { cls: el.className, color: c.color, bg: c.backgroundColor, edge: c.borderLeftColor, edgeW: parseFloat(c.borderLeftWidth), size: parseFloat(c.fontSize) }; });
  assert.equal(s.cls, 'ag-banner', 'the same class as the reset notice');
  assert.equal(s.color, NAVY, 'navy text');
  assert.notEqual(s.bg, 'rgb(251, 227, 222)', 'not the old pink');
  assert.ok(KIT_EDGES.includes(s.edge) && s.edgeW >= 4, `a coral or mango edge (${s.edge}, ${s.edgeW} px)`);
  assert.ok(s.size >= 15);
  assert.deepEqual(errors, []);
  await context.close();
});

test('#62: the audit table hides the Hash column on a phone and keeps it on a wide screen', async () => {
  for (const [width, shown] of [[360, false], [390, false], [1280, true]]) {
    const { context, page, errors } = await openPage(env, { width, height: 800, path: '#/data', touch: width < 600 });
    await page.waitForSelector('[data-test="audit-status"]');
    await page.waitForSelector('.table-wrap tbody tr td code', { state: 'attached' });
    const r = await page.evaluate(() => {
      const ths = [...document.querySelectorAll('.table-wrap thead th')];
      const hash = ths.find((t) => t.textContent === 'Hash');
      const action = ths.find((t) => t.textContent === 'Action');
      const code = document.querySelector('.table-wrap tbody td code');
      const vis = (el) => !!el && el.getClientRects().length > 0 && getComputedStyle(el).display !== 'none';
      return { hash: vis(hash), cell: vis(code), actionW: action.getBoundingClientRect().width, wrapW: document.querySelector('.table-wrap').clientWidth, title: code.title };
    });
    assert.equal(r.hash, shown, `Hash header at ${width} px`);
    assert.equal(r.cell, shown, `hash cells at ${width} px`);
    if (!shown) assert.ok(r.actionW >= r.wrapW * 0.3, `Action column has room at ${width} px (${r.actionW} of ${r.wrapW})`);
    assert.ok(r.title.length >= 12, 'the full check code is kept in the page');
    assert.deepEqual(errors, []);
    await context.close();
  }
});

test('#62: the front page footer link to the agent guide says it is a text file', async () => {
  const context = await env.browser.newContext({ viewport: { width: 360, height: 780 }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  await page.goto(`${env.base}/overview.html`);
  const links = await page.$$eval('a[href="agents.md"]', (as) => as.map((a) => a.textContent.trim()));
  assert.ok(links.length >= 1);
  for (const t of links) assert.match(t, /text file/);
  await context.close();
});
