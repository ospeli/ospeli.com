// Pharmacy operations demo (web/demo/pharmacy/): each role renders with no sideways scroll, a ward
// can ask for a top-up from a phone and the queue measures update, the dispensary can take a discharge
// request to ready and the turnaround updates, guide proposals wait for a person, and the guide can be
// switched off. Fictional data only.
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
  await page.goto(env.base + '/demo/pharmacy/');
  await page.waitForSelector('#kpis .stat');
  return { context, page, errors };
}
const api = (page, fn) => page.evaluate((f) => window.ospeliPharmacyDemo[f](), fn);
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

for (const width of [360, 390, 1280]) {
  test(`pharmacy renders every role at ${width}px with no sideways scroll`, async () => {
    const { context, page, errors } = await open(width);
    assert.equal(await page.locator('#kpis .stat').count(), 4);
    assert.ok(await page.locator('.sugg').count() >= 2, 'guide shows suggestions');
    for (const role of ['ward', 'dispensary', 'manager']) {
      await page.click('#r-' + role);
      assert.equal(await page.locator('#r-' + role).getAttribute('aria-pressed'), 'true');
      const o = await overflow(page);
      assert.ok(o <= 0, `${role} view scrolls sideways by ${o}px`);
    }
    if (width < 500) {
      await page.click('#r-ward');
      const h = await page.locator('#q-topup').boundingBox();
      assert.ok(h.height >= 44, 'front-line buttons are at least 44px tall');
      await page.click('#r-dispensary');
      const g = await page.locator('#queue .go').first().boundingBox();
      assert.ok(g.height >= 44, 'dispensary stage buttons are at least 44px tall');
    }
    assert.deepEqual(errors, []);
    await context.close();
  });
}

test('a ward asks for a top-up from a phone and the pharmacy queue grows', async () => {
  const { context, page, errors } = await open(360);
  await page.click('#r-ward');
  const before = await api(page, 'kpis');
  await page.click('#q-topup');
  await page.click('#w-0');
  await page.click('#q-plus');
  await page.click('#q-send');
  const after = await api(page, 'kpis');
  assert.equal(after.inQueue, before.inQueue + 1);
  assert.equal(await page.locator('#kpi-queue b').textContent(), String(after.inQueue));
  assert.match(await page.locator('#ward-requests').textContent(), /Top-up · Line 102/);
  assert.match(await page.locator('#log li').first().textContent(), /Request received from Ward 5: top-up/);
  const got = await api(page, 'get');
  assert.ok(got.queue.some((q) => q.kind === 'topup' && q.who === 'Ward 5 · top-up, 1 line' && q.stage === 'Requested'));
  assert.deepEqual(errors, []);
  await context.close();
});

test('the dispensary takes a discharge request to ready and the turnaround updates; the ward sees it', async () => {
  const { context, page, errors } = await open(390);
  await page.click('#r-dispensary');
  await page.click('#f-discharge');
  const before = await api(page, 'kpis');
  const btn = page.locator('#queue .go').first();
  const id = await btn.getAttribute('id');
  const label = await btn.textContent();
  const steps = { 'Start preparing': 3, 'Mark checked': 2, 'Ready: put on shelf': 1 }[label];
  assert.ok(steps, 'first card has a stage button');
  for (let i = 0; i < steps; i++) await page.click('#' + id);
  const after = await api(page, 'kpis');
  assert.equal(after.dischargesReady, before.dischargesReady + 1);
  assert.equal(after.inQueue, before.inQueue - 1);
  assert.equal(after.onShelf, before.onShelf + 1);
  assert.match(await page.locator('#log li').first().textContent(), /can see patient .* ready to collect/);
  // Hand it over from the shelf
  await page.click('#shelf #' + id);
  assert.equal((await api(page, 'kpis')).onShelf, before.onShelf);
  assert.deepEqual(errors, []);
  await context.close();
});

