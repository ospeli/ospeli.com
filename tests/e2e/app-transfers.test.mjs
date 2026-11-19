// Transfers and vehicles in the app (module transfers): every role and screen with no sideways
// scroll and no console error at 360, 390 and 1280 px; the driver's first five minutes on a 390 px
// touch screen (picks a vehicle, which writes a crewing event, sees the first job on the first
// screen and taps it through to Handed over; a quick second tap cannot skip a step; the vehicle is
// free again and the measures change); the coordinator's first five minutes on a phone (the queue
// and free vehicles first, gives the oldest journey to a free crewed vehicle, marks one delayed);
// a ward books in a few taps; a failed daily check becomes a fault report a person sends; the guide
// switch; an agent's write waits for a person; roles with no rights see no buttons.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, openPage } from './helpers.mjs';

let env;
before(async () => { env = await startApp(); });
after(async () => { await env.close(); });

const CLOCK = '2026-11-10T14:00:00Z'; // 10:00 at the example site: the day shift
// Playwright's waitForFunction does not wait for an async check, so a check that reads the store polls from here.
async function until(check, what) {
  for (let i = 0; i < 100; i++) { if (await check()) return; await new Promise((r) => setTimeout(r, 100)); }
  assert.fail(`timed out waiting for ${what}`);
}
// A fresh device starts as Ward nurse with nothing saved, so choosing that role again saves nothing.
const roleSaved = (page, role) => until(async () => { const v = await page.evaluate(() => window.ospeli.core.getMeta('role')); return v === role || (v == null && role === 'ward-nurse'); }, `role ${role}`);
const noSideways = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
async function asRole(page, role, screen = '') {
  await page.selectOption('#role-select', role);
  await roleSaved(page, role);
  const hash = screen ? `#/transfers/${screen}` : '#/transfers';
  await page.evaluate((target) => {
    const x = document.querySelector('.trf');
    if (location.hash === target) return;
    if (x) x.dataset.stale = 'true';
    location.hash = target;
  }, hash);
  await page.waitForFunction(([r, s]) => {
    const x = document.querySelector('.trf');
    return x && !x.dataset.stale && x.dataset.role === r && (!s || x.dataset.screen === s);
  }, [role, screen]);
}
// Opening the app with no address, as a phone that keeps its role does.
async function openAs(page, role) {
  await page.selectOption('#role-select', role);
  await roleSaved(page, role);
  await page.goto(env.appUrl);
  await page.waitForSelector('html[data-ready="true"]');
  await page.waitForFunction((r) => document.querySelector('.trf')?.dataset.role === r, role);
}
const phoneProblems = (page) => page.evaluate(() => {
  const out = [];
  for (const el of document.querySelectorAll('.trf button, .trf a, .trf select, .trf summary, .trf input')) {
    const r = el.getBoundingClientRect();
    if (r.height && r.height < 44 && el.type !== 'checkbox') out.push(`${el.tagName} "${el.textContent.trim().slice(0, 30)}" is ${Math.round(r.height)} px tall`);
  }
  for (const el of document.querySelectorAll('.trf *')) {
    const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    const size = parseFloat(getComputedStyle(el).fontSize);
    if (own && el.getClientRects().length && !el.closest('.sr-only') && size < 15) out.push(`"${el.textContent.trim().slice(0, 30)}" is ${size} px`);
  }
  return out;
});
const run = (page, name, input, role, who = null) => page.evaluate(async ([n, i, r, w]) => {
  const { runCommand } = await import('/app/core/commands.js');
  try { return await runCommand(window.ospeli.core, n, i, w || { type: 'human', role: r }); } catch (err) { return { error: err.code, message: err.message }; }
}, [name, input, role, who]);
const board = (page) => run(page, 'ospeli_transfers_board', {}, 'transport-coordinator');

