// The tap-through walk sheet (walk-first brief, Builder nights 4 to 6; 27 Nov 2026), in the browser
// on a phone. On a first walk in a department with a step list the list is the page, as rows:
//   - the main button is named for the step offered next and starts it by that name (kept as
//     "from the list", not confirmed by the person: #170); nothing is typed and no sheet opens;
//   - a row tapped while waiting starts that step, in any order (the name is then "chosen");
//   - a list step timed a second time is its own step, marked done again, and the mark can be taken away;
//   - a step that is not on the list is one tap away in the bar and is named after it ends.
// The clock is the page's own, moved forward by the test.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, openPage } from './helpers.mjs';

let env;
before(async () => { env = await startApp(); });
after(async () => { await env.close(); });

const state = (page, want) => page.waitForFunction((w) => document.querySelector('[data-test="walk"]')?.dataset.state === w, want);
const stored = (page) => page.evaluate(async () => (await window.ospeli.core.getMeta('process-walks'))?.walks || []);
const noSideways = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const row = (n) => `[data-test="walk-list-row"][data-n="${n}"]`;
const rowState = (page, n) => page.getAttribute(row(n), 'data-state');
const IMAGING = [['Arrived', 'Patient'], ['Registered', 'Reception'], ['Safety questions', 'Imaging staff'], ['Changed into gown', 'Patient'], ['Cannula or prep', 'Radiology nurse'], ['Scan', 'Imaging staff']];

// What a first-time user's thumb and eyes need after every tap.
const look = (page) => page.evaluate(() => {
  const box = (e) => { const b = e.getBoundingClientRect(); return { top: b.top, bottom: b.bottom, left: b.left, right: b.right, h: b.height }; };
  const main = document.querySelector('[data-test="walk-main"]'); const bar = document.querySelector('[data-test="walk-bar"]');
  const next = document.querySelector('[data-test="walk-list-row"][data-state="next"]');
  const head = document.querySelector('.topbar');
  const a = document.activeElement;
  return { vh: window.innerHeight, vw: window.innerWidth, main: box(main), mainText: main.textContent, barTop: box(bar).top,
    headBottom: head && /fixed|sticky/.test(getComputedStyle(head).position) ? head.getBoundingClientRect().bottom : 0,
    next: next ? box(next) : null,
    barButtons: [...bar.querySelectorAll('button')].map((e) => [e.textContent.trim(), Math.round(e.getBoundingClientRect().height)]),
    rows: [...document.querySelectorAll('[data-test="walk-list-row"], [data-test="walk-list-other"]')].map((e) => Math.round(e.getBoundingClientRect().height)),
    typing: !!a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable),
    sheet: !!document.querySelector('[data-test="walk-sheet"]') };
});
async function easy(page, when) {
  const l = await look(page);
  assert.ok(l.main.top >= 0 && l.main.bottom <= l.vh, `${when}: the main button is on the screen`);
  assert.ok(l.barButtons.every(([, h]) => h >= 44), `${when}: every button in the bar is 44 px high or more (${JSON.stringify(l.barButtons)})`);
  assert.ok(l.rows.length >= 9 && l.rows.every((h) => h >= 44), `${when}: every list row is 44 px high or more (${l.rows})`);
  assert.equal(l.typing, false, `${when}: nothing is being typed, so no keyboard`);
  assert.equal(l.sheet, false, `${when}: no naming sheet for a list step`);
  assert.ok(await noSideways(page) <= 0, `${when}: no sideways scroll`);
  if (l.next) assert.ok(l.next.top >= l.headBottom - 1 && l.next.bottom <= l.barTop + 1, `${when}: the next row is whole between the top bar and the walk's bar (${Math.round(l.next.top)} to ${Math.round(l.next.bottom)}; room ${Math.round(l.headBottom)} to ${Math.round(l.barTop)})`);
  return l;
}
async function begin(env2, { width = 360, height = 640 } = {}) {
  const o = await openPage(env2, { width, height, path: '#/process/walk', touch: true, department: 'imaging', clock: '2026-11-19T09:00:00' });
  await o.page.waitForSelector('[data-test="walk-before"]');
  return o;
}
const startWalk = async (page) => { await page.tap('[data-test="walk-before-ok"]'); await page.waitForSelector('[data-test="walk"][data-state="waiting"]'); await page.waitForSelector('[data-test="walk-list"]'); };

