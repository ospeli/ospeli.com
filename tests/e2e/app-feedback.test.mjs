// Patient feedback in the app (module feedback): every role on a phone and a laptop; a receptionist
// logs a concern in a few taps; a patient sends a feedback card on a touch phone and the service's
// numbers change; personal details in a note are refused and nothing is saved; staff steps change
// the KPIs; the guide switch; a role with no rights sees no action button; an agent's write waits
// for a person. Fixed clock: Monday 16 Nov 2026, 11:00 site time.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, openPage } from './helpers.mjs';

let env;
before(async () => { env = await startApp(); });
after(async () => { await env.close(); });

const CLOCK = '2026-11-16T15:00:00.000Z';
const noSideways = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
async function open(width, role, { path = '#/feedback', touch = width < 500 } = {}) {
  const o = await openPage(env, { width, height: width < 500 ? 844 : 900, touch, clock: CLOCK, path });
  await o.page.selectOption('#role-select', role);
  await o.page.waitForSelector(`.mod-feedback[data-role="${role}"] :is(.fb-body > *, [data-test="no-rights"])`);
  return o;
}
const feedbackEvents = (page, type = 'feedback.logged') => page.evaluate(async (t) => (await window.ospeli.core.events({ type: t })).length, type);
// Every visible piece of text under a root is at least 15px; every visible target is at least 44px high.
const smallText = (page, root) => page.evaluate((sel) => [...document.querySelectorAll(`${sel} *`)].filter((n) => n.getClientRects().length
  && [...n.childNodes].some((c) => c.nodeType === 3 && c.textContent.trim()) && parseFloat(getComputedStyle(n).fontSize) < 15).map((n) => `${n.tagName} ${n.textContent.trim().slice(0, 30)}`), root);
const shortTargets = (page, root) => page.evaluate((sel) => [...document.querySelectorAll(`${sel} :is(button, select, textarea, a, summary, .fb-pick, .fb-check, input[type="text"], input[type="date"])`)]
  .filter((n) => n.getClientRects().length && n.getBoundingClientRect().height < 44).map((n) => `${n.tagName} ${n.textContent.trim().slice(0, 30)} ${Math.round(n.getBoundingClientRect().height)}`), root);

for (const width of [390, 1280]) {
  test(`every role renders patient feedback at ${width}px with no sideways scroll and no console error`, async () => {
    for (const [role, tab] of [['receptionist', 'quick'], ['patient-liaison', 'queue'], ['ward-nurse', 'queue'], ['quality-lead', 'themes'], ['ops-manager', 'queue'], ['coo', 'themes']]) {
      const { context, page, errors } = await open(width, role);
      assert.equal(await page.locator('.fb-tabs a[aria-current="page"]').getAttribute('data-tab'), tab, `${role} opens on ${tab}`);
      for (const t of await page.locator('.fb-tabs a').evaluateAll((as) => as.map((a) => a.dataset.tab))) {
        await page.evaluate((x) => { location.hash = `#/feedback/${x}`; }, t);
        await page.waitForFunction((x) => document.querySelector('.fb-tabs a[aria-current="page"]')?.dataset.tab === x, t);
        await page.waitForSelector('.fb-body > *');
        assert.ok(await noSideways(page) <= 0, `${role} ${t} scrolls sideways`);
      }
      assert.deepEqual(errors, [], role);
      await context.close();
    }
    // A role that does not use feedback sees one line saying who does, and no button.
    const { context, page, errors } = await open(width, 'estates-tech');
    assert.match(await page.locator('[data-test="no-rights"]').textContent(), /It is for: Patient liaison officer, Receptionist/);
    assert.equal(await page.locator('.mod-feedback [data-cmd]').count(), 0);
    assert.deepEqual(errors, []);
    await context.close();
  });
}

