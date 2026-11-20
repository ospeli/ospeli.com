// Outpatient clinics (area A1): pure functions for the screens, the measures and the guide.
// No screen code, no storage and no clock: the caller passes `now`. Every measure is worked out
// by the shared helpers of the slot object (core/slots.js) and the patient code object
// (core/codes.js); this file only picks which sessions and codes they are asked about (clinic
// sessions, one service) and never counts in its own way.
//
// Operations only. A clinic is a service at a place, never a person: no figure here names, times
// or ranks a clinician. A patient is a code ("Patient P12"); two codes are never matched.

import {
  utilisation, noShowRate, waitInClinic, firstCalledVsStart, overrun, sessionFill, slotTimes, placeTaken, dueMs, localInstant, localDate, addDays, weekdayOf,
} from '../../core/slots.js';
import { stageToFirstAttended, codeLabel, waitingDays, attendanceOf } from '../../core/codes.js';

const MIN = 60e3;
const DAY = 864e5;

export const SESSION_TYPE = 'clinic';
export const CODE_KIND = 'outpatient-referral';
export const ACCEPTED = 'referral.accepted';
export const GUIDE_SUBJECT = 'clinics-guide';

// Example settings, not standards. A site sets its own.
export const ON_TIME_MINUTES = 15;       // clinic start punctuality: first patient called within this many minutes of the planned start
export const MIN_GROUP = 5;              // small-number rule: a figure for one clinic needs at least this many cases
export const MISSED_LOOKBACK_WEEKS = 4;  // guide rule 1
export const MISSED_ABOVE = 0.12;        // guide rule 1: the usual level the site set (12%)
export const MISSED_MIN_DUE = 20;        // guide rule 1: at least this many appointments due over the weeks
export const EMPTY_WITHIN_HOURS = 48;    // guide rule 2: empty slots within two days of the clinic
export const OFFER_AT_MOST = 3;          // guide rule 2: at most this many prefilled bookings per clinic
export const MOVE_NOTICE_HOURS = 24;       // a booking moved off a cancelled clinic goes no sooner than this (example setting, not a standard)
export const LATE_MINUTES = 15;           // queue: a patient waiting this long past the booked time is shown as late
export const EARLY_MINUTES = 30;         // guide rule 3: arrived this long or more before the booked slot
export const BUNCHED_SHARE = 0.5;        // guide rule 3: share of arrivals that early
export const BUNCHED_MIN_ARRIVED = 20;   // guide rule 3: at least this many arrivals over the weeks

const BASIS = 'Example setting, not a standard: a site sets its own level. Fixed rule, not AI; it suggests and a person decides.';
export const GUIDE_RULES = [
  { id: 'missed-high', name: 'Missed appointments above the usual level',
    when: `A clinic's missed appointment rate over the last ${MISSED_LOOKBACK_WEEKS} weeks is above ${Math.round(MISSED_ABOVE * 100)}%, with at least ${MISSED_MIN_DUE} appointments due. Clinic sessions only.`,
    suggests: 'A review of how that clinic books (and, once reminders are recorded here, extra reminders). What happens after each missed appointment is for the follow-up team, not this rule.',
    basis: `${BASIS} The level of ${Math.round(MISSED_ABOVE * 100)}% is an example.` },
  { id: 'empty-soon', name: 'Empty slots within two days',
    when: `A clinic in the next ${EMPTY_WITHIN_HOURS / 24} days still has empty slots, and referrals for the same service are waiting with no appointment.`,
    suggests: `Offer the empty slots to the longest-waiting referrals for that service (by wait only, never by urgency): up to ${OFFER_AT_MOST} prefilled bookings a person taps. The guide never books.`,
    basis: `${BASIS} Two days and ${OFFER_AT_MOST} offers are examples.` },
  { id: 'arrivals-bunched', name: 'Patients arrive at the start, not at their slot',
    when: `Over the last ${MISSED_LOOKBACK_WEEKS} weeks at least ${Math.round(BUNCHED_SHARE * 100)}% of a clinic's patients arrived ${EARLY_MINUTES} minutes or more before their booked slot (at least ${BUNCHED_MIN_ARRIVED} arrivals).`,
    suggests: 'A staggered template, or telling each patient their own slot time, with the current arrived-to-called waits beside it. Changing a template is planned, not built yet.',
    basis: `${BASIS} ${EARLY_MINUTES} minutes and ${Math.round(BUNCHED_SHARE * 100)}% are examples.` },
];

