// Pharmacy operations: the screens. Every read and write goes through ctx.run, the same commands an
// agent would use, so the page works the same on a site's own server.
//   #/pharmacy/queue       Dispensing queue (pharmacy technician, pharmacist; phone first)
//   #/pharmacy/discharge   Discharge medicines (ward nurse, patient flow coordinator; phone first)
//   #/pharmacy/summary     Turnaround (pharmacy manager): time by stage and ward, the guide, move to front
// A request is a ward, a bed, a kind, a count of items and times: no medicine names, no doses, no
// typed text. Measures count requests and stages, never a technician or a pharmacist.
import { h, setKids, fmtWait, moduleStyle, redrawOnChange } from '../ui.js';
import { roleById } from '../../core/model.js';
import { commandByName } from '../../core/commands.js';
import { proposalsCard } from '../proposals.js';
import { SCREEN_TITLES, screensFor, shownOn, KINDS, PLANNED, MAX_ITEMS, UNDO_MINUTES } from './logic.js';

const can = (role, cmd) => !!commandByName(cmd)?.roles.includes(role);
const roleNames = (cmd) => (commandByName(cmd)?.roles || []).map((r) => roleById(r)?.name || r).join(', ');
const offline = () => document.documentElement.dataset.site === 'offline';
const LOCK_MS = 3e3; // after a step, the same request's next button waits this long
const CHIP_ITEMS = 6; // item counts with a chip of their own; More opens the rest up to MAX_ITEMS
const WARD_KEY = 'ospeli-pharmacy-ward'; // a convenience on this device only, never access control
const minText = (v) => (v == null ? 'None yet' : fmtWait(v));
const items = (n) => `${n} item${n === 1 ? '' : 's'}`;
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// Panels a person opened stay open when the page is drawn again (after a save here or in another tab).
const openPanels = new Set();
const detailsBox = (label, test, key, ...kids) => h('details', { class: 'ph-more', 'data-test': test, open: openPanels.has(key),
  ontoggle: (e) => { if (e.currentTarget.open) openPanels.add(key); else openPanels.delete(key); } }, h('summary', {}, label), ...kids);

export async function render(el, ctx) {
  await moduleStyle('pharmacy');
  const screens = screensFor(ctx.role);
  const screen = screens.includes(ctx.rest[0]) ? ctx.rest[0] : screens[0];
  const head = h('div', { class: 'page-head' }, h('div', {}, h('p', { class: 'eyebrow' }, 'Pharmacy operations'), h('h1', {}, SCREEN_TITLES[screen])));
  const tabs = h('nav', { class: 'ph-tabs', 'aria-label': 'Pharmacy operations' },
    screens.map((s) => h('a', { href: `#/pharmacy/${s}`, 'data-screen': s, 'aria-current': s === screen ? 'page' : null }, SCREEN_TITLES[s])));
  const view = { queue: queueScreen, discharge: dischargeScreen, summary: summaryScreen }[screen](ctx);
  // The shell moves the page's children into <main>, so the module's class goes on its own wrapper.
  const root = h('div', { class: 'mod-pharmacy ph', 'data-screen': screen, 'data-role': ctx.role }, head, tabs, view.el);
  el.append(root);
  await view.load();
  const off = redrawOnChange(ctx, () => view.load());
  const watch = new MutationObserver(() => view.draw?.());
  watch.observe(document.documentElement, { attributes: true, attributeFilter: ['data-site'] });
  const tick = setInterval(() => view.load(), 60e3); // keep the waits fresh
  return () => { off(); clearInterval(tick); watch.disconnect(); view.stop?.(); };
}

// One command for a person, safely: a second tap while the first runs does nothing.
function runner(ctx, reload) {
  let busy = false;
  return async function act(cmd, input, words, { onDone = null, onError = null } = {}) {
    if (busy) return null;
    busy = true;
    try {
      const out = await ctx.run(cmd, input);
      if (words) ctx.toast(words);
      if (onDone) onDone(out);
      return out;
    } catch (err) {
      if (onError && onError(err)) return null;
      // A double tap or another device got there first: say so, it is not an error to retry.
      ctx.toast(err.code === 'conflict' ? err.message : `Not saved. ${err.message}`);
      return null;
    } finally {
      busy = false;
      await reload();
    }
  };
}
const proposals = (ctx, screen) => proposalsCard(ctx, { match: (p) => shownOn(p).includes(screen), describe: describeProposal });
const offlineNote = () => (offline() ? h('p', { class: 'card notice ph-offline', role: 'status', 'data-test': 'offline' }, 'Not connected: the list is as last seen, and steps cannot be saved until the connection is back.') : null);
const plannedLine = (list) => h('p', { class: 'card notice ph-planned', 'data-test': 'planned' }, (list || []).map((x) => x.text).join(' · ') || 'Stock levels and expiry: planned');
// A row tapped on this visit keeps the tallest height it has had (an open More panel included) on
// every tap, so nothing below it slides up under the finger when a panel closes (review round 2).
const keepTallest = (px, id, li) => { if (li) px.set(id, Math.max(px.get(id) || 0, Math.round(li.getBoundingClientRect().height))); };
const notFor = (text) => h('p', { class: 'card meta notice', 'data-test': 'not-for' }, text);

function chipsFor(r) {
  return [
    h('span', { class: 'chip' }, r.kindName),
    r.urgent ? h('span', { class: 'chip ph-urgent', 'data-test': 'urgent' }, 'Urgent (ward\'s call)') : null,
    r.plannedName ? h('span', { class: 'chip' }, `Home ${r.plannedName.toLowerCase()}`) : null,
    r.front ? h('span', { class: 'chip ph-front', 'data-test': 'front-mark' }, 'Moved to the front by the manager') : null,
  ];
}
const stageClock = (r) => {
  const at = { raised: r.clocks.raised, started: r.clocks.started, checked: r.clocks.checked, ready: r.clocks.ready, collected: r.clocks.collected, cancelled: r.clocks.cancelled }[r.stage];
  return at ? `${r.stateName} ${at}` : r.stateName;
};