test('a receptionist logs a concern on a phone in three taps; the form has large targets and text', async () => {
  const { context, page, errors } = await open(390, 'receptionist');
  assert.deepEqual(await shortTargets(page, '[data-test="log-form"]'), []);
  assert.deepEqual(await smallText(page, '[data-test="log-form"]'), []);
  assert.deepEqual(await smallText(page, '[data-test="handover"]'), []);
  assert.equal(await page.locator('.fb-tabs a[data-tab="queue"]').count(), 0, 'no complaints queue for reception');
  const before = await feedbackEvents(page);
  const t0 = Date.now();
  await page.locator('.fb-pick', { hasText: 'Concern' }).tap();
  await page.locator('.fb-pick', { hasText: 'Waiting' }).tap();
  await page.locator('[data-cmd="ospeli_experience_complaint_log"]').tap();
  await page.waitForFunction(() => /^Saved: FB-\d{5}/.test(document.querySelector('[data-test="log-status"]').textContent));
  assert.ok(Date.now() - t0 < 60e3);
  assert.match(await page.locator('[data-test="log-status"]').textContent(), /Concern, Emergency department\. Reply due by .* \(example setting\)\.If the person wants a reply, write FB-\d{5} on your contact note\./);
  assert.equal(await feedbackEvents(page), before + 1);
  const ev = await page.evaluate(async () => (await window.ospeli.core.events({ type: 'feedback.logged' })).at(-1));
  assert.deepEqual([ev.actorRole, ev.data.kind, ev.data.channel, ev.data.serviceId, ev.data.theme, ev.data.note], ['receptionist', 'concern', 'in-person', 'dept-emergency', 'waiting', null]);
  // The form is clear for the next person; the clinical tick shows only for a complaint or concern.
  assert.equal(await page.locator('input[name="fb-kind"]:checked').count(), 0);
  assert.equal(await page.locator('[data-test="fb-clinical"]').isVisible(), false);
  await page.locator('.fb-pick', { hasText: 'Complaint' }).tap();
  assert.equal(await page.locator('[data-test="fb-clinical"]').isVisible(), true);
  assert.deepEqual(errors, []);
  await context.close();
});

test('a note with a titled name or a phone number is refused with a helpful message, and nothing is saved', async () => {
  const { context, page, errors } = await open(390, 'receptionist');
  const before = await feedbackEvents(page);
  for (const [note, said] of [['Dr Sarah Jones was rude at the desk', 'Not saved. Take out the name. Write what happened, not who.'], ['Please ring back on 0123 456 7890', 'Not saved. Take out the phone number. Write what happened, not who.']]) {
    await page.locator('.fb-pick', { hasText: 'Complaint' }).tap();
    await page.locator('.fb-pick', { hasText: 'Staff attitude' }).tap();
    await page.fill('[data-test="fb-note"]', note);
    await page.locator('[data-cmd="ospeli_experience_complaint_log"]').tap();
    await page.waitForSelector('[data-test="log-error"]');
    assert.equal(await page.locator('[data-test="log-error"]').textContent(), said);
    assert.equal(await page.inputValue('[data-test="fb-note"]'), note, 'the note stays so it can be changed');
    assert.equal(await feedbackEvents(page), before, 'nothing saved');
  }
  // An untitled name is asked about once; changing the note then saves it.
  await page.fill('[data-test="fb-note"]', 'Sarah Jones at the front desk');
  await page.locator('[data-cmd="ospeli_experience_complaint_log"]').tap();
  await page.waitForSelector('[data-test="not-a-name"]');
  assert.equal(await feedbackEvents(page), before);
  await page.fill('[data-test="fb-note"]', 'Front desk was very busy');
  await page.locator('[data-cmd="ospeli_experience_complaint_log"]').tap();
  await page.waitForFunction(() => /^Saved: FB-/.test(document.querySelector('[data-test="log-status"]').textContent));
  assert.equal(await feedbackEvents(page), before + 1);
  assert.deepEqual(errors, []);
  await context.close();
});

