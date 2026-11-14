// KPI library (foundation section 5.6). Every KPI has a written definition and is
// calculated only from the event log, so every number can be recomputed and checked.
// Calculations are pure functions: (events, options) -> result.

const HOUR = 3600e3;
const MIN = 60e3;

// Response targets used to decide when a work order is overdue (example values, set locally).
export const WORK_ORDER_SLA_HOURS = { urgent: 4, high: 24, routine: 72 };

export const KPIS = [
  {
    id: 'occupancy', name: 'Bed occupancy', unit: '%', decimals: 0, direction: 'lower',
    numerator: 'Beds with a patient in them at the time shown (admitted and not yet discharged).',
    denominator: 'All inpatient beds in the hospital model.',
    exclusions: 'Day-case and emergency department trolleys are not inpatient beds. Beds not yet cleaned count as empty.',
    source: 'General bed-occupancy definition (point-in-time census).',
    owner: 'bed-manager', target: 85, targetText: '85% or lower (example target; set locally)',
  },
  {
    id: 'alos', name: 'Average length of stay', unit: 'days', decimals: 1, direction: 'lower',
    numerator: 'Total time in hospital, admission to discharge, for patients discharged in the period.',
    denominator: 'Number of patients discharged in the period.',
    exclusions: 'Patients still in hospital at the end of the period.',
    source: 'General length-of-stay definition (mean, discharges in period).',
    owner: 'ops-manager', target: null, targetText: 'Set by specialty',
  },
  {
    id: 'discharges-before-noon', name: 'Discharges before noon', unit: '%', decimals: 0, direction: 'higher',
    numerator: 'Discharges in the period that happened before 12:00 local time.',
    denominator: 'All discharges in the period.',
    exclusions: 'Deaths and transfers are not yet separated in the synthetic data.',
    source: 'Common flow measure used in board-round programmes.',
    owner: 'ward-nurse', target: 33, targetText: '33% or higher (example target; set locally)',
  },
  {
    id: 'decision-to-bed', name: 'Decision to bed (ED)', unit: 'hours', decimals: 1, direction: 'lower',
    numerator: 'Median time from the decision to admit in the emergency department (ED) to the patient arriving in a ward bed.',
    denominator: 'Patients admitted from the ED in the period.',
    exclusions: 'Elective admissions, and ED patients still waiting for a bed.',
    source: 'General emergency department flow measure.',
    owner: 'bed-manager', target: 4, targetText: '4 hours or less (example target; set locally)',
  },
  {
    id: 'bed-turnaround', name: 'Bed turnaround', unit: 'minutes', decimals: 0, direction: 'lower',
    numerator: 'Median time from a bed being vacated to it being cleaned and ready.',
    denominator: 'Beds cleaned in the period.',
    exclusions: 'Beds vacated but not yet cleaned.',
    source: 'General bed-management measure.',
    owner: 'bed-manager', target: 60, targetText: '60 minutes or less (example target; set locally)',
  },
  {
    id: 'open-work-orders', name: 'Open work orders', unit: 'count', decimals: 0, direction: 'lower',
    numerator: 'Faults reported and not yet completed at the time shown.',
    denominator: 'None (a count).',
    exclusions: 'Planned maintenance is not included yet.',
    source: 'General maintenance backlog measure.',
    owner: 'estates-tech', target: null, targetText: 'Track the trend',
  },
  {
    id: 'overdue-work-orders', name: 'Overdue work orders', unit: 'count', decimals: 0, direction: 'lower',
    numerator: 'Open work orders older than their response target: urgent 4 h, high 24 h, routine 72 h.',
    denominator: 'None (a count).',
    exclusions: 'Completed work orders.',
    source: 'General maintenance SLA measure. Response targets are examples; set locally.',
    owner: 'estates-tech', target: 0, targetText: 'None overdue',
  },
];

export const kpiById = (id) => KPIS.find((k) => k.id === id) || null;

const ms = (iso) => Date.parse(iso);
const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const inWindow = (e, since, until) => (since == null || e.at >= since) && e.at < until;

