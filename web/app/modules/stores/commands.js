// Stores and supplies: the module's pack (see core/modules.js for the contract).
// Plain data and pure functions; no screen code, so the same file runs in the browser, in tests
// and on a site's own server.
//
// Counting, requesting, issuing, receiving, transfers, stock-outs, write-offs, levels and item adds
// are the shared stock commands (ospeli_stock_*, core/stock-commands.js): this pack configures them
// (STOCK_CATEGORIES, STOCK_ITEMS) and writes none of them again. Its own commands are the overview
// (measures and the guide), the order tracker, an order's steps, a reminder and the guide's off
// switch. People approve purchases: an agent's approval is refused. Nothing here calls a model.

import {
  CommandError, ALL_ROLES, ID, TIME, SYNTHETIC, LIMIT, TOTAL, TRUNCATED, FORMAT, page, WRITE_STATUS, PROPOSAL_OUT, EVENT_SEQS,
  isSynthetic, DAY, HOUR, MIN,
} from '../../core/kit.js';
import { roleById, currentWords } from '../../core/model.js';
import { STOCK_PLACE_TYPES, MAX_QTY, ITEM_ID_PATTERN, balance, openStockOut, usableOf } from '../../core/stock.js';
import {
  STOCK_CATEGORIES, STOCK_ITEMS, CATEGORY, deriveSupplies, isSupply, suppliesRequest, deriveOrders, nextOrderId, orderSteps, daysAtStep, overUsual, lastReminder, isOpenOrder,
  ORDER_STEPS, ORDER_STATES, RECORDED_STEPS, STEP_NAMES, STEP_ROLES, WAITING_FOR, USUAL_DAYS, REMIND_GAP_HOURS, ORDER_CANCEL_REASONS, ORDER_ID_PATTERN, MAX_ORDER_LINES, stepProblem,
  guideOn, GUIDE_RULES, shortNow, SHORT_SHARE, REQUEST_USUAL_HOURS, tracerStockOutRate, requestWaitHours, orderCycleTime, fillRatePercent, ruleLevelCheck, ruleOrderWaiting, ruleTransfer,
} from './logic.js';

export { STOCK_CATEGORIES, STOCK_ITEMS };
export const id = 'stores';
export const PREFIX = 'ospeli_stores_';
export const EVENT_PREFIX = 'stores.';

// Every number has a definition and a source. No target is set: none of these has a cited standard.
const NO_TARGET = 'No target set: track the trend. A site may set its own (an example setting, not a standard).';
export const KPIS = [
  { id: 'stores-tracer-stock-out-rate', name: 'Stock-out rate on tracer items', unit: '%',
    definition: 'Item-days with nothing usable divided by item-days held, for tracer supplies items, in all and for each area (the core measure "Stock-out rate", KPI dictionary D-17). A day out counts when a person declared a stock-out or the balances show nothing usable; the two are joined, never counted twice.',
    counts: 'Item-days with nothing usable, for tracer items.', outOf: 'Item-days tracer items were held, from each holding\'s first event (a level set or a movement).',
    leavesOut: 'Items that are not tracer items, and other modules\' stock (medicines, vaccines).',
    source: 'local definition (the core measure "Stock-out rate", KPI dictionary D-17)', target: null, targetText: NO_TARGET },
  { id: 'stores-request-wait', name: 'Request wait', unit: 'hours',
    definition: 'Median hours from a ward\'s request being raised (by a count or by hand) to it being issued in full, for requests issued in full in the period. A part issue leaves the clock running.',
    counts: 'Requests issued in full in the period.', outOf: 'None (a median).',
    leavesOut: 'Requests still waiting (shown beside the value: how many, and the longest wait so far) and cancelled requests.',
    source: 'local definition', target: null, targetText: NO_TARGET },
  { id: 'stores-order-cycle', name: 'Order cycle time', unit: 'days',
    definition: 'Median days from an order being requested to the receipt into stock that completes it (every line received; a receipt names the order).',
    counts: 'Orders received in full in the period.', outOf: 'None (a median).',
    leavesOut: 'Orders not received in full yet, part received included (shown beside the value: how many, and the longest so far) and cancelled orders.',
    source: 'local definition', target: null, targetText: NO_TARGET },
  { id: 'stores-fill-rate', name: 'Fill rate (filled in the end)', unit: '%',
    definition: 'Request lines issued in full divided by request lines raised, for requests raised in the period. A line still waiting counts as not issued in full. A line counts once it is filled in the end, after any part issues; some places use fill rate for lines filled in full at the first issue, which is not shown here.',
    counts: 'Request lines issued in full.', outOf: 'Request lines raised in the period.',
    leavesOut: 'Cancelled requests (counted apart).',
    source: 'local definition (the core measure "fill rate")', target: null, targetText: NO_TARGET },
];
const PLANNED_KPIS = [
  { id: 'stores-inventory-turns', name: 'Inventory turns', status: 'planned', note: 'Planned, not built: it needs the value of what is issued and held, and Ospeli keeps no prices or currency.' },
];

// ---- reading the record ----
const TYPES = ['item-added', 'level-set', 'received', 'requested', 'issued', 'request-cancelled', 'transferred', 'counted', 'used', 'written-off', 'quarantined', 'released', 'stock-out-started', 'stock-out-ended']
  .map((t) => `stock.${t}`).concat(['stores.order-step', 'stores.order-reminded', 'stores.guide-set']);
async function context(core, wards = null, events = null) {
  const [evs, ents] = await Promise.all([events ?? core.events({ type: TYPES }), core.listEntities()]);
  const offsetMinutes = ents.find((e) => e.type === 'site' && e.utcOffsetMinutes != null)?.utcOffsetMinutes ?? 0;
  const places = new Map(ents.filter((e) => STOCK_PLACE_TYPES.includes(e.type)).map((e) => [e.id, e]));
  const stock = deriveSupplies(evs, offsetMinutes);
  const { orders } = deriveOrders(evs);
  const placeName = (pid) => (places.has(pid) ? currentWords(places.get(pid).name) : pid);
  // An agent limited to some wards sees those wards; stores and departments are not wards and stay visible.
  const see = (pid) => !wards || places.get(pid)?.type !== 'ward' || wards.has(pid);
  const isArea = (pid) => ['ward', 'department'].includes(places.get(pid)?.type);
  const stores = [...places.values()].filter((p) => p.type === 'store').sort((a, b) => (a.id < b.id ? -1 : 1));
  const itemName = (iid) => stock.items.get(iid)?.name || iid;
  return { core, events: evs, places, stock, orders, placeName, see, isArea, stores, itemName, now: core.now(), offsetMinutes };
}
const roleList = (ids) => ids.map((r) => (r === 'coo' ? 'Chief operating officer' : roleById(r)?.name || r)).join(' or ');
const hoursSince = (iso, now) => Math.round(((Date.parse(now) - Date.parse(iso)) / HOUR) * 10) / 10;

