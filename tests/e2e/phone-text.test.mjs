// Issue #13: on a phone, every piece of text on the main pages is at least 15 px. Since #145 that
// includes the top bar's "Synthetic data" label (no exception left).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, openPage } from './helpers.mjs';

const ROUTES = ['#/', '#/beds', '#/engineering', '#/process', '#/kpi', '#/agents', '#/data'];
let env;
before(async () => { env = await startApp(); });
after(async () => { await env.close(); });

const small = (page) => page.evaluate(() => [...document.querySelectorAll('body *')].filter((n) => {
  const r = n.getBoundingClientRect(); const s = getComputedStyle(n);
  if (r.width <= 1 || r.height <= 1 || s.visibility === 'hidden' || s.display === 'none') return false;
  return [...n.childNodes].some((c) => c.nodeType === 3 && c.textContent.trim()) && parseFloat(s.fontSize) < 14.95;
}).map((n) => `${n.tagName.toLowerCase()}.${[...n.classList].join('.')} "${n.textContent.trim().slice(0, 24)}" ${parseFloat(getComputedStyle(n).fontSize).toFixed(2)}px`));

for (const width of [360, 390]) {
  test(`phone text is at least 15 px on the main pages at ${width}px (issue #13)`, async () => {
    const found = [];
    for (const route of ROUTES) {
      const { context, page, errors } = await openPage(env, { width, height: 800, path: route, clock: '2026-11-10T10:00:00Z', touch: true });
      await page.waitForTimeout(300);
      for (const s of await small(page)) found.push(`${route} ${s}`);
      assert.deepEqual(errors, []);
      await context.close();
    }
    assert.deepEqual([...new Set(found)], []);
  });
}

test('desktop text sizes are unchanged at 1280px (issue #13 touches phones only)', async () => {
  const { context, page } = await openPage(env, { width: 1280, path: '#/beds', clock: '2026-11-10T10:00:00Z' });
  const px = await page.evaluate(() => parseFloat(getComputedStyle(document.querySelector('.chip, .bed-age, .eyebrow')).fontSize));
  assert.ok(px < 15, `desktop keeps its smaller labels (${px}px)`);
  await context.close();
});
