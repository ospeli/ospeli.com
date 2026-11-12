// Engineering (backlog item 7): report a fault, and run the work-order queue with SLA timers,
// assign to a team, close with an outcome, and repeat faults flagged. Every control runs a named
// command (core/commands.js), the same one an agent would. Deep link per asset:
// #/engineering/report/<assetId> (the address a QR label on the asset points to).
import { h, fmtTime } from './ui.js';
import { roleById } from '../core/model.js';
import { commandByName } from '../core/commands.js';
import { PRIORITIES, TEAMS, OUTCOMES, WO_STATES, slaText } from '../core/workorders.js';
import { kpiContext, kpiTiles } from './kpi-tiles.js';
import { proposalsCard } from './proposals.js';

const can = (role, cmd) => !!commandByName(cmd)?.roles.includes(role);
const FILTERS = [
  ['open', 'Open'],
  ['overdue', 'Overdue'],
  ['repeat', 'Repeat faults'],
  ['completed', 'Completed'],
];

export async function render(el, ctx) {
  const { core } = ctx;
  const ui = { filter: 'open', busy: false };
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
    h('p', { class: 'meta' }, 'Pick from the lists; there is no free text, so no personal details go in the log. If it is unsafe, make the area safe and call the team as well.'));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (ui.busy) return;
    ui.busy = true;
    reportBtn.disabled = true;
    try {
      const priority = form.querySelector('input[name="f-prio"]:checked')?.value || 'routine';
      const out = await ctx.run('ospeli_workorders_report_fault', { assetId: assetSel.value, fault: faultSel.value, priority });
      const a = assets.get(assetSel.value);
      reportStatus.textContent = `Reported: ${out.workOrderId.toUpperCase()}, ${faultSel.value}, ${a.name}.${out.repeat ? ` Repeat fault: ${out.repeat} earlier on this asset in 30 days.` : ''}`;
      ctx.toast(`Work order ${out.workOrderId.toUpperCase()} opened`);
      ui.filter = 'open';
    } catch (err) {
      reportStatus.textContent = `Not saved. ${err.message}`;
    } finally {
      ui.busy = false;
      reportBtn.disabled = false;
    }
  });

  // ---- the queue ----
  const counts = h('div', { class: 'stats', 'data-test': 'wo-counts' });
  const filterRow = h('div', { class: 'chips', role: 'group', 'aria-label': 'Show work orders' });
  const list = h('ul', { class: 'wo-list', 'data-test': 'wo-list' });
  const kpiBox = h('div');
  const dialog = h('dialog', { class: 'kpi-dialog wo-dialog', 'aria-labelledby': 'wo-dlg-h' });
  dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close(); });
  let data = { open: null, completed: null };

  async function load() {
    const [open, completed] = await Promise.all([ctx.run('ospeli_workorders_list', { state: 'open', limit: 500 }), ctx.run('ospeli_workorders_list', { state: 'completed', limit: 500 })]);
    data = { open, completed };
    draw();
  }

  async function act(cmd, w, extra) {
    if (ui.busy) return;
    ui.busy = true;
    try {
      await ctx.run(cmd, { workOrderId: w.id, expectedState: w.state, ...extra });
      ctx.toast(`${w.id.toUpperCase()}: ${cmd === 'ospeli_workorders_assign' ? `assigned to ${TEAMS[extra.team]}` : OUTCOMES[extra.outcome]}`);
    } catch (err) {
      ctx.toast(`Not saved. ${err.message}`);
      await load();
    } finally {
      ui.busy = false;
      list.querySelector(`[data-wo="${w.id}"]`)?.focus();
    }
  }

  function openWorkOrder(w) {
    const now = new Date().toISOString();
    const teamSel = h('select', { id: 'wo-team' }, Object.entries(TEAMS).map(([id, t]) => new Option(t, id)));
    teamSel.value = w.team;
    const outSel = h('select', { id: 'wo-outcome' }, Object.entries(OUTCOMES).map(([id, t]) => new Option(t, id)));
    const open = w.state !== 'completed';
    const mayAssign = open && can(ctx.role, 'ospeli_workorders_assign');
    const mayClose = open && can(ctx.role, 'ospeli_workorders_complete');
    const row = (k, v) => h('div', { class: 'def-row' }, h('dt', {}, k), h('dd', {}, v));
    dialog.replaceChildren(
      h('h2', { id: 'wo-dlg-h' }, `${w.id.toUpperCase()} · ${w.title}`),
      h('p', {}, h('span', { class: `chip pr-${w.priority}` }, PRIORITIES[w.priority].name), ' ',
        h('span', { class: `chip wo-${w.state}` }, WO_STATES[w.state]), ' ',
        h('span', { class: `sla${w.overdue ? ' sla-over' : ''}` }, slaText(w, now))),
      h('dl', {},
        row('Asset', `${w.assetName}, ${w.locationName}`),
        row('Reported', `${fmtTime(w.reportedAt)} by ${roleById(w.reportedByRole)?.name || w.reportedByRole}`),
        row('Target', `${fmtTime(w.dueAt)} (${PRIORITIES[w.priority].name.toLowerCase()})`),
        row('Team', TEAMS[w.team] || w.team),
        row('Label link', h('code', { class: 'label-link' }, `${location.origin}${location.pathname}#/engineering/report/${w.assetId}`)),
        w.repeat ? row('Repeat fault', `${w.repeat} earlier on this asset in 30 days`) : null,
        w.completedAt ? row('Closed', `${fmtTime(w.completedAt)}: ${OUTCOMES[w.outcome] || w.outcome}`) : null),
      mayAssign ? h('div', { class: 'field' }, h('label', { for: 'wo-team' }, 'Team'), teamSel) : null,
      mayClose ? h('div', { class: 'field' }, h('label', { for: 'wo-outcome' }, 'Outcome'), outSel) : null,
      h('p', { class: 'meta' }, mayAssign || mayClose ? `Each change is saved to the event log as ${roleById(ctx.role).name}.`
        : open ? `${roleById(ctx.role).name} can see this work order but not change it.` : 'This work order is closed.'),
      h('div', { class: 'actions' },
        mayAssign ? h('button', { class: 'btn btn-ghost', type: 'button', 'data-cmd': 'ospeli_workorders_assign', onclick: () => { dialog.close(); act('ospeli_workorders_assign', w, { team: teamSel.value }); } }, 'Assign') : null,
        mayClose ? h('button', { class: 'btn', type: 'button', 'data-cmd': 'ospeli_workorders_complete', onclick: () => { dialog.close(); act('ospeli_workorders_complete', w, { outcome: outSel.value }); } }, 'Close work order') : null,
        h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => dialog.close() }, 'Close')));
    dialog.showModal();
  }

  function draw() {
    if (!data.open) return;
    const c = data.open.counts;
    const stat = (n, label, test) => h('div', { class: 'stat', 'data-test': test }, h('b', {}, n), h('span', {}, label));
    counts.replaceChildren(stat(c.open, 'Open', 'wo-open'), stat(c.overdue, 'Overdue', 'wo-overdue'), stat(c.repeat, 'Repeat faults open', 'wo-repeat'));
    filterRow.replaceChildren(...FILTERS.map(([id, label]) => h('button', {
      type: 'button', class: 'chip-btn', 'aria-pressed': String(ui.filter === id), 'data-filter': id, onclick: () => { ui.filter = id; draw(); },
    }, label)));
    const now = new Date().toISOString();
    let rows = ui.filter === 'completed' ? data.completed.workOrders.slice(0, 30) : data.open.workOrders;
    if (ui.filter === 'overdue') rows = rows.filter((w) => w.overdue);
    if (ui.filter === 'repeat') rows = rows.filter((w) => w.repeat > 0);
    list.replaceChildren(...(rows.length ? rows.map((w) => h('li', {},
      h('button', {
        type: 'button', class: `wo pr-${w.priority}${w.overdue ? ' is-over' : ''}`, 'data-wo': w.id, 'data-cmd': 'ospeli_workorders_list',
        'aria-label': `${w.id.toUpperCase()}, ${w.title}, ${w.assetName}, ${w.locationName}, ${PRIORITIES[w.priority].name}, ${slaText(w, now)}${w.repeat ? ', repeat fault' : ''}`,
        onclick: () => openWorkOrder(w),
      },
        h('span', { class: 'wo-top' }, h('b', {}, w.title), h('span', { class: `sla${w.overdue ? ' sla-over' : ''}` }, slaText(w, now))),
        h('span', { class: 'wo-where' }, `${w.assetName} · ${w.locationName}`),
        h('span', { class: 'wo-tags' },
          h('span', { class: `chip pr-${w.priority}` }, PRIORITIES[w.priority].name),
          h('span', { class: `chip wo-${w.state}` }, w.state === 'completed' ? OUTCOMES[w.outcome] || 'Completed' : WO_STATES[w.state]),
          w.state !== 'open' ? h('span', { class: 'meta' }, TEAMS[w.team]) : null,
          w.repeat ? h('span', { class: 'chip repeat' }, `Repeat ×${w.repeat + 1}`) : null)))) : [h('li', { class: 'meta' }, 'No work orders here.')]));
  }

  async function renderKpis() {
    kpiBox.replaceChildren(kpiTiles(['open-work-orders', 'overdue-work-orders'], await kpiContext(core)));
  }

  const props = proposalsCard(ctx, {
    match: (p) => p.command.startsWith('ospeli_workorders_'),
    describe: (p) => (p.command === 'ospeli_workorders_report_fault'
      ? `Report: ${p.input.fault}, ${assets.get(p.input.assetId)?.name || p.input.assetId} (${PRIORITIES[p.input.priority]?.name || p.input.priority})`
      : `${p.input.workOrderId?.toUpperCase()}: ${p.command === 'ospeli_workorders_assign' ? `assign to ${TEAMS[p.input.team]}` : `close as ${OUTCOMES[p.input.outcome]}`}`),
  });

  const queueFirst = ctx.role === 'estates-tech' && !deepAsset;
  const queue = h('section', { class: 'section', 'aria-labelledby': 'queue-h' },
    h('h2', { id: 'queue-h' }, 'Work-order queue'),
    h('p', { class: 'meta' }, 'Overdue first, then by urgency and due time. Targets: urgent 4 h, high 24 h, routine 72 h (examples; set locally).'),
    counts, filterRow, list);
  const reportSection = canReport ? h('section', { class: 'section' }, form)
    : h('p', { class: 'meta' }, `${roleById(ctx.role).name} can see the queue but not report faults here.`);
  el.append(
    h('div', { class: 'page-head' },
      h('div', {},
        h('p', { class: 'eyebrow' }, 'Engineering'),
        h('h1', {}, 'Faults and work orders'),
        h('p', {}, 'Report a fault in three taps. The facilities and equipment teams work the queue from the same log.'))),
    props.el,
    queueFirst ? queue : reportSection,
    queueFirst ? reportSection : queue,
    h('section', { class: 'section', 'aria-labelledby': 'eng-kpi-h' },
      h('h2', { id: 'eng-kpi-h' }, 'Engineering numbers'),
      h('p', { class: 'meta' }, 'Calculated from the same event log. Tap a number to see how it is defined.'),
      kpiBox),
    dialog);
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
