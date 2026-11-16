// The shared task object: a job asked for at a place, done by a team, tracked from request to
// done. Cleaning, moving patients and goods, deliveries and later transport all use it; each
// module adds its own kinds of task as configuration (see TASK_KINDS in a module's commands.js).
//
// Derived only from the event log, like the bed board: nothing about a task is stored except
// events, so the queue, the KPIs and an auditor all read the same record.
//
// Measure flows, never people: a task records the role that asked, started and finished it,
// never a person, and it belongs to a team's queue, never to a named member of staff.
//
// Two sources, one list:
// - asked-for tasks: task.requested -> task.started -> task.completed (or task.cancelled);
//   task.prioritised moves an open task to the front of its team's queue, or back;
//   task.released puts a started task back in the queue, in its old place, with a reason;
// - bed cleans: a bed that is vacated IS a clean task. It is read from the bed's own events
//   (bed.vacated -> bed.clean-started -> bed.cleaned; bed.clean-stopped puts it back to waiting), so the bed board and
//   the cleaning queue can never disagree and no one has to tell cleaning that a bed is empty.

export const TASK_STATES = {
  requested: { name: 'Waiting' },
  started: { name: 'In progress' },
  completed: { name: 'Done' },
  cancelled: { name: 'Cancelled' },
};
export const TASK_PRIORITIES = { urgent: { name: 'Urgent' }, routine: { name: 'Routine' } };
// No free text on a task: a reason is picked from a list, so no personal detail can be typed.
// Why a job that was started went back to the queue. A pick list, like every reason on a task.
export const RELEASE_REASONS = ['Patient or item not ready', 'Needs a second person', 'Wrong place or details', 'Called to an urgent job', 'Started by mistake'];
export const CANCEL_REASONS = ['No longer needed', 'Asked for by mistake', 'Done another way', 'Other'];

// Built into the core: the bed clean, because it is read from bed events. Every other kind
// comes from a module. `derived` kinds cannot be asked for by hand.
export const CORE_TEAMS = { cleaning: 'Cleaning' };
export const BED_CLEAN = {
  id: 'bed-clean', name: 'Bed clean', team: 'cleaning', derived: true,
  startLabel: 'Start clean', startedName: 'Cleaning', doneLabel: 'Clean done: bed ready',
  requestRoles: [], doRoles: ['cleaner', 'support-supervisor', 'ward-nurse', 'bed-manager'],
  // Who may move it to the front of the queue (or back): the people who balance the work.
  leadRoles: ['support-supervisor', 'bed-manager'],
};

const KIND_ID = /^[a-z][a-z0-9-]{1,30}$/;

// Put the core's kinds and the modules' kinds together. A module's kind is refused (throws at
// load, so a test catches it) when it is malformed, reuses an id, or names a role or team that
// does not exist. packs: [{ id, TASK_TEAMS?: { id: name }, TASK_KINDS?: [kind] }].
export function taskCatalogue(packs = [], roleIds = []) {
  const teams = { ...CORE_TEAMS };
  const kinds = new Map([[BED_CLEAN.id, BED_CLEAN]]);
  for (const p of packs) {
    for (const [id, name] of Object.entries(p.TASK_TEAMS || {})) {
      if (!KIND_ID.test(id) || typeof name !== 'string' || !name.trim()) throw new Error(`module ${p.id}: bad task team ${id}`);
      if (teams[id] && teams[id] !== name) throw new Error(`module ${p.id}: task team ${id} already exists`);
      teams[id] = name;
    }
  }
  for (const p of packs) {
    for (const k of p.TASK_KINDS || []) {
      const bad = (why) => { throw new Error(`module ${p.id}: task kind ${k?.id}: ${why}`); };
      if (!k || !KIND_ID.test(k.id)) bad('id must be lower-case letters, digits and hyphens');
      if (kinds.has(k.id)) bad('this id is already used');
      if (typeof k.name !== 'string' || !k.name.trim()) bad('name is required');
      if (!teams[k.team]) bad(`unknown team ${k.team}`);
      if (k.derived) bad('only the core may add a derived kind');
      for (const list of ['requestRoles', 'doRoles']) {
        if (!Array.isArray(k[list]) || !k[list].length) bad(`${list} is required`);
        for (const r of k[list]) if (!roleIds.includes(r)) bad(`unknown role ${r} in ${list}`);
      }
      if (k.leadRoles != null && !(Array.isArray(k.leadRoles) && k.leadRoles.length && k.leadRoles.every((r) => roleIds.includes(r)))) bad('leadRoles must be a list of real roles');
      if (k.repeatable != null && typeof k.repeatable !== 'boolean') bad('repeatable is true or false');
      if (k.details && !(Array.isArray(k.details) && k.details.every((d) => typeof d === 'string' && d.trim() && d.length <= 60))) bad('details must be a list of short strings');
      kinds.set(k.id, {
        startLabel: 'Start', startedName: 'In progress', doneLabel: 'Done', needsTo: false, details: null, ...k,
        placeTypes: k.placeTypes || ['ward', 'department', 'bed'], leadRoles: k.leadRoles || k.doRoles, module: p.id,
      });
    }
  }
  return { teams, kinds };
}

