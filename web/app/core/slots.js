// The shared appointment or slot object: capacity offered at a place on a date (a session), and
// the bookings made against it (appointments). One record for a clinic with timed slots and for
// a capacity session with a visit order (a round, an outreach day). Outpatients, theatres,
// diagnostics, community care and public health each add their types of session as configuration
// (SESSION_TYPES and SLOT_TYPES in a module's commands.js) and write no booking code of their own.
//
// Derived only from the event log, like the bed board, tasks and stock: nothing about a session
// or an appointment is stored except events, so a list, a measure and an auditor read one record.
//
// Operations only. An appointment is a patient code, a time and a few picks: no name, no
// address, no date of birth, no reason for the visit, no urgency and no free text anywhere.
// Measure flows, never people: every event records the role that acted, and a session is run by
// a role, never a named person. Ospeli sends no messages: a reminder is only recorded.
//
// Times. A session has a date and a start as the site's own wall clock ("2026-11-09", "09:00").
// They are turned into a moment with the site's utcOffsetMinutes (the one time model the app
// ships with, as in kpi.js and stock.js); `offsetMinutes` is passed in, so this file has no clock.

const MIN = 60e3;
const DAY = 864e5;

export const TEMPLATE_ID_PATTERN = '^tpl-[0-9]{5,}$';
export const SESSION_ID_PATTERN = '^ses-[0-9]{5,}$';
export const APPOINTMENT_ID_PATTERN = '^apt-[0-9]{5,}$';
// A patient code is made by Ospeli (the patient code object), never typed from another system.
export const CODE_PATTERN = '^pc-[0-9]{5,}$';
export const DATE_PATTERN = '^[0-9]{4}-[0-9]{2}-[0-9]{2}$';
export const HHMM_PATTERN = '^([01][0-9]|2[0-3]):[0-5][0-9]$';
export const AREA_PATTERN = '^[A-Za-z][A-Za-z ]{0,17}[A-Za-z0-9]$';

export const SESSION_STATES = {
  planned: { name: 'Planned' },
  reduced: { name: 'Reduced' },
  held: { name: 'Held' },
  cancelled: { name: 'Cancelled' },
};
export const APPOINTMENT_STATES = {
  booked: { name: 'Booked' },
  arrived: { name: 'Arrived' },
  called: { name: 'Called' },
  finished: { name: 'Finished' },
  'no-show': { name: 'Missed appointment' },
  cancelled: { name: 'Cancelled' },
};
export const OPEN_APPOINTMENT_STATES = ['booked', 'arrived', 'called'];
// A patient who was seen but whose Call in and Finished nobody tapped: the appointment is finished
// with no call or finish time (`noTimes`). The words a list shows for it.
export const NO_TIMES_NAME = 'Seen, no times';
// A step marked by mistake can be undone by a person: the step it undoes, and the state it goes back to.
// Nothing is erased: the wrong step and the undo both stay in the log.
export const UNDO_STEPS = { arrived: 'booked', called: 'arrived', 'no-show': 'booked' };
export const UNDO_REASON_DEFAULT = 'Marked by mistake';
// "Patient arrived late" is for a missed appointment only: the patient came after it was recorded.
export const UNDO_REASONS = [UNDO_REASON_DEFAULT, 'Patient arrived late'];
// Every reason is a pick from a list, so no personal detail can be typed. A module may add
// reasons of its own (SLOT_REASONS in its pack); it can never take one away.
export const SESSION_CHANGE_REASONS = ['Staff short', 'Room or vehicle not available', 'Weather or access', 'Other'];
// Once a patient has arrived, the only cancel is this one, by the patient: they left before being seen.
export const LEFT_REASON = 'Left before being seen';
export const APPOINTMENT_CANCEL_REASONS = ['Patient asked to cancel', 'Session cancelled or reduced', 'Not reached: round ran out of time', 'Booked in error', LEFT_REASON, 'Other'];
export const NO_SHOW_REASONS = ['Did not arrive', 'No answer at the door', 'Other'];
export const BOOKED_FROM = ['referral', 'recall', 'rebook', 'walk-in'];
export const REMINDER_REPLIES = ['confirmed', 'cancelled', 'no-reply'];
export const CANCEL_BY = ['site', 'patient'];
// Minutes after the booked time before a no-show may be recorded. Example setting, not a standard.
export const NO_SHOW_GRACE_DEFAULT = 15;
export const MAX_SESSION_MINUTES = 24 * 60;
export const MAX_CAPACITY = 200;
export const SLOT_PLACE_TYPES = ['site', 'building', 'department', 'ward', 'bed', 'asset'];
export const SLOT_EVENT_TYPES = [
  'slot.template-set', 'session.planned', 'session.held', 'session.cancelled', 'session.reduced', 'session.released',
  'appointment.booked', 'appointment.moved', 'appointment.cancelled', 'appointment.arrived', 'appointment.called', 'appointment.finished',
  'appointment.no-show', 'appointment.reminder-recorded', 'appointment.seen-no-times', 'appointment.step-undone',
  // Read only, never written here: the patient code object's own events.
  'code.opened', 'code.closed',
];

