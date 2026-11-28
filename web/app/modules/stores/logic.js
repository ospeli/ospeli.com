// Stores and supplies: the module's fixed lists and its pure functions. Everything here reads the
// event log and nothing else: no screen, no storage, no clock (the caller passes `now`), so the
// order tracker, the KPIs and the guide give the same answer in the browser, in a test and on a
// site's own server.
//
// The stock itself (counts, requests, issues, receipts, transfers, stock-outs, levels) is the
// shared stock item (core/stock.js). This file adds the module's category and example items, the
// order tracker (stores.order-step events), the measures and the guide's three fixed rules.
//
// Measure flows, never people: every number is about items, requests and orders. An event records
// the role that made it, never a person. No price, value, currency, brand or supplier anywhere.
// Ospeli records purchasing steps; people approve purchases, it never does.

import { stockCatalogue, deriveStock, balance, stockOutRate, fillRate, requestWait, USE_PERIOD_DAYS, MAX_QTY } from '../../core/stock.js';
import { ALL_ROLES, median, DAY, HOUR } from '../../core/kit.js';
import { roleById } from '../../core/model.js';

// ---- the module's stock configuration (the shared stock item reads it from the pack) ----
// Who may do what with ward supplies. Every verb is listed; [] means nobody does it here.
export const STOCK_CATEGORIES = {
  supplies: { name: 'Supplies', roles: {
    count: ['ward-nurse', 'storekeeper', 'supply-manager'], request: ['ward-nurse', 'supply-manager'], issue: ['storekeeper'], receive: ['storekeeper'],
    transfer: ['storekeeper', 'supply-manager'], use: [], writeOff: ['storekeeper', 'supply-manager'], hold: ['supply-manager'], release: ['supply-manager'],
    levels: ['supply-manager'], itemAdd: ['supply-manager'],
  } },
};
// About twenty generic consumables: no brand, supplier, price or currency, nothing cold-chain and
// nothing that is a medicine (medicines are pharmacy operations). Critical items are the few watched
// as a sign of how well stock is kept; which ones is an example choice, set locally.
export const STOCK_ITEMS = [
  { id: 'gloves-m', name: 'Examination gloves, medium', unit: 'box of 100', category: 'supplies', tracer: true },
  { id: 'gloves-l', name: 'Examination gloves, large', unit: 'box of 100', category: 'supplies' },
  { id: 'syringe-5', name: 'Syringe, 5 ml', unit: 'box of 100', category: 'supplies', tracer: true },
  { id: 'syringe-10', name: 'Syringe, 10 ml', unit: 'box of 100', category: 'supplies' },
  { id: 'needle-21', name: 'Hypodermic needle, 21 gauge', unit: 'box of 100', category: 'supplies' },
  { id: 'cannula-20', name: 'Intravenous cannula, 20 gauge', unit: 'box of 50', category: 'supplies', tracer: true },
  { id: 'giving-set', name: 'Infusion giving set', unit: 'each', category: 'supplies', tracer: true },
  { id: 'gauze-swabs', name: 'Gauze swabs', unit: 'pack of 100', category: 'supplies' },
  { id: 'dressing-small', name: 'Adhesive dressing, small', unit: 'box of 50', category: 'supplies' },
  { id: 'tape-roll', name: 'Surgical tape', unit: 'box of 12 rolls', category: 'supplies' },
  { id: 'alcohol-wipes', name: 'Alcohol skin wipes', unit: 'box of 200', category: 'supplies' },
  { id: 'hand-rub', name: 'Alcohol hand rub, 500 ml', unit: 'bottle', category: 'supplies', tracer: true },
  { id: 'aprons', name: 'Disposable aprons', unit: 'roll of 100', category: 'supplies' },
  { id: 'masks', name: 'Surgical masks', unit: 'box of 50', category: 'supplies', tracer: true },
  { id: 'sharps-bin', name: 'Sharps container, 5 litre', unit: 'each', category: 'supplies' },
  { id: 'urine-bag', name: 'Urine drainage bag', unit: 'box of 10', category: 'supplies' },
  { id: 'underpads', name: 'Bed underpads', unit: 'pack of 25', category: 'supplies' },
  { id: 'detergent-wipes', name: 'Detergent wipes', unit: 'pack of 100', category: 'supplies' },
  { id: 'specimen-pots', name: 'Specimen pots', unit: 'box of 100', category: 'supplies' },
  { id: 'suction-cath', name: 'Suction catheter', unit: 'box of 50', category: 'supplies' },
  { id: 'electrodes', name: 'Monitoring electrodes', unit: 'pack of 50', category: 'supplies' },
];
// Issued is not arrived (ospeli/ospeli#113, point 1): until a ward can confirm that a delivery
// arrived, the shared stock item puts an issued item on the ward's balance at once. The screens and
// the module's reads say so in the same words, as the review asked, until that is built.
export const EXAMPLE_NOTE = 'Example data only. An item the store issues is counted as arrived on the ward until the ward confirms arrival, which is not built yet.';
export const CATEGORY = 'supplies';
// Units an item a site adds may be counted in: a pick list, so nothing is typed but the name.
export const UNITS = ['each', 'pair', 'pack', 'pack of 10', 'pack of 25', 'pack of 50', 'pack of 100', 'box', 'box of 10', 'box of 50', 'box of 100', 'box of 200', 'roll', 'bottle', 'bag', 'case'];

