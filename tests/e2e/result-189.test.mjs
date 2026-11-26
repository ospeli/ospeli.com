// Result polish (#189 items 3 to 5, #182 items 22 and 23; module crew night 11): the bars are
// numbered by step and sit on a minutes scale, every wait is mango stripes on both tabs (coral only
// for the longest wait), no text under 15 px on a phone on Result or Edit map, both tabs say the
// same wait for the same step, and Edit map opens on the step list with "Change" beside each name.
// Synthetic imaging visit (result-seed.mjs); the page's clock is pinned and moved by the test.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, openPage } from './helpers.mjs';
import { twoWalkMap, threeWalkNine } from './result-seed.mjs';

let env;
before(async () => { env = await startApp(); });
after(async () => { await env.close(); });

const open = (o = {}) => openPage(env, { path: '#/process', touch: true, locale: 'en-GB', timezoneId: 'UTC', clock: '2026-11-17T09:00:00Z', department: 'imaging', ...o });
const goMap = async (page, tail = '') => { await page.goto(`${env.appUrl}#/process/map-001${tail}`); await page.waitForSelector(tail ? '.steps-box' : '[data-test="result-table"]'); };
const flat = (s) => s.replace(/\s+/g, ' ').trim();
const CORAL = 'rgb(224, 88, 62)';

// Every visible text on the page part given, with its font size, outside screen-reader-only text.
const smallTexts = (page, sel) => page.evaluate((s) => {
  const px = (e) => parseFloat(getComputedStyle(e).fontSize);
  const srOnly = (e) => { const r = e.getBoundingClientRect(); return r.width <= 1 && r.height <= 1; };
  return [...document.querySelectorAll(s)].filter((e) => e.checkVisibility() && !srOnly(e) && [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()))
    .filter((e) => px(e) < 15).map((e) => `${e.tagName}.${e.className}:${px(e)}:${e.textContent.trim().slice(0, 24)}`);
}, sel);

for (const width of [360, 390]) {
  test(`${width} px: each bar has its step numbers on the segments, in step order, and a minutes scale runs under the bars`, async () => {
    const { context, page, errors } = await open({ width, height: 640 });
    await twoWalkMap(page);
    await goMap(page);
    const bars = await page.evaluate(() => [...document.querySelectorAll('[data-test="bar-walk"]')].map((b) => {
      const row = b.closest('.bar-row');
      const nums = [...row.querySelectorAll('[data-test="bar-num"]')];
      const seen = nums.filter((n) => n.checkVisibility());
      const box = (e) => e.getBoundingClientRect();
      return { all: nums.map((n) => n.textContent), seen: seen.map((n) => [n.textContent, Math.round(box(n).left), Math.round(box(n).right), parseFloat(getComputedStyle(n).fontSize)]),
        hot: row.querySelector('[data-test="bar-num"][data-longest="true"]')?.checkVisibility() || false, bar: [Math.round(box(b).left), Math.round(box(b).right)],
        label: b.getAttribute('aria-label') };
    }));
    // Walk 1: the six list steps; walk 2: steps 1 to 4, the step not on the list, the scan twice, step 6.
    assert.deepEqual(bars[0].all, ['1', '2', '3', '4', '5', '6']);
    assert.deepEqual(bars[1].all, ['1', '2', '3', '4', '+', '5', '5', '6']);
    for (const b of bars) {
      assert.ok(b.hot, 'the number of the longest wait\'s step always shows');
      for (let i = 1; i < b.seen.length; i += 1) assert.ok(b.seen[i][1] >= b.seen[i - 1][2], `numbers do not overlap: ${JSON.stringify(b.seen)}`);
      assert.ok(b.seen.every((n) => n[1] >= b.bar[0] - 1 && n[2] <= b.bar[1] + 1 + 20 && n[3] >= 15), `numbers sit on the bar, 15 px or more: ${JSON.stringify(b.seen)}`);
      assert.match(b.label, /The numbers are the step numbers in the table\./);
    }
    const scale = await page.evaluate(() => {
      const s = document.querySelector('[data-test="bar-scale"]');
      return s && { ticks: [...s.querySelectorAll('[data-test="bar-tick"]')].map((t) => [t.textContent, Number(t.dataset.sec), parseFloat(getComputedStyle(t).fontSize)]),
        label: s.getAttribute('aria-label'), max: Math.max(...[...document.querySelectorAll('[data-test="bar-walk"]')].map((b) => Number(b.dataset.sec))) };
    });
    assert.ok(scale, 'a scale under the bars');
    assert.equal(scale.ticks[0][0], '0');
    assert.ok(scale.ticks.length >= 3 && scale.ticks.length <= 6, `3 to 6 marks: ${JSON.stringify(scale.ticks)}`);
    assert.ok(scale.ticks.every((t, i) => i === 0 || (t[1] > scale.ticks[i - 1][1] && t[1] <= scale.max)), 'marks rise and stay inside the longest walk');
    assert.ok(scale.ticks.slice(1).every((t) => /^(\d+ min|\d+ h( \d+ min)?)$/.test(t[0])), `marks in whole minutes: ${scale.ticks.map((t) => t[0])}`);
    assert.ok(scale.ticks.every((t) => t[2] >= 15));
    assert.match(scale.label, /^Scale: minutes from the start of the walk/);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), 0, 'no sideways scroll');
    assert.deepEqual(errors, []);
    await context.close();
  });
}

