// The app's service worker (web/app/sw.js): what it may keep as "the app page".
// Weekly audit, 15 Nov 2026. Each test serves web/ from its own small server.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'web');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };

let browser;
const open = [];
before(async () => { browser = await chromium.launch(); });
after(async () => { await browser.close(); for (const s of open) { s.closeAllConnections(); s.close(); } });

// A static server over web/. `swap` holds the files of a newer release; `cacheControl` is what
// the host sends (a static host such as GitHub Pages sends max-age=600 by default).
async function host({ cacheControl = 'no-cache' } = {}) {
  const swap = new Map();
  const server = http.createServer(async (req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p.endsWith('/')) p += 'index.html';
    try {
      const body = swap.has(p) ? swap.get(p) : await readFile(path.join(WEB, p));
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(p)] || 'application/octet-stream', 'Cache-Control': p.endsWith('/sw.js') ? 'no-cache' : cacheControl }).end(body);
    } catch { res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found'); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  open.push(server);
  return { swap, appUrl: `http://127.0.0.1:${server.address().port}/app/`, close: async () => {} };
}
async function openControlled(site) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const page = await context.newPage();
  await page.goto(`${site.appUrl}#/home`);
  await page.waitForSelector('html[data-ready="true"]');
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await page.waitForSelector('html[data-ready="true"]');
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  return { context, page };
}

test('opening one of the app\'s own files in the address bar does not replace the saved app page', async () => {
  const site = await host();
  const { context, page } = await openControlled(site);
  await page.goto(`${site.appUrl}app.css`);
  await page.waitForTimeout(800); // the worker writes its cache after it has answered
  const saved = await page.evaluate(async () => {
    const key = (await caches.keys()).find((k) => k.startsWith('ospeli-app-v'));
    const hit = await (await caches.open(key)).match(new URL('./', location.href.replace(/app\.css$/, '')).href);
    return { type: hit.headers.get('content-type'), start: (await hit.text()).slice(0, 15) };
  });
  assert.match(saved.type, /text\/html/, `the app page saved for offline use is now ${saved.type}: ${JSON.stringify(saved.start)}`);
  await context.close(); await site.close();
});

test('an address under /app/ that does not exist says so instead of showing the app', async () => {
  const site = await host();
  const { context, page } = await openControlled(site);
  const res = await page.goto(`${site.appUrl}no-such-page.html`);
  assert.equal(res.status(), 404);
  await context.close(); await site.close();
});

// Issue #108 parts 1 and 3 (from the audit of 15 Nov, docs/audit/2026-11-15/audit-sw-offline.test.mjs).
const src = (rel) => readFile(path.join(WEB, rel), 'utf8');
const bump = async () => (await src('app/sw.js')).replace(/ospeli-app-v\d+/, 'ospeli-app-v999');
// A newer release in which the Data page needs something new from the shared ui.js.
async function release(site) {
  site.swap.set('/app/modules/ui.js', `${await src('app/modules/ui.js')}\nexport const addedInNewRelease = 1;\n`);
  site.swap.set('/app/modules/data.js', `import { addedInNewRelease } from './ui.js';\n${await src('app/modules/data.js')}`);
  site.swap.set('/app/sw.js', await bump());
}
const newWorkerInCharge = (page) => page.evaluate(async () => {
  const reg = await navigator.serviceWorker.getRegistration();
  await reg.update();
  for (let i = 0; i < 100; i += 1) {
    const keys = (await caches.keys()).filter((k) => k.startsWith('ospeli-app-v'));
    if (keys.length === 1 && keys[0].startsWith('ospeli-app-v999') && reg.active?.state === 'activated' && !reg.installing && !reg.waiting) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
});
const dataPageOpens = async (page) => {
  await page.evaluate(() => { location.hash = '#/data'; });
  const h = page.locator('main h1:text-is("Your data stays on this device"), main h2:text-is("Something went wrong")');
  await h.first().waitFor({ timeout: 20000 });
  return h.first().textContent();
};

test('issue #108 part 1: a new release that arrives while the app is open does not break the next page', async () => {
  const site = await host();
  const { context, page } = await openControlled(site);
  await release(site);
  assert.equal(await newWorkerInCharge(page), true, 'the new worker took over');
  assert.equal(await dataPageOpens(page), 'Your data stays on this device');
  await context.close(); await site.close();
});

test('issue #108 part 3: a new cache version holds the new files even when the host lets browsers keep files for ten minutes', async () => {
  const site = await host({ cacheControl: 'max-age=600' });
  const { context, page } = await openControlled(site);
  await release(site);
  assert.equal(await newWorkerInCharge(page), true, 'the new worker took over');
  const saved = await page.evaluate(async () => {
    const key = (await caches.keys()).find((k) => k.startsWith('ospeli-app-v999'));
    return (await (await (await caches.open(key)).match('modules/data.js')).text()).includes('addedInNewRelease') ? 'new file' : 'old file';
  });
  assert.equal(saved, 'new file', 'what cache v999 holds for modules/data.js');
  await context.close(); await site.close();
});
