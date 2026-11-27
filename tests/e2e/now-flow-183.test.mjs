// Now says only what its numbers hold (ospeli/ospeli#183 items 1 to 5; decision record
// docs/decisions/2026-11-25-now-flow-strip.md in the planning repo): the headline covers every
// timed wait and names its unit, the strip and each card carry their time and say when they are
// old, every tile names its unit, Emergency shows its one honest tile, and the agents' card takes
// its place in flow order. Synthetic example hospital; made-up proposals only.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, openPage, chooseDepartment } from './helpers.mjs';
import { DEPARTMENTS } from '../../web/app/modules/departments.js';

let env;
before(async () => { env = await startApp(); });
after(async () => { await env.close(); });

const CLOCK = '2026-11-17T14:20:00Z';
const asHuman = (page, name, input, role) => page.evaluate(async ([n, i, r]) => {
  const { runCommand } = await import('./core/commands.js');
  return runCommand(window.ospeli.core, n, i, { type: 'human', role: r });
}, [name, input, role]);
const hhmmIn = (page, iso) => page.evaluate((x) => new Date(x).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }), iso);

test('(a) Wards: the headline is the longest of every timed wait, a bed wait before a shorter vehicle wait, named with its unit', async () => {
  const { page, context, errors } = await openPage(env, { width: 390, height: 844, touch: true, department: 'wards', clock: CLOCK });
  await page.waitForSelector('[data-test="flow-wait"]');
  const beds = await asHuman(page, 'ospeli_beds_board', { format: 'short' }, 'ward-nurse');
  const trips = await asHuman(page, 'ospeli_transfers_board', { limit: 500 }, 'ward-nurse');
  const bedMax = Math.max(...beds.waiting.map((x) => Math.round((Date.parse(beds.asOf) - Date.parse(x.decisionAt)) / 60000)));
  const vanMax = Math.max(0, ...trips.waiting.filter((j) => /^ward-/.test(j.pickup?.id || '')).map((j) => j.waitMinutes || 0));
  assert.ok(beds.waiting.length > 0, 'the example hospital has patients waiting for a bed');
  const text = (await page.textContent('[data-test="flow-wait"]')).replace(/^→/, '');
  // Crew night 5 item 2: the bed wait heads the strip whenever one is timed, even when a vehicle
  // wait is longer (night 4 let the longer vehicle wait head it); the longer vehicle wait is said under it.
  assert.match(text, /^Longest wait now: .+ for a bed \(1 patient\)$/);
  const h = Math.floor(bedMax / 60); const m = bedMax % 60;
  assert.ok(text.includes(`${h ? `${h} h${m ? ` ${m} min` : ''}` : `${m} min`} for a bed`), `${text} names the ${bedMax} min bed wait`);
  if (vanMax > bedMax) assert.match(await page.textContent('[data-test="flow-key"]'), / · A vehicle wait is longer: .+ \(1 journey\)\./);
  // The mango bar sits where that wait is: before Stay for a bed.
  const bar = await page.locator('[data-test="flow-wait-bar"] + .flow-tile').getAttribute('data-stage');
  assert.equal(bar, 'stay');
  // Whole hospital: a patient's wait heads it, never a lab request or a journey.
  await chooseDepartment(page, 'whole-hospital');
  await page.waitForSelector('.flow-tile[data-stage="test"]');
  const whole = (await page.textContent('[data-test="flow-wait"]')).replace(/^→/, '');
  assert.match(whole, /\(1 patient\)$/);
  assert.doesNotMatch(await page.textContent('[data-test="flow-key"]'), /Longest patient wait/);
  assert.deepEqual(errors, []);
  await context.close();
});

