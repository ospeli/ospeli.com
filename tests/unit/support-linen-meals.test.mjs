// Cleaning and transport, slice 2 (19 Nov): linen and meals. Linen is the shared stock item, so
// counts, top-ups, issues and stock-outs go through ospeli_stock_*; meals are counts for a ward, a
// day and a meal. Both KPIs recomputed from hand-made logs with hand-checked numbers; the meal
// record's checks, latest wins, a double tap and an agent's proposal; the two guide rules; the seed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Core } from '../../web/app/core/core.js';
import { MemoryAdapter } from '../../web/app/core/db.js';
import { loadSyntheticHospital, generateHospital } from '../../web/app/core/generator.js';
import { runCommand, CommandError, commandByName } from '../../web/app/core/commands.js';
import { validate } from '../../web/app/core/schema.js';
import { stockCatalogue, deriveStock } from '../../web/app/core/stock.js';
import { MODULE_PACKS } from '../../web/app/core/modules.js';
import { ALL_ROLES } from '../../web/app/core/kit.js';
import * as pack from '../../web/app/modules/support/commands.js';
import {
  deriveLinen, linenStockOuts, deriveMeals, mealWaste, ruleLinenTwoCounts, ruleMealsReturned, shiftsBetween, MEAL_USUAL_PCT,
} from '../../web/app/modules/support/logic.js';

const END = '2026-11-06T18:00:00.000Z'; // 14:00 at the example hospital (UTC-4)
const MIN = 60e3;
const human = (role) => ({ type: 'human', role });
const code = (c) => (err) => err instanceof CommandError && err.code === c;
async function site() {
  // The clock stands still while the example hospital loads and ticks a second a call after that.
  // It used to tick during the load too, so every module's seed pushed "now" later (23:22 site time
  // with 33,740 events); one more module's seed carried it past midnight and "today" became the 7th.
  let t = Date.parse(END);
  let ticking = false;
  const core = await Core.open({ adapter: new MemoryAdapter(), clock: () => new Date(ticking ? (t += 1000) : t) });
  await loadSyntheticHospital(core, { end: END });
  ticking = true;
  const run = (name, input, who) => runCommand(core, name, input, typeof who === 'string' ? human(who) : who);
  return { core, run, advance: (m) => { t += m * MIN; } };
}
const out = (name, value) => assert.deepEqual(validate(commandByName(name).output, value), [], `${name}: answer matches its schema`);
const ev = (type, subject, at, data, actorRole = 'cleaner') => ({ type, subject, actorRole, at: `2026-${at}:00.000Z`, data });

test('the pack declares linen as shared stock, with roles for every verb and a few example items; it writes no stock command of its own', () => {
  assert.deepEqual(Object.keys(pack.STOCK_CATEGORIES), ['linen']);
  assert.deepEqual(pack.STOCK_ITEMS.map((i) => i.id), ['bed-sheet', 'pillowcase', 'blanket', 'towel', 'patient-gown']);
  assert.ok(pack.STOCK_ITEMS.every((i) => i.category === 'linen' && i.unit === 'each'));
  const roles = pack.STOCK_CATEGORIES.linen.roles;
  assert.deepEqual(roles.count, ['cleaner', 'ward-nurse', 'support-supervisor']);
  assert.deepEqual([roles.issue, roles.receive, roles.levels], [['storekeeper'], ['storekeeper'], ['support-supervisor']], 'clean linen is kept in the store');
  assert.ok(!pack.COMMANDS.some((c) => /stock/.test(c.name)), 'no stock command in the pack');
  assert.ok(pack.COMMANDS.every((c) => c.name.startsWith('ospeli_support_')));
  // The shared catalogue takes it with every other module's stock, and the shared commands list its roles.
  const cat = stockCatalogue(MODULE_PACKS, ALL_ROLES);
  assert.equal(cat.items.get('towel').module, 'support');
  assert.ok(commandByName('ospeli_stock_count').roles.includes('cleaner'));
});

