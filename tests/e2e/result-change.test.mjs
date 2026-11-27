// Before and after a change (#189 item 6, module crew night 11): on Result a person marks "we
// changed something after walk N" (ospeli_maps_change_set). With walks on both sides the step table
// shows Before · After · Difference with the walk counts in its heads; one line under it says that
// Ospeli shows the difference and does not say whether the change worked. Print, Copy as text and
// CSV carry the same. Synthetic imaging visit (result-seed.mjs); the page's clock is pinned.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { startApp, openPage } from './helpers.mjs';
import { walkIt, twoWalkMap, threeWalkNine, WALK1, WALK2 } from './result-seed.mjs';

let env;
before(async () => { env = await startApp(); });
after(async () => { await env.close(); });

const DOCK = 96;
const open = (o = {}) => openPage(env, { path: '#/process', touch: true, locale: 'en-GB', timezoneId: 'UTC', clock: '2026-11-17T09:00:00Z', department: 'imaging', ...o });
const goMap = async (page) => { await page.goto(`${env.appUrl}#/process/map-001`); await page.waitForSelector('[data-test="result-table"]'); };
const flat = (s) => s.replace(/\s+/g, ' ').trim();
const CAVEAT = (n) => `Ospeli shows the difference. It does not say whether the change worked. ${n} walks are examples, not a sample.`;
// Walk 3, after a change: the same list, the scan's wait down to 3 min, the other waits a little shorter.
const WALK3 = WALK1.map((s, i) => ({ ...s, wait: i === 4 ? 180 : Math.round(s.wait * 0.8) }));
async function threeWalks(page) {
  await twoWalkMap(page);
  await page.clock.fastForward(26 * 3600 * 1000);
  await walkIt(page, WALK3, { mapId: 'map-001' });
}
const mark = async (page, n) => {
  await page.tap('[data-test="change-open"]');
  await page.selectOption('[data-test="change-after"]', String(n));
  await page.tap('[data-test="change-save"]');
  await page.waitForSelector('[data-test="change-remove"]');
};