// ---- the overview: measures, what is short, what is stuck, and the guide, in one read ----
async function overview(core, input, wards) {
  const c = await context(core, wards);
  const { stock, now, see } = c;
  const days = input.days ?? 30;
  const since = new Date(Date.parse(now) - days * DAY).toISOString();
  const span = { since, until: now, see };
  const values = {
    'stores-tracer-stock-out-rate': tracerStockOutRate(stock, span),
    'stores-request-wait': requestWaitHours(stock, span),
    'stores-order-cycle': orderCycleTime(c.orders, span),
    'stores-fill-rate': fillRatePercent(stock, span),
  };
  const kpis = KPIS.map((k) => {
    const v = values[k.id];
    const base = { id: k.id, name: k.name, unit: k.unit, value: v.value == null ? null : Math.round(v.value * 10) / 10, numerator: v.numerator, denominator: v.denominator, n: v.n,
      ...(v.open != null ? { open: v.open, longestOpen: v.longestOpen } : {}), target: k.target, targetText: k.targetText };
    return input.format === 'short' ? base : { ...base, ...(v.byArea ? { byArea: v.byArea.map((a) => ({ ...a, placeName: c.placeName(a.placeId), value: a.value == null ? null : Math.round(a.value * 10) / 10 })) } : {}),
      ...(v.cancelled != null ? { cancelled: v.cancelled } : {}), definition: k.definition, counts: k.counts, outOf: k.outOf, leavesOut: k.leavesOut, source: k.source };
  });
  const held = [...stock.holdings.values()].filter((h) => isSupply(stock.items.get(h.itemId)) && see(h.placeId));
  const under = held.filter((h) => h.level && balance(h, now, stock.offsetMinutes).usable < h.level);
  const waiting = [...stock.requests.values()].filter((q) => (q.state === 'open' || q.state === 'part') && suppliesRequest(stock)(q) && see(q.placeId));
  const open = [...c.orders.values()].filter(isOpenOrder);
  const outs = [...stock.stockOuts.values()].filter((s) => !s.endedAt && isSupply(stock.items.get(s.itemId)) && see(s.placeId));
  const notDeclared = held.filter((h) => h.level && balance(h, now, stock.offsetMinutes).usable === 0 && !openStockOut(stock, h.itemId, h.placeId));
  const short = shortNow(stock, c.orders, { now, isArea: c.isArea, isStore: (pid) => c.places.get(pid)?.type === 'store', see });
  const on = guideOn(c.events);
  const suggestions = on ? [
    ...ruleLevelCheck(stock, { now, isArea: c.isArea, see, placeName: c.placeName }),
    ...ruleOrderWaiting(c.orders, { now, itemName: c.itemName }),
    ...ruleTransfer(stock, { now, isArea: c.isArea, see, placeName: c.placeName, storeHas: (itemId) => (c.stores[0] ? usableOf(stock, itemId, c.stores[0].id, now) : null) }),
  ].map(({ rule, id: sid, text, why, basis, action }) => ({ rule, id: sid, text, why, basis, action })) : [];
  return {
    asOf: now, synthetic: await isSynthetic(core), period: { since, until: now, days },
    hasStore: c.stores.length > 0, hasHistory: held.length > 0, stores: c.stores.map((s) => ({ id: s.id, name: currentWords(s.name) })),
    counts: {
      underLevel: under.length, areasShort: new Set(under.map((h) => h.placeId)).size,
      requestsWaiting: waiting.length, oldestWaitHours: waiting.length ? Math.max(...waiting.map((q) => hoursSince(q.at, now))) : null,
      ordersOpen: open.length, longestAtStepDays: open.length ? Math.max(...open.map((o) => daysAtStep(o, now))) : null,
      stockOutsOpen: outs.length, notDeclared: notDeclared.length,
    },
    // What needs a person to look now (not every item under its top-up level: see shortNow).
    short: { share: SHORT_SHARE, requestUsualHours: REQUEST_USUAL_HOURS, note: `Example settings, not standards: a ward item with nothing usable or below ${SHORT_SHARE * 100}% of its top-up level, a ward request waiting more than ${REQUEST_USUAL_HOURS} hours, a store item below its reorder level with no open order.`,
      counts: short.counts, lines: short.lines.slice(0, 200).map((x) => ({ ...x, placeName: c.placeName(x.placeId), ...(x.itemId ? { itemName: c.itemName(x.itemId), unit: stock.items.get(x.itemId)?.unit ?? null } : {}) })) },
    // Reminders sent for open orders at the step they wait at, and the roles each is for.
    reminders: open.map((o) => ({ o, r: lastReminder(o) })).filter((x) => x.r).map(({ o, r }) => ({ orderId: o.id, step: o.state, waitingFor: WAITING_FOR[o.state].words, roles: [...WAITING_FOR[o.state].roles], at: r.at, byRole: r.byRole })),
    kpis, planned: PLANNED_KPIS.map((x) => ({ ...x })),
    guide: { on, rules: GUIDE_RULES.map((r) => ({ ...r })), suggestions },
    note: 'Counts items, requests and orders, never a storekeeper, nurse or anyone else. Not for medicines dispensing (pharmacy operations), vaccine stock and cold chain, or choosing suppliers. Ospeli does not approve purchases; people do.',
  };
}

