// Engineering work orders (backlog item 7), derived only from the event log, like beds.
// A fault report opens a work order; it is assigned to a team, then completed with an outcome.
// Teams, not people, are assigned (rule 3: measure flows, never people).

import { WORK_ORDER_SLA_HOURS } from './kpi.js';
import { currentWords } from './model.js';

const HOUR = 3600e3;
const DAY = 24 * HOUR;
const ms = (iso) => Date.parse(iso);

export const PRIORITIES = {
  urgent: { name: 'Urgent', hint: 'Unsafe, or stops care in this area now' },
  high: { name: 'High', hint: 'Needed today' },
  routine: { name: 'Routine', hint: 'Can wait for the planned round' },
};
export const TEAMS = { estates: 'Facilities team', biomed: 'Medical equipment team', contractor: 'External contractor' };
export const OUTCOMES = { fixed: 'Fixed', escalated: 'Escalated', 'no-fault-found': 'No fault found' };
export const WO_STATES = { open: 'Reported', assigned: 'Assigned', completed: 'Completed' };

// What can go wrong with each kind of asset, and which team usually fixes it. Picking from a list
// (not free text) keeps personal details out of the log (rule 1, issue #19) and makes repeats countable.
export const FAULT_TYPES = {
  'infusion-pump': [['IV pump alarm', 'biomed'], ['IV pump will not power on', 'biomed']],
  suction: [['Suction unit not pulling', 'biomed']],
  'o2-flowmeter': [['Oxygen flowmeter check', 'biomed'], ['Oxygen flowmeter leaking', 'biomed']],
  'call-bell': [['Nurse call not working', 'estates']],
  ac: [['AC filter blocked', 'estates'], ['AC not cooling', 'estates']],
  sink: [['Blocked sink', 'estates'], ['Tap leaking', 'estates']],
  'door-closer': [['Door closer broken', 'estates'], ['Door will not latch', 'estates']],
  light: [['Light fitting out', 'estates'], ['Tripped breaker', 'estates']],
  bed: [['Bed brake faulty', 'estates']],
  generator: [['Generator test fault', 'estates']],
  chiller: [['Chiller high temperature', 'estates']],
  lift: [['Lift out of service', 'estates']],
  boiler: [['Boiler pressure low', 'estates']],
  imaging: [['X-ray detector error', 'biomed']],
  lab: [['Analyser calibration error', 'biomed']],
};
export const OTHER_FAULT = 'Other fault (describe to the team in person)';
export const ALL_FAULTS = [...new Set(Object.values(FAULT_TYPES).flat().map(([t]) => t)), OTHER_FAULT];
export const faultsFor = (kind) => [...(FAULT_TYPES[kind] || []).map(([t]) => t), OTHER_FAULT];
export const teamFor = (kind, title) => (FAULT_TYPES[kind] || []).find(([t]) => t === title)?.[1] ?? 'estates';

export const REPEAT_WINDOW_DAYS = 30;
export const slaHours = (priority) => WORK_ORDER_SLA_HOURS[priority] ?? WORK_ORDER_SLA_HOURS.routine;

