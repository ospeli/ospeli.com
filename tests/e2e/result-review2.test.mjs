// Result review fixes (#189, the night 5 review), in the browser at 360 and 390 px: each line of
// the headline names its own side's longest wait; the differences add up from the minutes shown;
// on a phone the Before · After · Difference table is a block per step, each cell on its own line;
// a difference from one walk says so; "on walk 1" sits after the interruption; with a walk running
// the "Change made after walk 2" line can be scrolled clear of the ribbon and dock. Synthetic
// imaging visit (result-seed.mjs); the page's clock is pinned and moved by the test.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, openPage } from './helpers.mjs';
import { walkIt, twoWalkMap, WALK1 } from './result-seed.mjs';

let env;
before(async () => { env = await startApp(); });
after(async () => { await env.close(); });

const open = (o = {}) => openPage(env, { path: '#/process', touch: true, locale: 'en-GB', timezoneId: 'UTC', clock: '2026-11-17T09:00:00Z', department: 'imaging', ...o });
const flat = (s) => s.replace(/\s+/g, ' ').trim();
const WALK3 = WALK1.map((s, i) => ({ ...s, wait: i === 4 ? 180 : Math.round(s.wait * 0.8) }));
async function marked(page) {
  await twoWalkMap(page);
  await page.clock.fastForward(26 * 3600 * 1000);
  await walkIt(page, WALK3, { mapId: 'map-001' });
  await page.goto(`${env.appUrl}#/process/map-001`);
  await page.waitForSelector('[data-test="result-table"]');
  await page.click('[data-test="change-open"]');
  await page.click('[data-test="change-save"]');
  await page.waitForSelector('[data-test="change-caveat"]');
}
// The free part of the screen ends at the dock or the walk ribbon, whichever is higher.
const foot = () => { const r = document.querySelector('#walk-ribbon'); const d = document.querySelector('#dock').getBoundingClientRect().top;
  return Math.min(d, r && !r.hidden ? r.getBoundingClientRect().top : Infinity); };

for (const [width, height] of [[360, 640], [360, 740], [390, 844]]) {
  test(`${width}x${height}: each headline line names its own side's longest wait; the extra line only while the answer fits the first screen`, async () => {
    const { context, page, errors } = await open({ width, height });
    await marked(page);
    await page.evaluate(() => window.scrollTo(0, 0));
    assert.equal(flat(await page.textContent('[data-test="walk-longest"]')), 'Longest wait after the change: 4 min before “Cannula or prep”, on 1 walk');
    assert.equal(flat(await page.textContent('[data-test="walk-before-change"]')), 'Before the change, the longest wait was 10 to 13 min before “Scan” (2 walks).');
    const look = await page.evaluate((f) => {
      const same = document.querySelector('[data-test="walk-before-same"]');
      return { shown: !!same && same.checkVisibility(), text: same?.textContent, bottom: document.querySelector('[data-test="walk-answer"]').getBoundingClientRect().bottom, foot: new Function(`return (${f})()`)() };
    }, foot.toString());
    assert.equal(look.text, '“Cannula or prep” before the change: 4 to 5 min (2 walks).');
    if (look.shown) assert.ok(look.bottom <= look.foot, `the extra line is shown only while the answer ends above the dock (${look.bottom}, ${look.foot})`);
    if (height >= 740) assert.equal(look.shown, true, 'room for it at this height');
    assert.deepEqual(errors, []);
    await context.close();
  });
}

