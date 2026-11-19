// Issue #86 items 1 and 2 (marketer and Adoption lead, 14 Nov): the proposal card says
// "Suggested changes" in plain words, and on a connected device with no connection Accept and
// Decline cannot be tapped and say "Not connected"; a change that fails says so inside the card,
// not in a message over it. Phone first (360 and 390 px, touch).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const emit = process.emitWarning;
process.emitWarning = (w, ...rest) => (/SQLite/i.test(String(w?.message || w)) ? undefined : emit.call(process, w, ...rest));
const { startServer } = await import('../../tools/ospeli-server/site-server.mjs');
const { chromium } = createRequire(import.meta.url)('playwright');

const dir = mkdtempSync(join(tmpdir(), 'ospeli-card-e2e-'));
let site; let browser; let key;
before(async () => {
  // The example hospital is made for a fixed hour, not the wall clock: at some hours of the day the
  // wall-clock hospital had too few free beds for the third proposal and the test failed (issue #95).
  site = await startServer({ file: join(dir, 'site.db'), port: 0, end: '2026-11-08T12:00:00.000Z' });
  browser = await chromium.launch();
  for (const line of ['setup agent', 'night-helper', '2', 'all']) await site.consoleLine(line);
  key = /osk_[0-9a-f]{8}_[A-Za-z0-9_-]{32}/.exec(await site.consoleLine(''))[0];
});
after(async () => { await browser.close(); await site.close(); rmSync(dir, { recursive: true, force: true }); });

const agent = (name, input) => fetch(`${site.url}/api/v1/commands/${name}`, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ input }) }).then((r) => r.json());
async function propose() {
  const free = (await agent('ospeli_beds_find_free', { limit: 20, waitingLimit: 20 })).result;
  const taken = new Set((await site.core.proposals()).filter((p) => p.status === 'pending').flatMap((p) => [p.input.bedId, p.input.encounter]));
  const bed = free.beds.find((b) => !taken.has(b.bedId)); const who = free.waiting.find((w) => !taken.has(w.encounter));
  const out = await agent('ospeli_beds_allocate', { bedId: bed.bedId, encounter: who.encounter });
  assert.equal(out.result?.status, 'proposed', JSON.stringify(out));
  return out.result.proposal.id;
}
async function connectedPhone(width, label) {
  await site.consoleLine('add device');
  await site.consoleLine(label);
  const code = /^ {4}([A-Z0-9]{4}-[A-Z0-9]{4})$/m.exec(await site.consoleLine('2'))[1];
  const context = await browser.newContext({ viewport: { width, height: 780 }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|ERR_INTERNET_DISCONNECTED|ERR_FAILED/.test(m.text())) errors.push(m.text()); });
  await page.goto(`${site.url}/app/`);
  await page.waitForSelector('html[data-ready="connect"]');
  await page.fill('[data-test="connect-code"]', code);
  await page.locator('[data-test="connect-btn"]').tap();
  await page.waitForSelector('html[data-ready="true"]');
  return { context, page, errors };
}
const YES = '[data-test="proposals"] [data-cmd="ospeli_proposals_accept"]';
const NO = '[data-test="proposals"] [data-cmd="ospeli_proposals_decline"]';

for (const width of [360, 390]) {
  test(`#86: "Suggested changes" in plain words; with no connection Accept and Decline cannot be tapped and say "Not connected" (${width} px)`, async () => {
    const propId = await propose();
    const { context, page, errors } = await connectedPhone(width, `card phone ${width}`);
    await page.waitForSelector(YES, { timeout: 15000 });
    const n = (await site.core.proposals()).filter((p) => p.status === 'pending').length;
    assert.equal(await page.locator('#prop-h').textContent(), `Suggested changes (${n})`);
    assert.equal(await page.locator('[data-test="proposals"] .proposals > p.meta').textContent(), 'An agent suggested these. Nothing changes until you say yes. Your yes is recorded under your role.');
    assert.equal(await page.locator(YES).first().isEnabled(), true);
    assert.equal(await page.locator('[data-test="proposal-offline"]').count(), 0);

    const eventsBefore = await site.core.eventCount();
    await context.setOffline(true);
    await page.waitForFunction(() => document.documentElement.dataset.site === 'offline', null, { timeout: 15000 });
    await page.waitForSelector('[data-test="proposal-offline"]');
    assert.equal(await page.locator(YES).first().isDisabled(), true, 'Accept cannot be tapped');
    assert.equal(await page.locator(NO).first().isDisabled(), true, 'Decline cannot be tapped');
    const tag = await page.locator('[data-test="proposal-offline"]').first().evaluate((el) => ({ text: el.textContent, size: parseFloat(getComputedStyle(el).fontSize), inActions: !!el.closest('.proposal-actions') }));
    assert.deepEqual([tag.text, tag.inActions], ['Not connected', true], 'beside the buttons');
    assert.ok(tag.size >= 15);
    const dim = await page.locator(YES).first().evaluate((el) => getComputedStyle(el).opacity);
    assert.equal(dim, '1', 'no see-through text: the state is shown by the words and the disabled look');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth) <= 0);

    await context.setOffline(false);
    await page.waitForFunction(() => document.documentElement.dataset.site === 'connected', null, { timeout: 15000 });
    await page.waitForFunction((sel) => document.querySelector(sel) && !document.querySelector(sel).disabled, YES);
    assert.equal(await page.locator('[data-test="proposal-offline"]').count(), 0);
    assert.equal(await site.core.eventCount(), eventsBefore, 'nothing was changed while offline');
    assert.equal((await site.core.proposals()).find((x) => x.id === propId).status, 'pending');
    assert.deepEqual(errors, []);
    await context.close();
  });
}

test('#86: a change that fails says so inside the card, not in a message over it (360 px)', async () => {
  await propose();
  const { context, page, errors } = await connectedPhone(360, 'card phone msg');
  await page.waitForSelector(YES, { timeout: 15000 });
  // The connection drops between the last check and the tap: the device does not know yet.
  await page.route('**/api/v1/commands/**', (r) => r.abort());
  await page.locator(YES).first().tap();
  await page.waitForSelector('[data-test="proposal-msg"]');
  assert.equal(await page.locator('[data-test="proposal-msg"]').textContent(), 'Not saved. This device is not connected. Try again when it is back on your site\'s network.');
  assert.equal(await page.locator('[data-test="proposal-msg"]').getAttribute('role'), 'status');
  assert.ok(await page.locator('[data-test="proposal-msg"]').evaluate((el) => !!el.closest('[data-test="proposals"]')));
  assert.notEqual(await page.locator('#toast').textContent(), await page.locator('[data-test="proposal-msg"]').textContent(), 'not also over the page');
  await page.unroute('**/api/v1/commands/**');
  assert.deepEqual(errors, []);
  await context.close();
});
