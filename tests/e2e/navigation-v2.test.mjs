// Navigation v2 (ospeli/ospeli docs/design/navigation-v2.md; founder, 22 Nov 2026): the dock, the
// department chip and sheet, the Journey page and Me. The acceptance lines of the walk-first week
// (docs/briefs/2026-11-22-walk-first.md) that belong to the shell are checked here at 360 and 390 px:
// from a cold open Walk is one tap from every screen, and any module is at most two taps away.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, openPage, chooseDepartment, setRole } from './helpers.mjs';
import { MODULES } from '../../web/app/modules/registry.js';
import { DEPARTMENTS, ME_PAGES } from '../../web/app/modules/departments.js';

let env;
before(async () => { env = await startApp(); });
after(async () => { await env.close(); });

const BUILT = MODULES.filter((m) => m.load && !m.shell);
const PLANNED = MODULES.filter((m) => !m.load);
const box = (page, sel) => page.evaluate((s) => { const r = document.querySelector(s)?.getBoundingClientRect(); return r ? { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom } : null; }, sel);

for (const width of [360, 390]) {
  test(`${width} px: a first open asks for the department, not the role, and remembers the answer`, async () => {
    const { page, context, errors } = await openPage(env, { width, height: 740, touch: true, department: null });
    assert.equal(await page.locator('#dept-sheet[open]').count(), 1, 'the department sheet is open on a first open');
    assert.equal(await page.locator('#role-select').count(), 0, 'no role is asked for');
    assert.deepEqual(await page.locator('#dept-sheet [data-dept]').evaluateAll((els) => els.map((e) => e.dataset.dept)), DEPARTMENTS.map((d) => d.id));
    assert.deepEqual(await page.locator('#dept-sheet .dept-opt-name').allTextContents(),
      ['Imaging', 'Outpatients and clinics', 'Emergency department', 'Pharmacy', 'Laboratory', 'Wards', 'Whole hospital (managers)']);
    for (const h of await page.locator('#dept-sheet [data-dept]').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height))) assert.ok(h >= 44, `a department is a ${h} px target`);
    await page.locator('#dept-sheet [data-dept="imaging"]').tap();
    await page.waitForFunction(() => document.documentElement.dataset.department === 'imaging' && document.documentElement.dataset.role === 'radiographer');
    assert.equal(await page.locator('#dept-sheet[open]').count(), 0);
    assert.equal((await page.textContent('#dept-name')).trim(), 'Imaging');
    assert.match(await page.getAttribute('#dept-btn', 'aria-label'), /^Department: Imaging/);
    // An imaging department does not open as a ward nurse (UX review, finding 1).
    await page.waitForFunction(() => /Imaging staff/.test(document.querySelector('[data-test="now-role"]')?.textContent || ''));
    assert.equal(await page.textContent('#main h1'), 'Imaging');
    // The answer is kept: the next open asks nothing.
    await page.reload();
    await page.waitForSelector('html[data-ready="true"]');
    assert.equal(await page.locator('#dept-sheet[open]').count(), 0, 'the second open does not ask again');
    assert.equal((await page.textContent('#dept-name')).trim(), 'Imaging');
    assert.equal(await page.evaluate(() => document.documentElement.dataset.role), 'radiographer');
    assert.deepEqual(errors, []);
    await context.close();
  });

  test(`${width} px: the dock has five places in words, and Walk is one tap from every screen`, async () => {
    const { page, context, errors } = await openPage(env, { width, height: 740, touch: true, department: 'imaging' });
    assert.deepEqual((await page.locator('#dock a').allTextContents()).map((t) => t.trim()), ['Now', 'Journey', 'Walk', 'Maps', 'Me']);
    const dock = await box(page, '#dock');
    assert.equal(Math.round(dock.h), 68, 'the dock is 68 px tall');
    assert.equal(Math.round(dock.x), 12, 'the dock is 12 px from the left edge');
    assert.equal(Math.round(width - dock.right), 12, 'the dock is 12 px from the right edge');
    assert.equal(Math.round(740 - dock.bottom), 12, 'the dock is 12 px from the foot of the screen');
    const walk = await box(page, '#dock .dock-walk');
    assert.equal(Math.round(walk.w), 76); assert.equal(Math.round(walk.h), 76);
    assert.ok(walk.y < dock.y, 'Walk is raised above the dock');
    // The real symbol, used as it is (brand kit v3.1), never redrawn.
    assert.match(await page.getAttribute('#dock .dock-walk img', 'src'), /brand\/ospeli_symbol_dark\.svg$/);
    assert.ok(await page.evaluate(() => { const i = document.querySelector('#dock .dock-walk img'); return i.complete && i.naturalWidth > 0; }), 'the symbol loaded');
    for (const a of await page.locator('#dock a').evaluateAll((els) => els.map((e) => ({ t: e.textContent.trim(), h: e.getBoundingClientRect().height, w: e.getBoundingClientRect().width, f: parseFloat(getComputedStyle(e.querySelector('.dock-word')).fontSize) })))) {
      assert.ok(a.h >= 44 && a.w >= 44, `${a.t}: a ${a.w} by ${a.h} px target`);
      assert.ok(a.f >= 15, `${a.t}: ${a.f} px words`);
    }
    // Every screen: the two shell pages, Now, Me's pages, every built module and one planned page.
    const screens = ['home', 'journey', 'me', ...ME_PAGES, ...BUILT.map((m) => m.id), PLANNED[0].id];
    for (const id of new Set(screens)) {
      await page.evaluate((h) => { location.hash = h; }, `#/${id}`);
      await page.waitForFunction((h) => document.documentElement.dataset.route === h, `#/${id}`);
      const w = await box(page, '#dock .dock-walk');
      assert.ok(w && w.y >= 0 && w.bottom <= 740 && w.x >= 0 && w.right <= width, `${id}: Walk is on screen`);
      assert.equal(await page.evaluate(([x, y]) => !!document.elementFromPoint(x, y)?.closest('.dock-walk'), [w.x + w.w / 2, w.y + w.h / 2]), true, `${id}: nothing covers Walk`);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${id}: the page is not wider than the phone`);
      await page.locator('#dock .dock-walk').tap();
      await page.waitForFunction(() => document.documentElement.dataset.route === '#/process/walk');
      assert.equal(await page.getAttribute('#dock .dock-walk', 'aria-current'), 'page');
    }
    assert.deepEqual(errors, []);
    await context.close();
  });

  test(`${width} px: any module is at most two taps away (Journey, then the module)`, async () => {
    const { page, context, errors } = await openPage(env, { width, height: 740, touch: true, department: 'imaging' });
    for (const m of BUILT.filter((x) => !ME_PAGES.includes(x.id))) {
      await page.evaluate(() => { location.hash = '#/home'; });
      await page.waitForFunction(() => document.documentElement.dataset.route === '#/home');
      await page.locator('#dock [data-dock="journey"]').tap(); // tap 1
      await page.waitForSelector('#main .journey');
      const chip = page.locator(`#main .journey a[data-module="${m.id}"]`);
      assert.equal(await chip.count(), 1, `${m.name} is on the Journey page once`);
      assert.ok((await chip.evaluate((e) => e.getBoundingClientRect().height)) >= 44, `${m.name}: a 44 px target`);
      await chip.tap(); // tap 2
      await page.waitForFunction((h) => document.documentElement.dataset.route === h, `#/${m.id}`);
      assert.equal(await page.getAttribute('#dock [data-dock="journey"]', 'aria-current'), m.id === 'process' ? null : 'true', `${m.name}: the dock shows where the page belongs`);
    }
    // Me's own pages: Me, then the page.
    for (const id of ME_PAGES) {
      await page.locator('#dock [data-dock="me"]').tap();
      await page.waitForSelector(`#main a[href="#/${id}"]`);
      await page.locator(`#main a[href="#/${id}"]`).tap();
      await page.waitForFunction((h) => document.documentElement.dataset.route === h, `#/${id}`);
    }
    assert.deepEqual(errors, []);
    await context.close();
  });
}

