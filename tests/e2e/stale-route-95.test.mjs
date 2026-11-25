// Issue #95 (16 Nov note): a page still loading when the person changes role went on loading under
// the new role, so a command the new role may not run was refused and the error reached the console
// ("Receptionist cannot run ospeli_experience_queue_list"). The page being left is thrown away, so
// what happens to it must not show as an error, and the page for the new role must open.
// Made steady by holding the event log's reads until the role has changed.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, openPage, setRole } from './helpers.mjs';

let env;
before(async () => { env = await startApp(); });
after(async () => { await env.close(); });

for (const width of [390, 1280]) {
  test(`a page left by a role change while it loads gives no error, and the new role's page opens (${width}px)`, async () => {
    const { context, page, errors } = await openPage(env, { width, clock: '2026-11-16T15:00:00.000Z', touch: width < 500 });
    await setRole(page, 'patient-liaison');
    await page.waitForFunction(() => /Patient relations/.test(document.querySelector('main h1')?.textContent || '') || !!document.querySelector('.mod-feedback'));
    // Hold every read of the event log until the test lets it go.
    await page.evaluate(() => {
      const core = window.ospeli.core;
      const orig = core.events.bind(core);
      window.__held = 0;
      let open;
      const gate = new Promise((r) => { open = r; });
      window.__release = open;
      core.events = async (...a) => { window.__held += 1; await gate; return orig(...a); };
      location.hash = '#/feedback/queue';
    });
    await page.waitForFunction(() => window.__held > 0);
    // The person changes role while the complaints queue is still loading. Navigation v2: the role
    // is under Me, so the person taps Me on the dock (leaving the page that is still loading),
    // chooses the role, then opens the new role's page from Me with one tap.
    const act = (sel) => (width < 500 ? page.locator(sel).tap() : page.locator(sel).click());
    await act('#dock [data-dock="me"]');
    await page.waitForSelector('#main #role-select');
    await page.selectOption('#role-select', 'receptionist');
    await page.waitForFunction(() => document.documentElement.dataset.role === 'receptionist' && document.documentElement.dataset.route === '#/me' && document.querySelector('main h1')?.textContent === 'Receptionist');
    const held = await page.evaluate(() => window.__held);
    await act('[data-test="me-role-home"]');
    // The new role's page starts loading too, before the left page is let go.
    await page.waitForFunction((n) => window.__held > n, held);
    await page.evaluate(() => window.__release());
    await page.waitForSelector('.mod-feedback[data-role="receptionist"] .fb-body > *');
    await page.waitForTimeout(500);
    assert.equal(await page.locator('.mod-feedback').count(), 1, 'one page in main');
    assert.equal(await page.locator('.fb-tabs a[aria-current="page"]').getAttribute('data-tab'), 'quick');
    assert.equal(await page.evaluate(() => document.documentElement.dataset.route), '#/feedback');
    assert.deepEqual(errors, []);
    await context.close();
  });
}

// Issue #95 (the work-order dialog test that failed about one run in eight): choosing the role the
// device already has drew the page again and recorded a role change. A tap during that redraw
// landed on the page being replaced and was lost. The same role again now changes nothing.
// Navigation v2: the role list is on Me, so Me is the page that must not be drawn again.
test('choosing the role already chosen records nothing and does not draw the page again (360px)', async () => {
  const { context, page, errors } = await openPage(env, { width: 360, height: 780, path: '#/engineering', clock: '2026-11-10T10:00:00Z' });
  await page.waitForSelector('[data-test="wo-list"] [data-wo]');
  await page.locator('#dock [data-dock="me"]').click();
  await page.waitForSelector('#main #role-select');
  await page.waitForFunction(() => !document.querySelector('#toast.show'));
  const role = await page.locator('#role-select').inputValue();
  const before = await page.evaluate(async () => (await window.ospeli.core.events({ type: 'role.changed' })).length);
  const drawn = await page.evaluate(() => document.documentElement.dataset.drawn);
  await page.evaluate(() => { document.querySelector('main > *').dataset.mark = 'first'; });
  await page.selectOption('#role-select', role);
  await page.waitForTimeout(800);
  assert.equal(await page.locator('main > [data-mark="first"]').count(), 1, 'the page on screen is the same one');
  assert.equal(await page.evaluate(() => document.documentElement.dataset.drawn), drawn, 'the page was not drawn again');
  assert.equal(await page.evaluate(async () => (await window.ospeli.core.events({ type: 'role.changed' })).length), before, 'no role change recorded');
  assert.equal(await page.locator('#toast.show').count(), 0, 'no "Role:" message');
  assert.deepEqual(errors, []);
  await context.close();
});
