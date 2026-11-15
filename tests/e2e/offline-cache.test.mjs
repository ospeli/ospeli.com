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
