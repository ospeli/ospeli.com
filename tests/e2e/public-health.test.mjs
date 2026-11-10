// Public health operations demo (web/demo/public-health/): each role renders with no sideways scroll,
// an outreach worker's check-ins and session close update the measures, changes made with no signal
// are queued and sent later, guide proposals change nothing until the coordinator confirms, and the
// guide can be switched off. Fictional data only.
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
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(env.base + '/demo/public-health/');
  await page.waitForSelector('#kpis .stat');
  return { context, page, errors };
}
const api = (page, fn) => page.evaluate((f) => window.ospeliPublicHealthDemo[f](), fn);
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

for (const width of [360, 390, 1280]) {
  test(`public health renders every role at ${width}px with no sideways scroll`, async () => {
    const { context, page, errors } = await open(width);
    for (const [role, tiles] of [['worker', 4], ['coordinator', 4], ['manager', 6]]) {
      await page.click('#r-' + role);
      assert.equal(await page.locator('#r-' + role).getAttribute('aria-pressed'), 'true');
      assert.equal(await page.locator('#kpis .stat').count(), tiles);
      const n = await page.locator('.sugg').count();
      assert.ok(n >= 1 && n <= 4, `guide shows 1-4 suggestions for ${role} (got ${n})`);
      const o = await overflow(page);
      assert.ok(o <= 0, `${role} view scrolls sideways by ${o}px`);
    }
    await page.click('#r-worker');
    if (width < 500) {
      for (const sel of ['#plus-u5', '#vial-open', '#cb-log', '#close-start']) {
        const h = await page.locator(sel).boundingBox();
        assert.ok(h.height >= 44, `${sel} is at least 44px tall`);
      }
    }
    assert.match(await page.locator('#clocknow').textContent(), /Demo clock Tue 10:20/);
    assert.deepEqual(errors, []);
    await context.close();
  });
}

test('an outreach worker checks people in and closes the session; the measures update', async () => {
  const { context, page, errors } = await open(390);
  await page.click('#r-worker');
  const before = await api(page, 'kpis');
  await page.click('#plus-a');
  await page.click('#plus-u5');
  const mid = await api(page, 'kpis');
  assert.equal(mid.checkedInToday, before.checkedInToday + 2);
  assert.equal(mid.peopleReachedMonth, before.peopleReachedMonth + 2, 'programme count of people reached goes up');
  assert.equal(await page.locator('#kpi-in b').textContent(), String(mid.checkedInToday));
  assert.match(await page.locator('#log li').first().textContent(), /Check-in: Under 5/);
  await page.click('#vial-open');
  assert.equal((await api(page, 'kpis')).vialsUnopened, before.vialsUnopened - 1);
  await page.click('#close-start');
  await page.click('#close-confirm');
  const after = await api(page, 'kpis');
  assert.ok(after.dosesIssuedMonth > before.dosesIssuedMonth, 'closed session adds to wastage figures');
  assert.match(await page.locator('#log li').first().textContent(), /closed/);
  assert.deepEqual(errors, []);
  await context.close();
});

test('with no signal, changes stay on the phone and are sent when the signal is back', async () => {
  const { context, page, errors } = await open(360);
  await page.click('#r-worker');
  const before = await api(page, 'kpis');
  await page.click('#net');
  assert.equal(await page.locator('#net').getAttribute('aria-pressed'), 'true');
  await page.click('#plus-o');
  await page.fill('#cb-v', '9.2');
  await page.click('#cb-log');
  const k = await api(page, 'kpis');
  assert.equal(k.queuedChanges, 2);
  assert.equal(k.peopleReachedMonth, before.peopleReachedMonth, 'programme figures wait for the sync');
  assert.equal(k.openAlarms, before.openAlarms, 'cold box excursion not seen until sent');
  assert.match(await page.locator('#sync').textContent(), /2 waiting/);
  await page.click('#net');
  await page.waitForFunction(() => window.ospeliPublicHealthDemo.kpis().queuedChanges === 0);
  const k2 = await api(page, 'kpis');
  assert.equal(k2.peopleReachedMonth, before.peopleReachedMonth + 1);
  assert.equal(k2.openAlarms, before.openAlarms + 1, 'out-of-range cold box reading opens an excursion');
  assert.match(await page.locator('#log li').first().textContent(), /2 changes sent/);
  assert.deepEqual(errors, []);
  await context.close();
});

test('guide proposals wait for the coordinator: near-expiry transfer and missing transport', async () => {
  const { context, page, errors } = await open(1280);
  await page.click('#r-coordinator');
  const s = await api(page, 'suggestions');
  assert.ok(s.some((x) => /expire/.test(x.title)), 'near-expiry suggestion');
  assert.ok(s.some((x) => /No transport/.test(x.title)), 'missing transport suggestion');
  const before = await api(page, 'kpis');
  const exp = page.locator('.sugg', { hasText: 'expire' });
  await exp.getByRole('button', { name: 'Propose' }).click();
  assert.equal((await api(page, 'kpis')).nearExpiryUnits, before.nearExpiryUnits, 'proposing changes nothing');
  await page.locator('.prop button.confirm').click();
  assert.ok((await api(page, 'kpis')).nearExpiryUnits < before.nearExpiryUnits, 'confirmed transfer moves the stock');
  const tr = page.locator('.sugg', { hasText: 'No transport' });
  await tr.getByRole('button', { name: 'Propose' }).click();
  await page.locator('.prop button.confirm').click();
  assert.equal((await api(page, 'kpis')).sessionsWithGaps, before.sessionsWithGaps - 1);
  // The coordinator logs an action on the open fridge excursion and closes it.
  await page.locator('[id^=actlog-]').first().click();
  await page.locator('[id^=inrange-]').first().click();
  assert.equal((await api(page, 'kpis')).openAlarms, before.openAlarms - 1);
  assert.deepEqual(errors, []);
  await context.close();
});

test('the guide has an off switch and every view still works', async () => {
  const { context, page, errors } = await open(390);
  await page.uncheck('#guide-on');
  for (const role of ['worker', 'coordinator', 'manager']) {
    await page.click('#r-' + role);
    assert.equal(await page.locator('.sugg').count(), 0);
    assert.ok(await page.locator('#kpis .stat').count() >= 4);
  }
  assert.deepEqual(await api(page, 'suggestions').then((x) => Array.isArray(x)), true);
  const g = await api(page, 'get');
  assert.ok(g.upcomingSessions.length >= 5 && g.stock.length > 0 && g.excursions.length > 0);
  assert.match(await api(page, 'describe'), /Read-only/);
  await page.locator('#kpi-held').click();
  assert.equal(await page.locator('#kpi-held').getAttribute('aria-expanded'), 'true');
  assert.deepEqual(errors, []);
  await context.close();
});
