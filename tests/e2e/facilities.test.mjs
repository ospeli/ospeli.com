// Facilities and utilities demo (web/demo/facilities/): each role renders with no sideways scroll,
// anyone can report a fault in three taps, a technician takes a job from Accept to Done and the
// measures update, logging a generator test clears the overdue flag, guide proposals wait for the
// facilities manager, and the guide can be switched off. Fictional data only.
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
  await page.goto(env.base + '/demo/facilities/');
  await page.waitForSelector('#kpis .stat');
  return { context, page, errors };
}
const api = (page, fn) => page.evaluate((f) => window.ospeliFacilitiesDemo[f](), fn);
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

for (const width of [360, 390, 1280]) {
  test(`facilities renders every role at ${width}px with no sideways scroll`, async () => {
    const { context, page, errors } = await open(width);
    assert.equal(await page.locator('#kpis .stat').count(), 4);
    assert.ok(await page.locator('.sugg').count() >= 3, 'guide shows suggestions');
    for (const role of ['anyone', 'tech', 'manager']) {
      await page.click('#r-' + role);
      assert.equal(await page.locator('#r-' + role).getAttribute('aria-pressed'), 'true');
      const o = await overflow(page);
      assert.ok(o <= 0, `${role} view scrolls sideways by ${o}px`);
    }
    if (width < 500) {
      await page.click('#r-tech');
      const h = await page.locator('#incoming .go').first().boundingBox();
      assert.ok(h.height >= 44, 'technician buttons are at least 44px tall');
      await page.click('#r-anyone');
      const f = await page.locator('#ft-leak').boundingBox();
      assert.ok(f.height >= 44, 'fault buttons are at least 44px tall');
    }
    assert.deepEqual(errors, []);
    await context.close();
  });
}

test('anyone reports a fault in three taps, by list or by simulated scan', async () => {
  const { context, page, errors } = await open(360);
  await page.click('#r-anyone');
  const before = await api(page, 'kpis');
  await page.click('#how-list');
  await page.click('#fl-1');
  await page.click('#rm-M-1-01');
  await page.click('#ft-lights');
  await page.click('#rep-send');
  let after = await api(page, 'kpis');
  assert.equal(after.open, before.open + 1);
  assert.equal(await page.locator('#kpi-open b').textContent(), String(after.open));
  const wo = (await api(page, 'get')).openWorkOrders.find((w) => w.roomLabel === 'M-1-01' && w.fault === 'lights' && w.ageHours < 0.1);
  assert.ok(wo, 'the new work order is open');
  assert.equal(wo.trade, 'Electrical');
  assert.match(await page.locator('#my-reports .rq').first().textContent(), /Lights, Ward 1 bay A/);
  // Simulated QR scan, marked unsafe and room out of use
  await page.click('#how-scan');
  await page.click('#loc-scan');
  assert.match(await page.locator('#located').textContent(), /M-1-04/);
  await page.click('#ft-leak');
  await page.check('#rep-unsafe');
  await page.check('#rep-closed');
  await page.click('#rep-send');
  after = await api(page, 'kpis');
  assert.equal(after.open, before.open + 2);
  assert.equal(after.roomsOutOfUse, before.roomsOutOfUse + 1);
  const leak = (await api(page, 'get')).openWorkOrders.find((w) => w.roomLabel === 'M-1-04' && w.priority === 'urgent');
  assert.ok(leak && leak.roomOutOfUse);
  assert.deepEqual(errors, []);
  await context.close();
});

test('a technician takes a job from Accept to Done and the measures update', async () => {
  const { context, page, errors } = await open(390);
  await page.click('#r-tech');
  await page.selectOption('#trade-pick', 'elec');
  const before = await api(page, 'kpis');
  const btn = page.locator('#incoming .go').first();
  const id = await btn.getAttribute('id');
  await btn.click();
  assert.equal(await page.locator('#' + id).textContent(), 'On site');
  await page.click('#' + id);
  assert.equal(await page.locator('#' + id).textContent(), 'Done, fixed');
  await page.fill('#n-' + id.slice(2), 'Replaced the socket and tested.');
  await page.locator('#n-' + id.slice(2)).blur();
  await page.click('#' + id);
  const after = await api(page, 'kpis');
  assert.equal(after.open, before.open - 1);
  assert.equal(after.closed14d, before.closed14d + 1);
  assert.equal(await page.locator('#kpi-open b').textContent(), String(after.open));
  assert.match(await page.locator('#log').textContent(), /closed .*Note: Replaced the socket/);
  assert.deepEqual(errors, []);
  await context.close();
});

