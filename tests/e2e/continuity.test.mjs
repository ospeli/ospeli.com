// Emergency preparedness and continuity demo (web/demo/continuity/): renders on phone and laptop,
// a ward lead's checklist tick changes the readiness KPIs, changes queue while the network is
// simulated down and sync when it is back, incident mode logs decisions, the guide can be switched
// off and only proposes. Fictional data only.
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
  await page.goto(env.base + '/demo/continuity/');
  await page.waitForSelector('#kpis .stat');
  return { context, page, errors };
}
const api = (page, fn) => page.evaluate((f) => window.ospeliContinuityDemo[f](), fn);

for (const width of [360, 390, 1280]) {
  test(`continuity demo renders at ${width}px with no sideways scroll in every role`, async () => {
    const { context, page, errors } = await open(width);
    for (const role of ['ward', 'planning', 'exec']) {
      await page.click('#r-' + role);
      assert.equal(await page.locator('#r-' + role).getAttribute('aria-pressed'), 'true');
      assert.equal(await page.locator('#kpis .stat').count(), 4);
      const o = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      assert.ok(o <= 0, `${role} view scrolls sideways by ${o}px`);
    }
    await page.click('#r-ward');
    await page.click('#pack-open');
    assert.ok(await page.locator('#pack').isVisible(), 'downtime pack preview opens');
    const o = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(o <= 0, `pack preview scrolls sideways by ${o}px`);
    assert.ok(await page.locator('.sugg').count() >= 1, 'guide shows suggestions');
    assert.deepEqual(errors, []);
    await context.close();
  });
}

test('a ward lead ticking the checklist changes the readiness KPIs', async () => {
  const { context, page, errors } = await open(390);
  await page.click('#r-ward');
  const before = await api(page, 'kpis');
  for (const k of ['plan', 'pack', 'contacts', 'drill']) await page.click('#ci-' + k);
  const afterK = await api(page, 'kpis');
  assert.equal(afterK.areasReady, before.areasReady + 1, 'one more area fully ready');
  assert.equal(afterK.plansInDate, before.plansInDate, 'Ward 3 plan was already in date');
  assert.match(await page.locator('#kpi-mine b').textContent(), /4 of 4/);
  await page.click('#cp-contacts');
  assert.equal((await api(page, 'kpis')).areasReady, before.areasReady, 'a reported problem makes the area not ready');
  assert.equal((await api(page, 'kpis')).openActions, before.openActions + 1, 'the problem opens an action');
  assert.deepEqual(errors, []);
  await context.close();
});

test('simulated network down: page still works, changes queue, then sync', async () => {
  const { context, page, errors } = await open(390);
  await page.click('#r-ward');
  await page.click('#net');
  assert.equal(await page.locator('#net').getAttribute('aria-pressed'), 'true');
  await page.click('#ci-pack');
  assert.equal((await api(page, 'get')).queue.length, 1);
  assert.match(await page.locator('#sync').textContent(), /1 change waiting/);
  assert.ok(await page.locator('.sugg[data-id=queued]').count() === 1, 'guide explains the queue');
  await page.click('#net');
  await page.waitForFunction(() => window.ospeliContinuityDemo.get().queue.length === 0 && !window.ospeliContinuityDemo.get().offline);
  assert.match(await page.locator('#sync').textContent(), /Synced/);
  assert.deepEqual(errors, []);
  await context.close();
});

test('incident mode: start, tick a step, log a decision, executive sees it', async () => {
  const { context, page, errors } = await open(1280);
  await page.click('#r-planning');
  await page.selectOption('#inc-type', 'power');
  await page.click('#inc-start');
  await page.locator('.sugg[data-id=nextstep] button').click();
  assert.equal(await page.locator('#step-0').getAttribute('aria-pressed'), 'false', 'the guide only opens the step');
  await page.click('#step-0');
  await page.fill('#dec-text', 'Planned lists paused for two hours');
  await page.click('#dec-log');
  const g = await api(page, 'get');
  assert.equal(g.incident.active, true);
  assert.equal(g.incident.stepsDone, 1);
  assert.equal(g.incident.decisions.length, 1);
  await page.click('#r-exec');
  assert.match(await page.locator('#view').textContent(), /Planned lists paused/);
  assert.ok(await page.locator('#exec-next').isVisible());
  assert.deepEqual(errors, []);
  await context.close();
});

test('the guide proposes drill dates and a person confirms', async () => {
  const { context, page, errors } = await open(1280);
  await page.click('#r-planning');
  const n = (await api(page, 'get')).drills.length;
  await page.locator('.sugg[data-id=nodrill] button').click();
  assert.equal((await api(page, 'get')).drills.length, n, 'proposing does not change the plan');
  await page.locator('.prop button.primary').first().click();
  assert.equal((await api(page, 'get')).drills.length, n + 1);
  assert.deepEqual(errors, []);
  await context.close();
});

test('the guide has an off switch and the page still works without it', async () => {
  const { context, page, errors } = await open(390);
  await page.uncheck('#guide-on');
  assert.equal(await page.locator('.sugg').count(), 0);
  await page.click('#r-ward');
  await page.click('#ci-plan');
  assert.equal(await page.locator('#kpis .stat').count(), 4);
  assert.deepEqual(errors, []);
  await context.close();
});

test('the agent object is read-only and returns data', async () => {
  const { context, page, errors } = await open(1280);
  assert.match(await api(page, 'describe'), /Read-only/);
  const g = await api(page, 'get');
  assert.equal(g.areas.length, 8);
  const k = await api(page, 'kpis');
  assert.ok(k.areas === 8 && typeof k.areasReady === 'number');
  assert.ok((await api(page, 'suggestions')).length >= 1);
  assert.ok(await page.evaluate(() => Object.isFrozen(window.ospeliContinuityDemo)));
  assert.deepEqual(errors, []);
  await context.close();
});
