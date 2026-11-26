// #180 point 1: "Waiting for what?" after a wait of two minutes or more, and "Stopped by what?"
// after "Step interrupted". One tap, never needed, nothing typed; the main button never moves off
// the screen and the walk goes on the same when the row is left alone. The result says the reason
// beside the longest wait, as recorded on the walk.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, openPage } from './helpers.mjs';

let env;
before(async () => { env = await startApp(); });
after(async () => { await env.close(); });

const state = (page, want) => page.waitForFunction((w) => document.querySelector('[data-test="walk"]')?.dataset.state === w, want);
const stored = (page) => page.evaluate(async () => (await window.ospeli.core.getMeta('process-walks'))?.walks || []);
const fits = (page) => page.evaluate(() => {
  const b = (sel) => document.querySelector(sel)?.getBoundingClientRect();
  const main = b('[data-test="walk-main"]'); const row = b('[data-test="walk-reason"]');
  const el = document.querySelector('[data-test="walk-main"]');
  return { mainOn: main.top >= 0 && main.bottom <= window.innerHeight, mainTop: Math.round(main.top), mainH: Math.round(main.height),
    onTop: el.contains(document.elementFromPoint(main.left + main.width / 2, main.top + main.height / 2)),
    rowAbove: row ? row.bottom <= main.top && row.top >= 0 : null,
    sideways: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    side: [...document.querySelectorAll('.walk-side > *')].map((e) => Math.round(e.getBoundingClientRect().left)),
    chips: [...document.querySelectorAll('[data-test="walk-reason"] button')].map((e) => Math.round(e.getBoundingClientRect().height)) };
});
const main = (page) => page.locator('[data-test="walk-main"]').tap();