const TYPE_ID = /^[a-z][a-z0-9-]{1,30}$/;
const AREA = new RegExp(AREA_PATTERN);
const HHMM = new RegExp(HHMM_PATTERN);
const ROLE_LISTS = ['runByRoles', 'planRoles', 'bookRoles', 'stepRoles'];
const shortWord = (w) => typeof w === 'string' && w.trim() && w.length <= 40;

// Put the modules' session types and slot types together. A type is refused (throws at load, so
// a test catches it) when it is malformed, reuses an id, or names a role or a kind of place that
// does not exist (roleIds null: the roles are not checked, for a caller that only replays the log). packs: [{ id, SESSION_TYPES?, SLOT_TYPES?, NO_SHOW_GRACE_MINUTES?, SLOT_REASONS? }].
// A session type may list `services` (a pick list { id: word }): then each session names one.
export function slotCatalogue(packs = [], roleIds = []) {
  const sessionTypes = new Map();
  const slotTypes = {};
  const reasons = { sessionChange: [...SESSION_CHANGE_REASONS], appointmentCancel: [...APPOINTMENT_CANCEL_REASONS], noShow: [...NO_SHOW_REASONS] };
  for (const p of packs) {
    for (const [id, word] of Object.entries(p.SLOT_TYPES || {})) {
      if (!TYPE_ID.test(id) || !shortWord(word)) throw new Error(`module ${p.id}: bad slot type ${id}`);
      if (slotTypes[id] && slotTypes[id] !== word) throw new Error(`module ${p.id}: slot type ${id} is already used`);
      slotTypes[id] = word;
    }
    for (const [list, more] of Object.entries(p.SLOT_REASONS || {})) {
      if (!reasons[list] || !Array.isArray(more) || !more.every(shortWord)) throw new Error(`module ${p.id}: SLOT_REASONS.${list} must be a list of short reasons for sessionChange, appointmentCancel or noShow`);
      // Added before "Other", which stays last.
      for (const r of more) if (!reasons[list].includes(r)) reasons[list].splice(reasons[list].length - 1, 0, r);
    }
  }
  for (const p of packs) {
    const grace = p.NO_SHOW_GRACE_MINUTES ?? NO_SHOW_GRACE_DEFAULT;
    if ((p.SESSION_TYPES || []).length && !(Number.isInteger(grace) && grace >= 0 && grace <= 240)) throw new Error(`module ${p.id}: NO_SHOW_GRACE_MINUTES must be a whole number of minutes from 0 to 240`);
    for (const st of p.SESSION_TYPES || []) {
      const bad = (why) => { throw new Error(`module ${p.id}: session type ${st?.id}: ${why}`); };
      if (!st || typeof st.id !== 'string' || !TYPE_ID.test(st.id)) bad('id must be lower-case letters, digits and hyphens');
      if (sessionTypes.has(st.id)) bad('this id is already used');
      if (!shortWord(st.word)) bad('word is required (what people call it, for example "Clinic")');
      if (typeof st.timed !== 'boolean') bad('timed is true (slots at set times) or false (a capacity and a visit order)');
      if (!Array.isArray(st.placeTypes) || !st.placeTypes.length) bad('placeTypes is required');
      for (const t of st.placeTypes) if (!SLOT_PLACE_TYPES.includes(t)) bad(`unknown place type ${t}`);
      for (const list of ROLE_LISTS) {
        if (!Array.isArray(st[list]) || !st[list].length) bad(`${list} is required`);
        for (const r of st[list]) if (roleIds && !roleIds.includes(r)) bad(`unknown role ${r} in ${list}`);
      }
      // Optional: the services a session of this type is held for (an eye clinic, a skin clinic),
      // a pick list. With it, every template and session of the type names one service, and two
      // clinics may run in the same place at the same time.
      if (st.services != null) {
        const sv = st.services && typeof st.services === 'object' ? Object.entries(st.services) : [];
        if (!sv.length || !sv.every(([id, w]) => TYPE_ID.test(id) && shortWord(w))) bad('services, when given, is a pick list { id: word } with at least one service');
      }
      if (st.areas != null) {
        if (st.timed) bad('areas are for a session with a visit order, not for timed slots');
        if (!Array.isArray(st.areas) || !st.areas.length || !st.areas.every((a) => typeof a === 'string' && a.length <= 20 && AREA.test(a))) bad('areas must be short zone codes such as "North 2": letters, then an optional number, never an address');
      }
      sessionTypes.set(st.id, { ...st, areas: st.areas ? [...st.areas] : null, services: st.services ? { ...st.services } : null, graceMinutes: grace, module: p.id });
    }
  }
  return { sessionTypes, slotTypes, reasons };
}

