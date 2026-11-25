// Stores and supplies: the screens. Every read and write goes through ctx.run, the same commands an
// agent would use, so the page works the same on a site's own server.
//   #/stores/count     Ward stock count (ward nurse, phone): count, and what is short is asked for in the same step
//   #/stores/requests  Requests and issues (storekeeper, phone): oldest first, issue in full or in part
//   #/stores/receive   Receive a delivery (storekeeper): where it came from, and the order it belongs to
//   #/stores/orders    Order tracker: each order's steps and days at each; people approve purchases
//   #/stores/outs      Stock-out log: start and end, cause, and whether care was affected (yes or no)
//   #/stores/manage    Supplies overview (supply chain manager): what is short, what is stuck, measures, guide, levels, items, transfers
// The role decides which screens it has and which opens first. Counts items, requests and orders, never people.
import { h, setKids, fmtWait, moduleStyle, redrawOnChange } from '../ui.js';
import { roleById } from '../../core/model.js';
import { commandByName } from '../../core/commands.js';
import { proposalsCard } from '../proposals.js';
import { TITLES, screensFor } from './screens.js';
import { STEP_ROLES, STEP_NAMES, UNITS, percentText } from './logic.js';

const can = (role, cmd) => !!commandByName(cmd)?.roles.includes(role);
// Role names in full on this page ("COO" spelled out).
const roleName = (r) => (r === 'coo' ? 'Chief operating officer' : roleById(r)?.name || r);
const roleNames = (ids) => ids.map(roleName).join(' or ');
// A request or an order named in plain words; the id itself stays in data attributes.
const reqName = (id) => `Request ${Number(String(id).replace(/^req-/, '')) || id}`;
const ordName = (id) => `Order ${Number(String(id).replace(/^ord-/, '')) || id}`;
const MAX = 100000;
const hoursText = (hrs) => (hrs == null ? '' : fmtWait(hrs * 60));
// Hours since, in the linen screen's words: "just now", "25 min ago", "1 h 20 min ago" (#145; was "1 h" under 90 minutes).
const agoWords = (hrs) => { const m = Math.floor(hrs * 60); return m < 1 ? 'just now' : `${fmtWait(m)} ago`; };
const daysText = (d) => (d == null ? '' : d < 1 ? `${Math.max(1, Math.round(d * 24))} h` : `${Math.round(d * 10) / 10} days`);
// Dates as day and month, times on the 24-hour clock, in the device's own time: "8 Nov, 19:19".
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const day = (iso) => { const d = new Date(iso); return `${d.getDate()} ${MONTHS[d.getMonth()]}`; };
const when = (iso) => { const d = new Date(iso); return `${day(iso)}, ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const CHECK_TIMES = 10; // a count over this many times the top-up level is asked about once (example setting, not a standard)
const ISSUED_RECENT_HOURS = 4; // an issue this recent may still be on its way to the ward (example setting, not a standard)
const levelWord = (isStore) => (isStore ? 'reorder level' : 'top-up level');
// Issued is not arrived: the ward sees that the store issued it, never that it arrived.
const stateWords = (q) => ({ open: 'Waiting', part: 'Part issued from the store', issued: 'Issued from the store', cancelled: 'Cancelled' })[q.state] || q.stateName;
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
// A double tap: the core refuses the same movement again and says so. That is not an error to retry.
const already = (err) => err?.code === 'conflict' && (err.detail?.confirm === 'again' || err.detail?.already === true || err.detail?.state === 'issued');
const offline = () => document.documentElement.dataset.site === 'offline';
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { if (v) localStorage.setItem(k, v); else localStorage.removeItem(k); } catch { /* still works for this visit */ } },
};

export async function render(el, ctx) {
  await moduleStyle('stores');
  const screens = screensFor(ctx.role);
  const screen = screens.includes(ctx.rest[0]) ? ctx.rest[0] : screens[0];
  const head = h('div', { class: 'page-head' }, h('div', {}, h('p', { class: 'eyebrow' }, 'Stores and supplies'), h('h1', {}, TITLES[screen])));
  const wrap = h('div', { class: 'mod-stores sto', 'data-screen': screen, 'data-role': ctx.role }, head);
  el.append(wrap);
  const items = await ctx.run('ospeli_stock_items', { category: 'supplies', limit: 500 });
  if (!items.stores.length) {
    wrap.append(h('div', { class: 'card notice', 'data-test': 'no-store' },
      h('p', {}, h('b', {}, 'No store is set up in the hospital on this device, so supplies cannot be counted, issued or received here.')),
      h('p', {}, 'The example hospital on this device was made before stores were added. Load a new example hospital on the ', h('a', { class: 'sto-link', href: '#/data' }, 'Data and audit'), ' page to try this module.')));
    return null;
  }
  const shared = { items, item: new Map(items.items.map((it) => [it.id, it])), stores: items.stores, names: new Map(items.stores.map((s) => [s.id, s.name])) };
  const tabs = screens.length > 1 ? h('nav', { class: 'sto-tabs', 'aria-label': 'Stores and supplies' },
    screens.map((s) => h('a', { href: `#/stores/${s}`, 'data-screen': s, 'aria-current': s === screen ? 'page' : null }, TITLES[s]))) : null;
  const view = { count: countScreen, requests: requestsScreen, receive: receiveScreen, orders: ordersScreen, outs: outsScreen, manage: manageScreen }[screen](ctx, shared);
  wrap.append(...[tabs, view.el].filter(Boolean));
  await view.load();
  const off = redrawOnChange(ctx, () => view.load(), { wait: 120 });
  // Keep the waits fresh, but never redraw under a person who is typing or picking.
  const tick = setInterval(() => { const a = document.activeElement; if (a && wrap.contains(a) && ['INPUT', 'SELECT', 'TEXTAREA'].includes(a.tagName)) return; view.load(); }, 60e3);
  return () => { off(); clearInterval(tick); };
}

// ---------------------------------------------------------------- shared pieces
// A number picked with − and + (or typed). It starts blank: blank means "not counted", never zero.
function stepper({ get, set, label, max = MAX, test = null }) {
  const input = h('input', { type: 'number', inputmode: 'numeric', min: 0, max, step: 1, placeholder: '–', class: 'sto-num', 'aria-label': label, 'data-test': test });
  const msg = h('span', { class: 'sto-bad', role: 'alert', hidden: true });
  // A number the field itself marks wrong is never changed to a nearby one and saved (#116):
  // it is marked, said beside the field, and every save on the page refuses while it stands.
  const mark = (why) => {
    if (why) { input.setAttribute('aria-invalid', 'true'); msg.textContent = `Not saved: ${label.replace(/, how many.*$/, '')}. ${why}`; msg.hidden = false; }
    else { input.removeAttribute('aria-invalid'); msg.textContent = ''; msg.hidden = true; }
  };
  const show = () => { const v = get(); input.value = v == null ? '' : String(v); mark(null); };
  const put = (v) => { set(v); show(); };
  input.addEventListener('input', () => {
    const raw = input.value.trim();
    if (raw === '' && !input.validity.badInput) { mark(null); set(null); return; }
    const n = Number(raw);
    const why = raw === '' || !Number.isFinite(n) ? 'Type a number, for example 4.'
      : n < 0 ? 'A count cannot be below 0.'
        : !Number.isInteger(n) || !/^\d+$/.test(raw) ? 'Use a whole number, for example 4.'
          : n > max ? `The most this field takes is ${max}.` : null;
    mark(why);
    if (!why) set(n);
  });
  input.addEventListener('blur', () => { if (input.getAttribute('aria-invalid') !== 'true') show(); });
  show();
  return h('span', { class: 'sto-stepper-wrap' }, h('span', { class: 'sto-stepper' },
    h('button', { type: 'button', class: 'sto-step', 'aria-label': `One less: ${label}`, onclick: () => { const v = get(); put(v == null ? 0 : Math.max(0, v - 1)); } }, '−'),
    input,
    h('button', { type: 'button', class: 'sto-step', 'aria-label': `One more: ${label}`, onclick: () => { const v = get(); put(v == null ? 1 : Math.min(max, v + 1)); } }, '+')), msg);
}
// The first number on the page the field marks wrong: focus it and say so. True when one stands.
function refuseBad(ctx) {
  const bad = document.querySelector('.mod-stores .sto-num[aria-invalid="true"]');
  if (!bad) return false;
  bad.focus();
  ctx.toast('Not saved. Fix the number marked beside its field.');
  return true;
}
// A <details> that stays open or shut across redraws.
function keepOpen(openSet, key, summary, body, attrs = {}) {
  const d = h('details', { ...attrs, open: openSet.has(key) || null }, h('summary', {}, summary), body);
  d.addEventListener('toggle', () => { if (d.open) openSet.add(key); else openSet.delete(key); });
  return d;
}
function placeSelect(id, list, { blank, value, onchange }) {
  const s = h('select', { id, 'data-test': id }, h('option', { value: '' }, blank), list.map(([v, label]) => h('option', { value: v }, label)));
  s.value = value || '';
  s.addEventListener('change', () => onchange(s.value));
  return s;
}
// Run one command for a person: a second tap while it runs does nothing; a double tap the core
// caught says "Already saved". Returns the answer, or null when it was not saved.
function actions(ctx, reload) {
  let busy = false;
  return async function act(cmd, input, words, { onDone = null, onError = null } = {}) {
    if (busy) return null;
    if (refuseBad(ctx)) return null;
    busy = true;
    try {
      const out = await ctx.run(cmd, input);
      if (words) ctx.toast(typeof words === 'function' ? words(out) : words);
      if (onDone) onDone(out);
      return out;
    } catch (err) {
      if (already(err)) ctx.toast('Already saved');
      else if (onError) onError(err);
      else ctx.toast(`Not saved. ${err.message}`);
      return null;
    } finally {
      busy = false;
      await reload();
    }
  };
}
const offlineNote = (what) => (offline() ? h('p', { class: 'card notice', 'data-test': 'offline' }, `Not connected to the site: ${what} cannot be saved until the connection is back.`) : null);
function placesOf(levels, stores) {
  const storeIds = new Set(stores.map((s) => s.id));
  const m = new Map();
  for (const r of levels) if (!storeIds.has(r.placeId)) m.set(r.placeId, r.placeName);
  return [...m].sort((a, b) => (a[1] < b[1] ? -1 : 1));
}
function describe(p, shared) {
  const i = p.input || {};
  const nm = (id) => shared.names.get(id) || 'a place';
  const it = (id) => shared.item.get(id)?.name || 'an item';
  const lines = (ls) => (ls || []).map((l) => `${it(l.itemId)} ${l.qty}`).join(', ');
  switch (p.command) {
    case 'ospeli_stock_count': return `Count at ${nm(i.placeId)}: ${plural((i.lines || []).length, 'item')}`;
    case 'ospeli_stock_request': return `Ask for stock for ${nm(i.placeId)}: ${lines(i.lines)}`;
    case 'ospeli_stock_issue': return `Issue ${i.lines ? 'part of ' : ''}request ${i.requestId}${i.lines ? `: ${lines(i.lines)}` : ' in full'}`;
    case 'ospeli_stock_request_cancel': return `Cancel request ${i.requestId} (${i.reason})`;
    case 'ospeli_stock_receive': return `Receive at ${nm(i.placeId)} (${i.source}${i.orderRef ? `, order ${i.orderRef}` : ''}): ${lines(i.lines)}`;
    case 'ospeli_stock_transfer': return `Move from ${nm(i.fromPlaceId)} to ${nm(i.toPlaceId)}: ${lines(i.lines)}`;
    case 'ospeli_stock_write_off': return `Write off at ${nm(i.placeId)} (${i.reason}): ${lines(i.lines)}`;
    case 'ospeli_stock_hold': return `Put on hold at ${nm(i.placeId)} (${i.reason}): ${lines(i.lines)}`;
    case 'ospeli_stock_out_start': return `Start a stock-out: ${it(i.itemId)} at ${nm(i.placeId)} (${i.cause})`;
    case 'ospeli_stock_out_end': return `End stock-out ${i.stockOutId}: care ${i.careAffected ? 'was' : 'was not'} affected`;
    case 'ospeli_stores_order_step': return i.step === 'requested' ? `Request a new order: ${lines(i.lines)}` : `Order ${i.orderId}: record ${STEP_NAMES[i.step]?.toLowerCase() || i.step}`;
    case 'ospeli_stores_order_remind': return `Send a reminder about order ${i.orderId}`;
    default: return p.command;
  }
}
const matchMine = (p) => /^ospeli_(stores|stock)_/.test(p.command);

