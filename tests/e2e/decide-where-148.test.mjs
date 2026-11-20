// Issue #148: "Waiting for your decision" on Today leads to the screen that shows each proposal with
// Accept, one line per screen, counts only what the role can open and decide, and no card shows a
// raw command name. Agents propose through window.ospeli, as in the issue; synthetic data only.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, openPage } from './helpers.mjs';

let env;
before(async () => { env = await startApp(); });
after(async () => { await env.close(); });

const CLOCK = '2026-11-10T10:00:00Z';

async function fourProposals(page) {
  return page.evaluate(async () => {
    const { runCommand } = await import('./core/commands.js');
    const core = window.ospeli.core;
    const ops = { type: 'human', role: 'ops-manager' };
    const wards = (await core.listEntities('ward')).map((w) => w.id);
    await runCommand(core, 'ospeli_agents_set_access', { allowed: true, wards: Object.fromEntries(wards.map((id) => [id, true])) }, { type: 'human', role: 'coo' });
    await runCommand(core, 'ospeli_agents_add', { name: 'ward-helper', role: 'ward-nurse', wards, days: 30 }, ops);
    await runCommand(core, 'ospeli_agents_add', { name: 'ed-helper', role: 'ae-nic', wards, days: 30 }, ops);
    const as = (agent, role) => ({ agent, role });
    const out = [];
    out.push(await window.ospeli.run('ospeli_support_meals_record', { wardId: 'ward-a1', meal: 'midday', ordered: 20, delivered: 19, returned: 3 }, as('ward-helper', 'ward-nurse')));
    out.push(await window.ospeli.run('ospeli_stock_count', { placeId: 'ward-a1', lines: [{ itemId: 'bed-sheet', qty: 4 }] }, as('ward-helper', 'ward-nurse')));
    out.push(await window.ospeli.run('ospeli_transfers_request', { type: 'between-sites', fromPlace: 'ward-a3', toSite: 'site-north', needed: 'asap', mobility: 'wheelchair', escort: 'none', equipment: ['none'] }, as('ed-helper', 'ae-nic')));
    out.push(await window.ospeli.run('ospeli_tasks_request', { kind: 'patient-move', locationId: 'ward-a1', toLocationId: 'dept-imaging', detail: 'Wheelchair' }, as('ed-helper', 'ae-nic')));
    return out.map((o) => o.status);
  });
}

const todayLinks = (page) => page.locator('[data-test="decisions-waiting"] a').evaluateAll((as) => as.map((a) => [a.getAttribute('href'), a.innerText.replace(/\s+/g, ' ').trim()]));

