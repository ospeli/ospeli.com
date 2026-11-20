// Cleaning and transport: the module's fixed lists and its pure functions. Everything here reads
// the event log and nothing else: no screen, no storage, no clock (the caller passes `now`), so
// the queue, the KPIs, the audits and the guide give the same answer in the browser, in a test
// and on a site's own server.
//
// Measure flows, never people: every number is about jobs and waits. A task records the role
// that did it, never a person, and nothing here counts or ranks a member of staff.

import { deriveTasks, completionStats, BED_CLEAN } from '../../core/tasks.js';
import { stockCatalogue, deriveStock, zeroIntervals, openRequestFor, usableOf, holdingOf, validDate } from '../../core/stock.js';
import { ALL_ROLES } from '../../core/kit.js';

// ---- kinds of task (configuration for the shared task object, core/tasks.js) ----
// Bed cleans are not here: a vacated bed is a clean task by itself (core). These are the jobs a
// ward asks for. Every detail is a pick list, so no personal or clinical detail can be typed. The
// ward decides what kind of clean it needs; Ospeli records the pick and decides nothing.
const ASK = ['ward-nurse', 'ae-nic', 'bed-manager', 'support-supervisor'];
const LEADS = ['support-supervisor', 'bed-manager']; // who may move a job to the front, as for a bed clean
// The first tap says "I am going" (it claims the job for the team, so nobody else goes too).
const MOVE = { team: 'transport', needsTo: true, placeTypes: ['ward', 'department', 'bed'], startLabel: 'On my way', startedName: 'On the way', doneLabel: 'Delivered',
  requestRoles: ASK, doRoles: ['porter', 'support-supervisor'], leadRoles: LEADS };
export const TEAMS = { transport: 'Transport' };
export const KINDS = [
  // Two patients on one ward are two moves, so a second identical ask for a ward is a new job; for
  // one bed it is still a double ask. Two specimen runs or equipment moves between the same places
  // are one run: those stay one open job at a time.
  { ...MOVE, id: 'patient-move', name: 'Patient move', repeatable: true, details: ['Wheelchair', 'Bed', 'Stretcher', 'Walking with help'] },
  { ...MOVE, id: 'item-run', name: 'Specimen or item run', details: ['Specimen', 'Medicines', 'Supplies', 'Other item'] },
  { ...MOVE, id: 'equipment-move', name: 'Equipment move', details: ['Empty bed', 'Wheelchair or stretcher', 'Other equipment'] },
  { id: 'room-clean', name: 'Room or area clean', team: 'cleaning', placeTypes: ['ward', 'department', 'bed'],
    details: ['Routine clean', 'Spill', 'After a patient leaves a room', 'Extra clean asked for by the ward'],
    startLabel: 'Start clean', startedName: 'Cleaning', doneLabel: 'Clean done',
    requestRoles: ASK, doRoles: ['cleaner', 'support-supervisor'], leadRoles: LEADS },
];
export const TEAM_OF = Object.fromEntries([BED_CLEAN, ...KINDS].map((k) => [k.id, k.team]));
export const KIND_NAME = Object.fromEntries([BED_CLEAN, ...KINDS].map((k) => [k.id, k.name]));
export const TEAM_NAMES = { cleaning: 'Cleaning', ...TEAMS };
export const PORTERING_KINDS = KINDS.filter((k) => k.team === 'transport').map((k) => k.id);

// ---- cleaning audits: an example set, set locally, not a standard ----
// A site replaces these with the elements and risk categories of its own cleanliness standard.
export const RISK_CATEGORIES = [
  { id: 'very-high', name: 'Very high risk', examples: 'for example operating rooms and critical care' },
  { id: 'high', name: 'High risk', examples: 'for example wards and the emergency department' },
  { id: 'moderate', name: 'Moderate risk', examples: 'for example outpatient and imaging areas' },
  { id: 'low', name: 'Low risk', examples: 'for example offices and stores' },
];
export const AUDIT_ELEMENTS = [
  { id: 'floor', name: 'Floor' },
  { id: 'bed-frame', name: 'Bed frame and mattress' },
  { id: 'bedside', name: 'Bedside table and chair' },
  { id: 'high-touch', name: 'Door handles, switches and rails' },
  { id: 'hand-wash', name: 'Hand-wash sink and taps' },
  { id: 'toilet', name: 'Toilet and shower' },
  { id: 'bins', name: 'Waste bins' },
  { id: 'curtains', name: 'Curtains and screens' },
  { id: 'high-surfaces', name: 'High surfaces and vents' },
  { id: 'dispensers', name: 'Soap and hand gel dispensers filled' },
];
export const AUDIT_PLACE_TYPES = ['ward', 'department'];
export const ELEMENT_NAME = Object.fromEntries(AUDIT_ELEMENTS.map((e) => [e.id, e.name]));
export const RISK_NAME = Object.fromEntries(RISK_CATEGORIES.map((c) => [c.id, c.name]));
export const AUDIT_SET_NOTE = 'The list of items and the types of area are an example set, set locally, not a standard. Your site uses its own cleanliness standard.';

