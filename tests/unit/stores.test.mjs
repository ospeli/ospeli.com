// Stores and supplies (module stores): its commands without the screen, every refusal, agent
// proposals (an agent's purchase approval is refused), attack tests, each KPI recomputed from the
// event log with hand-checked numbers, the guide's rules on and off, and the synthetic history
// replayed through the shared stock item with no problem.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Core } from '../../web/app/core/core.js';
import { MemoryAdapter } from '../../web/app/core/db.js';
import { generateHospital } from '../../web/app/core/generator.js';
import { loadHospital } from './hospital-clock.mjs';
import { runCommand, CommandError, commandByName, listCommands } from '../../web/app/core/commands.js';
import { validate } from '../../web/app/core/schema.js';
import { ROLES } from '../../web/app/core/model.js';
import { deriveStock, stockCatalogue, balance } from '../../web/app/core/stock.js';
import * as pack from '../../web/app/modules/stores/commands.js';
import { MODULE_PACKS } from '../../web/app/core/modules.js';
import {
  CATALOGUE, deriveSupplies, deriveOrders, orderSteps, overUsual, tracerStockOutRate, requestWaitHours, orderCycleTime, fillRatePercent,
  ruleLevelCheck, ruleOrderWaiting, ruleTransfer, guideOn, GUIDE_RULES, shortNow, SHORT_SHARE, REQUEST_USUAL_HOURS, percentText, countIntervals,
} from '../../web/app/modules/stores/logic.js';

const END = '2026-11-06T18:00:00.000Z';
const DAY = 864e5; const HOUR = 36e5; const MIN = 6e4;
const ROLE_IDS = ROLES.map((r) => r.id);
const human = (role) => ({ type: 'human', role });
const code = (c) => (err) => err instanceof CommandError && err.code === c;
const out = (name, value) => assert.deepEqual(validate(commandByName(name).output, value), [], `${name}: answer matches its schema`);

// A site on a clock the test moves (each reading one second later; skip(m) jumps m minutes), with
// the example hospital and, unless asked otherwise, the module's history.
async function site({ withHistory = true, noStore = false } = {}) {
  let t = Date.parse(END);
  const core = await Core.open({ adapter: new MemoryAdapter(), clock: () => new Date(t += 1000) });
  if (noStore) {
    const { entities } = generateHospital({ end: END });
    await core.putEntities(entities.filter((e) => e.type !== 'store'), 'system', 'an older example hospital with no store');
  } else {
    // The example hospital carries the module's history (its seed); modules: false leaves it out.
    await loadHospital(core, { end: END, modules: withHistory });
  }
  const run = (name, input, who) => runCommand(core, name, input, typeof who === 'string' ? human(who) : who);
  return { core, run, skip: (m) => { t += m * MIN; } };
}

test('the pack: about twenty generic supplies items, nothing cold-chain or priced; the shared stock commands it gets; its own five', () => {
  assert.ok(pack.STOCK_ITEMS.length >= 18 && pack.STOCK_ITEMS.length <= 25);
  assert.ok(pack.STOCK_ITEMS.every((it) => it.category === 'supplies' && !it.coldChain && !it.batched));
  assert.ok(pack.STOCK_ITEMS.filter((it) => it.tracer).length >= 4, 'several tracer items');
  assert.equal(/price|cost|currency|brand|supplier|vendor/i.test(JSON.stringify(pack.STOCK_ITEMS)), false);
  const { categories } = stockCatalogue([pack], ROLE_IDS);
  assert.deepEqual(categories.supplies.roles.issue, ['storekeeper']);
  const names = listCommands().map((c) => c.name);
  for (const n of ['count', 'request', 'issue', 'receive', 'transfer', 'out_start', 'out_end', 'level_set', 'item_add', 'outs']) assert.ok(names.includes(`ospeli_stock_${n}`), n);
  assert.ok(!names.includes('ospeli_stock_use'), 'nobody records "use" of ward supplies here: a count finds it');
  assert.deepEqual(pack.COMMANDS.map((c) => c.name), ['ospeli_stores_overview', 'ospeli_stores_orders', 'ospeli_stores_order_step', 'ospeli_stores_order_remind', 'ospeli_stores_guide_set']);
  for (const c of pack.COMMANDS) for (const [k, v] of Object.entries(c.input.properties)) assert.ok(v.description?.length >= 15, `${c.name}.${k} has a description`);
  assert.equal(commandByName('ospeli_stores_guide_set').agents, false, 'the guide switch is for people only');
  assert.ok(!commandByName('ospeli_stores_order_step').input.properties.step.enum.includes('received'), 'received comes from the receipt, never typed as a step');
});

