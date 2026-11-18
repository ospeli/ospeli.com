// The shared stock item: things held at places, counted in one unit, moved by a few plain
// movements. Stores, pharmacy operations, public health and linen all use it; each module adds
// its categories and its example items as configuration (STOCK_CATEGORIES and STOCK_ITEMS in a
// module's commands.js) and writes no stock command of its own.
//
// Derived only from the event log (stock.* events), like the bed board and the task object:
// nothing about stock is stored except events, so a screen, a KPI and an auditor read one record.
//
// Operations only. The object counts things held at places. It never prescribes, never works out
// a dose for a person, never decides whether stock is fit to use and never approves a purchase.
// It holds no price, value, currency, brand or supplier. A movement records the role that made
// it, never a person.
//
// Events (all { type, subject, actorRole, at, data }); a line is { itemId, qty, batch?, expiresOn? }:
//   stock.item-added        subject item id      data: the item's fields, its name as `label` (an item a site added)
//   stock.level-set         subject place id     { itemId, level }            top-up level; 0 clears it
//   stock.received          subject place id     { lines, source, orderRef? } + at the place
//   stock.requested         subject request id   { placeId, fromPlaceId, lines, raisedBy }
//   stock.issued            subject request id   { lines }                     - supplier, + asker
//   stock.request-cancelled subject request id   { reason }
//   stock.transferred       subject transfer id  { fromPlaceId, toPlaceId, lines, ref? }
//   stock.counted           subject place id     { lines }                     sets the counted lines only
//   stock.used              subject place id     { lines, ref? }               - (used, not waste)
//   stock.written-off       subject place id     { lines, reason, fromHold? }  - (waste)
//   stock.quarantined       subject place id     { lines, reason }             usable -> on hold
//   stock.released          subject place id     { lines }                     on hold -> usable
//   stock.stock-out-started subject stock-out id { itemId, placeId, cause }
//   stock.stock-out-ended   subject stock-out id { careAffected }
// "Under level", "near expiry" and "expired" are never stored: they come from the time asked.

const MIN = 60e3;
const DAY = 864e5;

export const STOCK_PLACE_TYPES = ['site', 'building', 'department', 'ward', 'store'];
export const STOCK_VERBS = ['count', 'request', 'issue', 'receive', 'transfer', 'use', 'writeOff', 'hold', 'release', 'levels', 'itemAdd'];
// Every reason is a pick, so nothing personal can be typed.
export const RECEIVE_SOURCES = ['Purchase', 'Donation', 'Transfer from outside'];
export const WRITE_OFF_REASONS = ['Expired', 'Damaged or broken', 'Heat exposure', 'Freeze exposure', 'Lost', 'Count difference', 'Other'];
export const HOLD_REASONS = ['Cold chain excursion under review', 'Damaged packaging', 'Recall notice', 'Other'];
export const STOCK_OUT_CAUSES = ['Not delivered', 'Order not placed', 'Used faster than expected', 'Supplier out of stock', 'Other'];
export const REQUEST_CANCEL_REASONS = ['No longer needed', 'Asked for by mistake', 'Supplied another way', 'Other'];
export const REQUEST_STATES = { open: 'Waiting', part: 'Part issued', issued: 'Issued', cancelled: 'Cancelled' };

export const MAX_QTY = 100000;
export const MAX_LINES = 100;
export const ITEM_ID_PATTERN = '^[a-z][a-z0-9-]{1,30}$';
export const BATCH_PATTERN = '^[A-Z0-9][A-Z0-9-]{0,19}$'; // a product lot, never anything personal
export const DATE_PATTERN = '^[0-9]{4}-[0-9]{2}-[0-9]{2}$';
export const REQUEST_ID_PATTERN = '^req-[0-9]{5,}$';
export const TRANSFER_ID_PATTERN = '^trf-[0-9]{5,}$';
export const STOCK_OUT_ID_PATTERN = '^so-[0-9]{5,}$';
const SITE_ITEM_ID = /^item-(\d{5,})$/;
const re = (p) => new RegExp(p);
const ITEM_ID = re(ITEM_ID_PATTERN); const BATCH = re(BATCH_PATTERN); const DATE = re(DATE_PATTERN);

// Example settings, not standards: each site sets its own.
export const NEAR_EXPIRY_DAYS = 30;
export const USE_PERIOD_DAYS = 28;

