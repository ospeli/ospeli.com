// Bed board: live bed state by ward, derived from the event log, with flow KPIs.
// Every tap runs a named command (core/commands.js), the same one an agent would call; the
// command re-checks the bed against the stored log before it appends anything (issue #9).
import { h } from './ui.js';
import { roleById } from '../core/model.js';
import { kpiContext, kpiTiles } from './kpi-tiles.js';
import {
  BED_STATES, OUT_OF_SERVICE_REASONS, ACTION_LABELS, deriveBoard, countStates, bedActions, since, encounterLabel,
} from '../core/beds.js';
import { ACTION_COMMANDS, commandByName } from '../core/commands.js';
import { proposalsCard } from './proposals.js';

const ACTION_BY_COMMAND = Object.fromEntries(Object.entries(ACTION_COMMANDS).map(([a, c]) => [c, a]));

const canDo = (role, action) => commandByName(ACTION_COMMANDS[action])?.roles.includes(role);

const BOARD_KPIS = ['occupancy', 'bed-turnaround', 'decision-to-bed', 'discharges-before-noon'];
const FILTERS = [
  ['all', 'All beds', () => true],
  ['available', 'Available', (b) => b.state === 'available'],
  ['clean', 'To clean', (b) => b.state === 'vacated' || b.state === 'cleaning'],
  ['going', 'Going home', (b) => b.state === 'expected-discharge'],
  ['occupied', 'Occupied', (b) => b.state === 'occupied' || b.state === 'expected-discharge'],
  ['oos', 'Out of service', (b) => b.state === 'out-of-service'],
];
const BED_EVENT = /^(bed\.|patient\.)/;
const fmtClock = (iso) => new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
const shortWard = (w) => w.name.replace(/\s*\(.*\)$/, '');