// opts: { until (ISO, required), since (ISO), bedCount, utcOffsetMinutes }
const CALC = {
  occupancy(events, { until, bedCount }) {
    const inBed = new Set();
    for (const e of events) {
      if (e.at >= until) break;
      if (e.type === 'patient.admitted') inBed.add(e.data?.bedId);
      else if (e.type === 'patient.discharged') inBed.delete(e.data?.bedId);
    }
    return { numerator: inBed.size, denominator: bedCount, value: bedCount ? (100 * inBed.size) / bedCount : null };
  },
  alos(events, { since, until }) {
    const admitted = new Map();
    let total = 0; let n = 0;
    for (const e of events) {
      if (e.at >= until) break;
      if (e.type === 'patient.admitted') admitted.set(e.subject, ms(e.at));
      else if (e.type === 'patient.discharged' && inWindow(e, since, until) && admitted.has(e.subject)) {
        total += (ms(e.at) - admitted.get(e.subject)) / (24 * HOUR); n++;
      }
    }
    return { numerator: total, denominator: n, value: n ? total / n : null };
  },
  'discharges-before-noon'(events, { since, until, utcOffsetMinutes = 0 }) {
    let am = 0; let n = 0;
    for (const e of events) {
      if (e.type !== 'patient.discharged' || !inWindow(e, since, until)) continue;
      n++;
      if (new Date(ms(e.at) + utcOffsetMinutes * MIN).getUTCHours() < 12) am++;
    }
    return { numerator: am, denominator: n, value: n ? (100 * am) / n : null };
  },
  'decision-to-bed'(events, { since, until }) {
    const decided = new Map();
    const waits = [];
    for (const e of events) {
      if (e.at >= until) break;
      if (e.type === 'ae.decision-to-admit') decided.set(e.subject, ms(e.at));
      else if (e.type === 'patient.admitted' && inWindow(e, since, until) && decided.has(e.subject)) {
        waits.push((ms(e.at) - decided.get(e.subject)) / HOUR);
      }
    }
    return { numerator: null, denominator: waits.length, value: median(waits) };
  },
  'bed-turnaround'(events, { since, until }) {
    const vacated = new Map();
    const times = [];
    for (const e of events) {
      if (e.at >= until) break;
      if (e.type === 'bed.vacated') vacated.set(e.subject, ms(e.at));
      else if (e.type === 'bed.cleaned' && vacated.has(e.subject)) {
        if (inWindow(e, since, until)) times.push((ms(e.at) - vacated.get(e.subject)) / MIN);
        vacated.delete(e.subject);
      }
    }
    return { numerator: null, denominator: times.length, value: median(times) };
  },
  'open-work-orders'(events, opts) {
    const open = openWorkOrders(events, opts.until);
    return { numerator: open.length, denominator: null, value: open.length };
  },
  'overdue-work-orders'(events, opts) {
    const now = ms(opts.until);
    const overdue = openWorkOrders(events, opts.until)
      .filter((w) => now - w.reportedAt > (WORK_ORDER_SLA_HOURS[w.priority] ?? WORK_ORDER_SLA_HOURS.routine) * HOUR);
    return { numerator: overdue.length, denominator: null, value: overdue.length };
  },
};

export function openWorkOrders(events, until) {
  const open = new Map();
  for (const e of events) {
    if (e.at >= until) break;
    if (e.type === 'asset.fault-reported' && e.data?.workOrder) {
      open.set(e.data.workOrder, { id: e.data.workOrder, asset: e.subject, priority: e.data.priority, title: e.data.title, reportedAt: ms(e.at) });
    } else if (e.type === 'workorder.completed') open.delete(e.subject);
  }
  return [...open.values()];
}

// Events must be in time order (the event log returns them in recorded order;
// sort by `at` first if events were back-dated).
export function computeKpi(id, events, opts) {
  const calc = CALC[id];
  if (!calc) throw new Error(`unknown KPI ${id}`);
  if (!opts?.until) throw new Error('until is required');
  const sorted = isSorted(events) ? events : [...events].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.seq - b.seq));
  return { id, ...calc(sorted, opts) };
}

function isSorted(events) {
  for (let i = 1; i < events.length; i++) if (events[i].at < events[i - 1].at) return false;
  return true;
}

export function formatKpi(kpi, value) {
  if (value == null) return 'No data';
  const n = value.toFixed(kpi.decimals);
  return kpi.unit === '%' ? `${n}%` : kpi.unit === 'count' ? n : `${n} ${kpi.unit === 'minutes' ? 'min' : kpi.unit === 'hours' ? 'h' : kpi.unit}`;
}

// Is the value on the right side of its target? null when there is no target or no value.
export function meetsTarget(kpi, value) {
  if (kpi.target == null || value == null) return null;
  return kpi.direction === 'lower' ? value <= kpi.target : value >= kpi.target;
}
