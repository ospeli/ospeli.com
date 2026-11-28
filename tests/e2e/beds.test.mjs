import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, openPage, setRole, waitUntil } from './helpers.mjs';

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

test('patient flow coordinator allocates a waiting patient, the nurse admits, discharges and cleans: all from the event log', async () => {
  const { context, page, errors } = await openPage(env, { clock: CLOCK, width: 390, path: '#/beds' });
  await setRole(page, 'bed-manager');
  await waitUntil(page, async () => (await window.ospeli.core.getMeta('role')) === 'bed-manager');
  await page.reload(); // start from a settled render as the patient flow coordinator
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
  await setRole(page, 'ward-nurse');
  await waitUntil(page, async () => (await window.ospeli.core.getMeta('role')) === 'ward-nurse');
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
  await waitUntil(page, async (n) => (await window.ospeli.core.eventCount()) > n, before);
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
    await setRole(page, 'bed-manager');
    await waitUntil(page, async () => (await window.ospeli.core.getMeta('role')) === 'bed-manager');
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
  await setRole(page, 'bed-manager');
  await waitUntil(page, async () => (await window.ospeli.core.getMeta('role')) === 'bed-manager');
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
    await setRole(page, 'ward-nurse');
    await waitUntil(page, async () => (await window.ospeli.core.getMeta('role')) === 'ward-nurse');
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
    // The card on Now opens the board on my ward, also after a reload.
    await page.goto(`${env.appUrl}#/home`);
    await page.reload();
    await page.waitForSelector('html[data-ready="true"]');
    await page.locator('[data-test="role-shortcuts"] a[href="#/beds"]').tap();
    await page.waitForFunction(() => /^Ward B2/.test(document.querySelector('#ward-h')?.textContent || ''));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), 0, 'no sideways scroll');
    // Another role on the same phone keeps the usual order and does not get the nurse's ward.
    await setRole(page, 'bed-manager');
    await waitUntil(page, async () => (await window.ospeli.core.getMeta('role')) === 'bed-manager');
    await page.goto(`${env.appUrl}#/beds`);
    await page.waitForSelector('[data-test="change-ward"]', { state: 'detached' }); // the board redraws for the new role
    await page.waitForSelector('[data-test="bed-grid"] .bed');
    assert.ok(await page.evaluate(() => document.querySelector('[data-test="waiting"]').getBoundingClientRect().top < document.querySelector('.ward-tabs').getBoundingClientRect().top), 'patient flow coordinator: waiting list first');
    assert.match(await page.textContent('#ward-h'), /^Ward A1/);
    assert.deepEqual(errors, []);
    await context.close();
  });
}

test('ward nurse at 1280 px: the desktop bed board keeps its order (issue #10)', async () => {
  const { context, page, errors } = await openPage(env, { clock: CLOCK, width: 1280 });
  await setRole(page, 'ward-nurse');
  await waitUntil(page, async () => (await window.ospeli.core.getMeta('role')) === 'ward-nurse');
  await page.goto(`${env.appUrl}#/beds`);
  await page.waitForSelector('[data-test="bed-grid"] .bed');
  assert.equal(await page.locator('[data-test="change-ward"]').count(), 0);
  assert.equal(await page.locator('[data-test="ward-counts"]').count(), 0);
  const tops = await page.evaluate(() => ['[data-test="board-summary"]', '[data-test="waiting"]', '.ward-tabs', '[data-test="bed-grid"]'].map((s) => document.querySelector(s).getBoundingClientRect().top));
  assert.deepEqual(tops, [...tops].sort((a, b) => a - b), 'totals, waiting list, ward tabs, beds');
  assert.deepEqual(errors, []);
  await context.close();
});