const orderRow = (c, o, format) => {
  const wait = isOpenOrder(o) ? WAITING_FOR[o.state] : null;
  const base = {
    id: o.id, state: o.state, stateName: STEP_NAMES[o.state], placeId: o.placeId, placeName: o.placeId ? c.placeName(o.placeId) : null,
    requestedAt: o.steps.requested.at, receivedAt: o.steps.received?.at ?? null,
    waitingFor: wait?.words ?? null, waitingForRoles: wait ? [...wait.roles] : [], daysAtStep: daysAtStep(o, c.now),
    usualDays: wait ? USUAL_DAYS[o.state] : null, overUsual: overUsual(o, c.now),
    cycleDays: o.steps.received ? Math.round(((Date.parse(o.steps.received.at) - Date.parse(o.steps.requested.at)) / DAY) * 10) / 10 : null,
    lines: o.lines.map((l) => ({ itemId: l.itemId, itemName: c.itemName(l.itemId), unit: c.stock.items.get(l.itemId)?.unit ?? null, qty: l.qty, received: l.received, toCome: Math.max(0, l.qty - l.received), over: l.received > l.qty })),
    overReceived: o.lines.some((l) => l.received > l.qty),
  };
  if (format === 'short') return base;
  const r = lastReminder(o);
  return { ...base, steps: orderSteps(o, c.now), cancelReason: o.cancelReason,
    lastReminder: r ? { at: r.at, byRole: r.byRole, hoursAgo: hoursSince(r.at, c.now) } : null,
    nextSteps: RECORDED_STEPS.filter((s) => s !== 'requested' && !stepProblem(o, s)).map((s) => ({ step: s, name: STEP_NAMES[s], roles: [...STEP_ROLES[s]] })),
    receivedBy: isOpenOrder(o) && ['ordered', 'delivered', 'part-received'].includes(o.state) ? 'Record the delivery with ospeli_stock_receive and orderRef set to this order id.' : null };
};

// ---- order steps: the checks a person's action and an agent's proposal both pass ----
const ORDER_ID = { type: 'string', pattern: ORDER_ID_PATTERN, maxLength: 20, description: 'An order id from ospeli_stores_orders, for example ord-00001.' };
const REPEAT = 2 * MIN;
const PEOPLE_APPROVE = 'People approve purchases. An agent cannot record an approval, not even as a proposal: a person in a role that approves purchases (Operations manager or COO) records it on screen.';
function noAgentApproval(input, actor) {
  if (actor?.type === 'agent' && input.step === 'approved') throw new CommandError('forbidden', PEOPLE_APPROVE, { peopleOnly: true });
}
async function checkStep(core, input, actor, events = null) {
  noAgentApproval(input, actor);
  const { step } = input;
  if (actor?.role && !STEP_ROLES[step].includes(actor.role)) {
    throw new CommandError('forbidden', `${roleById(actor.role)?.name || 'This role'} cannot record "${STEP_NAMES[step]}" on an order. That step is for: ${roleList(STEP_ROLES[step])}.`, { roles: [...STEP_ROLES[step]] });
  }
  const c = await context(core, null, events);
  if (step === 'requested') {
    for (const k of ['orderId', 'expectedStep', 'reason']) if (input[k] != null) throw new CommandError('invalid-input', `${k} is not used when an order is first requested: send step, lines and (if the site has more than one store) placeId.`);
    if (!input.lines?.length) throw new CommandError('invalid-input', `Add at least one line, for example { "itemId": "${STOCK_ITEMS[0].id}", "qty": 20 }. ospeli_stock_items lists the items.`);
    const seen = new Set();
    for (const l of input.lines) {
      const it = c.stock.items.get(l.itemId);
      if (!isSupply(it)) throw new CommandError('not-found', 'No supplies item with that id. ospeli_stock_items with { "category": "supplies" } lists them.');
      if (seen.has(l.itemId)) throw new CommandError('invalid-input', `${it.name} is listed twice. List each item once.`);
      seen.add(l.itemId);
    }
    if (!c.stores.length) throw new CommandError('invalid-input', 'This site has no store set up, so there is nowhere for the order to arrive. A store is set up with the hospital model.');
    const placeId = input.placeId ?? c.stores[0].id;
    if (c.places.get(placeId)?.type !== 'store') throw new CommandError('not-found', `No store with that id. Stores here: ${c.stores.map((s) => s.id).join(', ')}.`);
    if (input.again !== true) {
      const t = Date.parse(c.now);
      const same = (e) => e.type === 'stores.order-step' && e.data?.step === 'requested' && e.data.placeId === placeId
        && JSON.stringify([...e.data.lines].map((l) => [l.itemId, l.qty]).sort()) === JSON.stringify(input.lines.map((l) => [l.itemId, l.qty]).sort());
      for (let i = c.events.length - 1; i >= 0 && t - Date.parse(c.events[i].at) < REPEAT; i--) {
        if (same(c.events[i])) throw new CommandError('conflict', 'The same order was requested a moment ago, so nothing new was saved. If this really is a second order, send it again with again: true.', { confirm: 'again' });
      }
    }
    return { c, placeId };
  }
  for (const k of ['lines', 'placeId', 'again']) if (input[k] != null) throw new CommandError('invalid-input', `${k} is only for a new order (step "requested").`);
  if (!input.orderId) throw new CommandError('invalid-input', 'Say which order: add orderId, for example "ord-00001". ospeli_stores_orders lists the open orders.');
  const o = c.orders.get(input.orderId);
  if (!o) throw new CommandError('not-found', 'No order with that id. ospeli_stores_orders lists the orders.');
  if (input.expectedStep && o.state !== input.expectedStep) throw new CommandError('conflict', `This order changed since you opened it: it is now ${STEP_NAMES[o.state].toLowerCase()}. Read it again.`, { state: o.state });
  const why = stepProblem(o, step);
  if (why) throw new CommandError('conflict', why, { state: o.state });
  if (step === 'cancelled' && !input.reason) throw new CommandError('invalid-input', `Pick why it is cancelled: ${ORDER_CANCEL_REASONS.join(', ')}.`);
  if (step !== 'cancelled' && input.reason != null) throw new CommandError('invalid-input', 'reason is only for cancelling an order.');
  return { c, o };
}
async function checkRemind(core, input, events = null) {
  const c = await context(core, null, events);
  const o = c.orders.get(input.orderId);
  if (!o) throw new CommandError('not-found', 'No order with that id. ospeli_stores_orders lists the open orders.');
  if (!isOpenOrder(o)) throw new CommandError('conflict', `This order is ${STEP_NAMES[o.state].toLowerCase()}: there is nothing to remind anyone about.`, { state: o.state });
  if (o.state !== input.expectedStep) throw new CommandError('conflict', `This order changed since you opened it: it is now ${STEP_NAMES[o.state].toLowerCase()}. Read it again.`, { state: o.state });
  const r = lastReminder(o);
  if (r && Date.parse(c.now) - Date.parse(r.at) < REMIND_GAP_HOURS * HOUR) {
    throw new CommandError('conflict', `A reminder about this step was sent ${Math.max(0, Math.round((Date.parse(c.now) - Date.parse(r.at)) / HOUR))} h ago, so no second one was sent (at most one a day).`, { already: true });
  }
  return { c, o };
}
async function checkGuide(core, input, events = null) {
  if (guideOn(events ?? await core.events({ type: 'stores.guide-set' })) === input.on) throw new CommandError('conflict', `The guide is already ${input.on ? 'on' : 'off'}.`, { already: true });
}