// ---------------------------------------------------------------- Ward stock count (phone)
function countScreen(ctx, shared) {
  const box = h('div', { class: 'sto-count' });
  // A ward's own agent may suggest a count or a request: the ward decides it here (#148).
  const props = proposalsCard(ctx, { match: (p) => matchMine(p) && p.canDecide, describe: (p) => describe(p, shared) });
  const mayCount = can(ctx.role, 'ospeli_stock_count');
  const known = () => ui.wards.some(([id]) => id === ui.ward);
  const ui = { ward: ctx.rest[1] || store.get('ospeli-stores-ward') || '', wards: [], values: new Map(), moved: new Set(), result: null, open: new Set(), checked: null };
  let data = null;
  const load = async () => {
    const levels = await ctx.run('ospeli_stock_levels', { category: 'supplies', format: 'short', limit: 500 });
    ui.wards = placesOf(levels.levels, shared.stores);
    for (const [id, name] of ui.wards) shared.names.set(id, name);
    if (!known()) ui.ward = '';
    const reqs = ui.ward ? await ctx.run('ospeli_stock_requests', { placeId: ui.ward, state: 'all', limit: 20 }) : null;
    data = { levels, rows: levels.levels.filter((r) => r.placeId === ui.ward && r.level), reqs };
    draw();
    await props.load();
  };
  const act = actions(ctx, load);
  const saveBtn = h('button', { class: 'btn btn-big sto-save', type: 'button', 'data-cmd': 'ospeli_stock_count', 'data-test': 'count-save' });
  const counted = () => [...ui.values].filter(([, v]) => v != null);
  const label = () => { const n = counted().length; saveBtn.textContent = n ? `Save count (${plural(n, 'item')})` : 'Count at least one item to save'; };
  saveBtn.addEventListener('click', async () => {
    if (refuseBad(ctx)) return;
    const lines = counted().map(([itemId, qty]) => ({ itemId, qty }));
    if (!lines.length) return;
    // A count far over the top-up level is often a slip (400 for 4): ask once, then save what was typed.
    const big = lines.map((l) => ({ ...l, row: data.rows.find((r) => r.itemId === l.itemId) })).filter((l) => l.row?.level && l.qty > l.row.level * CHECK_TIMES);
    const key = JSON.stringify(big.map((l) => [l.itemId, l.qty]));
    if (big.length && ui.checked !== key) {
      ui.checked = key;
      ui.result = { check: big.map((l) => `${l.qty} of ${l.row.itemName} (${l.row.unit}; top-up level ${l.row.level})`).join('; ') };
      draw();
      saveBtn.focus();
      return;
    }
    ui.checked = null;
    const place = ui.ward;
    await act('ospeli_stock_count', { placeId: place, lines, seenSeq: data.levels.asOfSeq }, (out) => (out.requestId ? `Count saved. ${reqName(out.requestId)} sent to the store` : 'Count saved'), {
      onDone: (out) => { ui.values.clear(); ui.moved.clear(); ui.result = { ...out, place }; },
      onError: (err) => {
        if (err.code === 'conflict' && err.detail?.changed) {
          for (const id of err.detail.changed) { ui.values.delete(id); ui.moved.add(id); }
          ui.result = { error: 'Stock moved here since you opened the count (a delivery or an issue). Count the marked items again; the rest of your count is kept.' };
        } else ui.result = { error: `Not saved. ${err.message}` };
      },
    });
  });

  function draw() {
    const select = placeSelect('count-ward', ui.wards, { blank: 'Choose your ward', value: ui.ward, onchange: (v) => { ui.ward = v; store.set('ospeli-stores-ward', v); ui.values.clear(); ui.moved.clear(); ui.result = null; load(); } });
    const top = h('div', { class: 'field sto-field' }, h('label', { for: 'count-ward' }, 'Your ward'), select);
    if (!ui.wards.length) {
      setKids(box, h('p', { class: 'card sto-empty', 'data-test': 'count-empty' }, 'No ward has a top-up list yet, so there is nothing to count on this device. The supply chain manager sets the top-up levels for each ward.'));
      return;
    }
    if (!ui.ward) { setKids(box, top, h('p', { class: 'meta' }, 'Choose your ward to see its supplies and their top-up levels.')); return; }
    const all = data.reqs?.requests || [];
    const waiting = all.filter((q) => q.state === 'open' || q.state === 'part');
    const status = waiting.length
      ? h('p', { class: 'sto-status', 'data-test': 'ward-status' }, h('b', {}, `${plural(waiting.length, 'request')} waiting`), ` for this ward: ${waiting.map((q) => `${reqName(q.id)}, ${stateWords(q).toLowerCase()} ${hoursText(q.waitHours)}`).join('; ')}. `, h('a', { class: 'sto-link', href: '#sto-ward-reqs' }, 'See it'))
      : null;
    // Issued is not arrived: an issue in the last few hours may still be on its way to the ward.
    const now = Date.parse(data.levels.asOf);
    const onWay = new Map();
    for (const q of all) {
      if (q.state !== 'issued' || !q.issuedAt) continue;
      const hrs = (now - Date.parse(q.issuedAt)) / 36e5;
      if (hrs >= 0 && hrs < ISSUED_RECENT_HOURS) for (const l of q.lines) if (l.issued > 0 && !onWay.has(l.itemId)) onWay.set(l.itemId, hrs);
    }
    const rows = data.rows;
    const list = h('ul', { class: 'sto-lines', 'data-test': 'count-list' }, rows.map((r) => {
      const marker = h('span', { class: 'sto-marker', 'data-test': 'marker' });
      const li = h('li', { 'data-item': r.itemId, class: ui.moved.has(r.itemId) ? 'is-moved' : null });
      const mark = () => {
        const v = ui.values.get(r.itemId);
        const under = v != null && v < r.level;
        li.classList.toggle('is-under', under);
        li.classList.toggle('is-counted', v != null);
        marker.textContent = v == null ? (ui.moved.has(r.itemId) ? 'Count again' : '') : under ? (r.openRequestId ? `Under level: already asked for (${reqName(r.openRequestId)})` : onWay.has(r.itemId) ? `Under level: saving asks the store again for ${r.level - v}, though stock was issued ${agoWords(onWay.get(r.itemId))}. Is it on the shelf yet?` : `Under level: ${r.level - v} will be asked for`) : 'At or over level';
        label();
      };
      li.append(...[
        h('div', { class: 'sto-line-head' }, h('b', {}, r.itemName), h('span', { class: 'meta' }, `${r.unit} · top-up level ${r.level}`)),
        onWay.has(r.itemId) ? h('p', { class: 'sto-fact', 'data-test': 'on-its-way' }, `Issued from the store ${agoWords(onWay.get(r.itemId))}: on its way. Count it once it is on the shelf.`) : null,
        mayCount ? h('div', { class: 'sto-line-acts' },
          stepper({ get: () => ui.values.get(r.itemId) ?? null, set: (v) => { if (v == null) ui.values.delete(r.itemId); else ui.values.set(r.itemId, v); mark(); }, label: `${r.itemName}, how many are there`, test: 'count-input' }),
          h('button', { type: 'button', class: 'btn btn-ghost btn-small sto-full', 'data-test': 'at-level', onclick: () => { ui.values.set(r.itemId, r.level); const n = li.querySelector('.sto-num'); n.value = String(r.level); n.dispatchEvent(new Event('input')); mark(); } }, `At level: ${r.level}`)) : null,
        marker].filter(Boolean));
      mark();
      return li;
    }));
    const result = ui.result?.check ? h('p', { class: 'card notice sto-result', role: 'status', 'data-test': 'count-check' }, `${ui.result.check}: more than ${CHECK_TIMES} times the level. Is that right? Tap save again to keep it, or change the number.`)
      : ui.result ? (ui.result.error
      ? h('p', { class: 'card notice sto-result', role: 'status', 'data-test': 'count-result' }, ui.result.error)
      : h('div', { class: 'card sto-result is-ok', role: 'status', 'data-test': 'count-result' },
        h('p', {}, h('b', {}, `Saved: ${plural(ui.result.counted, 'item')} counted at ${shared.names.get(ui.result.place) || 'the ward'}.`)),
        ui.result.requestId ? h('p', { 'data-test': 'raised', 'data-request': ui.result.requestId }, `${reqName(ui.result.requestId)} sent to the store for ${plural(ui.result.requested.length, 'item')} under level: `, ui.result.requested.map((l) => `${shared.item.get(l.itemId)?.name || l.itemId} ${l.qty}`).join(', '), '.')
          : h('p', {}, ui.result.requestNote || 'Nothing is under its level: no request needed.'))) : null;
    label();
    setKids(box,
      offline() ? h('p', { class: 'card notice', 'data-test': 'offline' }, 'Not connected to the site: the count cannot be saved until the connection is back. Keep this screen open; your count is kept.') : null,
      top, status, result,
      rows.length ? [
        h('p', { class: 'sto-hint' }, mayCount ? 'Count what is on the shelf. Leave an item blank if you did not count it. "At level" fills in the top-up level; if there is more than that, use +. Anything under its top-up level is asked for when you save.' : `${roleName(ctx.role)} can see this list. Counts are saved by ${roleNames(commandByName('ospeli_stock_count').roles)}.`),
        list,
        mayCount ? h('div', { class: 'sto-savebar' }, saveBtn) : null,
      ] : h('p', { class: 'card sto-empty', 'data-test': 'count-empty' }, 'No top-up levels are set for this ward yet. The supply chain manager sets them.'),
      wardRequests());
  }
  function wardRequests() {
    const list = data.reqs?.requests || [];
    return h('section', { class: 'section', id: 'sto-ward-reqs', 'aria-labelledby': 'sto-wr-h', 'data-test': 'ward-requests' },
      h('h2', { id: 'sto-wr-h' }, 'This ward\'s requests'),
      list.length ? h('ul', { class: 'sto-plain' }, list.map((q) => h('li', { 'data-request': q.id, 'data-state': q.state },
        h('p', {}, h('b', {}, reqName(q.id)), ' ', h('span', { class: `chip sto-state is-${q.state}`, 'data-test': 'state' }, stateWords(q)),
          ` ${q.state === 'issued' ? `in ${hoursText(q.waitHours)}, ${when(q.issuedAt)}` : q.state === 'cancelled' ? `(${q.cancelReason})` : `for ${hoursText(q.waitHours)}`}`),
        keepOpen(ui.open, q.id, `${plural(q.lines.length, 'item')} asked for`, h('ul', { class: 'sto-mini' }, q.lines.map((l) => h('li', {}, `${l.itemName}: ${l.issued} of ${l.qty} issued from the store`))))))) : h('p', { class: 'meta' }, 'No request from this ward yet.'));
  }
  return { el: h('div', {}, props.el, box), load };
}

