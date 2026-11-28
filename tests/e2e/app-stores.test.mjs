// Stores and supplies in the app (module stores): every role and screen with no sideways scroll
// and no console error at 360, 390, 1024 and 1280 px; the storekeeper's first five minutes on a
// 390 px touch screen (issues the oldest request the store can fill, and the measure changes; a
// quick second tap issues nothing more); the supply chain manager's first five minutes on a 390 px
// phone (sees what is short and stuck, and records an order step) (issue #112); a ward count under
// level raises a request with no extra step and the ward sees it move; phone rules; the guide
// switch; a role with no rights sees no action button; honest empty states on an older device.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, openPage, setRole, chooseDepartment, waitUntil } from './helpers.mjs';
import { roleById } from '../../web/app/core/model.js';
import { moduleById } from '../../web/app/modules/registry.js';
import { departmentById, departmentForRole } from '../../web/app/modules/departments.js';

let env;
before(async () => { env = await startApp(); });
after(async () => { await env.close(); });

// A cold open (no address) as this role, in the department it works in. Navigation v2: every cold
// open lands on Now (the old jump to the role's page is gone); the role's own page is the first card
// under "Your pages" after the department's pages (the first of all when the department's pages
// start with it), and one tap opens it.
async function openFromNow(page, role) {
  const dept = departmentById(departmentForRole(role));
  await chooseDepartment(page, dept.id);
  await page.goto(env.appUrl);
  await page.waitForSelector('html[data-ready="true"]');
  await page.waitForSelector('#main [data-test="role-shortcuts"]');
  assert.match(await page.evaluate(() => location.hash), /^(#\/?(home)?)?$/, 'a cold open lands on Now');
  const home = roleById(role).home;
  const deptFirst = dept.pinned.filter((id) => moduleById(id)?.load);
  const at = deptFirst.includes(home) ? deptFirst.indexOf(home) : deptFirst.length;
  const cards = page.locator('#main [data-test="role-shortcuts"] a');
  assert.equal(await cards.nth(at).getAttribute('href'), `#/${home}`, `the role's page is card ${at + 1} under Your pages`);
  await cards.nth(at).tap();
}

const CLOCK = '2026-11-10T14:00:00Z';
const noSideways = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
// Data as an older device holds it (no stores history, or no store at all), through export and import.
const olderDevice = (page, what) => page.evaluate(async (w) => {
  const core = window.ospeli.core;
  const data = await core.exportData();
  if (w === 'history') data.events = data.events.filter((e) => !e.type.startsWith('stock.') && !e.type.startsWith('stores.')).map((e, i) => ({ ...e, seq: i + 1 }));
  if (w === 'store') data.entities = data.entities.filter((e) => e.type !== 'store');
  await core.importData(data, 'coo');
}, what);
const cmd = (page, name, input, role) => page.evaluate(async ([n, i, r]) => {
  const { runCommand } = await import('/app/core/commands.js');
  return runCommand(window.ospeli.core, n, i, { type: 'human', role: r });
}, [name, input, role]);
// Choose a role in the picker, then open one screen by its address, and wait for a fresh drawing for it.
async function asRole(page, role, screen) {
  await setRole(page, role);
  await waitUntil(page, async (r) => (await window.ospeli.core.getMeta('role')) === r, role);
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
  // A storekeeper's phone: opening the app with no address lands on Now; one tap on their card opens the module, on the requests.
  await setRole(page, 'storekeeper');
  await waitUntil(page, async () => (await window.ospeli.core.getMeta('role')) === 'storekeeper');
  await openFromNow(page, 'storekeeper');
  await page.waitForFunction(() => document.querySelector('.sto')?.dataset.screen === 'requests' && document.querySelector('[data-test="first-request"]'));
  assert.equal(await page.evaluate(() => location.hash), '#/stores');
  const first = page.locator('[data-test="first-request"]');
  const id = await first.getAttribute('data-request');
  // The oldest of the requests the store can issue now: oldest first in the list.
  const waiting = await cmd(page, 'ospeli_stock_requests', { fromPlaceId: 'store-main', limit: 200 }, 'storekeeper');
  const fillable = waiting.requests.filter((q) => q.lines.some((l) => l.left > 0 && l.usableAtSupplier > 0));
  assert.equal(id, fillable[0].id, 'the first card is the oldest request the store can fill');
  // The pick list is open on the oldest card, above the button that confirms it.
  const pick = first.locator('[data-test="pick-list"]');
  assert.equal(await pick.getAttribute('open'), '', 'the pick list is open');
  const main = first.locator('[data-cmd="ospeli_stock_issue"]').first();
  assert.ok((await pick.boundingBox()).y < (await main.boundingBox()).y, 'the list comes before the button');
  assert.match(await pick.textContent(), /owed · store holds \d+/);
  const box = await main.boundingBox();
  assert.ok(box.y + box.height <= 844, `the issue button is on the first screen (bottom at ${Math.round(box.y + box.height)} px)`);
  assert.ok(box.height >= 56, `one big button (${box.height} px)`);
  assert.deepEqual(await phoneProblems(page), [], 'requests screen: phone rules');
  // One line is reduced inline: the button now says it is a part issue.
  const line = pick.locator('li[data-item]').filter({ has: page.locator('.sto-num') }).first();
  const lineItem = await line.getAttribute('data-item');
  const lineQty = Number(await line.locator('.sto-num').inputValue());
  assert.ok(lineQty >= 1);
  await line.getByRole('button', { name: /One less/ }).tap();
  assert.match(await main.textContent(), /^Issue \d+ of \d+ items as picked \(part\)$|^Issue \d+ of \d+ items as picked \(part\)$/);
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
  assert.match(await page.locator('[data-test="issue-result"]').textContent(), new RegExp(`^Part issued: Request ${Number(id.slice(4))} to Ward`));
  const ev = await page.evaluate(async (r) => (await window.ospeli.core.events({ subject: r })).at(-1), id);
  assert.equal(ev.data.lines.find((l) => l.itemId === lineItem)?.qty ?? 0, lineQty - 1, 'what was picked is what was issued');
  await page.waitForFunction((r) => document.querySelector(`[data-request="${r}"] .sto-req-head`)?.textContent.includes('part issued'), id);
  assert.match(await page.locator(`[data-request="${id}"] [data-test="owed"]`).textContent(), /^Still owed: .+ 1$/, 'the reduced line stays owed');
  assert.ok(await fillLines(page) > fill0, 'the fill rate counts the lines issued in full');
  assert.deepEqual(errors, []);
  await context.close();
});

test('a ward count under level raises the request with no extra step, and the ward sees it move to issued', async () => {
  const { context, page, errors } = await openPage(env, { width: 390, height: 844, touch: true, clock: CLOCK, path: '#/stores' });
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
  const req = await page.locator('[data-test="raised"]').getAttribute('data-request');
  assert.match(await page.locator('[data-test="raised"]').textContent(), new RegExp(`^Request ${Number(req.slice(4))} sent to the store`));
  assert.match(await page.locator('[data-test="raised"]').textContent(), /for 1 item under level: Examination gloves, medium \d+\./);
  const mine = page.locator(`[data-test="ward-requests"] [data-request="${req}"]`);
  assert.equal(await mine.getAttribute('data-state'), 'open', 'the ward sees its request waiting');
  await cmd(page, 'ospeli_stock_issue', { requestId: req }, 'storekeeper');
  await page.waitForFunction((r) => document.querySelector(`[data-test="ward-requests"] [data-request="${r}"]`)?.dataset.state === 'issued', req);
  assert.match(await mine.locator('[data-test="state"]').textContent(), /^Issued from the store$/, 'issued, never "arrived"');
  // Issued is not arrived: the count says the gloves are on their way, and to count them once on the shelf.
  await page.waitForSelector('[data-test="count-list"] > li[data-item="gloves-m"] [data-test="on-its-way"]');
  // Issued seconds ago reads "just now", never "1 h ago" (#145; the same words as the linen screen).
  assert.match(await gloves.locator('[data-test="on-its-way"]').textContent(), /^Issued from the store just now: on its way\. Count it once it is on the shelf\.$/);
  // Counted under level before the delivery is on the shelf: the marker warns it would ask again (#113).
  await gloves.getByRole('button', { name: /One less/ }).tap();
  assert.match(await gloves.locator('[data-test="marker"]').textContent(), /^Under level: saving asks the store again for \d+, though stock was issued just now\. Is it on the shelf yet\?$/);
  assert.match(await page.locator('[data-test="count-list"] > li').first().locator('[data-test="at-level"]').textContent(), /^At level: \d+$/);
  assert.deepEqual(errors, []);
  await context.close();
});

test('the supply chain manager\'s first five minutes on a 390 px phone: sees what is short and what is stuck, and records an order step (#112)', async () => {
  const { context, page, errors } = await openPage(env, { width: 390, height: 844, touch: true, clock: CLOCK, path: '' });
  await setRole(page, 'supply-manager');
  await waitUntil(page, async () => (await window.ospeli.core.getMeta('role')) === 'supply-manager');
  await openFromNow(page, 'supply-manager');
  await page.waitForFunction(() => document.querySelector('.sto')?.dataset.screen === 'manage' && document.querySelector('[data-test="stats"]'));
  // The first screen says what is short and what is stuck, in numbers.
  const stats = page.locator('[data-test="stats"]');
  const sb = await stats.boundingBox();
  assert.ok(sb.y < 844, 'the counts start on the first screen');
  assert.match(await stats.textContent(), /Short now\d+item lines in \d+ wards?.*Requests waiting\d+oldest .*Open orders\d+longest at one step .*Stock-outs open1/);
  assert.match(await page.locator('[data-test="stuck"]').textContent(), /What is stuck.*Waiting for approval/s);
  // Short means nothing left, below half the top-up level, a late request or a store item not on order: not every top-up.
  const ov = await cmd(page, 'ospeli_stores_overview', {}, 'supply-manager');
  assert.ok(ov.short.lines.length < ov.counts.underLevel, `${ov.short.lines.length} short lines, not the ${ov.counts.underLevel} under their level`);
  assert.equal(await page.locator('[data-test="short"] li[data-kind]').count(), Math.min(10, ov.short.lines.length));
  assert.match(await page.locator('[data-test="short"]').textContent(), /What is short \(\d+ lines?\).*below 50% of its fill-to level/s);
  assert.deepEqual(await phoneProblems(page), [], 'manager view on a phone: phone rules');
  // Acts: the order that is approved is marked as ordered, from the stuck list.
  const btn = page.locator('[data-test="stuck"] [data-cmd="ospeli_stores_order_step"][data-step="ordered"]').first();
  const order = await btn.locator('xpath=ancestor::li[@data-order]').getAttribute('data-order');
  await btn.scrollIntoViewIfNeeded();
  await btn.tap();
  // A real wait for the saved step (ospeli/ospeli#133): the shared waitUntil, not a hand-written loop
  // that gave up after 5 s, which a busy machine can take to save one tap.
  await waitUntil(page, async (o) => (await window.ospeli.core.events({ subject: o })).at(-1)?.data?.step === 'ordered', order);
  const last = await page.evaluate(async (o) => (await window.ospeli.core.events({ subject: o })).at(-1), order);
  assert.equal(last?.data?.step, 'ordered', 'the order step was saved');
  assert.deepEqual([last.type, last.actorRole], ['stores.order-step', 'supply-manager']);
  // The approval is not this role's: no approve button anywhere on the page.
  assert.equal(await page.locator('[data-step="approved"]').count(), 0);
  // And a level, from the guide's suggestion, with the usage shown.
  const sugg = page.locator('[data-test="suggestion"][data-rule="level-check"]').first();
  assert.match(await sugg.textContent(), /Used in the last \d+ days: \d+/);
  // The suggestion fills in the level form and saves nothing; the person checks it and taps Save.
  const levels0 = await page.evaluate(async () => (await window.ospeli.core.events({ type: 'stock.level-set' })).length);
  await sugg.locator('[data-test="follow"]').tap();
  await page.waitForFunction(() => document.querySelector('[data-test="tool-level"]')?.open);
  await page.waitForTimeout(300);
  assert.equal(await page.evaluate(async () => (await window.ospeli.core.events({ type: 'stock.level-set' })).length), levels0, 'one tap on a suggestion saves nothing');
  const level = Number(await page.locator('[data-test="tool-level"] [data-test="level-input"]').inputValue());
  assert.ok(level > 0 && await page.locator('#lvl-place').inputValue() && await page.locator('#lvl-item').inputValue(), 'the form is filled in');
  await page.locator('[data-test="set-level-save"]').tap();
  await waitUntil(page, async (n) => (await window.ospeli.core.events({ type: 'stock.level-set' })).length === n + 1, levels0);
  assert.equal(await page.evaluate(async () => (await window.ospeli.core.events({ type: 'stock.level-set' })).at(-1).data.level), level);
  assert.deepEqual(errors, []);
  await context.close();
});

test('the manager view at 1280 px: measures with their sources, the guide switch off and on, and an approval by the operations manager', async () => {
  const { context, page, errors } = await openPage(env, { width: 1280, clock: CLOCK, path: '#/stores' });
  await asRole(page, 'supply-manager', 'manage');
  assert.equal(await page.locator('[data-kpi]').count(), 4);
  assert.equal(await page.locator('[data-test="planned"]').count(), 0, 'inventory turns is in the overview read, not on screen');
  assert.match(await page.locator('[data-kpi="stores-tracer-stock-out-rate"]').textContent(), /sees zero only when a count or a movement records it.*Main store: /s);
  assert.match(await page.locator('[data-kpi="stores-fill-rate"]').textContent(), /request lines issued in full in the end \(after any part issues\)/);
  assert.equal(await page.locator('[data-kpi="stores-fill-rate"] .sto-kpi-name').textContent(), 'Fill rate (filled in the end)', '#185: named as filled in the end on screen');
  assert.match(await page.locator('[data-kpi="stores-request-wait"]').textContent(), /to issued from the store/);
  assert.match(await page.locator('[data-kpi="stores-tracer-stock-out-rate"]').textContent(), /KPI dictionary D-17/);
  // #125: the stock-out tile says it is Ospeli's own definition, shows each place's usual count interval, and
  // says once that places counting at different intervals are not directly comparable.
  const so = page.locator('[data-kpi="stores-tracer-stock-out-rate"]');
  assert.equal(await so.locator('[data-test="own-definition"]').textContent(), "Ospeli's definition");
  assert.equal(await so.locator('[data-test="count-note"]').count(), 1);
  assert.match(await so.locator('[data-test="count-note"]').textContent(), /different intervals are not directly comparable/);
  assert.match(await so.textContent(), /Main store: .*\(.*item-days; (counted about every|fewer than two counts)/s);
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
  await waitUntil(page, async () => (await window.ospeli.core.events({ type: 'stores.order-reminded' })).length === 1);
  await asRole(page, 'ops-manager', 'orders');
  assert.match(await page.locator('[data-test="reminders"]').textContent(), /Reminder: Order \d+ waiting for approval/);
  const approve = page.locator('[data-cmd="ospeli_stores_order_step"][data-step="approved"]').first();
  const order = await approve.locator('xpath=ancestor::li[@data-order]').getAttribute('data-order');
  await approve.click();
  await waitUntil(page, async (o) => (await window.ospeli.core.events({ subject: o })).at(-1)?.data?.step === 'approved', order);
  assert.deepEqual(errors, []);
  await context.close();
});

test('the stock-out log opens on the nurse\'s own ward, with a way to all wards; closing says "Back in stock" and whether care was affected', async () => {
  const { context, page, errors } = await openPage(env, { width: 390, height: 844, touch: true, clock: CLOCK, path: '#/stores' });
  const open = (await cmd(page, 'ospeli_stock_outs', { state: 'open' }, 'ward-nurse')).stockOuts[0];
  await page.evaluate(() => { localStorage.setItem('ospeli-stores-ward', 'ward-c1'); });
  await asRole(page, 'ward-nurse', 'outs');
  assert.match(await page.locator('[data-test="outs-scope"]').textContent(), /Showing Ward C1 \(maternity\)\./);
  assert.equal(await page.locator(`[data-out="${open.id}"]`).count(), open.placeId === 'ward-c1' ? 1 : 0, 'another ward\'s stock-out is not in the first list');
  await page.locator('[data-test="outs-all"]').tap();
  await page.waitForSelector(`[data-test="outs-open"] [data-out="${open.id}"]`);
  const li = page.locator(`[data-test="outs-open"] [data-out="${open.id}"]`);
  assert.deepEqual(await li.locator('[data-cmd="ospeli_stock_out_end"]').allTextContents(), ['Back in stock: care was affected', 'Back in stock: care not affected']);
  await li.locator('[data-care="no"]').tap();
  await waitUntil(page, async (id) => (await window.ospeli.core.events({ subject: id })).at(-1).type === 'stock.stock-out-ended', open.id);
  assert.equal(await page.evaluate(async (id) => (await window.ospeli.core.events({ subject: id })).at(-1).data.careAffected, open.id), false);
  assert.deepEqual(await phoneProblems(page), []);
  assert.deepEqual(errors, []);
  await context.close();
});

test('a role with no rights sees no action button; with no stock history and with no store the screens say so honestly', async () => {
  const { context, page, errors } = await openPage(env, { width: 390, touch: true, clock: CLOCK, path: '#/stores' });
  for (const screen of ['manage', 'requests', 'orders', 'outs']) {
    await asRole(page, 'estates-tech', screen);
    assert.equal(await page.locator('.sto [data-cmd]').count(), 0, `${screen}: no action button for a role with no rights`);
  }
  await asRole(page, 'estates-tech', 'requests');
  assert.match(await page.locator('[data-test="read-only"]').textContent(), /issued by Stores assistant/);
  // A device whose example hospital was made before this module: no stock history.
  await olderDevice(page, 'history');
  await asRole(page, 'supply-manager', 'manage');
  await page.waitForSelector('[data-test="no-history"]');
  assert.match(await page.locator('[data-test="no-history"]').textContent(), /No supplies are held anywhere on this device yet/);
  await asRole(page, 'storekeeper', 'requests');
  await page.waitForSelector('[data-test="requests-empty"]');
  await asRole(page, 'ward-nurse', 'count');
  await page.waitForSelector('[data-test="count-empty"]');
  await asRole(page, 'storekeeper', 'orders');
  await page.waitForSelector('[data-test="orders-empty"]');
  // An older example hospital with no store.
  await olderDevice(page, 'store');
  await page.evaluate(() => { location.hash = '#/stores/receive'; });
  await page.reload();
  await page.waitForSelector('[data-test="no-store"]');
  assert.match(await page.locator('[data-test="no-store"]').textContent(), /No store is set up/);
  assert.deepEqual(errors, []);
  await context.close();
});

test('at 390 px the sticky Issue button never hides a pick line: it is solid, and a line moved to is clear of it (#113)', async () => {
  const { context, page, errors } = await openPage(env, { width: 390, height: 844, touch: true, clock: CLOCK, path: '#/stores' });
  await asRole(page, 'storekeeper', 'requests');
  const first = page.locator('[data-test="first-request"]');
  await first.locator('[data-test="pick-list"]').waitFor();
  // Solid: a stepper half under the bar does not show through above the button, where a tap would land on Issue.
  assert.equal(await first.locator('.sto-issuebar').evaluate((el) => getComputedStyle(el).backgroundImage), 'none', 'no see-through fade over the lines');
  // The line under the bar when the screen opens: moving to its number brings it clear of the bar.
  const under = await first.evaluate((card) => {
    const bar = card.querySelector('.sto-issuebar').getBoundingClientRect();
    const l = [...card.querySelectorAll('.sto-pick li[data-item]')].find((x) => { const r = x.querySelector('.sto-num')?.getBoundingClientRect(); return r && r.bottom > bar.top; });
    return l?.dataset.item;
  });
  assert.ok(under, 'a pick line starts under the bar');
  await first.locator(`.sto-pick li[data-item="${under}"] .sto-num`).focus();
  await page.waitForTimeout(100);
  const [num, bar] = await first.evaluate((card, id) => [card.querySelector(`li[data-item="${id}"] .sto-num`).getBoundingClientRect().bottom, card.querySelector('.sto-issuebar').getBoundingClientRect().top], under);
  assert.ok(num <= bar, `the number (bottom ${Math.round(num)} px) is above the bar (top ${Math.round(bar)} px)`);
  assert.deepEqual(errors, []);
  await context.close();
});

test('a short line offers its next step in one tap: the open request or a stock-out for a ward with none left, an order for the store (#113)', async () => {
  const { context, page, errors } = await openPage(env, { width: 390, height: 844, touch: true, clock: CLOCK, path: '#/stores' });
  await asRole(page, 'supply-manager', 'manage');
  const none = page.locator('[data-test="short"] li[data-kind="none-left"]');
  assert.ok(await none.count() >= 1, 'a ward line with none left');
  for (const li of await none.all()) {
    const next = li.locator('[data-test="short-next"]');
    assert.equal(await next.count(), 1, 'a next step beside "Change the top-up level"');
    assert.match(await next.textContent(), /^(See Request \d+|Start a stock-out|Stock-out open: see the log)$/);
    assert.match(await next.getAttribute('href'), /^#\/stores\/(requests|outs)$/);
  }
  const store = page.locator('[data-test="short"] li[data-kind="store-not-on-order"]').first();
  const item = await store.getAttribute('data-item');
  const ask = store.locator('[data-test="short-next"]');
  assert.equal(await ask.textContent(), 'Request an order');
  const orders0 = await page.evaluate(async () => (await window.ospeli.core.events({ type: 'stores.order-step' })).length);
  await ask.tap();
  await page.waitForFunction((id) => document.querySelector('.sto')?.dataset.screen === 'orders' && document.querySelector(`[data-test="order-new"][open] li[data-item="${id}"]`), item);
  assert.equal(await page.evaluate(async () => (await window.ospeli.core.events({ type: 'stores.order-step' })).length), orders0, 'one tap opens the form with the item; nothing is saved');
  assert.deepEqual(await phoneProblems(page), []);
  assert.deepEqual(errors, []);
  await context.close();
});

for (const width of [360, 390, 1280]) {
  test(`an order received before anyone approved it stays open and marked on the order tracker and the manager view at ${width}px (#128)`, async () => {
    const { context, page, errors } = await openPage(env, { width, touch: width < 500, clock: CLOCK, path: '#/stores' });
    const o = await cmd(page, 'ospeli_stores_order_step', { step: 'requested', lines: [{ itemId: 'aprons', qty: 5 }] }, 'storekeeper');
    await cmd(page, 'ospeli_stock_receive', { placeId: 'store-main', lines: [{ itemId: 'aprons', qty: 5 }], source: 'Purchase', orderRef: o.orderId }, 'storekeeper');
    await asRole(page, 'supply-manager', 'manage');
    const card = page.locator(`.sto-order[data-order="${o.orderId}"]`);
    assert.equal(await card.count(), 1, 'the order is on the manager view');
    assert.equal(await card.getAttribute('data-state'), 'requested');
    assert.match(await card.locator('[data-test="received-before-approval"]').textContent(), /^Received before approval: .+ before anyone approved it\./);
    await asRole(page, 'ops-manager', 'orders');
    const row = page.locator(`[data-test="orders"] .sto-order[data-order="${o.orderId}"]`);
    assert.equal(await row.locator('[data-test="received-before-approval"]').count(), 1, 'marked on the order tracker');
    assert.equal(await row.locator('.sto-approve').count(), 1, 'the approver can still decide');
    assert.ok(await noSideways(page) <= 0);
    assert.deepEqual(errors, []);
    await context.close();
  });
}
test('until a ward can confirm arrival, every stores screen says "example data only" and that issued counts as arrived, at 15 px or more, with the main action still on the first screen at 360 and 390 px (#113)', async () => {
  const MAIN = { requests: '[data-test="first-request"] [data-cmd="ospeli_stock_issue"]', manage: '[data-test="stats"]', count: '[data-test="count-save"]' };
  for (const [width, height] of [[390, 844], [360, 640]]) {
    const { context, page, errors } = await openPage(env, { width, height, touch: true, clock: CLOCK, path: '#/stores' });
    await page.evaluate(() => { try { localStorage.setItem('ospeli-stores-ward', 'ward-a1'); } catch { /* none */ } });
    for (const [role, screen] of SCREENS) {
      await asRole(page, role, screen);
      const note = page.locator('[data-test="example-note"]');
      assert.equal(await note.count(), 1, `${role} ${screen}: the note shows once`);
      assert.match(await note.textContent(), /^Example data only\. .*issue.*counted as arrived on the ward.*confirm.*not built yet/i, `${role} ${screen}: plain words`);
      const nb = await note.boundingBox();
      assert.ok(nb && nb.y + nb.height <= height, `${role} ${screen} at ${width} px: the note is on the first screen`);
      assert.ok(parseFloat(await note.evaluate((el) => getComputedStyle(el).fontSize)) >= 15, 'at least 15 px');
      if (MAIN[screen] && !(role === 'estates-tech')) {
        await page.waitForSelector(MAIN[screen]);
        const b = await page.locator(MAIN[screen]).first().boundingBox();
        assert.ok(b.y + Math.min(b.height, 56) <= height, `${role} ${screen} at ${width} px: the main action starts on the first screen (top ${Math.round(b.y)} px)`);
      }
    }
    assert.deepEqual(await phoneProblems(page), []);
    assert.deepEqual(errors, []);
    await context.close();
  }
});