// The guide is on until a person switches it off (clinics.guide-set, a people-only command).
export function guideOn(events) {
  let on = true;
  for (const e of events) if (e.type === 'clinics.guide-set' && typeof e.data?.on === 'boolean') on = e.data.on;
  return on;
}

// ---- which sessions and codes a measure is asked about ----
// The derived slot record narrowed to clinic sessions (and one service, when given), so a shared
// helper counts exactly those. Nothing is counted here.
export function clinicView(d, service = null) {
  const keep = (s) => s && s.sessionType === SESSION_TYPE && (!service || s.service === service);
  const sessions = new Map([...d.sessions].filter(([, s]) => keep(s)));
  const appointments = new Map([...d.appointments].filter(([, a]) => sessions.has(a.sessionId)));
  return { ...d, sessions, appointments };
}
export const servicesOf = (d) => [...new Set([...d.sessions.values()].filter((s) => s.sessionType === SESSION_TYPE && s.service).map((s) => s.service))];

// ---- the five measures (each through a shared helper) ----
// 1. Missed appointment rate: appointments in clinic sessions marked missed, out of those due in
//    the period, leaving out those cancelled before the day. Helper noShowRate.
export const missedRate = (d, { since, until, service = null }) => noShowRate(clinicView(d, service), { since, until, sessionType: SESSION_TYPE });
// 2. Slot utilisation: slots used (a missed appointment used its slot) out of slots released in
//    clinic sessions held in the period, after reductions. Helper utilisation.
export const slotUtilisation = (d, { since, until, service = null }) => utilisation(clinicView(d, service), { since, until, sessionType: SESSION_TYPE });
// 3. Referral to first appointment: days from referral accepted to the first finished visit,
//    median, by service; with the referrals still waiting beside it. Helper stageToFirstAttended.
export const referralToFirst = (codesD, index, { since, until, minGroup = MIN_GROUP }) => stageToFirstAttended(codesD, index, { stage: ACCEPTED, since, until, kind: CODE_KIND, minGroup });
// 4. Waiting time in clinic: arrived to called, median minutes. Helper waitInClinic.
export const clinicWait = (d, { since, until, service = null }) => waitInClinic(clinicView(d, service), { since, until, sessionType: SESSION_TYPE });
// 5. Clinic start punctuality: clinic sessions held in the period whose first patient was called
//    no later than ON_TIME_MINUTES after the planned start (early counts as on time), out of the
//    sessions held in which anyone was called. Helper firstCalledVsStart for each session.
export function startPunctuality(d, { since, until, service = null, windowMinutes = ON_TIME_MINUTES }) {
  const lo = since == null ? -Infinity : Date.parse(since); const hi = Date.parse(until);
  let onTime = 0; let held = 0; let nobodyCalled = 0;
  for (const s of clinicView(d, service).sessions.values()) {
    if (s.state !== 'held' || !(s.startMs >= lo && s.startMs < hi)) continue;
    const { minutes } = firstCalledVsStart(d, { sessionId: s.id });
    if (minutes == null) { nobodyCalled++; continue; }
    held++;
    if (minutes <= windowMinutes) onTime++;
  }
  return { value: held ? onTime / held : null, numerator: onTime, denominator: held, nobodyCalled };
}

// ---- the queue for one clinic session ----
// The open patient keeps its place: the list is in booked-time order and never re-sorts by state,
// so a second tap lands where the first did.
export function queueOf(d, sessionId, now) {
  const s = d.sessions.get(sessionId);
  if (!s) return [];
  return (s.appointments || []).map((id) => d.appointments.get(id)).filter(Boolean)
    .filter((a) => a.state !== 'cancelled' || a.arrivedAt) // cancelled before arriving: not coming, counted only
    .sort((a, b) => (a.slotTime < b.slotTime ? -1 : a.slotTime > b.slotTime ? 1 : a.id < b.id ? -1 : 1))
    .map((a) => ({ a, dueMs: dueMs(d, a) }));
}
export const minutesBetween = (fromIso, toIso) => Math.max(0, Math.round((Date.parse(toIso) - Date.parse(fromIso)) / MIN));