// Issue #12: one tap still allocates, a double tap does nothing more, and a mis-tap is one tap to undo.
for (const [width, height] of [[360, 780], [390, 844]]) {
  test(`find a bed at ${width} px: a double tap allocates once and opens no dialog; Undo frees the bed and starts the choice again (issue #12)`, async () => {
    const { context, page, errors } = await openPage(env, { clock: CLOCK, width, height, touch: true, path: '#/beds' });
    await setRole(page, 'bed-manager');
    await waitUntil(page, async () => (await window.ospeli.core.getMeta('role')) === 'bed-manager');
    await page.reload();
    await page.waitForSelector('html[data-ready="true"]');
    await page.waitForSelector('[data-find]');
    const count = (type) => page.evaluate(async (t) => (await window.ospeli.core.events({ type: t })).length, type);
    const [allocBefore, cancelBefore, waitingBefore] = [await count('bed.allocated'), await count('bed.allocation-cancelled'), await stat(page, 'sum-waiting')];
    const enc = await page.locator('[data-find]').first().getAttribute('data-find');
    await page.locator('[data-find]').first().tap();
    await page.waitForSelector('.bed.match');
    const bed = await page.locator('.bed.match').first().getAttribute('data-bed');
    // A double tap: two taps on the same spot, 120 ms apart.
    const r = await page.locator(`.bed[data-bed="${bed}"]`).boundingBox();
    await page.touchscreen.tap(r.x + r.width / 2, r.y + r.height / 2);
    await page.waitForTimeout(120);
    await page.touchscreen.tap(r.x + r.width / 2, r.y + r.height / 2);
    await page.waitForFunction((b) => document.querySelector(`.bed[data-bed="${b}"]`)?.classList.contains('st-allocated'), bed);
    await page.waitForTimeout(700);
    assert.equal(await count('bed.allocated'), allocBefore + 1, 'one allocation');
    assert.equal(await page.locator('dialog[open]').count(), 0, 'the second tap opens no dialog');
    // The page says what was held and offers Undo, in the page (not in a toast that covers controls).
    const held = page.locator('[data-test="held"]');
    assert.match(await held.innerText(), /^Ward [A-Z]\d Bed \d+ is held for Patient \d+\./);
    const undo = held.getByRole('button', { name: /^Undo/ });
    const ub = await undo.boundingBox();
    assert.ok(ub.height >= 44 && ub.width >= 44, 'Undo is a 44 px target');
    assert.ok(parseFloat(await held.evaluate((n) => getComputedStyle(n).fontSize)) >= 15);
    assert.ok(ub.y >= 0 && ub.y + ub.height <= height, 'Undo is on screen without scrolling');
    await undo.tap();
    await page.waitForFunction((b) => document.querySelector(`.bed[data-bed="${b}"]`)?.classList.contains('st-available'), bed);
    assert.equal(await count('bed.allocation-cancelled'), cancelBefore + 1, 'Undo is recorded as a cancelled allocation, nothing is erased');
    assert.equal(await stat(page, 'sum-waiting'), waitingBefore);
    // The choice starts again for the same patient, and the held notice is gone.
    await page.waitForSelector('.banner');
    assert.match(await page.locator('.banner').innerText(), /^Choose a bed for/);
    assert.equal(await page.locator(`[data-find="${enc}"]`).innerText(), 'Cancel');
    assert.equal(await page.locator('[data-test="held"]').count(), 0);
    // After the guard time a tap on another free bed allocates as usual.
    await page.waitForTimeout(700);
    await page.locator('.bed.match').first().tap();
    await page.waitForSelector('[data-test="held"]');
    assert.equal(await count('bed.allocated'), allocBefore + 2);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), 0, 'no sideways scroll');
    assert.deepEqual(errors, []);
    await context.close();
  });
}

// Issue #90: what a screen reader or voice control hears is what the screen shows.
// Every piece of text on the button is in its spoken name (WCAG 2.5.3), the bed's name includes
// who is in it, one word per bed state on the tile and in the dialog, and a bed that is not a
// match in Find a bed is still a live button, so its text stays at 4.5:1 or better.
const spokenVsShown = (page, sel) => page.evaluate((s) => [...document.querySelectorAll(s)].map((el) => {
  const shown = []; const tw = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let n; (n = tw.nextNode());) { if (n.textContent.trim() && !n.parentElement.closest('.sr-only')) shown.push(n.textContent.trim()); }
  const name = (el.getAttribute('aria-label') ?? el.textContent).replace(/\s+/g, ' ');
  return { name, shown, missing: shown.filter((t) => !name.toLowerCase().includes(t.replace(/\s+/g, ' ').toLowerCase())) };
}), sel);

