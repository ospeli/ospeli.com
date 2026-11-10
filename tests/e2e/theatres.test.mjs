// Theatres demo (web/demo/theatres/): each role renders with no sideways scroll, the coordinator records
// case times and the measures update, a cancellation needs a reason, the ward nurse's ready checks update
// the counts and clear the guide's flag, guide proposals wait for the coordinator, and the guide can be
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
  await page.goto(env.base + '/demo/theatres/');
  await page.waitForSelector('#kpis .stat');
  return { context, page, errors };
}
const api = (page, fn) => page.evaluate((f) => window.ospeliTheatresDemo[f](), fn);
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

for (const width of [360, 390, 1280]) {
  test(`theatres renders every role at ${width}px with no sideways scroll`, async () => {
    const { context, page, errors } = await open(width);
    await page.click('#r-coord');
    assert.ok(await page.locator('.sugg').count() >= 2, 'guide shows suggestions');
    for (const role of ['coord', 'manager', 'nurse']) {
      await page.click('#r-' + role);
      assert.equal(await page.locator('#r-' + role).getAttribute('aria-pressed'), 'true');
      assert.ok(await page.locator('#kpis .stat').count() >= 2);
      const o = await overflow(page);
      assert.ok(o <= 0, `${role} view scrolls sideways by ${o}px`);
    }
    if (width < 500) {
      await page.click('#r-nurse');
      const h = await page.locator('.tick').first().boundingBox();
      assert.ok(h.height >= 44, 'front-line buttons are at least 44px tall');
      const fs = await page.locator('.tick').first().evaluate((e) => parseFloat(getComputedStyle(e).fontSize));
      assert.ok(fs >= 15, 'front-line text is at least 15px');
    }
    assert.deepEqual(errors, []);
    await context.close();
  });
}

test('the coordinator records case times and the measures update', async () => {
  const { context, page, errors } = await open(390);
  await page.click('#r-coord');
  await page.click('#th-T4');
  const before = await api(page, 'kpis');
  await page.click('#rec-P-5040');
  await page.click('#chk-yes-P-5040');
  const after = await api(page, 'kpis');
  assert.equal(after.casesOut, before.casesOut + 1);
  assert.equal(after.checklistDone, before.checklistDone + 1);
  assert.ok(after.checklistPct > before.checklistPct);
  assert.match(await page.locator('#kpi-check .n').textContent(), new RegExp(`^${after.checklistDone} of ${after.casesOut}`));
  assert.match(await page.locator('#log li').first().textContent(), /checklist recorded complete/);
  const c = (await api(page, 'get')).sessions.find((s) => s.id === 'T4a').cases.find((x) => x.code === 'P-5040');
  assert.equal(c.times.out, '11:20');
  assert.deepEqual(errors, []);
  await context.close();
});

test('a cancellation on the day needs a reason from the fixed list', async () => {
  const { context, page, errors } = await open(1280);
  await page.click('#r-coord');
  await page.click('#th-T1');
  const before = await api(page, 'kpis');
  await page.click('#cx-P-2355');
  assert.equal(await page.locator('#cx-confirm').isDisabled(), true);
  await page.click('#cr-0');
  await page.click('#cx-confirm');
  const after = await api(page, 'kpis');
  assert.equal(after.cancelledOnDay, before.cancelledOnDay + 1);
  const s = await api(page, 'suggestions');
  assert.ok(s.some((x) => x.id.startsWith('cx-No bed')), 'repeated reason is flagged for review');
  assert.deepEqual(errors, []);
  await context.close();
});

test('the ward nurse ticks ready checks and the count and guide update', async () => {
  const { context, page, errors } = await open(360);
  await page.click('#r-nurse');
  const before = await api(page, 'kpis');
  assert.ok((await api(page, 'suggestions')).some((x) => x.id.startsWith('notready-P-3150')));
  await page.click('#rd-P-3150-transport');
  assert.equal(await page.locator('#rd-P-3150-transport').getAttribute('aria-pressed'), 'true');
  const after = await api(page, 'kpis');
  assert.equal(after.wardReady, before.wardReady + 1);
  assert.match(await page.locator('#kpi-ready b').textContent(), new RegExp(`^${after.wardReady} of`));
  assert.ok(!(await api(page, 'suggestions')).some((x) => x.id.startsWith('notready-P-3150')));
  assert.deepEqual(errors, []);
  await context.close();
});

test('a guide proposal changes nothing until the coordinator confirms', async () => {
  const { context, page, errors } = await open(1280);
  await page.click('#r-coord');
  const beds = async () => (await api(page, 'get')).tomorrow.filter((r) => r.items.bed === 'gap').length;
  const b0 = await beds();
  assert.ok(b0 > 0);
  await page.getByRole('button', { name: /Propose: ask the patient flow team/ }).click();
  assert.equal(await beds(), b0, 'proposing changes nothing');
  assert.equal((await api(page, 'get')).pendingDecisions.length, 1);
  await page.locator('#pending').getByRole('button', { name: 'Confirm' }).click();
  assert.equal(await beds(), 0);
  assert.equal((await api(page, 'get')).tomorrow.filter((r) => r.items.bed === 'asked').length, b0);
  assert.deepEqual(errors, []);
  await context.close();
});

test('the guide has an off switch and the lists still work without it', async () => {
  const { context, page, errors } = await open(390);
  await page.uncheck('#guide-on');
  assert.equal(await page.locator('.sugg').count(), 0);
  assert.deepEqual(await api(page, 'suggestions'), []);
  await page.click('#r-coord');
  await page.click('#th-T2');
  await page.click('#rec-P-3150');
  const c = (await api(page, 'get')).sessions.find((s) => s.id === 'T2').cases.find((x) => x.code === 'P-3150');
  assert.equal(c.stage, 'Sent for');
  assert.deepEqual(errors, []);
  await context.close();
});

test('agent object is read-only and returns data', async () => {
  const { context, page, errors } = await open(1280);
  assert.match(await api(page, 'describe'), /Read-only/);
  const g = await api(page, 'get');
  assert.equal(g.sessions.length, 6);
  assert.equal(g.tomorrow.length, 10);
  const k = await api(page, 'kpis');
  assert.ok(k.utilisationPct > 0 && k.turnaroundMedianMin > 0 && k.casesListed > 0);
  assert.ok((await api(page, 'suggestions')).length >= 2);
  assert.ok(await page.evaluate(() => Object.isFrozen(window.ospeliTheatresDemo)));
  assert.deepEqual(errors, []);
  await context.close();
});

test('the ward nurse sees no guide buttons for decisions that belong to the coordinator', async () => {
  const { context, page, errors } = await open(390);
  await page.click('#r-nurse');
  assert.equal(await page.locator('#guide .sugg').count(), 0);
  assert.match(await page.locator('#nurse-guide').textContent(), /The theatre coordinator has \d+ proposals?/);
  assert.deepEqual(errors, []);
  await context.close();
});