// ---- dates and times (site wall clock) ----
export function validDate(date) {
  if (typeof date !== 'string' || !new RegExp(DATE_PATTERN).test(date)) return false;
  const t = Date.parse(`${date}T00:00:00.000Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === date;
}
// Monday = 1 … Sunday = 7.
export const weekdayOf = (date) => new Date(`${date}T00:00:00.000Z`).getUTCDay() || 7;
// The moment (milliseconds) of a wall-clock date and time on a site `offsetMinutes` from UTC.
export const localInstant = (date, hhmm, offsetMinutes = 0) => Date.parse(`${date}T${hhmm}:00.000Z`) - offsetMinutes * MIN;
// The site's own date at a moment.
export const localDate = (iso, offsetMinutes = 0) => new Date(Date.parse(iso) + offsetMinutes * MIN).toISOString().slice(0, 10);
export const addDays = (date, n) => new Date(Date.parse(`${date}T00:00:00.000Z`) + n * DAY).toISOString().slice(0, 10);
const toMinutes = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));
const toHHMM = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

// The slot times a start, a length and a slot length give: 09:00 for 80 minutes in 20-minute
// slots is 09:00, 09:20, 09:40, 10:00. A part slot at the end is not a slot.
export function slotGrid(start, minutes, slotMinutes) {
  const out = [];
  const s = toMinutes(start);
  for (let k = 0; (k + 1) * slotMinutes <= minutes && s + k * slotMinutes < 24 * 60; k++) out.push(toHHMM(s + k * slotMinutes));
  return out;
}
// The slot times of a timed session as it stands (after any reduction). [] for a capacity session.
export const slotTimes = (session) => (session.timed ? slotGrid(session.start, session.minutes, session.slotMinutes).filter((t) => !session.removed.includes(t)) : []);
// How many places the session offers now.
export const capacityOf = (session) => (session.timed ? slotTimes(session).length : session.capacity);
// An appointment still takes its place unless it was cancelled before the patient arrived.
// A no-show used its slot; so did a patient who arrived and then left.
export const holdsPlace = (a) => a.state !== 'cancelled' || Boolean(a.arrivedAt);
export const isOpenAppointment = (a) => OPEN_APPOINTMENT_STATES.includes(a.state);

// The version of a template in force on a date: the latest one whose `from` is on or before it.
export function templateOn(template, date) {
  let best = null;
  for (const v of template?.versions || []) if (v.from <= date && (!best || v.from >= best.from)) best = v;
  return best;
}

// Replay the event log. Returns { templates, sessions, appointments, codes, offsetMinutes }, each
// a Map by id in the order first seen. An event that does not fit the record it names (a step
// out of order, a second booking with the same id) is ignored, so a bad import cannot bend a list.
//   template    { id, sessionType, service, placeId, weekday, versions: [{ start, minutes, slotMinutes, slotTypes, released, from, at }] }
//   session     { id, sessionType, service, timed, placeId, assetId, date, start, minutes, slotMinutes, slotTypes, capacity, plannedCapacity,
//                 removed, runByRole, templateId, released, state, reason, plannedAt, closedAt, startMs, endMs, appointments: [id] }
//   appointment { id, sessionId, sessionType, slotTime, visitOrder, area, code, slotType, bookedFrom, rebookOf, rebookedBy, requestRef,
//                 state, bookedAt, placedAt, bookedByRole, arrivedAt, calledAt, finishedAt, closedAt, noTimes, attendedAt, noShowReason, cancelBy,
//                 cancelReason, moves, reminders, corrections: [{ undo, reason, at, byRole, stepAt }] }
// placedAt: when the booking was put in the place it has now (booked, or last moved). noTimes: seen, but the
// call and finish were not tapped, so finishedAt is null. attendedAt: the finish, or for noTimes the arrival.
export function deriveSlots(events, { packs = [], offsetMinutes = 0, catalogue = null } = {}) {
  const { sessionTypes } = catalogue || slotCatalogue(packs, null);
  const templates = new Map();
  const sessions = new Map();
  const appointments = new Map();
  const codes = new Map();
  const place = (s) => { s.startMs = localInstant(s.date, s.start, offsetMinutes); s.endMs = s.startMs + s.minutes * MIN; return s; };
  const openSession = (id) => { const s = sessions.get(id); return s && (s.state === 'planned' || s.state === 'reduced') ? s : null; };
  for (const e of events) {
    const d = e.data || {};
    switch (e.type) {
      case 'code.opened': if (!codes.has(e.subject)) codes.set(e.subject, { code: e.subject, openedAt: e.at, closedAt: null }); break;
      case 'code.closed': { const c = codes.get(e.subject); if (c && !c.closedAt) c.closedAt = e.at; break; }
      case 'slot.template-set': {
        const v = { start: d.start, minutes: d.minutes, slotMinutes: d.slotMinutes, slotTypes: [...(d.slotTypes || [])], released: d.released !== false, from: d.from, at: e.at };
        const t = templates.get(e.subject);
        if (t) t.versions.push(v);
        else templates.set(e.subject, { id: e.subject, sessionType: d.sessionType, service: d.service ?? null, placeId: d.placeId, weekday: d.weekday, versions: [v] });
        break;
      }
      case 'session.planned': {
        if (sessions.has(e.subject) || !validDate(d.date) || !HHMM.test(d.start || '')) break;
        const timed = d.slotMinutes != null;
        sessions.set(e.subject, place({
          id: e.subject, sessionType: d.sessionType, service: d.service ?? null, timed, placeId: d.placeId ?? null, assetId: d.assetId ?? null, date: d.date, start: d.start, minutes: d.minutes,
          slotMinutes: timed ? d.slotMinutes : null, slotTypes: [...(d.slotTypes || [])], capacity: timed ? null : d.capacity, plannedCapacity: null, removed: [],
          runByRole: d.runByRole, templateId: d.templateId ?? null, released: d.released !== false, state: 'planned', reason: null,
          plannedAt: e.at, closedAt: null, appointments: [],
        }));
        const s = sessions.get(e.subject);
        s.plannedCapacity = capacityOf(s);
        break;
      }
      case 'session.released': { const s = openSession(e.subject); if (s) s.released = true; break; }
      case 'session.held': { const s = openSession(e.subject); if (s) Object.assign(s, { state: 'held', closedAt: e.at }); break; }
      case 'session.cancelled': { const s = openSession(e.subject); if (s) Object.assign(s, { state: 'cancelled', closedAt: e.at, reason: d.reason ?? null }); break; }
      case 'session.reduced': {
        const s = openSession(e.subject);
        if (!s) break;
        if (s.timed) s.removed = [...new Set([...s.removed, ...(Array.isArray(d.removeSlotTimes) ? d.removeSlotTimes : [])])];
        else if (Number.isInteger(d.capacity) && d.capacity < s.capacity) s.capacity = d.capacity;
        Object.assign(s, { state: 'reduced', reason: d.reason ?? null });
        break;
      }
      case 'appointment.booked': {
        const s = sessions.get(d.sessionId);
        if (appointments.has(e.subject) || !s) break;
        appointments.set(e.subject, {
          id: e.subject, sessionId: s.id, sessionType: d.sessionType ?? s.sessionType, slotTime: d.slotTime ?? null, visitOrder: d.visitOrder ?? null, area: d.area ?? null,
          code: d.code, slotType: d.slotType, bookedFrom: d.bookedFrom ?? null, rebookOf: d.rebookOf ?? null, rebookedBy: null, requestRef: d.requestRef ?? null,
          state: 'booked', bookedAt: e.at, placedAt: e.at, bookedByRole: e.actorRole, arrivedAt: null, calledAt: null, finishedAt: null, closedAt: null,
          noTimes: false, attendedAt: null, noShowReason: null, cancelBy: null, cancelReason: null, moves: 0, reminders: [], corrections: [],
        });
        s.appointments.push(e.subject);
        const old = d.rebookOf ? appointments.get(d.rebookOf) : null;
        if (old && !old.rebookedBy) old.rebookedBy = e.subject;
        break;
      }
      case 'appointment.moved': {
        const a = appointments.get(e.subject); const s = sessions.get(d.sessionId);
        if (!a || a.state !== 'booked' || !s) break;
        const from = sessions.get(a.sessionId);
        if (from && from !== s) { from.appointments = from.appointments.filter((x) => x !== a.id); s.appointments.push(a.id); }
        Object.assign(a, { sessionId: s.id, slotTime: d.slotTime ?? null, visitOrder: d.visitOrder ?? null, moves: a.moves + 1, placedAt: e.at });
        break;
      }
      case 'appointment.arrived': { const a = appointments.get(e.subject); if (a?.state === 'booked') Object.assign(a, { state: 'arrived', arrivedAt: e.at }); break; }
      case 'appointment.called': { const a = appointments.get(e.subject); if (a?.state === 'arrived') Object.assign(a, { state: 'called', calledAt: e.at }); break; }
      case 'appointment.finished': { const a = appointments.get(e.subject); if (a?.state === 'called') Object.assign(a, { state: 'finished', finishedAt: e.at, closedAt: e.at, attendedAt: e.at }); break; }
      // Seen, but not tapped through: attended and finished, with no call or finish time made up.
      case 'appointment.seen-no-times': {
        const a = appointments.get(e.subject);
        if (a && (a.state === 'arrived' || a.state === 'called')) Object.assign(a, { state: 'finished', noTimes: true, closedAt: e.at, attendedAt: a.arrivedAt });
        break;
      }
      // A step marked by mistake, undone by a person. An undo that does not fit the record is ignored.
      case 'appointment.step-undone': {
        const a = appointments.get(e.subject);
        if (!a || a.state !== d.undo || !UNDO_STEPS[d.undo]) break;
        if (d.undo === 'no-show' && !openSession(a.sessionId)) break;
        const stepAt = d.undo === 'arrived' ? a.arrivedAt : d.undo === 'called' ? a.calledAt : a.closedAt;
        a.corrections.push({ undo: d.undo, reason: UNDO_REASONS.includes(d.reason) ? d.reason : UNDO_REASON_DEFAULT, at: e.at, byRole: e.actorRole, stepAt });
        if (d.undo === 'arrived') Object.assign(a, { state: 'booked', arrivedAt: null });
        else if (d.undo === 'called') Object.assign(a, { state: 'arrived', calledAt: null });
        else Object.assign(a, { state: 'booked', closedAt: null, noShowReason: null });
        break;
      }
      case 'appointment.no-show': { const a = appointments.get(e.subject); if (a?.state === 'booked') Object.assign(a, { state: 'no-show', closedAt: e.at, noShowReason: d.reason ?? null }); break; }
      case 'appointment.cancelled': {
        const a = appointments.get(e.subject);
        if (a && isOpenAppointment(a)) Object.assign(a, { state: 'cancelled', closedAt: e.at, cancelBy: d.by ?? null, cancelReason: d.reason ?? null });
        break;
      }
      case 'appointment.reminder-recorded': { const a = appointments.get(e.subject); if (a && REMINDER_REPLIES.includes(d.reply)) a.reminders.push({ at: e.at, reply: d.reply }); break; }
      default: break;
    }
  }
  return { templates, sessions, appointments, codes, offsetMinutes, sessionTypes };
}

const nextId = (events, type, prefix) => {
  let max = 0;
  const re = new RegExp(`^${prefix}-(\\d{5,})$`);
  for (const e of events) { const m = e.type === type ? re.exec(e.subject) : null; if (m) max = Math.max(max, Number(m[1])); }
  return `${prefix}-${String(max + 1).padStart(5, '0')}`;
};
export const nextTemplateId = (events) => nextId(events, 'slot.template-set', 'tpl');
export const nextSessionId = (events) => nextId(events, 'session.planned', 'ses');
export const nextAppointmentId = (events) => nextId(events, 'appointment.booked', 'apt');

// A patient code as the log has it: 'open', 'closed', or null when Ospeli never opened it.
// (A small reader until the patient code object lands; then this asks that object.)
export const codeState = (d, code) => { const c = d.codes.get(code); return !c ? null : c.closedAt ? 'closed' : 'open'; };

// The appointments of a session that still take a place, and those still open.
export const appointmentsOf = (d, sessionId) => (d.sessions.get(sessionId)?.appointments || []).map((id) => d.appointments.get(id)).filter(Boolean);
export const placeTaken = (d, session, { slotTime = null, visitOrder = null }, exceptId = null) => appointmentsOf(d, session.id)
  .find((a) => a.id !== exceptId && holdsPlace(a) && (session.timed ? a.slotTime === slotTime : a.visitOrder === visitOrder)) || null;

// How full a session is: { capacity, booked, free }. A no-show still used its place.
export function sessionFill(d, sessionId) {
  const s = d.sessions.get(sessionId);
  if (!s) return null;
  const capacity = capacityOf(s);
  const booked = appointmentsOf(d, sessionId).filter(holdsPlace).length;
  return { capacity, booked, free: Math.max(0, capacity - booked) };
}

// When an appointment is due: its slot time, or the session's start for a visit order.
export function dueMs(d, a) {
  const s = d.sessions.get(a.sessionId);
  return s ? (a.slotTime ? localInstant(s.date, a.slotTime, d.offsetMinutes) : s.startMs) : null;
}
// The earliest moment a no-show may be recorded: the type's grace after the time the patient was
// given. For a booking made or moved into a place whose time had already passed, the grace
// counts from that booking or move, so nobody is "missed" before the time they were told.
export const noShowFromMs = (d, a) => {
  const due = dueMs(d, a);
  if (due == null) return null;
  const placed = a.placedAt ? Date.parse(a.placedAt) : -Infinity;
  return Math.max(due, placed) + (d.sessionTypes.get(a.sessionType)?.graceMinutes ?? NO_SHOW_GRACE_DEFAULT) * MIN;
};
// true: the grace runs from when the booking was placed, not from its slot time.
export const placedLate = (d, a) => { const due = dueMs(d, a); return due != null && a.placedAt != null && Date.parse(a.placedAt) > due; };
// Minutes from arrived to called, or to `now` while still waiting; null before arriving, and
// null for a patient seen with no call time recorded (no wait is made up).
export function waitMinutes(a, now) {
  if (!a.arrivedAt || (a.noTimes && !a.calledAt)) return null;
  const end = a.calledAt || (a.state === 'arrived' ? now : a.closedAt) || now;
  return Math.max(0, Math.round((Date.parse(end) - Date.parse(a.arrivedAt)) / MIN));
}

// ---- measures (pure; sessions and places, never a person) ----
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
const rate = (numerator, denominator) => ({ value: denominator ? numerator / denominator : null, numerator, denominator });

// Slots used out of slots offered, for sessions that were held and started in the period, after
// any reduction, released sessions only. A no-show counts as used: the slot could not be
// given to anyone else. Local definition.
export function utilisation(d, { since, until, sessionType = null } = {}) {
  const inPeriod = period({ since, until });
  let used = 0; let offered = 0;
  for (const s of d.sessions.values()) {
    if (s.state !== 'held' || !s.released || !inPeriod(s.startMs) || (sessionType && s.sessionType !== sessionType)) continue;
    const f = sessionFill(d, s.id);
    used += Math.min(f.booked, f.capacity); offered += f.capacity;
  }
  return rate(used, offered);
}
// No-shows out of appointments due in the period, leaving out those cancelled before the
// day of the appointment (site date). Filter by session type: a clinic's rate never includes
// "no answer at the door" on a round. Local definition.
export function noShowRate(d, { since, until, sessionType = null } = {}) {
  const inPeriod = period({ since, until });
  let missed = 0; let due = 0;
  for (const a of d.appointments.values()) {
    const s = d.sessions.get(a.sessionId);
    if (!s || (sessionType && a.sessionType !== sessionType) || !inPeriod(dueMs(d, a))) continue;
    if (a.state === 'cancelled' && !a.arrivedAt && Date.parse(a.closedAt) < localInstant(s.date, '00:00', d.offsetMinutes)) continue;
    due++;
    if (a.state === 'no-show') missed++;
  }
  return rate(missed, due);
}
// Arrived to called, for appointments called in the period: { n, medianMinutes, leftOut }.
// leftOut: patients seen with no call time recorded (closed in the period); they have no wait
// to count, and the figure says how many. Local definition.
export function waitInClinic(d, { since, until, sessionType = null } = {}) {
  const inPeriod = period({ since, until });
  const mine = [...d.appointments.values()].filter((a) => !sessionType || a.sessionType === sessionType);
  const waits = mine.filter((a) => a.calledAt && a.arrivedAt && inPeriod(Date.parse(a.calledAt)))
    .map((a) => Math.max(0, Date.parse(a.calledAt) - Date.parse(a.arrivedAt)) / MIN);
  const leftOut = mine.filter((a) => a.noTimes && !a.calledAt && inPeriod(Date.parse(a.closedAt))).length;
  return { n: waits.length, medianMinutes: median(waits), leftOut };
}
// Start of a session, two ways (both local definitions; below zero: called early; null: nobody called yet):
//   minutes                 first patient called, against the planned start: the delay patients feel. The headline.
//   minutesFromFirstArrival first patient called, against the later of the planned start and the first arrival,
//                           so a session whose first booked patients did not come is not shown as starting late.
//   nobodyHereAtStart       true when no patient had arrived by the planned start (null: nobody arrived at all).
//   leftOut                 patients seen with no call time recorded: they cannot be the first call.
export function firstCalledVsStart(d, { sessionId }) {
  const s = d.sessions.get(sessionId);
  const mine = appointmentsOf(d, sessionId);
  const called = mine.filter((a) => a.calledAt).map((a) => Date.parse(a.calledAt));
  const arrived = mine.filter((a) => a.arrivedAt).map((a) => Date.parse(a.arrivedAt));
  const firstArrival = arrived.length ? Math.min(...arrived) : null;
  const firstCall = s && called.length ? Math.min(...called) : null;
  return {
    minutes: firstCall == null ? null : (firstCall - s.startMs) / MIN,
    minutesFromFirstArrival: firstCall == null ? null : (firstCall - Math.max(s.startMs, firstArrival ?? s.startMs)) / MIN,
    nobodyHereAtStart: s && firstArrival != null ? firstArrival > s.startMs : null,
    leftOut: mine.filter((a) => a.noTimes && !a.calledAt).length,
  };
}
// Minutes from the session's planned end to the last patient finished (below zero: ended early). null: nobody
// finished yet. Only a finish tapped at its own time counts; leftOut says how many patients were seen with no
// finish time recorded, so tidying up after a clinic never shows as an overrun. Local definition.
export function overrun(d, { sessionId }) {
  const s = d.sessions.get(sessionId);
  const mine = appointmentsOf(d, sessionId);
  const done = mine.filter((a) => a.finishedAt).map((a) => Date.parse(a.finishedAt));
  return { minutes: s && done.length ? (Math.max(...done) - s.endMs) / MIN : null, leftOut: mine.filter((a) => a.noTimes).length };
}
// How many of a session's attended patients were closed as "seen, no times": a figure about the
// record's quality, shown beside the measures. { noTimes, attended }
export function noTimesCount(d, { sessionId }) {
  const done = appointmentsOf(d, sessionId).filter((a) => a.state === 'finished');
  return { noTimes: done.filter((a) => a.noTimes).length, attended: done.length };
}
// Bookings made in the period that replace a cancelled or missed appointment.
export function rebookCount(d, { since, until, sessionType = null } = {}) {
  const inPeriod = period({ since, until });
  return [...d.appointments.values()].filter((a) => a.rebookOf && inPeriod(Date.parse(a.bookedAt)) && (!sessionType || a.sessionType === sessionType)).length;
}
// Patients who arrived and left before being seen, out of those who arrived, for appointments due in the period.
export function leftBeforeSeen(d, { since, until, sessionType = null } = {}) {
  const inPeriod = period({ since, until });
  const arrived = [...d.appointments.values()].filter((a) => a.arrivedAt && inPeriod(dueMs(d, a)) && (!sessionType || a.sessionType === sessionType));
  return rate(arrived.filter((a) => a.state === 'cancelled').length, arrived.length);
}