test('the synthetic history replays through the shared stock item with no problem, and ends as the brief asks', () => {
  for (const end of [END, '2026-11-10T14:00:00.000Z', '2026-11-18T03:00:00.000Z']) {
    // The example hospital's own events, as the generator makes them with the module's seed.
    const { events } = generateHospital({ end });
    const evs = events.filter((e) => e.type.startsWith('stock.') || e.type.startsWith('stores.')).map((e, i) => ({ ...e, seq: i + 1 }));
    assert.deepEqual(generateHospital({ end }).events.length, events.length, 'the same seed gives the same history');
    assert.equal(generateHospital({ end, modules: false }).events.filter((e) => e.type.startsWith('stock.')).length, 0, 'modules: false leaves it out');
    assert.ok(evs.every((e) => (e.type.startsWith('stock.') || e.type.startsWith('stores.')) && ROLE_IDS.includes(e.actorRole) && e.at <= end));
    // Every module's stock shares one log (linen is the support module's), so "every movement fits"
    // is checked with every module's catalogue; what Stores itself ends with is read with its own.
    const everyone = stockCatalogue(MODULE_PACKS, ROLE_IDS);
    assert.equal(deriveStock(evs, { items: everyone.items, categories: everyone.categories }).problems, 0, `${end}: every movement fits and no balance goes below zero`);
    const stock = deriveStock(evs, { items: CATALOGUE.items, categories: CATALOGUE.categories });
    const { orders, problems } = deriveOrders(evs);
    assert.equal(problems, 0);
    const open = [...stock.requests.values()].filter((q) => q.state === 'open' || q.state === 'part');
    assert.ok(open.length >= 3, `${end}: a few requests wait at the end (${open.length})`);
    const outs = [...stock.stockOuts.values()];
    assert.ok(outs.filter((s) => s.endedAt).length >= 2, 'stock-outs declared and ended, with causes');
    const still = outs.filter((s) => !s.endedAt);
    assert.equal(still.length, 1);
    assert.equal(balance(stock.holdings.get(`${still[0].itemId}|${still[0].placeId}`), end).usable, 0, 'one ward item at zero with an open stock-out');
    assert.ok([...orders.values()].some((o) => o.state === 'requested' && overUsual(o, end)), 'one order waiting for approval longer than usual');
    assert.ok([...orders.values()].filter((o) => o.state === 'received').length >= 2);
    assert.ok(evs.some((e) => e.type === 'stock.received' && e.data.source === 'Donation'), 'one donation');
    // The guide has something to say on each rule.
    const isArea = (p) => p.startsWith('ward-');
    assert.ok(ruleLevelCheck(stock, { now: end, isArea }).length >= 1);
    assert.ok(ruleTransfer(stock, { now: end, isArea }).length >= 1);
    assert.ok(ruleOrderWaiting(orders, { now: end }).length >= 1);
    // No key that could hold a person, a price or a supplier.
    for (const e of evs) assert.equal(/"[a-z]*(name|phone|email|staff|price|cost|supplier|brand)[a-z]*":/i.test(JSON.stringify(e.data)), false, e.type);
  }
});

test('a ward count under level raises the request in the same step; the ward sees it; the storekeeper issues it and the measure changes', async () => {
  const { core, run } = await site();
  const before = await run('ospeli_stores_overview', {}, 'storekeeper');
  out('ospeli_stores_overview', before);
  const w = before.kpis.find((k) => k.id === 'stores-request-wait');
  // A ward with nothing waiting, so its count raises a new request.
  const levels = await run('ospeli_stock_levels', { placeId: 'ward-b1', category: 'supplies' }, 'ward-nurse');
  const waiting = (await run('ospeli_stock_requests', { placeId: 'ward-b1' }, 'ward-nurse')).requests;
  for (const q of waiting) await run('ospeli_stock_request_cancel', { requestId: q.id, reason: 'Supplied another way' }, 'ward-nurse');
  const row = levels.levels.find((r) => r.itemId === 'gloves-m');
  const counted = await run('ospeli_stock_count', { placeId: 'ward-b1', lines: [{ itemId: 'gloves-m', qty: 1 }], seenSeq: levels.asOfSeq }, 'ward-nurse');
  assert.deepEqual(counted.requested, [{ itemId: 'gloves-m', qty: row.level - 1 }], 'exactly level minus count, with no extra step');
  const seen = (await run('ospeli_stock_requests', { placeId: 'ward-b1' }, 'ward-nurse')).requests[0];
  assert.deepEqual([seen.id, seen.state, seen.raisedBy], [counted.requestId, 'open', 'count'], 'the ward sees its request and its state');
  const done = await run('ospeli_stock_issue', { requestId: counted.requestId, expectedState: 'open' }, 'storekeeper');
  assert.equal(done.state, 'issued');
  assert.equal((await run('ospeli_stock_requests', { placeId: 'ward-b1', state: 'issued', limit: 1 }, 'ward-nurse')).requests[0].stateName, 'Issued', 'and sees it move');
  const after = (await run('ospeli_stores_overview', {}, 'storekeeper')).kpis.find((k) => k.id === 'stores-request-wait');
  assert.equal(after.n, w.n + 1, 'the request wait counts it');
  // A second tap on Issue: refused as already issued, nothing written twice.
  const n = await core.eventCount();
  await assert.rejects(run('ospeli_stock_issue', { requestId: counted.requestId }, 'storekeeper'), (e) => code('conflict')(e) && e.detail.state === 'issued');
  assert.equal(await core.eventCount(), n);
});