// The module's own catalogue, for its reads. Items a site added come from the log.
export const CATALOGUE = stockCatalogue([{ id: 'stores', STOCK_CATEGORIES, STOCK_ITEMS }], ALL_ROLES);
export const deriveSupplies = (events, offsetMinutes = 0) => deriveStock(events, { items: CATALOGUE.items, categories: CATALOGUE.categories, offsetMinutes });
export const isSupply = (it) => !!it && it.category === CATEGORY && it.coldChain !== true;
export const suppliesRequest = (stock) => (q) => q.lines.some((l) => isSupply(stock.items.get(l.itemId)));

// ---- orders: the purchasing steps, recorded by people (stores.order-step events) ----
// Received is not recorded here: it is the first stock receipt that names the order (orderRef on
// ospeli_stock_receive), so the tracker and the stock balance can never disagree.
export const ORDER_STEPS = ['requested', 'approved', 'ordered', 'delivered', 'received'];
export const RECORDED_STEPS = ['requested', 'approved', 'ordered', 'delivered', 'cancelled'];
export const STEP_NAMES = { requested: 'Requested', approved: 'Approved', ordered: 'Ordered', delivered: 'Delivered', 'part-received': 'Part received', received: 'Received', cancelled: 'Cancelled' };
// The states an order can be in: a step, or part received (some lines still to come).
export const ORDER_STATES = ['requested', 'approved', 'ordered', 'delivered', 'part-received'];
// Who records each step. The roles that request and the roles that approve are different on purpose.
export const STEP_ROLES = {
  requested: ['supply-manager', 'storekeeper'], approved: ['ops-manager', 'coo'], ordered: ['supply-manager'],
  delivered: ['storekeeper', 'supply-manager'], cancelled: ['supply-manager', 'ops-manager'],
};
export const RECEIVE_ROLES = STOCK_CATEGORIES.supplies.roles.receive;
// While an order is at a step, it waits for the next one, and for the roles that hold it.
export const WAITING_FOR = {
  requested: { words: 'Waiting for approval', roles: STEP_ROLES.approved },
  approved: { words: 'Waiting to be ordered', roles: STEP_ROLES.ordered },
  ordered: { words: 'Waiting for delivery', roles: ['supply-manager'] },
  delivered: { words: 'Waiting to be received into stock', roles: RECEIVE_ROLES },
  'part-received': { words: 'Waiting for the rest of the delivery', roles: ['supply-manager'] },
};
// Example settings, not standards: the usual longest wait at each step, set locally.
export const USUAL_DAYS = { requested: 2, approved: 2, ordered: 7, delivered: 1, 'part-received': 7 };
export const REMIND_GAP_HOURS = 24; // one reminder a day at most for one order at one step (example setting)
export const ORDER_CANCEL_REASONS = ['No longer needed', 'Ordered another way', 'Asked for by mistake', 'Other'];
export const ORDER_ID_PATTERN = '^ord-[0-9]{5,}$';
export const MAX_ORDER_LINES = 50;
const ORDER_ID = /^ord-(\d{5,})$/;
const OPEN = ORDER_STATES;
export const isOpenOrder = (o) => OPEN.includes(o.state);