// ---------------------------------------------------------------- Requests and issues (storekeeper, phone)
function requestsScreen(ctx, shared) {
  const box = h('div', { class: 'sto-reqs' });
  const mayIssue = can(ctx.role, 'ospeli_stock_issue');
  const ui = { open: new Set(), closed: new Set(), pick: new Map(), done: null };
  const props = proposalsCard(ctx, { match: matchMine, describe: (p) => describe(p, shared) });
  let data = null;
  const load = async () => {
    const [reqs, ov] = await Promise.all([ctx.run('ospeli_stock_requests', { state: 'waiting', limit: 200 }), ctx.run('ospeli_stores_overview', { days: 30, format: 'short' })]);
    for (const q of reqs.requests) { shared.names.set(q.placeId, q.placeName); shared.names.set(q.fromPlaceId, q.fromPlaceName); }
    data = { reqs: reqs.requests.filter((q) => q.lines.some((l) => shared.item.has(l.itemId))), ov };
    draw();
    await props.load();
  };
  const act = actions(ctx, load);
  const issue = (q, lines) => act('ospeli_stock_issue', { requestId: q.id, expectedState: q.state, ...(lines ? { lines } : {}) },
    (out) => `${out.state === 'issued' ? 'Issued in full' : 'Part issued'}: ${reqName(q.id)} to ${q.placeName}`,
    { onDone: (out) => { ui.pick.delete(q.id); ui.done = { id: q.id, place: q.placeName, state: out.state, left: out.left.length }; ui.lockUntil = Date.now() + LOCK_MS; setTimeout(() => draw(), LOCK_MS + 50); } });
  // After an issue the next request's button moves up into the same place: it cannot be tapped for a
  // moment, so a second tap to "check it worked" never issues the next request.
  const LOCK_MS = 2500;
  const locked = () => Date.now() < (ui.lockUntil || 0);

  // One request: the pick list (item, how many are owed, what the store holds, how many go now) is
  // open on the oldest card, above the button that confirms it. Reduce a line for a part issue.
  function card(q, first) {
    const owed = q.lines.filter((l) => l.left > 0);
    const none = owed.every((l) => l.usableAtSupplier <= 0);
    if (!ui.pick.has(q.id)) ui.pick.set(q.id, new Map(owed.map((l) => [l.itemId, Math.max(0, Math.min(l.left, l.usableAtSupplier))])));
    const vals = ui.pick.get(q.id);
    const picked = () => owed.map((l) => ({ itemId: l.itemId, qty: vals.get(l.itemId) || 0 })).filter((l) => l.qty > 0);
    const full = () => owed.every((l) => (vals.get(l.itemId) || 0) >= l.left);
    const btn = h('button', { class: `btn ${first ? 'btn-big ' : ''}sto-issue`, type: 'button', disabled: locked(), 'data-cmd': 'ospeli_stock_issue', 'data-test': 'issue' });
    const label = () => {
      const n = picked().length;
      btn.textContent = !n ? 'Nothing picked to issue' : full() ? `Issue all ${plural(n, 'item')} as picked` : `Issue ${n} of ${plural(owed.length, 'item')} as picked (part)`;
      btn.dataset.full = String(full());
    };
    btn.addEventListener('click', (e) => { const ls = picked(); if (!ls.length) return; e.currentTarget.disabled = true; issue(q, full() ? null : ls); });
    label();
    const isOpen = first ? !ui.closed.has(q.id) : ui.open.has(q.id);
    const pick = h('details', { class: 'sto-pick', 'data-test': 'pick-list', open: isOpen || null },
      h('summary', {}, `Pick list: ${plural(owed.length, 'item')}`),
      h('ul', { class: 'sto-lines' }, owed.map((l) => {
        const most = Math.max(0, Math.min(l.left, l.usableAtSupplier));
        return h('li', { 'data-item': l.itemId, class: l.usableAtSupplier < l.left ? 'is-under' : null },
          h('div', { class: 'sto-line-head' }, h('b', {}, l.itemName), h('span', { class: 'meta' }, `${l.left} owed · store holds ${l.usableAtSupplier}`)),
          most > 0 ? h('div', { class: 'sto-line-acts' }, h('span', { class: 'meta' }, 'Issue now'),
            stepper({ get: () => vals.get(l.itemId) ?? 0, set: (v) => { vals.set(l.itemId, v ?? 0); label(); }, label: `${l.itemName}, how many to issue now`, max: most }))
            : h('span', { class: 'sto-marker' }, 'None in the store: stays owed'));
      })));
    pick.addEventListener('toggle', () => { if (first) { if (pick.open) ui.closed.delete(q.id); else ui.closed.add(q.id); } else if (pick.open) ui.open.add(q.id); else ui.open.delete(q.id); });
    return h('li', { class: `sto-req${first ? ' is-first' : ''}`, 'data-request': q.id, 'data-test': first ? 'first-request' : 'request' },
      h('div', { class: 'sto-req-head' },
        h('p', { class: 'sto-req-place' }, h('b', {}, q.placeName)),
        h('p', { class: 'sto-wait', 'data-test': 'wait' }, `Waiting ${hoursText(q.waitHours)}`),
        h('p', { class: 'meta' }, `${reqName(q.id)} · ${q.raisedBy === 'count' ? 'raised by a count' : 'asked for by hand'}${q.state === 'part' ? ' · part issued' : ''} · ${plural(owed.length, 'item')} to issue`),
        owed.length <= 3 ? h('p', { class: 'meta', 'data-test': 'owed' }, `Still owed: ${owed.map((l) => `${l.itemName} ${l.left}`).join(', ')}`) : null),
      mayIssue
        ? (none ? h('p', { class: 'sto-fact', 'data-test': 'cannot-full' }, 'The store has none of what is still owed. It stays waiting until a delivery is received.')
          : [pick, h('div', { class: first ? 'sto-issuebar' : 'sto-acts' }, btn)])
        : keepOpen(ui.open, `lines:${q.id}`, `See the ${plural(q.lines.length, 'item')}`, h('ul', { class: 'sto-mini' }, q.lines.map((l) => h('li', { class: l.left > l.usableAtSupplier ? 'is-short' : null },
          `${l.itemName}: ${l.left} to issue${l.issued ? ` (${l.issued} already issued)` : ''}, store holds ${l.usableAtSupplier}`))), { class: 'sto-more' }));
  }
  function draw() {
    const list = data.reqs;
    const k = Object.fromEntries(data.ov.kpis.map((x) => [x.id, x]));
    const wait = k['stores-request-wait']; const fill = k['stores-fill-rate'];
    const oldest = list[0];
    // Oldest first, the ones the store can issue now on top: those waiting for a delivery go below.
    const fillable = (q) => q.lines.some((l) => l.left > 0 && l.usableAtSupplier > 0);
    const ready = list.filter(fillable); const stuck = list.filter((q) => !fillable(q));
    setKids(box,
      offlineNote('an issue'),
      props.el,
      h('p', { class: 'sto-counts', 'data-test': 'req-counts' }, h('b', {}, list.length), ` waiting${oldest ? ` · oldest ${hoursText(oldest.waitHours)}` : ''}${stuck.length ? ` · ${stuck.length} need a delivery first` : ''}`),
      ui.done ? h('p', { class: 'card sto-result is-ok', role: 'status', 'data-test': 'issue-result' }, `${ui.done.state === 'issued' ? 'Issued in full' : 'Part issued'}: ${reqName(ui.done.id)} to ${ui.done.place}.${ui.done.left ? ` ${plural(ui.done.left, 'item')} still to come.` : ''}`) : null,
      mayIssue ? null : h('p', { class: 'meta', 'data-test': 'read-only' }, `${roleName(ctx.role)} can see the requests. They are issued by ${roleNames(commandByName('ospeli_stock_issue').roles)}.`),
      list.length ? [
        ready.length ? h('ul', { class: 'sto-req-list', 'data-test': 'requests' }, ready.map((q, i) => card(q, i === 0))) : h('p', { class: 'meta' }, 'Nothing can be issued now: the store has none of what is owed.'),
        stuck.length ? h('section', { class: 'section', 'aria-labelledby': 'sto-ws-h' }, h('h2', { id: 'sto-ws-h' }, `Waiting for a delivery (${stuck.length})`),
          h('p', { class: 'meta' }, 'The store has none of what is still owed on these. They are issued when stock arrives; the order tracker shows what is on its way.'),
          h('ul', { class: 'sto-req-list', 'data-test': 'requests-waiting-stock' }, stuck.map((q) => card(q, false)))) : null,
      ] : h('p', { class: 'card sto-empty', 'data-test': 'requests-empty' }, 'No request is waiting. New requests show here by themselves when a ward saves a count.'),
      h('p', { class: 'meta sto-measure', 'data-test': 'req-measure', 'data-n': wait?.n ?? 0, 'data-fill': fill?.numerator ?? 0 },
        `Last 30 days: requests waited ${wait?.value == null ? 'no full issue yet' : `a median of ${hoursText(wait.value)}`} from raised to issued from the store in full (${plural(wait?.n ?? 0, 'request')}); fill rate ${fill?.value == null ? 'none yet' : `${Math.round(fill.value)}%`} of request lines issued in full in the end (after any part issues).`));
  }
  return { el: box, load };
}