for (const width of [360, 390]) {
  test(`a patient sends a feedback card on a ${width}px touch screen; the service's numbers change`, async () => {
    const { context, page, errors } = await open(width, 'receptionist');
    await page.selectOption('[data-test="fb-card-service"]', 'dept-outpatients');
    await page.waitForFunction(() => /Outpatients/.test(document.querySelector('[data-test="svc-numbers"] h2')?.textContent));
    const cards = Number(await page.locator('[data-test="svc-numbers"] [data-n="cards"] b').textContent());
    await page.locator('[data-test="hand-over"]').tap();
    const dlg = page.locator('dialog[data-test="card"][open]');
    await dlg.waitFor();
    assert.match(await dlg.locator('h2').textContent(), /How was your visit to Outpatients\?/);
    assert.equal(await dlg.locator('.fbc-face svg').count(), 5, 'five drawn faces');
    assert.deepEqual(await dlg.locator('.fbc-face span').allTextContents(), ['Very poor', 'Poor', 'OK', 'Good', 'Very good']);
    // The card covers the staff screen.
    const box = await dlg.boundingBox();
    assert.ok(box.width >= width - 1 && box.y <= 0, 'full screen');
    assert.deepEqual(await shortTargets(page, 'dialog[data-test="card"]'), []);
    assert.deepEqual(await smallText(page, 'dialog[data-test="card"]'), []);
    assert.ok(await dlg.locator('[data-test="card-send"]').isDisabled(), 'Send waits for a face');
    const t0 = Date.now();
    await dlg.locator('[data-test="face-2"]').tap();
    await dlg.locator('.fbc-theme', { hasText: 'Waiting' }).tap();
    await dlg.locator('[data-test="card-send"]').tap();
    await dlg.locator('[data-test="card-thanks"]').waitFor();
    assert.ok(Date.now() - t0 < 60e3, 'under a minute');
    assert.doesNotMatch(await dlg.locator('[data-test="card-thanks"]').textContent(), /FB-\d/, 'no reference on the patient\'s thank-you');
    assert.match(await dlg.locator('[data-test="card-thanks"]').textContent(), /Cards are read by the team/);
    assert.deepEqual(await smallText(page, 'dialog[data-test="card"]'), []);
    const ev = await page.evaluate(async () => (await window.ospeli.core.events({ type: 'feedback.logged' })).at(-1));
    assert.deepEqual([ev.data.kind, ev.data.channel, ev.data.rating, ev.data.theme, ev.data.serviceId], ['card', 'card', 2, 'waiting', 'dept-outpatients']);
    // A fresh card for the next person: nothing of the last one shows.
    await dlg.locator('[data-test="card-again"]').tap();
    assert.equal(await dlg.locator('.fbc-face[aria-pressed="true"]').count(), 0);
    assert.equal(await dlg.locator('.fbc-theme[aria-pressed="true"]').count(), 0);
    // Back to staff takes two taps, so a patient does not leave by accident.
    await dlg.locator('[data-test="card-exit"]').tap();
    assert.ok(await page.locator('dialog[data-test="card"]').evaluate((d) => d.open));
    await dlg.locator('[data-test="card-exit-yes"]').tap();
    await page.waitForFunction(() => !document.querySelector('dialog[data-test="card"]').open);
    await page.waitForFunction((n) => Number(document.querySelector('[data-test="svc-numbers"] [data-n="cards"] b').textContent) === n + 1, cards);
    assert.ok(await noSideways(page) <= 0);
    assert.deepEqual(errors, []);
    await context.close();
  });
}

test('a phone number on the card is refused in the patient\'s words and nothing is saved', async () => {
  const { context, page, errors } = await open(390, 'receptionist');
  const before = await feedbackEvents(page);
  await page.locator('[data-test="hand-over"]').tap();
  const dlg = page.locator('dialog[data-test="card"][open]');
  await dlg.locator('[data-test="face-1"]').tap();
  await dlg.locator('[data-test="card-note"]').fill('Call me on 0123 456 7890');
  await dlg.locator('[data-test="card-send"]').tap();
  await dlg.locator('[data-test="card-error"]').waitFor();
  assert.equal(await dlg.locator('[data-test="card-error"]').textContent(), 'Please take out names and phone numbers, then send again.');
  assert.equal(await feedbackEvents(page), before);
  await dlg.locator('[data-test="card-note"]').fill('Hard to find the clinic');
  await dlg.locator('[data-test="card-send"]').tap();
  await dlg.locator('[data-test="card-thanks"]').waitFor();
  assert.equal(await feedbackEvents(page), before + 1);
  assert.deepEqual(errors, []);
  await context.close();
});