test('a cleaner counts a ward\'s linen with the shared command: under level raises the top-up in the same step; the store issues it; supplies stay the store\'s', async () => {
  const { run } = await site();
  const lv = await run('ospeli_stock_levels', { placeId: 'ward-a3', category: 'linen' }, 'cleaner');
  assert.deepEqual(lv.levels.map((l) => l.itemId).sort(), ['bed-sheet', 'blanket', 'patient-gown', 'pillowcase', 'towel'], 'the example ward has its five linen items with levels');
  for (const q of (await run('ospeli_stock_requests', { placeId: 'ward-a3' }, 'cleaner')).requests.filter((x) => x.lines.some((l) => l.itemId === 'towel'))) {
    await run('ospeli_stock_request_cancel', { requestId: q.id, reason: 'Supplied another way' }, 'cleaner');
  }
  const towel = lv.levels.find((l) => l.itemId === 'towel');
  const fresh = await run('ospeli_stock_levels', { placeId: 'ward-a3', category: 'linen' }, 'cleaner');
  const c = await run('ospeli_stock_count', { placeId: 'ward-a3', lines: [{ itemId: 'towel', qty: 4 }], seenSeq: fresh.asOfSeq }, 'cleaner');
  assert.deepEqual(c.requested, [{ itemId: 'towel', qty: towel.level - 4 }], 'exactly the top-up level minus the count');
  await assert.rejects(run('ospeli_stock_issue', { requestId: c.requestId }, 'cleaner'), code('forbidden'), 'a cleaner does not issue from the store');
  await assert.rejects(run('ospeli_stock_count', { placeId: 'ward-a3', lines: [{ itemId: 'gloves-m', qty: 2 }] }, 'cleaner'), code('forbidden'), 'supplies are counted by the ward and the store, not cleaning');
  await assert.rejects(run('ospeli_stock_issue', { requestId: c.requestId }, 'support-supervisor'), code('forbidden'), 'nor does the supervisor: the store does');
  const done = await run('ospeli_stock_issue', { requestId: c.requestId, expectedState: 'open' }, 'storekeeper');
  assert.equal(done.state, 'issued');
  assert.equal((await run('ospeli_stock_levels', { placeId: 'ward-a3', itemId: 'towel' }, 'cleaner')).levels[0].usable, towel.level, 'issued counts at the ward at once (it may still be on its way: #113)');
});

