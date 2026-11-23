// ospeli/ospeli#150 point 1: more meals delivered than ordered is asked about once (a slip on − or +
// is the likely cause), then saved as entered on the second tap. Synthetic site.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, openPage, setRole, waitUntil } from './helpers.mjs';

let env;
before(async () => { env = await startApp(); });
after(async () => { await env.close(); });

test('#150: delivered above ordered asks once, then saves what was entered', async () => {
  const { context, page, errors } = await openPage(env, { width: 390, height: 844, touch: true, clock: '2026-11-10T14:00:00Z', path: '#/home' });
  await setRole(page, 'ward-nurse');
  await waitUntil(page, async () => (await window.ospeli.core.getMeta('role')) === 'ward-nurse');
  await page.evaluate(() => { localStorage.setItem('ospeli-support-linen-area', 'ward-c1'); location.hash = '#/support/linen'; });
  await page.waitForSelector('[data-test="meal-save"]');
  if (await page.locator('[data-test="meal-ward"]').inputValue() === '') await page.selectOption('[data-test="meal-ward"]', 'ward-c1');
  const before = await page.evaluate(async () => (await window.ospeli.core.events({ type: 'support.meals-recorded' })).length);
  await page.locator('[data-test="meal-pick-evening"]').tap();
  await page.locator('[data-test="meal-ordered"]').fill('20');
  await page.locator('[data-test="meal-delivered"]').fill('25');
  await page.locator('[data-test="meal-returned"]').fill('3');
  await page.locator('[data-test="meal-save"]').tap();
  await page.waitForSelector('[data-test="meal-result"]');
  assert.equal(await page.locator('[data-test="meal-result"]').textContent(), 'Delivered (25) is more than ordered (20). Is that right? Check the numbers, or tap Save again to keep them.');
  assert.equal(await page.evaluate(async () => (await window.ospeli.core.events({ type: 'support.meals-recorded' })).length), before, 'nothing saved on the first tap');
  await page.locator('[data-test="meal-save"]').tap();
  await page.waitForFunction(() => /^Saved: /.test(document.querySelector('[data-test="meal-result"]')?.textContent || ''));
  const meal = await page.evaluate(async () => (await window.ospeli.core.events({ type: 'support.meals-recorded' })).at(-1));
  assert.deepEqual([meal.data.ordered, meal.data.delivered, meal.data.returned], [20, 25, 3]);
  // Delivered equal to ordered saves on the first tap, as before.
  await page.locator('[data-test="meal-pick-midday"]').tap();
  await page.locator('[data-test="meal-ordered"]').fill('20');
  await page.locator('[data-test="meal-delivered"]').fill('20');
  await page.locator('[data-test="meal-returned"]').fill('1');
  await page.locator('[data-test="meal-save"]').tap();
  await page.waitForFunction(() => /^Saved: .*midday/.test(document.querySelector('[data-test="meal-result"]')?.textContent || ''));
  assert.deepEqual(errors, []);
  await context.close();
});
