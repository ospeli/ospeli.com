// The walk ribbon (issue #179; ospeli/ospeli docs/design/navigation-v2.md "Walk ribbon"): while a
// walk runs, every page but the walk itself shows a navy band above the dock with the steps, the
// state in words, a clock and the next tap. Checked at 360 by 640 and 390 by 844 on a touch phone.
// Synthetic hospital; the page's clock is moved by the test.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, openPage } from './helpers.mjs';

let env;
before(async () => { env = await startApp(); });
after(async () => { await env.close(); });

const route = (page, h) => page.waitForFunction((x) => document.documentElement.dataset.route === x, h);
const go = async (page, h) => { await page.evaluate((x) => { location.hash = x; }, h); await route(page, h); };
const walkNow = (page) => page.evaluate(async () => {
  const { runCommand } = await import('./core/commands.js');
  return (await runCommand(window.ospeli.core, 'ospeli_walks_get', {}, { type: 'human', role: 'radiographer' })).walk;
});
const ribbonShown = (page) => page.evaluate(() => { const r = document.querySelector('#walk-ribbon'); return !!r && !r.hidden && r.getBoundingClientRect().height > 0; });

// Start a walk and time one step, then leave it running. Since the tap-through walk sheet (27 Nov
// 2026) the main button names the step it starts from the department's list ("Arrived"), so the
// step is named with no extra tap and one line says what it was saved as (before: a naming sheet
// and two chip taps).
async function walkOneStep(page) {
  await go(page, '#/process');
  await page.waitForSelector('[data-test="walk-start"]');
  await page.tap('[data-test="walk-start"]'); await page.tap('[data-test="walk-before-ok"]');
  await page.waitForSelector('[data-test="walk"][data-state="waiting"]');
  await page.clock.fastForward(60000);
  await page.tap('[data-test="walk-main"]'); await page.waitForSelector('[data-test="walk"][data-state="step"]');
  await page.clock.fastForward(90000);
  await page.tap('[data-test="walk-main"]'); await page.waitForSelector('[data-test="walk"][data-state="waiting"]');
  await page.waitForSelector('[data-test="walk-flash"]');
  assert.equal(await page.locator('[data-test="walk-sheet"]').count(), 0, 'a list step needs no naming sheet');
  const named = (await page.evaluate(async () => (await window.ospeli.core.getMeta('process-walks'))?.walks || []))[0].steps[0];
  assert.deepEqual([named.name, named.role], ['Arrived', 'Patient'], 'the step is named, as it was after the two chip taps');
  assert.equal(await ribbonShown(page), false, 'no ribbon on the walk itself');
  await page.tap('[data-test="walk-leave"]');
  await route(page, '#/home');
}