const whole = (n, min = 0) => Number.isInteger(n) && n >= min && n <= MAX_QTY;
export const validDate = (s) => typeof s === 'string' && DATE.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
// An expiry date is read at the end of that day in the site's own time zone.
export const expiryMs = (expiresOn, offsetMinutes = 0) => Date.parse(`${expiresOn}T00:00:00Z`) + DAY - offsetMinutes * MIN;

// What is wrong with an item's fields, or null. Used for pack items (throws at load) and for items a site adds.
export function itemProblem(it, categories) {
  if (!it || typeof it !== 'object') return 'not an item';
  if (typeof it.id !== 'string' || !ITEM_ID.test(it.id)) return 'id must be lower-case letters, digits and hyphens';
  if (typeof it.name !== 'string' || !it.name.trim() || it.name.length > 60) return 'name is required, 60 characters at most';
  if (typeof it.unit !== 'string' || !it.unit.trim() || it.unit.length > 30) return 'unit is required, 30 characters at most (one unit for every quantity, for example "box of 100")';
  if (!categories[it.category]) return `unknown category ${it.category}`;
  for (const k of ['tracer', 'batched', 'coldChain']) if (it[k] != null && typeof it[k] !== 'boolean') return `${k} is true or false`;
  if (it.dosesPerVial != null && !(it.unit === 'vial' && Number.isInteger(it.dosesPerVial) && it.dosesPerVial >= 1 && it.dosesPerVial <= 50)) return 'dosesPerVial is 1 to 50 and only for an item whose unit is "vial"';
  if (it.gs1 != null && !(typeof it.gs1 === 'string' && /^[0-9]{8,14}$/.test(it.gs1))) return 'gs1 is 8 to 14 digits';
  for (const k of Object.keys(it)) if (!['id', 'name', 'unit', 'category', 'tracer', 'batched', 'coldChain', 'dosesPerVial', 'gs1'].includes(k)) return `an item has no field "${k}" (no price, brand or supplier is kept)`;
  return null;
}
const cleanItem = (it, extra = {}) => ({ id: it.id, name: it.name, unit: it.unit, category: it.category, tracer: it.tracer === true, batched: it.batched === true,
  coldChain: it.coldChain === true, dosesPerVial: it.dosesPerVial ?? null, gs1: it.gs1 ?? null, ...extra });

// Put the modules' categories and items together. Throws at load (so a test catches it) on a
// malformed or reused id, an unknown role or category, or a verb with no list.
// packs: [{ id, STOCK_CATEGORIES?: { id: { name, roles: { verb: [role ids] } } }, STOCK_ITEMS?: [item] }].
export function stockCatalogue(packs = [], roleIds = []) {
  const categories = {};
  const items = new Map();
  for (const p of packs) {
    for (const [id, c] of Object.entries(p.STOCK_CATEGORIES || {})) {
      const bad = (why) => { throw new Error(`module ${p.id}: stock category ${id}: ${why}`); };
      if (!ITEM_ID.test(id)) bad('id must be lower-case letters, digits and hyphens');
      if (categories[id]) bad('this id is already used');
      if (typeof c?.name !== 'string' || !c.name.trim() || c.name.length > 40) bad('name is required, 40 characters at most');
      const roles = {};
      for (const v of STOCK_VERBS) {
        const list = c.roles?.[v];
        if (!Array.isArray(list)) bad(`roles.${v} is required (an empty list when nobody does this)`);
        for (const r of list) if (!roleIds.includes(r)) bad(`unknown role ${r} in roles.${v}`);
        roles[v] = [...list];
      }
      for (const v of Object.keys(c.roles || {})) if (!STOCK_VERBS.includes(v)) bad(`unknown verb ${v}`);
      categories[id] = { id, name: c.name, roles, module: p.id };
    }
  }
  for (const p of packs) {
    for (const it of p.STOCK_ITEMS || []) {
      const why = itemProblem(it, categories) || (items.has(it.id) ? 'this id is already used' : SITE_ITEM_ID.test(it.id) ? 'ids like item-00001 are kept for items a site adds' : null);
      if (why) throw new Error(`module ${p.id}: stock item ${it?.id}: ${why}`);
      items.set(it.id, cleanItem(it, { module: p.id, siteAdded: false }));
    }
  }
  return { categories, items };
}

const key = (itemId, placeId) => `${itemId}|${placeId}`;
const bkey = (line) => line.batch || '';
const ms = (iso) => Date.parse(iso);