test('Journey: the spine, the two boxes, the department\'s module marked in words, planned pages only under "Coming later", and search', async () => {
  const { page, context, errors } = await openPage(env, { width: 390, height: 800, touch: true, department: 'pharmacy', path: '#/journey' });
  assert.deepEqual(await page.locator('.j-spine h2').allTextContents(), ['Arrive and book', 'Test and treat', 'Stay', 'Leave and move']);
  assert.deepEqual(await page.locator('.j-box h2').allTextContents(), ['Keeps it running', 'See and improve']);
  // The chosen department's module is filled navy and says so in words, never by colour alone.
  const mine = page.locator('.j-chip.is-mine');
  assert.equal(await mine.count(), 1);
  assert.equal(await mine.getAttribute('data-module'), 'pharmacy');
  assert.match(await mine.textContent(), /Your department/);
  assert.equal(await mine.evaluate((e) => getComputedStyle(e).backgroundColor), 'rgb(11, 47, 78)');
  // Planned pages: counted, closed, and nowhere else on the page.
  assert.equal((await page.textContent('[data-test="coming-later"] summary')).trim(), `Coming later (${PLANNED.length})`);
  assert.equal(await page.locator('[data-test="coming-later"]').evaluate((d) => d.open), false);
  assert.equal(await page.locator('.j-chip[data-planned]:visible').count(), 0, 'no planned page shows until "Coming later" is opened');
  assert.equal(await page.locator('.j-spine .j-chip[data-planned], .j-box > .j-chips .j-chip[data-planned]').count(), 0);
  await page.locator('[data-test="coming-later"] summary').tap();
  assert.equal(await page.locator('.j-chip[data-planned]:visible').count(), PLANNED.length);
  for (const t of await page.locator('.j-chip[data-planned]').allTextContents()) assert.match(t, /Planned$/);
  // Search narrows the page to what matches, and says so when nothing does.
  await page.fill('[data-test="journey-search"]', 'bed');
  assert.deepEqual(await page.locator('.j-spine .j-chip:visible').evaluateAll((els) => els.map((e) => e.dataset.module)), ['beds']);
  await page.fill('[data-test="journey-search"]', 'zzzz');
  assert.equal(await page.locator('.j-chip:visible').count(), 0);
  assert.equal(await page.locator('[data-test="journey-none"]').isVisible(), true);
  await page.fill('[data-test="journey-search"]', '');
  assert.equal(await page.locator('.j-spine .j-chip:visible').count(), 6);
  // Search in the top bar opens the Journey page with the box ready to type in.
  await page.evaluate(() => { location.hash = '#/home'; });
  await page.waitForFunction(() => document.documentElement.dataset.route === '#/home');
  await page.locator('#top-search').tap();
  await page.waitForFunction(() => document.activeElement?.id === 'journey-search');
  assert.deepEqual(errors, []);
  await context.close();
});