// Why a step cannot be recorded on an order as it stands, or null when it can.
export function stepProblem(order, step) {
  if (step === 'requested') return order ? 'This order is already requested.' : null;
  if (!order) return 'There is no such order.';
  if (order.state === 'received') return 'This order is already received in full.';
  if (order.state === 'part-received' && step !== 'cancelled') return 'Part of this order is received: the rest is received into stock against it, or cancelled with a reason.';
  if (order.state === 'cancelled') return 'This order is cancelled.';
  if (step === 'cancelled') return null;
  const before = { approved: 'requested', ordered: 'approved', delivered: 'ordered' }[step];
  if (!before) return `${step} is not a step that is recorded here.`;
  if (order.state !== before) {
    return order.state === 'requested' && step !== 'approved' ? 'This order is not approved yet: a person in a role that approves purchases records the approval first.'
      : `This order is ${STEP_NAMES[order.state].toLowerCase()}, so the next step is ${STEP_NAMES[nextStep(order.state)].toLowerCase()}.`;
  }
  return null;
}
export const nextStep = (state) => ORDER_STEPS[ORDER_STEPS.indexOf(state) + 1] || null;

// Orders, read from the log. A step that does not fit (an edited import) is left out and counted.
export function deriveOrders(events) {
  const orders = new Map();
  let problems = 0;
  for (const e of events) {
    if (e.type === 'stores.order-step') {
      const d = e.data || {};
      const o = orders.get(e.subject);
      if (d.step === 'requested') {
        const lines = (Array.isArray(d.lines) ? d.lines : []).slice(0, MAX_ORDER_LINES)
          .filter((l) => typeof l?.itemId === 'string' && Number.isInteger(l.qty) && l.qty > 0 && l.qty <= MAX_QTY);
        if (o || !ORDER_ID.test(e.subject) || !lines.length) { problems += 1; continue; }
        orders.set(e.subject, { id: e.subject, placeId: typeof d.placeId === 'string' ? d.placeId : null, lines: lines.map((l) => ({ itemId: l.itemId, qty: l.qty, received: 0 })),
          state: 'requested', steps: { requested: { at: e.at, byRole: e.actorRole } }, reminders: [], receipts: 0, cancelReason: null, lastSeq: e.seq ?? 0,
          receivedBeforeApproval: null, fullBeforeApproval: null });
        continue;
      }
      if (!RECORDED_STEPS.includes(d.step) || stepProblem(o, d.step)) { problems += 1; continue; }
      o.steps[d.step] = { at: e.at, byRole: e.actorRole };
      o.state = d.step;
      if (d.step === 'cancelled') o.cancelReason = ORDER_CANCEL_REASONS.includes(d.reason) ? d.reason : 'Other';
      // Goods already received before the approval: once approved, they complete the order (or part of it).
      if (d.step === 'approved' && o.receivedBeforeApproval) {
        if (o.fullBeforeApproval) { o.steps.received = o.fullBeforeApproval; o.state = 'received'; }
        else { o.steps['part-received'] = o.receivedBeforeApproval; o.state = 'part-received'; }
      }
      if (e.seq > o.lastSeq) o.lastSeq = e.seq;
    } else if (e.type === 'stores.order-reminded') {
      const o = orders.get(e.subject);
      if (!o || !isOpenOrder(o)) { problems += 1; continue; }
      o.reminders.push({ at: e.at, step: o.state, byRole: e.actorRole });
      if (e.seq > o.lastSeq) o.lastSeq = e.seq;
    } else if (e.type === 'stock.received' && typeof e.data?.orderRef === 'string') {
      const o = orders.get(e.data.orderRef);
      if (!o || o.state === 'cancelled' || o.state === 'received') continue;
      for (const l of Array.isArray(e.data.lines) ? e.data.lines : []) {
        const want = o.lines.find((x) => x.itemId === l?.itemId);
        if (want && Number.isInteger(l.qty) && l.qty > 0) want.received += l.qty;
      }
      o.receipts += 1;
      // Received before anyone approved the order (#128): counted into stock, never refused (some sites
      // receive urgent items before the paperwork), but the order does not move on. It stays waiting
      // for approval, open and marked "received before approval" where the manager sees it.
      if (!o.steps.approved) {
        o.receivedBeforeApproval ??= { at: e.at, byRole: e.actorRole };
        if (!o.fullBeforeApproval && o.lines.every((l) => l.received >= l.qty)) o.fullBeforeApproval = { at: e.at, byRole: e.actorRole };
        if (e.seq > o.lastSeq) o.lastSeq = e.seq;
        continue;
      }
      // Received in full only when every line has come: the last receipt that completes it. Until
      // then the order is part received and stays open. More than ordered is flagged, never refused.
      if (o.lines.every((l) => l.received >= l.qty)) { o.steps.received = { at: e.at, byRole: e.actorRole }; o.state = 'received'; }
      else if (!o.steps['part-received']) { o.steps['part-received'] = { at: e.at, byRole: e.actorRole }; o.state = 'part-received'; }
      if (e.seq > o.lastSeq) o.lastSeq = e.seq;
    }
  }
  return { orders, problems };
}
export function nextOrderId(events) {
  let max = 0;
  for (const e of events) { const m = e.type === 'stores.order-step' && e.data?.step === 'requested' ? ORDER_ID.exec(e.subject) : null; if (m) max = Math.max(max, Number(m[1])); }
  return `ord-${String(max + 1).padStart(5, '0')}`;
}
const days = (fromIso, toMs) => Math.round(((toMs - Date.parse(fromIso)) / DAY) * 10) / 10;
// One order's steps with the days spent at each, as of `now`. While some lines are still to come,
// the last step shows as "Part received".
const SEQ = ['requested', 'approved', 'ordered', 'delivered', 'part-received', 'received'];
export function orderSteps(o, now) {
  const t = typeof now === 'string' ? Date.parse(now) : now;
  const reached = SEQ.filter((s) => o.steps[s]);
  const end = o.steps.cancelled?.at;
  const row = (s) => {
    const at = o.steps[s]?.at ?? null;
    if (!at) return { step: s, name: STEP_NAMES[s], at: null, byRole: null, days: null };
    const later = reached.slice(reached.indexOf(s) + 1).map((x) => o.steps[x].at)[0] ?? end ?? null;
    // Goods received before approval: the receipt is earlier than the approval, so no negative days.
    return { step: s, name: STEP_NAMES[s], at, byRole: o.steps[s].byRole, days: s === 'received' ? null : Math.max(0, days(at, later ? Date.parse(later) : t)), current: s === o.state };
  };
  return ORDER_STEPS.map((s) => (s === 'received' && !o.steps.received && o.steps['part-received'] ? row('part-received') : row(s)));
}
export const daysAtStep = (o, now) => (isOpenOrder(o) ? days(o.steps[o.state].at, typeof now === 'string' ? Date.parse(now) : now) : null);
export const overUsual = (o, now) => isOpenOrder(o) && daysAtStep(o, now) > USUAL_DAYS[o.state];
export const lastReminder = (o) => o.reminders.filter((r) => r.step === o.state).at(-1) || null;

