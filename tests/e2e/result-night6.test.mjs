// Result, crew night 6: a step done again has its own pattern on the bar and its own line on the
// first result; how many step names and roles came from the list is said once (screen, Copy as
// text, print); a longest wait under 5 minutes keeps its seconds; a step with no name has a 44 px
// "Name this step" link to Edit map at that step. Synthetic imaging visit through the commands at
// no real site; the page's clock is pinned and moved by the test.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, openPage } from './helpers.mjs';
import { ME, redoWalk } from './result-seed.mjs';

let env;
before(async () => { env = await startApp(); });
after(async () => { await env.close(); });

const open = (o = {}) => openPage(env, { path: '#/process', touch: true, locale: 'en-GB', timezoneId: 'UTC', clock: '2026-11-17T09:00:00Z', department: 'imaging', ...o });
const flat = (s) => s.replace(/\s+/g, ' ').trim();
const run = (page, name, input = {}) => page.evaluate(async ([n, i, me]) => {
  const { runCommand } = await import('./core/commands.js');
  return runCommand(window.ospeli.core, n, i, me);
}, [name, input, ME]);
const tick = (page, s) => page.clock.fastForward(s * 1000);

const NAMES = '6 of 8 step names and 7 of 8 roles came from the list and were not confirmed on the walk.';
const AGAIN = 'Done again: Cannula or prep, 2 times, 6 min hands-on after the first time.';

for (const [width, height] of [[360, 640], [390, 844]]) {
  test(`${width} px: the redone step has its own pattern and line, the names line is said once, the longest wait keeps its seconds, and "Name this step" opens Edit map at that step`, async () => {
    const { context, page, errors } = await open({ width, height });
    await redoWalk(page);
    await page.goto(`${env.appUrl}#/process/map-001`); await page.waitForSelector('[data-test="result-table"]');
    // Item 3: seconds under 5 minutes in the headline and under the bar.
    assert.equal(flat(await page.textContent('[data-test="walk-longest"]')), 'Longest wait: 2 min 30 s before “Scan”');
    assert.equal(flat(await page.textContent('[data-test="bar-longest"]')), 'Longest wait: 2 min 30 s before “Scan”');
    // Item 1: its own line on the first result, not inside "Not as listed".
    const again = await page.evaluate(() => { const e = document.querySelector('[data-test="result-again"]'); return e && { text: e.textContent.replace(/\s+/g, ' ').trim(), inAnswer: !!e.closest('[data-test="walk-answer"]'), folded: !!e.closest('details') }; });
    assert.deepEqual(again, { text: AGAIN, inAnswer: true, folded: false });
    assert.equal(await page.locator('[data-test="result-extras"] [data-test="again-total"]').count(), 0, 'the total is no longer folded inside "Not as listed"');
    // Its own pattern on the bar, and words in the legend.
    const bar = await page.evaluate(() => {
      const segs = [...document.querySelectorAll('[data-test="bar-walk"] i[data-again="true"]')];
      const key = [...document.querySelectorAll('[data-test="bar-legend"] .key')].find((k) => /Done again/.test(k.textContent));
      const plain = document.querySelector('[data-test="bar-walk"] i.k:not([data-again])');
      return { n: segs.length, step: segs[0]?.dataset.step, bg: segs[0] && getComputedStyle(segs[0]).backgroundImage, plainBg: plain && getComputedStyle(plain).backgroundImage, key: key?.textContent.trim(), sw: key && getComputedStyle(key.querySelector('.rsw')).backgroundImage };
    });
    assert.equal(bar.n, 1, 'one hands-on segment done again');
    assert.equal(bar.step, 'map-001-s6');
    assert.match(bar.bg, /gradient/, 'a pattern, not a colour alone');
    assert.notEqual(bar.bg, bar.plainBg);
    assert.equal(bar.key, 'Done again');
    assert.equal(bar.sw, bar.bg, 'the legend shows the same pattern');
    // The bar's own words name it too.
    assert.match(await page.getAttribute('[data-test="bar-walk"]', 'aria-label'), /Done again: Cannula or prep/);
    // Item 2: said once, on the step table.
    assert.equal(await page.locator('[data-test="names-from"]').count(), 1);
    assert.equal(flat(await page.textContent('[data-test="names-from"]')), NAMES);
    // Copy as text holds the headline, the redo line and the names line.
    await page.evaluate(() => { window.__copied = null; navigator.clipboard.writeText = async (t) => { window.__copied = t; }; });
    await page.tap('[data-test="result-copy"]');
    const copied = await page.waitForFunction(() => window.__copied).then((x) => x.jsonValue());
    assert.match(copied, /\nLongest wait: 2 min 30 s before “Scan”\n/);
    assert.ok(copied.includes(`\n${AGAIN}\n`), 'the redo line in the copy');
    assert.ok(copied.includes(`\n${NAMES}\n`), 'the names line in the copy');
    assert.equal(copied.split(NAMES).length, 2, 'said once');
    assert.match(copied, /Walk 1, .*Longest wait: 2 min 30 s before “Scan”/);
    // Phone rules on the whole panel.
    const look = await page.evaluate(() => {
      const panel = document.querySelector('[data-test="result-panel"]'); const px = (e) => parseFloat(getComputedStyle(e).fontSize);
      const texts = [...panel.querySelectorAll('*')].filter((e) => e.checkVisibility() && e.getBoundingClientRect().width > 1 && [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()));
      return { sw: document.documentElement.scrollWidth - document.documentElement.clientWidth, small: texts.filter((e) => px(e) < 15).map((e) => `${e.tagName}.${e.className}:${px(e)}`),
        targets: [...panel.querySelectorAll('a, button, summary, select')].filter((e) => e.checkVisibility()).map((e) => [e.textContent.trim().slice(0, 20), Math.round(e.getBoundingClientRect().height)]).filter((t) => t[1] < 44),
        tall: Math.round(panel.getBoundingClientRect().bottom - document.querySelector('.result-head').getBoundingClientRect().top) };
    });
    assert.ok(look.sw <= 0, `sideways scroll ${look.sw}`);
    assert.deepEqual(look.small, []);
    assert.deepEqual(look.targets, []);
    if (width === 360) assert.ok(look.tall <= 1600, `the Result tab is ${look.tall} px tall at 360 px (limit 1600)`);
    // Item 4: the unnamed step has a 44 px link to Edit map at that step.
    const link = page.locator('[data-test="result-table"] tr[data-row="map-001-s8"] [data-test="name-step"]');
    assert.equal(await link.count(), 1);
    assert.equal(flat(await link.textContent()), 'Name this step');
    assert.equal(await link.getAttribute('href'), '#/process/map-001/edit/map-001-s8');
    assert.ok((await link.boundingBox()).height >= 44);
    assert.equal(await page.locator('[data-test="name-step"]').count(), 1, 'only the step with no name or role');
    await link.tap();
    await page.waitForSelector('[data-test="step-form"]');
    assert.equal(flat(await page.textContent('#st-h')), 'Change step 8');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'st-name');
    assert.equal(await page.getAttribute('[data-test="tab-edit"]', 'aria-selected'), 'true');
    assert.deepEqual(errors, []);
    await context.close();
  });
}

