// Patient transport demo (web/demo/transport/): every role renders with no sideways scroll, a crew
// takes a job from Collected to Handed over and the measures update, a ward books a transfer that the
// desk sees, a shared-journey proposal waits for the desk to confirm, a fault report reaches the guide,
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
  await page.goto(env.base + '/demo/transport/');
  await page.waitForSelector('#kpis .stat');
  return { context, page, errors };
}
const api = (page, fn) => page.evaluate((f) => window.ospeliTransportDemo[f](), fn);
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

for (const width of [360, 390, 1280]) {
  test(`transport renders every role at ${width}px with no sideways scroll`, async () => {
    const { context, page, errors } = await open(width);
    assert.equal(await page.locator('#kpis .stat').count(), 4);
    assert.ok(await page.locator('.sugg').count() >= 3, 'guide shows suggestions');
    for (const role of ['ward', 'desk', 'crew', 'manager']) {
      await page.click('#r-' + role);
      assert.equal(await page.locator('#r-' + role).getAttribute('aria-pressed'), 'true');
      const o = await overflow(page);
      assert.ok(o <= 0, `${role} view scrolls sideways by ${o}px`);
    }
    if (width < 500) {
      await page.click('#r-crew');
      const h = await page.locator('#crew-jobs .go').first().boundingBox();
      assert.ok(h.height >= 44, 'crew buttons are at least 44px tall');
      await page.click('#r-ward');
      const b = await page.locator('#q-wheelchair').boundingBox();
      assert.ok(b.height >= 44, 'ward choices are at least 44px tall');
    }
    assert.deepEqual(errors, []);
    await context.close();
  });
}

test('a crew taps Collected, Arrived and Handed over and the measures update', async () => {
  const { context, page, errors } = await open(390);
  await page.click('#r-crew');
  await page.selectOption('#veh-pick', 'AMB-1');
  const before = await api(page, 'kpis');
  const btn = page.locator('#crew-jobs .go').first();
  const id = await btn.getAttribute('id');
  assert.equal(await btn.textContent(), 'Collected patient');
  await btn.click();
  assert.equal(await page.locator('#' + id).textContent(), 'Arrived at destination');
  assert.equal((await api(page, 'kpis')).collectedCount, before.collectedCount + 1);
  await page.click('#' + id);
  await page.click('#' + id);
  const after = await api(page, 'kpis');
  assert.equal(after.handedOverCount, before.handedOverCount + 1);
  assert.equal(after.open, before.open - 1);
  assert.match(await page.locator('#kpi-handover .n').textContent(), new RegExp('of ' + after.handedOverCount));
  const amb = (await api(page, 'get')).vehicles.find((v) => v.id === 'AMB-1');
  assert.equal(amb.status, 'free');
  assert.match(await page.locator('#log li').first().textContent(), /handed over/);
  assert.deepEqual(errors, []);
  await context.close();
});

test('a ward books a transfer and the desk assigns a vehicle', async () => {
  const { context, page, errors } = await open(360);
  await page.click('#r-ward');
  const n = (await api(page, 'get')).openTransfers.length;
  assert.ok(await page.locator('#q-send').isDisabled());
  await page.selectOption('#q-to', 'CH');
  await page.click('#q-wheelchair');
  await page.click('#q-esc-yes');
  await page.click('#q-urg-today');
  await page.click('#q-send');
  const got = await api(page, 'get');
  assert.equal(got.openTransfers.length, n + 1);
  const t = got.openTransfers.find((x) => x.to === 'Community care home' && x.from === 'Ward 3' && x.status === 'booked');
  assert.ok(t, 'the new booking is open');
  assert.match(t.patientCode, /^PT-/);
  assert.match(await page.locator('#ward-requests .rq').first().textContent(), /Waiting for a vehicle/);
  await page.click('#r-desk');
  await page.selectOption('#as-' + t.id, 'VAN-1');
  await page.click('#go-' + t.id);
  const after = (await api(page, 'get')).openTransfers.find((x) => x.id === t.id);
  assert.equal(after.status, 'assigned');
  assert.equal(after.vehicle, 'VAN-1');
  await page.click('#r-ward');
  assert.match(await page.locator('#ward-requests .rq').first().textContent(), /VAN-1/);
  assert.deepEqual(errors, []);
  await context.close();
});

