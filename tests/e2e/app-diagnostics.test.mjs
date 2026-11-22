// Diagnostics in the app (module diagnostics, A5 slice 1): every role with no sideways scroll and no
// console error at 360, 390, 1024 and 1280 px; phone rules (targets 44 px or more, text 15 px or
// more) for the laboratory reception officer and the unit clerk with their panels open; the unit
// clerk records a request and marks it collected, and the ward stays picked; Received keeps the row
// in place with Undo; the guide switch; roles with no rights see no action button. And the two
// first-five-minutes tests (ospeli/ospeli#112) on a 390 px touch phone: the laboratory reception
// officer and the diagnostics manager. Fictional data only.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, openPage } from './helpers.mjs';

let env;
before(async () => { env = await startApp(); });
after(async () => { await env.close(); });

const CLOCK = '2026-11-19T14:00:00Z'; // 10:00 on the example site's clock, after the morning rounds began
const noSideways = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
async function asRole(page, role) {
  await page.selectOption('#role-select', role);
  await page.waitForFunction(async (r) => (await window.ospeli.core.getMeta('role')) === r, role);
  await page.evaluate(() => {
    const x = document.querySelector('.dx');
    if (location.hash === '#/diagnostics') return;
    if (x) x.dataset.stale = 'true';
    location.hash = '#/diagnostics';
  });
  await page.waitForFunction((r) => { const x = document.querySelector('.dx'); return x && !x.dataset.stale && x.dataset.role === r && x.querySelector('.page-head'); }, role, { timeout: 20000 });
}
const cmd = (page, name, input, role) => page.evaluate(async ([n, i, r]) => {
  const { runCommand } = await import('/app/core/commands.js');
  return runCommand(window.ospeli.core, n, i, { type: 'human', role: r });
}, [name, input, role]);
const overview = (page) => cmd(page, 'ospeli_diagnostics_overview', {}, 'diagnostics-manager');
const phoneProblems = (page) => page.evaluate(() => {
  const out = [];
  for (const el of document.querySelectorAll('.dx button, .dx a, .dx select, .dx summary')) {
    const r = el.getBoundingClientRect();
    if (r.height && r.height < 44) out.push(`${el.tagName} "${el.textContent.trim().slice(0, 30)}" is ${Math.round(r.height)} px tall`);
  }
  for (const el of document.querySelectorAll('.dx *')) {
    const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    const size = parseFloat(getComputedStyle(el).fontSize);
    if (own && el.getClientRects().length && !el.closest('.sr-only') && size < 15) out.push(`"${el.textContent.trim().slice(0, 30)}" is ${size} px`);
  }
  return out;
});
const smallest = (page) => page.evaluate(() => {
  let h = Infinity; let f = Infinity;
  for (const el of document.querySelectorAll('.dx button, .dx a, .dx select, .dx summary')) { const r = el.getBoundingClientRect(); if (r.height) h = Math.min(h, r.height); }
  for (const el of document.querySelectorAll('.dx *')) { if ([...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()) && el.getClientRects().length) f = Math.min(f, parseFloat(getComputedStyle(el).fontSize)); }
  return { height: Math.round(h), font: f };
});
const tap = async (page, sel) => { const l = page.locator(sel).first(); await l.scrollIntoViewIfNeeded(); await l.tap(); };
const waitSaved = (page, re) => page.waitForFunction((src) => new RegExp(src).test(document.querySelector('[data-test="saved"]')?.textContent || ''), re.source);
const openHome = async (page, role) => {
  await page.selectOption('#role-select', role);
  await page.waitForFunction(async (r) => (await window.ospeli.core.getMeta('role')) === r, role);
  await page.goto(env.appUrl);
  await page.waitForSelector('html[data-ready="true"]');
  await page.waitForFunction((r) => document.querySelector('.dx')?.dataset.role === r, role, { timeout: 20000 });
};