// ---------------------------------------------------------------- Receive a delivery (storekeeper)
function receiveScreen(ctx, shared) {
  const box = h('div', { class: 'sto-receive' });
  const mayReceive = can(ctx.role, 'ospeli_stock_receive');
  const SOURCES = shared.items.picks.receiveSources;
  const ui = { source: null, orderId: ctx.rest[1] || '', placeId: shared.stores[0].id, lines: new Map(), add: '', msg: null };
  let data = null;
  const load = async () => {
    data = { orders: await ctx.run('ospeli_stores_orders', { state: 'open', format: 'short', limit: 200 }) };
    if (ui.orderId && !data.orders.orders.some((o) => o.id === ui.orderId)) ui.orderId = '';
    if (ui.orderId && !ui.source) ui.source = 'Purchase';
    draw();
  };
  const act = actions(ctx, load);
  const order = () => data.orders.orders.find((o) => o.id === ui.orderId) || null;
  const save = h('button', { class: 'btn btn-big', type: 'button', 'data-cmd': 'ospeli_stock_receive', 'data-test': 'receive-save' });
  const missing = () => (!ui.source ? 'the source' : ui.source === 'Purchase' && ui.orderId === '' ? 'the order (or "No order on the list")' : ![...ui.lines.values()].some((v) => v > 0) ? 'how many of at least one item' : null);
  const label = () => { const m = missing(); save.classList.toggle('is-waiting', !!m); save.setAttribute('aria-disabled', String(!!m)); save.textContent = m ? `Choose ${m}` : `Receive ${plural([...ui.lines.values()].filter((v) => v > 0).length, 'item')} into ${shared.names.get(ui.placeId)}`; };
  save.addEventListener('click', async () => {
    if (missing()) { ui.msg = `Choose ${missing()} first.`; draw(); return; }
    const lines = [...ui.lines].filter(([, v]) => v > 0).map(([itemId, qty]) => ({ itemId, qty }));
    const ref = ui.source === 'Purchase' && ui.orderId && ui.orderId !== 'none' ? ui.orderId : null;
    await act('ospeli_stock_receive', { placeId: ui.placeId, lines, source: ui.source, ...(ref ? { orderRef: ref } : {}) }, 'Delivery received', {
      onDone: () => { ui.msg = `Received into ${shared.names.get(ui.placeId)}: ${plural(lines.length, 'item')}${ref ? `, against order ${ref}` : ''}.`; ui.lines.clear(); ui.source = null; ui.orderId = ''; },
      onError: (err) => { ui.msg = `Not saved. ${err.message}`; },
    });
  });
  function pickOrder(id) {
    ui.orderId = id; ui.lines.clear();
    const o = order();
    if (o) for (const l of o.lines) if (l.qty > l.received) ui.lines.set(l.itemId, null);
    draw();
  }
  function draw() {
    if (!mayReceive) { setKids(box, h('p', { class: 'card meta', 'data-test': 'read-only' }, `${roleName(ctx.role)} can see deliveries on the order tracker. Deliveries are received by ${roleNames(commandByName('ospeli_stock_receive').roles)}.`)); return; }
    const o = order();
    // Orders that can arrive: approved or later, part received included (what is still to come).
    const open = data.orders.orders.filter((x) => ['approved', 'ordered', 'delivered', 'part-received'].includes(x.state));
    const choice = (v) => h('button', { type: 'button', class: 'chip-btn sto-choice', 'aria-pressed': String(ui.source === v), 'data-source': v, onclick: () => { ui.source = v; if (v !== 'Purchase') { ui.orderId = ''; } draw(); box.querySelector(`[data-source="${v}"]`)?.focus(); } }, v);
    const rows = [...ui.lines.keys()].map((itemId) => {
      const it = shared.item.get(itemId);
      const ol = o?.lines.find((l) => l.itemId === itemId);
      const left = ol ? Math.max(0, ol.qty - ol.received) : null;
      return h('li', { 'data-item': itemId },
        h('div', { class: 'sto-line-head' }, h('b', {}, it?.name || itemId), h('span', { class: 'meta' }, `${it?.unit || ''}${left != null ? ` · ${left} on the order` : ''}`)),
        h('div', { class: 'sto-line-acts' },
          stepper({ get: () => ui.lines.get(itemId) ?? null, set: (v) => { ui.lines.set(itemId, v); label(); }, label: `${it?.name || itemId}, how many arrived` }),
          left ? h('button', { type: 'button', class: 'btn btn-ghost btn-small', onclick: (e) => { ui.lines.set(itemId, left); e.currentTarget.parentElement.querySelector('.sto-num').value = String(left); label(); } }, `As ordered (${left})`) : null,
          o ? null : h('button', { type: 'button', class: 'btn btn-ghost btn-small', onclick: () => { ui.lines.delete(itemId); draw(); } }, 'Remove')));
    });
    const addSel = h('select', { id: 'rcv-add', 'data-test': 'rcv-add' }, h('option', { value: '' }, 'Add an item'), shared.items.items.filter((it) => !ui.lines.has(it.id)).map((it) => h('option', { value: it.id }, `${it.name} (${it.unit})`)));
    addSel.addEventListener('change', () => { if (addSel.value) { ui.lines.set(addSel.value, null); draw(); box.querySelector(`[data-item="${addSel.value}"] .sto-num`)?.focus(); } });
    label();
    setKids(box,
      offlineNote('a delivery'),
      h('div', { class: 'card sto-form' },
        h('div', { class: 'field' }, h('span', { class: 'label', id: 'rcv-src' }, 'Where did it come from?'), h('div', { class: 'sto-choices', role: 'group', 'aria-labelledby': 'rcv-src' }, SOURCES.map(choice))),
        ui.source === 'Purchase' ? h('div', { class: 'field' }, h('label', { for: 'rcv-order' }, 'Which order is it for?'),
          placeSelect('rcv-order', [...open.map((x) => [x.id, `${x.lines.slice(0, 2).map((l) => l.itemName).join(', ')}${x.lines.length > 2 ? ` and ${x.lines.length - 2} more` : ''} (${ordName(x.id)}, ${x.stateName.toLowerCase()})`]), ['none', 'No order on the list']],
            { blank: 'Choose the order', value: ui.orderId, onchange: pickOrder })) : null,
        shared.stores.length > 1 ? h('div', { class: 'field' }, h('label', { for: 'rcv-place' }, 'Into which store?'), placeSelect('rcv-place', shared.stores.map((s) => [s.id, s.name]), { blank: 'Choose the store', value: ui.placeId, onchange: (v) => { ui.placeId = v; label(); } }))
          : h('p', { class: 'meta' }, `Into: ${shared.stores[0].name}`),
        rows.length ? h('ul', { class: 'sto-lines' }, rows) : null,
        o ? null : h('div', { class: 'field' }, h('label', { for: 'rcv-add' }, rows.length ? 'Anything else that arrived?' : 'What arrived?'), addSel),
        save,
        ui.msg ? h('p', { class: 'sto-status', role: 'status', 'data-test': 'receive-result' }, ui.msg) : null,
        h('p', { class: 'meta' }, 'Count what arrived, not what the paperwork says. This records the receipt only: it approves nothing and keeps no price or supplier.')),
      open.length ? h('section', { class: 'section', 'aria-labelledby': 'rcv-exp-h' }, h('h2', { id: 'rcv-exp-h' }, `Open orders (${open.length})`),
        h('p', { class: 'meta' }, 'Approved or later, with what is still to come on each.'),
        h('ul', { class: 'sto-plain', 'data-test': 'rcv-open' }, open.map((x) => h('li', { 'data-order': x.id }, h('b', {}, x.lines.filter((l) => l.toCome > 0).map((l) => `${l.itemName} ${l.toCome}`).join(', ')), ` · ${ordName(x.id)} · ${x.waitingFor.toLowerCase()} · ${daysText(x.daysAtStep)}`)))) : null);
  }
  return { el: box, load };
}