const ms = (iso) => Date.parse(iso);
const mins = (from, to) => Math.max(0, Math.round((ms(to) - ms(from)) / 60000));
const TASK_ID = /^task-(\d{5,})$/;
export const TASK_ID_PATTERN = '^(task-[0-9]{5,}|clean-[a-z0-9][a-z0-9-]*)$';
export const bedCleanId = (bedId) => `clean-${bedId}`;
export const bedOfCleanId = (taskId) => (String(taskId).startsWith('clean-') ? String(taskId).slice(6) : null);

// Replay the event log. Returns { all: [task], open: Map(id -> task) }, oldest first.
// A task is { id, kind, source, locationId, toLocationId, priority, detail, state, requestedAt,
// requestedByRole, startedAt, startedByRole, completedAt, completedByRole, cancelledAt, cancelReason }.
// `beds`: Map(bedId -> wardId) or null. Bed cleans are only read when it is given.
export function deriveTasks(events, { beds = null } = {}) {
  const all = [];
  const open = new Map();
  const seen = new Set();
  const base = (id, kind, source, at, role, extra) => ({
    id, kind, source, locationId: null, toLocationId: null, priority: 'routine', detail: null, state: 'requested',
    requestedAt: at, requestedByRole: role, startedAt: null, startedByRole: null, completedAt: null, completedByRole: null,
    cancelledAt: null, cancelReason: null, releases: 0, lastReleaseReason: null, ...extra,
  });
  // Back to waiting, in its old place: the time it was asked for does not change.
  const release = (t, reason) => Object.assign(t, { state: 'requested', startedAt: null, startedByRole: null, releases: t.releases + 1, lastReleaseReason: reason ?? null });
  const add = (t) => { all.push(t); open.set(t.id, t); return t; };
  const close = (t, state, at, role, reason = null) => {
    if (state === 'completed') Object.assign(t, { state, completedAt: at, completedByRole: role });
    else Object.assign(t, { state, cancelledAt: at, cancelReason: reason });
    open.delete(t.id);
  };
  for (const e of events) {
    const d = e.data || {};
    switch (e.type) {
      case 'task.requested':
        if (TASK_ID.test(e.subject) && !seen.has(e.subject)) {
          seen.add(e.subject);
          add(base(e.subject, d.kind, 'task', e.at, e.actorRole, {
            locationId: d.locationId ?? null, toLocationId: d.toLocationId ?? null,
            priority: TASK_PRIORITIES[d.priority] ? d.priority : 'routine', detail: d.detail ?? null,
          }));
        }
        break;
      case 'task.started': {
        const t = open.get(e.subject);
        if (t && t.source === 'task' && t.state === 'requested') Object.assign(t, { state: 'started', startedAt: e.at, startedByRole: e.actorRole });
        break;
      }
      case 'task.released': {
        const t = open.get(e.subject);
        if (t && t.source === 'task' && t.state === 'started') release(t, d.reason);
        break;
      }
      case 'task.completed': {
        const t = open.get(e.subject);
        if (t && t.source === 'task') close(t, 'completed', e.at, e.actorRole);
        break;
      }
      // Moved to the front of its team's queue, or back. Works for a bed clean too: the
      // subject is the open task's id, and the mark ends with that clean.
      case 'task.prioritised': {
        const t = open.get(e.subject);
        if (t && TASK_PRIORITIES[d.priority]) t.priority = d.priority;
        break;
      }
      case 'task.cancelled': {
        const t = open.get(e.subject);
        if (t && t.source === 'task') close(t, 'cancelled', e.at, e.actorRole, d.reason ?? null);
        break;
      }
      // Bed cleans, read from the bed's own events.
      // The clean is asked for at the moment the bed is vacated: the same start the bed
      // turnaround KPI uses (bed vacated -> clean and ready).
      case 'bed.vacated':
        if (beds && beds.has(e.subject) && !open.has(bedCleanId(e.subject))) {
          add(base(bedCleanId(e.subject), BED_CLEAN.id, 'bed', e.at, e.actorRole, { locationId: e.subject }));
        }
        break;
      case 'bed.clean-started': {
        const t = open.get(bedCleanId(e.subject));
        if (t && t.state === 'requested') Object.assign(t, { state: 'started', startedAt: e.at, startedByRole: e.actorRole });
        break;
      }
      case 'bed.clean-stopped': {
        const t = open.get(bedCleanId(e.subject));
        if (t && t.state === 'started') release(t, d.reason);
        break;
      }
      case 'bed.cleaned': {
        const t = open.get(bedCleanId(e.subject));
        if (t) close(t, 'completed', e.at, e.actorRole);
        break;
      }
      // A bed taken out of service, or given to a new patient, no longer waits for this clean.
      case 'bed.out-of-service': {
        const t = open.get(bedCleanId(e.subject));
        if (t) close(t, 'cancelled', e.at, e.actorRole, 'Bed taken out of service');
        break;
      }
      case 'patient.admitted': {
        const t = open.get(bedCleanId(d.bedId));
        if (t) close(t, 'cancelled', e.at, e.actorRole, 'Bed in use again');
        break;
      }
      default: break;
    }
  }
  return { all, open };
}

