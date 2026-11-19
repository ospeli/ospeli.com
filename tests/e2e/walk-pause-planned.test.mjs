// Walk mode, third slice (ospeli/ospeli#124 items 2 and 3) in the browser: Pause while the person
// walking steps out, a wait marked planned or required in two taps, and waits that are never
// shown by colour alone. The clock is the page's own, moved forward by the test.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, openPage } from './helpers.mjs';

let env;
before(async () => { env = await startApp(); });
after(async () => { await env.close(); });

const state = (page, want) => page.waitForFunction((w) => document.querySelector('[data-test="walk"]')?.dataset.state === w, want);
const noSideways = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const stored = (page) => page.evaluate(async () => (await window.ospeli.core.getMeta('process-walks'))?.walks || []);

async function start(page) {
  await page.waitForSelector('[data-test="walk-start"]');
  await page.tap('[data-test="walk-start"]');
  await page.tap('[data-test="walk-before-ok"]');
  await page.waitForSelector('[data-test="walk"]');
}
async function step(page, name, role, waitSec, workSec) {
  await page.clock.fastForward(waitSec * 1000);
  await page.tap('[data-test="walk-main"]'); await state(page, 'step');
  await page.clock.fastForward(workSec * 1000);
  await page.tap('[data-test="walk-main"]'); await page.waitForSelector('[data-test="walk-sheet"]');
  await page.tap(`[data-chip="name"]:text-is("${name}")`);
  await page.tap(`[data-chip="role"]:text-is("${role}")`);
  await page.waitForFunction(() => !document.querySelector('[data-test="walk-sheet"]'));
}

test('Pause at 360 px: one tap out, one tap back, the paused time is "not seen" on the map and in no total', async () => {
  const { context, page, errors } = await openPage(env, { width: 360, height: 640, path: '#/process', touch: true, locale: 'en-GB', clock: '2026-11-19T09:00:00' });
  await start(page);
  // Pause is offered while waiting and during a step, and is a full-size target.
  const pauseBox = await page.locator('[data-test="walk-pause"]').boundingBox();
  assert.ok(pauseBox.height >= 44, `Pause is ${pauseBox.height}px high`);
  await step(page, 'Checked in at reception', 'Reception', 120, 60);
  await page.clock.fastForward(100 * 1000);
  await page.tap('[data-test="walk-pause"]'); await state(page, 'paused');
  // Paused: one state word, one big button, and it does not look like waiting.
  assert.equal(await page.textContent('[data-test="walk-state"]'), 'Paused');
  assert.equal(await page.textContent('[data-test="walk-main"]'), 'I am back');
  assert.match(await page.textContent('[data-test="walk-def"]'), /Paused: nothing is counted\. This time shows on the map as “not seen”\. The wait carries on when you are back\./);
  assert.equal(await page.locator('[data-test="walk-pause"], [data-test="walk-finish"], [data-test="walk-stopped"]').count(), 0, 'nothing else to tap while paused');
  const look = await page.evaluate(() => {
    const w = document.querySelector('[data-test="walk"]'); const b = document.querySelector('[data-test="walk-main"]').getBoundingClientRect();
    return { bg: getComputedStyle(w).backgroundColor, border: getComputedStyle(w).borderTopStyle, mainBottom: b.bottom - window.scrollY + window.scrollY, mainH: b.height,
      targets: [...w.querySelectorAll('button, a')].filter((e) => e.offsetParent).map((e) => Math.round(e.getBoundingClientRect().height)) };
  });
  assert.equal(look.border, 'dashed', 'paused is told apart by its outline as well as its colour');
  assert.ok(look.targets.every((x) => x >= 44), `tap targets ${look.targets}`);
  assert.ok(look.mainBottom <= 640, `"I am back" is on the first screen (${look.mainBottom})`);
  await page.clock.fastForward(300 * 1000);
  // A reload while paused loses nothing: still paused, from the same moment.
  await page.reload(); await page.waitForSelector('html[data-ready="true"]');
  await page.waitForSelector('[data-test="walk"]'); assert.equal(await page.getAttribute('[data-test="walk"]', 'data-state'), 'paused');
  assert.match(await page.textContent('[data-test="walk-timer"]'), /^5:0\d$/);
  await page.tap('[data-test="walk-main"]'); await state(page, 'waiting');
  // Back: the waiting timer carries on from the 100 s already seen, without the 5 minutes away.
  assert.match(await page.textContent('[data-test="walk-timer"]'), /^1:4\d$/);
  await step(page, 'Seen by a nurse', 'Nurse', 50, 120);
  await step(page, 'Seen by a doctor', 'Doctor', 400, 180);
  await page.tap('[data-test="walk-finish"]'); await page.tap('[data-test="walk-finish-yes"]');
  await page.waitForSelector('[data-test="walk-answer"]');

  // Recomputed from the stored taps: wait before step 2 is 150 s seen and 300 s not seen.
  const w = (await stored(page))[0];
  const sec = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 1000);
  assert.equal(w.pauses.length, 1);
  const away = sec(w.pauses[0].startAt, w.pauses[0].endAt);
  assert.ok(away >= 300 && away <= 303, `away ${away} s`);
  const gap2 = sec(w.steps[0].endAt, w.steps[1].startAt) - away;
  assert.ok(gap2 >= 150 && gap2 <= 153, `wait before step 2: ${gap2} s seen`);
  const answer = (await page.textContent('[data-test="walk-answer"]')).replace(/\s+/g, ' ');
  assert.match(answer, /5 min( \d s)? not seen \(walk paused\): not counted as waiting or hands-on\./);
  assert.match(answer, /% of the time seen on this walk\)/);
  assert.match(answer, /Longest wait: 6 min 4\d s before “Seen by a doctor”/, 'the wait that was partly not seen is not the one named');
  assert.match(answer, /Waiting is not always waste\. Some waits are planned or needed\./);
  const list = (await page.textContent('[data-test="step-list"]')).replace(/\s+/g, ' ');
  assert.match(list, /Waits 2 min 3\d s · 5 min( \d s)? more not seen/);
  // The bar: four kinds would be three here, each named in words with its time.
  const legend = (await page.textContent('[data-test="bar-legend"]')).replace(/\s+/g, ' ');
  assert.match(legend, /Waiting \d+ min.*Hands-on work 6 min.*Not seen 5 min/);
  assert.equal(await page.locator('[data-test="bar-today"] i.n').count(), 1);
  assert.ok(await noSideways(page) <= 0);
  assert.deepEqual(errors, []);
  await context.close();
});

