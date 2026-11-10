// Maternity and children's flow demo (web/demo/maternity/): each role renders with no sideways
// scroll, the midwife or nurse in charge can admit, discharge, clean and request a transfer and the
// numbers update, the flow coordinator moves transfers through stages and logs closures, guide
// proposals wait for a person, the guide can be switched off, and the agent object returns data.
// Fictional data only.
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
  await page.goto(env.base + '/demo/maternity/');
  await page.waitForSelector('#kpis .stat');
  return { context, page, errors };
}
const api = (page, fn) => page.evaluate((f) => window.ospeliMaternityDemo[f](), fn);
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

for (const width of [360, 390, 1280]) {
  test(`maternity renders every role at ${width}px with no sideways scroll`, async () => {
    const { context, page, errors } = await open(width);
    assert.equal(await page.locator('#kpis .stat').count(), 6);
    assert.ok(await page.locator('.sugg').count() >= 2, 'guide shows suggestions');
    for (const role of ['nic', 'flow', 'ops']) {
      await page.click('#r-' + role);
      assert.equal(await page.locator('#r-' + role).getAttribute('aria-pressed'), 'true');
      const o = await overflow(page);
      assert.ok(o <= 0, `${role} view scrolls sideways by ${o}px`);
    }
    if (width < 500) {
      await page.click('#r-nic');
      for (const u of ['lab', 'pn', 'neo', 'ch']) {
        await page.click('#u-' + u);
        const o = await overflow(page);
        assert.ok(o <= 0, `unit ${u} scrolls sideways by ${o}px`);
      }
      const h = await page.locator('#places .go').first().boundingBox();
      assert.ok(h.height >= 44, 'front-line buttons are at least 44px tall');
    }
    assert.deepEqual(errors, []);
    await context.close();
  });
}

test('the midwife or nurse in charge admits, discharges, cleans and requests a transfer, and the numbers update', async () => {
  const { context, page, errors } = await open(390);
  await page.click('#r-nic');
  const before = await api(page, 'kpis');
  // Labour ward: admit an expected arrival to the one ready room.
  await page.click('#u-lab');
  await page.click('#adm-E2');
  const k1 = await api(page, 'kpis');
  assert.equal(k1.expectedAdmissions, before.expectedAdmissions - 1);
  assert.equal(k1.byUnit.lab.occupied, before.byUnit.lab.occupied + 1);
  assert.equal(k1.byUnit.lab.ready, 0);
  // A room is cleaned and becomes ready.
  await page.click('#rd-L3');
  assert.equal((await api(page, 'kpis')).byUnit.lab.ready, 1);
  // Postnatal: a discharge before noon counts.
  await page.click('#u-pn');
  await page.click('#dis-PN1');
  const k2 = await api(page, 'kpis');
  assert.equal(k2.postnatalDischargesToday, before.postnatalDischargesToday + 1);
  assert.equal(k2.postnatalDischargesBeforeNoon, before.postnatalDischargesBeforeNoon + 1);
  assert.equal(k2.byUnit.pn.cleaning, before.byUnit.pn.cleaning + 1);
  // Neonatal: a cot discharge lowers cot occupancy.
  await page.click('#u-neo');
  await page.click('#dis-C1');
  assert.equal((await api(page, 'kpis')).cotsOccupied, before.cotsOccupied - 1);
  // Children's ward: a transfer out for capacity is requested.
  await page.click('#u-ch');
  await page.click('#tr-CH1');
  await page.selectOption('#tr-reason', 'cap');
  await page.click('#tr-ok');
  const k3 = await api(page, 'kpis');
  assert.equal(k3.transfersOutThisMonth, before.transfersOutThisMonth + 1);
  assert.equal(k3.transfersOutForCapacityThisMonth, before.transfersOutForCapacityThisMonth + 1);
  assert.match(await page.locator('#log li').first().textContent(), /Transfer out requested/);
  assert.deepEqual(errors, []);
  await context.close();
});

