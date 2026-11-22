// Pharmacy operations in the app (module pharmacy): every role on every screen with no sideways
// scroll and no console error at 360, 390 and 1280 px; phone rules (targets 44 px, text 15 px) for the
// front line; roles with no rights see no action button and one line saying who can; the guide switch;
// the ward asks for discharge medicines and collects them. And the two first-five-minutes tests
// (ospeli/ospeli#112) on a 390 px touch phone: the pharmacy technician and the pharmacy manager.
// Fixed clock; fictional data only.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, openPage } from './helpers.mjs';

let env;
before(async () => { env = await startApp(); });
after(async () => { await env.close(); });

const CLOCK = '2026-11-20T18:00:00Z'; // 14:00 at the example site
const noSideways = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
async function asRole(page, role, screen = '') {
  await page.selectOption('#role-select', role);
  await page.waitForFunction(async (r) => (await window.ospeli.core.getMeta('role')) === r, role);
  await page.evaluate((s) => {
    const x = document.querySelector('.mod-pharmacy');
    if (x) x.dataset.stale = 'true';
    location.hash = `#/pharmacy${s ? `/${s}` : ''}`;
    if (x && location.hash === `#/pharmacy${s ? `/${s}` : ''}`) window.dispatchEvent(new HashChangeEvent('hashchange'));
  }, screen);
  await page.waitForFunction(([r, s]) => { const x = document.querySelector('.mod-pharmacy'); return x && !x.dataset.stale && x.dataset.role === r && (!s || x.dataset.screen === s) && x.querySelector('[data-test="not-for"]'); }, [role, screen]);
}
const cmd = (page, name, input, role) => page.evaluate(async ([n, i, r]) => {
  const { runCommand } = await import('/app/core/commands.js');
  return runCommand(window.ospeli.core, n, i, { type: 'human', role: r });
}, [name, input, role]);
const overview = (page) => cmd(page, 'ospeli_pharmacy_overview', {}, 'pharmacy-manager');
const kpi = async (page, id) => (await overview(page)).kpis.find((k) => k.id === id);
const phoneProblems = (page) => page.evaluate(() => {
  const out = [];
  for (const el of document.querySelectorAll('.mod-pharmacy button, .mod-pharmacy a, .mod-pharmacy select, .mod-pharmacy summary')) {
    const r = el.getBoundingClientRect();
    if (r.height && r.height < 44) out.push(`${el.tagName} "${el.textContent.trim().slice(0, 30)}" is ${Math.round(r.height)} px tall`);
  }
  for (const el of document.querySelectorAll('.mod-pharmacy *')) {
    const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    const size = parseFloat(getComputedStyle(el).fontSize);
    if (own && el.getClientRects().length && !el.closest('.sr-only') && el.tagName !== 'OPTION' && size < 15) out.push(`"${el.textContent.trim().slice(0, 30)}" is ${size} px`);
  }
  return out;
});
// The smallest target and text on the page, for the report.
const smallest = (page) => page.evaluate(() => {
  let target = Infinity; let text = Infinity;
  for (const el of document.querySelectorAll('.mod-pharmacy button, .mod-pharmacy a, .mod-pharmacy select, .mod-pharmacy summary')) { const h = el.getBoundingClientRect().height; if (h) target = Math.min(target, h); }
  for (const el of document.querySelectorAll('.mod-pharmacy *')) {
    if ([...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()) && el.getClientRects().length && el.tagName !== 'OPTION') text = Math.min(text, parseFloat(getComputedStyle(el).fontSize));
  }
  return { target: Math.round(target), text };
});
const tap = async (page, sel) => { const l = page.locator(sel).first(); await l.scrollIntoViewIfNeeded(); await l.tap(); };

const SCREENS = ['queue', 'discharge', 'summary'];
const ROLES = ['pharmacy-technician', 'pharmacist', 'pharmacy-manager', 'ward-nurse', 'bed-manager', 'coo'];
for (const width of [360, 390, 1280]) {
  test(`every role on every screen at ${width} px: no sideways scroll, no console error${width < 500 ? ', phone rules' : ''}`, async () => {
    const { context, page, errors } = await openPage(env, { width, touch: width < 500, clock: CLOCK, path: '#/pharmacy' });
    for (const role of ROLES) {
      for (const screen of SCREENS) {
        await asRole(page, role, screen);
        if (screen === 'discharge' && ['ward-nurse', 'pharmacy-technician'].includes(role)) {
          await page.locator('[data-test="wards"]').selectOption('ward-a2');
          await page.waitForSelector('[data-test="ask-form"]');
        }
        assert.ok(await noSideways(page) <= 0, `${role} on ${screen} scrolls sideways`);
        if (width < 500) assert.deepEqual(await phoneProblems(page), [], `${role} on ${screen}: phone rules`);
      }
    }
    if (width === 390) {
      await asRole(page, 'pharmacy-technician', 'queue');
      console.log(`# smallest at 390 px, technician queue: ${JSON.stringify(await smallest(page))}`);
    }
    assert.deepEqual(errors, []);
    await context.close();
  });
}

