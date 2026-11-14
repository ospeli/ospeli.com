// The app opened from a site's own server (backlog A8, second part): connect a phone with a
// one-time code, see the site's data, answer an agent's proposal from the phone, lose the
// connection, get it back, and be disconnected at the server. Phone first (360 px, touch).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const emit = process.emitWarning;
process.emitWarning = (w, ...rest) => (/SQLite/i.test(String(w?.message || w)) ? undefined : emit.call(process, w, ...rest));
const { startServer } = await import('../../tools/ospeli-server/site-server.mjs');
const { runCommand } = await import('../../web/app/core/commands.js');
const { chromium } = createRequire(import.meta.url)('playwright');

const dir = mkdtempSync(join(tmpdir(), 'ospeli-site-e2e-'));
let site; let browser; let key;
before(async () => {
  site = await startServer({ file: join(dir, 'site.db'), port: 0 });
  browser = await chromium.launch();
  for (const line of ['setup agent', 'night-helper', '2', 'all']) await site.consoleLine(line);
  key = /osk_[0-9a-f]{8}_[A-Za-z0-9_-]{32}/.exec(await site.consoleLine(''))[0];
});
after(async () => { await browser.close(); await site.close(); rmSync(dir, { recursive: true, force: true }); });

async function codeFor(label, role) {
  await site.consoleLine('add device');
  await site.consoleLine(label);
  return /^ {4}([A-Z0-9]{4}-[A-Z0-9]{4})$/m.exec(await site.consoleLine(String(role)))[1];
}
async function phone({ width = 360, height = 780 } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|ERR_INTERNET_DISCONNECTED|ERR_FAILED/.test(m.text())) errors.push(m.text()); });
  let taps = 0;
  const tap = async (sel) => { taps += 1; await page.locator(sel).first().tap(); };
  return { context, page, errors, tap, taps: () => taps };
}
const agent = (name, input) => fetch(`${site.url}/api/v1/commands/${name}`, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ input }) }).then((r) => r.json());
const sideways = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
async function propose() {
  const free = (await agent('ospeli_beds_find_free', {})).result;
  const taken = new Set((await site.core.proposals()).filter((p) => p.status === 'pending').flatMap((p) => [p.input.bedId, p.input.encounter]));
  const bed = free.beds.find((b) => !taken.has(b.bedId)); const who = free.waiting.find((w) => !taken.has(w.encounter));
  const out = await agent('ospeli_beds_allocate', { bedId: bed.bedId, encounter: who.encounter });
  assert.equal(out.result?.status, 'proposed', JSON.stringify(out));
  return out.result.proposal.id;
}