// ---- one clinic's day ----
export function dayOf(d, s, now) {
  const appts = (s.appointments || []).map((id) => d.appointments.get(id)).filter(Boolean);
  const fill = sessionFill(d, s.id);
  const count = (f) => appts.filter(f).length;
  const waiting = appts.filter((a) => a.state === 'arrived').map((a) => minutesBetween(a.arrivedAt, now));
  const open = appts.filter((a) => ['booked', 'arrived', 'called'].includes(a.state));
  return {
    // Used + empty = offered, always: a missed appointment and a patient who left before being seen
    // used their slot; a cancelled booking's slot is empty again, or refilled by another booking.
    templateSlots: s.timed ? s.plannedCapacity : null, capacity: s.state === 'cancelled' ? 0 : fill.capacity, used: s.state === 'cancelled' ? 0 : fill.booked,
    empty: s.state === 'cancelled' ? 0 : Math.max(0, fill.capacity - fill.booked),
    cancelled: count((a) => a.state === 'cancelled' && !a.arrivedAt), missed: count((a) => a.state === 'no-show'),
    attended: count((a) => a.arrivedAt), finished: count((a) => a.state === 'finished'),
    toCome: count((a) => a.state === 'booked'), waitingNow: waiting.length, longestWaitMinutes: waiting.length ? Math.max(...waiting) : null,
    withClinician: count((a) => a.state === 'called'), leftBeforeSeen: count((a) => a.state === 'cancelled' && a.arrivedAt),
    firstCalledMinutes: firstCalledVsStart(d, { sessionId: s.id }).minutes, overrunMinutes: open.length ? null : overrun(d, { sessionId: s.id }).minutes, // only once nobody is still booked, waiting or in
    open,
  };
}

// ---- free slots, offered only in sessions of the referral's own service ----
// The core does not tie a booking to a service; this does, for every screen and the guide.
// `sessions` is a neutral list: [{ id, service, state, released, startMs, start, slots: [{ time, taken }] }].
const toMinutes = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));
export function nextFreeSlots(sessions, { service, nowMs, exceptSessionId = null, limit = 3, untilMs = Infinity }) {
  if (!service) return [];
  const out = [];
  const list = sessions.filter((s) => s.service === service && s.id !== exceptSessionId && (s.state === 'planned' || s.state === 'reduced') && s.released !== false)
    .sort((a, b) => a.startMs - b.startMs || (a.id < b.id ? -1 : 1));
  for (const s of list) {
    for (const slot of s.slots) {
      if (slot.taken) continue;
      const at = s.startMs + (toMinutes(slot.time) - toMinutes(s.start)) * MIN;
      if (at <= nowMs || at > untilMs) continue;
      out.push({ sessionId: s.id, slotTime: slot.time, atMs: at, date: s.date ?? null });
      if (out.length >= limit) return out;
    }
  }
  return out;
}
// Move-or-Cancel: one distinct free slot for each open booking of a clinic being cancelled, in
// booked-time order: same service, never sooner than now plus the notice, and on or after the
// booking's own date. null when none is free: then only Cancel is offered.
export function moveTargets(sessions, { service, exceptSessionId, bookings, nowMs, fromDate, noticeHours = MOVE_NOTICE_HOURS }) {
  const all = nextFreeSlots(sessions, { service, nowMs: nowMs + noticeHours * 60 * MIN, exceptSessionId, limit: 500 })
    .filter((x) => !fromDate || (x.date ?? '') >= fromDate);
  const used = new Set();
  return [...bookings].sort((a, b) => (a.slotTime < b.slotTime ? -1 : a.slotTime > b.slotTime ? 1 : a.appointmentId < b.appointmentId ? -1 : 1))
    .map((b) => {
      const to = all.find((x) => !used.has(`${x.sessionId} ${x.slotTime}`)) || null;
      if (to) used.add(`${to.sessionId} ${to.slotTime}`);
      return { ...b, moveTo: to };
    });
}
// The neutral list from the derived record (pack) …
export const sessionsFromDerived = (d) => [...clinicView(d).sessions.values()].map((s) => ({
  id: s.id, service: s.service, state: s.state, released: s.released, startMs: s.startMs, start: s.start, date: s.date,
  slots: slotTimes(s).map((time) => ({ time, taken: Boolean(placeTaken(d, s, { slotTime: time })) })) }));