test('the patient liaison officer at 1280px: overdue first, records a late reply, and the measures change', async () => {
  const { context, page, errors } = await open(1280, 'patient-liaison');
  await page.waitForSelector('[data-test="queue-list"] [data-record]');
  assert.equal(await page.locator('[data-kpi]').count(), 4);
  const overdue = Number(await page.locator('[data-test="count-overdue"]').textContent());
  assert.ok(overdue >= 1);
  const rows = await page.locator('[data-test="queue-list"] .fb-row').evaluateAll((as) => as.map((a) => a.classList.contains('is-over')));
  assert.ok(rows[0] && rows.indexOf(false) >= overdue, 'overdue first');
  const respondedOf = async () => Number((await page.locator('[data-kpi="feedback-response-time"] .fb-kpi-of').first().textContent()).match(/\d+/)[0]);
  const n0 = await respondedOf();
  const first = page.locator('[data-test="queue-list"] .fb-row.is-over').first();
  const id = await first.getAttribute('data-record');
  await first.click();
  await page.waitForSelector(`[data-test="record"][data-record="${id}"]`);
  assert.match(await page.locator('.fb-due').textContent(), /Reply by .* · late/);
  assert.match(await page.locator('[data-test="record"]').textContent(), /Example settings, set locally, not a standard/);
  await page.selectOption('#fb-reply-ch', 'email');
  await page.click('[data-step="reply"]');
  await page.waitForSelector(`[data-test="record"][data-stage="replied"]`);
  assert.match(await page.locator('[data-test="timeline"]').textContent(), /Reply sent.*Patient liaison officer · Email/);
  // Closing is now open to the liaison officer.
  assert.equal(await page.locator('[data-step="close"]').count(), 1);
  await page.click('.fb-tabs a[data-tab="queue"]');
  await page.waitForFunction((n) => Number(document.querySelector('[data-test="count-overdue"]')?.textContent) === n - 1, overdue);
  assert.equal(await respondedOf(), n0 + 1, 'response time now counts one more complaint');
  const ev = await page.evaluate(async (r) => (await window.ospeli.core.events({ subject: r })).at(-1), id);
  assert.deepEqual([ev.type, ev.actorRole, ev.data.channel], ['feedback.replied', 'patient-liaison', 'email']);
  assert.ok(await noSideways(page) <= 0);
  assert.deepEqual(errors, []);
  await context.close();
});

