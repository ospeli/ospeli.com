// Issue #87: if the browser clears the app's storage, the app says so. It must not open on a fresh
// hospital as if nothing happened, with "Saved on this device" and a clean-looking audit pill.
// What can be caught: the app keeps a small marker outside its database (in localStorage and in
// Cache Storage). If the database is empty but a marker is still there, the data was cleared.
// What cannot: a wipe of every kind of storage at once looks the same as a first visit.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, openPage } from './helpers.mjs';

let env;
before(async () => { env = await startApp(); });
after(async () => { await env.close(); });

const CLOCK = '2026-11-14T10:00:00Z';
// Clear storage the way the issue does, with the page closed over it: go to a blank page first so
// no connection holds the database open.
async function clearStorage(context, page, types) {
  await page.goto('about:blank');
  const cdp = await context.newCDPSession(page);
  await cdp.send('Storage.clearDataForOrigin', { origin: env.base, storageTypes: types });
  await cdp.detach();
  await page.goto(`${env.appUrl}#/engineering`);
  await page.waitForSelector('html[data-ready="true"]');
}
const startAJob = async (page) => {
  await page.selectOption('#role-select', 'estates-tech');
  await page.goto(`${env.appUrl}#/engineering`);
  await page.locator('button:has-text("Start job")').first().click();
  await page.waitForFunction(() => /Job in progress/.test(document.querySelector('main').innerText));
};

for (const [width, types] of [[390, 'indexeddb,local_storage'], [360, 'indexeddb'], [1280, 'indexeddb,local_storage']]) {
  test(`the browser clears the app's storage (${types}): the app says so, records it, and the pill reads "History replaced" (issue #87, ${width}px)`, async () => {
    const phone = width < 641;
    const { context, page, errors } = await openPage(env, { width, height: phone ? 780 : 860, clock: CLOCK, touch: phone });
    assert.equal(await page.locator('[data-test="data-lost"]').count(), 0, 'a first visit has no notice');
    await startAJob(page);
    const before = await page.evaluate(() => window.ospeli.core.eventCount());

    await clearStorage(context, page, types);
    const notice = page.locator('[data-test="data-lost"]');
    await notice.waitFor();
    const text = await notice.innerText();
    assert.match(text, /browser cleared the data saved on this device/i);
    assert.match(text, /fresh example copy/i);
    assert.match(text, /14 Nov 2026/, 'says when the data was last here');
    assert.ok(await notice.evaluate((e) => parseFloat(getComputedStyle(e).fontSize)) >= 15);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), 0, 'no sideways scroll');
    // The work is gone and the app does not pretend otherwise.
    assert.ok(await page.evaluate(() => window.ospeli.core.eventCount()) < before, 'the started job is gone');
    assert.equal(await page.evaluate(() => /Job in progress/.test(document.querySelector('main').innerText)), false);
    // It is in the audit trail, as the system, and the trail still checks.
    const log = await page.evaluate(() => window.ospeli.core.auditLog());
    const lost = log.filter((e) => e.action === 'data.lost');
    assert.equal(lost.length, 1);
    assert.equal(lost[0].actorRole, 'system');
    assert.match(lost[0].detail.lastSeen, /^2026-11-14T/);
    assert.deepEqual(await page.evaluate(() => window.ospeli.core.verifyAudit()), { ok: true });
    // The Data page pill is not a clean "Self-check passed".
    await page.goto(`${env.appUrl}#/data`);
    await page.waitForFunction(() => /History replaced on/.test(document.querySelector('[data-test="audit-status"]')?.textContent || ''));
    assert.match(await page.locator('main').innerText(), /browser cleared this device's storage/i);
    assert.doesNotMatch(await page.textContent('[data-test="audit-status"]'), /Self-check passed/);
    // The notice stays through a reload until a person closes it; then it stays closed.
    await page.reload();
    await page.waitForSelector('html[data-ready="true"]');
    await notice.waitFor();
    const ok = notice.locator('button');
    assert.ok((await ok.boundingBox()).height >= 44, 'the button is a 44 px target');
    if (phone) await ok.tap(); else await ok.click();
    await page.waitForFunction(() => !document.querySelector('[data-test="data-lost"]'));
    await page.reload();
    await page.waitForSelector('html[data-ready="true"]');
    assert.equal(await page.locator('[data-test="data-lost"]').count(), 0);
    assert.equal((await page.evaluate(() => window.ospeli.core.auditLog())).filter((e) => e.action === 'data.lost').length, 1, 'recorded once');
    assert.deepEqual(errors, []);
    await context.close();
  });
}