// … and from what ospeli_slots_sessions answers (screens).
export const sessionsFromRead = (list) => (list || []).filter((s) => s.sessionType === SESSION_TYPE && s.timed !== false).map((s) => ({
  id: s.id, service: s.service, state: s.state, released: s.released, startMs: Date.parse(s.startsAt), start: s.start, date: s.date,
  slots: (s.slots || []).map((x) => ({ time: x.time, taken: Boolean(x.appointmentId) })) }));

// The waiting list for a first appointment, longest wait first (wait only: no urgency). ONE order
// for the screen (rows from ospeli_codes_list) and the guide (rows from the derived record):
// rows are { code, service, state, openedAt, booked, attended }.
export function firstAppointmentList(rows, { service = null } = {}) {
  return rows.filter((r) => r.state === 'open' && !r.booked && !r.attended && (!service || r.service === service))
    .sort((x, y) => Date.parse(x.openedAt) - Date.parse(y.openedAt) || (x.code < y.code ? -1 : 1));
}
// The rows from what ospeli_codes_list answers (screens) …
export const rowsFromList = (codes) => (codes || []).map((c) => ({ ...c, booked: Boolean(c.booked), attended: c.lastAttendedAt != null }));
// … and from the derived record (pack). rebookOf: the last missed or cancelled appointment not yet rebooked.
export function waitingReferrals(codesD, index, { service = null, now }) {
  const rows = [...codesD.codes.values()].filter((c) => c.kind === CODE_KIND).map((c) => {
    const att = attendanceOf(index, c.code);
    const last = (index?.get(c.code) || []).filter((a) => (a.state === 'no-show' || a.state === 'cancelled') && !a.rebookedBy).at(-1) || null;
    return { code: c.code, service: c.service, state: c.state, openedAt: c.openedAt, booked: att.open.length > 0, attended: att.everAttended,
      label: codeLabel(c.code), waitingDays: waitingDays(c, now), appointments: att.count, rebookOf: last?.id ?? null };
  });
  return firstAppointmentList(rows, { service });
}
// "today", "1 day", "12 days".
export const daysWords = (n) => (n <= 0 ? 'today' : n === 1 ? '1 day' : `${n} days`);
export const waitedWords = (n) => (n <= 0 ? 'added today' : `waiting ${daysWords(n)}`);

// ---- guide rules: fixed, checkable rules. A rule suggests; a person decides. ----
const pct = (x) => `${Math.round(x * 100)}%`;
const dayWord = (date) => ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][weekdayOf(date) - 1];
const shortDate = (date) => `${dayWord(date)} ${Number(date.slice(8))} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(date.slice(5, 7)) - 1]}`;
export const slotWords = (date, hhmm) => `${shortDate(date)}, ${hhmm}`;
const sameService = (word) => word || 'this clinic';

// Rule 1. Weeks run back from `now` in whole weeks, newest last.
export function ruleMissedHigh(d, { now, serviceWords = {} }) {
  const out = [];
  const end = Date.parse(now);
  for (const service of servicesOf(d)) {
    const weeks = [];
    for (let w = MISSED_LOOKBACK_WEEKS; w >= 1; w--) {
      const since = new Date(end - w * 7 * DAY).toISOString(); const until = new Date(end - (w - 1) * 7 * DAY).toISOString();
      weeks.push({ until, ...missedRate(d, { since, until, service }) });
    }
    const all = missedRate(d, { since: new Date(end - MISSED_LOOKBACK_WEEKS * 7 * DAY).toISOString(), until: now, service });
    if (all.denominator < MISSED_MIN_DUE || !(all.value > MISSED_ABOVE)) continue;
    const word = sameService(serviceWords[service]);
    out.push({ rule: 'missed-high', id: `missed-high:${service}`, service,
      text: `Review how the ${word} books: ${pct(all.value)} of appointments were missed over the last ${MISSED_LOOKBACK_WEEKS} weeks.`,
      why: `${all.numerator} of ${all.denominator} appointments due were missed (the usual level set here is ${pct(MISSED_ABOVE)}). Week by week, oldest first: ${weeks.map((x) => `${x.numerator} of ${x.denominator}`).join('; ')}.`,
      basis: GUIDE_RULES[0].basis, weeks: weeks.map((x) => ({ until: x.until, missed: x.numerator, due: x.denominator })), action: null, actions: [] });
  }
  return out;
}