test('the ward nurse on a phone sees the complaints its role owns, records the reply, and has no close button', async () => {
  const { context, page, errors } = await open(390, 'ward-nurse');
  await page.waitForSelector('[data-view="mine"][aria-pressed="true"]');
  const ids = await page.locator('[data-test="queue-list"] [data-record]').evaluateAll((as) => as.map((a) => a.dataset.record));
  assert.ok(ids.length >= 1);
  assert.match(await page.locator('[data-view="mine"]').textContent(), /^For ward or department leads \(\d+\)$/);
  const owners = await page.locator('[data-test="queue-list"] .fb-row-owner').allTextContents();
  assert.ok(owners.every((o) => /^Owner: Ward or department lead · .+/.test(o)), owners.join(' / '));
  // The list comes first on the phone; the reminders and the measures come after it.
  const order = await page.evaluate(() => ['[data-test="queue-list"]', '[data-test="guide"]', '[data-test="kpis"]'].map((q) => document.querySelector(q).getBoundingClientRect().top));
  assert.ok(order[0] < order[1] && order[1] < order[2], order.join(' < '));
  assert.deepEqual(await smallText(page, '.mod-feedback'), [], 'queue text at 390 px');
  await page.locator(`[data-record="${ids[0]}"]`).tap();
  await page.waitForSelector('[data-test="record"]');
  assert.deepEqual(await smallText(page, '.mod-feedback'), [], 'record text at 390 px');
  // Next step and the actions come straight after the header, before the due dates and the timeline.
  const pos = await page.evaluate(() => ['[data-test="next"]', '[data-test="actions"]', '[data-test="due"]', '[data-test="timeline"]'].map((q) => document.querySelector(q).getBoundingClientRect().top));
  assert.ok(pos[0] < pos[1] && pos[1] < pos[2] && pos[2] < pos[3], pos.join(' < '));
  assert.equal(await page.locator('[data-step="close"]').count(), 0, 'closing is for the liaison officer and the quality lead');
  assert.equal(await page.locator('[data-step="set-owner"]').count(), 0);
  assert.equal(await page.locator('[data-step-ask="clinical-review"]').count(), 0, 'clinical review is for the liaison officer and the quality lead');
  assert.deepEqual(await shortTargets(page, '[data-test="next"]'), []);
  // Nothing is chosen in advance: the button says what is missing.
  const reply = page.locator('[data-step="reply"]');
  assert.ok(await reply.isDisabled());
  assert.equal(await reply.textContent(), 'Choose how you replied');
  await page.selectOption('#fb-reply-ch', 'phone');
  assert.equal(await reply.textContent(), 'Record reply sent');
  await reply.tap();
  await page.waitForSelector('[data-test="record"][data-stage="replied"]');
  assert.match(await page.locator('[data-test="saved"]').textContent(), /^Saved: FB-\d{5} reply recorded\. It is in the timeline below\.$/);
  assert.equal(await page.locator('[data-step="reply"]').count(), 0);
  // Agreeing an action: the button waits for "what will change".
  await page.locator('.fb-agree > summary').tap();
  assert.ok(await page.locator('[data-test="agree-action"]').isDisabled());
  assert.equal(await page.locator('[data-test="agree-action"]').textContent(), 'Choose what will change');
  await page.selectOption('#fb-act-what', 'information');
  await page.locator('[data-test="agree-action"]').tap();
  await page.waitForFunction(() => document.querySelectorAll('[data-test="actions"] [data-action]').length >= 1);
  assert.ok(await noSideways(page) <= 0);
  assert.deepEqual(errors, []);
  await context.close();
});

test('the guide switch: off hides the reminders and the template reply; the queue and records work the same', async () => {
  // The reminders are for the owner role and the liaison officer, so the liaison officer sees them all.
  const { context, page, errors } = await open(1280, 'patient-liaison', { path: '#/feedback/queue' });
  await page.waitForSelector('[data-test="suggestions"] li');
  const rowsOn = await page.locator('[data-test="queue-list"] [data-record]').evaluateAll((as) => as.map((a) => a.dataset.record));
  await page.click('[data-test="guide-switch"]');
  await page.waitForSelector('[data-test="guide-off"]');
  assert.equal(await page.locator('[data-test="guide-switch"]').getAttribute('aria-pressed'), 'false');
  assert.equal(await page.locator('[data-test="suggestions"]').count(), 0);
  assert.deepEqual(await page.locator('[data-test="queue-list"] [data-record]').evaluateAll((as) => as.map((a) => a.dataset.record)), rowsOn);
  await page.locator('[data-test="queue-list"] [data-record]').first().click();
  await page.waitForSelector('[data-test="record"]');
  assert.equal(await page.locator('[data-test="reply-template"]').count(), 0);
  assert.ok(await page.locator('[data-cmd="ospeli_experience_record_update"]').count() > 0, 'the steps still work');
  await page.click('.fb-tabs a[data-tab="queue"]');
  await page.click('[data-test="guide-switch"]');
  await page.waitForSelector('[data-test="suggestions"] li');
  await page.locator('[data-test="suggestions"] a').first().click();
  await page.waitForSelector('[data-test="reply-template"]');
  await page.click('[data-test="reply-template"] summary');
  assert.match(await page.locator('[data-test="reply-template"] .fb-pre').textContent(), /^Reference FB-\d{5}/);
  assert.match(await page.locator('[data-test="reply-template"]').textContent(), /Not sent and not stored/);
  assert.deepEqual(errors, []);
  await context.close();
});

