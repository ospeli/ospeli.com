// Outpatient clinics in the app (module clinics, area A1): every role and screen with no sideways
// scroll and no console error at 360, 390 and 1280 px; the clinic receptionist's first five minutes
// on a 390 px touch screen (opens on the queue, marks the next patient arrived; the row stays where
// it was, a second tap writes nothing, the wait starts); the clinic nurse calls in and finishes
// (Finished waits three seconds after Call in); the outpatient manager's first five minutes on a
// phone (today's clinics, waits and empty slots, then books an empty slot from the waiting list);
// the booking clerk adds a referral (asked "Is this another patient?" on a double tap) and books it
// in two taps; a clinic with bookings is cancelled through Move or Cancel and shows with its reason;
// guide suggestions wait for a person and the guide switches off; an agent's booking waits for a
// person; typed text never reaches the screen as HTML; a role with no rights sees no buttons; the
// queue opens offline. Synthetic data only.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, openPage } from './helpers.mjs';

let env;
before(async () => { env = await startApp(); });
after(async () => { await env.close(); });

const CLOCK = '2026-11-10T14:00:00Z'; // Tuesday 10:00 at the example site: two clinics running
async function until(check, what) {
  for (let i = 0; i < 100; i++) { if (await check()) return; await new Promise((r) => setTimeout(r, 100)); }
  assert.fail(`timed out waiting for ${what}`);
}
const roleSaved = (page, role) => until(async () => { const v = await page.evaluate(() => window.ospeli.core.getMeta('role')); return v === role || (v == null && role === 'ward-nurse'); }, `role ${role}`);
const noSideways = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
async function asRole(page, role, screen = '') {
  await page.selectOption('#role-select', role);
  await roleSaved(page, role);
  const hash = screen ? `#/clinics/${screen}` : '#/clinics';
  await page.evaluate((target) => {
    const x = document.querySelector('.cl');
    if (x) x.dataset.stale = 'true';
    if (location.hash === target) location.hash = '#/clinics/_';
    location.hash = target;
  }, hash);
  await page.waitForFunction(([r, s]) => {
    const x = document.querySelector('.cl');
    return x && !x.dataset.stale && x.dataset.role === r && (!s || x.dataset.screen === s);
  }, [role, screen]);
}
async function openAs(page, role) {
  await page.selectOption('#role-select', role);
  await roleSaved(page, role);
  await page.goto(env.appUrl);
  await page.waitForSelector('html[data-ready="true"]');
  await page.waitForFunction((r) => document.querySelector('.cl')?.dataset.role === r, role);
}
const phoneProblems = (page) => page.evaluate(() => {
  const out = [];
  for (const el of document.querySelectorAll('.cl button, .cl a, .cl select, .cl summary, .cl input')) {
    const r = el.getBoundingClientRect();
    if (r.height && r.height < 44) out.push(`${el.tagName} "${el.textContent.trim().slice(0, 30)}" is ${Math.round(r.height)} px tall`);
  }
  for (const el of document.querySelectorAll('.cl *')) {
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
const lastEvent = (page, subject) => page.evaluate(async (s) => (await window.ospeli.core.events({ subject: s })).at(-1), subject);

const SCREENS = [['clinic-receptionist', 'queue'], ['clinic-receptionist', 'summary'], ['clinic-nurse', 'queue'], ['booking-clerk', 'referrals'], ['booking-clerk', 'templates'],
  ['outpatient-manager', 'summary'], ['outpatient-manager', 'referrals'], ['outpatient-manager', 'queue'], ['outpatient-manager', 'templates'], ['ops-manager', 'summary'], ['coo', 'queue']];
for (const width of [360, 390, 1280]) {
  test(`every role and screen renders at ${width} px with no sideways scroll and no console error`, async () => {
    const { context, page, errors } = await openPage(env, { width, touch: width < 500, clock: CLOCK, path: '#/clinics' });
    for (const [role, screen] of SCREENS) {
      await asRole(page, role, screen);
      await page.waitForSelector('.cl [data-test]', { state: 'attached' });
      const o = await noSideways(page);
      assert.ok(o <= 0, `${role} ${screen} scrolls sideways by ${o} px`);
    }
    assert.deepEqual(errors, []);
    await context.close();
  });
}

// Adoption check (ospeli/ospeli#112): the front-line persona's first five minutes, untrained, on a phone.
test('the clinic receptionist\'s first five minutes on a 390 px touch screen: opens on the queue and marks the next patient arrived; the row stays put and a second tap writes nothing', async () => {
  const { context, page, errors } = await openPage(env, { width: 390, height: 844, touch: true, clock: CLOCK, path: '' });
  await openAs(page, 'clinic-receptionist');
  assert.equal(await page.evaluate(() => location.hash), '#/clinics', 'the receptionist opens on the clinic queue, not on Today');
  await page.waitForSelector('[data-test="queue"]');
  assert.match(await page.locator('[data-test="clinic"] h2').textContent(), /General medicine clinic, Outpatients/);
  assert.deepEqual(await phoneProblems(page), [], 'queue: phone rules');
  const before = await run(page, 'ospeli_clinics_queue', {}, 'clinic-receptionist');
  const btn = page.locator('[data-test="queue"] [data-step="arrived"]').first();
  const box = await btn.boundingBox();
  assert.ok(box.y + box.height <= 844, `the first Arrived button is on the first screen (bottom at ${Math.round(box.y + box.height)} px)`);
  assert.ok(box.height >= 56, `one big button (${box.height} px)`);
  const row = btn.locator('xpath=ancestor::li[1]');
  const id = await row.getAttribute('data-appointment');
  const rowBox = await row.boundingBox();
  await btn.tap();
  await page.waitForSelector(`[data-appointment="${id}"][data-state="arrived"]`);
  // A second tap where the button was, as a person checking it worked would: nothing more is written.
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(400);
  const evs = await page.evaluate(async (s) => (await window.ospeli.core.events({ subject: s })).map((e) => [e.type, e.actorRole]), id);
  assert.deepEqual(evs.slice(-1), [['appointment.arrived', 'clinic-receptionist']]);
  assert.equal(evs.filter((e) => e[0] === 'appointment.arrived').length, 1);
  const after = await run(page, 'ospeli_clinics_queue', {}, 'clinic-receptionist');
  assert.equal(after.patients.filter((p) => p.state === 'arrived').length, before.patients.filter((p) => p.state === 'arrived').length + 1, 'one more arrival, and no other row changed');
  assert.equal(after.clinic.counts.waiting, before.clinic.counts.waiting + 1, 'the waiting count changes');
  const moved = await page.locator(`[data-appointment="${id}"]`).boundingBox();
  assert.ok(Math.abs(moved.y - rowBox.y) < 2, 'the row did not move under the finger');
  assert.match(await page.locator(`[data-appointment="${id}"] [data-test="wait"]`).textContent(), /^Waiting 0 min \(arrived \d\d:\d\d\)$/);
  assert.equal(await page.locator('[data-kpi], [data-test="guide"]').count(), 0, 'no measures or guide on the desk\'s queue');
  assert.deepEqual(errors, []);
  await context.close();
});

test('the clinic nurse calls in and finishes; Finished waits three seconds after Call in; the wait-in-clinic measure counts it', async () => {
  const { context, page, errors } = await openPage(env, { width: 390, height: 844, touch: true, clock: CLOCK, path: '' });
  await openAs(page, 'clinic-nurse');
  await page.waitForSelector('[data-test="queue"]');
  assert.deepEqual(await phoneProblems(page), [], 'nurse queue: phone rules');
  assert.equal(await page.locator('[data-step="arrived"]').count(), 0, 'the nurse is not asked to mark arrivals');
  const m0 = (await run(page, 'ospeli_clinics_day_summary', { format: 'short' }, 'clinic-nurse')).kpis.find((k) => k.id === 'clinic-wait').n;
  const call = page.locator('[data-step="called"]').first();
  const id = await call.locator('xpath=ancestor::li[1]').getAttribute('data-appointment');
  await call.tap();
  const fin = page.locator(`[data-appointment="${id}"] [data-step="finished"]`);
  await fin.waitFor();
  assert.ok(await fin.isDisabled(), 'Finished cannot be tapped at once');
  assert.match(await fin.textContent(), /^Finished \(wait \d s\)$/);
  await page.waitForFunction((a) => !document.querySelector(`[data-appointment="${a}"] [data-step="finished"]`)?.disabled, id, { timeout: 6000 });
  await fin.tap();
  await page.waitForSelector(`[data-appointment="${id}"][data-state="finished"]`);
  assert.deepEqual((await page.evaluate(async (s) => (await window.ospeli.core.events({ subject: s })).slice(-2).map((e) => [e.type, e.actorRole]), id)), [['appointment.called', 'clinic-nurse'], ['appointment.finished', 'clinic-nurse']]);
  const m1 = (await run(page, 'ospeli_clinics_day_summary', { format: 'short' }, 'clinic-nurse')).kpis.find((k) => k.id === 'clinic-wait').n;
  assert.equal(m1, m0 + 1, 'waiting time in clinic counts the call');
  assert.deepEqual(errors, []);
  await context.close();
});

// Adoption check (ospeli/ospeli#112): the manager's first five minutes, untrained, on a phone.
test('the outpatient manager\'s first five minutes on a 390 px phone: today\'s clinics, waits and empty slots, then books an empty slot from the waiting list', async () => {
  const { context, page, errors } = await openPage(env, { width: 390, height: 844, touch: true, clock: CLOCK, path: '' });
  await openAs(page, 'outpatient-manager');
  assert.equal(await page.evaluate(() => location.hash), '#/clinics');
  await page.waitForSelector('[data-test="clinics"]');
  const counts = await page.locator('[data-test="summary-counts"]').textContent();
  assert.match(counts, /Clinics\s*2/);
  assert.match(counts, /Waiting now\s*\d+/);
  assert.match(counts, /Empty slots\s*\d+/);
  const first = await page.locator('[data-test="clinics"] > li').first().boundingBox();
  assert.ok(first.y < 844, 'the first clinic starts on the first screen');
  assert.match(await page.locator('[data-test="clinics"] > li').first().textContent(), /General medicine clinic.*In template.*Used.*Empty.*Waiting now: \d+, longest/s);
  assert.deepEqual(await phoneProblems(page), [], 'clinic day: phone rules');
  // Book an empty slot from the waiting list: Waiting list, Book, the slot.
  await page.locator('.cl-tabs [data-screen="referrals"]').tap();
  await page.waitForSelector('[data-test="waiting"]');
  assert.deepEqual(await phoneProblems(page), [], 'waiting list: phone rules');
  const ref = page.locator('[data-test="waiting"] > li').first();
  const code = await ref.getAttribute('data-code');
  const service = await ref.getAttribute('data-service');
  await ref.locator('[data-test="book-open"]').tap();
  const slot = ref.locator('[data-cmd="ospeli_slots_book"]').first();
  await slot.waitFor();
  const sessionId = await slot.getAttribute('data-session');
  await slot.tap();
  await page.waitForFunction((c) => !document.querySelector(`[data-test="waiting"] [data-code="${c}"]`), code);
  const booked = await page.evaluate(async (c) => (await window.ospeli.core.events({ type: 'appointment.booked' })).filter((e) => e.data.code === c).at(-1), code);
  assert.deepEqual([booked.actorRole, booked.data.sessionId], ['outpatient-manager', sessionId]);
  const ses = (await run(page, 'ospeli_slots_sessions', { sessionType: 'clinic', to: '2026-12-15', limit: 500 }, 'outpatient-manager')).sessions.find((s) => s.id === sessionId);
  assert.equal(ses.service, service, 'booked into a clinic of the referral\'s own service');
  assert.deepEqual(errors, []);
  await context.close();
});

test('the booking clerk adds a referral (a double tap asks "Is this another patient?") and books it in two taps', async () => {
  const { context, page, errors } = await openPage(env, { width: 390, height: 844, touch: true, clock: CLOCK, path: '' });
  await openAs(page, 'booking-clerk');
  await page.waitForSelector('[data-test="waiting"]');
  assert.match(await page.locator('[data-test="order-note"]').textContent(), /by wait only.*cannot know whether two numbers are the same person/);
  await page.locator('[data-test="open-referral-box"] > summary').tap();
  const add = page.locator('[data-test="add-referral"]');
  assert.equal(await add.textContent(), 'Pick the clinic first');
  assert.ok(await add.isDisabled(), 'nothing is chosen in advance');
  await page.locator('[data-test="open-referral"] [data-service="eye"]').tap();
  await page.locator('[data-test="open-referral"] [data-source="referral"]').tap();
  await add.tap();
  await page.waitForFunction(() => document.querySelector('[data-test="add-referral"]')?.textContent === 'Pick the clinic first');
  const first = await page.evaluate(async () => (await window.ospeli.core.events({ type: 'code.opened' })).at(-1).subject);
  // The same again a moment later: Ospeli asks, and makes nothing until a person answers.
  await page.locator('[data-test="open-referral"] [data-service="eye"]').tap();
  await page.locator('[data-test="open-referral"] [data-source="referral"]').tap();
  await add.tap();
  await page.waitForSelector('[data-test="again"]');
  assert.match(await page.locator('[data-test="again"]').textContent(), /Is this another patient\?/);
  assert.equal(await page.evaluate(async () => (await window.ospeli.core.events({ type: 'code.opened' })).at(-1).subject), first, 'no second code yet');
  await page.locator('[data-test="again-yes"]').tap();
  await until(async () => (await page.evaluate(async () => (await window.ospeli.core.events({ type: 'code.opened' })).at(-1).subject)) !== first, 'the second code');
  const second = await page.evaluate(async () => (await window.ospeli.core.events({ type: 'code.opened' })).at(-1));
  assert.deepEqual([second.actorRole, second.data.service, second.data.source], ['booking-clerk', 'eye', 'referral']);
  // The new referral opens with its booking choices: two taps from the list.
  const row = page.locator(`[data-code="${second.subject}"]`);
  await row.waitFor();
  assert.match(await row.textContent(), /Patient P\d+.*Eye clinic.*Waiting 0 days/s);
  const slot = row.locator('[data-cmd="ospeli_slots_book"]').first();
  await slot.tap();
  await page.waitForFunction((c) => !document.querySelector(`[data-test="waiting"] [data-code="${c}"]`), second.subject);
  const b = await page.evaluate(async (c) => (await window.ospeli.core.events({ type: 'appointment.booked' })).find((e) => e.data.code === c), second.subject);
  assert.deepEqual([b.actorRole, b.data.bookedFrom, b.data.slotType], ['booking-clerk', 'referral', 'new']);
  assert.deepEqual(errors, []);
  await context.close();
});

test('a clinic with bookings is cancelled through Move or Cancel, then shows in the clinic day with its reason', async () => {
  const { context, page, errors } = await openPage(env, { width: 1280, clock: CLOCK, path: '#/clinics' });
  await asRole(page, 'outpatient-manager', 'summary');
  await page.locator('[data-day="1"]').click(); // tomorrow
  await page.waitForFunction(() => document.querySelector('[data-day="1"]')?.getAttribute('aria-pressed') === 'true' && document.querySelector('[data-test="clinics"]'));
  const card = page.locator('[data-test="clinics"] > li[data-state="planned"]').first();
  const sessionId = await card.getAttribute('data-session');
  await card.locator('[data-test="cancel-clinic"] > summary').click();
  await card.locator('[data-test="move-list"]').waitFor();
  assert.equal(await card.locator('[data-test="cancel-session"]').count(), 0, 'no cancel while a booking is open');
  let n = 0;
  while (await page.locator(`li[data-session="${sessionId}"] [data-test="move-list"] li`).count()) {
    const li = page.locator(`li[data-session="${sessionId}"] [data-test="move-list"] li`).first();
    const before = await li.getAttribute('data-appointment');
    await li.locator(n % 2 ? '[data-test="cancel-booking"]' : '[data-test="move"]').click();
    await page.waitForFunction(([s, a]) => !document.querySelector(`li[data-session="${s}"] [data-appointment="${a}"]`), [sessionId, before]);
    n++;
  }
  assert.ok(n > 0, 'it had bookings');
  await page.locator(`li[data-session="${sessionId}"] [data-reason="Staff short"]`).click();
  await page.locator(`li[data-session="${sessionId}"] [data-test="cancel-session"]`).click();
  await page.waitForSelector(`li[data-session="${sessionId}"][data-state="cancelled"]`);
  assert.match(await page.locator(`li[data-session="${sessionId}"]`).textContent(), /Cancelled: Staff short/);
  const e = await lastEvent(page, sessionId);
  assert.deepEqual([e.type, e.actorRole, e.data.reason], ['session.cancelled', 'outpatient-manager', 'Staff short']);
  assert.match(await page.locator('[data-test="summary-counts"]').textContent(), /1 cancelled/);
  assert.deepEqual(errors, []);
  await context.close();
});

test('guide suggestions wait for a person; a prefilled booking is a button; the guide switches off and everything else works', async () => {
  const { context, page, errors } = await openPage(env, { width: 1280, clock: CLOCK, path: '#/clinics' });
  await asRole(page, 'outpatient-manager', 'summary');
  const guide = page.locator('[data-test="guide"]');
  assert.equal(await guide.getAttribute('data-on'), 'true');
  assert.ok(await guide.locator('[data-test="suggestion"]').count() >= 2);
  for (const rule of ['missed-high', 'arrivals-bunched']) assert.equal(await guide.locator(`[data-rule="${rule}"]`).count(), 1, `${rule} shows`);
  const booked0 = await page.evaluate(async () => (await window.ospeli.core.events({ type: 'appointment.booked' })).length);
  const follow = guide.locator('[data-rule="empty-soon"] [data-test="follow"]').first();
  assert.equal(await page.evaluate(async () => (await window.ospeli.core.events({ type: 'appointment.booked' })).length), booked0, 'showing a suggestion books nothing');
  await follow.click();
  await until(async () => (await page.evaluate(async () => (await window.ospeli.core.events({ type: 'appointment.booked' })).length)) === booked0 + 1, 'the booking a person tapped');
  await guide.locator('[data-test="guide-switch"]').click();
  await page.waitForSelector('[data-test="guide"][data-on="false"] [data-test="guide-off"]');
  assert.equal(await page.locator('[data-test="suggestion"]').count(), 0);
  assert.equal(await page.locator('[data-kpi]').count(), 5, 'the measures stay');
  await asRole(page, 'clinic-receptionist', 'queue');
  assert.ok(await page.locator('[data-step="arrived"]').count() > 0, 'the queue works with the guide off');
  await asRole(page, 'clinic-receptionist', 'summary');
  assert.equal(await page.locator('[data-test="guide-switch"]').count(), 0, 'only the outpatient manager switches it');
  assert.deepEqual(errors, []);
  await context.close();
});

test('an agent\'s booking waits for a person on the waiting list, and is booked only when a person accepts', async () => {
  const { context, page, errors } = await openPage(env, { width: 1280, clock: CLOCK, path: '#/clinics' });
  const wards = await page.evaluate(async () => (await window.ospeli.core.listEntities('ward')).map((w) => w.id));
  await run(page, 'ospeli_agents_set_access', { allowed: true, wards: Object.fromEntries(wards.map((w) => [w, true])) }, 'coo');
  await run(page, 'ospeli_agents_add', { name: 'clinic-bot', role: 'booking-clerk', wards, days: 30 }, 'coo');
  const bot = { type: 'agent', role: 'booking-clerk', agent: 'clinic-bot' };
  const s = await run(page, 'ospeli_clinics_day_summary', {}, null, bot);
  const offer = s.guide.suggestions.find((x) => x.rule === 'empty-soon').actions[0];
  const n0 = await page.evaluate(async () => (await window.ospeli.core.events({ type: 'appointment.booked' })).length);
  const p = await run(page, 'ospeli_slots_book', offer.input, null, bot);
  assert.equal(p.status, 'proposed');
  await asRole(page, 'booking-clerk', 'referrals');
  const card = page.locator('[data-test="proposals"]');
  await card.locator('.proposal-item').first().waitFor();
  assert.match(await card.textContent(), /Book Patient P\d+ at \d\d:\d\d/);
  assert.equal(await page.evaluate(async () => (await window.ospeli.core.events({ type: 'appointment.booked' })).length), n0, 'nothing booked yet');
  await card.locator('.proposal-yes').first().click();
  await until(async () => (await page.evaluate(async () => (await window.ospeli.core.events({ type: 'appointment.booked' })).length)) === n0 + 1, 'the accepted booking');
  const e = await page.evaluate(async () => (await window.ospeli.core.events({ type: 'appointment.booked' })).at(-1));
  assert.deepEqual([e.actorRole, e.data.code], ['booking-clerk', offer.input.code]);
  assert.deepEqual(errors, []);
  await context.close();
});

test('typed or hostile text cannot reach the screen as HTML: the find box keeps digits only and the command refuses anything else', async () => {
  const { context, page, errors } = await openPage(env, { width: 390, touch: true, clock: CLOCK, path: '#/clinics' });
  await asRole(page, 'clinic-receptionist', 'queue');
  await page.evaluate(() => { window.__pwned = false; });
  const find = page.locator('[data-test="find"]');
  await find.fill('<img src=x onerror="window.__pwned=true">P');
  await page.waitForTimeout(500);
  assert.equal(await find.inputValue(), '', 'letters and markup are not kept');
  await find.pressSequentially('<b>4</b>');
  await page.waitForTimeout(500);
  assert.equal(await find.inputValue(), '4');
  assert.equal(await page.locator('.cl img, .cl b b, .cl script').count(), 0, 'no element made from typed text');
  assert.equal(await page.evaluate(() => window.__pwned), false);
  assert.match(await page.locator('.cl').textContent(), /No Patient P4 in this clinic today|Patient P4\b/);
  const r = await run(page, 'ospeli_clinics_queue', { find: '<img src=x>' }, 'clinic-receptionist');
  assert.equal(r.error, 'invalid-input');
  // The module's own code never sets HTML from data.
  const src = await page.evaluate(async () => (await (await fetch('/app/modules/clinics/view.js')).text()));
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML/.test(src));
  assert.deepEqual(errors, []);
  await context.close();
});

test('a role with no rights sees the queue and the day with no action buttons, and one line saying who acts', async () => {
  const { context, page, errors } = await openPage(env, { width: 390, touch: true, clock: CLOCK, path: '#/clinics' });
  await asRole(page, 'coo', 'queue');
  await page.waitForSelector('[data-test="queue"]');
  assert.equal(await page.locator('.cl [data-cmd]').count(), 0, 'no command buttons on the queue');
  assert.match(await page.locator('[data-test="read-only"]').textContent(), /Clinic receptionist, Clinic nurse/);
  await asRole(page, 'coo', 'referrals');
  await page.waitForSelector('[data-test="waiting"]');
  assert.equal(await page.locator('.cl [data-cmd]').count(), 0, 'no booking buttons');
  assert.match(await page.locator('[data-test="read-only"]').textContent(), /Booking clerk, Outpatient manager/);
  await asRole(page, 'clinic-nurse', 'summary');
  assert.equal(await page.locator('.cl [data-cmd="ospeli_slots_session_change"], .cl [data-cmd="ospeli_clinics_guide_set"]').count(), 0);
  await asRole(page, 'booking-clerk', 'templates');
  assert.match(await page.locator('[data-test="planned"]').textContent(), /planned, not built yet/);
  assert.equal(await page.locator('.cl [data-cmd]').count(), 0, 'templates are read-only');
  assert.ok(await page.locator('[data-test="templates"] li').count() >= 10);
  assert.deepEqual(errors, []);
  await context.close();
});

test('the queue opens offline; on a device with no connection to its site server the taps wait and the desk is told to note arrivals on paper', async () => {
  const { context, page, errors } = await openPage(env, { width: 390, touch: true, clock: CLOCK, path: '#/clinics' });
  await asRole(page, 'clinic-receptionist', 'queue');
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await until(async () => page.evaluate(() => Boolean(navigator.serviceWorker.controller)) || (await page.reload(), page.evaluate(() => Boolean(navigator.serviceWorker.controller))), 'the offline copy');
  await context.setOffline(true);
  await page.reload();
  await page.waitForSelector('html[data-ready="true"]');
  await page.waitForSelector('[data-test="queue"]');
  assert.ok(await page.locator('[data-step="arrived"]').count() > 0, 'the queue opens with no network');
  // A device connected to a site server that lost its connection: the shell marks the page offline.
  await page.evaluate(() => { document.documentElement.dataset.site = 'offline'; });
  await page.waitForSelector('[data-test="offline"]');
  assert.match(await page.locator('[data-test="offline"]').textContent(), /note the arrival time on paper/);
  assert.ok(await page.locator('[data-step="arrived"]').first().isDisabled(), 'taps wait for a connection');
  await context.setOffline(false);
  assert.deepEqual(errors.filter((e) => !/net::|Failed to fetch|ERR_INTERNET_DISCONNECTED/.test(e)), []);
  await context.close();
});
