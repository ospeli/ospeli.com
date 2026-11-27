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
import { startApp, openPage, setRole, chooseDepartment } from './helpers.mjs';

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
  await setRole(page, role);
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
// A cold open as a clinic role working in Outpatients. Navigation v2: every cold open lands on Now,
// and the role's page is the first card under "Your pages", one tap away (it no longer opens by itself).
async function openAs(page, role) {
  await setRole(page, role);
  await roleSaved(page, role);
  await chooseDepartment(page, 'outpatients');
  await page.goto(env.appUrl);
  await page.waitForSelector('html[data-ready="true"]');
  await page.waitForSelector('#main [data-test="role-shortcuts"]');
  assert.match(await page.evaluate(() => location.hash), /^(#\/?(home)?)?$/, 'a cold open lands on Now');
  const first = page.locator('#main [data-test="role-shortcuts"] a').first();
  assert.equal(await first.getAttribute('href'), '#/clinics', 'the clinic queue is the first card under Your pages');
  await first.tap();
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
  assert.equal(await page.evaluate(() => location.hash), '#/clinics', 'one tap on the first card on Now opens the clinic queue');
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
  assert.match(await page.locator(`[data-appointment="${id}"] [data-test="wait"]`).textContent(), /^Waiting 0 min · booked \d\d:\d\d, arrived \d\d:\d\d/);
  // Patients already here are not folded away: "Left, or marked by mistake?" is one tap from their row.
  assert.match(await page.locator('.cl-sec').first().textContent(), /^Still to come \(\d+\)$/);
  const here = page.locator('[data-test="here-now"] > li[data-state="arrived"]').first();
  await here.locator('[data-test="left"] > summary').tap();
  assert.match(await here.locator('[data-test="wrong-arrived"]').textContent(), /^Marked arrived by mistake\? Undo it: Patient P\d+ goes back to not arrived yet\. The mistake and the undo both stay in the record\.$/);
  // A wrong Arrived is put right at the desk (ospeli/ospeli#144): back to booked, the mistake and the undo both in the log.
  const hereId = await here.getAttribute('data-appointment');
  await here.locator('[data-test="undo-arrived"]').tap();
  await page.waitForSelector(`[data-appointment="${hereId}"][data-state="booked"]`);
  const undone = await page.evaluate(async (s) => (await window.ospeli.core.events({ subject: s })).map((e) => [e.type, e.actorRole, e.data?.undo ?? null]), hereId);
  assert.deepEqual(undone.slice(-2), [['appointment.arrived', 'clinic-receptionist', null], ['appointment.step-undone', 'clinic-receptionist', 'arrived']]);
  assert.equal(await page.locator(`[data-appointment="${hereId}"] [data-step="arrived"]`).count(), 1, 'Arrived can be marked again');
  assert.ok(await page.locator(`[data-appointment="${hereId}"] [data-step="arrived"]`).isDisabled(), 'but not in the first moments after the undo, so a second tap cannot redo it');
  assert.match(await page.locator(`[data-appointment="${hereId}"] [data-step="arrived"]`).textContent(), /^Arrived \(wait \d s\)$/);
  // An early arrival's long wait is shown with the booked time; the colour follows the time past it.
  const early = await page.evaluate(() => [...document.querySelectorAll('[data-test="here-now"] [data-test="wait"]')].map((x) => [x.textContent, x.className]));
  assert.ok(early.every(([t, cls]) => /booked \d\d:\d\d, arrived \d\d:\d\d/.test(t) && (/past booked time/.test(t) ? true : !/st-late/.test(cls))), JSON.stringify(early));
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
  const cb = await call.boundingBox();
  assert.ok(cb.y >= 0 && cb.y + cb.height <= 844, `the first Call in is fully on the first screen (bottom at ${Math.round(cb.y + cb.height)} px)`);
  assert.equal(await page.locator('[data-test="find"]').count(), 0, 'the nurse is not asked to search');
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

test('the clinic nurse puts right a patient called in by mistake: Undo Call in sends them back to waiting with the arrival time kept (ospeli/ospeli#144)', async () => {
  const { context, page, errors } = await openPage(env, { width: 390, height: 844, touch: true, clock: CLOCK, path: '' });
  await openAs(page, 'clinic-nurse');
  await page.waitForSelector('[data-test="queue"]');
  const call = page.locator('[data-step="called"]').first();
  const id = await call.locator('xpath=ancestor::li[1]').getAttribute('data-appointment');
  const arrivedAt = (await run(page, 'ospeli_clinics_queue', {}, 'clinic-nurse')).patients.find((p) => p.appointmentId === id).arrivedAt;
  await call.tap();
  await page.waitForSelector(`[data-appointment="${id}"][data-state="called"]`);
  const row = page.locator(`[data-appointment="${id}"]`);
  await row.locator('[data-test="wrong-called"] > summary').tap();
  assert.deepEqual(await phoneProblems(page), [], 'undo panel: phone rules');
  await row.locator('[data-test="undo-called"]').tap();
  await page.waitForSelector(`[data-appointment="${id}"][data-state="arrived"]`);
  const p = (await run(page, 'ospeli_clinics_queue', {}, 'clinic-nurse')).patients.find((x) => x.appointmentId === id);
  assert.deepEqual([p.state, p.arrivedAt, p.calledAt], ['arrived', arrivedAt, null], 'back to waiting; the arrival time is kept');
  const evs = await page.evaluate(async (s) => (await window.ospeli.core.events({ subject: s })).slice(-2).map((e) => [e.type, e.actorRole]), id);
  assert.deepEqual(evs, [['appointment.called', 'clinic-nurse'], ['appointment.step-undone', 'clinic-nurse']], 'the wrong step and the undo both stay in the log');
  assert.equal(await row.locator('[data-step="called"]').count(), 1, 'Call in is offered again');
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
  assert.match(await page.locator('[data-test="clinics"] > li').first().textContent(), /General medicine clinic.*Used.*Empty.*Offered.*Used \d+.*\+ empty \d+ = \d+ offered.*Waiting now: \d+, longest/s);
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
  await page.waitForSelector(`[data-test="waiting"] [data-code="${code}"][data-state="booked"]`);
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
  assert.match(await row.textContent(), /Patient P\d+.*Eye clinic.*Added today/s);
  const slot = row.locator('[data-cmd="ospeli_slots_book"]').first();
  await slot.tap();
  await page.waitForSelector(`[data-test="waiting"] [data-code="${second.subject}"][data-state="booked"]`);
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
  await page.waitForFunction((x) => !document.querySelector(`li[data-session="${x}"] [data-test="fill-empty"]`), sessionId); // no Fill while the cancel list is open
  assert.match(await card.locator('[data-test="tell-patient"]').textContent(), /Ospeli sends no messages/);
  const targets = await card.locator('[data-test="move-list"] > li').evaluateAll((xs) => xs.map((x) => x.dataset.move));
  const real = targets.filter((x) => x !== 'none');
  assert.equal(new Set(real).size, real.length, `each booking has its own slot: ${targets.join(', ')}`);
  const times = await card.locator('[data-test="move-list"] > li').evaluateAll((xs) => xs.map((x) => x.querySelector('b').textContent.slice(0, 5)));
  assert.deepEqual(times, [...times].sort(), 'booked-time order');
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
  // Wait for the queue to be drawn for the find box (#133: a fixed 500 ms was not always enough on a busy machine).
  await until(async () => /No Patient P4 in this clinic today|Patient P4\b/.test(await page.locator('.cl').textContent()), 'the queue filtered to P4');
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
  assert.match(await page.locator('[data-test="read-only"]').textContent(), /Appointments scheduler, Outpatient manager/);
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

test('the booking clerk\'s mistakes can be put right, and a booked row stays in place: Booked by mistake, Added by mistake, one Book panel, the new referral in view', async () => {
  const { context, page, errors } = await openPage(env, { width: 390, height: 844, touch: true, clock: CLOCK, path: '' });
  await openAs(page, 'booking-clerk');
  await page.waitForSelector('[data-test="waiting"]');
  const rows = page.locator('[data-test="waiting"] > li');
  const first = rows.nth(0); const second = rows.nth(1);
  const [c1, c2] = [await first.getAttribute('data-code'), await second.getAttribute('data-code')];
  // One Book panel at a time.
  await first.locator('[data-test="book-open"]').tap();
  await first.locator('[data-test="book-options"]').waitFor();
  await second.locator('[data-test="book-open"]').tap();
  await second.locator('[data-test="book-options"]').waitFor();
  assert.equal(await page.locator('[data-test="book-options"]').count(), 1, 'opening one closes the other');
  await page.locator(`[data-code="${c1}"] [data-test="book-open"]`).tap();
  const slot = page.locator(`[data-code="${c1}"] [data-cmd="ospeli_slots_book"]`).first();
  await slot.waitFor();
  const pageY = (c) => page.evaluate((x) => document.querySelector(`[data-test="waiting"] [data-code="${x}"]`).getBoundingClientRect().y + window.scrollY, c);
  const before2 = { y: await pageY(c2) };
  await slot.tap();
  // The row stays where it was, now saying when it is booked; the next row does not slide up.
  await page.waitForSelector(`[data-test="waiting"] [data-code="${c1}"][data-state="booked"]`);
  assert.match(await page.locator(`[data-code="${c1}"] [data-test="booked-now"]`).textContent(), /^Booked: \w{3} \d+ \w{3}, \d\d:\d\d$/);
  const after2 = { y: await pageY(c2) };
  assert.ok(after2.y >= before2.y - 2, `the next row did not move up under the finger (${Math.round(before2.y)} -> ${Math.round(after2.y)})`);
  // Booked by mistake: one confirm, then it is back on the list.
  await page.locator(`[data-code="${c1}"] [data-test="booked-mistake"] > summary`).tap();
  await page.locator(`[data-code="${c1}"] [data-test="confirm-unbook"]`).tap();
  await page.waitForSelector(`[data-test="waiting"] [data-code="${c1}"][data-state="waiting"]`);
  const undo = await page.evaluate(async () => (await window.ospeli.core.events({ type: 'appointment.cancelled' })).at(-1));
  assert.deepEqual([undo.actorRole, undo.data.by, undo.data.reason], ['booking-clerk', 'site', 'Booked in error']);
  // Added by mistake: add one, it comes into view, then remove it with one confirm.
  await page.locator('[data-test="open-referral-box"] > summary').tap();
  await page.locator('[data-test="open-referral"] [data-service="antenatal"]').tap();
  await page.locator('[data-test="open-referral"] [data-source="walk-in"]').tap();
  await page.locator('[data-test="add-referral"]').tap();
  await until(async () => page.evaluate(async () => (await window.ospeli.core.events({ type: 'code.opened' })).at(-1).data.service === 'antenatal'), 'the new code');
  const code = await page.evaluate(async () => (await window.ospeli.core.events({ type: 'code.opened' })).at(-1).subject);
  const row = page.locator(`[data-test="waiting"] [data-code="${code}"]`);
  await row.waitFor();
  await until(async () => { const b = await row.boundingBox(); return b && b.y >= 0 && b.y < 844; }, 'the new referral scrolled into view');
  assert.match(await row.textContent(), /Added today/);
  await row.locator('[data-test="added-mistake"] > summary').tap();
  await row.locator('[data-test="confirm-remove"]').tap();
  await page.waitForSelector(`[data-test="waiting"] [data-code="${code}"][data-state="removed"]`);
  const closed = await lastEvent(page, code);
  assert.deepEqual([closed.type, closed.actorRole, closed.data.reason], ['code.closed', 'booking-clerk', 'Opened in error']);
  assert.deepEqual(await phoneProblems(page), [], 'waiting list: phone rules');
  assert.deepEqual(errors, []);
  await context.close();
});

test('after a clinic\'s end the manager closes each open appointment with the shared commands, and only then is "Mark the clinic as held" offered', async () => {
  const { context, page, errors } = await openPage(env, { width: 390, height: 844, touch: true, clock: CLOCK, path: '' });
  await openAs(page, 'outpatient-manager');
  await page.waitForSelector('[data-test="clinics"]');
  const gm = () => page.locator('[data-test="clinics"] > li[data-service="general-medicine"]');
  assert.equal(await gm().locator('[data-test="mark-held"]').count(), 0, 'not while patients are booked, waiting or in');
  assert.match(await gm().locator('[data-test="day-sum"]').textContent(), /^Used \d+.* \+ empty \d+ = \d+ offered/);
  await page.clock.fastForward('05:00:00'); // 15:00 at the site: the clinic ended at 12:30
  await page.reload();
  await page.waitForSelector('html[data-ready="true"]');
  await page.waitForSelector('[data-test="close-out"]');
  assert.equal(await gm().locator('[data-test="fill-empty"], [data-test="cancel-clinic"]').count(), 0, 'no Fill or Cancel after the end');
  assert.equal(await gm().locator('[data-test="mark-held"]').count(), 0);
  const co = gm().locator('[data-test="close-out"]');
  if (await co.locator('li[data-state="arrived"]').count()) {
    const li = co.locator('li[data-state="arrived"]').first();
    assert.match(await co.locator('[data-test="not-tapped"]').textContent(), /"Seen, no times" closes the visit as attended with no call or finish time\. The start, wait and overrun figures leave it out and say how many\./);
    assert.deepEqual(await li.locator('button').allTextContents(), ['Seen, no times', 'Left before being seen'], 'Seen, no times first, then Left before being seen');
  }
  const noTimesExpected = await co.locator('li[data-state="arrived"]').count();
  if (await co.locator('li[data-state="called"]').count()) {
    assert.equal(await co.locator('li[data-state="called"] button').first().textContent(), 'Finished (recorded now, late)');
    assert.match(await co.locator('[data-test="late-finish"]').textContent(), /overrun figure will include it/);
  }
  // Each row closed stays where it was, greyed (a close-out step has no undo): a second tap on the same
  // spot a moment later lands on no other patient's button and writes nothing.
  const writes = () => page.evaluate(async () => (await window.ospeli.core.events({ type: ['appointment.finished', 'appointment.seen-no-times', 'appointment.cancelled', 'appointment.no-show'] })).length);
  let closedHere = 0;
  for (let i = 0; i < 20 && await gm().locator('[data-test="close-out"] li:not([data-state="closed"])').count(); i++) {
    const li = gm().locator('[data-test="close-out"] li:not([data-state="closed"])').first();
    const id = await li.getAttribute('data-appointment');
    const btn = li.locator('button').first();
    await btn.scrollIntoViewIfNeeded();
    const b = await btn.boundingBox();
    const n0 = await writes();
    await page.touchscreen.tap(b.x + b.width / 2, b.y + b.height / 2);
    await page.waitForSelector(`[data-test="close-out"] [data-appointment="${id}"][data-state="closed"]`);
    closedHere++;
    await page.waitForTimeout(300);
    await page.touchscreen.tap(b.x + b.width / 2, b.y + b.height / 2);
    await page.waitForTimeout(400);
    assert.equal(await writes(), n0 + 1, `the second tap after closing ${id} wrote nothing`);
  }
  assert.equal(await gm().locator('[data-test="closed-here"]').count(), closedHere, 'every row closed here is still shown, greyed');
  await gm().locator('[data-test="mark-held"]').tap();
  await page.waitForSelector('[data-test="clinics"] > li[data-service="general-medicine"][data-state="held"]');
  assert.match(await gm().locator('[data-test="day-sum"]').textContent(), /^Used (\d+).*\+ empty (\d+) = (\d+) offered/);
  const [, u, e, o] = (await gm().locator('[data-test="day-sum"]').textContent()).match(/^Used (\d+).*\+ empty (\d+) = (\d+) offered/);
  assert.equal(+u + +e, +o, 'the figures add up');
  // Patients closed as "Seen, no times" are counted, and the end figure says it is only the earliest end.
  if (noTimesExpected) {
    assert.match(await gm().locator('[data-test="no-times-count"]').textContent(), new RegExp(`^${noTimesExpected} seen with no times \\(Seen, no times\\): left out of the end figure, and of the start figure when never called in\\.`));
    assert.match(await gm().locator('[data-test="start-end"]').textContent(), /at least\.|may have ended later\.|^No call time recorded\.$|recorded call/);
  }
  assert.deepEqual(errors, []);
  await context.close();
});

test('the desk: after "Did not come?" or "Left before being seen" saves, the row keeps its place and height; a second tap a second later lands on no other patient\'s button and writes nothing', async () => {
  const { context, page, errors } = await openPage(env, { width: 390, height: 844, touch: true, clock: CLOCK, path: '' });
  await page.clock.fastForward('00:50:00'); // 10:50 at the site: the 10:30 patient is past the booked time and the grace
  await openAs(page, 'clinic-receptionist');
  await page.waitForSelector('[data-test="queue"]');
  const count = () => page.evaluate(async () => (await window.ospeli.core.events({ type: ['appointment.arrived', 'appointment.no-show', 'appointment.cancelled'] })).length);
  async function tapAndCheck(rowSel, summarySel, buttonSel, state) {
    const row = page.locator(rowSel).first();
    const id = await row.getAttribute('data-appointment');
    await row.locator(summarySel).tap();
    const btn = page.locator(`[data-appointment="${id}"] ${buttonSel}`).first();
    await btn.waitFor();
    await btn.scrollIntoViewIfNeeded();
    const b = await btn.boundingBox();
    const h0 = (await page.locator(`[data-appointment="${id}"]`).boundingBox()).height;
    const n0 = await count();
    await page.touchscreen.tap(b.x + b.width / 2, b.y + b.height / 2);
    await page.waitForSelector(`[data-appointment="${id}"][data-state="${state}"]`);
    assert.equal(await count(), n0 + 1);
    const h1 = (await page.locator(`[data-appointment="${id}"]`).boundingBox()).height;
    assert.ok(h1 >= h0 - 1, `the row kept its height (${h0} -> ${h1})`);
    const under = await page.evaluate(([x, y, a]) => { const el = document.elementFromPoint(x, y); const btn = el?.closest('button, summary, a'); const li = el?.closest('li[data-appointment]'); return { other: Boolean(btn && li && li.dataset.appointment !== a), mine: li?.dataset.appointment === a }; }, [b.x + b.width / 2, b.y + b.height / 2, id]);
    assert.deepEqual(under, { other: false, mine: true }, 'the tapped point is still this patient\'s row');
    await page.waitForTimeout(1000);
    await page.touchscreen.tap(b.x + b.width / 2, b.y + b.height / 2);
    await page.waitForTimeout(500);
    assert.equal(await count(), n0 + 1, 'the second tap wrote nothing');
  }
  await tapAndCheck('[data-test="queue"] > li[data-state="booked"]:has([data-test="missed"])', '[data-test="missed"] > summary', '[data-reason="Did not arrive"]', 'no-show');
  await tapAndCheck('[data-test="here-now"] > li[data-state="arrived"]', '[data-test="left"] > summary', '[data-cmd="ospeli_slots_cancel"]', 'cancelled');
  // A missed appointment marked too soon is undone on the same day (ospeli/ospeli#144): back to booked, Arrived offered again.
  const missed = page.locator('li[data-state="no-show"]:has([data-test="wrong-missed"])').first();
  const missedId = await missed.getAttribute('data-appointment');
  await missed.locator('[data-test="wrong-missed"] > summary').tap();
  assert.deepEqual(await missed.locator('[data-test="undo-no-show"]').allTextContents(), ['Undo: marked by mistake', 'Undo: patient arrived late']);
  const ub = await missed.locator('[data-test="undo-no-show"][data-reason="Patient arrived late"]').boundingBox();
  await page.touchscreen.tap(ub.x + ub.width / 2, ub.y + ub.height / 2);
  await page.waitForSelector(`[data-appointment="${missedId}"][data-state="booked"]`);
  // No panel that writes opens again under the finger; the row says what to do next.
  assert.equal(await page.locator(`[data-appointment="${missedId}"] [data-test="missed"]`).count(), 0, 'no "Did not come?" right after the undo');
  assert.equal(await page.locator(`[data-appointment="${missedId}"] [data-test="undone"]`).textContent(), 'Back to not arrived yet. Tap Arrived when the patient is here.');
  const last = await page.evaluate(async (s) => (await window.ospeli.core.events({ subject: s })).at(-1), missedId);
  assert.deepEqual([last.type, last.data.undo, last.data.reason], ['appointment.step-undone', 'no-show', 'Patient arrived late']);
  // A second tap on the same spot a moment later writes nothing (the round-3 trap: it marked the patient missed again).
  await page.waitForTimeout(300);
  await page.touchscreen.tap(ub.x + ub.width / 2, ub.y + ub.height / 2);
  await page.waitForTimeout(500);
  assert.equal((await page.evaluate(async (s) => (await window.ospeli.core.events({ subject: s })).at(-1), missedId)).type, 'appointment.step-undone', 'the second tap wrote nothing');
  assert.deepEqual(errors, []);
  await context.close();
});

test('#184: beside slot utilisation the page says a missed appointment counts as used, with attended and missed slots, matching the command (360 and 390 px)', async () => {
  for (const width of [360, 390]) {
    const { context, page, errors } = await openPage(env, { width, clock: CLOCK, path: '#/clinics' });
    await asRole(page, 'outpatient-manager', 'summary');
    const k = (await run(page, 'ospeli_clinics_day_summary', {}, 'outpatient-manager')).kpis.find((x) => x.id === 'slot-utilisation');
    assert.ok(k.attended + k.missed <= k.numerator && k.missed > 0, 'the example history has missed appointments in held clinics');
    const line = (await page.locator('[data-kpi="slot-utilisation"] [data-test="used-split"]').textContent()).replace(/\s+/g, ' ');
    assert.match(line, /A missed appointment counts as a used slot/);
    assert.ok(line.includes(`${k.attended} attended`) && line.includes(`${k.missed} missed`), line);
    const px = await page.locator('[data-kpi="slot-utilisation"] [data-test="used-split"]').evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    assert.ok(px >= 15, `text ${px} px`);
    assert.equal(await noSideways(page), 0);
    assert.deepEqual(errors, []);
    await context.close();
  }
});

test('#185: beside the waiting time in clinic the page shows the wait past booked time and says arrived to called is the headline (360, 390 and 1280 px)', async () => {
  for (const width of [360, 390, 1280]) {
    const { context, page, errors } = await openPage(env, { width, clock: CLOCK, path: '#/clinics' });
    await asRole(page, 'outpatient-manager', 'summary');
    const k = (await run(page, 'ospeli_clinics_day_summary', {}, 'outpatient-manager')).kpis.find((x) => x.id === 'clinic-wait');
    assert.ok(k.pastBooked && k.pastBooked.n === k.n, 'the same patients as the headline');
    assert.ok(k.pastBooked.medianMinutes <= k.value, 'never more than arrived to called');
    const line = (await page.locator('[data-kpi="clinic-wait"] [data-test="past-booked"]').textContent()).replace(/\s+/g, ' ');
    assert.match(line, /^Headline: arrived to called\. Beside it, wait past booked time: median \d+ (min|h)/);
    const px = await page.locator('[data-kpi="clinic-wait"] [data-test="past-booked"]').evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    assert.ok(px >= 15, `text ${px} px`);
    assert.equal(await noSideways(page), 0);
    assert.deepEqual(errors, []);
    await context.close();
  }
});

// Issue #155 point 2: the next day, yesterday's close-out sent the manager to "Open the clinic queue",
// which opens today's queue (a past day's list is read only, and Arrived is marked on the clinic's own
// day). A past day's close-out has no such link and says what is true instead.
test('a past day\'s close-out has no link to today\'s queue and says Arrived is marked on the clinic\'s own day', async () => {
  const { context, page, errors } = await openPage(env, { width: 390, height: 844, touch: true, clock: CLOCK, path: '' });
  await page.clock.fastForward('24:00:00'); // Wednesday 10:00 at the site: Tuesday's clinics were left open
  await openAs(page, 'outpatient-manager');
  await page.evaluate(() => { location.hash = '#/clinics/summary'; });
  await page.waitForSelector('[data-test="clinics"]');
  await page.locator('[data-day="-1"]').tap();
  await page.waitForFunction(() => document.querySelector('[data-day="-1"]')?.getAttribute('aria-pressed') === 'true' && document.querySelector('[data-test="close-out"]'));
  const co = page.locator('[data-test="close-out"]');
  assert.ok(await co.locator('li[data-state="booked"]').count(), 'yesterday still has a booked patient to close');
  assert.equal(await page.locator('[data-test="to-queue"]').count(), 0, 'no link that opens today\'s queue');
  const hint = await co.first().locator('[data-test="seen-not-arrived"]').textContent();
  assert.match(hint, /^Seen on Tue 10 Nov but never marked Arrived\? Do not record a missed appointment\. Arrived is marked only on the clinic's own day/);
  assert.doesNotMatch(hint, /clinic queue/);
  assert.deepEqual(await phoneProblems(page), [], 'phone rules');
  assert.deepEqual(errors, []);
  await context.close();
});
