// Health records demo (web/demo/records/): each role renders with no sideways scroll, the records
// clerk can pull a chart and record a move with the measures updating, the coder can mark a
// discharge coded, guide proposals wait for the records manager to confirm, and the guide can be
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
  await page.goto(env.base + '/demo/records/');
  await page.waitForSelector('#kpis .stat');
  return { context, page, errors };
}
const api = (page, fn) => page.evaluate((f) => window.ospeliRecordsDemo[f](), fn);
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

for (const width of [360, 390, 1280]) {
  test(`records renders every role at ${width}px with no sideways scroll`, async () => {
    const { context, page, errors } = await open(width);
    assert.equal(await page.locator('#kpis .stat').count(), 4);
    assert.ok(await page.locator('.sugg').count() >= 3, 'guide shows suggestions');
    for (const role of ['clerk', 'coder', 'manager']) {
      await page.click('#r-' + role);
      assert.equal(await page.locator('#r-' + role).getAttribute('aria-pressed'), 'true');
      const o = await overflow(page);
      assert.ok(o <= 0, `${role} view scrolls sideways by ${o}px`);
    }
    if (width < 500) {
      await page.click('#r-clerk');
      const view = await page.locator('#view').boundingBox();
      const kpi = await page.locator('#kpis').boundingBox();
      assert.ok(kpi.y > view.y, 'the clerk view leads with the task; measures below');
      const h = await page.locator('#pull .go').first().boundingBox();
      assert.ok(h.height >= 44, 'front-line buttons are at least 44px tall');
      const small = await page.evaluate(() => [...document.querySelectorAll('#view *')].filter((e) => e.childNodes.length && [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()) && e.offsetParent && parseFloat(getComputedStyle(e).fontSize) < 15).map((e) => e.className + ':' + e.textContent.slice(0, 20)));
      assert.deepEqual(small, [], 'clerk text is at least 15px');
    }
    assert.deepEqual(errors, []);
    await context.close();
  });
}

test('the clerk pulls a chart, sends a wanted chart and records a move; the measures update', async () => {
  const { context, page, errors } = await open(390);
  await page.click('#r-clerk');
  const before = await api(page, 'kpis');
  const btn = page.locator('#pull .chart.s-shelf .go').first();
  const id = await btn.getAttribute('id');
  await btn.click();
  const mid = await api(page, 'kpis');
  assert.equal(mid.pullReady, before.pullReady + 1, 'pulled chart counts as ready');
  assert.match(await page.locator('#kpi-ready b').textContent(), new RegExp('^' + mid.pullReadyPct + '%'));
  assert.equal(await page.locator('#' + id).count(), 0, 'the chart leaves the to-get list');
  assert.match(await page.locator('#log li').first().textContent(), /pulled for tomorrow/);
  // A ward asked for a chart: send it.
  await page.locator('#wanted .go').first().click();
  const after = await api(page, 'kpis');
  assert.equal(after.retrievalsToday, before.retrievalsToday + 1);
  assert.equal(after.waitingToSend, 0);
  // Scan, then record the chart going to a ward.
  await page.click('#scan-btn');
  const code = await page.inputValue('#scan-code');
  assert.match(code, /^R-[A-Z0-9]{4}$/);
  await page.click('#mv-ward');
  await page.selectOption('#scan-where', 'Ward 2');
  await page.click('#scan-save');
  const got = await api(page, 'get');
  assert.equal(got.pullList.find((p) => p.code === code).location, 'Ward 2');
  // Not found
  const nf = page.locator('#pull .chart.s-shelf button.alt').first();
  await nf.click();
  assert.equal((await api(page, 'kpis')).notFound, before.notFound + 1);
  assert.deepEqual(errors, []);
  await context.close();
});