test('issue #90: bed and work-order buttons are announced with the words on them, including the patient reference; one word per bed state', async () => {
  const { context, page, errors } = await openPage(env, { width: 390, height: 844, path: '#/beds', clock: CLOCK });
  await page.waitForSelector('.bed');
  // Every state on one ward, so each state's word is checked.
  await page.evaluate(async () => {
    const { runCommand, ACTION_COMMANDS } = await import('./core/commands.js');
    const core = window.ospeli.core; const p = { type: 'human', role: 'bed-manager' };
    const board = await runCommand(core, 'ospeli_beds_board', {}, p);
    const ward = document.querySelector('.bed').dataset.bed.replace(/-bed-\d+$/, '');
    const occ = board.beds.filter((b) => b.wardId === ward && b.state === 'occupied');
    const go = async (bed, ...actions) => { for (const a of actions) await runCommand(core, ACTION_COMMANDS[a], { bedId: bed.id, ...(a === 'expect-discharge' ? { expectedAt: new Date(Date.now() + 3 * 3600e3).toISOString() } : a === 'out-of-service' ? { reason: 'Electrical' } : {}) }, p); };
    await go(occ[0], 'expect-discharge'); await go(occ[1], 'vacate'); await go(occ[2], 'vacate', 'start-clean'); await go(occ[3], 'vacate', 'finish-clean', 'out-of-service');
  });
  await page.waitForFunction(() => document.querySelector('.bed.st-out-of-service') && document.querySelector('.bed.st-cleaning') && document.querySelector('.bed.st-expected-discharge'));
  const beds = await spokenVsShown(page, '.bed');
  assert.ok(beds.length >= 10);
  assert.deepEqual(beds.filter((b) => b.missing.length).map((b) => `${b.name} | not spoken: ${b.missing.join(', ')}`), []);
  for (const b of beds) assert.match(b.name, /^Bed \d+/, b.name);
  assert.ok(beds.some((b) => /Patient \d+/.test(b.name)), 'the patient reference is in the spoken name');
  assert.ok(beds.some((b) => /Going home/.test(b.name)) && beds.some((b) => /To clean/.test(b.name)));
  // One word per state: the dialog's chip says what the tile's chip says.
  for (const st of ['expected-discharge', 'vacated', 'cleaning', 'out-of-service', 'occupied']) {
    const tile = page.locator(`.bed.st-${st}`).first();
    const word = (await tile.locator('.chip').innerText()).trim();
    await tile.evaluate((b) => b.click());
    await page.waitForSelector('dialog.bed-dialog[open]');
    assert.equal((await page.locator('dialog.bed-dialog .bed-dlg-state .chip').innerText()).trim(), word, `the dialog for a ${st} bed`);
    await page.keyboard.press('Escape');
    await page.waitForSelector('dialog.bed-dialog[open]', { state: 'detached' }).catch(() => page.waitForFunction(() => !document.querySelector('dialog.bed-dialog[open]')));
  }
  // Work orders: the same rule.
  await page.evaluate(() => { location.hash = '#/engineering'; });
  await page.waitForSelector('button[data-wo]');
  const rows = await spokenVsShown(page, 'button[data-wo]');
  assert.ok(rows.length >= 3);
  assert.deepEqual(rows.filter((b) => b.missing.length).map((b) => `${b.name} | not spoken: ${b.missing.join(', ')}`), []);
  assert.deepEqual(errors, []);
  await context.close();
});

for (const width of [390, 1280]) {
  test(`issue #90: in Find a bed, beds that are not a match stay readable at 4.5:1 and are not faded (${width}px)`, async () => {
    const { context, page, errors } = await openPage(env, { width, height: 844, path: '#/beds', clock: CLOCK });
    // The charge nurse's board has "Find a bed" too. Wait for the coordinator's own board before tapping,
    // so the tap and every check below are on the page the role change opens (the page is swapped
    // sooner since ospeli/ospeli#153, and a tap on the page being replaced did nothing).
    await page.evaluate(() => { for (const el of document.querySelector('main').children) el.dataset.stale = 'true'; });
    await setRole(page, 'bed-manager');
    await page.waitForFunction(() => !document.querySelector('main > [data-stale]') && document.querySelector('main [data-find]'));
    await page.locator('[data-find]').first().evaluate((b) => b.click());
    await page.waitForSelector('.bed.dim');
    const worst = await page.evaluate(() => {
      const rgb = (c) => (c.match(/[\d.]+/g) || []).map(Number);
      const lum = ([r, g, b]) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
      const over = (fg, bg, a) => fg.slice(0, 3).map((v, i) => v * a + bg[i] * (1 - a));
      // The colour behind a node: the nearest ancestor with a solid background.
      const behind = (el) => { for (let e = el; e; e = e.parentElement) { const c = rgb(getComputedStyle(e).backgroundColor); if (c.length === 3 || c[3] === 1) return c.slice(0, 3); } return [255, 255, 255]; };
      const page = behind(document.querySelector('.bed-grid'));
      let low = { ratio: 99 };
      for (const bed of document.querySelectorAll('.bed.dim')) {
        const fade = parseFloat(getComputedStyle(bed).opacity);
        for (const el of bed.querySelectorAll('.bed-no, .bed-age, .chip, .bed-who, .bed-tag')) {
          if (!el.textContent.trim()) continue;
          // Opacity on the tile fades text and background together into the page behind it.
          const bg = over(behind(el), page, fade); const fg = over(rgb(getComputedStyle(el).color), page, fade);
          const [a, b] = [lum(fg), lum(bg)].sort((x, y) => y - x);
          const ratio = (a + 0.05) / (b + 0.05);
          if (ratio < low.ratio) low = { ratio: Math.round(ratio * 100) / 100, what: el.className, text: el.textContent.trim(), fade };
        }
      }
      return { low, dim: document.querySelectorAll('.bed.dim').length, match: document.querySelectorAll('.bed.match').length };
    });
    assert.ok(worst.dim > 0);
    assert.ok(worst.low.ratio >= 4.5, `lowest contrast on a bed that is not a match: ${JSON.stringify(worst.low)}`);
    // A match still stands out from the rest. The fixed clock's hospital always has one, so this
    // check always runs (#95).
    assert.ok(worst.match > 0, 'at least one bed matches');
    const [m, d] = await page.evaluate(() => [getComputedStyle(document.querySelector('.bed.match')).backgroundColor, getComputedStyle(document.querySelector('.bed.dim')).backgroundColor]);
    assert.notEqual(m, d);
    assert.deepEqual(errors, []);
    await context.close();
  });
}

