// Infection prevention operations demo (web/demo/infection-prevention/): each role renders with no
// sideways scroll, a ward nurse's actions (clean done, audit, request) change the measures, guide
// proposals change nothing until the IPC team confirms, closure mode counts beds, and the guide can be
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
  await page.goto(env.base + '/demo/infection-prevention/');
  await page.waitForSelector('#kpis .stat');
  return { context, page, errors };
}
const api = (page, fn) => page.evaluate((f) => window.ospeliInfectionPreventionDemo[f](), fn);
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

for (const width of [360, 390, 1280]) {
  test(`infection prevention renders every role at ${width}px with no sideways scroll`, async () => {
    const { context, page, errors } = await open(width);
    assert.equal(await page.locator('#kpis .stat').count(), 4);
    assert.ok(await page.locator('.sugg').count() >= 2, 'guide shows suggestions');
    assert.match(await page.locator('#clocknow').textContent(), /^Demo clock \d\d:\d\d$/);
    for (const role of ['nurse', 'ipc', 'ops']) {
      await page.click('#r-' + role);
      assert.equal(await page.locator('#r-' + role).getAttribute('aria-pressed'), 'true');
      const o = await overflow(page);
      assert.ok(o <= 0, `${role} view scrolls sideways by ${o}px`);
    }
    if (width < 500) {
      await page.click('#r-nurse');
      const h = await page.locator('#my-rooms .go').first().boundingBox();
      assert.ok(h.height >= 44, 'front-line buttons are at least 44px tall');
      const order = await page.evaluate(() => document.getElementById('view').compareDocumentPosition(document.getElementById('kpibox')) & Node.DOCUMENT_POSITION_FOLLOWING);
      assert.ok(order, 'the nurse view leads with its task; KPI tiles come below');
    }
    assert.deepEqual(errors, []);
    await context.close();
  });
}

test('a ward nurse marks a clean done and the availability measure updates', async () => {
  const { context, page, errors } = await open(390);
  await page.click('#r-nurse');
  await page.selectOption('#ward-pick', 'W2');
  const before = await api(page, 'kpis');
  await page.click('#a-W2-2');
  const after = await api(page, 'kpis');
  assert.equal(after.roomsReady, before.roomsReady + 1);
  assert.equal(after.roomsCleaning, before.roomsCleaning - 1);
  assert.match(await page.locator('#kpi-avail b').textContent(), new RegExp('^' + after.roomsReady + ' of '));
  assert.match(await page.locator('#log li').first().textContent(), /deep clean done/);
  // The waiting request from Ward 4 needs a lobby room: it now has a ready match.
  assert.ok((await api(page, 'suggestions')).some((s) => /Place P-3054/.test(s.title)));
  assert.deepEqual(errors, []);
  await context.close();
});

test('a hand hygiene audit and an isolation request update the measures', async () => {
  const { context, page, errors } = await open(360);
  await page.click('#r-nurse');
  const k0 = await api(page, 'kpis');
  await page.click('#hh-yes'); await page.click('#hh-yes'); await page.click('#hh-no');
  assert.match(await page.locator('#hh-tally').textContent(), /3 observed · 67% done/);
  await page.click('#au-save');
  const k1 = await api(page, 'kpis');
  assert.equal(k1.handHygieneObs, k0.handHygieneObs + 3);
  await page.click('#n-lobby');
  await page.click('#q-send');
  const k2 = await api(page, 'kpis');
  assert.equal(k2.requestsWaiting, k1.requestsWaiting + 1);
  assert.ok((await api(page, 'get')).requestsWaiting.some((q) => q.area === 'Ward 2' && q.needs === 'lobby' && /^P-\d{4}$/.test(q.patientCode)));
  // A cleaning audit with a failed item creates an action.
  await page.click('#au-clean');
  for (let i = 0; i < 6; i++) await page.click(`#ci-${i}-${i === 3 ? 'n' : 'y'}`);
  const a0 = (await api(page, 'get')).openActions.length;
  await page.click('#au-save');
  assert.equal((await api(page, 'get')).openActions.length, a0 + 1);
  assert.deepEqual(errors, []);
  await context.close();
});

test('a guide proposal changes nothing until the IPC team confirms', async () => {
  const { context, page, errors } = await open(1280);
  await page.click('#r-ipc');
  const k0 = await api(page, 'kpis');
  await page.getByRole('button', { name: 'Propose this placement' }).first().click();
  assert.deepEqual(await api(page, 'kpis'), k0, 'proposing changes nothing');
  assert.equal((await api(page, 'get')).pendingDecisions.length, 1);
  await page.locator('#pending').getByRole('button', { name: 'Confirm' }).click();
  const k1 = await api(page, 'kpis');
  assert.equal(k1.requestsWaiting, k0.requestsWaiting - 1);
  assert.equal(k1.placedToday, k0.placedToday + 1);
  assert.equal(k1.roomsReady, k0.roomsReady - 1);
  // Overdue audits: proposal, then confirm adds them to the round.
  await page.getByRole('button', { name: /add to this week's round/ }).click();
  await page.locator('#pending').getByRole('button', { name: 'Confirm' }).click();
  assert.ok((await api(page, 'get')).compliance.filter((c) => c.inAuditRound).length >= 2);
  assert.deepEqual(errors, []);
  await context.close();
});

test('closure mode counts closed beds and reopening drafts a checklist', async () => {
  const { context, page, errors } = await open(1280);
  await page.click('#r-ipc');
  const k0 = await api(page, 'kpis');
  await page.click('#bay-plus');
  assert.equal((await api(page, 'kpis')).bedsClosedNow, k0.bedsClosedNow + 6);
  await page.click('#cl-reopen');
  assert.equal((await api(page, 'kpis')).bedsClosedNow, 0);
  await page.getByRole('button', { name: 'Propose this checklist' }).click();
  await page.locator('#pending').getByRole('button', { name: 'Confirm' }).click();
  assert.equal(await page.locator('#closure .check li').count(), 6);
  assert.deepEqual(errors, []);
  await context.close();
});

test('the guide has an off switch and the ward view still works without it', async () => {
  const { context, page, errors } = await open(390);
  await page.uncheck('#guide-on');
  assert.equal(await page.locator('.sugg').count(), 0);
  assert.deepEqual(await api(page, 'suggestions'), []);
  await page.click('#r-nurse');
  await page.selectOption('#ward-pick', 'W2');
  const before = await api(page, 'kpis');
  await page.click('#a-W2-1');
  assert.equal((await api(page, 'kpis')).roomsCleaning, before.roomsCleaning + 1);
  assert.equal(await page.locator('#kpis .stat').count(), 4);
  assert.deepEqual(errors, []);
  await context.close();
});

test('agent object is read-only and returns data', async () => {
  const { context, page, errors } = await open(1280);
  assert.match(await api(page, 'describe'), /Read-only/);
  const g = await api(page, 'get');
  assert.equal(g.rooms.length, 15);
  assert.equal(g.compliance.length, 8);
  assert.ok(g.requestsWaiting.length >= 2);
  const k = await api(page, 'kpis');
  assert.ok(k.handHygienePct > 0 && k.timeToIsolationMin > 0 && k.bedDaysLost > 0);
  assert.ok((await api(page, 'suggestions')).length >= 2);
  assert.ok(await page.evaluate(() => Object.isFrozen(window.ospeliInfectionPreventionDemo)));
  assert.deepEqual(errors, []);
  await context.close();
});