test('the coder marks a discharge coded and sends a query', async () => {
  const { context, page, errors } = await open(1280);
  await page.click('#r-coder');
  const before = await api(page, 'kpis');
  await page.locator('#episodes button[id^="code-"]').first().click();
  const mid = await api(page, 'kpis');
  assert.equal(mid.uncoded, before.uncoded - 1);
  assert.equal(mid.codedRecently, before.codedRecently + 1);
  await page.locator('#episodes button[id^="q-"]').first().click();
  assert.equal((await api(page, 'kpis')).queried, before.queried + 1);
  await page.click('#band-b4');
  const ages = (await api(page, 'get')).codingBacklog.filter((e) => e.daysSinceDischarge > 30).length;
  assert.equal(await page.locator('#episodes .erow').count(), ages);
  assert.deepEqual(errors, []);
  await context.close();
});

test('guide suggestions only propose; the records manager confirms', async () => {
  const { context, page, errors } = await open(1280);
  await page.click('#r-manager');
  // Chase round
  const round = page.locator('.sugg[data-id^="round-"]');
  assert.equal(await round.count(), 1);
  assert.match(await round.locator('h3').textContent(), /Ward 3/);
  await round.locator('button.primary').click();
  assert.equal((await api(page, 'get')).chaseRounds.length, 0, 'nothing changes on proposal');
  await page.locator('#pending').getByRole('button', { name: 'Confirm' }).click();
  const rounds = (await api(page, 'get')).chaseRounds;
  assert.equal(rounds.length, 1);
  // Due-date flag
  const due = page.locator('.sugg[data-id^="due-"]');
  await due.locator('button.primary').click();
  assert.equal((await api(page, 'get')).requests.filter((r) => r.flagged).length, 0);
  await page.locator('#pending').getByRole('button', { name: 'Confirm' }).click();
  assert.equal((await api(page, 'get')).requests.filter((r) => r.flagged).length, 3);
  // The clerk works the round.
  await page.click('#r-clerk');
  const before = (await api(page, 'kpis')).chartsOutPastPeriod;
  await page.locator('.round button').first().click();
  assert.equal((await api(page, 'kpis')).chartsOutPastPeriod, before - 1);
  // Record request moves on a stage.
  await page.click('#r-manager');
  const open1 = (await api(page, 'kpis')).requestsOpen;
  const r = page.locator('#requests button').first();
  for (let i = 0; i < 4 && (await api(page, 'kpis')).requestsOpen === open1; i++) await page.locator('#requests button').first().click();
  assert.equal((await api(page, 'kpis')).requestsOpen, open1 - 1, 'a released request closes');
  assert.ok(r);
  assert.deepEqual(errors, []);
  await context.close();
});

test('the guide has an off switch and the views still work without it', async () => {
  const { context, page, errors } = await open(390);
  await page.uncheck('#guide-on');
  assert.equal(await page.locator('.sugg').count(), 0);
  assert.deepEqual(await api(page, 'suggestions'), []);
  await page.click('#r-clerk');
  assert.ok(await page.locator('#pull .go').count() > 0);
  assert.equal(await page.locator('#kpis .stat').count(), 4);
  assert.deepEqual(errors, []);
  await context.close();
});

test('the read-only agent object returns data', async () => {
  const { context, page, errors } = await open(1280);
  const d = await page.evaluate(() => {
    const o = window.ospeliRecordsDemo;
    return { frozen: Object.isFrozen(o), describe: o.describe(), get: o.get(), kpis: o.kpis(), sugg: o.suggestions() };
  });
  assert.ok(d.frozen);
  assert.match(d.describe, /Read-only/);
  assert.equal(d.get.pullList.length, d.kpis.pullRequested);
  assert.ok(d.get.pullList.every((p) => /^R-[A-Z0-9]{4}$/.test(p.code)), 'patients appear as codes only');
  assert.ok(d.get.chartsOutByLocation.length > 0);
  assert.ok(d.get.codingBacklog.length > 0);
  assert.ok(d.get.requests.length > 0);
  assert.ok(d.sugg.length >= 3 && d.sugg.every((s) => s.why && s.decidedBy));
  assert.ok(/^\d\d:\d\d$/.test(d.get.clock));
  assert.deepEqual(errors, []);
  await context.close();
});