// Everything about stock, read from the event log. `items` is the catalogue's Map; items a site
// added come from the log. A line that does not fit (an edited import) is left out and counted in
// `problems`, and a movement never takes a balance below zero.
export function deriveStock(events, { items = new Map(), categories = {}, offsetMinutes = 0 } = {}) {
  const all = new Map(items);
  const holdings = new Map();
  const requests = new Map();
  const stockOuts = new Map();
  const transfers = [];
  let problems = 0; let lastSeq = 0;

  const holding = (itemId, placeId, e) => {
    const k = key(itemId, placeId);
    let h = holdings.get(k);
    if (!h) { h = { itemId, placeId, level: null, batches: new Map(), firstAt: e.at, since: ms(e.at), zero: [], use: [], lastSeq: 0 }; holdings.set(k, h); }
    return h;
  };
  // Before a holding changes at time t: note any time since its last change with nothing usable.
  const touch = (h, e) => {
    const t = ms(e.at);
    const from = zeroFrom(h, offsetMinutes);
    if (from < t) h.zero.push([from, t]);
    h.since = Math.max(h.since, t);
    if (e.seq > h.lastSeq) h.lastSeq = e.seq;
  };
  const entry = (h, line) => {
    let b = h.batches.get(bkey(line));
    if (!b) { b = { batch: line.batch || null, expiresOn: null, qty: 0, held: 0 }; h.batches.set(bkey(line), b); }
    if (!b.expiresOn && validDate(line.expiresOn)) b.expiresOn = line.expiresOn;
    return b;
  };
  const okLine = (line, min = 1) => {
    const it = line && typeof line === 'object' ? all.get(line.itemId) : null;
    const ok = it && whole(line.qty, min) && (it.batched ? typeof line.batch === 'string' && BATCH.test(line.batch) : line.batch == null);
    if (!ok) problems += 1;
    return ok;
  };
  const lines = (d, min) => (Array.isArray(d?.lines) ? d.lines.slice(0, MAX_LINES).filter((l) => okLine(l, min)) : []);
  const add = (placeId, line, e) => { const h = holding(line.itemId, placeId, e); touch(h, e); entry(h, line).qty += line.qty; };
  const take = (placeId, line, e, { fromHold = false, used = false } = {}) => {
    const h = holding(line.itemId, placeId, e); touch(h, e);
    const b = entry(h, line);
    const have = fromHold ? b.held : b.qty - b.held;
    const n = Math.min(have, line.qty);
    if (n < line.qty) problems += 1;
    b.qty -= n; if (fromHold) b.held -= n;
    if (used && n) h.use.push({ at: ms(e.at), qty: n });
  };

  for (const e of events) {
    if (typeof e.type !== 'string' || !e.type.startsWith('stock.')) continue;
    if (e.seq > lastSeq) lastSeq = e.seq;
    const d = e.data || {};
    switch (e.type) {
      case 'stock.item-added': {
        // The name is kept under `label`: an import refuses any event field called name (rule 1).
        const { label, ...rest } = d;
        const it = { ...rest, name: label, id: e.subject };
        if (all.has(it.id) || !SITE_ITEM_ID.test(it.id) || itemProblem(it, categories)) { problems += 1; break; }
        all.set(it.id, cleanItem(it, { module: null, siteAdded: true }));
        break;
      }
      case 'stock.level-set': {
        if (!all.has(d.itemId) || !whole(d.level)) { problems += 1; break; }
        const h = holding(d.itemId, e.subject, e); touch(h, e);
        h.level = d.level || null;
        break;
      }
      case 'stock.received': for (const l of lines(d)) add(e.subject, l, e); break;
      case 'stock.used': for (const l of lines(d)) take(e.subject, l, e, { used: true }); break;
      case 'stock.written-off': for (const l of lines(d)) take(e.subject, l, e, { fromHold: d.fromHold === true }); break;
      case 'stock.quarantined':
      case 'stock.released': {
        for (const l of lines(d)) {
          const h = holding(l.itemId, e.subject, e); touch(h, e);
          const b = entry(h, l);
          const n = Math.min(e.type === 'stock.quarantined' ? b.qty - b.held : b.held, l.qty);
          if (n < l.qty) problems += 1;
          b.held += e.type === 'stock.quarantined' ? n : -n;
        }
        break;
      }
      case 'stock.counted': {
        // A count sets what is there and usable for the lines counted; stock on hold is left as it is.
        for (const l of lines(d, 0)) {
          const h = holding(l.itemId, e.subject, e); touch(h, e);
          const b = entry(h, l);
          const before = b.qty - b.held;
          if (l.qty < before) h.use.push({ at: ms(e.at), qty: before - l.qty, fromCount: true });
          b.qty = l.qty + b.held;
        }
        break;
      }
      case 'stock.transferred': {
        const ls = lines(d);
        for (const l of ls) { const from = holdings.get(key(l.itemId, d.fromPlaceId)); const exp = from?.batches.get(bkey(l))?.expiresOn; take(d.fromPlaceId, l, e); add(d.toPlaceId, exp ? { ...l, expiresOn: exp } : l, e); }
        transfers.push({ id: e.subject, at: e.at, byRole: e.actorRole, fromPlaceId: d.fromPlaceId, toPlaceId: d.toPlaceId, lines: ls.map((l) => ({ ...l })), ref: d.ref ?? null });
        break;
      }
      case 'stock.requested': {
        if (requests.has(e.subject) || typeof d.placeId !== 'string' || typeof d.fromPlaceId !== 'string') { problems += 1; break; }
        const ls = (Array.isArray(d.lines) ? d.lines.slice(0, MAX_LINES) : []).filter((l) => all.has(l?.itemId) && whole(l.qty, 1));
        if (!ls.length) { problems += 1; break; }
        requests.set(e.subject, { id: e.subject, placeId: d.placeId, fromPlaceId: d.fromPlaceId, at: e.at, byRole: e.actorRole, raisedBy: d.raisedBy === 'count' ? 'count' : 'request',
          lines: ls.map((l) => ({ itemId: l.itemId, qty: l.qty, issued: 0 })), state: 'open', issuedAt: null, cancelledAt: null, cancelReason: null, lastSeq: e.seq ?? 0 });
        break;
      }
      case 'stock.issued': {
        const q = requests.get(e.subject);
        if (!q || q.state === 'issued' || q.state === 'cancelled') { problems += 1; break; }
        for (const l of lines(d)) {
          const want = q.lines.find((x) => x.itemId === l.itemId);
          if (!want || want.issued + l.qty > want.qty) { problems += 1; continue; }
          const exp = holdings.get(key(l.itemId, q.fromPlaceId))?.batches.get(bkey(l))?.expiresOn;
          take(q.fromPlaceId, l, e); add(q.placeId, exp ? { ...l, expiresOn: exp } : l, e);
          want.issued += l.qty;
        }
        q.state = q.lines.every((x) => x.issued >= x.qty) ? 'issued' : q.lines.some((x) => x.issued > 0) ? 'part' : 'open';
        if (q.state === 'issued') q.issuedAt = e.at;
        if (e.seq > q.lastSeq) q.lastSeq = e.seq;
        break;
      }
      case 'stock.request-cancelled': {
        const q = requests.get(e.subject);
        if (!q || q.state === 'issued' || q.state === 'cancelled') { problems += 1; break; }
        q.state = 'cancelled'; q.cancelledAt = e.at; q.cancelReason = REQUEST_CANCEL_REASONS.includes(d.reason) ? d.reason : 'Other';
        break;
      }
      case 'stock.stock-out-started': {
        if (stockOuts.has(e.subject) || !all.has(d.itemId) || typeof d.placeId !== 'string') { problems += 1; break; }
        stockOuts.set(e.subject, { id: e.subject, itemId: d.itemId, placeId: d.placeId, cause: STOCK_OUT_CAUSES.includes(d.cause) ? d.cause : 'Other', startedAt: e.at, byRole: e.actorRole, endedAt: null, careAffected: null });
        break;
      }
      case 'stock.stock-out-ended': {
        const s = stockOuts.get(e.subject);
        if (!s || s.endedAt || e.at < s.startedAt) { problems += 1; break; }
        s.endedAt = e.at; s.careAffected = d.careAffected === true;
        break;
      }
      default: break;
    }
  }
  return { items: all, categories, holdings, requests, stockOuts, transfers, problems, lastSeq, offsetMinutes };
}

