// Shared setup for end-to-end tests: a static server over web/ and a Chromium browser.
import { createRequire } from 'node:module';
import { createServer } from '../../scripts/serve.mjs';
import { roleById } from '../../web/app/core/model.js';
import { moduleById } from '../../web/app/modules/registry.js';

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
// locale: the device's language and region (for example 'en-GB'), for a test that checks a date's exact form.
// timezoneId: the device's time zone (for example 'UTC'), so a date checked from a pinned clock is the same on any machine (issue #95).
// department: navigation v2 asks where the person works on a first open. A test that is not about
// that picks "Wards" (the role then stays Ward nurse, as these tests were written). Pass null to
// see the first open exactly as a new person does, with the department sheet open.
export async function openPage(env, { width = 1280, height = 860, path = '', testHook = true, clock, touch = false, locale, timezoneId, department = 'wards' } = {}) {
  const context = await env.browser.newContext({ viewport: { width, height }, acceptDownloads: true, ...(touch ? { hasTouch: true, isMobile: true } : {}), ...(locale ? { locale } : {}), ...(timezoneId ? { timezoneId } : {}) });
  if (testHook) await context.addInitScript(() => { window.__OSPELI_TEST__ = true; });
  const page = await context.newPage();
  if (clock) await page.clock.install({ time: new Date(clock) });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(env.appUrl + path);
  await page.waitForSelector('html[data-ready="true"]');
  if (department) await chooseDepartment(page, department);
  return { context, page, errors };
}

const drawn = (page) => page.evaluate(() => Number(document.documentElement.dataset.drawn || 0));

// Choose the department in the department sheet (opened from the chip when it is not open), with
// the keyboard: a key press has no spot on the screen, so the app's guard against a second tap
// falling through a closed dialog (issue #147) never holds back the test's next tap. Returns once
// the page has been drawn again for the new department. The same department again changes nothing.
export async function chooseDepartment(page, id) {
  const open = () => page.locator('#dept-sheet[open]').count();
  if ((await page.evaluate(() => document.documentElement.dataset.department)) === id) {
    if (await open()) await page.keyboard.press('Escape');
    return;
  }
  const n = await drawn(page);
  if (!(await open())) await page.locator('#dept-btn').press('Enter');
  await page.locator(`#dept-sheet [data-dept="${id}"]`).press('Enter');
  await page.waitForFunction(([d, was]) => document.documentElement.dataset.department === d && !document.querySelector('#dept-sheet[open]') && Number(document.documentElement.dataset.drawn || 0) > was, [id, n]);
}

// Change the role the way a person does in navigation v2: open Me, choose the role, go back to the
// page they were on (it is drawn again for the new role). Before navigation v2 the role list was in
// the top bar and a role whose whole job is on one page jumped there from the home page by itself;
// that jump is gone, so from the home page this opens the role's own page, as those tests expect.
// The same role chosen again changes nothing, as before.
export async function setRole(page, role) {
  const state = await page.evaluate(() => ({ hash: location.hash, role: document.documentElement.dataset.role }));
  if (state.role === role) return;
  await page.evaluate(() => { location.hash = '#/me'; });
  await page.waitForSelector('#main #role-select');
  await page.selectOption('#role-select', role);
  await page.waitForFunction((r) => document.documentElement.dataset.role === r, role);
  const onHome = /^(#\/?(home\/?)?)?$/.test(state.hash);
  const r = roleById(role);
  const to = !onHome ? state.hash : r.startsOnHome && moduleById(r.home)?.load ? `#/${r.home}` : '#/home';
  await page.evaluate((h) => { location.hash = h; }, to);
  const want = await page.evaluate(() => location.hash);
  await page.waitForFunction((h) => location.hash === h && (document.documentElement.dataset.route === h || document.documentElement.dataset.route === h.replace(/\/$/, '')), want);
}

// Walk mode's naming sheet (walk-first week, 23 Nov 2026): typing and the two tick boxes are behind
// "More options". Opens them the way a person does, when they are not open already.
export async function openMore(page) {
  if (await page.locator('[data-test="walk-more-box"]').count()) return;
  await page.locator('[data-test="walk-more"]').click();
  await page.waitForSelector('[data-test="walk-more-box"]');
}
