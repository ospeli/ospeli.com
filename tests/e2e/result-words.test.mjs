// The result of a walk on a phone (walk-first week, crew night 2): the longest wait is on the first
// screen, whole minutes and "1 h 49 min", "at least" only after a pause during that wait, one
// "How to read this", and "Walk the next patient" on the map and in the list of maps, which starts
// a repeat walk. Staged walks with synthetic times; the page's clock is moved by the test.
// Since the one-screen result (crew night 3) "Walk the next patient" sits in the Result tab's
// actions row, and the step list with each step's wait is on the "Edit map" tab.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, openPage } from './helpers.mjs';

let env;
before(async () => { env = await startApp(); });
after(async () => { await env.close(); });

const state = (page, s) => page.waitForSelector(`[data-test="walk"][data-state="${s}"]`);
const DOCK = 96;

async function walk(page, steps, { pauseBefore = null } = {}) {
  await page.waitForSelector('[data-test="walk-start"]');
  await page.tap('[data-test="walk-start"]'); await page.tap('[data-test="walk-before-ok"]');
  await page.waitForSelector('[data-test="walk"]');
  for (const [i, [name, role, wait, work]] of steps.entries()) {
    if (pauseBefore === i) {
      // Half the wait, then the person walking steps out for 5 minutes, then the rest of the wait.
      await page.clock.fastForward((wait / 2) * 1000);
      await page.tap('[data-test="walk-pause"]'); await state(page, 'paused');
      await page.clock.fastForward(300 * 1000);
      await page.tap('[data-test="walk-main"]'); await state(page, 'waiting');
      await page.clock.fastForward((wait / 2) * 1000);
    } else await page.clock.fastForward(wait * 1000);
    await page.tap('[data-test="walk-main"]'); await state(page, 'step');
    await page.clock.fastForward(work * 1000);
    await page.tap('[data-test="walk-main"]'); await page.waitForSelector('[data-test="walk-sheet"]');
    await page.tap(`[data-chip="name"]:text-is("${name}")`); await page.tap(`[data-chip="role"]:text-is("${role}")`);
    await page.waitForFunction(() => !document.querySelector('[data-test="walk-sheet"]'));
  }
  await page.tap('[data-test="walk-finish"]'); await page.tap('[data-test="walk-finish-yes"]');
  await page.waitForSelector('[data-test="walk-answer"]');
}

// Waits 120, 3900 (1 h 5 min), 600 s; hands-on 300, 900, 240 s: 1 h 41 min in all.
const LONG = [['Checked in at reception', 'Reception', 120, 300], ['Seen by a nurse', 'Nurse', 3900, 900], ['Seen by a doctor', 'Doctor', 600, 240]];

for (const [width, height] of [[390, 844], [360, 640]]) {
  test(`${width} by ${height}: the longest wait is on the first screen, in whole minutes, with no "at least" on a walk that was never paused`, async () => {
    const { context, page, errors } = await openPage(env, { width, height, path: '#/process', touch: true, locale: 'en-GB', timezoneId: 'UTC', clock: '2026-11-20T08:00:00Z' });
    await walk(page, LONG);
    await page.evaluate(() => window.scrollTo(0, 0));
    const look = await page.evaluate(() => {
      const r = (sel) => document.querySelector(sel).getBoundingClientRect();
      return { head: document.querySelector('[data-test="walk-longest"]').innerText.replace(/\s+/g, ' '), headBottom: r('[data-test="walk-longest"]').bottom,
        firstInAnswer: document.querySelector('[data-test="walk-answer"]').firstElementChild.dataset.test,
        btnBottom: r('[data-test="result-actions"] [data-test="walk-again"]').bottom, btnH: r('[data-test="result-actions"] [data-test="walk-again"]').height, btnW: r('[data-test="result-actions"] [data-test="walk-again"]').width,
        answerW: r('[data-test="walk-answer"]').width, vh: innerHeight };
    });
    assert.equal(look.firstInAnswer, 'walk-longest', 'the headline is the first thing in the result');
    assert.equal(look.head, 'Longest wait: 1 h 5 min before “Seen by a nurse”');
    assert.ok(look.headBottom <= look.vh - DOCK, `the headline ends at ${Math.round(look.headBottom)} px, above the dock (${look.vh - DOCK})`);
    assert.ok(look.btnH >= 44 && look.btnW >= look.answerW - 60, `"Walk the next patient" is a full-width button (${Math.round(look.btnW)} of ${Math.round(look.answerW)} px, ${Math.round(look.btnH)} px high)`);
    if (height >= 844) assert.ok(look.btnBottom <= look.vh - DOCK, `on a 390 by 844 phone the button is on the first screen too (${Math.round(look.btnBottom)})`);
    const answer = (await page.locator('[data-test="walk-answer"]').innerText()).replace(/\s+/g, ' ');
    assert.match(answer, /1 h 41 min start to finish on this walk/);
    assert.match(answer, /1 h 17 min waiting \(76% of this walk\) · 24 min hands-on/);
    const all = (await page.textContent('[data-test="process-body"]')).replace(/\s+/g, ' ');
    assert.doesNotMatch(all, /at least/i, 'the walk was never paused');
    assert.doesNotMatch(all, /\d h \d+\b(?! min)/, 'hours always say min');
    assert.doesNotMatch(all, /\d+ min \d+ s\b/, 'no seconds on the result');
    // One place for every caveat and definition, one tap away.
    assert.equal(await page.getByText('How to read this', { exact: true }).count(), 1);
    const read = page.locator('[data-test="read-this"]');
    assert.equal(await read.evaluate((d) => d.open), false);
    await read.locator('summary').tap();
    const kept = (await read.innerText()).replace(/\s+/g, ' ');
    for (const rx of [/One walk, one observation/, /Waiting is not always waste/, /This is what happened once/, /Example setting, not a standard/, /Waiting share: waiting divided by start to finish/]) assert.match(kept, rx);
    assert.equal(await page.locator('[data-test="walk-answer"] .wa-note, [data-test="walk-answer"] [data-test="walk-waste"]').evaluateAll((els) => els.every((e) => e.closest('details'))), true, 'no caveat outside "How to read this"');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no sideways scroll');
    assert.deepEqual(errors, []);
    await context.close();
  });
}