// ---- the guide switch: on until a person switches it off (stores.guide-set, people only) ----
export function guideOn(events) {
  let on = true;
  for (const e of events) if (e.type === 'stores.guide-set' && typeof e.data?.on === 'boolean') on = e.data.on;
  return on;
}

// ---- KPIs. Each is (stock or orders, { since, until, see }) -> { value, numerator, denominator, n, ... } ----
// `see(placeId)` keeps the places the caller may see (an agent's wards); a person sees all.
const all = () => true;
// 1. Stock-out rate on critical items: the core KPI (dictionary D-17), filtered to supplies tracer
// items, in all and per area. The module works out no formula of its own.
export function tracerStockOutRate(stock, { since, until, see = all }) {
  const pick = (it, h) => isSupply(it) && it.tracer && see(h.placeId);
  const total = stockOutRate(stock, { since, until, pick });
  const areas = [...new Set([...stock.holdings.values()].filter((h) => pick(stock.items.get(h.itemId), h)).map((h) => h.placeId))].sort();
  const byArea = areas.map((placeId) => {
    const v = stockOutRate(stock, { since, until, pick: (it, h) => pick(it, h) && h.placeId === placeId });
    return { placeId, value: v.value, numerator: v.numerator, denominator: v.denominator };
  });
  return { value: total.value, numerator: total.numerator, denominator: total.denominator, n: total.holdings, declaredDays: total.declaredDays, derivedDays: total.derivedDays, byArea };
}
// Each place's usual count interval (#125): the median days between its counts of a critical supplies
// item in the period, from the counts already stored. A zero balance is seen only when a count or a
// movement records it, so a place's figure depends on how often it counts. null below two counts.
export function countIntervals(events, stock, { since, until, see = all }) {
  const [from, to] = [Date.parse(since), Date.parse(until)];
  const times = new Map();
  for (const e of events) {
    if (e.type !== 'stock.counted' || !see(e.subject)) continue;
    const t = Date.parse(e.at);
    if (!(t >= from && t < to)) continue;
    if (!(Array.isArray(e.data?.lines) ? e.data.lines : []).some((l) => { const it = stock.items.get(l?.itemId); return isSupply(it) && it.tracer; })) continue;
    if (!times.has(e.subject)) times.set(e.subject, []);
    times.get(e.subject).push(t);
  }
  const out = new Map();
  for (const [placeId, list] of times) {
    list.sort((a, b) => a - b);
    const m = median(list.slice(1).map((t, i) => (t - list[i]) / DAY));
    out.set(placeId, m == null ? null : Math.round(m * 10) / 10);
  }
  return out;
}
// 2. Request wait: raised to issued in full, median hours (core requestWait). Open requests beside it.
export function requestWaitHours(stock, { since, until, see = all }) {
  const supplies = suppliesRequest(stock);
  const v = requestWait(stock, { since, until, pick: (q) => supplies(q) && see(q.placeId) });
  return { value: v.value, numerator: null, denominator: v.n, n: v.n, open: v.open, longestOpen: v.longestOpenHours };
}
// 3. Order cycle time: order requested to the receipt that completes it (every line received), median days. Orders not
// received in full yet (part received included) are shown beside it, never dropped: how many, and the longest so far.
export function orderCycleTime(orders, { since, until }) {
  const [from, to] = [Date.parse(since), Date.parse(until)];
  const list = [...orders.values()];
  const done = list.filter((o) => o.steps.received && Date.parse(o.steps.received.at) >= from && Date.parse(o.steps.received.at) < to)
    .map((o) => (Date.parse(o.steps.received.at) - Date.parse(o.steps.requested.at)) / DAY);
  const open = list.filter((o) => isOpenOrder(o) && Date.parse(o.steps.requested.at) < to);
  const v = median(done);
  return { value: v == null ? null : Math.round(v * 10) / 10, numerator: null, denominator: done.length, n: done.length, open: open.length,
    longestOpen: open.length ? Math.round((Math.max(...open.map((o) => to - Date.parse(o.steps.requested.at))) / DAY) * 10) / 10 : null };
}
// 4. Fill rate: request lines issued in full / request lines raised (core fillRate).
export function fillRatePercent(stock, { since, until, see = all }) {
  const supplies = suppliesRequest(stock);
  const v = fillRate(stock, { since, until, pick: (q) => supplies(q) && see(q.placeId) });
  return { value: v.value, numerator: v.numerator, denominator: v.denominator, n: v.requests, cancelled: v.cancelled };
}