test('KPI linen stock-outs, hand-checked: 3 of 8 area-shifts (37.5%), night 2 of 4, day 1 of 4; 6 shifts with no count; the store and supplies left out', () => {
  const S = 'store-main'; const W1 = 'ward-a1'; const W2 = 'ward-a2';
  const events = [
    ev('stock.received', S, '10-31T10:00', { lines: [{ itemId: 'towel', qty: 50 }, { itemId: 'bed-sheet', qty: 50 }], source: 'Transfer from outside' }, 'support-supervisor'),
    ev('stock.counted', W1, '10-31T10:00', { lines: [{ itemId: 'bed-sheet', qty: 20 }, { itemId: 'towel', qty: 10 }] }),
    ev('stock.level-set', W1, '10-31T10:01', { itemId: 'bed-sheet', level: 30 }, 'support-supervisor'),
    ev('stock.level-set', W1, '10-31T10:01', { itemId: 'towel', level: 20 }, 'support-supervisor'),
    ev('stock.counted', W2, '10-31T10:00', { lines: [{ itemId: 'bed-sheet', qty: 15 }] }),
    ev('stock.level-set', W2, '10-31T10:01', { itemId: 'bed-sheet', level: 30 }, 'support-supervisor'),
    ev('stock.stock-out-started', 'so-00002', '11-01T08:00', { itemId: 'gloves-m', placeId: W1, cause: 'Not delivered' }, 'ward-nurse'), // supplies: not linen
    // Night 1: W1 counts its towels at zero at 20:00; the top-up is issued at 22:00.
    ev('stock.counted', W1, '11-01T20:00', { lines: [{ itemId: 'towel', qty: 0 }, { itemId: 'gloves-m', qty: 0 }] }),
    ev('stock.requested', 'req-00001', '11-01T20:00', { placeId: W1, fromPlaceId: S, lines: [{ itemId: 'towel', qty: 20 }], raisedBy: 'count' }),
    ev('stock.issued', 'req-00001', '11-01T22:00', { fromPlaceId: S, lines: [{ itemId: 'towel', qty: 20 }] }, 'support-supervisor'),
    // Day 2: W2 declares a stock-out of sheets for an hour, though its balance shows 15.
    ev('stock.stock-out-started', 'so-00001', '11-02T08:00', { itemId: 'bed-sheet', placeId: W2, cause: 'Not delivered' }),
    ev('stock.stock-out-ended', 'so-00001', '11-02T09:00', { careAffected: false }),
    // Night 2: W2 counts sheets at zero at 06:00 and nothing comes before the period ends at 07:00.
    ev('stock.counted', W2, '11-03T06:00', { lines: [{ itemId: 'bed-sheet', qty: 0 }] }),
    // After the period: W1's sheets at zero at 08:00.
    ev('stock.counted', W1, '11-03T08:00', { lines: [{ itemId: 'bed-sheet', qty: 0 }] }),
  ];
  const isArea = (p) => p !== S;
  const k = linenStockOuts(events, { since: '2026-11-01T07:00:00.000Z', until: '2026-11-03T07:00:00.000Z', isArea });
  assert.deepEqual([k.numerator, k.denominator, k.value, k.uncounted], [3, 8, 37.5, 6]);
  assert.deepEqual(k.byShift.map((s) => [s.id, s.numerator, s.denominator, s.value]), [['day', 1, 4, 25], ['night', 2, 4, 50]]);
  assert.deepEqual(k.breakdown.map((b) => [b.id, b.numerator, b.denominator]), [[W1, 1, 4], [W2, 2, 4]]);
  // Two hours later the day shift going on now counts so far: both areas at zero in it (W1 from 08:00, W2 since 06:00).
  const later = linenStockOuts(events, { since: '2026-11-01T07:00:00.000Z', until: '2026-11-03T09:00:00.000Z', isArea });
  assert.deepEqual([later.numerator, later.denominator, later.uncounted], [5, 10, 7]);
  // With the store taken as an area it adds four shifts and none at zero (it never ran out).
  assert.equal(linenStockOuts(events, { since: '2026-11-01T07:00:00.000Z', until: '2026-11-03T07:00:00.000Z' }).denominator, 12);
  // The shifts: day 07:00 to 19:00 and night 19:00 to 07:00, in local time.
  assert.deepEqual(shiftsBetween(Date.parse('2026-11-01T11:00:00Z'), Date.parse('2026-11-02T11:00:00Z'), -240).map((s) => [s.id, new Date(s.start).toISOString()]),
    [['day', '2026-11-01T11:00:00.000Z'], ['night', '2026-11-01T23:00:00.000Z']]);
  assert.equal(linenStockOuts([], { since: '2026-11-01T07:00:00.000Z', until: '2026-11-03T07:00:00.000Z' }).value, null, 'nothing held: no value, not 0');
});

test('KPI meal waste, hand-checked: 17 of 77 delivered (22.1%); by meal 10%, 30.8% and 16.7%; by ward 15.8% and 40%; the latest record wins; outside the dates and malformed left out', () => {
  const meal = (ward, date, m, o, d, r, at = `${date.slice(5)}T15:00`) => ev('support.meals-recorded', ward, at, { date, meal: m, ordered: o, delivered: d, returned: r }, 'ward-nurse');
  const events = [
    meal('ward-b1', '2026-10-31', 'breakfast', 20, 20, 10), // the day before
    meal('ward-a1', '2026-11-01', 'breakfast', 20, 20, 2),
    meal('ward-a1', '2026-11-01', 'midday', 20, 19, 5),
    meal('ward-a1', '2026-11-01', 'midday', 20, 19, 4, '11-01T16:00'), // recorded again: the latest wins
    meal('ward-a1', '2026-11-02', 'evening', 18, 18, 3),
    meal('ward-b1', '2026-11-02', 'midday', 22, 20, 8),
    meal('ward-b1', '2026-11-02', 'evening', 20, 10, 11), // more returned than delivered: not a record
    meal('ward-b1', '2026-11-02', 'snack', 20, 20, 1), // not a meal on the list
    meal('ward-b1', '2026-11-03', 'evening', 20, 20, 20), // the day after
  ];
  const k = mealWaste(events, { fromDate: '2026-11-01', toDate: '2026-11-02' });
  assert.deepEqual([k.numerator, k.denominator, k.n], [17, 77, 4]);
  assert.ok(Math.abs(k.value - 22.0779) < 1e-3);
  assert.deepEqual(k.breakdown.map((b) => [b.id, b.numerator, b.denominator, Math.round(b.value * 10) / 10]), [['breakfast', 2, 20, 10], ['midday', 12, 39, 30.8], ['evening', 3, 18, 16.7]]);
  assert.deepEqual(k.byWard.map((w) => [w.id, w.numerator, w.denominator, Math.round(w.value * 10) / 10]), [['ward-a1', 9, 57, 15.8], ['ward-b1', 8, 20, 40]]);
  const recs = deriveMeals(events);
  assert.deepEqual(recs.find((x) => x.wardId === 'ward-a1' && x.meal === 'midday').versions, 2);
  assert.equal(mealWaste([], { fromDate: '2026-11-01', toDate: '2026-11-02' }).value, null, 'no record: no value, never 0');
});