for (const [width, height] of [[360, 640], [390, 844]]) {
  test(`${width} by ${height}: mark a change after walk 2; Before · After · Difference with the walk counts; the caveat; remove the mark`, async () => {
    const { context, page, errors } = await open({ width, height });
    await threeWalks(page);
    await goMap(page);
    assert.equal(flat(await page.textContent('[data-test="change-open"]')), 'Mark a change');
    await page.tap('[data-test="change-open"]');
    assert.deepEqual(await page.locator('[data-test="change-after"] option').allTextContents(), ['walk 1', 'walk 2', 'walk 3']);
    // #189 night 5 item 3: the choice offered first gives a table (after the walk before the newest).
    assert.equal(await page.inputValue('[data-test="change-after"]'), '2', 'with 2 or more walks, after walk N-1 is offered first');
    assert.match(flat(await page.textContent('[data-test="change-box"]')), /We changed something after ?walk 1 ?walk 2 ?walk 3/);
    await page.selectOption('[data-test="change-after"]', '2');
    await page.tap('[data-test="change-save"]');
    await page.waitForSelector('[data-test="change-remove"]');
    const stored = await page.evaluate(async () => (await window.ospeli.core.getMeta('process-maps')).maps[0].changeAfterWalk);
    assert.equal(stored, 2);
    assert.equal(flat(await page.textContent('[data-test="change-line"]')), 'Change marked after walk 2: walks 1 and 2 are before it, walk 3 after.');
    const heads = await page.evaluate(() => [...document.querySelectorAll('[data-test="result-table"] thead th')].filter((t) => t.checkVisibility()).map((t) => t.textContent.trim()));
    assert.deepEqual(heads.slice(-3), ['Before (2 walks)', 'After (1 walk)', 'Difference in the wait']);
    const scan = await page.evaluate(() => [...document.querySelectorAll('[data-test="result-table"] tr[data-row="map-001-s5"] td')].map((td) => [td.textContent.replace(/\s+/g, ' ').trim(), td.dataset.dir || null]));
    // The scan's first time on each walk; its second time on walk 2 is the row under it, never dropped (#189 night 5 item 2).
    assert.deepEqual(scan, [['wait 10 to 13 min · 14 to 15 min', null], ['wait 3 min · 15 min', null], ['shorter by 7 to 10 min', 'shorter']]);
    assert.match(flat(await page.textContent('[data-test="result-table"] tr[data-row="map-001-s5"] th')), /Done again on walk 2/);
    const redo = await page.evaluate(() => [...document.querySelectorAll('[data-test="result-table"] tr[data-row="again-map-001-s5"] td')].map((td) => td.textContent.replace(/\s+/g, ' ').trim()));
    assert.deepEqual(redo, ['on walk 2: wait 5 min · 7 min', 'not on these walks', 'only before the change']);
    // The step not on the list is kept, said as before only.
    assert.match(flat(await page.innerText('[data-test="result-table"]')), /\+ Contrast check · Radiology nurse Not on the list on walk 2: wait 2 min · 3 min not on these walks only before the change/);
    // Totals, then the caveat under the table.
    assert.match(flat(await page.innerText('[data-test="result-table"]')), /Start to finish .+ Waiting in all .+ Hands-on in all/);
    assert.equal(flat(await page.textContent('[data-test="change-caveat"]')), CAVEAT(3));
    assert.doesNotMatch(flat(await page.innerText('[data-test="result-panel"]')).replace(CAVEAT(3), ''), /average|improv|better|worse|worked|success/i, 'no judgement of the change');
    // The bars say where the change was made, in words.
    assert.equal(flat(await page.textContent('[data-test="bar-change"]')), 'Change made after walk 2: walks above it are before, below it after.');
    // The headline is still on the first screen; phone rules hold with the new columns.
    await page.evaluate(() => window.scrollTo(0, 0));
    const look = await page.evaluate(() => {
      const panel = document.querySelector('[data-test="result-panel"]'); const px = (e) => parseFloat(getComputedStyle(e).fontSize);
      const texts = [...panel.querySelectorAll('*')].filter((e) => e.checkVisibility() && e.getBoundingClientRect().width > 1 && [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()));
      return { head: Math.round(document.querySelector('[data-test="walk-longest"]').getBoundingClientRect().bottom), vh: innerHeight, sw: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        small: texts.filter((e) => px(e) < 15).map((e) => `${e.tagName}.${e.className}:${px(e)}`),
        targets: [...panel.querySelectorAll('a, button, summary, select')].filter((e) => e.checkVisibility()).map((e) => [e.textContent.trim().slice(0, 20), Math.round(e.getBoundingClientRect().height)]).filter((t) => t[1] < 44) };
    });
    assert.ok(look.head <= look.vh - DOCK, 'the headline is on the first screen');
    assert.ok(look.sw <= 0, `sideways scroll ${look.sw}`);
    assert.deepEqual(look.small, [], 'text 15 px or more');
    assert.deepEqual(look.targets, [], 'targets 44 px');
    // Remove the mark: the walk-by-walk table again.
    await page.tap('[data-test="change-remove"]');
    await page.waitForSelector('[data-test="change-open"]');
    assert.equal(await page.evaluate(async () => (await window.ospeli.core.getMeta('process-maps')).maps[0].changeAfterWalk ?? null), null);
    assert.equal(await page.locator('[data-test="change-caveat"], [data-test="bar-change"]').count(), 0);
    assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('[data-test="result-table"] thead th')].filter((t) => t.checkVisibility()).map((t) => t.textContent.trim())).then((x) => x.slice(-3)), ['Walk 1', 'Walk 2', 'Walk 3']);
    const audit = await page.evaluate(async () => (await window.ospeli.core.auditLog()).filter((a) => a.action.startsWith('map.change')).map((a) => a.action));
    assert.deepEqual(audit, ['map.change-marked', 'map.change-cleared']);
    assert.deepEqual(errors, []);
    await context.close();
  });
}

test('a mark with walks on one side only: the table stays walk by walk and one line says what the next walk counts as', async () => {
  const { context, page, errors } = await open({ width: 390, height: 844 });
  await twoWalkMap(page);
  await goMap(page);
  await mark(page, 2);
  assert.equal(flat(await page.textContent('[data-test="change-line"]')), 'Change marked after walk 2: walks 1 and 2 are before it. The next walk will be the first after the change.');
  assert.equal(await page.locator('[data-test="change-caveat"]').count(), 0);
  assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('[data-test="result-table"] thead th')].filter((t) => t.checkVisibility()).map((t) => t.textContent.trim())).then((x) => x.slice(-2)), ['Walk 1', 'Walk 2']);
  // One walk: the mark can be set after walk 1 only.
  assert.deepEqual(errors, []);
  await context.close();
});

test('one walk: "Mark a change" offers walk 1, and the line says the next walk is the first after', async () => {
  const { context, page, errors } = await open({ width: 360, height: 640 });
  await walkIt(page, WALK1);
  await goMap(page);
  await page.tap('[data-test="change-open"]');
  assert.deepEqual(await page.locator('[data-test="change-after"] option').allTextContents(), ['walk 1']);
  await page.tap('[data-test="change-save"]');
  await page.waitForSelector('[data-test="change-remove"]');
  assert.equal(flat(await page.textContent('[data-test="change-line"]')), 'Change marked after walk 1: walk 1 is before it. The next walk will be the first after the change.');
  assert.deepEqual(errors, []);
  await context.close();
});

