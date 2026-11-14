// Engineering (backlog item 7): report a fault from a label link, work the queue as the
// facilities technician, and keep the KPIs in step. Phone and desktop.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, openPage } from './helpers.mjs';

let env;
before(async () => { env = await startApp(); });
after(async () => { await env.close(); });

const noSideways = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
const openCount = (page) => page.locator('[data-test="wo-open"] b').textContent().then(Number);

for (const width of [390, 1280]) {
  test(`ward nurse reports a fault from the asset's label link (${width}px)`, async () => {
    const { context, page, errors } = await openPage(env, { width, path: '#/engineering/report/asset-a1-sink-1' });
    await page.waitForSelector('[data-test="wo-open"] b');
    assert.equal(await page.inputValue('[data-test="f-loc"]'), 'ward-a1');
    assert.equal(await page.inputValue('[data-test="f-asset"]'), 'asset-a1-sink-1');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'f-fault', 'the label link lands on the fault list');
    const before = await openCount(page);
    await page.selectOption('[data-test="f-fault"]', 'Tap leaking');
    await page.locator('.prio-opt', { hasText: 'High' }).click();
    await page.click('[data-cmd="ospeli_workorders_report_fault"]');
    await page.waitForFunction(() => /^Reported: WO-\d{5}/.test(document.querySelector('[data-test="report-status"]').textContent));
    await page.waitForFunction((n) => Number(document.querySelector('[data-test="wo-open"] b').textContent) === n + 1, before);
    const ev = await page.evaluate(async () => (await window.ospeli.core.events({ type: 'asset.fault-reported' })).at(-1));
    assert.equal(ev.subject, 'asset-a1-sink-1');
    assert.equal(ev.actorRole, 'ward-nurse');
    assert.deepEqual({ title: ev.data.title, priority: ev.data.priority, trade: ev.data.trade }, { title: 'Tap leaking', priority: 'high', trade: 'estates' });
    const tile = page.locator(`[data-wo="${ev.data.workOrder}"]`);
    assert.match(await tile.textContent(), /Tap leaking.*Due in (23 h 59 min|24 h)/s);
    const heights = await page.locator('form [data-cmd], .prio-opt, form select').evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().height)));
    assert.ok(heights.every((x) => x >= 44), `tap targets ${heights.join(',')}`);
    assert.ok(await noSideways(page) <= 0);
    assert.deepEqual(errors, []);
    await context.close();
  });
}

test('facilities technician sees the queue first, assigns and closes a work order; the KPI tile follows', async () => {
  const { context, page, errors } = await openPage(env, { width: 390, path: '#/engineering' });
  await page.selectOption('#role-select', 'estates-tech');
  await page.waitForFunction(() => document.querySelector('main h2')?.textContent === 'Work-order queue');
  await page.waitForSelector('[data-test="wo-list"] [data-wo]');
  await page.waitForFunction(() => document.querySelector('[data-kpi="open-work-orders"]'));
  const order = await page.evaluate(() => [...document.querySelectorAll('main h2')].map((x) => x.textContent));
  assert.ok(order.indexOf('Work-order queue') < order.indexOf('Report a fault'), `queue first for the facilities technician: ${order.join(' / ')}`);
  const before = await openCount(page);
  assert.equal(Number(await page.locator('[data-kpi="open-work-orders"] .kpi-value').textContent()), before, 'KPI tile equals the queue count');

  const first = page.locator('[data-test="wo-list"] [data-wo]').first();
  const id = await first.getAttribute('data-wo');
  await first.click();
  await page.waitForSelector('dialog[open]');
  assert.match(await page.locator('dialog[open] .label-link').textContent(), /#\/engineering\/report\/asset-/);
  await page.selectOption('#wo-team', 'contractor');
  await page.click('dialog[open] [data-cmd="ospeli_workorders_assign"]');
  await page.waitForFunction((wo) => document.querySelector(`[data-wo="${wo}"]`)?.textContent.includes('External contractor'), id);
  await page.click(`[data-wo="${id}"]`);
  await page.waitForSelector('dialog[open]');
  await page.selectOption('#wo-outcome', 'fixed');
  await page.click('dialog[open] [data-cmd="ospeli_workorders_complete"]');
  await page.waitForFunction((n) => Number(document.querySelector('[data-test="wo-open"] b').textContent) === n - 1, before);
  await page.waitForFunction((n) => Number(document.querySelector('[data-kpi="open-work-orders"] .kpi-value')?.textContent) === n - 1, before);
  const types = await page.evaluate(async (wo) => (await window.ospeli.core.events()).filter((e) => e.subject === wo).map((e) => [e.type, e.actorRole]), id);
  assert.deepEqual(types.slice(-2), [['workorder.assigned', 'estates-tech'], ['workorder.completed', 'estates-tech']]);
  await page.click('[data-filter="completed"]');
  assert.match(await page.locator(`[data-wo="${id}"]`).textContent(), /Fixed/);
  assert.ok(await noSideways(page) <= 0);
  assert.deepEqual(errors, []);
  await context.close();
});

test('the COO can read the queue but has no report form or work-order actions', async () => {
  const { context, page, errors } = await openPage(env, { path: '#/engineering' });
  await page.selectOption('#role-select', 'coo');
  await page.waitForSelector('[data-test="wo-list"] [data-wo]');
  await page.waitForFunction(() => !document.querySelector('[data-test="report-form"]'));
  await page.locator('[data-test="wo-list"] [data-wo]').first().click();
  await page.waitForSelector('dialog[open]');
  assert.equal(await page.locator('dialog[open] [data-cmd]').count(), 0);
  assert.match(await page.locator('dialog[open]').textContent(), /COO can see this work order but not change it/);
  assert.deepEqual(errors, []);
  await context.close();
});

// Issue #28: a role that cannot assign or close saw the text "nullnull" in the work-order dialog.
// Every role opens an open and a completed work order; no dialog may show "null" or "undefined".
test('work-order dialog never shows "null" or "undefined", for every role (issue #28)', async () => {
  const { context, page, errors } = await openPage(env, { width: 360, height: 780, path: '#/engineering', clock: '2026-11-10T10:00:00Z' });
  await page.waitForSelector('[data-test="wo-list"] [data-wo]');
  const roles = await page.evaluate(() => [...document.querySelector('#role-select').options].map((o) => o.value));
  assert.ok(roles.length >= 6);
  for (const role of roles) {
    await page.selectOption('#role-select', role);
    await page.waitForFunction(async (r) => (await window.ospeli.core.getMeta('role')) === r, role);
    // The page is drawn again for the new role and swapped in when it is ready. Wait for that queue,
    // so the test never taps a row from the page for the role before.
    await page.waitForSelector(`[data-test="wo-queue"][data-role="${role}"] [data-test="wo-list"] [data-wo]`);
    for (const filter of ['open', 'completed']) {
      const chip = page.locator(`.chip-btn[data-filter="${filter}"]`);
      if (!(await chip.count())) continue;
      await chip.click();
      const row = page.locator('[data-test="wo-list"] [data-wo]').first();
      if (!(await row.count())) continue;
      await row.click();
      await page.waitForSelector('dialog[open]');
      const text = await page.locator('dialog[open]').innerText();
      assert.doesNotMatch(text, /\bnull|undefined\b/, `${role}, ${filter}: ${text.slice(0, 200)}`);
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !document.querySelector('dialog[open]'));
    }
  }
  assert.deepEqual(errors, []);
  await context.close();
});