test('(c) the strip and every card say "As of hh:mm"; past the limit a plain stale line (an example setting) and one tap reads again', async () => {
  const { page, context, errors } = await openPage(env, { width: 390, height: 844, touch: true, department: 'wards', clock: CLOCK });
  await page.waitForSelector('[data-test="flow-asof"]');
  const board = await asHuman(page, 'ospeli_beds_board', { format: 'short' }, 'ward-nurse');
  const at = await page.getAttribute('[data-test="flow-asof"]', 'data-asof');
  assert.ok(Math.abs(Date.parse(at) - Date.parse(board.asOf)) < 120000, 'the strip carries the time of its reads');
  assert.equal(await page.textContent('[data-test="flow-asof"]'), `As of ${await hhmmIn(page, at)}`);
  const cards = page.locator('[data-test="needs-list"] .needs-card');
  assert.ok(await cards.count() >= 1);
  for (const t of await cards.locator('[data-test="needs-asof"]').allTextContents()) assert.match(t, /^As of \d\d:\d\d$/);
  assert.equal(await page.locator('[data-test="flow-stale"]').isVisible(), false);
  // 16 minutes later, with nothing read again.
  await page.clock.fastForward(16 * 60 * 1000);
  await page.waitForSelector('[data-test="flow-stale"]:not([hidden])');
  assert.match(await page.textContent('[data-test="flow-stale"]'), /^These numbers are 1[67] min old\. Old after 15 min \(example setting, not a standard\)\.Read again$/);
  assert.match(await page.textContent('[data-test="flow-asof"]'), /^As of \d\d:\d\d, 1[67] min old$/);
  for (const t of await cards.locator('[data-test="needs-asof"]').allTextContents()) assert.match(t, /^As of \d\d:\d\d, 1[67] min old$/);
  const again = page.locator('[data-test="flow-again"]');
  const box = await again.boundingBox();
  assert.ok(box.height >= 44, `Read again is ${box.height} px tall`);
  await again.tap();
  await page.waitForSelector('[data-test="flow-stale"]', { state: 'hidden' });
  assert.match(await page.textContent('[data-test="flow-asof"]'), /^As of \d\d:\d\d$/);
  assert.ok(Date.parse(await page.getAttribute('[data-test="flow-asof"]', 'data-asof')) > Date.parse(at), 'read again: a new time');
  assert.deepEqual(errors, []);
  await context.close();
});

