// Facilities and utilities, slice 2 in the app: the load pick on the generator test and the on-load
// row, and the waste log at #/facilities/waste. Both screens with no sideways scroll and no console
// error at 360, 390 and 1280 px; phone rules (targets 44 px or more, text 15 px or more); a waste form
// cannot be saved until every pick is made, with no answer chosen in advance; an agent's waste record
// waits for a person; a role with no rights sees no waste button; guide off. And the first five minutes
// (ospeli/ospeli#112) on a 390 px touch phone: the facilities assistant records a collection and a
// missed one; the facilities manager sees the miss in Needs attention, records the late collection and
// sees the figures; the technician's on-load test turns the on-load row Done. Fictional data only.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, openPage, setRole, chooseDepartment, waitUntil } from './helpers.mjs';
import { roleById } from '../../web/app/core/model.js';
import { moduleById } from '../../web/app/modules/registry.js';
import { departmentById, departmentForRole } from '../../web/app/modules/departments.js';

let env;
before(async () => { env = await startApp(); });
after(async () => { await env.close(); });

// A cold open (no address) as this role, in the department it works in. Navigation v2: every cold
// open lands on Now (the old jump to the role's page is gone); the role's own page is the first card
// under "Your pages" after the department's pages (the first of all when the department's pages
// start with it), and one tap opens it.
async function openFromNow(page, role) {
  const dept = departmentById(departmentForRole(role));
  await chooseDepartment(page, dept.id);
  await page.goto(env.appUrl);
  await page.waitForSelector('html[data-ready="true"]');
  await page.waitForSelector('#main [data-test="role-shortcuts"]');
  assert.match(await page.evaluate(() => location.hash), /^(#\/?(home)?)?$/, 'a cold open lands on Now');
  const home = roleById(role).home;
  const deptFirst = dept.pinned.filter((id) => moduleById(id)?.load);
  const at = deptFirst.includes(home) ? deptFirst.indexOf(home) : deptFirst.length;
  const cards = page.locator('#main [data-test="role-shortcuts"] a');
  assert.equal(await cards.nth(at).getAttribute('href'), `#/${home}`, `the role's page is card ${at + 1} under Your pages`);
  await cards.nth(at).tap();
}

const CLOCK = '2026-11-19T14:00:00Z';
const noSideways = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
async function go(page, role, hash = '#/facilities') {
  await setRole(page, role);
  await waitUntil(page, async (r) => (await window.ospeli.core.getMeta('role')) === r, role);
  await page.evaluate((h) => {
    const x = document.querySelector('.fac');
    if (x) x.dataset.stale = 'true';
    if (location.hash === h) location.hash = '#/today';
    setTimeout(() => { location.hash = h; }, 0);
  }, hash);
  const screen = hash.endsWith('/waste') ? 'waste' : null;
  await page.waitForFunction(([r, s]) => {
    const x = document.querySelector('.fac');
    return x && !x.dataset.stale && x.dataset.role === r && (x.dataset.screen || null) === s && x.querySelector('.page-head');
  }, [role, screen]);
}
const cmd = (page, name, input, role) => page.evaluate(async ([n, i, r]) => {
  const { runCommand } = await import('/app/core/commands.js');
  return runCommand(window.ospeli.core, n, i, { type: 'human', role: r });
}, [name, input, role]);
const overview = (page) => cmd(page, 'ospeli_facilities_overview', {}, 'facilities-manager');
const kpi = (ov, id) => ov.kpis.find((k) => k.id === id);
const phoneProblems = (page) => page.evaluate(() => {
  const out = [];
  for (const el of document.querySelectorAll('.fac button, .fac a, .fac select, .fac summary')) {
    const r = el.getBoundingClientRect();
    if (r.height && r.height < 44) out.push(`${el.tagName} "${el.textContent.trim().slice(0, 30)}" is ${Math.round(r.height)} px tall`);
  }
  for (const el of document.querySelectorAll('.fac *')) {
    const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    const size = parseFloat(getComputedStyle(el).fontSize);
    if (own && el.getClientRects().length && !el.closest('.sr-only') && size < 15) out.push(`"${el.textContent.trim().slice(0, 30)}" is ${size} px`);
  }
  return out;
});
const tap = async (page, sel) => { const l = page.locator(sel).first(); await l.scrollIntoViewIfNeeded(); await l.tap(); };
// Saved is shown, and the page has read the log again (the redraw from the change has settled).
const waitSaved = async (page, re) => {
  await page.waitForFunction((src) => new RegExp(src).test(document.querySelector('[data-test="saved"]')?.textContent || ''), re.source);
  await page.waitForTimeout(400);
};

const ROLES = ['facilities-assistant', 'estates-tech', 'facilities-manager', 'ops-manager', 'ward-nurse'];
for (const width of [360, 390, 1280]) {
  test(`the waste log and the load pick render at ${width} px for every role with no sideways scroll and no console error`, async () => {
    const phone = width < 500;
    const { context, page, errors } = await openPage(env, { width, touch: phone, clock: CLOCK, path: '#/facilities' });
    for (const role of ROLES) {
      await go(page, role, '#/facilities/waste');
      assert.ok(await noSideways(page) <= 0, `${role} waste log scrolls sideways`);
      if (phone) assert.deepEqual(await phoneProblems(page), [], `${role}: phone rules on the waste log`);
      if (['facilities-assistant', 'estates-tech', 'facilities-manager'].includes(role)) {
        for (const tile of ['waste-collected', 'waste-missed']) {
          await page.locator(`[data-tile="${tile}"]`).click();
          await page.waitForSelector('[data-test="waste-form"]');
          await page.locator('.fac-ago summary').click();
          assert.ok(await noSideways(page) <= 0, `${role} ${tile} form scrolls sideways`);
          if (phone) assert.deepEqual(await phoneProblems(page), [], `${role}: phone rules with the ${tile} form open`);
          await page.click('[data-test="back"]');
        }
        await page.locator('[data-test="waste-late"]').first().click();
        await page.waitForSelector('[data-test="late-panel"]');
        if (phone) assert.deepEqual(await phoneProblems(page), [], `${role}: phone rules with the late collection open`);
        assert.ok(await noSideways(page) <= 0);
      }
      if (['estates-tech', 'facilities-manager'].includes(role)) {
        await go(page, role);
        await page.locator('[data-tile="generator-test"]').click();
        await page.locator('[data-test="target"] [data-value="asset-generator-2"]').click();
        await page.waitForSelector('[data-test="load"]');
        assert.ok(await noSideways(page) <= 0, `${role} generator form scrolls sideways`);
        if (phone) assert.deepEqual(await phoneProblems(page), [], `${role}: phone rules with the load pick`);
        await page.click('[data-test="back"]');
      }
    }
    await go(page, 'facilities-manager');
    assert.ok(await noSideways(page) <= 0, 'manager view scrolls sideways');
    if (phone) assert.deepEqual(await phoneProblems(page), [], 'manager view: phone rules');
    assert.deepEqual(errors, []);
    await context.close();
  });
}

test('the generator test asks the load with no answer chosen; Save says "Pick the load first"; the due on-load test is said in one line', async () => {
  const { context, page, errors } = await openPage(env, { width: 390, touch: true, clock: CLOCK, path: '#/facilities' });
  await go(page, 'estates-tech');
  await tap(page, '[data-tile="generator-test"]');
  await tap(page, '[data-test="target"] [data-value="asset-generator-2"]');
  assert.match(await page.locator('[data-test="load-due"]').textContent(), /^An on-load test is due for this generator: due by the end of Sun 6 Dec\.$/);
  await tap(page, '[data-test="result"] [data-value="pass"]');
  await tap(page, '[data-test="run"] [data-value="30"]');
  const save = page.locator('[data-test="save"]');
  assert.equal(await save.textContent(), 'Pick the load first');
  assert.equal(await save.isDisabled(), true);
  assert.equal(await page.locator('[data-test="load"] [aria-pressed="true"]').count(), 0, 'no load chosen in advance');
  assert.deepEqual(await page.locator('[data-test="load"] [data-value]').evaluateAll((xs) => xs.map((x) => x.textContent)), ['On load (building or load bank)', 'Off load (no load)']);
  assert.match(await page.locator('[data-test="form"]').textContent(), /does not say the load was enough or that the generator is fit/);
  // Standby generator 1 had its on-load test this period: no line.
  await tap(page, '[data-test="target"] [data-value="asset-generator-1"]');
  assert.equal(await page.locator('[data-test="load-due"]').count(), 0);
  // The picks so far survive a redraw from another tab's change.
  await cmd(page, 'ospeli_facilities_check_record', { checkKind: 'water-level', placeId: 'bld-main-plant', levelPct: 80 }, 'facilities-assistant');
  await page.waitForTimeout(400);
  assert.equal(await page.locator('[data-test="run"] [data-value="30"]').getAttribute('aria-pressed'), 'true', 'the form stays open with its picks');
  // Scheduled checks: the on-load row beside the weekly one; the weekly says on or off load.
  const row = page.locator('[data-check="generator-load-test:asset-generator-1"]');
  assert.match(await row.textContent(), /Generator test on load: Standby generator 1.*Every 4 weeks/);
  assert.match(await page.locator('[data-check="generator-test:asset-generator-1"]').textContent(), /Every week, on or off load/);
  assert.deepEqual(errors, []);
  await context.close();
});

test('the waste form cannot be saved until every pick is made, with no answer chosen in advance; a double tap is "already saved"', async () => {
  const { context, page, errors } = await openPage(env, { width: 390, touch: true, clock: CLOCK, path: '#/facilities' });
  await go(page, 'facilities-assistant', '#/facilities/waste');
  await tap(page, '[data-tile="waste-collected"]');
  const save = page.locator('[data-test="waste-save"]');
  assert.equal(await page.locator('[data-test="waste-form"] [data-test="stream"] [aria-pressed="true"], [data-test="waste-form"] [data-test="containers"] [aria-pressed="true"]').count(), 0, 'nothing chosen in advance');
  assert.equal(await page.locator('[data-test="waste-place"]').inputValue(), '');
  assert.equal(await save.textContent(), 'Pick the place first');
  await page.locator('[data-test="waste-place"]').selectOption('bld-main-b');
  assert.equal(await save.textContent(), 'Pick the stream first');
  await tap(page, '[data-test="stream"] [data-value="sharps"]');
  assert.equal(await save.textContent(), 'Pick how many containers first');
  assert.equal(await save.isDisabled(), true);
  assert.equal(await page.locator('[data-test="waste-form"] [data-test="reason"]').count(), 0, 'a collection asks no reason');
  await tap(page, '[data-test="containers"] [data-value="20"]');
  assert.equal(await page.locator('[data-test="containers"] [data-value="20"]').textContent(), '20 or more');
  assert.equal(await save.textContent(), 'Save');
  await save.tap();
  await waitSaved(page, /Saved: Sharps, Building B.*20 or more containers collected/);
  // The same again at once: already saved, nothing new.
  const n = await page.evaluate(() => window.ospeli.core.eventCount());
  await tap(page, '[data-tile="waste-collected"]');
  await page.locator('[data-test="waste-place"]').selectOption('bld-main-b');
  await tap(page, '[data-test="stream"] [data-value="sharps"]');
  await tap(page, '[data-test="containers"] [data-value="20"]');
  await tap(page, '[data-test="waste-save"]');
  await waitSaved(page, /Already saved/);
  assert.ok(await page.evaluate(() => window.ospeli.core.eventCount()) <= n + 1, 'no second waste record (an audit line at most)');
  assert.equal(await page.locator('[data-test="waste-form"]').count(), 1, 'the form stays open with its picks after "already saved"');
  await tap(page, '[data-test="back"]');
  // A miss asks the reason, not containers.
  await tap(page, '[data-tile="waste-missed"]');
  assert.equal(await page.locator('[data-test="waste-form"] [data-test="containers"]').count(), 0);
  await page.locator('[data-test="waste-place"]').selectOption('bld-main-b');
  await tap(page, '[data-test="stream"] [data-value="chemical"]');
  assert.equal(await page.locator('[data-test="waste-save"]').textContent(), 'Pick what happened first');
  assert.match(await page.locator('.fac').textContent(), /does not check what is inside a container/);
  assert.match(await page.locator('[data-test="planned"]').textContent(), /Compliance calendar: planned, not built yet\. Rooms out of use: planned, not built yet\./);
  assert.deepEqual(errors, []);
  await context.close();
});

test('a role with no rights sees no waste button and one line saying who can; an agent\'s waste record waits for a person; guide off, the waste log works the same', async () => {
  const { context, page, errors } = await openPage(env, { width: 1280, clock: CLOCK, path: '#/facilities' });
  for (const role of ['ops-manager', 'ward-nurse', 'coo']) {
    await go(page, role, '#/facilities/waste');
    assert.equal(await page.locator('.fac [data-cmd], .fac [data-tile], .fac [data-test="waste-late"]').count(), 0, `${role} sees no waste button`);
    assert.match(await page.locator('[data-test="read-only"]').textContent(), /Collections are recorded by Facilities technician, Facilities assistant, Facilities manager/);
    assert.ok(await page.locator('[data-test="waste-missed"]').count() >= 1, `${role} still sees the missed collection`);
  }
  await go(page, 'ops-manager');
  assert.equal(await page.locator('[data-test="attention"] [data-test="waste-late"]').count(), 0, 'no late-collection button for the operations manager');
  assert.ok(await page.locator('[data-test="attention"] [data-test="waste-missed"]').count() >= 1);
  // An agent proposes a collection: nothing changes until the manager accepts.
  await cmd(page, 'ospeli_agents_set_access', { allowed: true, wards: { 'ward-a1': true } }, 'coo');
  await cmd(page, 'ospeli_agents_add', { name: 'waste-bot', role: 'facilities-assistant', wards: ['ward-a1'], days: 30 }, 'coo');
  await go(page, 'facilities-manager');
  const n = await page.evaluate(() => window.ospeli.core.eventCount());
  const c0 = kpi(await overview(page), 'waste-containers').value;
  const p = await page.evaluate(async () => {
    const { runCommand } = await import('/app/core/commands.js');
    return runCommand(window.ospeli.core, 'ospeli_facilities_waste_record', { placeId: 'bld-north-1', stream: 'general', outcome: 'collected', containers: 5 }, { type: 'agent', role: 'facilities-assistant', agent: 'waste-bot' });
  });
  assert.equal(p.status, 'proposed');
  await page.waitForSelector('[data-test="proposals"] [data-proposal]');
  assert.match(await page.locator('[data-test="proposals"]').textContent(), /Record waste: General, Clinic building, 5 containers collected/);
  assert.equal(await page.evaluate(() => window.ospeli.core.eventCount()), n, 'nothing changed');
  assert.equal(await page.locator('[data-test="attention"] [data-test="waste-missed"][data-place="bld-north-1"]').count(), 1, 'the miss is still waiting');
  await page.locator('[data-test="proposals"] [data-cmd="ospeli_proposals_accept"]').click();
  await page.waitForFunction(() => !document.querySelector('[data-test="attention"] [data-test="waste-missed"][data-place="bld-north-1"]'));
  assert.equal(kpi(await overview(page), 'waste-containers').value, c0 + 5);
  // Guide off: the waste log works the same.
  await page.click('[data-test="guide-switch"]');
  await page.waitForSelector('[data-test="guide-off"]');
  await go(page, 'facilities-manager', '#/facilities/waste');
  await page.click('[data-tile="waste-missed"]');
  await page.locator('[data-test="waste-place"]').selectOption('dept-emergency');
  await page.click('[data-test="stream"] [data-value="infectious"]');
  await page.click('[data-test="reason"] [data-value="could-not-take"]');
  await page.click('[data-test="waste-save"]');
  await waitSaved(page, /Saved: Infectious, Emergency department: collection missed \(Came but could not take it\)/);
  assert.equal(await page.locator('[data-test="waste-missed"][data-place="dept-emergency"]').count(), 1);
  assert.deepEqual(errors, []);
  await context.close();
});

// ---- the first five minutes on a phone (ospeli/ospeli#112) ----
test('front line: the facilities assistant on a 390 px touch phone opens on the module, reaches the waste log with no help, records a collection and a missed collection; the manager\'s figures change', async () => {
  const { context, page, errors } = await openPage(env, { width: 390, height: 844, touch: true, clock: CLOCK, path: '' });
  const t0 = Date.now();
  await setRole(page, 'facilities-assistant');
  await waitUntil(page, async () => (await window.ospeli.core.getMeta('role')) === 'facilities-assistant');
  await openFromNow(page, 'facilities-assistant');
  await page.waitForFunction(() => document.querySelector('.fac')?.dataset.role === 'facilities-assistant');
  assert.equal(await page.evaluate(() => location.hash), '#/facilities');
  const k0 = await overview(page);
  // One big Waste log button under the utilities tiles, on the first screen.
  const btn = await page.locator('[data-test="to-waste"]').boundingBox();
  assert.ok(btn.y + btn.height <= 844, `the Waste log button is on the first screen (bottom at ${Math.round(btn.y + btn.height)} px)`);
  assert.equal(await page.locator('[data-tile]').count(), 4, 'the utilities tiles stay as they were');
  await page.locator('[data-test="to-waste"]').tap();
  await page.waitForFunction(() => document.querySelector('.fac')?.dataset.screen === 'waste');
  assert.deepEqual(await phoneProblems(page), []);
  const tile = await page.locator('[data-tile="waste-missed"]').boundingBox();
  assert.ok(tile.y + tile.height <= 844, 'both tiles on the first screen');

  // Collected: tile, place, stream, containers, save = five taps.
  await tap(page, '[data-tile="waste-collected"]');
  await page.locator('[data-test="waste-place"]').selectOption('bld-main-a');
  await tap(page, '[data-test="stream"] [data-value="infectious"]');
  await tap(page, '[data-test="containers"] [data-value="3"]');
  await tap(page, '[data-test="waste-save"]');
  await waitSaved(page, /Saved: Infectious, Building A.*3 containers collected/);
  const sv = await page.locator('[data-test="saved"]').boundingBox();
  assert.ok(sv.y >= 0 && sv.y < 844, 'Saved shows on screen');
  // Missed: tile, place, stream, reason, save = five taps.
  await tap(page, '[data-tile="waste-missed"]');
  await page.locator('[data-test="waste-place"]').selectOption('bld-main-a');
  await tap(page, '[data-test="stream"] [data-value="general"]');
  await tap(page, '[data-test="reason"] [data-value="did-not-come"]');
  await tap(page, '[data-test="waste-save"]');
  await waitSaved(page, /Saved: General, Building A.*collection missed \(Collection did not come\)/);
  assert.equal(await page.locator('[data-test="waste-waiting"] [data-test="waste-missed"][data-place="bld-main-a"][data-stream="general"]').count(), 1, 'listed as still waiting');

  const k1 = await overview(page);
  const [s0, s1] = [kpi(k0, 'waste-missed-share'), kpi(k1, 'waste-missed-share')];
  assert.deepEqual([s1.numerator, s1.denominator], [s0.numerator + 1, s0.denominator + 2], 'the missed share counts both');
  assert.equal(kpi(k1, 'waste-containers').value, kpi(k0, 'waste-containers').value + 3);
  // And the manager view shows it.
  await go(page, 'facilities-manager');
  assert.equal(await page.locator('[data-kpi="waste-missed-share"]').getAttribute('data-n'), `${s1.numerator}/${s1.denominator}`);
  assert.equal(await page.locator('[data-kpi="waste-containers"]').getAttribute('data-value'), String(kpi(k1, 'waste-containers').value));
  assert.ok(Date.now() - t0 < 5 * 60e3, 'under five minutes');
  assert.deepEqual(errors, []);
  await context.close();
});

test('manager: the facilities manager on a 390 px touch phone sees the missed waste collection in Needs attention, records the late collection, and it clears while the missed share keeps the miss; the on-load row and figure are there', async () => {
  const { context, page, errors } = await openPage(env, { width: 390, height: 844, touch: true, clock: CLOCK, path: '' });
  const t0 = Date.now();
  await setRole(page, 'facilities-manager');
  await waitUntil(page, async () => (await window.ospeli.core.getMeta('role')) === 'facilities-manager');
  await openFromNow(page, 'facilities-manager');
  await page.waitForFunction(() => document.querySelector('.fac')?.dataset.role === 'facilities-manager');
  assert.equal(await page.evaluate(() => location.hash), '#/facilities');
  const att = page.locator('[data-test="attention"]');
  const miss = att.locator('[data-test="waste-missed"]');
  assert.equal(await miss.count(), 1);
  assert.match(await miss.textContent(), /Waste collection missed: General, Clinic building.*Missed.*Collection did not come/);
  // Listed after the existing items.
  const y = async (l) => (await l.first().boundingBox()).y;
  assert.ok(await y(miss) > await y(att.locator('[data-test="missed"]')), 'after the missed check');
  assert.ok(await y(miss) > await y(att.locator('[data-test="open-outage"]')), 'after the open outage');
  const s0 = kpi(await overview(page), 'waste-missed-share');

  // Record the late collection: button, containers, save = three taps; the stream and place come from the miss.
  await tap(page, '[data-test="attention"] [data-test="waste-late"]');
  const save = page.locator('[data-test="late-save"]');
  assert.equal(await save.textContent(), 'Pick how many containers first');
  assert.equal(await save.isDisabled(), true);
  assert.equal(await page.locator('[data-test="late-containers"] [aria-pressed="true"]').count(), 0, 'no number chosen in advance');
  assert.deepEqual(await phoneProblems(page), []);
  await tap(page, '[data-test="late-containers"] [data-value="4"]');
  await tap(page, '[data-test="late-save"]');
  await waitSaved(page, /Saved: General, Clinic building: 4 containers collected/);
  await page.waitForFunction(() => !document.querySelector('[data-test="attention"] [data-test="waste-missed"]'));
  const k1 = await overview(page);
  const s1 = kpi(k1, 'waste-missed-share');
  assert.deepEqual([s1.numerator, s1.denominator], [s0.numerator, s0.denominator + 1], 'the miss stays in the share; the collection is one more recorded');
  assert.equal(k1.attention.wasteMissed.length, 0);
  // Waste this month card, the on-load row and the on-load figure.
  assert.match(await page.locator('[data-test="waste-card"]').textContent(), /Waste this month.*containers collected; \d+ of \d+ collections recorded were missed/);
  assert.equal(await page.locator('[data-test="open-waste"]').getAttribute('href'), '#/facilities/waste');
  assert.equal(await page.locator('[data-check="generator-load-test:asset-generator-2"]').count(), 1);
  const load = kpi(k1, 'generator-load-test-compliance');
  assert.equal(await page.locator('[data-kpi="generator-load-test-compliance"]').getAttribute('data-n'), `${load.numerator}/${load.denominator}`);
  assert.match(await page.locator('[data-kpi="generator-load-test-compliance"]').textContent(), /Generator on-load tests done by due date, since Tue 20 Oct/);
  assert.match(await page.locator('[data-test="planned"]').textContent(), /Rooms out of use: planned, not built yet/);
  assert.ok(Date.now() - t0 < 5 * 60e3, 'under five minutes');
  assert.deepEqual(errors, []);
  await context.close();
});

test('the technician records an on-load test on a 390 px touch phone and the on-load row turns Done', async () => {
  const { context, page, errors } = await openPage(env, { width: 390, height: 844, touch: true, clock: CLOCK, path: '#/facilities' });
  await go(page, 'estates-tech');
  const row = page.locator('[data-check="generator-load-test:asset-generator-2"]');
  assert.equal(await row.getAttribute('data-status'), 'due');
  const k0 = kpi(await overview(page), 'generator-load-test-compliance');
  // Tile, generator, pass, 30 min, on load, save = six taps.
  await tap(page, '[data-tile="generator-test"]');
  await tap(page, '[data-test="target"] [data-value="asset-generator-2"]');
  await tap(page, '[data-test="result"] [data-value="pass"]');
  await tap(page, '[data-test="run"] [data-value="30"]');
  await tap(page, '[data-test="load"] [data-value="on-load"]');
  await tap(page, '[data-test="save"]');
  await waitSaved(page, /Saved: Generator test, Standby generator 2: Pass, 30 min, on load\./);
  await page.waitForFunction(() => document.querySelector('[data-check="generator-load-test:asset-generator-2"]')?.dataset.status === 'done');
  assert.match(await row.textContent(), /Done.*Pass, 30 min, on load/);
  assert.equal(await page.locator('[data-check="generator-test:asset-generator-2"]').getAttribute('data-status'), 'done', 'the weekly row too');
  const k1 = kpi(await overview(page), 'generator-load-test-compliance');
  assert.deepEqual([k1.numerator, k1.denominator], [k0.numerator + 1, k0.denominator + 1], 'the period is settled by the on-load test');
  assert.deepEqual(await phoneProblems(page), []);
  assert.deepEqual(errors, []);
  await context.close();
});