// ---- example settings, not a standard (each site sets its own) ----
export const PASS_MARK = 85; // per cent, for the guide's "failed twice" rule and the audit tile
export const REAUDIT_DAYS = 7; // the guide's suggested re-audit date: this many days after the last audit
export const BED_TURNAROUND_TARGET = 60; // minutes, the same example target as the bed board
export const SEVERAL_CLEANS = 2; // "several beds wait for a clean"
export const TEAM_LEVELS = { transport: { waiting: 5, longestMinutes: 30 }, cleaning: { waiting: 6, longestMinutes: 60 } };

const inPeriod = (at, since, until) => at < until && (since == null || at >= since);

// ---- audits, derived from support.audit-recorded events ----
// An event is { type: 'support.audit-recorded', subject: <place id>, data: { auditId, riskCategory,
// passed: [element ids], failed: [element ids] } }. Anything that does not fit the fixed lists (an
// edited import) is read as not audited, so a score is always elements passed / elements audited.
const AUDIT_ID = /^aud-(\d{5,})$/;
export function deriveAudits(events) {
  const out = [];
  const seen = new Set();
  for (const e of events) {
    if (e.type !== 'support.audit-recorded') continue;
    const d = e.data || {};
    if (!AUDIT_ID.test(d.auditId) || seen.has(d.auditId) || !RISK_NAME[d.riskCategory]) continue;
    seen.add(d.auditId);
    const pick = (list) => [...new Set((Array.isArray(list) ? list : []).filter((x) => ELEMENT_NAME[x]))];
    const failed = pick(d.failed);
    const passed = pick(d.passed).filter((x) => !failed.includes(x));
    const audited = passed.length + failed.length;
    if (!audited) continue;
    out.push({ id: d.auditId, locationId: e.subject, riskCategory: d.riskCategory, at: e.at, byRole: e.actorRole, passed, failed, audited, score: (100 * passed.length) / audited });
  }
  return out;
}
export function nextAuditId(events) {
  let max = 0;
  for (const e of events) {
    const m = e.type === 'support.audit-recorded' ? AUDIT_ID.exec(e.data?.auditId) : null;
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `aud-${String(max + 1).padStart(5, '0')}`;
}

// Why an open job is first in its queue: the ward asked for it urgently ('asked-urgent'), or one of
// the people who balance the work moved it to the front ('do-next'). The task object keeps one
// priority for both; the event log says which. Returns Map(taskId -> mark) for marked jobs.
export function queueMarks(events) {
  const marks = new Map();
  for (const e of events) {
    if (e.type === 'task.requested' && e.data?.priority === 'urgent') marks.set(e.subject, 'asked-urgent');
    else if (e.type === 'task.prioritised') {
      if (e.data?.priority === 'urgent') marks.set(e.subject, 'do-next');
      else marks.delete(e.subject);
    }
    // A mark ends with its job (#129). A bed clean's id is reused for every clean of that bed, so
    // the mark must not pass to the next clean: any event that ends or begins a clean clears it.
    else if (e.type === 'task.completed' || e.type === 'task.cancelled') marks.delete(e.subject);
    else if (e.type === 'bed.vacated' || e.type === 'bed.cleaned' || e.type === 'bed.out-of-service') marks.delete(`clean-${e.subject}`);
    else if (e.type === 'patient.admitted' && e.data?.bedId) marks.delete(`clean-${e.data.bedId}`);
  }
  return marks;
}

// The guide is on until a person switches it off (support.guide-set, a people-only command).
export function guideOn(events) {
  let on = true;
  for (const e of events) if (e.type === 'support.guide-set' && typeof e.data?.on === 'boolean') on = e.data.on;
  return on;
}

// ---- KPIs: (events, { since, until, beds }) -> { value, numerator, denominator, n, breakdown } ----
// Bed turnaround: bed vacated -> clean done and bed ready, median minutes, cleans finished in the
// period. Read from the bed cleans of the task object, which are the bed board's own events, so it
// equals the bed board's KPI (tested).
// Beds used again or taken out of service before a clean was recorded are left out of the median
// and counted in `leftOut`, so a reader can see how many there were.
export function bedTurnaround(events, { since, until, beds }) {
  const { all } = deriveTasks(events, { beds });
  const s = completionStats(all, { since, until, pick: (t) => t.kind === BED_CLEAN.id });
  const gone = all.filter((t) => t.kind === BED_CLEAN.id && t.state === 'cancelled' && inPeriod(t.cancelledAt, since, until));
  const count = (reason) => gone.filter((t) => t.cancelReason === reason).length;
  return { value: s.medianMinutes, numerator: null, denominator: s.n, n: s.n, breakdown: [],
    leftOut: { total: gone.length, usedAgain: count('Bed in use again'), outOfService: count('Bed taken out of service') } };
}

// Transport request to completion: asked for -> delivered, median minutes, for each kind and for all
// transport jobs finished in the period. Cancelled and open jobs are left out.
export function porterRequestToDone(events, { since, until, tasks = null }) {
  const all = tasks ?? deriveTasks(events).all;
  const stat = (pick) => completionStats(all, { since, until, pick });
  const total = stat((t) => PORTERING_KINDS.includes(t.kind));
  return {
    value: total.medianMinutes, numerator: null, denominator: total.n, n: total.n,
    breakdown: PORTERING_KINDS.map((id) => { const s = stat((t) => t.kind === id); return { id, name: KIND_NAME[id], value: s.medianMinutes, n: s.n }; }),
    // Urgent and normal apart: a job moved to the front counts as urgent, as it was when done.
    byPriority: [['urgent', 'Urgent'], ['routine', 'Normal']].map(([id, name]) => {
      const s = stat((t) => PORTERING_KINDS.includes(t.kind) && t.priority === id);
      return { id, name, value: s.medianMinutes, n: s.n };
    }),
  };
}

// Cleanliness audit score: elements passed / elements audited, for each risk category and in all,
// over the audits recorded in the period. Elements not checked are left out.
export function auditScore(events, { since, until, audits = null }) {
  const list = (audits ?? deriveAudits(events)).filter((a) => inPeriod(a.at, since, until));
  const sum = (xs) => xs.reduce((s, a) => [s[0] + a.passed.length, s[1] + a.audited], [0, 0]);
  const pct = ([p, n]) => (n ? (100 * p) / n : null);
  const total = sum(list);
  return {
    value: pct(total), numerator: total[0], denominator: total[1], n: list.length,
    breakdown: RISK_CATEGORIES.map((c) => {
      const mine = list.filter((a) => a.riskCategory === c.id);
      const s = sum(mine);
      return { id: c.id, name: c.name, value: pct(s), numerator: s[0], denominator: s[1], n: mine.length };
    }),
  };
}

// ---- guide rules: fixed, checkable rules. A rule suggests; a person decides. ----
export const GUIDE_RULES = [
  { id: 'cleans-first', name: 'Which cleans first',
    basis: `Example setting, not a standard: a fixed rule. When ${SEVERAL_CLEANS} or more beds wait for a clean and the bed board shows patients waiting for a bed on a ward with no free bed, the cleans on that ward come first, the longest wait first, one for each patient who has no bed.` },
  { id: 'team-busy', name: 'A team is busier than usual',
    basis: `Example setting, not a standard: the usual level is set locally (here up to ${TEAM_LEVELS.transport.waiting} jobs waiting and ${TEAM_LEVELS.transport.longestMinutes} min for transport, ${TEAM_LEVELS.cleaning.waiting} and ${TEAM_LEVELS.cleaning.longestMinutes} min for cleaning). Advice only.` },
  { id: 'audit-failed-twice', name: 'An area failed its audit twice',
    basis: `Example setting, not a standard: the last two audits of an area both scored under the example pass mark of ${PASS_MARK}%, set locally. The suggested re-audit date is ${REAUDIT_DAYS} days after the last audit, also an example setting. Advice only.` },
];
const BASIS = Object.fromEntries(GUIDE_RULES.map((r) => [r.id, r.basis]));
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const andList = (xs) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);