const SCREENS = [['driver', 'jobs'], ['driver', 'fleet'], ['transport-coordinator', 'board'], ['transport-coordinator', 'request'], ['transport-coordinator', 'fleet'],
  ['fleet-supervisor', 'fleet'], ['fleet-supervisor', 'board'], ['ward-nurse', 'request'], ['ward-nurse', 'board'], ['ae-nic', 'request'], ['bed-manager', 'board'], ['coo', 'board'], ['coo', 'fleet']];
for (const width of [360, 390, 1280]) {
  test(`every role and screen renders at ${width} px with no sideways scroll and no console error`, async () => {
    const { context, page, errors } = await openPage(env, { width, touch: width < 500, clock: CLOCK, path: '#/transfers' });
    for (const [role, screen] of SCREENS) {
      await asRole(page, role, screen);
      const o = await noSideways(page);
      assert.ok(o <= 0, `${role} ${screen} scrolls sideways by ${o} px`);
    }
    assert.deepEqual(errors, []);
    await context.close();
  });
}

// Adoption check (ospeli/ospeli#112): the front-line persona's first five minutes, untrained, on a phone.
test('the driver\'s first five minutes on a 390 px touch screen: picks a vehicle, sees the first job on the first screen, taps it through to Handed over; the vehicle is free and the measures change', async () => {
  const { context, page, errors } = await openPage(env, { width: 390, height: 844, touch: true, clock: CLOCK, path: '' });
  await openAs(page, 'driver');
  assert.equal(await page.evaluate(() => location.hash), '#/transfers', 'the driver opens on the module, not on Today');
  await page.waitForSelector('[data-test="pick-vehicle"]');
  assert.deepEqual(await phoneProblems(page), [], 'vehicle pick: phone rules');
  const before = await board(page);
  const wait0 = before.kpis.find((k) => k.id === 'transfer-wait').n; const hand0 = before.kpis.find((k) => k.id === 'handover-time').n;
  assert.equal(before.vehicles.find((v) => v.id === 'asset-vehicle-2').crewed, false);
  await page.locator('[data-vehicle="asset-vehicle-2"]').tap();
  await page.waitForSelector('[data-test="next-job"][data-state="assigned"]');
  const ev = await page.evaluate(async () => (await window.ospeli.core.events({ subject: 'asset-vehicle-2' })).at(-1));
  assert.deepEqual([ev.type, ev.actorRole, ev.data.shift], ['transfers.vehicle-crewed', 'driver', 'shift-day'], 'the pick writes a crewing event: vehicle, shift and role, never who');
  const card = page.locator('[data-test="next-job"]');
  const id = await card.getAttribute('data-transfer');
  assert.match(await card.textContent(), /Next job.*Discharge.*As soon as possible.*From .*To Home.*Arrived at pickup/s);
  const main = page.locator('[data-test="main-action"]');
  const box = await main.boundingBox();
  assert.ok(box.y + box.height <= 844, `the job's button is on the first screen (bottom at ${Math.round(box.y + box.height)} px)`);
  assert.ok(box.height >= 56, `one big button (${box.height} px)`);
  assert.deepEqual(await phoneProblems(page), [], 'my jobs: phone rules');
  assert.equal(await page.locator('[data-kpi], [data-test="guide"]').count(), 0, 'no measures or guide on the driver\'s screen');

  const labels = [];
  for (const step of ['arrived-pickup', 'departed', 'arrived-destination', 'handed-over']) {
    await page.waitForFunction((s) => { const b = document.querySelector('[data-test="main-action"]'); return b && b.dataset.step === s && !b.disabled; }, step);
    labels.push(await main.textContent());
    const b = await main.boundingBox();
    await main.tap();
    if (step === 'arrived-pickup') {
      // A second tap a moment later, as a person checking it worked would: it does not take the next step.
      await page.waitForFunction(() => document.querySelector('[data-test="main-action"]')?.dataset.step === 'departed');
      await page.touchscreen.tap(b.x + b.width / 2, b.y + b.height / 2);
      await page.waitForTimeout(400);
      assert.equal(await page.evaluate(async (t) => (await window.ospeli.core.events({ subject: t })).at(-1).type, id), 'transfers.arrived-pickup', 'the second tap did not skip a step');
      assert.match(await main.textContent(), /^Departed \(wait \d s\)$/);
    }
  }
  assert.deepEqual(labels, ['Arrived at pickup', 'Departed', 'Arrived at destination', 'Handed over']);
  await page.waitForFunction((t) => document.querySelector('[data-test="next-job"]')?.dataset.transfer !== t, id);
  const steps = await page.evaluate(async (t) => (await window.ospeli.core.events({ subject: t })).slice(-4).map((e) => [e.type, e.actorRole]), id);
  assert.deepEqual(steps, [['transfers.arrived-pickup', 'driver'], ['transfers.departed', 'driver'], ['transfers.arrived-destination', 'driver'], ['transfers.handed-over', 'driver']]);
  const afterB = await board(page);
  assert.equal(afterB.vehicles.find((v) => v.id === 'asset-vehicle-2').state, 'free', 'the vehicle shows free on the board');
  assert.equal(afterB.vehicles.find((v) => v.id === 'asset-vehicle-2').crewed, true);
  assert.equal(afterB.kpis.find((k) => k.id === 'transfer-wait').n, wait0 + 1, 'transfer wait counts it');
  assert.equal(afterB.kpis.find((k) => k.id === 'handover-time').n, hand0 + 1, 'handover time counts it');
  // The phone keeps its vehicle: reopened, it shows the vehicle's (now empty) jobs, not the pick.
  await page.reload();
  await page.waitForSelector('html[data-ready="true"]');
  await page.waitForSelector('[data-test="my-vehicle"][data-vehicle="asset-vehicle-2"]');
  assert.match(await page.locator('[data-test="jobs-empty"]').textContent(), /No job for Vehicle 2 right now/);
  assert.deepEqual(errors, []);
  await context.close();
});

