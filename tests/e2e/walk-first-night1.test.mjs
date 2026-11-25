// Walk-first week, Builder night 1 (ospeli/ospeli docs/briefs/2026-11-22-walk-first.md), in the
// browser at 360 and 390 px. The acceptance lines that belong to the walk screen:
//   - the main button is on the screen in every state of a walk (checked after every tap);
//   - once the department is set, the first walk of a 6-step imaging visit needs at most 15 taps
//     from the before-you-walk screen and nothing typed;
//   - a walk that had an interruption is walked again and every tap is filed under its own step.
// The clock is the page's own, moved forward by the test.
// Since the one-screen result (crew night 3) a walked map opens on its Result tab; the step list
// and the guide are read on the Edit map tab (a tap after the walk, so not in the walk's count).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, openPage, openMore } from './helpers.mjs';

let env;
before(async () => { env = await startApp(); });
after(async () => { await env.close(); });

const state = (page, want) => page.waitForFunction((w) => document.querySelector('[data-test="walk"]')?.dataset.state === w, want);
const stored = (page) => page.evaluate(async () => (await window.ospeli.core.getMeta('process-walks'))?.walks || []);
const noSideways = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
// Where the main button, the clock and Pause are, and whether the page's dock is showing.
const look = (page) => page.evaluate(() => {
  const r = (sel) => { const e = document.querySelector(sel); if (!e) return null; const b = e.getBoundingClientRect(); return { top: b.top, bottom: b.bottom, left: b.left, right: b.right, h: b.height, w: b.width }; };
  const main = document.querySelector('[data-test="walk-main"]');
  const mid = main.getBoundingClientRect();
  return { main: r('[data-test="walk-main"]'), timer: r('[data-test="walk-timer"]'), pause: r('[data-test="walk-pause"]'), mainText: main.textContent,
    // The element a finger would hit at the middle of the main button is the button itself: nothing lies over it.
    onTop: main.contains(document.elementFromPoint(mid.left + mid.width / 2, mid.top + mid.height / 2)),
    dock: getComputedStyle(document.querySelector('.dock')).display, vh: window.innerHeight, vw: window.innerWidth,
    targets: [...document.querySelectorAll('[data-test="walk-bar"] button')].map((e) => Math.round(e.getBoundingClientRect().height)) };
});
// The acceptance line: the main button (and the clock) are on the screen, whole, with nothing over them.
async function mainOnScreen(page, when) {
  const l = await look(page);
  assert.ok(l.main.top >= 0 && l.main.bottom <= l.vh && l.main.left >= 0 && l.main.right <= l.vw, `${when}: the main button is on the screen (${Math.round(l.main.top)} to ${Math.round(l.main.bottom)} of ${l.vh})`);
  assert.ok(l.onTop, `${when}: nothing lies over the main button`);
  assert.ok(l.main.h >= 72, `${when}: the main button is ${l.main.h} px high`);
  assert.ok(l.timer.top >= 0 && l.timer.bottom <= l.main.top, `${when}: the clock is on the screen, above the button`);
  assert.equal(l.dock, 'none', `${when}: the dock is hidden during a walk`);
  assert.ok(l.targets.every((h) => h >= 44), `${when}: tap targets ${l.targets}`);
  return l;
}
const IMAGING = [['Arrived', 'Patient'], ['Registered', 'Reception'], ['Safety questions', 'Imaging staff'], ['Changed into gown', 'Patient'], ['Cannula or prep', 'Radiology nurse'], ['Scan', 'Imaging staff']];