const ROLES = ['lab-reception', 'lab-scientist', 'unit-clerk', 'ward-nurse', 'radiographer', 'diagnostics-manager', 'ops-manager', 'coo'];
for (const width of [360, 390, 1024, 1280]) {
  test(`every role renders at ${width} px with no sideways scroll and no console error`, async () => {
    const { context, page, errors } = await openPage(env, { width, touch: width < 500, clock: CLOCK, path: '#/diagnostics' });
    for (const role of ROLES) {
      await asRole(page, role);
      if (role === 'unit-clerk') {
        await page.selectOption('[data-test="ward"]', 'ward-a2');
        await page.waitForSelector('[data-test="new-request"]');
        await page.locator('[data-test="new-request"]').click();
        await page.waitForSelector('[data-test="request-form"]');
      }
      if (role === 'lab-reception') {
        await page.locator('[data-test="hatch-row"] [data-test="reject"]').first().click();
        await page.waitForSelector('[data-test="reject-panel"]');
      }
      if (role === 'diagnostics-manager') {
        await page.locator('[data-test="equipment"][data-asset="asset-analyser-1"] [data-test="mark-down"]').click();
        await page.waitForSelector('[data-test="eq-form"]');
      }
      assert.ok(await noSideways(page) <= 0, `${role} scrolls sideways at ${width} px`);
      if (width < 500 && ['lab-reception', 'unit-clerk', 'diagnostics-manager'].includes(role)) assert.deepEqual(await phoneProblems(page), [], `${role}: phone rules with a panel open`);
    }
    assert.deepEqual(errors, []);
    await context.close();
  });
}

test('what each role may do: a role with no rights sees no action button and one line saying who can; the ward nurse cannot receive', async () => {
  const { context, page, errors } = await openPage(env, { width: 390, touch: true, clock: CLOCK, path: '#/diagnostics' });
  for (const role of ['coo', 'ops-manager']) {
    await asRole(page, role);
    assert.equal(await page.locator('.dx [data-cmd]').count(), 0, `${role} sees no action button`);
    assert.equal(await page.locator('.dx [data-test="mark-down"], .dx [data-test="receive"], .dx [data-test="guide-switch"]').count(), 0);
    assert.match(await page.locator('[data-test="read-only"]').textContent(), /Requests are recorded by Unit clerk/);
  }
  await asRole(page, 'ward-nurse');
  assert.equal(await page.locator('[data-test="receive"]').count(), 0);
  assert.match(await page.locator('[data-test="eq-read-only"]').textContent(), /Analysers are marked down and back by Laboratory scientist/);
  await asRole(page, 'radiographer');
  assert.equal(await page.locator('[data-test="equipment"][data-asset="asset-analyser-1"] [data-test="mark-down"]').count(), 0, 'a radiographer marks scanners only');
  assert.equal(await page.locator('[data-test="equipment"][data-asset="asset-xray-1"] [data-test="mark-down"]').count(), 1);
  assert.match(await page.locator('[data-test="imaging-planned"]').textContent(), /planned, not built yet/);
  assert.match(await page.locator('[data-test="fault-note"]').textContent(), /To report a fault, ask a facilities technician or the operations manager/);
  assert.deepEqual(errors, []);
  await context.close();
});

