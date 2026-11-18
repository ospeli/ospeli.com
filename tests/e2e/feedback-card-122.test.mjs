// Issue #122: a patient holding the feedback card must not reach the staff screens with ordinary
// taps. "Yes, staff screen" now needs a press and hold of two seconds, with a visible count; a tap,
// or letting go early, leaves the card open.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, openPage } from './helpers.mjs';

let env;
before(async () => { env = await startApp(); });
after(async () => { await env.close(); });

async function openCard(width) {
  const { context, page, errors } = await openPage(env, { width, touch: width < 500, clock: '2026-11-10T14:00:00Z' });
  await page.selectOption('#role-select', 'receptionist');
  await page.evaluate(() => { location.hash = '#/feedback/quick'; });
  await page.waitForSelector('[data-test="hand-over"]');
  await page.locator('[data-test="hand-over"]').click();
  await page.waitForFunction(() => document.querySelector('dialog[data-test="card"]').open);
  return { context, page, errors, dlg: page.locator('dialog[data-test="card"]') };
}
const isOpen = (page) => page.evaluate(() => document.querySelector('dialog[data-test="card"]').open);

for (const width of [360, 390, 1280]) {
  test(`${width} px: two ordinary taps do not leave the card; a two-second hold does (#122)`, async () => {
    const { context, page, errors, dlg } = await openCard(width);
    await dlg.locator('[data-test="card-exit"]').click();
    const yes = dlg.locator('[data-test="card-exit-yes"]');
    assert.match(await yes.textContent(), /hold/i, 'the button says to hold it');
    assert.ok((await yes.boundingBox()).height >= 44);
    await yes.click();
    await page.waitForTimeout(2500);
    assert.equal(await isOpen(page), true, 'a tap leaves the card open');
    assert.match(await dlg.locator('[data-test="card-hold-note"]').textContent(), /2 seconds/);
    // Let go after one second: still on the card.
    await yes.dispatchEvent('pointerdown');
    await page.waitForTimeout(1000);
    assert.match(await dlg.locator('[data-test="card-hold-note"]').textContent(), /Keep holding/);
    await yes.dispatchEvent('pointerup');
    await page.waitForTimeout(1500);
    assert.equal(await isOpen(page), true, 'letting go early leaves the card open');
    // A full hold returns to the staff screen.
    await yes.dispatchEvent('pointerdown');
    await page.waitForTimeout(2300);
    await page.waitForFunction(() => !document.querySelector('dialog[data-test="card"]').open);
    assert.deepEqual(errors, []);
    await context.close();
  });
}

test('keyboard: holding Enter for two seconds returns to staff; a short press does not (#122)', async () => {
  const { context, page, errors, dlg } = await openCard(1280);
  await dlg.locator('[data-test="card-exit"]').click();
  await dlg.locator('[data-test="card-exit-yes"]').focus();
  await page.keyboard.press('Enter');
  await page.waitForTimeout(2500);
  assert.equal(await isOpen(page), true);
  await page.keyboard.down('Enter');
  await page.waitForTimeout(2300);
  await page.keyboard.up('Enter');
  await page.waitForFunction(() => !document.querySelector('dialog[data-test="card"]').open);
  assert.deepEqual(errors, []);
  await context.close();
});