// Build every work order from the log. `now` (ISO) sets the SLA clock.
// A repeat fault is one that failed again after a fix: `repeat` counts the earlier work orders for
// the same fault on the same asset that were closed as Fixed in the 30 days before this report.
// A second report while a work order is still open is a duplicate, never a repeat (issue #24).
// A work order closed as "No fault found" or "Escalated" fixed nothing, a different fault is a
// different fault, and two "Other fault" reports cannot be told to be the same one, so none of
// those counts (issue #75).
// A fault stored under a word that has since changed (issue #82) is read with the current word, so
// the title on screen is current and an old report and a new one of the same fault still match.
export function deriveWorkOrders(events, now) {
  const orders = new Map();
  const fixes = new Map(); // asset and fault -> times an earlier work order for it was closed as Fixed
  const key = (assetId, title) => `${assetId}|${title}`;
  for (const e of events) {
    if (e.type === 'asset.fault-reported' && e.data?.workOrder) {
      const at = ms(e.at);
      const title = currentWords(e.data.title);
      const prior = title === OTHER_FAULT ? [] : (fixes.get(key(e.subject, title)) || []).filter((t) => t <= at && at - t <= REPEAT_WINDOW_DAYS * DAY);
      orders.set(e.data.workOrder, {
        id: e.data.workOrder, assetId: e.subject, title, team: e.data.trade || 'estates',
        priority: e.data.priority || 'routine', state: 'open', reportedAt: e.at, reportedByRole: e.actorRole,
        assignedAt: null, completedAt: null, outcome: null,
        dueAt: new Date(at + slaHours(e.data.priority) * HOUR).toISOString(),
        repeat: prior.length, // earlier work orders for this fault on this asset closed as Fixed in the 30 days before this report
      });
    } else if (e.type === 'workorder.assigned') {
      const w = orders.get(e.subject);
      if (w && w.state !== 'completed') Object.assign(w, { state: 'assigned', assignedAt: e.at, team: e.data?.trade || w.team });
    } else if (e.type === 'workorder.completed') {
      const w = orders.get(e.subject);
      if (w && w.state !== 'completed') {
        Object.assign(w, { state: 'completed', completedAt: e.at, outcome: e.data?.outcome || 'fixed' });
        if (w.outcome === 'fixed') fixes.set(key(w.assetId, w.title), [...(fixes.get(key(w.assetId, w.title)) || []), ms(e.at)]);
      }
    }
  }
  const t = ms(now);
  for (const w of orders.values()) {
    w.overdue = w.state !== 'completed' && t > ms(w.dueAt);
    w.metSla = w.state === 'completed' ? ms(w.completedAt) <= ms(w.dueAt) : null;
  }
  return orders;
}

// The open work order for the same fault on the same asset, if there is one (issue #24): a second
// report of it is a duplicate and opens nothing. The oldest one wins.
export function openDuplicate(orders, assetId, fault) {
  for (const w of orders.values()) if (w.state !== 'completed' && w.assetId === assetId && w.title === fault) return w;
  return null;
}

// How long ago, in words: "just now", "2 min ago", "3 h ago", "2 d ago".
export function agoText(fromIso, nowIso) {
  const m = Math.max(0, Math.floor((ms(nowIso) - ms(fromIso)) / 60e3));
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 48 * 60 ? `${Math.floor(m / 60)} h ago` : `${Math.floor(m / 1440)} d ago`;
}

// "1 earlier fix" or "2 earlier fixes", for the repeat-fault words on screen. The badge and the
// sentence use the same number (issue #75).
const fixWords = (n) => `${n} earlier ${n === 1 ? 'fix' : 'fixes'}`;
export const repeatText = (n) => `Failed again after a fix: ${fixWords(n)} of this fault on this asset in 30 days`;
export const repeatBadge = (n) => `Repeat: ${fixWords(n)}`;

// Actions on a work order, in the order a person would take them.
export function workOrderActions(w) {
  if (!w || w.state === 'completed') return [];
  return ['assign', 'complete']; // re-assigning to another team is allowed
}

export function nextWorkOrderId(events) {
  let max = 0;
  for (const e of events) {
    if (e.type === 'asset.fault-reported') {
      const n = Number(String(e.data?.workOrder || '').replace(/^wo-/, ''));
      if (Number.isFinite(n) && n > max) max = n;
    }
  }
  return `wo-${String(max + 1).padStart(5, '0')}`;
}

// Time left to the SLA, in words: "due in 3 h 10 min" or "overdue by 2 h".
export function slaText(w, now) {
  if (w.state === 'completed') return w.metSla ? 'Done within target' : 'Done after target';
  const left = ms(w.dueAt) - ms(now);
  const m = Math.round(Math.abs(left) / 60e3);
  const span = m < 60 ? `${m} min` : m < 48 * 60 ? `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}` : `${Math.floor(m / 1440)} d ${Math.floor((m % 1440) / 60)} h`;
  return left >= 0 ? `Due in ${span}` : `Overdue by ${span}`;
}
