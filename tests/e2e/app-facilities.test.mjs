// Facilities and utilities in the app (module facilities): every role with no sideways scroll and
// no console error at 360, 390 and 1280 px; phone rules for the front line; a form with no typed
// text cannot be saved until every pick is made; a failed generator test offers a fault report that
// waits for a priority; guide suggestions and agent proposals wait for a person; the guide switch;
// roles with no rights see no buttons; the faults card shows Engineering's own next job. And the two
// first-five-minutes tests (ospeli/ospeli#112) on a 390 px touch phone: the facilities technician and
// the facilities manager. Fictional data only.
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
async function asRole(page, role) {
  await setRole(page, role);
  await waitUntil(page, async (r) => (await window.ospeli.core.getMeta('role')) === r, role);
  await page.evaluate(() => {
    const x = document.querySelector('.fac');
    if (location.hash === '#/facilities') return;
    if (x) x.dataset.stale = 'true';
    location.hash = '#/facilities';
  });
  await page.waitForFunction((r) => { const x = document.querySelector('.fac'); return x && !x.dataset.stale && x.dataset.role === r && x.querySelector('.page-head'); }, role);
}
const cmd = (page, name, input, role) => page.evaluate(async ([n, i, r]) => {
  const { runCommand } = await import('/app/core/commands.js');
  return runCommand(window.ospeli.core, n, i, { type: 'human', role: r });
}, [name, input, role]);
const overview = (page) => cmd(page, 'ospeli_facilities_overview', {}, 'facilities-manager');
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
const waitSaved = (page, re) => page.waitForFunction((src) => new RegExp(src).test(document.querySelector('[data-test="saved"]')?.textContent || ''), re.source);

const ROLES = ['estates-tech', 'facilities-assistant', 'facilities-manager', 'ops-manager', 'coo', 'ward-nurse'];
for (const width of [360, 390, 1280]) {
  test(`every role renders at ${width} px with no sideways scroll and no console error`, async () => {
    const { context, page, errors } = await openPage(env, { width, touch: width < 500, clock: CLOCK, path: '#/facilities' });
    for (const role of ROLES) {
      await asRole(page, role);
      assert.ok(await noSideways(page) <= 0, `${role} scrolls sideways`);
      if (['estates-tech', 'facilities-assistant'].includes(role)) {
        await page.locator('[data-tile]').first().click();
        await page.waitForSelector('[data-test="form"]');
        assert.ok(await noSideways(page) <= 0, `${role} form scrolls sideways`);
        if (width < 500) assert.deepEqual(await phoneProblems(page), [], `${role}: phone rules with a form open`);
        await page.click('[data-test="back"]');
        if (width < 500) assert.deepEqual(await phoneProblems(page), [], `${role}: phone rules`);
      }
    }
    assert.deepEqual(errors, []);
    await context.close();
  });
}

test('what each role may do: the assistant sees reading tiles only; a role with no rights sees no action button and one line saying who can', async () => {
  const { context, page, errors } = await openPage(env, { width: 390, touch: true, clock: CLOCK, path: '#/facilities' });
  await asRole(page, 'facilities-assistant');
  assert.deepEqual(await page.locator('[data-tile]').evaluateAll((xs) => xs.map((x) => x.dataset.tile)), ['fuel-level', 'water-level', 'outage-start', 'outage-end']);
  await asRole(page, 'estates-tech');
  assert.equal(await page.locator('[data-tile]').count(), 6);
  assert.equal(await page.locator('[data-test="to-engineering"]').getAttribute('href'), '#/engineering', 'the technician has a link back to Engineering');
  for (const role of ['ward-nurse', 'coo']) {
    await asRole(page, role);
    assert.equal(await page.locator('.fac [data-cmd]').count(), 0, `${role} sees no action button`);
    assert.match(await page.locator('[data-test="read-only"]').textContent(), /Checks are recorded by Facilities technician/);
  }
  await asRole(page, 'ops-manager');
  assert.ok(await page.locator('[data-cmd="ospeli_facilities_outage_start"], [data-test="outage-end"]').count() >= 1, 'the operations manager may record outages');
  assert.equal(await page.locator('[data-cmd="ospeli_facilities_guide_set"], [data-cmd="ospeli_facilities_levels_set"]').count(), 0);
  assert.deepEqual(errors, []);
  await context.close();
});

