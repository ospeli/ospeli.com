// The shared patient code with a stage timeline: one reference code for one episode (a referral,
// a programme, a stay), and the timed stages it passes through. Outpatients, community care,
// the emergency department, theatres, maternity and critical care each add their kinds of
// episode as configuration (CODE_KINDS in a module's commands.js) and write no code of their own.
//
// Derived only from the event log, like the bed board, tasks, stock and slots: nothing about a
// code is stored except events, so a list, a measure and an auditor read one record.
//
// Operations only. A code is a number Ospeli makes, a service picked from a list, a place and
// a few picks: no name, no date of birth, no contact, no address, no record number, no reason
// for the visit, no urgency and no free text anywhere. A code is never typed in from another
// system. Two codes are never matched as one person: a new referral is a new code, and Ospeli
// cannot and must not know that two codes are the same person.
// Measure flows, never people: every event records the role that acted, never a named person.
//
// What is written where. Arrived, called and finished belong to the appointment (core/slots.js)
// and are written once, there; a code's timeline reads them by code. A stay in a bed keeps its
// bed board id (enc-…): its timeline is read from the bed board's own events and nothing is
// written twice. Episodes outside a bed get pc-00001 and write their stages here.
//
// This file has no clock and reads no other core file: the appointments of a code are passed in
// (the result of deriveSlots), so the two shared objects stay separate.

const MIN = 60e3;
const DAY = 864e5;

// A code Ospeli opens here, and the bed board's own id for a stay (read only).
export const CODE_ID_PATTERN = '^pc-[0-9]{5,}$';
export const ENCOUNTER_ID_PATTERN = '^enc-[0-9]{6,}$';
export const ANY_CODE_PATTERN = '^(pc-[0-9]{5,}|enc-[0-9]{6,})$';
export const DATE_PATTERN = '^[0-9]{4}-[0-9]{2}-[0-9]{2}$';
export const STAGE_ID_PATTERN = '^[a-z][a-z0-9.-]{1,40}$';

export const CODE_STATES = { open: { name: 'Open' }, closed: { name: 'Closed' } };
// How the episode began. A pick, never text.
export const CODE_SOURCES = { referral: 'Referral', 'walk-in': 'Walk-in', 'transfer-in': 'Transfer in' };
// Why an episode was closed. A module may add reasons of its own (CODE_CLOSE_REASONS in its
// pack, added before "Other"); it can never take one away.
export const CLOSE_REASONS = ['Episode finished', 'Moved to other care', 'Left the area', 'Opened in error', 'Other'];
export const ERROR_REASON = 'Opened in error';
// Two codes that move together (a mother and a baby). Ospeli offers the same move for the
// other; it never makes it.
export const LINK_RELATIONS = { 'moves-with': 'Moves with' };
export const MAX_LINKS = 8;
export const CODE_PLACE_TYPES = ['site', 'building', 'department', 'ward', 'bed'];
export const CODE_EVENT_TYPES = ['code.opened', 'code.stage', 'code.due-set', 'code.linked', 'code.closed'];
// The bed board's events that are stages of a stay, read for an enc-… code and never written here.
export const BED_STAGES = {
  'ae.decision-to-admit': 'Decision to admit',
  'bed.requested': 'Bed requested',
  'patient.admitted': 'Admitted',
  'patient.expected-discharge': 'Going home planned',
  'patient.discharged': 'Discharged',
};
export const BED_STAGE_EVENT_TYPES = Object.keys(BED_STAGES);

const KIND_ID = /^[a-z][a-z0-9-]{1,30}$/;
const STAGE_ID = new RegExp(STAGE_ID_PATTERN);
const DATE = new RegExp(DATE_PATTERN);
const ROLE_LISTS = ['openRoles', 'stageRoles', 'closeRoles'];
const shortWord = (w) => typeof w === 'string' && w.trim() && w.length <= 40;

