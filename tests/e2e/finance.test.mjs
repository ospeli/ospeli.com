// Finance and budgets demo (web/demo/finance/): renders on phone and laptop, a budget holder's note
// changes the measures, the guide only drafts or proposes, and it can be switched off. Fictional data only.
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
  await page.goto(env.base + '/demo/finance/');
  await page.waitForSelector('#kpis .stat');
  return { context, page, errors };
}
const api = (page, fn) => page.evaluate((f) => window.ospeliFinanceDemo[f](), fn);

for (const width of [360, 390, 1280]) {
  test(`finance demo renders at ${width}px with no sideways scroll in every view`, async () => {
    const { context, page, errors } = await open(width);
    for (const role of ['holder', 'partner', 'lead']) {
      await page.click('#r-' + role);
      assert.equal(await page.getAttribute('#r-' + role, 'aria-pressed'), 'true');
      assert.equal(await page.locator('#kpis .stat').count(), 4);
      assert.ok(await page.locator('.sugg').count() >= 1, `guide shows suggestions in ${role} view`);
      const o = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      assert.ok(o <= 0, `${role} view scrolls sideways by ${o}px`);
    }
    assert.deepEqual(errors, []);
    await context.close();
  });
}

test('a budget holder drafts, edits and sends a variance note, and the measures update', async () => {
  const { context, page, errors } = await open(390);
  await page.click('#r-holder');
  await page.selectOption('#cc-pick', 'W4');
  const before = await api(page, 'kpis');
  assert.equal(before.myNotesWaiting, 1);
  assert.equal(await page.locator('#kpi-notes b').textContent(), '1');
  await page.click('#n-draft');
  const draft = await page.inputValue('#n-text');
  assert.match(draft, /Ward 4 is .* over budget/);
  assert.equal(await page.locator('#n-send').count(), 1, 'the person still has to send it');
  assert.equal((await api(page, 'kpis')).notesReceived, before.notesReceived, 'drafting changes nothing on its own');
  await page.fill('#n-text', draft.replace('[add what you will do, and by when].', 'review the roster gaps with the workforce lead this week.'));
  await page.click('#n-send');
  const after = await api(page, 'kpis');
  assert.equal(after.myNotesWaiting, 0);
  assert.equal(after.notesReceived, before.notesReceived + 1);
  assert.equal(await page.locator('#kpi-notes b').textContent(), '0');
  assert.match(await page.locator('#log li').first().textContent(), /Ward 4 manager sent a variance note/);
  // The finance partner agrees it: explained on time goes up.
  await page.click('#r-partner');
  await page.click('#ag-W4');
  assert.equal((await api(page, 'kpis')).explainedOnTime, before.explainedOnTime + 1);
  assert.deepEqual(errors, []);
  await context.close();
});

test('guide proposals wait for the finance partner to confirm', async () => {
  const { context, page, errors } = await open(1280);
  await page.click('#r-partner');
  await page.locator('.sugg button.primary').first().click();
  assert.equal(await page.locator('#pending .prop').count(), 1);
  assert.equal((await api(page, 'get')).pendingDecisions.length, 1);
  await page.locator('#pending button.primary').click();
  assert.equal((await api(page, 'get')).pendingDecisions.length, 0);
  assert.match(await page.locator('#log li').first().textContent(), /Finance partner/);
  assert.deepEqual(errors, []);
  await context.close();
});

test('the guide has an off switch and the views still work without it', async () => {
  const { context, page, errors } = await open(390);
  await page.click('#r-holder');
  await page.uncheck('#guide-on');
  assert.equal(await page.locator('.sugg').count(), 0);
  assert.equal(await page.locator('#n-draft').count(), 0, 'no drafting with the guide off');
  assert.equal(await page.locator('#n-send').count(), 1, 'the note can still be written by hand');
  assert.deepEqual(await api(page, 'suggestions'), []);
  assert.equal(await page.locator('#kpis .stat').count(), 4);
  assert.deepEqual(errors, []);
  await context.close();
});

test('the agent object returns data and the tolerance changes the board', async () => {
  const { context, page, errors } = await open(1280);
  const g = await api(page, 'get');
  assert.equal(g.costCentres.length, 10);
  assert.ok(typeof (await api(page, 'describe')) === 'string');
  const k = await api(page, 'kpis');
  assert.ok(k.beyondTolerance > 0 && k.costPerOccupiedBedDay > 0);
  assert.ok((await api(page, 'suggestions')).length >= 1);
  await page.click('#r-partner');
  await page.fill('#tol', '5');
  await page.dispatchEvent('#tol', 'change');
  assert.ok((await api(page, 'kpis')).beyondTolerance < k.beyondTolerance);
  assert.deepEqual(errors, []);
  await context.close();
});