for (const [width, height] of [[360, 640], [390, 844]]) {
  test(`${width} px, imaging: a first walk of six steps in 15 taps from the before-you-walk screen, nothing typed, the main button on the screen after every tap`, async () => {
    const { context, page, errors } = await openPage(env, { width, height, touch: true, department: 'imaging', clock: '2026-11-19T09:00:00' });
    let taps = 0;
    const tap = async (sel) => { await page.locator(sel).first().tap(); taps += 1; };
    // From Now, Walk is one tap (the dock); the count of the walk itself starts on the screen it opens.
    await page.locator('.dock [data-dock="walk"]').tap();
    await page.waitForSelector('[data-test="walk-before"]');
    // The examples are the department's own; the box can be left empty.
    assert.deepEqual(await page.locator('[data-chip="title"]').allTextContents(), ['Outpatient CT', 'Outpatient MRI', 'Walk-in X-ray', 'Inpatient ultrasound']);
    const okBox = await page.locator('[data-test="walk-before-ok"]').boundingBox();
    assert.ok(okBox.y + okBox.height <= height, `the start button is on the first screen (${okBox.y + okBox.height} of ${height})`);
    await tap('[data-test="walk-before-ok"]');
    await page.waitForSelector('[data-test="walk"]');
    await mainOnScreen(page, 'walk started');
    for (const [i, [name, role]] of IMAGING.entries()) {
      await page.clock.fastForward(60 * 1000);
      await tap('[data-test="walk-main"]'); await state(page, 'step');
      let l = await mainOnScreen(page, `step ${i + 1} running`);
      assert.equal(l.mainText, 'Step done');
      // The step before was saved by that tap, with the words that were offered, and one line says so.
      if (i > 0) assert.match(await page.textContent('[data-test="walk-flash"]'), new RegExp(`^Step ${i} saved as ${IMAGING[i - 1][0]} · ${IMAGING[i - 1][1]}Change$`));
      await page.clock.fastForward(120 * 1000);
      await tap('[data-test="walk-main"]'); await state(page, 'waiting');
      await page.waitForSelector('[data-test="walk-sheet"]');
      l = await mainOnScreen(page, `step ${i + 1} done, naming sheet open`);
      // The usual next step and its usual role are offered, already chosen and first in their rows.
      assert.equal(await page.locator('[data-test="walk-row-name"] [data-chip]').first().textContent(), name);
      assert.deepEqual(await page.locator('[data-chip][aria-pressed="true"]').allTextContents(), [name, role]);
      assert.match(await page.textContent('[data-test="walk-sheet-hint"]'), /^Next on the list\. Tap another if not\.$/);
      assert.equal((await stored(page))[0].steps[i].name, null, 'an offer is not saved until the next tap');
      assert.ok(await noSideways(page) <= 0);
    }
    // Finish is on the screen beside Pause and Undo, with nothing to scroll, and keeps what is chosen for the last step.
    const fin = await page.locator('[data-test="walk-finish"]').boundingBox();
    assert.equal(await page.locator('[data-test="walk-finish"]').count(), 1);
    assert.ok(fin.y >= 0 && fin.y + fin.height <= height && fin.height >= 44, `Finish walk is on the first screen (${fin.y} to ${fin.y + fin.height} of ${height})`);
    await tap('[data-test="walk-finish"]');
    await page.waitForSelector('[data-test="walk-confirm"]');
    await mainOnScreen(page, 'finish asked');
    const yes = await page.locator('[data-test="walk-finish-yes"]').boundingBox();
    assert.ok(yes.y >= 0 && yes.y + yes.height <= height, 'the answer is on the screen too');
    await tap('[data-test="walk-finish-yes"]');
    await page.waitForSelector('[data-test="pm-stats"]');
    assert.equal(taps, 15, 'start 1, six steps of 2 taps, finish 2');
    const w = (await stored(page))[0];
    assert.deepEqual(w.steps.map((s) => [s.name, s.role]), IMAGING);
    assert.equal(w.department, 'imaging');
    await page.tap('[data-test="tab-edit"]');
    await page.waitForSelector('[data-test="tab-edit"][aria-selected="true"]');
    assert.equal(await page.locator('[data-test="step-list"] li').count(), 6);
    assert.equal(await page.evaluate(() => document.documentElement.dataset.walkFull), undefined, 'the dock is back after the walk');
    assert.notEqual(await page.evaluate(() => getComputedStyle(document.querySelector('.dock')).display), 'none');
    assert.deepEqual(errors, []);
    await context.close();
  });
}