test('recording a meal: picks and whole numbers only; returned not above delivered; today or the six days before; a double tap is caught; recording again corrects it and both stay in the log', async () => {
  const { core, run, advance } = await site();
  const r1 = await run('ospeli_support_meals_record', { wardId: 'ward-a2', meal: 'midday', ordered: 20, delivered: 18, returned: 4 }, 'cleaner');
  out('ospeli_support_meals_record', r1);
  assert.deepEqual([r1.status, r1.date, r1.replaced, r1.wastePercent], ['done', '2026-11-06', false, 22.2], 'today in the site\'s own time');
  const n = await core.eventCount();
  await assert.rejects(run('ospeli_support_meals_record', { wardId: 'ward-a2', meal: 'midday', ordered: 20, delivered: 18, returned: 4 }, 'cleaner'), (e) => code('conflict')(e) && e.detail.already === true, 'a double tap');
  assert.equal(await core.eventCount(), n, 'nothing written twice');
  advance(3);
  const r2 = await run('ospeli_support_meals_record', { wardId: 'ward-a2', date: '2026-11-06', meal: 'midday', ordered: 20, delivered: 18, returned: 5 }, 'ward-nurse');
  assert.deepEqual([r2.replaced, r2.previous], [true, { ordered: 20, delivered: 18, returned: 4 }]);
  const list = await run('ospeli_support_meals_list', { wardId: 'ward-a2', days: 1 }, 'porter');
  out('ospeli_support_meals_list', list);
  assert.deepEqual(list.records.map((x) => [x.meal, x.returned, x.corrected]), [['midday', 5, true]], 'the latest wins');
  assert.deepEqual([list.waste.numerator, list.waste.denominator], [5, 18]);
  assert.match(list.note, /Diets and allergies are not handled here/);
  assert.equal((await core.events({ type: 'support.meals-recorded', subject: 'ward-a2' })).length, 2, 'both versions are kept in the log');
  assert.equal((await core.auditLog()).filter((a) => a.action === 'support.meals-recorded' && a.target === 'ward-a2').length, 2, 'one audit entry for each, numbers and picks only');
  // Refusals: every one before anything is written.
  const m = await core.eventCount();
  const base = { wardId: 'ward-a2', meal: 'evening', ordered: 20, delivered: 18, returned: 2 };
  for (const [input, c, why] of [
    [{ ...base, returned: 19 }, 'invalid-input', 'more returned than delivered'],
    [{ ...base, date: '2026-11-07' }, 'invalid-input', 'a day that has not come'],
    [{ ...base, date: '2026-10-30' }, 'invalid-input', 'older than the six days before today'],
    [{ ...base, date: '2026-02-30' }, 'invalid-input', 'not a calendar date'],
    [{ ...base, date: '6 Nov' }, 'invalid-input', 'not the date form'],
    [{ ...base, ordered: 501 }, 'invalid-input', 'above the bound'],
    [{ ...base, delivered: -1 }, 'invalid-input', 'below zero'],
    [{ ...base, returned: 2.5 }, 'invalid-input', 'not a whole number'],
    [{ ...base, meal: 'snack' }, 'invalid-input', 'not a meal on the list'],
    [{ ...base, diet: 'soft' }, 'invalid-input', 'no diet field'],
    [{ ...base, note: 'Mr Smith refused his meal' }, 'invalid-input', 'no typed text at all'],
    [{ ...base, wardId: 'dept-imaging' }, 'not-found', 'a department is not a ward'],
    [{ ...base, wardId: 'ward-a2-bed-04' }, 'not-found', 'meals are for a ward, never a bed'],
  ]) await assert.rejects(run('ospeli_support_meals_record', input, 'ward-nurse'), code(c), why);
  await assert.rejects(run('ospeli_support_meals_record', { ...base, wardId: 'ward-zz9' }, 'ward-nurse'), (e) => code('not-found')(e) && !e.message.includes('ward-zz9'), 'a made-up id is not echoed');
  for (const role of ['porter', 'bed-manager', 'storekeeper']) await assert.rejects(run('ospeli_support_meals_record', base, role), code('forbidden'), role);
  assert.equal(await core.eventCount(), m, 'nothing was written');
});