test('Me: the role is set here, the page is drawn for it, and it is kept; the department chip changes the department from any page', async () => {
  const { page, context, errors } = await openPage(env, { width: 390, height: 800, touch: true });
  assert.equal(await page.evaluate(() => document.documentElement.dataset.role), 'ward-nurse');
  await page.locator('#dock [data-dock="me"]').tap();
  await page.waitForSelector('#main #role-select');
  assert.deepEqual(await page.locator('#main h2').allTextContents(), ['Role', 'Appearance', 'AI helpers', 'Data and audit', `Coming later (${PLANNED.length})`, 'On this device']);
  assert.match(await page.textContent('[data-test="storage-status"]'), /^(Saved on this device|Not saved)/);
  await page.selectOption('#role-select', 'estates-tech');
  await page.waitForFunction(() => document.querySelector('#main h1')?.textContent === 'Facilities technician');
  assert.equal(await page.inputValue('#role-select'), 'estates-tech');
  assert.equal((await page.textContent('[data-test="me-role-home"]')).trim(), 'Open Engineering');
  assert.equal(await page.evaluate(() => location.hash), '#/me', 'the person stays on Me; nothing jumps');
  const audit = await page.evaluate(() => window.ospeli.core.auditLog());
  assert.equal(audit.at(-1).action, 'role.changed');
  assert.equal(audit.at(-1).actorRole, 'estates-tech');
  // The chip: from a module page, the department changes and the person stays where they are.
  await page.evaluate(() => { location.hash = '#/engineering'; });
  await page.waitForFunction(() => document.documentElement.dataset.route === '#/engineering');
  await chooseDepartment(page, 'laboratory');
  assert.equal((await page.textContent('#dept-name')).trim(), 'Laboratory');
  assert.equal(await page.evaluate(() => location.hash), '#/engineering');
  assert.equal(await page.evaluate(() => document.documentElement.dataset.role), 'estates-tech', 'a chosen role is not changed by the department');
  const trail = await page.evaluate(() => window.ospeli.core.auditLog());
  assert.equal(trail.at(-1).action, 'department.changed', 'a change of department is in the audit trail');
  // Escape closes the sheet and changes nothing.
  await page.locator('#dept-btn').press('Enter');
  assert.equal(await page.locator('#dept-sheet [aria-pressed="true"]').getAttribute('data-dept'), 'laboratory');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#dept-sheet[open]').count(), 0);
  await page.reload();
  await page.waitForSelector('html[data-ready="true"]');
  assert.equal(await page.evaluate(() => `${document.documentElement.dataset.role} ${document.documentElement.dataset.department}`), 'estates-tech laboratory');
  await setRole(page, 'ward-nurse');
  assert.deepEqual(errors, []);
  await context.close();
});

test('1280 px: the dock is a left rail with the same five places, and the top bar is one row', async () => {
  const { page, context, errors } = await openPage(env, { width: 1280, height: 860, department: 'outpatients' });
  assert.deepEqual((await page.locator('#dock a').allTextContents()).map((t) => t.trim()), ['Now', 'Journey', 'Walk', 'Maps', 'Me']);
  const dock = await box(page, '#dock'); const main = await box(page, '#main'); const top = await box(page, '.topbar');
  assert.equal(Math.round(dock.x), 0); assert.ok(dock.w <= 120, `the rail is ${dock.w} px wide`);
  assert.ok(dock.h > 600, 'the rail runs down the side');
  assert.ok(main.x >= dock.right - 1, 'the page starts beside the rail');
  assert.ok(top.h <= 70, `the top bar is one row (${top.h} px)`);
  assert.equal((await page.textContent('#dept-name')).trim(), 'Outpatients');
  assert.match(await page.textContent('#top-time'), /\d{2}:\d{2}$/);
  // Keyboard: the chip, Search and the five places are reached with Tab and have names.
  const names = await page.evaluate(() => [...document.querySelectorAll('#dept-btn, #top-search, #dock a')].map((e) => ({ tab: e.tabIndex, name: (e.getAttribute('aria-label') || e.textContent).trim() })));
  for (const n of names) { assert.equal(n.tab, 0); assert.ok(n.name.length > 1); }
  await page.focus('#dock [data-dock="maps"]');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.documentElement.dataset.route === '#/process');
  assert.equal(await page.getAttribute('#dock [data-dock="maps"]', 'aria-current'), 'page');
  assert.deepEqual(errors, []);
  await context.close();
});