// From when a holding has nothing usable, given its balances as they stand: its last change if it
// is empty now, the end of its last batch's expiry day if every batch has a date, never otherwise.
function zeroFrom(h, offsetMinutes) {
  let last = h.since;
  for (const b of h.batches.values()) {
    if (b.qty - b.held <= 0) continue;
    if (!b.expiresOn) return Infinity;
    last = Math.max(last, expiryMs(b.expiresOn, offsetMinutes));
  }
  return last;
}

// ---- balances ----
// What a holding has at a time: usable (not on hold, not expired), on hold, and expired but still there.
export function balance(h, now, offsetMinutes = 0) {
  const t = typeof now === 'string' ? ms(now) : now;
  let usable = 0; let onHold = 0; let expired = 0;
  for (const b of h?.batches.values() ?? []) {
    onHold += b.held;
    if (b.expiresOn && expiryMs(b.expiresOn, offsetMinutes) <= t) expired += b.qty - b.held; else usable += b.qty - b.held;
  }
  return { usable, onHold, expired };
}
export const holdingOf = (stock, itemId, placeId) => stock.holdings.get(key(itemId, placeId)) || null;
export const usableOf = (stock, itemId, placeId, now) => balance(holdingOf(stock, itemId, placeId), now, stock.offsetMinutes).usable;
// One batch's balances at a place: { usable, onHold, expired (true or false), expiresOn }.
export function batchBalance(stock, placeId, line, now) {
  const b = holdingOf(stock, line.itemId, placeId)?.batches.get(bkey(line));
  if (!b) return { usable: 0, onHold: 0, expired: false, expiresOn: null };
  const expired = !!b.expiresOn && expiryMs(b.expiresOn, stock.offsetMinutes) <= (typeof now === 'string' ? ms(now) : now);
  return { usable: b.qty - b.held, onHold: b.held, expired, expiresOn: b.expiresOn };
}
export function batchList(h, now, offsetMinutes = 0) {
  const t = typeof now === 'string' ? ms(now) : now;
  return [...(h?.batches.values() ?? [])].filter((b) => b.qty > 0).map((b) => {
    const end = b.expiresOn ? expiryMs(b.expiresOn, offsetMinutes) : null;
    return { batch: b.batch, expiresOn: b.expiresOn, qty: b.qty - b.held, onHold: b.held, expired: end != null && end <= t, daysToExpiry: end == null ? null : Math.floor((end - t) / DAY) };
  }).sort((a, b) => (a.expiresOn || '9999') < (b.expiresOn || '9999') ? -1 : 1);
}
// Batches with usable stock that pass their date within `days` (an example setting, not a standard).
export const nearExpiry = (h, now, days = NEAR_EXPIRY_DAYS, offsetMinutes = 0) => batchList(h, now, offsetMinutes).filter((b) => !b.expired && b.qty > 0 && b.daysToExpiry != null && b.daysToExpiry < days);

