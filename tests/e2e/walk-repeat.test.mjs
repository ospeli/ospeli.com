// Repeat walks (issue #124 item 1): walk a map's saved step list again. The walk is added to the
// same map, which then reads as a range: lowest to highest, whole minutes, no percentage.
// The first-time-user test does the whole second walk at 360 px in a fixed number of taps, with
// nothing named and nothing typed. Synthetic times only; the page's clock is moved by the test.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, openPage } from './helpers.mjs';

let env;
before(async () => { env = await startApp(); });
after(async () => { await env.close(); });

const noSideways = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const state = (page, s) => page.waitForSelector(`[data-test="walk"][data-state="${s}"]`);
const text = (page, sel) => page.textContent(sel);

// The first walk, through the screen: three steps named by tapping.
// Waits 120, 600, 1500 s (37 min); hands-on 180, 240, 540 s (16 min); 53 min in all.
const FIRST = [['Checked in at reception', 'Reception', 120, 180], ['Seen by a nurse', 'Nurse', 600, 240], ['Seen by a doctor', 'Doctor', 1500, 540]];
async function firstWalk(page) {
  await page.waitForSelector('[data-test="walk-start"]');
  await page.tap('[data-test="walk-start"]'); await page.tap('[data-test="walk-before-ok"]');
  await page.waitForSelector('[data-test="walk"]');
  for (const [name, role, wait, work] of FIRST) {
    await page.clock.fastForward(wait * 1000);
    await page.tap('[data-test="walk-main"]'); await state(page, 'step');
    await page.clock.fastForward(work * 1000);
    await page.tap('[data-test="walk-main"]'); await page.waitForSelector('[data-test="walk-sheet"]');
    await page.tap(`[data-chip="name"]:text-is("${name}")`); await page.tap(`[data-chip="role"]:text-is("${role}")`);
    await page.waitForFunction(() => !document.querySelector('[data-test="walk-sheet"]'));
  }
  await page.tap('[data-test="walk-finish"]'); await page.tap('[data-test="walk-finish-yes"]');
  await page.waitForSelector('[data-test="walk-answer"]');
}