test('a wait is marked planned or required in two taps at 360 px; it still counts, and the longest wait moves on', async () => {
  const { context, page, errors } = await openPage(env, { width: 360, height: 780, path: '#/process', touch: true, locale: 'en-GB', clock: '2026-11-19T09:00:00' });
  await start(page);
  await step(page, 'Test or scan done', 'Laboratory', 900, 120);
  await step(page, 'Seen by a doctor', 'Doctor', 420, 300);
  await page.tap('[data-test="walk-finish"]'); await page.tap('[data-test="walk-finish-yes"]');
  await page.waitForSelector('[data-test="walk-answer"]');
  assert.match(await page.textContent('[data-test="walk-longest"]'), /Longest wait: 15 min( \d s)? before “Test or scan done”/);
  const waitingBefore = (await page.textContent('[data-test="walk-answer"]')).match(/(\d+ min(?: \d+ s)?) waiting/)[1];

  // Waiting is never colour alone: the waiting part of the bar is patterned, and the legend says "Waiting" with a time.
  const bar = await page.evaluate(() => {
    const w = document.querySelector('[data-test="bar-today"] i.w'); const k = document.querySelector('[data-test="bar-today"] i.k');
    return { w: getComputedStyle(w).backgroundImage, k: getComputedStyle(k).backgroundImage, border: getComputedStyle(document.querySelector('[data-test="walk-answer"]')).borderLeftColor,
      hot: getComputedStyle(document.querySelector('[data-test="step-list"] .wait.hot .wait-btn')).color };
  });
  assert.match(bar.w, /repeating-linear-gradient/, 'waiting is hatched');
  assert.equal(bar.k, 'none', 'hands-on is solid');
  assert.equal(bar.border, 'rgb(11, 47, 78)', 'the answer card is edged in navy, not in an alarm colour');
  assert.equal(bar.hot, 'rgb(11, 47, 78)', 'the longest wait is named in navy, not red');

  let taps = 0;
  const tap = async (sel) => { await page.locator(sel).first().tap(); taps += 1; };
  await tap('[data-step$="-s1"] [data-test="wait-btn"]');
  await page.waitForSelector('[data-test="wait-choice"]');
  assert.match(await page.textContent('[data-test="wait-choice"]'), /Mark it only if the whole wait was needed by the process itself.*If part of it was queueing, leave it unmarked\./s);
  const choice = await page.evaluate(() => [...document.querySelectorAll('[data-test="wait-btn"], [data-test="wait-planned"]')].map((e) => Math.round(e.getBoundingClientRect().height)));
  assert.ok(choice.every((x) => x >= 44), `tap targets ${choice}`);
  await tap('[data-test="wait-planned"]');
  await page.waitForSelector('[data-test="walk-planned"]');
  assert.equal(taps, 2);
  const answer = (await page.textContent('[data-test="walk-answer"]')).replace(/\s+/g, ' ');
  assert.ok(answer.includes(`${waitingBefore} waiting`), 'total waiting is unchanged by the mark');
  assert.match(answer, /Of the waiting, 15 min( \d s)? was marked planned or required\./);
  assert.match(answer, /Longest wait: 7 min( \d s)? before “Seen by a doctor”/);
  assert.match((await page.textContent('[data-step$="-s1"]')).replace(/\s+/g, ' '), /Waits 15 min( \d s)? · planned or required/);
  assert.equal(await page.locator('[data-test="bar-today"] i.p').count(), 1);
  assert.match(await page.textContent('[data-test="bar-legend"]'), /Planned or required wait 15 min/);
  // Marking a wait is not a proposed change, and the map still says "Measured on one walk".
  assert.equal(await page.textContent('[data-test="v-proposed"]'), 'Proposed');
  assert.match(await page.textContent('[data-test="walk-badge"]'), /^Measured on one walk$/);
  // The guide says who decided, and what the mark rests on.
  const guide = await page.evaluate(async () => { const { runCommand } = await import('./core/commands.js'); return (await runCommand(window.ospeli.core, 'ospeli_maps_suggest', { mapId: 'map-001', version: 'today' }, { type: 'human', role: 'ops-manager' })).suggestions.find((x) => x.id === 'walk-planned'); });
  assert.match(guide.why, /A person marked them on this map\. Ospeli does not judge which waits are needed\./);
  // The mark comes off the same way.
  await page.tap('[data-step$="-s1"] [data-test="wait-btn"]');
  assert.equal(await page.textContent('[data-test="wait-planned"]'), 'Remove the mark');
  await page.tap('[data-test="wait-planned"]');
  await page.waitForFunction(() => !document.querySelector('[data-test="walk-planned"]'));
  assert.match(await page.textContent('[data-test="walk-longest"]'), /before “Test or scan done”/);
  assert.ok(await noSideways(page) <= 0);
  assert.deepEqual(errors, []);
  await context.close();
});