test('(d) every tile in every department names its unit (or says it is not counted); text and unit 15 px, tiles 44 px', async () => {
  const { page, context, errors } = await openPage(env, { width: 360, height: 640, touch: true, department: 'wards', clock: CLOCK });
  for (const d of DEPARTMENTS) {
    await chooseDepartment(page, d.id);
    await page.waitForFunction((w) => JSON.stringify([...document.querySelectorAll('.flow-tile .flow-name')].map((e) => e.textContent)) === w, JSON.stringify(d.stages.filter((s) => !s.planned).map((s) => s.tile || s.name)), { timeout: 10000 });
    const tiles = await page.locator('.flow-tile').evaluateAll((els) => els.map((e) => ({ stage: e.dataset.stage, n: e.querySelector('.flow-n').textContent, unit: e.querySelector('.flow-unit')?.textContent,
      name: parseFloat(getComputedStyle(e.querySelector('.flow-name')).fontSize), cap: parseFloat(getComputedStyle(e.querySelector('.flow-unit')).fontSize), h: e.getBoundingClientRect().height, w: e.getBoundingClientRect().width })));
    for (const t of tiles) {
      const s = d.stages.find((x) => x.id === t.stage);
      if (t.n === '–') assert.equal(t.unit, 'not counted yet', `${d.id} ${t.stage}`);
      else assert.match(t.unit, new RegExp(`^${s.unit}${t.n === '1' ? '' : 's'}(, last 24 h)?$`), `${d.id} ${t.stage}: "${t.n} ${t.unit}"`);
      assert.ok(t.name >= 15 && t.cap >= 15, `${d.id} ${t.stage}: text ${t.name} px, unit ${t.cap} px`);
      assert.ok(t.h >= 44 && t.w >= 44, `${d.id} ${t.stage}: ${t.w} by ${t.h} px`);
    }
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${d.id}: no sideways scroll`);
  }
  assert.deepEqual(errors, []);
  await context.close();
});

test('(e) Emergency shows one honest tile, waiting for a ward bed with its longest wait, and says the rest is planned, not built', async () => {
  const { page, context, errors } = await openPage(env, { width: 360, height: 640, touch: true, department: 'emergency', clock: CLOCK });
  await page.waitForSelector('[data-test="now-flow"]');
  const tiles = page.locator('.flow-tile');
  assert.equal(await tiles.count(), 1);
  const board = await asHuman(page, 'ospeli_beds_board', { format: 'short' }, 'ae-nic');
  const t = tiles.first();
  assert.equal(await t.locator('.flow-name').textContent(), 'Waiting for a ward bed');
  assert.equal(await t.locator('.flow-n').textContent(), String(board.waiting.length));
  assert.equal(await t.locator('.flow-unit').textContent(), board.waiting.length === 1 ? 'patient' : 'patients');
  if (board.waiting.length) assert.match(await t.locator('[data-test="flow-longest"]').textContent(), /^longest (\d+ min|\d+ h( \d+ min)?|under 1 min)$/);
  assert.equal(await page.locator('[data-test="flow-wait-bar"]').count(), 0, 'one tile: no connector, no bar');
  assert.match(await page.textContent('[data-test="flow-key"]'), /Arrive, Assess and Treat are planned, not built\./);
  assert.doesNotMatch(await page.textContent('[data-test="now-flow"]'), /not counted yet/);
  const box = await t.boundingBox();
  assert.ok(box.height >= 44 && box.width > 300, 'one tile across the strip');
  assert.deepEqual(errors, []);
  await context.close();
});

test('(f) the agents\' card takes its place in flow order, never pinned first; with agents off the page keeps its shape', async () => {
  const { page, context, errors } = await openPage(env, { width: 390, height: 844, touch: true, department: 'wards', clock: CLOCK });
  await page.waitForSelector('[data-test="needs-list"]');
  const shape = () => page.evaluate(() => ({
    strip: Math.round(document.querySelector('[data-test="flow-strip"]').getBoundingClientRect().top),
    needs: Math.round(document.querySelector('#needs-h').getBoundingClientRect().top),
    order: [...document.querySelectorAll('[data-test="needs-list"] > li')].map((li) => (li.querySelector('[data-test="decisions-waiting"]') ? 'decisions' : li.querySelector('.needs-card').dataset.page)),
  }));
  const off = await shape();
  assert.deepEqual(off.order, ['transfers'], 'agents off: the work cards only (Leave, Transfers)');
  // Agents on; a map helper proposes a new process map. Process maps are on no stage of Wards, so
  // the card goes after Leave, not on top.
  await page.evaluate(async () => {
    const { runCommand } = await import('./core/commands.js');
    const core = window.ospeli.core; const coo = { type: 'human', role: 'coo' };
    const wards = (await runCommand(core, 'ospeli_beds_board', {}, coo)).wards.map((w) => w.id);
    await runCommand(core, 'ospeli_agents_set_access', { allowed: true, wards: Object.fromEntries(wards.map((id) => [id, true])) }, coo);
    for (const [name, role] of [['flow-bot', 'bed-manager'], ['map-bot', 'ops-manager']]) await runCommand(core, 'ospeli_agents_add', { name, role, wards, days: 30 }, coo);
    await window.ospeli.run('ospeli_maps_create', { from: 'discharge' }, { agent: 'map-bot', role: 'ops-manager' });
  });
  await page.waitForSelector('[data-test="decisions-waiting"]');
  let on = await shape();
  assert.deepEqual(on.order, ['transfers', 'decisions']);
  assert.equal(on.strip, off.strip, 'the strip does not move');
  assert.equal(on.needs, off.needs, 'Needs you does not move');
  assert.match(await page.textContent('[data-test="decisions-waiting"] [data-test="needs-asof"]'), /^As of \d\d:\d\d$/);
  // A bed proposal: the card now has a page at Arrive, so it moves up to Arrive, its place in the flow.
  await page.evaluate(async () => {
    const { runCommand } = await import('./core/commands.js');
    const bed = (await runCommand(window.ospeli.core, 'ospeli_beds_board', {}, { type: 'human', role: 'coo' })).beds.find((b) => b.state === 'occupied');
    await window.ospeli.run('ospeli_beds_mark_vacated', { bedId: bed.id }, { agent: 'flow-bot', role: 'bed-manager' });
  });
  await page.waitForFunction(() => /\(2\)/.test(document.querySelector('[data-test="decisions-waiting"] h2')?.textContent || ''));
  on = await shape();
  assert.deepEqual(on.order, ['decisions', 'transfers']);
  // Agents off again: proposals answered, access off. The page is as it was.
  await page.evaluate(async () => {
    const { runCommand } = await import('./core/commands.js');
    for (const p of (await window.ospeli.core.proposals()).filter((x) => x.status === 'pending')) await runCommand(window.ospeli.core, 'ospeli_proposals_decline', { id: p.id, reason: 'Not needed' }, { type: 'human', role: p.command.startsWith('ospeli_beds_') ? 'bed-manager' : 'ops-manager' });
    await runCommand(window.ospeli.core, 'ospeli_agents_set_access', { allowed: false }, { type: 'human', role: 'coo' });
  });
  await page.waitForFunction(() => !document.querySelector('[data-test="decisions-waiting"]'));
  assert.deepEqual(await shape(), off);
  assert.deepEqual(errors, []);
  await context.close();
});

// ---- Crew night 5 (items 1 to 3): what is on screen, at 360 and 390 px ----
const tileFacts = (page) => page.locator('.flow-tile').evaluateAll((els) => els.map((e) => {
  // What a sighted person reads: the tile's visible text only (screen-reader words left out).
  const seen = [...e.querySelectorAll(':scope > span:not(.sr-only), :scope > b, :scope > span > span')].filter((x) => x.checkVisibility() && !x.closest('.sr-only'));
  const r = e.getBoundingClientRect();
  return { stage: e.dataset.stage, seen: e.innerText.replace(e.querySelector('.sr-only')?.innerText || '', '').replace(/\s+/g, ' ').trim(),
    small: seen.filter((x) => parseFloat(getComputedStyle(x).fontSize) < 15).map((x) => x.textContent), h: r.height, w: r.width };
}));
for (const [width, height] of [[360, 740], [390, 844]]) {
  test(`night 5 item 1 (${width} px): each tile says on screen what its number counts, 15 px words, 44 px tiles, no sideways scroll`, async () => {
    const { page, context, errors } = await openPage(env, { width, height, touch: true, department: 'pharmacy', clock: CLOCK });
    // The visible words for the tiles the Domain lead misread, and one per department.
    const want = {
      pharmacy: { collected: /^Ready to collect \d+ requests?$/, received: /^Not started \d+ requests?$/ },
      outpatients: { arrive: /^Booked, not arrived \d+ patients?$/, wait: /^Arrived, waiting \d+ patients?$/, seen: /^With clinician \d+ patients?$/ },
      laboratory: { received: /^In the lab \d+ requests?( oldest .+)?$/, done: /^Released \d+ requests?, last 24 h$/ },
      wards: { arrive: /^Waiting for a bed \d+ patients?$/, ready: /^Expected to leave \d+ beds?$/, leave: /^Awaiting vehicle \d+ journeys?$/ },
      imaging: { arrive: /^Arrive \d+ patients? being moved in$/, leave: /^Leave \d+ patients? waiting to leave$/ },
      'whole-hospital': { test: /^Open in the lab \d+ requests?( oldest .+)?$/, stay: /^Occupied \d+ beds?$/ },
    };
    for (const [d, tiles] of Object.entries(want)) {
      await chooseDepartment(page, d);
      const names = DEPARTMENTS.find((x) => x.id === d).stages.filter((s) => !s.planned).map((s) => s.tile || s.name);
      await page.waitForFunction((w) => JSON.stringify([...document.querySelectorAll('.flow-tile .flow-name')].map((e) => e.textContent)) === w, JSON.stringify(names), { timeout: 10000 });
      const facts = await tileFacts(page);
      for (const [stage, re] of Object.entries(tiles)) {
        const t = facts.find((x) => x.stage === stage);
        assert.match(t.seen, re, `${d} ${stage} on screen: "${t.seen}"`);
      }
      for (const t of facts) {
        assert.deepEqual(t.small, [], `${d} ${t.stage}: no words under 15 px`);
        assert.ok(t.h >= 44 && t.w >= 44, `${d} ${t.stage}: ${t.w} by ${t.h} px`);
      }
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${d}: no sideways scroll`);
    }
    assert.deepEqual(errors, []);
    await context.close();
  });

  test(`night 5 item 2 (${width} px): Laboratory and Whole hospital are never headed by a request; Laboratory says there is no timed patient wait`, async () => {
    const { page, context, errors } = await openPage(env, { width, height, touch: true, department: 'laboratory', clock: CLOCK });
    await page.waitForSelector('[data-test="flow-none"]');
    assert.equal(await page.locator('[data-test="flow-wait"]').count(), 0, 'no request heads the strip');
    assert.equal(await page.locator('[data-test="flow-wait-bar"]').count(), 0);
    const none = await page.textContent('[data-test="flow-none"]');
    assert.match(none, /^No timed patient wait\. /);
    assert.doesNotMatch(await page.textContent('[data-test="now-flow"]'), /Longest (wait|timed wait)|for a result/);
    // The request's age stays on its tile, in the same words as the read.
    const lab = await asHuman(page, 'ospeli_diagnostics_requests_list', { stage: 'current', limit: 500 }, 'lab-scientist');
    const inLab = lab.requests.filter((x) => x.state === 'received' && x.minutesInStep != null).map((x) => x.minutesInStep);
    if (inLab.length) assert.match(await page.textContent('.flow-tile[data-stage="received"] [data-test="flow-longest"]'), /^oldest (\d+ min|\d+ h( \d+ min)?)$/);
    assert.ok(parseFloat(await page.locator('[data-test="flow-none"]').evaluate((e) => getComputedStyle(e).fontSize)) >= 15);
    await chooseDepartment(page, 'whole-hospital');
    await page.waitForSelector('.flow-tile[data-stage="test"]');
    const head = (await page.textContent('[data-test="flow-wait"]')).replace(/^→/, '');
    assert.match(head, /^Longest wait now: .+ (for a bed|to be seen since booked time or later arrival) \(1 patient\)$/);
    assert.doesNotMatch(head, /request|result/);
    assert.match(await page.textContent('[data-test="flow-key"]'), /Requests are not ranked with patient waits/);
    assert.deepEqual(errors, []);
    await context.close();
  });
}

