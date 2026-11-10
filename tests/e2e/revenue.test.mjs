// Revenue cycle demo (web/demo/revenue/): each role renders with no sideways scroll, the front desk
// records coverage and authorisation and the measures update, the billing officer fixes, submits and
// resubmits, guide proposals wait for a person, the guide and the whole module can be switched off,
// and the read-only agent object returns data. Fictional data only.
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
  await page.goto(env.base + '/demo/revenue/');
  await page.waitForSelector('#kpis .stat');
  return { context, page, errors };
}
const api = (page, fn) => page.evaluate((f) => window.ospeliRevenueDemo[f](), fn);
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

for (const width of [360, 390, 1280]) {
  test(`revenue demo renders every role at ${width}px with no sideways scroll`, async () => {
    const { context, page, errors } = await open(width);
    assert.ok(await page.locator('.sugg').count() >= 2, 'guide shows suggestions');
    for (const role of ['registration', 'billing', 'finance']) {
      await page.click('#r-' + role);
      assert.equal(await page.locator('#r-' + role).getAttribute('aria-pressed'), 'true');
      assert.equal(await page.locator('#kpis .stat').count(), 4);
      const o = await overflow(page);
      assert.ok(o <= 0, `${role} view scrolls sideways by ${o}px`);
    }
    if (width < 500) {
      await page.click('#r-registration');
      const h = await page.locator('#arrivals .go').first().boundingBox();
      assert.ok(h.height >= 44, 'front-line buttons are at least 44px tall');
      const fs = await page.locator('#arrivals .chk b').first().evaluate((n) => parseFloat(getComputedStyle(n).fontSize));
      assert.ok(fs >= 15, 'front-line text is at least 15px');
    }
    assert.deepEqual(errors, []);
    await context.close();
  });
}

test('the front desk records coverage and an authorisation, and the measures update', async () => {
  const { context, page, errors } = await open(390);
  await page.click('#r-registration');
  const before = await api(page, 'kpis');
  await page.click('#cov-8124');
  await page.click('#pay-8124-B');
  const mid = await api(page, 'kpis');
  assert.equal(mid.coverageRecorded, before.coverageRecorded + 1);
  assert.match(await page.locator('#kpi-cov b').textContent(), new RegExp('^' + mid.coverageRecorded + ' of'));
  assert.match(await page.locator('#log li').first().textContent(), /Coverage recorded for P-8124/);
  await page.click('#recv-4983');
  assert.equal((await api(page, 'kpis')).authorisationsStillNeeded, before.authorisationsStillNeeded - 1);
  assert.deepEqual(errors, []);
  await context.close();
});

test('the billing officer fixes a missing item, submits, and resubmits a denial', async () => {
  const { context, page, errors } = await open(1280);
  await page.click('#r-billing');
  const k0 = await api(page, 'kpis');
  const fixBtn = page.locator('#missing button[id^="fix-"]').first();
  const id = (await fixBtn.getAttribute('id')).split('-').slice(1, 3).join('-');
  // fix every missing item on that encounter
  while (await page.locator(`#row-${id} button[id^="fix-"]`).count()) await page.locator(`#row-${id} button[id^="fix-"]`).first().click();
  const k1 = await api(page, 'kpis');
  assert.equal(k1.missingCount, k0.missingCount - 1);
  assert.equal(k1.readyCount, k0.readyCount + 1);
  await page.click('#sub-' + id);
  const k2 = await api(page, 'kpis');
  assert.equal(k2.readyCount, k0.readyCount);
  assert.equal(k2.claimsSubmitted, k0.claimsSubmitted + 1);
  assert.ok(k2.cleanClaimRatePct < k0.cleanClaimRatePct, 'a hand-fixed claim is not clean');
  await page.locator('#denials button[id^="rs-"]').first().click();
  assert.equal((await api(page, 'kpis')).openDenials, k0.openDenials - 1);
  await page.click('#t-resp');
  assert.match(await page.locator('#log li').first().textContent(), /Payer responses received/);
  assert.deepEqual(errors, []);
  await context.close();
});

test('guide proposals wait for a person to confirm', async () => {
  const { context, page, errors } = await open(1280);
  const up0 = (await api(page, 'get')).plannedNext3Days.filter((u) => u.authorisation === 'none').length;
  assert.ok(up0 > 0);
  await page.locator('#g-auth button.primary').click();
  assert.equal((await api(page, 'get')).plannedNext3Days.filter((u) => u.authorisation === 'none').length, up0, 'nothing changes on propose');
  assert.equal((await api(page, 'get')).pendingDecisions.length, 1);
  await page.locator('.prop button.primary').click();
  assert.equal((await api(page, 'get')).plannedNext3Days.filter((u) => u.authorisation === 'none').length, 0);
  assert.deepEqual(errors, []);
  await context.close();
});

test('the guide and the module have off switches, and the agent object returns data', async () => {
  const { context, page, errors } = await open(390);
  await page.uncheck('#guide-on');
  assert.equal(await page.locator('.sugg').count(), 0);
  assert.equal(await page.locator('#kpis .stat').count(), 4);
  assert.deepEqual(await api(page, 'suggestions'), []);
  await page.check('#guide-on');
  assert.ok((await api(page, 'suggestions')).length >= 2);
  assert.match(await api(page, 'describe'), /optional module/i);
  const g = await api(page, 'get');
  assert.ok(g.arrivalsToday.length > 0 && g.encounters.length > 0);
  assert.ok(typeof (await api(page, 'kpis')).netDaysInAR === 'number');
  await page.uncheck('#mod-on');
  assert.ok(await page.locator('#offcard').isVisible());
  assert.ok(!(await page.locator('#layout').isVisible()));
  await page.check('#mod-on');
  assert.ok(await page.locator('#layout').isVisible());
  assert.deepEqual(errors, []);
  await context.close();
});
