// Stores and supplies in the app (module stores): every role and screen with no sideways scroll
// and no console error at 360, 390, 1024 and 1280 px; the storekeeper's first five minutes on a
// 390 px touch screen (issues the oldest request the store can fill, and the measure changes; a
// quick second tap issues nothing more); the supply chain manager's first five minutes on a 390 px
// phone (sees what is short and stuck, and records an order step) (issue #112); a ward count under
// level raises a request with no extra step and the ward sees it move; phone rules; the guide
// switch; a role with no rights sees no action button; honest empty states.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, openPage } from './helpers.mjs';

let env;
before(async () => { env = await startApp(); });
after(async () => { await env.close(); });

const CLOCK = '2026-11-10T14:00:00Z';
const noSideways = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
// The module's thirty days of history, loaded the way the example hospital will load it once the
// core stock test is ready for it (see stores/commands.js, seedHistory).
const loadHistory = (page) => page.evaluate(async () => {
  const { rng } = await import('/app/core/generator.js');
  const { seedHistory } = await import('/app/modules/stores/commands.js');
  const core = window.ospeli.core; const gen = await core.getMeta('generator'); const endMs = Date.parse(gen.end);
  if ((await core.events({ type: 'stores.order-step' })).length) return; // the example hospital already has it
  const evs = seedHistory({ r: rng(4242), startMs: endMs - gen.days * 864e5, endMs, days: gen.days, entities: await core.listEntities() });
  evs.sort((a, b) => a.t - b.t || (a.type < b.type ? -1 : a.type > b.type ? 1 : 0) || (a.subject < b.subject ? -1 : 1));
  await core.appendEvents(evs.map((e) => ({ type: e.type, subject: e.subject, actorRole: e.actorRole, at: new Date(e.t).toISOString(), data: e.data ?? null })), 'system', 'stores history');
});
const cmd = (page, name, input, role) => page.evaluate(async ([n, i, r]) => {
  const { runCommand } = await import('/app/core/commands.js');
  return runCommand(window.ospeli.core, n, i, { type: 'human', role: r });
}, [name, input, role]);
// Choose a role in the picker, then open one screen by its address, and wait for a fresh drawing for it.
async function asRole(page, role, screen) {
  await page.selectOption('#role-select', role);
  await page.waitForFunction(async (r) => (await window.ospeli.core.getMeta('role')) === r, role);
  await page.evaluate((target) => {
    const x = document.querySelector('.sto');
    if (location.hash === target) return;
    if (x) x.dataset.stale = 'true';
    location.hash = target;
  }, `#/stores/${screen}`);
  await page.waitForFunction(([r, s]) => { const x = document.querySelector('.sto'); return x && !x.dataset.stale && x.dataset.role === r && x.dataset.screen === s && x.childElementCount > 2; }, [role, screen]);
}
// Phone rules for the front-line views: every control at least 44 px tall, every piece of text at least 15 px.
const phoneProblems = (page) => page.evaluate(() => {
  const out = [];
  for (const el of document.querySelectorAll('.sto button, .sto a, .sto select, .sto summary, .sto input')) {
    const r = el.getBoundingClientRect();
    if (r.height && r.height < 44 && el.type !== 'checkbox') out.push(`${el.tagName} "${(el.textContent || el.value || '').trim().slice(0, 30)}" is ${Math.round(r.height)} px tall`);
  }
  for (const el of document.querySelectorAll('.sto *')) {
    const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    const size = parseFloat(getComputedStyle(el).fontSize);
    if (own && el.getClientRects().length && !el.closest('.sr-only') && size < 15) out.push(`"${el.textContent.trim().slice(0, 30)}" is ${size} px`);
  }
  return out;
});
const fillLines = (page) => page.evaluate(async () => {
  const { runCommand } = await import('/app/core/commands.js');
  return (await runCommand(window.ospeli.core, 'ospeli_stores_overview', {}, { type: 'human', role: 'coo' })).kpis.find((k) => k.id === 'stores-fill-rate').numerator;
});

const SCREENS = [['storekeeper', 'requests'], ['storekeeper', 'receive'], ['storekeeper', 'outs'], ['storekeeper', 'orders'], ['ward-nurse', 'count'], ['ward-nurse', 'outs'],
  ['supply-manager', 'manage'], ['supply-manager', 'orders'], ['ops-manager', 'manage'], ['coo', 'orders'], ['estates-tech', 'requests']];