for (const [width, height] of [[360, 640], [390, 844]]) {
  test(`${width}x${height}: the ribbon shows a running walk on every page, clear of the dock and of the page's last line, with a clock that runs`, async () => {
    const { page, context, errors } = await openPage(env, { width, height, touch: true, department: 'imaging', clock: '2026-11-17T09:00:00Z' });
    assert.equal(await ribbonShown(page), false, 'no ribbon when no walk runs');
    assert.equal(await page.getAttribute('#dock .dock-walk', 'aria-label'), null);
    await walkOneStep(page);
    for (const h of ['#/home', '#/journey', '#/process', '#/me', '#/beds', '#/clinics', '#/engineering']) {
      await go(page, h);
      await page.waitForFunction(() => { const r = document.querySelector('#walk-ribbon'); return r && !r.hidden; });
      const look = await page.evaluate(() => {
        const r = document.querySelector('#walk-ribbon').getBoundingClientRect();
        const walk = document.querySelector('#dock .dock-walk').getBoundingClientRect();
        const px = (sel) => parseFloat(getComputedStyle(document.querySelector(sel)).fontSize);
        return { top: r.top, bottom: r.bottom, walkTop: walk.top, title: document.querySelector('[data-test="ribbon-title"]').textContent,
          step: document.querySelector('[data-test="ribbon-step"]').textContent, words: document.querySelector('[data-test="ribbon-words"]').textContent,
          clock: document.querySelector('[data-test="ribbon-clock"]').textContent, act: document.querySelector('[data-test="ribbon-act"]').getBoundingClientRect().height,
          open: document.querySelector('[data-test="ribbon-open"]').getBoundingClientRect().height, text: px('[data-test="ribbon-words"]'), btnText: px('[data-test="ribbon-act"]') };
      });
      assert.ok(look.bottom <= look.walkTop, `${h}: the ribbon (to ${look.bottom}) is above the dock's Walk (from ${look.walkTop})`);
      assert.equal(look.title, 'Walk 1'); assert.equal(look.step, ' · step 2'); assert.equal(look.words, 'Waiting');
      assert.match(look.clock, /^\d+:\d{2}$/);
      assert.ok(look.act >= 44 && look.open >= 44, `${h}: 44 px targets (${look.act}, ${look.open})`);
      assert.ok(look.text >= 15 && look.btnText >= 15, `${h}: 15 px words`);
      // Nothing that is the page's own sits under the ribbon once the page is scrolled to its end.
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      const lastBottom = await page.evaluate(() => {
        const kids = [...document.querySelectorAll('#main *')].filter((e) => e.checkVisibility() && e.getClientRects().length && getComputedStyle(e).position !== 'fixed');
        return Math.max(...kids.map((e) => e.getBoundingClientRect().bottom));
      });
      const top = await page.evaluate(() => document.querySelector('#walk-ribbon').getBoundingClientRect().top);
      assert.ok(lastBottom <= top + 1, `${h}: the page's last line ends at ${lastBottom}, the ribbon starts at ${top}`);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${h}: no sideways scroll`);
    }
    // The clock ticks every second and the dock's Walk says the walk runs.
    const c1 = await page.textContent('[data-test="ribbon-clock"]');
    await page.clock.fastForward(3000);
    await page.waitForFunction((c) => document.querySelector('[data-test="ribbon-clock"]').textContent !== c, c1);
    assert.equal(await page.getAttribute('#dock .dock-walk', 'aria-label'), 'Walk, running');
    assert.equal((await page.textContent('#dock .dock-walk .dock-word')).trim(), 'Running');
    assert.equal(await page.locator('#dock .dock-walk .dock-live').count(), 1);
    // The clock is not read out every second: only the status line is live.
    assert.equal(await page.getAttribute('[data-test="ribbon-clock"]', 'aria-live'), null);
    assert.equal(await page.locator('#walk-ribbon [aria-live]').count(), 1);
    assert.deepEqual(errors, []);
    await context.close();
  });
}

test('390 px: a tap on the band opens the walk; the button does the next tap through the walk\'s own commands; gone on the walk and after it ends', async () => {
  const { page, context, errors } = await openPage(env, { width: 390, height: 844, touch: true, department: 'imaging', clock: '2026-11-17T09:00:00Z' });
  await walkOneStep(page);
  await go(page, '#/journey');
  // The band opens the walk.
  await page.locator('[data-test="ribbon-open"]').tap();
  await route(page, '#/process/walk');
  await page.waitForSelector('[data-test="walk"]');
  assert.equal(await ribbonShown(page), false, 'hidden on the walk page');
  await page.tap('[data-test="walk-leave"]'); await route(page, '#/home');
  // The ribbon starts the step the walk's list offers next, by name, as the walk screen's main
  // button does (crew night 6 item 1; was "Step starts" and "Hands-on: step 2"): hands-on, step 2.
  await page.clock.fastForward(30000);
  assert.equal((await page.textContent('[data-test="ribbon-act"]')).trim(), 'Registered starts');
  await page.locator('[data-test="ribbon-act"]').tap();
  await page.waitForFunction(() => document.querySelector('[data-test="ribbon-words"]')?.textContent === 'Hands-on: Registered');
  let w = await walkNow(page);
  assert.equal(w.state, 'step');
  assert.equal(w.steps.length, 1);
  assert.match(await page.textContent('[data-test="ribbon-status"]'), /Registered started/);
  const segs = await page.locator('#walk-ribbon .wr-seg').evaluateAll((s) => s.map((x) => x.className));
  assert.deepEqual(segs, ['wr-seg is-done', 'wr-seg is-step']);
  // "Registered done": the list step is named already, so the tap is stamped and the page stays, as
  // on the walk screen (crew night 6 item 1; was "Step done", then the walk opened with its naming
  // sheet: that path, for a walk with no list, is in shell-n6.test.mjs). Then the walk is opened.
  await page.clock.fastForward(45000);
  assert.equal((await page.textContent('[data-test="ribbon-act"]')).trim(), 'Registered done');
  await page.locator('[data-test="ribbon-act"]').tap();
  await page.waitForFunction(() => document.querySelector('[data-test="ribbon-words"]')?.textContent === 'Waiting');
  await page.locator('[data-test="ribbon-open"]').tap();
  await route(page, '#/process/walk');
  await page.waitForSelector('[data-test="walk"]');
  w = await walkNow(page);
  assert.equal(w.state, 'waiting'); assert.equal(w.steps.length, 2); assert.equal(w.steps[1].workSec, 45);
  // Paused: "I am back" from the ribbon.
  await page.tap('[data-test="walk-pause"]'); await page.waitForSelector('[data-test="walk"][data-state="paused"]');
  await page.tap('[data-test="walk-leave"]'); await route(page, '#/home');
  assert.equal(await page.textContent('[data-test="ribbon-words"]'), 'Paused');
  assert.equal((await page.textContent('[data-test="ribbon-act"]')).trim(), 'I am back');
  await page.locator('[data-test="ribbon-act"]').tap();
  await page.waitForFunction(() => document.querySelector('[data-test="ribbon-words"]')?.textContent === 'Waiting');
  assert.equal((await walkNow(page)).state, 'waiting');
  // Finish the walk on the walk page: the ribbon and the running mark are gone.
  await page.locator('[data-test="ribbon-open"]').tap(); await route(page, '#/process/walk');
  await page.waitForSelector('[data-test="walk"]');
  await page.tap('[data-test="walk-finish"]'); await page.tap('[data-test="walk-finish-yes"]');
  await page.waitForSelector('[data-test="walk-answer"]');
  assert.equal(await ribbonShown(page), false, 'no ribbon once the walk is finished');
  assert.equal(await page.getAttribute('#dock .dock-walk', 'aria-label'), null);
  assert.equal((await page.textContent('#dock .dock-walk .dock-word')).trim(), 'Walk');
  await go(page, '#/home');
  assert.equal(await ribbonShown(page), false);
  assert.deepEqual(errors, []);
  await context.close();
});

for (const [width, height] of [[360, 640], [390, 844]]) test(`${width}x${height}: "Walk it again" on the result is clear of the dock on the first screen (#179 item 4)`, async () => {
  const { page, context, errors } = await openPage(env, { width, height, touch: true, department: 'imaging', clock: '2026-11-17T09:00:00Z' });
  await walkOneStep(page);
  await page.locator('[data-test="ribbon-open"]').tap(); await route(page, '#/process/walk');
  await page.waitForSelector('[data-test="walk"]');
  await page.tap('[data-test="walk-finish"]'); await page.tap('[data-test="walk-finish-yes"]');
  await page.waitForSelector('[data-test="walk-again"]');
  const r = await page.evaluate(() => {
    const b = document.querySelector('[data-test="walk-again"]').getBoundingClientRect();
    const d = document.querySelector('#dock').getBoundingClientRect(); const w = document.querySelector('#dock .dock-walk').getBoundingClientRect();
    return { top: b.top, bottom: b.bottom, x: b.left + b.width / 2, y: b.top + b.height / 2, dockTop: Math.min(d.top, w.top), hit: !!document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2)?.closest('[data-test="walk-again"]') };
  });
  assert.ok(r.bottom <= r.dockTop, `the button (to ${r.bottom}) ends above the dock (from ${r.dockTop})`);
  assert.equal(r.hit, true, 'a tap on the button reaches it');
  assert.deepEqual(errors, []);
  await context.close();
});
