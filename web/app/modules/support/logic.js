// Cleaning and portering: the module's fixed lists and its pure functions. Everything here reads
// the event log and nothing else: no screen, no storage, no clock (the caller passes `now`), so
// the queue, the KPIs, the audits and the guide give the same answer in the browser, in a test
// and on a site's own server.
//
// Measure flows, never people: every number is about jobs and waits. A task records the role
// that did it, never a person, and nothing here counts or ranks a member of staff.

import { deriveTasks, completionStats, BED_CLEAN } from '../../core/tasks.js';

// ---- kinds of task (configuration for the shared task object, core/tasks.js) ----
// Bed cleans are not here: a vacated bed is a clean task by itself (core). These are the jobs a
// ward asks for. Every detail is a pick list, so no personal or clinical detail can be typed. The
// ward decides what kind of clean it needs; Ospeli records the pick and decides nothing.
const ASK = ['ward-nurse', 'ae-nic', 'bed-manager', 'support-supervisor'];
const LEADS = ['support-supervisor', 'bed-manager']; // who may move a job to the front, as for a bed clean
// The first tap says "I am going" (it claims the job for the team, so nobody else goes too).
const MOVE = { team: 'portering', needsTo: true, placeTypes: ['ward', 'department', 'bed'], startLabel: 'On my way', startedName: 'On the way', doneLabel: 'Delivered',
  requestRoles: ASK, doRoles: ['porter', 'support-supervisor'], leadRoles: LEADS };
export const TEAMS = { portering: 'Portering' };
export const KINDS = [
  // Two patients on one ward are two moves, so a second identical ask for a ward is a new job; for
  // one bed it is still a double ask. Two specimen runs or equipment moves between the same places
  // are one run: those stay one open job at a time.
  { ...MOVE, id: 'patient-move', name: 'Patient move', repeatable: true, details: ['Wheelchair', 'Bed', 'Trolley', 'Walking with help'] },
  { ...MOVE, id: 'item-run', name: 'Specimen or item run', details: ['Specimen', 'Medicines', 'Supplies', 'Other item'] },
  { ...MOVE, id: 'equipment-move', name: 'Equipment move', details: ['Empty bed', 'Wheelchair or trolley', 'Other equipment'] },
  { id: 'room-clean', name: 'Room or area clean', team: 'cleaning', placeTypes: ['ward', 'department', 'bed'],
    details: ['Routine clean', 'Spill', 'After a patient leaves a room', 'Extra clean asked for by the ward'],
    startLabel: 'Start clean', startedName: 'Cleaning', doneLabel: 'Clean done',
    requestRoles: ASK, doRoles: ['cleaner', 'support-supervisor'], leadRoles: LEADS },
];
export const TEAM_OF = Object.fromEntries([BED_CLEAN, ...KINDS].map((k) => [k.id, k.team]));
export const KIND_NAME = Object.fromEntries([BED_CLEAN, ...KINDS].map((k) => [k.id, k.name]));
export const TEAM_NAMES = { cleaning: 'Cleaning', ...TEAMS };
export const PORTERING_KINDS = KINDS.filter((k) => k.team === 'portering').map((k) => k.id);

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
export const TEAM_LEVELS = { portering: { waiting: 5, longestMinutes: 30 }, cleaning: { waiting: 6, longestMinutes: 60 } };

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

// Porter request to completion: asked for -> delivered, median minutes, for each kind and for all
// portering jobs finished in the period. Cancelled and open jobs are left out.
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
    basis: `Example setting, not a standard: the usual level is set locally (here up to ${TEAM_LEVELS.portering.waiting} jobs waiting and ${TEAM_LEVELS.portering.longestMinutes} min for portering, ${TEAM_LEVELS.cleaning.waiting} and ${TEAM_LEVELS.cleaning.longestMinutes} min for cleaning). Advice only.` },
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