test('first-time user at 360 px: connect the phone with the code and answer an agent\'s proposal in 2 taps; recorded as a person on that device', async () => {
  const code = await codeFor('front desk tablet', 2);
  const propId = await propose();
  const { context, page, errors, tap, taps } = await phone();
  await page.goto(`${site.url}/app/`);
  await page.waitForSelector('html[data-ready="connect"]');
  // One screen, one task: a heading, one line, one field, one button. Nothing to read first.
  const screen = await page.evaluate(() => {
    const form = document.querySelector('[data-test="connect"]');
    const px = (el) => parseFloat(getComputedStyle(el).fontSize);
    return {
      h1: form.querySelector('h1').textContent, help: form.querySelector('#connect-help').textContent, label: form.querySelector('label').textContent,
      inputs: form.querySelectorAll('input').length, buttons: [...form.querySelectorAll('button')].map((b) => b.textContent),
      heights: [...form.querySelectorAll('input, button')].map((e) => Math.round(e.getBoundingClientRect().height)),
      smallest: Math.min(...[...form.querySelectorAll('h1, p, label, input, button')].filter((e) => e.textContent || e.tagName === 'INPUT').map(px)),
      bottom: Math.round(form.querySelector('button').getBoundingClientRect().bottom),
      focused: document.activeElement?.id, words: form.innerText.split(/\s+/).length,
      rolePicker: !!document.querySelector('#role-select'),
    };
  });
  assert.deepEqual({ h1: screen.h1, help: screen.help, label: screen.label, inputs: screen.inputs, buttons: screen.buttons }, { h1: 'Connect this device', help: 'Ask the person who looks after Ospeli here for a code.', label: 'Code', inputs: 1, buttons: ['Connect'] });
  assert.ok(screen.heights.every((x) => x >= 44), `tap targets ${screen.heights}`);
  assert.ok(screen.smallest >= 15, `smallest text ${screen.smallest}px`);
  assert.ok(screen.bottom <= 780, 'the Connect button is on the first screen');
  assert.equal(screen.focused, 'connect-code', 'the field is ready to type in');
  assert.ok(screen.words <= 45, `${screen.words} words on the screen`);
  assert.equal(await page.locator('.topbar .role, .topbar .menu-btn, .topbar .hospital, #nav').evaluateAll((els) => els.filter((e) => e.getClientRects().length).length), 0, 'no menu, role or badge on the connect screen: one task');
  assert.ok(await sideways(page) <= 0);
  for (const bad of ['plain', 'pair', 'sync', 'token', 'session', 'server']) assert.doesNotMatch(await page.locator('[data-test="connect"]').innerText(), new RegExp(`\\b${bad}`, 'i'));
  // A wrong code says so in plain words and keeps the field.
  await page.fill('[data-test="connect-code"]', 'zzzzzzzz');
  assert.equal(await page.inputValue('[data-test="connect-code"]'), 'ZZZZ-ZZZZ', 'the dash is added and lower case is fine');
  await page.locator('[data-test="connect-btn"]').tap();
  await page.waitForFunction(() => document.querySelector('[data-test="connect-msg"]').textContent === 'That code is not right. Check it and try again.');
  // The right code, typed in lower case without the dash: one tap on Connect.
  await page.fill('[data-test="connect-code"]', code.toLowerCase().replace('-', ''));
  await tap('[data-test="connect-btn"]');
  await page.waitForSelector('html[data-ready="true"]');
  assert.equal(await page.locator('[data-test="device-role"]').textContent(), 'Patient flow coordinator');
  assert.equal(await page.locator('#role-select').count(), 0, 'the role was chosen at the server; there is nothing to pick');
  assert.equal(await page.locator('[data-test="site-status"]').isHidden(), true);
  // The agent's proposal is on the first screen of this role's home; one tap answers it.
  await page.waitForSelector('[data-test="proposals"] [data-cmd="ospeli_proposals_accept"]');
  const accept = await page.locator('[data-test="proposals"] [data-cmd="ospeli_proposals_accept"]').first().boundingBox();
  assert.ok(accept.height >= 44, `Accept is ${accept.height}px tall`);
  // Accept stands alone; the reason sits with Decline under a label, so nobody declines "Not needed" by accident.
  const row = await page.evaluate(() => {
    const box = document.querySelector('[data-test="proposals"] .proposal-actions');
    const r = (el) => el.getBoundingClientRect();
    const yes = r(box.querySelector('[data-cmd="ospeli_proposals_accept"]')); const sel = r(box.querySelector('select')); const no = r(box.querySelector('[data-cmd="ospeli_proposals_decline"]'));
    const label = box.querySelector('label');
    return { label: label.textContent, labelFor: label.htmlFor === box.querySelector('select').id, selBelowYes: sel.top >= yes.bottom, noBelowYes: no.top >= yes.bottom, heights: [yes.height, sel.height, no.height].map(Math.round), labelPx: parseFloat(getComputedStyle(label).fontSize) };
  });
  assert.deepEqual({ label: row.label, labelFor: row.labelFor, selBelowYes: row.selBelowYes, noBelowYes: row.noBelowYes }, { label: 'If no, why?', labelFor: true, selBelowYes: true, noBelowYes: true });
  assert.ok(row.heights.every((x) => x >= 44) && row.labelPx >= 15, JSON.stringify(row));
  await tap('[data-test="proposals"] [data-cmd="ospeli_proposals_accept"]');
  await page.waitForFunction(() => /^Accepted:/.test(document.querySelector('#toast').textContent));
  assert.equal(taps(), 2, 'connect, then accept');
  const p = (await site.core.proposals()).find((x) => x.id === propId);
  assert.equal(p.status, 'accepted');
  const entry = (await site.core.auditLog()).find((e) => e.action === 'agent.proposal-accepted' && e.target === propId);
  assert.deepEqual({ type: entry.actorType, role: entry.actorRole, via: entry.via, device: entry.device }, { type: 'human', role: 'bed-manager', via: 'app', device: 'front desk tablet' });
  // The phone's own copy has the new event too, and the trail on the Data page says where the person acted.
  await page.goto(`${site.url}/app/#/data`);
  await page.waitForSelector('[data-test="site-device-card"]');
  assert.match(await page.locator('main h1').textContent(), /Your data stays on your site/);
  assert.match(await page.locator('main').innerText(), /Person · Patient flow coordinator \(on front desk tablet\)/);
  assert.equal(await page.locator('main button', { hasText: /Reset|Export|Load a fresh copy/ }).count(), 0, 'reset, import and export belong to the server');
  // The page has no agent door here; agents use their key.
  const door = await page.evaluate(() => window.ospeli.run('ospeli_beds_board', {}).then(() => 'ran', (e) => e.message));
  assert.match(door, /uses its own key/);
  // The token is not readable by a script in the page.
  assert.equal(await page.evaluate(() => document.cookie), '');
  assert.ok(await sideways(page) <= 0);
  assert.deepEqual(errors, []);
  await context.close();
});

