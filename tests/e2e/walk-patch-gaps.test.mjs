// J1 swarm check (17 Nov 2026): what #103, #102 and #99 still need on screen after the walk-mode
// fixes patch. Each test fails on the patched code. Synthetic taps only; no real walk is read.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, openPage } from './helpers.mjs';

let env;
before(async () => { env = await startApp(); });
after(async () => { await env.close(); });

async function openWalk(page) {
  await page.waitForSelector('[data-test="walk-card"]');
  await page.locator('[data-test="walk-start"]').click();
  await page.locator('[data-test="walk-before-ok"]').click();
  await page.waitForSelector('[data-test="walk"]');
}
const state = (page, want) => page.waitForFunction((w) => document.querySelector('[data-test="walk"]')?.dataset.state === w, want);

// #103: a keyboard or switch user taps "Step starts" and focus falls to the page body.
test('#103: focus stays on the main button after each tap (390px)', async () => {
  const { context, page } = await openPage(env, { width: 390, height: 844, path: '#/process' });
  await openWalk(page);
  await page.focus('[data-test="walk-main"]');
  await page.keyboard.press('Enter'); await state(page, 'step');
  const after1 = await page.evaluate(() => document.activeElement?.getAttribute('data-test') || document.activeElement?.tagName);
  assert.equal(after1, 'walk-main', `after "Step starts" focus is on ${after1}`);
  await context.close();
});

// #103: the state (Waiting / Hands-on) changes with no spoken word: the only region is aria-live="off".
test('#103: the change to Hands-on is announced in a polite live region', async () => {
  const { context, page } = await openPage(env, { width: 390, height: 844, path: '#/process' });
  await openWalk(page);
  await page.locator('[data-test="walk-main"]').click(); await state(page, 'step');
  const said = await page.evaluate(() => [...document.querySelectorAll('[aria-live="polite"], [role="status"]')]
    .map((e) => e.textContent).join(' | '));
  assert.match(said, /Hands-on|Step started/, `live regions hold: "${said}"`);
  await context.close();
});

// #99: the guide no longer names a 1-second wait, but the step list still rings it.
test('#99: a walked map with waits of a second or two does not ring one as "the longest wait"', async () => {
  const { context, page } = await openPage(env, { width: 390, height: 844, path: '#/process' });
  await page.evaluate(async () => {
    const { runCommand } = await import('./core/commands.js');
    const me = { type: 'human', role: 'ops-manager' }; const core = window.ospeli.core;
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    await runCommand(core, 'ospeli_walks_start', {}, me);
    for (const [name, role] of [['Checked in at reception', 'Reception'], ['Seen by a nurse', 'Nurse']]) {
      await wait(1100); await runCommand(core, 'ospeli_walks_step_start', {}, me);
      await wait(1100); await runCommand(core, 'ospeli_walks_step_done', {}, me);
      await runCommand(core, 'ospeli_walks_step_name', { name, role }, me);
    }
    await runCommand(core, 'ospeli_walks_finish', {}, me);
  });
  await page.goto(`${env.appUrl}#/process/map-001`);
  await page.waitForSelector('[data-test="process-body"] .walk-when');
  const text = await page.textContent('[data-test="process-body"]');
  assert.doesNotMatch(text, /the longest wait on this walk/, 'a wait under the 30 s floor is still ringed on the step list');
  await context.close();
});