// Rule 1. openCleans: open bed-clean tasks [{ id, wardId, state, priority, requestedAt, bedName }];
// patientsWaiting: Map(wardId -> patients waiting for a bed there with no bed held);
// freeBeds: Map(wardId -> beds available now); wardName: Map(wardId -> name).
export function ruleCleansFirst({ openCleans, patientsWaiting, freeBeds, wardName }) {
  const waiting = openCleans.filter((t) => t.state === 'requested');
  if (waiting.length < SEVERAL_CLEANS) return [];
  const out = [];
  for (const [wardId, patients] of patientsWaiting) {
    const short = patients - (freeBeds.get(wardId) || 0); // a free bed there already takes a patient
    const here = waiting.filter((t) => t.wardId === wardId).sort((a, b) => (a.requestedAt < b.requestedAt ? -1 : 1));
    if (short <= 0 || !here.length) continue;
    const first = here.slice(0, short);
    const todo = first.filter((t) => t.priority !== 'urgent');
    if (!todo.length) continue; // already at the front of the queue
    const ward = wardName.get(wardId) || wardId;
    out.push({
      rule: 'cleans-first', id: `cleans-first:${wardId}`, patients, ward: wardId,
      text: `Clean first on ${ward}: ${andList(todo.map((t) => t.bedName))}.`,
      why: `${plural(patients, 'patient is', 'patients are')} waiting for a bed on ${ward}, ${freeBeds.get(wardId) ? `${plural(freeBeds.get(wardId), 'bed is', 'beds are')} free there, ` : 'no bed there is free, '}and ${plural(here.length, 'bed waits', 'beds wait')} for a clean.`,
      basis: BASIS['cleans-first'],
      action: { label: todo.length === 1 ? 'Move this clean to the front' : `Move these ${todo.length} cleans to the front`, command: 'ospeli_tasks_set_priority', inputs: todo.map((t) => ({ taskId: t.id, priority: 'urgent' })) },
    });
  }
  return out.sort((a, b) => b.patients - a.patients || (a.ward < b.ward ? -1 : 1)).map(({ patients, ward, ...s }) => s);
}