// Adoption check (ospeli/ospeli#112): the manager's first five minutes, untrained, on a phone.
test('the coordinator\'s first five minutes on a 390 px phone: the queue and free vehicles first, gives the oldest journey to a free crewed vehicle, marks one delayed with a reason', async () => {
  const { context, page, errors } = await openPage(env, { width: 390, height: 844, touch: true, clock: CLOCK, path: '' });
  await openAs(page, 'transport-coordinator');
  assert.equal(await page.evaluate(() => location.hash), '#/transfers');
  const counts = page.locator('[data-test="board-counts"]');
  await counts.waitFor();
  assert.match(await counts.textContent(), /Waiting\d+longest \d+ min.*Free vehicles\d of 3\d crewed.*Journeys under way\d/s);
  const first = page.locator('[data-test="queue"] > li').first();
  const fb = await first.boundingBox();
  assert.ok(fb.y < 844, `the first waiting journey starts on the first screen (top at ${Math.round(fb.y)} px)`);
  const kpiTop = (await page.locator('[data-kpi]').first().boundingBox()).y;
  const guideTop = (await page.locator('[data-test="guide"]').boundingBox()).y;
  assert.ok(fb.y < kpiTop && fb.y < guideTop, 'the queue comes before the measures and the guide');
  assert.deepEqual(await phoneProblems(page), [], 'the board on a phone: phone rules');
  const oldest = await first.getAttribute('data-transfer');
  const b0 = await board(page);
  assert.equal(b0.waiting[0].id, oldest, 'the first row is the one needed first');
  const free = b0.vehicles.find((v) => v.state === 'free' && v.crewed);
  // Give it without choosing: the button says what is missing, nothing is saved.
  await first.locator('[data-test="assign"]').tap();
  assert.equal(await first.locator('.trf-status').textContent(), 'Choose a vehicle first.');
  await first.locator('[data-test="assign-vehicle"]').selectOption(free.id);
  await first.locator('[data-test="assign"]').tap();
  await page.waitForFunction((t) => !document.querySelector(`[data-test="queue"] [data-transfer="${t}"]`) && document.querySelector(`[data-test="open"] [data-transfer="${t}"]`), oldest);
  const ev = await page.evaluate(async (t) => (await window.ospeli.core.events({ subject: t })).at(-1), oldest);
  assert.deepEqual([ev.type, ev.actorRole, ev.data.vehicle], ['transfers.assigned', 'transport-coordinator', free.id]);
  // Mark the next waiting one delayed: open, tap a reason.
  const next = page.locator('[data-test="queue"] > li').first();
  const nid = await next.getAttribute('data-transfer');
  await next.locator('[data-test="delay"] summary').tap();
  await next.locator('[data-test="delay"] [data-reason="no-escort"]').tap();
  await page.waitForFunction((t) => document.querySelector(`[data-transfer="${t}"] [data-test="delayed"]`)?.textContent === 'Delayed: no escort', nid);
  const d = await page.evaluate(async (t) => (await window.ospeli.core.events({ subject: t })).at(-1), nid);
  assert.deepEqual([d.type, d.actorRole, d.data.reason], ['transfers.delayed', 'transport-coordinator', 'no-escort']);
  assert.ok(await noSideways(page) <= 0);
  assert.deepEqual(errors, []);
  await context.close();
});