test('print: the step numbers and the minutes scale are on paper', async () => {
  const { context, page, errors } = await open({ width: 1280, height: 860, touch: false });
  await threeWalkNine(page);
  await goMap(page);
  await page.emulateMedia({ media: 'print' });
  await page.waitForTimeout(100);
  const pr = await page.evaluate(() => ({ scale: document.querySelector('[data-test="bar-scale"]')?.checkVisibility() || false,
    nums: [...document.querySelectorAll('[data-test="bar-num"]')].filter((n) => n.checkVisibility()).length }));
  assert.ok(pr.scale, 'the scale prints');
  assert.ok(pr.nums >= 9, `step numbers print (${pr.nums})`);
  assert.deepEqual(errors, []);
  await context.close();
});

test('waiting is mango stripes on Result and on Edit map; coral only outlines the longest wait', async () => {
  const { context, page, errors } = await open({ width: 390, height: 844 });
  await twoWalkMap(page);
  await goMap(page);
  const result = await page.evaluate(() => [...document.querySelectorAll('[data-test="bar-walk"] i, .result-bars .rsw')].map((i) => ({ wait: /\b(w|p)\b/.test(i.className), bg: getComputedStyle(i).backgroundImage, longest: i.dataset.longest === 'true' || i.classList.contains('is-longest'), outline: getComputedStyle(i).outlineStyle === 'none' ? null : getComputedStyle(i).outlineColor })));
  const waits = result.filter((x) => x.wait);
  assert.ok(waits.length >= 8, `waits on the Result bars (${waits.length})`);
  assert.ok(waits.every((x) => x.bg.includes('238, 155, 0') && /gradient/.test(x.bg)), 'every wait on Result is mango stripes');
  assert.ok(result.every((x) => !x.bg.includes('224, 88, 62')), 'no coral fill on Result');
  assert.ok(result.filter((x) => x.outline).every((x) => x.longest && x.outline === 'rgb(224, 88, 62)'), 'coral is only the longest wait\'s outline');
  await page.tap('[data-test="tab-edit"]');
  await page.waitForSelector('.steps-box');
  const edit = await page.evaluate(() => [...document.querySelectorAll('.flowbar i.w, .flowbar i.p, .legend .sw.w, .legend .sw.p')].map((i) => getComputedStyle(i).backgroundImage));
  assert.ok(edit.length >= 2, 'Edit map has its wait bar and key');
  assert.ok(edit.every((bg) => bg.includes('238, 155, 0') && !bg.includes('224, 88, 62')), `Edit map waits are mango stripes: ${edit}`);
  const textCoral = await page.evaluate(([c]) => [...document.querySelectorAll('.steps-box *')].filter((e) => getComputedStyle(e).color === c).map((e) => e.className), [CORAL]);
  assert.deepEqual(textCoral, [], 'no coral text on the step list');
  assert.deepEqual(errors, []);
  await context.close();
});

