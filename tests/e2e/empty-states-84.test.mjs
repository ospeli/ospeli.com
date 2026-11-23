// Issue #84 item 2 (founder note, 13 Nov): every list has a designed empty state, starting with the
// technician queue. (Item 4, reduce motion, is reduced-motion-84.test.mjs.)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, openPage, setRole } from './helpers.mjs';

let env;
before(async () => { env = await startApp(); });
after(async () => { await env.close(); });

const CLOCK = '2026-11-10T10:00:00Z';
const readable = (page, sel) => page.locator(sel).evaluate((e) => {
  const r = e.getBoundingClientRect(); const cs = getComputedStyle(e);
  return { w: r.width, right: r.right, px: parseFloat(cs.fontSize), seen: r.height > 0 && cs.visibility !== 'hidden' };
});

for (const width of [360, 1280]) {
  test(`engineering: with every job closed, each work-order list says so in words (${width}px)`, async () => {
    const { context, page, errors } = await openPage(env, { width, height: 780, path: '#/engineering', clock: CLOCK, touch: width < 500 });
    await setRole(page, 'estates-tech');
    await page.waitForSelector('[data-test="wo-queue"][data-role="estates-tech"] [data-test="wo-list"] [data-wo]');
    await page.evaluate(async () => {
      const { runCommand } = await import('./core/commands.js');
      const core = window.ospeli.core; const tech = { type: 'human', role: 'estates-tech' };
      const open = await runCommand(core, 'ospeli_workorders_list', { state: 'open', limit: 500 }, tech);
      for (const w of open.workOrders) await runCommand(core, 'ospeli_workorders_complete', { workOrderId: w.id, outcome: 'fixed' }, tech);
    });
    const empty = page.locator('[data-test="wo-list"] [data-test="wo-empty"]');
    await empty.waitFor();
    assert.equal(await empty.textContent(), 'All clear: no open work orders. A new fault shows here as soon as it is reported.');
    const r = await readable(page, '[data-test="wo-empty"]');
    assert.ok(r.seen && r.right <= width && r.px >= 15, JSON.stringify(r));
    for (const [filter, words] of [['overdue', 'Nothing is late: every open work order is within its target.'], ['repeat', 'No repeat faults among the open work orders.']]) {
      await page.locator(`.chip-btn[data-filter="${filter}"]`).click();
      await page.waitForFunction((f) => document.querySelector(`.chip-btn[data-filter="${f}"]`)?.getAttribute('aria-pressed') === 'true', filter);
      assert.equal(await empty.textContent(), words);
    }
    // Closed jobs are listed, so that list is not empty.
    await page.locator('.chip-btn[data-filter="completed"]').click();
    await page.waitForSelector('[data-test="wo-list"] [data-wo]');
    assert.equal(await empty.count(), 0);
    // The suggested-job card says the same thing.
    assert.match(await page.locator('[data-test="next-card"] h3').textContent(), /^No job is waiting for the /);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), 0);
    assert.deepEqual(errors, []);
    await context.close();
  });
}

test('patient feedback: an empty queue view says what is empty, not "Nothing here" (390px)', async () => {
  const { context, page, errors } = await openPage(env, { width: 390, height: 844, path: '#/feedback', clock: '2026-11-16T15:00:00.000Z', touch: true });
  await setRole(page, 'patient-liaison');
  await page.waitForSelector('.mod-feedback[data-role="patient-liaison"] [data-test="queue-list"]');
  const seen = new Map();
  for (const view of await page.locator('.fb-views [data-view]').evaluateAll((bs) => bs.map((b) => b.dataset.view))) {
    await page.locator(`.fb-views [data-view="${view}"]`).click();
    await page.waitForFunction((v) => document.querySelector(`.fb-views [data-view="${v}"]`)?.getAttribute('aria-pressed') === 'true', view);
    const empty = page.locator('[data-test="queue-list"] [data-test="queue-empty"]');
    if (await empty.count()) seen.set(view, await empty.textContent());
    assert.equal(await page.locator('[data-test="queue-list"]').getByText('Nothing here.', { exact: true }).count(), 0, view);
  }
  // With the example month of feedback some views have records; every empty one said what was empty.
  for (const [view, words] of seen) assert.ok(words.length > 20 && !/^Nothing here/.test(words), `${view}: ${words}`);
  assert.deepEqual(errors, []);
  await context.close();
});