test('the menu foot says whether the browser agreed to keep the data; a reset a person chose shows no "browser cleared" notice (issue #87)', async () => {
  const { context, page, errors } = await openPage(env, { width: 390, height: 780, clock: CLOCK });
  // The app asks the browser to keep its data and says what the browser answered.
  await page.waitForFunction(() => /^Saved on this device/.test(document.getElementById('storage-status').textContent));
  const kept = await page.evaluate(() => navigator.storage.persisted());
  const foot = await page.textContent('#storage-status');
  if (kept) assert.equal(foot, 'Saved on this device');
  else assert.equal(foot, 'Saved on this device. The browser may clear it: export a backup.');
  // It asks on every start (the test watches the browser's own function from the next load on).
  await page.addInitScript(() => { const real = navigator.storage.persist.bind(navigator.storage); navigator.storage.persist = () => { window.__askedToPersist = true; return real(); }; });
  await page.reload();
  await page.waitForSelector('html[data-ready="true"]');
  assert.equal(await page.evaluate(() => window.__askedToPersist === true), true, 'the app asked the browser to keep its data');
  // A reset is a person's choice: the pill says "History replaced", and no browser notice appears.
  await page.goto(`${env.appUrl}#/data`);
  page.once('dialog', (d) => d.accept());
  await page.click('text=Reset device data');
  await page.waitForFunction(() => document.querySelector('[data-test="synthetic-badge"]').textContent === 'No data loaded');
  await page.reload();
  await page.waitForSelector('html[data-ready="true"]');
  assert.equal(await page.locator('[data-test="data-lost"]').count(), 0);
  assert.equal((await page.evaluate(() => window.ospeli.core.auditLog())).filter((e) => e.action === 'data.lost').length, 0);
  assert.deepEqual(errors, []);
  await context.close();
});

// Issue #87, part 3: the Data page says when this data was last exported, and nudges when that is over a week ago.
for (const width of [360, 1280]) {
  test(`the Data page shows the date of the last export and nudges after a week (issue #87, ${width}px)`, async () => {
    const phone = width < 641;
    const { context, page, errors } = await openPage(env, { width, height: phone ? 780 : 860, path: '#/data', clock: CLOCK, touch: phone });
    const line = page.locator('[data-test="last-export"]');
    await line.waitFor();
    assert.equal(await line.innerText(), 'This data has not been exported yet. An export is the only backup.');
    assert.ok(await line.evaluate((e) => parseFloat(getComputedStyle(e).fontSize)) >= 15);
    const [download] = await Promise.all([page.waitForEvent('download'), page.locator('button:has-text("Export JSON")').click()]);
    assert.match(download.suggestedFilename(), /^ospeli-export-/);
    await page.waitForFunction(() => /^Last export: 14 Nov 2026, \d\d:\d\d\.$/.test(document.querySelector('[data-test="last-export"]').innerText));
    assert.equal(await line.getAttribute('data-old'), 'false');
    // Eight days later the line asks for a new backup.
    await page.clock.setSystemTime(new Date('2026-11-22T12:00:00Z'));
    await page.reload();
    await page.waitForSelector('html[data-ready="true"]');
    await page.waitForFunction(() => /^Last export: 14 Nov 2026, \d\d:\d\d, 8 days ago\. Export a new backup\.$/.test(document.querySelector('[data-test="last-export"]')?.innerText || ''));
    assert.equal(await line.getAttribute('data-old'), 'true');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), 0);
    assert.deepEqual(errors, []);
    await context.close();
  });
}