test('night 5 item 3: Outpatients is headed by the wait from the later of arrival and booked time, read from each clinic\'s queue', async () => {
  const { page, context, errors } = await openPage(env, { width: 390, height: 844, touch: true, department: 'outpatients', clock: CLOCK });
  await page.waitForSelector('[data-test="now-flow"]');
  const day = await asHuman(page, 'ospeli_clinics_day_summary', { limit: 200 }, 'clinic-receptionist');
  let best = -1; let early = -1;
  for (const c of day.clinics.filter((x) => x.date === day.date && x.counts.waiting > 0)) {
    const q = await asHuman(page, 'ospeli_clinics_queue', { sessionId: c.sessionId, limit: 300 }, 'clinic-receptionist');
    for (const p of q.patients.filter((x) => x.state === 'arrived' && x.arrivedAt)) {
      const since = Math.max(0, Math.round((Date.parse(q.asOf) - Date.parse(p.arrivedAt)) / 60000));
      best = Math.max(best, Math.min(since, p.pastBookedMinutes)); early = Math.max(early, since);
    }
  }
  assert.ok(best >= 1, 'the example hospital has a patient waiting past their booked time');
  const text = (await page.textContent('[data-test="flow-wait"]')).replace(/^→/, '');
  const h = Math.floor(best / 60); const m = best % 60;
  assert.equal(text, `Longest timed wait: ${h ? `${h} h${m ? ` ${m} min` : ''}` : `${m} min`} to be seen since booked time or later arrival (1 patient)`, `longest since arrival is ${early} min`);
  assert.deepEqual(errors, []);
  await context.close();
});
