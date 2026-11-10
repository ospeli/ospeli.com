// Daily flow report demo (web/demo/daily-report/): renders on phone and laptop, the flow coordinator's
// data fixes and "ready" change the KPIs, the COO can decide, the guide only proposes huddle items and
// can be switched off, numbers show definitions, and the read-only agent object returns data.
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
  await page.goto(env.base + '/demo/daily-report/');
  await page.waitForSelector('#stats .stat');
  return { context, page, errors };
}
const api = (page, fn) => page.evaluate((f) => window.ospeliDailyReportDemo[f](), fn);
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

for (const width of [360, 390, 1280]) {
  test(`daily report renders every role at ${width}px with no sideways scroll`, async () => {
    const { context, page, errors } = await open(width);
    for (const role of ['coo', 'ops', 'flow']) {
      await page.click(`[data-role=${role}]`);
      assert.equal(await page.locator('#stats .stat').count(), 4);
      const o = await overflow(page);
      assert.ok(o <= 0, `${role} scrolls sideways by ${o}px`);
    }
    await page.click('[data-view=report]');
    assert.ok(await page.locator('#report').isVisible());
    assert.ok((await overflow(page)) <= 0, 'report scrolls sideways');
    if (width < 400) {
      const small = await page.evaluate(() => [...document.querySelectorAll('.seg button')].filter((b) => b.getBoundingClientRect().height < 44).length);
      assert.equal(small, 0, 'role and day buttons are at least 44px tall');
    }
    assert.deepEqual(errors, []);
    await context.close();
  });
}

test('the flow coordinator fills data gaps and marks the report ready; KPIs update', async () => {
  const { context, page, errors } = await open(390);
  await page.click('[data-role=flow]');
  const before = await api(page, 'kpis');
  assert.ok(before.dataCompleteness.value < 100, 'example day has data gaps');
  await page.locator('#checks button.primary').first().click();
  const mid = await api(page, 'kpis');
  assert.ok(mid.dataCompleteness.value > before.dataCompleteness.value, 'completeness goes up');
  await page.click('#mark-ready');
  const after = await api(page, 'kpis');
  assert.equal(after.reportOnTime.value, before.reportOnTime.value + 1, 'report on time counts today');
  assert.match(await page.locator('#log').innerText(), /report marked ready/);
  assert.deepEqual(errors, []);
  await context.close();
});

test('the COO sees three decisions with reasons and links, and can mark one decided', async () => {
  const { context, page, errors } = await open(1280);
  await page.click('[data-role=coo]');
  const list = await api(page, 'decisions');
  assert.equal(list.length, 3);
  for (const d of list) { assert.ok(d.reason.length > 10); assert.ok(d.link); }
  await page.locator('.dec button.primary').first().click();
  assert.equal((await api(page, 'decisions')).filter((d) => d.status === 'decided').length, 1);
  assert.match(await page.locator('#d-sub').innerText(), /2 decisions open/);
  assert.deepEqual(errors, []);
  await context.close();
});

test('operations manager: run charts, bottleneck ranking, closing an action changes the KPI', async () => {
  const { context, page, errors } = await open(1280);
  await page.click('[data-role=ops]');
  assert.equal(await page.locator('.chart svg').count(), 6);
  const bn = await api(page, 'bottlenecks');
  assert.ok(bn.rows[0].hours >= bn.rows[1].hours, 'ranked by hours lost');
  const before = (await api(page, 'kpis')).actionsClosedOnTime.value;
  await page.locator('[data-action=a5] button').click();
  assert.ok((await api(page, 'kpis')).actionsClosedOnTime.value > before, 'closing a due action on time raises the KPI');
  assert.deepEqual(errors, []);
  await context.close();
});

test('the guide proposes a huddle item a person can edit, and has an off switch', async () => {
  const { context, page, errors } = await open(390);
  await page.click('[data-role=ops]');
  const sugg = await api(page, 'suggestions');
  assert.ok(sugg.length >= 2 && sugg.length <= 4, 'two to four suggestions');
  for (const s of sugg) assert.ok(s.why);
  await page.locator('.sugg button.primary').first().click();
  const input = page.locator('#huddle input[type=text]').first();
  await input.fill('Edited by a person');
  await input.press('Enter');
  await input.blur();
  assert.equal((await api(page, 'get')).huddle[0].text, 'Edited by a person');
  await page.uncheck('#guide-on');
  assert.equal(await page.locator('.sugg').count(), 0);
  assert.deepEqual(await api(page, 'suggestions'), []);
  assert.equal(await page.locator('#stats .stat').count(), 4, 'report still works with the guide off');
  assert.deepEqual(errors, []);
  await context.close();
});

test('numbers show their definition, and the day switch is deterministic', async () => {
  const { context, page, errors } = await open(390);
  await page.click('[data-role=ops]');
  await page.locator('[data-area=beds] .n').first().click();
  assert.ok(await page.locator('#def').isVisible());
  assert.match(await page.locator('#def-d').innerText(), /empty, cleaned/);
  await page.keyboard.press('Escape');
  assert.ok(await page.locator('#def').isHidden());
  const y1 = await api(page, 'get');
  await page.click('[data-day=today]');
  const t = await api(page, 'get');
  assert.equal(t.day, 'today');
  await page.click('[data-day=yesterday]');
  assert.deepEqual((await api(page, 'get')).beds, y1.beds, 'same seed gives the same day');
  assert.match(await page.evaluate(() => window.ospeliDailyReportDemo.describe()), /Read-only/);
  assert.ok(Object.isFrozen(await page.evaluateHandle(() => window.ospeliDailyReportDemo).then((h) => h.evaluate((o) => Object.isFrozen(o)))));
  assert.deepEqual(errors, []);
  await context.close();
});