// Usable stock divided by average daily use over the last `days` (use recorded, or the drop a
// count found). null when nothing was used: no rate, no guess.
export function daysOfStockLeft(h, now, { days = USE_PERIOD_DAYS, offsetMinutes = 0 } = {}) {
  const t = typeof now === 'string' ? ms(now) : now;
  const used = (h?.use ?? []).filter((u) => u.at > t - days * DAY && u.at <= t).reduce((s, u) => s + u.qty, 0);
  if (!used) return null;
  return Math.round((10 * balance(h, t, offsetMinutes).usable) / (used / days)) / 10;
}

// ---- time with nothing usable ----
const merge = (list) => {
  const out = [];
  for (const [a, b] of [...list].sort((x, y) => x[0] - y[0])) {
    if (out.length && a <= out.at(-1)[1]) out.at(-1)[1] = Math.max(out.at(-1)[1], b); else out.push([a, b]);
  }
  return out;
};
const clip = (list, from, to) => list.map(([a, b]) => [Math.max(a, from), Math.min(b, to)]).filter(([a, b]) => b > a);
const span = (list) => list.reduce((s, [a, b]) => s + (b - a), 0);
// Times a holding had nothing usable up to `until`, worked out from its balances: [[fromMs, toMs]].
export function zeroIntervals(h, until, offsetMinutes = 0) {
  const from = zeroFrom(h, offsetMinutes);
  return merge(from < until ? [...h.zero, [from, until]] : h.zero);
}
// Stock-out rate (KPI dictionary D-17): item-days with no usable stock divided by item-days, for
// the holdings `pick` keeps. An item-day out is counted when a person declared a stock-out or the
// balances show nothing usable; the two are joined, never counted twice. A holding counts from
// its first event (a level set or a movement), so a place that never held an item adds nothing.
export function stockOutRate(stock, { since, until, pick = () => true }) {
  const [from, to] = [ms(since), ms(until)];
  let out = 0; let total = 0; let declared = 0; let derived = 0; let holdings = 0;
  for (const h of stock.holdings.values()) {
    const item = stock.items.get(h.itemId);
    if (!item || !pick(item, h)) continue;
    const start = Math.max(from, ms(h.firstAt));
    if (start >= to) continue;
    holdings += 1; total += to - start;
    const said = clip([...stock.stockOuts.values()].filter((s) => s.itemId === h.itemId && s.placeId === h.placeId).map((s) => [ms(s.startedAt), s.endedAt ? ms(s.endedAt) : to]), start, to);
    const seen = clip(zeroIntervals(h, to, stock.offsetMinutes), start, to);
    declared += span(merge(said)); derived += span(seen); out += span(merge([...said, ...seen]));
  }
  const d = (x) => Math.round((100 * x) / DAY) / 100;
  return { value: total ? (100 * out) / total : null, numerator: d(out), denominator: d(total), holdings, declaredDays: d(declared), derivedDays: d(derived) };
}
// Tracer items available now: tracer holdings with a top-up level that have usable stock, out of all such holdings.
export function tracerAvailability(stock, { now, pick = () => true }) {
  const list = [...stock.holdings.values()].filter((h) => { const it = stock.items.get(h.itemId); return it?.tracer && h.level && pick(it, h); });
  const have = list.filter((h) => balance(h, now, stock.offsetMinutes).usable > 0).length;
  return { value: list.length ? (100 * have) / list.length : null, numerator: have, denominator: list.length };
}