test('360 px: Pause never moves, Undo has its own place, More options and a typed name keep the main button on the screen, and the way out leaves the walk running', async () => {
  const { context, page, errors } = await openPage(env, { width: 360, height: 640, path: '#/process/walk', touch: true, department: 'imaging', clock: '2026-11-19T09:00:00' });
  await page.waitForSelector('[data-test="walk-before"]');
  // What is being walked: one tap on an example, and it is the walk's title.
  await page.locator('[data-chip="title"]:text-is("Outpatient CT")').tap();
  assert.equal(await page.inputValue('#wk-title'), 'Outpatient CT');
  await page.tap('[data-test="walk-before-ok"]');
  await page.waitForSelector('[data-test="walk"]');
  assert.equal((await stored(page))[0].title, 'Outpatient CT');
  assert.match(await page.textContent('[data-test="walk-sub"]'), /^Outpatient CT · step by step$/);
  const places = [];
  const note = async (when) => { const l = await mainOnScreen(page, when); if (l.pause) places.push([when, Math.round(l.pause.left), Math.round(l.pause.w)]); return l; };
  await note('waiting, no undo');
  assert.equal(await page.locator('[data-test="walk-undo"]').count(), 0);
  await page.clock.fastForward(30 * 1000);
  await page.tap('[data-test="walk-main"]'); await state(page, 'step');
  assert.equal(await page.locator('[data-test="walk-undo"]').count(), 1);
  await note('step, undo offered');
  await page.clock.runFor(11000);
  await page.waitForFunction(() => !document.querySelector('[data-test="walk-undo"]'));
  await note('step, undo gone');
  await page.clock.fastForward(30 * 1000);
  await page.tap('[data-test="walk-main"]'); await page.waitForSelector('[data-test="walk-sheet"]');
  await note('naming, undo offered');
  // Typing is behind "More options". With it open the sheet scrolls inside itself; the button stays.
  await openMore(page);
  await note('more options open');
  await page.fill('#wk-name', 'Sent to the other desk');
  await page.locator('[data-chip="role"]:text-is("Reception")').tap();
  await page.waitForFunction(() => !document.querySelector('[data-test="walk-sheet"]'));
  assert.deepEqual((await stored(page))[0].steps.map((s) => [s.name, s.role]), [['Sent to the other desk', 'Reception']]);
  // The next step: a name typed once is offered straight away, and the offer is still the list's first step.
  await page.clock.fastForward(30 * 1000);
  await page.tap('[data-test="walk-main"]'); await state(page, 'step');
  await page.clock.fastForward(30 * 1000);
  await page.tap('[data-test="walk-main"]'); await page.waitForSelector('[data-test="walk-sheet"]');
  assert.deepEqual((await page.locator('[data-test="walk-row-name"] [data-chip]').allTextContents()).slice(0, 3), ['Arrived', 'Sent to the other desk', 'Registered']);
  // Another step than the one offered: one tap on it brings its usual role, and the main button saves both.
  await page.locator('[data-chip="name"]:text-is("Registered")').tap();
  assert.deepEqual(await page.locator('[data-chip][aria-pressed="true"]').allTextContents(), ['Registered', 'Reception']);
  assert.equal((await stored(page))[0].steps[1].name, null);
  await page.clock.fastForward(30 * 1000);
  await page.tap('[data-test="walk-main"]'); await state(page, 'step');
  assert.deepEqual((await stored(page))[0].steps.map((s) => [s.name, s.role]), [['Sent to the other desk', 'Reception'], ['Registered', 'Reception']]);
  // "Change" on the line that says what was saved opens the sheet again for that step, while the next one runs.
  await page.tap('[data-test="walk-flash-change"]'); await page.waitForSelector('[data-test="walk-sheet"]');
  await note('changing a saved name during a step');
  await page.locator('[data-chip="role"]:text-is("Imaging staff")').tap();
  await page.waitForFunction(() => !document.querySelector('[data-test="walk-sheet"]'));
  assert.deepEqual((await stored(page))[0].steps[1].role, 'Imaging staff');
  // Pause: the same place holds nothing while paused, and Pause is where it was when back.
  await page.tap('[data-test="walk-pause"]'); await state(page, 'paused');
  await mainOnScreen(page, 'paused');
  await page.tap('[data-test="walk-main"]'); await state(page, 'step');
  await note('back from a pause');
  assert.equal(new Set(places.map((p) => `${p[1]}/${p[2]}`)).size, 1, `Pause is in one place in every state: ${JSON.stringify(places)}`);
  // Rename, then leave: the walk keeps running, the dock is back, and Walk returns to it.
  await page.tap('[data-test="walk-rename"]');
  await page.fill('#wk-rename', 'Outpatient CT with contrast');
  await page.tap('[data-test="walk-rename-save"]');
  await page.waitForFunction(() => /Outpatient CT with contrast/.test(document.querySelector('[data-test="walk-sub"]')?.textContent || ''));
  // The way out is at the top of the walk (the person scrolled down to rename it).
  await page.evaluate(() => window.scrollTo(0, 0));
  const leave = await page.locator('[data-test="walk-leave"]').boundingBox();
  assert.ok(leave.height >= 44 && leave.y >= 0, `the way out is a full-size target at the top (${leave.height} px high at ${leave.y})`);
  assert.equal((await page.textContent('[data-test="walk-leave"]')).trim(), 'Leave walk running');
  await page.tap('[data-test="walk-leave"]');
  await page.waitForFunction(() => document.documentElement.dataset.route === '#/home' && !document.documentElement.dataset.walkFull);
  assert.notEqual(await page.evaluate(() => getComputedStyle(document.querySelector('.dock')).display), 'none');
  const kept = (await stored(page))[0];
  assert.deepEqual([kept.status, kept.title, !!kept.current], ['walking', 'Outpatient CT with contrast', true], 'the walk is still running, with its step');
  await page.locator('.dock [data-dock="walk"]').tap();
  await state(page, 'step');
  await mainOnScreen(page, 'back on the walk');
  assert.deepEqual(errors, []);
  await context.close();
});