// ---------------------------------------------------------------- Order tracker
function ordersScreen(ctx, shared) {
  const box = h('div', { class: 'sto-orders' });
  const mayRequest = STEP_ROLES.requested.includes(ctx.role);
  const ui = { open: new Set(), lines: new Map(), cancel: new Map(), msg: null };
  // #/stores/orders/new/<item>: the form opens with that item on it; the person sets how many and saves.
  if (mayRequest && ctx.rest[1] === 'new' && shared.item.has(ctx.rest[2])) { ui.lines.set(ctx.rest[2], null); ui.open.add('new'); }
  const props = proposalsCard(ctx, { match: matchMine, describe: (p) => describe(p, shared) });
  let data = null;
  const load = async () => {
    const [open, done, ov] = await Promise.all([ctx.run('ospeli_stores_orders', { state: 'open', limit: 200 }), ctx.run('ospeli_stores_orders', { state: 'all', limit: 30 }), ctx.run('ospeli_stores_overview', { days: 30, format: 'short' })]);
    data = { open: open.orders, closed: done.orders.filter((o) => o.state === 'received' || o.state === 'cancelled').slice(0, 10), ov };
    draw();
    await props.load();
  };
  const act = actions(ctx, load);
  const newBtn = h('button', { class: 'btn', type: 'button', 'data-cmd': 'ospeli_stores_order_step', 'data-test': 'order-new-save' });
  const newLabel = () => { const n = [...ui.lines.values()].filter((v) => v > 0).length; newBtn.textContent = n ? `Request this order (${plural(n, 'item')})` : 'Add an item and how many first'; };
  newBtn.addEventListener('click', () => {
    const lines = [...ui.lines].filter(([, v]) => v > 0).map(([itemId, qty]) => ({ itemId, qty }));
    if (!lines.length) return;
    act('ospeli_stores_order_step', { step: 'requested', lines }, (out) => `${ordName(out.orderId)} requested: it waits for approval`, { onDone: () => { ui.lines.clear(); ui.open.delete('new'); } });
  });

  function newOrder() {
    const sel = h('select', { id: 'ord-add', 'data-test': 'ord-add' }, h('option', { value: '' }, 'Add an item'), shared.items.items.filter((it) => !ui.lines.has(it.id)).map((it) => h('option', { value: it.id }, `${it.name} (${it.unit})`)));
    sel.addEventListener('change', () => { if (sel.value) { ui.lines.set(sel.value, null); draw(); } });
    newLabel();
    return keepOpen(ui.open, 'new', 'Request a new order', h('div', { class: 'sto-form' },
      h('ul', { class: 'sto-lines' }, [...ui.lines.keys()].map((itemId) => h('li', { 'data-item': itemId }, h('div', { class: 'sto-line-head' }, h('b', {}, shared.item.get(itemId)?.name || itemId), h('span', { class: 'meta' }, shared.item.get(itemId)?.unit || '')),
        h('div', { class: 'sto-line-acts' }, stepper({ get: () => ui.lines.get(itemId) ?? null, set: (v) => { ui.lines.set(itemId, v); newLabel(); }, label: `${shared.item.get(itemId)?.name}, how many to order` }),
          h('button', { type: 'button', class: 'btn btn-ghost btn-small', onclick: () => { ui.lines.delete(itemId); draw(); } }, 'Remove'))))),
      h('div', { class: 'field' }, h('label', { for: 'ord-add' }, 'Item'), sel), newBtn,
      h('p', { class: 'meta' }, `Items and quantities only: no price or supplier is kept. It then waits for approval by ${roleNames(STEP_ROLES.approved)}.`)), { class: 'card sto-new', 'data-test': 'order-new' });
  }
  function draw() {
    const remind = new Map(data.ov.guide.suggestions.filter((s) => s.rule === 'order-waiting').map((s) => [s.action?.inputs[0].orderId || s.id.split(':')[1], s]));
    const forMe = (data.ov.reminders || []).filter((r) => r.roles.includes(ctx.role));
    setKids(box,
      props.el,
      forMe.length ? h('div', { class: 'card notice', 'data-test': 'reminders' }, forMe.map((r) => h('p', {}, h('b', {}, `Reminder: ${ordName(r.orderId)}`), ` ${r.waitingFor.toLowerCase()} (sent by ${roleName(r.byRole)}, ${when(r.at)}).`))) : null,
      h('p', { class: 'meta' }, `Ospeli records each step; people approve purchases (${roleNames(STEP_ROLES.approved)}). "Received" is recorded when the delivery is received into stock against the order.`),
      mayRequest ? newOrder() : null,
      h('section', { class: 'section', 'aria-labelledby': 'ord-open-h' }, h('h2', { id: 'ord-open-h' }, `Open orders (${data.open.length})`),
        data.open.length ? h('ul', { class: 'sto-order-list', 'data-test': 'orders' }, data.open.map((o) => orderCard(ctx, shared, o, { ui, act, remind: remind.get(o.id), guideOn: data.ov.guide.on })))
          : h('p', { class: 'card sto-empty', 'data-test': 'orders-empty' }, 'No order is open. An order starts when a storekeeper or the supply chain manager requests one.')),
      data.closed.length ? h('section', { class: 'section', 'aria-labelledby': 'ord-done-h' }, h('h2', { id: 'ord-done-h' }, 'Recently closed'),
        h('ul', { class: 'sto-plain' }, data.closed.map((o) => h('li', { 'data-order': o.id }, h('b', {}, ordName(o.id)), ` ${o.stateName.toLowerCase()}${o.cycleDays != null ? ` ${daysText(o.cycleDays)} after it was requested` : ''} · ${o.lines.slice(0, 3).map((l) => `${l.itemName} ${l.received}/${l.qty}`).join(', ')}${o.lines.length > 3 ? ` and ${o.lines.length - 3} more` : ''}`)))) : null);
  }
  return { el: box, load };
}
// One order: what, where it is, its steps with days at each, and the buttons for this role.
function orderCard(ctx, shared, o, { ui, act, remind, guideOn, compact = false }) {
  const mine = (o.nextSteps || []).filter((s) => s.step !== 'cancelled' && s.roles.includes(ctx.role));
  const mayCancel = (o.nextSteps || []).some((s) => s.step === 'cancelled' && s.roles.includes(ctx.role));
  const stepWords = { approved: 'Approve', ordered: 'Mark ordered', delivered: 'Mark delivered' };
  const reason = h('select', { 'aria-label': `Why cancel ${ordName(o.id)}` }, h('option', { value: '' }, 'Choose why'), ['No longer needed', 'Ordered another way', 'Asked for by mistake', 'Other'].map((r) => h('option', { value: r }, r)));
  reason.value = ui.cancel.get(o.id) || '';
  reason.addEventListener('change', () => ui.cancel.set(o.id, reason.value));
  const record = (step) => act('ospeli_stores_order_step', { step, orderId: o.id, expectedStep: o.state }, `${ordName(o.id)}: ${STEP_NAMES[step].toLowerCase()} recorded`);
  const what = `${o.lines.slice(0, 3).map((l) => `${l.itemName} ${l.qty}`).join(', ')}${o.lines.length > 3 ? ` and ${o.lines.length - 3} more` : ''}`;
  const toCome = o.state === 'part-received' ? o.lines.filter((l) => l.toCome > 0) : [];
  return h('li', { class: `sto-order${guideOn && o.overUsual ? ' is-late' : ''}`, 'data-order': o.id, 'data-state': o.state },
    h('div', { class: 'sto-order-head' },
      h('p', {}, h('b', {}, what)),
      h('p', {}, h('span', { class: 'meta' }, `${ordName(o.id)} `), h('span', { class: `chip sto-state is-${o.state}` }, o.stateName), guideOn && o.overUsual ? h('span', { class: 'chip sto-late', 'data-test': 'over-usual' }, 'Longer than usual') : null),
      h('p', { class: 'sto-wait' }, `${o.waitingFor} · ${daysText(o.daysAtStep)}`),
      toCome.length ? h('p', { class: 'meta', 'data-test': 'to-come' }, `Still to come: ${toCome.map((l) => `${l.itemName} ${l.toCome} of ${l.qty}`).join(', ')}`) : null,
      o.overReceived ? h('p', { class: 'sto-fact', 'data-test': 'over-received' }, `More received than ordered: ${o.lines.filter((l) => l.over).map((l) => `${l.itemName} ${l.received} of ${l.qty}`).join(', ')}. Check the delivery note.`) : null),
    compact ? null : h('ol', { class: 'sto-steps', 'aria-label': `Steps of ${ordName(o.id)}` }, o.steps.map((s) => h('li', { class: s.at ? (s.current ? 'is-now' : 'is-done') : null, 'data-step': s.step },
      h('b', {}, s.name), ' ', s.at ? `${day(s.at)}${s.days != null ? ` · ${daysText(s.days)}${s.current ? ' so far' : ''}` : ''}` : (o.state === 'received' && s.step !== 'received' ? 'not recorded' : '')))),
    h('div', { class: 'sto-acts' },
      mine.map((s) => h('button', { class: `btn btn-small${s.step === 'approved' ? ' sto-approve' : ''}`, type: 'button', 'data-cmd': 'ospeli_stores_order_step', 'data-step': s.step, onclick: () => record(s.step) }, stepWords[s.step])),
      ['ordered', 'delivered', 'part-received'].includes(o.state) && can(ctx.role, 'ospeli_stock_receive') ? h('a', { class: 'btn btn-ghost btn-small', href: `#/stores/receive/${o.id}` }, 'Receive into stock') : null,
      remind?.action && can(ctx.role, 'ospeli_stores_order_remind') ? h('button', { class: 'btn btn-ghost btn-small', type: 'button', 'data-cmd': 'ospeli_stores_order_remind', 'data-test': 'remind',
        onclick: () => act('ospeli_stores_order_remind', remind.action.inputs[0], `Reminder sent to ${roleNames(o.waitingForRoles)}: ${ordName(o.id)}`) }, remind.action.label) : null,
      remind && !remind.action ? h('span', { class: 'meta' }, 'Reminder sent in the last day.') : null),
    mayCancel && !compact ? keepOpen(ui.open, `cancel:${o.id}`, o.state === 'part-received' ? 'Cancel the rest of this order' : 'Cancel this order', h('div', { class: 'sto-acts' }, reason,
      h('button', { class: 'btn btn-ghost btn-small', type: 'button', 'data-cmd': 'ospeli_stores_order_step', onclick: () => { if (!reason.value) { ctx.toast('Choose why first'); return; } act('ospeli_stores_order_step', { step: 'cancelled', orderId: o.id, expectedStep: o.state, reason: reason.value }, `${ordName(o.id)} cancelled (${reason.value.toLowerCase()})`); } }, o.state === 'part-received' ? 'Cancel the rest' : 'Cancel order')), { class: 'sto-more' }) : null);
}