test('an order through its steps: people approve; steps go in order; a part delivery keeps it open; the receipt that completes it is its "received"; the cycle time counts it', async () => {
  const { core, run, skip } = await site();
  const made = await run('ospeli_stores_order_step', { step: 'requested', lines: [{ itemId: 'gauze-swabs', qty: 30 }, { itemId: 'aprons', qty: 12 }] }, 'storekeeper');
  out('ospeli_stores_order_step', made);
  assert.match(made.orderId, /^ord-\d{5}$/);
  const o = made.orderId;
  // A double tap on "request" is caught; a real second order says so.
  await assert.rejects(run('ospeli_stores_order_step', { step: 'requested', lines: [{ itemId: 'aprons', qty: 12 }, { itemId: 'gauze-swabs', qty: 30 }] }, 'storekeeper'), (e) => code('conflict')(e) && e.detail.confirm === 'again');
  // Who records what: the roles that request do not approve.
  await assert.rejects(run('ospeli_stores_order_step', { step: 'approved', orderId: o }, 'supply-manager'), code('forbidden'));
  await assert.rejects(run('ospeli_stores_order_step', { step: 'approved', orderId: o }, 'storekeeper'), code('forbidden'));
  await assert.rejects(run('ospeli_stores_order_step', { step: 'ordered', orderId: o }, 'supply-manager'), (e) => code('conflict')(e) && /not approved yet/.test(e.message), 'no step skipped');
  skip(30 * 60);
  await run('ospeli_stores_order_step', { step: 'approved', orderId: o, expectedStep: 'requested' }, 'ops-manager');
  await assert.rejects(run('ospeli_stores_order_step', { step: 'approved', orderId: o }, 'coo'), code('conflict'), 'approved once');
  await assert.rejects(run('ospeli_stores_order_step', { step: 'ordered', orderId: o, expectedStep: 'requested' }, 'supply-manager'), (e) => code('conflict')(e) && e.detail.state === 'approved', 'it changed since the caller looked');
  skip(60 * 24);
  await run('ospeli_stores_order_step', { step: 'ordered', orderId: o, expectedStep: 'approved' }, 'supply-manager');
  await assert.rejects(run('ospeli_stores_order_step', { step: 'cancelled', orderId: o }, 'supply-manager'), code('invalid-input'), 'a cancel needs a picked reason');
  skip(60 * 24 * 3);
  const before = await run('ospeli_stores_overview', { days: 7 }, 'supply-manager');
  const k = (ov) => ov.kpis.find((x) => x.id === 'stores-order-cycle');
  // A part delivery does not close the order: it is part received, still open, with what is still to come.
  await run('ospeli_stock_receive', { placeId: 'store-main', lines: [{ itemId: 'gauze-swabs', qty: 30 }, { itemId: 'aprons', qty: 10 }], source: 'Purchase', orderRef: o }, 'storekeeper');
  let got = (await run('ospeli_stores_orders', { state: 'open', limit: 50 }, 'coo')).orders.find((x) => x.id === o);
  assert.equal(got.state, 'part-received');
  assert.equal(got.waitingFor, 'Waiting for the rest of the delivery');
  assert.deepEqual(got.lines.map((l) => [l.itemId, l.qty, l.received, l.toCome, l.over]), [['gauze-swabs', 30, 30, 0, false], ['aprons', 12, 10, 2, false]]);
  assert.equal(got.steps.at(-1).step, 'part-received', 'the last step shows as part received');
  let mid = await run('ospeli_stores_overview', { days: 7 }, 'supply-manager');
  assert.deepEqual([k(mid).n, k(mid).open], [k(before).n, k(before).open], 'not counted as received; still open beside the value');
  await assert.rejects(run('ospeli_stores_order_step', { step: 'delivered', orderId: o }, 'storekeeper'), (e) => code('conflict')(e) && /Part of this order is received/.test(e.message));
  skip(60 * 24);
  mid = await run('ospeli_stores_overview', { days: 7 }, 'supply-manager');
  // The rest arrives, more than was still expected: received in full at this last receipt, and flagged, not refused.
  await run('ospeli_stock_receive', { placeId: 'store-main', lines: [{ itemId: 'aprons', qty: 5 }], source: 'Purchase', orderRef: o }, 'storekeeper');
  const list = await run('ospeli_stores_orders', { state: 'received', limit: 50 }, 'coo');
  out('ospeli_stores_orders', list);
  got = list.orders.find((x) => x.id === o);
  assert.equal(got.state, 'received');
  assert.deepEqual(got.lines.map((l) => [l.itemId, l.qty, l.received, l.over]), [['gauze-swabs', 30, 30, false], ['aprons', 12, 15, true]], 'what came against what was ordered');
  assert.equal(got.overReceived, true);
  assert.deepEqual(got.steps.map((s) => [s.step, !!s.at]), [['requested', true], ['approved', true], ['ordered', true], ['delivered', false], ['received', true]]);
  assert.equal(got.steps[1].days, 1, 'one day at "approved" before it was ordered');
  assert.equal(got.cycleDays, 6.3, 'requested, then 30 h, 24 h, 72 h and 24 h (and a few clock seconds): 6.25 days to the last receipt, shown to one decimal');
  const after = await run('ospeli_stores_overview', { days: 7 }, 'supply-manager');
  assert.deepEqual([k(after).n, k(after).open], [k(mid).n + 1, k(mid).open - 1], 'the order cycle time counts it, and it is no longer open');
  await assert.rejects(run('ospeli_stores_order_step', { step: 'cancelled', orderId: o, reason: 'Other' }, 'supply-manager'), (e) => code('conflict')(e) && /already received/.test(e.message));
  // A cancel of an open order, with a pick; the trail holds ids and picks only.
  const other = await run('ospeli_stores_order_step', { step: 'requested', lines: [{ itemId: 'masks', qty: 5 }] }, 'supply-manager');
  await run('ospeli_stores_order_step', { step: 'cancelled', orderId: other.orderId, reason: 'Ordered another way' }, 'ops-manager');
  const trail = (await core.auditLog()).filter((e) => e.action === 'stores.order-step');
  assert.deepEqual(trail.at(-1).detail, { step: 'cancelled', reason: 'Ordered another way' });
  assert.deepEqual(await core.verifyAudit(), { ok: true });
});

