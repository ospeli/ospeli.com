// #188 (design audit, 25 Nov 2026): a step typed in "What happened?" is saved under the words
// typed, whatever chip was offered or tapped before, and a role tap never changes it.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, openPage } from './helpers.mjs';

let env;
before(async () => { env = await startApp(); });
after(async () => { await env.close(); });

const state = (page, want) => page.waitForFunction((w) => document.querySelector('[data-test="walk"]')?.dataset.state === w, want);
const stored = (page) => page.evaluate(async () => (await window.ospeli.core.getMeta('process-walks'))?.walks || []);


// Since the tap-through walk sheet (27 Nov 2026) the department's list is the page: the main button
// starts the list's next step by name, and words are typed only for a step started with
// "+ Another step" (not on the list). So the walk times n - 1 list steps, then one step off the list,
// whose naming sheet is where #188's checks apply.
async function otherStep(page) {
  await page.clock.fastForward(60000);
  await page.locator('[data-test="walk-other"]').tap(); await state(page, 'step');
  await page.clock.fastForward(60000);
  await page.locator('[data-test="walk-main"]').tap(); await state(page, 'waiting');
  await page.waitForSelector('[data-test="walk-sheet"]');
}
async function toStep(page, n) {
  await page.locator('.dock [data-dock="walk"]').tap();
  await page.locator('[data-test="walk-before-ok"]').tap();
  await page.waitForSelector('[data-test="walk"]');
  for (let i = 0; i < n - 1; i += 1) {
    await page.clock.fastForward(60000);
    await page.locator('[data-test="walk-main"]').tap(); await state(page, 'step');
    await page.clock.fastForward(60000);
    await page.locator('[data-test="walk-main"]').tap(); await state(page, 'waiting');
  }
  await otherStep(page);
}
const pressed = (page) => page.locator('[data-chip][aria-pressed="true"]').allTextContents();

