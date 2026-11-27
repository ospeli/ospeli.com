// Result, crew night 5 (#189 held branch): once a change is marked the first screen names the
// longest wait after it and says in one line what it was before (never one range across both
// sides); "Mark a change" is a plain 44 px button at the foot of the bars whose first choice gives
// a table; the reason recorded on the walk follows the longest wait and is on the step's row; the
// time a step stood still once started is said apart from its wait. Synthetic imaging visit
// (result-seed.mjs); the page's clock is pinned and moved by the test.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, openPage } from './helpers.mjs';
import { walkIt, twoWalkMap, WALK1 } from './result-seed.mjs';

let env;
before(async () => { env = await startApp(); });
after(async () => { await env.close(); });

const DOCK = 96;
const open = (o = {}) => openPage(env, { path: '#/process', touch: true, locale: 'en-GB', timezoneId: 'UTC', clock: '2026-11-17T09:00:00Z', department: 'imaging', ...o });
const goMap = async (page) => { await page.goto(`${env.appUrl}#/process/map-001`); await page.waitForSelector('[data-test="result-table"]'); };
const flat = (s) => s.replace(/\s+/g, ' ').trim();
// Walk 3, after a change: the scan's wait down to 3 min (its reason recorded on the walk), the prep step stood still 3 min again.
const WALK3 = WALK1.map((s, i) => ({ ...s, wait: i === 4 ? 180 : Math.round(s.wait * 0.8) }));
async function threeWalks(page) {
  await twoWalkMap(page);
  await page.clock.fastForward(26 * 3600 * 1000);
  await walkIt(page, WALK3, { mapId: 'map-001' });
  // The one tap on the walk that records a reason (#180 point 1), set on the stored record of walk 3's scan.
  await page.evaluate(async () => {
    const core = window.ospeli.core; const raw = await core.getMeta('process-maps');
    raw.maps[0].walks[2].steps.find((s) => s.stepId === 'map-001-s5').waitReason = 'room-equipment';
    await core.setMeta('process-maps', raw);
  });
}

