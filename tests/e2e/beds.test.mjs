import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, openPage } from './helpers.mjs';

let env;
before(async () => { env = await startApp(); });
after(async () => { await env.close(); });

const stat = (page, t) => page.locator(`[data-test="${t}"] b`).textContent().then(Number);
const bedState = (page, id) => page.evaluate(async (bedId) => {
  const { deriveBoard } = await import('./core/beds.js');
  const core = window.ospeli.core;
  return deriveBoard(await core.listEntities('bed'), await core.events()).beds.get(bedId).state;
}, id);

for (const width of [360, 390, 1024, 1280]) {
  test(`bed board renders every ward at ${width}px with no sideways scroll`, async () => {
    const { context, page, errors } = await openPage(env, { width, path: '#/beds' });
    await page.waitForSelector('[data-test="bed-grid"] .bed');
    assert.equal(await page.locator('main h1').textContent(), 'Bed board');
    assert.equal(await page.locator('.ward-tab').count(), 6);
    assert.equal(await page.locator('[data-test="bed-grid"] .bed').count(), 20);
    assert.ok(await stat(page, 'sum-waiting') >= 1, 'synthetic patients wait for a bed');
    const o = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(o <= 0, `scrolls sideways by ${o}px`);
    assert.deepEqual(errors, []);
    await context.close();
  });
}

test('bed manager allocates a waiting patient, the nurse admits, discharges and cleans: all from the event log', async () => {
  const { context, page, errors } = await openPage(env, { width: 390, path: '#/beds' });
  await page.selectOption('#role-select', 'bed-manager');
  await page.waitForFunction(async () => (await window.ospeli.core.getMeta('role')) === 'bed-manager');
  await page.reload(); // start from a settled render as the bed manager
  await page.waitForSelector('html[data-ready="true"]');
  await page.waitForSelector('[data-find]');
  const waitingBefore = await stat(page, 'sum-waiting');
  const enc = await page.locator('[data-find]').first().getAttribute('data-find');
  // Find a bed: the board jumps to the requested ward and highlights free beds.
  await page.locator('[data-find]').first().click();
  await page.waitForSelector('.banner');
  let freeBed = await page.locator('.bed.match').first().getAttribute('data-bed').catch(() => null);
  if (!freeBed) {
    // No free bed on the requested ward: pick any ward that has one.
    const ward = await page.evaluate(() => [...document.querySelectorAll('.ward-tab')].find((b) => !/\b0 free/.test(b.textContent))?.dataset.ward);
    await page.click(`.ward-tab[data-ward="${ward}"]`);
    freeBed = await page.locator('.bed.match').first().getAttribute('data-bed');
  }
  await page.click(`.bed[data-bed="${freeBed}"]`);
  await page.waitForFunction((b) => document.querySelector(`.bed[data-bed="${b}"]`)?.classList.contains('st-allocated'), freeBed);
  assert.equal(await stat(page, 'sum-waiting'), waitingBefore - 1);
  const allocated = await page.evaluate(async () => (await window.ospeli.core.events({ type: 'bed.allocated' })).at(-1));
  assert.equal(allocated.subject, freeBed);
  assert.equal(allocated.data.encounter, enc);
  assert.equal(allocated.actorRole, 'bed-manager');

  // Ward nurse: patient arrives, goes home, bed is cleaned.
  await page.selectOption('#role-select', 'ward-nurse');
  await page.waitForFunction(async () => (await window.ospeli.core.getMeta('role')) === 'ward-nurse');
  const ward = freeBed.replace(/-bed-\d+$/, '');
  await page.goto(`${env.appUrl}#/beds/${ward}`);
  await page.reload();
  await page.waitForSelector('html[data-ready="true"]');
  await page.waitForSelector(`.bed[data-bed="${freeBed}"]`);
  const step = async (action, expect) => {
    await page.click(`.bed[data-bed="${freeBed}"]`);
    await page.click(`dialog[open] [data-action="${action}"]`);
    await page.waitForFunction(([b, s]) => document.querySelector(`.bed[data-bed="${b}"]`)?.classList.contains(`st-${s}`), [freeBed, expect]);
  };
  await step('admit', 'occupied');
  await step('expect-discharge', 'expected-discharge');
  await step('vacate', 'vacated');
  await step('start-clean', 'cleaning');
  await step('finish-clean', 'available');
  // Out of service needs a reason, and comes back.
  await page.click(`.bed[data-bed="${freeBed}"]`);
  await page.selectOption('dialog[open] #oos-reason', 'Electrical');
  await page.click('dialog[open] [data-action="out-of-service"]');
  await page.waitForFunction((b) => document.querySelector(`.bed[data-bed="${b}"]`)?.classList.contains('st-out-of-service'), freeBed);
  assert.match(await page.locator(`.bed[data-bed="${freeBed}"]`).textContent(), /Electrical/);

  // Survives a reload because state comes only from the stored event log.
  await page.reload();
  await page.waitForSelector('html[data-ready="true"]');
  await page.waitForSelector(`.bed[data-bed="${freeBed}"]`);
  assert.equal(await bedState(page, freeBed), 'out-of-service');
  const types = await page.evaluate(async (b) => (await window.ospeli.core.events()).filter((e) => e.subject === b || e.data?.bedId === b).slice(-8).map((e) => e.type), freeBed);
  assert.deepEqual(types, ['bed.allocated', 'patient.admitted', 'patient.expected-discharge', 'patient.discharged', 'bed.vacated', 'bed.clean-started', 'bed.cleaned', 'bed.out-of-service']);
  assert.match(await page.locator('[data-test="recent"]').textContent(), /out of service · Ward nurse/);
  assert.deepEqual(errors, []);
  await context.close();
});

test('filters, deep link to a ward, and KPI definitions on the board', async () => {
  const { context, page, errors } = await openPage(env, { path: '#/beds/ward-c1' });
  await page.waitForSelector('[data-test="bed-grid"] .bed');
  assert.match(await page.locator('#ward-h').textContent(), /Ward C1/);
  assert.equal(await page.getAttribute('.ward-tab[data-ward="ward-c1"]', 'aria-pressed'), 'true');
  await page.click('[data-filter="occupied"]');
  const shown = await page.locator('[data-test="bed-grid"] .bed').evaluateAll((els) => els.map((e) => e.className));
  assert.ok(shown.every((c) => /st-(occupied|expected-discharge)/.test(c)));
  await page.click('[data-kpi="bed-turnaround"]');
  await page.waitForSelector('dialog[open]');
  assert.match(await page.locator('dialog[open]').textContent(), /vacated to it being cleaned/);
  await page.keyboard.press('Escape');
  // Changing ward updates the address without a reload.
  await page.click('.ward-tab[data-ward="ward-a2"]');
  assert.match(page.url(), /#\/beds\/ward-a2$/);
  assert.deepEqual(errors, []);
  await context.close();
});

test('bed board is keyboard operable', async () => {
  const { context, page } = await openPage(env, { width: 1280, path: '#/beds/ward-a1' });
  await page.waitForSelector('.bed');
  await page.focus('.bed');
  await page.keyboard.press('Enter');
  await page.waitForSelector('dialog[open]');
  assert.ok(await page.evaluate(() => document.querySelector('dialog[open]').contains(document.activeElement)));
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('dialog[open]').count(), 0);
  const unlabelled = await page.evaluate(() => [...document.querySelectorAll('main button, main select')].filter((b) => !(b.getAttribute('aria-label') || b.textContent.trim() || b.labels?.length)).length);
  assert.equal(unlabelled, 0);
  await context.close();
});
