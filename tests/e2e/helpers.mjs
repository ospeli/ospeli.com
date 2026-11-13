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
// testHook: expose window.ospeli.core for assertions (local only; issue #16). Pass false to see
// the app exactly as a browser agent on the live site does.
// clock: an ISO time to start the page's clock at (time then runs normally), so the synthetic
// hospital, which is generated from the current hour, is the same on every run.
// touch: a phone, so the test taps instead of clicking.
export async function openPage(env, { width = 1280, height = 860, path = '', testHook = true, clock, touch = false } = {}) {
  const context = await env.browser.newContext({ viewport: { width, height }, acceptDownloads: true, ...(touch ? { hasTouch: true, isMobile: true } : {}) });
  if (testHook) await context.addInitScript(() => { window.__OSPELI_TEST__ = true; });
  const page = await context.newPage();
  if (clock) await page.clock.install({ time: new Date(clock) });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(env.appUrl + path);
  await page.waitForSelector('html[data-ready="true"]');
  return { context, page, errors };
}
