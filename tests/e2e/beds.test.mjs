import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, openPage } from './helpers.mjs';

let env;
before(async () => { env = await startApp(); });
after(async () => { await env.close(); });

// The synthetic hospital is generated from the current hour, so free beds vary through the day.
// Pin the clock to an hour with free beds that match the first waiting patient (issue #35).
const CLOCK = '2026-11-09T00:40:00Z';

const stat = (page, t) => page.locator(`[data-test="${t}"] b`).textContent().then(Number);
const bedState = (page, id) => page.evaluate(async (bedId) => {
  const { deriveBoard } = await import('./core/beds.js');
  const core = window.ospeli.core;
  return deriveBoard(await core.listEntities('bed'), await core.events()).beds.get(bedId).state;
}, id);

for (const width of [360, 390, 1024, 1280]) {
  test(`bed board renders every ward at ${width}px with no sideways scroll`, async () => {
    const { context, page, errors } = await openPage(env, { clock: CLOCK, width, path: '#/beds' });
    await page.waitForSelector('[data-test="bed-grid"] .bed');
    assert.equal(await page.locator('main h1').textContent(), 'Bed board');
    assert.equal(await page.locator('.ward-tab').count(), 6);
    assert.equal(await page.locator('[data-test="bed-grid"] .bed').count(), 20);
    assert.ok(await stat(page, 'sum-waiting') >= 1, 'synthetic patients wait for a bed');
    const o = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(o <= 0, `scrolls sideways by ${o}px`);
    assert.deepEqual(errors, []);
    await context.close();
  });
}

test('bed manager allocates a waiting patient, the nurse admits, discharges and cleans: all from the event log', async () => {
  const { context, page, errors } = await openPage(env, { clock: CLOCK, width: 390, path: '#/beds' });
  await page.selectOption('#role-select', 'bed-manager');
  await page.waitForFunction(async () => (await window.ospeli.core.getMeta('role')) === 'bed-manager');
  await page.reload(); // start from a settled render as the bed manager
  await page.waitForSelector('html[data-ready="true"]');
  await page.waitForSelector('[data-find]');
  const waitingBefore = await stat(page, 'sum-waiting');
  const enc = await page.locator('[data-find]').first().getAttribute('data-find');
  // Find a bed: the board jumps to the requested ward and highlights free beds.
  await page.locator('[data-find]').first().click();
  await page.waitForSelector('.banner');
  let freeBed = await page.locator('.bed.match').first().getAttribute('data-bed').catch(() => null);
  if (!freeBed) {
    // No free bed on the requested ward: pick any ward that has one.
    const ward = await page.evaluate(() => [...document.querySelectorAll('.ward-tab')].find((b) => !/\b0 free/.test(b.textContent))?.dataset.ward);
    await page.click(`.ward-tab[data-ward="${ward}"]`);
    freeBed = await page.locator('.bed.match').first().getAttribute('data-bed');
  }
  await page.click(`.bed[data-bed="${freeBed}"]`);
  await page.waitForFunction((b) => document.querySelector(`.bed[data-bed="${b}"]`)?.classList.contains('st-allocated'), freeBed);
  assert.equal(await stat(page, 'sum-waiting'), waitingBefore - 1);
  const allocated = await page.evaluate(async () => (await window.ospeli.core.events({ type: 'bed.allocated' })).at(-1));
  assert.equal(allocated.subject, freeBed);
  assert.equal(allocated.data.encounter, enc);
  assert.equal(allocated.actorRole, 'bed-manager');

  // Ward nurse: patient arrives, goes home, bed is cleaned.
  await page.selectOption('#role-select', 'ward-nurse');
  await page.waitForFunction(async () => (await window.ospeli.core.getMeta('role')) === 'ward-nurse');
  const ward = freeBed.replace(/-bed-\d+$/, '');
  await page.goto(`${env.appUrl}#/beds/${ward}`);
  await page.reload();
  await page.waitForSelector('html[data-ready="true"]');
  await page.waitForSelector(`.bed[data-bed="${freeBed}"]`);
  const step = async (action, expect) => {
    await page.click(`.bed[data-bed="${freeBed}"]`);
    await page.click(`dialog[open] [data-action="${action}"]`);
    await page.waitForFunction(([b, s]) => document.querySelector(`.bed[data-bed="${b}"]`)?.classList.contains(`st-${s}`), [freeBed, expect]);
  };
  await step('admit', 'occupied');
  await step('expect-discharge', 'expected-discharge');
  await step('vacate', 'vacated');
  await step('start-clean', 'cleaning');
  await step('finish-clean', 'available');
  // Out of service needs a reason, and comes back.
  await page.click(`.bed[data-bed="${freeBed}"]`);
  await page.selectOption('dialog[open] #oos-reason', 'Electrical');
  await page.click('dialog[open] [data-action="out-of-service"]');
  await page.waitForFunction((b) => document.querySelector(`.bed[data-bed="${b}"]`)?.classList.contains('st-out-of-service'), freeBed);
  assert.match(await page.locator(`.bed[data-bed="${freeBed}"]`).textContent(), /Electrical/);

  // Survives a reload because state comes only from the stored event log.
  await page.reload();
  await page.waitForSelector('html[data-ready="true"]');
  await page.waitForSelector(`.bed[data-bed="${freeBed}"]`);
  assert.equal(await bedState(page, freeBed), 'out-of-service');
  const types = await page.evaluate(async (b) => (await window.ospeli.core.events()).filter((e) => e.subject === b || e.data?.bedId === b).slice(-8).map((e) => e.type), freeBed);
  assert.deepEqual(types, ['bed.allocated', 'patient.admitted', 'patient.expected-discharge', 'patient.discharged', 'bed.vacated', 'bed.clean-started', 'bed.cleaned', 'bed.out-of-service']);
  assert.match(await page.locator('[data-test="recent"]').textContent(), /out of service · Ward nurse/);
  assert.deepEqual(errors, []);
  await context.close();
});