test('making a top-up ready takes it from pharmacy stock and counts in the fill rate', async () => {
  const { context, page, errors } = await open(1280);
  await page.click('#r-dispensary');
  await page.click('#f-inpatient');
  const before = await api(page, 'kpis');
  // Ward 5's top-up (Line 107 × 5, Line 106 × 2) is being prepared.
  const card = page.locator('#queue .job', { hasText: 'Ward 5 · top-up' });
  const btn = card.locator('.go');
  await btn.click(); // Mark checked
  await btn.click(); // Ready
  const after = await api(page, 'kpis');
  assert.equal(after.topUpLines, before.topUpLines + 2);
  assert.equal(after.topUpLinesFull, before.topUpLinesFull + 2);
  const stock = (await api(page, 'get')).stock.find((s) => s.line === 107);
  assert.equal(stock.qty, 5);
  assert.deepEqual(errors, []);
  await context.close();
});

test('guide proposals wait for the right person; confirming reorders the queue', async () => {
  const { context, page, errors } = await open(1280);
  await page.click('#r-manager');
  const s = await api(page, 'suggestions');
  assert.ok(s.some((x) => x.id.startsWith('order-')), 'discharge order suggestion');
  assert.ok(s.some((x) => x.id.startsWith('reorder-107')), 'reorder suggestion');
  assert.ok(s.some((x) => x.id.startsWith('move-')), 'expiry move suggestion');
  assert.ok(s.every((x) => x.why), 'every suggestion says why');
  const firstBefore = (await api(page, 'get')).queue.filter((q) => q.type === 'discharge' && q.stage === 'Requested')[0];
  await page.locator('.sugg[data-id^="order-"] button.primary').click();
  assert.equal((await api(page, 'get')).pendingDecisions.length, 1);
  assert.equal(await page.locator('#pending button', { hasText: 'Confirm' }).count(), 0, 'the manager cannot confirm a dispensary decision');
  await page.locator('#pending button', { hasText: 'Open the Dispensary view' }).click();
  await page.locator('#pending button', { hasText: 'Confirm' }).click();
  const firstAfter = (await api(page, 'get')).queue.filter((q) => q.type === 'discharge' && q.stage === 'Requested')[0];
  assert.notEqual(firstAfter.id, firstBefore.id);
  assert.match(firstAfter.who, /Ward 5/);
  // Reorder: proposed, confirmed by the manager, then shows as on order
  await page.locator('.sugg[data-id^="reorder-107"] button.primary').click();
  await page.locator('#pending button', { hasText: 'Open the Manager view' }).click();
  await page.locator('#pending button', { hasText: 'Confirm' }).click();
  const st = (await api(page, 'get')).stock.find((x) => x.line === 107);
  assert.ok(st.onOrder > 0);
  assert.deepEqual(errors, []);
  await context.close();
});

test('the guide has an off switch and the views still work without it', async () => {
  const { context, page, errors } = await open(390);
  await page.uncheck('#guide-on');
  assert.equal(await page.locator('.sugg').count(), 0);
  assert.deepEqual(await api(page, 'suggestions'), []);
  assert.equal(await page.locator('#kpis .stat').count(), 4);
  await page.click('#r-dispensary');
  assert.ok(await page.locator('#queue .job').count() > 0);
  await page.check('#guide-on');
  assert.ok(await page.locator('.sugg').count() >= 2);
  assert.deepEqual(errors, []);
  await context.close();
});

test('the agent object is read-only and returns data', async () => {
  const { context, page, errors } = await open(1280);
  const d = await page.evaluate(() => window.ospeliPharmacyDemo.describe());
  assert.match(d, /Read-only/);
  const g = await api(page, 'get');
  assert.ok(g.queue.length > 0 && g.stock.length > 0 && g.nearExpiry.length > 0);
  const k = await api(page, 'kpis');
  assert.equal(typeof k.dischargeTurnaroundMin, 'number');
  assert.equal(await page.evaluate(() => Object.isFrozen(window.ospeliPharmacyDemo)), true);
  assert.deepEqual(errors, []);
  await context.close();
});