// ---------------------------------------------------------------- Stock-out log
function outsScreen(ctx, shared) {
  const box = h('div', { class: 'sto-outs' });
  const mayStart = can(ctx.role, 'ospeli_stock_out_start');
  const mayEnd = can(ctx.role, 'ospeli_stock_out_end');
  // A ward nurse sees her own ward first (the ward saved on the count screen), with a way to all wards.
  const ui = { cause: new Map(), open: new Set(), ward: ctx.role === 'ward-nurse' ? store.get('ospeli-stores-ward') || '' : '', all: false, wardName: '' };
  let data = null;
  const load = async () => {
    const mine = ui.ward && !ui.all;
    try { data = await ctx.run('ospeli_stock_outs', { category: 'supplies', state: 'all', limit: 100, ...(mine ? { placeId: ui.ward } : {}) }); } catch { ui.ward = ''; data = await ctx.run('ospeli_stock_outs', { category: 'supplies', state: 'all', limit: 100 }); }
    if (ui.ward && !ui.wardName) ui.wardName = (await ctx.run('ospeli_stock_levels', { placeId: ui.ward, format: 'short', limit: 1 })).levels[0]?.placeName || 'your ward';
    draw();
  };
  const act = actions(ctx, load);
  function draw() {
    const open = data.stockOuts.filter((s) => s.open);
    const ended = data.stockOuts.filter((s) => !s.open).slice(0, 20);
    const causes = shared.items.picks.stockOutCauses;
    setKids(box,
      offlineNote('a stock-out'),
      ui.ward ? h('div', { class: 'sto-acts', 'data-test': 'outs-scope' }, h('p', { class: 'meta' }, ui.all ? 'Showing every ward.' : `Showing ${ui.wardName}.`),
        h('button', { class: 'btn btn-ghost btn-small', type: 'button', 'data-test': 'outs-all', onclick: () => { ui.all = !ui.all; load(); } }, ui.all ? `Only ${ui.wardName}` : 'Show all wards')) : null,
      h('section', { class: 'section', 'aria-labelledby': 'out-open-h' }, h('h2', { id: 'out-open-h' }, `Out of stock now (${open.length})`),
        open.length ? h('ul', { class: 'sto-plain sto-out-list', 'data-test': 'outs-open' }, open.map((s) => h('li', { class: 'sto-out', 'data-out': s.id },
          h('p', {}, h('b', {}, s.itemName), ` at ${s.placeName}`),
          h('p', { class: 'meta' }, `Since ${when(s.startedAt)} · ${hoursText(s.hours)} · cause: ${s.cause}`),
          mayEnd ? [h('p', { class: 'sto-q' }, 'Is it back in stock? Close it and say whether care was affected (yes or no, nothing about any patient):'),
            h('div', { class: 'sto-acts' },
              h('button', { class: 'btn btn-small', type: 'button', 'data-cmd': 'ospeli_stock_out_end', 'data-care': 'yes', onclick: () => act('ospeli_stock_out_end', { stockOutId: s.id, careAffected: true }, `Stock-out closed: ${s.itemName}, ${s.placeName}, care was affected`) }, 'Back in stock: care was affected'),
              h('button', { class: 'btn btn-small', type: 'button', 'data-cmd': 'ospeli_stock_out_end', 'data-care': 'no', onclick: () => act('ospeli_stock_out_end', { stockOutId: s.id, careAffected: false }, `Stock-out closed: ${s.itemName}, ${s.placeName}, care not affected`) }, 'Back in stock: care not affected'))] : null)))
          : h('p', { class: 'meta', 'data-test': 'outs-none' }, 'No stock-out is open.')),
      data.notDeclared.length ? h('section', { class: 'section', 'aria-labelledby': 'out-nd-h' }, h('h2', { id: 'out-nd-h' }, `Nothing usable, no stock-out declared (${data.notDeclared.length})`),
        h('p', { class: 'meta' }, 'A count of zero does not start a stock-out by itself. A person checks and declares it, with the cause.'),
        h('ul', { class: 'sto-plain', 'data-test': 'not-declared' }, data.notDeclared.map((x) => {
          const key = `${x.itemId}@${x.placeId}`;
          const sel = h('select', { 'aria-label': `Cause: ${x.itemName} at ${x.placeName}` }, h('option', { value: '' }, 'Choose the cause'), causes.map((c) => h('option', { value: c }, c)));
          sel.value = ui.cause.get(key) || '';
          sel.addEventListener('change', () => ui.cause.set(key, sel.value));
          return h('li', { 'data-item': x.itemId, 'data-place': x.placeId }, h('p', {}, h('b', {}, x.itemName), ` at ${x.placeName}, nothing usable since ${when(x.since)}`),
            mayStart ? h('div', { class: 'sto-acts' }, sel, h('button', { class: 'btn btn-small', type: 'button', 'data-cmd': 'ospeli_stock_out_start',
              onclick: () => { if (!sel.value) { ctx.toast('Choose the cause first'); return; } act('ospeli_stock_out_start', { itemId: x.itemId, placeId: x.placeId, cause: sel.value }, `Stock-out started: ${x.itemName}, ${x.placeName} (${sel.value.toLowerCase()})`); } }, 'Start stock-out')) : null);
        }))) : null,
      mayStart || mayEnd ? null : h('p', { class: 'meta', 'data-test': 'read-only' }, `${roleName(ctx.role)} can see the log. Stock-outs are started and closed by ${roleNames(commandByName('ospeli_stock_out_start').roles)}.`),
      h('section', { class: 'section', 'aria-labelledby': 'out-end-h' }, h('h2', { id: 'out-end-h' }, 'Closed'),
        ended.length ? h('ul', { class: 'sto-plain', 'data-test': 'outs-ended' }, ended.map((s) => h('li', { 'data-out': s.id }, h('b', {}, s.itemName), ` at ${s.placeName}: ${day(s.startedAt)}, ${hoursText(s.hours)}, ${s.cause.toLowerCase()}, care ${s.careAffected ? 'affected' : 'not affected'}`)))
          : h('p', { class: 'meta' }, 'None closed yet.')));
  }
  return { el: box, load };
}