test('filters, deep link to a ward, and KPI definitions on the board', async () => {
  const { context, page, errors } = await openPage(env, { clock: CLOCK, path: '#/beds/ward-c1' });
  await page.waitForSelector('[data-test="bed-grid"] .bed');
  assert.match(await page.locator('#ward-h').textContent(), /Ward C1/);
  assert.equal(await page.getAttribute('.ward-tab[data-ward="ward-c1"]', 'aria-pressed'), 'true');
  await page.click('[data-filter="occupied"]');
  const shown = await page.locator('[data-test="bed-grid"] .bed').evaluateAll((els) => els.map((e) => e.className));
  assert.ok(shown.every((c) => /st-(occupied|expected-discharge)/.test(c)));
  await page.click('[data-kpi="bed-turnaround"]');
  await page.waitForSelector('dialog[open]');
  assert.match(await page.locator('dialog[open]').textContent(), /vacated to it being cleaned/);
  await page.keyboard.press('Escape');
  // Changing ward updates the address without a reload.
  await page.click('.ward-tab[data-ward="ward-a2"]');
  assert.match(page.url(), /#\/beds\/ward-a2$/);
  assert.deepEqual(errors, []);
  await context.close();
});

test('bed board is keyboard operable', async () => {
  const { context, page } = await openPage(env, { clock: CLOCK, width: 1280, path: '#/beds/ward-a1' });
  await page.waitForSelector('.bed');
  await page.focus('.bed');
  await page.keyboard.press('Enter');
  await page.waitForSelector('dialog[open]');
  assert.ok(await page.evaluate(() => document.querySelector('dialog[open]').contains(document.activeElement)));
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('dialog[open]').count(), 0);
  const unlabelled = await page.evaluate(() => [...document.querySelectorAll('main button, main select')].filter((b) => !(b.getAttribute('aria-label') || b.textContent.trim() || b.labels?.length)).length);
  assert.equal(unlabelled, 0);
  await context.close();
});

test('after a bed action, keyboard focus stays on that bed (issue #11)', async () => {
  const { context, page, errors } = await openPage(env, { clock: CLOCK, width: 1280, path: '#/beds/ward-a1' });
  await page.waitForSelector('.bed');
  const id = await page.locator('.bed').first().getAttribute('data-bed');
  const before = await page.evaluate(() => window.ospeli.core.eventCount());
  await page.focus(`.bed[data-bed="${id}"]`);
  await page.keyboard.press('Enter');
  await page.waitForSelector('dialog[open] [data-action]');
  await page.focus('dialog[open] [data-action]');
  await page.keyboard.press('Enter');
  await page.waitForFunction((n) => window.ospeli.core.eventCount().then((c) => c > n), before);
  await page.waitForFunction((b) => document.activeElement?.dataset?.bed === b, id);
  assert.equal(await page.getAttribute('#toast', 'role'), 'status');
  assert.deepEqual(errors, []);
  await context.close();
});