test('first-time user at 360 px: walk the same three steps again in 10 taps, nothing named or typed, and the map reads as a range', async () => {
  const { context, page, errors } = await openPage(env, { width: 360, height: 780, path: '#/process', touch: true, locale: 'en-GB', timezoneId: 'UTC', clock: '2026-11-17T09:00:00Z' });
  await firstWalk(page);
  // One walk: the share stays, beside "this walk", and the map offers the second walk.
  assert.match(await text(page, '[data-test="walk-answer"]'), /37 min waiting \(70% of this walk\)/);
  assert.equal((await text(page, '[data-test="walk-again"]')).trim(), 'Walk it again (walk 2 of 3)');

  // Another day, another hour.
  await page.clock.setSystemTime(new Date('2026-11-19T14:30:00Z'));
  let taps = 0;
  const tap = async (sel) => { await page.locator(sel).first().tap(); taps += 1; };
  await tap('[data-test="walk-again"]');
  await page.waitForSelector('[data-test="walk-before"]');
  assert.match(page.url(), /#\/process\/walk\/map-001$/);
  assert.match(await text(page, '[data-test="walk-before-again"]'), /Walk 2 of 3 · same step list/);
  await tap('[data-test="walk-before-ok"]');
  await state(page, 'waiting');

  // The repeat walk screen on a 360 by 640 phone: the next list step, the timer, the main button,
  // "Did not happen" and Pause, all without scrolling.
  await page.setViewportSize({ width: 360, height: 640 });
  const look = await page.evaluate(() => {
    const walk = document.querySelector('[data-test="walk"]');
    const r = (sel) => document.querySelector(sel).getBoundingClientRect();
    const px = (e) => parseFloat(getComputedStyle(e).fontSize);
    return { next: document.querySelector('[data-test="walk-next"]').innerText.replace(/\s+/g, ' '), nextTop: r('[data-test="walk-next"]').top, mainBottom: r('[data-test="walk-main"]').bottom, mainH: r('[data-test="walk-main"]').height,
      skipBottom: r('[data-test="walk-skip"]').bottom, pauseBottom: r('[data-test="walk-pause"]').bottom, timerPx: px(document.querySelector('[data-test="walk-timer"]')),
      smallest: Math.min(...[...walk.querySelectorAll('h1, p, span, b, button')].filter((e) => e.textContent.trim() && e.offsetParent).map(px)),
      targets: [...walk.querySelectorAll('button:not([disabled]), a')].filter((e) => e.offsetParent).map((e) => Math.round(e.getBoundingClientRect().height)),
      inputs: walk.querySelectorAll('input, select, textarea').length, sub: document.querySelector('.walk-sub').textContent, scrollY: window.scrollY };
  });
  assert.equal(look.next, 'Next: step 1 of 3 · Reception Checked in at reception');
  assert.match(look.sub, /Walk 2 of 3/);
  assert.ok(look.scrollY === 0 && look.nextTop > 0 && look.mainBottom <= 640 && look.skipBottom <= 640 && look.pauseBottom <= 640, `main ${look.mainBottom}, did not happen ${look.skipBottom}, pause ${look.pauseBottom} on a 640 px screen`);
  assert.ok(look.mainH >= 72 && look.timerPx >= 56, `main button ${look.mainH}px, timer ${look.timerPx}px`);
  assert.ok(look.smallest >= 15, `smallest text ${look.smallest}px`);
  assert.ok(look.targets.every((x) => x >= 44), `tap targets ${look.targets}`);
  assert.equal(look.inputs, 0, 'nothing to type on a repeat walk');
  assert.ok(await noSideways(page) <= 0);

  // Waits 60, 900, 1200 s (36 min); hands-on 240, 300, 480 s (17 min): 53 min in all, two taps a step.
  const second = [[60, 240], [900, 300], [1200, 480]];
  for (let i = 0; i < second.length; i++) {
    await page.clock.fastForward(second[i][0] * 1000);
    await tap('[data-test="walk-main"]'); await state(page, 'step');
    assert.match(await text(page, '[data-test="walk-next"]'), new RegExp(`Now: step ${i + 1} of 3.*${FIRST[i][0]}`));
    await page.clock.fastForward(second[i][1] * 1000);
    await tap('[data-test="walk-main"]'); await state(page, 'waiting');
    // No naming sheet: one line says what the step was saved as, with one way to change it.
    assert.equal(await page.locator('[data-test="walk-sheet"]').count(), 0);
    assert.match(await text(page, '[data-test="walk-saved"]'), new RegExp(`Step ${i + 1} saved as ${FIRST[i][0]}`));
    if (i === 0) {
      const saved = await page.evaluate(() => { const b = document.querySelector('[data-test="walk-main"]').getBoundingClientRect(); const u = document.querySelector('[data-test="walk-undo"]').getBoundingClientRect(); return { main: b.bottom, undo: u.bottom }; });
      assert.ok(saved.main <= 640 && saved.undo <= 640, `after a step the main button (${saved.main}) and Undo (${saved.undo}) are still on the first screen`);
    }
  }
  assert.match(await text(page, '[data-test="walk-next"]'), /End of the list/);
  await page.setViewportSize({ width: 360, height: 780 });
  await tap('[data-test="walk-finish"]');
  assert.match(await text(page, '[data-test="walk-confirm"]'), /Finish and add walk 2 to the map\?/);
  await tap('[data-test="walk-finish-yes"]');
  await page.waitForSelector('[data-test="walk-range"]');
  assert.equal(taps, 10, 'walk it again, start, two taps for each of three steps, finish, yes');
  assert.match(page.url(), /#\/process\/map-001$/, 'the same map, not a new one');

  // The map: a count and the aim, a range in whole minutes, where the longest wait fell, each
  // walk's day and hour, and no percentage anywhere in the answer.
  const answer = (await page.locator('[data-test="walk-answer"]').innerText()).replace(/\s+/g, ' ');
  assert.equal((await text(page, '[data-test="walk-badge"]')).trim().toLowerCase(), '2 walks');
  assert.match(answer, /^53 min \(the same on both walks\) start to finish/, 'the range comes first');
  assert.match(answer, /2 of 3 walks: shortest to longest\. These are examples, not an average\. Walk the third on another day or at another hour\./);
  assert.match(answer, /Waiting 36 to 37 min · hands-on 16 to 17 min/);
  assert.match(answer, /Longest wait: before “Seen by a doctor” on both walks/);
  assert.equal(await page.locator('[data-test="walk-list"]').count(), 0, 'no walk is left out, so none is listed in the answer: each walk\'s day and hour is on its bar');
  assert.doesNotMatch(answer, /%/, 'no percentage on a map with more than one walk');
  assert.equal((await text(page, '[data-test="walk-again"]')).trim(), 'Walk it again (walk 3 of 3)');
  // The answer starts on the first screen of a 360 by 640 phone, range and longest wait included.
  await page.setViewportSize({ width: 360, height: 640 });
  await page.evaluate(() => window.scrollTo(0, 0));
  const fold = await page.evaluate(() => ['walk-range', 'walk-range-parts', 'walk-longest'].map((t) => Math.round(document.querySelector(`[data-test="${t}"]`).getBoundingClientRect().bottom)));
  assert.ok(fold.every((y) => y <= 640), `range, parts and longest wait end at ${fold} on a 640 px screen`);
  await page.setViewportSize({ width: 360, height: 780 });
  // One bar per walk, and each step with its own range.
  assert.equal(await page.locator('[data-test="bar-walk"]').count(), 2);
  assert.match(await text(page, '[data-test="walk-bars"]'), /Where the time went.*Walk 1 · Tue,? 17 Nov, 09:00 · 53 min.*Walk 2 · Thu,? 19 Nov, 14:30 · 53 min.*Same step list, one bar per walk/s);
  const steps = (await page.locator('[data-test="step-list"]').innerText()).replace(/\s+/g, ' ');
  assert.match(steps, /Waits 1 to 2 min.*Reception · hands-on 3 to 4 min.*Waits 10 to 15 min.*Nurse · hands-on 4 to 5 min.*Waits 20 to 25 min · longest wait.*Doctor · hands-on 8 to 9 min/);
  // The guide says how the walks are compared and what that rests on; people decide.
  const guide = await page.evaluate(() => [...document.querySelectorAll('[data-test="guide"] [data-suggestion]')].map((li) => [li.dataset.suggestion, !!li.querySelector('[data-test="sg-basis"]')]));
  assert.deepEqual(guide, [['walks-longest', true], ['walks-more', true], ['walks-compare', true]]);
  assert.match(await text(page, '[data-test="guide"]'), /People decide; Ospeli suggests\./);
  // The list of maps says how many walks.
  await page.goto(`${env.appUrl}#/process`);
  await page.waitForSelector('[data-test="map-link"]');
  assert.match(await text(page, '[data-test="map-link"]'), /3 steps · 2 walks/);
  assert.ok(await noSideways(page) <= 0);
  assert.deepEqual(errors, []);
  await context.close();
});

test('a visit that differs from the list: "Did not happen" with Undo, "Change" to a list step or to a step not on the list, and steps left at Finish are asked about', async () => {
  const { context, page, errors } = await openPage(env, { width: 390, height: 844, path: '#/process', touch: true, locale: 'en-GB', timezoneId: 'UTC', clock: '2026-11-17T09:00:00Z' });
  await firstWalk(page);
  await page.clock.setSystemTime(new Date('2026-11-18T11:00:00Z'));
  await page.tap('[data-test="walk-again"]'); await page.tap('[data-test="walk-before-ok"]'); await state(page, 'waiting');
  // Reception happens. Then the nurse step did not happen: one tap, and it can be undone.
  await page.clock.fastForward(60000); await page.tap('[data-test="walk-main"]'); await state(page, 'step');
  await page.clock.fastForward(120000); await page.tap('[data-test="walk-main"]'); await state(page, 'waiting');
  await page.tap('[data-test="walk-skip"]');
  await page.waitForFunction(() => /step 3 of 3/.test(document.querySelector('[data-test="walk-next"]').textContent));
  await page.tap('[data-test="walk-undo"]');
  await page.waitForFunction(() => /step 2 of 3/.test(document.querySelector('[data-test="walk-next"]').textContent));
  assert.match(await text(page, '[data-test="walk-status"]'), /Undone\. The step is back on the list\./);
  await page.tap('[data-test="walk-skip"]');
  await page.waitForFunction(() => /step 3 of 3/.test(document.querySelector('[data-test="walk-next"]').textContent));
  // The next step timed was really reception again: Change, then pick it from the list.
  await page.clock.fastForward(300000); await page.tap('[data-test="walk-main"]'); await state(page, 'step');
  await page.clock.fastForward(60000); await page.tap('[data-test="walk-main"]'); await state(page, 'waiting');
  assert.match(await text(page, '[data-test="walk-saved"]'), /Step 2 saved as Seen by a doctor/);
  await page.tap('[data-test="walk-change"]');
  await page.waitForSelector('[data-test="walk-pick"]');
  const pick = await page.evaluate(() => [...document.querySelectorAll('[data-test="walk-pick"] button')].map((b) => [b.textContent, Math.round(b.getBoundingClientRect().height)]));
  assert.deepEqual(pick.map((p) => p[0]), ['1. Checked in at reception', '2. Seen by a nurse', '3. Seen by a doctor', 'Not on the list', 'Back']);
  assert.ok(pick.every((p) => p[1] >= 44), `targets ${pick.map((p) => p[1])}`);
  await page.locator('[data-test="walk-pick-step"]').first().tap();
  await page.waitForFunction(() => /Step 2 saved as Checked in at reception/.test(document.querySelector('[data-test="walk-saved"]')?.textContent || ''));
  assert.match(await text(page, '[data-test="walk-next"]'), /Next: step 3 of 3.*Seen by a doctor/, 'a step done again does not use up the next list step');
  // Then a step that is not on the list: it is named with the usual chips.
  await page.clock.fastForward(30000); await page.tap('[data-test="walk-main"]'); await state(page, 'step');
  await page.clock.fastForward(90000); await page.tap('[data-test="walk-main"]'); await state(page, 'waiting');
  await page.tap('[data-test="walk-change"]'); await page.tap('[data-test="walk-pick-off"]');
  await page.waitForSelector('[data-test="walk-sheet"]');
  await page.tap('[data-chip="name"]:text-is("Test or scan done")'); await page.tap('[data-chip="role"]:text-is("Imaging")');
  await page.waitForFunction(() => !document.querySelector('[data-test="walk-sheet"]'));
  // Finish with the doctor step left: the screen asks, and does not guess.
  await page.tap('[data-test="walk-finish"]');
  assert.match(await text(page, '[data-test="walk-left"]'), /1 step on the list was not timed: Seen by a doctor\./);
  assert.equal(await page.locator('[data-test="walk-finish-yes"]').count(), 0);
  const ask = await page.evaluate(() => [...document.querySelectorAll('[data-test="walk-confirm"] button')].map((b) => [b.textContent, Math.round(b.getBoundingClientRect().height)]));
  assert.deepEqual(ask.map((a) => a[0]), ['It did not happen. Finish', 'I stopped early. Finish', 'Keep walking']);
  assert.ok(ask.every((a) => a[1] >= 44));
  await page.tap('[data-test="walk-finish-early"]');
  await page.waitForSelector('[data-test="walk-range"]');
  const answer = (await page.locator('[data-test="walk-answer"]').innerText()).replace(/\s+/g, ' ');
  // Walk 2 stopped early: listed, said so, and left out of the totals, which rest on walk 1 alone.
  assert.match(answer, /53 min start to finish \(1 of 2 walks\)/);
  assert.match(answer, /Walk 2: Wed,? 18 Nov, 11:00 · stopped early, left out of the totals/);
  const steps = (await page.locator('[data-test="step-list"]').innerText()).replace(/\s+/g, ' ');
  // Reception was done twice on walk 2 (120 + 60 s): 3 min on both walks, and "done again" is said.
  assert.match(steps, /Reception · hands-on 3 min \(the same on both walks\) · done again on 1 walk/);
  assert.match(steps, /Nurse · hands-on 4 min · on 1 of 2 walks/);
  // The saved list is unchanged: the off-list step is on its walk alone.
  assert.equal(await page.locator('[data-test="step-list"] > li').count(), 3);
  const kept = await page.evaluate(async () => (await window.ospeli.core.getMeta('process-maps')).maps[0].walks[1]);
  assert.deepEqual([kept.steps.filter((x) => !x.stepId).map((x) => x.name), kept.stoppedEarly, kept.didNotHappen, kept.notTimed], [['Test or scan done'], true, ['map-001-s2'], ['map-001-s3']]);
  assert.doesNotMatch(JSON.stringify(kept.steps), /T\d\d:/, 'a record keeps seconds, not clock times, for its steps');
  // A name or role changes for every walk; measured times cannot be changed on the walks version.
  await page.locator('[aria-label="Change step 1"]').tap();
  await page.waitForSelector('[data-test="list-shared"]');
  assert.equal(await page.locator('#st-wait').isDisabled(), true);
  assert.ok(await noSideways(page) <= 0);
  assert.deepEqual(errors, []);
  await context.close();
});

test('a reload in the middle of a repeat walk keeps the list and the place on it; the Proposed version stays a what-if from walk 1', async () => {
  const { context, page, errors } = await openPage(env, { width: 1280, height: 860, path: '#/process', touch: true, locale: 'en-GB', timezoneId: 'UTC', clock: '2026-11-17T09:00:00Z' });
  await firstWalk(page);
  await page.clock.setSystemTime(new Date('2026-11-18T09:20:00Z'));
  await page.tap('[data-test="walk-again"]'); await page.tap('[data-test="walk-before-ok"]'); await state(page, 'waiting');
  await page.clock.fastForward(60000); await page.tap('[data-test="walk-main"]'); await state(page, 'step');
  await page.clock.fastForward(60000); await page.tap('[data-test="walk-main"]'); await state(page, 'waiting');
  await page.reload(); await page.waitForSelector('html[data-ready="true"]');
  await state(page, 'waiting');
  assert.match(await text(page, '[data-test="walk-next"]'), /Next: step 2 of 3.*Seen by a nurse/);
  for (const [wait, work] of [[600, 240], [1500, 540]]) {
    await page.clock.fastForward(wait * 1000); await page.tap('[data-test="walk-main"]'); await state(page, 'step');
    await page.clock.fastForward(work * 1000); await page.tap('[data-test="walk-main"]'); await state(page, 'waiting');
  }
  await page.tap('[data-test="walk-finish"]'); await page.tap('[data-test="walk-finish-yes"]');
  await page.waitForSelector('[data-test="walk-range"]');
  // Both walks began in the same hour of the day: the guide says so.
  assert.match(await text(page, '[data-test="guide"]'), /2 of 3 walks so far/);
  await page.tap('[data-test="v-proposed"]');
  await page.waitForFunction(() => /What-if, not measured/i.test(document.querySelector('[data-test="walk-badge"]')?.textContent || ''));
  assert.match(await text(page, '.walk-when'), /From walk 1's times \(Tue,? 17 Nov, 09:00\)/);
  assert.equal(await page.locator('[data-test="walk-range"]').count(), 0, 'no range on a what-if');
  assert.deepEqual(errors, []);
  await context.close();
});