test('an agent\'s meal record is a proposal that changes nothing until a person accepts; it reads and proposes only for its own wards', async () => {
  const { core, run } = await site();
  await run('ospeli_agents_set_access', { allowed: true, wards: { 'ward-a2': true, 'ward-b1': true } }, 'coo');
  await run('ospeli_agents_add', { name: 'meals-bot', role: 'ward-nurse', wards: ['ward-a2'], days: 30 }, 'coo');
  const bot = { type: 'agent', role: 'ward-nurse', agent: 'meals-bot' };
  const seen = await run('ospeli_support_meals_list', { days: 7 }, bot);
  assert.ok(seen.records.every((x) => x.wardId === 'ward-a2'), 'only its own ward');
  await assert.rejects(run('ospeli_support_meals_list', { wardId: 'ward-b1' }, bot), code('forbidden'));
  const n = await core.eventCount();
  const p = await run('ospeli_support_meals_record', { wardId: 'ward-a2', meal: 'breakfast', ordered: 19, delivered: 19, returned: 1 }, bot);
  assert.equal(p.status, 'proposed');
  assert.equal(await core.eventCount(), n, 'nothing changed');
  await assert.rejects(run('ospeli_support_meals_record', { wardId: 'ward-b1', meal: 'breakfast', ordered: 19, delivered: 19, returned: 1 }, bot), code('forbidden'), 'not its ward');
  await assert.rejects(run('ospeli_proposals_accept', { id: p.proposal.id }, 'porter'), code('forbidden'), 'a role that cannot record meals cannot accept one');
  assert.equal((await run('ospeli_proposals_accept', { id: p.proposal.id }, 'cleaner')).status, 'accepted');
  const e = (await core.events({ type: 'support.meals-recorded' })).at(-1);
  assert.deepEqual([e.subject, e.actorRole, e.data], ['ward-a2', 'cleaner', { date: '2026-11-06', meal: 'breakfast', ordered: 19, delivered: 19, returned: 1 }]);
  const entry = (await core.auditLog()).filter((a) => a.action === 'support.meals-recorded').at(-1);
  assert.deepEqual([entry.actorType, entry.actorRole], ['human', 'cleaner'], 'recorded as done by the person who accepted');
});

