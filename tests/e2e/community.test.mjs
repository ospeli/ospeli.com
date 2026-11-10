// Primary and community care demo (web/demo/community/): each role renders with no sideways scroll,
// a community nurse can work a visit from Arrived to Done and the measures update, changes made with
// no signal are queued and sent later, guide proposals wait for the right role, and the guide can be
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
  await page.goto(env.base + '/demo/community/');
  await page.waitForSelector('#kpis .stat');
  return { context, page, errors };
}
const api = (page, fn) => page.evaluate((f) => window.ospeliCommunityDemo[f](), fn);
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

for (const width of [360, 390, 1280]) {
  test(`community care renders every role at ${width}px with no sideways scroll`, async () => {
    const { context, page, errors } = await open(width);
    for (const role of ['front', 'manager', 'district']) {
      await page.click('#r-' + role);
      assert.equal(await page.locator('#r-' + role).getAttribute('aria-pressed'), 'true');
      assert.equal(await page.locator('#kpis .stat').count(), 4);
      assert.ok(await page.locator('.sugg').count() >= 1, `guide shows a suggestion for ${role}`);
      const o = await overflow(page);
      assert.ok(o <= 0, `${role} view scrolls sideways by ${o}px`);
    }
    await page.click('#r-front');
    await page.click('#m-clinic');
    assert.ok(await overflow(page) <= 0, 'clinic list scrolls sideways');
    await page.click('#m-visits');
    if (width < 500) {
      const h = await page.locator('#round .go').first().boundingBox();
      assert.ok(h.height >= 44, 'front-line buttons are at least 44px tall');
    }
    assert.match(await page.locator('#clocknow').textContent(), /Demo clock Tue 11:4\d/);
    assert.deepEqual(errors, []);
    await context.close();
  });
}

test('a nurse marks a visit arrived then done and the measures update', async () => {
  const { context, page, errors } = await open(390);
  await page.click('#r-front');
  const before = await api(page, 'kpis');
  const btn = page.locator('#round .go').first();
  const id = await btn.getAttribute('id');
  await btn.click();
  assert.equal(await page.locator('#' + id).textContent(), 'Visit done');
  await page.click('#' + id);
  const after = await api(page, 'kpis');
  assert.equal(after.visitsDoneToday, before.visitsDoneToday + 1);
  assert.equal(after.visitsLeftToday, before.visitsLeftToday - 1);
  assert.ok(after.visitsAsPlannedPct > before.visitsAsPlannedPct, 'visits completed as planned goes up');
  assert.match(await page.locator('#kpi-done b').textContent(), new RegExp('^' + after.visitsDoneToday + ' of '));
  assert.match(await page.locator('#log li').first().textContent(), /Visit done/);
  assert.deepEqual(errors, []);
  await context.close();
});

test('with no signal, changes are kept on the phone and sent when it is back', async () => {
  const { context, page, errors } = await open(360);
  await page.click('#r-front');
  await page.click('#net');
  assert.equal(await page.locator('#net').getAttribute('aria-pressed'), 'true');
  await page.locator('#round [id^=nh-]').first().click();
  await page.locator('#fu-list button').first().click();
  assert.equal((await api(page, 'kpis')).queuedChanges, 2);
  assert.match(await page.locator('#sync').textContent(), /2 waiting/);
  await page.click('#net');
  await page.waitForFunction(() => window.ospeliCommunityDemo.kpis().queuedChanges === 0);
  assert.match(await page.locator('#log li').first().textContent(), /2 changes sent/);
  assert.deepEqual(errors, []);
  await context.close();
});

test('clinic check-in to seen records a wait', async () => {
  const { context, page, errors } = await open(390);
  await page.click('#r-front');
  await page.click('#m-clinic');
  const n = (await api(page, 'get')).clinicList.filter((c) => c.status === 'seen').length;
  await page.locator('#clinic-am .go.done').first().click();
  assert.equal((await api(page, 'get')).clinicList.filter((c) => c.status === 'seen').length, n + 1);
  assert.deepEqual(errors, []);
  await context.close();
});

test('a guide recall proposal changes nothing until the centre manager confirms', async () => {
  const { context, page, errors } = await open(1280);
  await page.click('#r-manager');
  const overdue = async () => (await api(page, 'get')).followUps[0].byProgramme[0].overdue;
  const o0 = await overdue();
  assert.ok(o0 >= 5, 'the example has overdue long-term conditions follow-ups');
  await page.getByRole('button', { name: 'Propose this recall list' }).click();
  assert.equal(await overdue(), o0, 'proposing changes nothing');
  assert.equal((await api(page, 'get')).pendingDecisions.length, 1);
  await page.locator('#pending').getByRole('button', { name: 'Confirm' }).click();
  assert.ok(await overdue() < o0, 'recalls booked');
  assert.equal((await api(page, 'get')).pendingDecisions.length, 0);
  assert.deepEqual(errors, []);
  await context.close();
});

test('the district manager holds a free place and starts it, recording the wait', async () => {
  const { context, page, errors } = await open(1280);
  await page.click('#r-district');
  const k0 = await api(page, 'kpis');
  await page.getByRole('button', { name: /Propose holding the place/ }).first().click();
  await page.locator('#pending').getByRole('button', { name: 'Confirm' }).click();
  const k1 = await api(page, 'kpis');
  assert.equal(k1.placesFree, k0.placesFree - 1);
  await page.locator('#places [id^=start-]').first().click();
  const g = await api(page, 'get');
  assert.ok(g.waitingForPlace.length < 4, 'one patient left hospital for a place');
  assert.match(await page.locator('#log li').first().textContent(), /Wait from accepted/);
  assert.deepEqual(errors, []);
  await context.close();
});

test('the guide has an off switch and the round still works without it', async () => {
  const { context, page, errors } = await open(390);
  await page.uncheck('#guide-on');
  assert.equal(await page.locator('.sugg').count(), 0);
  assert.deepEqual(await api(page, 'suggestions'), []);
  await page.click('#r-front');
  const before = await api(page, 'kpis');
  await page.locator('#round .go').first().click();
  await page.locator('#round .go').first().click();
  assert.equal((await api(page, 'kpis')).visitsDoneToday, before.visitsDoneToday + 1);
  assert.equal(await page.locator('#kpis .stat').count(), 4);
  assert.deepEqual(errors, []);
  await context.close();
});

test('agent object is read-only and returns data', async () => {
  const { context, page, errors } = await open(1280);
  assert.match(await api(page, 'describe'), /Read-only/);
  const g = await api(page, 'get');
  assert.equal(g.visitRound.length, 10);
  assert.equal(g.followUps.length, 4);
  assert.ok(g.communityPlaces.length === 3);
  const k = await api(page, 'kpis');
  assert.ok(k.missedFollowUpPct > 0 && k.readinessPct > 0 && k.placementWaitMedianDays > 0);
  assert.ok((await api(page, 'suggestions')).length >= 2);
  assert.ok(await page.evaluate(() => Object.isFrozen(window.ospeliCommunityDemo)));
  assert.deepEqual(errors, []);
  await context.close();
});
