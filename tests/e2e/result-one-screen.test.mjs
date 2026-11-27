// The one-screen result (walk-first week, crew night 3): a walked map opens on a Result tab with
// the header, the headline, one bar per walk split by step, the step table, the extra and redone
// steps, and Print, Copy as text, Download CSV and Share. Edit map holds the editing. Synthetic
// imaging visit (result-seed.mjs); the page's clock is pinned and moved by the test.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { startApp, openPage } from './helpers.mjs';
import { walkIt, twoWalkMap, threeWalkNine, WALK1, WALK2, IMAGING } from './result-seed.mjs';

let env;
before(async () => { env = await startApp(); });
after(async () => { await env.close(); });

const DOCK = 96;
const open = (o = {}) => openPage(env, { path: '#/process', touch: true, locale: 'en-GB', timezoneId: 'UTC', clock: '2026-11-17T09:00:00Z', department: 'imaging', ...o });
const goMap = async (page, tail = '') => { await page.goto(`${env.appUrl}#/process/map-001${tail}`); await page.waitForSelector(tail ? '.steps-box' : '[data-test="result-table"]'); };
const flat = (s) => s.replace(/\s+/g, ' ').trim();
const records = (page) => page.evaluate(async () => (await window.ospeli.core.getMeta('process-maps')).maps[0].walks);

for (const [width, height] of [[360, 640], [390, 844]]) {
  test(`${width} by ${height}: header, headline and the first bar on the first screen; the extra step and the redo in words; the coral outline on the longest wait`, async () => {
    const { context, page, errors } = await open({ width, height });
    await twoWalkMap(page);
    await goMap(page);
    await page.evaluate(() => window.scrollTo(0, 0));
    const look = await page.evaluate(() => {
      const r = (sel) => document.querySelector(sel).getBoundingClientRect();
      return { title: document.querySelector('[data-test="map-title"]').textContent, header: document.querySelector('[data-test="result-header"]').textContent.replace(/\s+/g, ' ').trim(),
        bottoms: ['[data-test="result-header"]', '[data-test="walk-longest"]', '[data-test="bar-walk"]'].map((s) => Math.round(r(s).bottom)), vh: innerHeight,
        tall: Math.round(document.querySelector('[data-test="result-panel"]').getBoundingClientRect().bottom - r('.result-head').top) };
    });
    assert.equal(look.title, 'Outpatient CT');
    assert.equal(look.header, '2 walks Imaging · 17–18 Nov 2026'.replace('17–18', look.header.match(/17\s?[–-]\s?18/)[0]));
    assert.ok(look.bottoms.every((y) => y <= look.vh - DOCK), `header, headline and first bar end at ${look.bottoms}, above the dock at ${look.vh - DOCK}`);
    if (width === 360) assert.ok(look.tall <= 2.5 * 640, `the Result tab is ${look.tall} px tall: at most 2.5 screens (1600 px)`);
    const head = flat(await page.textContent('[data-test="walk-longest"]'));
    assert.equal(head, 'Longest wait: 10 to 13 min before “Scan”, on both walks');
    // The outline: on the walk's own longest wait, in coral, and said in words that match the headline.
    const marks = await page.evaluate(() => [...document.querySelectorAll('[data-test="bar-walk"]')].map((b) => {
      const hot = [...b.querySelectorAll('[data-longest="true"]')];
      return { steps: hot.map((i) => i.dataset.step), outline: hot.map((i) => getComputedStyle(i).outlineColor), words: b.parentElement.querySelector('[data-test="bar-longest"]').textContent };
    }));
    assert.deepEqual(marks.map((x) => x.steps), [['map-001-s5'], ['map-001-s5']]);
    assert.ok(marks.every((x) => x.outline.every((c) => c === 'rgb(224, 88, 62)')), `coral outline: ${marks.map((x) => x.outline)}`);
    assert.deepEqual(marks.map((x) => x.words), ['Longest wait: 10 min before “Scan”', 'Longest wait: 13 min before “Scan”']);
    for (const m of marks) assert.ok(head.includes(m.words.match(/(before|at) “[^”]+”/)[0]), 'the words under each bar name the same place as the headline');
    // Extra and redone steps, in words, never dropped.
    const table = flat(await page.innerText('[data-test="result-table"]'));
    assert.match(table, /\+ Contrast check · Radiology nurse Not on the list · Only on walk 2/);
    assert.match(table, /Done 2 times/);
    // The time the prep step stood still once started is said apart from the wait before it (#180 point 2).
    assert.match(table, /wait 5 min · 4 min · stood still 3 min, interrupted 1 time/);
    assert.match(flat(await page.textContent('[data-test="result-extras"] summary')), /^Not as listed: 1 extra step, 1 step done again$/);
    // Phone rules: no sideways scroll, text 15 px (13 px captions), targets 44 px.
    const rules = await page.evaluate(() => {
      const panel = document.querySelector('[data-test="result-panel"]'); const px = (e) => parseFloat(getComputedStyle(e).fontSize);
      const texts = [...document.querySelectorAll('.result-head *, [data-test="result-panel"] *')].filter((e) => e.offsetParent && [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()));
      return { sw: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        small: texts.filter((e) => px(e) < 15 && !e.closest('caption')).map((e) => `${e.tagName}.${e.className}:${px(e)}`), cap: Math.min(...texts.filter((e) => e.closest('caption')).map(px)),
        targets: [...document.querySelectorAll('.result-head a, .result-head button, [data-test="result-panel"] a, [data-test="result-panel"] button, [data-test="result-panel"] summary')].filter((e) => e.offsetParent).map((e) => [e.textContent.trim().slice(0, 20), Math.round(e.getBoundingClientRect().height)]) };
    });
    assert.ok(rules.sw <= 0, `sideways scroll ${rules.sw}`);
    assert.deepEqual(rules.small, [], 'every text 15 px or more outside the caption');
    assert.ok(rules.cap >= 13, `caption ${rules.cap} px`);
    assert.ok(rules.targets.every((t) => t[1] >= 44), `targets ${JSON.stringify(rules.targets)}`);
    assert.deepEqual(errors, []);
    await context.close();
  });
}

