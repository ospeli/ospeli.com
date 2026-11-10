// Staffing and rostering demo (web/demo/staffing/): each role renders with no sideways scroll, a staff
// member can pick up an open shift and the measures update, a swap request waits for the manager, guide
// proposals change nothing until the unit manager approves, and the guide can be switched off. Fictional data only.
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
  await page.goto(env.base + '/demo/staffing/');
  await page.waitForSelector('#kpis .stat');
  return { context, page, errors };
}
const api = (page, fn) => page.evaluate((f) => window.ospeliStaffingDemo[f](), fn);
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

for (const width of [360, 390, 1280]) {
  test(`staffing renders every role at ${width}px with no sideways scroll`, async () => {
    const { context, page, errors } = await open(width);
    assert.equal(await page.locator('#kpis .stat').count(), 4);
    assert.ok(await page.locator('.sugg').count() >= 2, 'guide shows suggestions');
    for (const role of ['staff', 'manager', 'office']) {
      await page.click('#r-' + role);
      assert.equal(await page.locator('#r-' + role).getAttribute('aria-pressed'), 'true');
      const o = await overflow(page);
      assert.ok(o <= 0, `${role} view scrolls sideways by ${o}px`);
    }
    if (width < 500) {
      await page.click('#r-staff');
      const b = await page.locator('#open-mine .go').first().boundingBox();
      assert.ok(b.height >= 44, 'front-line buttons are at least 44px tall');
      const fs = await page.locator('#my-shifts .meta').first().evaluate((n) => parseFloat(getComputedStyle(n).fontSize));
      assert.ok(fs >= 15, 'front-line text is at least 15px');
    }
    assert.deepEqual(errors, []);
    await context.close();
  });
}

test('a staff member picks up an open shift and the measures update', async () => {
  const { context, page, errors } = await open(390);
  await page.click('#r-staff');
  const before = await api(page, 'kpis');
  const shifts = await page.locator('#my-shifts .item').count();
  await page.locator('#open-mine .go').first().click();
  const after = await api(page, 'kpis');
  assert.equal(after.openShifts, before.openShifts - 1);
  assert.equal(after.filledShifts, before.filledShifts + 1);
  assert.ok(after.fillRatePct > before.fillRatePct, 'fill rate goes up');
  assert.equal(after.gapsFilled, before.gapsFilled + 1, 'time to fill counts the new fill');
  assert.equal(await page.locator('#my-shifts .item').count(), shifts + 1, 'the shift is on my list');
  assert.match(await page.locator('#log li').first().textContent(), /picked up/);
  assert.deepEqual(errors, []);
  await context.close();
});

test('a swap request waits for the unit manager, who approves it', async () => {
  const { context, page, errors } = await open(390);
  await page.click('#r-staff');
  await page.locator('#my-shifts .go.swap').first().click();
  await page.locator('.picker .choice').first().click();
  await page.click('#sw-send');
  assert.match(await page.locator('#my-shifts').textContent(), /Waiting for your unit manager/);
  await page.click('#r-manager');
  const n = await page.locator('#swaps .row').count();
  assert.ok(n >= 2, 'manager sees the new swap and the seeded one');
  await page.locator('#swaps button', { hasText: 'Approve' }).last().click();
  assert.equal(await page.locator('#swaps .row').count(), n - 1);
  assert.deepEqual(errors, []);
  await context.close();
});

test('a guide move is only a proposal until the unit manager approves it', async () => {
  const { context, page, errors } = await open(1280);
  await page.click('#r-office');
  const before = await api(page, 'kpis');
  assert.ok(before.shortToday >= 1, 'the example starts with a gap tonight');
  await page.locator('.sugg[data-id^="move-"] button.primary').click();
  assert.equal((await api(page, 'kpis')).shortToday, before.shortToday, 'nothing changes on proposing');
  assert.equal((await api(page, 'get')).pendingDecisions.length, 1);
  await page.click('#r-manager');
  await page.locator('#pending button.primary').first().click();
  const after = await api(page, 'kpis');
  assert.equal(after.shortToday, before.shortToday - 1, 'the gap is covered');
  assert.ok(after.coverTodayPct > before.coverTodayPct);
  assert.equal((await api(page, 'get')).pendingDecisions.length, 0);
  assert.deepEqual(errors, []);
  await context.close();
});

test('the guide has an off switch and the views still work without it', async () => {
  const { context, page, errors } = await open(390);
  await page.uncheck('#guide-on');
  assert.equal(await page.locator('.sugg').count(), 0);
  assert.deepEqual(await api(page, 'suggestions'), []);
  await page.click('#r-office');
  await page.fill('#wl-W1D', '40');
  await page.locator('#wl-W1D').dispatchEvent('change');
  const w1 = (await api(page, 'get')).units.find((u) => u.id === 'W1');
  assert.equal(w1.workloadCount.day, 40);
  assert.ok(w1.today.day[0].needed > w1.today.day[0].rostered, 'more workload means more staff needed');
  assert.equal(await page.locator('#kpis .stat').count(), 4);
  assert.deepEqual(errors, []);
  await context.close();
});

test('the agent object is read-only and returns data', async () => {
  const { context, page, errors } = await open(1280);
  const d = await api(page, 'describe');
  assert.match(d, /Read-only/);
  const g = await api(page, 'get');
  assert.equal(g.units.length, 5);
  assert.ok(g.openShifts.length >= 5);
  const k = await api(page, 'kpis');
  assert.equal(k.byUnit.length, 5);
  assert.ok(k.fillRatePct > 0 && k.fillRatePct <= 100);
  const s = await api(page, 'suggestions');
  assert.ok(s.length >= 2 && s.every((x) => x.why));
  assert.ok(await page.evaluate(() => Object.isFrozen(window.ospeliStaffingDemo)));
  assert.deepEqual(errors, []);
  await context.close();
});