test('the quality lead\'s themes board at 1280px: compliments beside complaints, counts only, every KPI with its source', async () => {
  const { context, page, errors } = await open(1280, 'quality-lead');
  await page.waitForSelector('[data-test="by-theme"]');
  assert.deepEqual(await page.locator('[data-test="by-theme"] thead th').allTextContents(), ['Theme', 'Complaints', 'Concerns', 'Compliments', 'Cards (very poor or poor)', 'Actions agreed', 'Actions closed']);
  assert.match(await page.locator('[data-test="method"]').textContent(), /Counts only/);
  for (const k of await page.locator('[data-kpi]').all()) assert.match(await k.textContent(), /Source: local definition/);
  const all = Number(await page.locator('[data-test="totals"] [data-n="cards"] b').textContent());
  await page.selectOption('[data-test="fb-t-service"]', 'dept-outpatients');
  await page.waitForFunction((n) => Number(document.querySelector('[data-test="totals"] [data-n="cards"] b').textContent) < n, all);
  assert.ok(await noSideways(page) <= 0);
  assert.deepEqual(errors, []);
  await context.close();
});

test('the COO can read a record but sees no step button and no guide switch', async () => {
  const { context, page, errors } = await open(1280, 'coo', { path: '#/feedback/queue' });
  await page.waitForSelector('[data-test="queue-list"] [data-record]');
  assert.equal(await page.locator('[data-test="guide-switch"]').count(), 0);
  await page.locator('[data-test="queue-list"] [data-record]').first().click();
  await page.waitForSelector('[data-test="record"]');
  assert.equal(await page.locator('[data-cmd="ospeli_experience_record_update"], [data-cmd="ospeli_experience_action_set"]').count(), 0);
  assert.match(await page.locator('[data-test="no-steps"]').textContent(), /COO can see this record but not move it on/);
  assert.equal(await page.locator('.fb-tabs a[data-tab="quick"]').count(), 0, 'no log form for the COO');
  assert.deepEqual(errors, []);
  await context.close();
});

test('an agent\'s complaint waits on the feedback page until a person accepts it', async () => {
  const { context, page, errors } = await open(1280, 'patient-liaison', { path: '#/feedback/queue' });
  await page.waitForSelector('[data-test="queue-list"] [data-record]');
  const open0 = Number(await page.locator('[data-test="count-open"]').textContent());
  const out = await page.evaluate(async () => {
    const { runCommand } = await import('./core/commands.js');
    const core = window.ospeli.core;
    await runCommand(core, 'ospeli_agents_set_access', { allowed: true, wards: { 'ward-a1': true } }, { type: 'human', role: 'coo' });
    await runCommand(core, 'ospeli_agents_add', { name: 'letters-bot', role: 'patient-liaison', wards: ['ward-a1'], days: 30 }, { type: 'human', role: 'coo' });
    return window.ospeli.run('ospeli_experience_complaint_log', { kind: 'complaint', channel: 'email', serviceId: 'ward-a1', theme: 'communication' }, { agent: 'letters-bot', role: 'patient-liaison' });
  });
  assert.equal(out.status, 'proposed');
  await page.waitForSelector('[data-test="proposals"] [data-proposal]');
  assert.match(await page.locator('[data-test="proposals"]').textContent(), /Log a complaint: Ward A1 \(acute medicine\), Information and communication/);
  assert.equal(Number(await page.locator('[data-test="count-open"]').textContent()), open0, 'nothing changed yet');
  await page.click('[data-test="proposals"] [data-cmd="ospeli_proposals_accept"]');
  await page.waitForFunction((n) => Number(document.querySelector('[data-test="count-open"]')?.textContent) === n + 1, open0);
  const ev = await page.evaluate(async () => (await window.ospeli.core.events({ type: 'feedback.logged' })).at(-1));
  assert.equal(ev.actorRole, 'patient-liaison');
  assert.deepEqual(errors, []);
  await context.close();
});

