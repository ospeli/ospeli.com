// Cleaning and portering in the app (module support): every role and screen with no sideways
// scroll and no console error; a ward asks for help in a few taps; a porter takes the job from
// waiting to done on a 390 px touch screen and the measure changes; a bed vacated on the bed board
// is in the cleaner's queue with no one asking, and finishing it makes the bed available; the
// manager view at 1280 px with the guide and its switch; roles with no rights see no buttons.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, openPage } from './helpers.mjs';

let env;
before(async () => { env = await startApp(); });
after(async () => { await env.close(); });

const CLOCK = '2026-11-10T14:00:00Z';
const noSideways = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
async function asRole(page, role, screen = '') {
  await page.selectOption('#role-select', role);
  await page.waitForFunction((r) => document.querySelector('.sup')?.dataset.role === r, role);
  if (screen) {
    // The page is drawn again for the new address; wait for that drawing, not the one before it.
    await page.evaluate((s) => { if (location.hash !== `#/support/${s}`) { document.querySelector('.sup').dataset.stale = 'true'; location.hash = `#/support/${s}`; } }, screen);
    await page.waitForFunction(([r, s]) => { const x = document.querySelector('.sup'); return x && !x.dataset.stale && x.dataset.role === r && x.dataset.screen === s; }, [role, screen]);
  }
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

const SCREENS = [['porter', 'jobs'], ['porter', 'board'], ['cleaner', 'jobs'], ['cleaner', 'audit'], ['support-supervisor', 'board'], ['support-supervisor', 'audit'],
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

test('a porter opens the app on a 390 px touch screen and takes the first job in the queue from waiting to done; the queue and the measure change', async () => {
  const { context, page, errors } = await openPage(env, { width: 390, height: 844, touch: true, clock: CLOCK, path: '#/support' });
  await asRole(page, 'porter', 'jobs');
  const card = page.locator('[data-test="next-job"]');
  await card.waitFor();
  const id = await card.getAttribute('data-task');
  assert.match(await card.textContent(), /Next job.*Specimen or item run.*Specimen.*Urgent.*to Laboratory.*Waiting/s, 'the urgent job is first');
  const main = page.locator('[data-test="main-action"]');
  const box = await main.boundingBox();
  assert.ok(box.y + box.height <= 844, `the job's button is on the first screen (bottom at ${Math.round(box.y + box.height)} px)`);
  assert.ok(box.height >= 56, `one big button (${box.height} px)`);
  assert.equal(await main.textContent(), 'Collected');
  assert.deepEqual(await phoneProblems(page), [], 'jobs screen: phone rules');
  const counts = async () => (await page.locator('[data-test="queue-counts"]').textContent()).match(/^(\d+) waiting · (\d+) in progress/).slice(1).map(Number);
  const [waiting0, busy0] = await counts();
  assert.ok(waiting0 >= 3 && busy0 >= 1, `a real queue: ${waiting0} waiting, ${busy0} in progress`);
  const measured = () => page.locator('[data-test="team-measure"]').getAttribute('data-n').then(Number);
  const n0 = await measured();
  assert.ok(n0 > 100, 'the measure has thirty days of history');

  await main.tap();
  await page.waitForFunction(() => document.querySelector('[data-test="main-action"]')?.textContent === 'Delivered');
  assert.match(await card.textContent(), /Your job now.*On the way/s);
  assert.equal(await card.getAttribute('data-task'), id);
  assert.deepEqual(await counts(), [waiting0 - 1, busy0 + 1]);
  // The phone is locked and the app opened again: the job this phone started is still on top.
  await page.reload();
  await page.waitForSelector('html[data-ready="true"]');
  await page.waitForFunction((t) => document.querySelector('[data-test="next-job"]')?.dataset.task === t && document.querySelector('[data-test="main-action"]')?.textContent === 'Delivered', id);
  assert.match(await page.locator('[data-test="next-job"]').textContent(), /Your job now/);
  await page.locator('[data-test="main-action"]').tap();
  await page.waitForFunction((n) => Number(document.querySelector('[data-test="team-measure"]')?.dataset.n) === n + 1, n0);
  assert.deepEqual(await counts(), [waiting0 - 1, busy0]);
  assert.notEqual(await page.locator('[data-test="next-job"]').getAttribute('data-task'), id, 'the next job moves up');
  const types = await page.evaluate(async (t) => (await window.ospeli.core.events({ subject: t })).map((e) => [e.type, e.actorRole]), id);
  assert.deepEqual(types.slice(-2), [['task.started', 'porter'], ['task.completed', 'porter']]);
  assert.ok(await noSideways(page) <= 0);
  assert.deepEqual(errors, []);
  await context.close();
});

test('a ward asks for a move in a few taps, sees its place in the queue, and the porter sees the job', async () => {
  const { context, page, errors } = await openPage(env, { width: 390, height: 844, touch: true, clock: CLOCK, path: '#/support' });
  await asRole(page, 'ward-nurse', 'ask');
  await page.tap('[data-kind="patient-move"]');
  await page.selectOption('[data-test="ask-where"]', 'ward-a1');
  await page.selectOption('[data-test="ask-bed"]', 'ward-a1-bed-04');
  await page.selectOption('[data-test="ask-to"]', 'dept-imaging');
  await page.tap('[data-detail="Wheelchair"]');
  await page.tap('[data-test="ask-send"]');
  await page.waitForFunction(() => /^Asked: Patient move, Ward A1 \(acute medicine\), Bed 04\. \d+(st|nd|rd|th) of \d+ waiting for Portering\./.test(document.querySelector('[data-test="ask-status"]').textContent));
  assert.match(await page.locator('[data-test="ask-open"]').textContent(), /\d+(st|nd|rd|th) of \d+ waiting for Portering/, 'the ward sees where its job is in the queue');
  assert.deepEqual(await phoneProblems(page), [], 'ask form: phone rules');
  const asked = await page.evaluate(async () => (await window.ospeli.core.events({ type: 'task.requested' })).at(-1));
  assert.deepEqual([asked.actorRole, asked.data.locationId, asked.data.toLocationId, asked.data.detail], ['ward-nurse', 'ward-a1-bed-04', 'dept-imaging', 'Wheelchair']);

  await asRole(page, 'porter', 'jobs');
  const btn = page.locator(`button[data-task="${asked.subject}"]`);
  await btn.waitFor();
  assert.equal(await btn.textContent(), 'Collected');
  assert.match(await page.locator(`li[data-task="${asked.subject}"]`).textContent(), /From Ward A1 \(acute medicine\), Bed 04 to Imaging/);
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
  assert.ok(await page.locator('.sup-jobs').getByText('Ward A3 (care of older people)').count() >= 1);
  assert.deepEqual(errors, []);
  await context.close();
});

test('a bed vacated on the bed board is in the cleaner\'s queue with no one asking; finishing it makes the bed available', async () => {
  const { context, page, errors } = await openPage(env, { width: 390, touch: true, clock: CLOCK, path: '#/beds' });
  await page.selectOption('#role-select', 'ward-nurse');
  await page.waitForSelector('.bed.st-occupied');
  const bedId = await page.locator('.bed.st-occupied').first().getAttribute('data-bed');
  // The bed board may draw itself once more just after it opens; tap again until the bed's dialog is open.
  for (let i = 0; i < 10 && !(await page.locator('dialog[open]').count()); i++) {
    await page.tap(`.bed[data-bed="${bedId}"]`);
    await page.waitForTimeout(300);
  }
  await page.tap('dialog[open] [data-action="vacate"]');
  await page.waitForFunction((b) => document.querySelector(`.bed[data-bed="${b}"]`)?.classList.contains('st-vacated'), bedId);

  await page.evaluate(() => { location.hash = '#/support'; });
  await asRole(page, 'cleaner', 'jobs');
  const btn = page.locator(`button[data-task="clean-${bedId}"]`);
  await btn.waitFor();
  assert.equal(await btn.textContent(), 'Start clean');
  await btn.tap();
  await page.waitForFunction((id) => document.querySelector(`button[data-task="${id}"]`)?.textContent === 'Clean done: bed ready', `clean-${bedId}`);
  await page.locator(`button[data-task="clean-${bedId}"]`).tap();
  await page.waitForFunction((id) => !document.querySelector(`button[data-task="${id}"]`), `clean-${bedId}`);

  await page.evaluate(() => { location.hash = '#/beds'; });
  await page.waitForFunction((b) => document.querySelector(`.bed[data-bed="${b}"]`)?.classList.contains('st-available'), bedId);
  const types = await page.evaluate(async (b) => (await window.ospeli.core.events({ subject: b })).slice(-3).map((e) => [e.type, e.actorRole]), bedId);
  assert.deepEqual(types, [['bed.vacated', 'ward-nurse'], ['bed.clean-started', 'cleaner'], ['bed.cleaned', 'cleaner']]);
  assert.deepEqual(errors, []);
  await context.close();
});

test('the supervisor\'s board at 1280 px: teams, the guide with its reasons and one switch, the measures with definitions, linen and meals planned', async () => {
  const { context, page, errors } = await openPage(env, { width: 1280, clock: CLOCK, path: '#/support' });
  await asRole(page, 'support-supervisor', 'board');
  await page.waitForSelector('[data-test="team-counts"] .stat');
  assert.equal(await page.locator('[data-test="team-counts"] .stat').count(), 2);
  assert.equal(await page.locator('[data-kpi]').count(), 3);
  assert.match(await page.locator('[data-kpi="cleanliness-audit-score"]').textContent(), /\d+%.*elements passed.*Source: Your site's cleanliness standard \(set locally\)/s);
  assert.match(await page.locator('[data-kpi="support-bed-turnaround"]').textContent(), /example setting, not a standard/);
  assert.equal(await page.locator('[data-test="planned"]').textContent(), 'Linen and meals: planned, not built yet.');
  const sugg = page.locator('[data-test="suggestion"][data-rule="audit-failed-twice"]');
  assert.match(await sugg.textContent(), /Re-audit Ward B2 \(orthopaedics\).*70% and 80%.*Failed both times/s);

  // A job asked for now, to show the board still works with the guide off.
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
  await row.locator('[data-test="to-front"]').click();
  await page.waitForFunction((t) => document.querySelector(`[data-test="board"] li[data-task="${t}"] [data-test="to-front"]`)?.textContent === 'Back in order', id);
  assert.match(await row.textContent(), /Urgent/);
  // A job already in progress has no "move to the front": the order matters only while it waits.
  await row.locator('[data-cmd="ospeli_tasks_start"]').click();
  await page.waitForFunction((t) => document.querySelector(`[data-test="board"] li[data-task="${t}"] [data-cmd="ospeli_tasks_complete"]`), id);
  assert.equal(await row.locator('[data-test="to-front"]').count(), 0);
  await page.click('[data-test="guide-switch"]');
  await page.waitForSelector('[data-test="suggestion"]');
  assert.ok(await noSideways(page) <= 0);
  assert.deepEqual(errors, []);
  await context.close();
});

test('a cleaning audit on a phone: area, risk category, pass or fail per element, saved with its score and what needs action', async () => {
  const { context, page, errors } = await openPage(env, { width: 390, touch: true, clock: CLOCK, path: '#/support' });
  await asRole(page, 'support-supervisor', 'audit');
  assert.match(await page.locator('[data-test="aud-note"]').textContent(), /example set, set locally, not a standard/);
  await page.selectOption('[data-test="aud-where"]', 'ward-a3');
  await page.waitForFunction(() => document.querySelector('[data-risk="high"]')?.getAttribute('aria-pressed') === 'true'); // its last category
  await page.tap('[data-element="curtains"] [data-mark="fail"]');
  await page.tap('[data-test="aud-rest"]');
  assert.equal(await page.locator('[data-test="aud-score"]').textContent(), '9 of 10 passed: 90%');
  assert.deepEqual(await phoneProblems(page), [], 'audit screen: phone rules');
  await page.tap('[data-test="aud-save"]');
  await page.waitForFunction(() => /Saved: Ward A3 \(care of older people\), 90%/.test(document.querySelector('[data-test="aud-result"]')?.textContent));
  assert.match(await page.locator('[data-test="aud-result"]').textContent(), /Needs action:.*Curtains and screens/s);
  await page.waitForFunction(() => document.querySelector('[data-area="ward-a3"]')?.textContent.includes('90%'));
  const ev = await page.evaluate(async () => (await window.ospeli.core.events({ type: 'support.audit-recorded' })).at(-1));
  assert.deepEqual([ev.subject, ev.actorRole, ev.data.riskCategory, ev.data.failed], ['ward-a3', 'support-supervisor', 'high', ['curtains']]);
  assert.deepEqual(errors, []);
  await context.close();
});

test('a role with no rights sees no action button, and one line that says who can', async () => {
  const { context, page, errors } = await openPage(env, { width: 1280, clock: CLOCK, path: '#/support' });
  await page.evaluate(async () => {
    const { runCommand } = await import('/app/core/commands.js');
    await runCommand(window.ospeli.core, 'ospeli_tasks_request', { kind: 'patient-move', locationId: 'ward-a1', toLocationId: 'dept-imaging', detail: 'Bed' }, { type: 'human', role: 'ward-nurse' });
  });
  await asRole(page, 'estates-tech', 'board');
  await page.waitForSelector('[data-test="board"] [data-task]');
  assert.equal(await page.locator('.sup [data-cmd^="ospeli_tasks_"], .sup [data-cmd^="ospeli_support_"]').count(), 0);
  assert.match(await page.locator('[data-test="read-only"]').textContent(), /Facilities technician can see the board/);
  assert.match(await page.locator('[data-test="guide"]').textContent(), /can switch the guide on or off/);
  await asRole(page, 'estates-tech', 'audit');
  assert.equal(await page.locator('[data-test="aud-save"]').count(), 0);
  assert.match(await page.locator('[data-test="read-only"]').textContent(), /Audits are recorded by the Support services supervisor/);
  // A porter does porter jobs only: no button on a cleaning job, no audit form.
  await asRole(page, 'porter', 'board');
  await page.waitForSelector('[data-test="board"] [data-task]');
  assert.equal(await page.locator('[data-test="board"] [data-team="cleaning"] [data-cmd]').count(), 0);
  assert.ok(await page.locator('[data-test="board"] [data-team="portering"] [data-cmd="ospeli_tasks_start"]').count() >= 1);
  assert.equal(await page.locator('[data-test="to-front"]').count(), 0);
  assert.equal(await page.locator('[data-screen="audit"]').count(), 0, 'no audit screen in the porter\'s menu');
  assert.deepEqual(errors, []);
  await context.close();
});
