// Crew night 6, shell (ospeli/ospeli docs/briefs/2026-11-27-crew-night-6.md, "crew/shell-n6"):
// one tap means one thing, and Me speaks the department's words. Persona: a first-time imaging
// manager on a 360 px phone, one hand. Synthetic example hospital; made-up proposals and faults.
//   1. The ribbon's button does what the walk screen's main button does (#182 item 3).
//   2. After the department on a first open, the message says what happened (#166 item 4).
//   3. The role list under Me is grouped by department, the chosen one first (#166 item 3).
//   4. Plain words on the AI helpers page and its row under Me (#166 item 6).
//   5. A cleared device: the notice is read first; the department sheet waits (#166 item 8).
//   6. While a page's own pop-up is open the dock cannot be tapped (#165).
//   7. The agents' card is never pinned first, with an overdue work card beside it (#183 item 6).
//   8. Desktop (1280 px): the rail, the content and the ribbon (shell faults only).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, openPage, chooseDepartment, setRole } from './helpers.mjs';
import { ROLES } from '../../web/app/core/model.js';
import { walkIt } from './result-seed.mjs';

let env;
before(async () => { env = await startApp(); });
after(async () => { await env.close(); });

const CLOCK = '2026-11-17T09:00:00Z';
const route = (page, h) => page.waitForFunction((x) => document.documentElement.dataset.route === x, h);
const go = async (page, h) => { await page.evaluate((x) => { location.hash = x; }, h); await route(page, h); };
const asHuman = (page, name, input, role) => page.evaluate(async ([n, i, r]) => {
  const { runCommand } = await import('./core/commands.js');
  return runCommand(window.ospeli.core, n, i, { type: 'human', role: r });
}, [name, input, role]);
const walkNow = async (page) => (await asHuman(page, 'ospeli_walks_get', {}, 'radiographer')).walk;
const actText = async (page) => (await page.textContent('[data-test="ribbon-act"]')).trim();

// A first walk in Imaging with its first step ("Arrived") timed from the walk screen, left running.
async function walkArrived(page) {
  await go(page, '#/process');
  await page.waitForSelector('[data-test="walk-start"]');
  await page.tap('[data-test="walk-start"]'); await page.tap('[data-test="walk-before-ok"]');
  await page.waitForSelector('[data-test="walk"][data-state="waiting"]');
  await page.clock.fastForward(60000);
  await page.tap('[data-test="walk-main"]'); await page.waitForSelector('[data-test="walk"][data-state="step"]');
  await page.clock.fastForward(90000);
  await page.tap('[data-test="walk-main"]'); await page.waitForSelector('[data-test="walk"][data-state="waiting"]');
  await page.tap('[data-test="walk-leave"]');
  await route(page, '#/home');
}

// ---------------------------------------------------------------- 1. one tap means one thing
for (const [width, height] of [[360, 640], [390, 844]]) {
  test(`${width}x${height}: on a walk with a step list the ribbon's button starts the step offered next, by name, as the walk screen's main button does`, async () => {
    const { page, context, errors } = await openPage(env, { width, height, touch: true, department: 'imaging', clock: CLOCK });
    await walkArrived(page);
    await go(page, '#/journey');
    // The walk screen offers "Registered" next; the ribbon says the same and starts the same.
    let w = await walkNow(page);
    const next = w.list.find((p) => p.state === 'next');
    assert.equal(next.name, 'Registered');
    assert.equal(await actText(page), 'Registered starts');
    await page.clock.fastForward(30000);
    await page.locator('[data-test="ribbon-act"]').tap();
    await page.waitForFunction(() => document.querySelector('[data-test="ribbon-words"]')?.textContent === 'Hands-on: Registered');
    w = await walkNow(page);
    assert.equal(w.state, 'step');
    assert.equal(w.running?.name, 'Registered', 'the step running is the list step, by name');
    const cur = (await page.evaluate(async () => (await window.ospeli.core.getMeta('process-walks')).walks.at(-1).current));
    assert.equal(cur.nameFrom, 'list', 'kept as "from the list", as the walk screen keeps it');
    assert.match(await page.textContent('[data-test="ribbon-status"]'), /Registered started/);
    assert.equal(await page.textContent('#toast'), 'Registered started. Wrong tap? Open Walk to undo it.');
    // The step is named already: "Registered done" saves it and the page stays, as on the walk screen.
    assert.equal(await actText(page), 'Registered done');
    await page.clock.fastForward(45000);
    await page.locator('[data-test="ribbon-act"]').tap();
    await page.waitForFunction(() => document.querySelector('[data-test="ribbon-words"]')?.textContent === 'Waiting');
    assert.equal(await page.evaluate(() => document.documentElement.dataset.route), '#/journey', 'no naming sheet is needed');
    w = await walkNow(page);
    assert.deepEqual(w.steps.map((s) => s.name), ['Arrived', 'Registered']);
    assert.equal(w.steps[1].workSec, 45);
    // The longest names fit the button: no word is cut, 44 px, 15 px.
    assert.equal(await actText(page), 'Safety questions starts');
    const b = await page.locator('[data-test="ribbon-act"]').evaluate((e) => ({ h: e.getBoundingClientRect().height, cut: e.scrollWidth > e.clientWidth + 1, f: parseFloat(getComputedStyle(e).fontSize) }));
    assert.ok(b.h >= 44 && !b.cut && b.f >= 15, JSON.stringify(b));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'no sideways scroll');
    // The walk screen's main button says the very same words.
    await page.locator('[data-test="ribbon-open"]').tap(); await route(page, '#/process/walk');
    assert.equal((await page.textContent('[data-test="walk-main"]')).trim(), 'Safety questions starts');
    assert.deepEqual(errors, []);
    await context.close();
  });
}