test('agents: an order step becomes a proposal and changes nothing until a person accepts; an agent\'s approval is refused outright; the guide switch is people only', async () => {
  const { core, run } = await site();
  const wards = (await core.listEntities('ward')).map((w) => w.id);
  await run('ospeli_agents_set_access', { allowed: true, wards: Object.fromEntries(wards.map((id) => [id, true])) }, 'coo');
  await run('ospeli_agents_add', { name: 'stores-bot', role: 'supply-manager', wards, days: 30 }, 'coo');
  await run('ospeli_agents_add', { name: 'approve-bot', role: 'ops-manager', wards, days: 30 }, 'coo');
  const bot = { type: 'agent', agent: 'stores-bot', role: 'supply-manager' };
  const open = await run('ospeli_stores_orders', {}, bot);
  const approved = open.orders.find((o) => o.state === 'approved');
  const n = await core.eventCount();
  const p = await run('ospeli_stores_order_step', { step: 'ordered', orderId: approved.id, expectedStep: 'approved' }, bot);
  assert.equal(p.status, 'proposed');
  assert.equal(await core.eventCount(), n, 'nothing changed');
  assert.equal((await run('ospeli_stores_orders', {}, 'coo')).orders.find((o) => o.id === approved.id).state, 'approved');
  const acc = await run('ospeli_proposals_accept', { id: p.proposal.id }, 'supply-manager');
  assert.equal(acc.status, 'accepted');
  assert.equal((await run('ospeli_stores_orders', {}, 'coo')).orders.find((o) => o.id === approved.id).state, 'ordered');
  // People approve purchases: refused for an agent in the role that approves, before anything is queued.
  const waiting = open.orders.find((o) => o.state === 'requested');
  const before = (await core.proposals()).length;
  await assert.rejects(run('ospeli_stores_order_step', { step: 'approved', orderId: waiting.id }, { type: 'agent', agent: 'approve-bot', role: 'ops-manager' }), (e) => code('forbidden')(e) && /People approve purchases/.test(e.message));
  assert.equal((await core.proposals()).length, before, 'no proposal was queued');
  // And inside the command itself, whoever calls it.
  await assert.rejects(commandByName('ospeli_stores_order_step').run(core, { step: 'approved', orderId: waiting.id }, { actor: { type: 'agent', agent: 'approve-bot', role: 'ops-manager' } }), code('forbidden'));
  await assert.rejects(run('ospeli_stores_guide_set', { on: false }, bot), code('forbidden'));
  await assert.rejects(run('ospeli_stock_level_set', { itemId: 'gloves-m', placeId: 'ward-a1', level: 40 }, bot), code('forbidden'), 'a level is set by a person');
  // A shared stock write from an agent waits too.
  await run('ospeli_agents_add', { name: 'ward-bot', role: 'ward-nurse', wards: ['ward-a2'], days: 30 }, 'coo');
  const c = await run('ospeli_stock_count', { placeId: 'ward-a2', lines: [{ itemId: 'gloves-m', qty: 1 }] }, { type: 'agent', agent: 'ward-bot', role: 'ward-nurse' });
  assert.equal(c.status, 'proposed');
});

test('a reminder: sent by a person for the role that holds the step, at most one a day; it shows for that role', async () => {
  const { run, skip } = await site();
  const ov = await run('ospeli_stores_overview', {}, 'supply-manager');
  const s = ov.guide.suggestions.find((x) => x.rule === 'order-waiting');
  assert.equal(s.action.command, 'ospeli_stores_order_remind');
  const sent = await run('ospeli_stores_order_remind', s.action.inputs[0], 'supply-manager');
  out('ospeli_stores_order_remind', sent);
  assert.deepEqual(sent.roles, ['ops-manager', 'coo']);
  await assert.rejects(run('ospeli_stores_order_remind', s.action.inputs[0], 'supply-manager'), (e) => code('conflict')(e) && e.detail.already === true);
  const again = await run('ospeli_stores_overview', {}, 'ops-manager');
  assert.ok(again.reminders.some((r) => r.orderId === s.action.inputs[0].orderId && r.roles.includes('ops-manager')));
  assert.equal(again.guide.suggestions.find((x) => x.id === s.id).action, null, 'no second reminder offered the same day');
  await assert.rejects(run('ospeli_stores_order_remind', s.action.inputs[0], 'ward-nurse'), code('forbidden'));
  skip(25 * 60);
  await run('ospeli_stores_order_remind', s.action.inputs[0], 'storekeeper');
});

test('attack: unknown fields, made-up ids (never echoed), wrong roles, not-supplies items and wrong shapes are refused and nothing is written', async () => {
  const { core, run } = await site();
  const n = await core.eventCount();
  const step = (input, role = 'supply-manager') => run('ospeli_stores_order_step', input, role);
  const line = [{ itemId: 'gloves-m', qty: 2 }];
  await assert.rejects(step({ step: 'requested', lines: line, note: 'from Mr Example, call 555 0100' }), code('invalid-input'), 'no field takes typed text');
  await assert.rejects(step({ step: 'requested', lines: [{ itemId: 'gloves-m', qty: 2, price: 9 }] }), code('invalid-input'), 'no price');
  await assert.rejects(step({ step: 'requested', lines: [{ itemId: 'gloves-m', qty: 2, supplier: 'x' }] }), code('invalid-input'));
  await assert.rejects(step({ step: 'received', orderId: 'ord-00001' }), code('invalid-input'), 'received is not typed');
  await assert.rejects(step({ step: 'requested', lines: [{ itemId: 'zz-made-up', qty: 1 }] }), (e) => code('not-found')(e) && !e.message.includes('zz-made-up'));
  await assert.rejects(step({ step: 'ordered', orderId: 'ord-99999' }), (e) => code('not-found')(e) && !e.message.includes('99999'));
  await assert.rejects(step({ step: 'ordered', orderId: 'ord-1; drop' }), code('invalid-input'));
  await assert.rejects(step({ step: 'requested', lines: [{ itemId: 'gloves-m', qty: 0 }] }), code('invalid-input'));
  await assert.rejects(step({ step: 'requested', lines: [{ itemId: 'gloves-m', qty: 1 }, { itemId: 'gloves-m', qty: 2 }] }), code('invalid-input'));
  await assert.rejects(step({ step: 'requested', lines: line, placeId: 'ward-a1' }), code('not-found'), 'an order arrives at a store');
  await assert.rejects(step({ step: 'requested', lines: line, orderId: 'ord-00001' }), code('invalid-input'));
  await assert.rejects(step({ step: 'requested', lines: line }, 'ward-nurse'), code('forbidden'));
  await assert.rejects(step({ step: 'requested', lines: line }, 'estates-tech'), code('forbidden'));
  await assert.rejects(run('ospeli_stores_order_remind', { orderId: 'ord-99999', expectedStep: 'requested' }, 'supply-manager'), (e) => code('not-found')(e) && !e.message.includes('99999'));
  await assert.rejects(run('ospeli_stores_guide_set', { on: 'no' }, 'supply-manager'), code('invalid-input'));
  await assert.rejects(run('ospeli_stores_guide_set', { on: false }, 'storekeeper'), code('forbidden'));
  await assert.rejects(run('ospeli_stores_overview', { days: 365 }, 'coo'), code('invalid-input'));
  await assert.rejects(run('ospeli_stores_overview', { ward: 'ward-a1' }, 'coo'), code('invalid-input'));
  await assert.rejects(run('ospeli_stores_orders', { state: 'stuck' }, 'coo'), code('invalid-input'));
  await assert.rejects(run('ospeli_stores_overview', {}, { type: 'robot', role: 'coo' }), code('forbidden'));
  // The shared commands guard the module's stock the same way.
  await assert.rejects(run('ospeli_stock_issue', { requestId: 'req-00001' }, 'ward-nurse'), code('forbidden'), 'a ward does not issue to itself');
  await assert.rejects(run('ospeli_stock_level_set', { itemId: 'gloves-m', placeId: 'ward-a1', level: 99 }, 'storekeeper'), code('forbidden'));
  await assert.rejects(run('ospeli_stock_out_end', { stockOutId: 'so-00003', careAffected: 'patient in bed 4 waited' }, 'ward-nurse'), code('invalid-input'), 'a yes or no only');
  assert.equal(await core.eventCount(), n, 'nothing was written');
});

