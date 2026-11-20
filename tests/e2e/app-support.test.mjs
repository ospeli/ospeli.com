// Cleaning and transport in the app (module support): every role and screen with no sideways
// scroll and no console error; a transport assistant takes the first seeded job from waiting to done on a 390 px
// touch screen (a quick second tap cannot finish it; undo and hand back work) and the queue and the
// measure change; a ward asks for help in a few taps, and two patients are two jobs; a bed vacated
// on the bed board is in the cleaner's queue with no one asking, and finishing it makes the bed
// available; the supervisor's board at 1280 px with the guide, "do this next" and hand back; roles
// with no rights see no buttons.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, openPage } from './helpers.mjs';

let env;
before(async () => { env = await startApp(); });
after(async () => { await env.close(); });

const CLOCK = '2026-11-10T14:00:00Z';
const noSideways = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
// Choose a role in the picker, then open the module's page (or one screen of it) by its address:
// the picker only jumps to a role's own page from Today, so the test never relies on that. Each
// step waits for the state it needs: the role saved, then a fresh drawing of the page for it.
async function asRole(page, role, screen = '') {
  await page.selectOption('#role-select', role);
  await page.waitForFunction(async (r) => (await window.ospeli.core.getMeta('role')) === r, role);
  const hash = screen ? `#/support/${screen}` : '#/support';
  await page.evaluate((target) => {
    const sup = document.querySelector('.sup');
    if (location.hash === target) return; // the page is drawn again for the new role by the picker
    if (sup) sup.dataset.stale = 'true';
    location.hash = target;
  }, hash);
  await page.waitForFunction(([r, s]) => {
    const x = document.querySelector('.sup');
    return x && !x.dataset.stale && x.dataset.role === r && (!s || x.dataset.screen === s);
  }, [role, screen]);
}
// Phone rules for the front-line view: every control at least 44 px tall, every piece of text at least 15 px.
const phoneProblems = (page) => page.evaluate(() => {
  const out = [];
  for (const el of document.querySelectorAll('.sup button, .sup a, .sup select, .sup summary')) {
    const r = el.getBoundingClientRect();
    if (r.height && r.height < 44) out.push(`${el.tagName} "${el.textContent.trim().slice(0, 30)}" is ${Math.round(r.height)} px tall`);
  }
  for (const el of document.querySelectorAll('.sup *')) {
    const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    const size = parseFloat(getComputedStyle(el).fontSize);
    if (own && el.getClientRects().length && !el.closest('.sr-only') && size < 15) out.push(`"${el.textContent.trim().slice(0, 30)}" is ${size} px`);
  }
  return out;
});

const SCREENS = [['porter', 'jobs'], ['cleaner', 'jobs'], ['cleaner', 'audit'], ['support-supervisor', 'board'], ['support-supervisor', 'audit'],
  ['support-supervisor', 'ask'], ['ward-nurse', 'ask'], ['ward-nurse', 'board'], ['bed-manager', 'board'], ['coo', 'board'], ['estates-tech', 'audit']];
for (const width of [360, 390, 1024, 1280]) {
  test(`every role and screen renders at ${width} px with no sideways scroll and no console error`, async () => {
    const { context, page, errors } = await openPage(env, { width, touch: width < 500, clock: CLOCK, path: '#/support' });
    for (const [role, screen] of SCREENS) {
      await asRole(page, role, screen);
      const o = await noSideways(page);
      assert.ok(o <= 0, `${role} ${screen} scrolls sideways by ${o} px`);
    }
    assert.deepEqual(errors, []);
    await context.close();
  });
}

const porterKpiN = (page) => page.evaluate(async () => {
  const { runCommand } = await import('/app/core/commands.js');
  return (await runCommand(window.ospeli.core, 'ospeli_support_overview', {}, { type: 'human', role: 'support-supervisor' })).kpis.find((k) => k.id === 'porter-request-to-done').n;
});
const counts = async (page) => (await page.locator('[data-test="queue-counts"]').textContent()).match(/^(\d+) waiting · (\d+) in progress/).slice(1).map(Number);