// Issue #24: reporting the same fault twice opened a second work order (and counted it as a
// repeat fault). The second report now says the fault is already in the queue and leads to it.
test('the same fault reported twice: "Already reported", one work order, and a way to see it (390px, touch) (issue #24)', async () => {
  const { context, page, errors } = await openPage(env, { width: 390, height: 780, touch: true, path: '#/engineering/report/asset-a1-sink-1', clock: '2026-11-10T10:00:00Z' });
  await page.waitForSelector('[data-test="wo-open"] b');
  const before = await openCount(page);
  const status = page.locator('[data-test="report-status"]');
  await page.selectOption('[data-test="f-fault"]', 'Tap leaking');
  await page.locator('[data-cmd="ospeli_workorders_report_fault"]').tap();
  await page.waitForFunction(() => /^Reported: WO-\d{5}/.test(document.querySelector('[data-test="report-status"]').textContent));
  const id = (await status.textContent()).match(/WO-\d{5}/)[0];
  await page.waitForFunction((n) => Number(document.querySelector('[data-test="wo-open"] b').textContent) === n + 1, before);
  // (This sink was fixed earlier in the month, so the first report may itself be a genuine repeat.)
  const repeatsAfterFirst = Number(await page.locator('[data-test="wo-repeat"] b').textContent());

  // A second nurse (or a second tap) reports the same fault on the same sink.
  await page.locator('[data-cmd="ospeli_workorders_report_fault"]').tap();
  await page.waitForFunction(() => /^Already reported/.test(document.querySelector('[data-test="report-status"]').textContent));
  assert.equal(await status.textContent(), `Already reported: ${id} is open for this fault. No new work order was opened.`);
  const reports = await page.evaluate(async () => (await window.ospeli.core.events({ type: 'asset.fault-reported' })).filter((e) => e.subject === 'asset-a1-sink-1' && e.data.title === 'Tap leaking').length);
  assert.equal(reports, 1, 'one fault-reported event');
  assert.equal(await openCount(page), before + 1, 'the open count went up by one, not two');
  assert.equal(Number(await page.locator('[data-test="wo-repeat"] b').textContent()), repeatsAfterFirst, 'a duplicate is not a repeat fault');
  assert.equal(Number(await page.locator('[data-kpi="open-work-orders"] .kpi-value').textContent()), before + 1, 'the KPI tile agrees');
  assert.equal(await page.locator('[data-test="wo-list"] [data-wo]').filter({ hasText: 'Tap leaking' }).count(), 1, 'one card in the queue');

  // No dead end: a button, tall enough to tap, opens that work order.
  const see = page.locator('[data-test="see-existing"]');
  assert.equal(await see.textContent(), `See ${id}`);
  const box = await see.boundingBox();
  assert.ok(box.height >= 44, `tap target ${box.height}px`);
  await see.tap();
  await page.waitForSelector('dialog[open]');
  assert.match(await page.locator('dialog[open] h2').textContent(), new RegExp(`^${id} · Tap leaking$`));
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('dialog[open]'));

  // A different fault on the same sink still opens, and clears the "Already reported" line.
  await page.selectOption('[data-test="f-fault"]', 'Other fault (describe to the team in person)');
  await page.locator('[data-cmd="ospeli_workorders_report_fault"]').tap();
  await page.waitForFunction(() => /^Reported: WO-\d{5}/.test(document.querySelector('[data-test="report-status"]').textContent));
  assert.equal(await see.count(), 0);
  assert.ok(await noSideways(page) <= 0);

  // It fits the smallest phone too.
  await page.setViewportSize({ width: 360, height: 780 });
  await page.selectOption('[data-test="f-fault"]', 'Tap leaking');
  await page.locator('[data-cmd="ospeli_workorders_report_fault"]').tap();
  await page.waitForSelector('[data-test="see-existing"]');
  const fit = await page.evaluate(() => ['[data-test="report-status"]', '[data-test="see-existing"]'].map((sel) => { const r = document.querySelector(sel).getBoundingClientRect(); return r.left >= 0 && r.right <= window.innerWidth; }));
  assert.deepEqual(fit, [true, true]);
  assert.ok(await noSideways(page) <= 0);
  assert.deepEqual(errors, []);
  await context.close();
});