test('an older example hospital with no store: honest answers, and an order cannot be opened', async () => {
  const { run } = await site({ noStore: true });
  const ov = await run('ospeli_stores_overview', {}, 'supply-manager');
  assert.deepEqual([ov.hasStore, ov.hasHistory, ov.counts.requestsWaiting, ov.guide.suggestions], [false, false, 0, []]);
  assert.ok(ov.kpis.every((k) => k.value === null), 'no value, not zero');
  assert.equal(ov.planned[0].status, 'planned');
  await assert.rejects(run('ospeli_stores_order_step', { step: 'requested', lines: [{ itemId: 'gloves-m', qty: 1 }] }, 'supply-manager'), (e) => code('invalid-input')(e) && /no store/.test(e.message));
  assert.equal((await run('ospeli_stores_orders', {}, 'coo')).total, 0);
});

// ---- KPIs, worked out by hand from a small log ----
const D0 = Date.parse('2026-10-01T00:00:00.000Z');
const at = (d) => new Date(D0 + d * DAY).toISOString();
const log = (rows) => rows.map(([d, type, subject, data, role = 'storekeeper'], i) => ({ seq: i + 1, type, subject, actorRole: role, at: at(d), data }));
const S = 'store-main'; const W1 = 'ward-a1'; const W2 = 'ward-a2';
const KPI_LOG = log([
  [0, 'stock.level-set', W1, { itemId: 'gloves-m', level: 10 }], [0, 'stock.level-set', W2, { itemId: 'gloves-m', level: 10 }],
  [0, 'stock.received', S, { lines: [{ itemId: 'gloves-m', qty: 50 }, { itemId: 'gauze-swabs', qty: 50 }], source: 'Purchase' }],
  [0, 'stock.counted', W1, { lines: [{ itemId: 'gloves-m', qty: 10 }] }], [0, 'stock.counted', W2, { lines: [{ itemId: 'gloves-m', qty: 10 }] }],
  [2, 'stock.counted', W1, { lines: [{ itemId: 'gloves-m', qty: 0 }] }], // W1 has nothing usable from day 2
  [3, 'stock.requested', 'req-00001', { placeId: W1, fromPlaceId: S, lines: [{ itemId: 'gloves-m', qty: 10 }], raisedBy: 'count' }],
  [3.25, 'stock.issued', 'req-00001', { fromPlaceId: S, lines: [{ itemId: 'gloves-m', qty: 10 }] }], // in full after 6 hours; W1 usable again
  [4, 'stock.requested', 'req-00002', { placeId: W2, fromPlaceId: S, lines: [{ itemId: 'gloves-m', qty: 4 }, { itemId: 'gauze-swabs', qty: 2 }], raisedBy: 'count' }],
  [4 + 2 / 24, 'stock.issued', 'req-00002', { fromPlaceId: S, lines: [{ itemId: 'gloves-m', qty: 4 }] }], // part: the clock keeps running
  [5, 'stock.issued', 'req-00002', { fromPlaceId: S, lines: [{ itemId: 'gauze-swabs', qty: 2 }] }], // in full after 24 hours
  [6, 'stock.requested', 'req-00003', { placeId: W1, fromPlaceId: S, lines: [{ itemId: 'gauze-swabs', qty: 3 }], raisedBy: 'request' }], // still waiting
  [7, 'stock.stock-out-started', 'so-00001', { itemId: 'gloves-m', placeId: W2, cause: 'Not delivered' }, 'ward-nurse'], // declared, though the balance shows stock
  [8, 'stock.stock-out-ended', 'so-00001', { careAffected: false }, 'ward-nurse'],
  [1, 'stores.order-step', 'ord-00001', { step: 'requested', placeId: S, lines: [{ itemId: 'gloves-m', qty: 20 }] }, 'supply-manager'],
  [2, 'stores.order-step', 'ord-00001', { step: 'approved' }, 'ops-manager'],
  [2.5, 'stores.order-step', 'ord-00001', { step: 'ordered' }, 'supply-manager'],
  [5, 'stock.received', S, { lines: [{ itemId: 'gloves-m', qty: 20 }], source: 'Purchase', orderRef: 'ord-00001' }], // 4 days
  [3, 'stores.order-step', 'ord-00002', { step: 'requested', placeId: S, lines: [{ itemId: 'gauze-swabs', qty: 10 }] }, 'supply-manager'],
  [4, 'stores.order-step', 'ord-00002', { step: 'approved' }, 'coo'],
  [9, 'stock.received', S, { lines: [{ itemId: 'gauze-swabs', qty: 10 }], source: 'Purchase', orderRef: 'ord-00002' }], // 6 days, "ordered" not recorded
  [2, 'stores.order-step', 'ord-00003', { step: 'requested', placeId: S, lines: [{ itemId: 'masks', qty: 5 }] }, 'supply-manager'],
  [3, 'stores.order-step', 'ord-00003', { step: 'cancelled', reason: 'No longer needed' }, 'ops-manager'], // left out
  [8, 'stores.order-step', 'ord-00004', { step: 'requested', placeId: S, lines: [{ itemId: 'aprons', qty: 5 }] }, 'storekeeper'], // open: 2 days at day 10
].sort((a, b) => a[0] - b[0]));

