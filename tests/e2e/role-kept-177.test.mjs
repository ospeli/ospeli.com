// Issue ospeli/ospeli#177 item 6: on a new device a person closes "Where do you work?", chooses
// their role under Me, then chooses a department. The department must not replace the role they
// just chose (it only gives a first role to a device where nobody has chosen one).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, openPage, chooseDepartment } from './helpers.mjs';

let env;
before(async () => { env = await startApp(); });
after(async () => { await env.close(); });

test('#177 item 6: a role chosen under Me is kept when a department is chosen after it', async () => {
  const { context, page, errors } = await openPage(env, { width: 390, height: 800, department: null, clock: '2026-11-10T10:00:00Z' });
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('#dept-sheet[open]'));
  await page.evaluate(() => { location.hash = '#/me'; });
  await page.waitForSelector('#main #role-select');
  await page.selectOption('#role-select', 'pharmacist');
  await page.waitForFunction(() => document.documentElement.dataset.role === 'pharmacist');
  await chooseDepartment(page, 'imaging');
  assert.equal(await page.evaluate(() => document.documentElement.dataset.role), 'pharmacist', 'the department replaced the role chosen under Me');
  const why = await page.evaluate(async () => (await window.ospeli.core.events()).filter((e) => e.type === 'role.changed').map((e) => e.data?.why || null));
  assert.ok(!why.includes('department'), `no role change was made for the department (${JSON.stringify(why)})`);
  assert.deepEqual(errors, []);
  await context.close();
});

test('#177 item 6, control: on a new device where nobody chose a role, the department still gives its usual role', async () => {
  const { context, page } = await openPage(env, { width: 390, height: 800, department: null, clock: '2026-11-10T10:00:00Z' });
  await chooseDepartment(page, 'imaging');
  assert.notEqual(await page.evaluate(() => document.documentElement.dataset.role), 'ward-nurse');
  await context.close();
});

// Item 7: a walk name refused because it looks like a person's name says so where it was typed.
const stored = (page) => page.evaluate(async () => (await window.ospeli.core.getMeta('process-walks'))?.walks || []);
test('#177 item 7: "Rename this walk" with a person\'s name asks the question under the field; "Not a name" saves it', async () => {
  const { context, page, errors } = await openPage(env, { width: 360, height: 640, path: '#/process', touch: true, clock: '2026-11-19T09:00:00' });
  await page.waitForSelector('[data-test="walk-start"]');
  await page.tap('[data-test="walk-start"]');
  await page.tap('[data-test="walk-before-ok"]');
  await page.waitForSelector('[data-test="walk"]');
  await page.tap('[data-test="walk-rename"]');
  await page.fill('#wk-rename', 'S. Jones clinic');
  await page.tap('[data-test="walk-rename-save"]');
  await page.waitForSelector('[data-test="walk-rename-form"] [data-test="name-question"]');
  assert.match(await page.textContent('[data-test="name-question"]'), /Is “S\. Jones” a person's name\?/);
  assert.equal(await page.inputValue('#wk-rename'), 'S. Jones clinic', 'what was typed is still in the field');
  assert.notEqual((await stored(page))[0].title, 'S. Jones clinic', 'nothing saved yet');
  await page.tap('[data-test="walk-rename-form"] [data-test="name-keep"]');
  await page.waitForFunction(() => !document.querySelector('[data-test="walk-rename-form"]'));
  assert.equal((await stored(page))[0].title, 'S. Jones clinic');
  assert.deepEqual(errors, []);
  await context.close();
});
