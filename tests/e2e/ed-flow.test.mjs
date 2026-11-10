// Emergency department flow demo (web/demo/ed-flow/): renders on phone and laptop, a nurse-in-charge
// tap records a step and the KPIs update, guide proposals need a person to confirm, the guide can be
// switched off, and the read-only agent object returns data. Fictional data only.
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
  await page.goto(env.base + '/demo/ed-flow/');
  await page.waitForSelector('#stats .stat');
  return { context, page, errors };
}
const api = (page, fn) => page.evaluate((f) => window.ospeliEdFlowDemo[f](), fn);

for (const width of [360, 390, 1280]) {
  test(`ED flow renders at ${width}px with no sideways scroll, in every role`, async () => {
    const { context, page, errors } = await open(width);
    for (const role of ['nurse', 'flow', 'ops']) {
      await page.click(`.roles button[data-role=${role}]`);
      assert.equal(await page.locator(`.roles button[data-role=${role}]`).getAttribute('aria-pressed'), 'true');
      assert.equal(await page.locator('#stats .stat').count(), 4);
      const o = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      assert.ok(o <= 0, `${role} view scrolls sideways by ${o}px`);
    }
    assert.ok(await page.locator('.sugg').count() >= 2, 'guide shows suggestions');
    assert.deepEqual(errors, []);
    await context.close();
  });
}

test('the nurse in charge records a step and the KPIs update', async () => {
  const { context, page, errors } = await open(390);
  const before = await api(page, 'kpis');
  // Record "left department" for the first patient who is ready to leave.
  await page.locator('.pt button', { hasText: 'Record left department' }).first().click();
  const after1 = await api(page, 'kpis');
  assert.equal(after1.inDepartment.value, before.inDepartment.value - 1, 'one fewer in the department');
  assert.equal(await page.locator('#stats .stat[data-kpi=inDepartment] b').textContent(), String(after1.inDepartment.value));
  assert.ok((await page.locator('#log li').count()) >= 2, 'the action is logged with a time');
  // A decision to admit adds a patient waiting for a bed.
  await page.locator('.pt button', { hasText: /^Admit$/ }).first().click();
  const after2 = await api(page, 'kpis');
  assert.equal(after2.waitingForBed.value, after1.waitingForBed.value + 1);
  // Undo restores the previous state.
  await page.click('#undo');
  assert.equal((await api(page, 'kpis')).waitingForBed.value, after1.waitingForBed.value);
  assert.deepEqual(errors, []);
  await context.close();
});

test('guide proposals change nothing until a person confirms', async () => {
  const { context, page, errors } = await open(1280);
  await page.click('.roles button[data-role=ops]');
  const s0 = await api(page, 'get');
  assert.equal(s0.openLevel, 2);
  assert.equal(s0.thresholdLevel, 3, 'the example starts above the open level');
  const card = page.locator('.sugg', { hasText: 'Thresholds point to level 3' });
  await card.locator('button.primary').click();
  assert.equal((await api(page, 'get')).openLevel, 2, 'proposing alone changes nothing');
  await card.locator('[data-confirm]').click();
  assert.equal((await api(page, 'get')).openLevel, 3, 'confirmed by a person');
  assert.equal(await page.locator('.lv').textContent(), '3');
  // Escalation of bed requests over the site limit.
  const esc = page.locator('.sugg[data-id=escalate]');
  await esc.locator('button.primary').click();
  await esc.locator('[data-confirm]').click();
  const pts = (await api(page, 'get')).patients.filter((p) => p.escalated != null);
  assert.ok(pts.length >= 1, 'bed requests escalated');
  assert.ok(pts.every((p) => /^Patient \d{4}$/.test(p.code)), 'patients only as anonymous codes');
  assert.deepEqual(errors, []);
  await context.close();
});

test('the guide has an off switch and the board still works without it', async () => {
  const { context, page, errors } = await open(360);
  await page.uncheck('#guide-on');
  assert.equal(await page.locator('.sugg').count(), 0);
  assert.deepEqual(await api(page, 'suggestions'), []);
  await page.click('.roles button[data-role=flow]');
  assert.ok(await page.locator('.bwrow').count() >= 1, 'bed list still shown');
  assert.deepEqual(errors, []);
  await context.close();
});

test('the read-only agent object returns data', async () => {
  const { context, page, errors } = await open(1280);
  assert.match(await api(page, 'describe'), /Read-only/);
  const g = await api(page, 'get');
  assert.ok(g.patients.length > 20);
  const k = await api(page, 'kpis');
  assert.ok(k.medianArrivalToDecisionMin.value > 0);
  assert.ok(k.slowestStep && k.slowestStep.name);
  const s = await api(page, 'suggestions');
  assert.ok(s.length >= 2 && s.every((x) => x.why));
  assert.equal(await page.evaluate(() => Object.isFrozen(window.ospeliEdFlowDemo)), true);
  assert.deepEqual(errors, []);
  await context.close();
});
