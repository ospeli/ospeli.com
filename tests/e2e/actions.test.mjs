// Incidents, risk and actions demo (web/demo/actions/): renders for each role with no sideways
// scroll, a staff report updates the KPIs, a lead review and a leadership close change state,
// the guide only proposes and has an off switch, and the agent object is read-only. Fictional data.
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
  await page.goto(env.base + '/demo/actions/');
  await page.waitForSelector('#stats .stat');
  return { context, page, errors };
}
const api = (page, fn) => page.evaluate((f) => window.ospeliActionsDemo[f](), fn);
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

for (const width of [360, 390, 1280]) {
  test(`actions demo renders every role at ${width}px with no sideways scroll`, async () => {
    const { context, page, errors } = await open(width);
    for (const role of ['staff', 'lead', 'exec']) {
      await page.click(`#role-${role}`);
      assert.equal(await page.locator(`#role-${role}`).getAttribute('aria-pressed'), 'true');
      assert.equal(await page.locator('#stats .stat').count(), 4);
      assert.ok(await page.locator('.sugg').count() >= 1, `guide shows suggestions for ${role}`);
      const o = await overflow(page);
      assert.ok(o <= 0, `${role} view scrolls sideways by ${o}px`);
    }
    assert.deepEqual(errors, []);
    await context.close();
  });
}

test('a staff member reports from a phone and the KPIs update', async () => {
  const { context, page, errors } = await open(360);
  await page.click('#role-staff');
  const before = await api(page, 'kpis');
  const tileBefore = await page.locator('#kpi-reports b').textContent();
  await page.click('label[for=cat-equip]');
  await page.selectOption('#f-where', 'Theatres');
  await page.click('label[for=near-yes]');
  await page.fill('#f-what', 'Trolley wheel jammed in the corridor; moved it aside.');
  await page.check('#f-anon');
  await page.click('#f-send');
  await page.waitForSelector('.thanks');
  const now = await api(page, 'kpis');
  assert.equal(now.reportsThisMonth, before.reportsThisMonth + 1);
  assert.equal(now.waitingForReview, before.waitingForReview + 1);
  assert.equal(await page.locator('#kpi-reports b').textContent(), String(Number(tileBefore) + 1));
  assert.equal(await page.locator('#mine .item').count(), 1);
  const r = (await api(page, 'get')).reports.at(-1);
  assert.equal(r.anon, true);
  assert.equal(r.near, true);
  assert.ok(await page.locator('#log li').first().textContent().then((t) => t.includes(r.id)));
  assert.ok(await overflow(page) <= 0);
  assert.deepEqual(errors, []);
  await context.close();
});

test('the form refuses text that looks like a name', async () => {
  const { context, page, errors } = await open(390);
  await page.click('#role-staff');
  const n = (await api(page, 'kpis')).reportsThisMonth;
  await page.click('label[for=cat-hand]');
  await page.selectOption('#f-where', 'Outpatients');
  await page.fill('#f-what', 'Mrs Example was not told about the delay.');
  await page.click('#f-send');
  assert.equal((await api(page, 'kpis')).reportsThisMonth, n);
  assert.ok(await page.locator('.alert').count() >= 1);
  assert.deepEqual(errors, []);
  await context.close();
});

test('a lead reviews a report with an action, and leadership closes an overdue action', async () => {
  const { context, page, errors } = await open(1280);
  await page.click('#role-lead');
  const k0 = await api(page, 'kpis');
  await page.locator('[data-review]').first().click();
  await page.selectOption('#rv-resp', 'Learning review');
  assert.equal(await page.locator('#rv-atitle').isVisible(), false, 'action fields hidden until asked for');
  await page.check('#rv-act');
  await page.fill('#rv-atitle', 'Spare charger kept in every bay');
  await page.click('#rv-save');
  const k1 = await api(page, 'kpis');
  assert.equal(k1.waitingForReview, k0.waitingForReview - 1);
  assert.equal(k1.openActions, k0.openActions + 1);
  await page.click('#role-exec');
  assert.ok(k1.actionsOverdue > 0, 'example has overdue actions');
  await page.locator('#actions [data-close]').first().click();
  await page.fill('#ap-text', 'Signs and mats in place; checked on site');
  await page.click('#ap-save');
  const k2 = await api(page, 'kpis');
  assert.equal(k2.actionsOverdue, k1.actionsOverdue - 1);
  assert.equal(k2.closedThisMonth, k1.closedThisMonth + 1);
  const risk = (await api(page, 'get')).risks[0];
  await page.click(`[data-rescore="${risk.id}"]`);
  await page.selectOption(`#l-${risk.id}`, '2');
  assert.equal((await api(page, 'get')).risks[0].score, 2 * risk.I, 'risk re-scored');
  assert.deepEqual(errors, []);
  await context.close();
});

test('a guide suggestion only proposes until a person confirms', async () => {
  const { context, page, errors } = await open(1280);
  await page.click('#role-lead');
  const themes = (await api(page, 'get')).themes.length;
  const card = page.locator('.sugg', { has: page.getByRole('button', { name: 'Propose a theme' }) });
  await card.getByRole('button', { name: 'Propose a theme' }).click();
  assert.equal((await api(page, 'get')).themes.length, themes, 'nothing changes on propose');
  await page.getByRole('button', { name: 'Create theme' }).click();
  assert.equal((await api(page, 'get')).themes.length, themes + 1);
  assert.deepEqual(errors, []);
  await context.close();
});

test('the guide has an off switch and everything else still works', async () => {
  const { context, page, errors } = await open(390);
  await page.click('#role-exec');
  await page.uncheck('#guide-on');
  assert.equal(await page.locator('.sugg').count(), 0);
  assert.deepEqual(await api(page, 'suggestions'), []);
  assert.equal(await page.locator('#stats .stat').count(), 4);
  assert.ok(await page.locator('#actions .action').count() > 0);
  assert.deepEqual(errors, []);
  await context.close();
});

test('the agent object is read-only and returns data', async () => {
  const { context, page, errors } = await open(1280);
  assert.match(await api(page, 'describe'), /Read-only/);
  const d = await api(page, 'get');
  assert.ok(d.reports.length > 10 && d.actions.length > 5 && d.risks.length > 3);
  assert.ok(d.risks.every((r) => r.score === r.L * r.I));
  const k = await api(page, 'kpis');
  for (const key of ['reportsThisMonth', 'medianDaysToFirstReview', 'actionsOverdue', 'closedOnTimePct']) assert.ok(key in k);
  assert.ok((await api(page, 'suggestions')).length >= 1);
  assert.equal(await page.evaluate(() => Object.isFrozen(window.ospeliActionsDemo)), true);
  assert.deepEqual(errors, []);
  await context.close();
});
