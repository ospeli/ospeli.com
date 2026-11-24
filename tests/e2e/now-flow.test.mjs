// Now (navigation v2, ospeli/ospeli docs/design/navigation-v2.md "Now"; walk-first week crew plan,
// night 1 part d): the department's flow strip from data already on the device, "Needs you, in flow
// order", "From your walks", and Key numbers only where they describe the department (#166 item 1).
// Synthetic example hospital; made-up requests only.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, openPage } from './helpers.mjs';
import { DEPARTMENTS } from '../../web/app/modules/departments.js';

let env;
before(async () => { env = await startApp(); });
after(async () => { await env.close(); });

const CLOCK = '2026-11-17T14:20:00Z';
const route = (page, h) => page.waitForFunction((x) => document.documentElement.dataset.route === x, h);
const go = async (page, h) => { await page.evaluate((x) => { location.hash = x; }, h); await route(page, h); };
const asHuman = (page, name, input, role) => page.evaluate(async ([n, i, r]) => {
  const { runCommand } = await import('./core/commands.js');
  return runCommand(window.ospeli.core, n, i, { type: 'human', role: r });
}, [name, input, role]);

for (const [width, height] of [[360, 640], [390, 844]]) {
  test(`${width} px: Imaging's flow strip has its four stages in order, 44 px tiles, no sideways scroll, and Leave opens Transfers`, async () => {
    const { page, context, errors } = await openPage(env, { width, height, touch: true, department: 'imaging', clock: CLOCK });
    await page.waitForSelector('[data-test="now-flow"]');
    const tiles = await page.locator('.flow-tile').evaluateAll((els) => els.map((e) => ({ stage: e.dataset.stage, name: e.querySelector('.flow-name').textContent, n: e.querySelector('.flow-n').textContent, h: e.getBoundingClientRect().height, w: e.getBoundingClientRect().width, top: e.getBoundingClientRect().top, label: e.getAttribute('aria-label') })));
    assert.deepEqual(tiles.map((t) => t.name), ['Arrive', 'Prep', 'Scan', 'Leave']);
    for (const t of tiles) { assert.ok(t.h >= 44 && t.w >= 44, `${t.name}: a ${t.w} by ${t.h} px tile`); assert.equal(t.top, tiles[0].top, `${t.name} is on the same row`); }
    // Honest counts: Prep and Scan have no source, so a dash and the words "not counted yet", never a number.
    assert.equal(tiles[1].n, '–'); assert.equal(tiles[2].n, '–');
    assert.match(tiles[1].label, /^Prep: not counted yet/);
    assert.match(await page.textContent('[data-test="flow-key"]'), /Prep, Scan: not counted yet/);
    assert.match(tiles[0].n, /^\d+$/); assert.match(tiles[3].n, /^\d+$/);
    assert.equal(await page.textContent('.flow-caption'), 'Example setting, a site can edit these stages.');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'no sideways scroll');
    // Imaging does not lead with ward and emergency numbers (#166 item 1); its pages and the footer stay.
    assert.equal(await page.locator('#kpi-h').count(), 0);
    assert.ok(await page.locator('[data-test="role-shortcuts"] a').count() >= 3);
    assert.equal(await page.textContent('[data-test="now-foot"]'), 'Synthetic demo data · no real patients or sites');
    // A stage served by two pages lists them; a stage served by one opens it.
    await page.locator('.flow-tile[data-stage="scan"]').tap();
    assert.deepEqual(await page.locator('[data-test="flow-pick"] a').evaluateAll((as) => as.map((a) => [a.getAttribute('href'), a.textContent])), [['#/engineering', 'Engineering'], ['#/diagnostics', 'Diagnostics']]);
    assert.equal(await page.getAttribute('.flow-tile[data-stage="scan"]', 'aria-expanded'), 'true');
    await page.locator('.flow-tile[data-stage="leave"]').tap();
    await route(page, '#/transfers');
    assert.deepEqual(errors, []);
    await context.close();
  });
}