for (const [width, height] of [[360, 640], [390, 844]]) {
  test(`${width} px: a long wait is asked about with one row, one tap keeps the reason, and the result says it beside the longest wait`, async () => {
    const { context, page, errors } = await openPage(env, { width, height, touch: true, department: 'outpatients', clock: '2026-11-19T09:00:00' });
    await page.locator('.dock [data-dock="walk"]').tap();
    await page.locator('[data-test="walk-before-ok"]').tap();
    await page.waitForSelector('[data-test="walk"]');
    // A wait of under two minutes: no question.
    await page.clock.fastForward(90 * 1000); await main(page); await state(page, 'step');
    assert.equal(await page.locator('[data-test="walk-reason"]').count(), 0);
    const before = await fits(page);
    await page.clock.fastForward(60 * 1000); await main(page); await state(page, 'waiting');
    // Nine minutes: the question shows once the next step starts (the tap that ends the wait), beside the line that says what was saved.
    await page.clock.fastForward(9 * 60 * 1000); await main(page); await state(page, 'step');
    await page.waitForSelector('[data-test="walk-reason"]');
    assert.equal(await page.locator('[data-test="walk-reason"]').getAttribute('aria-label'), 'What was the wait for? You can leave this.');
    assert.deepEqual(await page.locator('[data-reason]').allTextContents(), ['Others ahead in line', 'Staff busy elsewhere', 'Room or equipment', 'Information or paperwork', 'An approval or answer', 'Transport or moving', 'Could not tell']);
    let f = await fits(page);
    assert.ok(f.mainOn && f.onTop && f.rowAbove, `the main button is on the screen with the row above it (${JSON.stringify(f)})`);
    assert.equal(f.mainH, before.mainH, 'the main button keeps its size');
    assert.deepEqual(f.side, before.side, 'Pause, Undo and the third place do not move sideways');
    assert.ok(f.sideways <= 0 && f.chips.every((h) => h >= 44), `44 px targets, no sideways scroll of the page (${f.chips})`);
    assert.equal(await page.locator('[data-test="walk-flash"]').count(), 1, 'the line that says what was saved is still there');
    assert.equal((await stored(page))[0].current.waitReason, undefined, 'nothing is kept until a person taps');
    // One tap keeps it; one line says so, with a way back.
    await page.locator('[data-reason="room-equipment"]').tap();
    await page.waitForSelector('[data-test="walk-reason-line"]');
    assert.equal(await page.textContent('[data-test="walk-reason-line"]'), 'Waited for: Room or equipmentChange reason');
    assert.equal((await stored(page))[0].current.waitReason, 'room-equipment');
    assert.equal(await page.textContent('[data-test="walk-status"]'), 'Saved: Room or equipment.');
    await page.locator('[data-test="walk-reason-change"]').tap();
    await page.waitForSelector('[data-test="walk-reason"]');
    assert.equal((await stored(page))[0].current.waitReason, undefined);
    await page.locator('[data-reason="room-equipment"]').tap();
    await page.waitForSelector('[data-test="walk-reason-line"]');
    f = await fits(page); assert.ok(f.mainOn && f.onTop);
    // The step is interrupted: the naming sheet comes first; the question waits for it.
    await page.clock.fastForward(60 * 1000);
    await page.locator('[data-test="walk-stopped"]').tap(); await state(page, 'waiting');
    await page.waitForSelector('[data-test="walk-sheet"]');
    assert.equal(await page.locator('[data-test="walk-reason"]').count(), 0, 'never beside the naming sheet');
    await page.locator('[data-test="walk-later"]').tap();
    await page.waitForSelector('[data-test="walk-reason"][data-of="stop"]');
    assert.equal(await page.locator('.walk-reason-word').textContent(), 'What stopped it?');
    f = await fits(page); assert.ok(f.mainOn && f.onTop && f.rowAbove, JSON.stringify(f));
    // Left alone: the same step carries on and nothing is kept for the interruption.
    await page.clock.fastForward(3 * 60 * 1000); await main(page); await state(page, 'step');
    assert.equal(await page.locator('[data-test="walk-reason"]').count(), 0, 'carrying on is not a new wait');
    await page.clock.fastForward(60 * 1000); await main(page); await state(page, 'waiting');
    const st = (await stored(page))[0].steps[1];
    assert.deepEqual([st.waitReason, st.stopReason], ['room-equipment', undefined]);
    // Left alone again: the row goes with the next tap on the main button and nothing is kept.
    await page.locator('[data-test="walk-later"]').tap();
    await page.clock.fastForward(4 * 60 * 1000); await main(page); await state(page, 'step');
    await page.waitForSelector('[data-test="walk-reason"]');
    // On a phone of ordinary height every answer is in sight, none slid off the side (a short phone has one row that slides).
    if (height > 720) assert.ok(await page.evaluate(() => [...document.querySelectorAll('[data-reason]')].every((e) => { const b = e.getBoundingClientRect(); return b.left >= 0 && b.right <= window.innerWidth && b.top >= 0; })), 'all seven reasons are on the screen');
    await page.clock.fastForward(60 * 1000); await main(page); await state(page, 'waiting');
    assert.equal(await page.locator('[data-test="walk-reason"], [data-test="walk-reason-line"]').count(), 0);
    assert.equal((await stored(page))[0].steps[2].waitReason, undefined);
    // Finish: the first line of the result names the longest wait and the reason recorded on the walk.
    await page.locator('[data-test="walk-finish"]').tap();
    await page.locator('[data-test="walk-finish-yes"]').tap();
    await page.waitForFunction(() => /^#\/process\/map-/.test(location.hash));
    await page.waitForFunction(() => /Longest wait/.test(document.querySelector('main')?.textContent || ''));
    // (The 12 min is the 9 min wait before the step and the 3 min it stood still: #180 point 2, the result page's.)
    const text = await page.textContent('main');
    assert.ok(text.includes('Longest wait: 12 min at “Step 2” · reason recorded on the walk: room or equipment'), text.slice(0, 700));
    assert.deepEqual(errors, []);
    await context.close();
  });
}
