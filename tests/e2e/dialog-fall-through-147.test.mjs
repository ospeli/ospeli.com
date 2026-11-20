// Issue #147: a quick second or third tap on a dialog button must not land on the screen
// underneath (the next bed's tile, then that bed's dialog button). Taps are made at the
// button's own spot, as a thumb would, with gaps of 120 and 400 ms.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, openPage } from './helpers.mjs';

let env;
before(async () => { env = await startApp(); });
after(async () => { await env.close(); });

const CLOCK = '2026-11-09T00:40:00Z';

async function eventCount(page) {
  return page.evaluate(async () => (await window.ospeli.core.events()).length);
}

for (const { width, touch, gap } of [
  { width: 360, touch: true, gap: 120 },
  { width: 390, touch: true, gap: 400 },
  { width: 1280, touch: false, gap: 120 },
]) {
  test(`three quick taps on "Patient has left" change one bed only (${width}px, ${touch ? 'touch' : 'mouse'}, ${gap} ms)`, async () => {
    const { context, page, errors } = await openPage(env, { clock: CLOCK, width, height: 860, path: '#/beds', touch });
    await page.waitForSelector('[data-test="bed-grid"] .bed');
    // Every ward, until one has a bed whose dialog offers "Patient has left".
    const wards = await page.$$eval('.ward-tab', (els) => els.map((e) => e.dataset.ward));
    let done = false;
    for (const ward of wards) {
      if (done) break;
      if (wards.length > 1) await page.evaluate((w) => document.querySelector(`.ward-tab[data-ward="${w}"]`)?.click(), ward);
      const beds = await page.$$eval('[data-test="bed-grid"] .bed.st-occupied, [data-test="bed-grid"] .bed.st-expected', (els) => els.map((e) => e.dataset.bed));
      for (const bedId of beds) {
        await page.locator(`.bed[data-bed="${bedId}"]`).click();
        const btn = page.locator('dialog[open] [data-action="vacate"]');
        if (!await btn.count()) { await page.keyboard.press('Escape'); continue; }
        const box = await btn.boundingBox();
        const x = box.x + box.width / 2; const y = box.y + box.height / 2;
        const before = await eventCount(page);
        const vacatedBefore = await page.evaluate(async () => (await window.ospeli.core.events({ type: 'bed.vacated' })).length);
        for (let i = 0; i < 3; i += 1) {
          if (touch) await page.touchscreen.tap(x, y); else await page.mouse.click(x, y);
          await page.waitForTimeout(gap);
        }
        await page.waitForTimeout(800);
        const vacated = await page.evaluate(async () => (await window.ospeli.core.events({ type: 'bed.vacated' })).map((e) => e.subject));
        assert.equal(vacated.length, vacatedBefore + 1, 'exactly one bed was vacated');
        assert.equal(vacated.at(-1), bedId, 'the bed that was vacated is the one whose dialog was open');
        const after = await page.evaluate(async (n) => (await window.ospeli.core.events()).slice(n).map((e) => `${e.type} ${e.subject}`), before);
        assert.ok(after.every((s) => s.endsWith(` ${bedId}`) || !s.startsWith('bed.')), `no other bed changed: ${after.join(', ')}`);
        assert.equal(await page.locator('dialog[open]').count(), 0, 'no other bed\'s dialog was opened by the extra taps');
        done = true;
        break;
      }
    }
    assert.ok(done, 'found a bed with "Patient has left"');
    // A tap somewhere else straight after still works: the guard is for the same spot only.
    const other = page.locator('[data-test="bed-grid"] .bed').first();
    await other.click();
    assert.equal(await page.locator('dialog[open]').count(), 1, 'a tap on another spot opens that bed');
    assert.deepEqual(errors, []);
    await context.close();
  });
}
