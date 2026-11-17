// Walk mode (backlog PM2): follow one visit with a phone, tap as things happen, get a timed map.
// The first-time-user test does the whole main task at 360 px in a fixed number of taps, with
// nothing typed. The others cover a reload in the middle, mistakes, names, and no connection.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, openPage } from './helpers.mjs';

let env;
before(async () => { env = await startApp(); });
after(async () => { await env.close(); });

const noSideways = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const walkState = (page) => page.getAttribute('[data-test="walk"]', 'data-state');
const stored = (page) => page.evaluate(async () => (await window.ospeli.core.getMeta('process-walks'))?.walks || []);

test('first-time user at 360 px: walk three steps and see the timed map in 15 taps, nothing typed', async () => {
  // A UK-English phone, so the walk's date has one exact form (other devices: locale-41.test.mjs).
  const { context, page, errors } = await openPage(env, { width: 360, height: 780, path: '#/process', touch: true, locale: 'en-GB' });
  let taps = 0;
  const tap = async (sel) => { await page.locator(sel).first().tap(); taps += 1; };
  await page.waitForSelector('[data-test="walk-card"]');
  // The walk card is the first thing on the page, above the examples.
  const first = await page.evaluate(() => document.querySelector('[data-test="process-body"]').firstElementChild.getAttribute('data-test'));
  assert.equal(first, 'walk-card');
  assert.match(await page.textContent('[data-test="walk-card"]'), /Walk it and time it.*No names, no patient details\. Works with no connection\./s);
  const started = Date.now();
  await tap('[data-test="walk-start"]');
  await page.waitForSelector('[data-test="walk"]');
  assert.match(page.url(), /#\/process\/walk$/);

  // The walk screen: the state, a big timer and one big button, all on the first screen.
  const look = await page.evaluate(() => {
    const r = (sel) => document.querySelector(sel).getBoundingClientRect();
    const px = (e) => parseFloat(getComputedStyle(e).fontSize);
    const walk = document.querySelector('[data-test="walk"]');
    return {
      state: document.querySelector('[data-test="walk-state"]').textContent, main: document.querySelector('[data-test="walk-main"]').textContent,
      mainH: r('[data-test="walk-main"]').height, mainBottom: r('[data-test="walk-main"]').bottom, mainW: r('[data-test="walk-main"]').width,
      timerPx: px(document.querySelector('[data-test="walk-timer"]')), cardW: r('[data-test="walk"]').width,
      smallest: Math.min(...[...walk.querySelectorAll('h1, p, span, button, label')].filter((e) => e.textContent.trim() && e.offsetParent).map(px)),
      targets: [...walk.querySelectorAll('button:not([disabled]), a')].filter((e) => e.offsetParent).map((e) => Math.round(e.getBoundingClientRect().height)),
      headHidden: document.querySelector('.page-head').hidden, words: walk.innerText.split(/\s+/).length,
      finishDisabled: document.querySelector('[data-test="walk-finish"]').disabled,
    };
  });
  assert.equal(look.state, 'Waiting');
  assert.equal(look.main, 'Step starts');
  assert.ok(look.mainH >= 72, `the main button is ${look.mainH}px high`);
  assert.ok(look.mainW >= 280 && look.mainW >= look.cardW - 36, `the main button is as wide as the walk (${look.mainW} of ${look.cardW})`);
  assert.ok(look.mainBottom <= 780, `the main button is on the first screen (${look.mainBottom})`);
  assert.ok(look.timerPx >= 56, `the timer is the biggest thing (${look.timerPx}px)`);
  assert.ok(look.smallest >= 15, `smallest text ${look.smallest}px`);
  assert.ok(look.targets.every((x) => x >= 44), `tap targets ${look.targets}`);
  assert.equal(look.headHidden, true, 'nothing but the walk on the screen');
  assert.ok(look.words <= 75, `${look.words} words on the walk screen`);
  assert.equal(look.finishDisabled, true, 'Finish waits for one step');
  assert.ok(await noSideways(page) <= 0);

  // Three steps: starts, done, what happened (tap), which role (tap; the second answer saves).
  const steps = [['Checked in at reception', 'Reception'], ['Seen by a nurse', 'Nurse'], ['Seen by a doctor', 'Doctor']];
  for (const [name, role] of steps) {
    await page.waitForTimeout(1100);
    await tap('[data-test="walk-main"]');
    await page.waitForFunction(() => document.querySelector('[data-test="walk"]')?.dataset.state === 'step');
    assert.equal(await page.textContent('[data-test="walk-state"]'), 'Hands-on');
    assert.equal(await page.textContent('[data-test="walk-main"]'), 'Step done');
    await page.waitForTimeout(1100);
    await tap('[data-test="walk-main"]');
    await page.waitForSelector('[data-test="walk-sheet"]');
    await tap(`[data-chip="name"]:text-is("${name}")`);
    await tap(`[data-chip="role"]:text-is("${role}")`);
    await page.waitForFunction(() => !document.querySelector('[data-test="walk-sheet"]'));
  }
  assert.match(await page.textContent('.walk-meta'), /3 steps saved/);
  await tap('[data-test="walk-finish"]');
  assert.match(await page.textContent('[data-test="walk-confirm"]'), /Finish and see the map\?/);
  await tap('[data-test="walk-finish-yes"]');
  await page.waitForSelector('[data-test="pm-stats"]');
  assert.equal(taps, 15, 'start 1, three steps of 4 taps, finish 2');
  assert.ok(Date.now() - started < 5 * 60 * 1000, 'well under five minutes');

  // The map: measured on one walk, in seconds, and it says what one walk can show.
  assert.match(page.url(), /#\/process\/map-001$/);
  assert.match(await page.textContent('[data-test="walk-badge"]'), /^Measured on one walk$/);
  assert.match(await page.textContent('[data-test="map-title"]'), /^Walk 1 · This walk$/);
  assert.match(await page.textContent('.walk-when'), /Walked [A-Z][a-z]{2} \d{1,2} [A-Z][a-z]{2}, started \d\d:\d\d/);
  assert.equal(await page.textContent('[data-test="v-today"]'), 'This walk');
  assert.doesNotMatch(await page.textContent('[data-test="process-body"]'), /Today/, 'a dated walk is never called Today');
  assert.match(await page.textContent('[data-test="walk-note"]'), /Times from one walk on .+, started \d\d:\d\d\. This is what happened once, not how the process usually runs\./);
  assert.match(await page.textContent('[data-test="pm-stats"]'), /\d+ s\s*start to finish on this walk/);
  assert.equal(await page.locator('[data-test="step-list"] li').count(), 3);
  const text = await page.textContent('[data-test="process-body"]');
  for (const [name, role] of steps) { assert.ok(text.includes(name)); assert.ok(text.includes(role)); }
  assert.doesNotMatch(text, /null|undefined|NaN/);
  assert.match(await page.textContent('[data-test="guide"]'), /Longest wait on this walk: \d+ s before/);
  assert.equal(await page.locator('[data-cmd="ospeli_maps_try_suggestion"]').count(), 0, 'no change is offered on one walk');
  assert.ok(await noSideways(page) <= 0);
  // What the screen shows is what the tap times give.
  const w = (await stored(page))[0];
  assert.equal(w.status, 'finished'); assert.equal(w.mapId, 'map-001');
  const waits = w.steps.map((s, i) => Math.round((Date.parse(s.startAt) - Date.parse(i ? w.steps[i - 1].endAt : w.startedAt)) / 1000));
  assert.ok(waits.every((x) => x >= 1), `each wait was timed (${waits})`);
  // The audit trail has the taps, as a person, with no step text.
  const audit = await page.evaluate(async () => (await window.ospeli.core.auditLog()).filter((a) => a.action.startsWith('walk.')));
  assert.equal(audit.length, 11);
  assert.ok(audit.every((a) => a.actorType === 'human'));
  assert.ok(!JSON.stringify(audit).includes('Reception'));
  assert.deepEqual(errors, []);
  await context.close();
});

test('a reload in the middle loses nothing; undo, name it later, work stopped, a hand-over with no wait, a typed name is refused (390px)', async () => {
  const { context, page, errors } = await openPage(env, { width: 390, path: '#/process', touch: true });
  await page.waitForSelector('[data-test="walk-start"]');
  await page.tap('[data-test="walk-start"]');
  await page.waitForSelector('[data-test="walk"]');
  await page.tap('[data-test="walk-main"]');
  await page.waitForFunction(() => document.querySelector('[data-test="walk"]')?.dataset.state === 'step');
  // A mistaken tap: undo is offered and takes it back.
  await page.tap('[data-test="walk-undo"]');
  await page.waitForFunction(() => document.querySelector('[data-test="walk"]')?.dataset.state === 'waiting');
  await page.tap('[data-test="walk-main"]');
  await page.waitForFunction(() => document.querySelector('[data-test="walk"]')?.dataset.state === 'step');

  // The phone is reloaded mid-step: the page says a walk is in progress and it carries on.
  await page.goto(`${env.appUrl}#/process`);
  await page.reload();
  await page.waitForSelector('[data-test="walk-card"]');
  assert.match(await page.textContent('[data-test="walk-card"]'), /Walk in progress.*The clock is still running\./s);
  assert.equal(await page.locator('[data-test="walk-start"]').count(), 0);
  await page.tap('[data-test="walk-continue"]');
  await page.waitForSelector('[data-test="walk"]');
  assert.equal(await walkState(page), 'step', 'the step is still running');
  await page.waitForTimeout(1100);

  // Step 1: a typed person's name is refused; a role is asked for.
  await page.tap('[data-test="walk-main"]');
  await page.waitForSelector('[data-test="walk-sheet"]');
  await page.fill('#wk-name', 'Seen by Dr Sarah Jones');
  await page.fill('#wk-role', 'Doctor');
  await page.tap('[data-test="walk-save"]');
  await page.waitForSelector('[data-test="walk-error"]');
  assert.match(await page.textContent('[data-test="walk-error"]'), /looks like a person's name\. Use a role instead/);
  assert.equal(await page.inputValue('#wk-name'), 'Seen by Dr Sarah Jones', 'what was typed is still there to change');
  assert.equal((await stored(page))[0].steps[0].name, null, 'nothing was saved');
  // The hand-over: the next step had already started, so there is no wait before it.
  await page.fill('#wk-name', 'Seen by a doctor');
  await page.fill('#wk-role', 'Doctor');
  await page.check('#wk-next');
  await page.tap('[data-test="walk-save"]');
  await page.waitForFunction(() => document.querySelector('[data-test="walk"]')?.dataset.state === 'step' && !document.querySelector('[data-test="walk-sheet"]'));
  await page.waitForTimeout(1100);
  // Step 2: the work stops before it is finished; it is named later.
  await page.tap('[data-test="walk-stopped"]');
  await page.waitForSelector('[data-test="walk-sheet"]');
  await page.tap('[data-test="walk-later"]');
  await page.waitForFunction(() => !document.querySelector('[data-test="walk-sheet"]'));
  let w = (await stored(page))[0];
  assert.equal(w.steps.length, 2);
  assert.equal(w.steps[1].startAt, w.steps[0].endAt, 'no wait between the two');
  assert.equal(w.steps[1].interrupted, true);
  // A reload now offers the sheet again for the step with no name.
  await page.reload();
  await page.waitForSelector('[data-test="walk-sheet"]');
  await page.tap('[data-test="walk-later"]');
  await page.tap('[data-test="walk-finish"]');
  await page.tap('[data-test="walk-finish-yes"]');
  await page.waitForSelector('[data-test="pm-stats"]');
  const body = await page.textContent('[data-test="process-body"]');
  assert.match(body, /Step 2/); assert.match(body, /Not set/); assert.match(body, /interrupted/);
  assert.match(await page.textContent('[data-test="guide"]'), /1 step has no name or role yet/);
  // Naming it on the map keeps its measured time; changing a time by hand says so.
  await page.click('[data-test="step-list"] li >> nth=1 >> [aria-label="Change step 2"]');
  await page.waitForSelector('#st-name');
  await page.fill('#st-name', 'Medicines collected');
  await page.fill('#st-role', 'Pharmacy');
  await page.fill('#st-wait', '4');
  await page.click('[data-cmd="ospeli_maps_step_update"]');
  await page.waitForFunction(() => /time changed by hand/.test(document.querySelector('[data-test="step-list"]')?.textContent || ''));
  assert.match(await page.textContent('[data-test="step-list"]'), /Waits 4 min/);
  // The map no longer says "measured": a time was changed by hand. Proposed is a what-if.
  assert.equal(await page.textContent('[data-test="walk-badge"]'), 'One walk, changed by hand');
  assert.match(await page.textContent('[data-test="walk-note"]'), /changed by hand after the walk/);
  await page.click('[data-test="v-proposed"]');
  await page.waitForFunction(() => document.querySelector('[data-test="walk-badge"]')?.textContent === 'What-if, not measured');
  assert.doesNotMatch(await page.textContent('[data-test="pm-stats"]'), /on this walk/);
  await page.click('[data-test="v-today"]');
  await page.waitForFunction(() => /This walk$/.test(document.querySelector('[data-test="map-title"]')?.textContent || ''));
  // The list of maps says which map came from a walk; a new walk can start.
  await page.click('a.back');
  await page.waitForSelector('[data-test="map-link"]');
  assert.match(await page.textContent('[data-test="map-link"]'), /measured on one walk/);
  assert.equal(await page.locator('[data-test="walk-start"]').count(), 1);
  assert.ok(await noSideways(page) <= 0);
  assert.deepEqual(errors, []);
  await context.close();
});

test('with no connection the walk still works, and a walk can be deleted (1280px)', async () => {
  const { context, page, errors } = await openPage(env, { width: 1280, path: '#/process' });
  await page.waitForSelector('[data-test="walk-start"]');
  await page.waitForFunction(() => navigator.serviceWorker?.controller != null, null, { timeout: 15000 }).catch(() => {});
  await context.setOffline(true);
  await page.click('[data-test="walk-start"]');
  await page.waitForSelector('[data-test="walk"]');
  await page.click('[data-test="walk-main"]');
  await page.waitForFunction(() => document.querySelector('[data-test="walk"]')?.dataset.state === 'step');
  await page.waitForTimeout(1800);
  const timer = await page.textContent('[data-test="walk-timer"]');
  assert.match(timer, /^0:0[1-9]$/, `the timer runs (${timer})`);
  await page.click('[data-test="walk-main"]');
  await page.waitForSelector('[data-test="walk-sheet"]');
  assert.ok(await noSideways(page) <= 0);
  const wide = await page.evaluate(() => document.querySelector('[data-test="walk"]').getBoundingClientRect().width);
  assert.ok(wide <= 560, 'the walk stays a phone-sized column on a wide screen');
  // Delete: asked once, then gone; no map is made.
  page.once('dialog', (d) => d.accept());
  await page.click('[data-test="walk-delete"]');
  await page.waitForSelector('[data-test="walk-start"]');
  assert.match(await page.textContent('[data-test="map-chooser"]'), /No maps yet/);
  const w = (await stored(page))[0];
  assert.equal(w.status, 'discarded'); assert.equal(w.steps.length, 0);
  // The address of the walk screen with no walk in progress is not a dead end.
  await page.goto(`${env.appUrl}#/process/walk`);
  await page.waitForSelector('[data-test="walk-none"]');
  assert.match(await page.textContent('[data-test="walk-none"]'), /No walk in progress/);
  await context.setOffline(false);
  assert.deepEqual(errors, []);
  await context.close();
});

test('a half-answered step is kept when the next step is timed, and "Name it later" keeps a hand-over (390px)', async () => {
  const { context, page, errors } = await openPage(env, { width: 390, path: '#/process', touch: true });
  await page.waitForSelector('[data-test="walk-start"]');
  await page.tap('[data-test="walk-start"]');
  await page.waitForSelector('[data-test="walk"]');
  const state = (want) => page.waitForFunction((w) => document.querySelector('[data-test="walk"]')?.dataset.state === w, want);
  await page.tap('[data-test="walk-main"]'); await state('step');
  await page.tap('[data-test="walk-main"]'); await page.waitForSelector('[data-test="walk-sheet"]');
  // Only the first answer is tapped, then the next step is timed straight away.
  await page.tap('[data-chip="name"]:text-is("Seen by a nurse")');
  await page.tap('[data-test="walk-main"]'); await state('step');
  await page.tap('[data-test="walk-main"]'); await state('waiting');
  await page.waitForSelector('[data-test="walk-sheet"]');
  let w = (await stored(page))[0];
  assert.equal(w.steps[0].name, 'Seen by a nurse', 'the half answer was kept');
  assert.equal(w.steps[0].role, null);
  // Step 2: the next step had already started, and the name is left for later.
  await page.check('#wk-next');
  await page.tap('[data-test="walk-later"]');
  await state('step');
  w = (await stored(page))[0];
  assert.equal(w.current.startAt, w.steps[1].endAt, 'no wait was recorded before step 3');
  assert.deepEqual(errors, []);
  await context.close();
});