test('KPIs from the event log, checked by hand: tracer stock-out rate (core D-17), request wait, order cycle time, fill rate', () => {
  const stock = deriveSupplies(KPI_LOG);
  const { orders } = deriveOrders(KPI_LOG);
  assert.equal(stock.problems, 0);
  const span = { since: at(0), until: at(10) };
  // Tracer (gloves) holdings over days 0 to 10: W1, W2 and the store, 30 item-days. W1 had nothing from
  // day 2 to day 3.25 (1.25 days, worked out from balances); W2 was declared out from day 7 to day 8
  // (1 day, declared). Joined: 2.25 of 30 = 7.5%. Gauze swabs are not a tracer item.
  const so = tracerStockOutRate(stock, span);
  assert.deepEqual([so.numerator, so.denominator, so.n, so.declaredDays, so.derivedDays, so.value], [2.25, 30, 3, 1, 1.25, 7.5]);
  assert.deepEqual(so.byArea.map((a) => [a.placeId, a.value]), [[W1, 12.5], [W2, 10], [S, 0]].sort());
  // Request wait: 6 h (req-00001) and 24 h (req-00002, the part issue kept the clock running): median 15 h.
  // req-00003 still waits: 1 open, 96 h so far at day 10.
  const rw = requestWaitHours(stock, span);
  assert.deepEqual([rw.value, rw.n, rw.open, rw.longestOpen], [15, 2, 1, 96]);
  // Fill rate: 4 lines raised (1 + 2 + 1); 3 issued in full: 75%.
  const fr = fillRatePercent(stock, span);
  assert.deepEqual([fr.value, fr.numerator, fr.denominator, fr.n], [75, 3, 4, 3]);
  // Order cycle time: 4 days (ord-00001) and 6 days (ord-00002): median 5. ord-00003 was cancelled and
  // is left out; ord-00004 is open, 2 days so far.
  const oc = orderCycleTime(orders, span);
  assert.deepEqual([oc.value, oc.n, oc.open, oc.longestOpen], [5, 2, 1, 2]);
  assert.deepEqual(orderCycleTime(orders, { since: at(6), until: at(10) }).value, 6, 'only the order received in the period');
  assert.deepEqual(orderSteps(orders.get('ord-00002'), at(10)).map((s) => [s.step, s.days]), [['requested', 1], ['approved', 5], ['ordered', null], ['delivered', null], ['received', null]]);
  // An empty log gives no value, never zero.
  assert.deepEqual([tracerStockOutRate(deriveSupplies([]), span).value, requestWaitHours(deriveSupplies([]), span).value, fillRatePercent(deriveSupplies([]), span).value, orderCycleTime(new Map(), span).value], [null, null, null, null]);
});

test('#125: each place\'s usual count interval, from the counts already stored (median days between counts of a tracer item)', async () => {
  const stock = deriveSupplies(KPI_LOG);
  const span = { since: at(0), until: at(10) };
  // W1 counted gloves on day 0 and day 2: every 2 days. W2 counted once: no interval. The store never counted.
  const every = countIntervals(KPI_LOG, stock, span);
  assert.deepEqual([every.get(W1), every.get(W2) ?? null, every.get(S) ?? null], [2, null, null]);
  // A count of a non-tracer item only does not count; neither does one outside the period.
  const more = log([[0, 'stock.counted', W2, { lines: [{ itemId: 'gauze-swabs', qty: 1 }] }], [5, 'stock.counted', W2, { lines: [{ itemId: 'gauze-swabs', qty: 1 }] }], [11, 'stock.counted', W1, { lines: [{ itemId: 'gloves-m', qty: 1 }] }]]);
  const again = countIntervals([...KPI_LOG, ...more], stock, span);
  assert.deepEqual([again.get(W1), again.get(W2) ?? null], [2, null]);
  // Through the overview: every area line carries its interval (null when it counted fewer than twice), and
  // the definition says once that places counting at different intervals are not directly comparable.
  const { run } = await site();
  const ov = await run('ospeli_stores_overview', { days: 30 }, 'coo');
  const so = ov.kpis.find((x) => x.id === 'stores-tracer-stock-out-rate');
  assert.ok(so.byArea.length > 1 && so.byArea.every((a) => 'countEveryDays' in a));
  assert.ok(so.byArea.some((a) => a.countEveryDays > 0), 'the demo wards count, so an interval shows');
  assert.match(so.definition, /different intervals are not directly comparable/);
});

test('the overview gives the same numbers through the command as the pure functions over the same log', async () => {
  const { core, run } = await site();
  const ov = await run('ospeli_stores_overview', { days: 30 }, 'coo');
  const evs = await core.events();
  const stock = deriveSupplies(evs);
  const now = ov.asOf; const since = ov.period.since;
  const k = Object.fromEntries(ov.kpis.map((x) => [x.id, x]));
  const round = (v) => (v == null ? null : Math.round(v * 10) / 10);
  assert.equal(k['stores-fill-rate'].value, round(fillRatePercent(stock, { since, until: now }).value));
  assert.equal(k['stores-request-wait'].n, requestWaitHours(stock, { since, until: now }).n);
  assert.equal(k['stores-order-cycle'].value, orderCycleTime(deriveOrders(evs).orders, { since, until: now }).value);
  for (const x of ov.kpis) assert.ok(x.source && x.definition && x.leavesOut, `${x.id} carries its definition and source`);
  assert.ok(ov.kpis.every((x) => /local definition/.test(x.source)));
  assert.deepEqual(ov.planned.map((p) => [p.id, p.status]), [['stores-inventory-turns', 'planned']]);
  assert.equal('value' in ov.planned[0], false, 'inventory turns has no value');
});