// Put the modules' kinds of episode together. A kind is refused (throws at load, so a test
// catches it) when it is malformed, reuses an id, or names a role or a kind of place that does
// not exist (roleIds null: the roles are not checked, for a caller that only replays the log).
// packs: [{ id, CODE_KINDS?, CODE_CLOSE_REASONS? }]. A kind:
//   { id, word,                       'outpatient-referral', 'Outpatient referral'
//     services: { id: word },         the site's pick list (an example set), at least one
//     sources: ['referral', …],       which of CODE_SOURCES this kind may begin from
//     placeTypes: ['department'],     where an episode of this kind may sit (optional place)
//     openRoles, stageRoles, closeRoles,   the roles for each verb
//     stages: [{ id, word, after: [stage ids], roles? }],
//                                     after: the stages this one may follow; [] = only first.
//                                     roles: only these may mark it (default: stageRoles)
//     openStage: 'referral.accepted', optional: the stage written with the opening
//     dueBy: true, dueRoles: [...],   optional: a person may set a due-by date (never a rule)
//     links: true }                   optional: codes of this kind may be linked
export function codeCatalogue(packs = [], roleIds = []) {
  const kinds = new Map();
  const closeReasons = [...CLOSE_REASONS];
  for (const p of packs) {
    const more = p.CODE_CLOSE_REASONS;
    if (more != null) {
      if (!Array.isArray(more) || !more.every(shortWord)) throw new Error(`module ${p.id}: CODE_CLOSE_REASONS must be a list of short reasons`);
      for (const r of more) if (!closeReasons.includes(r)) closeReasons.splice(closeReasons.length - 1, 0, r);
    }
    for (const k of p.CODE_KINDS || []) {
      const bad = (why) => { throw new Error(`module ${p.id}: code kind ${k?.id}: ${why}`); };
      if (!k || typeof k.id !== 'string' || !KIND_ID.test(k.id)) bad('id must be lower-case letters, digits and hyphens');
      if (kinds.has(k.id)) bad('this id is already used');
      if (!shortWord(k.word)) bad('word is required (what people call it, for example "Outpatient referral")');
      const services = Object.entries(k.services || {});
      if (!services.length || !services.every(([id, w]) => KIND_ID.test(id) && shortWord(w))) bad('services is a pick list { id: word } with at least one service');
      if (!Array.isArray(k.sources) || !k.sources.length || !k.sources.every((s) => CODE_SOURCES[s])) bad(`sources must be picked from ${Object.keys(CODE_SOURCES).join(', ')}`);
      if (!Array.isArray(k.placeTypes) || !k.placeTypes.length) bad('placeTypes is required');
      for (const t of k.placeTypes) if (!CODE_PLACE_TYPES.includes(t)) bad(`unknown place type ${t}`);
      const lists = [...ROLE_LISTS, ...(k.dueBy ? ['dueRoles'] : [])];
      for (const list of lists) {
        if (!Array.isArray(k[list]) || !k[list].length) bad(`${list} is required`);
        for (const r of k[list]) if (roleIds && !roleIds.includes(r)) bad(`unknown role ${r} in ${list}`);
      }
      if (!k.dueBy && k.dueRoles != null) bad('dueRoles is only for a kind with dueBy: true');
      const stages = new Map();
      for (const s of k.stages || []) {
        if (!s || typeof s.id !== 'string' || !STAGE_ID.test(s.id)) bad(`stage id ${s?.id} must be lower-case letters, digits, dots and hyphens`);
        if (stages.has(s.id)) bad(`stage ${s.id} is listed twice`);
        if (!shortWord(s.word)) bad(`stage ${s.id}: word is required`);
        if (!Array.isArray(s.after)) bad(`stage ${s.id}: after is the list of stages it may follow ([] for a first stage)`);
        if (s.roles != null) {
          if (!Array.isArray(s.roles) || !s.roles.length) bad(`stage ${s.id}: roles, when given, lists at least one role`);
          for (const r of s.roles) if (roleIds && !roleIds.includes(r)) bad(`unknown role ${r} in stage ${s.id}`);
        }
        stages.set(s.id, { id: s.id, word: s.word, after: [...s.after], roles: s.roles ? [...s.roles] : null });
      }
      for (const s of stages.values()) for (const a of s.after) if (!stages.has(a)) bad(`stage ${s.id}: after names ${a}, which is not a stage of this kind`);
      if (k.openStage != null) {
        const first = stages.get(k.openStage);
        if (!first) bad(`openStage ${k.openStage} is not a stage of this kind`);
        if (first.after.length) bad(`openStage ${k.openStage} must be a first stage (after: [])`);
      }
      kinds.set(k.id, {
        id: k.id, word: k.word, module: p.id, services: Object.fromEntries(services), sources: [...k.sources], placeTypes: [...k.placeTypes],
        openRoles: [...k.openRoles], stageRoles: [...k.stageRoles], closeRoles: [...k.closeRoles], dueBy: k.dueBy === true, dueRoles: k.dueBy ? [...k.dueRoles] : [],
        stages, openStage: k.openStage ?? null, links: k.links === true,
      });
    }
  }
  return { kinds, closeReasons };
}

