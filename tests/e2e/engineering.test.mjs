// Engineering (backlog item 7): report a fault from a label link, work the queue as the
// estates technician, and keep the KPIs in step. Phone and desktop.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, openPage } from './helpers.mjs';

let env;
before(async () => { env = await startApp(); });
after(async () => { await env.close(); });

const noSideways = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
const openCount = (page) => page.locator('[data-test="wo-open"] b').textContent().then(Number);

for (const width of [390, 1280]) {
  test(`ward nurse reports a fault from the asset's label link (${width}px)`, async () => {
    const { context, page, errors } = await openPage(env, { width, path: '#/engineering/report/asset-a1-sink-1' });
    await page.waitForSelector('[data-test="wo-open"] b');
    assert.equal(await page.inputValue('[data-test="f-loc"]'), 'ward-a1');
    assert.equal(await page.inputValue('[data-test="f-asset"]'), 'asset-a1-sink-1');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'f-fault', 'the label link lands on the fault list');
    const before = await openCount(page);
    await page.selectOption('[data-test="f-fault"]', 'Tap leaking');
    await page.locator('.prio-opt', { hasText: 'High' }).click();
    await page.click('[data-cmd="ospeli_workorders_report_fault"]');
    await page.waitForFunction(() => /^Reported: WO-\d{5}/.test(document.querySelector('[data-test="report-status"]').textContent));
    await page.waitForFunction((n) => Number(document.querySelector('[data-test="wo-open"] b').textContent) === n + 1, before);
    const ev = await page.evaluate(async () => (await window.ospeli.core.events({ type: 'asset.fault-reported' })).at(-1));
    assert.equal(ev.subject, 'asset-a1-sink-1');
    assert.equal(ev.actorRole, 'ward-nurse');
    assert.deepEqual({ title: ev.data.title, priority: ev.data.priority, trade: ev.data.trade }, { title: 'Tap leaking', priority: 'high', trade: 'estates' });
    const tile = page.locator(`[data-wo="${ev.data.workOrder}"]`);
    assert.match(await tile.textContent(), /Tap leaking.*Due in (23 h 59 min|24 h)/s);
    const heights = await page.locator('form [data-cmd], .prio-opt, form select').evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().height)));
    assert.ok(heights.every((x) => x >= 44), `tap targets ${heights.join(',')}`);
    assert.ok(await noSideways(page) <= 0);
    assert.deepEqual(errors, []);
    await context.close();
  });
}

test('estates tech sees the queue first, assigns and closes a work order; the KPI tile follows', async () => {
  const { context, page, errors } = await openPage(env, { width: 390, path: '#/engineering' });
  await page.selectOption('#role-select', 'estates-tech');
  await page.waitForFunction(() => document.querySelector('main h2')?.textContent === 'Work-order queue');
  await page.waitForSelector('[data-test="wo-list"] [data-wo]');
  await page.waitForFunction(() => document.querySelector('[data-kpi="open-work-orders"]'));
  const order = await page.evaluate(() => [...document.querySelectorAll('main h2')].map((x) => x.textContent));
  assert.ok(order.indexOf('Work-order queue') < order.indexOf('Report a fault'), `queue first for the estates tech: ${order.join(' / ')}`);
  const before = await openCount(page);
  assert.equal(Number(await page.locator('[data-kpi="open-work-orders"] .kpi-value').textContent()), before, 'KPI tile equals the queue count');

  const first = page.locator('[data-test="wo-list"] [data-wo]').first();
  const id = await first.getAttribute('data-wo');
  await first.click();
  await page.waitForSelector('dialog[open]');
  assert.match(await page.locator('dialog[open] .label-link').textContent(), /#\/engineering\/report\/asset-/);
  await page.selectOption('#wo-team', 'contractor');
  await page.click('dialog[open] [data-cmd="ospeli_workorders_assign"]');
  await page.waitForFunction((wo) => document.querySelector(`[data-wo="${wo}"]`)?.textContent.includes('External contractor'), id);
  await page.click(`[data-wo="${id}"]`);
  await page.waitForSelector('dialog[open]');
  await page.selectOption('#wo-outcome', 'fixed');
  await page.click('dialog[open] [data-cmd="ospeli_workorders_complete"]');
  await page.waitForFunction((n) => Number(document.querySelector('[data-test="wo-open"] b').textContent) === n - 1, before);
  await page.waitForFunction((n) => Number(document.querySelector('[data-kpi="open-work-orders"] .kpi-value')?.textContent) === n - 1, before);
  const types = await page.evaluate(async (wo) => (await window.ospeli.core.events()).filter((e) => e.subject === wo).map((e) => [e.type, e.actorRole]), id);
  assert.deepEqual(types.slice(-2), [['workorder.assigned', 'estates-tech'], ['workorder.completed', 'estates-tech']]);
  await page.click('[data-filter="completed"]');
  assert.match(await page.locator(`[data-wo="${id}"]`).textContent(), /Fixed/);
  assert.ok(await noSideways(page) <= 0);
  assert.deepEqual(errors, []);
  await context.close();
});

test('the COO can read the queue but has no report form or work-order actions', async () => {
  const { context, page, errors } = await openPage(env, { path: '#/engineering' });
  await page.selectOption('#role-select', 'coo');
  await page.waitForSelector('[data-test="wo-list"] [data-wo]');
  await page.waitForFunction(() => !document.querySelector('[data-test="report-form"]'));
  await page.locator('[data-test="wo-list"] [data-wo]').first().click();
  await page.waitForSelector('dialog[open]');
  assert.equal(await page.locator('dialog[open] [data-cmd]').count(), 0);
  assert.match(await page.locator('dialog[open]').textContent(), /COO can see this work order but not change it/);
  assert.deepEqual(errors, []);
  await context.close();
});
