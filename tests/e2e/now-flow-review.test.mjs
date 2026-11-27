// Now review fixes (crew/now-183, 26 Nov; decision record docs/decisions/2026-11-25-now-flow-strip.md
// in the planning repo), at 360 and 390 px: "Longest wait now" only where every patient stage is
// timed, what is not timed is named, the whole-hospital headline points at a tile that shows the
// beds waited for, Emergency's timed wait heads its strip, Imaging's single wait is "Only", and the
// Laboratory line is short. Synthetic example hospital.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, openPage, chooseDepartment } from './helpers.mjs';
import { DEPARTMENTS } from '../../web/app/modules/departments.js';

let env;
before(async () => { env = await startApp(); });
after(async () => { await env.close(); });

const CLOCK = '2026-11-17T14:20:00Z';
const asHuman = (page, name, input, role) => page.evaluate(async ([n, i, r]) => {
  const { runCommand } = await import('./core/commands.js');
  return runCommand(window.ospeli.core, n, i, { type: 'human', role: r });
}, [name, input, role]);
const show = async (page, id) => {
  await chooseDepartment(page, id);
  const names = DEPARTMENTS.find((x) => x.id === id).stages.filter((s) => !s.planned).map((s) => s.tile || s.name);
  await page.waitForFunction((w) => JSON.stringify([...document.querySelectorAll('.flow-tile .flow-name')].map((e) => e.textContent)) === w, JSON.stringify(names), { timeout: 10000 });
};
const head = async (page) => ((await page.locator('[data-test="flow-wait"]').count()) ? (await page.textContent('[data-test="flow-wait"]')).replace(/^→/, '') : null);
const fmt = (m) => (m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`);

for (const [width, height] of [[360, 740], [390, 844]]) {
  test(`${width} px: Whole hospital: "Longest timed wait" for a bed, what is not timed named, and the Occupied tile counts the patients waiting for a bed`, async () => {
    const { page, context, errors } = await openPage(env, { width, height, touch: true, department: 'whole-hospital', clock: CLOCK });
    await show(page, 'whole-hospital');
    const board = await asHuman(page, 'ospeli_beds_board', { format: 'short' }, 'ops-manager');
    assert.ok(board.waiting.length > 0, 'the example hospital has patients waiting for a bed');
    assert.match(await head(page), /^Longest timed wait: .+ for a bed \(1 patient( waiting this long)?\)$/);
    const key = await page.textContent('[data-test="flow-key"]');
    assert.match(key, / · Not timed: emergency department steps, imaging prep and scan\./);
    assert.doesNotMatch(key, /Requests are not ranked with patient waits/, 'the long request sentence is gone');
    const stay = page.locator('.flow-tile[data-stage="stay"]');
    const also = stay.locator('[data-test="flow-also"]');
    assert.equal(await also.textContent(), `${board.waiting.length} patient${board.waiting.length === 1 ? '' : 's'} waiting for a bed`);
    assert.ok(parseFloat(await also.evaluate((e) => getComputedStyle(e).fontSize)) >= 15);
    assert.equal(await page.locator('[data-test="flow-wait-bar"] + .flow-tile').getAttribute('data-stage'), 'stay', 'the bar sits on the tile that shows the bed wait');
    for (const b of await page.locator('.flow-tile').evaluateAll((els) => els.map((e) => e.getBoundingClientRect()))) assert.ok(b.height >= 44 && b.width >= 44);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'no sideways scroll');
    assert.deepEqual(errors, []);
    await context.close();
  });

  test(`${width} px: Emergency is headed by its timed wait for a ward bed and names its planned steps as not timed`, async () => {
    const { page, context, errors } = await openPage(env, { width, height, touch: true, department: 'emergency', clock: CLOCK });
    await show(page, 'emergency');
    const board = await asHuman(page, 'ospeli_beds_board', { format: 'short' }, 'ae-nic');
    const top = Math.max(...board.waiting.map((x) => Math.round((Date.parse(board.asOf) - Date.parse(x.decisionAt)) / 60000)));
    assert.match(await head(page), new RegExp(`^Longest timed wait: ${fmt(top)} for a ward bed \\(1 patient( waiting this long)?\\)$`));
    assert.match(await page.textContent('[data-test="flow-key"]'), / · Not timed: arrival, assessment and treatment \(planned, not built\)\.$/);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'no sideways scroll');
    assert.deepEqual(errors, []);
    await context.close();
  });

  test(`${width} px: Imaging's one timed wait is "Only timed wait"; Laboratory's line is one short sentence; only Wards says "Longest wait now"`, async () => {
    const { page, context, errors } = await openPage(env, { width, height, touch: true, department: 'imaging', clock: CLOCK });
    await show(page, 'imaging');
    const tasks = await asHuman(page, 'ospeli_tasks_list', { kind: 'patient-move', limit: 500 }, 'radiographer');
    const timed = tasks.tasks.filter((t) => (t.toLocationId === 'dept-imaging' || t.locationId === 'dept-imaging') && !t.startedAt);
    assert.equal(timed.length, 1, 'the example hospital has one timed imaging wait');
    assert.match(await head(page), /^Only timed wait: \d+ min to be moved in \(1 patient( waiting this long)?\)$/);
    assert.match(await page.textContent('[data-test="flow-key"]'), / · Prep and Scan are not counted yet\.$/);
    await show(page, 'laboratory');
    assert.equal(await page.textContent('[data-test="flow-none"]'), 'No timed patient wait. Requests are not ranked; each tile shows its oldest.');
    for (const d of DEPARTMENTS) {
      await show(page, d.id);
      const t = await head(page);
      if (d.id !== 'wards') assert.doesNotMatch(String(t), /Longest wait now/, `${d.id}: "${t}"`);
    }
    assert.deepEqual(errors, []);
    await context.close();
  });
}

test('the "Department: …" message is shown when the department is changed, not on a load with a saved department', async () => {
  const { page, context, errors } = await openPage(env, { width: 360, height: 740, touch: true, department: 'whole-hospital', clock: CLOCK });
  await page.reload();
  await page.waitForSelector('html[data-ready="true"]');
  await page.waitForSelector('[data-test="now-flow"]');
  assert.equal(await page.locator('#toast.show').count(), 0, 'no message over the header on load');
  assert.deepEqual(errors, []);
  await context.close();
});