// ---- what is short now: not every item under its fill-to level (a ward under its level is normal
// between top-ups and is asked for by its count), but what needs a person to look ----
export const SHORT_SHARE = 0.5; // a ward item below half its fill-to level (example setting, not a standard)
export const REQUEST_USUAL_HOURS = 24; // a ward request waiting longer than this (example setting, not a standard)
export function shortNow(stock, orders, { now, isArea, isStore, see = all }) {
  const t = typeof now === 'string' ? Date.parse(now) : now;
  const onOrder = new Set([...orders.values()].filter(isOpenOrder).flatMap((o) => o.lines.filter((l) => l.received < l.qty).map((l) => l.itemId)));
  const lines = [];
  for (const h of stock.holdings.values()) {
    const it = stock.items.get(h.itemId);
    if (!isSupply(it) || !h.level || !see(h.placeId)) continue;
    const usable = balance(h, t, stock.offsetMinutes).usable;
    if (isArea(h.placeId)) {
      if (usable === 0) lines.push({ kind: 'none-left', itemId: h.itemId, placeId: h.placeId, usable, level: h.level });
      else if (usable < h.level * SHORT_SHARE) lines.push({ kind: 'below-share', itemId: h.itemId, placeId: h.placeId, usable, level: h.level });
    } else if (isStore(h.placeId) && usable < h.level && !onOrder.has(h.itemId)) {
      lines.push({ kind: 'store-not-on-order', itemId: h.itemId, placeId: h.placeId, usable, level: h.level });
    }
  }
  const late = [...stock.requests.values()].filter((q) => (q.state === 'open' || q.state === 'part') && suppliesRequest(stock)(q) && see(q.placeId) && t - Date.parse(q.at) > REQUEST_USUAL_HOURS * HOUR)
    .map((q) => ({ kind: 'request-waiting', placeId: q.placeId, requestId: q.id, hours: Math.round(((t - Date.parse(q.at)) / HOUR) * 10) / 10 }));
  const order = { 'none-left': 0, 'store-not-on-order': 1, 'request-waiting': 2, 'below-share': 3 };
  const all = [...lines, ...late].sort((a, b) => order[a.kind] - order[b.kind] || (a.placeId < b.placeId ? -1 : a.placeId > b.placeId ? 1 : (a.itemId || a.requestId) < (b.itemId || b.requestId) ? -1 : 1));
  const wardLines = lines.filter((x) => x.kind !== 'store-not-on-order');
  return { lines: all, counts: { itemLines: wardLines.length, wards: new Set(wardLines.map((x) => x.placeId)).size, noneLeft: lines.filter((x) => x.kind === 'none-left').length,
    storeLines: lines.length - wardLines.length, requestsLate: late.length } };
}