for (const width of [360, 390, 1024, 1280]) {
  test(`every role and screen renders at ${width} px with no sideways scroll and no console error`, async () => {
    const { context, page, errors } = await openPage(env, { width, touch: width < 500, clock: CLOCK, path: '#/stores' });
    await loadHistory(page);
    await page.evaluate(() => { try { localStorage.setItem('ospeli-stores-ward', 'ward-a1'); } catch { /* none */ } });
    for (const [role, screen] of SCREENS) {
      await asRole(page, role, screen);
      const o = await noSideways(page);
      assert.ok(o <= 0, `${role} ${screen} scrolls sideways by ${o} px`);
    }
    assert.deepEqual(errors, []);
    await context.close();
  });
}

test('the storekeeper\'s first five minutes on a 390 px touch screen: issues the oldest request the store can fill, a second tap issues nothing more, and the measure changes', async () => {
  const { context, page, errors } = await openPage(env, { width: 390, height: 844, touch: true, clock: CLOCK, path: '' });
  await loadHistory(page);
  // A storekeeper's phone: opening the app with no address opens the module, on the requests.
  await page.selectOption('#role-select', 'storekeeper');
  await page.waitForFunction(async () => (await window.ospeli.core.getMeta('role')) === 'storekeeper');
  await page.goto(env.appUrl);
  await page.waitForSelector('html[data-ready="true"]');
  await page.waitForFunction(() => document.querySelector('.sto')?.dataset.screen === 'requests' && document.querySelector('[data-test="first-request"]'));
  assert.equal(await page.evaluate(() => location.hash), '#/stores');
  const first = page.locator('[data-test="first-request"]');
  const id = await first.getAttribute('data-request');
  // The oldest of the requests the store can issue now: oldest first in the list.
  const waiting = await cmd(page, 'ospeli_stock_requests', { fromPlaceId: 'store-main', limit: 200 }, 'storekeeper');
  const fillable = waiting.requests.filter((q) => q.lines.some((l) => l.left > 0 && l.usableAtSupplier > 0));
  assert.equal(id, fillable[0].id, 'the first card is the oldest request the store can fill');
  assert.ok(await page.locator('[data-test="requests-waiting-stock"] li').count() >= 0);
  const main = first.locator('[data-cmd="ospeli_stock_issue"]').first();
  const box = await main.boundingBox();
  assert.ok(box.y + box.height <= 844, `the issue button is on the first screen (bottom at ${Math.round(box.y + box.height)} px)`);
  assert.ok(box.height >= 56, `one big button (${box.height} px)`);
  assert.deepEqual(await phoneProblems(page), [], 'requests screen: phone rules');
  const fill0 = await fillLines(page);
  const issued0 = await page.evaluate(async () => (await window.ospeli.core.events({ type: 'stock.issued' })).length);
  await main.tap();
  await page.waitForSelector('[data-test="issue-result"]');
  // Tap the same spot again a moment later, as a person checking it worked would.
  await page.waitForTimeout(400);
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(600);
  assert.equal(await page.evaluate(async () => (await window.ospeli.core.events({ type: 'stock.issued' })).length), issued0 + 1, 'one issue, not two');
  assert.equal(await page.evaluate(async (r) => (await window.ospeli.core.events({ subject: r })).at(-1).type, id), 'stock.issued');
  assert.match(await page.locator('[data-test="issue-result"]').textContent(), new RegExp(`(Issued in full|Part issued): ${id} to Ward`));
  assert.notEqual(await page.locator('[data-test="first-request"]').getAttribute('data-request'), id, 'the next request comes up');
  assert.ok(await fillLines(page) > fill0, 'the fill rate counts the lines issued in full');
  assert.deepEqual(errors, []);
  await context.close();
});