test('guide rule "linen under its top-up level twice": offers a top-up for exactly what is short; says so when one is waiting; nothing once topped up', () => {
  const W = 'ward-a1'; const S = 'store-main';
  const start = [
    ev('stock.received', S, '11-01T05:00', { lines: [{ itemId: 'towel', qty: 100 }, { itemId: 'blanket', qty: 10 }], source: 'Transfer from outside' }, 'support-supervisor'),
    ev('stock.counted', W, '11-01T06:00', { lines: [{ itemId: 'towel', qty: 20 }, { itemId: 'blanket', qty: 8 }] }),
    ev('stock.level-set', W, '11-01T06:01', { itemId: 'towel', level: 30 }, 'support-supervisor'),
    ev('stock.level-set', W, '11-01T06:01', { itemId: 'blanket', level: 10 }, 'support-supervisor'),
    ev('stock.counted', W, '11-01T18:00', { lines: [{ itemId: 'towel', qty: 14 }, { itemId: 'blanket', qty: 12 }] }),
    ev('stock.counted', W, '11-02T06:00', { lines: [{ itemId: 'towel', qty: 11 }, { itemId: 'blanket', qty: 9 }] }),
  ];
  const run = (events) => ruleLinenTwoCounts(events, { stock: deriveLinen(events), now: '2026-11-02T07:00:00.000Z', isArea: (p) => p !== S, placeName: () => 'Ward A1', itemName: (i) => ({ towel: 'Towel', blanket: 'Blanket' })[i] });
  const [s] = run(start);
  assert.equal(s.text, 'Ask for a linen top-up for Ward A1: towel 19.', 'towels under 30 twice (14, 11); blankets were over level at 18:00, so not twice running');
  assert.match(s.why, /towel \(11 of 30\)/);
  assert.match(s.basis, /Example setting, not a standard/);
  assert.deepEqual(s.action, { label: 'Ask for this top-up', command: 'ospeli_stock_request', inputs: [{ placeId: W, lines: [{ itemId: 'towel', qty: 19 }] }] });
  const asked = [...start, ev('stock.requested', 'req-00001', '11-02T06:00', { placeId: W, fromPlaceId: S, lines: [{ itemId: 'towel', qty: 19 }], raisedBy: 'count' })];
  const [w] = run(asked);
  assert.deepEqual([w.id, w.action], [`linen-two-counts:${W}:waiting`, null]);
  assert.match(w.text, /req-00001 is still waiting/);
  assert.deepEqual(run([...asked, ev('stock.issued', 'req-00001', '11-02T06:30', { fromPlaceId: S, lines: [{ itemId: 'towel', qty: 19 }] }, 'support-supervisor')]), [], 'topped up: nothing to say');
  assert.deepEqual(run(start.slice(0, 5)), [], 'one count under level is not two');
});

test('guide rule "many meals returned uneaten": above the usual level over recent days, with the numbers; too few days or meals says nothing; advice only', () => {
  const rec = (date, d, r, meal = 'midday', wardId = 'ward-b1') => ({ wardId, date, meal, ordered: d, delivered: d, returned: r, versions: 1 });
  const opts = { toDate: '2026-11-06', placeName: () => 'Ward B1' };
  const [s] = ruleMealsReturned([rec('2026-11-04', 20, 4), rec('2026-11-05', 20, 4), rec('2026-11-06', 20, 4), rec('2026-10-30', 20, 0)], opts);
  // #172: uneaten meals can mean patients are not eating, so the rule never reads as "order less".
  assert.equal(s.text, 'Check the midday meal numbers ordered for Ward B1 with the ward. Uneaten meals can also mean patients are not eating: tell the charge nurse, and do not cut the order on this figure alone.');
  // #172: the 15% has no source; the published figures are weighed plate waste, a different measure.
  assert.match(s.basis, /no published figure for whole meals returned/);
  assert.match(s.why, /^20% came back uneaten over the last 7 days \(12 of 60 delivered, 3 days recorded\), above the usual level of 15%/);
  assert.equal(s.action, null);
  assert.equal(MEAL_USUAL_PCT, 15);
  assert.deepEqual(ruleMealsReturned([rec('2026-11-05', 30, 9), rec('2026-11-06', 30, 9)], opts), [], 'two days recorded is too few');
  assert.deepEqual(ruleMealsReturned([rec('2026-11-04', 10, 2), rec('2026-11-05', 10, 2), rec('2026-11-06', 9, 2)], opts), [], 'under 30 delivered is too few');
  assert.deepEqual(ruleMealsReturned([rec('2026-11-04', 20, 3), rec('2026-11-05', 20, 3), rec('2026-11-06', 20, 3)], opts), [], '15% is not above 15%');
});