test('a ward nurse books a transfer in a few taps on a 390 px phone; nothing is chosen in advance; the booking is in the queue with its place', async () => {
  const { context, page, errors } = await openPage(env, { width: 390, height: 844, touch: true, clock: CLOCK, path: '#/transfers' });
  await asRole(page, 'ward-nurse', 'request');
  await page.waitForSelector('[data-type="discharge"]');
  assert.equal(await page.locator('.trf-form [aria-pressed="true"]').count(), 0, 'no answer chosen in advance');
  await page.locator('[data-test="req-send"]').tap();
  assert.equal(await page.locator('[data-test="req-status"]').textContent(), 'Choose the kind of journey first.');
  await page.locator('[data-type="between-sites"]').tap();
  await page.selectOption('[data-test="req-pickup"]', 'ward-a2');
  await page.locator('[data-to="site:site-north"]').tap();
  await page.locator('[data-when="asap"]').tap();
  await page.locator('[data-mobility="wheelchair"]').tap();
  await page.locator('[data-escort="none"]').tap();
  await page.locator('[data-equipment="oxygen"]').tap();
  assert.deepEqual(await phoneProblems(page), [], 'booking: phone rules');
  await page.locator('[data-test="req-send"]').tap();
  await page.waitForSelector('[data-test="req-done"]');
  assert.match(await page.locator('[data-test="req-done"]').textContent(), /^Booked: trf-\d{5}\. \w+ of \d+ waiting for a vehicle\./);
  const ev = await page.evaluate(async () => (await window.ospeli.core.events({ type: 'transfers.requested' })).at(-1));
  assert.deepEqual([ev.actorRole, ev.data], ['ward-nurse', { type: 'between-sites', fromPlace: 'ward-a2', toSite: 'site-north', needed: 'asap', mobility: 'wheelchair', escort: 'none', equipment: ['oxygen'], bayMove: false }]);
  await page.waitForSelector(`[data-test="req-open"] [data-transfer="${ev.subject}"]`);
  assert.equal(await page.locator('.trf-form [aria-pressed="true"]').count(), 0, 'the form is clear for the next one');
  assert.ok(await noSideways(page) <= 0);
  assert.deepEqual(errors, []);
  await context.close();
});