// ---------------------------------------------------------------- Dispensing queue (phone first)
function queueScreen(ctx) {
  const box = h('div', { class: 'ph-queue' });
  // lockUntil: the next button waits after a tap. Rows this person tapped keep their place for this
  // visit in the section they were tapped in (home), greyed once they are collected or cancelled, so
  // a row never slides up under a finger and a second tap never lands on another request.
  const ui = { lockUntil: new Map(), home: new Map(), lastIndex: new Map(), snap: new Map(), closedNow: new Map(), px: new Map() };
  let data = null; let flags = []; let timer = null;
  const props = proposals(ctx, 'queue');
  const mayStep = can(ctx.role, 'ospeli_pharmacy_request_step');
  const mayCheck = can(ctx.role, 'ospeli_pharmacy_request_check');
  const mayCollect = can(ctx.role, 'ospeli_pharmacy_request_collect');
  const mayCancel = mayStep && can(ctx.role, 'ospeli_pharmacy_request_cancel'); // the ward cancels on its own screen
  const manager = ctx.role === 'pharmacy-manager';
  const seesFlags = mayCheck || manager; // guide rule 2 goes to the pharmacist and the manager
  const load = async () => {
    data = await ctx.run('ospeli_pharmacy_queue_list', { limit: 300 });
    if (seesFlags) {
      const ov = await ctx.run('ospeli_pharmacy_overview', { format: 'short', days: 1 });
      flags = ov.guide.on ? ov.guide.suggestions.filter((s) => s.rule === 'waiting-too-long') : [];
    }
    draw();
    await props.load();
  };
  const act = runner(ctx, load);
  const siteClock = (ms) => { const m = Math.floor((((ms + (data?.offsetMinutes || 0) * 60e3) % 864e5) + 864e5) % 864e5 / 60e3); return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; };
  const hold = (e, r, section) => {
    if (!ui.home.has(r.id)) ui.home.set(r.id, section);
    ui.snap.set(r.id, r);
    keepTallest(ui.px, r.id, e.currentTarget.closest('li'));
  };
  const keepPx = (li, id) => { if (ui.px.has(id)) li.style.minHeight = `${ui.px.get(id)}px`; return li; };
  const closed = (r) => (out) => { if (out && ['collected', 'cancelled'].includes(out.state)) ui.closedNow.set(r.id, { state: out.state, atMs: Date.now() }); };
  const lockLeft = (r) => (ui.lockUntil.get(r.id) || 0) - Date.now();
  // The pharmacist sees the requests waiting for their check first.
  const sectionOf = (r) => (mayCheck && r.section === 'working' && r.state === 'started' ? 'check' : r.section);

  function stepButton(r, section, { cmd, input, label, cls, done, hint = null }) {
    const left = lockLeft(r);
    if (left > 0) { clearTimeout(timer); timer = setTimeout(draw, 500); }
    const b = h('button', { class: `btn ph-main ${cls}`, type: 'button', 'data-cmd': cmd, 'data-step': input.step || (cmd.endsWith('check') ? 'check' : 'collect'), 'data-test': 'main-action',
      disabled: offline() || left > 0, 'aria-label': `${label}: ${r.label}, ${r.kindName.toLowerCase()}`,
      onclick: (e) => {
        hold(e, r, section);
        e.currentTarget.disabled = true;
        ui.lockUntil.set(r.id, Date.now() + LOCK_MS);
        act(cmd, { requestId: r.id, expectedState: r.state, ...input }, done, { onDone: closed(r) });
      } }, label); // the label never counts down: a countdown invites a tap
    return h('div', { class: `ph-act ${cls}-at` }, b, hint ? h('p', { class: 'ph-hint', 'data-test': 'check-note' }, hint) : null);
  }
  function mainAction(r, section) {
    if (r.held) {
      return mayStep ? stepButton(r, section, { cmd: 'ospeli_pharmacy_request_step', input: { step: 'resume' }, label: 'Resume', cls: 'ph-resume', done: `${r.label}: resumed` })
        : h('p', { class: 'ph-wait-for' }, 'On hold');
    }
    // Made Ready here on this visit: no Collected button where Ready just was.
    if (r.state === 'ready' && ui.home.has(r.id) && ui.home.get(r.id) !== 'ready') return h('p', { class: 'ph-wait-for', 'data-test': 'ready-here' }, 'Ready: waiting for collection');
    switch (r.nextStep) {
      case 'start': return mayStep ? stepButton(r, section, { cmd: 'ospeli_pharmacy_request_step', input: { step: 'start' }, label: 'Start', cls: 'ph-start', done: `${r.label}: started` }) : null;
      case 'check': return mayCheck ? stepButton(r, section, { cmd: 'ospeli_pharmacy_request_check', input: {}, label: 'Checked', cls: 'ph-check', done: `${r.label}: checked`, hint: data.checkNote })
        : h('p', { class: 'ph-wait-for', 'data-test': 'waits-check' }, r.recheck ? 'Needs the pharmacist\'s check again' : 'Waiting for the pharmacist\'s check');
      case 'ready': return mayStep ? stepButton(r, section, { cmd: 'ospeli_pharmacy_request_step', input: { step: 'ready' }, label: 'Ready', cls: 'ph-ready', done: `${r.label}: ready for collection` }) : null;
      case 'collect': return mayCollect ? stepButton(r, section, { cmd: 'ospeli_pharmacy_request_collect', input: {}, label: 'Collected', cls: 'ph-collect', done: `${r.label}: collected` }) : null;
      default: return null;
    }
  }
  const undoText = (what) => `${what} tapped by mistake? Undo it within ${UNDO_MINUTES} minutes. The step and the undo both stay in the record.`;
  function more(r, section) {
    if (!mayStep && !(mayCheck && r.undo === 'checked')) return null;
    const off = offline();
    const btn = (cmd, input, label, { cls = 'btn-ghost', test = null, reason = null, done }) => h('button', { class: `btn ${cls} btn-small`, type: 'button', 'data-cmd': cmd, 'data-step': input.step || null,
      ...(reason ? { 'data-reason': reason } : {}), 'data-test': test, disabled: off,
      onclick: (e) => { hold(e, r, section); e.currentTarget.disabled = true; openPanels.delete(`more:${r.id}`);
        act(cmd, { requestId: r.id, ...(input.undo ? {} : { expectedState: r.state }), ...input }, done, { onDone: closed(r) }); } }, label);
    const kids = [];
    if (r.undo === 'checked' && mayCheck) kids.push(h('p', { class: 'ph-hint' }, undoText('Checked')), btn('ospeli_pharmacy_request_check', { undo: true }, 'Undo Checked', { test: 'undo', done: `${r.label}: Checked undone` }));
    if (mayStep && (r.undo === 'started' || r.undo === 'ready')) kids.push(h('p', { class: 'ph-hint' }, undoText(r.undo === 'started' ? 'Started' : 'Ready')), btn('ospeli_pharmacy_request_step', { step: 'undo' }, `Undo ${r.undo === 'started' ? 'Start' : 'Ready'}`, { test: 'undo', done: `${r.label}: step undone` }));
    if (mayStep && ['raised', 'started', 'checked'].includes(r.state)) {
      kids.push(h('p', { class: 'ph-label' }, 'Put on hold, because:'), h('div', { class: 'ph-reasons', 'data-test': 'hold-reasons' },
        Object.entries(data.picks.holdReasons).map(([k, v]) => btn('ospeli_pharmacy_request_step', { step: 'hold', reason: k }, v, { reason: k, done: `${r.label}: on hold (${v.toLowerCase()})` }))));
      if (r.state === 'checked') kids.push(h('p', { class: 'ph-hint' }, 'Held for stock or supply after Checked: on resume it goes back to Started and needs the pharmacist\'s check again.'));
    }
    if (mayCancel) {
      kids.push(h('div', { class: 'ph-cancel-box' }, h('p', { class: 'ph-label' }, 'Cancel the request, because:'), h('div', { class: 'ph-reasons', 'data-test': 'cancel-reasons' },
        Object.entries(data.picks.cancelReasons).map(([k, v]) => btn('ospeli_pharmacy_request_cancel', { reason: k }, v, { cls: 'btn-ghost ph-cancel-reason', reason: k, done: `${r.label}: cancelled (${v.toLowerCase()})` })))));
    }
    if (manager && r.state !== 'ready') kids.push(r.front ? btn('ospeli_pharmacy_request_step', { step: 'back' }, 'Back to the usual order', { test: 'back', done: `${r.label}: back in the usual order` }) : btn('ospeli_pharmacy_request_step', { step: 'front' }, 'Move to the front', { test: 'front', done: `${r.label}: moved to the front` }));
    return kids.length ? detailsBox('More', 'more', `more:${r.id}`, kids) : null;
  }
  function stageWords(r) {
    if (r.held) return `On hold: ${r.holdReasonName}, since ${r.clocks.held || `${fmtWait(r.sinceStepMinutes)} ago`}`;
    if (r.recheck && r.state === 'started') return `${stageClock(r)} · needs the pharmacist's check again`;
    return stageClock(r);
  }
  function row(r, section) {
    const flag = flags.find((f) => f.requestId === r.id);
    return keepPx(h('li', { class: `ph-row st-${r.state}${sectionOf(r) !== section ? ' is-moved' : ''}`, 'data-request': r.id, 'data-state': r.state, 'data-kind': r.kind, 'data-section': section },
      h('div', { class: 'ph-row-text' },
        h('p', { class: 'ph-who' }, h('b', {}, r.label)),
        h('p', { class: 'ph-chips' }, chipsFor(r)),
        h('p', { class: 'ph-line' }, `${items(r.items)} · waiting ${fmtWait(r.waitMinutes)}`),
        h('p', { class: `ph-st st-${r.state}`, 'data-test': 'stage' }, stageWords(r)),
        flag ? h('p', { class: 'ph-flag', 'data-test': 'flag' }, `No step for ${fmtWait(flag.minutes)} (guide: example limit, not a standard)`) : null),
      h('div', { class: 'ph-row-act' }, mainAction(r, section), more(r, section))), r.id);
  }
  // A request collected or cancelled here on this visit: it keeps its place, greyed, with its undo.
  function closedRow(r, section) {
    const c = ui.closedNow.get(r.id) || { state: 'collected', atMs: Date.now() };
    const fresh = Date.now() - c.atMs <= UNDO_MINUTES * 60e3;
    const cmd = c.state === 'collected' ? 'ospeli_pharmacy_request_collect' : 'ospeli_pharmacy_request_cancel';
    const what = c.state === 'collected' ? 'Collected' : 'Cancel';
    const li = h('li', { class: `ph-row is-done st-${c.state}`, 'data-request': r.id, 'data-state': c.state, 'data-kind': r.kind, 'data-section': section },
      h('div', { class: 'ph-row-text' }, h('p', { class: 'ph-who' }, h('b', {}, r.label)),
        h('p', { class: 'ph-st', 'data-test': 'stage' }, `${c.state === 'collected' ? 'Collected' : 'Cancelled'} ${siteClock(c.atMs)}. Kept here for this visit.`)),
      fresh && can(ctx.role, cmd) ? h('div', { class: 'ph-row-act' }, detailsBox(`${what} by mistake?`, 'undo-closed', `undo:${r.id}`,
        h('p', { class: 'ph-hint' }, undoText(what)),
        h('button', { class: 'btn btn-ghost btn-small', type: 'button', 'data-cmd': cmd, 'data-test': 'undo', disabled: offline(),
          onclick: (e) => { e.currentTarget.disabled = true; openPanels.delete(`undo:${r.id}`); ui.closedNow.delete(r.id);
            act(cmd, { requestId: r.id, undo: true }, `${r.label}: ${what.toLowerCase()} undone`); } }, `Undo ${what}`))) : null);
    return keepPx(li, r.id);
  }
  function draw() {
    if (!data) return;
    clearTimeout(timer);
    const all = new Map(data.requests.map((r) => [r.id, r]));
    const order = mayCheck ? ['check', 'working', 'on-hold', 'ready'] : ['working', 'on-hold', 'ready'];
    const lists = {};
    for (const sec of order) {
      const list = data.requests.filter((r) => sectionOf(r) === sec && !(ui.home.has(r.id) && ui.home.get(r.id) !== sec));
      const kept = [...ui.home].filter(([id, home]) => home === sec && !list.some((r) => r.id === id)).map(([id]) => id)
        .sort((a, b) => (ui.lastIndex.get(a) ?? 0) - (ui.lastIndex.get(b) ?? 0));
      for (const id of kept) {
        const r = all.get(id) || (ui.closedNow.has(id) ? { ...ui.snap.get(id), closedHere: true } : null);
        if (r) list.splice(Math.min(ui.lastIndex.get(id) ?? list.length, list.length), 0, r);
      }
      list.forEach((r, i) => ui.lastIndex.set(r.id, i));
      lists[sec] = list;
    }
    const draw1 = (r, sec) => (r.closedHere ? closedRow(r, sec) : row(r, sec));
    const c = data.counts;
    setKids(box,
      props.el,
      offlineNote(),
      h('div', { class: 'ph-counts', 'data-test': 'counts' },
        h('div', { class: 'stat', 'data-count': 'to-start' }, h('span', {}, 'To start'), h('b', {}, String(c.raised))),
        h('div', { class: 'stat', 'data-count': 'in-progress' }, h('span', {}, 'In progress'), h('b', {}, String(c.started + c.checked))),
        h('div', { class: 'stat', 'data-count': 'ready' }, h('span', {}, 'Ready'), h('b', {}, String(c.ready)))),
      mayCheck && lists.check.length ? h('section', { class: 'section ph-sec', 'aria-labelledby': 'ph-check-h' }, h('h2', { id: 'ph-check-h' }, `Waiting for your check (${lists.check.length})`),
        h('ol', { class: 'ph-rows', 'data-test': 'check-list' }, lists.check.map((r) => draw1(r, 'check')))) : null,
      mayCheck && lists.check.length ? h('h2', { class: 'ph-sec-h' }, 'Working order') : null,
      lists.working.length ? h('ol', { class: 'ph-rows', 'data-test': 'queue', 'aria-label': 'Working order' }, lists.working.map((r) => draw1(r, 'working')))
        : h('p', { class: 'ph-empty', 'data-test': 'queue-empty' }, 'Nothing else waiting to be dispensed.'),
      h('p', { class: 'ph-hint ph-note', 'data-test': 'order-note' }, data.orderNote),
      lists['on-hold'].length ? h('section', { class: 'section', 'aria-labelledby': 'ph-held-h' }, h('h2', { id: 'ph-held-h' }, `On hold (${lists['on-hold'].length})`), h('ol', { class: 'ph-rows', 'data-test': 'held' }, lists['on-hold'].map((r) => draw1(r, 'on-hold')))) : null,
      lists.ready.length ? h('section', { class: 'section', 'aria-labelledby': 'ph-ready-h' }, h('h2', { id: 'ph-ready-h' }, `Ready for collection (${lists.ready.length})`), h('ol', { class: 'ph-rows', 'data-test': 'ready' }, lists.ready.map((r) => draw1(r, 'ready')))) : null,
      mayStep || mayCheck || mayCollect ? null : h('p', { class: 'ph-hint', 'data-test': 'read-only' }, `${roleById(ctx.role)?.name || 'This role'} can see the queue. Steps are recorded by ${roleNames('ospeli_pharmacy_request_step')}; Checked by ${roleNames('ospeli_pharmacy_request_check')}.`),
      mayStep && !mayCheck ? h('p', { class: 'ph-hint' }, `Checked is recorded by ${roleNames('ospeli_pharmacy_request_check')}. Ready can only follow Checked.`) : null,
      plannedLine(),
      notFor(data.note));
  }
  return { el: box, load, draw, stop: () => clearTimeout(timer) };
}