// Adoption check (ospeli/ospeli#112): the manager's first five minutes, untrained, on a phone.
// The patient flow coordinator opens the app on a touch phone, reaches the bed board in one tap,
// sees how many wait on the first screen, and places the first waiting patient.
test('the patient flow coordinator\'s first five minutes on a 390 px phone: one tap to the bed board, sees the waiting count first, and places a patient', async () => {
  const { context, page, errors } = await openPage(env, { clock: CLOCK, width: 390, height: 844, touch: true, path: '' });
  await setRole(page, 'bed-manager');
  await waitUntil(page, async () => (await window.ospeli.core.getMeta('role')) === 'bed-manager');
  await page.goto(env.appUrl);
  await page.waitForSelector('html[data-ready="true"]');
  // The first roles open on Now, with their pages first on a phone (issue #10): the bed
  // board is one tap away on the first screen.
  const shortcut = page.locator('[data-test="role-shortcuts"] a[href^="#/beds"]').first();
  await shortcut.waitFor();
  const sc = await shortcut.boundingBox();
  assert.ok(sc.y + sc.height <= 844 && sc.height >= 44, `the bed board shortcut is a 44 px target on the first screen (${Math.round(sc.y)}, ${Math.round(sc.height)} px)`);
  await shortcut.tap();
  await page.waitForSelector('[data-find]');
  assert.match(await page.evaluate(() => location.hash), /^#\/beds/);
  // The area's status on the first screen.
  const waiting = await stat(page, 'sum-waiting');
  assert.ok(waiting >= 1);
  const box = await page.locator('[data-test="sum-waiting"]').boundingBox();
  assert.ok(box && box.y < 844, `the waiting count is on the first screen (top at ${Math.round(box?.y)} px)`);
  const find = await page.locator('[data-find]').first().boundingBox();
  assert.ok(find.height >= 44, `Find a bed is a 44 px target (${Math.round(find.height)} px)`);
  // Act: find a bed for the first waiting patient and place them, in taps.
  await page.locator('[data-find]').first().tap();
  await page.waitForSelector('.banner');
  let freeBed = await page.locator('.bed.match').first().getAttribute('data-bed').catch(() => null);
  if (!freeBed) {
    const ward = await page.evaluate(() => [...document.querySelectorAll('.ward-tab')].find((b) => !/\b0 free/.test(b.textContent))?.dataset.ward);
    await page.locator(`.ward-tab[data-ward="${ward}"]`).tap();
    freeBed = await page.locator('.bed.match').first().getAttribute('data-bed');
  }
  await page.locator(`.bed[data-bed="${freeBed}"]`).tap();
  await page.waitForFunction((b) => document.querySelector(`.bed[data-bed="${b}"]`)?.classList.contains('st-allocated'), freeBed);
  assert.equal(await stat(page, 'sum-waiting'), waiting - 1);
  const ev = await page.evaluate(async () => (await window.ospeli.core.events({ type: 'bed.allocated' })).at(-1));
  assert.deepEqual([ev.subject, ev.actorRole], [freeBed, 'bed-manager']);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth) <= 0, 'no sideways scroll');
  assert.deepEqual(errors, []);
  await context.close();
});