// ---- requests ----
const inPeriod = (at, since, until) => at != null && at < until && (since == null || at >= since);
// Fill rate: request lines issued in full divided by request lines raised, for requests raised in
// the period. Cancelled requests are left out and counted apart.
export function fillRate(stock, { since, until, pick = () => true }) {
  const list = [...stock.requests.values()].filter((q) => inPeriod(q.at, since, until) && pick(q));
  const live = list.filter((q) => q.state !== 'cancelled');
  const lines = live.flatMap((q) => q.lines);
  const full = lines.filter((l) => l.issued >= l.qty).length;
  return { value: lines.length ? (100 * full) / lines.length : null, numerator: full, denominator: lines.length, requests: live.length, cancelled: list.length - live.length };
}
// Request wait: raised to issued in full, median hours, for requests completed in the period.
// Requests still open are shown beside it, never dropped: how many, and the longest wait so far.
export function requestWait(stock, { since, until, pick = () => true }) {
  const all = [...stock.requests.values()].filter(pick);
  const done = all.filter((q) => q.state === 'issued' && inPeriod(q.issuedAt, since, until)).map((q) => (ms(q.issuedAt) - ms(q.at)) / 36e5).sort((a, b) => a - b);
  const m = Math.floor(done.length / 2);
  const open = all.filter((q) => (q.state === 'open' || q.state === 'part') && q.at < until);
  return { value: done.length ? (done.length % 2 ? done[m] : (done[m - 1] + done[m]) / 2) : null, n: done.length, numerator: null, denominator: done.length,
    open: open.length, longestOpenHours: open.length ? Math.max(...open.map((q) => (ms(until) - ms(q.at)) / 36e5)) : null };
}
export const openRequestFor = (stock, itemId, placeId) => [...stock.requests.values()].find((q) => (q.state === 'open' || q.state === 'part') && q.placeId === placeId && q.lines.some((l) => l.itemId === itemId && l.issued < l.qty)) || null;
export const openStockOut = (stock, itemId, placeId) => [...stock.stockOuts.values()].find((s) => !s.endedAt && s.itemId === itemId && s.placeId === placeId) || null;

// ---- doses and vials (for an item whose unit is "vial"). Counting only: never a dose for a person. ----
export const toDoses = (item, vials) => (item?.dosesPerVial ? vials * item.dosesPerVial : null);
export const toVials = (item, doses) => (item?.dosesPerVial ? Math.ceil(doses / item.dosesPerVial) : null);

// ---- ids, allocated inside core.appendChecked so two devices' taps cannot share one ----
function nextId(events, type, prefix, pattern) {
  let max = 0;
  for (const e of events) { const m = e.type === type ? pattern.exec(e.subject) : null; if (m) max = Math.max(max, Number(m[1])); }
  return `${prefix}-${String(max + 1).padStart(5, '0')}`;
}
export const nextRequestId = (events) => nextId(events, 'stock.requested', 'req', /^req-(\d{5,})$/);
export const nextTransferId = (events) => nextId(events, 'stock.transferred', 'trf', /^trf-(\d{5,})$/);
export const nextStockOutId = (events) => nextId(events, 'stock.stock-out-started', 'so', /^so-(\d{5,})$/);
export const nextItemId = (events) => nextId(events, 'stock.item-added', 'item', SITE_ITEM_ID);