test('the overview gives both measures with values, the guide\'s linen and meal suggestions on the example hospital, and a person acts on the top-up; with the guide off the measures are the same', async () => {
  const { run } = await site();
  const ov = await run('ospeli_support_overview', {}, 'support-supervisor');
  out('ospeli_support_overview', ov);
  assert.deepEqual(ov.planned, []);
  const k = Object.fromEntries(ov.kpis.map((x) => [x.id, x]));
  assert.deepEqual(ov.taskKpis, ['support-bed-turnaround', 'porter-request-to-done', 'cleanliness-audit-score']);
  assert.ok(k['linen-stock-outs'].denominator > 20 && k['linen-stock-outs'].value != null && k['linen-stock-outs'].uncounted >= 0);
  assert.equal(k['linen-stock-outs'].source, 'local definition');
  assert.match(k['linen-stock-outs'].leavesOut, /A shift with no count is not left out and not guessed/);
  assert.ok(k['meal-waste'].denominator > 100 && k['meal-waste'].value > 0 && k['meal-waste'].value < 30);
  assert.ok(k['meal-waste'].byWard.length === 4 && k['meal-waste'].byWard.every((w) => /^Ward /.test(w.name)));
  const ask = ov.guide.suggestions.find((s) => s.rule === 'linen-two-counts' && s.action);
  assert.ok(ask, 'a top-up to offer');
  assert.match(ask.text, /^Ask for a linen top-up for Ward C1 \(maternity\): /);
  assert.ok(ov.guide.suggestions.some((s) => s.id === 'meals-returned:ward-b1:midday'));
  for (const input of ask.action.inputs) await run(ask.action.command, input, 'cleaner');
  const after = await run('ospeli_support_overview', {}, 'support-supervisor');
  assert.ok(!after.guide.suggestions.some((s) => s.id === ask.id), 'asked for: the offer goes');
  assert.ok(after.guide.suggestions.some((s) => s.id === `${ask.id}:waiting`), 'and it now says the top-up is waiting');
  await run('ospeli_support_guide_set', { on: false }, 'support-supervisor');
  const off = await run('ospeli_support_overview', {}, 'support-supervisor');
  assert.deepEqual(off.guide.suggestions, []);
  assert.deepEqual(off.kpis.filter((x) => ['linen-stock-outs', 'meal-waste'].includes(x.id)), after.kpis.filter((x) => ['linen-stock-outs', 'meal-waste'].includes(x.id)));
});

test('synthetic linen and meals: through stock.* and support.* events only; every movement fits the shared stock item; ids of their own; no linen stock-out left open; a meal record corrected once', () => {
  for (const end of [END, '2026-11-10T14:00:00.000Z', '2026-11-18T03:00:00.000Z']) {
    const { events, entities } = generateHospital({ end });
    const evs = events.map((e, i) => ({ ...e, seq: i + 1 }));
    const cat = stockCatalogue(MODULE_PACKS, ALL_ROLES);
    const all = deriveStock(evs.filter((e) => e.type.startsWith('stock.')), { items: cat.items, categories: cat.categories, offsetMinutes: -240 });
    assert.equal(all.problems, 0, `${end}: with every module's stock, every movement fits and nothing goes below zero`);
    const linen = deriveLinen(evs, -240);
    const reqs = [...linen.requests.values()];
    assert.ok(reqs.length > 100 && reqs.every((q) => /^req-1\d{5}$/.test(q.id)), 'linen request ids of their own (never another module\'s seeded ids)');
    assert.ok([...linen.stockOuts.values()].every((s) => s.endedAt && /^so-1\d{5}$/.test(s.id)), 'declared linen stock-outs all ended');
    const wards = new Set([...linen.holdings.values()].filter((h) => h.placeId.startsWith('ward-')).map((h) => h.placeId));
    assert.deepEqual([...wards].sort(), ['ward-a1', 'ward-a3', 'ward-b1', 'ward-c1']);
    assert.ok([...linen.holdings.values()].every((h) => !h.placeId.startsWith('ward-') || h.level), 'every ward item has a top-up level');
    const meals = evs.filter((e) => e.type === 'support.meals-recorded');
    const recs = deriveMeals(meals);
    assert.equal(recs.length, meals.length - 1, 'one record corrected');
    assert.ok(recs.every((x) => x.returned <= x.delivered && x.delivered <= x.ordered + 1 && x.date <= end.slice(0, 10)));
    assert.ok(evs.filter((e) => e.type.startsWith('stock.') && JSON.stringify(e.data).match(/bed-sheet|pillowcase|blanket|towel|patient-gown/)).every((e) => ['cleaner', 'ward-nurse', 'support-supervisor', 'storekeeper'].includes(e.actorRole)));
    for (const e of meals) assert.equal(/"[a-z]*(name|patient|diet|allerg|texture|staff)[a-z]*":/i.test(JSON.stringify(e.data)), false, 'no person, no diet');
    assert.ok(entities.some((e) => e.type === 'store'));
  }
});
