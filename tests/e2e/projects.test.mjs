// Planning and capital projects demo (web/demo/projects/): every role renders with no sideways scroll,
// a project lead marking a milestone done changes the programme measures, the executive can record a
// decision, guide suggestions only propose until a person confirms, the guide can be switched off, and
// the read-only agent object returns data. Fictional data only.
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
  await page.goto(env.base + '/demo/projects/');
  await page.waitForSelector('#kpis .stat');
  return { context, page, errors };
}
const api = (page, fn, arg) => page.evaluate(([f, a]) => window.ospeliProjectsDemo[f](a), [fn, arg]);
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

for (const width of [360, 390, 1280]) {
  test(`projects demo renders every role at ${width}px with no sideways scroll`, async () => {
    const { context, page, errors } = await open(width);
    assert.ok(await page.locator('.sugg').count() >= 2, 'guide shows suggestions');
    for (const role of ['lead', 'case', 'office', 'exec']) {
      await page.click('#r-' + role);
      assert.equal(await page.locator('#r-' + role).getAttribute('aria-pressed'), 'true');
      assert.equal(await page.locator('#kpis .stat').count(), 4);
      const o = await overflow(page);
      assert.ok(o <= 0, `${role} view scrolls sideways by ${o}px`);
    }
    if (width < 500) {
      await page.click('#r-lead');
      const h = await page.locator('#duenow button').first().boundingBox();
      assert.ok(h.height >= 44, 'front-line buttons are at least 44px tall');
    }
    assert.deepEqual(errors, []);
    await context.close();
  });
}

test('a project lead marks a milestone done and programme delivery goes up', async () => {
  const { context, page, errors } = await open(390);
  await page.click('#r-lead');
  const before = await api(page, 'kpis');
  await page.click('#done-p2m2');
  const after = await api(page, 'kpis');
  assert.equal(after.delivery.achieved, before.delivery.achieved + 1);
  assert.ok(after.delivery.rate > before.delivery.rate);
  assert.match(await page.locator('#k-delivery b').textContent(), /%/);
  assert.match(await page.locator('#log li').first().textContent(), /done/);
  // spend and weekly update
  await page.fill('#sp-amt', '20');
  await page.click('#sp-save');
  const p2 = (await api(page, 'get')).projects.find((p) => p.id === 'p2');
  assert.equal(p2.spend, 1330);
  await page.fill('#u-done', 'Phase 1 handed over.');
  await page.click('#u-send');
  assert.equal((await api(page, 'get')).projects.find((p) => p.id === 'p2').lastUpdate, 0);
  assert.deepEqual(errors, []);
  await context.close();
});

test('status is explained by rules, and the executive records a decision', async () => {
  const { context, page, errors } = await open(1280);
  const risky = await api(page, 'listAtRisk');
  const ed = risky.find((p) => p.id === 'p2');
  assert.equal(ed.status, 'Red');
  assert.ok(ed.reasons.some((r) => /moved 2 times/.test(r)));
  await page.click('#r-exec');
  const before = await api(page, 'kpis');
  await page.click('#approve-p6');
  const after = await api(page, 'kpis');
  assert.equal(after.decision.decided, before.decision.decided + 1);
  assert.equal(after.decision.waiting, before.decision.waiting - 1);
  assert.equal((await api(page, 'get')).projects.find((p) => p.id === 'p6').stage, 'approved');
  assert.deepEqual(errors, []);
  await context.close();
});

test('a guide suggestion only proposes; a person confirms', async () => {
  const { context, page, errors } = await open(1280);
  await page.click('#r-exec');
  const before = await api(page, 'benefitsReview', 'p3');
  assert.equal(before.benefits[1].status, 'unmeasured');
  const k0 = await api(page, 'kpis');
  await page.locator('.sugg', { hasText: 'Draft a benefits review' }).locator('button.primary').click();
  assert.equal((await api(page, 'benefitsReview', 'p3')).benefits[1].status, 'unmeasured', 'nothing changes before confirm');
  await page.click('#p-confirm');
  const after = await api(page, 'benefitsReview', 'p3');
  assert.equal(after.benefits[1].status, 'achieved');
  assert.equal((await api(page, 'kpis')).benefits.realised, k0.benefits.realised + 1);
  assert.deepEqual(errors, []);
  await context.close();
});

test('business case builder attaches a measured baseline and submits for decision', async () => {
  const { context, page, errors } = await open(390);
  await page.click('#r-case');
  await page.waitForFunction(() => /typed by hand/.test(document.querySelector('#summary')?.textContent || ''), null, { timeout: 5000 });
  assert.match(await page.locator('#summary').textContent(), /typed by hand/);
  await page.locator('.sugg', { hasText: 'Attach data' }).locator('button.primary').click();
  await page.click('#p-confirm');
  await page.waitForFunction(() => !/typed by hand/.test(document.querySelector('#summary')?.textContent || ''), null, { timeout: 5000 });
  const draft = (await api(page, 'get')).draftCase;
  assert.equal(draft.benefits[0].kpi, 'bedclean');
  assert.doesNotMatch(await page.locator('#summary').textContent(), /typed by hand/);
  const w0 = (await api(page, 'kpis')).decision.waiting;
  await page.click('#c-submit');
  assert.equal((await api(page, 'kpis')).decision.waiting, w0 + 1);
  assert.deepEqual(errors, []);
  await context.close();
});

test('the guide has an off switch and the views still work without it', async () => {
  const { context, page, errors } = await open(390);
  await page.uncheck('#guide-on');
  assert.equal(await page.locator('.sugg').count(), 0);
  assert.deepEqual(await api(page, 'suggestions'), []);
  await page.click('#r-office');
  assert.ok(await page.locator('.prow').count() >= 5);
  assert.equal(await page.locator('#kpis .stat').count(), 4);
  assert.deepEqual(errors, []);
  await context.close();
});

test('the agent object is read-only and returns data', async () => {
  const { context, page, errors } = await open(1280);
  assert.match(await api(page, 'describe'), /Read-only/);
  const g = await api(page, 'get');
  assert.ok(g.projects.length >= 8);
  assert.equal(g.demoClock, '10:30');
  const k = await api(page, 'kpis');
  assert.ok(k.delivery.due > 0 && k.benefits.promised > 0);
  assert.ok((await api(page, 'suggestions')).length >= 2);
  assert.ok(await page.evaluate(() => Object.isFrozen(window.ospeliProjectsDemo)));
  assert.deepEqual(errors, []);
  await context.close();
});