export function nextTaskId(events) {
  let max = 0;
  for (const e of events) {
    const m = e.type === 'task.requested' ? TASK_ID.exec(e.subject) : null;
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `task-${String(max + 1).padStart(5, '0')}`;
}

// One open task of a kind for the same place, destination and detail: a second request names
// the first instead of opening another.
export function openDuplicate(open, { kind, locationId, toLocationId = null, detail = null }) {
  for (const t of open.values()) {
    if (t.kind === kind && t.locationId === locationId && (t.toLocationId ?? null) === (toLocationId ?? null) && (t.detail ?? null) === (detail ?? null)) return t;
  }
  return null;
}

// How long it has waited (asked for until started, or until now) and how long it took in all.
export function taskTimes(t, now) {
  const waitEnd = t.startedAt || t.completedAt || t.cancelledAt || now;
  return {
    waitMinutes: mins(t.requestedAt, waitEnd),
    totalMinutes: t.completedAt ? mins(t.requestedAt, t.completedAt) : null,
    ageMinutes: mins(t.requestedAt, t.completedAt || t.cancelledAt || now),
  };
}

// The order a team works in: urgent first, then the one that has waited longest.
export function sortQueue(tasks) {
  return [...tasks].sort((a, b) => ((a.priority === 'urgent' ? 0 : 1) - (b.priority === 'urgent' ? 0 : 1))
    || (a.requestedAt < b.requestedAt ? -1 : a.requestedAt > b.requestedAt ? 1 : (a.id < b.id ? -1 : 1)));
}

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// Request to completion for tasks completed in the period (since <= completedAt < until),
// for the tasks `pick` keeps. Local definition: median minutes from asked-for to done.
// Cancelled and still-open tasks are left out. Returns { n, medianMinutes, medianWaitMinutes }.
export function completionStats(all, { since = null, until, pick = () => true }) {
  if (!until) throw new Error('until is required');
  const done = all.filter((t) => t.state === 'completed' && t.completedAt < until && (since == null || t.completedAt >= since) && pick(t));
  return {
    n: done.length,
    medianMinutes: median(done.map((t) => (ms(t.completedAt) - ms(t.requestedAt)) / 60000)),
    medianWaitMinutes: median(done.filter((t) => t.startedAt).map((t) => (ms(t.startedAt) - ms(t.requestedAt)) / 60000)),
  };
}
