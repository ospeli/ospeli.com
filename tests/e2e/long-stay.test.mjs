// Long-stay beds demo (web/demo/long-stay/): each role renders with no sideways scroll, a ward
// manager can move a placement request to Moved and record a new ready-to-leave date with the
// measures updating, guide proposals wait for the named role, and the guide can be switched off.
// Fictional data only.
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
  await page.goto(env.base + '/demo/long-stay/');
  await page.waitForSelector('#kpis .stat');
  return { context, page, errors };
}
const api = (page, fn) => page.evaluate((f) => window.ospeliLongStayDemo[f](), fn);
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

for (const width of [360, 390, 1280]) {
  test(`long-stay renders every role at ${width}px with no sideways scroll`, async () => {
    const { context, page, errors } = await open(width);
    assert.equal(await page.locator('#kpis .stat').count(), 6);
    assert.ok(await page.locator('.sugg').count() >= 3, 'guide shows suggestions');
    for (const role of ['ward', 'coord', 'ops']) {
      await page.click('#r-' + role);
      assert.equal(await page.locator('#r-' + role).getAttribute('aria-pressed'), 'true');
      const o = await overflow(page);
      assert.ok(o <= 0, `${role} view scrolls sideways by ${o}px`);
    }
    if (width < 500) {
      await page.click('#r-ward');
      const h = await page.locator('#ward-list .go').first().boundingBox();
      assert.ok(h.height >= 44, 'front-line buttons are at least 44px tall');
      const fs = await page.locator('#ward-list .code small').first().evaluate((n) => parseFloat(getComputedStyle(n).fontSize));
      assert.ok(fs >= 15, 'front-line text is at least 15px');
    }
    assert.deepEqual(errors, []);
    await context.close();
  });
}

test('a ward manager moves a placement request to Moved and the measures update', async () => {
  const { context, page, errors } = await open(390);
  await page.click('#r-ward');
  await page.selectOption('#ward-pick', 'W15');
  const before = await api(page, 'kpis');
  // P-4470 is at Accepted on Ward 15: the next tap records the move.
  assert.equal(await page.locator('#a-P-4470').textContent(), 'Moved: bed now free');
  await page.click('#a-P-4470');
  const after = await api(page, 'kpis');
  assert.equal(after.patientsDelayed, before.patientsDelayed - 1);
  assert.equal(after.freeBeds, before.freeBeds + 1);
  assert.equal(after.movesThisMonth, before.movesThisMonth + 1);
  assert.equal(await page.locator('#a-P-4470').count(), 0);
  assert.match(await page.locator('#log li').first().textContent(), /P-4470 moved/);
  // Stage update on another patient: P-3846 on Ward 11 has no request yet.
  await page.selectOption('#ward-pick', 'W11');
  await page.click('#a-P-3846');
  assert.equal((await api(page, 'get')).delays.find((d) => d.code === 'P-3846').stage, 'Requested');
  assert.equal(await page.locator('#a-P-3846').textContent(), 'Mark assessed');
  assert.deepEqual(errors, []);
  await context.close();
});

test('recording ready to leave starts a delay with a reason from the fixed list', async () => {
  const { context, page, errors } = await open(360);
  await page.click('#r-ward');
  const before = await api(page, 'kpis');
  const opts = await page.locator('#rec-reason option').allTextContents();
  assert.deepEqual(opts.slice(1), ['Placement', 'Funding', 'Housing', 'Family', 'Equipment', 'Paperwork']);
  const val = await page.locator('#rec-bed option').nth(1).getAttribute('value');
  await page.selectOption('#rec-bed', val);
  await page.selectOption('#rec-reason', 'equipment');
  await page.click('#rec-go');
  const after = await api(page, 'kpis');
  assert.equal(after.patientsDelayed, before.patientsDelayed + 1);
  const d = (await api(page, 'get')).delays.find((x) => x.daysWaiting === 0);
  assert.equal(d.reason, 'equipment');
  assert.equal(d.stage, 'No request yet');
  assert.deepEqual(errors, []);
  await context.close();
});

test('a guide proposal changes nothing until the named role confirms', async () => {
  const { context, page, errors } = await open(1280);
  await page.click('#r-ward');
  const noReq = () => api(page, 'get').then((g) => g.delays.filter((d) => d.stage === 'No request yet').length);
  const before = await noReq();
  assert.ok(before >= 3);
  await page.locator('.sugg[data-id^="noreq-"] button.primary').click();
  assert.equal(await noReq(), before, 'proposing changes nothing');
  assert.equal(await page.locator('#pending .prop').count(), 1);
  await page.getByRole('button', { name: 'Switch to the coordinator view to decide' }).click();
  assert.equal(await page.locator('#r-coord').getAttribute('aria-pressed'), 'true');
  await page.locator('#pending').getByRole('button', { name: 'Confirm' }).click();
  assert.ok(await noReq() < before, 'confirmed requests are started');
  assert.match(await page.locator('#log li').first().textContent(), /coordinator confirmed/);
  assert.deepEqual(errors, []);
  await context.close();
});

test('the guide flags a growing delay reason and a local bed for an out-of-area return', async () => {
  const { context, page, errors } = await open(1280);
  const s = await api(page, 'suggestions');
  assert.ok(s.some((x) => x.id.startsWith('grow-housing')), 'housing delays flagged as growing');
  assert.ok(s.some((x) => x.id.startsWith('return-')), 'return suggested');
  assert.ok(s.some((x) => x.id.startsWith('review-')), 'review list suggested');
  await page.click('#r-ops');
  assert.equal(await page.locator('#trend tr.grow').count(), 1);
  assert.deepEqual(errors, []);
  await context.close();
});

test('the guide has an off switch and the views still work without it', async () => {
  const { context, page, errors } = await open(390);
  await page.uncheck('#guide-on');
  assert.equal(await page.locator('.sugg').count(), 0);
  assert.deepEqual(await api(page, 'suggestions'), []);
  await page.click('#r-coord');
  assert.ok(await page.locator('#delays .drow').count() >= 10);
  assert.equal(await page.locator('#kpis .stat').count(), 6);
  assert.deepEqual(errors, []);
  await context.close();
});

test('the agent object is read-only and returns data', async () => {
  const { context, page, errors } = await open(1280);
  assert.match(await api(page, 'describe'), /Read-only/);
  const g = await api(page, 'get');
  assert.equal(g.beds.length, 4);
  assert.ok(g.delays.length >= 10);
  assert.ok(g.delays.every((d) => /^P-\d{4}$/.test(d.code)));
  const k = await api(page, 'kpis');
  assert.ok(k.delayedTransferDaysThisMonth > 0);
  assert.ok(await page.evaluate(() => Object.isFrozen(window.ospeliLongStayDemo)));
  assert.deepEqual(errors, []);
  await context.close();
});