test('390 px: a walk without a step list keeps the ribbon as it was: "Step starts", then "Step done" opens the walk to name it', async () => {
  const { page, context, errors } = await openPage(env, { width: 390, height: 844, touch: true, department: 'wards', clock: CLOCK });
  await asHuman(page, 'ospeli_walks_start', { guidanceSeen: true, department: 'wards' }, 'ward-nurse');
  await go(page, '#/journey');
  await page.waitForFunction(() => { const r = document.querySelector('#walk-ribbon'); return r && !r.hidden; });
  assert.equal(await actText(page), 'Step starts');
  await page.clock.fastForward(30000);
  await page.locator('[data-test="ribbon-act"]').tap();
  await page.waitForFunction(() => document.querySelector('[data-test="ribbon-words"]')?.textContent === 'Hands-on: step 1');
  assert.equal(await actText(page), 'Step done');
  await page.clock.fastForward(30000);
  await page.locator('[data-test="ribbon-act"]').tap();
  await route(page, '#/process/walk');
  await page.waitForSelector('[data-test="walk-sheet"]');
  assert.deepEqual(errors, []);
  await context.close();
});

// ---------------------------------------------------------------- 2. the message after the department
test('360 px: after the department on a first open, the message says what happened and where to change the role', async () => {
  const { page, context, errors } = await openPage(env, { width: 360, height: 640, touch: true, department: null });
  await page.locator('#dept-sheet [data-dept="imaging"]').tap();
  await page.waitForFunction(() => document.documentElement.dataset.role === 'radiographer' && document.querySelector('#toast.show'));
  assert.equal(await page.textContent('#toast'), 'Imaging. Role set to Imaging staff; change it under Me');
  // Later, from the chip, the role is the person's own now: the department alone is said.
  await page.waitForFunction(() => !document.querySelector('#toast.show'), null, { timeout: 6000 });
  await chooseDepartment(page, 'laboratory');
  await page.waitForSelector('#toast.show');
  assert.equal(await page.textContent('#toast'), 'Department: Laboratory');
  assert.equal(await page.evaluate(() => document.documentElement.dataset.role), 'radiographer');
  assert.deepEqual(errors, []);
  await context.close();
});