test('a failed daily check on a phone: the guide suggests taking the vehicle off the road and a fault report the fleet supervisor sends with a priority they pick', async () => {
  const { context, page, errors } = await openPage(env, { width: 390, height: 844, touch: true, clock: CLOCK, path: '#/transfers' });
  await asRole(page, 'fleet-supervisor', 'fleet');
  await page.waitForSelector('[data-test="chk-form"]');
  assert.match(await page.locator('[data-test="planned"]').textContent(), /Servicing plan: planned, not built yet/);
  await page.selectOption('[data-test="chk-vehicle"]', 'asset-vehicle-3');
  await page.locator('[data-item="lift"] [data-mark="fail"]').tap();
  await page.locator('[data-test="chk-rest"]').tap();
  await page.locator('[data-test="chk-rest-yes"]').tap();
  assert.equal(await page.locator('[data-test="chk-score"]').textContent(), '8 of 9 marked items passed');
  assert.deepEqual(await phoneProblems(page), [], 'daily check: phone rules');
  await page.locator('[data-test="chk-save"]').tap();
  await page.waitForSelector('[data-test="suggestion"][data-rule="check-failed"]');
  const s = page.locator('[data-test="suggestion"][data-rule="check-failed"]');
  assert.match(await s.textContent(), /Vehicle 3 failed its daily check: Patient lift or ramp/);
  await s.locator('[data-test="report-fault"]').tap();
  assert.equal(await s.locator('[data-priority]').count(), 3, 'the person picks the priority');
  await s.locator('[data-priority="high"]').tap();
  const reported = () => page.evaluate(async () => (await window.ospeli.core.events({ type: 'asset.fault-reported', subject: 'asset-vehicle-3' })));
  for (let i = 0; i < 50 && !(await reported()).length; i++) await page.waitForTimeout(100);
  const wo = (await reported())[0];
  assert.deepEqual([wo.actorRole, wo.data.title, wo.data.priority], ['fleet-supervisor', 'Patient lift or ramp not working', 'high']);
  await page.waitForFunction(() => !document.querySelector('[data-test="report-fault"]'));
  await page.waitForTimeout(500);
  await page.locator('[data-rule="check-failed"] [data-test="follow"]').tap();
  await page.waitForSelector('[data-vehicle="asset-vehicle-3"][data-state="off-road"]');
  assert.deepEqual(errors, []);
  await context.close();
});

test('the coordinator\'s board at 1280 px: the guide switch (off: no suggestions, everything else the same), measures with definitions, the not-for line', async () => {
  const { context, page, errors } = await openPage(env, { width: 1280, clock: CLOCK, path: '#/transfers' });
  await asRole(page, 'transport-coordinator', 'board');
  await page.waitForSelector('[data-test="suggestion"]');
  assert.equal(await page.locator('[data-kpi]').count(), 4);
  assert.match(await page.locator('[data-kpi="on-time-pickup"]').textContent(), /example setting, not a standard.*Source: local definition/s);
  assert.match(await page.locator('[data-test="not-for"]').textContent(), /does not time, score or rank drivers or crews/);
  const rules = await page.locator('[data-test="suggestion"]').evaluateAll((l) => l.map((x) => x.dataset.rule).sort());
  assert.deepEqual(rules, ['discharge-later', 'escort-cover']);
  const q = await page.locator('[data-test="queue"] > li').count();
  await page.click('[data-test="guide-switch"]');
  await page.waitForSelector('[data-test="guide-off"]');
  assert.equal(await page.locator('[data-test="suggestion"]').count(), 0);
  assert.equal(await page.locator('[data-kpi]').count(), 4, 'the measures stay');
  assert.equal(await page.locator('[data-test="queue"] > li').count(), q, 'the queue stays');
  assert.ok(await page.locator('[data-test="queue"] [data-test="assign"]').count() > 0, 'assigning works the same');
  await page.click('[data-test="guide-switch"]');
  await page.waitForSelector('[data-test="suggestion"]');
  assert.ok(await noSideways(page) <= 0);
  assert.deepEqual(errors, []);
  await context.close();
});