test('the unit clerk on a 390 px phone picks the ward once, records a request for a patient by picks and marks it collected 10 minutes ago', async () => {
  const { context, page, errors } = await openPage(env, { width: 390, height: 844, touch: true, clock: CLOCK, path: '' });
  await openHome(page, 'unit-clerk');
  assert.equal(await page.evaluate(() => location.hash), '#/diagnostics');
  await page.selectOption('[data-test="ward"]', 'ward-a2');
  await page.waitForSelector('[data-test="new-request"]');
  await tap(page, '[data-test="new-request"]');
  const save = page.locator('[data-test="request-save"]');
  assert.equal(await save.textContent(), 'Pick the test group first');
  assert.equal(await save.isDisabled(), true);
  await tap(page, '[data-test="test-group"] [data-value="chemistry"]');
  await tap(page, '[data-test="urgency"] [data-value="urgent"]');
  assert.equal(await save.textContent(), 'Pick the patient (or No patient code) first', 'nobody is chosen in advance');
  const patient = page.locator('[data-test="patient"] [data-value^="enc-"]').first();
  const label = (await patient.textContent()).match(/Patient \d+/)[0];
  await patient.tap();
  assert.deepEqual(await phoneProblems(page), []);
  await save.tap();
  await waitSaved(page, new RegExp(`Saved: ${label}, Blood chemistry`));
  const row = page.locator('[data-test="request-row"][data-state="requested"]', { hasText: label }).first();
  await row.locator('[data-test="collect"]').tap();
  assert.equal(await page.locator('[data-test="collect-save"]').isDisabled(), true, 'when it was taken is picked, not assumed');
  await tap(page, '[data-test="collect-ago"] [data-value="10"]');
  await tap(page, '[data-test="collect-save"]');
  const pinned = page.locator('[data-test="pinned-row"][data-state="collected"]', { hasText: label });
  await pinned.waitFor();
  assert.match(await pinned.textContent(), /Collected 09:5\d/, 'taken 10 minutes before 10:00 on the site clock');
  // The ward stays picked on this device.
  await page.reload();
  await page.waitForSelector('[data-test="requests"]', { timeout: 20000 });
  assert.equal(await page.locator('[data-test="ward"]').inputValue(), 'ward-a2');
  assert.deepEqual(errors, []);
  await context.close();
});