test('a role with no rights sees no action button and one line saying who can; the ward nurse sees Collected but no pharmacy step', async () => {
  const { context, page, errors } = await openPage(env, { width: 390, touch: true, clock: CLOCK, path: '#/pharmacy' });
  for (const screen of SCREENS) {
    await asRole(page, 'coo', screen);
    assert.equal(await page.locator('.mod-pharmacy [data-cmd]').count(), 0, `coo on ${screen} sees no action button`);
  }
  await asRole(page, 'coo', 'queue');
  assert.match(await page.locator('[data-test="read-only"]').textContent(), /COO can see the queue\. Steps are recorded by Pharmacy technician, Pharmacist, Pharmacy manager; Checked by Pharmacist\./);
  await asRole(page, 'coo', 'discharge');
  assert.match(await page.locator('[data-test="read-only"]').textContent(), /Asking for medicines is for Ward nurse, Patient flow coordinator, Pharmacy technician/);
  await asRole(page, 'coo', 'summary');
  assert.equal(await page.locator('[data-test="guide-switch"]').count(), 0);
  await asRole(page, 'ward-nurse', 'queue');
  assert.equal(await page.locator('.mod-pharmacy [data-cmd="ospeli_pharmacy_request_step"], .mod-pharmacy [data-cmd="ospeli_pharmacy_request_check"]').count(), 0);
  assert.ok(await page.locator('.mod-pharmacy [data-cmd="ospeli_pharmacy_request_collect"]').count() >= 1, 'the ward may record a collection');
  // The technician never sees a Checked button: the row says it waits for the pharmacist.
  await asRole(page, 'pharmacy-technician', 'queue');
  assert.equal(await page.locator('[data-cmd="ospeli_pharmacy_request_check"]').count(), 0);
  assert.ok(await page.locator('[data-test="waits-check"]').count() >= 1);
  assert.deepEqual(errors, []);
  await context.close();
});