test('#185: fill rate is named on screen as filled in the end, and says the first-issue meaning is not shown', async () => {
  const { run } = await site();
  const k = (await run('ospeli_stores_overview', { days: 30 }, 'coo')).kpis.find((x) => x.id === 'stores-fill-rate');
  assert.match(k.name, /filled in the end/);
  assert.match(k.definition, /first issue/);
});

test('guide rules by hand: use ahead of a level, an order waiting longer than usual, a transfer; each cites its basis', () => {
  const rows = [
    [0, 'stock.level-set', W1, { itemId: 'gloves-m', level: 5 }], [0, 'stock.level-set', W2, { itemId: 'gloves-m', level: 10 }],
    [0, 'stock.received', W1, { lines: [{ itemId: 'gloves-m', qty: 48 }], source: 'Purchase' }], [0, 'stock.received', W2, { lines: [{ itemId: 'gloves-m', qty: 30 }], source: 'Purchase' }],
    [20, 'stock.level-set', 'ward-a3', { itemId: 'gloves-m', level: 1 }], [20, 'stock.received', 'ward-a3', { lines: [{ itemId: 'gloves-m', qty: 9 }], source: 'Purchase' }],
  ];
  for (let d = 1; d <= 28; d++) rows.push([d, 'stock.counted', W1, { lines: [{ itemId: 'gloves-m', qty: 48 - d }] }]); // 1 a day: 7 a week
  for (let d = 21; d <= 28; d++) rows.push([d, 'stock.counted', 'ward-a3', { lines: [{ itemId: 'gloves-m', qty: 9 - (d - 20) }] }]); // only 8 days held
  rows.push([27, 'stock.counted', W2, { lines: [{ itemId: 'gloves-m', qty: 2 }] }]);
  const stock = deriveSupplies(log(rows.sort((a, b) => a[0] - b[0])));
  const isArea = (p) => p.startsWith('ward-');
  // Rule 1: W1 used 28 in 28 days, 7 a week, more than its level of 5: suggest 7 x 1.25 = 8.75, so 9.
  // W2 used 28 (a count found 28 gone) in 28 days, 7 a week, under its level of 10. Ward A3 has too little history.
  const r1 = ruleLevelCheck(stock, { now: at(28), isArea });
  assert.deepEqual(r1.map((s) => [s.id, s.action.inputs[0].level, s.action.inputs[0].expectedLevel]), [[`level-check:${W1}:gloves-m`, 9, 5]]);
  assert.match(r1[0].why, /Used in the last 28 days: 28 .* about 7 a week\. The fill-to level is 5\./);
  // Rule 3: W1 holds 20 (level 5, at least twice) and W2 holds 2 (level 10): move min(20 - 5, 10 - 2) = 8.
  const r3 = ruleTransfer(stock, { now: at(28), isArea, storeHas: () => 0 });
  assert.deepEqual(r3.map((s) => s.action.inputs[0]), [{ fromPlaceId: W1, toPlaceId: W2, lines: [{ itemId: 'gloves-m', qty: 8 }] }]);
  assert.match(r3[0].why, /The store has 0 usable/);
  // Rule 2: an order 3 days at "requested" (usual up to 2) gets a reminder; one 1 day there does not; a reminder sent 6 hours ago holds it back.
  const { orders } = deriveOrders(log([
    [25, 'stores.order-step', 'ord-00001', { step: 'requested', placeId: S, lines: [{ itemId: 'gloves-m', qty: 1 }] }],
    [27, 'stores.order-step', 'ord-00002', { step: 'requested', placeId: S, lines: [{ itemId: 'gloves-m', qty: 1 }] }],
    [19, 'stores.order-step', 'ord-00003', { step: 'requested', placeId: S, lines: [{ itemId: 'masks', qty: 1 }] }],
    [20, 'stores.order-step', 'ord-00003', { step: 'approved' }, 'ops-manager'],
    [20.5, 'stores.order-step', 'ord-00003', { step: 'ordered' }], // 7.5 days waiting for delivery (usual up to 7)
    [27.75, 'stores.order-reminded', 'ord-00003', { step: 'ordered' }],
  ].sort((a, b) => a[0] - b[0])));
  const r2 = ruleOrderWaiting(orders, { now: at(28) });
  assert.deepEqual(r2.map((s) => [s.id, s.action?.inputs[0] ?? null]), [['order-waiting:ord-00001:requested', { orderId: 'ord-00001', expectedStep: 'requested' }], ['order-waiting:ord-00003:ordered', null]]);
  assert.match(r2[0].why, /Operations manager or Chief operating officer/);
  for (const r of GUIDE_RULES) assert.match(r.basis, /^Example setting, not a standard/);
});

test('the guide switch: off, there are no suggestions and everything else is the same; on again; people only', async () => {
  const { core, run } = await site();
  const on = await run('ospeli_stores_overview', {}, 'supply-manager');
  assert.equal(on.guide.on, true);
  assert.deepEqual([...new Set(on.guide.suggestions.map((s) => s.rule))].sort(), ['level-check', 'order-waiting', 'transfer']);
  for (const s of on.guide.suggestions) assert.ok(s.basis && s.why && (s.action === null || commandByName(s.action.command)), s.id);
  await run('ospeli_stores_guide_set', { on: false }, 'supply-manager');
  assert.equal(guideOn(await core.events({ type: 'stores.guide-set' })), false);
  const off = await run('ospeli_stores_overview', {}, 'supply-manager');
  assert.deepEqual([off.guide.on, off.guide.suggestions], [false, []]);
  assert.deepEqual(off.counts, on.counts, 'everything else works the same');
  assert.deepEqual(off.kpis.map((k) => k.value), on.kpis.map((k) => k.value));
  // With the guide off a person still records steps and counts.
  const o = (await run('ospeli_stores_orders', {}, 'coo')).orders.find((x) => x.state === 'requested');
  await run('ospeli_stores_order_step', { step: 'approved', orderId: o.id }, 'coo');
  await assert.rejects(run('ospeli_stores_guide_set', { on: false }, 'coo'), (e) => code('conflict')(e) && e.detail.already === true);
  await run('ospeli_stores_guide_set', { on: true }, 'ops-manager');
  assert.equal((await run('ospeli_stores_overview', {}, 'coo')).guide.on, true);
});

