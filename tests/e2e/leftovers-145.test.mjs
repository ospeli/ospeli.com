// ospeli/ospeli#145 (B3 slice 2 leftovers): Stores says a wait under a day in hours and minutes,
// not "1 h" for anything under 90 minutes; the linen count says untouched boxes are not saved;
// correcting a meal count starts from the saved numbers. Synthetic site.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, openPage, setRole, waitUntil } from './helpers.mjs';

let env;
before(async () => { env = await startApp(); });
after(async () => { await env.close(); });
const CLOCK = '2026-11-10T14:00:00Z';

test('#145: an order step recorded a moment ago reads "under a minute", not "1 h"', async () => {
  const { context, page, errors } = await openPage(env, { width: 1280, clock: CLOCK, path: '#/home' });
  await setRole(page, 'ops-manager');
  await waitUntil(page, async () => (await window.ospeli.core.getMeta('role')) === 'ops-manager');
  await page.evaluate(() => { location.hash = '#/stores/orders'; });
  const approve = page.locator('[data-cmd="ospeli_stores_order_step"][data-step="approved"]').first();
  await approve.waitFor();
  const order = await approve.locator('xpath=ancestor::li[@data-order]').getAttribute('data-order');
  await approve.click();
  await waitUntil(page, async (o) => (await window.ospeli.core.events({ subject: o })).at(-1)?.data?.step === 'approved', order);
  const card = page.locator(`li.sto-order[data-order="${order}"]`).first();
  await page.waitForFunction((o) => document.querySelector(`li.sto-order[data-order="${o}"]`)?.dataset.state === 'approved', order);
  const wait = await card.locator('.sto-wait').textContent();
  assert.match(wait, / · under a minute$/, wait);
  assert.match(await card.locator('.sto-steps li.is-now').textContent(), /under a minute so far$/);
  assert.doesNotMatch(await page.locator('.sto').textContent(), /\b1 h\b(?! \d)/, 'no bare "1 h" left on the orders screen');
  assert.deepEqual(errors, []);
  await context.close();
});

test('#145: the linen count says untouched boxes are not saved; correcting a meal count starts from the saved numbers', async () => {
  const { context, page, errors } = await openPage(env, { width: 390, height: 844, touch: true, clock: CLOCK, path: '#/home' });
  await setRole(page, 'ward-nurse');
  await waitUntil(page, async () => (await window.ospeli.core.getMeta('role')) === 'ward-nurse');
  await page.evaluate(() => { localStorage.setItem('ospeli-support-linen-area', 'ward-c1'); location.hash = '#/support/linen'; });
  await page.waitForSelector('[data-test="meal-save"]');
  assert.match(await page.locator('.sup-hint').textContent(), /untouched boxes are not saved\.$/);
  if (await page.locator('[data-test="meal-ward"]').inputValue() === '') await page.selectOption('[data-test="meal-ward"]', 'ward-c1');
  const vals = () => Promise.all(['ordered', 'delivered', 'returned'].map((k) => page.locator(`[data-test="meal-${k}"]`).inputValue()));
  await page.locator('[data-test="meal-pick-evening"]').tap();
  await page.locator('[data-test="meal-ordered"]').fill('20');
  await page.locator('[data-test="meal-delivered"]').fill('18');
  await page.locator('[data-test="meal-returned"]').fill('3');
  await page.locator('[data-test="meal-save"]').tap();
  await page.waitForFunction(() => /^(Saved|Corrected): /.test(document.querySelector('[data-test="meal-result"]')?.textContent || ''));
  await page.waitForSelector('[data-test="meal-saved"]');
  assert.match(await page.locator('[data-test="meal-saved"]').textContent(), /^Saved already: 20 ordered, 18 delivered, 3 returned uneaten\. The boxes start from these/);
  assert.deepEqual(await vals(), ['20', '18', '3'], 'the correction starts from the saved numbers');
  assert.equal(await page.locator('[data-test="meal-save"]').textContent(), 'Save the correction');
  // Change only what was wrong.
  await page.locator('[data-test="meal-returned"]').fill('4');
  await page.locator('[data-test="meal-save"]').tap();
  await page.waitForFunction(() => /^Corrected: .*4 of 18/.test(document.querySelector('[data-test="meal-result"]')?.textContent || ''));
  const meal = await page.evaluate(async () => (await window.ospeli.core.events({ type: 'support.meals-recorded' })).at(-1));
  assert.deepEqual([meal.data.meal, meal.data.ordered, meal.data.delivered, meal.data.returned], ['evening', 20, 18, 4]);
  // Another meal: its own saved numbers, or empty boxes; never the evening's.
  await page.locator('[data-test="meal-pick-breakfast"]').tap();
  const other = page.locator('[data-test="meal-saved"]');
  if (await other.count()) {
    const [, o, d, r] = (await other.textContent()).match(/(\d+) ordered, (\d+) delivered, (\d+) returned/);
    assert.deepEqual(await vals(), [o, d, r]);
  } else assert.deepEqual(await vals(), ['', '', '']);
  assert.deepEqual(errors, []);
  await context.close();
});