test('a form cannot be saved until every pick is made; a failed generator test offers a fault report that waits for a priority', async () => {
  const { context, page, errors } = await openPage(env, { width: 390, touch: true, clock: CLOCK, path: '#/facilities' });
  await asRole(page, 'estates-tech');
  await tap(page, '[data-tile="generator-test"]');
  const save = page.locator('[data-test="save"]');
  assert.equal(await save.textContent(), 'Pick the generator first');
  assert.equal(await save.isDisabled(), true);
  await tap(page, '[data-test="target"] [data-value="asset-generator-1"]');
  await tap(page, '[data-test="result"] [data-value="fail"]');
  assert.equal(await save.textContent(), 'Pick how long it ran first');
  assert.equal(await save.isDisabled(), true);
  await tap(page, '[data-test="run"] [data-value="15"]');
  await tap(page, '[data-test="load"] [data-value="off-load"]');
  assert.equal(await save.isDisabled(), false);
  const wos = (await cmd(page, 'ospeli_workorders_list', { state: 'all', limit: 500 }, 'coo')).total;
  await save.tap();
  await waitSaved(page, /Saved: Generator test, Standby generator 1: Fail, 15 min/);
  assert.equal((await cmd(page, 'ospeli_workorders_list', { state: 'all', limit: 500 }, 'coo')).total, wos, 'no work order opened by itself');
  const send = page.locator('[data-test="fault-send"]');
  assert.equal(await send.textContent(), 'Pick how soon first');
  assert.equal(await send.isDisabled(), true);
  assert.equal(await page.locator('[data-test="priority"] [aria-pressed="true"]').count(), 0, 'no priority chosen in advance');
  await tap(page, '[data-test="priority"] [data-value="high"]');
  await send.tap();
  await page.waitForSelector('[data-test="fault-done"]');
  assert.match(await page.locator('[data-test="fault-done"]').textContent(), /Reported: WO-\d+, Generator test fault/);
  assert.equal((await cmd(page, 'ospeli_workorders_list', { state: 'all', limit: 500 }, 'coo')).total, wos + 1);
  // The medical gas form says to follow the site's procedure first; a supply on reserve is raised.
  await tap(page, '[data-tile="gas-check"]');
  assert.match(await page.locator('[data-test="gas-first"]').textContent(), /Follow your site's medical gas procedure first.*does not say a supply is safe/);
  await tap(page, '[data-test="result"] [data-value="pass"]');
  await tap(page, '[data-test="band"] [data-value="reserve"]');
  await tap(page, '[data-test="save"]');
  await waitSaved(page, /Saved: Medical gas check/);
  // #152 (facilities point 4): the saved card says what Ospeli did with a low or reserve reading.
  assert.match(await page.locator('[data-test="saved"] [data-test="gas-told"]').textContent(), /^Shown to the facilities manager under Needs attention in Ospeli\. Nobody has been called\.$/);
  // The manager sees both in Needs attention; the generator's check reads "Done: failed" in coral.
  await asRole(page, 'facilities-manager');
  const att = page.locator('[data-test="attention"]');
  assert.match(await att.locator('[data-test="problem"][data-check="generator-test:asset-generator-1"]').textContent(), /Generator test: Standby generator 1.*Failed/);
  const gas = await att.locator('[data-test="problem"][data-problem="reserve"]').textContent();
  assert.match(gas, /Supply low.*Running on the reserve supply.*Follow your site's medical gas procedure first/);
  assert.ok(!/safe/i.test((await att.textContent()).replaceAll('it does not say a supply is safe for patients', '')), 'nothing says a supply is safe');
  const chip = page.locator('[data-check="generator-test:asset-generator-1"][data-status="done"] [data-test="done-problem"]');
  assert.equal(await chip.textContent(), 'Done: failed');
  assert.equal(await chip.evaluate((x) => getComputedStyle(x).color), 'rgb(138, 36, 18)', 'coral chip, not the green Done');
  // A later pass clears it.
  await cmd(page, 'ospeli_facilities_check_record', { checkKind: 'generator-test', assetId: 'asset-generator-1', result: 'pass', runMinutes: 30 }, 'estates-tech');
  await page.waitForFunction(() => !document.querySelector('[data-test="problem"][data-check="generator-test:asset-generator-1"]'));
  assert.deepEqual(errors, []);
  await context.close();
});

test('small things a person meets: supply wording, Saved where they tapped, honest empty forms, two open outages, a start entered 12 hours later', async () => {
  const { context, page, errors } = await openPage(env, { width: 390, height: 844, touch: true, clock: CLOCK, path: '#/facilities' });
  await asRole(page, 'estates-tech');
  assert.match(await page.locator('[data-tile="fuel-level"]').textContent(), /Generator's own tank/);
  await tap(page, '[data-tile="outage-start"]');
  assert.equal(await page.locator('[data-test="save"]').textContent(), 'Pick the supply first');
  await tap(page, '[data-test="utility"] [data-value="heating-cooling"]');
  await page.locator('[data-test="place"]').selectOption('bld-north-1');
  await tap(page, '[data-test="cause"] [data-value="not-known"]');
  await tap(page, '.fac-ago summary');
  await tap(page, '[data-test="start-ago"] [data-value="720"]');
  await tap(page, '[data-test="save"]');
  await waitSaved(page, /Saved: Heating or cooling outage/);
  const sv = await page.locator('[data-test="saved"]').boundingBox();
  assert.ok(sv.y >= 0 && sv.y < 844, `Saved shows on screen where the person tapped (at ${Math.round(sv.y)} px)`);
  assert.match(await page.locator('[data-test="open-outage"]', { hasText: 'Heating' }).textContent(), /start entered 12 hours later/);
  assert.match(await page.locator('[data-test="recent"] [data-test="backdated"]').first().textContent(), /Start entered 12 hours later/);
  // Two outages open: the tile says to pick one above.
  assert.equal(await page.locator('[data-tile="outage-end"] [data-test="pick-above"]').textContent(), 'Pick the outage above');
  // A site with no generator: no picks and no button that can never be used.
  await page.evaluate(async () => {
    for (const id of ['asset-generator-1', 'asset-generator-2']) {
      const a = await window.ospeli.core.getEntity(id);
      await window.ospeli.core.putEntity({ ...a, kind: 'retired-plant' }, 'coo');
    }
  });
  await page.reload();
  await page.waitForSelector('html[data-ready="true"]');
  await page.waitForFunction(() => document.querySelector('.fac')?.dataset.role === 'estates-tech');
  for (const kind of ['generator-test', 'fuel-level']) {
    await tap(page, `[data-tile="${kind}"]`);
    assert.match(await page.locator('[data-test="no-target"]').textContent(), /There is no generator on this site yet/);
    assert.equal(await page.locator('[data-test="form"] [data-test="result"], [data-test="form"] [data-test="save"], [data-test="form"] [data-test="level"]').count(), 0);
    assert.match(await page.locator('[data-test="form"]').textContent(), /sets up the site on the Data and audit page/);
    assert.deepEqual(await phoneProblems(page), []);
    await tap(page, '[data-test="back"]');
  }
  assert.deepEqual(errors, []);
  await context.close();
});

test('the faults card shows Engineering\'s own next job for the facilities team, with no count of its own', async () => {
  const { context, page, errors } = await openPage(env, { width: 1280, clock: CLOCK, path: '#/facilities' });
  await asRole(page, 'facilities-manager');
  const next = await cmd(page, 'ospeli_workorders_next', { team: 'estates' }, 'facilities-manager');
  assert.equal(await page.locator('[data-test="faults"] [data-test="next-job"]').getAttribute('data-wo'), next.workOrder.id);
  const text = await page.locator('[data-test="faults"]').textContent();
  assert.ok(!text.includes(next.positionText) && !/\bof \d+\b/.test(text), 'no count on the card');
  assert.equal(await page.locator('[data-test="open-engineering"]').getAttribute('href'), '#/engineering');
  assert.deepEqual(errors, []);
  await context.close();
});

test('guide suggestions and an agent\'s proposal wait for a person; the guide can be switched off and the page works the same', async () => {
  const { context, page, errors } = await openPage(env, { width: 1280, clock: CLOCK, path: '#/facilities' });
  await asRole(page, 'facilities-manager');
  assert.ok(await page.locator('[data-test="suggestion"]').count() >= 1);
  assert.equal(await page.locator('[data-test="suggestion"] button').count(), 0, 'a suggestion has no button that changes anything');
  // An agent proposes a reading: nothing changes until the manager accepts.
  await cmd(page, 'ospeli_agents_set_access', { allowed: true, wards: { 'ward-a1': true } }, 'coo');
  await cmd(page, 'ospeli_agents_add', { name: 'fac-bot', role: 'estates-tech', wards: ['ward-a1'], days: 30 }, 'coo');
  const n = await page.evaluate(() => window.ospeli.core.eventCount());
  const p = await page.evaluate(async () => {
    const { runCommand } = await import('/app/core/commands.js');
    return runCommand(window.ospeli.core, 'ospeli_facilities_check_record', { checkKind: 'fuel-level', assetId: 'asset-generator-1', levelPct: 90 }, { type: 'agent', role: 'estates-tech', agent: 'fac-bot' });
  });
  assert.equal(p.status, 'proposed');
  await page.waitForSelector('[data-test="proposals"] [data-proposal]');
  assert.match(await page.locator('[data-test="proposals"]').textContent(), /Record a fuel level: Standby generator 1, 90%/);
  assert.equal(await page.evaluate(() => window.ospeli.core.eventCount()), n, 'nothing changed');
  assert.ok((await overview(page)).guide.suggestions.some((s) => s.rule === 'low-level'));
  await page.locator('[data-test="proposals"] [data-cmd="ospeli_proposals_accept"]').click();
  await page.waitForFunction(() => !document.querySelector('[data-test="proposals"] [data-proposal]'));
  assert.ok(!(await overview(page)).guide.suggestions.some((s) => s.rule === 'low-level'), 'the accepted reading clears the low-fuel suggestion');
  // The switch.
  const before = await overview(page);
  await page.click('[data-test="guide-switch"]');
  await page.waitForSelector('[data-test="guide-off"]');
  assert.equal(await page.locator('[data-test="suggestion"]').count(), 0);
  const after = await overview(page);
  assert.deepEqual([after.guide.on, after.kpis.map((k) => k.value), after.attention], [false, before.kpis.map((k) => k.value), before.attention]);
  assert.ok(await page.locator('[data-test="attention"] [data-test="missed"]').count() >= 1, 'the rest of the page is the same');
  await page.click('[data-test="guide-switch"]');
  await page.waitForSelector('[data-test="guide"][data-on="true"]');
  assert.deepEqual(errors, []);
  await context.close();
});

// ---- the first five minutes on a phone (ospeli/ospeli#112) ----
test('front line: the facilities technician on a 390 px touch phone, with no help, records a generator test, starts a power outage and ends it; the manager\'s measures change', async () => {
  const { context, page, errors } = await openPage(env, { width: 390, height: 844, touch: true, clock: CLOCK, path: '' });
  const t0 = Date.now();
  await setRole(page, 'estates-tech');
  await waitUntil(page, async () => (await window.ospeli.core.getMeta('role')) === 'estates-tech');
  await page.goto(env.appUrl);
  await page.waitForSelector('html[data-ready="true"]');
  await page.waitForSelector('#main [data-test="role-shortcuts"]');
  // The technician's own page is Engineering; Facilities is on Journey: the dock, then its chip.
  await page.locator('#dock [data-dock="journey"]').tap();
  await page.locator('#main .journey a[data-module="facilities"]').tap();
  await page.waitForFunction(() => document.querySelector('.fac')?.dataset.role === 'estates-tech');
  const tile = await page.locator('[data-tile="generator-test"]').boundingBox();
  assert.ok(tile.y + tile.height <= 844, `the tiles are on the first screen (bottom at ${Math.round(tile.y + tile.height)} px)`);
  assert.deepEqual(await phoneProblems(page), []);
  const k0 = await overview(page);
  const gen0 = k0.kpis[0];
  const power0 = k0.kpis[1].breakdown.find((b) => b.id === 'power');

  // Generator test: tile, generator, pass, 30 min, save = five taps.
  await tap(page, '[data-tile="generator-test"]');
  await tap(page, '[data-test="target"] [data-value="asset-generator-1"]');
  await tap(page, '[data-test="result"] [data-value="pass"]');
  await tap(page, '[data-test="run"] [data-value="30"]');
  await tap(page, '[data-test="load"] [data-value="on-load"]');
  await tap(page, '[data-test="save"]');
  await waitSaved(page, /Saved: Generator test, Standby generator 1: Pass, 30 min/);
  assert.equal(await page.locator('[data-test="fault"]').count(), 0, 'a pass offers no fault report');

  // Power outage started: tile, utility, place, cause, save.
  await tap(page, '[data-tile="outage-start"]');
  await tap(page, '[data-test="utility"] [data-value="power"]');
  await page.locator('[data-test="place"]').selectOption('bld-main-a');
  await tap(page, '[data-test="cause"] [data-value="not-known"]');
  await tap(page, '[data-test="save"]');
  await waitSaved(page, /Saved: Power outage, Building A/);
  const row = page.locator('[data-test="open-outage"]', { hasText: 'Power outage' });
  const box = await row.boundingBox();
  assert.ok(box.y < 844, 'the open outage is at the top');

  // A minute later the power is back: Outage ended, then save (two taps; the first tap alone ends nothing).
  await page.clock.fastForward(60e3 * 20);
  await row.locator('[data-test="outage-end"]').tap();
  assert.equal((await overview(page)).attention.openOutages.filter((o) => o.utility === 'power').length, 1, 'one tap ends nothing');
  await tap(page, '[data-test="end-cause"] [data-value="outside-supply"]');
  await tap(page, '[data-test="end-save"]');
  await waitSaved(page, /Saved: Power outage ended/);
  assert.equal(await page.locator('[data-test="open-outage"]', { hasText: 'Power outage' }).count(), 0);

  const k1 = await overview(page);
  const gen1 = k1.kpis[0];
  assert.deepEqual([gen1.numerator, gen1.denominator], [gen0.numerator + 1, gen0.denominator + 1], 'generator test compliance counts the test');
  assert.ok(gen1.value > gen0.value);
  const power1 = k1.kpis[1].breakdown.find((b) => b.id === 'power');
  assert.ok(power1.hours > power0.hours && power1.outages === power0.outages + 1, 'outage hours count the outage');
  // And the manager view shows it.
  await asRole(page, 'facilities-manager');
  assert.equal(await page.locator('[data-kpi="generator-test-compliance"]').getAttribute('data-n'), `${gen1.numerator}/${gen1.denominator}`);
  assert.match(await page.locator('[data-test="hours"] [data-utility="power"]').textContent(), /^Power: \d/);
  assert.ok(Date.now() - t0 < 5 * 60e3, 'under five minutes');
  assert.deepEqual(errors, []);
  await context.close();
});

test('manager: the facilities manager on a 390 px touch phone opens on the module, sees the missed check and the open outage first, ends the outage and sets a level; the low-fuel suggestion clears', async () => {
  const { context, page, errors } = await openPage(env, { width: 390, height: 844, touch: true, clock: CLOCK, path: '' });
  const t0 = Date.now();
  await setRole(page, 'facilities-manager');
  await waitUntil(page, async () => (await window.ospeli.core.getMeta('role')) === 'facilities-manager');
  await openFromNow(page, 'facilities-manager');
  await page.waitForFunction(() => document.querySelector('.fac')?.dataset.role === 'facilities-manager');
  assert.equal(await page.evaluate(() => location.hash), '#/facilities', 'one tap from Now opens the module');
  // First on the page: the missed check and the open outage, above the guide, measures and forms.
  const y = async (sel) => (await page.locator(sel).first().boundingBox()).y;
  const missed = page.locator('[data-test="attention"] [data-test="missed"]');
  assert.match(await missed.textContent(), /Generator test: Standby generator 2.*Missed/);
  const endBtn = await page.locator('[data-test="attention"] [data-test="outage-end"]').boundingBox();
  assert.ok(endBtn.y + endBtn.height <= 844, `the open outage and its button are on the first screen (bottom at ${Math.round(endBtn.y + endBtn.height)} px)`);
  for (const later of ['[data-test="guide"]', '[data-test="measures"]', '[data-test="levels"]', '[data-test="log"]']) assert.ok(await y(later) > endBtn.y, `${later} comes after the attention list`);
  assert.ok(await y('[data-test="missed"]') < endBtn.y);

  // End the water outage.
  await page.locator('[data-test="attention"] [data-test="outage-end"]').tap();
  await tap(page, '[data-test="end-save"]');
  await waitSaved(page, /Saved: Water outage ended/);
  assert.equal((await overview(page)).attention.openOutages.length, 0);
  assert.match(await page.locator('[data-test="attention"]').textContent(), /Missed/);
  // Set the fuel level: the low-fuel suggestion clears.
  assert.equal(await page.locator('[data-test="suggestion"][data-rule="low-level"]').count(), 1);
  assert.equal(await page.locator('[data-test="levels-save"]').isDisabled(), true, 'nothing to save until a new level is picked');
  await tap(page, '[data-test="level-fuel"] [data-value="30"]');
  await tap(page, '[data-test="levels-save"]');
  await page.waitForFunction(() => !document.querySelector('[data-test="suggestion"][data-rule="low-level"]'));
  assert.deepEqual([(await overview(page)).levels.fuelPct], [30]);
  assert.ok(Date.now() - t0 < 5 * 60e3, 'under five minutes');
  assert.deepEqual(errors, []);
  await context.close();
});