test('a fault that comes back after a fix is a repeat fault, in plain words (issue #24)', async () => {
  const { context, page, errors } = await openPage(env, { width: 390, height: 780, path: '#/engineering/report/asset-a1-sink-1', clock: '2026-11-10T10:00:00Z' });
  await page.waitForSelector('[data-test="wo-open"] b');
  const repeatsBefore = Number(await page.locator('[data-test="wo-repeat"] b').textContent());
  const report = async () => {
    await page.selectOption('[data-test="f-fault"]', 'Tap leaking');
    await page.click('[data-cmd="ospeli_workorders_report_fault"]');
    await page.waitForFunction(() => /^Reported: WO-\d{5}/.test(document.querySelector('[data-test="report-status"]').textContent));
    return (await page.locator('[data-test="report-status"]').textContent());
  };
  // This sink already had fixes in the synthetic month; count them from what the screen says.
  const fixes = (text) => Number(text.match(/Failed again after a fix: (\d+) earlier fix(es)? of this fault on this asset in 30 days\.$/)?.[1] ?? 0);
  const first = await report();
  const earlier = fixes(first);
  const id = first.match(/WO-\d{5}/)[0].toLowerCase();
  await page.waitForSelector(`[data-wo="${id}"]`);
  // The page is drawn again for the new role; mark the old queue so the test waits for the new one.
  await page.evaluate(() => { document.querySelector('[data-test="wo-list"]').dataset.old = '1'; });
  await page.selectOption('#role-select', 'estates-tech');
  await page.waitForSelector(`[data-test="wo-list"]:not([data-old]) [data-wo="${id}"]`);
  await page.click(`[data-wo="${id}"]`);
  await page.waitForSelector('dialog[open]');
  await page.selectOption('#wo-outcome', 'fixed');
  await page.click('dialog[open] [data-cmd="ospeli_workorders_complete"]');
  await page.waitForFunction((wo) => !document.querySelector(`[data-wo="${wo}"]`), id);
  const second = await report();
  assert.match(second, /Repeat fault\. Failed again after a fix: \d+ earlier fix(es)? of this fault on this asset in 30 days\.$/);
  assert.equal(fixes(second), earlier + 1, 'one more fix than before');
  const id2 = second.match(/WO-\d{5}/)[0].toLowerCase();
  await page.waitForFunction((n) => Number(document.querySelector('[data-test="wo-repeat"] b').textContent) === n + 1, repeatsBefore);
  assert.match(await page.locator(`[data-wo="${id2}"]`).textContent(), new RegExp(`Repeat: ${earlier + 1} earlier fix(es)?$`), 'the badge uses the same number as the sentence (issue #75)');
  await page.click(`[data-wo="${id2}"]`);
  await page.waitForSelector('dialog[open]');
  assert.match(await page.locator('dialog[open]').innerText(), new RegExp(`Failed again after a fix: ${earlier + 1} earlier fix(es)? of this fault on this asset in 30 days`));
  assert.ok(await noSideways(page) <= 0);
  assert.deepEqual(errors, []);
  await context.close();
});