test('360 by 640: no text under 15 px on Result (the table caption too) or on Edit map', async () => {
  const { context, page, errors } = await open({ width: 360, height: 640 });
  await twoWalkMap(page);
  await goMap(page);
  assert.deepEqual(await smallTexts(page, '.result-head *, [data-test="result-panel"] *'), [], 'Result');
  await page.tap('[data-test="tab-edit"]');
  await page.waitForSelector('.steps-box');
  // Open the "more notes" fold and a wait's choice, so their text is checked as well.
  for (const d of await page.$$('#main details')) await d.evaluate((x) => { x.open = true; });
  await page.locator('[data-test="wait-btn"]').first().tap();
  await page.waitForSelector('[data-test="wait-choice"]');
  assert.deepEqual(await smallTexts(page, '#main .map-head *, #main .pm-layout *'), [], 'Edit map');
  assert.deepEqual(errors, []);
  await context.close();
});

test('#182 item 22: Edit map gives the same wait for "Scan" as Result, counted on the walks where it happened', async () => {
  const { context, page, errors } = await open({ width: 390, height: 844 });
  await twoWalkMap(page);
  await goMap(page);
  assert.equal(flat(await page.textContent('[data-test="walk-longest"]')), 'Longest wait: 10 to 13 min before “Scan”, on both walks');
  await page.tap('[data-test="tab-edit"]');
  await page.waitForSelector('.steps-box');
  const scan = flat(await page.textContent('[data-step="map-001-s5"] .wait'));
  assert.match(scan, /^Waits 10 to 13 min · longest wait/);
  assert.doesNotMatch(scan, /of 2 walks/);
  // Step 6 waited 1 min on walk 1 and under 1 min on walk 2; it happened on both.
  assert.doesNotMatch(flat(await page.textContent('[data-test="step-list"]')), /on 1 of 2 walks/);
  assert.deepEqual(errors, []);
  await context.close();
});

for (const width of [360, 390]) {
  test(`${width} by 640: Edit map opens on the step list; "Change" sits beside each step name and opens the form at that step`, async () => {
    const { context, page, errors } = await open({ width, height: 640 });
    await twoWalkMap(page);
    await goMap(page, '/edit');
    await page.evaluate(() => window.scrollTo(0, 0));
    const at = await page.evaluate(() => {
      const top = (s) => Math.round(document.querySelector(s).getBoundingClientRect().top);
      const name = document.querySelector('[data-step="map-001-s5"] .what b').getBoundingClientRect();
      const btn = document.querySelector('[data-step="map-001-s5"] [data-test="step-change"]');
      const b = btn.getBoundingClientRect();
      return { list: top('[data-test="step-list"]'), guide: top('[data-test="guide"]'), bars: top('.pm-layout .bars'), firstRow: Math.round(document.querySelector('[data-test="step-list"] li [data-test="step-change"]').getBoundingClientRect().bottom), vh: innerHeight,
        btn: { text: btn.textContent.trim(), label: btn.getAttribute('aria-label'), h: Math.round(b.height), w: Math.round(b.width), mid: Math.round((b.top + b.bottom) / 2), right: Math.round(b.right) }, name: { top: Math.round(name.top), bottom: Math.round(name.bottom), right: Math.round(name.right) } };
    });
    assert.ok(at.list < at.bars && at.list < at.guide, `the step list comes first (list ${at.list}, bars ${at.bars}, guide ${at.guide})`);
    assert.ok(at.firstRow <= at.vh - 96, `the first step's name and Change are on the first screen (${at.firstRow} of ${at.vh - 96})`);
    assert.equal(at.btn.text, '✎ Change');
    assert.equal(at.btn.label, 'Change step 5');
    assert.ok(at.btn.h >= 44 && at.btn.w >= 44, `target ${at.btn.w} by ${at.btn.h}`);
    assert.ok(at.btn.mid >= at.name.top - 16 && at.btn.mid <= at.name.bottom + 16, `the button is beside the name (${at.btn.mid} vs ${at.name.top}-${at.name.bottom})`);
    assert.ok(at.btn.right <= width, 'on the screen');
    await page.tap('[data-step="map-001-s5"] [data-test="step-change"]');
    await page.waitForSelector('[data-step="map-001-s5"] [data-test="step-form"]');
    assert.equal(await page.inputValue('#st-name'), 'Scan');
    const box = await page.locator('#st-name').boundingBox();
    assert.ok(box.y >= 0 && box.y + box.height <= 640, 'the name field is on the screen');
    assert.equal(await page.locator('[data-test="step-form"]').count(), 1, 'one form');
    assert.deepEqual(errors, []);
    await context.close();
  });
}