test('no connection at 360 px: the phone says so, still shows the last information, refuses a change, and catches up when it is back', async () => {
  const code = await codeFor('ward phone', 2);
  const { context, page, errors } = await phone();
  await page.goto(`${site.url}/app/`);
  await page.waitForSelector('html[data-ready="connect"]');
  await page.fill('[data-test="connect-code"]', code);
  await page.locator('[data-test="connect-btn"]').tap();
  await page.waitForSelector('html[data-ready="true"]');
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => new Promise((r) => setTimeout(r, 1500))));
  const propId = await propose();
  await page.waitForSelector('[data-test="proposals"] [data-cmd="ospeli_proposals_accept"]', { timeout: 15000 });
  const eventsBefore = await site.core.eventCount();
  await context.setOffline(true);
  await page.waitForFunction(() => document.documentElement.dataset.site === 'offline', null, { timeout: 15000 });
  const bar = page.locator('[data-test="site-status"]');
  assert.match(await bar.textContent(), /^Not connected\. You see the information from \d{1,2}[:.]\d{2}.*\. You cannot save changes now\.$/);
  assert.ok(parseFloat(await bar.evaluate((e) => getComputedStyle(e).fontSize)) >= 15);
  // A change is refused in plain words; nothing reaches the server later.
  await page.locator('[data-test="proposals"] [data-cmd="ospeli_proposals_accept"]').first().tap();
  await page.waitForFunction(() => document.querySelector('#toast').textContent === 'Not saved. This device is not connected. Try again when it is back on your site\'s network.');
  // Reopened with no connection: the app still opens on the last information, and says so.
  await page.reload();
  await page.waitForSelector('html[data-ready="true"]');
  assert.equal(await page.locator('[data-test="device-role"]').textContent(), 'Patient flow coordinator');
  await page.waitForSelector('[data-test="proposals"] [data-cmd="ospeli_proposals_accept"]');
  assert.equal(await bar.isVisible(), true);
  assert.ok(await page.locator('.bed, [data-bed]').count() > 0, 'the beds are still on screen');
  assert.ok(await sideways(page) <= 0);
  await context.setOffline(false);
  await page.waitForFunction(() => document.documentElement.dataset.site === 'connected', null, { timeout: 15000 });
  assert.equal(await bar.isHidden(), true);
  assert.equal(await site.core.eventCount(), eventsBefore, 'the refused change was not kept and sent later');
  assert.equal((await site.core.proposals()).find((x) => x.id === propId).status, 'pending');
  // Now it can be answered.
  await page.locator('[data-test="proposals"] [data-cmd="ospeli_proposals_accept"]').first().tap();
  await page.waitForFunction(() => /^Accepted:/.test(document.querySelector('#toast').textContent));
  assert.equal((await site.core.proposals()).find((x) => x.id === propId).status, 'accepted');
  // Disconnected at the server: the phone goes back to "Connect this device" and keeps no copy.
  const n = (await site.consoleLine('devices')).split('\n').findIndex((l) => l.includes('ward phone'));
  assert.match(await site.consoleLine(`remove device ${n}`), /"ward phone" is disconnected/);
  await page.waitForSelector('html[data-ready="connect"]', { timeout: 15000 });
  const left = await page.evaluate(() => new Promise((done) => {
    const r = indexedDB.open('ospeli-site');
    r.onsuccess = () => { const q = r.result.transaction('events').objectStore('events').count(); q.onsuccess = () => done(q.result); };
  }));
  assert.equal(left, 0, 'nothing of the site is left on a disconnected device');
  assert.deepEqual(errors, []);
  await context.close();
});