const KPI_OUT = { type: 'object', required: ['id', 'name', 'unit', 'value'], properties: {
  id: { type: 'string' }, name: { type: 'string' }, unit: { type: 'string' }, value: { type: ['number', 'null'], description: 'null when nothing was counted in the period.' },
  numerator: { type: ['number', 'null'] }, denominator: { type: ['number', 'null'] }, n: { type: 'integer', description: 'How many holdings, requests or orders the value is from.' },
  open: { type: 'integer', description: 'Requests or orders not finished yet, shown beside the value and never dropped.' }, longestOpen: { type: ['number', 'null'], description: 'The longest of those so far, in the measure\'s own unit.' },
  byArea: { type: 'array', description: 'For the stock-out rate: the value for each area.' }, cancelled: { type: 'integer' },
  target: { type: ['number', 'null'] }, targetText: { type: 'string' }, definition: { type: 'string' }, counts: { type: 'string' }, outOf: { type: 'string' }, leavesOut: { type: 'string' }, source: { type: 'string' } } };
const SUGGESTION = { type: 'object', required: ['rule', 'id', 'text', 'why', 'basis'], properties: {
  rule: { type: 'string' }, id: { type: 'string' }, text: { type: 'string' }, why: { type: 'string' }, basis: { type: 'string' },
  action: { type: ['object', 'null'], description: 'The command a person may run to follow the suggestion, with its input filled in (for an agent, a proposal). null: advice only.' } } };
const STEP_LINE = { type: 'object', additionalProperties: false, required: ['itemId', 'qty'], properties: {
  itemId: { type: 'string', pattern: ITEM_ID_PATTERN, maxLength: 31, description: 'A supplies item id from ospeli_stock_items, for example gloves-m.' },
  qty: { type: 'integer', minimum: 1, maximum: MAX_QTY, description: 'How many to order, in the item\'s own unit (for example boxes of 100).' } } };
const WRITE_OUT = (props) => ({ type: 'object', required: ['status'], properties: { status: WRITE_STATUS, events: EVENT_SEQS, proposal: PROPOSAL_OUT, ...props } });
const STEP_WRITERS = [...new Set(Object.values(STEP_ROLES).flat())];