for (const [width, height] of [[360, 640], [390, 844]]) {
  test(`${width}x${height}, first-time user: a six-step imaging visit with the main button only, 15 taps or fewer, nothing typed, no naming sheet`, async () => {
    const { context, page, errors } = await begin(env, { width, height });
    let taps = 0;
    const tap = async (sel) => { await page.locator(sel).first().tap(); taps += 1; };
    await tap('[data-test="walk-before-ok"]');
    await page.waitForSelector('[data-test="walk"][data-state="waiting"]');
    await page.waitForSelector('[data-test="walk-list"]');
    for (const [i, [name, role]] of IMAGING.entries()) {
      let l = await easy(page, `before step ${i + 1}`);
      assert.equal(l.mainText, `${name} starts`, 'the main button names the step it will start');
      assert.equal(await rowState(page, i + 1), 'next');
      await page.clock.fastForward(60 * 1000);
      await tap('[data-test="walk-main"]'); await state(page, 'step');
      l = await easy(page, `step ${i + 1} running`);
      assert.equal(l.mainText, `${name} done`);
      assert.equal(await rowState(page, i + 1), 'running');
      assert.match(await page.textContent(row(i + 1)), /Timing now/);
      await page.clock.fastForward(120 * 1000);
      await tap('[data-test="walk-main"]'); await state(page, 'waiting');
      await page.waitForSelector('[data-test="walk-flash"]');
      // One line says what was saved, and that the words were the list's, not the person's.
      assert.equal(await page.textContent('[data-test="walk-flash"]'), `${name} saved · from the listChange`);
      assert.equal(await rowState(page, i + 1), 'timed');
      assert.match(await page.textContent(row(i + 1)), new RegExp(`${role} · waited 1 min · 2 min ${role === 'Patient' ? 'patient step' : 'hands-on'}`));
      // Adoption lead, 27 Nov: with the saved line showing, the bar leaves the list its room (300 px or less on a 360 by 640 phone).
      if (height === 640) { const bar = await page.locator('[data-test="walk-bar"]').boundingBox(); assert.ok(bar.height <= 300, `the bar is ${Math.round(bar.height)} px with the saved line`); }
    }
    await easy(page, 'six steps timed');
    await tap('[data-test="walk-finish"]');
    // "Check the names" is the finish question now (28 Nov); "Finish, check later" keeps the list's marks.
    await page.waitForSelector('[data-test="walk-check"]');
    await tap('[data-test="walk-check-later"]');
    await page.waitForSelector('[data-test="pm-stats"]');
    assert.ok(taps <= 15, `${taps} taps: start 1, six steps of 2 taps, finish 2`);
    const w = (await stored(page))[0];
    assert.deepEqual(w.steps.map((s) => [s.name, s.role, s.nameFrom, s.roleFrom]), IMAGING.map(([n, r]) => [n, r, 'list', 'list']));
    assert.deepEqual(errors, []);
    await context.close();
  });
}

test('360x640, out of order: a tapped row starts that step, its name is the person\'s choice and its role the list\'s; skipped rows keep no time', async () => {
  const { context, page, errors } = await begin(env);
  await startWalk(page);
  await page.clock.fastForward(30 * 1000);
  await page.locator(row(3)).tap(); await state(page, 'step');
  assert.equal(await rowState(page, 3), 'running');
  // While it runs the other rows wait: only its own row (or the main button) ends it.
  const others = await page.locator('[data-test="walk-list-row"]:not([data-n="3"]), [data-test="walk-list-other"]').evaluateAll((b) => b.map((x) => x.disabled));
  assert.ok(others.length >= 8 && others.every(Boolean), 'the other rows are disabled while a step runs');
  assert.equal(await page.locator(row(3)).isDisabled(), false);
  assert.equal((await page.textContent('[data-test="walk-main"]')).trim(), 'Safety questions done');
  await page.clock.fastForward(60 * 1000);
  await page.locator(row(3)).tap(); await state(page, 'waiting');
  await page.waitForSelector('[data-test="walk-flash"]');
  const w = (await stored(page))[0];
  assert.equal(w.steps.length, 1);
  assert.deepEqual([w.steps[0].name, w.steps[0].role, w.steps[0].nameFrom, w.steps[0].roleFrom], ['Safety questions', 'Imaging staff', 'chosen', 'list']);
  assert.match(await page.textContent('[data-test="walk-flash"]'), /^Safety questions saved · role from the listChange$/);
  // Rows 1 and 2 were not seen: never filled in, no time of their own.
  for (const n of [1, 2]) {
    assert.ok(['later', 'next'].includes(await rowState(page, n)), `row ${n} is not timed`);
    assert.doesNotMatch(await page.textContent(row(n)), /waited|hands-on|min/);
  }
  assert.equal(await rowState(page, 3), 'timed');
  assert.match(await page.textContent(row(3)), /waited under 1 min · 1 min hands-on/);
  assert.equal(await rowState(page, 4), 'next');
  assert.deepEqual(errors, []);
  await context.close();
});