// Issue #63: on a phone, "Find a bed" must take the user to the choice. The banner comes into view
// below the top bar, focus moves to it (never to <body>), the banner says where the free beds are
// when the shown ward has none, and Cancel hands focus back to the button the user started from.
for (const [width, height] of [[360, 780], [390, 844]]) {
  test(`find a bed at ${width}px: the banner is in view and holds focus; cancel returns focus (issue #63)`, async () => {
    const { context, page, errors } = await openPage(env, { clock: CLOCK, width, height, path: '#/beds' });
    await page.selectOption('#role-select', 'bed-manager');
    await page.waitForFunction(async () => (await window.ospeli.core.getMeta('role')) === 'bed-manager');
    await page.reload();
    await page.waitForSelector('html[data-ready="true"]');
    await page.waitForSelector('[data-find]');
    const first = page.locator('[data-find]').first();
    const enc = await first.getAttribute('data-find');
    await first.focus();
    await page.keyboard.press('Enter'); // the keyboard route; a tap runs the same handler
    await page.waitForSelector('.banner');
    await page.waitForFunction(() => document.activeElement?.classList.contains('banner'));
    const seen = await page.evaluate(() => {
      const r = document.querySelector('.banner').getBoundingClientRect();
      const bar = document.querySelector('.topbar').getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, barBottom: bar.bottom, vh: innerHeight, sideways: document.documentElement.scrollWidth - innerWidth,
        text: document.querySelector('.banner').textContent, match: document.querySelectorAll('.bed.match').length,
        shown: document.querySelector('.ward-tab[aria-pressed="true"]').dataset.ward,
        free: [...document.querySelectorAll('.ward-tab')].filter((b) => b.querySelector('.ward-tab-counts b').textContent !== '0').map((b) => b.dataset.ward) };
    });
    assert.ok(seen.top >= seen.barBottom - 1, `banner top ${seen.top} is under the top bar (${seen.barBottom})`);
    assert.ok(seen.bottom <= seen.vh, `banner bottom ${seen.bottom} is below the screen (${seen.vh})`);
    assert.ok(seen.sideways <= 0, 'no sideways scroll');
    if (seen.match === 0 && seen.free.length) {
      assert.match(seen.text, /No bed is free on/);
      assert.ok(await page.locator('.banner [data-go-ward]').count() >= 1, 'the banner offers the wards that have a free bed');
    } else if (seen.match > 0) {
      assert.match(seen.text, /tap one to allocate/);
    }
    // A tap does the same.
    await page.locator('.banner button', { hasText: 'Cancel' }).click();
    await page.waitForFunction(() => !document.querySelector('.banner'));
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-find')), enc, 'cancel returns focus to the Find a bed button');
    await page.evaluate(() => scrollTo(0, 0));
    await first.tap().catch(() => first.click());
    await page.waitForFunction(() => document.activeElement?.classList.contains('banner'));
    const again = await page.evaluate(() => document.querySelector('.banner').getBoundingClientRect().top);
    assert.ok(again >= 0 && again < height - 60, `banner top ${again} is on screen after a tap`);
    assert.deepEqual(errors, []);
    await context.close();
  });
}

test('find a bed with no free bed on the asked-for ward: the banner names the wards that have one and one tap goes there (issue #63)', async () => {
  const { context, page, errors } = await openPage(env, { clock: CLOCK, width: 390, height: 844, path: '#/beds' });
  await page.selectOption('#role-select', 'bed-manager');
  await page.waitForFunction(async () => (await window.ospeli.core.getMeta('role')) === 'bed-manager');
  await page.reload();
  await page.waitForSelector('html[data-ready="true"]');
  await page.waitForSelector('[data-find]');
  // Make the first ward full (its free beds go out of service, through the same commands the screen uses).
  const full = await page.evaluate(async () => {
    const { runCommand } = await import('./core/commands.js');
    const who = { type: 'human', role: 'bed-manager' };
    const board = await runCommand(window.ospeli.core, 'ospeli_beds_board', { limit: 500 }, who);
    const ward = board.wards[0];
    for (const b of board.beds.filter((x) => x.wardId === ward.id && x.state === 'available')) {
      await runCommand(window.ospeli.core, 'ospeli_beds_take_out_of_service', { bedId: b.id, reason: 'Other', expectedState: 'available' }, who);
    }
    return { id: ward.id };
  });
  await page.waitForFunction((w) => document.querySelector(`.ward-tab[data-ward="${w}"] .ward-tab-counts b`)?.textContent === '0', full.id);
  // Start the pick, then look at the ward that has no free bed.
  await page.locator('[data-find]').first().click();
  await page.waitForSelector('.banner');
  await page.click(`.ward-tab[data-ward="${full.id}"]`);
  await page.waitForFunction(() => /No bed is free on/.test(document.querySelector('.banner')?.textContent || ''));
  const go = page.locator('.banner [data-go-ward]').first();
  const box = await go.boundingBox();
  assert.ok(box.height >= 44, `ward button is ${box.height}px tall`);
  const target = await go.getAttribute('data-go-ward');
  await go.click();
  await page.waitForFunction((w) => document.querySelector('.ward-tab[aria-pressed="true"]')?.dataset.ward === w, target);
  assert.ok(await page.locator('.bed.match').count() >= 1, 'free beds on that ward are highlighted');
  assert.match(await page.locator('.banner').textContent(), /tap one to allocate/);
  assert.deepEqual(errors, []);
  await context.close();
});

