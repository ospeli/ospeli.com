// Governance demo (web/demo/governance/): each role renders with no sideways scroll, staff can find a
// current policy and tick "I have read this" (the measures update), an owner's revision goes for approval
// and the committee approves it (policies in date rises), guide proposals wait for the governance lead,
// and the guide can be switched off. Fictional data only.
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
  await page.goto(env.base + '/demo/governance/');
  await page.waitForSelector('#kpis .stat');
  return { context, page, errors };
}
const api = (page, fn) => page.evaluate((f) => window.ospeliGovernanceDemo[f](), fn);
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

for (const width of [360, 390, 1280]) {
  test(`governance renders every role and lead section at ${width}px with no sideways scroll`, async () => {
    const { context, page, errors } = await open(width);
    assert.equal(await page.locator('#kpis .stat').count(), 4);
    assert.ok(await page.locator('.sugg').count() >= 2, 'guide shows suggestions');
    for (const role of ['staff', 'owner', 'lead']) {
      await page.click('#r-' + role);
      assert.equal(await page.locator('#r-' + role).getAttribute('aria-pressed'), 'true');
      const o = await overflow(page);
      assert.ok(o <= 0, `${role} view scrolls sideways by ${o}px`);
    }
    for (const tab of ['review', 'coverage', 'grid', 'meeting']) {
      await page.click('#tab-' + tab);
      const o = await overflow(page);
      assert.ok(o <= 0, `lead ${tab} scrolls sideways by ${o}px`);
    }
    if (width < 500) {
      await page.click('#r-staff');
      const h = await page.locator('#toread .go.ack').first().boundingBox();
      assert.ok(h.height >= 44, 'front-line buttons are at least 44px tall');
    }
    assert.deepEqual(errors, []);
    await context.close();
  });
}

test('staff search shows only current documents, and ticking "I have read this" updates the measures', async () => {
  const { context, page, errors } = await open(390);
  await page.click('#r-staff');
  await page.fill('#q', 'how do I clean up a spill');
  assert.equal(await page.locator('#results .doc').count(), 2, 'both spill documents are found');
  const before = await api(page, 'kpis');
  const toRead = (await api(page, 'get')).toReadForPersona.length;
  assert.ok(toRead >= 1, 'the persona has something to read');
  await page.locator('#toread .go.ack').first().click();
  const after = await api(page, 'kpis');
  assert.equal(after.readAcks, before.readAcks + 1);
  assert.equal((await api(page, 'get')).toReadForPersona.length, toRead - 1);
  assert.match(await page.locator('#kpi-read .n').textContent(), new RegExp(after.readAcks.toLocaleString('en')));
  assert.deepEqual(errors, []);
  await context.close();
});

test('an owner drafts a revision, sends it, the committee approves it and policies in date rises', async () => {
  const { context, page, errors } = await open(1280);
  await page.click('#r-owner');
  await page.selectOption('#owner-pick', 'Head of facilities');
  await page.click('#rev-D03');
  await page.fill('#note-D03', 'Bin colours updated; collection times changed.');
  await page.click('#save-D03');
  await page.click('#send-D03');
  const before = await api(page, 'kpis');
  assert.ok(before.awaitingApproval >= 1);
  await page.click('#r-lead');
  await page.click('#tab-meeting');
  await page.selectOption('#meet-pick', 'hs');
  await page.click('#appr-D03');
  const after = await api(page, 'kpis');
  assert.equal(after.inDate, before.inDate + 1);
  assert.equal(after.awaitingApproval, before.awaitingApproval - 1);
  const d = (await api(page, 'get')).documents.find((x) => x.id === 'D03');
  assert.equal(d.version, 3);
  assert.equal(d.reviewState, 'ok');
  assert.equal(d.readPc, 0, 'a new version starts unread');
  assert.deepEqual(errors, []);
  await context.close();
});

test('a guide proposal waits for the governance lead, and confirming adds actions', async () => {
  const { context, page, errors } = await open(1280);
  await page.click('#r-lead');
  const before = await api(page, 'kpis');
  await page.locator('.sugg[data-id^="gaps-"] button.primary').click();
  assert.equal((await api(page, 'kpis')).openActions, before.openActions, 'a proposal changes nothing');
  await page.locator('#pending button.primary').first().click();
  const after = await api(page, 'kpis');
  assert.equal(after.openActions, before.openActions + before.standardsNoEvidence);
  assert.deepEqual(errors, []);
  await context.close();
});

test('the lead links evidence to a standard and closes a past-due action', async () => {
  const { context, page, errors } = await open(1280);
  await page.click('#r-lead');
  await page.click('#tab-grid');
  await page.click('#cell-6-1');
  const before = await api(page, 'kpis');
  await page.selectOption('#ev-pick', 'D01');
  await page.click('#ev-link');
  assert.equal((await api(page, 'kpis')).standardsNoEvidence, before.standardsNoEvidence - 1);
  await page.click('#tab-meeting');
  const late = (await api(page, 'get')).openActions.find((a) => a.pastDue);
  await page.click('#close-' + late.id);
  assert.equal((await api(page, 'kpis')).actionsPastDue, before.actionsPastDue - 1);
  assert.deepEqual(errors, []);
  await context.close();
});

test('the guide has an off switch and the demo still works without it', async () => {
  const { context, page, errors } = await open(390);
  await page.uncheck('#guide-on');
  assert.equal(await page.locator('.sugg').count(), 0);
  assert.deepEqual(await api(page, 'suggestions'), []);
  assert.equal(await page.locator('#kpis .stat').count(), 4);
  await page.click('#r-staff');
  await page.click('#qk-0');
  assert.ok(await page.locator('#results .doc').count() >= 1, 'search works with the guide off');
  assert.deepEqual(errors, []);
  await context.close();
});

test('the agent object is read-only and returns data', async () => {
  const { context, page, errors } = await open(1280);
  assert.match(await api(page, 'describe'), /Read-only/);
  const g = await api(page, 'get');
  assert.equal(g.documents.length, 18);
  assert.ok(g.standards.length > 10);
  assert.ok(g.openActions.length > 0);
  assert.ok((await api(page, 'suggestions')).length >= 2);
  assert.equal(await page.evaluate(() => Object.isFrozen(window.ospeliGovernanceDemo)), true);
  assert.deepEqual(errors, []);
  await context.close();
});