// ---- guide rules: fixed, checkable rules. A rule suggests; a person decides. ----
export const LEVEL_WEEK_DAYS = 7; // the guide assumes an area is topped up about once a week (example setting)
export const LEVEL_EXTRA = 0.25; // a quarter on top of a week's use (example setting)
export const LEVEL_MIN_HISTORY_DAYS = 14; // no suggestion from less history than this (example setting)
export const FAR_MORE = 2; // "far more" means at least twice the fill-to level (example setting)
export const GUIDE_RULES = [
  { id: 'level-check', name: 'Use runs ahead of the fill-to level',
    basis: `Example setting, not a standard: a fixed rule. When an area's use of an item over the last ${USE_PERIOD_DAYS} days (what counts found gone) averages more in a week than its fill-to level, a new level of one week's use plus a quarter is suggested. It assumes the area is topped up about once a week and needs ${LEVEL_MIN_HISTORY_DAYS} days of history; both are set locally. A person sets the level.` },
  { id: 'order-waiting', name: 'An order has waited at one step longer than usual',
    basis: `Example setting, not a standard: the usual longest waits set here are ${USUAL_DAYS.requested} days for approval, ${USUAL_DAYS.approved} days to be ordered, ${USUAL_DAYS.ordered} days for delivery and ${USUAL_DAYS.delivered} day to be received into stock. A person sends the reminder; at most one a day for one order at one step.` },
  { id: 'transfer', name: 'One area holds far more than another that is short',
    basis: `Example setting, not a standard: one area holds at least ${FAR_MORE} times its fill-to level of an item while another area is under its level. The amount suggested is the smaller of the extra and what is short, and what the store holds is shown beside it. Cold-chain items are left out. A person moves the stock and then records the move.` },
];
const BASIS = Object.fromEntries(GUIDE_RULES.map((r) => [r.id, r.basis]));
const roleList = (ids) => ids.map((r) => (r === 'coo' ? 'Chief operating officer' : roleById(r)?.name || r)).join(' or ');
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// Rule 1. `isArea(placeId)`: a ward or department (the store's level is its reorder level, left out).
export function ruleLevelCheck(stock, { now, isArea, see = all, placeName = (id) => id }) {
  const t = typeof now === 'string' ? Date.parse(now) : now;
  const out = [];
  for (const h of stock.holdings.values()) {
    const it = stock.items.get(h.itemId);
    if (!isSupply(it) || !h.level || !isArea(h.placeId) || !see(h.placeId)) continue;
    const held = (t - Date.parse(h.firstAt)) / DAY;
    if (held < LEVEL_MIN_HISTORY_DAYS) continue;
    const span = Math.min(USE_PERIOD_DAYS, held);
    const used = h.use.filter((u) => u.at > t - span * DAY && u.at <= t).reduce((s, u) => s + u.qty, 0);
    const week = (used / span) * LEVEL_WEEK_DAYS;
    if (week <= h.level) continue;
    const level = Math.min(MAX_QTY, Math.ceil(week * (1 + LEVEL_EXTRA)));
    out.push({
      rule: 'level-check', id: `level-check:${h.placeId}:${h.itemId}`, placeId: h.placeId, itemId: h.itemId,
      text: `${it.name}, ${placeName(h.placeId)}: think about a fill-to level of ${level}.`,
      why: `Used in the last ${Math.round(span)} days: ${used} (${it.unit}), about ${Math.round(week * 10) / 10} a week. The fill-to level is ${h.level}.`,
      basis: BASIS['level-check'],
      action: { label: `Set the level to ${level}`, command: 'ospeli_stock_level_set', inputs: [{ itemId: h.itemId, placeId: h.placeId, level, expectedLevel: h.level }] },
    });
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : 1));
}