// ---------------------------------------------------------------- 3. the role list, by department
for (const [dept, first, want] of [['imaging', 'Imaging', ['radiographer', 'diagnostics-manager']], ['laboratory', 'Laboratory', ['lab-reception', 'lab-scientist', 'diagnostics-manager']], ['wards', 'Wards', ['ward-nurse', 'bed-manager', 'unit-clerk']]]) {
  test(`${dept}: the role list under Me is grouped by department, ${first} first, each group with a heading; ids are unchanged`, async () => {
    const { page, context, errors } = await openPage(env, { width: 360, height: 640, touch: true, department: dept });
    await go(page, '#/me');
    await page.waitForSelector('#role-select');
    const look = await page.evaluate(() => ({
      groups: [...document.querySelectorAll('#role-select optgroup')].map((g) => ({ label: g.label, ids: [...g.querySelectorAll('option')].map((o) => o.value) })),
      loose: document.querySelectorAll('#role-select > option').length,
      value: document.querySelector('#role-select').value,
    }));
    assert.equal(look.loose, 0, 'every role is in a group');
    assert.equal(look.groups[0].label, first, 'the chosen department\'s group is first');
    assert.deepEqual(look.groups[0].ids, want);
    for (const g of look.groups) { assert.ok(g.label.length > 1, 'each group has a heading'); assert.ok(g.ids.length > 0); }
    const all = look.groups.flatMap((g) => g.ids);
    assert.equal(all.length, ROLES.length, 'each role once');
    assert.deepEqual([...all].sort(), ROLES.map((r) => r.id).sort(), 'the same role ids as before');
    assert.equal(new Set(look.groups.map((g) => g.label)).size, look.groups.length);
    // Choosing still stores the same id.
    await page.selectOption('#role-select', 'diagnostics-manager');
    await page.waitForFunction(() => document.documentElement.dataset.role === 'diagnostics-manager');
    assert.equal(await page.evaluate(() => window.ospeli.core.getMeta('role')), 'diagnostics-manager');
    assert.deepEqual(errors, []);
    await context.close();
  });
}

// ---------------------------------------------------------------- 4. AI helpers in plain words
test('360 px: the AI helpers page and its row under Me speak plain words; the Off setting is one tap from Me, on the first screen', async () => {
  const { page, context, errors } = await openPage(env, { width: 360, height: 640, touch: true, department: 'imaging', clock: CLOCK });
  await go(page, '#/me');
  const row = await page.textContent('[data-test="me-agents"]');
  assert.match(row, /AI helpers/);
  assert.match(row, /Now: off/, 'the row says the setting now');
  assert.match(row, /off switch/i, 'the row says where the off switch is');
  await page.locator('[data-test="me-agents"]').tap();
  await route(page, '#/agents');
  await page.waitForSelector('[data-dial="off"]');
  assert.equal(await page.textContent('#main h1'), 'AI helpers');
  const off = await page.evaluate(() => {
    const r = document.querySelector('[data-dial="off"]').getBoundingClientRect();
    const dock = document.querySelector('#dock').getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, dockTop: dock.top, h: r.height };
  });
  assert.ok(off.top >= 0 && off.bottom <= off.dockTop, `the Off setting (${off.top} to ${off.bottom}) is on the first screen, above the dock (${off.dockTop})`);
  assert.ok(off.h >= 44);
  const text = await page.locator('#main').innerText();
  assert.doesNotMatch(text, /\bdial\b/i, 'no "dial"');
  // "Agents" and "Advise" are said with what they mean.
  assert.match(text, /Agents are AI helpers/);
  assert.match(text, /Advise.{0,40}suggest only/i);
  assert.deepEqual(errors, []);
  await context.close();
});

// ---------------------------------------------------------------- 5. a cleared device
test('360 px: on a device whose browser cleared the data, the notice is read first; the department sheet opens only after it is closed', async () => {
  const { page, context, errors } = await openPage(env, { width: 360, height: 640, touch: true, department: 'imaging', clock: CLOCK });
  await page.goto('about:blank');
  const cdp = await context.newCDPSession(page);
  await cdp.send('Storage.clearDataForOrigin', { origin: env.base, storageTypes: 'indexeddb' });
  await cdp.detach();
  await page.goto(`${env.appUrl}#/home`);
  await page.waitForSelector('html[data-ready="true"]');
  await page.waitForSelector('[data-test="data-lost"]');
  await page.waitForTimeout(300);
  assert.equal(await page.locator('#dept-sheet[open]').count(), 0, 'the department sheet does not open over the notice');
  assert.equal(await page.evaluate(() => !!document.activeElement?.closest('[data-test="data-lost"]')), true, 'the notice has the focus, so it is read first');
  const ok = page.locator('[data-test="data-lost"] button');
  const hit = await ok.evaluate((b) => { const r = b.getBoundingClientRect(); return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) === b; });
  assert.equal(hit, true, 'nothing lies over the notice\'s button');
  await ok.tap();
  await page.waitForSelector('#dept-sheet[open]');
  await page.locator('#dept-sheet [data-dept="imaging"]').tap();
  await page.waitForFunction(() => document.documentElement.dataset.department === 'imaging');
  assert.deepEqual(errors, []);
  await context.close();
});

