import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, openPage } from './helpers.mjs';

let env;
before(async () => { env = await startApp(); });
after(async () => { await env.close(); });

for (const width of [390, 1280]) {
  test(`KPI tiles show their definition on tap at ${width}px`, async () => {
    const { context, page, errors } = await openPage(env, { width });
    const tiles = page.locator('button.kpi');
    assert.equal(await tiles.count(), 7);
    // Ward nurse owns "discharges before noon", so it comes first.
    assert.equal(await tiles.first().getAttribute('data-kpi'), 'discharges-before-noon');
    await page.click('button[data-kpi="occupancy"]');
    const dlg = page.locator('dialog[open]');
    await dlg.waitFor();
    const text = await dlg.textContent();
    for (const label of ['Counts', 'Out of', 'Leaves out', 'Target', 'Owner', 'Source', 'Period', 'Calculated from']) assert.match(text, new RegExp(label));
    assert.match(text, /of 120\)/);
    const box = await dlg.boundingBox();
    assert.ok(box.x >= 0 && box.x + box.width <= width, 'dialog fits the screen');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('dialog[open]').count(), 0);
    assert.equal(await page.evaluate(() => document.activeElement.dataset.kpi), 'occupancy', 'focus returns to the tile');
    assert.deepEqual(errors, []);
    await context.close();
  });
}

test('KPI values recompute from the event log', async () => {
  const { context, page } = await openPage(env);
  const read = () => page.locator('button[data-kpi="open-work-orders"] .kpi-value').textContent();
  const before = Number(await read());
  await page.evaluate(() => window.ospeli.core.appendEvent({ type: 'asset.fault-reported', subject: 'asset-a1-sink-1', actorRole: 'ward-nurse', data: { workOrder: 'wo-e2e', priority: 'routine', title: 'Blocked sink' } }));
  await page.reload();
  await page.waitForSelector('html[data-ready="true"]');
  assert.equal(Number(await read()), before + 1);
  await context.close();
});