test('print: the names line and the redo line are on the printed page', async () => {
  const { context, page, errors } = await open({ width: 1280, height: 800, touch: false });
  await redoWalk(page);
  await page.goto(`${env.appUrl}#/process/map-001`); await page.waitForSelector('[data-test="result-table"]');
  await page.emulateMedia({ media: 'print' });
  const seen = await page.evaluate(() => ['names-from', 'result-again'].map((t) => document.querySelector(`[data-test="${t}"]`)?.checkVisibility() || false));
  assert.deepEqual(seen, [true, true]);
  assert.deepEqual(errors, []);
  await context.close();
});

test('a walk with every name typed on the walk and no step done again: no names line, no redo line, no "Name this step"', async () => {
  const { context, page, errors } = await open({ width: 360, height: 640 });
  await run(page, 'ospeli_walks_start', { title: 'Walk-in X-ray', guidanceSeen: true, department: 'imaging' });
  for (const [name, wait] of [['Came in', 200], ['X-ray taken', 100]]) {
    await tick(page, wait); await run(page, 'ospeli_walks_step_start'); await tick(page, 100); await run(page, 'ospeli_walks_step_done');
    await run(page, 'ospeli_walks_step_name', { name, role: 'Imaging staff', typed: true, roleFrom: 'chosen' });
  }
  await tick(page, 5); await run(page, 'ospeli_walks_finish');
  await page.goto(`${env.appUrl}#/process/map-001`); await page.waitForSelector('[data-test="result-table"]');
  assert.deepEqual(await page.evaluate(() => ['names-from', 'result-again', 'name-step'].map((t) => [t, document.querySelectorAll(`[data-test="${t}"]`).length, document.querySelector(`[data-test="${t}"]`)?.textContent || ''])), [['names-from', 0, ''], ['result-again', 0, ''], ['name-step', 0, '']]);
  assert.equal(flat(await page.textContent('[data-test="walk-longest"]')), 'Longest wait: 3 min 20 s before “Came in”');
  assert.deepEqual(errors, []);
  await context.close();
});