// Rule 2. orders: from deriveOrders.
export function ruleOrderWaiting(orders, { now, itemName = (id) => id }) {
  const t = typeof now === 'string' ? Date.parse(now) : now;
  const out = [];
  for (const o of orders.values()) {
    if (!overUsual(o, t)) continue;
    const wait = WAITING_FOR[o.state];
    const sent = lastReminder(o);
    const recent = sent && t - Date.parse(sent.at) < REMIND_GAP_HOURS * HOUR;
    const what = o.lines.slice(0, 3).map((l) => itemName(l.itemId)).join(', ') + (o.lines.length > 3 ? ` and ${o.lines.length - 3} more` : '');
    out.push({
      rule: 'order-waiting', id: `order-waiting:${o.id}:${o.state}`, orderId: o.id,
      text: `${what} (order ${Number(o.id.slice(4))}): ${wait.words.toLowerCase()} for ${daysAtStep(o, t)} days.`,
      why: `The usual longest wait set here is ${plural(USUAL_DAYS[o.state], 'day')} (example setting, not a standard). This step is for ${roleList(wait.roles)}.${recent ? ` A reminder was sent ${Math.max(1, Math.round((t - Date.parse(sent.at)) / HOUR))} h ago.` : ''}`,
      basis: BASIS['order-waiting'],
      action: recent ? null : { label: `Remind ${roleList(wait.roles)}`, command: 'ospeli_stores_order_remind', inputs: [{ orderId: o.id, expectedStep: o.state }] },
    });
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : 1));
}