test('a shared journey is only proposed until the desk confirms it', async () => {
  const { context, page, errors } = await open(1280);
  await page.click('#r-manager');
  const s = (await api(page, 'suggestions')).find((x) => x.id.startsWith('combine-'));
  assert.ok(s, 'guide suggests sharing a vehicle');
  const ids = s.id.split('-').slice(1);
  await page.locator(`.sugg[data-id="${s.id}"] button.primary`).click();
  let open1 = (await api(page, 'get')).openTransfers.filter((x) => ids.includes(x.id));
  assert.ok(open1.every((x) => x.status === 'booked'), 'nothing changes on propose');
  assert.equal((await api(page, 'get')).pendingDecisions.length, 1);
  assert.equal(await page.locator('#pending button', { hasText: 'Confirm' }).count(), 0, 'manager cannot confirm a desk decision');
  await page.click('#r-desk');
  await page.locator('#pending button', { hasText: 'Confirm' }).click();
  open1 = (await api(page, 'get')).openTransfers.filter((x) => ids.includes(x.id));
  assert.equal(open1.length, 2);
  assert.ok(open1.every((x) => x.status === 'assigned' && x.vehicle === open1[0].vehicle), 'both on one vehicle');
  assert.deepEqual(errors, []);
  await context.close();
});

test('a fault report reaches the guide, and taking the vehicle off the road lowers availability', async () => {
  const { context, page, errors } = await open(390);
  await page.click('#r-crew');
  await page.selectOption('#veh-pick', 'VAN-1');
  await page.locator('#d-fault summary').click();
  await page.selectOption('#fault-pick', 'Lights or indicators');
  await page.click('#fault-send');
  const s = (await api(page, 'suggestions')).find((x) => x.id.startsWith('fault-VAN-1'));
  assert.ok(s, 'guide flags the fault');
  assert.equal((await api(page, 'get')).vehicles.find((v) => v.id === 'VAN-1').status, 'free', 'still on the road until someone decides');
  const before = await api(page, 'kpis');
  await page.locator(`.sugg[data-id="${s.id}"] button.primary`).click();
  await page.click('#r-manager');
  await page.locator('#pending button', { hasText: 'Confirm' }).click();
  const van = (await api(page, 'get')).vehicles.find((v) => v.id === 'VAN-1');
  assert.equal(van.status, 'off');
  assert.match(van.workOrder, /^WO-/);
  assert.equal((await api(page, 'kpis')).vehiclesOffRoad, before.vehiclesOffRoad + 1);
  await page.click('#back-VAN-1');
  assert.equal((await api(page, 'get')).vehicles.find((v) => v.id === 'VAN-1').status, 'free');
  assert.deepEqual(errors, []);
  await context.close();
});

test('the guide has an off switch and the board still works without it', async () => {
  const { context, page, errors } = await open(390);
  await page.uncheck('#guide-on');
  assert.equal(await page.locator('.sugg').count(), 0);
  assert.deepEqual(await api(page, 'suggestions'), []);
  assert.equal(await page.locator('#kpis .stat').count(), 4);
  await page.click('#r-desk');
  assert.ok(await page.locator('#desk .drow').count() >= 5);
  await page.click('#kpi-ontime');
  assert.equal(await page.locator('#kpi-ontime').getAttribute('aria-expanded'), 'true');
  assert.deepEqual(errors, []);
  await context.close();
});

test('the agent object is read-only and returns data', async () => {
  const { context, page, errors } = await open(1280);
  const d = await page.evaluate(() => window.ospeliTransportDemo.describe());
  assert.match(d, /Read-only/);
  const g = await api(page, 'get');
  assert.equal(g.vehicles.length, 6);
  assert.ok(g.openTransfers.length >= 8);
  const k = await api(page, 'kpis');
  assert.ok(k.collectedCount > 0 && k.fleetAvailabilityPct > 0 && k.fleetAvailabilityPct < 100);
  assert.ok(await page.evaluate(() => Object.isFrozen(window.ospeliTransportDemo)));
  assert.deepEqual(errors, []);
  await context.close();
});