for (const [width, height] of [[360, 640], [390, 844]]) {
  test(`${width} px: a typed step is saved under the typed words, with the role the person tapped and never the one only offered`, async () => {
    const { context, page, errors } = await openPage(env, { width, height, touch: true, department: 'outpatients', clock: '2026-11-19T09:00:00' });
    await toStep(page, 2);
    // Was: step 2 offered as "Seen by a nurse" with the role Nurse, both already chosen. That offer is
    // retired (#170): for a step not on the list nothing is chosen for the person, and nothing is saved yet.
    assert.deepEqual(await pressed(page), []);
    assert.equal(await page.textContent('[data-test="walk-sheet-hint"]'), 'Name this step. The clock keeps running.');
    assert.deepEqual((await stored(page))[0].steps.map((s) => [s.name, s.role]).at(-1), [null, null]);
    // The step row ends with the way to a step that is not among the words offered.
    assert.equal(await page.locator('[data-test="walk-row-name"] button').last().textContent(), '+ Add your own');
    await page.locator('[data-test="walk-own"]').tap();
    await page.waitForSelector('#wk-name');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'wk-name', 'the field is ready to type in');
    await page.locator('#wk-name').pressSequentially('Left the clinic');
    // Typing leaves no chip pressed: no step word and no role stands in for the person's own answer.
    assert.deepEqual(await pressed(page), []);
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'wk-name', 'typing does not redraw the sheet');
    // Save with no role: refused inside the sheet, beside Save, and nothing is saved.
    await page.locator('[data-test="walk-save"]').tap();
    const err = page.locator('[data-test="walk-sheet"] [data-test="walk-error"]');
    assert.equal(await err.textContent(), 'Choose or type a role, or tap “Name it later”.');
    // The line and the buttons it names are on the screen together, above the main button (Adoption lead, 26 Nov).
    const mainTop = (await page.locator('[data-test="walk-main"]').boundingBox()).y;
    for (const sel of ['[data-test="walk-error"]', '[data-test="walk-later"]', '[data-test="walk-save"]']) {
      const b = await page.locator(`[data-test="walk-sheet"] ${sel}`).boundingBox(); const sheetBox = await page.locator('[data-test="walk-sheet"]').boundingBox();
      assert.ok(b.y >= sheetBox.y - 1 && b.y + b.height <= Math.min(mainTop, sheetBox.y + sheetBox.height) + 1, `${sel} is in sight (${Math.round(b.y)} to ${Math.round(b.y + b.height)}; sheet ${Math.round(sheetBox.y)} to ${Math.round(sheetBox.y + sheetBox.height)})`);
    }
    assert.equal(await page.locator('#toast.show').count(), 0, 'no message at the top of the screen');
    assert.deepEqual((await stored(page))[0].steps.map((s) => [s.name, s.role]).at(-1), [null, null]);
    assert.equal(await page.inputValue('#wk-name'), 'Left the clinic', 'the typed words are still there');
    // The two tick boxes are 44 px targets with their labels.
    for (const b of await page.locator('[data-test="walk-more-box"] label.check').all()) assert.ok((await b.boundingBox()).height >= 44);
    // A role tap saves: the typed words, that role.
    await page.locator('[data-chip="role"]', { hasText: /^Reception$/ }).tap();
    await page.waitForSelector('[data-test="walk-flash"]');
    const last = (await stored(page))[0].steps.at(-1);
    assert.deepEqual([last.name, last.role, last.typed], ['Left the clinic', 'Reception', true]);
    assert.equal(await page.textContent('[data-test="walk-flash"]'), 'Step 2 saved as Left the clinic · ReceptionChange');
    assert.equal((await stored(page))[0].steps[0].typed, undefined, 'a step chosen from the words offered is not marked as typed');
    // Step 1 came from the list by the main button: its name and role say so, and the typed step's do not.
    const first = (await stored(page))[0].steps[0];
    assert.deepEqual([first.name, first.role, first.nameFrom, first.roleFrom], ['Checked in at reception', 'Reception', 'list', 'list']);
    assert.deepEqual([last.nameFrom, last.roleFrom], ['typed', 'chosen'], 'the typed words and the tapped role are the person\'s own');
    assert.deepEqual(errors, []);
    await context.close();
  });
}

test('typed words and the main button: the step is saved with the typed name and no role, not the offered one', async () => {
  const { context, page, errors } = await openPage(env, { width: 360, height: 640, touch: true, department: 'outpatients', clock: '2026-11-19T09:00:00' });
  await toStep(page, 2);
  await page.locator('[data-test="walk-own"]').tap();
  await page.locator('#wk-name').pressSequentially('Sent to another desk');
  await page.clock.fastForward(30000);
  await page.locator('[data-test="walk-main"]').tap(); await state(page, 'step');
  const st = (await stored(page))[0].steps.at(-1);
  assert.deepEqual([st.name, st.role, st.typed], ['Sent to another desk', null, true]);
  assert.match(await page.textContent('[data-test="walk-flash"]'), /^Step 2 saved as Sent to another deskChange$/);
  // A step chip tapped after typing is the later answer: it takes the place of the typed words, and says so on screen.
  await page.clock.fastForward(30000);
  await page.locator('[data-test="walk-main"]').tap(); await state(page, 'waiting');
  // The step the main button started was the list's own: no sheet. Another step off the list brings the sheet.
  assert.equal(await page.locator('[data-test="walk-sheet"]').count(), 0);
  await otherStep(page);
  await page.locator('[data-test="walk-own"]').tap();
  await page.locator('#wk-name').pressSequentially('Something else');
  await page.locator('[data-chip="name"]', { hasText: /^Medicines collected$/ }).tap();
  assert.equal(await page.inputValue('#wk-name'), '');
  assert.deepEqual((await pressed(page))[0], 'Medicines collected');
  assert.deepEqual(errors, []);
  await context.close();
});