// Rule 3. `isArea(placeId)`: a ward or department; `storeOf(itemId)`: what the store holds usable.
export function ruleTransfer(stock, { now, isArea, see = all, placeName = (id) => id, storeHas = () => null }) {
  const byItem = new Map();
  for (const h of stock.holdings.values()) {
    const it = stock.items.get(h.itemId);
    if (!isSupply(it) || it.batched || !h.level || !isArea(h.placeId) || !see(h.placeId)) continue;
    const usable = balance(h, now, stock.offsetMinutes).usable;
    if (!byItem.has(it.id)) byItem.set(it.id, []);
    byItem.get(it.id).push({ placeId: h.placeId, usable, level: h.level });
  }
  const out = [];
  for (const [itemId, list] of byItem) {
    const rich = list.filter((x) => x.usable >= FAR_MORE * x.level).sort((a, b) => (b.usable - b.level) - (a.usable - a.level) || (a.placeId < b.placeId ? -1 : 1))[0];
    const short = list.filter((x) => x.usable < x.level).sort((a, b) => (b.level - b.usable) - (a.level - a.usable) || (a.placeId < b.placeId ? -1 : 1))[0];
    if (!rich || !short) continue;
    const it = stock.items.get(itemId);
    const qty = Math.min(rich.usable - rich.level, short.level - short.usable);
    const store = storeHas(itemId);
    out.push({
      rule: 'transfer', id: `transfer:${itemId}:${rich.placeId}:${short.placeId}`, itemId, fromPlaceId: rich.placeId, toPlaceId: short.placeId,
      text: `${it.name}: ${placeName(rich.placeId)} could send ${qty} (${it.unit}) to ${placeName(short.placeId)}.`,
      why: `${placeName(rich.placeId)} has ${rich.usable} (fill-to level ${rich.level}); ${placeName(short.placeId)} has ${short.usable} (level ${short.level}).${store == null ? '' : ` The store has ${store} usable.`}`,
      basis: BASIS.transfer,
      action: { label: `Record: ${qty} moved from ${placeName(rich.placeId)} to ${placeName(short.placeId)}`, command: 'ospeli_stock_transfer', inputs: [{ fromPlaceId: rich.placeId, toPlaceId: short.placeId, lines: [{ itemId, qty }] }] },
    });
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : 1));
}

// A percent measure in words. A rate rounded to 0 for the answer is shown as "under 0.1%" while the
// count under it is not zero, so a small rate never reads as none (#113). null: no value yet.
// At the top the same holds: while the count is not all of them (249 of 250 lines filled), the rate
// is never rounded up to "100%"; it keeps one decimal, or reads "over 99.9%" (#192).
export function percentText(value, numerator, denominator) {
  if (value == null) return null;
  if (value < 0.1 && numerator > 0) return 'under 0.1%';
  if (value < 10) return `${Math.round(value * 10) / 10}%`;
  const notAll = value < 100 || (denominator != null && numerator != null && numerator < denominator);
  if (Math.round(value) >= 100 && notAll) {
    const one = Math.round(value * 10) / 10;
    return one < 100 ? `${one}%` : 'over 99.9%';
  }
  return `${Math.round(value)}%`;
}