test('390 px: after a pause during the longest wait, "at least", never "at least under"; the paused wait is said on its step', async () => {
  const { context, page, errors } = await openPage(env, { width: 390, height: 844, path: '#/process', touch: true, locale: 'en-GB', timezoneId: 'UTC', clock: '2026-11-20T08:00:00Z' });
  // 600 s seen before the nurse, 300 s of it not seen (paused); 240 s before the doctor.
  await walk(page, [['Checked in at reception', 'Reception', 60, 120], ['Seen by a nurse', 'Nurse', 600, 300], ['Seen by a doctor', 'Doctor', 240, 120]], { pauseBefore: 1 });
  const head = (await page.textContent('[data-test="walk-longest"]')).replace(/\s+/g, ' ');
  assert.match(head, /^Longest wait: at least 10 min before “Seen by a nurse” \(5 min more of it not seen\)$/);
  assert.doesNotMatch((await page.textContent('[data-test="process-body"]')).replace(/\s+/g, ' '), /at least under/);
  // The step list, with each step's wait, is on the Edit map tab.
  await page.tap('[data-test="tab-edit"]');
  await page.waitForSelector('[data-test="tab-edit"][aria-selected="true"]');
  const all = (await page.textContent('[data-test="process-body"]')).replace(/\s+/g, ' ');
  assert.doesNotMatch(all, /at least under/);
  assert.match(all, /Waits at least 10 min · 5 min more not seen · the longest wait on this walk/);
  assert.doesNotMatch((await page.textContent('[data-step$="-s3"]')).replace(/\s+/g, ' '), /at least/, 'the wait before the doctor was not paused');
  assert.deepEqual(errors, []);
  await context.close();
});

test('360 by 640: "Walk the next patient" is on the map and in the list of maps, above starting a new map, and starts a repeat walk', async () => {
  const { context, page, errors } = await openPage(env, { width: 360, height: 640, path: '#/process', touch: true, locale: 'en-GB', timezoneId: 'UTC', clock: '2026-11-20T08:00:00Z' });
  await walk(page, LONG.slice(0, 2));
  assert.equal((await page.textContent('[data-test="result-actions"] [data-test="walk-again"]')).trim(), 'Walk the next patient');
  await page.locator('a.back').tap();
  await page.waitForSelector('[data-test="map-link"]');
  const list = await page.evaluate(() => {
    const again = document.querySelector('.map-list [data-test="walk-again"]'); const start = document.querySelector('[data-test="walk-start"]');
    return { again: again?.textContent, againH: again?.getBoundingClientRect().height, againTop: again?.getBoundingClientRect().top, startTop: start.getBoundingClientRect().top,
      startGhost: start.classList.contains('btn-ghost'), startText: start.textContent, meta: document.querySelector('[data-test="map-link"]').textContent };
  });
  assert.equal(list.again, 'Walk the next patient');
  assert.ok(list.againH >= 44, `the button is ${list.againH} px high`);
  assert.ok(list.againTop < list.startTop && list.startGhost, 'repeating a walked map comes before starting a new map, and is the stronger button');
  assert.equal(list.startText, 'Start a new map');
  assert.match(list.meta, /2 steps · 1 h 27 min start to finish · measured on one walk/);
  await page.locator('.map-list [data-test="walk-again"]').tap();
  await page.waitForSelector('[data-test="walk-before"]');
  assert.match(page.url(), /#\/process\/walk\/map-001$/);
  await page.tap('[data-test="walk-before-ok"]'); await state(page, 'waiting');
  assert.match((await page.textContent('[data-test="walk-next"]')).replace(/\s+/g, ' '), /^Next: step 1 of 2/);
  assert.deepEqual(errors, []);
  await context.close();
});