// Issue #75: "No fault found" and a different fault are not a repeat fault.
test('at 390 px: a work order closed as "No fault found", then a different fault on the same asset, is not a repeat (issue #75)', async () => {
  const { context, page, errors } = await openPage(env, { width: 390, height: 780, touch: true, path: '#/engineering/report/asset-a1-sink-1', clock: '2026-11-10T10:00:00Z' });
  await page.waitForSelector('[data-test="wo-open"] b');
  const repeats = () => page.locator('[data-test="wo-repeat"] b').textContent().then(Number);
  const before = await repeats();
  const report = async (fault) => {
    await page.selectOption('[data-test="f-fault"]', fault);
    await page.locator('[data-cmd="ospeli_workorders_report_fault"]').tap();
    await page.waitForFunction((f) => new RegExp(`^Reported: WO-\\d{5}, ${f.slice(0, 11)}`).test(document.querySelector('[data-test="report-status"]').textContent), fault);
    return page.locator('[data-test="report-status"]').textContent();
  };
  // This sink may already have a fixed "Blocked sink" in the pinned month; the first report says so if it has.
  const first = await report('Blocked sink');
  const firstWasRepeat = /Repeat fault/.test(first);
  const id = first.match(/WO-\d{5}/)[0].toLowerCase();
  await page.evaluate(() => { document.querySelector('[data-test="wo-list"]').dataset.old = '1'; });
  await page.selectOption('#role-select', 'estates-tech');
  await page.waitForSelector(`[data-test="wo-list"]:not([data-old]) [data-wo="${id}"]`);
  await page.locator(`[data-wo="${id}"]`).tap();
  await page.waitForSelector('dialog[open]');
  await page.selectOption('#wo-outcome', 'no-fault-found');
  await page.locator('dialog[open] [data-cmd="ospeli_workorders_complete"]').tap();
  await page.waitForFunction((wo) => !document.querySelector(`[data-wo="${wo}"]`), id);
  assert.equal(await repeats(), before, 'closing the first work order leaves the count where it was');
  const second = await report('Other fault (describe to the team in person)');
  assert.doesNotMatch(second, /Repeat fault/);
  const id2 = second.match(/WO-\d{5}/)[0].toLowerCase();
  await page.waitForSelector(`[data-wo="${id2}"]`);
  assert.doesNotMatch(await page.locator(`[data-wo="${id2}"]`).textContent(), /Repeat/);
  assert.equal(await repeats(), before, '"Repeat faults open" does not move');
  // The same fault again after "No fault found" is not a repeat either, unless it was one before.
  const third = await report('Blocked sink');
  assert.equal(/Repeat fault/.test(third), firstWasRepeat);
  // Every repeat badge in the queue says the same number as its dialog.
  const badges = await page.locator('[data-test="wo-list"] .chip.repeat').allTextContents();
  assert.ok(badges.every((b) => /^Repeat: \d+ earlier fix(es)?$/.test(b)), badges.join(' | '));
  if (badges.length) {
    const n = badges[0].match(/\d+/)[0];
    await page.locator('[data-test="wo-list"] li:has(.chip.repeat) [data-wo], [data-test="wo-list"] [data-wo]:has(.chip.repeat)').first().tap();
    await page.waitForSelector('dialog[open]');
    assert.match(await page.locator('dialog[open]').innerText(), new RegExp(`Failed again after a fix: ${n} earlier fix(es)? of this fault on this asset in 30 days`));
  }
  assert.match(await page.locator('[data-test="queue-rules"]').innerText(), /same fault on the same asset.*closed as Fixed.*Not counted: "No fault found", a different fault/);
  assert.ok(await noSideways(page) <= 0);
  assert.deepEqual(errors, []);
  await context.close();
});

// ---- Issue #83: the facilities technician's "do next" queue ----
// Synthetic faults for the facilities team, reported through the command as a ward nurse (two
// urgent, two high, one routine); then 30 hours pass, so the urgent and high ones are late.
async function seedJobs(page) {
  await page.evaluate(async () => {
    const { runCommand } = await import('/app/core/commands.js');
    const nurse = { type: 'human', role: 'ward-nurse' };
    for (const [assetId, fault, priority] of [['asset-a1-sink-1', 'Tap leaking', 'urgent'], ['asset-b1-sink-1', 'Tap leaking', 'high'], ['asset-a1-light-1', 'Tripped breaker', 'urgent'],
      ['asset-b1-door-closer-1', 'Door will not latch', 'high'], ['asset-a2-ac-1', 'AC not cooling', 'routine']]) await runCommand(window.ospeli.core, 'ospeli_workorders_report_fault', { assetId, fault, priority }, nurse);
  });
  await page.clock.fastForward('30:00:00');
}
async function asTechnician(page) {
  await seedJobs(page);
  await page.selectOption('#role-select', 'estates-tech');
  await page.waitForSelector('[data-test="wo-queue"][data-role="estates-tech"] [data-test="next-card"][data-mode="suggest"]');
  await page.waitForSelector('[data-test="wo-list"] [data-wo]');
}
// What the suggestion must be, worked out again from the event log alone.
const expectedNext = (page, skip = 0) => page.evaluate(async (n) => {
  const { deriveWorkOrders, suggestNext } = await import('/app/core/workorders.js');
  const s = suggestNext(deriveWorkOrders(await window.ospeli.core.events(), new Date().toISOString()), { team: 'estates', skip: n, now: new Date().toISOString() });
  return { id: s.workOrder?.id ?? null, title: s.workOrder?.title ?? null, position: s.position, total: s.total, reason: s.reason };
}, skip);
// Visible text smaller than 15 px, and tap targets shorter than 44 px, inside one part of the page.
const tooSmall = (page, scope) => page.evaluate((sel) => {
  const root = document.querySelector(sel);
  const seen = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none'; };
  const text = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!n.textContent.trim() || !seen(n.parentElement)) continue;
    const px = parseFloat(getComputedStyle(n.parentElement).fontSize);
    if (px < 15) text.push(`${px}px "${n.textContent.trim().slice(0, 30)}"`);
  }
  const targets = [...root.querySelectorAll('button, a[href], select, input, summary')].filter(seen)
    .map((el) => [Math.round(el.getBoundingClientRect().height), (el.textContent || el.id).trim().slice(0, 30)]).filter(([hgt]) => hgt < 44).map(([hgt, t]) => `${hgt}px "${t}"`);
  return { text, targets };
}, scope);

