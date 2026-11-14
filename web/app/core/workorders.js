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
export const WO_STATES = { open: 'Reported', assigned: 'Assigned', started: 'In progress', completed: 'Completed' };
// The team a role works in. Work is by team or role, never by person (issue #83).
export const ROLE_TEAMS = { 'estates-tech': 'estates' };
export const teamOfRole = (role) => ROLE_TEAMS[role] ?? null;

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
        assignedAt: null, startedAt: null, startedByRole: null, completedAt: null, outcome: null,
        dueAt: new Date(at + slaHours(e.data.priority) * HOUR).toISOString(),
        repeat: prior.length, // earlier work orders for this fault on this asset closed as Fixed in the 30 days before this report
      });
    } else if (e.type === 'workorder.assigned') {
      const w = orders.get(e.subject);
      // Assigning a job that is in progress hands it on: the team it goes to has not started it.
      if (w && w.state !== 'completed') Object.assign(w, { state: 'assigned', assignedAt: e.at, team: e.data?.trade || w.team, startedAt: null, startedByRole: null });
    } else if (e.type === 'workorder.started') {
      // Issue #83: someone in a role started the job. The role is kept, never the person.
      const w = orders.get(e.subject);
      if (w && w.state !== 'completed' && w.state !== 'started') Object.assign(w, { state: 'started', startedAt: e.at, startedByRole: e.actorRole });
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
  return w.state === 'started' ? ['assign', 'complete'] : ['start', 'assign', 'complete']; // re-assigning to another team is allowed
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

// Time to the target, in words: "Due in 3 h 10 min" or "Late by 2 d 3 h".
const spanText = (m) => (m < 60 ? `${m} min` : m < 48 * 60 ? `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}` : `${Math.floor(m / 1440)} d ${Math.floor((m % 1440) / 60)} h`);
export function slaText(w, now) {
  if (w.state === 'completed') return w.metSla ? 'Done within target' : 'Done after target';
  const left = ms(w.dueAt) - ms(now);
  const span = spanText(Math.round(Math.abs(left) / 60e3));
  return left >= 0 ? `Due in ${span}` : `Late by ${span}`;
}

// Lateness as a number (issue #83): whole minutes past the due time, 0 when not late or completed.
export function lateMinutes(w, now) {
  if (w.state === 'completed') return 0;
  return Math.max(0, Math.round((ms(now) - ms(w.dueAt)) / 60e3));
}
// The length of the small bar beside the number, 0 to 100: this job's lateness as a share of the
// most late job in view (maxMinutes). A late job always shows a little bar; one that is not late shows none.
export function lateBar(w, now, maxMinutes) {
  const late = lateMinutes(w, now);
  if (!late) return 0;
  return Math.min(100, Math.max(4, Math.round((100 * late) / Math.max(late, maxMinutes || 0))));
}

// ---- "Do next" (issue #83) ----
// The suggestion is a fixed rule that the screen can say out loud. It is not AI and works with AI off.
export const PRIORITY_RANK = { urgent: 0, high: 1, routine: 2 };
export const SUGGEST_RULE = 'This is a fixed rule, not AI: highest priority first, then the most late. It works with AI off.';
const rankOf = (w) => PRIORITY_RANK[w.priority] ?? PRIORITY_RANK.routine;
const listOf = (orders) => (orders instanceof Map ? [...orders.values()] : [...orders]);
// Highest priority, then most late (earliest due time), then the oldest report, then the id.
const byRule = (a, b) => (rankOf(a) - rankOf(b)) || (ms(a.dueAt) - ms(b.dueAt)) || (ms(a.reportedAt) - ms(b.reportedAt)) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

// The jobs a team could start next, in the order of the rule. Jobs in progress, completed jobs and
// jobs that belong to another team are left out.
export function suggestQueue(orders, team = 'estates') {
  return listOf(orders).filter((w) => w.team === team && (w.state === 'open' || w.state === 'assigned')).sort(byRule);
}

const PRIORITY_WORDS = { urgent: 'urgent', high: 'high priority', routine: 'routine' };
const cap = (s) => s[0].toUpperCase() + s.slice(1);
function suggestReason(queue, i, now) {
  const w = queue[i];
  const words = PRIORITY_WORDS[w.priority] || PRIORITY_WORDS.routine;
  if (queue.length === 1) return 'Why this one: it is the only job open for this team.';
  if (i > 0) return `Why this one: next by the same rule (${i + 1} of ${queue.length}). ${cap(words)}, ${slaText(w, now).toLowerCase()}.`;
  const same = queue.filter((x) => rankOf(x) === rankOf(w)).length;
  const higher = Object.keys(PRIORITY_RANK).filter((p) => PRIORITY_RANK[p] < rankOf(w)).map((p) => PRIORITY_WORDS[p].replace(' priority', ''));
  const lead = higher.length ? `no ${higher.join(' or ')}${higher.length > 1 ? ' priority' : ''} jobs are open. ${cap(words)}` : words;
  if (same === 1) return `Why this one: ${lead}, and the only ${words} job.`;
  return `Why this one: ${lead}, and ${ms(now) > ms(w.dueAt) ? 'the most late' : 'due first'} of the ${same} ${words} jobs.`;
}

// The suggested job for a team. skip moves on through the same order ("Pick another") and wraps.
export function suggestNext(orders, { team = 'estates', skip = 0, now } = {}) {
  const queue = suggestQueue(orders, team);
  if (!queue.length) return { workOrder: null, position: 0, total: 0, reason: 'No job is waiting for this team.' };
  const i = ((Math.trunc(skip) % queue.length) + queue.length) % queue.length;
  return { workOrder: queue[i], position: i + 1, total: queue.length, reason: suggestReason(queue, i, now) };
}

// The list under the suggestion, as groups in order. priority: Urgent, High, Routine, most late
// first in each. late: one group, most late first. ward: by place name, then by the rule.
// Each work order needs locationName for the ward sort.
export const WO_SORTS = { priority: 'Priority', late: 'Most late', ward: 'Ward' };
export function sortWorkOrders(list, sort = 'priority') {
  const rows = [...list].sort(byRule);
  if (!rows.length) return [];
  if (sort === 'late') return [{ id: 'all', name: null, items: rows.sort((a, b) => (ms(a.dueAt) - ms(b.dueAt)) || byRule(a, b)) }];
  const groups = new Map();
  for (const w of rows) {
    const id = sort === 'ward' ? (w.locationName || 'Other places') : w.priority;
    if (!groups.has(id)) groups.set(id, { id, name: sort === 'ward' ? id : PRIORITIES[w.priority]?.name || id, items: [] });
    groups.get(id).items.push(w);
  }
  const out = [...groups.values()];
  if (sort === 'ward') out.sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }));
  return out;
}