for (const width of [360, 390]) {
  test(`${width} px: the Before · After · Difference table is a block per step, each cell on its own line at 15 px; differences add up and say when one walk gave them`, async () => {
    const { context, page, errors } = await open({ width, height: 800 });
    await marked(page);
    const rows = await page.evaluate(() => [...document.querySelectorAll('.rcompare tbody tr')].map((tr) => {
      const tds = [...tr.querySelectorAll('td')];
      return { name: tr.querySelector('th').textContent.replace(/\s+/g, ' ').trim(), lines: tds.map((td) => `${getComputedStyle(td, '::before').content.replace(/^"|"$/g, '')}${td.textContent}`),
        block: tds.every((td) => getComputedStyle(td).display === 'block'), size: Math.min(...tds.map((td) => parseFloat(getComputedStyle(td).fontSize))),
        tops: tds.map((td) => Math.round(td.getBoundingClientRect().top)), role: tr.getAttribute('role'), cellRoles: tds.map((td) => td.getAttribute('role')) };
    }));
    assert.ok(rows.length >= 10);
    for (const r of rows) {
      assert.equal(r.block, true, `${r.name}: cells stacked`);
      assert.ok(r.size >= 15, `${r.name}: 15 px`);
      assert.ok(r.tops[0] < r.tops[1] && r.tops[1] < r.tops[2], `${r.name}: each cell on its own line`);
      assert.match(r.lines[0], /^Before \(2 walks\): /); assert.match(r.lines[1], /^After \(1 walk\): /); assert.match(r.lines[2], /^Difference: /);
      assert.deepEqual([r.role, ...r.cellRoles], ['row', 'cell', 'cell', 'cell'], 'still a table to a screen reader');
    }
    const wait = rows.find((r) => r.name === 'Waiting in all');
    assert.deepEqual(wait.lines, ['Before (2 walks): 26 to 30 min', 'After (1 walk): 16 min', 'Difference: shorter by 10 to 14 min (1 walk after)']);
    const prep = rows.find((r) => r.name.startsWith('4. Cannula or prep'));
    assert.equal(prep.lines[0], 'Before (2 walks): wait 4 to 5 min · 4 to 5 min · stood still 3 min, interrupted 1 time on walk 1');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), 'no sideways scroll');
    assert.deepEqual(errors, []);
    await context.close();
  });
}

test('700 px and print: the three-column table stays', async () => {
  const { context, page, errors } = await open({ width: 700, height: 900, touch: false });
  await marked(page);
  const cols = () => page.evaluate(() => { const tds = [...document.querySelectorAll('.rcompare tbody tr:first-child td')]; return tds.map((td) => [getComputedStyle(td).display, Math.round(td.getBoundingClientRect().top)]); });
  let c = await cols();
  assert.ok(c[0][1] === c[1][1] && c[1][1] === c[2][1], `three cells side by side at 700 px (${JSON.stringify(c)})`);
  await page.setViewportSize({ width: 360, height: 800 });
  await page.emulateMedia({ media: 'print' });
  c = await cols();
  assert.deepEqual(c.map((x) => x[0]), ['table-cell', 'table-cell', 'table-cell'], 'a table on paper');
  assert.deepEqual(errors, []);
  await context.close();
});

for (const [width, height] of [[360, 640], [390, 844]]) {
  test(`${width}x${height}, a walk running: the "Change made after walk 2" line and the foot of the page can be scrolled clear of the ribbon and dock`, async () => {
    const { context, page, errors } = await open({ width, height });
    await marked(page);
    await page.evaluate(async () => {
      const { runCommand } = await import('./core/commands.js');
      await runCommand(window.ospeli.core, 'ospeli_walks_start', { guidanceSeen: true }, { type: 'human', role: document.documentElement.dataset.role });
    });
    await page.waitForFunction(() => { const r = document.querySelector('#walk-ribbon'); return r && !r.hidden && r.getBoundingClientRect().height > 0; });
    for (const sel of ['[data-test="bar-change"]', '[data-test="walk-bars"] .rb-foot', '[data-test="walk-bars"]']) {
      const r = await page.evaluate(([s, f]) => {
        const el = document.querySelector(s); el.scrollIntoView({ block: 'end' });
        const b = el.getBoundingClientRect(); const hit = document.elementFromPoint(b.left + b.width / 2, b.bottom - 2);
        return { bottom: Math.round(b.bottom), foot: Math.round(new Function(`return (${f})()`)()), mine: !!hit && el.contains(hit) };
      }, [sel, foot.toString()]);
      assert.ok(r.bottom <= r.foot && r.mine, `${sel} scrolled clear (ends at ${r.bottom}, free part ends at ${r.foot}, under ${r.mine ? 'nothing' : 'the dock or ribbon'})`);
    }
    const end = await page.evaluate((f) => { window.scrollTo(0, document.documentElement.scrollHeight);
      const last = [...document.querySelectorAll('.result > *')].filter((e) => e.checkVisibility()).pop();
      return { bottom: Math.round(last.getBoundingClientRect().bottom), foot: Math.round(new Function(`return (${f})()`)()) }; }, foot.toString());
    assert.ok(end.bottom + 8 <= end.foot, `the foot of the Result page ends above the ribbon and dock with room (${end.bottom}, ${end.foot})`);
    assert.deepEqual(errors, []);
    await context.close();
  });
}
