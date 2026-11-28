// Issue #37: the app's short messages never cover a control a person is about to tap, and no
// message shows when the app first opens. Checked at 360, 390 and 1280 px.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, openPage, chooseDepartment } from './helpers.mjs';

const ROUTES = ['#/', '#/beds', '#/engineering', '#/process', '#/kpi', '#/agents', '#/data'];
let env;
before(async () => { env = await startApp(); });
after(async () => { await env.close(); });

// Controls (outside the message itself) that the visible message overlaps.
// barOnly: only the top bar's own controls (navigation v2: the department chip and Search).
const covered = (page, barOnly = false) => page.evaluate((barOnly) => {
  const t = document.querySelector('#toast.show');
  if (!t) return null;
  const a = t.getBoundingClientRect();
  const bar = document.querySelector('.topbar');
  const barBottom = bar.getBoundingClientRect().bottom;
  return [...document.querySelectorAll('button, a, select, input, textarea, summary, [tabindex="0"]')].filter((el) => {
    if (t.contains(el)) return false;
    if (barOnly && !bar.contains(el)) return false;
    const b = el.getBoundingClientRect(); const s = getComputedStyle(el);
    if (!b.width || !b.height || s.visibility === 'hidden') return false;
    // A control scrolled under the sticky top bar is hidden by the bar itself, message or not.
    if (!bar.contains(el) && b.bottom <= barBottom + 0.5) return false;
    return b.left < a.right && b.right > a.left && b.top < a.bottom && b.bottom > a.top;
  }).map((el) => `${el.tagName.toLowerCase()} "${(el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 30)}"`);
}, barOnly);

for (const width of [360, 390, 1280]) {
  const phone = width < 641;
  test(`a message never covers a control at ${width}px, and none shows on first open (issue #37)`, async () => {
    for (const route of ROUTES) {
      // A real first open: the department sheet is open and no message shows. The person's answer
      // gets a message ("Wards. Role set to Ward nurse; change it under Me": one message since crew
      // night 6, #166 item 4; was "Department: Wards"), which must not cover a control either.
      const { context, page, errors } = await openPage(env, { width, height: phone ? 800 : 860, path: route, clock: '2026-11-10T10:00:00Z', touch: phone, department: null });
      await page.waitForTimeout(300);
      assert.equal(await covered(page), null, `${route}: no message on first open`);
      await chooseDepartment(page, 'wards');
      await page.waitForSelector('#toast.show');
      assert.equal(await page.textContent('#toast'), 'Wards. Role set to Ward nurse; change it under Me');
      assert.deepEqual(await covered(page), [], `${route}: the department message covers a control`);
      // Opened again with the department kept: still no message.
      await page.reload();
      await page.waitForSelector('html[data-ready="true"]');
      await page.waitForTimeout(300);
      assert.equal(await covered(page), null, `${route}: no message when the app opens again`);
      // Navigation v2: the role is chosen on Me, and the person stays there, so the role message
      // shows over Me; then they go back to the page they came from.
      await page.evaluate(() => { location.hash = '#/me'; });
      await page.waitForSelector('#main #role-select');
      await page.selectOption('#role-select', 'coo');
      await page.waitForFunction(() => document.querySelector('#toast.show')?.textContent === 'Role: COO' && document.querySelector('main h1')?.textContent === 'COO');
      assert.deepEqual(await covered(page), [], `${route}: the role message covers a control`);
      const n = await page.evaluate(() => Number(document.documentElement.dataset.drawn));
      await page.goBack();
      await page.waitForFunction((was) => Number(document.documentElement.dataset.drawn) > was && document.documentElement.dataset.route !== '#/me', n);
      // The longest message the app shows, scrolled half way down the page.
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight / 2));
      await page.evaluate(async () => (await import('./app.js')).toast("Not saved. This device is not connected. Try again when it is back on your site's network."));
      await page.waitForTimeout(250);
      // A long message may reach below the bar for its 3 seconds (it wraps to three lines on a
      // phone); it never covers the top bar's own controls (the department chip, Search).
      const inBar = await covered(page, true);
      assert.deepEqual(inBar, [], `${route}: a long message covers a control in the top bar`);
      const fs = await page.$eval('#toast', (t) => parseFloat(getComputedStyle(t).fontSize));
      assert.ok(fs >= 15, `message text ${fs}px`);
      assert.equal(await page.getAttribute('#toast', 'role'), 'status');
      assert.deepEqual(errors, []);
      await context.close();
    }
  });

  test(`"Tried in Proposed" does not cover the map controls at ${width}px (issue #37)`, async () => {
    const { context, page } = await openPage(env, { width, height: phone ? 800 : 860, path: '#/process', clock: '2026-11-10T10:00:00Z', touch: phone });
    await page.click('[data-from="discharge"]');
    await page.waitForSelector('[data-cmd="ospeli_maps_try_suggestion"]');
    await page.click('[data-cmd="ospeli_maps_try_suggestion"] >> nth=0');
    await page.waitForSelector('#toast.show');
    assert.deepEqual(await covered(page), []);
    await context.close();
  });
}