test('what is short is not every item under its top-up level: nothing left, below half the level, a request waiting too long, a store item not on order', () => {
  assert.deepEqual([SHORT_SHARE, REQUEST_USUAL_HOURS], [0.5, 24], 'example settings, named on screen');
  const rows = [
    ...['gloves-m', 'gauze-swabs', 'aprons', 'masks'].map((itemId) => [0, 'stock.level-set', W1, { itemId, level: 10 }]),
    [0, 'stock.level-set', S, { itemId: 'gloves-m', level: 40 }], [0, 'stock.level-set', S, { itemId: 'aprons', level: 40 }],
    [0, 'stock.received', S, { lines: [{ itemId: 'gloves-m', qty: 30 }, { itemId: 'aprons', qty: 30 }], source: 'Purchase' }],
    // On the ward: gloves 0 (nothing left), gauze 4 (below half of 10), aprons 7 (under its level: an ordinary top-up), masks 10.
    [1, 'stock.counted', W1, { lines: [{ itemId: 'gloves-m', qty: 0 }, { itemId: 'gauze-swabs', qty: 4 }, { itemId: 'aprons', qty: 7 }, { itemId: 'masks', qty: 10 }] }],
    [1, 'stock.requested', 'req-00001', { placeId: W1, fromPlaceId: S, lines: [{ itemId: 'aprons', qty: 3 }], raisedBy: 'count' }], // 47 h waiting at day 3
    [2.5, 'stock.requested', 'req-00002', { placeId: W1, fromPlaceId: S, lines: [{ itemId: 'gloves-m', qty: 10 }], raisedBy: 'request' }], // 12 h: not late
    // The store: gloves 30 of 40 and on order (not short here); aprons 30 of 40 and not on order (short).
    [2, 'stores.order-step', 'ord-00001', { step: 'requested', placeId: S, lines: [{ itemId: 'gloves-m', qty: 20 }] }, 'supply-manager'],
  ].sort((a, b) => a[0] - b[0]);
  const evs = log(rows);
  const got = shortNow(deriveSupplies(evs), deriveOrders(evs).orders, { now: at(3), isArea: (p) => p.startsWith('ward-'), isStore: (p) => p === S });
  assert.deepEqual(got.lines.map((x) => [x.kind, x.itemId || x.requestId, x.placeId]), [
    ['none-left', 'gloves-m', W1], ['store-not-on-order', 'aprons', S], ['request-waiting', 'req-00001', W1], ['below-share', 'gauze-swabs', W1]]);
  assert.equal(got.lines.find((x) => x.kind === 'request-waiting').hours, 48);
  assert.deepEqual(got.counts, { itemLines: 2, wards: 1, noneLeft: 1, storeLines: 1, requestsLate: 1 }, 'aprons on the ward (7 of 10) and masks are not short');
});

test('the rest of a part-received order can be cancelled with a reason; it is then closed and left out of the cycle time', () => {
  const evs = log([
    [0, 'stores.order-step', 'ord-00001', { step: 'requested', placeId: S, lines: [{ itemId: 'gloves-m', qty: 10 }, { itemId: 'aprons', qty: 4 }] }, 'supply-manager'],
    [1, 'stores.order-step', 'ord-00001', { step: 'approved' }, 'coo'],
    [2, 'stores.order-step', 'ord-00001', { step: 'ordered' }, 'supply-manager'],
    [5, 'stock.received', S, { lines: [{ itemId: 'gloves-m', qty: 10 }], source: 'Purchase', orderRef: 'ord-00001' }],
    [9, 'stores.order-step', 'ord-00001', { step: 'cancelled', reason: 'Ordered another way' }, 'supply-manager'],
  ]);
  const { orders, problems } = deriveOrders(evs);
  const o = orders.get('ord-00001');
  assert.deepEqual([problems, o.state, o.cancelReason, o.lines[0].received], [0, 'cancelled', 'Ordered another way', 10]);
  assert.deepEqual(orderSteps(o, at(10)).map((x) => [x.step, x.days]), [['requested', 1], ['approved', 1], ['ordered', 3], ['delivered', null], ['part-received', 4]]);
  assert.deepEqual([orderCycleTime(orders, { since: at(0), until: at(10) }).n, orderCycleTime(orders, { since: at(0), until: at(10) }).open], [0, 0]);
});

test('a percent measure never reads "0%" when the count under it is not zero (#113)', () => {
  assert.equal(percentText(null, 0), null, 'no value: the caller says "none yet"');
  assert.equal(percentText(0, 0), '0%', 'nothing at all is 0%');
  assert.equal(percentText(0, 0.02), 'under 0.1%', 'a tiny rate, rounded to 0 for the answer, is not 0%');
  assert.equal(percentText(0.04, 0.02), 'under 0.1%');
  assert.equal(percentText(0.1, 1), '0.1%');
  assert.equal(percentText(3.25, 4), '3.3%');
  assert.equal(percentText(12.6, 30), '13%');
  assert.equal(percentText(100, 30), '100%');
});

test('#113: the stores reads say "example data only" and that an issued item counts as arrived until a ward can confirm arrival', async () => {
  const { core } = await site();
  for (const name of ['ospeli_stores_overview', 'ospeli_stores_orders']) {
    const r = await runCommand(core, name, {}, human('coo'));
    out(name, r);
    assert.match(r.exampleNote, /^Example data only\. .*issue.*counted as arrived on the ward.*confirm.*not built yet/i, name);
    assert.ok(commandByName(name).output.required.includes('exampleNote'), `${name}: the note is always in the answer`);
  }
});