// Rule 2. teams: [{ id, name, waiting, longestWaitMinutes }] for the open jobs of each team.
export function ruleTeamBusy(teams) {
  const level = (t) => TEAM_LEVELS[t.id];
  const busy = (t) => level(t) && (t.waiting > level(t).waiting || (t.longestWaitMinutes ?? 0) > level(t).longestMinutes);
  const quiet = (t) => level(t) && t.waiting <= Math.floor(level(t).waiting / 2) && (t.longestWaitMinutes ?? 0) <= level(t).longestMinutes / 2;
  return teams.filter(busy).map((t) => {
    const helper = teams.find((x) => x.id !== t.id && quiet(x));
    return {
      rule: 'team-busy', id: `team-busy:${t.id}`,
      text: `${t.name} is busier than usual: ${plural(t.waiting, 'job')} waiting, the longest for ${t.longestWaitMinutes ?? 0} min.`,
      why: `The usual level set here is up to ${level(t).waiting} waiting and ${level(t).longestMinutes} min (example setting, not a standard).${helper ? ` ${helper.name} has ${plural(helper.waiting, 'job')} waiting: look at whether someone there can help.` : ''}`,
      basis: BASIS['team-busy'], action: null,
    };
  });
}

// Rule 3. audits: from deriveAudits, oldest first; placeName(id) -> name.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dayText = (ms) => { const d = new Date(ms); return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`; };
export function ruleAuditFailedTwice(audits, placeName) {
  const byPlace = new Map();
  for (const a of audits) byPlace.set(a.locationId, [...(byPlace.get(a.locationId) || []), a]);
  const out = [];
  for (const [place, list] of byPlace) {
    const [a, b] = list.slice(-2);
    if (!b || a.score >= PASS_MARK || b.score >= PASS_MARK) continue;
    const both = b.failed.filter((x) => a.failed.includes(x)).map((x) => ELEMENT_NAME[x]);
    const by = Date.parse(b.at) + REAUDIT_DAYS * 864e5;
    out.push({
      rule: 'audit-failed-twice', id: `audit-failed-twice:${place}:${b.id}`, reauditBy: new Date(by).toISOString().slice(0, 10),
      text: `Re-audit ${placeName(place)} by ${dayText(by)}.`,
      why: `The last two audits scored ${Math.round(a.score)}% and ${Math.round(b.score)}%, under the example pass mark of ${PASS_MARK}%.${both.length ? ` Failed both times: ${both.join("; ")}.` : ''}`,
      basis: BASIS['audit-failed-twice'], action: null,
    });
  }
  return out;
}