for (const width of [390, 1280]) {
  test(`#148: each Today link opens the screen with the proposal and its Accept, one line per screen (${width}px)`, async () => {
    const { context, page, errors } = await openPage(env, { width, path: '#/home', clock: CLOCK, touch: width < 500 });
    assert.deepEqual(await fourProposals(page), ['proposed', 'proposed', 'proposed', 'proposed']);
    const card = page.locator('[data-test="decisions-waiting"]');
    await card.waitFor();
    await page.waitForFunction(() => /\(4\)/.test(document.querySelector('[data-test="decisions-waiting"] h2')?.innerText || ''), null, { timeout: 10000 }).catch(() => {});
    assert.equal((await card.locator('h2').innerText()).trim(), 'Waiting for your decision (4)');
    const links = await todayLinks(page);
    const hrefs = links.map(([href]) => href);
    assert.equal(new Set(hrefs).size, hrefs.length, `one line per screen: ${JSON.stringify(links)}`);
    assert.deepEqual(links, [
      ['#/support/board', 'Cleaning and transport, Task board: 1 proposal'],
      ['#/support/linen', 'Cleaning and transport, Linen and meals: 2 proposals'],
      ['#/transfers/board', 'Transfers and vehicles, Dispatch board: 1 proposal'],
    ]);
    // Follow each link: the proposals are on that screen, each with Accept, and no card shows a command name.
    let accepted = 0;
    for (const [href, text] of links) {
      const [, mod, screen] = href.split('/');
      await page.evaluate((hh) => { location.hash = hh; }, href);
      // The screen the link names, not the one before it, is on the page.
      await page.waitForSelector(`main .mod-${mod}[data-screen="${screen}"]`);
      const n = Number(text.match(/(\d+) proposals?$/)[1]);
      await page.waitForFunction((k) => document.querySelectorAll('[data-test="proposals"] .proposal-item').length >= k, n, { timeout: 10000 })
        .catch(async () => assert.fail(`${href}: ${n} proposals expected; the page reads: ${(await page.locator('main').innerText()).slice(0, 600)}`));
      const items = await page.locator('[data-test="proposals"] .proposal-item').evaluateAll((li) => li.map((x) => ({ text: x.querySelector('b').innerText, accept: !!x.querySelector('[data-cmd="ospeli_proposals_accept"]') })));
      assert.equal(items.length, n, `${href}: ${JSON.stringify(items)}`);
      for (const it of items) {
        assert.ok(it.accept, `${href}: Accept is there for "${it.text}"`);
        assert.doesNotMatch(it.text, /ospeli_/, `${href}: no command name on a card`);
      }
      if (href === '#/support/linen') {
        assert.ok(items.some((it) => /^Meal count: .*midday meal.*20 ordered, 19 delivered, 3 returned uneaten$/.test(it.text)), JSON.stringify(items));
        assert.ok(items.some((it) => /^Linen count: /.test(it.text)), JSON.stringify(items));
      }
      // The meal count is not on the Task board.
      if (href === '#/support/board') assert.ok(items.every((it) => !/meal/i.test(it.text)), JSON.stringify(items));
      // Accept the first one without changing screen.
      await page.locator('[data-test="proposals"] [data-cmd="ospeli_proposals_accept"]').first().click();
      accepted += 1;
      await page.waitForFunction((k) => document.querySelectorAll('[data-test="proposals"] .proposal-item').length === k - 1, n, { timeout: 10000 })
        .catch(async () => assert.fail(`${href}: Accept did not take the proposal off the card: ${(await page.locator('[data-test="proposals"]').innerText()).slice(0, 300)} ${JSON.stringify(await page.evaluate(async () => { const { runCommand } = await import('./core/commands.js'); return (await runCommand(window.ospeli.core, 'ospeli_proposals_list', { limit: 50 }, { type: 'human', role: 'ops-manager' })).proposals.map((p) => [p.command, p.status, p.decision?.message || '']); }))} toast: ${await page.locator('#toast').innerText()}`));
    }
    const left = await page.evaluate(async () => { const { runCommand } = await import('./core/commands.js'); return (await runCommand(window.ospeli.core, 'ospeli_proposals_list', { status: 'pending', limit: 50 }, { type: 'human', role: 'ops-manager' })).proposals.length; });
    assert.equal(left, 4 - accepted);
    assert.deepEqual(errors, []);
    await context.close();
  });
}

test('#148: Today counts only what the role can decide and has a screen for (storekeeper: the linen count only)', async () => {
  const { context, page, errors } = await openPage(env, { width: 390, path: '#/home', clock: CLOCK, touch: true });
  await fourProposals(page);
  await page.selectOption('#role-select', 'storekeeper');
  await page.waitForFunction(async () => (await window.ospeli.core.getMeta('role')) === 'storekeeper');
  await page.evaluate(() => { location.hash = '#/home'; });
  await page.waitForFunction(() => /Storekeeper/i.test(document.querySelector('main h1')?.textContent || ''));
  const card = page.locator('[data-test="decisions-waiting"]');
  await card.waitFor();
  assert.equal((await card.locator('h2').innerText()).trim(), 'Waiting for your decision (1)');
  assert.deepEqual(await todayLinks(page), [['#/support/linen', 'Cleaning and transport, Linen and meals: 1 proposal']]);
  await page.evaluate(() => { location.hash = '#/support/linen'; });
  await page.waitForSelector('main .mod-support[data-screen="linen"] [data-test="proposals"] [data-cmd="ospeli_proposals_accept"]');
  assert.match(await page.locator('main [data-test="proposals"] .proposal-item b').first().innerText(), /^Linen count: /);
  assert.deepEqual(errors, []);
  await context.close();
});

