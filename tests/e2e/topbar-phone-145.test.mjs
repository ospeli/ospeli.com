// Issue #145 (shared header): on a phone the top bar keeps the phone rules too. Navigation v2: the
// bar's controls are the department chip, the date and time, and Search, on one row; the site's
// name with the "Synthetic data" label sits on a second row that holds no control. Every piece of
// text is at least 15 px, the chip and Search are 44 px targets, nothing overlaps, and the sticky
// bar is no taller than the scroll padding the app sets, so whatever it scrolls to stops below it.
// The desktop bar keeps its sizes.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, openPage } from './helpers.mjs';

let env;
before(async () => { env = await startApp(); });
after(async () => { await env.close(); });

const measure = (page) => page.evaluate(() => {
  const box = (sel) => { const e = document.querySelector(sel); const r = e.getBoundingClientRect();
    return { sel, top: r.top, bottom: r.bottom, left: r.left, right: r.right, h: r.height, w: r.width, fs: parseFloat(getComputedStyle(e).fontSize), clipped: e.scrollWidth > e.clientWidth + 0.5 }; };
  return { chip: box('#dept-btn'), chipName: box('#dept-name'), time: box('#top-time'), search: box('#top-search'), row: box('.topbar .hospital'),
    name: box('.topbar .hospital-name'), badge: box('.topbar .badge-synthetic'), bar: box('.topbar'),
    padTop: parseFloat(getComputedStyle(document.documentElement).scrollPaddingTop), scroll: document.documentElement.scrollWidth };
});
const overlap = (a, b) => a.left < b.right - 0.5 && a.right > b.left + 0.5 && a.top < b.bottom - 0.5 && a.bottom > b.top + 0.5;

for (const width of [360, 390]) {
  test(`top bar at ${width}px: chip, time and Search on one row, nothing overlapping, 44 px targets, 15 px text, two rows within the scroll padding (issue #145)`, async () => {
    for (const route of ['#/', '#/beds', '#/process']) {
      const { context, page, errors } = await openPage(env, { width, height: 800, path: route, clock: '2026-11-10T10:00:00Z', touch: true });
      await page.waitForTimeout(300);
      const m = await measure(page);
      // 15 px text.
      for (const k of ['chip', 'chipName', 'time', 'search', 'name', 'badge']) assert.ok(m[k].fs >= 15, `${route}: ${m[k].sel} is ${m[k].fs}px`);
      // 44 px targets.
      for (const k of ['chip', 'search']) assert.ok(m[k].h >= 44 && m[k].w >= 44, `${route}: ${m[k].sel} is ${m[k].w}x${m[k].h}`);
      // The controls share one row, and the badge row is below it.
      const mid = (b) => (b.top + b.bottom) / 2;
      assert.ok(Math.abs(mid(m.chip) - mid(m.time)) < 12 && Math.abs(mid(m.chip) - mid(m.search)) < 12, `${route}: chip, time and Search on one row (${mid(m.chip)}, ${mid(m.time)}, ${mid(m.search)})`);
      assert.ok(m.row.top >= Math.max(m.chip.bottom, m.search.bottom) - 0.5, `${route}: the site's name and label sit on the row below the controls`);
      assert.equal(m.badge.top - m.name.top < 12, true, `${route}: the label sits beside the site's name (name at ${m.name.top}, label at ${m.badge.top})`);
      // Nothing overlaps, and the time and the chip's name are shown whole.
      const parts = [m.chip, m.time, m.search, m.name, m.badge];
      for (let i = 0; i < parts.length; i++) for (let j = i + 1; j < parts.length; j++) assert.ok(!overlap(parts[i], parts[j]), `${route}: ${parts[i].sel} overlaps ${parts[j].sel}`);
      assert.ok(!m.time.clipped, `${route}: the date and time are cut off`);
      assert.ok(!m.chipName.clipped, `${route}: the department's name is cut off`);
      assert.ok(m.search.right <= width && m.chip.left >= 0, `${route}: the controls are inside the screen`);
      // Two rows, no taller than the scroll padding the app sets for the sticky bar.
      assert.ok(m.bar.h <= 110, `${route}: the bar is two rows (${m.bar.h}px tall)`);
      assert.ok(m.bar.h <= m.padTop, `${route}: the bar (${m.bar.h}px) is no taller than scroll-padding-top (${m.padTop}px)`);
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

test('the desktop top bar keeps its sizes at 1280px (issue #145 touches phones only)', async () => {
  const { context, page } = await openPage(env, { width: 1280, path: '#/', clock: '2026-11-10T10:00:00Z' });
  const m = await measure(page);
  assert.ok(Math.abs(m.badge.fs - 11.84) < 0.1, `badge ${m.badge.fs}px`);
  // From 900 px the bar is one row: the controls and the site's name share it.
  const mid = (b) => (b.top + b.bottom) / 2;
  for (const k of ['time', 'search', 'name', 'badge']) assert.ok(Math.abs(mid(m.chip) - mid(m[k])) < 12, `${m[k].sel} on the chip's row`);
  assert.ok(m.chip.h >= 44 && m.search.h >= 44);
  // The logo is no longer in the top bar; the symbol on the dock's Walk button keeps the logo's 34 px.
  const img = await page.locator('#dock [data-dock="walk"] img').boundingBox();
  assert.equal(Math.round(img.height), 34);
  await context.close();
});
