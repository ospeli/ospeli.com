// Commands for the shared stock item (core/stock.js). One set for every module that holds things
// at places: a module adds its categories and example items as configuration and gets these
// commands, the audit entries and the agent rules without writing them again.
//
// People decide, Ospeli suggests: an agent may read stock; anything it asks to change waits as a
// proposal for a person, and is checked again when the person accepts. Releasing held stock,
// setting a fill-to level and adding an item are for people only.
// Operations only: no dose for a person, no decision that stock is fit to use, no purchase
// approval, no price. The only typed text is the name and unit of an item a site adds, and it is
// checked for personal details.

import {
  CommandError, ALL_ROLES, ID, TIME, SYNTHETIC, LIMIT, TOTAL, TRUNCATED, FORMAT, page, idsHint, WRITE_STATUS, PROPOSAL_OUT, EVENT_SEQS,
  NOT_A_NAME, checkTypedText, MIN, HOUR,
} from './kit.js';
import { roleById, currentWords } from './model.js';
import {
  STOCK_PLACE_TYPES, RECEIVE_SOURCES, WRITE_OFF_REASONS, HOLD_REASONS, STOCK_OUT_CAUSES, REQUEST_CANCEL_REASONS, REQUEST_STATES,
  MAX_QTY, MAX_LINES, ITEM_ID_PATTERN, BATCH_PATTERN, DATE_PATTERN, REQUEST_ID_PATTERN, TRANSFER_ID_PATTERN, STOCK_OUT_ID_PATTERN, NEAR_EXPIRY_DAYS, USE_PERIOD_DAYS,
  stockCatalogue, deriveStock, itemProblem, validDate, balance, holdingOf, usableOf, batchBalance, batchList, nearExpiry, daysOfStockLeft, zeroIntervals,
  openRequestFor, openStockOut, nextRequestId, nextTransferId, nextStockOutId, nextItemId,
} from './stock.js';

export const STOCK_EVENT_TYPES = ['item-added', 'level-set', 'received', 'requested', 'issued', 'request-cancelled', 'transferred', 'counted', 'used', 'written-off', 'quarantined', 'released', 'stock-out-started', 'stock-out-ended'].map((t) => `stock.${t}`);
const REPEAT = 2 * MIN; // the same movement again within this time is a double tap unless the caller says otherwise

const ITEM = { type: 'string', pattern: ITEM_ID_PATTERN, maxLength: 31 };
const QTY = (min) => ({ type: 'integer', minimum: min, maximum: MAX_QTY });
const BATCH = { type: 'string', pattern: BATCH_PATTERN, maxLength: 20 };
const DATE = { type: 'string', pattern: DATE_PATTERN, maxLength: 10 };
const lineSchema = (min, { batch = true, date = false } = {}) => ({
  type: 'object', additionalProperties: false, required: ['itemId', 'qty'],
  properties: {
    itemId: { ...ITEM, description: 'The item, by its id from ospeli_stock_items or ospeli_stock_levels, for example "gloves-m".' },
    qty: { ...QTY(min), description: `How many, as a whole number of the item's own unit (its "unit" in ospeli_stock_items or ospeli_stock_levels): 3 means 3 boxes of 50, not 3 gloves. From ${min} to ${MAX_QTY}.` },
    ...(batch ? { batch: { ...BATCH, description: 'The batch or lot printed on the pack, for example "LOT123". Needed for an item tracked by batch; leave it out for any other item.' } } : {}),
    ...(date ? { expiresOn: { ...DATE, description: 'The expiry date printed on the pack, as YYYY-MM-DD, for example "2027-06-30". Only for an item tracked by batch.' } } : {}),
  },
});
const LINES = (min, opts, what) => ({ type: 'array', minItems: 1, maxItems: MAX_LINES, items: lineSchema(min, opts),
  description: `${what} Each line is { itemId, qty${opts?.batch === false ? '' : ', batch'}${opts?.date ? ', expiresOn' : ''} }: qty is a whole number in the item's own unit${opts?.batch === false ? '' : '; batch (the product lot printed on the pack) is needed for a batched item and left out for any other'}${opts?.date ? '; expiresOn is the expiry date as YYYY-MM-DD' : ''}. ospeli_stock_items lists the items.` });
const PLACE = (what) => ({ ...ID, description: `${what} A ward, department or store id, for example ward-a1 (ospeli_stock_items lists the stores; ospeli_stock_levels shows what each place holds).` });
const AGAIN = { type: 'boolean', description: 'Send true only when the command said the same movement was saved a moment ago and this really is a second one.' };
const REF = { type: 'object', additionalProperties: false, required: ['module', 'id'], description: 'Optional: the record in another module this movement belongs to, as { module, id } (ids only, no text).',
  properties: { module: { type: 'string', pattern: '^[a-z][a-z0-9-]{1,30}$', maxLength: 31, description: 'The module the record belongs to, in lower case, for example "support" or "engineering".' },
    id: { ...ID, description: 'The record\'s id in that module, for example a task or work-order id. An id only, never a name or free text.' } } };
const REQUEST_ID = { type: 'string', pattern: REQUEST_ID_PATTERN, maxLength: 20, description: 'A request id from ospeli_stock_requests, for example req-00001.' };
const roleNames = (ids) => ids.map((r) => roleById(r)?.name || r).join(', ');
const cleanLine = (l, extra = {}) => ({ itemId: l.itemId, qty: l.qty, ...(l.batch ? { batch: l.batch } : {}), ...(extra.expiresOn || l.expiresOn ? { expiresOn: extra.expiresOn || l.expiresOn } : {}) });
const sameLines = (a, b) => JSON.stringify([...a].map((l) => [l.itemId, l.batch || '', l.qty]).sort()) === JSON.stringify([...(b || [])].map((l) => [l.itemId, l.batch || '', l.qty]).sort());

