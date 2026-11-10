// Diagnostics demo (web/demo/diagnostics/): each role renders with no sideways scroll, a ward marks a
// sample collected, lab reception receives and rejects with a reason from a fixed list and the measures
// update, a scanner-down proposal changes nothing until imaging booking confirms, and the guide can be
// switched off. Fictional data only; the page never shows results.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './helpers.mjs';

let env;
before(async () => { env = await startApp(); });
after(async () => { await env.close(); });

async function open(width) {
  const context = await env.browser.newContext({ viewport: { width, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(env.base + '/demo/diagnostics/');
  await page.waitForSelector('#kpis .stat');
  return { context, page, errors };
}
const api = (page, fn) => page.evaluate((f) => window.ospeliDiagnosticsDemo[f](), fn);
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

for (const width of [360, 390, 1280]) {
  test(`diagnostics renders every role at ${width}px with no sideways scroll`, async () => {
    const { context, page, errors } = await open(width);
    assert.equal(await page.locator('#kpis .stat').count(), 4);
    assert.ok(await page.locator('.sugg').count() >= 3, 'guide shows suggestions');
    for (const role of ['ward', 'lab', 'imaging', 'manager']) {
      await page.click('#r-' + role);
      assert.equal(await page.locator('#r-' + role).getAttribute('aria-pressed'), 'true');
      const o = await overflow(page);
      assert.ok(o <= 0, `${role} view scrolls sideways by ${o}px`);
    }
    await page.click('#r-lab');
    await page.locator('#incoming [id^="rj-S"]').first().click();
    assert.ok(await overflow(page) <= 0, 'reject reasons fit');
    if (width < 500) {
      await page.click('#r-ward');
      const h = await page.locator('#ward-specs .go').first().boundingBox();
      assert.ok(h.height >= 44, 'front-line buttons are at least 44px tall');
      const fs = await page.locator('#ward-specs .meta').first().evaluate((n) => parseFloat(getComputedStyle(n).fontSize));
      assert.ok(fs >= 15, 'front-line text is at least 15px');
    }
    assert.deepEqual(errors, []);
    await context.close();
  });
}

test('a ward marks a sample collected and lab reception receives it', async () => {
  const { context, page, errors } = await open(390);
  await page.click('#r-ward');
  const k0 = await api(page, 'kpis');
  const btn = page.locator('#ward-specs [id^="col-"]').first();
  const id = (await btn.getAttribute('id')).slice(4);
  await btn.click();
  const k1 = await api(page, 'kpis');
  assert.equal(k1.awaitingCollection, k0.awaitingCollection - 1);
  assert.equal(k1.inTransit, k0.inTransit + 1);
  assert.match(await page.locator('#log li').first().textContent(), /collected/);
  await page.click('#r-lab');
  await page.click('#rcv-' + id);
  const k2 = await api(page, 'kpis');
  assert.equal(k2.received, k1.received + 1);
  assert.equal(k2.inLab, k1.inLab + 1);
  assert.equal(k2.arrivedInLab, k1.arrivedInLab + 1);
  assert.deepEqual(errors, []);
  await context.close();
});

test('lab reception rejects with a reason and the rejection rate and guide update', async () => {
  const { context, page, errors } = await open(1280);
  await page.click('#r-lab');
  const k0 = await api(page, 'kpis');
  const ed = page.locator('#incoming article', { hasText: 'Emergency department' }).first();
  await ed.locator('[id^="rj-S"]').click();
  assert.ok(await page.locator('#rj-go').isDisabled(), 'a reason is required');
  await page.click('#rr-haem');
  await page.click('#rj-go');
  const k1 = await api(page, 'kpis');
  assert.equal(k1.rejected, k0.rejected + 1);
  assert.ok(k1.rejectionRatePct > k0.rejectionRatePct);
  assert.equal(await page.locator('#kpi-rej b').textContent(), k1.rejectionRatePct.toFixed(1) + '%');
  const s = await api(page, 'suggestions');
  assert.ok(s.some((x) => /Emergency department: 3 samples rejected/.test(x.title)), 'repeat rejections flagged');
  await page.click('#r-ward');
  await page.selectOption('#ward-pick', 'ED');
  assert.ok(await page.locator('#ward-specs').getByText(/haemolysed/i).count() >= 1, 'the ward sees the reason');
  assert.deepEqual(errors, []);
  await context.close();
});

test('moving bookings off a down scanner waits for imaging booking to confirm', async () => {
  const { context, page, errors } = await open(1280);
  const ct1 = async () => (await api(page, 'get')).equipment.find((e) => e.id === 'CT1').bookingsLeftToday;
  const n0 = await ct1();
  assert.ok(n0 >= 1, 'CT 1 has bookings while down');
  await page.getByRole('button', { name: /Propose: move \d+ booking/ }).click();
  assert.equal(await ct1(), n0, 'proposing changes nothing');
  assert.equal((await api(page, 'get')).pendingDecisions.length, 1);
  await page.locator('#pending').getByRole('button', { name: /Switch to Imaging booking view/ }).click();
  assert.equal(await page.locator('#r-imaging').getAttribute('aria-pressed'), 'true');
  await page.locator('#pending').getByRole('button', { name: 'Confirm' }).click();
  assert.equal(await ct1(), 0);
  assert.match(await page.locator('#log li').first().textContent(), /Imaging booking confirmed/);
  assert.deepEqual(errors, []);
  await context.close();
});

test('the guide has an off switch and the lists still work without it', async () => {
  const { context, page, errors } = await open(390);
  await page.uncheck('#guide-on');
  assert.equal(await page.locator('.sugg').count(), 0);
  assert.deepEqual(await api(page, 'suggestions'), []);
  await page.click('#r-imaging');
  const w0 = (await api(page, 'kpis')).scansWaitingForSlot;
  await page.locator('#waitlist [id^="bk-"]:not([disabled])').first().click();
  assert.equal((await api(page, 'kpis')).scansWaitingForSlot, w0 - 1);
  assert.equal(await page.locator('#kpis .stat').count(), 4);
  assert.deepEqual(errors, []);
  await context.close();
});

test('agent object is read-only and returns data, never results', async () => {
  const { context, page, errors } = await open(1280);
  assert.match(await api(page, 'describe'), /Read-only/);
  const g = await api(page, 'get');
  assert.ok(g.openSamples.length >= 10);
  assert.equal(g.imagingWaiting.length, 4);
  assert.ok(g.equipment.some((e) => e.down));
  assert.ok(g.openSamples.every((s) => /^P-[A-Z0-9]{3}$/.test(s.patientCode)), 'patients as anonymous codes');
  assert.ok(!JSON.stringify(g).match(/"result"/i));
  const k = await api(page, 'kpis');
  assert.ok(k.labTatMedianMin > 0 && k.labTatP90Min >= k.labTatMedianMin && k.rejectionRatePct > 0);
  assert.ok((await api(page, 'suggestions')).length >= 3);
  assert.ok(await page.evaluate(() => Object.isFrozen(window.ospeliDiagnosticsDemo)));
  await page.click('#kpi-tat');
  assert.equal(await page.locator('#kpi-tat').getAttribute('aria-expanded'), 'true');
  assert.deepEqual(errors, []);
  await context.close();
});

test('the move-bookings proposal never moves a booking earlier than its booked time', async () => {
  const { context, page, errors } = await open(1280);
  const rows = (await page.locator('#sugg').textContent()).match(/\d\d:\d\d CT \d → \d\d:\d\d CT \d/g) || [];
  assert.ok(rows.length >= 1, 'a move is proposed');
  for (const r of rows) { const [from, to] = r.match(/\d\d:\d\d/g); assert.ok(to >= from, `moved earlier: ${r}`); }
  assert.deepEqual(errors, []);
  await context.close();
});