// ================================================================ Linen and meals (slice 2)
// Linen is the shared stock item (core/stock.js): this module adds the category and a few example
// items, and every count, top-up level, request, issue and stock-out goes through the shared
// ospeli_stock_* commands. Nothing here moves stock; it only reads the log. Meals are counts for a
// ward, a date and a meal (ordered, delivered, returned uneaten), never a person, a diet or an
// allergy: those stay with the site's own catering and clinical process.

// Who may do what with linen. Every verb is listed; [] means nobody does it here. Clean linen is
// kept in the site's store (the example hospital has one store and no linen room), so the
// storekeeper receives it from the laundry and issues top-ups; the support services supervisor
// sets the top-up levels and looks after the rest.
const SUPERVISOR = ['support-supervisor'];
const STORE = ['storekeeper'];
const ON_THE_WARD = ['cleaner', 'ward-nurse', 'support-supervisor'];
export const STOCK_CATEGORIES = {
  linen: { name: 'Linen', roles: {
    count: ON_THE_WARD, request: ON_THE_WARD, issue: STORE, receive: STORE, transfer: SUPERVISOR, use: [],
    writeOff: SUPERVISOR, hold: SUPERVISOR, release: SUPERVISOR, levels: SUPERVISOR, itemAdd: SUPERVISOR,
  } },
};
// A few generic example items, counted one by one. No brand, supplier or price.
export const STOCK_ITEMS = [
  { id: 'bed-sheet', name: 'Bed sheet', unit: 'each', category: 'linen' },
  { id: 'pillowcase', name: 'Pillowcase', unit: 'each', category: 'linen' },
  { id: 'blanket', name: 'Blanket', unit: 'each', category: 'linen' },
  { id: 'towel', name: 'Towel', unit: 'each', category: 'linen' },
  { id: 'patient-gown', name: 'Patient gown', unit: 'each', category: 'linen' },
];
export const LINEN = 'linen';
export const LINEN_CATALOGUE = stockCatalogue([{ id: 'support', STOCK_CATEGORIES, STOCK_ITEMS }], ALL_ROLES);
// Linen only, from the shared stock item's own reading of the log: another module's stock is left out.
export const deriveLinen = (events, offsetMinutes = 0) => deriveStock(events.filter((e) => typeof e.type === 'string' && e.type.startsWith('stock.')),
  { items: LINEN_CATALOGUE.items, categories: LINEN_CATALOGUE.categories, offsetMinutes });

