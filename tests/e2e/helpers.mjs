// Shared setup for end-to-end tests: a static server over web/ and a Chromium browser.
import { createRequire } from 'node:module';
import { createServer } from '../../scripts/serve.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

export async function startApp() {
  const server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch();
  return {
    base,
    appUrl: `${base}/app/`,
    browser,
    async close() { await browser.close(); await new Promise((r) => server.close(r)); },
  };
}

// A fresh browser context per test (own IndexedDB and service worker), with error capture.
export async function openPage(env, { width = 1280, height = 860, path = '' } = {}) {
  const context = await env.browser.newContext({ viewport: { width, height }, acceptDownloads: true });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(env.appUrl + path);
  await page.waitForSelector('html[data-ready="true"]');
  return { context, page, errors };
}