test('a transport assistant opens the app on a 390 px touch screen and takes the first job from waiting to done; a quick second tap cannot finish it; the queue and the measure change', async () => {
  const { context, page, errors } = await openPage(env, { width: 390, height: 844, touch: true, clock: CLOCK, path: '' });
  // A transport assistant's phone: the role is saved, and opening the app with no address opens the module, not Today.
  await page.selectOption('#role-select', 'porter');
  await page.waitForFunction(async () => (await window.ospeli.core.getMeta('role')) === 'porter');
  await page.goto(env.appUrl);
  await page.waitForSelector('html[data-ready="true"]');
  await page.waitForFunction(() => document.querySelector('.sup')?.dataset.role === 'porter');
  assert.equal(await page.evaluate(() => location.hash), '#/support', 'the transport assistant opens on the module, not on Today');
  assert.equal(await page.locator('.sup-tabs').count(), 0, 'one screen: the team\'s jobs, nothing that balances the work');
  const card = page.locator('[data-test="next-job"]');
  await card.waitFor();
  const id = await card.getAttribute('data-task');
  assert.match(await card.textContent(), /Next job.*Specimen or item run.*Specimen.*Urgent.*to Laboratory.*Tap On my way to take this job.*First of \d+ jobs/s, 'the urgent job is first');
  const main = page.locator('[data-test="main-action"]');
  const box = await main.boundingBox();
  assert.ok(box.y + box.height <= 844, `the job's button is on the first screen (bottom at ${Math.round(box.y + box.height)} px)`);
  assert.ok(box.height >= 56, `one big button (${box.height} px)`);
  assert.equal(await main.textContent(), 'On my way');
  assert.deepEqual(await phoneProblems(page), [], 'jobs screen: phone rules');
  assert.equal(await page.locator('[data-test="team-measure"], [data-test="guide"]').count(), 0, 'no measures or guide on the transport assistant\'s screen');
  // Jobs in progress that this phone did not take are read-only; other waiting jobs offer only "take this one instead".
  assert.equal(await page.locator('.sup-list li [data-cmd="ospeli_tasks_complete"]').count(), 0);
  assert.equal(await page.locator('.sup-list li [data-cmd="ospeli_tasks_start"]').count(), 0);
  assert.ok(await page.locator('[data-test="take-instead"]').count() >= 2);
  const [waiting0, busy0] = await counts(page);
  assert.ok(waiting0 >= 3 && busy0 >= 1, `a real queue: ${waiting0} waiting, ${busy0} in progress`);
  const n0 = await porterKpiN(page);
  assert.ok(n0 > 100, 'the measure has thirty days of history');

  // Tap, then tap the same spot again a second later, as a person checking it worked would.
  await main.tap();
  await page.waitForFunction(() => document.querySelector('[data-test="next-job"]')?.dataset.mode === 'mine');
  await page.waitForTimeout(1000);
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(500);
  assert.equal(await page.evaluate(async (t) => (await window.ospeli.core.events({ subject: t })).at(-1).type, id), 'task.started', 'the second tap did not finish the job');
  assert.match(await card.textContent(), /You have this job.*On the way\. Saved\.Undo.*Tap Delivered when it is done/s);
  assert.match(await main.textContent(), /^Delivered \(wait \d s\)$/);
  assert.equal(await main.isDisabled(), true);
  assert.deepEqual(await counts(page), [waiting0 - 1, busy0 + 1]);
  // The phone is locked and the app opened again: the job this phone took is still on top.
  await page.reload();
  await page.waitForSelector('html[data-ready="true"]');
  await page.waitForFunction((t) => document.querySelector('[data-test="next-job"]')?.dataset.task === t && document.querySelector('[data-test="next-job"]')?.dataset.mode === 'mine', id);
  await page.waitForFunction(() => document.querySelector('[data-test="main-action"]')?.textContent === '✓ Delivered' && !document.querySelector('[data-test="main-action"]').disabled);
  await page.locator('[data-test="main-action"]').tap();
  await page.waitForFunction((t) => document.querySelector('[data-test="next-job"]')?.dataset.task !== t, id);
  assert.equal(await porterKpiN(page), n0 + 1, 'the measure counts it');
  assert.deepEqual(await counts(page), [waiting0 - 1, busy0]);
  const types = await page.evaluate(async (t) => (await window.ospeli.core.events({ subject: t })).map((e) => [e.type, e.actorRole]), id);
  assert.deepEqual(types.slice(-2), [['task.started', 'porter'], ['task.completed', 'porter']]);
  assert.ok(await noSideways(page) <= 0);
  assert.deepEqual(errors, []);
  await context.close();
});

test('undo and hand back: a job taken by mistake or not ready goes back in its place, and the queue says why', async () => {
  const { context, page, errors } = await openPage(env, { width: 390, height: 844, touch: true, clock: CLOCK, path: '#/support' });
  await asRole(page, 'porter', 'jobs');
  const card = page.locator('[data-test="next-job"]');
  await card.waitFor();
  const first = await card.getAttribute('data-task');
  await page.locator('[data-test="main-action"]').tap();
  await page.waitForSelector('[data-test="undo"]');
  await page.tap('[data-test="undo"]');
  await page.waitForFunction((t) => document.querySelector('[data-test="next-job"]')?.dataset.mode === 'next' && document.querySelector('[data-test="next-job"]')?.dataset.task === t, first);
  assert.match(await card.textContent(), /Handed back: started by mistake/);

  // Take another job instead (asks once), then hand it back: the patient or item is not ready.
  const other = page.locator('[data-test="take-instead"]').first();
  const otherId = await other.evaluate((b) => b.closest('li').dataset.task);
  await other.tap();
  await page.tap('[data-test="confirm-take"] [data-cmd="ospeli_tasks_start"]');
  await page.waitForFunction((t) => document.querySelector('[data-test="next-job"]')?.dataset.task === t && document.querySelector('[data-test="next-job"]').dataset.mode === 'mine', otherId);
  await page.locator('[data-test="hand-back"] summary').tap();
  await page.tap('[data-test="hand-back"] [data-release="Patient or item not ready"]');
  await page.waitForFunction((t) => document.querySelector(`li[data-task="${t}"] [data-test="handed-back"]`), otherId);
  assert.equal(await page.locator(`li[data-task="${otherId}"] [data-test="handed-back"]`).textContent(), 'Handed back: patient or item not ready');
  const ev = await page.evaluate(async (t) => (await window.ospeli.core.events({ subject: t })).at(-1), otherId);
  assert.deepEqual([ev.type, ev.actorRole, ev.data.reason], ['task.released', 'porter', 'Patient or item not ready']);
  assert.deepEqual(errors, []);
  await context.close();
});