// ---------------------------------------------------------------- 6. the dock under a page's pop-up
const POPUPS = [
  { route: '#/beds', role: 'ward-nurse', open: '#main [aria-haspopup="dialog"]' },
  { route: '#/home', role: 'ward-nurse', open: '#main [aria-haspopup="dialog"]' },
  { route: '#/engineering', role: 'estates-tech', open: '#main [aria-haspopup="dialog"]' },
];
for (const [width, height] of [[360, 640], [390, 844]]) {
  test(`${width}x${height}: while a page's own pop-up is open the dock and the ribbon cannot be tapped`, async () => {
    const { page, context, errors } = await openPage(env, { width, height, touch: true, department: 'wards', clock: CLOCK });
    await asHuman(page, 'ospeli_walks_start', { guidanceSeen: true }, 'ward-nurse');
    let opened = 0;
    for (const p of POPUPS) {
      await setRole(page, p.role);
      await go(page, p.route);
      await page.waitForTimeout(400);
      const btn = page.locator(p.open).first();
      if (!(await btn.count())) continue;
      await btn.scrollIntoViewIfNeeded();
      await btn.tap();
      await page.waitForSelector('dialog[open]:not(#dept-sheet)');
      opened += 1;
      const look = await page.evaluate(() => {
        const hitAt = (sel) => { const r = document.querySelector(sel).getBoundingClientRect(); const e = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return !!e?.closest(sel); };
        return { now: hitAt('#dock [data-dock="journey"]'), walk: hitAt('#dock .dock-walk'), ribbon: hitAt('[data-test="ribbon-act"]') };
      });
      assert.deepEqual(look, { now: false, walk: false, ribbon: false }, `${p.route}: the dock and ribbon are not reachable under the pop-up`);
      // A tap where the dock is changes no page.
      const d = await page.evaluate(() => { const r = document.querySelector('#dock [data-dock="journey"]').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
      await page.touchscreen.tap(d.x, d.y);
      await page.waitForTimeout(700);
      assert.equal(await page.evaluate(() => document.documentElement.dataset.route), p.route, `${p.route}: a tap on the dock under the pop-up does nothing`);
      if (await page.locator('dialog[open]:not(#dept-sheet)').count()) await page.keyboard.press('Escape');
      await page.waitForTimeout(700); // past the guard against a tap falling through a closed dialog
    }
    assert.ok(opened >= 2, `${opened} pop-ups opened`);
    assert.deepEqual(errors, []);
    await context.close();
  });
}

// ---------------------------------------------------------------- 7. the agents' card is never pinned first
test('Imaging, 390 px: with an overdue work order and a waiting proposal on the same page, the work card comes first and the agents\' card after it', async () => {
  const { page, context, errors } = await openPage(env, { width: 390, height: 844, touch: true, department: 'imaging', clock: '2026-11-17T08:00:00Z' });
  await setRole(page, 'ops-manager');
  // An overdue work order on the imaging department's X-ray room (urgent: due in 4 hours).
  const faults = (await asHuman(page, 'ospeli_assets_list', { limit: 500 }, 'estates-tech')).assets.find((a) => a.id === 'asset-xray-1').faults;
  await asHuman(page, 'ospeli_workorders_report_fault', { assetId: 'asset-xray-1', fault: faults[0], priority: 'urgent' }, 'estates-tech');
  await page.clock.fastForward(5 * 3600 * 1000);
  // Agents on; an agent proposes a fault report (decided on Engineering, the same page as the work
  // card) and a new process map (on no stage of Imaging).
  await page.evaluate(async () => {
    const { runCommand } = await import('./core/commands.js');
    const core = window.ospeli.core; const coo = { type: 'human', role: 'coo' };
    const wards = (await runCommand(core, 'ospeli_beds_board', {}, coo)).wards.map((w) => w.id);
    await runCommand(core, 'ospeli_agents_set_access', { allowed: true, wards: Object.fromEntries(wards.map((id) => [id, true])) }, coo);
    await runCommand(core, 'ospeli_agents_add', { name: 'fix-bot', role: 'ops-manager', wards, days: 30 }, coo);
    await window.ospeli.run('ospeli_workorders_report_fault', { assetId: 'asset-a1-sink-1', fault: 'Blocked', priority: 'routine' }, { agent: 'fix-bot', role: 'ops-manager' }).catch(async () => {
      const a = (await runCommand(core, 'ospeli_assets_list', { limit: 500 }, coo)).assets.find((x) => x.id === 'asset-a1-sink-1');
      await window.ospeli.run('ospeli_workorders_report_fault', { assetId: a.id, fault: a.faults[0], priority: 'routine' }, { agent: 'fix-bot', role: 'ops-manager' });
    });
    await window.ospeli.run('ospeli_maps_create', { from: 'discharge' }, { agent: 'fix-bot', role: 'ops-manager' });
  });
  await go(page, '#/journey'); await go(page, '#/home');
  await page.waitForSelector('[data-test="decisions-waiting"]');
  const look = await page.evaluate(() => [...document.querySelectorAll('[data-test="needs-list"] > li')].map((li) => (li.querySelector('[data-test="decisions-waiting"]')
    ? { card: 'decisions', text: li.textContent } : { card: li.querySelector('.needs-card').dataset.page, text: li.textContent })));
  assert.equal(look[0].card, 'engineering', `the work card is first: ${JSON.stringify(look.map((x) => x.card))}`);
  assert.match(look[0].text, /overdue/, 'it is the overdue work card');
  const dec = look.findIndex((x) => x.card === 'decisions');
  assert.ok(dec > 0, 'the agents\' card is not first');
  assert.match(look[dec].text, /Engineering: 1 proposal/, 'the proposal is decided on the same page as the work card');
  assert.match(look[dec].text, /\(2\)/);
  assert.deepEqual(errors, []);
  await context.close();
});

// ---------------------------------------------------------------- 8. desktop
test('1280x800: the rail, the content beside it and the ribbon at the foot of the content, on Now, Journey, Maps, Me and a two-walk result', async () => {
  const { page, context, errors } = await openPage(env, { width: 1280, height: 800, department: 'imaging', clock: CLOCK });
  const w1 = await walkIt(page, [{ wait: 60, work: 120, name: 'Arrived', role: 'Patient' }, { wait: 240, work: 180, name: 'Scan', role: 'Imaging staff' }]);
  const mapId = w1.map?.id || w1.mapId || w1.walk?.mapId;
  await walkIt(page, [{ wait: 90, work: 100 }, { wait: 300, work: 200 }], { mapId });
  await asHuman(page, 'ospeli_walks_start', { guidanceSeen: true, department: 'imaging' }, 'radiographer');
  for (const h of ['#/home', '#/journey', '#/process', '#/me', `#/process/map/${mapId}`]) {
    await page.evaluate((x) => { location.hash = x; }, h);
    await page.waitForFunction((x) => document.documentElement.dataset.route?.startsWith(x.split('/').slice(0, 3).join('/')), h);
    await page.waitForFunction(() => { const r = document.querySelector('#walk-ribbon'); return r && !r.hidden; });
    await page.waitForTimeout(300);
    const look = await page.evaluate(() => {
      const r = (s) => document.querySelector(s).getBoundingClientRect();
      const dock = r('#dock'); const main = r('#main'); const rib = r('#walk-ribbon');
      return { dockRight: dock.right, dockH: dock.height, mainLeft: main.left, mainRight: main.right, ribLeft: rib.left, ribRight: rib.right, ribBottom: rib.bottom,
        scroll: document.documentElement.scrollWidth - innerWidth, vw: innerWidth, vh: innerHeight };
    });
    assert.ok(look.dockH >= look.vh - 70, `${h}: the rail runs down the screen (${look.dockH})`);
    assert.ok(look.mainLeft >= look.dockRight - 1, `${h}: the content starts right of the rail`);
    assert.ok(look.ribLeft >= look.dockRight && look.ribRight <= look.vw, `${h}: the ribbon is beside the rail, not over it`);
    assert.ok(look.ribLeft >= look.mainLeft - 1 && look.ribRight <= look.mainRight + 1, `${h}: the ribbon lines up with the content (${look.ribLeft}–${look.ribRight} in ${look.mainLeft}–${look.mainRight})`);
    assert.ok(look.ribBottom <= look.vh, `${h}: the ribbon is on screen`);
    assert.equal(look.scroll, 0, `${h}: no sideways scroll`);
    // Scrolled to the end, the page's last line is clear of the ribbon.
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    const clear = await page.evaluate(() => {
      const kids = [...document.querySelectorAll('#main *')].filter((e) => e.checkVisibility() && e.getClientRects().length && getComputedStyle(e).position !== 'fixed');
      return { last: Math.max(...kids.map((e) => e.getBoundingClientRect().bottom)), top: document.querySelector('#walk-ribbon').getBoundingClientRect().top };
    });
    assert.ok(clear.last <= clear.top + 1, `${h}: the last line (${clear.last}) ends above the ribbon (${clear.top})`);
  }
  assert.deepEqual(errors, []);
  await context.close();
});