test('table cells equal the walk records to the second (data-sec), shown in whole minutes', async () => {
  const { context, page, errors } = await open({ width: 390, height: 844 });
  await twoWalkMap(page);
  await goMap(page);
  const recs = await records(page);
  // data-sec: the wait before the step and the hands-on; data-stood: the time the step stood still once started (#180 point 2).
  const cells = await page.evaluate(() => [...document.querySelectorAll('[data-test="result-table"] tbody tr')].map((tr) => ({ row: tr.dataset.row, cells: [...tr.querySelectorAll('td')].map((td) => [td.dataset.status, td.dataset.sec || null, td.textContent, Number(td.dataset.stood || 0)]) })));
  const rowsOf = cells.filter((r) => r.row !== 'extra');
  assert.equal(rowsOf.length, 6);
  rowsOf.forEach((r, i) => r.cells.forEach(([status, sec, text, stood], w) => {
    const at = recs[w].steps.filter((s) => s.stepId === `map-001-s${i + 1}`);
    assert.equal(status, 'timed', `${IMAGING[i][0]} on walk ${w + 1}`);
    // The wait before the step and the time it stood still add up to the record's wait, to the second.
    assert.equal(stood, at.reduce((n, s) => n + (s.interruptedWaitSec || 0), 0), `${IMAGING[i][0]} on walk ${w + 1}`);
    assert.equal(sec, `${at.reduce((n, s) => n + s.waitSec, 0) - stood},${at.reduce((n, s) => n + s.workSec, 0)}`, `${IMAGING[i][0]} on walk ${w + 1}`);
    assert.match(text, /^(1st: )?wait (under 1 min|\d+ min) · (under 1 min|\d+ min)( · stood still \d+ min, interrupted 1 time)?/);
    assert.doesNotMatch(text, /\d+ s\b/);
  }));
  // The seconds behind the cells are the seconds the walks were timed with.
  assert.equal(rowsOf[4].cells[1][1], `${WALK2[5].wait + WALK2[6].wait},${WALK2[5].work + WALK2[6].work}`, 'the scan done again adds its two times');
  assert.equal(rowsOf[3].cells[0][1], `${WALK1[3].wait},${WALK1[3].work}`, 'the wait before the prep step leaves out the time it stood still');
  assert.equal(rowsOf[3].cells[0][3], WALK1[3].stood, 'the time the prep step stood still is kept beside it, to the second');
  const extra = cells.find((r) => r.row === 'extra');
  assert.deepEqual(extra.cells.map((c) => [c[0], c[1]]), [['not-on-walk', null], ['timed', `${WALK2[4].wait},${WALK2[4].work}`]]);
  assert.deepEqual(errors, []);
  await context.close();
});