// The commands for one catalogue of stock categories and items. commands.js calls this once with
// the modules' packs; tests call it with their own. No category, no commands.
export function stockCommands(packs = []) {
  const { categories, items } = stockCatalogue(packs, ALL_ROLES);
  const catList = Object.values(categories);
  if (!catList.length) return [];
  // The item the examples use, and the roles of its category first: an example is run as the command's first role.
  const first = [...items.values()].find((it) => !it.batched) || [...items.values()][0] || { id: 'item-00001', category: catList[0].id };
  const union = (...verbs) => {
    const has = (c, r) => verbs.some((v) => c.roles[v].includes(r));
    const own = ALL_ROLES.filter((r) => has(categories[first.category], r));
    return [...own, ...ALL_ROLES.filter((r) => !own.includes(r) && catList.some((c) => has(c, r)))];
  };

  // ---- reading the record ----
  async function ctx(core, input, role, events) {
    const [evs, ents] = await Promise.all([events ?? core.events({ type: STOCK_EVENT_TYPES }), core.listEntities()]);
    const offsetMinutes = ents.find((e) => e.type === 'site' && e.utcOffsetMinutes != null)?.utcOffsetMinutes ?? 0;
    const places = new Map(ents.filter((e) => STOCK_PLACE_TYPES.includes(e.type)).map((e) => [e.id, e]));
    return { core, input, role, events: evs, places, now: core.now(), stock: deriveStock(evs, { items, categories, offsetMinutes }) };
  }
  const placeName = (c, id) => (c.places.has(id) ? currentWords(c.places.get(id).name) : id);
  const stores = (c) => [...c.places.values()].filter((p) => p.type === 'store').sort((a, b) => (a.id < b.id ? -1 : 1));
  // A ward-limited agent sees its own wards; stores and departments are not wards and stay visible.
  const visible = (c, wards) => (placeId) => !wards || c.places.get(placeId)?.type !== 'ward' || wards.has(placeId);
  // The wards a command names. Several keys (a transfer's two ends) give a list: the command layer checks each.
  const wardOf = (key) => async (core, input) => {
    const out = [];
    for (const k of [].concat(key)) { const p = input[k] ? await core.getEntity(input[k]) : null; if (p?.type === 'ward') out.push(p.id); }
    return Array.isArray(key) ? out : out[0] ?? null;
  };
  // A write that names a request or a stock-out is about the places that record names: the
  // place that asked and the place that supplies; the place that ran out.
  const wardOfRecord = (kind) => async (core, input) => {
    const c = await ctx(core, input, null);
    const r = kind === 'request' ? c.stock.requests.get(input.requestId) : c.stock.stockOuts.get(input.stockOutId);
    return r ? [r.placeId, r.fromPlaceId].filter((id) => c.places.get(id)?.type === 'ward') : [];
  };

  // ---- checks shared by a person's action, an agent's proposal and its acceptance ----
  function place(c, id, what) {
    const p = c.places.get(id);
    if (!p) throw new CommandError('not-found', `No place with that id for ${what}. Use a ward, department or store id, for example ward-a1${stores(c)[0] ? ` or ${stores(c)[0].id}` : ''}.`);
    return p;
  }
  function item(c, id) {
    const it = c.stock.items.get(id);
    if (!it) throw new CommandError('not-found', `No item with that id. Items here include: ${idsHint([...c.stock.items.values()])}. ospeli_stock_items lists them all.`);
    return it;
  }
  function allowed(c, it, verbs, doing) {
    const may = [...new Set([].concat(verbs).flatMap((v) => categories[it.category].roles[v]))];
    if (c.role && !may.includes(c.role)) throw new CommandError('forbidden', `${roleById(c.role)?.name || 'This role'} cannot ${doing} ${categories[it.category].name.toLowerCase()} stock. That is for: ${roleNames(may) || 'nobody on this site'}.`, { roles: may });
  }
  // Every line names a real item this role may act on, once, with a batch exactly when the item is batched.
  function checkLines(c, lines, verbs, doing) {
    if (!lines.length) throw new CommandError('invalid-input', 'Add at least one line, for example { "itemId": "' + first.id + '", "qty": 1 }.');
    const seen = new Set();
    return lines.map((l) => {
      const it = item(c, l.itemId);
      allowed(c, it, verbs, doing);
      if (it.batched && !l.batch) {
        throw new CommandError('invalid-input', `${it.name} is tracked by batch: add the batch (the lot printed on the pack) to its line, for example { "itemId": "${it.id}", "qty": ${l.qty}, "batch": "LOT123" }.`);
      }
      if (!it.batched && (l.batch || l.expiresOn)) throw new CommandError('invalid-input', `${it.name} is not tracked by batch: leave batch and expiresOn out of its line.`);
      if (l.expiresOn != null && !validDate(l.expiresOn)) throw new CommandError('invalid-input', 'expiresOn must be a real date as YYYY-MM-DD, for example 2027-06-30.');
      const k = `${l.itemId}|${l.batch || ''}`;
      if (seen.has(k)) throw new CommandError('invalid-input', `${it.name}${l.batch ? ` batch ${l.batch}` : ''} is listed twice. List each item${it.batched ? ' and batch' : ''} once.`);
      seen.add(k);
      return it;
    });
  }
  // Nothing leaves a place that is not there: "count first".
  function canTake(c, placeId, lines, { fromHold = false, allowExpired = false } = {}) {
    for (const l of lines) {
      const it = c.stock.items.get(l.itemId);
      const b = batchBalance(c.stock, placeId, l, c.now);
      const what = `${it.name}${l.batch ? ` batch ${l.batch}` : ''}`;
      if (!fromHold && b.expired && !allowExpired && b.usable > 0) throw new CommandError('conflict', `${what} passed its expiry date (${b.expiresOn}) and cannot be moved or used. Write it off (ospeli_stock_write_off).`, { itemId: l.itemId, expiresOn: b.expiresOn });
      const have = fromHold ? b.onHold : b.usable;
      if (have < l.qty) {
        throw new CommandError('conflict', `Only ${have} ${it.unit} of ${what} ${fromHold ? 'on hold' : 'usable'} at ${placeName(c, placeId)}, so ${l.qty} cannot be taken. If the shelf says otherwise, count the stock first (ospeli_stock_count).`, { itemId: l.itemId, have });
      }
    }
  }
  function notRepeat(c, type, same, word) {
    if (c.input.again === true) return;
    const t = Date.parse(c.now);
    for (let i = c.events.length - 1; i >= 0; i--) {
      const e = c.events[i];
      if (t - Date.parse(e.at) >= REPEAT) break;
      if (e.type === type && same(e)) throw new CommandError('conflict', `The same ${word} was saved a moment ago, so nothing new was saved. If this really is a second one, send it again with again: true.`, { confirm: 'again' });
    }
  }
  function waiting(c, id, expected) {
    const q = c.stock.requests.get(id);
    if (!q) throw new CommandError('not-found', 'No request with that id. ospeli_stock_requests lists the requests that are waiting.');
    if (q.state === 'issued' || q.state === 'cancelled') throw new CommandError('conflict', `This request is already ${REQUEST_STATES[q.state].toLowerCase()}.`, { state: q.state });
    if (expected && q.state !== expected) throw new CommandError('conflict', 'This request changed since you opened it. Read it again.', { state: q.state });
    return q;
  }
  const supplier = (c, placeId) => {
    const from = c.input.fromPlaceId ?? stores(c).find((s) => s.id !== placeId)?.id ?? null;
    if (c.input.fromPlaceId) { place(c, from, 'fromPlaceId'); if (from === placeId) throw new CommandError('invalid-input', 'The place that supplies must be different from the place that asks.'); }
    return from;
  };

  const WRITE_OUT = (props = {}) => ({ type: 'object', required: ['status'], properties: { status: WRITE_STATUS, events: EVENT_SEQS, proposal: PROPOSAL_OUT, ...props } });
  // One write: verify (for a person, a proposal, a dry run and an acceptance), then one checked
  // append and one audit entry holding ids and picks only.
  function write({ name, summary, verbs, people = false, props, required, out = {}, target, ward = 'placeId', check, verify, make, snapshot, example }) {
    return {
      name, summary, kind: 'write', approval: true, ...(people ? { agents: false } : {}), roles: union(...verbs),
      input: { type: 'object', additionalProperties: false, required, properties: props },
      output: WRITE_OUT(out), ...(target ? { target } : {}), ...(check ? { check } : {}), ...(snapshot ? { snapshot } : {}), wardOf: ward === 'request' || ward === 'stockOut' ? wardOfRecord(ward) : wardOf(ward),
      async precheck(core, input, { actor } = {}) { await verify(await ctx(core, input, actor?.role)); },
      async run(core, input, { actor }) {
        if (check) check(input);
        let res = null;
        const recs = await core.appendChecked(async (evs) => {
          const c = await ctx(core, input, actor.role, evs);
          res = make(c, await verify(c), evs);
          return res.events.map((e) => ({ ...e, actorRole: actor.role, at: c.now }));
        });
        await core.recordAs(actor, ...res.audit);
        return { status: 'done', ...res.out, events: recs.map((r) => r.seq) };
      },
      example,
    };
  }
  // A movement at one place: receive, use, write off, hold, release.
  function movement({ name, summary, verb, type, word, people, extra = {}, required = [], take = null, date = false, linesWhat, data = () => ({}), example }) {
    return write({
      name, summary, verbs: [verb], people, required: ['placeId', 'lines', ...required],
      props: { placeId: PLACE(`Where the stock is.`), lines: LINES(1, { date }, linesWhat), ...extra, again: AGAIN },
      out: { placeId: ID, lines: { type: 'integer', description: 'How many lines were saved.' } },
      target: (input) => ({ id: input.placeId, word: 'place' }),
      verify(c) {
        place(c, c.input.placeId, 'placeId');
        checkLines(c, c.input.lines, verb, word);
        if (take) canTake(c, c.input.placeId, c.input.lines, typeof take === 'function' ? take(c.input) : take);
        if (date) {
          for (const l of c.input.lines) {
            const have = batchBalance(c.stock, c.input.placeId, l, c.now);
            if (l.expiresOn && have.expiresOn && have.expiresOn !== l.expiresOn) throw new CommandError('conflict', `Batch ${l.batch} is already here with expiry date ${have.expiresOn}. Check the pack: one batch has one date.`, { expiresOn: have.expiresOn });
          }
        }
        notRepeat(c, type, (e) => e.subject === c.input.placeId && sameLines(e.data?.lines, c.input.lines), word.replace(/ .*/, '') === 'receive' ? 'receipt' : 'entry');
      },
      make(c) {
        const lines = c.input.lines.map((l) => cleanLine(l, take ? { expiresOn: batchBalance(c.stock, c.input.placeId, l, c.now).expiresOn } : {}));
        return { events: [{ type, subject: c.input.placeId, data: { lines, ...data(c.input) } }], out: { placeId: c.input.placeId, lines: lines.length },
          audit: [type, c.input.placeId, { lines: lines.length, items: lines.slice(0, 10).map((l) => l.itemId), ...data(c.input) }] };
      },
      example,
    });
  }

  const NEED_ITEM = `Stock of the item at the place. ${first.id} at ward-a1 is an example: ospeli_stock_levels with { "placeId": "ward-a1" } shows what is there, and ospeli_stock_receive or ospeli_stock_count puts stock in place.`;
  const levelRow = (c, h, short) => {
    const it = c.stock.items.get(h.itemId);
    const b = balance(h, c.now, c.stock.offsetMinutes);
    const open = openRequestFor(c.stock, h.itemId, h.placeId);
    const base = { itemId: it.id, itemName: it.name, unit: it.unit, category: it.category, tracer: it.tracer, placeId: h.placeId, placeName: placeName(c, h.placeId),
      usable: b.usable, onHold: b.onHold, expired: b.expired, level: h.level, shortBy: h.level ? Math.max(0, h.level - b.usable) : 0, underLevel: !!h.level && b.usable < h.level,
      openRequestId: open?.id ?? null };
    if (short) return base;
    const zero = b.usable === 0 ? zeroIntervals(h, Date.parse(c.now), c.stock.offsetMinutes).at(-1) : null;
    return { ...base, coldChain: it.coldChain, batched: it.batched, batches: it.batched ? batchList(h, c.now, c.stock.offsetMinutes) : [],
      nearExpiry: nearExpiry(h, c.now, NEAR_EXPIRY_DAYS, c.stock.offsetMinutes).length, daysLeft: daysOfStockLeft(h, c.now, { offsetMinutes: c.stock.offsetMinutes }),
      nothingUsableSince: zero ? new Date(zero[0]).toISOString() : null, openStockOutId: openStockOut(c.stock, h.itemId, h.placeId)?.id ?? null };
  };
  // `see` is the reader's view of places (an agent's wards). What the supplier holds is the
  // supplier's stock: an agent that may not see that ward is not told it (18 Nov).
  const requestRow = (c, q, see = () => true) => ({
    id: q.id, placeId: q.placeId, placeName: placeName(c, q.placeId), fromPlaceId: q.fromPlaceId, fromPlaceName: placeName(c, q.fromPlaceId),
    state: q.state, stateName: REQUEST_STATES[q.state], raisedAt: q.at, raisedByRole: q.byRole, raisedBy: q.raisedBy, issuedAt: q.issuedAt, cancelledAt: q.cancelledAt, cancelReason: q.cancelReason,
    waitHours: Math.round(((Date.parse(q.issuedAt || q.cancelledAt || c.now) - Date.parse(q.at)) / HOUR) * 10) / 10,
    lines: q.lines.map((l) => { const it = c.stock.items.get(l.itemId); return { itemId: l.itemId, itemName: it.name, unit: it.unit, batched: it.batched, qty: l.qty, issued: l.issued, left: l.qty - l.issued, usableAtSupplier: see(q.fromPlaceId) ? usableOf(c.stock, l.itemId, q.fromPlaceId, c.now) : null }; }),
    canIssueInFull: !see(q.fromPlaceId) ? null : q.lines.every((l) => l.issued >= l.qty || (!c.stock.items.get(l.itemId).batched && usableOf(c.stock, l.itemId, q.fromPlaceId, c.now) >= l.qty - l.issued)),
  });
  const CATEGORY = { type: 'string', enum: catList.map((x) => x.id), description: `Only items of this category: ${catList.map((x) => x.id).join(', ')}. Leave out for every category.` };
  const COLD = { type: 'boolean', description: 'true: only cold-chain items. false: leave cold-chain items out. Leave out for both.' };
  const keep = (input) => (it) => (!input.category || it.category === input.category) && (input.coldChain == null || it.coldChain === input.coldChain);

  const list = [
    // ---------------------------------------------------------------- reads
    {
      name: 'ospeli_stock_items',
      summary: 'The items this site keeps stock of (name, unit, category, whether it is a critical item and whether it is tracked by batch), the stores, the reasons to pick from and which roles may do what. Use the ids with the other ospeli_stock_ commands. No prices, brands or suppliers are kept. Read-only.',
      kind: 'read', roles: ALL_ROLES, approval: false, freeText: true,
      input: { type: 'object', additionalProperties: false, properties: { category: CATEGORY, coldChain: COLD, limit: LIMIT(100, 500, 'items') } },
      output: { type: 'object', required: ['synthetic', 'items', 'categories', 'stores', 'picks', 'total', 'truncated'], properties: {
        synthetic: SYNTHETIC, total: TOTAL, truncated: TRUNCATED,
        items: { type: 'array', items: { type: 'object', required: ['id', 'name', 'unit', 'category', 'tracer', 'batched'] } },
        categories: { type: 'array', description: 'Each category with the roles that may count, request, issue, receive, transfer, use, write off, hold, release, set levels and add items.' },
        stores: { type: 'array', description: 'The stores (places that supply others), with ids.' },
        picks: { type: 'object', description: 'The reasons and sources to pick from: receiveSources, writeOffReasons, holdReasons, stockOutCauses, requestCancelReasons.' },
        settings: { type: 'object', description: 'Example settings, not standards: days counted as near expiry, and the days of use behind "days of stock left".' } } },
      async run(core, input) {
        const c = await ctx(core, input, null);
        const cut = page([...c.stock.items.values()].filter(keep(input)), input.limit, 100);
        return {
          synthetic: (await core.getMeta('synthetic', false)) === true, total: cut.total, truncated: cut.truncated,
          items: cut.items.map(({ module, ...it }) => it),
          categories: catList.map((x) => ({ id: x.id, name: x.name, roles: { ...x.roles } })),
          stores: stores(c).map((s) => ({ id: s.id, name: currentWords(s.name) })),
          picks: { receiveSources: [...RECEIVE_SOURCES], writeOffReasons: [...WRITE_OFF_REASONS], holdReasons: [...HOLD_REASONS], stockOutCauses: [...STOCK_OUT_CAUSES], requestCancelReasons: [...REQUEST_CANCEL_REASONS] },
          settings: { nearExpiryDays: NEAR_EXPIRY_DAYS, usePeriodDays: USE_PERIOD_DAYS, note: 'Example settings, not standards.' },
        };
      },
      example: { input: {} },
    },
    {
      name: 'ospeli_stock_levels',
      summary: 'What each place holds now: for every item its usable stock, stock on hold, expired stock still on the shelf, its fill-to level and how far under it is, any open request, and (detailed) batches with expiry dates and days of stock left. Items under their level come first. Pass placeId for one ward or store. "asOfSeq" is what a count sends back as seenSeq. Read-only.',
      kind: 'read', roles: ALL_ROLES, approval: false, freeText: true,
      input: { type: 'object', additionalProperties: false, properties: {
        placeId: PLACE('Only this place.'), itemId: { ...ITEM, description: 'Only this item, for example to see every place that holds it.' }, category: CATEGORY, coldChain: COLD,
        underLevelOnly: { type: 'boolean', description: 'true: only items under their fill-to level. Default false.' },
        format: FORMAT('balances and levels', 'batches, near-expiry count and days of stock left too'), limit: LIMIT(100, 500, 'lines') } },
      output: { type: 'object', required: ['asOf', 'asOfSeq', 'synthetic', 'levels', 'total', 'truncated'], properties: {
        asOf: TIME, asOfSeq: { type: 'integer', description: 'The newest stock event behind this answer. Send it as seenSeq with a count.' }, synthetic: SYNTHETIC, total: TOTAL, truncated: TRUNCATED,
        levels: { type: 'array', items: { type: 'object', required: ['itemId', 'itemName', 'unit', 'placeId', 'usable', 'onHold', 'expired', 'level', 'shortBy', 'underLevel'] } },
        note: { type: 'string' } } },
      wardOf: wardOf('placeId'),
      async run(core, input, { wards } = {}) {
        const c = await ctx(core, input, null);
        if (input.placeId) place(c, input.placeId, 'placeId');
        if (input.itemId) item(c, input.itemId);
        const see = visible(c, wards); const pick = keep(input);
        const rows = [...c.stock.holdings.values()]
          .filter((h) => see(h.placeId) && (!input.placeId || h.placeId === input.placeId) && (!input.itemId || h.itemId === input.itemId) && pick(c.stock.items.get(h.itemId)))
          .map((h) => levelRow(c, h, input.format === 'short')).filter((r) => !input.underLevelOnly || r.underLevel)
          .sort((a, b) => (b.underLevel - a.underLevel) || (a.placeName < b.placeName ? -1 : a.placeName > b.placeName ? 1 : a.itemName < b.itemName ? -1 : 1));
        const cut = page(rows, input.limit, 100);
        return { asOf: c.now, asOfSeq: c.stock.lastSeq, synthetic: (await core.getMeta('synthetic', false)) === true, total: cut.total, truncated: cut.truncated, levels: cut.items,
          note: `Usable leaves out stock on hold and stock past its expiry date. Near expiry means within ${NEAR_EXPIRY_DAYS} days and days of stock left uses the last ${USE_PERIOD_DAYS} days of use: example settings, not standards.` };
      },
      example: { input: { placeId: 'ward-a1', format: 'short' } },
    },
    {
      name: 'ospeli_stock_requests',
      summary: 'Requests for stock: who asked, which place supplies, each line with what was asked, what has been issued and what the supplier has usable now, and how long the request has waited. Waiting requests come oldest first. A request raised by a count says so. Read-only.',
      kind: 'read', roles: ALL_ROLES, approval: false, freeText: true,
      input: { type: 'object', additionalProperties: false, properties: {
        placeId: PLACE('Only requests this place asked for.'), fromPlaceId: PLACE('Only requests this place supplies.'),
        state: { type: 'string', enum: ['waiting', 'issued', 'cancelled', 'all'], description: 'waiting (default) means not yet issued in full: open or part issued.' },
        limit: LIMIT(50, 200, 'requests') } },
      output: { type: 'object', required: ['asOf', 'synthetic', 'requests', 'total', 'truncated'], properties: {
        asOf: TIME, synthetic: SYNTHETIC, total: TOTAL, truncated: TRUNCATED,
        requests: { type: 'array', items: { type: 'object', required: ['id', 'placeId', 'fromPlaceId', 'state', 'raisedAt', 'waitHours', 'lines', 'canIssueInFull'] } } } },
      wardOf: wardOf('placeId'),
      async run(core, input, { wards } = {}) {
        const c = await ctx(core, input, null);
        for (const k of ['placeId', 'fromPlaceId']) if (input[k]) place(c, input[k], k);
        const see = visible(c, wards); const state = input.state || 'waiting';
        const rows = [...c.stock.requests.values()].filter((q) => see(q.placeId) && (!input.placeId || q.placeId === input.placeId) && (!input.fromPlaceId || q.fromPlaceId === input.fromPlaceId)
          && (state === 'all' || (state === 'waiting' ? q.state === 'open' || q.state === 'part' : q.state === state)));
        rows.sort((a, b) => (a.at < b.at ? -1 : 1));
        if (state !== 'waiting') rows.reverse();
        const cut = page(rows, input.limit, 50);
        return { asOf: c.now, synthetic: (await core.getMeta('synthetic', false)) === true, total: cut.total, truncated: cut.truncated, requests: cut.items.map((q) => requestRow(c, q, see)) };
      },
      example: { input: {} },
    },
    {
      name: 'ospeli_stock_outs',
      summary: 'The stock-out log: each stock-out a person declared, with the item, the place, when it started and ended, how long it lasted, its cause and whether care was affected (yes or no, nothing clinical). Also "notDeclared": items with a fill-to level that have nothing usable now and no open stock-out, as a fact for a person to look at. Read-only.',
      kind: 'read', roles: ALL_ROLES, approval: false, freeText: true,
      input: { type: 'object', additionalProperties: false, properties: {
        placeId: PLACE('Only this place.'), itemId: { ...ITEM, description: 'Only this item, across every place.' }, category: CATEGORY,
        state: { type: 'string', enum: ['open', 'ended', 'all'], description: 'open: still out. ended: over. all (default): both, newest first.' },
        limit: LIMIT(50, 200, 'stock-outs') } },
      output: { type: 'object', required: ['asOf', 'synthetic', 'stockOuts', 'notDeclared', 'total', 'truncated'], properties: {
        asOf: TIME, synthetic: SYNTHETIC, total: TOTAL, truncated: TRUNCATED,
        stockOuts: { type: 'array', items: { type: 'object', required: ['id', 'itemId', 'placeId', 'cause', 'startedAt', 'open', 'hours'] } },
        notDeclared: { type: 'array', description: 'Up to 50 items with a level, nothing usable and no open stock-out: { itemId, itemName, placeId, placeName, since }.' } } },
      wardOf: wardOf('placeId'),
      async run(core, input, { wards } = {}) {
        const c = await ctx(core, input, null);
        if (input.placeId) place(c, input.placeId, 'placeId');
        if (input.itemId) item(c, input.itemId);
        const see = visible(c, wards); const pick = keep(input);
        const mine = (x) => see(x.placeId) && (!input.placeId || x.placeId === input.placeId) && (!input.itemId || x.itemId === input.itemId) && pick(c.stock.items.get(x.itemId));
        const rows = [...c.stock.stockOuts.values()].filter((s) => mine(s) && (!input.state || input.state === 'all' || (input.state === 'open') === !s.endedAt)).sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
        const cut = page(rows, input.limit, 50);
        const notDeclared = [...c.stock.holdings.values()].filter((h) => mine(h) && h.level && balance(h, c.now, c.stock.offsetMinutes).usable === 0 && !openStockOut(c.stock, h.itemId, h.placeId)).slice(0, 50)
          .map((h) => ({ itemId: h.itemId, itemName: c.stock.items.get(h.itemId).name, placeId: h.placeId, placeName: placeName(c, h.placeId), since: new Date(zeroIntervals(h, Date.parse(c.now), c.stock.offsetMinutes).at(-1)?.[0] ?? Date.parse(c.now)).toISOString() }));
        return { asOf: c.now, synthetic: (await core.getMeta('synthetic', false)) === true, total: cut.total, truncated: cut.truncated, notDeclared,
          stockOuts: cut.items.map((s) => ({ id: s.id, itemId: s.itemId, itemName: c.stock.items.get(s.itemId).name, placeId: s.placeId, placeName: placeName(c, s.placeId), cause: s.cause, startedAt: s.startedAt, endedAt: s.endedAt,
            open: !s.endedAt, hours: Math.round(((Date.parse(s.endedAt || c.now) - Date.parse(s.startedAt)) / HOUR) * 10) / 10, careAffected: s.careAffected })) };
      },
      example: { input: {} },
    },

    // ---------------------------------------------------------------- count, request, issue
    write({
      name: 'ospeli_stock_count',
      summary: 'Record a count of stock at a place: for each line, how many are there and usable now (stock on hold is not counted). Only the lines counted change. Every counted item that is then under its fill-to level, with no request already open, goes on one new request to the store in the same step, for exactly what is short. An agent\'s call becomes a proposal for a person.',
      verbs: ['count'], required: ['placeId', 'lines'],
      props: {
        placeId: PLACE('The place counted.'), lines: LINES(0, { date: true }, 'What was counted: the number there now, 0 when there is none.'),
        seenSeq: { type: 'integer', minimum: 0, description: 'The asOfSeq from the ospeli_stock_levels answer the count was made against. If stock for a counted item moved since (a delivery, an issue), the count is refused so it cannot overwrite it.' },
        raiseRequest: { type: 'boolean', description: 'false: only record the count, raise no request. Default true.' },
        fromPlaceId: PLACE('Where a raised request is sent. Leave out for the site\'s first store.'),
      },
      out: { placeId: ID, counted: { type: 'integer' }, underLevel: { type: 'array', description: 'Counted items now under their level: { itemId, level, usable, shortBy }.' },
        requestId: { type: ['string', 'null'], description: 'The request raised for what is short, or null when none was needed or possible.' }, requested: { type: 'array' }, requestNote: { type: ['string', 'null'] } },
      target: (input) => ({ id: input.placeId, word: 'place' }),
      // An agent's count is kept with the stock as the agent saw it, and is checked against it when a
      // person accepts (#128 point 2): a delivery saved in between makes the count out of date, so it
      // cannot set the balance back.
      // The number is never taken above the newest stock event there is: an agent that sent a number
      // from the future would switch the check off (19 Nov).
      async snapshot(core, input) { const last = (await ctx(core, input)).stock.lastSeq; return { seenSeq: Math.min(input.seenSeq ?? last, last) }; },
      verify(c) {
        const { input } = c;
        place(c, input.placeId, 'placeId');
        const its = checkLines(c, input.lines, 'count', 'count');
        if (input.seenSeq != null) {
          const moved = its.filter((it) => (holdingOf(c.stock, it.id, input.placeId)?.lastSeq ?? 0) > input.seenSeq);
          if (moved.length) throw new CommandError('conflict', `Stock moved here since this count was opened (${[...new Set(moved.map((it) => it.name))].slice(0, 5).join(', ')}): a delivery, an issue or another count was saved. Read the levels again and recount those items.`, { changed: [...new Set(moved.map((it) => it.id))] });
        }
        for (const l of input.lines) {
          const have = batchBalance(c.stock, input.placeId, l, c.now);
          if (l.expiresOn && have.expiresOn && have.expiresOn !== l.expiresOn) throw new CommandError('conflict', `Batch ${l.batch} is already here with expiry date ${have.expiresOn}. Check the pack: one batch has one date.`, { expiresOn: have.expiresOn });
        }
        const from = input.raiseRequest === false ? null : supplier(c, input.placeId);
        // What each counted item has usable once the count is saved.
        const under = []; const ask = [];
        for (const it of new Set(its)) {
          const h = holdingOf(c.stock, it.id, input.placeId);
          if (!h?.level) continue;
          let usable = balance(h, c.now, c.stock.offsetMinutes).usable;
          for (const l of input.lines.filter((x) => x.itemId === it.id)) {
            const b = batchBalance(c.stock, input.placeId, l, c.now);
            const dead = b.expired || (l.expiresOn && !b.expiresOn && Date.parse(`${l.expiresOn}T00:00:00Z`) + 864e5 - c.stock.offsetMinutes * MIN <= Date.parse(c.now));
            usable += (dead ? 0 : l.qty) - (b.expired ? 0 : b.usable);
          }
          if (usable >= h.level) continue;
          under.push({ itemId: it.id, level: h.level, usable, shortBy: h.level - usable });
          if (from && !openRequestFor(c.stock, it.id, input.placeId)) ask.push({ itemId: it.id, qty: h.level - usable });
        }
        const requestNote = !under.length || ask.length ? null : input.raiseRequest === false ? 'No request raised: raiseRequest was false.' : !from ? 'No request raised: this site has no store set up to send it to.' : 'No new request: one is already open for these items.';
        return { from, under, ask, requestNote };
      },
      make(c, v, evs) {
        const { input } = c;
        const lines = input.lines.map((l) => cleanLine(l));
        const requestId = v.ask.length ? nextRequestId(evs) : null;
        return {
          events: [{ type: 'stock.counted', subject: input.placeId, data: { lines } },
            ...(requestId ? [{ type: 'stock.requested', subject: requestId, data: { placeId: input.placeId, fromPlaceId: v.from, lines: v.ask, raisedBy: 'count' } }] : [])],
          out: { placeId: input.placeId, counted: lines.length, underLevel: v.under, requestId, requested: v.ask, requestNote: v.requestNote },
          audit: ['stock.counted', input.placeId, { lines: lines.length, underLevel: v.under.length, requestId }],
        };
      },
      example: { input: { placeId: 'ward-a1', lines: [{ itemId: first.id, qty: 4 }] } },
    }),
    write({
      name: 'ospeli_stock_request',
      summary: 'Ask a store for stock for a place, by hand: the items and how many. (A count already raises a request for what is under its level, so this is for anything else.) An item with a request already open from the same place is refused, naming that request. An agent\'s call becomes a proposal for a person.',
      verbs: ['request'], required: ['placeId', 'lines'],
      props: { placeId: PLACE('The place that needs the stock.'), fromPlaceId: PLACE('The place that supplies. Leave out for the site\'s first store.'), lines: LINES(1, { batch: false }, 'What is needed.') },
      out: { requestId: { type: 'string' }, state: { type: 'string' }, fromPlaceId: ID },
      target: (input) => ({ id: input.placeId, word: 'place' }),
      verify(c) {
        const { input } = c;
        place(c, input.placeId, 'placeId');
        const from = supplier(c, input.placeId);
        if (!from) throw new CommandError('invalid-input', 'This site has no store set up, so say which place supplies: add fromPlaceId.');
        if (!input.lines.length) throw new CommandError('invalid-input', 'Add at least one line: the item and how many.');
        for (const l of input.lines) {
          const it = item(c, l.itemId);
          allowed(c, it, 'request', 'request');
          const open = openRequestFor(c.stock, l.itemId, input.placeId);
          if (open) throw new CommandError('conflict', `${open.id} is already open for ${it.name} at this place. No new request was raised.`, { existing: open.id });
        }
        if (new Set(input.lines.map((l) => l.itemId)).size !== input.lines.length) throw new CommandError('invalid-input', 'An item is listed twice. List each item once.');
        return { from };
      },
      make(c, v, evs) {
        const requestId = nextRequestId(evs);
        const lines = c.input.lines.map((l) => ({ itemId: l.itemId, qty: l.qty }));
        return { events: [{ type: 'stock.requested', subject: requestId, data: { placeId: c.input.placeId, fromPlaceId: v.from, lines, raisedBy: 'request' } }],
          out: { requestId, state: 'open', fromPlaceId: v.from }, audit: ['stock.requested', requestId, { placeId: c.input.placeId, fromPlaceId: v.from, lines: lines.length }] };
      },
      example: { input: { placeId: 'ward-a1', lines: [{ itemId: first.id, qty: 10 }] }, needs: 'No request already open for that item at that place. ospeli_stock_requests with { "placeId": "ward-a1" } shows what is open.' },
    }),
    write({
      name: 'ospeli_stock_issue',
      summary: 'Issue stock against a request: it leaves the supplying place and arrives at the place that asked. Leave lines out to issue everything still owed in full; send lines to issue part, and the rest stays open. Refused above what was asked or above what the supplier has usable. An agent\'s call becomes a proposal for a person.',
      verbs: ['issue'], required: ['requestId'], ward: 'request',
      props: { requestId: REQUEST_ID,
        lines: LINES(1, {}, 'What is issued now, for a part issue or for batched items. Leave out to issue everything still owed.'),
        expectedState: { type: 'string', enum: ['open', 'part'], description: 'The state the caller last saw. If the request has changed since, the command is refused (conflict).' } },
      out: { requestId: { type: 'string' }, state: { type: 'string' }, left: { type: 'array', description: 'What is still owed after this issue: { itemId, left }.' } },
      target: (input) => ({ id: input.requestId, word: 'request' }),
      verify(c) {
        const q = waiting(c, c.input.requestId, c.input.expectedState);
        const owed = q.lines.filter((l) => l.issued < l.qty);
        let lines = c.input.lines;
        if (!lines) {
          const batched = owed.map((l) => c.stock.items.get(l.itemId)).filter((it) => it.batched);
          if (batched.length) {
            const it = batched[0];
            const have = batchList(holdingOf(c.stock, it.id, q.fromPlaceId), c.now, c.stock.offsetMinutes).filter((b) => !b.expired && b.qty > 0).map((b) => `${b.batch} (${b.qty}${b.expiresOn ? `, expires ${b.expiresOn}` : ''})`);
            throw new CommandError('invalid-input', `${it.name} is tracked by batch, so say which batch is issued: send lines. Usable at ${placeName(c, q.fromPlaceId)}: ${have.join('; ') || 'none'}.`);
          }
          lines = owed.map((l) => ({ itemId: l.itemId, qty: l.qty - l.issued }));
          const short = lines.filter((l) => usableOf(c.stock, l.itemId, q.fromPlaceId, c.now) < l.qty).map((l) => ({ itemId: l.itemId, name: c.stock.items.get(l.itemId).name, asked: l.qty, usable: usableOf(c.stock, l.itemId, q.fromPlaceId, c.now) }));
          if (short.length) throw new CommandError('conflict', `${placeName(c, q.fromPlaceId)} cannot issue this in full: ${short.map((s) => `${s.name} (asked ${s.asked}, usable ${s.usable})`).join('; ')}. Send lines with what can be issued now; the rest stays open.`, { short });
        }
        checkLines(c, lines, 'issue', 'issue');
        const total = new Map();
        for (const l of lines) total.set(l.itemId, (total.get(l.itemId) || 0) + l.qty);
        for (const [itemId, qty] of total) {
          const want = q.lines.find((x) => x.itemId === itemId);
          const it = c.stock.items.get(itemId);
          if (!want) throw new CommandError('invalid-input', `${it.name} is not on this request. It asks for: ${q.lines.map((x) => x.itemId).join(', ')}.`);
          if (qty > want.qty - want.issued) throw new CommandError('conflict', `Only ${want.qty - want.issued} ${it.unit} of ${it.name} ${want.issued ? 'are still owed' : 'were asked for'} on this request, so ${qty} cannot be issued.`, { left: want.qty - want.issued });
        }
        canTake(c, q.fromPlaceId, lines);
        return { q, lines, total };
      },
      make(c, { q, lines, total }) {
        const out = lines.map((l) => cleanLine(l, { expiresOn: batchBalance(c.stock, q.fromPlaceId, l, c.now).expiresOn }));
        const left = q.lines.map((l) => ({ itemId: l.itemId, left: l.qty - l.issued - (total.get(l.itemId) || 0) })).filter((l) => l.left > 0);
        const state = left.length ? 'part' : 'issued';
        return { events: [{ type: 'stock.issued', subject: q.id, data: { fromPlaceId: q.fromPlaceId, lines: out } }], out: { requestId: q.id, state, left },
          audit: ['stock.issued', q.id, { fromPlaceId: q.fromPlaceId, placeId: q.placeId, lines: out.length, state }] };
      },
      example: { input: { requestId: 'req-00001' }, needs: 'A waiting request that the supplying place can issue in full. req-00001 is an example id: ospeli_stock_requests lists the waiting requests, with canIssueInFull on each.' },
    }),
    write({
      name: 'ospeli_stock_request_cancel',
      summary: 'Cancel a request that is still waiting, with a reason from the list. What was already issued stays issued. An agent\'s call becomes a proposal for a person.',
      verbs: ['request', 'count', 'issue'], required: ['requestId', 'reason'], ward: 'request',
      props: { requestId: REQUEST_ID, reason: { type: 'string', enum: REQUEST_CANCEL_REASONS, description: `Why it is cancelled: ${REQUEST_CANCEL_REASONS.join(', ')}.` },
        expectedState: { type: 'string', enum: ['open', 'part'], description: 'The state the caller last saw. If the request has changed since, the command is refused (conflict).' } },
      out: { requestId: { type: 'string' }, state: { type: 'string' } },
      target: (input) => ({ id: input.requestId, word: 'request' }),
      verify(c) {
        const q = waiting(c, c.input.requestId, c.input.expectedState);
        for (const l of q.lines) allowed(c, c.stock.items.get(l.itemId), ['request', 'count', 'issue'], 'cancel a request for');
        return q;
      },
      make(c, q) { return { events: [{ type: 'stock.request-cancelled', subject: q.id, data: { reason: c.input.reason } }], out: { requestId: q.id, state: 'cancelled' }, audit: ['stock.request-cancelled', q.id, { reason: c.input.reason }] }; },
      example: { input: { requestId: 'req-00001', reason: REQUEST_CANCEL_REASONS[0] }, needs: 'A waiting request. req-00001 is an example id: ospeli_stock_requests lists the waiting requests, and ospeli_stock_request raises one.' },
    }),

    // ---------------------------------------------------------------- movements at one place
    movement({
      name: 'ospeli_stock_receive', verb: 'receive', type: 'stock.received', word: 'receive', date: true, required: ['source'],
      summary: 'Record stock arriving at a place from outside the site: a purchase delivered, a donation, or a transfer from another organisation. For a batched item give the batch and its expiry date. It records the receipt only: it approves no purchase and keeps no price or supplier. An agent\'s call becomes a proposal for a person.',
      linesWhat: 'What arrived.',
      extra: { source: { type: 'string', enum: RECEIVE_SOURCES, description: `Where it came from: ${RECEIVE_SOURCES.join(', ')}.` },
        // An id's shape only (letters, a dash, digits), so a phone or record number typed here is refused and never reaches the log or the trail.
        orderRef: { type: 'string', pattern: '^[a-z]{2,12}-[0-9]{1,8}$', maxLength: 21, description: 'Optional: the id of the order this delivery belongs to, from the module that tracks orders, for example ord-00001 (an id, not text).' } },
      data: (input) => ({ source: input.source, orderRef: input.orderRef ?? null }),
      example: { input: { placeId: 'ward-a1', lines: [{ itemId: first.id, qty: 20 }], source: RECEIVE_SOURCES[0] } },
    }),
    movement({
      name: 'ospeli_stock_use', verb: 'use', type: 'stock.used', word: 'record use of', take: {},
      summary: 'Record stock used at a place, in the item\'s own unit (for example vials opened at a session). Use is not waste: waste goes through ospeli_stock_write_off. It records a number of things used, never who received them and never a dose. An agent\'s call becomes a proposal for a person.',
      linesWhat: 'What was used.', extra: { ref: REF }, data: (input) => ({ ref: input.ref ?? null }),
      example: { input: { placeId: 'ward-a1', lines: [{ itemId: first.id, qty: 1 }] }, needs: NEED_ITEM },
    }),
    movement({
      name: 'ospeli_stock_write_off', verb: 'writeOff', type: 'stock.written-off', word: 'write off', required: ['reason'], take: (input) => ({ fromHold: input.fromHold === true, allowExpired: true }),
      summary: 'Write stock off at a place with a reason from the list (expired, damaged, heat or freeze exposure, lost, count difference). It leaves the balance for good. With fromHold true it is taken from stock on hold. A person decides that stock is not fit to use; this records it. An agent\'s call becomes a proposal for a person.',
      linesWhat: 'What is written off.',
      extra: { reason: { type: 'string', enum: WRITE_OFF_REASONS, description: `Why: ${WRITE_OFF_REASONS.join(', ')}.` }, fromHold: { type: 'boolean', description: 'true: take it from the stock on hold at this place. Default false: from the usable stock (expired stock included).' } },
      data: (input) => ({ reason: input.reason, fromHold: input.fromHold === true }),
      example: { input: { placeId: 'ward-a1', lines: [{ itemId: first.id, qty: 1 }], reason: WRITE_OFF_REASONS[1] }, needs: NEED_ITEM },
    }),
    movement({
      name: 'ospeli_stock_hold', verb: 'hold', type: 'stock.quarantined', word: 'put on hold', required: ['reason'], take: { allowExpired: true },
      summary: 'Put stock on hold at a place while someone looks into it (a cold chain excursion, damaged packaging, a recall notice). Held stock stays on the shelf but is not usable: it cannot be issued, moved or used until a person releases it or writes it off. An agent\'s call becomes a proposal for a person.',
      linesWhat: 'What is put on hold.', extra: { reason: { type: 'string', enum: HOLD_REASONS, description: `Why: ${HOLD_REASONS.join(', ')}.` } }, data: (input) => ({ reason: input.reason }),
      example: { input: { placeId: 'ward-a1', lines: [{ itemId: first.id, qty: 1 }], reason: HOLD_REASONS[1] }, needs: NEED_ITEM },
    }),
    movement({
      name: 'ospeli_stock_release', verb: 'release', type: 'stock.released', word: 'release', people: true, take: { fromHold: true },
      summary: 'Release stock from hold so it is usable again. People only: the person who has looked into it decides; Ospeli records the decision and never makes it.',
      linesWhat: 'What is released from hold.',
      example: { input: { placeId: 'ward-a1', lines: [{ itemId: first.id, qty: 1 }] }, needs: 'Stock on hold at the place. ospeli_stock_levels shows onHold for each item, and ospeli_stock_hold puts stock on hold.' },
    }),
    write({
      name: 'ospeli_stock_transfer',
      summary: 'Move stock from one place on the site to another in one step (between wards, between stores, out to a session and back): it leaves the first place and arrives at the second together, so it can never be half done. Refused above what is usable. An agent\'s call becomes a proposal for a person.',
      verbs: ['transfer'], required: ['fromPlaceId', 'toPlaceId', 'lines'], ward: ['fromPlaceId', 'toPlaceId'],
      props: { fromPlaceId: PLACE('Where the stock leaves.'), toPlaceId: PLACE('Where it arrives.'), lines: LINES(1, {}, 'What is moved.'), ref: REF, again: AGAIN },
      out: { transferId: { type: 'string', pattern: TRANSFER_ID_PATTERN }, lines: { type: 'integer' } },
      target: (input) => ({ id: input.fromPlaceId, word: 'place' }),
      verify(c) {
        const { input } = c;
        place(c, input.fromPlaceId, 'fromPlaceId'); place(c, input.toPlaceId, 'toPlaceId');
        if (input.fromPlaceId === input.toPlaceId) throw new CommandError('invalid-input', 'The place it arrives at must be different from the place it leaves.');
        checkLines(c, input.lines, 'transfer', 'transfer');
        canTake(c, input.fromPlaceId, input.lines);
        notRepeat(c, 'stock.transferred', (e) => e.data?.fromPlaceId === input.fromPlaceId && e.data?.toPlaceId === input.toPlaceId && sameLines(e.data?.lines, input.lines), 'transfer');
      },
      make(c, v, evs) {
        const { input } = c;
        const transferId = nextTransferId(evs);
        const lines = input.lines.map((l) => cleanLine(l, { expiresOn: batchBalance(c.stock, input.fromPlaceId, l, c.now).expiresOn }));
        return { events: [{ type: 'stock.transferred', subject: transferId, data: { fromPlaceId: input.fromPlaceId, toPlaceId: input.toPlaceId, lines, ref: input.ref ?? null } }],
          out: { transferId, lines: lines.length }, audit: ['stock.transferred', transferId, { fromPlaceId: input.fromPlaceId, toPlaceId: input.toPlaceId, lines: lines.length }] };
      },
      example: { input: { fromPlaceId: 'ward-a1', toPlaceId: 'ward-a2', lines: [{ itemId: first.id, qty: 1 }] }, needs: NEED_ITEM },
    }),

    // ---------------------------------------------------------------- stock-outs
    write({
      name: 'ospeli_stock_out_start',
      summary: 'Declare that an item is out of stock at a place, with a cause from the list. A person declares it: a count of zero does not start one by itself. A second open stock-out for the same item and place is refused. An agent\'s call becomes a proposal for a person.',
      verbs: ['count', 'issue', 'levels'], required: ['itemId', 'placeId', 'cause'],
      props: { itemId: { ...ITEM, description: 'The item that is out, for example from ospeli_stock_outs "notDeclared".' }, placeId: PLACE('Where it is out.'),
        cause: { type: 'string', enum: STOCK_OUT_CAUSES, description: `The cause, as far as is known: ${STOCK_OUT_CAUSES.join(', ')}.` } },
      out: { stockOutId: { type: 'string', pattern: STOCK_OUT_ID_PATTERN } },
      target: (input) => ({ id: `${input.itemId}@${input.placeId}`, word: 'item' }),
      verify(c) {
        place(c, c.input.placeId, 'placeId');
        const it = item(c, c.input.itemId);
        allowed(c, it, ['count', 'issue', 'levels'], 'declare a stock-out of');
        const open = openStockOut(c.stock, it.id, c.input.placeId);
        if (open) throw new CommandError('conflict', `${open.id} is already open for ${it.name} at this place. No second stock-out was started.`, { existing: open.id });
      },
      make(c, v, evs) {
        const stockOutId = nextStockOutId(evs);
        const data = { itemId: c.input.itemId, placeId: c.input.placeId, cause: c.input.cause };
        return { events: [{ type: 'stock.stock-out-started', subject: stockOutId, data }], out: { stockOutId }, audit: ['stock.stock-out-started', stockOutId, data] };
      },
      example: { input: { itemId: first.id, placeId: 'ward-a1', cause: STOCK_OUT_CAUSES[0] }, needs: 'No stock-out already open for that item at that place. ospeli_stock_outs with { "state": "open" } lists the open ones.' },
    }),
    write({
      name: 'ospeli_stock_out_end',
      summary: 'Close a stock-out when the item is back, and say whether care was affected while it was out: yes or no, nothing clinical and nothing about any patient. An agent\'s call becomes a proposal for a person.',
      verbs: ['count', 'issue', 'levels'], required: ['stockOutId', 'careAffected'], ward: 'stockOut',
      props: { stockOutId: { type: 'string', pattern: STOCK_OUT_ID_PATTERN, maxLength: 20, description: 'A stock-out id from ospeli_stock_outs, for example so-00001.' },
        careAffected: { type: 'boolean', description: 'true: care was delayed or changed because the item was out. false: it was not. A yes or no only.' } },
      out: { stockOutId: { type: 'string' }, hours: { type: 'number' } },
      target: (input) => ({ id: input.stockOutId, word: 'stock-out' }),
      verify(c) {
        const s = c.stock.stockOuts.get(c.input.stockOutId);
        if (!s) throw new CommandError('not-found', 'No stock-out with that id. ospeli_stock_outs with { "state": "open" } lists the open ones.');
        if (s.endedAt) throw new CommandError('conflict', 'This stock-out is already closed.');
        // An end before the start is dropped when the log is read, so the command would say done and the stock-out would stay open.
        if (c.now < s.startedAt) throw new CommandError('conflict', 'This device\'s clock is earlier than the time this stock-out started, so it cannot be closed from here. Check the date and time on this device.');
        allowed(c, c.stock.items.get(s.itemId), ['count', 'issue', 'levels'], 'close a stock-out of');
        return s;
      },
      make(c, s) {
        return { events: [{ type: 'stock.stock-out-ended', subject: s.id, data: { careAffected: c.input.careAffected } }],
          out: { stockOutId: s.id, hours: Math.round(((Date.parse(c.now) - Date.parse(s.startedAt)) / HOUR) * 10) / 10 }, audit: ['stock.stock-out-ended', s.id, { careAffected: c.input.careAffected }] };
      },
      example: { input: { stockOutId: 'so-00001', careAffected: false }, needs: 'An open stock-out. so-00001 is an example id: ospeli_stock_outs with { "state": "open" } lists the open ones, and ospeli_stock_out_start declares one.' },
    }),

    // ---------------------------------------------------------------- people only: levels and items
    write({
      name: 'ospeli_stock_level_set',
      summary: 'Set the fill-to level of an item at a place: the number the place is topped back up to, and the line a count is compared with. 0 clears it. People only: a guide may suggest a level, a person sets it.',
      verbs: ['levels'], people: true, required: ['itemId', 'placeId', 'level'],
      props: { itemId: { ...ITEM, description: 'The item, from ospeli_stock_items.' }, placeId: PLACE('The place the level is for.'),
        level: { ...QTY(0), description: 'The fill-to level in the item\'s own unit. 0 means no level here.' },
        expectedLevel: { ...QTY(0), description: 'The level the caller last saw (0 for none). If it has changed since, the command is refused (conflict).' } },
      out: { itemId: { type: 'string' }, placeId: ID, level: { type: ['integer', 'null'] } },
      verify(c) {
        const { input } = c;
        place(c, input.placeId, 'placeId');
        allowed(c, item(c, input.itemId), 'levels', 'set levels for');
        const now = holdingOf(c.stock, input.itemId, input.placeId)?.level ?? 0;
        if (input.expectedLevel != null && input.expectedLevel !== now) throw new CommandError('conflict', 'This level changed since you opened it. Read it again.', { level: now });
        if (now === input.level) throw new CommandError('conflict', input.level ? `The level is already ${input.level}.` : 'There is no level here to clear.');
      },
      make(c) {
        const { itemId, placeId, level } = c.input;
        return { events: [{ type: 'stock.level-set', subject: placeId, data: { itemId, level } }], out: { itemId, placeId, level: level || null }, audit: ['stock.level-set', placeId, { itemId, level }] };
      },
      example: { input: { itemId: first.id, placeId: 'ward-a1', level: 37 }, needs: 'A level different from the one already set. ospeli_stock_levels with { "placeId": "ward-a1" } shows the levels.' },
    }),
    write({
      name: 'ospeli_stock_item_add',
      summary: 'Add an item this site keeps that is not on the list: a generic name, its one unit and its category. People only. The name is a thing, never a person, a brand or a supplier; a name that reads like a person\'s is asked about once.',
      verbs: ['itemAdd'], people: true, required: ['name', 'unit', 'category'], ward: 'none',
      props: {
        name: { type: 'string', minLength: 2, maxLength: 60, description: 'A generic name for the thing, for example "Examination gloves, medium". No brand, supplier or person.' },
        unit: { type: 'string', minLength: 1, maxLength: 30, description: 'The one unit every quantity of this item is counted in, for example "box of 100", "pack" or "vial".' },
        category: { type: 'string', enum: catList.map((x) => x.id), description: `The category it belongs to: ${catList.map((x) => x.id).join(', ')}.` },
        tracer: { type: 'boolean', description: 'true: one of the few items watched as a sign of how well stock is kept. Default false.' },
        batched: { type: 'boolean', description: 'true: tracked by batch (lot) and expiry date, so every movement names the batch. Default false.' },
        coldChain: { type: 'boolean', description: 'true: must be kept cold from store to use. Default false.' },
        dosesPerVial: { type: 'integer', minimum: 1, maximum: 50, description: 'Only for an item whose unit is "vial": how many doses one vial holds, for counting doses and vials.' },
        gs1: { type: 'string', pattern: '^[0-9]{8,14}$', maxLength: 14, description: 'Optional: the GS1 trade item number printed under the barcode, 8 to 14 digits.' },
        notAName: NOT_A_NAME,
      },
      out: { itemId: { type: 'string' } },
      check: (input) => checkTypedText(input, ['name', 'unit'], { advice: 'Name the thing and its unit; never a person. Ospeli holds no personal details.' }),
      verify(c) {
        const { notAName, ...fields } = c.input;
        const why = itemProblem({ ...fields, id: 'item-00000' }, categories);
        if (why) throw new CommandError('invalid-input', `This item cannot be added: ${why}.`);
        if (c.role && !categories[fields.category].roles.itemAdd.includes(c.role)) throw new CommandError('forbidden', `${roleById(c.role)?.name || 'This role'} cannot add ${categories[fields.category].name.toLowerCase()} items. That is for: ${roleNames(categories[fields.category].roles.itemAdd) || 'nobody on this site'}.`);
        const same = [...c.stock.items.values()].find((it) => it.category === fields.category && it.name.trim().toLowerCase() === fields.name.trim().toLowerCase());
        if (same) throw new CommandError('conflict', `An item with that name is already on the list (${same.id}). No second one was added.`, { existing: same.id });
        return fields;
      },
      make(c, fields, evs) {
        const itemId = nextItemId(evs);
        const { name, unit, ...picks } = fields;
        return { events: [{ type: 'stock.item-added', subject: itemId, data: { ...picks, label: name.trim(), unit: unit.trim() } }], out: { itemId }, audit: ['stock.item-added', itemId, picks] };
      },
      example: { input: { name: 'Example dressing pack, small', unit: 'pack', category: catList[0].id } },
    }),
  ];
  // A verb nobody on this site may do has no command.
  return list.filter((c) => c.kind === 'read' || c.roles.length);
}
