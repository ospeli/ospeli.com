// KPI library (foundation section 5.6). Every KPI has a written definition and is
// calculated only from the event log, so every number can be recomputed and checked.
// Calculations are pure functions: (events, options) -> result.

const HOUR = 3600e3;
const MIN = 60e3;

// Fix targets used to decide when a work order is late: the clock runs from the fault report to the
// job being closed (rectification), not to someone attending (response). Example values, set locally
// (issue #33).
export const WORK_ORDER_SLA_HOURS = { urgent: 4, high: 24, routine: 72 };

export const KPIS = [
  {
    id: 'occupancy', name: 'Bed occupancy', unit: '%', decimals: 0, direction: 'lower',
    numerator: 'Beds with a patient in them at the time shown (admitted and not yet discharged).',
    denominator: 'All inpatient beds in the hospital model.',
    exclusions: 'Day-case and emergency department stretchers are not inpatient beds. Beds not yet cleaned count as empty.',
    source: 'Ospeli definition: a point-in-time count of occupied beds, not an average over the period. The 85% example target comes from modelling of average occupancy over time (Bagust et al. 1999, BMJ, PMID 10406748, doi:10.1136/bmj.319.7203.155), so it is a guide for this count, not a limit for one moment.',
    owner: 'bed-manager', target: 85, targetText: '85% or lower (example target; set locally)',
  },
  {
    id: 'alos', name: 'Average length of stay', unit: 'days', decimals: 1, direction: 'lower',
    numerator: 'Total time in hospital, admission to discharge, for patients discharged in the period.',
    denominator: 'Number of patients discharged in the period.',
    exclusions: 'Patients still in hospital at the end of the period.',
    source: 'Ospeli definition: the mean stay of patients discharged in the period. No published standard is named; a few very long stays pull the mean up.',
    owner: 'ops-manager', target: null, targetText: 'Set by specialty',
  },
  {
    id: 'discharges-before-noon', name: 'Discharges before noon', unit: '%', decimals: 0, direction: 'higher',
    numerator: 'Discharges in the period that happened before 12:00 local time.',
    denominator: 'All discharges in the period.',
    exclusions: 'Deaths and transfers are not yet separated in the synthetic data.',
    source: 'Common patient-flow measure (share of discharges before midday).',
    owner: 'ward-nurse', target: 33, targetText: '33% or higher (example target; set locally)',
  },
  {
    id: 'decision-to-bed', name: 'Decision to admit to ward bed (ED)', unit: 'hours', decimals: 1, direction: 'lower',
    numerator: 'Median time from the decision to admit in the emergency department (ED) to the patient arriving in a ward bed. The 90th percentile is shown beside it, so long waits are not hidden.',
    denominator: 'Patients admitted from the ED in the period.',
    exclusions: 'Elective admissions, and ED patients still waiting for a bed.',
    source: 'Ospeli definition (decision to admit to arrival in a ward bed). Agreed definitions of emergency department time intervals: Welch et al. 2011, Ann Emerg Med, PMID 21067846, doi:10.1016/j.annemergmed.2010.08.040.',
    owner: 'bed-manager', target: 4, targetText: '4 hours or less (local example; not a four-hour emergency department standard, which runs from arrival to departure)',
  },
  {
    id: 'bed-turnaround', name: 'Bed turnaround', unit: 'minutes', decimals: 0, direction: 'lower',
    numerator: 'Median time from a bed being vacated to it being cleaned and ready. The 90th percentile is shown beside it.',
    denominator: 'Beds cleaned in the period.',
    exclusions: 'Beds vacated but not yet cleaned.',
    source: 'No published standard; Ospeli definition.',
    owner: 'bed-manager', target: 60, targetText: '60 minutes or less (example target; set locally)',
  },
  {
    id: 'open-work-orders', name: 'Open work orders', unit: 'count', decimals: 0, direction: 'lower',
    numerator: 'Faults reported and not yet completed at the time shown.',
    denominator: 'None (a count).',
    exclusions: 'Planned maintenance is not included yet.',
    source: 'No published standard; Ospeli definition.',
    owner: 'estates-tech', target: null, targetText: 'Track the trend',
  },
  {
    id: 'overdue-work-orders', name: 'Late work orders', unit: 'count', decimals: 0, direction: 'lower',
    numerator: 'Open work orders past their fix target: urgent 4 h, high 24 h, routine 72 h, counted from the fault report until the job is closed. This is a fix (rectification) clock, not a response clock: someone attending does not stop it.',
    denominator: 'None (a count).',
    exclusions: 'Completed work orders.',
    source: 'No published standard; Ospeli definition. Fix targets are examples, set locally. A separate response target (time until someone attends) is not measured yet.',
    owner: 'estates-tech', target: 0, targetText: 'None late',
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
// Nearest-rank percentile (issue #33: the 90th beside a median, so long waits show).
export const percentile = (xs, p) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))];
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
    return { numerator: null, denominator: waits.length, value: median(waits), p90: percentile(waits, 0.9) };
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
    return { numerator: null, denominator: times.length, value: median(times), p90: percentile(times, 0.9) };
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