test('a device whose example hospital has no feedback history shows an honest empty state, and logging still works', async () => {
  const { context, page, errors } = await open(390, 'receptionist');
  // Remove the feedback history the way an older example hospital would lack it: a fresh store with no feedback events.
  await page.evaluate(async () => {
    const core = window.ospeli.core;
    const data = await core.exportData();
    data.events = data.events.filter((e) => !e.type.startsWith('feedback.')).map((e, i) => ({ ...e, seq: i + 1 }));
    await core.importData(data, 'coo');
  });
  await page.evaluate(() => { location.hash = '#/feedback/themes'; });
  await page.waitForSelector('[data-test="no-history"]');
  assert.match(await page.locator('[data-test="no-history"]').textContent(), /No feedback is recorded on this device yet/);
  await page.evaluate(() => { location.hash = '#/feedback/quick'; });
  await page.waitForSelector('[data-test="log-form"]');
  await page.locator('.fb-pick', { hasText: 'Compliment' }).tap();
  await page.locator('.fb-pick', { hasText: 'Information and communication' }).tap();
  await page.locator('[data-cmd="ospeli_experience_complaint_log"]').tap();
  await page.waitForFunction(() => /^Saved: FB-00001/.test(document.querySelector('[data-test="log-status"]').textContent));
  assert.deepEqual(errors, []);
  await context.close();
});

test('back button or back swipe keeps the patient on the card; after staff close it, back works as usual', async () => {
  const { context, page, errors } = await open(390, 'receptionist');
  await page.evaluate(() => { location.hash = '#/feedback/themes'; });
  await page.waitForFunction(() => document.querySelector('.fb-tabs a[aria-current="page"]')?.dataset.tab === 'themes');
  await page.evaluate(() => { location.hash = '#/feedback/quick'; });
  await page.waitForSelector('[data-test="hand-over"]');
  await page.locator('[data-test="hand-over"]').tap();
  const dlg = page.locator('dialog[data-test="card"]');
  await page.waitForFunction(() => document.querySelector('dialog[data-test="card"]').open);
  await dlg.locator('[data-test="face-3"]').tap();
  for (let i = 0; i < 2; i++) {
    await page.goBack();
    await page.waitForSelector('[data-test="card-exit-yes"]');
    assert.ok(await dlg.evaluate((d) => d.open), 'the card is still open');
    assert.equal(await page.evaluate(() => location.hash), '#/feedback/quick');
    // Nothing of the staff screen is visible: the card covers it, and the topbar is behind the modal.
    assert.equal(await page.evaluate(() => { const r = document.querySelector('#role-select').getBoundingClientRect(); return document.elementFromPoint(r.x + 5, r.y + 5)?.closest('dialog[data-test="card"]') != null; }), true);
  }
  assert.equal(await dlg.locator('.fbc-face[aria-pressed="true"]').count(), 1, 'the patient\'s answer is kept');
  await dlg.locator('[data-test="card-exit-yes"]').tap();
  await page.waitForFunction(() => !document.querySelector('dialog[data-test="card"]').open);
  await page.waitForFunction(() => !history.state?.fbCard);
  assert.equal(await page.evaluate(() => location.hash), '#/feedback/quick');
  // Back now goes where it went before the card: the themes board.
  await page.goBack();
  await page.waitForFunction(() => location.hash === '#/feedback/themes');
  await page.waitForFunction(() => document.querySelector('.fb-tabs a[aria-current="page"]')?.dataset.tab === 'themes');
  assert.deepEqual(errors, []);
  await context.close();
});