test('a ward asks in a few taps and sees its place in the queue; two patients from one ward are two jobs; one bed asked twice says which job is open', async () => {
  const { context, page, errors } = await openPage(env, { width: 390, height: 844, touch: true, clock: CLOCK, path: '#/support' });
  await asRole(page, 'ward-nurse', 'ask');
  const ask = async ({ bed = '', detail = 'Wheelchair' } = {}) => {
    await page.tap('[data-kind="patient-move"]');
    await page.selectOption('[data-test="ask-where"]', 'ward-a1');
    await page.selectOption('[data-test="ask-bed"]', bed);
    await page.selectOption('[data-test="ask-to"]', 'dept-imaging');
    await page.tap(`[data-detail="${detail}"]`);
    await page.evaluate(() => { document.querySelector('[data-test="ask-status"]').textContent = ''; });
    await page.tap('[data-test="ask-send"]');
    await page.waitForFunction(() => document.querySelector('[data-test="ask-status"]').textContent);
    return page.locator('[data-test="ask-status"]').textContent();
  };
  await page.tap('[data-kind="patient-move"]');
  assert.match(await page.locator('[data-test="ask-form"]').textContent(), /How urgent.*Normal.*Urgent.*From.*To.*How will they travel\?.*Ask Transport/s, 'the button comes straight after the last pick');
  assert.match(await ask(), /^Asked: Patient move, Ward A1 \(acute medicine\)\. \w+ of \d+ waiting for Transport\./);
  assert.match(await ask(), /^Asked: Patient move, Ward A1 \(acute medicine\)\./, 'a second patient from the same ward is a second job');
  assert.match(await ask({ bed: 'ward-a1-bed-04' }), /^Asked: Patient move, Ward A1 \(acute medicine\), Bed 04\./);
  assert.equal(await ask({ bed: 'ward-a1-bed-04' }).then((x) => x.replace(/, \w+ of \d+ waiting for Transport/, '')),
    'Not sent: Patient move from Ward A1 (acute medicine), Bed 04 to Imaging (Wheelchair) is already open. For a different patient, choose their own bed or the whole ward.');
  const asked = await page.evaluate(async () => (await window.ospeli.core.events({ type: 'task.requested' })).filter((e) => e.actorRole === 'ward-nurse' && e.at > '2026-11-10T13:59').length);
  assert.equal(asked, 3);
  assert.match(await page.locator('[data-test="ask-open"]').textContent(), /\w+ of \d+ waiting for Transport/, 'the ward sees where its jobs are in the queue');
  assert.deepEqual(await phoneProblems(page), [], 'ask form: phone rules');
  // The device remembers the place it last asked from.
  await page.reload();
  await page.waitForSelector('html[data-ready="true"]');
  await page.waitForFunction(() => document.querySelector('[data-test="ask-where"]')?.value === 'ward-a1');

  await asRole(page, 'porter', 'jobs');
  await page.waitForSelector('[data-test="next-job"]');
  assert.ok(await page.locator('li[data-task]').filter({ hasText: 'From Ward A1 (acute medicine), Bed 04 to Imaging' }).count() >= 1);
  assert.deepEqual(errors, []);
  await context.close();
});

test('a room clean in three taps from the ward\'s own link; the cleaning team sees it', async () => {
  const { context, page, errors } = await openPage(env, { width: 360, touch: true, clock: CLOCK, path: '#/support' });
  await asRole(page, 'ward-nurse');
  await page.evaluate(() => { document.querySelector('.sup').dataset.stale = 'true'; location.hash = '#/support/ask/ward-a3'; });
  await page.waitForFunction(() => !document.querySelector('.sup').dataset.stale && document.querySelector('[data-test="ask-where"]')?.value === 'ward-a3');
  await page.tap('[data-kind="room-clean"]');
  await page.tap('[data-detail="Spill"]');
  await page.tap('[data-test="ask-send"]');
  await page.waitForFunction(() => /^Asked: Room or area clean, Ward A3/.test(document.querySelector('[data-test="ask-status"]').textContent));
  await asRole(page, 'cleaner', 'jobs');
  await page.waitForSelector('.sup-jobs [data-test="queue-counts"]');
  assert.ok(await page.locator('.sup-jobs').getByText('Ward A3 (older adults)').count() >= 1);
  assert.deepEqual(errors, []);
  await context.close();
});

test('a bed vacated on the bed board is in the cleaner\'s queue with no one asking, with any patient waiting for a bed there; finishing it makes the bed available', async () => {
  const { context, page, errors } = await openPage(env, { width: 390, touch: true, clock: CLOCK, path: '#/beds' });
  // Mark the board drawn before the role pick, so the test can wait for the new drawing to be
  // swapped in: the shell draws a page off-screen from the data it read when it started (app.js
  // route), so a bed changed while that drawing is under way shows its old state until the next one.
  await page.waitForSelector('.bed.st-occupied');
  // A new device starts as a ward nurse. Choosing the role already chosen changes nothing (#95: no
  // event, no new drawing), so the pick and the wait for a new drawing happen only for another role.
  if ((await page.inputValue('#role-select')) !== 'ward-nurse') {
    await page.evaluate(() => document.querySelectorAll('main .bed').forEach((b) => { b.dataset.oldDrawing = '1'; }));
    await page.selectOption('#role-select', 'ward-nurse');
    await page.waitForFunction(async () => (await window.ospeli.core.getMeta('role')) === 'ward-nurse');
    await page.waitForFunction(() => document.querySelector('main .bed') && !document.querySelector('main .bed[data-old-drawing]'));
  }
  assert.equal(await page.inputValue('#role-select'), 'ward-nurse');
  await page.waitForSelector('.bed.st-occupied');
  const bedId = await page.locator('.bed.st-occupied').first().getAttribute('data-bed');
  // The bed board draws itself again for the new role a moment after the pick, which closes a dialog
  // opened before that. Open the bed's dialog and tap "Patient has left" until the tap lands.
  let vacated = false;
  for (let i = 0; i < 10 && !vacated; i++) {
    if (!(await page.locator('dialog[open]').count())) await page.tap(`.bed[data-bed="${bedId}"]`);
    vacated = await page.tap('dialog[open] [data-action="vacate"]', { timeout: 1500 }).then(() => true, () => false);
  }
  assert.ok(vacated, 'the bed dialog opened and "Patient has left" was tapped');
  await page.waitForFunction((b) => document.querySelector(`.bed[data-bed="${b}"]`)?.classList.contains('st-vacated'), bedId);

  await asRole(page, 'cleaner', 'jobs');
  const id = `clean-${bedId}`;
  const here = page.locator(`[data-task="${id}"]`).first();
  await here.waitFor();
  // A fact from the bed board, guide on or off: is a patient waiting for a bed on this ward?
  const demand = await page.evaluate(async (b) => {
    const { runCommand } = await import('/app/core/commands.js');
    const ov = await runCommand(window.ospeli.core, 'ospeli_support_overview', { format: 'short' }, { type: 'human', role: 'cleaner' });
    return ov.bedDemand.find((d) => b.startsWith(`${d.wardId}-`)).patientsWaiting;
  }, bedId);
  assert.equal(await here.locator('[data-test="bed-demand"]').count(), demand ? 1 : 0, `${demand} waiting`);
  if (await page.locator(`[data-test="next-job"][data-task="${id}"]`).count()) await page.tap('[data-test="main-action"]');
  else {
    await page.locator(`li[data-task="${id}"] [data-test="take-instead"]`).tap();
    await page.tap('[data-test="confirm-take"] [data-cmd="ospeli_tasks_start"]');
  }
  await page.waitForFunction((t) => document.querySelector('[data-test="next-job"]')?.dataset.task === t && document.querySelector('[data-test="next-job"]').dataset.mode === 'mine', id);
  await page.waitForFunction(() => document.querySelector('[data-test="main-action"]')?.textContent === '✓ Clean done: bed ready');
  await page.tap('[data-test="main-action"]');
  await page.waitForFunction((t) => !document.querySelector(`[data-task="${t}"]`), id);

  await page.evaluate(() => { location.hash = '#/beds'; });
  await page.waitForFunction((b) => document.querySelector(`.bed[data-bed="${b}"]`)?.classList.contains('st-available'), bedId);
  const types = await page.evaluate(async (b) => (await window.ospeli.core.events({ subject: b })).slice(-3).map((e) => [e.type, e.actorRole]), bedId);
  assert.deepEqual(types, [['bed.vacated', 'ward-nurse'], ['bed.clean-started', 'cleaner'], ['bed.cleaned', 'cleaner']]);
  assert.deepEqual(errors, []);
  await context.close();
});