test('390 px: after "Step interrupted" the main button carries the same step on by default; it is one step on the map, and the walk is walked again with every tap under its own step', async () => {
  const { context, page, errors } = await openPage(env, { width: 390, height: 844, path: '#/process/walk', touch: true, department: 'imaging', clock: '2026-11-19T09:00:00' });
  await page.waitForSelector('[data-test="walk-before"]');
  await page.tap('[data-test="walk-before-ok"]');
  await page.waitForSelector('[data-test="walk"]');
  // Walk 1: six steps of 60 s waiting and 120 s hands-on; step 4 stops after 120 s, stands still 300 s, then takes 180 s more.
  for (let i = 0; i < 6; i++) {
    await page.clock.fastForward(60 * 1000);
    await page.tap('[data-test="walk-main"]'); await state(page, 'step');
    await page.clock.fastForward(120 * 1000);
    if (i === 3) {
      await page.tap('[data-test="walk-stopped"]'); await state(page, 'waiting');
      await page.waitForSelector('[data-test="walk-resume"]');
      // The default is the same step: the big button says so, and "No, new step" is beside it.
      assert.equal(await page.textContent('[data-test="walk-resume"]'), 'Step 4 was interrupted. Same step again?');
      // The step offered for it is named on the button, and the sheet asks for the interrupted step's name.
      assert.equal(await page.textContent('[data-test="walk-main"]'), 'Changed into gown carries on');
      assert.equal(await page.textContent('[data-test="walk-sheet-hint"]'), 'Next on the list. Tap another if not.');
      assert.equal(await page.textContent('[data-test="walk-new-step"]'), 'No, new step');
      await mainOnScreen(page, 'interrupted');
      await page.clock.fastForward(300 * 1000);
      await page.tap('[data-test="walk-main"]'); await state(page, 'step');
      const mid = (await stored(page))[0];
      assert.equal(mid.steps.length, 3, 'the interrupted step is running again, not saved as a step of its own');
      assert.equal(mid.current.name, 'Changed into gown', 'what was chosen when it stopped is kept');
      // Undo takes the coming back away again, and the choice is offered as before.
      await page.tap('[data-test="walk-undo"]'); await state(page, 'waiting');
      assert.equal(await page.textContent('[data-test="walk-main"]'), 'Changed into gown carries on');
      await page.tap('[data-test="walk-main"]'); await state(page, 'step');
      await page.clock.fastForward(180 * 1000);
    }
    await page.tap('[data-test="walk-main"]'); await state(page, 'waiting');
  }
  await page.tap('[data-test="walk-finish"]');
  await page.tap('[data-test="walk-finish-yes"]');
  await page.waitForSelector('[data-test="pm-stats"]');
  const one = (await stored(page))[0];
  assert.deepEqual(one.steps.map((s) => s.name), IMAGING.map((s) => s[0]), 'six steps, each once');
  const m = await page.evaluate(async () => (await window.ospeli.core.getMeta('process-maps')).maps[0]);
  assert.equal(m.today.length, 6);
  // Hands-on 120 + 180 s. Waiting 60 s before it and 300 s stood still (the undo and the second coming back
  // are real taps, so up to 3 s more of standing still). The two parts of the waiting always add up.
  const scan = m.today[3];
  assert.equal(scan.workSec, 300); assert.equal(scan.interruptions, 1);
  assert.ok(scan.interruptedWaitSec >= 300 && scan.interruptedWaitSec <= 303, `stood still ${scan.interruptedWaitSec} s`);
  assert.equal(scan.waitSec, 60 + scan.interruptedWaitSec);
  // Start to finish is the six steps and the time the fourth stood still and went on: 6 x 180 + 300 + 180 s = 26 min
  // (the undo and the second coming back are real taps, so a second or two more).
  assert.match(await page.textContent('[data-test="pm-stats"]'), /26 min( [1-3] s)?\s*start to finish on this walk/);
  // The guide counts the interruption and says where the longest wait was (on the Edit map tab).
  await page.tap('[data-test="tab-edit"]');
  await page.waitForSelector('[data-test="tab-edit"][aria-selected="true"]');
  const guide = await page.textContent('[data-test="guide"]');
  assert.match(guide, /Longest wait on this walk: 6 min( [1-3] s)? at “Changed into gown” \(5 min( [1-3] s)? of it while the step was interrupted\)/);
  assert.match(guide, /1 interruption on this walk: 5 min( [1-3] s)? stood still/);

  // Walk 2 of the same map: the button names each list step, and each tap is filed under it.
  // "Walk the next patient" is on the Result tab.
  await page.tap('[data-test="tab-result"]');
  await page.waitForSelector('[data-test="result-panel"]');
  await page.tap('[data-test="walk-again"]');
  await page.waitForSelector('[data-test="walk-before"]');
  assert.equal(await page.locator('#wk-title').count(), 0, 'a repeat walk carries its map\'s title: nothing to name');
  await page.tap('[data-test="walk-before-ok"]');
  await page.waitForSelector('[data-test="walk"]');
  for (let i = 0; i < 6; i++) {
    assert.equal(await page.textContent('[data-test="walk-main"]'), `${IMAGING[i][0]} starts`);
    await page.clock.fastForward(60 * 1000);
    await page.tap('[data-test="walk-main"]'); await state(page, 'step');
    assert.equal(await page.textContent('[data-test="walk-main"]'), `${IMAGING[i][0]} done`);
    await mainOnScreen(page, `walk 2, step ${i + 1}`);
    await page.clock.fastForward(10 * (i + 1) * 1000);
    await page.tap('[data-test="walk-main"]'); await state(page, 'waiting');
    await mainOnScreen(page, `walk 2, step ${i + 1} done`);
  }
  assert.equal(await page.textContent('[data-test="walk-main"]'), 'Step starts', 'the list is used up');
  await page.tap('[data-test="walk-finish"]');
  await page.tap('[data-test="walk-finish-yes"]');
  await page.waitForSelector('[data-test="pm-stats"]');
  const two = (await stored(page))[1];
  assert.deepEqual(two.steps.map((s) => [s.name, s.planIndex, Math.round((Date.parse(s.endAt) - Date.parse(s.startAt)) / 1000)]), IMAGING.map((s, i) => [s[0], i, 10 * (i + 1)]));
  assert.deepEqual(errors, []);
  await context.close();
});