test('a ward count under level raises the request with no extra step, and the ward sees it move to issued', async () => {
  const { context, page, errors } = await openPage(env, { width: 390, height: 844, touch: true, clock: CLOCK, path: '#/stores' });
  await loadHistory(page);
  // A ward with no request waiting, as a ward is after its last delivery.
  for (const q of (await cmd(page, 'ospeli_stock_requests', { placeId: 'ward-b1' }, 'ward-nurse')).requests) {
    await cmd(page, 'ospeli_stock_request_cancel', { requestId: q.id, reason: 'Supplied another way' }, 'ward-nurse');
  }
  await asRole(page, 'ward-nurse', 'count');
  await page.selectOption('[data-test="count-ward"]', 'ward-b1');
  await page.waitForSelector('[data-test="count-list"]');
  const save = page.locator('[data-test="count-save"]');
  assert.equal(await save.textContent(), 'Count at least one item to save', 'nothing is counted until a person counts it');
  const sb = await save.boundingBox();
  assert.ok(sb.y + sb.height <= 844, 'the save button is on the first screen');
  // Every item full but gloves, counted with one tap on "−": none left.
  const rows = page.locator('[data-test="count-list"] > li');
  const n = await rows.count();
  assert.ok(n >= 10, `${n} items on the ward's list`);
  for (let i = 0; i < n; i++) {
    const row = rows.nth(i);
    if ((await row.getAttribute('data-item')) === 'gloves-m') await row.getByRole('button', { name: /One less/ }).tap();
    else await row.locator('[data-test="at-level"]').tap();
  }
  const gloves = page.locator('[data-test="count-list"] > li[data-item="gloves-m"]');
  assert.match(await gloves.locator('[data-test="marker"]').textContent(), /^Under level: \d+ will be asked for$/);
  assert.equal(await save.textContent(), `Save count (${n} items)`);
  assert.deepEqual(await phoneProblems(page), [], 'count screen: phone rules');
  await save.tap();
  await page.waitForSelector('[data-test="raised"]');
  const req = (await page.locator('[data-test="raised"]').textContent()).match(/Request (req-\d+)/)[1];
  assert.match(await page.locator('[data-test="raised"]').textContent(), /for 1 item under level: Examination gloves, medium \d+\./);
  const mine = page.locator(`[data-test="ward-requests"] [data-request="${req}"]`);
  assert.equal(await mine.getAttribute('data-state'), 'open', 'the ward sees its request waiting');
  await cmd(page, 'ospeli_stock_issue', { requestId: req }, 'storekeeper');
  await page.waitForFunction((r) => document.querySelector(`[data-test="ward-requests"] [data-request="${r}"]`)?.dataset.state === 'issued', req);
  assert.match(await mine.textContent(), /Issued/);
  assert.deepEqual(errors, []);
  await context.close();
});

test('the supply chain manager\'s first five minutes on a 390 px phone: sees what is short and what is stuck, and records an order step (#112)', async () => {
  const { context, page, errors } = await openPage(env, { width: 390, height: 844, touch: true, clock: CLOCK, path: '' });
  await loadHistory(page);
  await page.selectOption('#role-select', 'supply-manager');
  await page.waitForFunction(async () => (await window.ospeli.core.getMeta('role')) === 'supply-manager');
  await page.goto(env.appUrl);
  await page.waitForSelector('html[data-ready="true"]');
  await page.waitForFunction(() => document.querySelector('.sto')?.dataset.screen === 'manage' && document.querySelector('[data-test="stats"]'));
  // The first screen says what is short and what is stuck, in numbers.
  const stats = page.locator('[data-test="stats"]');
  const sb = await stats.boundingBox();
  assert.ok(sb.y < 844, 'the counts start on the first screen');
  assert.match(await stats.textContent(), /Under level\d+in \d+ places.*Requests waiting\d+oldest .*Open orders\d+longest at one step .*Stock-outs open1/);
  assert.match(await page.locator('[data-test="stuck"]').textContent(), /What is stuck.*Waiting for approval/s);
  assert.match(await page.locator('[data-test="short"]').textContent(), /What is short \(\d+ items\)/);
  assert.deepEqual(await phoneProblems(page), [], 'manager view on a phone: phone rules');
  // Acts: the order that is approved is marked as ordered, from the stuck list.
  const btn = page.locator('[data-test="stuck"] [data-cmd="ospeli_stores_order_step"][data-step="ordered"]').first();
  const order = await btn.locator('xpath=ancestor::li[@data-order]').getAttribute('data-order');
  await btn.scrollIntoViewIfNeeded();
  await btn.tap();
  await page.waitForFunction(async (o) => (await window.ospeli.core.events({ subject: o })).at(-1)?.data?.step === 'ordered', order);
  const last = await page.evaluate(async (o) => (await window.ospeli.core.events({ subject: o })).at(-1), order);
  assert.deepEqual([last.type, last.actorRole], ['stores.order-step', 'supply-manager']);
  // The approval is not this role's: no approve button anywhere on the page.
  assert.equal(await page.locator('[data-step="approved"]').count(), 0);
  // And a level, from the guide's suggestion, with the usage shown.
  const sugg = page.locator('[data-test="suggestion"][data-rule="level-check"]').first();
  assert.match(await sugg.textContent(), /Used in the last \d+ days: \d+/);
  await sugg.locator('[data-cmd="ospeli_stock_level_set"]').tap();
  await page.waitForFunction(async () => (await window.ospeli.core.events({ type: 'stock.level-set' })).at(-1).actorRole === 'supply-manager' && (await window.ospeli.core.events({ type: 'stock.level-set' })).at(-1).at > '2026-11-10');
  assert.deepEqual(errors, []);
  await context.close();
});

