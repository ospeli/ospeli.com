// Issue #116: the ward stock count printed the word "null" under every item, and a count the field
// itself marks wrong (−5, 2.5, 1e9) was quietly changed to 0, 2 or 100,000 and saved; a slip such
// as 400 for 4 was saved with no question. Now: no screen shows "null", "undefined", "NaN" or
// "[object"; a wrong number is refused beside its field, nothing is written and focus goes to it;
// a count more than 10 times the top-up level (example setting) asks once before it is saved.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, openPage, setRole, waitUntil } from './helpers.mjs';

let env;
before(async () => { env = await startApp(); });
after(async () => { await env.close(); });

const CLOCK = '2026-11-10T14:00:00Z';
const JUNK = /\b(null|undefined|NaN)\b|\[object/;
const junkText = (page) => page.evaluate((src) => {
  const re = new RegExp(src);
  const out = [];
  const walk = document.createTreeWalker(document.querySelector('#view') || document.body, NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    if (re.test(n.textContent) && n.parentElement?.getClientRects().length) out.push(n.textContent.trim().slice(0, 60));
  }
  return out;
}, JUNK.source);
const counts = (page) => page.evaluate(async () => (await window.ospeli.core.exportData()).events.filter((e) => e.type === 'stock.counted').length);
async function openCount(page) {
  await page.evaluate(() => { try { localStorage.setItem('ospeli-stores-ward', 'ward-a1'); } catch { /* none */ } });
  await setRole(page, 'ward-nurse');
  await waitUntil(page, async () => (await window.ospeli.core.getMeta('role')) === 'ward-nurse');
  await page.evaluate(() => { location.hash = '#/stores/count'; });
  await page.waitForSelector('.sto[data-screen="count"] [data-test="count-input"]');
}

for (const width of [360, 390, 1280]) {
  test(`ward stock count at ${width} px shows no "null", "undefined" or "NaN" (#116 part 1)`, async () => {
    const { context, page, errors } = await openPage(env, { width, touch: width < 500, clock: CLOCK, path: '#/stores' });
    await openCount(page);
    assert.deepEqual(await junkText(page), []);
    assert.deepEqual(errors, []);
    await context.close();
  });
}

test('every built module screen shows no "null", "undefined", "NaN" or "[object" for the main roles (#116 sweep)', async () => {
  const { context, page, errors } = await openPage(env, { width: 390, touch: true, clock: CLOCK });
  await page.evaluate(() => { try { localStorage.setItem('ospeli-stores-ward', 'ward-a1'); } catch { /* none */ } });
  const routes = ['#/', '#/beds', '#/engineering', '#/process', '#/kpi', '#/feedback', '#/support', '#/stores', '#/agents', '#/data'];
  const found = [];
  for (const role of ['ward-nurse', 'estates-tech', 'storekeeper', 'coo']) {
    await setRole(page, role);
    for (const r of routes) {
      await page.evaluate((x) => { location.hash = x; }, r);
      await page.waitForTimeout(600);
      for (const t of await junkText(page)) found.push(`${role} ${r}: "${t}"`);
    }
  }
  assert.deepEqual(found, []);
  assert.deepEqual(errors, []);
  await context.close();
});

for (const typed of ['-5', '2.5', '1e9', '99999999999999999999']) {
  test(`a count typed as ${typed} is refused beside its field and nothing is saved (#116 part 2)`, async () => {
    const { context, page, errors } = await openPage(env, { width: 390, height: 844, touch: true, clock: CLOCK, path: '#/stores' });
    await openCount(page);
    const before = await counts(page);
    const input = page.locator('[data-test="count-input"]').first();
    await input.fill(typed);
    await page.locator('[data-test="count-save"]').tap();
    await page.waitForTimeout(300);
    assert.equal(await counts(page), before, 'no count was written');
    assert.equal(await input.getAttribute('aria-invalid'), 'true');
    const msg = await page.locator('.sto-bad').first().textContent();
    assert.match(msg, /Not saved/);
    assert.ok(await input.evaluate((el) => document.activeElement === el), 'focus is on the wrong number');
    const result = await page.locator('[data-test="count-result"]').textContent().catch(() => '');
    assert.doesNotMatch(result, /Saved:/);
    assert.deepEqual(errors, []);
    await context.close();
  });
}

test('a count more than 10 times the top-up level asks once, then saves what was typed (#116 part 2)', async () => {
  const { context, page, errors } = await openPage(env, { width: 390, height: 844, touch: true, clock: CLOCK, path: '#/stores' });
  await openCount(page);
  const before = await counts(page);
  const level = Number((await page.locator('[data-test="at-level"]').first().textContent()).match(/\d+/)[0]);
  const big = level * 10 + 1;
  await page.locator('[data-test="count-input"]').first().fill(String(big));
  await page.locator('[data-test="count-save"]').tap();
  await page.waitForSelector('[data-test="count-check"]');
  assert.equal(await counts(page), before, 'nothing is saved before the person answers');
  assert.match(await page.locator('[data-test="count-check"]').textContent(), new RegExp(`${big} .*Is that right\\?`));
  await page.locator('[data-test="count-save"]').tap();
  await page.waitForSelector('[data-test="count-result"]');
  assert.equal(await counts(page), before + 1);
  const last = await page.evaluate(async () => (await window.ospeli.core.exportData()).events.filter((e) => e.type === 'stock.counted').at(-1).data.lines[0].qty);
  assert.equal(last, big);
  assert.deepEqual(errors, []);
  await context.close();
});