test('the flow coordinator moves transfers through stages and logs a closure with reason and role', async () => {
  const { context, page, errors } = await open(1280);
  await page.click('#r-flow');
  const before = await api(page, 'kpis');
  await page.click('#dep-T2');
  const k1 = await api(page, 'kpis');
  assert.equal(k1.transfersDepartedThisMonth, before.transfersDepartedThisMonth + 1);
  assert.equal(k1.byUnit.neo.cleaning, before.byUnit.neo.cleaning + 1, 'the cot goes to cleaning');
  await page.click('#acc-T3');
  assert.equal((await api(page, 'get')).transfers.find((t) => t.id === 'T3').stage, 'accepted');
  await page.locator('#logclose summary').click();
  await page.selectOption('#cf-unit', 'ch');
  await page.selectOption('#cf-reason', 'Staffing short');
  await page.selectOption('#cf-by', 'Site manager on call');
  await page.click('#cf-ok');
  const k2 = await api(page, 'kpis');
  assert.equal(k2.unitsClosedNow, before.unitsClosedNow + 1);
  const c = (await api(page, 'get')).closures.find((x) => x.unit === 'ch' && x.open);
  assert.equal(c.reason, 'Staffing short');
  assert.equal(c.decidedBy, 'Site manager on call');
  await page.click('#end-' + (await page.locator('#closures button[id^="end-"]').last().getAttribute('id')).slice(4));
  assert.equal((await api(page, 'kpis')).unitsClosedNow, before.unitsClosedNow);
  assert.deepEqual(errors, []);
  await context.close();
});

test('guide proposals wait for the named role, and the guide has an off switch', async () => {
  const { context, page, errors } = await open(1280);
  await page.click('#r-ops');
  // Closure past the review time: only a proposal until the operations manager confirms.
  const review = page.locator('.sugg[data-id^="review-"] button.primary');
  await review.click();
  assert.equal(await page.locator('#pending .prop').count(), 1);
  assert.ok((await api(page, 'get')).pendingDecisions.length === 1);
  await page.locator('#pending button', { hasText: 'Confirm' }).click();
  assert.equal(await page.locator('.sugg[data-id^="review-"]').count(), 0, 'review clock restarted');
  // Clean-first proposal belongs to the midwife or nurse in charge.
  await page.locator('.sugg[data-id^="clean-lab"] button.primary').click();
  await page.locator('#pending button', { hasText: 'Switch to that view' }).click();
  assert.equal(await page.locator('#r-nic').getAttribute('aria-pressed'), 'true');
  await page.locator('#pending button', { hasText: 'Confirm' }).click();
  const places = (await api(page, 'get')).places;
  assert.ok(places.find((p) => p.id === 'L3').cleanFirst && places.find((p) => p.id === 'L6').cleanFirst);
  // Off switch.
  await page.uncheck('#guide-on');
  assert.equal(await page.locator('.sugg').count(), 0);
  assert.equal(await page.locator('#kpis .stat').count(), 6);
  assert.deepEqual(await api(page, 'suggestions'), []);
  await page.check('#guide-on');
  assert.ok((await api(page, 'suggestions')).length >= 1);
  assert.deepEqual(errors, []);
  await context.close();
});

test('the agent object is read-only and returns data', async () => {
  const { context, page, errors } = await open(1280);
  assert.match(await api(page, 'describe'), /Read-only/);
  const g = await api(page, 'get');
  assert.equal(g.units.length, 4);
  assert.equal(g.places.length, 50);
  assert.ok(g.places.every((p) => !p.code || /^[MBP]-\d+$/.test(p.code)), 'codes only');
  const k = await api(page, 'kpis');
  assert.equal(typeof k.cotOccupancyPct, 'number');
  assert.equal(await page.evaluate(() => Object.isFrozen(window.ospeliMaternityDemo)), true);
  assert.deepEqual(errors, []);
  await context.close();
});