// #102: the patch adds clockMoved to the walk view; nothing on screen says it yet.
test('#102: when the phone clock moves back mid-walk, the walk screen says its times cannot be trusted', async () => {
  const { context, page } = await openPage(env, { width: 390, height: 844, path: '#/process', clock: '2026-11-16T09:00:00Z' });
  await openWalk(page);
  await page.clock.runFor(10000);
  await page.locator('[data-test="walk-main"]').click(); await state(page, 'step');
  await page.clock.setSystemTime(new Date('2026-11-16T08:00:20Z')); // the phone corrects its clock back
  await page.clock.runFor(5000);
  await page.locator('[data-test="walk-main"]').click(); await state(page, 'waiting');
  const flagged = await page.evaluate(async () => { const { runCommand } = await import('./core/commands.js'); return (await runCommand(window.ospeli.core, 'ospeli_walks_get', {}, { type: 'human', role: 'ops-manager' })).walk.clockMoved; });
  assert.equal(flagged, true, 'the walk view flags the clock (patch fix 3)');
  const walkText = await page.textContent('[data-test="walk"]');
  assert.match(walkText, /clock (changed|moved)/i, 'the walk screen does not say the clock moved');
  // The map says so too, names no longest wait and rings none (the Domain lead's point, 18 Nov).
  await page.locator('[data-chip="name"]:text-is("Seen by a nurse")').click();
  await page.locator('[data-chip="role"]:text-is("Nurse")').click();
  await page.waitForFunction(() => !document.querySelector('[data-test="walk-sheet"]'));
  await page.locator('[data-test="walk-finish"]').click();
  await page.locator('[data-test="walk-finish-yes"]').click();
  await page.waitForSelector('[data-test="walk-answer"]');
  assert.match(await page.textContent('[data-test="walk-clock"]'), /clock changed during this walk\. The times on this map may be wrong\. Walk it again to get times you can use\./);
  assert.equal(await page.locator('[data-test="walk-longest"]').count(), 0);
  assert.equal(await page.locator('[data-test="step-list"] .wait.hot').count(), 0);
  assert.match(await page.textContent('[data-test="guide"]'), /The phone's clock changed during this walk/);
  await context.close();
});

// 18 Nov 2026 (builder): the result opens with the answer; a staged, synthetic walk on a clock
// the test moves by hand (waits of 4, 18 and 18 minutes, so two waits tie for longest).
test('the map from a walk opens with the answer: how long, how much was waiting, the longest wait; each guide rule says what it rests on (360px)', async () => {
  const { context, page, errors } = await openPage(env, { width: 360, height: 740, path: '#/process', clock: '2026-11-16T09:00:00Z', touch: true });
  await openWalk(page);
  for (const [wait, work, name, role] of [[240, 120, 'Checked in at reception', 'Reception'], [1080, 300, 'Seen by a nurse', 'Nurse'], [1080, 540, 'Seen by a doctor', 'Doctor']]) {
    await page.clock.runFor(wait * 1000);
    await page.tap('[data-test="walk-main"]'); await state(page, 'step');
    await page.clock.runFor(work * 1000);
    await page.tap('[data-test="walk-main"]'); await page.waitForSelector('[data-test="walk-sheet"]');
    assert.match(await page.textContent('[data-test="walk-sheet-hint"]'), /The clock keeps running/);
    await page.tap(`[data-chip="name"]:text-is("${name}")`);
    await page.tap(`[data-chip="role"]:text-is("${role}")`);
    await page.waitForFunction(() => !document.querySelector('[data-test="walk-sheet"]'));
  }
  await page.tap('[data-test="walk-finish"]');
  await page.tap('[data-test="walk-finish-yes"]');
  await page.waitForSelector('[data-test="walk-answer"]');
  // 240 + 120 + 1080 + 300 + 1080 + 540 = 3360 s = 56 min; waiting 2400 s = 40 min = 71%.
  const answer = (await page.textContent('[data-test="walk-answer"]')).replace(/\s+/g, ' ');
  assert.match(answer, /56 min start to finish on this walk/);
  assert.match(answer, /40 min waiting \(71% of this walk\) · 16 min hands-on/);
  assert.match(answer, /2 handoffs between roles/);
  assert.match(answer, /Longest waits, tied: 18 min before “Seen by a nurse” and “Seen by a doctor”/);
  assert.match(answer, /One walk, one observation/);
  // It is the first thing in the map's main column, and it starts on the first screen.
  // The Adoption lead's blocking point (18 Nov): the whole answer is on the first screen of a small
  // phone (360 by 640), with nothing to scroll past; the tiles that repeated it are gone.
  assert.equal(await page.evaluate(() => document.querySelector('.pm-main').firstElementChild.firstElementChild.dataset.test), 'walk-answer');
  const box = await page.locator('[data-test="walk-longest"]').boundingBox();
  assert.ok(box.y + box.height <= 640, `the longest wait ends at ${Math.round(box.y + box.height)} px, inside a 640 px tall screen`);
  assert.equal(await page.locator('[data-test="pm-stats"] .pm-stat').count(), 0);
  // The guide switch is still on the page, and the page still has its heading for a screen reader.
  assert.equal(await page.locator('[data-test="guide-switch"]').isVisible(), true);
  assert.equal(await page.locator('h1').count(), 1);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'no sideways scroll');
  // Both tied waits are ringed on the step list; the tile says the waiting share.
  assert.equal(await page.locator('[data-test="step-list"] .wait.hot').count(), 2);
  // The guide names the tie and says what its floor rests on.
  const guide = await page.textContent('[data-test="guide"]');
  assert.match(guide, /Longest wait on this walk, tied: 18 min each/);
  assert.match(guide, /A wait belongs to the process, not to the role that comes next/);
  assert.match(await page.locator('[data-test="sg-basis"]').first().textContent(), /^Example setting, not a standard/);
  // Proposed is a what-if: the answer card is for the measured walk only. Guide off: no basis text, the map still works.
  await page.tap('[data-test="v-proposed"]');
  await page.waitForFunction(() => !document.querySelector('[data-test="walk-answer"]'));
  await page.tap('[data-test="v-today"]');
  await page.waitForSelector('[data-test="walk-answer"]');
  await page.tap('[data-test="guide-switch"]');
  await page.waitForFunction(() => /The guide is off/.test(document.querySelector('[data-test="guide"]')?.textContent || ''));
  assert.equal(await page.locator('[data-test="sg-basis"]').count(), 0);
  assert.equal(await page.locator('[data-test="walk-answer"]').count(), 1, 'the answer does not need the guide');
  assert.deepEqual(errors, []);
  await context.close();
});

// The Undo button leaves after 10 seconds and the screen is redrawn: words being typed must stay.
test('a step name being typed is still there after the Undo button goes (390px)', async () => {
  const { context, page } = await openPage(env, { width: 390, height: 844, path: '#/process', clock: '2026-11-16T09:00:00Z' });
  await openWalk(page);
  await page.clock.runFor(60000);
  await page.locator('[data-test="walk-main"]').click(); await state(page, 'step');
  await page.clock.runFor(60000);
  await page.locator('[data-test="walk-main"]').click(); await page.waitForSelector('[data-test="walk-sheet"]');
  await page.fill('#wk-name', 'Weight and height taken');
  await page.clock.runFor(11000);
  await page.waitForFunction(() => !document.querySelector('[data-test="walk-undo"]'));
  assert.equal(await page.inputValue('#wk-name'), 'Weight and height taken');
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'wk-name', 'focus is still in the field');
  // The next step's sheet starts empty.
  await page.locator('[data-chip="role"]:text-is("Nurse")').click();
  await page.waitForFunction(() => !document.querySelector('[data-test="walk-sheet"]'));
  await page.clock.runFor(60000);
  await page.locator('[data-test="walk-main"]').click(); await state(page, 'step');
  await page.clock.runFor(60000);
  await page.locator('[data-test="walk-main"]').click(); await page.waitForSelector('[data-test="walk-sheet"]');
  assert.equal(await page.inputValue('#wk-name'), '');
  await context.close();
});