test('an agent\'s booking waits for a person on the board; refused writes (a typed field, an unknown key, a delay by a ward) change nothing', async () => {
  const { context, page, errors } = await openPage(env, { width: 1280, clock: CLOCK, path: '#/transfers' });
  await asRole(page, 'transport-coordinator', 'board');
  await run(page, 'ospeli_agents_set_access', { allowed: true, wards: { 'ward-b1': true } }, 'coo');
  await run(page, 'ospeli_agents_add', { name: 'transfer-bot', role: 'transport-coordinator', wards: ['ward-b1'], days: 30 }, 'coo');
  // New writes only (the example history may still be arriving): transfer events after the clock started.
  const fresh = () => page.evaluate(async () => (await window.ospeli.core.events()).filter((e) => e.type.startsWith('transfers.') && e.at > '2026-11-10T14:00:00.000Z'));
  const n = (await fresh()).length;
  const ask = { type: 'discharge', fromPlace: 'ward-b1', toOutside: 'care-home', needed: 'asap', mobility: 'stretcher', escort: 'nurse', equipment: ['none'] };
  const p = await run(page, 'ospeli_transfers_request', ask, null, { type: 'agent', agent: 'transfer-bot', role: 'transport-coordinator' });
  assert.equal(p.status, 'proposed');
  assert.equal((await run(page, 'ospeli_transfers_request', { ...ask, note: 'Mr Example' }, 'ward-nurse')).error, 'invalid-input');
  assert.equal((await run(page, 'ospeli_transfers_request', { ...ask, mobility: 'carried by Jane' }, 'ward-nurse')).error, 'invalid-input');
  const w = (await board(page)).waiting[0].id;
  assert.equal((await run(page, 'ospeli_transfers_delay', { transferId: w, reason: 'no-escort' }, 'ward-nurse')).error, 'forbidden');
  assert.equal((await fresh()).length, n, 'nothing changed');
  await page.waitForSelector('[data-test="proposals"] li');
  assert.match(await page.locator('[data-test="proposals"]').textContent(), /Book a transfer: Discharge from Ward B1/);
  await page.locator('[data-test="proposals"] li button', { hasText: 'Accept' }).first().click();
  const accepted = () => page.evaluate(async () => (await window.ospeli.core.events({ type: 'transfers.requested' })).filter((e) => e.data.fromPlace === 'ward-b1' && e.data.escort === 'nurse' && e.data.toOutside === 'care-home' && e.at > '2026-11-10T14:00:00.000Z'));
  for (let i = 0; i < 50 && !(await accepted()).length; i++) await page.waitForTimeout(100);
  const [ev] = await accepted();
  assert.deepEqual([ev.type, ev.data.fromPlace, ev.data.escort], ['transfers.requested', 'ward-b1', 'nurse']);
  assert.equal(ev.actorRole, 'transport-coordinator', 'recorded under the role of the person who said yes');
  assert.deepEqual(errors, []);
  await context.close();
});

test('roles with no rights see no action button, and one line that says who can', async () => {
  const { context, page, errors } = await openPage(env, { width: 1280, clock: CLOCK, path: '#/transfers' });
  await asRole(page, 'coo', 'board');
  await page.waitForSelector('[data-test="queue"] li');
  assert.equal(await page.locator('.trf [data-cmd]').count(), 0);
  assert.match(await page.locator('[data-test="read-only"]').textContent(), /COO can see the board\. Vehicles are given by Transport coordinator/);
  assert.match(await page.locator('[data-test="guide"]').textContent(), /Transport coordinator, Fleet supervisor can switch the guide on or off/);
  await asRole(page, 'coo', 'fleet');
  await page.waitForSelector('[data-test="fleet"]');
  assert.equal(await page.locator('.trf [data-cmd]').count(), 0);
  assert.match(await page.locator('[data-test="read-only"]').textContent(), /Daily checks are recorded by Fleet supervisor, Driver/);
  // A ward sees the board and may cancel, but gives no vehicle and marks no delay.
  await asRole(page, 'ward-nurse', 'board');
  await page.waitForSelector('[data-test="queue"] li');
  assert.equal(await page.locator('.trf [data-cmd="ospeli_transfers_assign"], .trf [data-cmd="ospeli_transfers_delay"]').count(), 0);
  assert.ok(await page.locator('.trf [data-cmd="ospeli_transfers_cancel"]').count() > 0);
  // A driver has no board and books nothing.
  await asRole(page, 'driver', 'jobs');
  assert.deepEqual(await page.locator('.trf-tabs a').evaluateAll((a) => a.map((x) => x.dataset.screen)), ['jobs', 'fleet']);
  assert.deepEqual(errors, []);
  await context.close();
});

