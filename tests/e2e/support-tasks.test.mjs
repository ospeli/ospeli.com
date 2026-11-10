// Support tasks demo (web/demo/support-tasks/): each role renders with no sideways scroll, a porter
// can take a job from Accept to Done and the measures update, a ward can ask for a bed clean in three
// taps, guide proposals wait for the supervisor, and the guide can be switched off. Fictional data only.
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
  await page.goto(env.base + '/demo/support-tasks/');
  await page.waitForSelector('#kpis .stat');
  return { context, page, errors };
}
const api = (page, fn) => page.evaluate((f) => window.ospeliSupportTasksDemo[f](), fn);
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

for (const width of [360, 390, 1280]) {
  test(`support tasks renders every role at ${width}px with no sideways scroll`, async () => {
    const { context, page, errors } = await open(width);
    assert.equal(await page.locator('#kpis .stat').count(), 4);
    assert.ok(await page.locator('.sugg').count() >= 2, 'guide shows suggestions');
    for (const role of ['porter', 'cleaner', 'supervisor', 'ward']) {
      await page.click('#r-' + role);
      assert.equal(await page.locator('#r-' + role).getAttribute('aria-pressed'), 'true');
      const o = await overflow(page);
      assert.ok(o <= 0, `${role} view scrolls sideways by ${o}px`);
    }
    if (width < 500) {
      await page.click('#r-porter');
      const h = await page.locator('#incoming .go').first().boundingBox();
      assert.ok(h.height >= 44, 'front-line buttons are at least 44px tall');
    }
    assert.deepEqual(errors, []);
    await context.close();
  });
}

test('a porter takes a job from Accept to Done and the measures update', async () => {
  const { context, page, errors } = await open(390);
  await page.click('#r-porter');
  const before = await api(page, 'kpis');
  const btn = page.locator('#incoming .go').first();
  const id = await btn.getAttribute('id');
  await btn.click();
  assert.equal(await page.locator('#' + id).textContent(), 'Collected');
  await page.click('#' + id);
  assert.equal(await page.locator('#' + id).textContent(), 'Delivered');
  await page.click('#' + id);
  const after = await api(page, 'kpis');
  assert.equal(after.doneCount, before.doneCount + 1);
  assert.equal(after.startedCount, before.startedCount + 1);
  assert.equal(after.open, before.open - 1);
  assert.ok(after.pastTarget < before.pastTarget, 'the late job no longer counts as past target');
  assert.match(await page.locator('#kpi-late b').textContent(), new RegExp('^' + after.pastTarget + '$'));
  assert.match(await page.locator('#log li').first().textContent(), /finished/);
  assert.deepEqual(errors, []);
  await context.close();
});

test('a ward asks for a bed clean in three taps and the cleaning team sees it', async () => {
  const { context, page, errors } = await open(360);
  await page.click('#r-ward');
  const n = (await api(page, 'get')).openJobs.length;
  await page.click('#q-bedclean');
  await page.click('#w-2');
  await page.click('#q-send');
  const got = await api(page, 'get');
  assert.equal(got.openJobs.length, n + 1);
  const job = got.openJobs.find((j) => j.type === 'bedclean' && j.area === 'Ward 4' && j.detail === 'Bed 3');
  assert.ok(job, 'the new clean is open');
  assert.equal(job.team, 'Cleaning · Main block');
  assert.match(await page.locator('#ward-requests .rq').first().textContent(), /Bed clean · Bed 3/);
  await page.click('#r-cleaner');
  await page.selectOption('#team-pick', 'c-main');
  assert.ok(await page.locator('#incoming').getByText('Ward 4 · Bed 3').count() >= 1);
  assert.deepEqual(errors, []);
  await context.close();
});

test('a guide proposal changes nothing until the supervisor confirms', async () => {
  const { context, page, errors } = await open(1280);
  await page.click('#r-supervisor');
  const staff = () => api(page, 'get').then((g) => Object.fromEntries(g.teams.map((t) => [t.id, t.staff])));
  const s0 = await staff();
  await page.getByRole('button', { name: /Propose: move 1 porter/ }).click();
  assert.deepEqual(await staff(), s0, 'proposing changes nothing');
  assert.equal((await api(page, 'get')).pendingDecisions.length, 1);
  await page.locator('#pending').getByRole('button', { name: 'Confirm' }).click();
  const s1 = await staff();
  assert.equal(s1['p-main'], s0['p-main'] - 1);
  assert.equal(s1['p-east'], s0['p-east'] + 1);
  assert.deepEqual(errors, []);
  await context.close();
});

test('the guide has an off switch and the task list still works without it', async () => {
  const { context, page, errors } = await open(390);
  await page.uncheck('#guide-on');
  assert.equal(await page.locator('.sugg').count(), 0);
  assert.deepEqual(await api(page, 'suggestions'), []);
  await page.click('#r-porter');
  const before = await api(page, 'kpis');
  await page.locator('#incoming .go').first().click();
  assert.equal((await api(page, 'kpis')).open, before.open);
  assert.ok(await page.locator('.job.mine').count() >= 1, 'accepted job moves to Your jobs');
  assert.equal(await page.locator('#kpis .stat').count(), 4);
  assert.deepEqual(errors, []);
  await context.close();
});

test('agent object is read-only and returns data', async () => {
  const { context, page, errors } = await open(1280);
  const d = await api(page, 'describe');
  assert.match(d, /Read-only/);
  const g = await api(page, 'get');
  assert.equal(g.teams.length, 4);
  assert.ok(g.openJobs.length >= 10);
  const k = await api(page, 'kpis');
  assert.ok(k.requestToStartMin > 0 && k.requestToDoneMin > 0 && k.bedTurnaroundMin > 0);
  assert.ok((await api(page, 'suggestions')).length >= 2);
  assert.ok(await page.evaluate(() => Object.isFrozen(window.ospeliSupportTasksDemo)));
  assert.deepEqual(errors, []);
  await context.close();
});