test('two visitors leave the same card 3 seconds apart: both arrive; a double tap on Send is one card', async () => {
  const { context, page, errors } = await open(390, 'receptionist');
  const before = await feedbackEvents(page);
  await page.locator('[data-test="hand-over"]').tap();
  const dlg = page.locator('dialog[data-test="card"][open]');
  await dlg.locator('[data-test="face-5"]').tap();
  await dlg.locator('[data-test="card-send"]').dblclick();
  await dlg.locator('[data-test="card-thanks"]').waitFor();
  await page.waitForTimeout(300);
  assert.equal(await feedbackEvents(page), before + 1, 'a double tap is one card');
  await page.clock.runFor(3000);
  await dlg.locator('[data-test="card-again"]').tap();
  await dlg.locator('[data-test="face-5"]').tap();
  await dlg.locator('[data-test="card-send"]').tap();
  await dlg.locator('[data-test="card-thanks"]').waitFor();
  assert.equal(await dlg.locator('[data-test="card-error"]').count(), 0);
  assert.equal(await feedbackEvents(page), before + 2, 'the second visitor\'s identical card arrives');
  assert.deepEqual(errors, []);
  await context.close();
});

test('the liaison officer passes a complaint to clinical review (with a yes) and back; it keeps its place and its acknowledgement date', async () => {
  const { context, page, errors } = await open(390, 'patient-liaison', { path: '#/feedback/queue' });
  await page.waitForSelector('[data-test="queue-list"] [data-record]');
  const id = await page.locator('[data-test="queue-list"] .fb-row:not(.is-clinical)').first().getAttribute('data-record');
  await page.locator(`[data-record="${id}"]`).tap();
  await page.waitForSelector('[data-test="record"]');
  await page.locator('[data-step-ask="clinical-review"]').tap();
  assert.equal(await page.evaluate((r) => window.ospeli.core.events({ subject: r, type: 'feedback.clinical-review' }).then((x) => x.length), id), 0, 'nothing until yes');
  await page.locator('[data-test="confirm-yes"]').tap();
  await page.waitForSelector('[data-test="record"][data-clinical="true"]');
  assert.match(await page.locator('[data-test="clinical-note"]').textContent(), /acknowledgement is timed as usual; the reply is not called overdue here/);
  assert.match(await page.locator('[data-test="due"]').textContent(), /Acknowledge by .*Reply by .* · waiting on clinical review \(not called overdue here\)/);
  await page.locator('.fb-tabs a[data-tab="queue"]').tap();
  await page.waitForSelector(`[data-record="${id}"]`);
  assert.match(await page.locator(`[data-record="${id}"] .fb-row-due`).textContent(), /Waiting on clinical review · reply due/);
  // Back from clinical review, by the same roles.
  await page.locator(`[data-record="${id}"]`).tap();
  await page.waitForSelector('[data-test="record"][data-clinical="true"]');
  await page.locator('[data-step-ask="clinical-return"]').tap();
  await page.locator('[data-test="confirm-yes"]').tap();
  await page.waitForSelector('[data-test="record"][data-clinical="false"]');
  assert.match(await page.locator('[data-test="timeline"]').textContent(), /Passed to clinical review.*Returned from clinical review/s);
  assert.deepEqual(await smallText(page, '.mod-feedback'), []);
  assert.deepEqual(errors, []);
  await context.close();
});

test('at 1280 px no text in the module is under 13 px, and the KPI tiles say what they leave out', async () => {
  const { context, page, errors } = await open(1280, 'patient-liaison', { path: '#/feedback/queue' });
  await page.waitForSelector('[data-test="queue-list"] [data-record]');
  const tiny = await page.evaluate(() => [...document.querySelectorAll('.mod-feedback *')].filter((n) => n.getClientRects().length
    && [...n.childNodes].some((c) => c.nodeType === 3 && c.textContent.trim()) && parseFloat(getComputedStyle(n).fontSize) < 13).map((n) => n.textContent.trim().slice(0, 30)));
  assert.deepEqual(tiny, []);
  assert.match(await page.locator('[data-kpi="feedback-response-time"] .fb-kpi-value').textContent(), /calendar days$/);
  assert.deepEqual(errors, []);
  await context.close();
});
