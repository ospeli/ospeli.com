// Quality bar: every built app screen works at phone, tablet and desktop widths with no sideways
// scroll (issue #23: the Engineering fault form overflowed a 360 px screen and hid "Routine").
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, openPage } from './helpers.mjs';

let env;
before(async () => { env = await startApp(); });
after(async () => { await env.close(); });

const ROUTES = ['#/', '#/beds', '#/engineering', '#/process', '#/kpi', '#/agents', '#/data'];
const ROLES = ['ward-nurse', 'estates-tech'];

for (const width of [360, 390, 1024, 1280]) {
  test(`every built screen fits ${width}px with no sideways scroll`, async () => {
    const { context, page, errors } = await openPage(env, { width, height: 800, clock: '2026-11-10T10:00:00Z' });
    for (const role of ROLES) {
      await page.selectOption('#role-select', role);
      for (const r of ROUTES) {
        await page.evaluate((h) => { location.hash = h; }, r);
        await page.waitForTimeout(700); // modules render async; let the view swap in
        const o = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        assert.ok(o <= 0, `${role} ${r} scrolls sideways by ${o}px at ${width}px`);
      }
    }
    assert.deepEqual(errors, []);
    await context.close();
  });
}

test('Engineering at 360px: all three urgency options are on screen, Routine is chosen', async () => {
  const { context, page } = await openPage(env, { width: 360, height: 800, path: '#/engineering', clock: '2026-11-10T10:00:00Z' });
  await page.waitForSelector('[data-test="report-form"]');
  const opts = await page.$$eval('.prio-opt', (els) => els.map((e) => {
    const b = e.getBoundingClientRect();
    return { left: b.left, right: b.right, checked: !!e.querySelector('input:checked'), text: e.textContent };
  }));
  assert.equal(opts.length, 3);
  for (const o of opts) assert.ok(o.left >= 0 && o.right <= 360, `"${o.text}" is cut off (${o.left}-${o.right})`);
  assert.ok(opts.some((o) => o.checked && /Routine/.test(o.text)), 'Routine is visible and pre-selected');
  await context.close();
});