for (const width of [390, 1280]) {
  test(`connected device at ${width} px: the role's home opens, a change made on the device is saved on the server, no sideways scroll`, async () => {
    // A job is waiting for the facilities team whatever the hour the made-up site was generated at.
    await runCommand(site.core, 'ospeli_workorders_report_fault', { assetId: 'asset-a1-sink-1', fault: width === 390 ? 'Tap leaking' : 'Blocked sink', priority: 'urgent' }, { type: 'human', role: 'ward-nurse', via: 'console' });
    const code = await codeFor(`desk ${width}`, 3);
    const { context, page, errors } = await phone({ width, height: 860 });
    await page.goto(`${site.url}/app/`);
    await page.waitForSelector('html[data-ready="connect"]');
    assert.ok(await sideways(page) <= 0);
    await page.fill('[data-test="connect-code"]', code);
    await page.locator('[data-test="connect-btn"]').tap();
    await page.waitForSelector('html[data-ready="true"]');
    assert.equal(await page.locator('[data-test="device-role"]').textContent(), 'Facilities technician');
    assert.match(await page.evaluate(() => location.hash), /^#\/engineering/, 'a connected device opens on its role\'s own screen');
    await page.waitForSelector('[data-cmd="ospeli_workorders_start"]');
    const before = await site.core.eventCount();
    await page.locator('[data-cmd="ospeli_workorders_start"]').first().tap();
    await page.waitForSelector('[data-test="close-job"]');
    assert.equal(await site.core.eventCount(), before + 1);
    const ev = (await site.core.events({ type: 'workorder.started' })).at(-1);
    assert.equal(ev.actorRole, 'estates-tech');
    // Close it, so the job is done from start to finish on the device.
    await page.locator('[data-test="close-job"]').tap();
    await page.locator('[data-test="outcomes"] [data-outcome="fixed"]').tap();
    await page.waitForFunction(() => !document.querySelector('[data-test="close-job"]') && !document.querySelector('[data-test="outcomes"]'));
    assert.equal(await site.core.eventCount(), before + 2);
    assert.equal((await site.core.events({ type: 'workorder.completed' })).at(-1).subject, ev.subject);
    assert.equal(await page.evaluate(() => window.ospeli.core === undefined), true, 'no test hook: this is the page as a visitor gets it');
    // With no connection the line sits in the top bar and the page keeps its shape (the menu
    // beside the page on a wide screen, nothing under the top bar hidden).
    await context.setOffline(true);
    await page.waitForFunction(() => document.documentElement.dataset.site === 'offline', null, { timeout: 15000 });
    await page.evaluate(() => window.scrollTo(0, 400));
    const shape = await page.evaluate(() => {
      const r = (sel) => document.querySelector(sel).getBoundingClientRect();
      return { bar: r('[data-test="site-status"]'), top: r('.topbar'), nav: r('#nav'), main: r('#main'), wide: getComputedStyle(document.querySelector('.layout')).display === 'grid' };
    });
    assert.ok(shape.bar.top >= 0 && shape.bar.bottom <= shape.top.bottom + 1, 'the line stays on screen inside the top bar when the page is scrolled');
    if (shape.wide) {
      assert.ok(shape.main.left >= shape.nav.right - 1, 'the page stays beside the menu');
      assert.ok(shape.nav.top >= shape.top.bottom - 1, 'the menu starts under the taller top bar');
    }
    await context.setOffline(false);
    await page.waitForFunction(() => document.documentElement.dataset.site === 'connected', null, { timeout: 15000 });
    assert.ok(await sideways(page) <= 0);
    assert.deepEqual(errors, []);
    await context.close();
  });
}
