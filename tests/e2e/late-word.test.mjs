// Issue #86 item 3: the maintenance queue says "Late" (filter, counts, "Late by"), so the KPI tile
// under it says "Late work orders" too: one word for one idea on one screen. The KPI id is unchanged.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, openPage } from './helpers.mjs';

let env;
before(async () => { env = await startApp(); });
after(async () => { await env.close(); });

for (const width of [360, 390, 1280]) {
  test(`maintenance queue and its KPI tile use one word, "late", at ${width}px (issue #86)`, async () => {
    const phone = width < 641;
    const { context, page, errors } = await openPage(env, { width, height: phone ? 800 : 860, path: '#/engineering', clock: '2026-11-10T10:00:00Z', touch: phone });
    await page.waitForSelector('.kpi-name');
    const text = await page.$eval('#main', (m) => m.innerText);
    assert.match(text, /Late work orders/);
    assert.doesNotMatch(text, /overdue/i, 'no "overdue" on the maintenance screen');
    assert.deepEqual(errors, []);
    await context.close();
  });
}

test('the KPI keeps its id; only the words change (issue #86)', async () => {
  const { KPIS } = await import('../../web/app/core/kpi.js');
  const k = KPIS.find((x) => x.id === 'overdue-work-orders');
  assert.equal(k.name, 'Late work orders');
  assert.equal(k.targetText, 'None late');
});