// ---------------------------------------------------------------- Discharge medicines (the ward's phone)
function dischargeScreen(ctx) {
  const box = h('div', { class: 'ph-discharge' });
  let remembered = null;
  try { remembered = localStorage.getItem(WARD_KEY); } catch { remembered = null; }
  // stay: requests this person tapped keep their place in the list for this visit, greyed once closed.
  const ui = { ward: remembered, form: { bedId: null, planned: null, items: null, urgent: false }, other: { kind: null, items: null, urgent: false }, stay: new Set(), px: new Map() };
  let wards = null; let data = null;
  const props = proposals(ctx, 'discharge');
  const mayRaise = can(ctx.role, 'ospeli_pharmacy_request_raise');
  const mayCollect = can(ctx.role, 'ospeli_pharmacy_request_collect');
  const mayCancel = can(ctx.role, 'ospeli_pharmacy_request_cancel');
  const wardOnly = ctx.role === 'ward-nurse'; // the ward picks from its own cancel reasons
  const load = async () => {
    wards = await ctx.run('ospeli_pharmacy_ward_requests', { limit: 1 });
    if (ui.ward && !wards.wards.some((w) => w.id === ui.ward)) ui.ward = null;
    data = await ctx.run('ospeli_pharmacy_ward_requests', { ...(ui.ward ? { wardId: ui.ward } : {}), limit: 100 });
    draw();
    await props.load();
  };
  const act = runner(ctx, load);
  const pickWard = (id) => { ui.ward = id; ui.form = { bedId: null, planned: null, items: null, urgent: false }; try { if (id) localStorage.setItem(WARD_KEY, id); else localStorage.removeItem(WARD_KEY); } catch { /* a private window: the pick lasts this visit */ } load(); };
  // Chips for 1 to 6 (one tap), and More for 7 up to the cap (#161).
  const itemsSelect = (state, test) => {
    const more = state.more || (state.items || 0) > CHIP_ITEMS;
    const chip = (v, label, pressed, onclick) => h('button', { class: 'chip-btn', type: 'button', 'aria-pressed': String(pressed), 'data-items': v, onclick }, label);
    const chips = h('div', { class: 'ph-choices', role: 'group', 'aria-label': 'How many items', 'data-test': test },
      Array.from({ length: CHIP_ITEMS }, (_, i) => chip(String(i + 1), String(i + 1), !more && state.items === i + 1, () => { state.items = i + 1; state.more = false; draw(); })),
      chip('more', 'More', more, () => { state.more = true; if ((state.items || 0) <= CHIP_ITEMS) state.items = null; draw(); }));
    if (!more) return chips;
    const s = h('select', { class: 'ph-select', 'data-test': `${test}-more`, 'aria-label': 'How many items (more)' },
      h('option', { value: '' }, 'Pick a number'), Array.from({ length: MAX_ITEMS - CHIP_ITEMS }, (_, i) => i + CHIP_ITEMS + 1).map((n) => h('option', { value: String(n), selected: state.items === n }, String(n))));
    s.addEventListener('change', () => { state.items = s.value ? Number(s.value) : null; draw(); });
    return [chips, s];
  };
  const urgentToggle = (state) => h('button', { class: 'chip-btn ph-urgent-toggle', type: 'button', 'aria-pressed': String(state.urgent), 'data-test': 'urgent-toggle',
    onclick: () => { state.urgent = !state.urgent; draw(); } }, state.urgent ? 'Urgent (ward\'s call): yes' : 'Urgent (ward\'s call)? Tap if so');

  function dischargeForm() {
    const f = ui.form;
    const beds = data.beds;
    const missing = !f.bedId ? 'Pick the bed first' : !f.planned ? 'Pick when they go home' : !f.items ? 'Pick how many items' : null;
    return h('section', { class: 'card ph-form', 'data-test': 'ask-form', 'aria-labelledby': 'ph-ask-h' },
      h('h2', { id: 'ph-ask-h' }, 'Ask for discharge medicines'),
      h('p', { class: 'ph-label' }, 'Which bed?'),
      beds.length ? h('div', { class: 'ph-choices', role: 'group', 'aria-label': 'Which bed', 'data-test': 'beds' }, beds.map((b) => h('button', {
        class: 'chip-btn', type: 'button', 'aria-pressed': String(f.bedId === b.bedId), 'data-bed': b.bedId, disabled: Boolean(b.request),
        onclick: () => { f.bedId = b.bedId; draw(); } }, `${b.bedName}${b.request ? ' (asked)' : b.plannedDischarge ? ' · going home' : ''}`)))
        : h('p', { class: 'ph-hint' }, 'No bed on this ward has a patient on the bed board.'),
      h('p', { class: 'ph-label' }, 'When do they go home?'),
      h('div', { class: 'ph-choices', role: 'group', 'aria-label': 'When do they go home', 'data-test': 'planned-picks' }, Object.entries(PLANNED).map(([k, v]) => h('button', {
        class: 'chip-btn', type: 'button', 'aria-pressed': String(f.planned === k), 'data-planned': k, onclick: () => { f.planned = k; draw(); } }, v))),
      h('p', { class: 'ph-label ph-items' }, 'How many items?'), itemsSelect(f, 'items'),
      h('p', { class: 'ph-hint' }, `A count only, 1 to ${MAX_ITEMS} (a cap for the form, example setting, not a standard). Never what they are.`),
      urgentToggle(f),
      h('button', { class: 'btn ph-send', type: 'button', 'data-cmd': 'ospeli_pharmacy_request_raise', 'data-test': 'send', disabled: Boolean(missing) || offline(),
        onclick: (e) => {
          e.currentTarget.disabled = true;
          const input = { wardId: ui.ward, bedId: f.bedId, kind: 'discharge', priority: f.urgent ? 'urgent' : 'routine', planned: f.planned, items: f.items };
          const bed = beds.find((b) => b.bedId === f.bedId)?.bedName || 'the bed';
          act('ospeli_pharmacy_request_raise', input, `Asked: discharge medicines for ${bed}`, { onDone: () => { ui.form = { bedId: null, planned: null, items: null, urgent: false }; } });
        } }, missing || 'Ask the pharmacy'));
  }
  function otherForm() {
    const o = ui.other;
    const missing = !o.kind ? 'Pick what kind first' : !o.items ? 'Pick how many items' : null;
    return detailsBox('Other medicines request', 'other-form', 'other-form',
      h('div', { class: 'ph-choices', role: 'group', 'aria-label': 'What kind' }, ['ward-request', 'other'].map((k) => h('button', {
        class: 'chip-btn', type: 'button', 'aria-pressed': String(o.kind === k), 'data-kind': k, onclick: () => { o.kind = k; draw(); } }, KINDS[k]))),
      h('p', { class: 'ph-label ph-items' }, 'How many items?'), itemsSelect(o, 'other-items'),
      urgentToggle(o),
      h('button', { class: 'btn ph-send', type: 'button', 'data-cmd': 'ospeli_pharmacy_request_raise', 'data-test': 'send-other', disabled: Boolean(missing) || offline(),
        onclick: (e) => { e.currentTarget.disabled = true; act('ospeli_pharmacy_request_raise', { wardId: ui.ward, kind: o.kind, priority: o.urgent ? 'urgent' : 'routine', items: o.items }, `Asked: ${KINDS[o.kind].toLowerCase()}`, { onDone: () => { ui.other = { kind: null, items: null, urgent: false }; openPanels.delete('other-form'); } }); } },
      missing || 'Ask the pharmacy'));
  }
  function estimateLine(r) {
    if (r.state === 'ready') return h('p', { class: 'ph-ready-now', 'data-test': 'ready-now' }, `Ready for collection since ${r.clocks.ready}`);
    if (r.state === 'collected' || r.state === 'cancelled') return null;
    const e = r.estimate;
    if (!e || e.minutes == null) return h('p', { class: 'ph-hint', 'data-test': 'estimate' }, 'No estimate yet: too few recent requests of this kind on this ward.');
    if (e.late) return h('p', { class: 'ph-hint', 'data-test': 'estimate' }, 'Taking longer than most recent requests. Estimate from recent requests, not a promise.');
    return h('p', { class: 'ph-estimate', 'data-test': 'estimate' }, `May be ready about ${e.readyByText}. Estimate from recent requests, not a promise.`);
  }
  const hold = (e, r) => { ui.stay.add(r.id); keepTallest(ui.px, r.id, e.currentTarget.closest('li')); };
  const name = (r) => r.bedName || r.kindName;
  function rowActions(r) {
    const off = offline();
    const kids = [];
    if (r.state === 'ready' && mayCollect) {
      kids.push(h('button', { class: 'btn ph-main ph-collect', type: 'button', 'data-cmd': 'ospeli_pharmacy_request_collect', 'data-test': 'collect', disabled: off,
        onclick: (e) => { hold(e, r); e.currentTarget.disabled = true; act('ospeli_pharmacy_request_collect', { requestId: r.id, expectedState: 'ready' }, `${name(r)}: collected`); } }, 'Collected'));
    }
    // Undo a Collected or a Cancel tapped by mistake, within the window, by a role that may.
    const undoCmd = r.undo === 'collected' ? 'ospeli_pharmacy_request_collect' : r.undo === 'cancelled' ? 'ospeli_pharmacy_request_cancel' : null;
    if (undoCmd && can(ctx.role, undoCmd)) {
      const what = r.undo === 'collected' ? 'Collected' : 'Cancel';
      kids.push(detailsBox(`${what} by mistake?`, 'undo-closed', `undo:${r.id}`,
        h('p', { class: 'ph-hint' }, `Undo it within ${UNDO_MINUTES} minutes. The step and the undo both stay in the record.`),
        h('button', { class: 'btn btn-ghost btn-small', type: 'button', 'data-cmd': undoCmd, 'data-test': 'undo', disabled: off,
          onclick: (e) => { hold(e, r); e.currentTarget.disabled = true; openPanels.delete(`undo:${r.id}`); act(undoCmd, { requestId: r.id, undo: true }, `${name(r)}: ${what.toLowerCase()} undone`); } }, `Undo ${what}`)));
    }
    if (mayCancel && !['collected', 'cancelled'].includes(r.state)) {
      const reasons = Object.entries(data.picks.cancelReasons || {}).filter(([k]) => !wardOnly || data.picks.wardCancelReasons.includes(k));
      kids.push(detailsBox('Cancel this request', 'cancel', `cancel:${r.id}`,
        h('p', { class: 'ph-hint' }, 'Cancel only if the medicines are no longer needed now. Because:'),
        h('div', { class: 'ph-reasons', 'data-test': 'cancel-reasons' }, reasons.map(([k, v]) => h('button', { class: 'btn btn-ghost btn-small ph-cancel-reason', type: 'button', 'data-cmd': 'ospeli_pharmacy_request_cancel', 'data-reason': k, disabled: off,
          onclick: (e) => { hold(e, r); e.currentTarget.disabled = true; openPanels.delete(`cancel:${r.id}`); act('ospeli_pharmacy_request_cancel', { requestId: r.id, reason: k, expectedState: r.state }, `${name(r)}: cancelled (${v.toLowerCase()})`); } }, v)))));
    }
    return kids.length ? h('div', { class: 'ph-row-act' }, kids) : null;
  }
  function requestRow(r) {
    const done = ['collected', 'cancelled'].includes(r.state);
    const li = h('li', { class: `ph-row st-${r.state}${done ? ' is-done' : ''}`, 'data-request': r.id, 'data-state': r.state },
      h('div', { class: 'ph-row-text' },
        h('p', { class: 'ph-who' }, h('b', {}, name(r)), r.bedName ? h('span', {}, r.kindName) : null),
        h('p', { class: 'ph-chips' }, chipsFor({ ...r, kindName: null }).filter((x) => x && x.textContent)),
        r.state === 'ready' && !r.held ? null : h('p', { class: `ph-st st-${r.state}`, 'data-test': 'stage' }, r.held ? `On hold: ${r.holdReasonName}` : r.state === 'cancelled' && r.cancelReasonName ? `${stageClock(r)}: ${r.cancelReasonName.toLowerCase()}` : stageClock(r)),
        h('p', { class: 'ph-line' }, r.state === 'raised' ? items(r.items) : `${items(r.items)} · raised ${r.clocks.raised}`),
        estimateLine(r)),
      rowActions(r));
    if (ui.px.has(r.id)) li.style.minHeight = `${ui.px.get(r.id)}px`;
    return li;
  }
  function draw() {
    if (!data) return;
    const wardPick = h('select', { class: 'ph-select ph-ward-select', id: 'ph-ward', 'data-test': 'wards' },
      [{ id: '', name: 'All wards' }, ...wards.wards].map((w) => h('option', { value: w.id, selected: (ui.ward || '') === w.id }, w.name)));
    wardPick.addEventListener('change', () => pickWard(wardPick.value || null));
    // A request tapped here stays in the open list for this visit, so the next one never slides under the finger.
    const isClosed = (r) => ['collected', 'cancelled'].includes(r.state);
    const open = data.requests.filter((r) => !isClosed(r) || ui.stay.has(r.id));
    const closed = data.requests.filter((r) => isClosed(r) && !ui.stay.has(r.id));
    const waiting = data.plannedDischarges;
    setKids(box,
      props.el,
      offlineNote(),
      h('label', { class: 'ph-label', for: 'ph-ward' }, 'Your ward'),
      wardPick,
      h('p', { class: 'ph-hint' }, 'Remembered on this device to save taps; any ward can be picked.'),
      mayRaise && ui.ward ? [dischargeForm(), otherForm()] : null,
      mayRaise && !ui.ward ? h('p', { class: 'card notice', 'data-test': 'pick-ward' }, 'Pick your ward to ask for medicines.') : null,
      h('section', { class: 'section', 'aria-labelledby': 'ph-mine-h' },
        h('h2', { id: 'ph-mine-h' }, `${ui.ward ? data.wardName : 'All wards'}: requests (${open.filter((r) => !isClosed(r)).length} open)`),
        open.length ? h('ol', { class: 'ph-rows', 'data-test': 'ward-requests' }, open.map(requestRow)) : h('p', { class: 'ph-empty' }, 'No open request.'),
        closed.length ? detailsBox(`Collected or cancelled in the last 24 hours (${closed.length})`, 'closed', `closed:${ui.ward || 'all'}`, h('ol', { class: 'ph-rows' }, closed.map(requestRow))) : null,
        h('p', { class: 'ph-hint', 'data-test': 'estimate-note' }, data.estimateNote)),
      waiting.length ? h('section', { class: 'section', 'aria-labelledby': 'ph-going-h', 'data-test': 'planned-discharges' },
        h('h2', { id: 'ph-going-h' }, `Planned discharges on the bed board (${waiting.length})`),
        h('ul', { class: 'ph-going' }, waiting.map((b) => h('li', { 'data-bed': b.bedId, 'data-medicines': b.request ? b.request.state : 'none' },
          h('b', {}, `${b.wardName}, ${b.bedName}`), ` · ${b.expectedText ? `going home ${b.expectedText.replace(/, .*$/, '')} · ` : ''}`,
          b.request ? `medicines: ${b.request.stateName.toLowerCase()}` : 'medicines not asked for yet')))) : null,
      mayRaise ? null : h('p', { class: 'ph-hint', 'data-test': 'read-only' }, `${roleById(ctx.role)?.name || 'This role'} can see the requests. Asking for medicines is for ${roleNames('ospeli_pharmacy_request_raise')}.`),
      notFor(data.note));
  }
  return { el: box, load, draw };
}