test('first-time user at 360 px: the facilities technician sees the next job, starts it and closes it in 3 taps (issue #83)', async () => {
  const { context, page, errors } = await openPage(env, { width: 360, height: 780, touch: true, clock: '2026-11-10T10:00:00Z', path: '#/engineering' });
  await asTechnician(page);
  const card = page.locator('[data-test="next-card"]');
  const want = await expectedNext(page);
  assert.ok(want.total >= 5, `jobs waiting for the facilities team: ${want.total}`);

  // The card is on the first screen, with everything the issue lists.
  assert.equal(await page.evaluate(() => window.scrollY), 0, 'nothing was scrolled');
  const start = card.locator('[data-cmd="ospeli_workorders_start"]');
  const box = await start.boundingBox();
  assert.ok(box.y + box.height <= 780, `Start job ends at ${Math.round(box.y + box.height)} px, inside the first 780 px`);
  assert.ok(box.height >= 44 && box.width >= 200, `a big button: ${Math.round(box.width)} x ${Math.round(box.height)}`);
  assert.equal(await start.textContent(), 'Start job');
  assert.equal(await card.getAttribute('data-job'), want.id);
  assert.equal(await card.locator('h3').textContent(), want.title);
  assert.equal(await card.locator('h3').textContent(), 'Tap leaking');
  assert.match(await card.locator('.next-where').textContent(), /Clinical hand-wash sink 1 · Ward A1/, 'the place');
  assert.equal(await card.locator('.chip.pr-urgent').textContent(), 'Urgent');
  assert.match(await card.locator('.late-n').textContent(), /^Late by 26 h( \d+ min)?$/, 'how late it is, as a number');
  assert.equal(await card.locator('[data-test="next-why"]').textContent(), want.reason);
  assert.equal(want.reason, 'Why this one: urgent, and the most late of the 2 urgent jobs.');
  assert.equal(await card.locator('[data-test="you-decide"]').textContent(), 'You decide');
  assert.equal(await card.locator('[data-test="pick-another"]').textContent(), 'Pick another');
  assert.match(await card.locator('[data-test="next-pos"]').textContent(), new RegExp(`^1 of ${want.total}\\b`));
  assert.match(await card.locator('[data-test="next-rule"]').textContent(), /fixed rule, not AI: highest priority first, then the most late\. It works with AI off\./);
  // One line replaces the three count tiles, and it equals the log.
  const counts = await page.evaluate(async () => {
    const { deriveWorkOrders } = await import('/app/core/workorders.js');
    const open = [...deriveWorkOrders(await window.ospeli.core.events(), new Date().toISOString()).values()].filter((w) => w.state !== 'completed');
    return { open: open.length, late: open.filter((w) => w.overdue).length, repeat: open.filter((w) => w.repeat > 0).length };
  });
  assert.equal((await page.locator('[data-test="wo-counts"]').innerText()).replace(/\s+/g, ' '), `${counts.open} open · ${counts.late} late · ${counts.repeat} repeat fault${counts.repeat === 1 ? '' : 's'}`);
  assert.equal(await page.locator('[data-test="wo-counts"]').evaluate((el) => Math.round(el.getBoundingClientRect().height)) <= 30, true, 'the summary is one line');
  assert.equal(await page.locator('.stat').count(), 0, 'no count tiles');

  // Tap 1: Start job. The card becomes the job in progress.
  let taps = 0;
  await start.tap(); taps += 1;
  await page.waitForSelector(`[data-test="next-card"][data-mode="started"][data-job="${want.id}"]`);
  assert.match(await card.innerText(), /Job in progress/);
  assert.equal(await card.locator('h3').textContent(), 'Tap leaking');
  const close = card.locator('[data-test="close-job"]');
  assert.equal(await close.textContent(), 'Close job');
  const closeBox = await close.boundingBox();
  assert.ok(closeBox.y + closeBox.height <= 780 && closeBox.height >= 44, 'Close job is on the first screen');
  await page.waitForSelector(`[data-wo="${want.id}"] .chip.wo-started`);
  assert.equal(await page.locator(`[data-wo="${want.id}"] .chip.wo-started`).textContent(), 'In progress');
  assert.doesNotMatch(await card.innerText(), /\bnull|undefined\b/);
  // Tap 2: Close job. Tap 3: the outcome, from the same list as before.
  await close.tap(); taps += 1;
  assert.deepEqual(await card.locator('[data-cmd="ospeli_workorders_complete"]').allTextContents(), ['Fixed', 'Escalated', 'No fault found']);
  const outcomes = await card.locator('[data-cmd="ospeli_workorders_complete"]').evaluateAll((els) => els.map((e) => { const r = e.getBoundingClientRect(); return r.height >= 44 && r.bottom <= 780; }));
  assert.deepEqual(outcomes, [true, true, true], 'each outcome is a full tap target on the first screen');
  await card.locator('[data-cmd="ospeli_workorders_complete"][data-outcome="fixed"]').tap(); taps += 1;
  assert.ok(taps <= 4, `${taps} taps`);

  // The next suggestion appears, and it is the one the rule gives.
  await page.waitForFunction((old) => { const c = document.querySelector('[data-test="next-card"]'); return c.dataset.mode === 'suggest' && c.dataset.job !== old; }, want.id);
  const next = await expectedNext(page);
  assert.equal(await card.getAttribute('data-job'), next.id);
  assert.equal(await card.locator('h3').textContent(), 'Tripped breaker');
  assert.equal(next.total, want.total - 1);
  assert.match(await card.locator('[data-test="next-pos"]').textContent(), new RegExp(`^1 of ${next.total}\\b`));
  assert.equal(await page.locator(`[data-wo="${want.id}"]`).count(), 0, 'the closed job left the open list');

  // The log holds both events, as the role and with no person.
  const evs = await page.evaluate(async (wo) => (await window.ospeli.core.events()).filter((e) => e.subject === wo), want.id);
  assert.deepEqual(evs.map((e) => [e.type, e.actorRole]), [['workorder.started', 'estates-tech'], ['workorder.completed', 'estates-tech']]);
  assert.equal(evs[1].data.outcome, 'fixed');
  assert.ok(evs.every((e) => !('actor' in e) && Object.keys(e.data).every((k) => ['asset', 'outcome'].includes(k))), 'no person in the events');
  assert.equal(Number(await page.locator('[data-test="wo-open"] b').textContent()), counts.open - 1);
  await page.waitForFunction((n) => Number(document.querySelector('[data-kpi="open-work-orders"] .kpi-value')?.textContent) === n, counts.open - 1);
  assert.ok(await noSideways(page) <= 0);
  assert.deepEqual(errors, []);
  await context.close();
});

