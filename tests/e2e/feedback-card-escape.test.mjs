// Finding 4: the patient-facing feedback card can be left without the press-and-hold. The card
// stops Escape by cancelling the dialog's "cancel" event, but the browser only lets a page hold a
// dialog shut once: a second Escape closes it, and the person holding the device is on the staff
// screen.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, openPage } from './helpers.mjs';

let env;
before(async () => { env = await startApp(); });
after(async () => { await env.close(); });
const CLOCK = '2026-11-16T15:00:00.000Z';

test('pressing Escape twice on the feedback card does not drop the patient on the staff screen', async () => {
  const { context, page } = await openPage(env, { width: 1280, height: 900, touch: false, clock: CLOCK, path: '#/feedback' });
  await page.selectOption('#role-select', 'receptionist');
  await page.waitForSelector('.mod-feedback[data-role="receptionist"] .fb-body > *');
  await page.locator('[data-test="hand-over"]').click();
  await page.waitForSelector('dialog[data-test="card"][open]');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  const open = await page.evaluate(() => document.querySelector('dialog[data-test="card"]').open);
  const staffScreen = await page.evaluate(() => { const b = document.querySelector('[data-test="log-form"] button[type="submit"]'); const r = b.getBoundingClientRect(); return document.elementFromPoint(r.x + 5, r.y + 5) === b; });
  assert.deepEqual({ cardOpen: open, staffFormReachable: staffScreen }, { cardOpen: true, staffFormReachable: false }, 'the card is still open after Escape, Escape: only the two-second press and hold leaves it');
  await context.close();
});