test('every department has a strip of four stages, numbers only where the data has them, and the mango bar only with a real wait', async () => {
  const { page, context, errors } = await openPage(env, { width: 360, height: 640, touch: true, department: 'wards', clock: CLOCK });
  for (const d of DEPARTMENTS) {
    await page.evaluate(() => { location.hash = '#/home'; });
    const { chooseDepartment } = await import('./helpers.mjs');
    await chooseDepartment(page, d.id);
    await page.waitForSelector('[data-test="now-flow"]');
    const names = await page.locator('.flow-tile .flow-name').allTextContents();
    assert.deepEqual(names, d.stages.map((s) => s.name), d.id);
    const bars = await page.locator('[data-test="flow-wait-bar"]').count();
    const line = await page.locator('[data-test="flow-wait"]').count();
    assert.ok(bars <= 1 && bars === line, `${d.id}: one mango bar with its words, or none`);
    if (line) assert.match(await page.textContent('[data-test="flow-wait"]'), /^→Longest wait now: (\d+ min|\d+ h( \d+)?|under 1 min), .+ to .+ \(.+\)$/);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${d.id}: no sideways scroll`);
    assert.equal(await page.locator('#kpi-h').count(), ['wards', 'emergency', 'whole-hospital'].includes(d.id) ? 1 : 0, `${d.id}: Key numbers`);
  }
  // Wards: the counts are the bed board's and the transfers board's own figures.
  await (await import('./helpers.mjs')).chooseDepartment(page, 'wards');
  await page.waitForSelector('[data-test="now-flow"]');
  const board = await asHuman(page, 'ospeli_beds_board', { format: 'short' }, 'ward-nurse');
  const n = (id) => page.textContent(`.flow-tile[data-stage="${id}"] .flow-n`);
  assert.equal(await n('stay'), String(board.wards.reduce((s, w) => s + w.counts.occupied, 0)));
  assert.equal(await n('ready'), String(board.wards.reduce((s, w) => s + w.counts['expected-discharge'], 0)));
  assert.equal(await n('arrive'), String(board.waiting.length));
  assert.deepEqual(errors, []);
  await context.close();
});

test('Needs you follows the flow: Scan (Engineering) before Leave (Transfers), whatever came first; nothing invented when nothing needs the person', async () => {
  const { page, context, errors } = await openPage(env, { width: 390, height: 844, touch: true, department: 'imaging', clock: CLOCK });
  await page.waitForSelector('[data-test="now-needs"]');
  assert.equal(await page.locator('[data-test="needs-list"]').count(), 0);
  assert.match(await page.textContent('[data-test="needs-none"]'), /^Nothing needs you right now/);
  // A journey out of Imaging first, then a fault on an Imaging X-ray room.
  const trip = await asHuman(page, 'ospeli_transfers_request', { type: 'between-sites', fromPlace: 'dept-imaging', toSite: 'site-north', needed: 'asap', mobility: 'wheelchair', escort: 'none', equipment: ['none'] }, 'ae-nic');
  assert.equal(trip.status, 'done');
  const fault = await asHuman(page, 'ospeli_workorders_report_fault', { assetId: 'asset-xray-1', fault: (await asHuman(page, 'ospeli_assets_list', { locationId: 'dept-imaging' }, 'ward-nurse')).assets.find((a) => a.id === 'asset-xray-1').faults[0], priority: 'urgent' }, 'ward-nurse');
  assert.equal(fault.status, 'done');
  await go(page, '#/journey'); await go(page, '#/home');
  await page.waitForSelector('[data-test="needs-list"]');
  const cards = await page.locator('[data-test="needs-list"] .needs-card').evaluateAll((as) => as.map((a) => ({ where: a.querySelector('[data-test="needs-where"]').textContent, chips: [...a.querySelectorAll('.chip-word')].map((c) => c.textContent), href: a.getAttribute('href'), h: a.getBoundingClientRect().height })));
  assert.deepEqual(cards.map((c) => c.where), ['At Scan · Engineering', 'At Leave · Transfers']);
  assert.match(cards[0].chips[0], /^1 open work order/);
  assert.match(cards[1].chips[0], /^1 waiting for a vehicle/);
  assert.deepEqual(cards.map((c) => c.href), ['#/engineering', '#/transfers']);
  for (const c of cards) assert.ok(c.h >= 44);
  // Status in words, upper case only by style.
  assert.equal(await page.locator('[data-test="needs-where"]').first().evaluate((e) => getComputedStyle(e).textTransform), 'uppercase');
  assert.deepEqual(errors, []);
  await context.close();
});

test('From your walks: nothing before a walk; after a finished walk, its longest wait in one sentence and See map', async () => {
  const { page, context, errors } = await openPage(env, { width: 360, height: 640, touch: true, department: 'imaging', clock: CLOCK });
  await page.waitForSelector('[data-test="now-flow"]');
  assert.equal(await page.locator('[data-test="now-walks"]').count(), 0);
  await go(page, '#/process');
  await page.waitForSelector('[data-test="walk-start"]');
  await page.tap('[data-test="walk-start"]'); await page.tap('[data-test="walk-before-ok"]');
  await page.waitForSelector('[data-test="walk"][data-state="waiting"]');
  for (const [wait, work] of [[120, 60], [420, 90]]) {
    await page.clock.fastForward(wait * 1000);
    await page.tap('[data-test="walk-main"]'); await page.waitForSelector('[data-test="walk"][data-state="step"]');
    await page.clock.fastForward(work * 1000);
    await page.tap('[data-test="walk-main"]'); await page.waitForSelector('[data-test="walk-sheet"]');
    await page.locator('[data-chip="name"]').first().tap(); await page.locator('[data-chip="role"]').first().tap();
    await page.waitForFunction(() => !document.querySelector('[data-test="walk-sheet"]'));
  }
  const second = await page.evaluate(async () => { const { runCommand } = await import('./core/commands.js'); return (await runCommand(window.ospeli.core, 'ospeli_walks_get', {}, { type: 'human', role: 'radiographer' })).walk.steps[1].name; });
  await page.tap('[data-test="walk-finish"]'); await page.tap('[data-test="walk-finish-yes"]');
  await page.waitForSelector('[data-test="walk-answer"]');
  await go(page, '#/home');
  await page.waitForSelector('[data-test="now-walks"]');
  assert.equal(await page.textContent('[data-test="now-walk-line"]'), `Walk 1: longest wait 7 min before ${second}`);
  await page.locator('[data-test="now-walk-map"]').tap();
  await route(page, '#/process/map-001');
  assert.deepEqual(errors, []);
  await context.close();
});
