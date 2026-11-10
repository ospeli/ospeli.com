// Outpatients and clinics demo (web/demo/clinics/): each role renders with no sideways scroll,
// reception can take a patient from arrived to finished (and mark did not attend) with the measures
// updating, the booking team can book a slot, guide proposals wait for the right person to confirm,
// and the guide can be switched off. Fictional data only.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './helpers.mjs';

let env;
before(async () => { env = await startApp(); });
after(async () => { await env.close(); });

async function open(width) {
  const context = await env.browser.newContext({ viewport: { width, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(env.base + '/demo/clinics/');
  await page.waitForSelector('#kpis .stat');
  return { context, page, errors };
}
const api = (page, fn) => page.evaluate((f) => window.ospeliClinicsDemo[f](), fn);
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

for (const width of [360, 390, 1280]) {
  test(`clinics renders every role at ${width}px with no sideways scroll`, async () => {
    const { context, page, errors } = await open(width);
    assert.equal(await page.locator('#kpis .stat').count(), 4);
    assert.ok(await page.locator('.sugg').count() >= 2, 'guide shows suggestions');
    for (const role of ['reception', 'booking', 'manager']) {
      await page.click('#r-' + role);
      assert.equal(await page.locator('#r-' + role).getAttribute('aria-pressed'), 'true');
      const o = await overflow(page);
      assert.ok(o <= 0, `${role} view scrolls sideways by ${o}px`);
    }
    if (width < 500) {
      await page.click('#r-reception');
      const h = await page.locator('#toarrive .go').first().boundingBox();
      assert.ok(h.height >= 44, 'front-line buttons are at least 44px tall');
      const small = await page.evaluate(() => [...document.querySelectorAll('#view *')].filter((e) => e.childNodes.length && [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()) && e.offsetParent && parseFloat(getComputedStyle(e).fontSize) < 15).map((e) => e.className + ':' + e.textContent.slice(0, 20)));
      assert.deepEqual(small, [], 'reception text is at least 15px');
    }
    assert.deepEqual(errors, []);
    await context.close();
  });
}

test('reception takes a patient from arrived to finished, and marks did not attend; the measures update', async () => {
  const { context, page, errors } = await open(390);
  await page.click('#r-reception');
  const before = await api(page, 'kpis');
  const btn = page.locator('#toarrive .go').first();
  const id = await btn.getAttribute('id');
  await btn.click();
  assert.equal(await page.locator('#' + id).textContent(), 'Call in');
  const mid = await api(page, 'kpis');
  assert.equal(mid.slotsUsed, before.slotsUsed + 1, 'arrival counts as a used slot');
  await page.click('#' + id);
  assert.equal(await page.locator('#' + id).textContent(), 'Finished');
  assert.equal((await api(page, 'kpis')).calledCount, before.calledCount + 1, 'the call-in adds to the wait-in-clinic measure');
  assert.match(await page.locator('#screen').textContent(), /Now calling/);
  await page.click('#' + id);
  assert.match(await page.locator('#log li').first().textContent(), /finished/);
  // Did not attend: a patient whose booked time has passed (Dermatology has one at the demo start).
  await page.selectOption('#clinic-pick', 'derm');
  const d = page.locator('#toarrive button.dna').first();
  await d.click();
  const after = await api(page, 'kpis');
  assert.equal(after.dnaCount, before.dnaCount + 1);
  assert.match(await page.locator('#kpi-dna .n').textContent(), new RegExp('^' + after.dnaCount + ' of'));
  await page.click('#undo');
  assert.equal((await api(page, 'kpis')).dnaCount, before.dnaCount, 'undo restores the last change');
  assert.deepEqual(errors, []);
  await context.close();
});

test('the booking team books the longest-waiting referral into a free slot', async () => {
  const { context, page, errors } = await open(1280);
  await page.click('#r-booking');
  const before = await api(page, 'kpis');
  const opener = page.locator('#reflist button[id^="open-"]').first();
  const rid = (await opener.getAttribute('id')).slice(5);
  await opener.click();
  await page.click('#book-' + rid);
  const after = await api(page, 'kpis');
  assert.equal(after.unbooked, before.unbooked - 1);
  assert.equal(after.freeSlotsThisWeek, before.freeSlotsThisWeek - 1);
  assert.match(await page.locator('#log li').first().textContent(), /booked/);
  // Reminders
  const sent = Number(await page.locator('#rem-sent').textContent());
  await page.click('#send-rem');
  assert.ok(Number(await page.locator('#rem-sent').textContent()) > sent);
  assert.deepEqual(errors, []);
  await context.close();
});

test('a guide suggestion only proposes; the booking team confirms the offer', async () => {
  const { context, page, errors } = await open(1280);
  await page.click('#r-manager');
  const offer = page.locator('.sugg[data-id^="offer-"]');
  assert.equal(await offer.count(), 1, 'the late-cancelled slot is flagged');
  const unbooked = (await api(page, 'kpis')).unbooked;
  await offer.locator('button.primary').click();
  assert.equal((await api(page, 'kpis')).unbooked, unbooked, 'nothing changes on proposal');
  assert.match(await page.locator('#pending').textContent(), /For the booking team/);
  await page.locator('#pending').getByRole('button', { name: 'Switch to Booking team' }).click();
  await page.locator('#pending').getByRole('button', { name: 'Confirm' }).click();
  const got = await api(page, 'get');
  assert.equal(got.waitingList.filter((r) => r.status === 'offered').length, 1);
  assert.equal((await api(page, 'kpis')).unbooked, unbooked - 1);
  // A late cancellation from the demo tools creates a new free slot.
  const free = (await api(page, 'kpis')).lateCancelledFree;
  await page.click('#t-cancel');
  assert.equal((await api(page, 'kpis')).lateCancelledFree, free + 1);
  assert.deepEqual(errors, []);
  await context.close();
});

test('the guide has an off switch and the views still work without it', async () => {
  const { context, page, errors } = await open(390);
  await page.uncheck('#guide-on');
  assert.equal(await page.locator('.sugg').count(), 0);
  assert.deepEqual(await api(page, 'suggestions'), []);
  await page.click('#r-reception');
  assert.ok(await page.locator('#toarrive .go').count() > 0);
  assert.equal(await page.locator('#kpis .stat').count(), 4);
  assert.deepEqual(errors, []);
  await context.close();
});

test('the read-only agent object returns data', async () => {
  const { context, page, errors } = await open(1280);
  const d = await page.evaluate(() => {
    const o = window.ospeliClinicsDemo;
    return { frozen: Object.isFrozen(o), describe: o.describe(), get: o.get(), kpis: o.kpis(), sugg: o.suggestions(), list: o.listWaiting('Cardiology', 3), slots: o.findSlots('card') };
  });
  assert.ok(d.frozen);
  assert.match(d.describe, /Read-only/);
  assert.equal(d.get.clinics.length, 5);
  assert.ok(d.get.appointments.every((a) => /^P-[A-Z0-9]{4}$/.test(a.code)), 'patients appear as codes only');
  assert.ok(d.kpis.openReferrals > 0 && d.kpis.slotsAvailable > 0);
  assert.ok(d.sugg.length >= 2 && d.sugg.every((s) => s.why && s.decidedBy));
  assert.equal(d.list.length, 3);
  assert.ok(d.list.every((r) => r.service === 'Cardiology'));
  assert.ok(d.slots.every((x) => x.service === 'Cardiology'));
  assert.deepEqual(errors, []);
  await context.close();
});