test('Pick another shows the next job by the same rule, counts "2 of N", and records nothing (issue #83)', async () => {
  const { context, page, errors } = await openPage(env, { width: 360, height: 780, touch: true, clock: '2026-11-10T10:00:00Z', path: '#/engineering' });
  await asTechnician(page);
  const card = page.locator('[data-test="next-card"]');
  const [first, second] = [await expectedNext(page, 0), await expectedNext(page, 1)];
  const events = await page.evaluate(() => window.ospeli.core.eventCount());
  assert.equal(await card.getAttribute('data-job'), first.id);
  await card.locator('[data-test="pick-another"]').tap();
  await page.waitForSelector(`[data-test="next-card"][data-job="${second.id}"]`);
  assert.notEqual(second.id, first.id);
  assert.match(await card.locator('[data-test="next-pos"]').textContent(), new RegExp(`^2 of ${first.total}\\b`));
  assert.equal(await card.locator('[data-test="next-why"]').textContent(), second.reason);
  assert.match(second.reason, new RegExp(`^Why this one: next by the same rule \\(2 of ${first.total}\\)\\. Urgent, late by 26 h`));
  assert.equal(await page.evaluate(() => document.activeElement?.dataset.test), 'pick-another', 'focus stays on Pick another');
  // It goes round: after the last job comes the first again.
  for (let i = 2; i <= first.total; i++) {
    const want = await expectedNext(page, i);
    await card.locator('[data-test="pick-another"]').tap();
    await page.waitForFunction(([id, pos]) => { const c = document.querySelector('[data-test="next-card"]'); return c.dataset.job === id && c.querySelector('[data-test="next-pos"]').textContent.startsWith(`${pos} of `); }, [want.id, want.position]);
  }
  assert.equal(await card.getAttribute('data-job'), first.id);
  assert.equal(await page.evaluate(() => window.ospeli.core.eventCount()), events, 'looking at another job writes no event');
  // Start the one picked, not the one suggested: the person decides.
  await card.locator('[data-test="pick-another"]').tap();
  await page.waitForSelector(`[data-test="next-card"][data-job="${second.id}"]`);
  await card.locator('[data-cmd="ospeli_workorders_start"]').tap();
  await page.waitForSelector(`[data-test="next-card"][data-mode="started"][data-job="${second.id}"]`);
  // While a job is in progress the next suggestion is one tap away, and so is the way back.
  await card.locator('[data-test="see-suggestion"]').tap();
  await page.waitForSelector(`[data-test="next-card"][data-mode="suggest"][data-job="${first.id}"]`);
  await card.getByText('Back to the job in progress (1)').tap();
  await page.waitForSelector(`[data-test="next-card"][data-mode="started"][data-job="${second.id}"]`);
  assert.deepEqual(errors, []);
  await context.close();
});

