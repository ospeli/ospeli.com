// Issue #33: the decision-to-bed tile has its new name, fits a phone, and its definition shows the
// 90th percentile beside the median and says the 4 h example is not a four-hour ED standard.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, openPage } from './helpers.mjs';

let env;
before(async () => { env = await startApp(); });
after(async () => { await env.close(); });

for (const width of [360, 1280]) {
  test(`decision to admit to ward bed: name, 90th percentile and the four-hour label (${width}px)`, async () => {
    const phone = width < 500;
    const { context, page, errors } = await openPage(env, { width, height: 800, path: '#/beds', clock: '2026-11-10T10:00:00Z', touch: phone, timezoneId: 'UTC' });
    const tile = page.locator('[data-kpi="decision-to-bed"]');
    await tile.waitFor();
    assert.equal(await tile.locator('.kpi-name').textContent(), 'Decision to admit to ward bed (ED)');
    const box = await tile.boundingBox();
    assert.ok(box.x >= 0 && box.x + box.width <= width, 'the tile fits the screen');
    await tile.evaluate((b) => b.click());
    const dlg = page.locator('dialog.kpi-dialog[open]');
    await dlg.waitFor();
    const p90 = dlg.locator('[data-test="kpi-p90"]');
    assert.match(await p90.textContent(), /^90th percentile: \d+(\.\d)? h\. Nine in ten were this or less\.$/);
    if (phone) assert.ok(parseFloat(await p90.evaluate((e) => getComputedStyle(e).fontSize)) >= 15);
    // The number in the dialog is the one the event log gives.
    const want = await page.evaluate(async () => {
      const { computeKpi, formatKpi, kpiById } = await import('./core/kpi.js');
      const { kpiContext } = await import('./modules/kpi-tiles.js');
      const k = await kpiContext(window.ospeli.core);
      return formatKpi(kpiById('decision-to-bed'), computeKpi('decision-to-bed', k.events, k.opts).p90);
    });
    assert.ok((await p90.textContent()).includes(want), `${want}`);
    const text = await dlg.innerText();
    assert.match(text, /not a four-hour emergency department standard/);
    assert.match(text, /PMID 21067846/);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), 0);
    assert.deepEqual(errors, []);
    await context.close();
  });
}