test('with the guide off, Pause, the planned mark and the answer card still work (nothing here needs a suggestion)', async () => {
  const { context, page, errors } = await openPage(env, { width: 390, height: 844, path: '#/process', touch: true, locale: 'en-GB', clock: '2026-11-19T09:00:00' });
  await page.waitForSelector('[data-test="walk-start"]');
  await page.evaluate(async () => { const { runCommand } = await import('./core/commands.js'); await runCommand(window.ospeli.core, 'ospeli_maps_guide_set', { on: false }, { type: 'human', role: 'ops-manager' }); });
  await start(page);
  await page.clock.fastForward(60 * 1000);
  await page.tap('[data-test="walk-pause"]'); await state(page, 'paused');
  // Undo takes the pause back.
  await page.tap('[data-test="walk-undo"]'); await state(page, 'waiting');
  await step(page, 'Checked in at reception', 'Reception', 60, 60);
  await page.tap('[data-test="walk-finish"]'); await page.tap('[data-test="walk-finish-yes"]');
  await page.waitForSelector('[data-test="walk-answer"]');
  assert.equal(await page.locator('[data-test="walk-not-seen"]').count(), 0, 'an undone pause leaves no time "not seen"');
  await page.tap('[data-test="wait-btn"]'); await page.tap('[data-test="wait-planned"]');
  await page.waitForSelector('[data-test="walk-planned"]');
  assert.match(await page.textContent('[data-test="walk-longest"]'), /No wait of 30 seconds or more/);
  assert.deepEqual(errors, []);
  await context.close();
});