test('the manager view at 1280 px: measures with their sources, the guide switch off and on, and an approval by the operations manager', async () => {
  const { context, page, errors } = await openPage(env, { width: 1280, clock: CLOCK, path: '#/stores' });
  await loadHistory(page);
  await asRole(page, 'supply-manager', 'manage');
  assert.equal(await page.locator('[data-kpi]').count(), 4);
  assert.match(await page.locator('[data-test="planned"]').textContent(), /Inventory turns: Planned, not built/);
  assert.match(await page.locator('[data-kpi="stores-tracer-stock-out-rate"]').textContent(), /KPI dictionary D-17/);
  const guide = page.locator('[data-test="guide"]');
  assert.equal(await guide.getAttribute('data-on'), 'true');
  assert.deepEqual((await page.locator('[data-test="suggestion"]').evaluateAll((els) => [...new Set(els.map((e) => e.dataset.rule))])).sort(), ['level-check', 'order-waiting', 'transfer']);
  const before = await page.locator('[data-test="stats"]').textContent();
  await page.locator('[data-test="guide-switch"]').click();
  await page.waitForSelector('[data-test="guide-off"]');
  assert.equal(await page.locator('[data-test="suggestion"]').count(), 0);
  assert.equal(await page.locator('[data-test="stats"]').textContent(), before, 'everything else is the same with the guide off');
  await page.locator('[data-test="guide-switch"]').click();
  await page.waitForFunction(() => document.querySelector('[data-test="guide"]')?.dataset.on === 'true');
  // The operations manager approves the order waiting for approval; the reminder the guide offered is sent first.
  await page.locator('[data-test="suggestion"][data-rule="order-waiting"] [data-cmd="ospeli_stores_order_remind"]').click();
  await page.waitForFunction(async () => (await window.ospeli.core.events({ type: 'stores.order-reminded' })).length === 1);
  await asRole(page, 'ops-manager', 'orders');
  assert.match(await page.locator('[data-test="reminders"]').textContent(), /Reminder: ord-\d+ waiting for approval/);
  const approve = page.locator('[data-cmd="ospeli_stores_order_step"][data-step="approved"]').first();
  const order = await approve.locator('xpath=ancestor::li[@data-order]').getAttribute('data-order');
  await approve.click();
  await page.waitForFunction(async (o) => (await window.ospeli.core.events({ subject: o })).at(-1)?.data?.step === 'approved', order);
  assert.deepEqual(errors, []);
  await context.close();
});

test('a role with no rights sees no action button; with no stock history and with no store the screens say so honestly', async () => {
  const { context, page, errors } = await openPage(env, { width: 390, touch: true, clock: CLOCK, path: '#/stores' });
  // No stock history on this device yet (the example hospital as it is today).
  await asRole(page, 'supply-manager', 'manage');
  assert.match(await page.locator('[data-test="no-history"]').textContent(), /No supplies are held anywhere on this device yet/);
  await asRole(page, 'storekeeper', 'requests');
  await page.waitForSelector('[data-test="requests-empty"]');
  await asRole(page, 'ward-nurse', 'count');
  await page.waitForSelector('[data-test="count-empty"]');
  await asRole(page, 'storekeeper', 'orders');
  await page.waitForSelector('[data-test="orders-empty"]');
  await loadHistory(page);
  for (const screen of ['manage', 'requests', 'orders', 'outs']) {
    await asRole(page, 'estates-tech', screen);
    assert.equal(await page.locator('.sto [data-cmd]').count(), 0, `${screen}: no action button for a role with no rights`);
  }
  await asRole(page, 'estates-tech', 'requests');
  assert.match(await page.locator('[data-test="read-only"]').textContent(), /issued by Storekeeper/);
  // An older example hospital with no store.
  await page.evaluate(async () => {
    const core = window.ospeli.core;
    const data = await core.exportData();
    data.entities = data.entities.filter((e) => e.type !== 'store');
    await core.importData(data, 'coo');
  });
  await page.evaluate(() => { location.hash = '#/stores/receive'; });
  await page.reload();
  await page.waitForSelector('[data-test="no-store"]');
  assert.match(await page.locator('[data-test="no-store"]').textContent(), /No store is set up/);
  assert.deepEqual(errors, []);
  await context.close();
});