for (const [width, height] of [[360, 640], [390, 844]]) {
  test(`${width} px: "Mark a change" is a 44 px button at the foot of the bars; its first choice gives a table; the headline then names the wait after the change and, in one line, before it`, async () => {
    const { context, page, errors } = await open({ width, height });
    await threeWalks(page);
    await goMap(page);
    // Item 3: a plain button, not a fold, inside the bars card, before the actions and the table.
    const btn = await page.evaluate(() => {
      const b = document.querySelector('[data-test="change-open"]'); const r = b.getBoundingClientRect();
      return { tag: b.tagName, h: Math.round(r.height), inBars: !!b.closest('[data-test="walk-bars"]'), beforeTable: !!(b.compareDocumentPosition(document.querySelector('[data-test="result-table"]')) & Node.DOCUMENT_POSITION_FOLLOWING),
        inFoot: !!b.closest('.result-foot'), size: parseFloat(getComputedStyle(b).fontSize) };
    });
    assert.deepEqual(btn, { tag: 'BUTTON', h: btn.h, inBars: true, beforeTable: true, inFoot: false, size: btn.size });
    assert.ok(btn.h >= 44 && btn.size >= 15, `44 px target, 15 px text (${btn.h}, ${btn.size})`);
    await page.tap('[data-test="change-open"]');
    assert.equal(await page.inputValue('[data-test="change-after"]'), '2', 'after walk N-1: a table on the first save');
    await page.tap('[data-test="change-save"]');
    await page.waitForSelector('[data-test="change-caveat"]');
    // Item 1: the headline is the longest wait after the change; the line under it says the same step before.
    const head = flat(await page.textContent('[data-test="walk-longest"]'));
    assert.equal(head, 'Longest wait after the change: 4 min before “Cannula or prep”, on 1 walk');
    assert.equal(flat(await page.textContent('[data-test="walk-before-change"]')), 'Before the change: 4 to 5 min before “Cannula or prep”, 2 walks.');
    const answer = flat(await page.innerText('[data-test="walk-answer"]'));
    assert.match(answer, /45 min start to finish after the change \(1 walk\)/);
    assert.match(answer, /Before the change: 55 min to 1 h 6 min start to finish \(2 walks\)\./);
    assert.doesNotMatch(answer, /on 2 of 3 walks|walk 3, /, 'no range or list across both sides');
    assert.doesNotMatch(answer, /average|mean|improv|better|worse|worked|success/i, 'no verdict');
    // The headline and the line before it are on the first screen.
    await page.evaluate(() => window.scrollTo(0, 0));
    const y = await page.evaluate(() => Math.round(document.querySelector('[data-test="walk-before-change"]').getBoundingClientRect().bottom));
    assert.ok(y <= height - DOCK, `the before line ends at ${y}, above the dock at ${height - DOCK}`);
    // Item 4: the reason recorded on walk 3 for its scan wait is on the scan's row; item 5: the time the prep step stood still is apart.
    assert.equal(flat(await page.textContent('[data-test="result-table"] tr[data-row="map-001-s5"] [data-test="row-reason"]')), 'Reason recorded on walk 3: Room or equipment');
    const prep = await page.evaluate(() => [...document.querySelectorAll('[data-test="result-table"] tr[data-row="map-001-s4"] td')].map((td) => td.textContent.replace(/\s+/g, ' ').trim()));
    assert.match(prep[0], /^wait 4 to 5 min · 4 to 5 min · stood still 3 min, interrupted 1 time \(walk 1\)$/);
    assert.match(prep[1], /^wait 4 min · 4 min · stood still 3 min, interrupted 1 time$/);
    // Phone rules.
    const look = await page.evaluate(() => {
      const panel = document.querySelector('[data-test="result-panel"]'); const px = (e) => parseFloat(getComputedStyle(e).fontSize);
      const texts = [...panel.querySelectorAll('*')].filter((e) => e.checkVisibility() && e.getBoundingClientRect().width > 1 && [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()));
      return { sw: document.documentElement.scrollWidth - document.documentElement.clientWidth, small: texts.filter((e) => px(e) < 15).map((e) => `${e.tagName}.${e.className}:${px(e)}`),
        targets: [...panel.querySelectorAll('a, button, summary, select')].filter((e) => e.checkVisibility()).map((e) => [e.textContent.trim().slice(0, 20), Math.round(e.getBoundingClientRect().height)]).filter((t) => t[1] < 44) };
    });
    assert.ok(look.sw <= 0, `sideways scroll ${look.sw}`);
    assert.deepEqual(look.small, []);
    assert.deepEqual(look.targets, []);
    assert.deepEqual(errors, []);
    await context.close();
  });
}

test('390 px, no mark yet: the reason recorded on the walk follows the longest wait under the bar and is on the step\'s cell', async () => {
  const { context, page, errors } = await open({ width: 390, height: 844 });
  await threeWalks(page);
  await goMap(page);
  const lines = await page.locator('[data-test="bar-longest"]').allTextContents();
  assert.equal(lines[2], 'Longest wait: 4 min before “Cannula or prep”', 'walk 3: the prep step\'s 4 min wait, not 7 min with the 3 min it stood still');
  assert.equal(lines[0], 'Longest wait: 10 min before “Scan”');
  assert.equal(flat(await page.textContent('[data-test="result-table"] tr[data-row="map-001-s5"] td:last-child [data-test="cell-reason"]')), 'Reason recorded on the walk: Room or equipment');
  assert.deepEqual(errors, []);
  await context.close();
});

test('one walk: "Mark a change" says the next walk will be the first "after" walk', async () => {
  const { context, page, errors } = await open({ width: 360, height: 640 });
  await walkIt(page, WALK1);
  await goMap(page);
  await page.tap('[data-test="change-open"]');
  assert.equal(flat(await page.textContent('[data-test="change-help"]')), 'For a before and after. This walk counts as before the change; the next walk will be the first “after” walk.');
  assert.equal(await page.inputValue('[data-test="change-after"]'), '1');
  assert.deepEqual(errors, []);
  await context.close();
});