test('waiting for parts and back on site', async () => {
  const { context, page, errors } = await open(390);
  await page.click('#r-tech');
  await page.selectOption('#trade-pick', 'hvac');
  const before = await api(page, 'kpis');
  const onsite = page.locator('#inhand button[id^="p-"]').first();
  const pid = await onsite.getAttribute('id');
  await onsite.click();
  assert.equal((await api(page, 'kpis')).waitingParts, before.waitingParts + 1);
  await page.click('#a-' + pid.slice(2));
  assert.equal((await api(page, 'kpis')).waitingParts, before.waitingParts);
  assert.deepEqual(errors, []);
  await context.close();
});

test('logging the overdue generator test updates compliance and clears the flag', async () => {
  const { context, page, errors } = await open(1280);
  await page.click('#r-manager');
  const before = await api(page, 'kpis');
  assert.ok(before.genCompliancePct < 100);
  assert.ok((await api(page, 'suggestions')).some((s) => /Generator 1 test is overdue/.test(s.title)));
  await page.click('#uc-log-gen1');
  const after = await api(page, 'kpis');
  assert.equal(after.genDone, before.genDone + 1);
  assert.equal(after.genCompliancePct, 100);
  assert.ok(!(await api(page, 'suggestions')).some((s) => /Generator 1/.test(s.title)));
  // Planned maintenance done today raises compliance
  await page.click('#pm-done-pm4');
  assert.equal((await api(page, 'kpis')).pmOnTime, before.pmOnTime + 1);
  // Plant board records status; never switches plant
  await page.click('#pl-ch1');
  assert.equal((await api(page, 'kpis')).plantDown, before.plantDown + 1);
  assert.deepEqual(errors, []);
  await context.close();
});

test('a guide proposal changes nothing until the facilities manager confirms', async () => {
  const { context, page, errors } = await open(1280);
  await page.click('#r-manager');
  const n0 = (await api(page, 'get')).openWorkOrders.length;
  await page.getByRole('button', { name: 'Propose: one job' }).click();
  assert.equal((await api(page, 'get')).openWorkOrders.length, n0, 'proposing changes nothing');
  assert.equal((await api(page, 'get')).pendingDecisions.length, 1);
  await page.locator('#pending').getByRole('button', { name: 'Confirm' }).click();
  const g = await api(page, 'get');
  assert.equal(g.openWorkOrders.length, n0 - 1);
  assert.ok(g.openWorkOrders.some((w) => w.covers.length === 1), 'one job covers both reports');
  // Generator booking is a proposal only: the test stays overdue until it is logged
  await page.getByRole('button', { name: /Propose: book it/ }).click();
  await page.locator('#pending').getByRole('button', { name: 'Confirm' }).click();
  assert.ok((await api(page, 'kpis')).genCompliancePct < 100);
  assert.deepEqual(errors, []);
  await context.close();
});

test('the guide has an off switch and the job queue still works without it', async () => {
  const { context, page, errors } = await open(390);
  await page.uncheck('#guide-on');
  assert.equal(await page.locator('.sugg').count(), 0);
  assert.deepEqual(await api(page, 'suggestions'), []);
  await page.click('#r-tech');
  const before = await api(page, 'kpis');
  await page.locator('#incoming .go').first().click();
  assert.equal((await api(page, 'kpis')).open, before.open);
  assert.ok(await page.locator('.job.mine').count() >= 1, 'accepted job moves to In hand');
  assert.equal(await page.locator('#kpis .stat').count(), 4);
  assert.deepEqual(errors, []);
  await context.close();
});

test('agent object is read-only and returns data', async () => {
  const { context, page, errors } = await open(1280);
  assert.match(await api(page, 'describe'), /Read-only/);
  const g = await api(page, 'get');
  assert.ok(g.openWorkOrders.length >= 10);
  assert.equal(g.plant.length, 8);
  assert.ok(g.plannedMaintenance.length >= 6);
  const k = await api(page, 'kpis');
  assert.ok(k.completionMedianH > 0 && k.pmCompliancePct >= 0 && k.genCompliancePct > 0);
  assert.ok((await api(page, 'suggestions')).length >= 3);
  assert.ok(await page.evaluate(() => Object.isFrozen(window.ospeliFacilitiesDemo)));
  assert.deepEqual(errors, []);
  await context.close();
});