export const COMMANDS = [
  {
    name: 'ospeli_stores_overview',
    summary: 'Stores and supplies at a glance, in one call: the four measures with their definitions and sources (stock-out rate on tracer items, request wait, order cycle time, fill rate), how many items are under their top-up level, requests waiting, open orders and stock-outs, reminders sent, and the guide\'s suggestions with their reasons and basis (empty while the guide is off). Inventory turns is listed as planned, with no value. Counts items, requests and orders, never people. Read-only.',
    kind: 'read', roles: ALL_ROLES, approval: false,
    input: { type: 'object', additionalProperties: false, properties: {
      days: { type: 'integer', minimum: 1, maximum: 90, description: 'The period for the measures: the last this many days. Default 30.' },
      format: FORMAT('the values without their definitions', 'each value with its definition, source and the value for each area') } },
    output: { type: 'object', required: ['asOf', 'synthetic', 'period', 'hasStore', 'hasHistory', 'counts', 'kpis', 'planned', 'guide'], properties: {
      asOf: TIME, synthetic: SYNTHETIC, period: { type: 'object' },
      hasStore: { type: 'boolean', description: 'False on a device whose hospital has no store set up: nothing can be issued or received.' },
      hasHistory: { type: 'boolean', description: 'False when no supplies are held anywhere yet (no level set, no movement).' },
      stores: { type: 'array', description: 'The stores, with ids.' },
      short: { type: 'object', description: 'What needs a person to look now: lines of kind none-left, below-share (a ward item below a share of its top-up level), store-not-on-order or request-waiting, with counts (itemLines and wards for the wards; storeLines; requestsLate). The share and the wait are example settings, not standards.' },
      counts: { type: 'object', description: 'underLevel, areasShort, requestsWaiting, oldestWaitHours, ordersOpen, longestAtStepDays, stockOutsOpen, notDeclared (items with a level and nothing usable, with no stock-out declared).' },
      reminders: { type: 'array', description: 'Reminders sent for open orders at the step they wait at: { orderId, step, waitingFor, roles, at, byRole }.' },
      kpis: { type: 'array', items: KPI_OUT }, planned: { type: 'array', items: { type: 'object', required: ['id', 'name', 'status'] } },
      guide: { type: 'object', required: ['on', 'rules', 'suggestions'], properties: { on: { type: 'boolean' }, rules: { type: 'array' }, suggestions: { type: 'array', items: SUGGESTION } } },
      note: { type: 'string' } } },
    async run(core, input, { wards }) { return overview(core, input, wards); },
    example: { input: { days: 7, format: 'short' } },
  },
  {
    name: 'ospeli_stores_orders',
    summary: 'The order tracker: each order with its items and quantities (and what is still to come; a delivery above the order is flagged), its steps (requested, approved, ordered, delivered, part received, received) with the date and the days spent at each, what it is waiting for and which roles hold that step, and what has been received against it. Open orders come first, the longest at one step first. No prices or suppliers are kept. Read-only.',
    kind: 'read', roles: ALL_ROLES, approval: false,
    input: { type: 'object', additionalProperties: false, properties: {
      state: { type: 'string', enum: ['open', 'received', 'cancelled', 'all'], description: 'open (default): not received in full or cancelled yet (part received is open). received, cancelled or all: newest first.' },
      format: FORMAT('each order without its steps', 'each order with its steps, its last reminder and the steps that can be recorded next'), limit: LIMIT(50, 200, 'orders') } },
    output: { type: 'object', required: ['asOf', 'synthetic', 'orders', 'steps', 'total', 'truncated'], properties: {
      asOf: TIME, synthetic: SYNTHETIC, total: TOTAL, truncated: TRUNCATED,
      steps: { type: 'array', description: 'The steps in order, who records each, and the usual longest wait at each (example settings, not standards).' },
      orders: { type: 'array', items: { type: 'object', required: ['id', 'state', 'stateName', 'requestedAt', 'lines', 'daysAtStep'] } },
      cancelReasons: { type: 'array', description: 'The reasons to pick from when an order is cancelled.' } } },
    async run(core, input) {
      const c = await context(core);
      const state = input.state || 'open';
      let list = [...c.orders.values()].filter((o) => state === 'all' || (state === 'open' ? isOpenOrder(o) : o.state === state));
      list = state === 'open' ? list.sort((a, b) => daysAtStep(b, c.now) - daysAtStep(a, c.now) || (a.id < b.id ? -1 : 1)) : list.sort((a, b) => (a.id < b.id ? 1 : -1));
      const cut = page(list, input.limit, 50);
      return {
        asOf: c.now, synthetic: await isSynthetic(core), total: cut.total, truncated: cut.truncated,
        steps: ORDER_STEPS.map((s) => ({ step: s, name: STEP_NAMES[s], roles: s === 'received' ? [...STOCK_CATEGORIES[CATEGORY].roles.receive] : [...STEP_ROLES[s]],
          usualDays: USUAL_DAYS[s] ?? null, note: s === 'received' ? 'Recorded by receiving the delivery into stock (ospeli_stock_receive with orderRef).' : null })),
        orders: cut.items.map((o) => orderRow(c, o, input.format)), cancelReasons: [...ORDER_CANCEL_REASONS],
      };
    },
    example: { input: { state: 'open', limit: 10 } },
  },
  {
    name: 'ospeli_stores_order_step',
    summary: 'Record the next purchasing step of an order: requested (opens an order: items and quantities, no price or supplier), approved, ordered, delivered, or cancelled with a reason from the list (an order part received can have the rest cancelled this way). Steps go in order; "received" is recorded by receiving the delivery into stock with ospeli_stock_receive and orderRef, and the order stays open as part received until every line has come. People approve purchases: an agent\'s approval is refused, and any other step from an agent becomes a proposal for a person.',
    kind: 'write', roles: STEP_WRITERS, approval: true,
    input: { type: 'object', additionalProperties: false, required: ['step'], properties: {
      step: { type: 'string', enum: RECORDED_STEPS, description: `The step to record: ${RECORDED_STEPS.join(', ')}. Who records each: ${RECORDED_STEPS.map((s) => `${s} by ${roleList(STEP_ROLES[s])}`).join('; ')}.` },
      orderId: { ...ORDER_ID, description: 'The order, for every step after requested, for example ord-00001 (ospeli_stores_orders lists them).' },
      expectedStep: { type: 'string', enum: ORDER_STATES, description: 'The step the caller last saw the order at (or part-received). If it has moved on since, the command is refused (conflict).' },
      lines: { type: 'array', minItems: 1, maxItems: MAX_ORDER_LINES, items: STEP_LINE, description: 'For step requested only: what is ordered, each line { itemId, qty } once.' },
      placeId: { ...ID, description: 'For step requested only: the store the order is for. Leave out for the site\'s first store.' },
      reason: { type: 'string', enum: ORDER_CANCEL_REASONS, description: `For step cancelled only: why, one of ${ORDER_CANCEL_REASONS.join(', ')}.` },
      again: { type: 'boolean', description: 'Send true only when the command said the same order was requested a moment ago and this really is a second one.' } } },
    output: WRITE_OUT({ orderId: { type: 'string', pattern: ORDER_ID_PATTERN }, step: { type: 'string' }, state: { type: 'string' } }),
    target: (input) => ({ id: input.orderId ?? null, word: 'order' }),
    wardOf: async () => null, // an order is the store's, not a ward's
    async precheck(core, input, { actor } = {}) { await checkStep(core, input, actor); },
    async run(core, input, { actor }) {
      noAgentApproval(input, actor); // checked again here, whoever calls run
      let res = null;
      const recs = await core.appendChecked(async (events) => {
        const { c, o, placeId } = await checkStep(core, input, actor, events);
        const orderId = o ? o.id : nextOrderId(events);
        const data = input.step === 'requested' ? { step: 'requested', placeId, lines: input.lines.map((l) => ({ itemId: l.itemId, qty: l.qty })) }
          : input.step === 'cancelled' ? { step: 'cancelled', reason: input.reason } : { step: input.step };
        res = { orderId, data, at: c.now };
        return [{ type: 'stores.order-step', subject: orderId, actorRole: actor.role, at: c.now, data }];
      });
      await core.recordAs(actor, 'stores.order-step', res.orderId, { step: input.step, ...(res.data.lines ? { lines: res.data.lines.length, placeId: res.data.placeId } : {}), ...(res.data.reason ? { reason: res.data.reason } : {}) });
      return { status: 'done', orderId: res.orderId, step: input.step, state: input.step, events: recs.map((r) => r.seq) };
    },
    example: { input: { step: 'requested', lines: [{ itemId: STOCK_ITEMS[0].id, qty: 20 }] } },
  },
  {
    name: 'ospeli_stores_order_remind',
    summary: 'Send a reminder about an order that waits at one step, to the roles that hold that step: it shows on their stores page and on the order. At most one a day for one order at one step. The guide suggests it when an order has waited longer than usual (an example setting); a person sends it. An agent\'s call becomes a proposal for a person.',
    kind: 'write', roles: ['supply-manager', 'storekeeper'], approval: true,
    input: { type: 'object', additionalProperties: false, required: ['orderId', 'expectedStep'], properties: {
      orderId: ORDER_ID,
      expectedStep: { type: 'string', enum: ORDER_STATES, description: 'The step the order waits at, as the caller saw it. If it has moved on, nothing is sent (conflict).' } } },
    output: WRITE_OUT({ orderId: { type: 'string' }, step: { type: 'string' }, roles: { type: 'array', description: 'The roles the reminder is for.' } }),
    target: (input) => ({ id: input.orderId, word: 'order' }),
    wardOf: async () => null,
    async precheck(core, input) { await checkRemind(core, input); },
    async run(core, input, { actor }) {
      let step = null;
      const recs = await core.appendChecked(async (events) => {
        const { c, o } = await checkRemind(core, input, events);
        step = o.state;
        return [{ type: 'stores.order-reminded', subject: o.id, actorRole: actor.role, at: c.now, data: { step } }];
      });
      await core.recordAs(actor, 'stores.order-reminded', input.orderId, { step });
      return { status: 'done', orderId: input.orderId, step, roles: [...WAITING_FOR[step].roles], events: recs.map((r) => r.seq) };
    },
    example: { input: { orderId: 'ord-00001', expectedStep: 'requested' }, needs: 'An open order at that step, with no reminder sent in the last day. ord-00001 is an example id: ospeli_stores_orders lists the open orders, and ospeli_stores_order_step with step "requested" opens one.' },
  },
  {
    name: 'ospeli_stores_guide_set',
    summary: 'Switch the stores guide on or off for this site. The guide is three fixed rules: a top-up level that use has outgrown, an order waiting at one step longer than usual, and a transfer from an area with far more than its level to one that is short. They suggest; a person decides. With it off everything else works the same. People only.',
    kind: 'write', roles: ['supply-manager', 'ops-manager', 'coo'], approval: true, agents: false,
    input: { type: 'object', additionalProperties: false, required: ['on'], properties: { on: { type: 'boolean', description: 'true: show the guide\'s suggestions. false: none.' } } },
    output: WRITE_OUT({ on: { type: 'boolean' } }),
    async precheck(core, input) { await checkGuide(core, input); },
    async run(core, input, { actor }) {
      const recs = await core.appendChecked(async (events) => {
        await checkGuide(core, input, events);
        return [{ type: 'stores.guide-set', subject: 'stores-guide', actorRole: actor.role, at: core.now(), data: { on: input.on } }];
      });
      await core.recordAs(actor, 'stores.guide-set', 'stores-guide', { on: input.on });
      return { status: 'done', on: input.on, events: recs.map((r) => r.seq) };
    },
    example: { input: { on: false } },
  },
];