test('front line: the laboratory reception officer on a 390 px touch phone, with no help, receives the oldest specimen and rejects another with a reason; Received keeps the row in place with Undo; the measures change', async () => {
  const { context, page, errors } = await openPage(env, { width: 390, height: 844, touch: true, clock: CLOCK, path: '' });
  const t0 = Date.now();
  await openHome(page, 'lab-reception');
  assert.equal(await page.evaluate(() => location.hash), '#/diagnostics', 'opens straight on the hatch list');
  // First screen: what is on its way, the first Received button and the no-collection count.
  const first = page.locator('[data-test="hatch-row"]').first();
  const btn = await first.locator('[data-test="receive"]').boundingBox();
  assert.ok(btn.y + btn.height <= 844, `the first Received button is on the first screen (bottom at ${Math.round(btn.y + btn.height)} px)`);
  assert.ok(btn.height >= 56, 'Received is 56 px or more');
  const rejectBox = await first.locator('[data-test="reject"]').boundingBox();
  assert.ok(rejectBox.x > btn.x + btn.width, 'Reject is on the other side, not in the same place');
  assert.match(await page.locator('[data-test="no-collection-count"]').textContent(), /Received with no collection time: \d+ today/);
  const count = await page.locator('[data-test="no-collection-count"]').boundingBox();
  assert.ok(count.y + count.height <= 844, `the no-collection count is on the first screen (bottom at ${Math.round(count.y + count.height)} px)`);
  assert.match(await page.locator('[data-test="not-arrived"]').textContent(), /Not arrived/);
  assert.deepEqual(await phoneProblems(page), []);
  const k0 = (await overview(page)).kpis[1];

  // The oldest specimen (not arrived, at the top): one tap.
  const oldest = await first.getAttribute('data-request');
  await first.locator('[data-test="receive"]').tap();
  const done = page.locator(`[data-test="done-row"][data-request="${oldest}"]`);
  await done.waitFor();
  assert.match(await done.textContent(), /Received at lab/);
  const doneBox = await done.boundingBox();
  assert.ok(Math.abs(doneBox.y - (await page.locator('[data-test="not-arrived"] ul').boundingBox()).y) < 2, 'the row keeps its place');
  assert.equal(await done.locator('[data-test="receive"]').count(), 0, 'no Received button under the finger: a second tap there does nothing');
  // Undo is offered, then the row goes after about ten seconds.
  assert.equal(await done.locator('[data-test="undo"]').count(), 1);
  await page.clock.fastForward(11e3);
  await page.waitForFunction((id) => !document.querySelector(`[data-test="done-row"][data-request="${id}"]`), oldest);

  // Reject another: Reject, a reason, save (it never acts on one tap).
  const other = page.locator('[data-test="hatch-row"]').first();
  const otherId = await other.getAttribute('data-request');
  await other.locator('[data-test="reject"]').tap();
  assert.match(await page.locator('[data-test="reject-panel"]').textContent(), /by your lab's acceptance criteria/);
  assert.equal(await page.locator('[data-test="reject-save"]').isDisabled(), true);
  assert.equal((await overview(page)).kpis[1].numerator, k0.numerator, 'one tap on Reject rejects nothing');
  await tap(page, '[data-test="reject-reason"] [data-value="clotted"]');
  assert.deepEqual(await phoneProblems(page), []);
  await tap(page, '[data-test="reject-save"]');
  await page.waitForSelector(`[data-test="done-row"][data-request="${otherId}"]`);
  assert.match(await page.locator(`[data-test="done-row"][data-request="${otherId}"]`).textContent(), /Rejected: Clotted/);

  const k1 = (await overview(page)).kpis[1];
  assert.deepEqual([k1.numerator, k1.denominator], [k0.numerator + 1, k0.denominator + 2], 'rejection rate: one more rejected, two more reached the lab');
  const log = await cmd(page, 'ospeli_diagnostics_specimen_log', {}, 'lab-scientist');
  assert.ok(log.waitingResult.some((r) => r.id === oldest), 'the received specimen now waits for its result: a turnaround input');
  console.log(`front line smallest: ${JSON.stringify(await smallest(page))}; taps: Received 1, Reject 3`);
  assert.ok(Date.now() - t0 < 5 * 60e3, 'under five minutes');
  assert.deepEqual(errors, []);
  await context.close();
});

test('undo: a Received tapped by mistake goes back on the list', async () => {
  const { context, page, errors } = await openPage(env, { width: 390, height: 844, touch: true, clock: CLOCK, path: '#/diagnostics' });
  await asRole(page, 'lab-reception');
  const first = page.locator('[data-test="block"] [data-test="hatch-row"]').first();
  const id = await first.getAttribute('data-request');
  await first.locator('[data-test="receive"]').tap();
  await page.locator(`[data-test="done-row"][data-request="${id}"] [data-test="undo"]`).tap();
  await waitSaved(page, /Undone: .* is back in the list/);
  await page.waitForSelector(`[data-test="hatch-row"][data-request="${id}"] [data-test="receive"]`);
  assert.deepEqual(errors, []);
  await context.close();
});

test('manager: the diagnostics manager on a 390 px touch phone sees turnaround, rejections by area and equipment status, marks the analyser down with its work order and backup route, and the affected ward sees it', async () => {
  const { context, page, errors } = await openPage(env, { width: 390, height: 844, touch: true, clock: CLOCK, path: '' });
  // Before the manager looks: the analyser's fault is reported by the operations manager, and Ward A1 has an open chemistry request.
  await page.waitForFunction(() => window.ospeli?.core);
  const wo = await cmd(page, 'ospeli_workorders_report_fault', { assetId: 'asset-analyser-1', fault: 'Analyser calibration error', priority: 'high' }, 'ops-manager');
  await cmd(page, 'ospeli_diagnostics_request_record', { sourceId: 'ward-a1', testGroup: 'chemistry', urgency: 'routine', again: true }, 'unit-clerk');
  const t0 = Date.now();
  await openHome(page, 'diagnostics-manager');
  assert.equal(await page.evaluate(() => location.hash), '#/diagnostics', 'the manager opens on the module');
  const sum = await page.locator('[data-test="summary"]').boundingBox();
  assert.ok(sum.y + sum.height <= 844, 'turnaround and rejections on the first screen');
  assert.equal(await page.locator('[data-test="summary"] [data-kpi="lab-turnaround"]').count(), 0, 'no blended turnaround tile');
  assert.match(await page.locator('[data-test="tat-by-group"] [data-group="blood-count"] [data-urgency="urgent"]').textContent(), /^Urgent: .+; 9 in 10 within .+ \(\d+ results?\)$/, 'turnaround by test group, urgent and routine apart');
  assert.match(await page.locator('[data-test="tat-by-group"] [data-group="culture"]').textContent(), /first report, not final/);
  assert.match(await page.locator('[data-test="tat-blended"]').textContent(), /except blood culture.*not comparable between weeks/);
  assert.ok(await page.locator('[data-test="rej-by-area"] li').count() >= 3, 'rejections by area');
  assert.match(await page.locator('[data-test="equipment"][data-asset="asset-analyser-1"]').textContent(), /Working/);

  // Mark down: Mark down, Down, reason, backup, work order, save.
  await tap(page, '[data-test="equipment"][data-asset="asset-analyser-1"] [data-test="mark-down"]');
  const save = page.locator('[data-test="eq-save"]');
  assert.equal(await save.isDisabled(), true);
  await tap(page, '[data-test="eq-state"] [data-value="down"]');
  await tap(page, '[data-test="eq-reason"] [data-value="qc-failed"]');
  await tap(page, '[data-test="eq-backup"] [data-value="partner-lab"]');
  assert.equal(await save.textContent(), 'Pick the work order (or None) first');
  await tap(page, `[data-test="eq-wo"] [data-value="${wo.workOrderId}"]`);
  await tap(page, '[data-test="eq-expected"] [data-value="2"]');
  assert.deepEqual(await phoneProblems(page), []);
  await tap(page, '[data-test="eq-save"]');
  await waitSaved(page, /Saved: Chemistry analyser 1 marked down/);
  const card = page.locator('[data-test="equipment"][data-asset="asset-analyser-1"]');
  await page.waitForSelector('[data-test="equipment"][data-asset="asset-analyser-1"][data-state="down"]');
  assert.match(await card.locator('[data-test="linked-wo"]').textContent(), new RegExp(`Work order ${wo.workOrderId.toUpperCase()}: Analyser calibration error`));
  assert.match(await card.locator('[data-test="backup"]').textContent(), /Send to: the partner laboratory/);
  assert.match(await card.locator('[data-test="expected"]').textContent(), /^Estimate: back by \d\d:\d\d \(set at \d\d:\d\d\)$/);
  assert.equal(await page.locator('[data-test="down-count"] b').textContent(), '1');
  const notice = page.locator('[data-test="suggestion"][data-rule="equipment-down"][data-source="ward-a1"]');
  assert.match(await notice.textContent(), /Chemistry analyser 1 is down: \d+ open requests? from Ward A1/);
  console.log(`manager smallest: ${JSON.stringify(await smallest(page))}; taps to mark down: 7 (6 without the estimate)`);
  // The ward sees it, where it works.
  await asRole(page, 'unit-clerk');
  await page.selectOption('[data-test="ward"]', 'ward-a1');
  await page.waitForSelector('[data-test="ward-notice"][data-rule="equipment-down"]');
  assert.match(await page.locator('[data-test="ward-notice"]').first().textContent(), /partner laboratory/);
  assert.ok(Date.now() - t0 < 5 * 60e3, 'under five minutes');
  assert.deepEqual(errors, []);
  await context.close();
});

test('the guide switch: the manager switches it off; suggestions and the "Not arrived" block go, every specimen is still listed; on again', async () => {
  const { context, page, errors } = await openPage(env, { width: 1280, clock: CLOCK, path: '#/diagnostics' });
  await asRole(page, 'diagnostics-manager');
  assert.ok(await page.locator('[data-test="suggestion"]').count() >= 1);
  const sw = page.locator('[data-test="guide-switch"]');
  assert.equal(await sw.getAttribute('aria-pressed'), 'true');
  await sw.click();
  await page.waitForSelector('[data-test="guide-off"]');
  assert.equal(await page.locator('[data-test="suggestion"]').count(), 0);
  await asRole(page, 'lab-reception');
  assert.equal(await page.locator('[data-test="not-arrived"]').count(), 0);
  const listed = await page.locator('[data-test="block"] [data-test="hatch-row"]').count();
  assert.equal(listed, (await cmd(page, 'ospeli_diagnostics_specimen_log', {}, 'lab-reception')).counts.onTheWay, 'every specimen on the way is still listed, in its block');
  assert.equal(await page.locator('[data-test="guide-switch"]').count(), 0, 'only the manager has the switch');
  await asRole(page, 'diagnostics-manager');
  await page.locator('[data-test="guide-switch"]').click();
  await page.waitForFunction(() => document.querySelector('[data-test="guide"]')?.dataset.on === 'true');
  assert.deepEqual(errors, []);
  await context.close();
});

test('the unit clerk taps "Save: collected" twice on the same spot: one collection is written, the row keeps its place, and Undo puts it back', async () => {
  const { context, page, errors } = await openPage(env, { width: 390, height: 844, touch: true, clock: CLOCK, path: '' });
  await openHome(page, 'unit-clerk');
  await page.selectOption('[data-test="ward"]', 'ward-a2');
  await page.waitForSelector('[data-test="new-request"]');
  // Two requests not collected yet, so another Collected button sits below the first.
  for (let i = 0; i < 2; i++) await cmd(page, 'ospeli_diagnostics_request_record', { sourceId: 'ward-a2', testGroup: 'urine', urgency: 'routine', again: true }, 'unit-clerk');
  await page.waitForFunction(() => document.querySelectorAll('[data-test="request-row"][data-state="requested"] [data-test="collect"]').length >= 2);
  const collected = () => page.evaluate(async () => (await window.ospeli.core.events({ type: 'diagnostics.specimen-collected' })).length);
  const n0 = await collected();
  const row = page.locator('[data-test="request-row"][data-state="requested"]').first();
  const id = await row.getAttribute('data-request');
  await row.locator('[data-test="collect"]').tap();
  await tap(page, '[data-test="collect-ago"] [data-value="0"]');
  const save = page.locator('[data-test="collect-save"]');
  await save.scrollIntoViewIfNeeded();
  const b = await save.boundingBox();
  const x = b.x + b.width / 2; const y = b.y + b.height / 2;
  await page.touchscreen.tap(x, y);
  await page.waitForTimeout(350);
  await page.touchscreen.tap(x, y);
  await page.waitForSelector(`[data-test="pinned-row"][data-request="${id}"]`);
  await page.waitForTimeout(1500);
  await page.touchscreen.tap(x, y); // and once more after the list has been read again
  await page.waitForTimeout(800);
  assert.equal(await collected(), n0 + 1, 'one collection written');
  assert.equal(await page.locator('[data-test="collect-panel"]').count(), 0, 'no other patient\'s panel opened');
  const pinned = page.locator(`[data-test="pinned-row"][data-request="${id}"]`);
  assert.match(await pinned.textContent(), /Collected \d\d:\d\d/);
  const pb = await pinned.boundingBox();
  assert.ok(pb.y <= y && pb.y + pb.height >= y, 'the saved row still sits under the finger');
  await pinned.locator('[data-test="collect-undo"]').tap();
  await waitSaved(page, /Undone: .* is not collected/);
  await page.waitForSelector(`[data-test="request-row"][data-request="${id}"][data-state="requested"]`);
  assert.equal(await page.evaluate(async (rid) => (await window.ospeli.core.events({ subject: rid })).at(-1).type, id), 'diagnostics.collection-undone');
  assert.deepEqual(await phoneProblems(page), []);
  assert.deepEqual(errors, []);
  await context.close();
});

test('the laboratory scientist undoes a "Result released" tapped by mistake', async () => {
  const { context, page, errors } = await openPage(env, { width: 390, height: 844, touch: true, clock: CLOCK, path: '#/diagnostics' });
  await asRole(page, 'lab-scientist');
  const row = page.locator('[data-test="waiting-result"] [data-test="hatch-row"]').first();
  const id = await row.getAttribute('data-request');
  await row.locator('[data-test="release"]').tap();
  const done = page.locator(`[data-test="done-row"][data-request="${id}"][data-outcome="released"]`);
  await done.waitFor();
  assert.equal(await done.locator('[data-test="release"]').count(), 0);
  await done.locator('[data-test="undo"]').tap();
  await waitSaved(page, /Undone: the result release/);
  await page.waitForSelector(`[data-test="waiting-result"] [data-test="hatch-row"][data-request="${id}"]`);
  assert.equal(await page.evaluate(async (rid) => (await window.ospeli.core.events({ subject: rid })).at(-1).type, id), 'diagnostics.specimen-undone');
  assert.deepEqual(errors, []);
  await context.close();
});