test('print: a 3-walk, 9-step map with a change after walk 2 is one A4 page with Before · After · Difference and the caveat', async () => {
  const { context, page, errors } = await open({ width: 1280, height: 860, touch: false });
  await threeWalkNine(page);
  await goMap(page);
  await page.click('[data-test="change-open"]');
  await page.selectOption('[data-test="change-after"]', '2');
  await page.click('[data-test="change-save"]');
  await page.waitForSelector('[data-test="change-remove"]');
  await page.emulateMedia({ media: 'print' });
  const pr = await page.evaluate(() => ({ heads: [...document.querySelectorAll('[data-test="result-table"] thead th')].filter((e) => e.checkVisibility()).map((e) => e.textContent.trim()),
    caveat: document.querySelector('[data-test="change-caveat"]')?.checkVisibility() || false, line: document.querySelector('[data-test="bar-change"]')?.checkVisibility() || false,
    buttons: [...document.querySelectorAll('[data-test="change-box"] button, [data-test="change-box"] summary')].filter((e) => e.checkVisibility()).length }));
  assert.deepEqual(pr.heads, ['Step', 'Before (2 walks)', 'After (1 walk)', 'Difference in the wait']);
  assert.ok(pr.caveat && pr.line, 'the caveat and the change line print');
  assert.equal(pr.buttons, 0, 'no buttons on paper');
  const pdf = await page.pdf({ format: 'A4' });
  assert.equal((pdf.toString('latin1').match(/\/Type\s*\/Page\b(?!s)/g) || []).length, 1, 'exactly one page');
  assert.deepEqual(errors, []);
  await context.close();
});

test('Copy as text and CSV carry before, after and the difference; typed names stay text', async () => {
  const { context, page, errors } = await open({ width: 390, height: 844 });
  // A step name typed with markup in it: it must show as the same characters, never as HTML.
  await walkIt(page, WALK1);
  await page.clock.fastForward(26 * 3600 * 1000);
  await walkIt(page, WALK2.map((s) => (s.off ? { ...s, off: ['<b>Contrast</b> check', 'Radiology nurse'] } : s)), { mapId: 'map-001' });
  await page.clock.fastForward(26 * 3600 * 1000);
  await walkIt(page, WALK3, { mapId: 'map-001' });
  await goMap(page);
  await mark(page, 2);
  await page.evaluate(() => { window.__copied = null; navigator.clipboard.writeText = async (t) => { window.__copied = t; }; });
  const markup = await page.evaluate(() => ({ text: [...document.querySelectorAll('[data-test="result-table"] tr.is-extra th b')].map((b) => b.textContent), inner: document.querySelectorAll('[data-test="result-table"] tr.is-extra th b b').length }));
  assert.deepEqual(markup, { text: ['+ <b>Contrast</b> check'], inner: 0 });
  await page.tap('[data-test="result-copy"]');
  const copied = await page.waitForFunction(() => window.__copied).then((h) => h.jsonValue());
  assert.match(copied, /\n\nBefore and after \(change marked after walk 2\): Before \(2 walks\) \| After \(1 walk\) \| Difference in the wait\n/);
  assert.match(copied, /\n5\. Scan \(Imaging staff, done again on walk 2\): wait 10 to 13 min · 14 to 15 min \| wait 3 min · 15 min \| shorter by 7 to 10 min\n/);
  assert.match(copied, /\n {2}5\. Scan, done again \(Imaging staff, its later times on the same walk\): on walk 2: wait 5 min · 7 min \| not on these walks \| only before the change\n/);
  assert.match(copied, new RegExp(`\\n${CAVEAT(3).replace(/\./g, '\\.')}\\n`));
  const [dl] = await Promise.all([page.waitForEvent('download'), page.tap('[data-test="result-csv"]')]);
  const csv = (await readFile(await dl.path(), 'utf8')).replace(/^﻿/, '');
  const lines = csv.trimEnd().split('\r\n');
  // The column is found by its head: the walk Builder's three columns stay last (walk-reason-180).
  const col = lines[0].split(',').indexOf('"before or after the change"');
  assert.ok(col > 0, 'the CSV has a "before or after the change" column');
  const side = (n) => lines.slice(1).filter((l) => l.startsWith(`"Outpatient CT","Imaging","${n}"`)).map((l) => l.split(',')[col].replace(/"/g, ''));
  assert.deepEqual([...new Set(side(1)), ...new Set(side(2)), ...new Set(side(3))], ['before', 'before', 'after']);
  assert.deepEqual(errors, []);
  await context.close();
});