// The shift pattern behind "area-shifts": an example setting, set locally (the example hospital's
// own day and night shifts). Hours are the site's local time.
export const SHIFTS = [{ id: 'day', name: 'Day shift', start: 7, end: 19 }, { id: 'night', name: 'Night shift', start: 19, end: 31 }];
export const SHIFT_NOTE = 'Day shift 07:00 to 19:00 and night shift 19:00 to 07:00, local time (example setting, set locally).';
// Shifts that begin in [fromMs, toMs): [{ id, name, start, end }] in milliseconds.
export function shiftsBetween(fromMs, toMs, offsetMinutes = 0) {
  const off = offsetMinutes * MIN_MS;
  const out = [];
  const first = Math.floor((fromMs + off) / DAY_MS) * DAY_MS - DAY_MS - off; // local midnight, a day early
  for (let d = first; d < toMs; d += DAY_MS) {
    for (const s of SHIFTS) {
      const start = d + s.start * HOUR_MS;
      if (start >= fromMs && start < toMs) out.push({ id: s.id, name: s.name, start, end: d + s.end * HOUR_MS });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}
export const localDate = (ms, offsetMinutes = 0) => new Date(ms + offsetMinutes * MIN_MS).toISOString().slice(0, 10);
export const addDays = (date, n) => new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
const MIN_MS = 60e3; const HOUR_MS = 36e5; const DAY_MS = 864e5;
const overlaps = (list, a, b) => list.some(([x, y]) => Math.min(y, b) - Math.max(x, a) > 0);

// KPI linen stock-outs: area-shifts with a linen item at zero / area-shifts (spec; local definition).
// An area is a place `isArea` keeps (wards and departments, never the store that supplies them) that
// has a linen record. An area-shift counts from the area's first linen record; the shift going on
// now counts up to `until`. It is a stock-out when any linen item there had nothing usable at any
// moment of the shift (the balances: a count of zero until the next top-up is issued), or a person
// had declared a stock-out of it. A shift with no count is neither left out nor guessed: it keeps
// the balance of the last count and the top-ups issued since; how many had no count is `uncounted`.
export function linenStockOuts(events, { since, until, offsetMinutes = 0, stock = null, isArea = () => true }) {
  const s = stock ?? deriveLinen(events, offsetMinutes);
  const [from, to] = [Date.parse(since), Date.parse(until)];
  const areas = new Map(); // place -> { start, zero: [[a, b]], counts: [t] }
  for (const h of s.holdings.values()) {
    if (s.items.get(h.itemId)?.category !== LINEN || !isArea(h.placeId)) continue;
    const a = areas.get(h.placeId) || { start: Infinity, zero: [], counts: [] };
    a.start = Math.min(a.start, Date.parse(h.firstAt));
    a.zero.push(...zeroIntervals(h, to, s.offsetMinutes));
    areas.set(h.placeId, a);
  }
  for (const so of s.stockOuts.values()) {
    const a = areas.get(so.placeId);
    if (a && s.items.get(so.itemId)?.category === LINEN) a.zero.push([Date.parse(so.startedAt), so.endedAt ? Date.parse(so.endedAt) : to]);
  }
  const linenIds = new Set([...s.items.values()].filter((it) => it.category === LINEN).map((it) => it.id));
  for (const e of events) {
    if (e.type !== 'stock.counted' || !areas.has(e.subject)) continue;
    if ((e.data?.lines || []).some((l) => linenIds.has(l?.itemId))) areas.get(e.subject).counts.push(Date.parse(e.at));
  }
  const shifts = shiftsBetween(from, to, offsetMinutes);
  const tally = () => ({ numerator: 0, denominator: 0 });
  const total = tally(); const byShift = Object.fromEntries(SHIFTS.map((x) => [x.id, tally()])); const byArea = new Map();
  let uncounted = 0;
  for (const [placeId, a] of areas) {
    const mine = tally();
    for (const sh of shifts) {
      const end = Math.min(sh.end, to);
      if (end <= a.start) continue;
      const begin = Math.max(sh.start, a.start);
      const out = overlaps(a.zero, begin, end);
      for (const t of [total, byShift[sh.id], mine]) { t.denominator += 1; if (out) t.numerator += 1; }
      if (!a.counts.some((t) => t >= begin && t < end)) uncounted += 1;
    }
    byArea.set(placeId, mine);
  }
  const pct = (t) => (t.denominator ? (100 * t.numerator) / t.denominator : null);
  return { value: pct(total), numerator: total.numerator, denominator: total.denominator, n: total.denominator, uncounted,
    byShift: SHIFTS.map((x) => ({ id: x.id, name: x.name, ...byShift[x.id], value: pct(byShift[x.id]) })),
    breakdown: [...byArea].map(([id, t]) => ({ id, ...t, value: pct(t), n: t.denominator })) };
}

// ---- meals: counts per ward, date and meal; never a person, a diet or an allergy ----
export const MEALS = [{ id: 'breakfast', name: 'Breakfast' }, { id: 'midday', name: 'Midday meal' }, { id: 'evening', name: 'Evening meal' }];
export const MEAL_NAME = Object.fromEntries(MEALS.map((m) => [m.id, m.name]));
export const MEAL_MAX = 500; // more than any ward serves at one meal: a bound on the numbers, not a setting
export const MEAL_BACK_DAYS = 7; // a meal can be recorded or corrected for today and the 6 days before (example setting, not a standard)
export const MEALS_NOTE = 'Counts only. Diets and allergies are not handled here: they stay with your site\'s own catering and clinical process.';
const okCount = (n) => Number.isInteger(n) && n >= 0 && n <= MEAL_MAX;
// What is wrong with a meal record's numbers, or null.
export function mealProblem({ ordered, delivered, returned }) {
  if (![ordered, delivered, returned].every(okCount)) return `Each number is a whole number from 0 to ${MEAL_MAX}.`;
  if (returned > delivered) return `Returned uneaten (${returned}) cannot be more than delivered (${delivered}).`;
  return null;
}
// The latest record for each ward, date and meal (recording again corrects it; both stay in the log).
// A record that does not fit (an edited import) is left out.
export function deriveMeals(events) {
  const m = new Map();
  for (const e of events) {
    if (e.type !== 'support.meals-recorded') continue;
    const d = e.data || {};
    if (typeof e.subject !== 'string' || !validDate(d.date) || !MEAL_NAME[d.meal] || mealProblem(d)) continue;
    const k = `${e.subject}|${d.date}|${d.meal}`;
    const prev = m.get(k);
    m.set(k, { wardId: e.subject, date: d.date, meal: d.meal, ordered: d.ordered, delivered: d.delivered, returned: d.returned, at: e.at, byRole: e.actorRole, versions: (prev?.versions || 0) + 1 });
  }
  return [...m.values()];
}
// KPI meal waste: meals returned uneaten / meals delivered (spec; local definition), over the meal
// records dated fromDate to toDate (YYYY-MM-DD, both included). A meal with no record is left out,
// never counted as zero.
export function mealWaste(events, { fromDate, toDate, see = () => true, records = null }) {
  const list = (records ?? deriveMeals(events)).filter((x) => x.date >= fromDate && x.date <= toDate && see(x.wardId));
  const sum = (xs) => xs.reduce((t, x) => ({ numerator: t.numerator + x.returned, denominator: t.denominator + x.delivered, n: t.n + 1 }), { numerator: 0, denominator: 0, n: 0 });
  const pct = (t) => (t.denominator ? (100 * t.numerator) / t.denominator : null);
  const total = sum(list);
  const wards = [...new Set(list.map((x) => x.wardId))].sort();
  return { value: pct(total), ...total,
    breakdown: MEALS.map((m) => { const t = sum(list.filter((x) => x.meal === m.id)); return { id: m.id, name: m.name, ...t, value: pct(t) }; }),
    byWard: wards.map((w) => { const mine = list.filter((x) => x.wardId === w); const t = sum(mine);
      return { id: w, ...t, value: pct(t), byMeal: MEALS.map((m) => { const u = sum(mine.filter((x) => x.meal === m.id)); return { id: m.id, ...u, value: pct(u) }; }) }; }) };
}

// ---- guide rules for linen and meals: fixed rules, example settings, a person acts ----
export const MEAL_DAYS = 7; // "recent days" for the meals rule
export const MEAL_USUAL_PCT = 15; // usual share returned uneaten, per ward and meal
export const MEAL_MIN_RECORDS = 3; // at least this many days recorded before the rule says anything
export const MEAL_MIN_DELIVERED = 30; // and at least this many meals delivered
GUIDE_RULES.push(
  { id: 'linen-two-counts', name: 'Linen under its top-up level twice',
    basis: 'Example setting, not a standard: a fixed rule. An item\'s last two counts in an area were both under its top-up level and it is still under. With no top-up waiting, the guide offers one for exactly what is short; with one waiting, it says so. A person decides.' },
  { id: 'meals-returned', name: 'Many meals returned uneaten',
    basis: `Example setting, not a standard: over the last ${MEAL_DAYS} days, with at least ${MEAL_MIN_RECORDS} days recorded and ${MEAL_MIN_DELIVERED} meals delivered, more than ${MEAL_USUAL_PCT}% of one ward's meal came back uneaten (the usual level, set locally). Advice only.` },
);
BASIS['linen-two-counts'] = GUIDE_RULES.find((r) => r.id === 'linen-two-counts').basis;
BASIS['meals-returned'] = GUIDE_RULES.find((r) => r.id === 'meals-returned').basis;
export const TASK_RULES = ['cleans-first', 'team-busy', 'audit-failed-twice'];

// Rule 4. stock: deriveLinen(...); now: ISO time; isArea(placeId) and see(placeId) keep the areas
// to look at; placeName(id), itemName(id) give the words.
export function ruleLinenTwoCounts(events, { stock, now, isArea = () => true, see = () => true, placeName = (x) => x, itemName = (x) => x }) {
  const linen = new Set([...stock.items.values()].filter((it) => it.category === LINEN).map((it) => it.id));
  const level = new Map(); const counts = new Map(); // item|place -> level; -> [{ qty, level }]
  for (const e of events) {
    if (e.type === 'stock.level-set' && linen.has(e.data?.itemId)) level.set(`${e.data.itemId}|${e.subject}`, e.data.level || null);
    else if (e.type === 'stock.counted' && isArea(e.subject)) {
      for (const l of e.data?.lines || []) {
        if (!linen.has(l?.itemId) || !Number.isInteger(l.qty)) continue;
        const k = `${l.itemId}|${e.subject}`;
        counts.set(k, [...(counts.get(k) || []).slice(-1), { qty: l.qty, level: level.get(k) ?? null }]);
      }
    }
  }
  const byPlace = new Map();
  for (const [k, list] of counts) {
    const [itemId, placeId] = k.split('|');
    if (list.length < 2 || !see(placeId) || !list.every((c) => c.level && c.qty < c.level)) continue;
    const h = holdingOf(stock, itemId, placeId);
    const usable = usableOf(stock, itemId, placeId, now);
    if (!h?.level || usable >= h.level) continue; // topped up since
    const p = byPlace.get(placeId) || { ask: [], waiting: [] };
    const open = openRequestFor(stock, itemId, placeId);
    if (open) p.waiting.push({ itemId, usable, level: h.level, request: open }); else p.ask.push({ itemId, usable, level: h.level });
    byPlace.set(placeId, p);
  }
  const out = [];
  const words = (xs) => andList(xs.map((x) => `${itemName(x.itemId).toLowerCase()} (${x.usable} of ${x.level})`));
  for (const [placeId, p] of [...byPlace].sort((a, b) => (placeName(a[0]) < placeName(b[0]) ? -1 : 1))) {
    const place = placeName(placeId);
    if (p.ask.length) {
      const lines = p.ask.sort((a, b) => (a.itemId < b.itemId ? -1 : 1)).map((x) => ({ itemId: x.itemId, qty: x.level - x.usable }));
      out.push({ rule: 'linen-two-counts', id: `linen-two-counts:${placeId}`,
        text: `Ask for a linen top-up for ${place}: ${andList(lines.map((l) => `${itemName(l.itemId).toLowerCase()} ${l.qty}`))}.`,
        why: `Under the top-up level on the last two counts, and no top-up is waiting: ${words(p.ask)}.`,
        basis: BASIS['linen-two-counts'],
        action: { label: 'Ask for this top-up', command: 'ospeli_stock_request', inputs: [{ placeId, lines }] } });
    }
    if (p.waiting.length) {
      const ids = [...new Set(p.waiting.map((x) => x.request.id))];
      const hrs = Math.max(...p.waiting.map((x) => (Date.parse(now) - Date.parse(x.request.at)) / HOUR_MS));
      out.push({ rule: 'linen-two-counts', id: `linen-two-counts:${placeId}:waiting`,
        text: `Check the linen top-up for ${place}: ${andList(ids)} ${ids.length === 1 ? 'is' : 'are'} still waiting.`,
        why: `Under the top-up level on the last two counts: ${words(p.waiting)}. The top-up was asked for ${Math.round(hrs)} h ago and is not issued in full yet.`,
        basis: BASIS['linen-two-counts'], action: null });
    }
  }
  return out;
}

// Rule 5. records: deriveMeals(...); toDate: today's local date; placeName(id) gives the words.
export function ruleMealsReturned(records, { toDate, see = () => true, placeName = (x) => x }) {
  const fromDate = addDays(toDate, -(MEAL_DAYS - 1));
  const groups = new Map();
  for (const x of records) {
    if (x.date < fromDate || x.date > toDate || !see(x.wardId)) continue;
    const k = `${x.wardId}|${x.meal}`;
    groups.set(k, [...(groups.get(k) || []), x]);
  }
  const out = [];
  for (const [k, list] of [...groups].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const [wardId, meal] = k.split('|');
    const t = list.reduce((s, x) => ({ o: s.o + x.ordered, d: s.d + x.delivered, r: s.r + x.returned }), { o: 0, d: 0, r: 0 });
    if (list.length < MEAL_MIN_RECORDS || t.d < MEAL_MIN_DELIVERED || (100 * t.r) / t.d <= MEAL_USUAL_PCT) continue;
    const name = MEAL_NAME[meal].toLowerCase();
    out.push({ rule: 'meals-returned', id: `meals-returned:${wardId}:${meal}`,
      text: `Check the ${name} numbers ordered for ${placeName(wardId)} with the ward.`,
      why: `${Math.round((100 * t.r) / t.d)}% came back uneaten over the last ${MEAL_DAYS} days (${t.r} of ${t.d} delivered, ${plural(list.length, 'day')} recorded), above the usual level of ${MEAL_USUAL_PCT}% set here (example setting, not a standard). On average ${Math.round(t.o / list.length)} ordered and ${Math.round(t.d / list.length)} delivered a day.`,
      basis: BASIS['meals-returned'], action: null });
  }
  return out;
}