export function validDate(date) {
  if (typeof date !== 'string' || !DATE.test(date)) return false;
  const t = Date.parse(`${date}T00:00:00.000Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === date;
}
// The site's own date at a moment.
export const localDate = (iso, offsetMinutes = 0) => new Date(Date.parse(iso) + offsetMinutes * MIN).toISOString().slice(0, 10);

// A short, non-identifying label: "pc-00012" -> "Patient P12". The P keeps it apart from a stay
// on the bed board ("Patient 4512"), so a clinic and a ward never seem to mean the same person.
export const codeLabel = (code) => {
  const m = /^pc-0*(\d+)$/.exec(String(code || ''));
  if (m) return `Patient P${m[1]}`;
  const e = /^enc-0*(\d+)$/.exec(String(code || ''));
  return e ? `Patient ${e[1]}` : '';
};

// May `stageId` be marked on this code now? { ok: true } or { ok: false, why }.
// The stage the code is at already is not asked here: the command answers that as done.
export function stageAllowed(kind, code, stageId) {
  const s = kind?.stages.get(stageId);
  if (!s) return { ok: false, why: 'not-a-stage' };
  if (code.stage == null) return s.after.length ? { ok: false, why: 'not-first' } : { ok: true };
  return s.after.includes(code.stage) ? { ok: true } : { ok: false, why: 'not-after' };
}
// The stages that may be marked next on this code, in the kind's own order.
export const nextStages = (kind, code) => (kind ? [...kind.stages.values()].filter((s) => s.id !== code.stage && stageAllowed(kind, code, s.id).ok) : []);

// Replay the event log. Returns { codes, kinds }: codes is a Map by code in the order first seen.
// An event that does not fit the record it names (a stage out of order, a second opening, any
// change to a closed code) is ignored, so a bad import cannot bend a list.
//   code { code, kind, service, placeId, source, state, openedAt, openedByRole, stage, stageAt,
//          stages: [{ stage, at, placeId, appointmentId, byRole }], dueBy, dueSetAt,
//          links: [{ otherCode, relation, at }], closedAt, closeReason }
export function deriveCodes(events, { packs = [], catalogue = null } = {}) {
  const { kinds } = catalogue || codeCatalogue(packs, null);
  const codes = new Map();
  const open = (id) => { const c = codes.get(id); return c && c.state === 'open' ? c : null; };
  for (const e of events) {
    const d = e.data || {};
    switch (e.type) {
      case 'code.opened': {
        if (codes.has(e.subject) || !new RegExp(CODE_ID_PATTERN).test(e.subject || '')) break;
        codes.set(e.subject, {
          code: e.subject, kind: d.kind ?? null, service: d.service ?? null, placeId: d.placeId ?? null, source: d.source ?? null, state: 'open',
          openedAt: e.at, openedByRole: e.actorRole, stage: null, stageAt: null, stages: [], dueBy: null, dueSetAt: null, links: [], closedAt: null, closeReason: null,
        });
        break;
      }
      case 'code.stage': {
        const c = open(e.subject);
        if (!c || typeof d.stage !== 'string') break;
        const kind = kinds.get(c.kind);
        // A kind this build does not know (its module is not loaded) is replayed as written.
        if (kind && !stageAllowed(kind, c, d.stage).ok) break;
        c.stages.push({ stage: d.stage, at: e.at, placeId: d.placeId ?? null, appointmentId: d.appointmentId ?? null, byRole: e.actorRole });
        Object.assign(c, { stage: d.stage, stageAt: e.at });
        if (d.placeId) c.placeId = d.placeId;
        break;
      }
      case 'code.due-set': { const c = open(e.subject); if (c && (d.dueBy === null || validDate(d.dueBy))) Object.assign(c, { dueBy: d.dueBy, dueSetAt: e.at }); break; }
      case 'code.linked': {
        const a = open(e.subject); const b = open(d.otherCode);
        if (!a || !b || a === b || !LINK_RELATIONS[d.relation] || a.links.some((l) => l.otherCode === b.code)) break;
        a.links.push({ otherCode: b.code, relation: d.relation, at: e.at });
        b.links.push({ otherCode: a.code, relation: d.relation, at: e.at });
        break;
      }
      case 'code.closed': { const c = open(e.subject); if (c) Object.assign(c, { state: 'closed', closedAt: e.at, closeReason: d.reason ?? null }); break; }
      default: break;
    }
  }
  return { codes, kinds };
}

export function nextCodeId(events) {
  let max = 0;
  for (const e of events) { const m = e.type === 'code.opened' ? /^pc-(\d{5,})$/.exec(e.subject) : null; if (m) max = Math.max(max, Number(m[1])); }
  return `pc-${String(max + 1).padStart(5, '0')}`;
}

// ---- a code's appointments (from deriveSlots, passed in) ----
// One pass over the appointments: Map code -> [appointment] in booking order. Lists and measures
// use this index instead of scanning every appointment for every code.
export function appointmentsByCode(slots) {
  const by = new Map();
  for (const a of slots?.appointments?.values() || []) {
    if (!by.has(a.code)) by.set(a.code, []);
    by.get(a.code).push(a);
  }
  return by;
}
const OPEN_APPOINTMENT = ['booked', 'arrived', 'called'];
// What a list needs to know about a code's appointments.
//   { count, open: [appointment], lastAttendedAt, everAttended }
// "Attended" means the patient arrived: a visit that was called or finished, or one where the
// patient arrived and then left, still shows they came.
export function attendanceOf(index, code) {
  const mine = index?.get(code) || [];
  let last = null;
  for (const a of mine) if (a.arrivedAt && (!last || a.arrivedAt > last)) last = a.arrivedAt;
  return { count: mine.length, open: mine.filter((a) => OPEN_APPOINTMENT.includes(a.state)), lastAttendedAt: last, everAttended: last != null };
}

// The first visit of this code that finished at or after the code reached `stage`:
//   { fromAt, attendedAt, appointmentId, days } or null when the stage was never reached.
// attendedAt, appointmentId and days are null while no visit has finished yet.
// (Outpatients: referral accepted to first appointment.)
export function firstAttendedAfter(d, index, code, stage) {
  const c = d.codes.get(code);
  const reached = c?.stages.find((s) => s.stage === stage);
  if (!reached) return null;
  let first = null;
  // A visit closed as "seen, no times" was attended: it counts from the patient's arrival, the one true time it has.
  const when = (a) => a.finishedAt ?? (a.noTimes ? a.arrivedAt : null);
  for (const a of index?.get(code) || []) if (when(a) && when(a) >= reached.at && (!first || when(a) < when(first))) first = a;
  return { fromAt: reached.at, attendedAt: first ? when(first) : null, appointmentId: first?.id ?? null, days: first ? (Date.parse(when(first)) - Date.parse(reached.at)) / DAY : null };
}

// How long the code spent in each stage, in order: [{ stage, from, to, minutes }]. The last
// stage runs to the closing, or to `now` while the code is open.
export function stageDurations(code, now) {
  return code.stages.map((s, i) => {
    const to = code.stages[i + 1]?.at ?? code.closedAt ?? now ?? null;
    return { stage: s.stage, from: s.at, to, minutes: to ? Math.max(0, (Date.parse(to) - Date.parse(s.at)) / MIN) : null };
  });
}

// Whole days an open code has waited since it was opened (a closed code: opened to closed).
export const waitingDays = (code, now) => Math.max(0, Math.floor((Date.parse(code.closedAt ?? now) - Date.parse(code.openedAt)) / DAY));

// Open codes whose due-by date (set by a person) has passed on the site's own calendar, oldest
// due first. `today` is the site's date, YYYY-MM-DD. Due today is not overdue.
export const isOverdue = (code, today) => code.state === 'open' && code.dueBy != null && code.dueBy < today;
export const overdueFollowUps = (d, today) => [...d.codes.values()].filter((c) => isOverdue(c, today)).sort((a, b) => (a.dueBy < b.dueBy ? -1 : a.dueBy > b.dueBy ? 1 : 0) || (a.code < b.code ? -1 : 1));

// The timeline of one code, oldest first, from three records read together and written once each:
// the code's own events, its appointments' steps, and, for a stay (enc-…), the bed board's events.
//   [{ at, source: 'code' | 'appointment' | 'bed', what, word, … }]
export function timelineOf(d, code, { index = null, events = [] } = {}) {
  const out = [];
  const c = d.codes.get(code);
  if (c) {
    const kind = d.kinds.get(c.kind);
    out.push({ at: c.openedAt, source: 'code', what: 'opened', word: 'Opened', byRole: c.openedByRole });
    for (const s of c.stages) out.push({ at: s.at, source: 'code', what: 'stage', stage: s.stage, word: kind?.stages.get(s.stage)?.word || s.stage, placeId: s.placeId, appointmentId: s.appointmentId, byRole: s.byRole });
    if (c.dueSetAt) out.push({ at: c.dueSetAt, source: 'code', what: 'due-set', word: c.dueBy ? 'Due-by date set' : 'Due-by date cleared', dueBy: c.dueBy });
    for (const l of c.links) out.push({ at: l.at, source: 'code', what: 'linked', word: LINK_RELATIONS[l.relation] || l.relation, otherCode: l.otherCode });
    if (c.closedAt) out.push({ at: c.closedAt, source: 'code', what: 'closed', word: 'Closed', reason: c.closeReason });
  }
  for (const a of index?.get(code) || []) {
    const step = (at, what, word, more = {}) => { if (at) out.push({ at, source: 'appointment', what, word, appointmentId: a.id, ...more }); };
    step(a.bookedAt, 'booked', 'Booked');
    step(a.arrivedAt, 'arrived', 'Arrived');
    step(a.calledAt, 'called', 'Called');
    step(a.finishedAt, 'finished', 'Finished');
    if (a.noTimes) step(a.closedAt, 'seen-no-times', 'Seen, no times');
    if (a.state === 'no-show') step(a.closedAt, 'no-show', 'Missed appointment', { reason: a.noShowReason ?? null });
    if (a.state === 'cancelled') step(a.closedAt, 'cancelled', 'Cancelled', { reason: a.cancelReason ?? null });
  }
  if (new RegExp(ENCOUNTER_ID_PATTERN).test(code)) {
    for (const e of events) if (e.subject === code && BED_STAGES[e.type]) out.push({ at: e.at, source: 'bed', what: e.type, word: BED_STAGES[e.type], placeId: e.data?.wardId ?? null });
  }
  // Same moment: the order they were added in (code, then appointment, then bed) is kept.
  return out.map((x, i) => [x, i]).sort((a, b) => Date.parse(a[0].at) - Date.parse(b[0].at) || a[1] - b[1]).map((x) => x[0]);
}

// ---- measures (pure; services and places, never a person) ----
const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const period = ({ since = null, until } = {}) => {
  if (!until) throw new Error('until is required');
  const lo = since == null ? -Infinity : Date.parse(since); const hi = Date.parse(until);
  return (ms) => ms != null && ms >= lo && ms < hi;
};

// Days from a stage to the first finished visit after it, for codes whose first visit finished
// in the period: { n, medianDays, byService: { service: { n, medianDays } }, waiting }.
// `waiting` counts open codes that reached the stage and have no finished visit yet (they are
// not in the median, so a long queue cannot hide behind a good figure: show both).
// A group of fewer than `minGroup` codes gives no median (a small group can point at a person).
// Local definition.
export function stageToFirstAttended(d, index, { stage, since, until, kind = null, minGroup = 1 } = {}) {
  const inPeriod = period({ since, until });
  const all = []; const by = {}; let waiting = 0;
  for (const c of d.codes.values()) {
    if (kind && c.kind !== kind) continue;
    const f = firstAttendedAfter(d, index, c.code, stage);
    if (!f) continue;
    if (f.days == null) { if (c.state === 'open') waiting++; continue; }
    if (!inPeriod(Date.parse(f.attendedAt))) continue;
    all.push(f.days);
    (by[c.service] ||= []).push(f.days);
  }
  const fig = (xs) => ({ n: xs.length, medianDays: xs.length >= minGroup ? median(xs) : null });
  return { ...fig(all), byService: Object.fromEntries(Object.entries(by).map(([s, xs]) => [s, fig(xs)])), waiting };
}
