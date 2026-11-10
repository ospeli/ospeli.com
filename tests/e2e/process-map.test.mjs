// Process mapping demo (web/demo/process-map/): map renders, the guide's what-ifs only change the
// proposed version, the guide can be switched off, and steps can be added. Fictional data only.
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
  await page.goto(env.base + '/demo/process-map/');
  await page.waitForSelector('#stats .stat');
  return { context, page, errors };
}
const api = (page, fn) => page.evaluate((f) => window.ospeliProcessMap[f](), fn);

for (const width of [360, 390, 1280]) {
  test(`process map renders at ${width}px with no sideways scroll`, async () => {
    const { context, page, errors } = await open(width);
    assert.equal(await page.locator('#stats .stat').count(), 4);
    assert.ok(await page.locator('.sugg').count() >= 3, 'guide shows suggestions');
    const o = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(o <= 0, `scrolls sideways by ${o}px`);
    assert.deepEqual(errors, []);
    await context.close();
  });
}

test('trying a suggestion changes only the proposed version, and undo restores it', async () => {
  const { context, page, errors } = await open(1280);
  const today = await api(page, 'analyse');
  assert.ok(today.biggestWait, 'the example has a biggest wait');
  await page.locator('.sugg button.primary').first().click();
  assert.equal(await page.locator('#v-next').getAttribute('aria-pressed'), 'true');
  const proposed = await api(page, 'analyse');
  assert.ok(proposed.elapsedMin < today.elapsedMin, 'proposed is shorter than today');
  await page.click('#v-now');
  assert.equal((await api(page, 'analyse')).elapsedMin, today.elapsedMin, 'today is unchanged');
  await page.getByRole('button', { name: 'Undo all' }).click();
  await page.click('#v-next');
  assert.equal((await api(page, 'analyse')).elapsedMin, today.elapsedMin, 'undo resets the proposal');
  assert.deepEqual(errors, []);
  await context.close();
});

test('the guide has an off switch and the map still works without it', async () => {
  const { context, page, errors } = await open(390);
  await page.uncheck('#guide-on');
  assert.equal(await page.locator('.sugg').count(), 0);
  assert.equal(await page.locator('#stats .stat').count(), 4);
  assert.deepEqual(errors, []);
  await context.close();
});

test('a person can add a step on a blank map', async () => {
  const { context, page, errors } = await open(390);
  await page.selectOption('#pick', 'blank');
  await page.locator('details.edit summary').click();
  await page.fill('#f-name', 'Request received');
  await page.fill('#f-role', 'Clerk');
  await page.fill('#f-work', '4');
  await page.click('#f-save');
  const map = await api(page, 'get');
  assert.equal(map.steps.length, 1);
  assert.equal(map.steps[0].role, 'Clerk');
  assert.equal((await api(page, 'analyse')).workMin, 4);
  assert.deepEqual(errors, []);
  await context.close();
});