// What an example needs, put in place the way a person would: an order that is open.
export async function prepareExample(core, command, { run }) {
  if (command.name === 'ospeli_stores_order_remind') {
    const made = await run('ospeli_stores_order_step', { step: 'requested', lines: [{ itemId: STOCK_ITEMS[1].id, qty: 5 }] }, 'supply-manager');
    return { orderId: made.orderId, expectedStep: 'requested' };
  }
  return {};
}

// ---- synthetic history for the example hospital: thirty days of ward supplies ----
// Generic patterns only, entirely fictional: each ward uses its items at a steady rate with day to
// day noise, counts them every two to four days, and the count raises a request for what is under
// the top-up level; the store issues within hours in its working day, in part when it is short;
// the supply chain manager reviews the store weekly and orders what is under the store's level,
// through approval, order, delivery and receipt. One donation arrives. Two stock-outs are declared
// and ended. At the end: a few requests waiting, one ward item at zero with an open stock-out, one
// order waiting for approval longer than usual, one area holding far more than its level of an
// item another area is short of, and one item whose use runs ahead of its level.
const RATE = { 'gloves-m': 1.2, 'gloves-l': 0.6, 'syringe-5': 0.35, 'syringe-10': 0.2, 'needle-21': 0.3, 'cannula-20': 0.25, 'giving-set': 4, 'gauze-swabs': 0.4,
  'dressing-small': 0.3, 'tape-roll': 0.12, 'alcohol-wipes': 0.4, 'hand-rub': 1.5, aprons: 0.5, masks: 0.8, 'sharps-bin': 0.5, 'urine-bag': 0.2, underpads: 0.5,
  'detergent-wipes': 0.4, 'specimen-pots': 0.15, 'suction-cath': 0.1, electrodes: 0.3 }; // units a day on a ward of average use
const WARD_USE = [1.2, 1, 0.9, 1, 0.9, 0.7]; // how busy each example ward is, by its place in the list
const ONLY_ON = { masks: [0, 3], 'suction-cath': [0, 2], electrodes: [0, 1, 3], 'urine-bag': [0, 1, 2, 3, 4] };