test('#148: the proposals logic picks the screen the role has, or none', async () => {
  const { context, page } = await openPage(env, { width: 1280, path: '#/home', clock: CLOCK });
  const got = await page.evaluate(async () => {
    const { decideAt } = await import('./modules/screens.js');
    const moduleOf = (c) => (c.startsWith('ospeli_support_') || c.startsWith('ospeli_tasks_') ? 'support' : c.startsWith('ospeli_stock_') ? 'stores' : c.startsWith('ospeli_transfers_') ? 'transfers' : null);
    const linenIds = new Set(['bed-sheet']);
    const supplies = { command: 'ospeli_stock_count', input: { placeId: 'ward-a1', lines: [{ itemId: 'gloves-m', qty: 4 }] } };
    const linen = { command: 'ospeli_stock_count', input: { placeId: 'ward-a1', lines: [{ itemId: 'bed-sheet', qty: 4 }] } };
    const meal = { command: 'ospeli_support_meals_record', input: {} };
    const vehicle = { command: 'ospeli_transfers_vehicle_set', input: {} };
    return {
      nurseSupplies: decideAt(supplies, 'ward-nurse', moduleOf, { linenIds }),
      nurseLinen: decideAt(linen, 'ward-nurse', moduleOf, { linenIds }),
      storekeeperLinen: decideAt(linen, 'storekeeper', moduleOf, { linenIds }),
      porterMeal: decideAt(meal, 'porter', moduleOf, { linenIds }),
      driverVehicle: decideAt(vehicle, 'driver', moduleOf, { linenIds }),
      nurseVehicle: decideAt(vehicle, 'ward-nurse', moduleOf, { linenIds }),
    };
  });
  assert.deepEqual(got, {
    nurseSupplies: { moduleId: 'stores', screen: 'count' },
    nurseLinen: { moduleId: 'support', screen: 'linen' },
    storekeeperLinen: { moduleId: 'support', screen: 'linen' },
    porterMeal: null,
    driverVehicle: { moduleId: 'transfers', screen: 'fleet' },
    nurseVehicle: { moduleId: 'transfers', screen: 'board' },
  });
  await context.close();
});

test('#148: a ward agent\'s supplies count is decided on the ward stock count screen, where the nurse already is', async () => {
  const { context, page, errors } = await openPage(env, { width: 390, path: '#/home', clock: CLOCK, touch: true });
  const status = await page.evaluate(async () => {
    const { runCommand } = await import('./core/commands.js');
    const core = window.ospeli.core;
    const wards = (await core.listEntities('ward')).map((w) => w.id);
    await runCommand(core, 'ospeli_agents_set_access', { allowed: true, wards: Object.fromEntries(wards.map((id) => [id, true])) }, { type: 'human', role: 'coo' });
    await runCommand(core, 'ospeli_agents_add', { name: 'ward-helper', role: 'ward-nurse', wards, days: 30 }, { type: 'human', role: 'ops-manager' });
    const levels = await runCommand(core, 'ospeli_stock_levels', { category: 'supplies', placeId: 'ward-a1', format: 'short', limit: 5 }, { type: 'human', role: 'ward-nurse' });
    const itemId = levels.levels.find((r) => r.level)?.itemId;
    return (await window.ospeli.run('ospeli_stock_count', { placeId: 'ward-a1', lines: [{ itemId, qty: 3 }] }, { agent: 'ward-helper', role: 'ward-nurse' })).status;
  });
  assert.equal(status, 'proposed');
  const card = page.locator('[data-test="decisions-waiting"]');
  await card.waitFor();
  assert.deepEqual(await todayLinks(page), [['#/stores/count', 'Stores and supplies, Ward stock count: 1 proposal']]);
  await page.evaluate(() => { location.hash = '#/stores/count'; });
  await page.waitForSelector('main .mod-stores[data-screen="count"] [data-test="proposals"] [data-cmd="ospeli_proposals_accept"]');
  assert.doesNotMatch(await page.locator('main [data-test="proposals"] .proposal-item b').first().innerText(), /ospeli_/);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), 0, 'no sideways scroll');
  assert.deepEqual(errors, []);
  await context.close();
});