export async function render(el, ctx) {
  const { core } = ctx;
  const [wards, bedEntities] = await Promise.all([core.listEntities('ward'), core.listEntities('bed')]);
  if (!bedEntities.length) {
    el.append(h('div', { class: 'page-head' }, h('div', {}, h('p', { class: 'eyebrow' }, 'Bed board'), h('h1', {}, 'Bed board'))),
      h('div', { class: 'card notice' }, h('p', {}, 'No hospital is loaded on this device. Load Example General Hospital from ', h('a', { href: '#/home' }, 'Today'), ' or ', h('a', { href: '#/data' }, 'Data and audit'), '.')));
    return null;
  }
  const bedInfo = new Map(bedEntities.map((b) => [b.id, b]));
  const wardById = new Map(wards.map((w) => [w.id, w]));
  let events = await core.events();
  const ui = {
    ward: wardById.has(ctx.rest[0]) ? ctx.rest[0] : wards[0].id,
    filter: 'all',
    picking: null, // encounter we are choosing a bed for
    busy: false,
  };

  const kpiBox = h('div');
  const summary = h('div', { class: 'stats board-summary', 'data-test': 'board-summary' });
  const conflictBox = h('div');
  const waitingBox = h('div', { 'data-test': 'waiting' });
  const banner = h('div', { role: 'status', 'aria-live': 'polite' });
  const wardTabs = h('div', { class: 'ward-tabs', role: 'group', 'aria-label': 'Wards' });
  const filterRow = h('div', { class: 'chips', role: 'group', 'aria-label': 'Show beds' });
  const wardHead = h('h2', { id: 'ward-h' });
  const grid = h('div', { class: 'bed-grid', 'data-test': 'bed-grid' });
  const recent = h('ol', { class: 'recent', 'data-test': 'recent' });
  const dialog = h('dialog', { class: 'kpi-dialog bed-dialog', 'aria-labelledby': 'bed-dlg-h' });
  dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close(); });

  let board = deriveBoard(bedEntities, events);

  function wardBeds(wardId) {
    return bedEntities.filter((b) => b.parentId === wardId).map((b) => board.beds.get(b.id));
  }

  async function refreshFromStore() {
    events = await core.events();
    board = deriveBoard(bedEntities, events);
    draw();
  }

  async function act(action, bed, opts = {}) {
    if (ui.busy) return;
    ui.busy = true;
    const wardId = bedInfo.get(bed.id).parentId;
    try {
      await ctx.run(ACTION_COMMANDS[action], { bedId: bed.id, expectedState: bed.state, ...opts }); // listeners redraw the board
      ctx.toast(`${shortWard(wardById.get(wardId))} ${bedInfo.get(bed.id).name}: ${ACTION_LABELS[action].replace(/:.*$/, '')}`);
    } catch (err) {
      if (err.code === 'conflict' || err.code === 'forbidden' || err.code === 'not-found') {
        ctx.toast(`Not saved. ${err.message} The board is up to date now.`);
        await refreshFromStore();
      } else {
        console.error(err);
        ctx.toast('That change was not saved. Try again.');
      }
    } finally {
      ui.busy = false;
      // Keep keyboard and screen-reader users on the bed they acted on (issue #11).
      grid.querySelector(`[data-bed="${bed.id}"]`)?.focus();
    }
  }

  function openBed(bedId) {
    const bed = board.beds.get(bedId);
    const info = bedInfo.get(bedId);
    const ward = wardById.get(info.parentId);
    const pick = ui.picking && board.waiting.find((w) => w.encounter === ui.picking);
    if (pick && bed.state === 'available' && canDo(ctx.role, 'allocate')) {
      // Choosing a bed for a waiting patient: one tap allocates, after a clear confirm.
      ui.picking = null;
      act('allocate', bed, { encounter: pick.encounter });
      return;
    }
    const body = [];
    const actions = bedActions(bed).filter((a) => canDo(ctx.role, a) && (a !== 'allocate' || board.waiting.some((w) => !w.allocatedBed)));
    let reasonSel = null; let patientSel = null;
    for (const a of actions) {
      if (a === 'out-of-service') {
        reasonSel = h('select', { id: 'oos-reason' }, OUT_OF_SERVICE_REASONS.map((r) => new Option(r, r)));
        body.push(h('div', { class: 'field' }, h('label', { for: 'oos-reason' }, 'Reason'), reasonSel));
      }
      if (a === 'allocate') {
        const free = board.waiting.filter((w) => !w.allocatedBed);
        patientSel = h('select', { id: 'alloc-patient' }, free.map((w) => new Option(
          `${encounterLabel(w.encounter)} · for ${shortWard(wardById.get(w.wardId) || { name: 'any ward' })} · waiting ${since(w.decisionAt, Date.now())}`, w.encounter)));
        const same = free.find((w) => w.wardId === info.parentId);
        if (same) patientSel.value = same.encounter;
        body.push(h('div', { class: 'field' }, h('label', { for: 'alloc-patient' }, 'Waiting patient'), patientSel));
      }
    }
    const buttons = actions.map((a) => h('button', {
      class: `btn${a === 'out-of-service' || a.startsWith('cancel') ? ' btn-ghost' : ''}`, type: 'button', 'data-action': a, 'data-cmd': ACTION_COMMANDS[a],
      onclick: async () => {
        const opts = {};
        if (a === 'out-of-service') opts.reason = reasonSel.value;
        if (a === 'allocate') opts.encounter = patientSel.value;
        dialog.close();
        await act(a, bed, opts);
      },
    }, ACTION_LABELS[a]));
    dialog.replaceChildren(
      h('h2', { id: 'bed-dlg-h' }, `${shortWard(ward)} · ${info.name}`),
      h('p', { class: 'bed-dlg-state' }, h('span', { class: `chip st-${bed.state}` }, BED_STATES[bed.state].name),
        bed.since ? h('span', { class: 'meta' }, ` for ${since(bed.since, Date.now())}, since ${fmtClock(bed.since)}`) : null),
      h('dl', {},
        bed.encounter ? h('div', { class: 'def-row' }, h('dt', {}, bed.state === 'allocated' ? 'Held for' : 'Patient'), h('dd', {}, encounterLabel(bed.encounter))) : null,
        bed.expectedAt ? h('div', { class: 'def-row' }, h('dt', {}, 'Expected to leave'), h('dd', {}, new Date(bed.expectedAt).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' }))) : null,
        bed.reason ? h('div', { class: 'def-row' }, h('dt', {}, 'Reason'), h('dd', {}, bed.reason)) : null,
        h('div', { class: 'def-row' }, h('dt', {}, 'Bed'), h('dd', {}, info.sideRoom ? 'Side room' : 'Bay bed'))),
      ...body,
      h('p', { class: 'meta' }, actions.length
        ? `Each change is saved to the event log as ${roleById(ctx.role).name}.`
        : `${roleById(ctx.role).name} can see this bed but not change it.`),
      h('div', { class: 'actions bed-actions' }, ...buttons, h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => dialog.close() }, 'Close')),
    );
    dialog.showModal();
  }

  // Agent proposals (issue #17): bed commands only on this page.
  function describeProposal(p) {
    const action = ACTION_BY_COMMAND[p.command];
    const info = p.input?.bedId ? bedInfo.get(p.input.bedId) : null;
    const where = info ? `${shortWard(wardById.get(info.parentId))} ${info.name}` : '';
    const what = action ? ACTION_LABELS[action].replace(/:.*$/, '') : p.command;
    const extra = p.input?.encounter ? ` for ${encounterLabel(p.input.encounter)}` : p.input?.reason ? ` (${p.input.reason})` : '';
    return `${where}: ${what}${extra}`;
  }
  const props = proposalsCard(ctx, { describe: describeProposal, match: (p) => p.command.startsWith('ospeli_beds_') });

  function renderConflicts() {
    const n = board.conflicts.length;
    conflictBox.replaceChildren(...(n ? [h('div', { class: 'card notice', 'data-test': 'conflicts' },
      h('p', {}, `${n} bed ${n === 1 ? 'change was' : 'changes were'} not applied because the bed already held a patient. `,
        'They stay in the event log for review.'))] : []));
  }

  function renderSummary() {
    const all = countStates(board.beds.values());
    const going = all['expected-discharge'];
    const waitingFree = board.waiting.filter((w) => !w.allocatedBed).length;
    const stat = (n, label, test) => h('div', { class: 'stat', 'data-test': test }, h('b', {}, n), h('span', {}, label));
    summary.replaceChildren(
      stat(all.available, 'Available now', 'sum-available'),
      stat(all.vacated + all.cleaning, 'To clean', 'sum-clean'),
      stat(going, 'Going home', 'sum-going'),
      stat(waitingFree, 'Waiting for a bed', 'sum-waiting'),
      stat(all['out-of-service'], 'Out of service', 'sum-oos'));
  }

  function renderWaiting() {
    const now = Date.now();
    if (!board.waiting.length) {
      waitingBox.replaceChildren(h('p', { class: 'meta' }, 'Nobody is waiting for a bed.'));
      return;
    }
    waitingBox.replaceChildren(h('ul', { class: 'waiting-list' }, board.waiting.map((w) => {
      const ward = wardById.get(w.wardId);
      const held = w.allocatedBed ? bedInfo.get(w.allocatedBed) : null;
      return h('li', { class: `waiting-item${ui.picking === w.encounter ? ' is-picking' : ''}` },
        h('div', {},
          h('b', {}, encounterLabel(w.encounter)),
          h('span', { class: 'meta' }, ` · for ${ward ? shortWard(ward) : 'any ward'} · waiting ${since(w.decisionAt, now)}`),
          held ? h('div', { class: 'meta' }, `Bed held: ${shortWard(wardById.get(held.parentId))} ${held.name}`) : null),
        held || !canDo(ctx.role, 'allocate') ? null : h('button', {
          class: 'btn btn-ghost btn-small', type: 'button', 'data-find': w.encounter, 'data-cmd': 'ospeli_beds_allocate',
          'aria-label': `${ui.picking === w.encounter ? 'Cancel finding a bed' : 'Find a bed'} for ${encounterLabel(w.encounter)}`,
          onclick: () => {
            if (ui.picking === w.encounter) { cancelPick(); return; }
            ui.picking = w.encounter;
            ui.filter = 'all'; // a filter must not hide the free beds the banner points at
            if (w.wardId && wardById.has(w.wardId)) setWard(w.wardId);
            draw();
            showBanner();
          },
        }, ui.picking === w.encounter ? 'Cancel' : 'Find a bed'));
    })));
  }

  // Stop choosing a bed and hand focus back to the button the pick started from (issue #63).
  function cancelPick() {
    const enc = ui.picking;
    ui.picking = null;
    draw();
    waitingBox.querySelector(`[data-find="${enc}"]`)?.focus();
  }

  // Take the user to the choice (issue #63): the banner comes into view under the top bar and
  // takes focus, so a phone user sees that a pick has started and a keyboard user is next to the beds.
  function showBanner() {
    const box = banner.querySelector('.banner');
    if (!box) return;
    box.focus({ preventScroll: true });
    const r = box.getBoundingClientRect();
    const barBottom = document.querySelector('.topbar')?.getBoundingClientRect().bottom || 0;
    if (r.top < barBottom + 8 || r.bottom > window.innerHeight) window.scrollBy(0, r.top - barBottom - 8);
  }

  function renderBanner() {
    const pick = ui.picking && board.waiting.find((w) => w.encounter === ui.picking);
    if (!pick) { banner.replaceChildren(); return; }
    const hadFocus = banner.contains(document.activeElement);
    const free = (id) => wardBeds(id).filter((b) => b.state === 'available').length;
    const here = free(ui.ward);
    const others = wards.filter((w) => w.id !== ui.ward && free(w.id) > 0);
    const hereName = shortWard(wardById.get(ui.ward));
    banner.replaceChildren(h('div', { class: 'banner', tabindex: '-1' },
      h('span', {}, 'Choose a bed for ', h('b', {}, encounterLabel(pick.encounter)),
        pick.wardId ? ` (asked for ${shortWard(wardById.get(pick.wardId))}). ` : '. ',
        here ? 'Available beds are highlighted; tap one to allocate it.'
          : others.length ? `No bed is free on ${hereName}. Wards with a free bed:`
            : 'No bed is available yet. Beds being cleaned are shown, and you can come back to this.'),
      !here && others.length ? h('span', { class: 'banner-wards' }, others.map((w) => h('button', {
        class: 'btn btn-ghost btn-small', type: 'button', 'data-go-ward': w.id,
        'aria-label': `Show ${shortWard(w)}: ${free(w.id)} free`,
        onclick: () => { setWard(w.id); draw(); },
      }, `${shortWard(w)} (${free(w.id)})`))) : null,
      h('button', { class: 'btn btn-ghost btn-small', type: 'button', onclick: cancelPick }, 'Cancel')));
    if (hadFocus) banner.querySelector('.banner').focus({ preventScroll: true });
  }

  function setWard(id) {
    ui.ward = id;
    history.replaceState(null, '', `#/beds/${id}`);
  }

  function renderWards() {
    wardTabs.replaceChildren(...wards.map((w) => {
      const c = countStates(wardBeds(w.id));
      return h('button', { type: 'button', class: 'ward-tab', 'aria-pressed': String(ui.ward === w.id), 'data-ward': w.id,
        onclick: () => { setWard(w.id); draw(); } },
        h('span', { class: 'ward-tab-name' }, shortWard(w)),
        h('span', { class: 'ward-tab-counts' },
          h('span', {}, h('b', {}, c.available), ' free'),
          h('span', {}, h('b', {}, c.vacated + c.cleaning), ' to clean'),
          h('span', {}, h('b', {}, c['expected-discharge']), ' going')));
    }));
  }

  function renderFilters() {
    filterRow.replaceChildren(...FILTERS.map(([id, label]) => h('button', {
      type: 'button', class: 'chip-btn', 'aria-pressed': String(ui.filter === id), 'data-filter': id,
      onclick: () => { ui.filter = id; draw(); },
    }, label)));
  }

  function renderGrid() {
    const ward = wardById.get(ui.ward);
    const now = Date.now();
    const test = FILTERS.find((f) => f[0] === ui.filter)[2];
    const picking = !!ui.picking;
    wardHead.textContent = ward.name;
    const beds = wardBeds(ui.ward).filter(test);
    grid.replaceChildren(...(beds.length ? beds.map((b) => {
      const info = bedInfo.get(b.id);
      const match = picking && b.state === 'available';
      const who = b.state === 'out-of-service' ? b.reason : b.encounter ? (b.state === 'allocated' ? `For ${encounterLabel(b.encounter)}` : encounterLabel(b.encounter)) : '';
      return h('button', {
        type: 'button', class: `bed st-${b.state}${match ? ' match' : ''}${picking && !match ? ' dim' : ''}`, 'data-bed': b.id, 'data-cmd': 'ospeli_beds_get',
        'aria-label': `${info.name}, ${BED_STATES[b.state].name}${b.since ? `, for ${since(b.since, now)}` : ''}${match ? ', available to allocate' : ''}`,
        onclick: () => openBed(b.id),
      },
        h('span', { class: 'bed-row' }, h('b', { class: 'bed-no' }, info.name.replace('Bed ', '')), h('span', { class: 'bed-age' }, since(b.since, now))),
        h('span', { class: `chip st-${b.state}` }, BED_STATES[b.state].short),
        who ? h('span', { class: 'bed-who' }, who) : null,
        info.sideRoom ? h('span', { class: 'bed-tag' }, 'Side room') : null);
    }) : [h('p', { class: 'meta' }, 'No beds in this ward match this filter.')]));
  }

  function renderRecent() {
    const wardBedIds = new Set(bedEntities.filter((b) => b.parentId === ui.ward).map((b) => b.id));
    const mine = [];
    for (let i = events.length - 1; i >= 0 && mine.length < 8; i--) {
      const e = events[i];
      if (!BED_EVENT.test(e.type)) continue;
      const bedId = wardBedIds.has(e.subject) ? e.subject : e.data?.bedId;
      if (!wardBedIds.has(bedId)) continue;
      mine.push(h('li', {}, h('span', { class: 'meta' }, fmtClock(e.at)), ' ', bedInfo.get(bedId).name, ': ', e.type.replace(/^[a-z]+\./, '').replace(/-/g, ' '),
        h('span', { class: 'meta' }, ` · ${roleById(e.actorRole)?.name || 'System'}`)));
    }
    recent.replaceChildren(...(mine.length ? mine : [h('li', { class: 'meta' }, 'No bed changes yet.')]));
  }

  async function renderKpis() {
    const kctx = await kpiContext(core);
    kpiBox.replaceChildren(kpiTiles(BOARD_KPIS, kctx));
  }

  function draw() {
    renderSummary(); renderConflicts(); renderWaiting(); renderBanner(); renderWards(); renderFilters(); renderGrid(); renderRecent();
  }

  el.append(
    h('div', { class: 'page-head' },
      h('div', {},
        h('p', { class: 'eyebrow' }, 'Bed board'),
        h('h1', {}, 'Bed board'),
        h('p', {}, 'Live bed state from the event log. Tap a bed to move it on: discharge, clean, allocate.'))),
    summary,
    props.el,
    conflictBox,
    h('section', { class: 'section', 'aria-labelledby': 'wait-h' },
      h('h2', { id: 'wait-h' }, 'Waiting for a bed'),
      h('p', { class: 'meta' }, 'Longest wait first. Waits count from the decision to admit.'),
      waitingBox),
    h('section', { class: 'section', 'aria-labelledby': 'ward-h' },
      wardTabs,
      banner,
      h('div', { class: 'board-head' }, wardHead, filterRow),
      grid,
      h('p', { class: 'meta legend' }, 'Time on each bed is how long it has been in its current state.')),
    h('section', { class: 'section', 'aria-labelledby': 'kpi-h' },
      h('h2', { id: 'kpi-h' }, 'Flow numbers'),
      h('p', { class: 'meta' }, 'Last 7 days, calculated from the same event log. Tap a number to see how it is defined.'),
      kpiBox),
    h('section', { class: 'section', 'aria-labelledby': 'recent-h' },
      h('h2', { id: 'recent-h' }, 'Recent changes on this ward'),
      recent),
    dialog,
  );
  draw();
  await props.load();
  await renderKpis();

  // Stay live: new events from this tab (or a reload of everything) redraw the board.
  let kpiTimer = null;
  const off = core.onChange(async ({ kind, detail }) => {
    if (kind === 'proposals' || kind === 'reset' || kind === 'events') await props.load();
    if (kind === 'event') events.push(detail);
    else if (kind === 'events' || kind === 'reset') events = await core.events();
    else return;
    board = deriveBoard(bedEntities, events);
    if (ui.picking && !board.waiting.some((w) => w.encounter === ui.picking && !w.allocatedBed)) ui.picking = null;
    draw();
    clearTimeout(kpiTimer);
    kpiTimer = setTimeout(renderKpis, 150);
  });
  const tick = setInterval(draw, 60e3); // keep the "time in state" fresh
  return () => { off(); clearInterval(tick); clearTimeout(kpiTimer); if (dialog.open) dialog.close(); };
}
