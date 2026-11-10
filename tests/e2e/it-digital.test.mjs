// IT, digital and cyber demo (web/demo/it-digital/): each role renders with no sideways scroll, any
// staff member can report a problem and the measures update, a third "slow system" report makes the
// guide propose downtime that only the service desk or lead can confirm, leaver accounts go to IT as
// a ticket (Ospeli never disables them), the downtime switch works, and the guide can be switched off.
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
  await page.goto(env.base + '/demo/it-digital/');
  await page.waitForSelector('#kpis .stat');
  return { context, page, errors };
}
const api = (page, fn) => page.evaluate((f) => window.ospeliItDigitalDemo[f](), fn);
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

for (const width of [360, 390, 1280]) {
  test(`IT demo renders every role at ${width}px with no sideways scroll`, async () => {
    const { context, page, errors } = await open(width);
    assert.equal(await page.locator('#kpis .stat').count(), 4);
    assert.ok(await page.locator('.sugg').count() >= 2, 'guide shows suggestions');
    for (const role of ['staff', 'desk', 'lead']) {
      await page.click('#r-' + role);
      assert.equal(await page.locator('#r-' + role).getAttribute('aria-pressed'), 'true');
      const o = await overflow(page);
      assert.ok(o <= 0, `${role} view scrolls sideways by ${o}px`);
    }
    await page.click('#r-staff');
    assert.ok(await page.locator('#status-banner').isVisible(), 'status banner shows');
    assert.deepEqual(errors, []);
    await context.close();
  });
}

test('a staff report raises the open ticket count and shows in "Your reports"', async () => {
  const { context, page, errors } = await open(390);
  await page.click('#r-staff');
  const before = (await api(page, 'kpis')).openTickets;
  await page.click('#c-printer');
  await page.selectOption('#rep-area', 'W3');
  await page.click('#h-0');
  await page.click('#rep-send');
  assert.equal((await api(page, 'kpis')).openTickets, before + 1);
  assert.equal(await page.locator('#kpi-open b').textContent(), String(before + 1));
  assert.match(await page.locator('#my-reports .rq').first().textContent(), /Ward 3/);
  assert.match(await page.locator('#log').textContent(), /Printer, Ward 3/);
  assert.deepEqual(errors, []);
  await context.close();
});

test('a third slow report leads to a downtime proposal that the service desk confirms', async () => {
  const { context, page, errors } = await open(1280);
  await page.click('#r-staff');
  assert.ok(!(await api(page, 'suggestions')).some((s) => s.id.startsWith('down-')), 'no downtime suggestion yet');
  await page.click('#c-slow');
  await page.selectOption('#rep-area', 'W4');
  await page.click('#sys-ehr');
  await page.click('#h-0');
  await page.click('#rep-send');
  const sg = page.locator('.sugg[data-id^="down-"]');
  assert.equal(await sg.count(), 1, 'downtime suggestion appears');
  await sg.locator('button.primary').click();
  let ehr = (await api(page, 'get')).systems.find((s) => s.id === 'ehr');
  assert.equal(ehr.status, 'up', 'a proposal changes nothing on its own');
  assert.equal(await page.locator('#pending button', { hasText: 'Confirm' }).count(), 0, 'staff cannot confirm');
  await page.click('#r-desk');
  await page.locator('#pending button', { hasText: 'Confirm' }).click();
  ehr = (await api(page, 'get')).systems.find((s) => s.id === 'ehr');
  assert.equal(ehr.status, 'down');
  assert.equal(ehr.downtimeOpen, true);
  assert.equal(await page.locator('#dt-ehr').getAttribute('aria-pressed'), 'true');
  // End it with the switch.
  await page.click('#dt-ehr');
  ehr = (await api(page, 'get')).systems.find((s) => s.id === 'ehr');
  assert.equal(ehr.status, 'up');
  assert.match(await page.locator('#log').textContent(), /catch-up/);
  assert.deepEqual(errors, []);
  await context.close();
});

test('leaver accounts go to IT as a ticket; resolving it updates the counts', async () => {
  const { context, page, errors } = await open(1280);
  await page.click('#r-lead');
  const k0 = await api(page, 'kpis');
  assert.ok(k0.leaverAccountsActivePastPeriod > 0);
  await page.locator('.sugg[data-id^="leavers-"] button.primary').click();
  await page.locator('#pending button', { hasText: 'Confirm' }).click();
  assert.equal((await api(page, 'get')).access.leaversActivePastPeriod, k0.leaverAccountsActivePastPeriod, 'Ospeli does not disable accounts');
  const ticket = (await api(page, 'get')).openTickets.find((t) => t.category === 'Access');
  assert.ok(ticket, 'an access ticket was raised for IT');
  await page.click('#r-desk');
  await page.click('#res-' + ticket.id);
  await page.click('#ok-' + ticket.id);
  assert.equal((await api(page, 'kpis')).leaverAccountsActivePastPeriod, 0);
  assert.deepEqual(errors, []);
  await context.close();
});

test('linking network reports to one fault, then fixing it, resolves the linked tickets', async () => {
  const { context, page, errors } = await open(1280);
  await page.click('#r-desk');
  const before = (await api(page, 'kpis')).openTickets;
  await page.locator('.sugg[data-id^="link-"] button.primary').click();
  await page.locator('#pending button', { hasText: 'Confirm' }).click();
  const f = (await api(page, 'get')).faults[0];
  assert.equal(f.tickets.length, 3);
  await page.click('#fix-' + f.id);
  assert.equal((await api(page, 'kpis')).openTickets, before - 3);
  assert.equal((await api(page, 'get')).systems.find((s) => s.id === 'wifiE').status, 'up');
  assert.deepEqual(errors, []);
  await context.close();
});

test('the guide has an off switch and the demo still works without it', async () => {
  const { context, page, errors } = await open(390);
  await page.uncheck('#guide-on');
  assert.equal(await page.locator('.sugg').count(), 0);
  assert.equal(await page.locator('#kpis .stat').count(), 4);
  assert.deepEqual(await api(page, 'suggestions'), []);
  await page.click('#kpi-avail');
  assert.equal(await page.locator('#kpi-avail').getAttribute('aria-expanded'), 'true');
  assert.deepEqual(errors, []);
  await context.close();
});

test('the read-only agent object returns data', async () => {
  const { context, page, errors } = await open(1280);
  assert.match(await api(page, 'describe'), /Read-only/);
  const g = await api(page, 'get');
  assert.equal(g.systems.length, 10);
  assert.ok(g.openTickets.length > 5);
  const k = await api(page, 'kpis');
  assert.ok(k.availabilityPct > 99 && k.availabilityPct < 100);
  assert.ok((await api(page, 'suggestions')).length >= 3);
  const frozen = await page.evaluate(() => Object.isFrozen(window.ospeliItDigitalDemo));
  assert.equal(frozen, true);
  assert.deepEqual(errors, []);
  await context.close();
});
