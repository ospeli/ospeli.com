// Stores and stock demo (web/demo/stores-stock/): renders on phone and laptop, a ward report and a
// store issue change the measures, guide proposals need a person to confirm, the guide can be
// switched off, and the read-only agent object returns data. Fictional data only.
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
  await page.goto(env.base + '/demo/stores-stock/');
  await page.waitForSelector('#kpis .stat');
  return { context, page, errors };
}
const api = (page, fn) => page.evaluate((f) => window.ospeliStoresDemo[f](), fn);
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

for (const width of [360, 390, 1280]) {
  test(`stores demo renders every role at ${width}px with no sideways scroll`, async () => {
    const { context, page, errors } = await open(width);
    for (const role of ['ward', 'store', 'manager']) {
      await page.click(`.roles button[data-role=${role}]`);
      assert.equal(await page.locator(`.roles button[data-role=${role}]`).getAttribute('aria-pressed'), 'true');
      assert.equal(await page.locator('#kpis .stat').count(), 4);
      assert.ok(await page.locator('.sugg').count() >= 2, `guide shows suggestions for ${role}`);
      const o = await overflow(page);
      assert.ok(o <= 0, `${role} view scrolls sideways by ${o}px`);
    }
    assert.deepEqual(errors, []);
    await context.close();
  });
}

test('front-line tap targets are at least 44px on a phone', async () => {
  const { context, page, errors } = await open(360);
  const small = await page.evaluate(() => [...document.querySelectorAll('#items button, .roles button')]
    .filter((b) => b.offsetParent && b.getBoundingClientRect().height < 44).length);
  assert.equal(small, 0);
  assert.deepEqual(errors, []);
  await context.close();
});

test('ward staff report an item out: tracer stock-outs go up and a request reaches the store', async () => {
  const { context, page, errors } = await open(390);
  const before = await api(page, 'kpis');
  await page.locator('.item[data-item=SUC] button.outb').click();
  const after = await api(page, 'kpis');
  assert.equal(after.tracerStockOuts, before.tracerStockOuts + 1);
  assert.equal(await page.locator('#kpis [data-kpi=outs] b').textContent(), String(after.tracerStockOuts));
  const data = await api(page, 'get');
  assert.equal(data.wardStock.W4.SUC.onHand, 0);
  assert.ok(data.requests.some((r) => r.area === 'W4' && r.item === 'SUC' && r.status === 'open' && r.urgent));
  assert.ok(await page.locator('#log li').first().textContent().then((t) => /suction catheter reported out/i.test(t)));
  assert.deepEqual(errors, []);
  await context.close();
});

test('storekeeper issues a request and receives a delivery: measures update', async () => {
  const { context, page, errors } = await open(390);
  await page.click('.roles button[data-role=store]');
  const before = await api(page, 'kpis');
  await page.locator('#picklist button.issue').first().click();
  const mid = await api(page, 'kpis');
  assert.equal(mid.filledOnTime.lines, before.filledOnTime.lines + 1);
  assert.equal(mid.openRequests, before.openRequests - 1);
  await page.locator('[data-order=PO-1038] button.receive').click();
  const after = await api(page, 'kpis');
  assert.ok(after.tracerStockOuts < mid.tracerStockOuts, 'receiving oxygen masks ends the store stock-out');
  assert.ok((await api(page, 'get')).mainStore.OXM.onHand >= 300);
  assert.deepEqual(errors, []);
  await context.close();
});

test('a guide reorder is only a proposal until a person confirms it', async () => {
  const { context, page, errors } = await open(1280);
  await page.click('.roles button[data-role=manager]');
  const card = page.locator('.sugg[data-sugg^="ord-"]');
  assert.equal(await card.count(), 1);
  const ordersBefore = (await api(page, 'get')).orders.length;
  await card.locator('button.sg-act').click();
  assert.equal((await api(page, 'get')).orders.length, ordersBefore, 'nothing changes before confirming');
  await page.click('.confirm-yes');
  const orders = (await api(page, 'get')).orders;
  assert.equal(orders.length, ordersBefore + 1);
  assert.equal(orders[0].step, 'Waiting for purchasing approval');
  assert.deepEqual(errors, []);
  await context.close();
});

test('the guide has an off switch and the demo still works without it', async () => {
  const { context, page, errors } = await open(390);
  await page.uncheck('#guide-on');
  assert.equal(await page.locator('.sugg').count(), 0);
  assert.equal(await page.locator('#kpis .stat').count(), 4);
  await page.locator('.item[data-item=GLM] button.req').click();
  assert.ok((await api(page, 'get')).requests.some((r) => r.area === 'W4' && r.item === 'GLM' && r.status === 'open'));
  await page.check('#guide-on');
  assert.ok(await page.locator('.sugg').count() >= 1);
  assert.deepEqual(errors, []);
  await context.close();
});

test('KPI tiles show their definition on tap', async () => {
  const { context, page, errors } = await open(390);
  await page.click('#kpis [data-kpi=days]');
  assert.equal(await page.locator('#kdef').isVisible(), true);
  assert.match(await page.locator('#kdef').textContent(), /average daily use/);
  assert.deepEqual(errors, []);
  await context.close();
});

test('the read-only agent object returns data', async () => {
  const { context, page, errors } = await open(1280);
  assert.match(await api(page, 'describe'), /Read-only/);
  const data = await api(page, 'get');
  assert.ok(Object.keys(data.wardStock).length >= 3 && Object.keys(data.mainStore).length >= 10);
  const k = await api(page, 'kpis');
  assert.ok(typeof k.tracerStockOuts === 'number' && k.fewestDaysOfStock && k.orderCycleMedianDays > 0);
  const s = await api(page, 'suggestions');
  assert.ok(s.length >= 3 && s.every((x) => x.why));
  assert.equal(await page.evaluate(() => Object.isFrozen(window.ospeliStoresDemo)), true);
  assert.deepEqual(errors, []);
  await context.close();
});