test('the supervisor\'s board at 1280 px: teams, the guide and its switch, "do this next" kept apart from a ward\'s urgent ask, hand back, honest measures, linen and meals on their own screen', async () => {
  const { context, page, errors } = await openPage(env, { width: 1280, clock: CLOCK, path: '#/support' });
  await asRole(page, 'support-supervisor', 'board');
  await page.waitForSelector('[data-test="team-counts"] .stat');
  assert.equal(await page.locator('[data-test="team-counts"] .stat').count(), 2);
  assert.equal(await page.locator('[data-kpi]').count(), 3);
  assert.match(await page.locator('[data-kpi="cleanliness-audit-score"]').textContent(), /\d+%.*items passed.*Source: Your site's cleanliness standard \(set locally\)/s);
  assert.match(await page.locator('[data-kpi="support-bed-turnaround"] [data-test="left-out"]').textContent(), /before a clean was recorded/);
  assert.match(await page.locator('[data-kpi="porter-request-to-done"] [data-test="by-priority"]').textContent(), /^Urgent: \d+ min \(\d+\) · Normal: \d+ min \(\d+\)$/);
  assert.match(await page.locator('[data-kpi="porter-request-to-done"]').textContent(), /handed back keeps the time it was first asked for/);
  // Slice 2 (19 Nov): linen and meals are built, so the "planned" line is gone; their suggestions are on their own screen.
  assert.equal(await page.locator('[data-test="planned"]').count(), 0);
  assert.match(await page.locator('[data-test="more-suggestions"]').textContent(), /more about linen and meals: see Linen and meals/);
  assert.match(await page.locator('[data-test="suggestion"][data-rule="audit-failed-twice"]').textContent(), /Re-audit Ward B2 \(orthopaedics\) by \d+ \w+ \d{4}\..*70% and 80%.*Failed both times/s);

  // The ward's own urgent ask: "Urgent", and nothing here undoes it.
  const urgentRow = page.locator('[data-test="board"] li[data-team="transport"]').filter({ has: page.locator('[data-mark="asked-urgent"]') }).first();
  await urgentRow.waitFor();
  assert.equal(await urgentRow.locator('[data-test="to-front"]').count(), 0);
  const id = await page.evaluate(async () => {
    const { runCommand } = await import('/app/core/commands.js');
    return (await runCommand(window.ospeli.core, 'ospeli_tasks_request', { kind: 'item-run', locationId: 'ward-c1', toLocationId: 'dept-laboratory', detail: 'Supplies' }, { type: 'human', role: 'ward-nurse' })).taskId;
  });
  const row = page.locator(`[data-test="board"] li[data-task="${id}"]`);
  await row.waitFor();
  await page.click('[data-test="guide-switch"]');
  await page.waitForSelector('[data-test="guide-off"]');
  assert.equal(await page.locator('[data-test="suggestion"]').count(), 0);
  assert.equal(await page.locator('[data-kpi]').count(), 3, 'the measures stay');
  assert.equal(await row.locator('[data-test="to-front"]').textContent(), 'Do this next');
  await row.locator('[data-test="to-front"]').click();
  await page.waitForFunction((t) => document.querySelector(`[data-test="board"] li[data-task="${t}"] [data-test="to-front"]`)?.textContent === 'Undo: back to its place', id);
  assert.equal(await row.locator('[data-mark]').getAttribute('data-mark'), 'do-next');
  assert.equal(await row.locator('[data-mark]').textContent(), 'Do this next', 'not a red Urgent');
  // Started: no reordering; the supervisor can hand it back.
  await row.locator('[data-cmd="ospeli_tasks_start"]').click();
  await page.waitForFunction((t) => document.querySelector(`[data-test="board"] li[data-task="${t}"] [data-cmd="ospeli_tasks_complete"]`), id);
  assert.equal(await row.locator('[data-test="to-front"]').count(), 0);
  await row.locator('[data-test="hand-back"] summary').click();
  await row.locator('[data-release="Needs a second person"]').click();
  await page.waitForFunction((t) => document.querySelector(`[data-test="board"] li[data-task="${t}"] [data-test="handed-back"]`)?.textContent === 'Handed back: needs a second person', id);
  await page.click('[data-test="guide-switch"]');
  await page.waitForSelector('[data-test="suggestion"]');
  assert.ok(await noSideways(page) <= 0);
  assert.deepEqual(errors, []);
  await context.close();
});

test('a cleaning audit on a phone: area, type of area, pass or fail per item, "the rest as pass" only after a check, saved with its score and what needs action', async () => {
  const { context, page, errors } = await openPage(env, { width: 390, touch: true, clock: CLOCK, path: '#/support' });
  await asRole(page, 'support-supervisor', 'audit');
  assert.match(await page.locator('[data-test="aud-note"]').textContent(), /example set, set locally, not a standard/);
  await page.selectOption('[data-test="aud-where"]', 'ward-a3');
  await page.waitForFunction(() => document.querySelector('[data-risk="high"]')?.getAttribute('aria-pressed') === 'true'); // the type it was audited as last time
  await page.tap('[data-element="curtains"] [data-mark="fail"]');
  await page.tap('[data-test="aud-rest"]');
  assert.match(await page.locator('[data-test="aud-rest-confirm"]').textContent(), /Have you checked every one\? 9 items are not marked yet/);
  assert.equal(await page.locator('[data-test="aud-score"]').textContent(), '0 of 1 items passed: 0%', 'nothing marked until the auditor says yes');
  await page.tap('[data-test="aud-rest-yes"]');
  assert.equal(await page.locator('[data-test="aud-score"]').textContent(), '9 of 10 items passed: 90%');
  assert.deepEqual(await phoneProblems(page), [], 'audit screen: phone rules');
  await page.tap('[data-test="aud-save"]');
  await page.waitForFunction(() => /Saved: Ward A3 \(older adults\), 90%/.test(document.querySelector('[data-test="aud-result"]')?.textContent));
  assert.match(await page.locator('[data-test="aud-result"]').textContent(), /Needs action:.*Curtains and screens/s);
  await page.waitForFunction(() => document.querySelector('[data-area="ward-a3"]')?.textContent.includes('90%'));
  const ev = await page.evaluate(async () => (await window.ospeli.core.events({ type: 'support.audit-recorded' })).at(-1));
  assert.deepEqual([ev.subject, ev.actorRole, ev.data.riskCategory, ev.data.failed], ['ward-a3', 'support-supervisor', 'high', ['curtains']]);
  assert.deepEqual(errors, []);
  await context.close();
});

test('a role with no rights sees no action button, and one line that says who can', async () => {
  const { context, page, errors } = await openPage(env, { width: 1280, clock: CLOCK, path: '#/support' });
  await asRole(page, 'estates-tech', 'board');
  await page.waitForSelector('[data-test="board"] [data-task]');
  assert.equal(await page.locator('.sup [data-cmd^="ospeli_tasks_"], .sup [data-cmd^="ospeli_support_"]').count(), 0);
  assert.match(await page.locator('[data-test="read-only"]').textContent(), /Facilities technician can see the board/);
  assert.match(await page.locator('[data-test="guide"]').textContent(), /can switch the guide on or off/);
  await asRole(page, 'estates-tech', 'audit');
  assert.equal(await page.locator('[data-test="aud-save"]').count(), 0);
  assert.match(await page.locator('[data-test="read-only"]').textContent(), /Audits are recorded by the Support services supervisor/);
  // A cleaner reads the audit results but records none, and has no board.
  await asRole(page, 'cleaner', 'audit');
  assert.equal(await page.locator('[data-test="aud-save"]').count(), 0);
  // Slice 2 (19 Nov): the cleaner also counts linen and meals on the ward.
  assert.deepEqual(await page.locator('.sup-tabs a').evaluateAll((a) => a.map((x) => x.dataset.screen)), ['jobs', 'audit', 'linen']);
  // A transport assistant has no button on a cleaning job: the transport assistant's queue holds transport jobs only.
  await asRole(page, 'porter', 'jobs');
  await page.waitForSelector('[data-test="next-job"]');
  assert.equal(await page.locator('.sup-jobs').getByText('Room or area clean').count(), 0);
  assert.deepEqual(errors, []);
  await context.close();
});

// Adoption check (ospeli/ospeli#112): the manager's first five minutes, untrained, on a phone.
test('the supervisor\'s first five minutes on a 390 px phone: opens on the module, sees each team\'s waiting jobs and the oldest wait, and puts a job first in one tap', async () => {
  const { context, page, errors } = await openPage(env, { width: 390, height: 844, touch: true, clock: CLOCK, path: '' });
  await page.selectOption('#role-select', 'support-supervisor');
  await page.waitForFunction(async () => (await window.ospeli.core.getMeta('role')) === 'support-supervisor');
  await page.goto(env.appUrl);
  await page.waitForSelector('html[data-ready="true"]');
  await page.waitForFunction(() => document.querySelector('.sup')?.dataset.role === 'support-supervisor');
  assert.equal(await page.evaluate(() => location.hash), '#/support', 'the supervisor opens on the module, not on Today');
  // The area's status: one count per team, each with its waiting jobs and longest wait, on the first screen.
  const teams = page.locator('[data-test="team-counts"] .stat');
  await teams.first().waitFor();
  assert.equal(await teams.count(), 2);
  const status = await page.locator('[data-test="team-counts"]').textContent();
  assert.match(status, /Transport\d+ waiting.*longest \d+ min/s);
  assert.match(status, /Cleaning\d+ waiting.*longest \d+ min/s);
  const box = await page.locator('[data-test="team-counts"]').boundingBox();
  assert.ok(box.y < 844, `the team counts start on the first screen (top at ${Math.round(box.y)} px)`);
  // Act: put a waiting routine job first in line, and undo it.
  const row = page.locator('[data-test="board"] li').filter({ has: page.locator('[data-test="to-front"]') }).first();
  await row.waitFor();
  const id = await row.getAttribute('data-task');
  await row.locator('[data-test="to-front"]').tap();
  await page.waitForFunction((t) => document.querySelector(`[data-test="board"] li[data-task="${t}"] [data-mark]`)?.dataset.mark === 'do-next', id);
  const ev = await page.evaluate(async (t) => (await window.ospeli.core.events({ subject: t })).at(-1), id);
  assert.deepEqual([ev.type, ev.actorRole], ['task.prioritised', 'support-supervisor']);
  assert.ok(await noSideways(page) <= 0, 'no sideways scroll');
  assert.deepEqual(await phoneProblems(page), [], 'the board on a phone: targets 44 px or more, text 15 px or more');
  assert.deepEqual(errors, []);
  await context.close();
});

// ---------------------------------------------------------------- Linen and meals (slice 2, 19 Nov)
async function toLinen(page, role) {
  await asRole(page, role, 'linen');
  await page.waitForSelector('[data-test="linen-count"]');
}
const ev = (page, type) => page.evaluate(async (t) => (await window.ospeli.core.events({ type: t })).at(-1), type);

for (const width of [360, 390, 1280]) {
  test(`Linen and meals renders for every role at ${width} px with no sideways scroll and no console error`, async () => {
    const { context, page, errors } = await openPage(env, { width, touch: width < 500, clock: CLOCK, path: '#/support' });
    await page.evaluate(() => localStorage.setItem('ospeli-support-linen-area', 'ward-c1'));
    for (const role of ['cleaner', 'ward-nurse', 'support-supervisor', 'storekeeper', 'coo', 'bed-manager']) {
      await toLinen(page, role);
      const o = await noSideways(page);
      assert.ok(o <= 0, `${role} linen scrolls sideways by ${o} px`);
    }
    assert.deepEqual(errors, []);
    await context.close();
  });
}

// Adoption check (ospeli/ospeli#112): the front line's first five minutes, untrained, on a phone.
test('a cleaner\'s first five minutes on a 390 px touch screen: picks the ward, counts from the number on record and saves (nothing is asked for by itself), asks for the top-up in one tap, can cancel it, and records a meal count', async () => {
  const { context, page, errors } = await openPage(env, { width: 390, height: 844, touch: true, clock: CLOCK, path: '#/support' });
  await asRole(page, 'cleaner', 'jobs');
  await page.locator('.sup-tabs a[data-screen="linen"]').tap();
  await page.waitForSelector('[data-test="linen-count"]');
  assert.equal(await page.locator('[data-test="linen-rows"]').count(), 0, 'nothing is chosen for the person: the ward is picked first');
  await page.selectOption('[data-test="linen-area"]', 'ward-c1');
  await page.waitForSelector('[data-test="linen-rows"] li');
  assert.match(await page.locator('[data-test="linen-count"] [data-test="levels-note"]').textContent(), /set by your support services supervisor\. The ones here are example settings, not a standard\./);
  // Lowest first, each line "Item n of level, top up m", the first one on the first screen.
  const first = page.locator('[data-test="linen-rows"] li').first();
  assert.match(await first.textContent(), /^\w[\w ]+\d+ of \d+top up \d+/);
  const fb = await first.boundingBox();
  assert.ok(fb.y + fb.height <= 844, `the first linen line is on the first screen (bottom at ${Math.round(fb.y + fb.height)} px)`);
  assert.deepEqual(await phoneProblems(page), [], 'linen screen: phone rules');
  // The box starts from the number on record: + gives one more, not 1.
  const rows = await page.locator('[data-test="linen-rows"] li').evaluateAll((ls) => ls.map((l) => [l.dataset.item, Number(l.querySelector('[data-test="linen-have"]').textContent.match(/^(\d+) of (\d+)/)[1]), Number(l.querySelector('[data-test="linen-have"]').textContent.match(/of (\d+)/)[1])]));
  const [[a, aHave, aLevel], [b]] = rows;
  assert.match(await page.locator(`[data-item="${a}"] [data-test="on-record"]`).textContent(), new RegExp(`on record: ${aHave}\\)$`));
  await page.locator(`[data-item="${a}"] [data-step="up"]`).tap();
  assert.equal(await page.locator(`[data-item="${a}"] [data-test="linen-count-input"]`).inputValue(), String(aHave + 1));
  await page.locator(`[data-item="${b}"] [data-test="linen-count-input"]`).fill('5');
  assert.equal(await page.locator('[data-test="linen-save"]').textContent(), 'Save count (2 items)');
  // Saving shows "Saving…" on a button that is off until the answer.
  await page.evaluate(() => {
    window.__saw = [];
    const watch = () => { const b = document.querySelector('[data-test="linen-save"]'); if (b) window.__saw.push([b.textContent, b.disabled]); };
    new MutationObserver(watch).observe(document.querySelector('.sup-linen'), { subtree: true, childList: true, characterData: true, attributes: true });
  });
  const requestsBefore = await page.evaluate(async () => (await window.ospeli.core.events({ type: 'stock.requested' })).length);
  await page.locator('[data-test="linen-save"]').tap();
  await page.waitForSelector('[data-test="linen-result"]');
  assert.ok((await page.evaluate(() => window.__saw)).some(([t, d]) => t === 'Saving…' && d === true), 'the button said Saving… and was off');
  assert.match(await page.locator('[data-test="linen-result"]').textContent(), /^Saved: 2 items counted at Ward C1 \(maternity\)\./);
  const counted = await ev(page, 'stock.counted');
  assert.deepEqual([counted.subject, counted.actorRole, counted.data.lines], ['ward-c1', 'cleaner', [{ itemId: a, qty: aHave + 1 }, { itemId: b, qty: 5 }]]);
  assert.equal(await page.evaluate(async () => (await window.ospeli.core.events({ type: 'stock.requested' })).length), requestsBefore, 'saving a count asks for nothing by itself');
  assert.match(await page.locator('[data-test="linen-under-line"]').first().textContent(), new RegExp(`is ${aLevel - aHave - 1} under its level\\.$`));
  assert.equal(await page.locator(`[data-item="${a}"] [data-test="linen-have"]`).textContent(), `${aHave + 1} of ${aLevel}`, 'the edited line is drawn at once');
  // One clear button asks for exactly what is short.
  assert.match(await page.locator('[data-test="will-ask"]').textContent(), /^Asks the store for: .+\d\.$/);
  await page.locator('[data-test="linen-ask"]').tap();
  await page.waitForSelector('[data-test="linen-ask-result"]');
  assert.match(await page.locator('[data-test="linen-ask-result"]').textContent(), /^Top-up asked for: .+ The store issues it\.$/);
  assert.doesNotMatch(await page.locator('[data-test="linen-count"]').textContent(), /req-\d/, 'no request ids on the cleaner\'s card');
  const q = await ev(page, 'stock.requested');
  assert.deepEqual([q.data.raisedBy, q.actorRole, q.data.placeId], ['request', 'cleaner', 'ward-c1']);
  assert.match(await page.locator(`[data-item="${a}"] [data-test="top-up-waiting"]`).textContent(), /^Top-up asked for just now: waiting for the store\.$/);
  assert.match(await page.locator('[data-test="no-ask"]').textContent(), /already asked for everything under level/, 'a second tap has nothing left to ask for');
  // A wrong top-up can be withdrawn: one confirm, the reason.
  const waiting = page.locator(`[data-test="linen-waiting"] li[data-request="${q.subject}"]`);
  await waiting.locator('[data-test="cancel-top-up"] summary').tap();
  await waiting.locator('[data-reason="Asked for by mistake"]').tap();
  await page.waitForFunction((r) => !document.querySelector(`[data-test="linen-waiting"] li[data-request="${r}"]`), q.subject);
  const gone = await ev(page, 'stock.request-cancelled');
  assert.deepEqual([gone.subject, gone.actorRole, gone.data.reason], [q.subject, 'cleaner', 'Asked for by mistake']);
  assert.match(await page.locator('[data-test="linen-ask-result"]').textContent(), /Top-up cancelled/);
  // Meals: the ward is the same; pick the meal, three numbers, save.
  assert.match(await page.locator('[data-test="meals-note"]').textContent(), /Diets and allergies are not handled here/);
  await page.locator('[data-test="meal-save"]').tap();
  await page.waitForSelector('[data-test="meal-result"]');
  assert.equal(await page.locator('[data-test="meal-result"]').textContent(), 'Fill in the meal first.', 'the button says what is missing');
  await page.locator('[data-test="meal-pick-evening"]').tap();
  await page.locator('[data-test="meal-ordered"]').fill('18');
  await page.locator('[data-test="meal-delivered"]').fill('17');
  for (let i = 0; i < 2; i++) await page.locator('[data-test="meal-returned"]').locator('xpath=..').locator('[data-step="up"]').tap();
  await page.locator('[data-test="meal-save"]').tap();
  await page.waitForFunction(() => /^Saved: Ward C1/.test(document.querySelector('[data-test="meal-result"]')?.textContent || ''));
  assert.equal(await page.locator('[data-test="meal-result"]').textContent(), 'Saved: Ward C1 (maternity), today, evening meal: 2 of 17 returned uneaten (12%).');
  const meal = await ev(page, 'support.meals-recorded');
  assert.deepEqual([meal.subject, meal.actorRole, meal.data.meal, meal.data.ordered, meal.data.delivered, meal.data.returned], ['ward-c1', 'cleaner', 'evening', 18, 17, 2]);
  assert.deepEqual(await phoneProblems(page), [], 'after saving: phone rules');
  assert.ok(await noSideways(page) <= 0);
  assert.deepEqual(errors, []);
  await context.close();
});

// Adoption check (ospeli/ospeli#112): the manager's first five minutes on a phone.
test('the supervisor\'s first five minutes on Linen and meals at 390 px: sees what is under level, at zero and the meal waste by ward and meal, and asks for the top-up in one tap; the guide switch leaves the rest working', async () => {
  const { context, page, errors } = await openPage(env, { width: 390, height: 844, touch: true, clock: CLOCK, path: '#/support' });
  await toLinen(page, 'support-supervisor');
  // The status first: under level, at zero, waiting, and meal waste, on the first screen.
  const stats = page.locator('[data-test="linen-stats"]');
  assert.match(await stats.textContent(), /Linen under level\d+items in \d+ areas?Linen at zero now\d+\d+ declaredTop-ups waiting\d+.*Meals returned uneaten\d+%\d+ of \d+ delivered, 7 days/);
  assert.ok((await stats.boundingBox()).y < 844, 'the status starts on the first screen');
  const under = page.locator('[data-test="linen-under"] li[data-area="ward-c1"]');
  assert.match(await under.textContent(), /Ward C1 \(maternity\).*of 30.*No top-up asked for/s);
  assert.match(await page.locator('[data-test="meal-waste"] li[data-ward="ward-b1"]').textContent(), /Ward B1 \(general surgery\)\d+%.*Midday meal: \d+%/s);
  assert.equal(await page.locator('[data-test="meal-waste"] li[data-ward="ward-b1"] [data-meal="midday"]').getAttribute('class'), 'chip sup-below', 'above the usual level is marked');
  assert.match(await page.locator('[data-kpi="linen-stock-outs"]').textContent(), /\d+%\d+ of \d+ area-shifts with a linen item at zero.*Day shift: .*Night shift: .*had no count.*Source: local definition/s);
  assert.match(await page.locator('[data-kpi="meal-waste"]').textContent(), /Source: local definition/);
  assert.match(await page.locator('[data-test="linen-suggestion"][data-rule="meals-returned"]').textContent(), /Check the midday meal numbers ordered for Ward B1 \(general surgery\) with the ward\./);
  assert.ok(await page.locator('[data-test="linen-suggestion"][data-rule="linen-two-counts"]').count() >= 1);
  assert.match(await page.locator('[data-test="linen-manager"] [data-test="levels-note"]').textContent(), /example settings, not a standard/);
  await page.locator('[data-test="to-meal-waste"]').tap();
  await page.waitForFunction(() => { const r = document.querySelector('#lin-meal-h').getBoundingClientRect(); return r.top >= 0 && r.top < 200; });
  // Recording a stock-out: nothing is picked for the person; the button waits for a cause.
  const zero = page.locator('[data-test="linen-zero"] li').first();
  await zero.locator('summary').tap();
  assert.equal(await zero.locator('[data-test="cause"]').inputValue(), '');
  assert.equal(await zero.locator('[data-cmd="ospeli_stock_out_start"]').isDisabled(), true);
  await zero.locator('[data-test="cause"]').selectOption('Not delivered');
  assert.equal(await zero.locator('[data-cmd="ospeli_stock_out_start"]').isDisabled(), false);
  assert.deepEqual(await phoneProblems(page), [], 'the manager view on a phone');
  // Act: one tap asks for exactly what Ward C1 is short of.
  const btn = under.locator('[data-test="manager-ask"]');
  assert.match(await btn.textContent(), /^Ask for a top-up \(\d\)$/);
  await btn.tap();
  await page.waitForFunction(() => !document.querySelector('[data-test="linen-under"] li[data-area="ward-c1"] [data-test="manager-ask"]'));
  const q = await ev(page, 'stock.requested');
  assert.deepEqual([q.data.placeId, q.actorRole, q.data.raisedBy], ['ward-c1', 'support-supervisor', 'request']);
  assert.match(await under.textContent(), /req-\d+: waiting/);
  assert.equal(await page.locator('[data-test="linen-suggestion"][data-id="linen-two-counts:ward-c1"]').count(), 0, 'the offer goes once it is asked for');
  assert.equal(await under.locator('[data-cmd="ospeli_stock_issue"]').count(), 0, 'the store issues it, not the supervisor');
  // The guide off: no suggestion; counts, top-ups, meals and measures the same.
  await page.locator('[data-test="linen-guide-switch"]').tap();
  await page.waitForSelector('[data-test="linen-guide-off"]');
  assert.equal(await page.locator('[data-test="linen-suggestion"]').count(), 0);
  assert.equal(await page.locator('[data-kpi]').count(), 2);
  assert.equal(await page.locator('[data-test="meal-save"]').count(), 1);
  await page.locator('[data-test="linen-guide-switch"]').tap();
  await page.waitForSelector('[data-test="linen-suggestion"]');
  assert.ok(await noSideways(page) <= 0);
  assert.deepEqual(errors, []);
  await context.close();
});

test('Linen and meals: the store issues the top-up from the same screen; a role with no rights sees no action button and says who can', async () => {
  const { context, page, errors } = await openPage(env, { width: 1280, clock: CLOCK, path: '#/support' });
  const req = await page.evaluate(async () => {
    const { runCommand } = await import('/app/core/commands.js');
    return (await runCommand(window.ospeli.core, 'ospeli_stock_request', { placeId: 'ward-c1', lines: [{ itemId: 'blanket', qty: 4 }] }, { type: 'human', role: 'ward-nurse' })).requestId;
  });
  await toLinen(page, 'storekeeper');
  const issue = page.locator(`[data-cmd="ospeli_stock_issue"][data-request="${req}"]`);
  await issue.click();
  await page.waitForFunction((r) => !document.querySelector(`[data-cmd="ospeli_stock_issue"][data-request="${r}"]`), req);
  assert.deepEqual([(await ev(page, 'stock.issued')).subject, (await ev(page, 'stock.issued')).actorRole], [req, 'storekeeper']);
  // Issued is not arrived (#113), and the time is the real one: under a minute is "just now", not "1 h ago".
  await page.evaluate(() => localStorage.setItem('ospeli-support-linen-area', 'ward-c1'));
  await toLinen(page, 'cleaner');
  await page.waitForSelector('[data-item="blanket"] [data-test="on-its-way"]');
  assert.equal(await page.locator('[data-item="blanket"] [data-test="on-its-way"]').textContent(), 'Issued from the store just now: on its way. Count it once it is on the shelf.');
  await page.clock.fastForward('25:00');
  await page.waitForFunction(() => /Issued from the store (25|26) min ago/.test(document.querySelector('[data-item="blanket"] [data-test="on-its-way"]')?.textContent || ''));
  await page.evaluate(() => localStorage.setItem('ospeli-support-linen-area', 'ward-c1'));
  await toLinen(page, 'bed-manager');
  assert.deepEqual(await page.locator('.sup-linen [data-cmd]').count(), 0, 'no action button');
  assert.match(await page.locator('[data-test="linen-count"] [data-test="read-only"]').textContent(), /Patient flow coordinator can see the linen\. It is counted by /);
  assert.match(await page.locator('[data-test="meals"] [data-test="read-only"]').textContent(), /recorded by Ward nurse, Cleaner, Support services supervisor/);
  assert.deepEqual(errors, []);
  await context.close();
});