test('a ward nurse books a journey for a booked time at 390 px: the time list offers the next day in half hours; picks survive a redraw', async () => {
  const { context, page, errors } = await openPage(env, { width: 390, height: 844, touch: true, clock: CLOCK, path: '#/transfers' });
  await asRole(page, 'ward-nurse', 'request');
  await page.waitForSelector('[data-type="discharge"]');
  await page.locator('[data-type="discharge"]').tap();
  await page.selectOption('[data-test="req-pickup"]', 'ward-b2');
  await page.locator('[data-to="out:care-home"]').tap();
  await page.locator('[data-when="booked"]').tap();
  const options = await page.locator('[data-test="req-slot"] option').evaluateAll((o) => o.map((x) => x.textContent));
  assert.equal(options.length, 49, 'a blank first, then 48 half hours');
  assert.equal(options[1], 'Today 10:30');
  await page.selectOption('[data-test="req-slot"]', { label: 'Today 15:00' });
  await page.locator('[data-mobility="walks"]').tap();
  // Another device writes something: the page is drawn again, and what this nurse picked stays.
  await run(page, 'ospeli_transfers_vehicle_check', { vehicleId: 'asset-vehicle-1', passed: ['tyres', 'lights', 'brakes', 'fuel', 'body', 'lift', 'fixings', 'kit', 'clean'] }, 'driver');
  await page.waitForTimeout(600);
  assert.deepEqual(await page.locator('.trf-form [aria-pressed="true"]').evaluateAll((l) => l.map((x) => x.textContent)), ['Discharge', 'Residential or nursing care', 'At a booked time', 'Walks (may need a hand)']);
  assert.equal(await page.locator('[data-test="req-slot"] option:checked').textContent(), 'Today 15:00');
  await page.locator('[data-escort="carer"]').tap();
  await page.locator('[data-equipment="none"]').tap();
  assert.deepEqual(await phoneProblems(page), [], 'booking: phone rules');
  await page.locator('[data-test="req-send"]').tap();
  await page.waitForSelector('[data-test="req-done"]');
  const ev = await page.evaluate(async () => (await window.ospeli.core.events({ type: 'transfers.requested' })).at(-1));
  assert.deepEqual([ev.data.needed, ev.data.bookedFor, ev.data.fromPlace, ev.data.toOutside], ['booked', '2026-11-10T19:00:00.000Z', 'ward-b2', 'care-home']);
  assert.match(await page.locator(`[data-test="req-open"] [data-transfer="${ev.subject}"]`).textContent(), /Booked for today 15:00/);
  assert.deepEqual(errors, []);
  await context.close();
});

