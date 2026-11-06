// KPI tiles: value, target status, and the full definition on tap. Shared by every module.
import { h } from './ui.js';
import { KPIS, kpiById, computeKpi, formatKpi, meetsTarget } from '../core/kpi.js';
import { roleById } from '../core/model.js';

const DAY = 864e5;

// Gather what every KPI needs once: events, bed count, local time offset, window.
export async function kpiContext(core, { days = 7, until = new Date().toISOString() } = {}) {
  const [events, beds, sites] = await Promise.all([core.events(), core.listEntities('bed'), core.listEntities('site')]);
  const offset = sites.find((s) => s.utcOffsetMinutes != null)?.utcOffsetMinutes ?? 0;
  return { events, opts: { since: new Date(Date.parse(until) - days * DAY).toISOString(), until, bedCount: beds.length, utcOffsetMinutes: offset }, days };
}

function definitionDialog(kpi, res, kctx) {
  const pointInTime = ['occupancy', 'open-work-orders', 'overdue-work-orders'].includes(kpi.id);
  const row = (label, text) => h('div', { class: 'def-row' }, h('dt', {}, label), h('dd', {}, text));
  const close = h('button', { class: 'btn btn-ghost', type: 'button', 'data-close': '' }, 'Close');
  const dlg = h('dialog', { class: 'kpi-dialog', 'aria-labelledby': `kpi-${kpi.id}-title` },
    h('h2', { id: `kpi-${kpi.id}-title` }, kpi.name),
    h('p', { class: 'kpi-dialog-value' }, formatKpi(kpi, res.value),
      res.denominator != null && res.numerator != null && kpi.unit === '%' ? h('span', { class: 'meta' }, ` (${res.numerator} of ${res.denominator})`) : null,
      res.denominator != null && res.numerator == null ? h('span', { class: 'meta' }, ` (from ${res.denominator})`) : null),
    h('dl', {},
      row('Counts', kpi.numerator),
      row('Out of', kpi.denominator),
      row('Leaves out', kpi.exclusions),
      row('Target', kpi.targetText),
      row('Owner', roleById(kpi.owner)?.name || kpi.owner),
      row('Source', kpi.source),
      row('Period', pointInTime ? `At ${new Date(kctx.opts.until).toLocaleString()}` : `Last ${kctx.days} days to ${new Date(kctx.opts.until).toLocaleString()}`),
      row('Calculated from', `${kctx.events.length.toLocaleString()} events in the event log, on this device.`)),
    h('div', { class: 'actions' }, close));
  dlg.addEventListener('click', (e) => { if (e.target === dlg || e.target.hasAttribute('data-close')) dlg.close(); });
  return dlg;
}

export function kpiTiles(ids, kctx) {
  const tiles = ids.map(kpiById).filter(Boolean).map((kpi) => {
    const res = computeKpi(kpi.id, kctx.events, kctx.opts);
    const ok = meetsTarget(kpi, res.value);
    const dlg = definitionDialog(kpi, res, kctx);
    const btn = h('button', { class: `kpi${ok === false ? ' kpi-off' : ok ? ' kpi-on' : ''}`, type: 'button', 'data-kpi': kpi.id,
      'aria-haspopup': 'dialog', onclick: () => dlg.showModal() },
      h('span', { class: 'kpi-name' }, kpi.name),
      h('b', { class: 'kpi-value' }, formatKpi(kpi, res.value)),
      h('span', { class: 'kpi-target' }, ok == null ? kpi.targetText : `${ok ? 'On' : 'Off'} target · ${kpi.targetText.replace(/ \(.*\)$/, '')}`),
      h('span', { class: 'sr-only' }, '. Show definition'));
    return [btn, dlg];
  });
  return h('div', { class: 'kpis' }, tiles);
}

export const ALL_KPI_IDS = KPIS.map((k) => k.id);