test('390 px: "No, new step" after an interruption starts a new step, and a name that looks like a person is refused for a walk and for a step without losing a tap', async () => {
  const { context, page, errors } = await openPage(env, { width: 390, height: 844, path: '#/process/walk', touch: true, department: 'outpatients', clock: '2026-11-19T09:00:00' });
  await page.waitForSelector('[data-test="walk-before"]');
  // Outpatients has its own examples and words.
  assert.deepEqual(await page.locator('[data-chip="title"]').allTextContents(), ['Morning clinic visit', 'Follow-up visit']);
  await page.fill('#wk-title', 'Mr J. Smith');
  await page.tap('[data-test="walk-before-ok"]');
  await page.waitForSelector('[data-test="walk-error"]');
  assert.match(await page.textContent('[data-test="walk-error"]'), /person's name or a personal detail/);
  assert.equal((await stored(page)).length, 0, 'no walk was started with it');
  await page.fill('#wk-title', 'Follow-up visit');
  await page.tap('[data-test="walk-before-ok"]');
  await page.waitForSelector('[data-test="walk"]');
  await page.clock.fastForward(30 * 1000);
  await page.tap('[data-test="walk-main"]'); await state(page, 'step');
  await page.clock.fastForward(30 * 1000);
  await page.tap('[data-test="walk-stopped"]'); await state(page, 'waiting');
  assert.deepEqual(await page.locator('[data-chip][aria-pressed="true"]').allTextContents(), ['Checked in at reception', 'Reception']);
  await page.clock.fastForward(30 * 1000);
  await page.tap('[data-test="walk-new-step"]'); await state(page, 'step');
  let w = (await stored(page))[0];
  assert.deepEqual([w.steps.length, w.steps[0].interrupted, w.steps[0].name, !!w.current, w.current.gaps], [1, true, 'Checked in at reception', true, undefined]);
  // A typed name that names a person: the tap that ends the next step is still stamped, and the sheet says why.
  await page.clock.fastForward(30 * 1000);
  await page.tap('[data-test="walk-main"]'); await page.waitForSelector('[data-test="walk-sheet"]');
  await openMore(page);
  await page.fill('#wk-name', 'Seen by Dr Sarah Jones');
  await page.clock.fastForward(30 * 1000);
  await page.tap('[data-test="walk-main"]'); await state(page, 'step');
  await page.waitForSelector('[data-test="walk-error"]');
  await mainOnScreen(page, 'a refused name, the next step running');
  w = (await stored(page))[0];
  assert.deepEqual([w.steps.length, w.steps[1].name, !!w.current], [2, null, true], 'the step started; the refused words were not saved');
  assert.equal(await page.inputValue('#wk-name'), 'Seen by Dr Sarah Jones', 'what was typed is still there to change');
  assert.deepEqual(errors.filter((e) => !/invalid-input|400/.test(e)), []);
  await context.close();
});

test('the phone is asked to keep the data when a walk starts; one honest line shows only when it says no', async () => {
  for (const answer of [false, true]) {
    const { context, page, errors } = await openPage(env, { width: 360, height: 640, touch: true, department: 'imaging' });
    await context.addInitScript((a) => {
      window.__persistAsked = 0; let kept = false;
      Object.defineProperty(navigator, 'storage', { configurable: true, value: { persist: async () => { window.__persistAsked += 1; kept = a; return a; }, persisted: async () => kept, estimate: async () => ({ usage: 0, quota: 1e9 }) } });
    }, answer);
    await page.goto(`${env.appUrl}#/process/walk`);
    await page.reload();
    await page.waitForSelector('[data-test="walk-before"]');
    // The app asks once when it opens (issue #87); the walk asks again at the moment it matters.
    const atOpen = await page.evaluate(() => window.__persistAsked);
    assert.ok(atOpen <= 1, `asked ${atOpen} times at opening`);
    await page.tap('[data-test="walk-before-ok"]');
    await page.waitForSelector('[data-test="walk"]');
    assert.equal(await page.evaluate(() => window.__persistAsked), atOpen + 1, 'asked once more when the walk starts');
    if (answer) assert.equal(await page.locator('[data-test="walk-keep"]').count(), 0);
    else {
      assert.equal(await page.textContent('[data-test="walk-keep"]'), 'This phone may clear saved walks. Finish, then print or save the map today.');
      await mainOnScreen(page, 'the line about keeping data');
    }
    assert.deepEqual(errors, []);
    await context.close();
  }
});