export const seed = seedHistory; // thirty days of ward supplies in the example hospital
export function seedHistory({ r, startMs, endMs, entities }) {
  const store = entities.find((e) => e.type === 'store');
  const wards = entities.filter((e) => e.type === 'ward').map((e) => e.id);
  if (!store || wards.length < 2) return []; // an older example hospital with no store: no history
  const S = store.id;
  const offset = (entities.find((e) => e.type === 'site' && e.utcOffsetMinutes != null)?.utcOffsetMinutes ?? 0) * MIN;
  const localHour = (t) => Math.floor(((((t + offset) % DAY) + DAY) % DAY) / HOUR);
  const atLocal = (t, hour, minute = 0) => { const local = t + offset; return local - ((local % DAY) + DAY) % DAY + hour * HOUR + minute * MIN - offset; };
  const totalDays = Math.ceil((endMs - startMs) / DAY);
  const W = (i) => wards[i % wards.length];
  const out = [];
  const emit = (t, type, subject, actorRole, data) => out.push({ t: Math.round(t / 1000) * 1000, type, subject, actorRole, data });

  // Who holds what, at which level, using how much.
  const plan = new Map(); // ward -> Map(item -> { rate, level, bal, lastT })
  wards.forEach((w, i) => {
    const m = new Map();
    for (const it of STOCK_ITEMS) {
      if (ONLY_ON[it.id] && !ONLY_ON[it.id].map(W).includes(w)) continue;
      const rate = RATE[it.id] * (WARD_USE[i] ?? 1);
      m.set(it.id, { rate, level: Math.max(1, Math.ceil(rate * 7 * 1.4)), bal: 0, lastT: startMs });
    }
    plan.set(w, m);
  });
  // Scripted: on the second ward gauze swabs run ahead of their level; the fourth ward holds far more masks than it needs.
  Object.assign(plan.get(W(1)).get('gauze-swabs'), { rate: 1, level: 4 });
  if (plan.get(W(3)).has('masks')) Object.assign(plan.get(W(3)).get('masks'), { rate: 0.1, level: 4 });
  const noise = new Map(); // ward|item -> day factors, drawn in a fixed order
  for (const w of wards) for (const itemId of plan.get(w).keys()) noise.set(`${w}|${itemId}`, Array.from({ length: totalDays + 2 }, () => 0.5 + r.int(0, 100) / 100));
  const use = (w, t) => {
    for (const [itemId, s] of plan.get(w)) {
      const f = noise.get(`${w}|${itemId}`);
      for (let x = s.lastT; x < t;) {
        const d = Math.floor((x - startMs) / DAY);
        const y = Math.min(t, startMs + (d + 1) * DAY);
        s.bal = Math.max(0, s.bal - s.rate * (f[d] ?? 1) * ((y - x) / DAY));
        x = y;
      }
      s.lastT = Math.max(s.lastT, t);
    }
  };
  const total = Object.fromEntries(STOCK_ITEMS.map((it) => [it.id, wards.reduce((n, w) => n + (plan.get(w).get(it.id)?.rate ?? 0), 0)]));
  // The store's level is its reorder point (sixteen days of use: a week between reviews and up to nine days to arrive); an order tops it up to a month.
  const storeLevel = Object.fromEntries(STOCK_ITEMS.map((it) => [it.id, Math.max(2, Math.ceil(total[it.id] * 16))]));
  const storeMax = Object.fromEntries(STOCK_ITEMS.map((it) => [it.id, Math.max(4, Math.ceil(total[it.id] * 32))]));
  const storeBal = Object.fromEntries(STOCK_ITEMS.map((it) => [it.id, Math.max(3, Math.ceil(total[it.id] * r.int(18, 30)))]));

  // Everything that happens, in time order.
  const queue = [];
  const at = (t, kind, data = {}) => { if (t <= endMs) queue.push({ t, kind, data, n: queue.length }); };
  const requests = new Map(); const openReq = new Map(); const waitingStock = [];
  const orders = new Map(); const onOrder = new Set();
  const outs = new Map(); // ward|item -> stock-out id, while a scripted one is open
  let reqN = 0; let ordN = 0; let soN = 0;
  const pad = (n) => String(n).padStart(5, '0');
  const inStoreHours = (t) => {
    const h = localHour(t);
    if (h < 7) return atLocal(t, 7, r.int(0, 60));
    if (h >= 19) return atLocal(t + DAY, 7, r.int(0, 90));
    return t;
  };

  // Opening: levels set, the store's and each ward's first count.
  let t0 = startMs + 20 * MIN;
  for (const w of wards) for (const [itemId, s] of plan.get(w)) emit(t0 += 1000, 'stock.level-set', w, 'supply-manager', { itemId, level: s.level });
  for (const it of STOCK_ITEMS) emit(t0 += 1000, 'stock.level-set', S, 'supply-manager', { itemId: it.id, level: storeLevel[it.id] });
  emit(startMs + 30 * MIN, 'stock.counted', S, 'storekeeper', { lines: STOCK_ITEMS.map((it) => ({ itemId: it.id, qty: storeBal[it.id] })) });
  wards.forEach((w, i) => {
    for (const s of plan.get(w).values()) s.bal = s.level - r.int(0, Math.ceil(s.level * 0.4));
    if (i === 3 && plan.get(w).has('masks')) plan.get(w).get('masks').bal = 14;
    at(startMs + 40 * MIN + i * 3 * MIN, 'count', { w, opening: true });
  });

  // Regular counts every two to four days; the last ones on four wards are scripted near the end.
  const finals = [[0, 3 * HOUR, { 'hand-rub': 0, masks: 2 }], [2, 5 * HOUR, {}], [4, 100 * MIN, {}], [5, 40 * MIN, {}]];
  wards.forEach((w, i) => {
    const stop = finals.some(([k]) => W(k) === w) ? endMs - 30 * HOUR : endMs - 2 * HOUR;
    for (let t = startMs + r.int(1, 2) * DAY; t < endMs; t += r.int(2, 4) * DAY) {
      const c = atLocal(t, r.int(7, 10), r.int(0, 59));
      if (c > startMs + HOUR && c < stop) at(c, 'count', { w });
    }
  });
  for (const [k, back, overrides] of finals) at(endMs - back, 'count', { w: W(k), overrides, final: true });
  // Two stock-outs declared and ended: a ward that ran out of gauze swabs, another out of hand rub.
  at(atLocal(startMs + 9 * DAY, 8, 30), 'count', { w: W(4), only: ['gauze-swabs'], overrides: { 'gauze-swabs': 0 }, out: ['gauze-swabs', 'Not delivered', false] });
  at(atLocal(startMs + 19 * DAY, 9, 0), 'count', { w: W(2), only: ['hand-rub'], overrides: { 'hand-rub': 0 }, out: ['hand-rub', 'Used faster than expected', true] });
  // The store: a weekly review raises orders; one donation.
  for (const d of [2, 9, 16, 23]) if (startMs + (d + 1) * DAY < endMs - 5 * DAY) at(atLocal(startMs + d * DAY, 10, r.int(0, 30)), 'review');
  at(atLocal(startMs + 12 * DAY, 11, 0), 'donation');
  at(atLocal(endMs - 4.5 * DAY, 10, 15), 'order', { pick: 2, stuck: true }); // waits for approval, longer than usual
  at(endMs - 2.7 * DAY, 'order', { pick: 2, approveAt: endMs - 1.2 * DAY });

  const issueLater = (id, t) => {
    if (t > endMs - 6 * HOUR) return; // raised in the last hours: still waiting at the end
    const due = inStoreHours(t + Math.min(20 * HOUR, Math.max(40 * MIN, r.lognormal(4, 0.6) * HOUR)));
    at(due, 'issue', { id });
  };
  const openOrder = (t, lines, by = 'supply-manager') => {
    const id = `ord-${pad(++ordN)}`;
    orders.set(id, { id, lines });
    for (const l of lines) onOrder.add(l.itemId);
    emit(t, 'stores.order-step', id, by, { step: 'requested', placeId: S, lines });
    return id;
  };
  const handlers = {
    count(t, { w, overrides = {}, only = null, out: so = null }) {
      use(w, t);
      const lines = []; const ask = [];
      for (const [itemId, s] of plan.get(w)) {
        if (only && !only.includes(itemId)) continue;
        // What is on the shelf in whole units; the part of a unit already open stays where it is.
        const qty = overrides[itemId] ?? Math.floor(s.bal);
        if (overrides[itemId] != null) s.bal = qty;
        lines.push({ itemId, qty });
        if (qty < s.level && !openReq.has(`${w}|${itemId}`)) ask.push({ itemId, qty: s.level - qty });
      }
      emit(t, 'stock.counted', w, 'ward-nurse', { lines });
      if (ask.length) {
        const id = `req-${pad(++reqN)}`;
        requests.set(id, { id, w, lines: ask.map((l) => ({ ...l, issued: 0 })) });
        for (const l of ask) openReq.set(`${w}|${l.itemId}`, id);
        emit(t, 'stock.requested', id, 'ward-nurse', { placeId: w, fromPlaceId: S, lines: ask, raisedBy: 'count' });
        issueLater(id, t);
      }
      for (const [itemId, ov] of Object.entries(overrides)) {
        if (ov !== 0 || outs.has(`${w}|${itemId}`)) continue;
        const scripted = so && so[0] === itemId;
        if (!scripted && !(itemId === 'hand-rub' && w === W(0))) continue;
        const sid = `so-${pad(++soN)}`;
        outs.set(`${w}|${itemId}`, { sid, careAffected: scripted ? so[2] : null, ends: scripted });
        emit(t + 15 * MIN, 'stock.stock-out-started', sid, 'ward-nurse', { itemId, placeId: w, cause: scripted ? so[1] : 'Used faster than expected' });
      }
    },
    issue(t, { id }) {
      const q = requests.get(id);
      if (q.lines.every((l) => l.issued >= l.qty)) return;
      const give = q.lines.map((l) => ({ itemId: l.itemId, qty: Math.min(l.qty - l.issued, storeBal[l.itemId]) })).filter((l) => l.qty > 0);
      if (!give.length) { waitingStock.push(id); return; }
      use(q.w, t);
      for (const g of give) {
        storeBal[g.itemId] -= g.qty;
        plan.get(q.w).get(g.itemId).bal += g.qty;
        q.lines.find((l) => l.itemId === g.itemId).issued += g.qty;
        const so = outs.get(`${q.w}|${g.itemId}`);
        if (so?.ends) { so.ends = false; at(t + r.int(30, 90) * MIN, 'outEnd', { key: `${q.w}|${g.itemId}` }); }
      }
      emit(t, 'stock.issued', id, 'storekeeper', { fromPlaceId: S, lines: give });
      for (const l of q.lines) if (l.issued >= l.qty) openReq.delete(`${q.w}|${l.itemId}`);
      if (q.lines.some((l) => l.issued < l.qty)) waitingStock.push(id);
    },
    outEnd(t, { key }) {
      const so = outs.get(key);
      emit(t, 'stock.stock-out-ended', so.sid, 'ward-nurse', { careAffected: so.careAffected === true });
      outs.delete(key);
    },
    review(t) {
      const lines = STOCK_ITEMS.filter((it) => storeBal[it.id] < storeLevel[it.id] && !onOrder.has(it.id)).map((it) => ({ itemId: it.id, qty: storeMax[it.id] - storeBal[it.id] }));
      if (!lines.length) return;
      const id = openOrder(t, lines);
      at(t + r.int(16, 44) * HOUR, 'approve', { id, next: true });
    },
    order(t, { pick, stuck, approveAt }) {
      const lines = STOCK_ITEMS.filter((it) => !onOrder.has(it.id)).sort((a, b) => storeBal[a.id] / storeLevel[a.id] - storeBal[b.id] / storeLevel[b.id] || (a.id < b.id ? -1 : 1))
        .slice(0, pick).map((it) => ({ itemId: it.id, qty: Math.max(1, storeMax[it.id] - storeBal[it.id]) }));
      if (!lines.length) return;
      const id = openOrder(t, lines, stuck ? 'storekeeper' : 'supply-manager');
      if (approveAt) at(approveAt, 'approve', { id, next: false });
    },
    approve(t, { id, next }) {
      emit(t, 'stores.order-step', id, 'ops-manager', { step: 'approved' });
      if (next) at(t + r.int(2, 20) * HOUR, 'placed', { id });
    },
    placed(t, { id }) {
      emit(t, 'stores.order-step', id, 'supply-manager', { step: 'ordered' });
      const arrive = inStoreHours(t + r.int(3, 6) * DAY);
      if (r.chance(0.5)) { at(arrive, 'delivered', { id }); at(arrive + r.int(1, 5) * HOUR, 'receive', { id }); } else at(arrive, 'receive', { id });
    },
    delivered(t, { id }) { emit(t, 'stores.order-step', id, 'storekeeper', { step: 'delivered' }); },
    receive(t, { id }) {
      const o = orders.get(id);
      emit(t, 'stock.received', S, 'storekeeper', { lines: o.lines.map((l) => ({ ...l })), source: 'Purchase', orderRef: id });
      for (const l of o.lines) { storeBal[l.itemId] += l.qty; onOrder.delete(l.itemId); }
      restart(t);
    },
    donation(t) {
      const lines = [{ itemId: 'gloves-m', qty: 20 }, { itemId: 'aprons', qty: 10 }];
      emit(t, 'stock.received', S, 'storekeeper', { lines, source: 'Donation', orderRef: null });
      for (const l of lines) storeBal[l.itemId] += l.qty;
      restart(t);
    },
  };
  // After stock arrives, the requests that were waiting for it are issued, oldest first.
  function restart(t) {
    const list = [...new Set(waitingStock.splice(0))].filter((id) => requests.get(id).lines.some((l) => l.issued < l.qty));
    list.forEach((id, k) => at(inStoreHours(t + (30 + 10 * k) * MIN), 'issue', { id }));
  }
  while (queue.length) {
    let k = 0;
    for (let i = 1; i < queue.length; i++) if (queue[i].t < queue[k].t || (queue[i].t === queue[k].t && queue[i].n < queue[k].n)) k = i;
    const [job] = queue.splice(k, 1);
    handlers[job.kind](job.t, job.data);
  }
  return out.filter((e) => e.t >= startMs && e.t <= endMs);
}