// Issue #10: a ward nurse on a phone sees their own ward's beds on the first screen.
for (const [width, height] of [[360, 780], [390, 800]]) {
  test(`ward nurse at ${width} px: my ward's beds are on the first screen, the ward is remembered, the rest of the hospital sits below (issue #10)`, async () => {
    const { context, page, errors } = await openPage(env, { clock: CLOCK, width, height, touch: true });
    await page.selectOption('#role-select', 'ward-nurse');
    await page.waitForFunction(async () => (await window.ospeli.core.getMeta('role')) === 'ward-nurse');
    await page.goto(`${env.appUrl}#/beds`);
    await page.waitForSelector('[data-test="bed-grid"] .bed');
    const box = async (sel) => page.locator(sel).first().boundingBox();
    const first = await box('[data-test="bed-grid"] .bed');
    assert.ok(first.y + first.height <= height, `the first bed ends at ${Math.round(first.y + first.height)} px on a ${height} px screen`);
    // The ward's own counts sit with its name, and the hospital totals and waiting list come after the beds.
    assert.match(await page.textContent('[data-test="ward-counts"]'), /^\d+ free · \d+ to clean · \d+ going home$/);
    const order = await page.evaluate(() => {
      const top = (s) => document.querySelector(s).getBoundingClientRect().top;
      return top('[data-test="bed-grid"]') < top('[data-test="board-summary"]') && top('[data-test="board-summary"]') < top('[data-test="waiting"]');
    });
    assert.ok(order, 'beds, then hospital totals, then the waiting list');
    // Changing ward is one 44 px row; the choice is remembered on this device.
    const change = page.locator('[data-test="change-ward"] > summary');
    assert.ok((await change.boundingBox()).height >= 44);
    assert.ok(parseFloat(await change.evaluate((n) => getComputedStyle(n).fontSize)) >= 15);
    await change.tap();
    await page.locator('.ward-tab[data-ward="ward-b2"]').tap();
    await page.waitForFunction(() => /^Ward B2/.test(document.querySelector('#ward-h').textContent));
    assert.equal(await page.locator('[data-test="change-ward"]').evaluate((d) => d.open), false, 'the ward list closes after a choice');
    const again = await box('[data-test="bed-grid"] .bed');
    assert.ok(again.y + again.height <= height + await page.evaluate(() => scrollY), 'still on the first screen after changing ward');
    assert.equal(await page.evaluate(() => window.ospeli.core.getMeta('my-ward')), 'ward-b2');
    // Today's shortcut opens the board on my ward, also after a reload.
    await page.goto(`${env.appUrl}#/home`);
    await page.reload();
    await page.waitForSelector('html[data-ready="true"]');
    await page.locator('[data-test="role-shortcuts"] a[href="#/beds"]').tap();
    await page.waitForFunction(() => /^Ward B2/.test(document.querySelector('#ward-h')?.textContent || ''));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), 0, 'no sideways scroll');
    // Another role on the same phone keeps the usual order and does not get the nurse's ward.
    await page.selectOption('#role-select', 'bed-manager');
    await page.waitForFunction(async () => (await window.ospeli.core.getMeta('role')) === 'bed-manager');
    await page.goto(`${env.appUrl}#/beds`);
    await page.waitForSelector('[data-test="change-ward"]', { state: 'detached' }); // the board redraws for the new role
    await page.waitForSelector('[data-test="bed-grid"] .bed');
    assert.ok(await page.evaluate(() => document.querySelector('[data-test="waiting"]').getBoundingClientRect().top < document.querySelector('.ward-tabs').getBoundingClientRect().top), 'bed manager: waiting list first');
    assert.match(await page.textContent('#ward-h'), /^Ward A1/);
    assert.deepEqual(errors, []);
    await context.close();
  });
}

test('ward nurse at 1280 px: the desktop bed board keeps its order (issue #10)', async () => {
  const { context, page, errors } = await openPage(env, { clock: CLOCK, width: 1280 });
  await page.selectOption('#role-select', 'ward-nurse');
  await page.waitForFunction(async () => (await window.ospeli.core.getMeta('role')) === 'ward-nurse');
  await page.goto(`${env.appUrl}#/beds`);
  await page.waitForSelector('[data-test="bed-grid"] .bed');
  assert.equal(await page.locator('[data-test="change-ward"]').count(), 0);
  assert.equal(await page.locator('[data-test="ward-counts"]').count(), 0);
  const tops = await page.evaluate(() => ['[data-test="board-summary"]', '[data-test="waiting"]', '.ward-tabs', '[data-test="bed-grid"]'].map((s) => document.querySelector(s).getBoundingClientRect().top));
  assert.deepEqual(tops, [...tops].sort((a, b) => a - b), 'totals, waiting list, ward tabs, beds');
  assert.deepEqual(errors, []);
  await context.close();
});