for (const width of [360, 390]) {
  test(`the list at ${width} px: groups, sort switch, lateness as a number and a bar, tags only where they matter, sizes (issue #83)`, async () => {
    const { context, page, errors } = await openPage(env, { width, height: 780, touch: true, clock: '2026-11-10T10:00:00Z', path: '#/engineering' });
    await asTechnician(page);
    const list = page.locator('[data-test="wo-list"]');
    const rows = () => list.locator('[data-wo]').evaluateAll((els) => els.map((e) => e.dataset.wo));
    const fromLog = (sort) => page.evaluate(async (how) => {
      const { runCommand } = await import('/app/core/commands.js');
      const { sortWorkOrders } = await import('/app/core/workorders.js');
      const q = await runCommand(window.ospeli.core, 'ospeli_workorders_list', { state: 'open', limit: 500 }, { type: 'human', role: 'estates-tech' });
      return sortWorkOrders(q.workOrders, how).map((g) => [g.name, g.items.map((w) => w.id)]);
    }, sort);

    // Priority (the default): Urgent, High, Routine; the most late first in each.
    const byPriority = await fromLog('priority');
    assert.deepEqual(byPriority.map(([name]) => name), ['Urgent', 'High', 'Routine']);
    assert.deepEqual(await list.locator('h3').evaluateAll((els) => els.map((e) => e.firstChild.textContent)), ['Urgent', 'High', 'Routine']);
    assert.deepEqual(await rows(), byPriority.flatMap(([, ids]) => ids));
    const sorts = page.locator('[data-sort]');
    assert.deepEqual(await sorts.allTextContents(), ['Priority', 'Most late', 'Ward']);
    assert.deepEqual(await sorts.evaluateAll((els) => els.map((e) => e.getAttribute('aria-pressed'))), ['true', 'false', 'false']);
    assert.ok((await sorts.evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().height)))).every((x) => x >= 44));
    // Most late: one list, the most late at the top, whatever its priority.
    await page.locator('[data-sort="late"]').tap();
    const byLate = await fromLog('late');
    assert.deepEqual(await rows(), byLate[0][1]);
    assert.notDeepEqual(await rows(), byPriority.flatMap(([, ids]) => ids), 'the order changed');
    assert.equal(await list.locator('h3').count(), 0);
    const late = await list.locator('.late-n').allTextContents();
    assert.match(late[0], /^Routine · Late by 3 d 16 h$/, 'with no group heading, each row says its priority in words');
    // Ward: grouped by place name.
    await page.locator('[data-sort="ward"]').tap();
    const byWard = await fromLog('ward');
    assert.deepEqual(await list.locator('h3').evaluateAll((els) => els.map((e) => e.firstChild.textContent)), byWard.map(([name]) => name));
    assert.deepEqual(await rows(), byWard.flatMap(([, ids]) => ids));
    assert.ok(byWard.length >= 4 && byWard.every(([name], i) => i === 0 || byWard[i - 1][0].localeCompare(name, 'en', { numeric: true }) < 0), 'places in order');
    await page.locator('[data-sort="priority"]').tap();
    assert.deepEqual(await rows(), byPriority.flatMap(([, ids]) => ids));

    // Lateness: a number in words on every row, and a small bar; the bar is hidden from screen readers.
    const lateRows = await list.locator('[data-wo]').evaluateAll((els) => els.map((e) => {
      const bar = e.querySelector('.late-bar'); const fill = bar?.querySelector('i');
      return { text: e.querySelector('.late-n')?.textContent, hidden: bar?.getAttribute('aria-hidden'), track: bar ? Math.round(bar.getBoundingClientRect().width) : 0, fill: fill ? fill.getBoundingClientRect().width : -1,
        colour: getComputedStyle(e.querySelector('.late-n')).color, fillColour: fill ? getComputedStyle(fill).backgroundColor : '', label: e.getAttribute('aria-label') };
    }));
    assert.ok(lateRows.length >= 10);
    for (const r of lateRows) {
      assert.match(r.text, /^(Late by|Due in) \d+ (min|h|d)/, r.text);
      assert.equal(r.hidden, 'true');
      assert.ok(r.label.includes(r.text), 'the number is in the accessible name');
      assert.equal(r.colour, 'rgb(11, 47, 78)', 'navy text, not red');
      assert.equal(r.fillColour, 'rgb(238, 155, 0)', 'a mango bar');
      assert.ok(r.track >= 60 && r.track <= 120, `a small bar: ${r.track}px`);
      assert.equal(r.fill > 0, r.text.startsWith('Late by'), `${r.text}: a bar only when late`);
    }
    // The bar grows with the lateness, and the most late job in view fills it.
    const lateOnes = lateRows.filter((r) => r.fill > 0);
    assert.ok(lateOnes.length >= 6);
    assert.ok(Math.abs(Math.max(...lateOnes.map((r) => r.fill)) - lateOnes[0].track) <= 1, 'the most late job fills the bar');
    const urgentFill = lateRows[0].fill; // late by 26 h
    const highFill = lateRows[2].fill; // late by 6 h
    assert.ok(urgentFill > highFill && highFill > 0, `26 h (${urgentFill}px) is longer than 6 h (${highFill}px)`);
    // Not red: nothing in the queue uses the old red text.
    assert.equal(await page.locator('[data-test="wo-queue"] .sla-over').count(), 0);
    const reds = await page.locator('[data-test="wo-queue"] *').evaluateAll((els) => els.filter((e) => getComputedStyle(e).color === 'rgb(163, 48, 26)').length);
    assert.equal(reds, 0, 'no element in the queue has the old red text colour');

    // Tags: no "Assigned" or "Reported" chips, no priority chip on rows; only in progress, another team, repeat fault.
    const chips = await list.locator('.chip').allTextContents();
    assert.ok(chips.length >= 5);
    assert.ok(chips.every((t) => /^(In progress|Medical equipment team|External contractor|Repeat: \d+ earlier fix(es)?)$/.test(t)), chips.join(' | '));
    assert.doesNotMatch(await list.innerText(), /\bAssigned\b|\bReported\b/);
    const teams = await page.evaluate(async () => {
      const { runCommand } = await import('/app/core/commands.js');
      const q = await runCommand(window.ospeli.core, 'ospeli_workorders_list', { state: 'open', limit: 500 }, { type: 'human', role: 'estates-tech' });
      return q.workOrders.map((w) => [w.id, w.team, w.repeat]);
    });
    for (const [id, team, repeat] of teams) {
      const text = await list.locator(`[data-wo="${id}"]`).textContent();
      assert.equal(/Medical equipment team|External contractor/.test(text), team !== 'estates', `${id}: a team tag only for another team`);
      assert.equal(/Repeat: /.test(text), repeat > 0, `${id}: a repeat tag only for a repeat fault`);
    }

    // Sizes: every tap target at least 44 px and all text at least 15 px, in the queue (card, switch, filters, list).
    const small = await tooSmall(page, '[data-test="wo-queue"]');
    assert.deepEqual(small.targets, [], 'tap targets under 44 px');
    assert.deepEqual(small.text, [], 'text under 15 px');
    // The same with a job in progress and the outcome list open.
    await page.locator('[data-test="next-card"] [data-cmd="ospeli_workorders_start"]').tap();
    await page.waitForSelector('[data-test="next-card"][data-mode="started"]');
    assert.deepEqual(await tooSmall(page, '[data-test="next-card"]'), { text: [], targets: [] });
    await page.locator('[data-test="close-job"]').tap();
    await page.waitForSelector('[data-test="outcomes"]');
    assert.deepEqual(await tooSmall(page, '[data-test="next-card"]'), { text: [], targets: [] });
    assert.ok(await noSideways(page) <= 0);
    assert.deepEqual(errors, []);
    await context.close();
  });
}