// Rule 2. Prefilled bookings for a person to tap; the guide never books.
export function ruleEmptySoon(d, codesD, index, { now, serviceWords = {}, offsetMinutes = 0 }) {
  const out = [];
  const offered = new Set();
  const nowMs = Date.parse(now);
  const all = sessionsFromDerived(d);
  for (const s of all.filter((x) => (x.state === 'planned' || x.state === 'reduced') && x.released !== false && x.startMs > nowMs - 12 * 60 * MIN && x.startMs <= nowMs + EMPTY_WITHIN_HOURS * 60 * MIN)
    .sort((a, b) => a.startMs - b.startMs)) {
    const free = nextFreeSlots([s], { service: s.service, nowMs, limit: 50 });
    if (!free.length) continue;
    const list = waitingReferrals(codesD, index, { service: s.service, now });
    const waiting = list.filter((r) => !offered.has(r.code)); // the same order as the waiting list; never one patient in two suggestions
    if (!waiting.length) continue;
    const n = Math.min(free.length, waiting.length, OFFER_AT_MOST);
    const word = sameService(serviceWords[s.service]);
    const date = localDate(new Date(s.startMs).toISOString(), offsetMinutes);
    const actions = [];
    for (let i = 0; i < n; i++) {
      const w = waiting[i];
      offered.add(w.code);
      actions.push({ command: 'ospeli_slots_book', label: `Book ${w.label} (${waitedWords(w.waitingDays)}) at ${free[i].slotTime}`,
        input: { sessionId: s.id, slotTime: free[i].slotTime, code: w.code, slotType: 'new', bookedFrom: w.rebookOf ? 'rebook' : 'referral', ...(w.rebookOf ? { rebookOf: w.rebookOf } : {}) } });
    }
    out.push({ rule: 'empty-soon', id: `empty-soon:${s.id}`, service: s.service, sessionId: s.id,
      text: `${free.length} empty slot${free.length === 1 ? '' : 's'} in the ${word} on ${shortDate(date)}: offer ${n === 1 ? 'it' : 'them'} to the longest-waiting referrals.`,
      why: `${list.length} referral${list.length === 1 ? ' is' : 's are'} waiting for a first ${word} appointment (the longest: ${waitedWords(list[0].waitingDays)}). Offered in the waiting list's own order, by wait only, in sessions of the same service.`,
      basis: GUIDE_RULES[1].basis, action: actions[0], actions });
  }
  return out;
}

// Rule 3. Arrival compared with the booked slot (dueMs), never with a person.
export function ruleArrivalsBunched(d, { now, serviceWords = {} }) {
  const out = [];
  const end = Date.parse(now); const lo = end - MISSED_LOOKBACK_WEEKS * 7 * DAY;
  for (const service of servicesOf(d)) {
    const view = clinicView(d, service);
    const arrived = [...view.appointments.values()].filter((a) => a.arrivedAt && a.slotTime && Date.parse(a.arrivedAt) >= lo && Date.parse(a.arrivedAt) < end);
    if (arrived.length < BUNCHED_MIN_ARRIVED) continue;
    const early = arrived.filter((a) => dueMs(d, a) - Date.parse(a.arrivedAt) >= EARLY_MINUTES * MIN).length;
    if (early / arrived.length < BUNCHED_SHARE) continue;
    const wait = clinicWait(d, { since: new Date(lo).toISOString(), until: now, service });
    const word = sameService(serviceWords[service]);
    out.push({ rule: 'arrivals-bunched', id: `arrivals-bunched:${service}`, service,
      text: `Most patients at the ${word} arrive at the start, not at their slot: consider a staggered template, or telling each patient their own slot time.`,
      why: `${early} of ${arrived.length} patients (${pct(early / arrived.length)}) arrived ${EARLY_MINUTES} minutes or more before their booked slot over the last ${MISSED_LOOKBACK_WEEKS} weeks. Median wait from arrived to called: ${wait.medianMinutes == null ? 'none yet' : `${Math.round(wait.medianMinutes)} min`} (${wait.n} patients). Changing a template is planned, not built yet.`,
      basis: GUIDE_RULES[2].basis, earlyShare: early / arrived.length, medianWaitMinutes: wait.medianMinutes, action: null, actions: [] });
  }
  return out;
}

// The site's own date at `now`, and the dates around it.
export const today = (now, offsetMinutes) => localDate(now, offsetMinutes);
export { addDays, localInstant, shortDate };