// ---------------------------------------------------------------- Supplies overview (supply chain manager)
function manageScreen(ctx, shared) {
  const box = h('div', { class: 'sto-manage' });
  const mayLevel = can(ctx.role, 'ospeli_stock_level_set');
  const ui = { open: new Set(), cancel: new Map(), level: new Map(), showAll: false, form: { place: '', item: '', level: null }, add: { name: '', unit: '', tracer: false }, move: { from: '', to: '', item: '', qty: null }, msg: new Map() };
  const props = proposalsCard(ctx, { match: matchMine, describe: (p) => describe(p, shared) });
  let data = null;
  const load = async () => {
    const [ov, levels, orders, reqs, items, outs] = await Promise.all([
      ctx.run('ospeli_stores_overview', { days: 30 }), ctx.run('ospeli_stock_levels', { category: 'supplies', format: 'short', limit: 500 }),
      ctx.run('ospeli_stores_orders', { state: 'open', limit: 200 }), ctx.run('ospeli_stock_requests', { state: 'waiting', limit: 200 }), ctx.run('ospeli_stock_items', { category: 'supplies', limit: 500 }),
      ctx.run('ospeli_stock_outs', { category: 'supplies', state: 'open', limit: 200 })]);
    for (const r of levels.levels) shared.names.set(r.placeId, r.placeName);
    shared.items = items; shared.item = new Map(items.items.map((it) => [it.id, it]));
    data = { ov, levels: levels.levels, orders: orders.orders, reqs: reqs.requests, outs: outs.stockOuts };
    draw();
    await props.load();
  };
  const act = actions(ctx, load);
  const places = () => [...shared.stores.map((s) => [s.id, s.name]), ...placesOf(data.levels, shared.stores)];

  // A suggestion never saves on one tap: it fills in the form, and the person checks it and saves.
  function follow(s) {
    const i = s.action.inputs[0];
    if (s.action.command === 'ospeli_stock_level_set') { ui.form = { place: i.placeId, item: i.itemId, level: i.level }; ui.open.add('tool:level'); }
    else if (s.action.command === 'ospeli_stock_transfer') { ui.move = { from: i.fromPlaceId, to: i.toPlaceId, item: i.lines[0].itemId, qty: i.lines[0].qty }; ui.open.add('tool:move'); }
    draw();
    const target = box.querySelector(s.action.command === 'ospeli_stock_level_set' ? '[data-test="tool-level"]' : '[data-test="tool-move"]');
    target?.scrollIntoView({ block: 'start' });
    target?.querySelector('[data-cmd]')?.focus({ preventScroll: true });
  }
  function guideCard(g) {
    const mayToggle = can(ctx.role, 'ospeli_stores_guide_set');
    const button = (s) => {
      if (!s.action || !can(ctx.role, s.action.command)) return null;
      if (s.action.command === 'ospeli_stores_order_remind') {
        return h('button', { class: 'btn btn-small', type: 'button', 'data-cmd': s.action.command, 'data-test': 'follow',
          onclick: () => act(s.action.command, s.action.inputs[0], `Reminder sent: ${ordName(s.action.inputs[0].orderId)}`) }, s.action.label);
      }
      return h('button', { class: 'btn btn-small', type: 'button', 'data-test': 'follow', onclick: () => follow(s) },
        s.action.command === 'ospeli_stock_transfer' ? 'Fill in the move to check and record' : 'Fill in the level to check and save');
    };
    return h('section', { class: 'card sto-guide', 'data-test': 'guide', 'data-on': String(g.on), 'aria-labelledby': 'sto-guide-h' },
      h('div', { class: 'sto-guide-head' }, h('h2', { id: 'sto-guide-h' }, 'Guide'),
        mayToggle ? h('button', { class: 'btn btn-ghost btn-small sto-switch', type: 'button', 'aria-pressed': String(g.on), 'data-cmd': 'ospeli_stores_guide_set', 'data-test': 'guide-switch',
          onclick: () => act('ospeli_stores_guide_set', { on: !g.on }, `Guide switched ${g.on ? 'off' : 'on'}`) }, g.on ? 'Guide on: switch off' : 'Guide off: switch on') : null),
      g.on ? [
        h('p', { class: 'meta' }, 'Three fixed rules, not AI. They suggest; you decide. Nothing is saved until you check the form and tap Save.'),
        g.suggestions.length ? h('ul', { class: 'sto-sugg' }, g.suggestions.map((s) => h('li', { 'data-rule': s.rule, 'data-test': 'suggestion' },
          h('p', {}, h('b', {}, s.text)), h('p', { class: 'meta' }, s.why), button(s),
          keepOpen(ui.open, `why:${s.id}`, 'Why this rule', h('p', {}, s.basis), { class: 'sto-def' }))))
          : h('p', { 'data-test': 'no-suggestion' }, 'Nothing to suggest right now.'),
      ] : h('p', { 'data-test': 'guide-off' }, 'The guide is off. Counts, requests, orders and measures work the same.'),
      mayToggle ? null : h('p', { class: 'meta' }, `${roleNames(commandByName('ospeli_stores_guide_set').roles)} can switch the guide on or off.`));
  }
  const storeIds = () => new Set(shared.stores.map((s) => s.id));
  function levelEditor(r) {
    const key = `${r.itemId}@${r.placeId}`;
    const word = levelWord(storeIds().has(r.placeId));
    if (!ui.level.has(key)) ui.level.set(key, r.level);
    return keepOpen(ui.open, `lvl:${key}`, `Change the ${word}`, h('div', { class: 'sto-acts' },
      stepper({ get: () => ui.level.get(key) ?? null, set: (v) => ui.level.set(key, v), label: `${word}: ${r.itemName}, ${r.placeName}` }),
      h('button', { class: 'btn btn-small', type: 'button', 'data-cmd': 'ospeli_stock_level_set', 'data-test': 'level-save',
        onclick: () => { const v = ui.level.get(key); if (v == null) return; act('ospeli_stock_level_set', { itemId: r.itemId, placeId: r.placeId, level: v, expectedLevel: r.level ?? 0 }, `The ${word} of ${r.itemName} at ${r.placeName} is now ${v}`, { onDone: () => { ui.level.delete(key); ui.open.delete(`lvl:${key}`); } }); } }, `Save ${word}`)), { class: 'sto-more' });
  }
  // What is short: not every item under its top-up level (that is normal between top-ups and each
  // ward's count asks for it), only what needs a person to look (overview "short", example settings).
  function shortList() {
    const sh = data.ov.short;
    const KIND = { 'none-left': 'Nothing left', 'below-share': `Below ${Math.round(sh.share * 100)}% of its top-up level`, 'store-not-on-order': 'Store below its reorder level, not on order', 'request-waiting': `Request waiting more than ${sh.requestUsualHours} h` };
    const row = (x) => levelOf(x);
    const levelOf = (x) => data.levels.find((r) => r.placeId === x.placeId && r.itemId === x.itemId) || null;
    const shown = ui.showAll ? sh.lines : sh.lines.slice(0, 10);
    // The next step in one tap (it opens the screen; nothing is saved): the ward's open request or a
    // stock-out for a ward with none left, an order for a store item not on order.
    const link = (href, words) => h('a', { class: 'btn btn-ghost btn-small', href, 'data-test': 'short-next' }, words);
    const next = (x) => {
      if (x.kind === 'store-not-on-order') return STEP_ROLES.requested.includes(ctx.role) ? link(`#/stores/orders/new/${x.itemId}`, 'Request an order') : null;
      if (x.kind !== 'none-left') return null;
      const reqId = levelOf(x)?.openRequestId;
      if (reqId && screensFor(ctx.role).includes('requests')) return link('#/stores/requests', `See ${reqName(reqId)}`);
      if (data.outs.some((o) => o.open && o.itemId === x.itemId && o.placeId === x.placeId)) return link('#/stores/outs', 'Stock-out open: see the log');
      return can(ctx.role, 'ospeli_stock_out_start') ? link('#/stores/outs', 'Start a stock-out') : null;
    };
    return h('section', { class: 'section', 'aria-labelledby': 'sto-short-h', 'data-test': 'short' },
      h('h2', { id: 'sto-short-h' }, `What is short (${plural(sh.lines.length, 'line')})`),
      h('p', { class: 'meta' }, `${sh.note} Ordinary top-ups are on each ward's count.`),
      sh.lines.length ? h('ul', { class: 'sto-plain' }, shown.map((x) => h('li', { class: x.kind === 'none-left' ? 'is-zero' : null, 'data-kind': x.kind, 'data-item': x.itemId || null, 'data-place': x.placeId },
        h('p', {}, h('b', {}, x.itemName ? `${x.itemName}, ${x.placeName}` : x.placeName), ' ', h('span', { class: 'chip sto-kind' }, KIND[x.kind])),
        h('p', { class: 'meta' }, x.kind === 'request-waiting' ? `${reqName(x.requestId)} has waited ${hoursText(x.hours)}.` : `${x.usable} usable; ${levelWord(x.kind === 'store-not-on-order')} ${x.level} (${x.unit}).`),
        next(x), mayLevel && x.itemId && row(x) ? levelEditor(row(x)) : null))) : h('p', { class: 'meta', 'data-test': 'short-none' }, 'Nothing needs a look right now.'),
      sh.lines.length > 10 ? h('button', { class: 'btn btn-ghost btn-small', type: 'button', 'aria-expanded': String(ui.showAll), onclick: () => { ui.showAll = !ui.showAll; draw(); } }, ui.showAll ? 'Show the first 10' : `See all ${sh.lines.length}`) : null);
  }
  function stuckList() {
    const orders = data.orders.slice(0, 5);
    const reqs = data.reqs.slice(0, 3);
    return h('section', { class: 'section', 'aria-labelledby': 'sto-stuck-h', 'data-test': 'stuck' },
      h('h2', { id: 'sto-stuck-h' }, 'What is stuck'),
      h('p', { class: 'meta' }, 'Open orders, the longest at one step first, and the requests that have waited longest.'),
      orders.length ? h('ul', { class: 'sto-order-list' }, orders.map((o) => orderCard(ctx, shared, o, { ui, act, remind: data.ov.guide.suggestions.find((s) => s.rule === 'order-waiting' && s.action?.inputs[0].orderId === o.id), guideOn: data.ov.guide.on, compact: true })))
        : h('p', { class: 'meta' }, 'No order is open.'),
      reqs.length ? h('ul', { class: 'sto-plain' }, reqs.map((q) => h('li', { 'data-request': q.id }, h('b', {}, q.placeName), ` · ${reqName(q.id)} · waiting ${hoursText(q.waitHours)} · ${plural(q.lines.filter((l) => l.left > 0).length, 'item')}${q.canIssueInFull ? '' : ' · the store is short'}`))) : null,
      h('div', { class: 'sto-acts' }, h('a', { class: 'btn btn-ghost btn-small', href: '#/stores/orders' }, 'All orders'), h('a', { class: 'btn btn-ghost btn-small', href: '#/stores/requests' }, 'All requests')));
  }
  const fmtKpi = (k) => (k.value == null ? 'None yet' : k.unit === '%' ? percentText(k.value, k.numerator) : k.unit === 'hours' ? hoursText(k.value) : daysText(k.value));
  function kpiSection(ov) {
    const extra = (k) => (k.open != null ? `${plural(k.open, k.id === 'stores-order-cycle' ? 'order' : 'request')} not finished yet${k.longestOpen != null ? `, the longest ${k.unit === 'hours' ? hoursText(k.longestOpen) : daysText(k.longestOpen)} so far` : ''}.` : null);
    const sub = (k) => {
      if (k.id === 'stores-fill-rate') return `${k.numerator ?? 0} of ${k.denominator ?? 0} request lines issued in full in the end (after any part issues)`;
      if (k.id === 'stores-request-wait') return `Median of ${plural(k.n, 'request')}, from raised to issued from the store in full`;
      if (k.id === 'stores-order-cycle') return `Median of ${plural(k.n, 'order')}, from requested to the last receipt that completes it`;
      return `${k.numerator ?? 0} of ${k.denominator ?? 0} item-days with nothing usable. It sees zero only when a count or a movement records it.`;
    };
    const ids = storeIds();
    return h('section', { class: 'section', 'aria-labelledby': 'sto-kpi-h' },
      h('h2', { id: 'sto-kpi-h' }, `Measures, last ${ov.period.days} days`),
      h('p', { class: 'meta' }, 'Worked out from the record on this device. They count items, requests and orders, never a person.'),
      h('div', { class: 'sto-kpis' }, ov.kpis.map((k) => h('div', { class: 'card sto-kpi', 'data-kpi': k.id, 'data-n': k.n },
        h('p', { class: 'sto-kpi-name' }, k.name), h('p', { class: 'sto-kpi-value' }, fmtKpi(k)),
        h('p', { class: 'meta' }, sub(k)),
        extra(k) ? h('p', { class: 'meta' }, extra(k)) : null,
        (k.byArea || []).filter((x) => ids.has(x.placeId)).map((x) => h('p', { class: 'meta', 'data-test': 'store-line' }, `${x.placeName}: ${x.value == null ? 'none' : percentText(x.value, x.numerator)} (${x.numerator} of ${x.denominator} item-days)`)),
        k.byArea?.length ? keepOpen(ui.open, `area:${k.id}`, 'Each ward', h('ul', { class: 'sto-mini' }, k.byArea.filter((x) => !ids.has(x.placeId)).map((x) => h('li', {}, `${x.placeName}: ${x.value == null ? 'none' : percentText(x.value, x.numerator)} (${x.numerator} of ${x.denominator} item-days)`))), { class: 'sto-def' }) : null,
        keepOpen(ui.open, `def:${k.id}`, 'How it is counted', [h('p', {}, k.definition), h('p', {}, `Counts: ${k.counts}`), h('p', {}, `Leaves out: ${k.leavesOut}`), h('p', {}, `Source: ${k.source}`), h('p', {}, `Target: ${k.targetText}`)], { class: 'sto-def' })))));
  }
  function tools() {
    if (!mayLevel && !can(ctx.role, 'ospeli_stock_transfer') && !can(ctx.role, 'ospeli_stock_item_add')) return null;
    const itemOpts = shared.items.items.map((it) => [it.id, `${it.name} (${it.unit})`]);
    const nm = (id) => shared.names.get(id) || id; const it = (id) => shared.item.get(id)?.name || id;
    const f = ui.form; const a = ui.add; const m = ui.move;
    const msg = (k) => (ui.msg.get(k) ? h('p', { class: 'sto-status', role: 'status' }, ui.msg.get(k)) : null);
    const lvlBtn = h('button', { class: 'btn btn-small', type: 'button', 'data-cmd': 'ospeli_stock_level_set', 'data-test': 'set-level-save', onclick: () => {
      if (!f.place || !f.item || f.level == null) { ui.msg.set('lvl', 'Choose the place, the item and the level first.'); draw(); return; }
      const now = data.levels.find((r) => r.placeId === f.place && r.itemId === f.item)?.level ?? 0;
      const word = levelWord(storeIds().has(f.place));
      act('ospeli_stock_level_set', { itemId: f.item, placeId: f.place, level: f.level, expectedLevel: now }, `The ${word} of ${it(f.item)} at ${nm(f.place)} is now ${f.level}`,
        { onDone: () => { ui.msg.set('lvl', `Saved: ${word} ${f.level} for ${it(f.item)} at ${nm(f.place)}.`); ui.form = { place: f.place, item: '', level: null }; }, onError: (e) => ui.msg.set('lvl', `Not saved. ${e.message}`) });
    } }, 'Save level');
    const name = h('input', { type: 'text', id: 'add-name', maxlength: 60, autocomplete: 'off', value: a.name, 'data-test': 'add-name' });
    name.addEventListener('input', () => { a.name = name.value; });
    const addBtn = h('button', { class: 'btn btn-small', type: 'button', 'data-cmd': 'ospeli_stock_item_add', 'data-test': 'add-save', onclick: () => {
      if (a.name.trim().length < 2 || !a.unit) { ui.msg.set('add', 'Write the item\'s name and choose its unit first.'); draw(); return; }
      const label = a.name.trim();
      act('ospeli_stock_item_add', { name: label, unit: a.unit, category: 'supplies', tracer: a.tracer }, `Item added: ${label} (${a.unit})`, { onDone: () => { ui.msg.set('add', `Added: ${label}. Set its top-up level for each ward that keeps it, and the store's reorder level.`); ui.add = { name: '', unit: '', tracer: false }; }, onError: (e) => ui.msg.set('add', `Not saved. ${e.message}`) });
    } }, 'Add item');
    const tracer = h('input', { type: 'checkbox', id: 'add-tracer', checked: a.tracer || null });
    tracer.addEventListener('change', () => { a.tracer = tracer.checked; });
    // Records a move that has been made: the button says so, with the numbers.
    const moveBtn = h('button', { class: 'btn btn-small', type: 'button', 'data-cmd': 'ospeli_stock_transfer', 'data-test': 'move-save' });
    const moveLabel = () => { moveBtn.textContent = m.from && m.to && m.item && m.qty ? `Record: ${m.qty} moved from ${nm(m.from)} to ${nm(m.to)}` : 'Record a move that has been made'; };
    moveBtn.addEventListener('click', () => {
      if (!m.from || !m.to || !m.item || !m.qty) { ui.msg.set('move', 'Choose both places, the item and how many first.'); draw(); return; }
      const words = `Recorded: ${m.qty} (${shared.item.get(m.item)?.unit || ''}) of ${it(m.item)} moved from ${nm(m.from)} to ${nm(m.to)}`;
      act('ospeli_stock_transfer', { fromPlaceId: m.from, toPlaceId: m.to, lines: [{ itemId: m.item, qty: m.qty }] }, words, { onDone: () => { ui.msg.set('move', `${words}.`); ui.move = { from: '', to: '', item: '', qty: null }; }, onError: (e) => ui.msg.set('move', `Not saved. ${e.message}`) });
    });
    moveLabel();
    return h('section', { class: 'section', 'aria-labelledby': 'sto-tools-h' }, h('h2', { id: 'sto-tools-h' }, 'Levels, items and moves'),
      mayLevel ? keepOpen(ui.open, 'tool:level', 'Set a level', h('div', { class: 'sto-form' },
        h('div', { class: 'field' }, h('label', { for: 'lvl-place' }, 'Place'), placeSelect('lvl-place', places(), { blank: 'Choose the place', value: f.place, onchange: (v) => { f.place = v; } })),
        h('div', { class: 'field' }, h('label', { for: 'lvl-item' }, 'Item'), placeSelect('lvl-item', itemOpts, { blank: 'Choose the item', value: f.item, onchange: (v) => { f.item = v; } })),
        h('div', { class: 'field' }, h('span', { class: 'label' }, 'Level: the top-up level for a ward, the reorder level for the store (0 clears it)'), stepper({ get: () => f.level, set: (v) => { f.level = v; }, label: 'Level', test: 'level-input' })),
        lvlBtn, msg('lvl')), { class: 'card sto-tool', 'data-test': 'tool-level' }) : null,
      can(ctx.role, 'ospeli_stock_item_add') ? keepOpen(ui.open, 'tool:add', 'Add an item this site keeps', h('div', { class: 'sto-form' },
        h('div', { class: 'field' }, h('label', { for: 'add-name' }, 'Name of the thing (no brand, supplier or person)'), name),
        h('div', { class: 'field' }, h('label', { for: 'add-unit' }, 'Counted in'), placeSelect('add-unit', UNITS.map((u) => [u, u]), { blank: 'Choose the unit', value: a.unit, onchange: (v) => { a.unit = v; } })),
        h('label', { class: 'sto-check', for: 'add-tracer' }, tracer, ' A tracer item (watched as a sign of how well stock is kept)'),
        addBtn, msg('add')), { class: 'card sto-tool', 'data-test': 'tool-add' }) : null,
      can(ctx.role, 'ospeli_stock_transfer') ? keepOpen(ui.open, 'tool:move', 'Record a move between places', h('div', { class: 'sto-form' },
        h('p', { class: 'meta' }, 'For stock that has been moved: it leaves the first place and arrives at the second.'),
        h('div', { class: 'field' }, h('label', { for: 'mv-out' }, 'From'), placeSelect('mv-out', places(), { blank: 'Choose the place it left', value: m.from, onchange: (v) => { m.from = v; moveLabel(); } })),
        h('div', { class: 'field' }, h('label', { for: 'mv-in' }, 'To'), placeSelect('mv-in', places(), { blank: 'Choose the place it went', value: m.to, onchange: (v) => { m.to = v; moveLabel(); } })),
        h('div', { class: 'field' }, h('label', { for: 'mv-item' }, 'Item'), placeSelect('mv-item', itemOpts, { blank: 'Choose the item', value: m.item, onchange: (v) => { m.item = v; moveLabel(); } })),
        h('div', { class: 'field' }, h('span', { class: 'label' }, 'How many'), stepper({ get: () => m.qty, set: (v) => { m.qty = v; moveLabel(); }, label: 'How many were moved', test: 'move-input' })),
        moveBtn, msg('move')), { class: 'card sto-tool', 'data-test': 'tool-move' }) : null);
  }
  function draw() {
    const { ov } = data;
    const c = ov.counts; const sc = ov.short.counts;
    const forMe = (ov.reminders || []).filter((r) => r.roles.includes(ctx.role));
    setKids(box,
      props.el,
      ov.hasHistory ? null : h('p', { class: 'card notice', 'data-test': 'no-history' }, 'No supplies are held anywhere on this device yet: no level is set and nothing has been received. Set the top-up levels for each ward and the store\'s reorder levels below, and receive the store\'s stock, to start.'),
      forMe.length ? h('div', { class: 'card notice', 'data-test': 'reminders' }, forMe.map((r) => h('p', {}, h('b', {}, `Reminder: ${ordName(r.orderId)}`), ` ${r.waitingFor.toLowerCase()}. `, h('a', { class: 'sto-link', href: '#/stores/orders' }, 'Open the order tracker')))) : null,
      h('div', { class: 'stats sto-stats', 'data-test': 'stats' },
        h('div', { class: 'stat', 'data-stat': 'short' }, h('span', {}, 'Short now'), h('b', {}, String(sc.itemLines)), h('span', {}, `item lines in ${plural(sc.wards, 'ward')}${sc.noneLeft ? `, ${sc.noneLeft} with none left` : ''}${sc.storeLines ? `; ${sc.storeLines} store items not on order` : ''}`)),
        h('div', { class: 'stat', 'data-stat': 'requests' }, h('span', {}, 'Requests waiting'), h('b', {}, String(c.requestsWaiting)), h('span', {}, c.oldestWaitHours != null ? `oldest ${hoursText(c.oldestWaitHours)}` : 'none waiting')),
        h('div', { class: 'stat', 'data-stat': 'orders' }, h('span', {}, 'Open orders'), h('b', {}, String(c.ordersOpen)), h('span', {}, c.longestAtStepDays != null ? `longest at one step ${daysText(c.longestAtStepDays)}` : 'none open')),
        h('div', { class: 'stat', 'data-stat': 'outs' }, h('span', {}, 'Stock-outs open'), h('b', {}, String(c.stockOutsOpen)), h('span', {}, c.notDeclared ? `${c.notDeclared} more with nothing usable` : 'declared by a person'))),
      h('div', { class: 'sto-cols' }, h('div', {}, stuckList(), shortList()), h('div', {}, guideCard(ov.guide))),
      kpiSection(ov),
      tools(),
      h('p', { class: 'card meta notice', 'data-test': 'not-for' }, ov.note));
  }
  return { el: box, load };
}