test('the do-next page has no sideways scroll at 360, 390 and 1280 px; other roles keep their page with the new list (issue #83)', async () => {
  for (const width of [360, 390, 1280]) {
    const { context, page, errors } = await openPage(env, { width, height: 780, clock: '2026-11-10T10:00:00Z', path: '#/engineering' });
    await asTechnician(page);
    assert.ok(await noSideways(page) <= 0, `${width}px`);
    const inside = await page.locator('[data-test="next-card"], [data-test="wo-list"] [data-wo], [data-sort], [data-filter]').evaluateAll((els) => els.every((e) => { const r = e.getBoundingClientRect(); return r.left >= 0 && r.right <= window.innerWidth; }));
    assert.ok(inside, `${width}px: the card, the switch and every row fit the screen`);
    await page.locator('[data-test="next-card"] [data-cmd="ospeli_workorders_start"]').click();
    await page.waitForSelector('[data-test="next-card"][data-mode="started"]');
    await page.locator('[data-test="close-job"]').click();
    await page.waitForSelector('[data-test="outcomes"]');
    assert.ok(await noSideways(page) <= 0, `${width}px, closing`);
    if (width === 1280) {
      // The ward nurse has no do-next card and cannot start a job; the list and the summary line are the same.
      await page.selectOption('#role-select', 'ward-nurse');
      await page.waitForSelector('[data-test="wo-queue"][data-role="ward-nurse"] [data-test="wo-list"] [data-wo]');
      assert.equal(await page.locator('[data-test="next-card"]').count(), 0);
      assert.equal(await page.locator('[data-cmd="ospeli_workorders_start"]').count(), 0);
      assert.equal(await page.locator('main h2').first().textContent(), 'Report a fault');
      assert.match((await page.locator('[data-test="wo-counts"]').innerText()).replace(/\s+/g, ' '), /^\d+ open · \d+ late · \d+ repeat faults?$/);
      assert.equal(await page.locator('.stat').count(), 0);
      assert.equal(await page.locator('[data-test="wo-list"] .chip.wo-started').count(), 1, 'everyone sees that the job is in progress');
      assert.equal(await page.locator('[data-test="wo-queue"] .sla-over').count(), 0);
      assert.match(await page.locator('[data-test="queue-rules"]').innerText(), /Targets: urgent 4 h, high 24 h, routine 72 h \(examples; set locally\)/);
      await page.locator('[data-test="wo-list"] [data-wo]').first().click();
      await page.waitForSelector('dialog[open]');
      assert.equal(await page.locator('dialog[open] [data-cmd]').count(), 0);
      assert.match(await page.locator('dialog[open]').innerText(), /In progress/);
      await page.keyboard.press('Escape');
      // The operations manager may start a job from the work order itself.
      await page.selectOption('#role-select', 'ops-manager');
      await page.waitForSelector('[data-test="wo-queue"][data-role="ops-manager"] [data-test="wo-list"] [data-wo]');
      const row = page.locator('[data-test="wo-list"] [data-wo]:not(:has(.wo-started))').first();
      const id = await row.getAttribute('data-wo');
      await row.click();
      await page.waitForSelector('dialog[open]');
      await page.click('dialog[open] [data-cmd="ospeli_workorders_start"]');
      await page.waitForSelector(`[data-wo="${id}"] .chip.wo-started`);
      const ev = await page.evaluate(async () => (await window.ospeli.core.events()).at(-1));
      assert.deepEqual([ev.type, ev.subject, ev.actorRole], ['workorder.started', id, 'ops-manager']);
    }
    assert.deepEqual(errors, []);
    await context.close();
  }
});