test('with the guide off, a vehicle that failed its daily check still says so: in the vehicle pick list, on its row, on the fleet card and on the driver\'s job card', async () => {
  const { context, page, errors } = await openPage(env, { width: 390, height: 844, touch: true, clock: CLOCK, path: '#/transfers' });
  await asRole(page, 'transport-coordinator', 'board');
  await page.waitForSelector('[data-test="guide-switch"]');
  await page.locator('[data-test="guide-switch"]').tap();
  await page.waitForSelector('[data-test="guide-off"]');
  const all = ['tyres', 'lights', 'brakes', 'fuel', 'body', 'lift', 'fixings', 'kit', 'clean'];
  const r = await run(page, 'ospeli_transfers_vehicle_check', { vehicleId: 'asset-vehicle-3', passed: all.filter((x) => x !== 'brakes'), failed: ['brakes'] }, 'driver');
  assert.equal(r.status, 'done');
  const row = page.locator('[data-test="vehicles"] [data-vehicle="asset-vehicle-3"]');
  await row.locator('[data-test="failed-check"]').waitFor();
  assert.equal(await row.locator('[data-test="failed-check"]').textContent(), 'Failed check: Brakes');
  const opts = await page.locator('[data-test="queue"] li').first().locator('[data-test="assign-vehicle"] option').evaluateAll((o) => o.map((x) => x.textContent));
  assert.ok(opts.some((x) => /^Vehicle 3: .*FAILED CHECK$/.test(x)), opts.join(' | '));
  assert.ok(!opts.some((x) => /^Vehicle 1: .*FAILED CHECK/.test(x)));
  // Vehicle 2 has a job given but not started: it says so, not just "Free".
  assert.equal(await page.locator('[data-test="vehicles"] [data-vehicle="asset-vehicle-2"] [data-test="vehicle-state"]').textContent(), 'Free, 1 next');
  assert.match(await page.locator('[data-test="board-counts"]').textContent(), /Journeys under way/);
  await asRole(page, 'fleet-supervisor', 'fleet');
  assert.match(await page.locator('[data-test="fleet"] [data-vehicle="asset-vehicle-3"] [data-test="failed-check"]').textContent(), /Failed its daily check: Brakes\. Do not send it/);
  // The driver on vehicle 3, with a job given to it.
  const w = (await board(page)).waiting[0].id;
  await run(page, 'ospeli_transfers_assign', { transferId: w, vehicleId: 'asset-vehicle-3' }, 'transport-coordinator');
  await asRole(page, 'driver', 'jobs');
  await page.waitForSelector('[data-vehicle="asset-vehicle-3"]');
  assert.match(await page.locator('[data-test="pick-vehicle"] [data-vehicle="asset-vehicle-3"]').textContent(), /FAILED CHECK/);
  await page.locator('[data-test="pick-vehicle"] [data-vehicle="asset-vehicle-3"]').tap();
  await page.waitForSelector('[data-test="next-job"]');
  assert.match(await page.locator('[data-test="failed-check"]').textContent(), /Vehicle 3 failed its daily check: Brakes\. Tell the coordinator before you drive it\./);
  assert.deepEqual(errors, []);
  await context.close();
});

test('an open "Mark delayed" panel stays open, with its reasons, when another journey is given a vehicle', async () => {
  const { context, page, errors } = await openPage(env, { width: 1280, clock: CLOCK, path: '#/transfers' });
  await asRole(page, 'transport-coordinator', 'board');
  const rows = page.locator('[data-test="queue"] > li');
  await rows.nth(1).waitFor();
  const keep = await rows.nth(1).getAttribute('data-transfer');
  await rows.nth(1).locator('[data-test="delay"] summary').click();
  const first = await rows.first().getAttribute('data-transfer');
  await rows.first().locator('[data-test="assign-vehicle"]').selectOption('asset-vehicle-3');
  await rows.first().locator('[data-test="assign"]').click();
  await page.waitForFunction((t) => !document.querySelector(`[data-test="queue"] [data-transfer="${t}"]`), first);
  assert.equal(await page.locator(`[data-test="queue"] [data-transfer="${keep}"] [data-test="delay"]`).evaluate((d) => d.open), true, 'still open after the redraw');
  await page.locator(`[data-test="queue"] [data-transfer="${keep}"] [data-test="delay"] [data-reason="no-crew"]`).click();
  await page.waitForSelector(`[data-transfer="${keep}"] [data-test="delayed"]`);
  assert.deepEqual(errors, []);
  await context.close();
});
