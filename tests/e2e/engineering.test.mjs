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
  assert.match(await page.locator('#queue-h + p').innerText(), /same fault on the same asset.*closed as Fixed.*Not counted: "No fault found", a different fault/);
  assert.ok(await noSideways(page) <= 0);
  assert.deepEqual(errors, []);
  await context.close();
});