test('print: a 3-walk, 9-step map is one A4 page with the header, the headline and "How to read this" opened; no dock, tabs or buttons', async () => {
  const { context, page, errors } = await open({ width: 1280, height: 860, touch: false });
  await threeWalkNine(page);
  await goMap(page);
  await page.emulateMedia({ media: 'print' });
  const pr = await page.evaluate(() => {
    const seen = (sel) => [...document.querySelectorAll(sel)].some((e) => e.checkVisibility());
    return { head: seen('[data-test="result-header"]'), headline: seen('[data-test="walk-longest"]'), readItems: [...document.querySelectorAll('[data-test="read-this"] li')].filter((e) => e.checkVisibility()).length,
      gone: ['#dock', '.walk-ribbon', '[data-test="map-tabs"]', '[data-test="result-actions"]', '.topbar'].filter(seen), foot: document.querySelector('[data-test="print-foot"]').checkVisibility() ? document.querySelector('[data-test="print-foot"]').textContent : null,
      cols: [...document.querySelectorAll('[data-test="result-table"] thead th')].filter((e) => e.checkVisibility()).length };
  });
  assert.ok(pr.head && pr.headline, 'header and headline print');
  assert.ok(pr.readItems >= 5, `"How to read this" is open on paper (${pr.readItems} lines)`);
  assert.deepEqual(pr.gone, [], 'no dock, ribbon, tabs, buttons or top bar on paper');
  assert.equal(pr.cols, 4, 'the step column and all three walks');
  assert.match(pr.foot, /Printed \d{1,2} [A-Z][a-z]{2} \d{4}/);
  const pdf = await page.pdf({ format: 'A4' });
  const raw = pdf.toString('latin1');
  assert.equal((raw.match(/\/Type\s*\/Page\b(?!s)/g) || []).length, 1, 'exactly one page');
  assert.deepEqual(errors, []);
  await context.close();
});

test('Copy as text, Download CSV (with the formula attack) and Share; Share is absent where the browser has none', async () => {
  const { context, page, errors } = await open({ width: 390, height: 844 });
  // A step name and role typed so that a spreadsheet would run them as formulas.
  await walkIt(page, WALK1, { title: 'Outpatient CT' });
  await page.clock.fastForward(26 * 3600 * 1000);
  await walkIt(page, WALK2.map((s) => (s.off ? { ...s, off: ['=1+2 check', '-Porter'] } : s)), { mapId: 'map-001' });
  await goMap(page);
  assert.equal(await page.locator('[data-test="result-share"]').count(), 0, 'no Share button where navigator.share does not exist');
  const labels = await page.locator('[data-test="result-actions"] a, [data-test="result-actions"] button').allTextContents();
  assert.deepEqual(labels, ['Walk the next patient', 'Print', 'Copy as text', 'Download CSV']);
  // Copy as text.
  await page.evaluate(() => { window.__copied = null; navigator.clipboard.writeText = async (t) => { window.__copied = t; }; });
  await page.tap('[data-test="result-copy"]');
  const copied = await page.waitForFunction(() => window.__copied).then((h) => h.jsonValue());
  assert.match(copied, /^Outpatient CT\n2 walks · Imaging · 17\s?[–-]\s?18 Nov 2026\n\nLongest wait: 10 to 13 min before “Scan”, on both walks\n/);
  assert.match(copied, /Walk 1, Tue,? 17 Nov, 09:00: \d+ min start to finish · waiting \d+ min · hands-on \d+ min\. Longest wait: 10 min before “Scan”/);
  assert.match(copied, /\n5\. Scan \(Imaging staff\): wait 10 min · 15 min \| 1st: wait 13 min · 14 min; 2nd: wait 5 min · 7 min\n/);
  assert.match(copied, /\n {2}\+ =1\+2 check \(-Porter, not on the list\): – \| wait 2 min · 3 min\n/);
  assert.match(copied, /How to read this: .+\nMeasured on 2 walks: examples, not a sample\.$/);
  // Download CSV.
  const [dl] = await Promise.all([page.waitForEvent('download'), page.tap('[data-test="result-csv"]')]);
  assert.equal(dl.suggestedFilename(), 'ospeli-outpatient-ct-walks.csv');
  const csv = (await readFile(await dl.path(), 'utf8')).replace(/^﻿/, '');
  const lines = csv.trimEnd().split('\r\n');
  assert.equal(lines.length, 1 + WALK1.length + WALK2.length, 'one row per walk per step');
  assert.match(lines[0], /^"map","department","walk number","walk date","step order","step","role","on list","wait seconds","hands-on seconds","not-seen seconds","interrupted count","stopped seconds \(inside wait\)","done again"/);
  assert.match(csv, /"Outpatient CT","Imaging","2","2026-11-18","5","'=1\+2 check","'-Porter","no","120","180","0","0","0","no","timed"/);
  for (const l of lines) for (const f of l.match(/"(?:[^"]|"")*"/g)) assert.doesNotMatch(f, /^"[=+\-@\t\r]/, `field ${f} would run as a formula`);
  const recs = await records(page);
  assert.match(csv, new RegExp(`"Outpatient CT","Imaging","1","2026-11-17","4","Cannula or prep","Radiology nurse","yes","${recs[0].steps[3].waitSec}","${recs[0].steps[3].workSec}","0","1","${recs[0].steps[3].interruptedWaitSec}","no","timed"`));
  assert.deepEqual(errors, []);
  await context.close();
});

