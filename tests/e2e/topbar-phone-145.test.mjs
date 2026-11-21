// Issue #145 (shared header): on a phone the top bar keeps the phone rules too. The "Synthetic
// data" label and the role picker are at least 15 px, the logo link is a 44 px target, and the
// bar still takes two rows (logo, role and Menu; then the site's name with the label beside it).
// The desktop bar is unchanged.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, openPage } from './helpers.mjs';

let env;
before(async () => { env = await startApp(); });
after(async () => { await env.close(); });

const measure = (page) => page.evaluate(() => {
  const box = (sel) => { const e = document.querySelector(sel); const r = e.getBoundingClientRect(); return { top: Math.round(r.top), h: r.height, w: r.width, fs: parseFloat(getComputedStyle(e).fontSize) }; };
  return { brand: box('.topbar .brand'), badge: box('.topbar .badge-synthetic'), select: box('#role-select'), name: box('.topbar .hospital-name'),
    bar: box('.topbar'), scroll: document.documentElement.scrollWidth };
});

for (const width of [360, 390]) {
  test(`top bar at ${width}px: 15 px text, a 44 px logo link, two rows (issue #145)`, async () => {
    for (const route of ['#/', '#/beds', '#/process']) {
      const { context, page, errors } = await openPage(env, { width, height: 800, path: route, clock: '2026-11-10T10:00:00Z', touch: true });
      await page.waitForTimeout(300);
      const m = await measure(page);
      assert.ok(m.badge.fs >= 15, `${route}: "Synthetic data" is ${m.badge.fs}px`);
      assert.ok(m.select.fs >= 15, `${route}: the role picker is ${m.select.fs}px`);
      assert.ok(m.brand.h >= 44 && m.brand.w >= 44, `${route}: the logo link is ${m.brand.w}x${m.brand.h}`);
      assert.equal(m.badge.top - m.name.top < 12, true, `${route}: the label sits beside the site's name (name at ${m.name.top}, label at ${m.badge.top})`);
      assert.ok(m.bar.h <= 110, `${route}: the bar is two rows (${m.bar.h}px tall)`);
      assert.equal(m.scroll, width, `${route}: no sideways scroll`);
      // The bar is sticky: whatever the app scrolls to stops below it, not underneath it.
      const under = await page.evaluate(() => { const max = document.documentElement.scrollHeight - innerHeight;
        const t = [...document.querySelectorAll('main h2, main h3')].find((x) => { const y = x.getBoundingClientRect().top + scrollY; return y > innerHeight && y < max; }); if (!t) return null;
        window.scrollTo(0, max); t.scrollIntoView({ block: 'start' });
        return { top: t.getBoundingClientRect().top, bar: document.querySelector('.topbar').getBoundingClientRect().bottom, max: document.documentElement.scrollHeight - innerHeight, y: scrollY }; });
      if (under && under.y < under.max) assert.ok(under.top >= under.bar, `${route}: a heading scrolled to sits under the bar (top ${under.top}, bar ends ${under.bar})`);
      assert.deepEqual(errors, []);
      await context.close();
    }
  });
}

test('the desktop top bar is unchanged at 1280px (issue #145 touches phones only)', async () => {
  const { context, page } = await openPage(env, { width: 1280, path: '#/', clock: '2026-11-10T10:00:00Z' });
  const m = await measure(page);
  assert.ok(Math.abs(m.badge.fs - 11.84) < 0.1, `badge ${m.badge.fs}px`);
  assert.ok(Math.abs(m.select.fs - 14.4) < 0.1, `role picker ${m.select.fs}px`);
  assert.equal(Math.round(m.brand.h), 34);
  await context.close();
});
