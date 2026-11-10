// Critical care capacity demo (web/demo/critical-care/): each role renders with no sideways scroll,
// the nurse in charge can record a step-down and a referral outcome and the numbers update, guide
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
  await page.goto(env.base + '/demo/critical-care/');
  await page.waitForSelector('#kpis .stat');
  return { context, page, errors };
}
const api = (page, fn) => page.evaluate((f) => window.ospeliCriticalCareDemo[f](), fn);
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

for (const width of [360, 390, 1280]) {
  test(`critical care renders every role at ${width}px with no sideways scroll`, async () => {
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
      const h = await page.locator('#beds .go').first().boundingBox();
      assert.ok(h.height >= 44, 'front-line buttons are at least 44px tall');
    }
    assert.deepEqual(errors, []);
    await context.close();
  });
}

test('the nurse in charge records a step-down, a referral and a staffing change, and the numbers update', async () => {
  const { context, page, errors } = await open(390);
  await page.click('#r-nic');
  const before = await api(page, 'kpis');
  // Bed 1 is occupied: the team decides the patient is ready to step down.
  await page.click('#ready-1');
  await page.selectOption('#ready-ward', 'Ward 6');
  await page.click('#ready-ok');
  const k1 = await api(page, 'kpis');
  assert.equal(k1.readyToStepDown, before.readyToStepDown + 1);
  assert.ok((await api(page, 'get')).stepDowns.some((s) => s.bed === 1 && s.wardRequested === 'Ward 6'));
  // A referral is refused for capacity: counted this month.
  await page.locator('#refs button[id^="rr-"]').first().click();
  const k2 = await api(page, 'kpis');
  assert.equal(k2.refusedForCapacityThisMonth, before.refusedForCapacityThisMonth + 1);
  assert.equal(k2.referralsWaiting, before.referralsWaiting - 1);
  // The other referral is admitted to the empty staffed bed.
  await page.locator('#refs button[id^="ra-"]').first().click();
  await page.click('#admit-ok');
  const k3 = await api(page, 'kpis');
  assert.equal(k3.occupied, before.occupied + 1);
  assert.equal(k3.emptyStaffed, before.emptyStaffed - 1);
  // A step-down with a ward bed offered leaves the unit.
  await page.click('#left-4');
  const k4 = await api(page, 'kpis');
  assert.equal(k4.stepDownsLeft24h, before.stepDownsLeft24h + 1);
  assert.match(await page.locator('#log li').first().textContent(), /left the unit/);
  assert.deepEqual(errors, []);
  await context.close();
});

test('guide proposals wait for the named role, and the guide has an off switch', async () => {
  const { context, page, errors } = await open(1280);
  await page.click('#r-ops');
  const raise = page.locator('.sugg[data-id^="raise-"] button.primary');
  await raise.click();
  assert.equal((await api(page, 'get')).pendingDecisions.length, 1);
  assert.equal((await api(page, 'get')).stepDowns.filter((s) => s.raisedAtBedMeeting).length, 0, 'nothing changes before a person confirms');
  await page.click('#r-flow');
  await page.locator('#pending button.primary').click();
  assert.equal((await api(page, 'get')).stepDowns.filter((s) => s.raisedAtBedMeeting).length, 1);
  await page.uncheck('#guide-on');
  assert.equal(await page.locator('.sugg').count(), 0);
  assert.deepEqual(await api(page, 'suggestions'), []);
  assert.equal(await page.locator('#kpis .stat').count(), 6);
  assert.deepEqual(errors, []);
  await context.close();
});

test('staffed beds below the set level are flagged, and the agent object returns data', async () => {
  const { context, page, errors } = await open(1280);
  assert.match(await api(page, 'describe'), /Read-only/);
  const g = await api(page, 'get');
  assert.equal(g.beds.length, 16);
  assert.ok(g.stepDowns.length >= 3);
  const k = await api(page, 'kpis');
  assert.ok(k.staffedBeds < k.staffedLevelSetting);
  assert.ok((await api(page, 'suggestions')).some((s) => /below the set level/.test(s.title)));
  await page.click('#t-sick');
  assert.equal((await api(page, 'kpis')).staffedBeds, k.staffedBeds - 1);
  assert.deepEqual(errors, []);
  await context.close();
});