// ---- the first five minutes on a phone (ospeli/ospeli#112) ----
test('front line: the pharmacy technician on a 390 px touch phone opens on the queue, starts the oldest discharge request, a double tap skips nothing, then makes a checked one Ready; the turnaround and the ward view change', async () => {
  const { context, page, errors } = await openPage(env, { width: 390, height: 844, touch: true, clock: CLOCK, path: '' });
  const t0 = Date.now();
  await page.selectOption('#role-select', 'pharmacy-technician');
  await page.waitForFunction(async () => (await window.ospeli.core.getMeta('role')) === 'pharmacy-technician');
  await page.goto(env.appUrl);
  await page.waitForSelector('html[data-ready="true"]');
  await page.waitForFunction(() => document.querySelector('.mod-pharmacy')?.dataset.screen === 'queue');
  assert.match(await page.evaluate(() => location.hash), /^#\/pharmacy/, 'the technician opens on the module');
  assert.deepEqual(await phoneProblems(page), []);
  // The first Start is on the first screen.
  const first = await page.locator('[data-test="queue"] [data-step="start"]').first().boundingBox();
  assert.ok(first.y + first.height <= 844, `the first Start is on the first screen (bottom at ${Math.round(first.y + first.height)} px)`);
  const turn0 = await kpi(page, 'discharge-turnaround');

  // The oldest discharge request waiting to start: the first discharge row with Start (urgent ones come first).
  const row = page.locator('[data-test="queue"] li[data-kind="discharge"][data-state="raised"]').first();
  const id = await row.getAttribute('data-request');
  const start = row.locator('[data-step="start"]');
  await start.scrollIntoViewIfNeeded();
  const b = await start.boundingBox();
  // A double tap on the same spot: the second lands on a waiting button and records nothing.
  await page.touchscreen.tap(b.x + b.width / 2, b.y + b.height / 2);
  await page.touchscreen.tap(b.x + b.width / 2, b.y + b.height / 2);
  const mine = page.locator(`[data-request="${id}"]`).first();
  await page.waitForFunction((x) => document.querySelector(`[data-request="${x}"]`)?.dataset.state === 'started', id);
  await page.waitForTimeout(400);
  const after = await cmd(page, 'ospeli_pharmacy_queue_list', { limit: 300 }, 'coo');
  assert.equal(after.requests.find((r) => r.id === id).state, 'started', 'the double tap did not skip a stage');
  // No order of taps gives Ready before Checked: the row waits for the pharmacist.
  assert.equal(await mine.locator('[data-step="ready"]').count(), 0);
  assert.match(await mine.locator('[data-test="waits-check"]').textContent(), /Waiting for the pharmacist's check/);

  // The pharmacist's checked request (Ward B1): Ready, in its own place and look.
  const checked = page.locator('[data-test="queue"] li[data-state="checked"]').first();
  const cid = await checked.getAttribute('data-request');
  const ward = (await cmd(page, 'ospeli_pharmacy_queue_list', { limit: 300 }, 'coo')).requests.find((r) => r.id === cid).wardId;
  assert.match(await checked.locator('[data-step="ready"]').getAttribute('class'), /ph-main/);
  assert.equal(await checked.locator('.ph-ready-at').count(), 1, 'Ready sits in its own place');
  await checked.locator('[data-step="ready"]').scrollIntoViewIfNeeded();
  await checked.locator('[data-step="ready"]').tap();
  await page.waitForFunction((x) => document.querySelector(`[data-request="${x}"]`)?.dataset.state === 'ready', cid);
  const turn1 = await kpi(page, 'discharge-turnaround');
  assert.equal(turn1.n + turn1.outsideWorkDay.n, turn0.n + turn0.outsideWorkDay.n + 1, 'the discharge turnaround counts it');
  // The ward's view shows it ready for collection.
  const wv = await cmd(page, 'ospeli_pharmacy_ward_requests', { wardId: ward }, 'ward-nurse');
  assert.equal(wv.requests.find((r) => r.id === cid).state, 'ready');
  await asRole(page, 'ward-nurse', 'discharge');
  await page.locator('[data-test="wards"]').selectOption(ward);
  await page.waitForSelector(`[data-test="ward-requests"] [data-request="${cid}"] [data-test="ready-now"]`);
  assert.ok(Date.now() - t0 < 5 * 60e3, 'under five minutes');
  assert.deepEqual(errors, []);
  await context.close();
});

test('manager: the pharmacy manager on a 390 px touch phone opens on Turnaround, sees which stage takes the most time and which ward asks late, and moves a request to the front', async () => {
  const { context, page, errors } = await openPage(env, { width: 390, height: 844, touch: true, clock: CLOCK, path: '' });
  const t0 = Date.now();
  await page.selectOption('#role-select', 'pharmacy-manager');
  await page.waitForFunction(async () => (await window.ospeli.core.getMeta('role')) === 'pharmacy-manager');
  await page.goto(env.appUrl);
  await page.waitForSelector('html[data-ready="true"]');
  await page.waitForFunction(() => document.querySelector('.mod-pharmacy')?.dataset.screen === 'summary');
  assert.deepEqual(await phoneProblems(page), []);
  const ov = await overview(page);
  const stages = ov.kpis.find((k) => k.id === 'stage-times');
  const longest = stages.stages.find((s) => s.id === stages.longest);
  const most = page.locator('[data-test="longest"]');
  assert.match(await most.textContent(), new RegExp(`^Most time: ${longest.name.toLowerCase()}`));
  const box = await most.boundingBox();
  assert.ok(box.y + box.height <= 844, 'where the time goes is on the first screen');
  assert.match(await page.locator('[data-test="suggestion"][data-rule="late-requests"]').first().textContent(), /Ward A3 \(older adults\): \d+ of \d+ same-day discharge requests/);
  // Move the oldest request that is not at the front.
  const target = page.locator('[data-test="oldest"] li').filter({ has: page.locator('[data-test="front"]') }).first();
  const id = await target.getAttribute('data-request');
  await target.locator('[data-test="front"]').scrollIntoViewIfNeeded();
  await target.locator('[data-test="front"]').tap();
  await page.waitForSelector(`[data-test="oldest"] [data-request="${id}"] [data-test="back"]`);
  const q = await cmd(page, 'ospeli_pharmacy_queue_list', {}, 'pharmacy-technician');
  assert.deepEqual([q.requests[0].id, q.requests[0].front], [id, true], 'first in the queue');
  // On the queue it carries its mark, so nobody thinks the order is broken.
  await tap(page, '.ph-tabs a[data-screen="queue"]');
  await page.waitForFunction(() => document.querySelector('.mod-pharmacy')?.dataset.screen === 'queue');
  assert.match(await page.locator('[data-test="queue"] li').first().textContent(), /Moved to the front by the manager/);
  assert.ok(Date.now() - t0 < 5 * 60e3, 'under five minutes');
  assert.deepEqual(errors, []);
  await context.close();
});

test('the ward nurse asks for discharge medicines in a few taps, nothing is chosen in advance, and later records the collection', async () => {
  const { context, page, errors } = await openPage(env, { width: 390, height: 844, touch: true, clock: CLOCK, path: '#/pharmacy' });
  await asRole(page, 'ward-nurse', 'discharge');
  await page.locator('[data-test="wards"]').selectOption('ward-b2');
  await page.waitForSelector('[data-test="ask-form"]');
  const send = page.locator('[data-test="send"]');
  assert.equal(await send.textContent(), 'Pick the bed first');
  assert.equal(await page.locator('[data-test="ask-form"] [aria-pressed="true"]').count(), 0, 'no pick made in advance');
  await tap(page, '[data-test="beds"] button:not([disabled])');
  assert.equal(await send.textContent(), 'Pick when they go home');
  await tap(page, '[data-test="planned-picks"] [data-planned="this-afternoon"]');
  assert.equal(await send.isDisabled(), true);
  await page.locator('[data-test="items"]').selectOption('4');
  assert.equal(await send.textContent(), 'Ask the pharmacy');
  const before = (await cmd(page, 'ospeli_pharmacy_queue_list', {}, 'coo')).counts.raised;
  await send.tap();
  await page.waitForFunction(() => document.querySelector('[data-test="send"]')?.textContent === 'Pick the bed first');
  assert.equal((await cmd(page, 'ospeli_pharmacy_queue_list', {}, 'coo')).counts.raised, before + 1);
  const mine = (await cmd(page, 'ospeli_pharmacy_ward_requests', { wardId: 'ward-b2' }, 'ward-nurse')).requests.find((r) => r.state === 'raised' && r.items === 4);
  assert.ok(mine, 'the request is on the ward list');
  // The pharmacy moves it on; the ward sees "ready for collection" and records the collection.
  await cmd(page, 'ospeli_pharmacy_request_step', { requestId: mine.id, step: 'start' }, 'pharmacy-technician');
  await cmd(page, 'ospeli_pharmacy_request_check', { requestId: mine.id }, 'pharmacist');
  await cmd(page, 'ospeli_pharmacy_request_step', { requestId: mine.id, step: 'ready' }, 'pharmacy-technician');
  const ready = page.locator(`[data-test="ward-requests"] [data-request="${mine.id}"]`);
  await ready.locator('[data-test="ready-now"]').waitFor();
  await ready.locator('[data-test="collect"]').tap();
  // The row stays where it was, greyed, with its undo, for this visit.
  await page.waitForFunction((x) => document.querySelector(`[data-test="ward-requests"] [data-request="${x}"]`)?.dataset.state === 'collected', mine.id);
  assert.equal(await ready.locator('[data-test="undo-closed"]').count(), 1);
  assert.equal((await cmd(page, 'ospeli_pharmacy_ward_requests', { wardId: 'ward-b2' }, 'ward-nurse')).requests.find((r) => r.id === mine.id).state, 'collected');
  assert.deepEqual(errors, []);
  await context.close();
});

test('the guide switch: the manager turns it off and on; the measures stay the same', async () => {
  const { context, page, errors } = await openPage(env, { width: 1280, clock: CLOCK, path: '#/pharmacy' });
  await asRole(page, 'pharmacy-manager', 'summary');
  const values = () => page.locator('[data-kpi]').evaluateAll((xs) => xs.map((x) => `${x.dataset.kpi}:${x.dataset.value}:${x.dataset.n}`));
  const v0 = await values();
  assert.ok(await page.locator('[data-test="suggestion"]').count() > 0);
  await page.click('[data-test="guide-switch"]');
  await page.waitForSelector('[data-test="guide-off"]');
  assert.equal(await page.locator('[data-test="suggestion"]').count(), 0);
  assert.deepEqual(await values(), v0, 'the measures are the same with the guide off');
  await page.click('[data-test="guide-switch"]');
  await page.waitForSelector('[data-test="suggestion"]');
  await asRole(page, 'pharmacist', 'summary');
  assert.equal(await page.locator('[data-test="guide-switch"]').count(), 0, 'the pharmacist cannot switch it');
  assert.deepEqual(errors, []);
  await context.close();
});

// ospeli/ospeli#112 review round 1 (adoption lead): a slow second tap on the same spot must not collect another request.
async function collectTwice(page, listSel, label) {
  const first = page.locator(`${listSel} [data-cmd="ospeli_pharmacy_request_collect"]:not([disabled])`).first();
  await first.scrollIntoViewIfNeeded();
  const id = await first.evaluate((b) => b.closest('li').dataset.request);
  const box = await first.boundingBox();
  const before = (await cmd(page, 'ospeli_pharmacy_queue_list', { limit: 300 }, 'coo')).counts.ready;
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForFunction((x) => document.querySelector(`[data-request="${x}"]`)?.dataset.state === 'collected', id);
  await page.waitForTimeout(1600);
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(1500);
  const after = (await cmd(page, 'ospeli_pharmacy_queue_list', { limit: 300 }, 'coo')).counts.ready;
  assert.equal(after, before - 1, `${label}: only one request collected`);
  return id;
}
test('a second tap on the same spot 1.6 s after Collected records nothing more: on Discharge medicines and in the queue\'s Ready list', async () => {
  const { context, page, errors } = await openPage(env, { width: 390, height: 844, touch: true, clock: CLOCK, path: '#/pharmacy' });
  // Make sure at least three requests are ready.
  for (const [w, n] of [['ward-a1', 3], ['ward-a2', 4], ['ward-b1', 5]]) {
    const { requestId } = await cmd(page, 'ospeli_pharmacy_request_raise', { wardId: w, kind: 'other', priority: 'routine', items: n }, 'ward-nurse');
    await cmd(page, 'ospeli_pharmacy_request_step', { requestId, step: 'start' }, 'pharmacy-technician');
    await cmd(page, 'ospeli_pharmacy_request_check', { requestId }, 'pharmacist');
    await cmd(page, 'ospeli_pharmacy_request_step', { requestId, step: 'ready' }, 'pharmacy-technician');
  }
  await asRole(page, 'ward-nurse', 'discharge');
  // Wait for the list as drawn for "all wards", not the one on screen when the ward was picked: the rows
  // there are marked first, and the check waits until none of them is left (the list is read again faster
  // since ospeli/ospeli#153, and the next step used to start on the list that was about to be replaced).
  await page.evaluate(() => { for (const el of document.querySelectorAll('[data-test="ward-requests"] li')) el.dataset.stale = 'true'; });
  await page.locator('[data-test="wards"]').selectOption('');
  await page.waitForFunction(() => !document.querySelector('[data-test="ward-requests"] li[data-stale]') && document.querySelectorAll('[data-test="ward-requests"] [data-test="collect"]').length >= 2);
  const id1 = await collectTwice(page, '[data-test="ward-requests"]', 'Discharge medicines');
  // The collected row can be taken back within 10 minutes.
  await tap(page, `[data-request="${id1}"] [data-test="undo-closed"] summary`);
  await tap(page, `[data-request="${id1}"] [data-test="undo"]`);
  await page.waitForFunction((x) => document.querySelector(`[data-request="${x}"]`)?.dataset.state === 'ready', id1);
  await asRole(page, 'pharmacy-technician', 'queue');
  await collectTwice(page, '[data-test="ready"]', 'Dispensing queue');
  assert.deepEqual(errors, []);
  await context.close();
});

test('the pharmacist sees the requests waiting for their check first, with Checked on the first screen at 390 px', async () => {
  const { context, page, errors } = await openPage(env, { width: 390, height: 844, touch: true, clock: CLOCK, path: '#/pharmacy' });
  await asRole(page, 'pharmacist', 'queue');
  const b = await page.locator('[data-test="check-list"] [data-step="check"]').first().boundingBox();
  assert.ok(b.y + b.height <= 844, `Checked is on the first screen (bottom at ${Math.round(b.y + b.height)} px)`);
  assert.deepEqual(await phoneProblems(page), []);
  assert.deepEqual(errors, []);
  await context.close();
});

test('cancel reasons look unlike hold reasons, and a technician\'s Ready never leaves a Collected button where Ready was', async () => {
  const { context, page, errors } = await openPage(env, { width: 390, height: 844, touch: true, clock: CLOCK, path: '#/pharmacy' });
  await asRole(page, 'pharmacy-technician', 'queue');
  const row = page.locator('[data-test="queue"] li[data-state="raised"]').first();
  await row.locator('[data-test="more"] summary').tap();
  const holdCls = await row.locator('[data-test="hold-reasons"] button').first().getAttribute('class');
  const cancelCls = await row.locator('[data-test="cancel-reasons"] button').first().getAttribute('class');
  assert.ok(!/ph-cancel-reason/.test(holdCls) && /ph-cancel-reason/.test(cancelCls));
  const checked = page.locator('[data-test="queue"] li[data-state="checked"]').first();
  const id = await checked.getAttribute('data-request');
  await checked.locator('[data-step="ready"]').scrollIntoViewIfNeeded();
  await checked.locator('[data-step="ready"]').tap();
  await page.waitForFunction((x) => document.querySelector(`[data-test="queue"] [data-request="${x}"]`)?.dataset.state === 'ready', id);
  await page.waitForTimeout(3500);
  const kept = page.locator(`[data-test="queue"] [data-request="${id}"]`);
  assert.equal(await kept.locator('[data-cmd="ospeli_pharmacy_request_collect"]').count(), 0, 'no Collected in the place Ready was');
  assert.match(await kept.locator('[data-test="ready-here"]').textContent(), /Ready: waiting for collection/);
  assert.deepEqual(errors, []);
  await context.close();
});

// Review round 2 (adoption lead): Start, then a hold or a cancel from More; a second tap on the same
// spot 1.6 s later must record nothing on any request (the row keeps its tallest height).
const pharmacyEvents = (page) => page.evaluate(async () => (await window.ospeli.core.events()).filter((e) => e.type.startsWith('pharmacy.')).map((e) => `${e.subject} ${e.type}`));
for (const [what, list, reason] of [['hold', 'hold-reasons', 'waiting-for-supply'], ['cancel', 'cancel-reasons', 'raised-in-error']]) {
  test(`Start, then ${what} from More, then a second tap on the same spot 1.6 s later records nothing more`, async () => {
    const { context, page, errors } = await openPage(env, { width: 390, height: 844, touch: true, clock: CLOCK, path: '#/pharmacy' });
    await asRole(page, 'pharmacy-technician', 'queue');
    const row = page.locator('[data-test="queue"] li[data-state="raised"]').first();
    const id = await row.getAttribute('data-request');
    const mine = page.locator(`[data-test="queue"] [data-request="${id}"]`);
    await mine.locator('[data-step="start"]').tap();
    await page.waitForFunction((x) => document.querySelector(`[data-test="queue"] [data-request="${x}"]`)?.dataset.state === 'started', id);
    await page.waitForTimeout(3200); // past the button's wait
    await mine.locator('[data-test="more"] summary').tap();
    const btn = mine.locator(`[data-test="${list}"] [data-reason="${reason}"]`);
    await btn.scrollIntoViewIfNeeded();
    const b = await btn.boundingBox();
    const before = await pharmacyEvents(page);
    await page.touchscreen.tap(b.x + b.width / 2, b.y + b.height / 2);
    await page.waitForFunction(([x, s]) => document.querySelector(`[data-test="queue"] [data-request="${x}"]`)?.dataset.state === s, [id, what === 'hold' ? 'on-hold' : 'cancelled']);
    await page.waitForTimeout(1600);
    // Whatever is under the finger now still belongs to this request's row: nothing slid up into its place.
    const under = await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.closest('li')?.dataset.request || null, [b.x + b.width / 2, b.y + b.height / 2]);
    assert.equal(under, id, 'the same row is still under the finger');
    await page.touchscreen.tap(b.x + b.width / 2, b.y + b.height / 2);
    await page.waitForTimeout(1500);
    const added = (await pharmacyEvents(page)).slice(before.length);
    assert.deepEqual(added, [`${id} pharmacy.request-${what === 'hold' ? 'on-hold' : 'cancelled'}`], 'one event, on this request only');
    assert.deepEqual(errors, []);
    await context.close();
  });
}