test('Share, where the browser has it, sends the same plain text', async () => {
  const { context, page, errors } = await open({ width: 390, height: 844 });
  await context.addInitScript(() => { navigator.share = async (d) => { window.__shared = d; }; });
  await twoWalkMap(page);
  await page.reload(); await page.waitForSelector('html[data-ready="true"]');
  await goMap(page);
  assert.equal(await page.locator('[data-test="result-share"]').count(), 1);
  assert.ok((await page.locator('[data-test="result-share"]').boundingBox()).height >= 44);
  await page.tap('[data-test="result-share"]');
  const shared = await page.waitForFunction(() => window.__shared).then((h) => h.jsonValue());
  assert.equal(shared.title, 'Outpatient CT');
  assert.match(shared.text, /Longest wait: 10 to 13 min before “Scan”, on both walks[\s\S]*Measured on 2 walks: examples, not a sample\.$/);
  assert.doesNotMatch(shared.text, /<[a-z]/i, 'plain text, no markup');
  assert.deepEqual(errors, []);
  await context.close();
});

test('tabs: named, keyboard reachable with the arrow keys, the choice in the address; a reload and Back keep it', async () => {
  const { context, page, errors } = await open({ width: 1280, height: 860, touch: false });
  await twoWalkMap(page);
  await goMap(page);
  const tabs = await page.evaluate(() => ({ list: document.querySelector('[role="tablist"]')?.getAttribute('aria-label'),
    tabs: [...document.querySelectorAll('[role="tab"]')].map((t) => [t.textContent, t.getAttribute('aria-selected'), t.tabIndex, Math.round(t.getBoundingClientRect().height)]),
    panel: document.querySelector('[role="tabpanel"]')?.getAttribute('aria-labelledby') }));
  assert.equal(tabs.list, 'This map');
  assert.deepEqual(tabs.tabs.map((t) => t.slice(0, 3)), [['Result', 'true', 0], ['Edit map', 'false', -1]]);
  assert.ok(tabs.tabs.every((t) => t[3] >= 44));
  assert.equal(tabs.panel, 'tab-result');
  // Keyboard: Tab reaches the selected tab, the right arrow opens Edit map and keeps the focus on it.
  await page.focus('[data-test="tab-result"]');
  await page.keyboard.press('ArrowRight');
  await page.waitForSelector('.steps-box');
  assert.match(page.url(), /#\/process\/map-001\/edit$/);
  assert.equal(await page.evaluate(() => document.activeElement?.dataset.test), 'tab-edit');
  assert.equal(await page.getAttribute('[data-test="tab-edit"]', 'aria-selected'), 'true');
  assert.equal(await page.locator('[data-test="result-table"]').count(), 0);
  assert.equal(await page.locator('[data-test="guide"]').count(), 1, 'the guide is on Edit map');
  // A reload keeps Edit map; Back goes to Result.
  await page.reload(); await page.waitForSelector('html[data-ready="true"]');
  await page.waitForSelector('.steps-box');
  assert.equal(await page.getAttribute('[data-test="tab-edit"]', 'aria-selected'), 'true');
  await page.focus('[data-test="tab-edit"]');
  await page.keyboard.press('Home');
  await page.waitForSelector('[data-test="result-table"]');
  assert.match(page.url(), /#\/process\/map-001$/);
  await page.keyboard.press('End');
  await page.waitForSelector('.steps-box');
  await page.goBack();
  await page.waitForSelector('[data-test="result-table"]');
  assert.equal(await page.getAttribute('[data-test="tab-result"]', 'aria-selected'), 'true');
  assert.deepEqual(errors, []);
  await context.close();
});

test('a map typed by hand has no tabs and is unchanged: the list, the guide and Proposed on one page', async () => {
  const { context, page, errors } = await open({ width: 390, height: 844 });
  await page.waitForSelector('[data-test="map-chooser"]');
  await page.locator('[data-from="discharge"]').tap();
  await page.waitForSelector('[data-test="step-list"]');
  assert.equal(await page.locator('[role="tablist"], [data-test="result-panel"], [data-test="result-actions"]').count(), 0);
  assert.equal(await page.locator('[data-test="guide"]').count(), 1);
  assert.equal(await page.locator('[data-test="v-proposed"]').count(), 1);
  assert.equal(await page.locator('[data-test="pm-stats"] .pm-stat').count(), 4, 'the four numbers as before');
  assert.deepEqual(errors, []);
  await context.close();
});
