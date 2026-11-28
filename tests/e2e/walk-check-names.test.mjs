// "Check the names" at Finish (#170 point 3) and the step after the visit (#169 item 3), in the
// browser on a phone. A first walk that kept names or roles from the example list ends on one
// screen: the steps in order with their times, the list's words marked in words; one tap says they
// are right and finishes; any one can be changed first; finishing without saying so keeps the marks.
// "Report signed" sits under "After the visit" and is in none of the visit's figures.
// The clock is the page's own, moved forward by the test.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, openPage } from './helpers.mjs';

let env;
before(async () => { env = await startApp(); });
after(async () => { await env.close(); });

const state = (page, want) => page.waitForFunction((w) => document.querySelector('[data-test="walk"]')?.dataset.state === w, want);
const stored = (page) => page.evaluate(async () => (await window.ospeli.core.getMeta('process-walks'))?.walks || []);
const maps = (page) => page.evaluate(async () => (await window.ospeli.core.getMeta('process-maps'))?.maps || []);
const noSideways = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const row = (n) => `[data-test="walk-list-row"][data-n="${n}"]`;
const IMAGING = ['Arrived', 'Registered', 'Safety questions', 'Changed into gown', 'Cannula or prep', 'Scan'];

async function begin(env2, { width = 360, height = 640 } = {}) {
  const o = await openPage(env2, { width, height, path: '#/process/walk', touch: true, department: 'imaging', clock: '2026-11-19T09:00:00' });
  await o.page.waitForSelector('[data-test="walk-before"]');
  return o;
}
// What a first-time user's thumb and eyes need on the check screen.
const look = (page) => page.evaluate(() => {
  const bar = document.querySelector('[data-test="walk-bar"]').getBoundingClientRect();
  const a = document.activeElement;
  return { vh: window.innerHeight,
    buttons: [...document.querySelectorAll('[data-test="walk-check"] button')].map((b) => [b.textContent.trim(), Math.round(b.getBoundingClientRect().height), Math.round(b.getBoundingClientRect().width)]),
    small: [...document.querySelectorAll('[data-test="walk-check"] *')].filter((e) => e.children.length === 0 && e.textContent.trim() && parseFloat(getComputedStyle(e).fontSize) < 15).map((e) => e.textContent.trim().slice(0, 30)),
    barTop: bar.top, barBottom: bar.bottom,
    ok: document.querySelector('[data-test="walk-check-ok"]')?.getBoundingClientRect().bottom,
    later: document.querySelector('[data-test="walk-check-later"]')?.getBoundingClientRect().bottom,
    firstRowTop: document.querySelector('[data-test="walk-check-row"]').getBoundingClientRect().top,
    typing: !!a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA'), inputs: document.querySelectorAll('[data-test="walk-check"] input, [data-test="walk-check"] textarea').length };
});

for (const [width, height] of [[360, 640], [390, 844]]) {
  test(`${width}x${height}, first-time user: six imaging steps, Finish, "Yes, all correct": 15 taps, nothing typed, and the names are kept as confirmed`, async () => {
    const { context, page, errors } = await begin(env, { width, height });
    let taps = 0;
    const tap = async (sel) => { await page.locator(sel).first().tap(); taps += 1; };
    await tap('[data-test="walk-before-ok"]');
    await page.waitForSelector('[data-test="walk-list"]');
    for (let i = 0; i < 6; i++) {
      await page.clock.fastForward(60 * 1000); await tap('[data-test="walk-main"]'); await state(page, 'step');
      await page.clock.fastForward(120 * 1000); await tap('[data-test="walk-main"]'); await state(page, 'waiting');
    }
    await tap('[data-test="walk-finish"]');
    await page.waitForSelector('[data-test="walk-check"]');
    assert.equal(await page.locator('[data-test="walk-confirm"]:not(.wc-actions)').count(), 0, 'no second finish question');
    assert.equal((await page.textContent('#wk-check-h')).trim(), 'Check the names');
    assert.equal((await page.textContent('[data-test="walk-check-lead"]')).trim(), 'Step names and job roles only. Marked ones came from the example list.');
    const rows = await page.locator('[data-test="walk-check-row"]').allTextContents();
    assert.equal(rows.length, 6);
    rows.forEach((t, i) => { assert.match(t, new RegExp(`^${i + 1}\\. ${IMAGING[i]} · `)); assert.match(t, /waited 1 min · 2 min (hands-on|patient step)/); assert.match(t, /Name and role from the list/); });
    const l = await look(page);
    assert.ok(l.buttons.every(([, h, w]) => h >= 44 && w >= 44), `every button is 44 px or more (${JSON.stringify(l.buttons.filter(([, h, w]) => h < 44 || w < 44))})`);
    assert.deepEqual(l.small, [], 'no text under 15 px');
    assert.ok(l.ok <= l.vh && l.later <= l.vh, 'both ways to finish are on the screen without scrolling');
    assert.ok(l.firstRowTop < l.barTop, 'the first step is in sight above the buttons');
    assert.equal(l.typing, false); assert.equal(l.inputs, 0, 'nothing to type on this screen');
    assert.ok(await noSideways(page) <= 0, 'no sideways scroll');
    assert.deepEqual(l.buttons.slice(-3).map((b) => b[0]), ['Yes, all correct', 'Keep walking', 'Finish, check later']);
    await tap('[data-test="walk-check-ok"]');
    await page.waitForSelector('[data-test="pm-stats"]');
    assert.ok(taps <= 15, `${taps} taps: start 1, six steps of 2 taps, Finish, Yes`);
    const m = (await maps(page))[0];
    assert.deepEqual(m.today.map((s) => [s.name, s.nameFrom, s.roleFrom]), IMAGING.map((n) => [n, 'confirmed', 'confirmed']));
    assert.ok(m.walk.namesConfirmedAt, 'the map keeps when the names were confirmed');
    assert.equal(await page.locator('[data-test="names-from"]').count(), 0, 'the result has no "came from the list, not confirmed" line');
    assert.deepEqual(errors, []);
    await context.close();
  });
}

test('360x640: "Finish, check later" finishes in one tap and the names stay marked as from the list, on the map and on the result', async () => {
  const { context, page, errors } = await begin(env);
  await page.tap('[data-test="walk-before-ok"]'); await page.waitForSelector('[data-test="walk-list"]');
  for (let i = 0; i < 3; i++) {
    await page.clock.fastForward(60 * 1000); await page.tap('[data-test="walk-main"]'); await state(page, 'step');
    await page.clock.fastForward(120 * 1000); await page.tap('[data-test="walk-main"]'); await state(page, 'waiting');
  }
  await page.tap('[data-test="walk-finish"]'); await page.waitForSelector('[data-test="walk-check"]');
  await page.tap('[data-test="walk-check-later"]');
  await page.waitForSelector('[data-test="pm-stats"]');
  const m = (await maps(page))[0];
  assert.deepEqual(m.today.map((s) => [s.nameFrom, s.roleFrom]), [['list', 'list'], ['list', 'list'], ['list', 'list']]);
  assert.equal(m.walk.namesConfirmedAt, undefined);
  assert.match(await page.textContent('[data-test="names-from"]'), /3 of 3 step names and 3 of 3 roles came from the list and were not confirmed/);
  assert.deepEqual(errors, []);
  await context.close();
});

test('360x640: one step is changed on the check screen with one tap from the words offered; "Keep walking" goes back to the walk; the change is the person\'s own', async () => {
  const { context, page, errors } = await begin(env);
  await page.tap('[data-test="walk-before-ok"]'); await page.waitForSelector('[data-test="walk-list"]');
  for (let i = 0; i < 2; i++) {
    await page.clock.fastForward(60 * 1000); await page.tap('[data-test="walk-main"]'); await state(page, 'step');
    await page.clock.fastForward(120 * 1000); await page.tap('[data-test="walk-main"]'); await state(page, 'waiting');
  }
  await page.tap('[data-test="walk-finish"]'); await page.waitForSelector('[data-test="walk-check"]');
  const second = page.locator('[data-test="walk-check-row"][data-n="2"]');
  await second.locator('[data-test="walk-check-change"]').tap();
  await page.waitForSelector('[data-test="walk-check-edit"]');
  const chips = await page.locator('[data-test="walk-check-edit"] button').evaluateAll((b) => b.map((x) => Math.round(x.getBoundingClientRect().height)));
  assert.ok(chips.length >= 10 && chips.every((h) => h >= 44), `every word offered is 44 px high or more (${chips})`);
  assert.ok(await noSideways(page) <= 0, 'no sideways scroll with the words open');
  await page.locator('[data-test="walk-check-role"]', { hasText: 'Imaging staff' }).tap();
  await page.waitForFunction(() => /Name from the list/.test(document.querySelector('[data-test="walk-check-row"][data-n="2"] [data-test="walk-check-mark"]')?.textContent || ''));
  assert.match(await second.textContent(), /2\. Registered · Imaging staff/);
  let w = (await stored(page))[0];
  assert.deepEqual([w.steps[1].role, w.steps[1].roleFrom, w.steps[1].nameFrom], ['Imaging staff', 'chosen', 'list']);
  assert.deepEqual([w.steps[0].role, w.steps[0].roleFrom], ['Patient', 'list'], 'the other step is untouched');
  // Back to the walk: nothing was finished, and a third step can still be timed.
  await page.tap('[data-test="walk-check-back"]');
  await page.waitForSelector('[data-test="walk-list"]');
  assert.equal((await page.textContent('[data-test="walk-main"]')).trim(), 'Safety questions starts');
  assert.equal((await stored(page))[0].status, 'walking');
  await page.tap('[data-test="walk-finish"]'); await page.waitForSelector('[data-test="walk-check"]');
  await page.tap('[data-test="walk-check-ok"]');
  await page.waitForSelector('[data-test="pm-stats"]');
  const m = (await maps(page))[0];
  assert.deepEqual(m.today.map((s) => [s.name, s.role, s.nameFrom, s.roleFrom]), [['Arrived', 'Patient', 'confirmed', 'confirmed'], ['Registered', 'Imaging staff', 'confirmed', 'chosen']]);
  assert.deepEqual(errors, []);
  await context.close();
});

test('390x844: "Report signed" is under "After the visit", is timed after the patient left, and is in none of the result\'s figures', async () => {
  const { context, page, errors } = await begin(env, { width: 390, height: 844 });
  await page.tap('[data-test="walk-before-ok"]'); await page.waitForSelector('[data-test="walk-list"]');
  // The heading comes after the eight steps of the visit and before the report's row.
  const order = await page.locator('.walk-rows > li').evaluateAll((li) => li.map((x) => x.dataset.test || x.querySelector('button')?.dataset.n || 'other'));
  assert.deepEqual(order.slice(7, 10), ['8', 'walk-after-head', '9']);
  assert.equal((await page.textContent('[data-test="walk-after-head"]')).trim(), 'After the visit Not counted in the visit’s totals.');
  for (let i = 0; i < 8; i++) {
    await page.clock.fastForward((i === 5 ? 900 : 60) * 1000); await page.tap('[data-test="walk-main"]'); await state(page, 'step');
    await page.clock.fastForward(120 * 1000); await page.tap('[data-test="walk-main"]'); await state(page, 'waiting');
  }
  // The visit's list is used up: the report is never offered as the next step by the main button.
  assert.equal((await page.textContent('[data-test="walk-main"]')).trim(), 'Step starts');
  await page.clock.fastForward(40 * 60 * 1000);
  await page.locator(row(9)).tap(); await state(page, 'step');
  await page.clock.fastForward(120 * 1000);
  await page.tap('[data-test="walk-main"]'); await state(page, 'waiting');
  assert.match(await page.textContent(row(9)), /Radiologist · started 40 min after the visit · took 2 min/);
  await page.tap('[data-test="walk-finish"]'); await page.waitForSelector('[data-test="walk-check"]');
  assert.match(await page.locator('[data-test="walk-check-row"][data-n="9"]').textContent(), /After the visit · started 40 min after it · took 2 min/);
  await page.tap('[data-test="walk-check-ok"]');
  await page.waitForSelector('[data-test="pm-stats"]');
  // Start to finish is the visit: 7 x 1 min + 15 min waiting and 8 x 2 min hands-on = 38 min.
  const stats = (await page.textContent('[data-test="pm-stats"]')).replace(/\s+/g, ' ');
  assert.match(stats, /Longest wait: 15 min before “Scan”/);
  assert.match(stats, /38 min start to finish on this walk/);
  assert.doesNotMatch(stats, /Report signed|1 h/);
  assert.equal((await page.textContent('[data-test="bar-after"]')).trim(), 'After the visit: Report signed started 40 min after it and took 2 min. Not in the bar or the totals.');
  // (real taps can add a second or two)
  const barSec = +(await page.getAttribute('[data-test="bar-walk"]', 'data-sec'));
  assert.ok(barSec >= 38 * 60 && barSec <= 38 * 60 + 3, `the bar is the visit: ${barSec} s`);
  assert.equal(await page.locator('[data-test="bar-walk"] [data-step$="-s9"]').count(), 0, 'the report is not a segment of the visit\'s bar');
  assert.match(await page.textContent('[data-test="after-visit-row"]'), /After the visit/);
  const m = (await maps(page))[0];
  assert.equal(m.today[8].afterVisit, true);
  const visitMs = Date.parse(m.walk.finishedAt) - Date.parse(m.walk.startedAt);
  assert.ok(visitMs >= 38 * 60 * 1000 && visitMs <= (38 * 60 + 3) * 1000, `the walk ends when the patient left: ${visitMs} ms`);
  assert.ok(await noSideways(page) <= 0);
  assert.deepEqual(errors, []);
  await context.close();
});