test('360x640, done again: a list step timed a second time is its own step with a mark, and one tap takes the mark away', async () => {
  const { context, page, errors } = await begin(env);
  await startWalk(page);
  for (const n of [2, 3, 2]) {
    await page.clock.fastForward(30 * 1000);
    await page.locator(row(n)).tap(); await state(page, 'step');
    await page.clock.fastForward(60 * 1000);
    await page.tap('[data-test="walk-main"]'); await state(page, 'waiting');
  }
  await page.waitForSelector('[data-test="walk-again-mark"]');
  let w = (await stored(page))[0];
  assert.equal(w.steps.length, 3, 'the second time is not merged into the first');
  assert.deepEqual(w.steps.map((s) => [s.name, !!s.again]), [['Registered', false], ['Safety questions', false], ['Registered', true]]);
  assert.match(await page.textContent(row(2)), /done 2 times/);
  assert.match(await page.textContent('[data-test="walk-flash"]'), /^Registered saved · role from the list · done again/);
  // A slip, or an ordinary second time: the mark goes, the step and its times stay.
  await page.tap('[data-test="walk-not-again"]');
  await page.waitForFunction(() => !document.querySelector('[data-test="walk-again-mark"]'));
  w = (await stored(page))[0];
  assert.equal(w.steps.length, 3);
  assert.equal(w.steps[2].again, undefined);
  assert.equal(w.steps[2].name, 'Registered');
  assert.deepEqual(errors, []);
  await context.close();
});

test('360x640, a step not on the list: its button is on the screen while waiting, and the step is named after it ends with nothing chosen for the person', async () => {
  const { context, page, errors } = await begin(env);
  await startWalk(page);
  const onScreen = (when) => page.evaluate((w) => {
    const e = document.querySelector('[data-test="walk-other"]'); if (!e) return `${w}: no button`;
    const b = e.getBoundingClientRect();
    if (!(b.top >= 0 && b.bottom <= window.innerHeight && b.left >= 0 && b.right <= window.innerWidth)) return `${w}: off the screen (${b.top} to ${b.bottom})`;
    if (!e.contains(document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2))) return `${w}: something lies over it`;
    return b.height >= 44 ? null : `${w}: ${b.height} px high`;
  }, when);
  assert.equal(await onScreen('before any step'), null);
  await page.clock.fastForward(30 * 1000);
  await page.tap('[data-test="walk-main"]'); await state(page, 'step');
  await page.clock.fastForward(60 * 1000);
  await page.tap('[data-test="walk-main"]'); await state(page, 'waiting');
  assert.equal(await onScreen('after one step'), null);
  await page.clock.fastForward(30 * 1000);
  await page.tap('[data-test="walk-other"]'); await state(page, 'step');
  assert.equal((await page.textContent('[data-test="walk-main"]')).trim(), 'Step done');
  await page.clock.fastForward(60 * 1000);
  await page.tap('[data-test="walk-main"]'); await state(page, 'waiting');
  await page.waitForSelector('[data-test="walk-sheet"]');
  // Nothing is chosen for the person, and nothing is saved yet.
  assert.equal(await page.locator('[data-test="walk-sheet"] [data-chip][aria-pressed="true"]').count(), 0);
  assert.equal((await stored(page))[0].steps[1].name, null);
  await page.locator('[data-test="walk-sheet"] [data-chip="name"]').first().tap();
  await page.locator('[data-test="walk-sheet"] [data-chip="role"]:text-is("Reception")').tap();
  await page.waitForFunction(() => !document.querySelector('[data-test="walk-sheet"]'));
  const s = (await stored(page))[0].steps[1];
  assert.ok(s.name, 'the step has the name that was tapped');
  assert.deepEqual([s.role, s.nameFrom, s.roleFrom], ['Reception', 'chosen', 'chosen']);
  assert.deepEqual(errors, []);
  await context.close();
});

test('360x640, undo: the step started with the main button is taken back, the row is next again and nothing is stored', async () => {
  const { context, page, errors } = await begin(env);
  await startWalk(page);
  await page.clock.fastForward(20 * 1000);
  await page.tap('[data-test="walk-main"]'); await state(page, 'step');
  assert.equal(await rowState(page, 1), 'running');
  await page.tap('[data-test="walk-undo"]'); await state(page, 'waiting');
  assert.equal(await rowState(page, 1), 'next');
  assert.equal((await page.textContent('[data-test="walk-main"]')).trim(), 'Arrived starts');
  const w = (await stored(page))[0];
  assert.equal(w.steps.length, 0); assert.equal(w.current, null);
  assert.deepEqual(errors, []);
  await context.close();
});
