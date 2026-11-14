// Engineering (backlog item 7): report a fault, and run the work-order queue with SLA timers,
// assign to a team, close with an outcome, and repeat faults flagged. Every control runs a named
// command (core/commands.js), the same one an agent would. Deep link per asset:
// #/engineering/report/<assetId> (the address a QR label on the asset points to).
// Issue #83: the facilities technician sees a "do next" card first: one suggested job (a fixed
// rule, not AI), Start job, Pick another, then Close job. Lateness is a number and a small bar.
import { h, fmtTime, setKids } from './ui.js';
import { roleById } from '../core/model.js';
import { commandByName } from '../core/commands.js';
import {
  PRIORITIES, TEAMS, OUTCOMES, WO_STATES, WO_SORTS, slaText, lateMinutes, lateBar, sortWorkOrders, teamOfRole, repeatText, repeatBadge,
} from '../core/workorders.js';
import { kpiContext, kpiTiles } from './kpi-tiles.js';
import { proposalsCard } from './proposals.js';

const can = (role, cmd) => !!commandByName(cmd)?.roles.includes(role);
const FILTERS = [
  ['open', 'Open'],
  ['overdue', 'Late'],
  ['repeat', 'Repeat faults'],
  ['completed', 'Completed'],
];

export async function render(el, ctx) {
  const { core } = ctx;
  const ui = { filter: 'open', sort: 'priority', busy: false, skip: 0, view: 'auto', closing: false, mine: null, shown: 0 };
  const assetData = await ctx.run('ospeli_assets_list', { limit: 1000 });
  if (!assetData.assets.length) {
    el.append(h('div', { class: 'page-head' }, h('div', {}, h('p', { class: 'eyebrow' }, 'Engineering'), h('h1', {}, 'Engineering'))),
      h('div', { class: 'card notice' }, h('p', {}, 'No hospital is loaded on this device. Load Example General Hospital from ', h('a', { href: '#/data' }, 'Data and audit'), '.')));
    return null;
  }
  const assets = new Map(assetData.assets.map((a) => [a.id, a]));
  const places = new Map(assetData.locations.map((p) => [p.id, p]));
  const deepAsset = ctx.rest[0] === 'report' && assets.has(ctx.rest[1]) ? ctx.rest[1] : null;

  // ---- report a fault ----
  const canReport = can(ctx.role, 'ospeli_workorders_report_fault');
  const locSel = h('select', { id: 'f-loc', 'data-test': 'f-loc' }, assetData.locations.map((p) => new Option(p.name, p.id)));
  const assetSel = h('select', { id: 'f-asset', 'data-test': 'f-asset' });
  const faultSel = h('select', { id: 'f-fault', 'data-test': 'f-fault' });
  const prioBox = h('div', { class: 'prio', role: 'radiogroup', 'aria-labelledby': 'f-prio-l' },
    Object.entries(PRIORITIES).map(([id, p]) => h('label', { class: 'prio-opt' },
      h('input', { type: 'radio', name: 'f-prio', value: id, checked: id === 'routine' }),
      h('span', {}, h('b', {}, p.name), h('small', {}, p.hint)))));
  const reportStatus = h('p', { class: 'meta', role: 'status', 'data-test': 'report-status' });
  const reportMore = h('div', { class: 'actions', 'data-test': 'report-more' }); // a way on after "Already reported"
  const fillAssets = (keep) => {
    const list = assetData.assets.filter((a) => a.locationId === locSel.value);
    assetSel.replaceChildren(...list.map((a) => new Option(a.name, a.id)));
    if (keep && list.some((a) => a.id === keep)) assetSel.value = keep;
    fillFaults();
  };
  const fillFaults = () => { faultSel.replaceChildren(...(assets.get(assetSel.value)?.faults || []).map((f) => new Option(f, f))); };
  locSel.addEventListener('change', () => fillAssets());
  assetSel.addEventListener('change', fillFaults);
  if (deepAsset) locSel.value = assets.get(deepAsset).locationId;
  fillAssets(deepAsset);

  const reportBtn = h('button', { class: 'btn', type: 'submit', 'data-cmd': 'ospeli_workorders_report_fault' }, 'Report fault');
  const form = h('form', { class: 'card report-form', 'aria-labelledby': 'report-h', 'data-test': 'report-form' },
    h('h2', { id: 'report-h' }, 'Report a fault'),
    deepAsset ? h('p', { class: 'meta' }, `From the label on ${assets.get(deepAsset).name}.`) : null,
    h('div', { class: 'field' }, h('label', { for: 'f-loc' }, 'Where'), locSel),
    h('div', { class: 'field' }, h('label', { for: 'f-asset' }, 'What'), assetSel),
    h('div', { class: 'field' }, h('label', { for: 'f-fault' }, 'Fault'), faultSel),
    h('div', { class: 'field' }, h('span', { id: 'f-prio-l', class: 'label' }, 'How urgent'), prioBox),
    h('div', { class: 'actions' }, reportBtn),
    reportStatus,
    reportMore,
    h('p', { class: 'meta' }, 'Pick from the lists; there is no free text, so no personal details go in the log. If it is unsafe, make the area safe and call the team as well.'));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (ui.busy) return;
    ui.busy = true;
    reportBtn.disabled = true;
    reportMore.replaceChildren();
    reportStatus.classList.remove('notice');
    try {
      const priority = form.querySelector('input[name="f-prio"]:checked')?.value || 'routine';
      const out = await ctx.run('ospeli_workorders_report_fault', { assetId: assetSel.value, fault: faultSel.value, priority });
      const a = assets.get(assetSel.value);
      reportStatus.textContent = `Reported: ${out.workOrderId.toUpperCase()}, ${faultSel.value}, ${a.name}.${out.repeat ? ` Repeat fault. ${repeatText(out.repeat)}.` : ''}`;
      ctx.toast(`Work order ${out.workOrderId.toUpperCase()} opened`);
      ui.filter = 'open';
    } catch (err) {
      const existing = err.code === 'conflict' ? err.detail?.existing : null;
      if (existing) {
        // Issue #24: the fault is already in the queue. Say so, and offer the work order itself.
        const name = existing.toUpperCase();
        reportStatus.classList.add('notice');
        reportStatus.textContent = `Already reported: ${name} is open for this fault. No new work order was opened.`;
        reportMore.replaceChildren(h('button', { class: 'btn btn-ghost', type: 'button', 'data-test': 'see-existing', onclick: () => showWorkOrder(existing) }, `See ${name}`));
      } else reportStatus.textContent = `Not saved. ${err.message}`;
    } finally {
      ui.busy = false;
      reportBtn.disabled = false;
    }
  });

  // ---- the queue ----
  const ownTeam = teamOfRole(ctx.role) || 'estates';
  const doNext = ctx.role === 'estates-tech' && !deepAsset; // the "do next" card (issue #83)
  const counts = h('p', { class: 'wo-summary', 'data-test': 'wo-counts' });
  const sortRow = h('div', { class: 'seg', role: 'group', 'aria-label': 'Sort the list by' });
  const filterRow = h('div', { class: 'chips', role: 'group', 'aria-label': 'Show work orders' });
  const list = h('div', { class: 'wo-groups', 'data-test': 'wo-list' });
  const card = h('section', { class: 'next-card', 'data-test': 'next-card', 'aria-labelledby': 'next-h' });
  const kpiBox = h('div');
  const dialog = h('dialog', { class: 'kpi-dialog wo-dialog', 'aria-labelledby': 'wo-dlg-h' });
  dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close(); });
  let data = { open: null, completed: null, next: null };

  async function load() {
    const [open, completed, next] = await Promise.all([
      ctx.run('ospeli_workorders_list', { state: 'open', limit: 500 }),
      ctx.run('ospeli_workorders_list', { state: 'completed', limit: 500 }),
      doNext ? ctx.run('ospeli_workorders_next', { skip: ui.skip }) : null,
    ]);
    data = { open, completed, next };
    draw();
  }

  const DONE_WORDS = { ospeli_workorders_start: () => 'started', ospeli_workorders_assign: (x) => `assigned to ${TEAMS[x.team]}`, ospeli_workorders_complete: (x) => OUTCOMES[x.outcome] };
  async function act(cmd, w, extra = {}, after) {
    if (ui.busy) return;
    ui.busy = true;
    try {
      await ctx.run(cmd, { workOrderId: w.id, expectedState: w.state, ...extra });
      ctx.toast(`${w.id.toUpperCase()}: ${DONE_WORDS[cmd](extra)}`);
      if (after) { after(); await load(); }
    } catch (err) {
      ctx.toast(`Not saved. ${err.message}`);
      await load();
    } finally {
      ui.busy = false;
      if (!after) list.querySelector(`[data-wo="${w.id}"]`)?.focus();
    }
  }

  // Lateness: the number in words, and a small bar that is the share of the most late job in view.
  // The bar is decoration for the eye; the words carry the meaning (issue #83).
  const lateness = (w, now, max, lead) => h('span', { class: 'wo-late' },
    h('span', { class: 'late-n' }, lead ? `${lead} · ` : null, slaText(w, now)),
    w.state === 'completed' ? null : h('span', { class: 'late-bar', 'aria-hidden': 'true' }, h('i', { style: `width:${lateBar(w, now, max)}%` })));
  // Tags only for what changes what the reader does: in progress, another team, a repeat fault.
  const tags = (w) => [
    w.state === 'started' ? h('span', { class: 'chip wo-started' }, WO_STATES.started) : null,
    w.state !== 'completed' && w.team !== ownTeam ? h('span', { class: 'chip wo-team' }, TEAMS[w.team] || w.team) : null,
    w.repeat ? h('span', { class: 'chip repeat' }, repeatBadge(w.repeat)) : null,
  ].filter(Boolean);

  // ---- the "do next" card: the suggestion, or the job in progress ----
  function drawCard(now, max) {
    const n = data.next;
    const inProgress = n.inProgress;
    const keep = card.contains(document.activeElement) ? document.activeElement.dataset.k || 'main' : null;
    const started = ui.view === 'auto' && inProgress.length ? inProgress.find((w) => w.id === ui.mine) || inProgress[ui.shown % inProgress.length] : null;
    const w = started || n.workOrder;
    // "How did it end?" belongs to the job it was asked for. If that job is no longer the one on
    // the card (closed or handed on from somewhere else), the question goes away with it.
    if (ui.closing && started?.id !== ui.closing) ui.closing = false;
    card.className = `next-card${w ? ` pr-${w.priority}` : ''}`;
    card.dataset.mode = started ? 'started' : w ? 'suggest' : 'empty';
    if (w) card.dataset.job = w.id; else delete card.dataset.job;
    const body = (label, side) => [
      h('p', { class: 'next-label' }, h('span', {}, label), side),
      h('h3', { id: 'next-h' }, w.title),
      h('p', { class: 'next-where' }, `${w.assetName} · ${w.locationName}`),
      h('p', { class: 'next-facts' }, h('span', { class: `chip pr-${w.priority}` }, PRIORITIES[w.priority].name), lateness(w, now, max), w.repeat ? h('span', { class: 'chip repeat' }, repeatBadge(w.repeat)) : null),
    ];
    if (!w) {
      setKids(card,
        h('p', { class: 'next-label' }, h('span', {}, 'Suggested next job')),
        h('h3', { id: 'next-h' }, `No job is waiting for the ${n.teamName}.`),
        h('p', { class: 'next-why' }, 'New faults show here when they are reported. Jobs for other teams are in the list below.'));
    } else if (started) {
      const others = inProgress.length - 1;
      setKids(card,
        body('Job in progress', h('span', { class: 'next-tag' }, n.teamName)),
        ui.closing
          ? h('div', { class: 'next-outcomes', role: 'group', 'aria-labelledby': 'next-out-l', 'data-test': 'outcomes' },
            h('p', { id: 'next-out-l', class: 'next-ask' }, 'How did it end?'),
            Object.entries(OUTCOMES).map(([id, name], i) => h('button', {
              class: `btn btn-big${i ? ' btn-ghost' : ''}`, type: 'button', 'data-cmd': 'ospeli_workorders_complete', 'data-outcome': id, 'data-k': i ? `out-${id}` : 'main',
              onclick: () => act('ospeli_workorders_complete', w, { outcome: id }, () => { ui.closing = false; ui.mine = null; ui.skip = 0; ui.view = 'auto'; }),
            }, name)),
            h('button', { class: 'linkish', type: 'button', 'data-k': 'back', onclick: () => { ui.closing = false; draw(); focusCard('main'); } }, 'Not finished yet'))
          : h('button', { class: 'btn btn-big', type: 'button', 'data-test': 'close-job', 'data-k': 'main', onclick: () => { ui.closing = w.id; draw(); focusCard('main'); } }, 'Close job'),
        ui.closing ? null : h('p', { class: 'next-more' },
          others > 0 ? h('button', { class: 'linkish', type: 'button', 'data-k': 'other', onclick: () => { ui.mine = null; ui.shown += 1; draw(); focusCard('other'); } }, `Show another job in progress (${others} more)`) : null,
          n.workOrder ? h('button', { class: 'linkish', type: 'button', 'data-k': 'suggest', 'data-test': 'see-suggestion', onclick: () => { ui.view = 'suggest'; draw(); focusCard('main'); } }, 'See the next suggested job') : null),
        ui.closing ? null : h('p', { class: 'next-rule' }, `Started as ${roleById(w.startedByRole)?.name || 'the team'}. The log keeps the role, never a person.`));
    } else {
      setKids(card,
        body('Suggested next job', h('span', { class: 'next-tag', 'data-test': 'you-decide' }, 'You decide')),
        h('p', { class: 'next-why', 'data-test': 'next-why' }, n.reason),
        h('button', { class: 'btn btn-big', type: 'button', 'data-cmd': 'ospeli_workorders_start', 'data-k': 'main',
          onclick: () => act('ospeli_workorders_start', w, {}, () => { ui.mine = w.id; ui.view = 'auto'; ui.skip = 0; ui.closing = false; }) }, 'Start job'),
        h('p', { class: 'next-more' },
          n.total > 1 ? h('button', { class: 'linkish', type: 'button', 'data-cmd': 'ospeli_workorders_next', 'data-k': 'pick', 'data-test': 'pick-another',
            onclick: async () => { ui.skip = n.position % n.total; await load(); focusCard('pick'); } }, 'Pick another') : null,
          h('span', { class: 'next-pos', 'data-test': 'next-pos' }, `${n.positionText} for your team`),
          inProgress.length ? h('button', { class: 'linkish', type: 'button', 'data-k': 'back', onclick: () => { ui.view = 'auto'; draw(); focusCard('main'); } }, `Back to the job in progress (${inProgress.length})`) : null),
        h('p', { class: 'next-rule', 'data-test': 'next-rule' }, n.rule));
    }
    if (keep) focusCard(keep);
  }
  function focusCard(k) { (card.querySelector(`[data-k="${k}"]`) || card.querySelector('[data-k="main"]'))?.focus({ preventScroll: true }); }

  // Open one work order by its id, from fresh data (used by "Already reported").
  async function showWorkOrder(id) {
    await load();
    const w = [...data.open.workOrders, ...data.completed.workOrders].find((x) => x.id === id);
    if (!w) { ctx.toast(`${id.toUpperCase()} is not in the queue any more.`); return; }
    ui.filter = w.state === 'completed' ? 'completed' : 'open';
    draw();
    openWorkOrder(w);
  }

  function openWorkOrder(w) {
    const now = new Date().toISOString();
    const teamSel = h('select', { id: 'wo-team' }, Object.entries(TEAMS).map(([id, t]) => new Option(t, id)));
    teamSel.value = w.team;
    const outSel = h('select', { id: 'wo-outcome' }, Object.entries(OUTCOMES).map(([id, t]) => new Option(t, id)));
    const open = w.state !== 'completed';
    const mayAssign = open && can(ctx.role, 'ospeli_workorders_assign');
    const mayStart = open && w.state !== 'started' && can(ctx.role, 'ospeli_workorders_start');
    const mayClose = open && can(ctx.role, 'ospeli_workorders_complete');
    const row = (k, v) => h('div', { class: 'def-row' }, h('dt', {}, k), h('dd', {}, v));
    setKids(dialog,
      h('h2', { id: 'wo-dlg-h' }, `${w.id.toUpperCase()} · ${w.title}`),
      h('p', {}, h('span', { class: `chip pr-${w.priority}` }, PRIORITIES[w.priority].name), ' ',
        h('span', { class: `chip wo-${w.state}` }, WO_STATES[w.state]), ' ',
        h('span', { class: 'sla' }, slaText(w, now))),
      h('dl', {},
        row('Asset', `${w.assetName}, ${w.locationName}`),
        row('Reported', `${fmtTime(w.reportedAt)} by ${roleById(w.reportedByRole)?.name || w.reportedByRole}`),
        row('Target', `${fmtTime(w.dueAt)} (${PRIORITIES[w.priority].name.toLowerCase()})`),
        row('Team', TEAMS[w.team] || w.team),
        row('Label link', h('code', { class: 'label-link' }, `${location.origin}${location.pathname}#/engineering/report/${w.assetId}`)),
        w.repeat ? row('Repeat fault', repeatText(w.repeat)) : null,
        w.completedAt ? row('Closed', `${fmtTime(w.completedAt)}: ${OUTCOMES[w.outcome] || w.outcome}`) : null),
      mayAssign ? h('div', { class: 'field' }, h('label', { for: 'wo-team' }, 'Team'), teamSel) : null,
      mayClose ? h('div', { class: 'field' }, h('label', { for: 'wo-outcome' }, 'Outcome'), outSel) : null,
      h('p', { class: 'meta' }, mayAssign || mayClose || mayStart ? `Each change is saved to the event log as ${roleById(ctx.role).name}.`
        : open ? `${roleById(ctx.role).name} can see this work order but not change it.` : 'This work order is closed.'),
      h('div', { class: 'actions' },
        mayStart ? h('button', { class: 'btn btn-ghost', type: 'button', 'data-cmd': 'ospeli_workorders_start', onclick: () => { dialog.close(); act('ospeli_workorders_start', w); } }, 'Start job') : null,
        mayAssign ? h('button', { class: 'btn btn-ghost', type: 'button', 'data-cmd': 'ospeli_workorders_assign', onclick: () => { dialog.close(); act('ospeli_workorders_assign', w, { team: teamSel.value }); } }, 'Assign') : null,
        mayClose ? h('button', { class: 'btn', type: 'button', 'data-cmd': 'ospeli_workorders_complete', onclick: () => { dialog.close(); act('ospeli_workorders_complete', w, { outcome: outSel.value }); } }, 'Close work order') : null,
        h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => dialog.close() }, 'Close')));
    dialog.showModal();
  }

  function draw() {
    if (!data.open) return;
    const c = data.open.counts;
    // One line instead of three tiles. The numbers are the same ones the KPI tiles below use.
    const part = (n, label, test) => h('span', { 'data-test': test }, h('b', {}, n), ` ${label}`);
    setKids(counts, part(c.open, 'open', 'wo-open'), ' · ', part(c.overdue, 'late', 'wo-overdue'), ' · ', part(c.repeat, c.repeat === 1 ? 'repeat fault' : 'repeat faults', 'wo-repeat'));
    sortRow.replaceChildren(...Object.entries(WO_SORTS).map(([id, label]) => h('button', {
      type: 'button', class: 'seg-btn', 'aria-pressed': String(ui.sort === id), 'data-sort': id, onclick: () => { ui.sort = id; draw(); sortRow.querySelector(`[data-sort="${id}"]`)?.focus(); },
    }, label)));
    filterRow.replaceChildren(...FILTERS.map(([id, label]) => h('button', {
      type: 'button', class: 'chip-btn', 'aria-pressed': String(ui.filter === id), 'data-filter': id, onclick: () => { ui.filter = id; draw(); filterRow.querySelector(`[data-filter="${id}"]`)?.focus(); },
    }, label)));
    const now = new Date().toISOString();
    const done = ui.filter === 'completed';
    let rows = done ? data.completed.workOrders.slice(0, 30) : data.open.workOrders;
    if (ui.filter === 'overdue') rows = rows.filter((w) => w.overdue);
    if (ui.filter === 'repeat') rows = rows.filter((w) => w.repeat > 0);
    const max = Math.max(0, ...data.open.workOrders.map((w) => lateMinutes(w, now)));
    sortRow.hidden = done;
    const row = (w, lead) => h('li', {},
      h('button', {
        type: 'button', class: `wo pr-${w.priority}`, 'data-wo': w.id, 'data-cmd': 'ospeli_workorders_list',
        'aria-label': `${w.id.toUpperCase()}, ${w.title}, ${w.assetName}, ${w.locationName}, ${PRIORITIES[w.priority].name}, ${done ? `${OUTCOMES[w.outcome] || 'Completed'}, ` : ''}${slaText(w, now)}${w.state === 'started' ? ', in progress' : ''}${!done && w.team !== ownTeam ? `, ${TEAMS[w.team]}` : ''}${w.repeat ? ', repeat fault, failed again after a fix' : ''}`,
        onclick: () => openWorkOrder(w),
      },
        h('b', { class: 'wo-title' }, w.title),
        h('span', { class: 'wo-where' }, `${w.assetName} · ${w.locationName}`),
        lateness(w, now, max, done ? OUTCOMES[w.outcome] || 'Completed' : lead ? PRIORITIES[w.priority].name : null),
        tags(w).length ? h('span', { class: 'wo-tags' }, tags(w)) : null));
    // Completed work orders stay in the order they were closed, newest first.
    const groups = done ? (rows.length ? [{ id: 'done', name: null, items: rows }] : []) : sortWorkOrders(rows, ui.sort);
    setKids(list, groups.length ? groups.map((g) => [
      g.name ? h('h3', { class: 'wo-group', 'data-group': g.id }, g.name, h('span', {}, ` ${g.items.length}`)) : null,
      h('ul', { class: 'wo-list' }, g.items.map((w) => row(w, done ? false : ui.sort !== 'priority'))),
    ]) : h('p', { class: 'meta' }, 'No work orders here.'));
    if (doNext && data.next) drawCard(now, max);
  }

  async function renderKpis() {
    kpiBox.replaceChildren(kpiTiles(['open-work-orders', 'overdue-work-orders'], await kpiContext(core)));
  }

  const props = proposalsCard(ctx, {
    match: (p) => p.command.startsWith('ospeli_workorders_'),
    describe: (p) => (p.command === 'ospeli_workorders_report_fault'
      ? `Report: ${p.input.fault}, ${assets.get(p.input.assetId)?.name || p.input.assetId} (${PRIORITIES[p.input.priority]?.name || p.input.priority})`
      : `${p.input.workOrderId?.toUpperCase()}: ${p.command === 'ospeli_workorders_assign' ? `assign to ${TEAMS[p.input.team]}` : p.command === 'ospeli_workorders_start' ? 'start the job' : `close as ${OUTCOMES[p.input.outcome]}`}`),
  });

  const queueFirst = ctx.role === 'estates-tech' && !deepAsset;
  const rules = h('p', { class: 'meta', 'data-test': 'queue-rules' }, 'Grouped by priority, the most late first. "Late" is time past the target. Targets: urgent 4 h, high 24 h, routine 72 h (examples; set locally). A repeat fault is the same fault on the same asset that came back within 30 days of being closed as Fixed. Not counted: "No fault found", a different fault, and a second report of a fault that is still open.');
  // data-role lets a test (and a browser agent) see which role this queue was drawn for.
  const queue = h('section', { class: 'section wo-queue', 'aria-labelledby': 'queue-h', 'data-test': 'wo-queue', 'data-role': ctx.role },
    h('h2', { id: 'queue-h' }, 'Work-order queue'),
    counts,
    doNext ? card : rules,
    h('div', { class: 'wo-controls' }, sortRow, filterRow),
    list,
    doNext ? rules : null);
  const reportSection = canReport ? h('section', { class: 'section' }, form)
    : h('p', { class: 'meta' }, `${roleById(ctx.role).name} can see the queue but not report faults here.`);
  el.append(h('div', { class: `eng${doNext ? ' eng-next' : ''}` },
    h('div', { class: 'page-head' },
      h('div', {},
        h('p', { class: 'eyebrow' }, 'Engineering'),
        h('h1', {}, 'Faults and work orders'),
        doNext ? null : h('p', {}, 'Report a fault in three taps. The facilities and equipment teams work the queue from the same log.'))),
    props.el,
    queueFirst ? queue : reportSection,
    queueFirst ? reportSection : queue,
    h('section', { class: 'section', 'aria-labelledby': 'eng-kpi-h' },
      h('h2', { id: 'eng-kpi-h' }, 'Engineering numbers'),
      h('p', { class: 'meta' }, 'Calculated from the same event log. Tap a number to see how it is defined.'),
      kpiBox),
    dialog));
  await Promise.all([load(), props.load(), renderKpis()]);
  // The page is rendered off-screen and swapped in after render() returns, so focus afterwards.
  if (deepAsset) setTimeout(() => { if (faultSel.isConnected) faultSel.focus(); }, 0);

  let t = null;
  const off = core.onChange(({ kind }) => {
    if (!['event', 'events', 'reset', 'proposals'].includes(kind)) return;
    clearTimeout(t);
    t = setTimeout(() => { load(); props.load(); renderKpis(); }, 100);
  });
  const tick = setInterval(draw, 60e3); // keep the SLA timers fresh
  return () => { off(); clearInterval(tick); clearTimeout(t); if (dialog.open) dialog.close(); };
}