// ---------------------------------------------------------------- Turnaround (pharmacy manager)
function summaryScreen(ctx) {
  const box = h('div', { class: 'ph-summary' });
  let data = null;
  const props = proposals(ctx, 'summary');
  const manager = can(ctx.role, 'ospeli_pharmacy_guide_set');
  const load = async () => { data = await ctx.run('ospeli_pharmacy_overview', {}); draw(); await props.load(); };
  const act = runner(ctx, load);
  const kpi = (id) => data.kpis.find((k) => k.id === id);
  // The queue's 3 s wait for the manager's own buttons too (#161): a second tap on the same spot
  // never flips Move to the front, or the guide, straight back.
  const lockUntil = new Map(); let lockTimer = null;
  const locked = (key) => {
    const left = (lockUntil.get(key) || 0) - Date.now();
    if (left > 0) { clearTimeout(lockTimer); lockTimer = setTimeout(draw, Math.min(left + 20, 500)); }
    return left > 0;
  };
  const lock = (key) => lockUntil.set(key, Date.now() + LOCK_MS);

  function stagesCard() {
    const k = kpi('stage-times');
    const top = Math.max(1, ...k.stages.map((s) => s.value || 0));
    const longest = k.stages.find((s) => s.id === k.longest);
    return h('section', { class: 'card ph-stages', 'data-test': 'stages', 'aria-labelledby': 'ph-stages-h' },
      h('h2', { id: 'ph-stages-h' }, 'Where the time goes'),
      h('p', { class: 'ph-big', 'data-test': 'longest' }, longest ? `Most time: ${longest.name.toLowerCase()}, ${minText(longest.value)}` : 'No stage recorded in the period yet.'),
      h('ul', { class: 'ph-bars' }, k.stages.map((s) => h('li', { 'data-stage': s.id, class: s.id === k.longest ? 'is-longest' : null },
        h('span', { class: 'ph-bar-label' }, `${s.name}: ${minText(s.value)} (median of ${s.n})`),
        h('span', { class: 'ph-bar', 'aria-hidden': 'true' }, h('span', { style: `width:${Math.round(((s.value || 0) / top) * 100)}%` }))))),
      h('p', { class: 'ph-hint', 'data-test': 'stage-hint' }, 'Started to checked includes dispensing and the wait for the check, not the check alone.'),
      h('p', { class: 'ph-hint' }, `Last ${k.period.days} days, every kind of request, time on hold taken out.`));
  }
  function guideCard() {
    const g = data.guide;
    return h('section', { class: 'card ph-guide', 'data-test': 'guide', 'data-on': String(g.on), 'aria-labelledby': 'ph-guide-h' },
      h('div', { class: 'ph-guide-head' }, h('h2', { id: 'ph-guide-h' }, 'Guide'),
        manager ? h('button', { class: 'btn btn-ghost btn-small ph-switch', type: 'button', 'aria-pressed': String(g.on), 'data-cmd': 'ospeli_pharmacy_guide_set', 'data-test': 'guide-switch', disabled: offline() || locked('guide'),
          onclick: (e) => { e.currentTarget.disabled = true; lock('guide'); act('ospeli_pharmacy_guide_set', { on: !g.on }, `Guide ${g.on ? 'off' : 'on'}`); } }, g.on ? 'Guide on: switch off' : 'Guide off: switch on') : null),
      g.on ? [
        h('p', { class: 'ph-hint' }, 'Fixed rules, not AI. They suggest; people decide. They point at requests and wards, never at a person.'),
        g.suggestions.length ? h('ul', { class: 'ph-sugg' }, g.suggestions.map((s) => h('li', { 'data-rule': s.rule, 'data-test': 'suggestion' },
          h('p', {}, h('b', {}, s.text)), h('p', { class: 'ph-hint' }, s.why),
          h('details', { class: 'ph-def' }, h('summary', {}, 'Why this rule'), h('p', {}, s.basis)))))
          : h('p', { 'data-test': 'no-suggestion' }, 'Nothing to suggest right now.'),
      ] : h('p', { 'data-test': 'guide-off' }, 'The guide is off. The queue, the ward\'s view and the measures work the same.'),
      manager ? null : h('p', { class: 'ph-hint' }, `${roleNames('ospeli_pharmacy_guide_set')} can switch the guide on or off.`));
  }
  function oldestCard() {
    const mayFront = can(ctx.role, 'ospeli_pharmacy_request_step') && ctx.role === 'pharmacy-manager';
    return h('section', { class: 'section', 'aria-labelledby': 'ph-old-h' },
      h('h2', { id: 'ph-old-h' }, `Oldest open requests (${data.open} open)`),
      data.oldest.length ? h('ol', { class: 'ph-rows', 'data-test': 'oldest' }, data.oldest.map((r) => h('li', { class: `ph-row st-${r.state}`, 'data-request': r.id, 'data-state': r.state },
        h('div', { class: 'ph-row-text' }, h('p', { class: 'ph-who' }, h('b', {}, r.label)), h('p', { class: 'ph-chips' }, chipsFor(r)),
          h('p', { class: 'ph-line' }, `${items(r.items)} · waiting ${fmtWait(r.waitMinutes)} · ${r.held ? `on hold: ${r.holdReasonName}` : r.stateName.toLowerCase()}`)),
        mayFront && !r.held ? h('div', { class: 'ph-row-act' }, h('button', { class: `btn ${r.front ? 'btn-ghost' : ''} btn-small ph-front-btn`, type: 'button', 'data-cmd': 'ospeli_pharmacy_request_step', 'data-step': r.front ? 'back' : 'front', 'data-test': r.front ? 'back' : 'front', disabled: offline() || locked(r.id),
          onclick: (e) => { e.currentTarget.disabled = true; lock(r.id); act('ospeli_pharmacy_request_step', { requestId: r.id, step: r.front ? 'back' : 'front', expectedState: r.state }, `${r.label}: ${r.front ? 'back in the usual order' : 'moved to the front'}`); } },
        r.front ? 'Back to the usual order' : 'Move to the front')) : null)))
        : h('p', { class: 'ph-empty' }, 'Nothing open.'),
      mayFront ? h('p', { class: 'ph-hint' }, 'A request moved to the front shows "Moved to the front by the manager" on the queue, so nobody thinks the order is broken.') : null);
  }
  function wardsCard() {
    return h('section', { class: 'section', 'aria-labelledby': 'ph-wards-h' },
      h('h2', { id: 'ph-wards-h' }, 'By ward'),
      h('ul', { class: 'ph-ward-list', 'data-test': 'by-ward' }, data.byWard.map((w) => h('li', { class: 'card', 'data-ward': w.wardId },
        h('p', {}, h('b', {}, w.wardName)),
        h('p', { class: 'ph-line' }, `Open ${w.open}: to start ${w.counts.raised}, started ${w.counts.started}, checked ${w.counts.checked}, ready ${w.counts.ready}, on hold ${w.counts['on-hold']}`),
        h('p', { class: 'ph-line' }, `${w.oldestMinutes != null ? `Oldest waiting ${fmtWait(w.oldestMinutes)} · ` : ''}Discharge turnaround ${minText(w.turnaround.value)} (${w.turnaround.n})`)))));
  }
  function kpiSection() {
    const sub = (k) => {
      if (k.id === 'discharge-turnaround') {
        return [
          h('p', { class: 'ph-hint' }, `Median of ${plural(k.n, 'request', 'requests')} raised ${data.settings.workDay}. Raised outside those hours: ${minText(k.outsideWorkDay.value)} (${k.outsideWorkDay.n}).`),
          h('p', { class: 'ph-hint', 'data-test': 'hold-median' }, `Time on hold, taken out: median ${minText(k.hold.value)} for the ${plural(k.hold.n, 'request', 'requests')} held.`),
          h('p', { class: 'ph-hint', 'data-test': 'ready-before' }, `Ready before the planned time: ${k.readyBeforePlanned.numerator} of ${k.readyBeforePlanned.denominator}.`),
          h('ul', { class: 'ph-breakdown' }, k.byPlanned.filter((b) => b.n).map((b) => h('li', {}, `Home ${b.name.toLowerCase()}: ${minText(b.value)} (${b.n})`))),
        ];
      }
      if (k.id === 'stage-times') return h('p', { class: 'ph-hint' }, `The stage with the longest median, of ${k.stages.length} stages.`);
      return h('p', { class: 'ph-hint' }, `Median of ${plural(k.n, 'request', 'requests')} collected. Waiting for collection now: ${k.waitingNow}.`);
    };
    const val = (k) => (k.id === 'stage-times' && k.longest ? `${minText(k.value)}` : minText(k.value));
    return h('section', { class: 'section', 'aria-labelledby': 'ph-kpi-h' },
      h('h2', { id: 'ph-kpi-h' }, `Measures, last ${data.kpis[0].period.days} days`),
      h('p', { class: 'ph-hint' }, 'Worked out from the event log on this device. They count requests and stages, never a technician or a pharmacist.'),
      h('div', { class: 'ph-kpis' }, data.kpis.map((k) => h('div', { class: 'card ph-kpi', 'data-kpi': k.id, 'data-n': String(k.n ?? 0), 'data-value': k.value == null ? '' : String(Math.round(k.value)) },
        h('p', { class: 'ph-kpi-name' }, k.name), h('p', { class: 'ph-kpi-value' }, val(k)), sub(k),
        h('details', { class: 'ph-def' }, h('summary', {}, 'How it is counted'),
          h('p', {}, k.definition), h('p', {}, `Counts: ${k.counts}`), h('p', {}, `Out of: ${k.outOf}`), h('p', {}, `Leaves out: ${k.leavesOut}`), h('p', {}, `Source: ${k.source}`), h('p', {}, `Target: ${k.targetText}`))))));
  }
  function draw() {
    if (!data) return;
    const c = data.counts;
    setKids(box,
      props.el,
      offlineNote(),
      h('div', { class: 'ph-counts ph-counts-5', 'data-test': 'summary-counts' },
        [['raised', 'To start'], ['started', 'Started'], ['checked', 'Checked'], ['ready', 'Ready'], ['on-hold', 'On hold']].map(([k, w]) => h('div', { class: 'stat', 'data-count': k }, h('span', {}, w), h('b', {}, String(c[k]))))),
      h('div', { class: 'ph-grid' }, stagesCard(), guideCard()),
      oldestCard(),
      wardsCard(),
      kpiSection(),
      plannedLine(data.planned),
      h('p', { class: 'ph-hint' }, `Example settings, not standards: working day ${data.settings.workDay}; planned times ${data.settings.plannedTimes}; undo within ${data.settings.undoMinutes} min; guide limits ${data.settings.stallMinutes} min and ${data.settings.lateHour}:00.`),
      notFor(data.note));
  }
  return { el: box, load, draw };
}

function describeProposal(p) {
  const i = p.input || {};
  switch (p.command) {
    case 'ospeli_pharmacy_request_raise': return `Ask the pharmacy: ${(KINDS[i.kind] || 'a request').toLowerCase()} for ${i.bedId || i.wardId || 'a ward'}, ${i.items} items`;
    case 'ospeli_pharmacy_request_step': return `Request ${i.requestId}: ${({ start: 'start', ready: 'ready', hold: 'put on hold', resume: 'resume', cancel: 'cancel', front: 'move to the front', back: 'back to the usual order', undo: 'undo the last step' })[i.step] || 'a step'}`;
    case 'ospeli_pharmacy_request_check': return `Request ${i.requestId}: ${i.undo ? 'undo Checked' : 'record Checked'}`;
    case 'ospeli_pharmacy_request_collect': return `Request ${i.requestId}: collected`;
    default: return p.command.replace(/^ospeli_/, '').replace(/_/g, ' ');
  }
}
