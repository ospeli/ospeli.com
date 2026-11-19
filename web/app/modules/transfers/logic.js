// Transfers and vehicles: the module's fixed lists and its pure functions. Everything here reads
// the event log (and the vehicles and places it is given) and nothing else: no screen, no storage,
// no clock (the caller passes `now`), so the queue, the fleet, the KPIs and the guide give the same
// answer in the browser, in a test and on a site's own server.
//
// A journey in a vehicle: between the organisation's own sites, or to or from another provider.
// Moves on foot inside a site belong to Cleaning and transport (the shared task object), never here.
// Measure flows, never people: every number is about journeys and vehicles. An event records the
// role that did it, never a person, and nothing here counts, times or ranks a driver or a crew.

import { median, MIN, HOUR, DAY } from '../../core/kit.js';

// ---- pick lists (nothing is typed, so no clinical note or personal detail can go in) ----
export const TYPES = [
  { id: 'discharge', name: 'Discharge', hint: 'Going home, to residential or nursing care, or to a hospice' },
  { id: 'between-sites', name: 'Between our sites', hint: 'To another site of this organisation' },
  { id: 'to-provider', name: 'To another provider', hint: 'Another hospital, residential or nursing care, or a hospice' },
  { id: 'appointment', name: 'Appointment', hint: 'To an appointment elsewhere; book the return as its own journey' },
];
// Outside destinations are categories, never a provider's name or an address.
export const OUTSIDE = [
  { id: 'other-hospital', name: 'Another hospital' },
  { id: 'care-home', name: 'Residential or nursing care' },
  { id: 'hospice', name: 'Hospice' },
  { id: 'home', name: 'Home (no address kept here)' },
  { id: 'other', name: 'Somewhere else' },
];
// How the patient travels. A starting list worded for any system (one country's published
// categories were the starting point: walker, wheelchair, stretcher, two crew, complex); a site
// sets its own. The ward picks it; Ospeli records the pick and decides nothing.
export const MOBILITY = [
  { id: 'walks', name: 'Walks (may need a hand)' },
  { id: 'wheelchair', name: 'Wheelchair' },
  { id: 'stretcher', name: 'Stretcher' },
  { id: 'two-crew', name: 'Needs two crew to move' },
  { id: 'special', name: 'Special handling: agree with the coordinator' },
];
// Who travels with the patient, as the ward set it. Ospeli never sets an escort level.
export const ESCORT = [
  { id: 'none', name: 'No escort' },
  { id: 'carer', name: 'Relative or carer' },
  { id: 'nurse', name: 'Nurse or nursing assistant' },
  { id: 'clinician', name: 'Doctor or other clinician' },
];
export const EQUIPMENT = [
  { id: 'none', name: 'No equipment' },
  { id: 'oxygen', name: 'Oxygen' },
  { id: 'pump', name: 'Infusion pump' },
  { id: 'wide', name: 'Extra-wide chair or stretcher' },
  { id: 'aids', name: 'Own wheelchair or walking aid' },
  { id: 'belongings', name: 'Large belongings' },
];
// Reasons for a delay or a cancellation. Each is on one side: the transport service's, or the
// requester's (the ward, the paperwork or the place receiving the patient). On-time pickup leaves
// the requester's side out and counts the transport side as not on time. "Other" counts as the
// transport side, so it cannot hide a transport delay.
export const REASONS = [
  { id: 'no-vehicle', name: 'No vehicle free', side: 'transport' },
  { id: 'no-escort', name: 'No escort', side: 'transport' },
  { id: 'no-crew', name: 'No crew', side: 'transport' },
  { id: 'vehicle-fault', name: 'Vehicle fault', side: 'transport' },
  { id: 'patient-not-ready', name: 'Patient not ready', side: 'requester' },
  { id: 'paperwork-not-ready', name: 'Paperwork not ready', side: 'requester' },
  { id: 'destination-not-ready', name: 'Destination not ready', side: 'requester' },
  { id: 'other', name: 'Other', side: 'transport' },
];
export const CANCEL_REASONS = [...REASONS, { id: 'not-needed', name: 'No longer needed', side: 'requester' }];
// The daily vehicle check: an example set, set locally, not a standard. A site uses its own
// vehicle check policy (ISO 39001 is a frame a site may run; Ospeli does not apply it).
export const CHECK_ITEMS = [
  { id: 'tyres', name: 'Tyres and wheels' },
  { id: 'lights', name: 'Lights and indicators' },
  { id: 'brakes', name: 'Brakes' },
  { id: 'fuel', name: 'Fuel or charge, and fluid levels' },
  { id: 'body', name: 'Bodywork, mirrors and windows' },
  { id: 'lift', name: 'Patient lift or ramp' },
  { id: 'fixings', name: 'Seat belts, stretcher and wheelchair fixings' },
  { id: 'kit', name: 'Fire extinguisher and first-aid kit' },
  { id: 'clean', name: 'Clean inside' },
];
export const CHECK_NOTE = 'The check list is an example set, set locally, not a standard. Your site uses its own vehicle check policy.';
// The defect type a failed item suggests for a work order (core/workorders.js, kind vehicle).
export const DEFECT_FOR = { tyres: 'Tyre or wheel damage', lift: 'Patient lift or ramp not working' };
export const DEFECT_DEFAULT = 'Defect found at the daily vehicle check';
export const OFF_ROAD_REASONS = [
  { id: 'failed-check', name: 'Failed its daily check' },
  { id: 'fault', name: 'Fault or damage' },
  { id: 'service', name: 'Planned service' },
  { id: 'other', name: 'Other' },
];
export const BACK_REASONS = [
  { id: 'repaired', name: 'Repaired' },
  { id: 'service-done', name: 'Service done' },
  { id: 'checked-safe', name: 'Checked and safe' },
  { id: 'other', name: 'Other' },
];
export const STEPS = [
  { id: 'arrived-pickup', label: 'Arrived at pickup', state: 'at-pickup' },
  { id: 'departed', label: 'Departed', state: 'on-the-way' },
  { id: 'arrived-destination', label: 'Arrived at destination', state: 'at-destination' },
  { id: 'handed-over', label: 'Handed over', state: 'handed-over' },
];
export const STATE_NAMES = {
  waiting: 'Waiting for a vehicle', assigned: 'Vehicle given', 'at-pickup': 'At pickup', 'on-the-way': 'On the way',
  'at-destination': 'At destination', 'handed-over': 'Handed over', cancelled: 'Cancelled',
};
export const OPEN_STATES = ['waiting', 'assigned', 'at-pickup', 'on-the-way', 'at-destination'];
export const UNDER_WAY = ['at-pickup', 'on-the-way', 'at-destination'];
const nameMap = (list) => Object.fromEntries(list.map((x) => [x.id, x.name]));
export const TYPE_NAME = nameMap(TYPES);
export const OUTSIDE_NAME = nameMap(OUTSIDE);
export const MOBILITY_NAME = nameMap(MOBILITY);
export const ESCORT_NAME = nameMap(ESCORT);
export const EQUIPMENT_NAME = nameMap(EQUIPMENT);
export const REASON = Object.fromEntries(CANCEL_REASONS.map((x) => [x.id, x]));
export const CHECK_NAME = nameMap(CHECK_ITEMS);
export const OFF_ROAD_NAME = nameMap(OFF_ROAD_REASONS);
export const BACK_NAME = nameMap(BACK_REASONS);

// ---- example settings, not a standard (each site sets its own) ----
export const ON_TIME_WINDOW = 15; // minutes after the booked time a pickup still counts as on time
export const SCHEDULED = { startHour: 7, endHour: 19 }; // each vehicle's scheduled hours a day, site time
export const SHIFTS = [{ id: 'shift-day', name: 'Day shift', start: '07:00', end: '19:00' }, { id: 'shift-night', name: 'Night shift', start: '19:00', end: '07:00' }];
export const EARLIER_MINUTES = 60; // guide rule 1: a discharge booked this much later than now while beds are needed
export const GROUP_MINUTES = 60; // guide rule 1: two journeys to the same place needed this close together
export const ESCORT_LOOKBACK_DAYS = 14; // guide rule 3
export const ESCORT_COUNT = 3; // guide rule 3: this many no-escort delays in one time band
export const BANDS = [
  { id: 'early', name: '07:00 to 11:00', from: 7, to: 11 }, { id: 'midday', name: '11:00 to 15:00', from: 11, to: 15 },
  { id: 'late', name: '15:00 to 19:00', from: 15, to: 19 }, { id: 'night', name: '19:00 to 07:00', from: 19, to: 7 },
];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// ---- site time (a fixed offset from UTC, from the example site's own setting) ----
const localMs = (ms, offsetMinutes) => ms + offsetMinutes * MIN;
export const localHour = (iso, offsetMinutes) => new Date(localMs(Date.parse(iso), offsetMinutes)).getUTCHours();
export function clockText(iso, offsetMinutes) {
  const d = new Date(localMs(Date.parse(iso), offsetMinutes));
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}
const dayStartLocal = (ms, offsetMinutes) => { const l = localMs(ms, offsetMinutes); return l - (((l % DAY) + DAY) % DAY); };
// "today 16:30", "tomorrow 09:00", "yesterday 18:10", or "Mon 3 Nov 08:00".
export function whenText(iso, nowIso, offsetMinutes) {
  const days = Math.round((dayStartLocal(Date.parse(iso), offsetMinutes) - dayStartLocal(Date.parse(nowIso), offsetMinutes)) / DAY);
  const word = days === 0 ? 'today' : days === 1 ? 'tomorrow' : days === -1 ? 'yesterday' : new Date(localMs(Date.parse(iso), offsetMinutes)).toISOString().slice(0, 10);
  return `${word} ${clockText(iso, offsetMinutes)}`;
}
// The shift a moment falls in: { id, name, start (ISO), end (ISO) }.
export function shiftAt(nowIso, offsetMinutes, shifts = SHIFTS) {
  const day = shifts.find((s) => s.id === 'shift-day') || SHIFTS[0];
  const [sh, sm] = String(day.start).split(':').map(Number);
  const [eh, em] = String(day.end).split(':').map(Number);
  const now = Date.parse(nowIso);
  const d0 = dayStartLocal(now, offsetMinutes) - offsetMinutes * MIN; // this local day's midnight, in UTC ms
  const dayStart = d0 + (sh * 60 + sm) * MIN; const dayEnd = d0 + (eh * 60 + em) * MIN;
  const night = shifts.find((s) => s.id === 'shift-night') || SHIFTS[1];
  const iso = (ms) => new Date(ms).toISOString();
  if (now >= dayStart && now < dayEnd) return { id: day.id, name: day.name, start: iso(dayStart), end: iso(dayEnd) };
  if (now >= dayEnd) return { id: night.id, name: night.name, start: iso(dayEnd), end: iso(dayStart + DAY) };
  return { id: night.id, name: night.name, start: iso(dayEnd - DAY), end: iso(dayStart) };
}
// Times a booked journey can be picked for: every half hour for the next day, in site time.
export function bookingSlots(nowIso, offsetMinutes, hours = 24) {
  const step = 30 * MIN;
  const first = Math.ceil((Date.parse(nowIso) + 15 * MIN) / step) * step;
  const out = [];
  for (let t = first; t < Date.parse(nowIso) + hours * HOUR; t += step) {
    const at = new Date(t).toISOString();
    out.push({ at, label: whenText(at, nowIso, offsetMinutes).replace(/^./, (c) => c.toUpperCase()) });
  }
  return out;
}

// ---- records, derived from transfers.* events ----
const TRF_ID = /^trf-(\d{5,})$/;
export function nextTransferId(events) {
  let max = 0;
  for (const e of events) {
    const m = e.type === 'transfers.requested' ? TRF_ID.exec(e.subject) : null;
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `trf-${String(max + 1).padStart(5, '0')}`;
}
// The time a journey is needed: its booked time, or when an as-soon-as-possible request was made.
export const neededAt = (t) => (t.needed === 'booked' ? t.bookedFor : t.requestedAt);
const byNeed = (a, b) => (neededAt(a) < neededAt(b) ? -1 : neededAt(a) > neededAt(b) ? 1 : a.id < b.id ? -1 : 1);

// Map(id -> transfer). Anything that does not fit the fixed lists (an edited import) is left out,
// and a step is only taken in its order, so a record is always one of the states above.
export function deriveTransfers(events) {
  const all = new Map();
  for (const e of events) {
    if (!e.type.startsWith('transfers.')) continue;
    const d = e.data || {};
    if (e.type === 'transfers.requested') {
      if (!TRF_ID.test(e.subject) || all.has(e.subject) || !TYPE_NAME[d.type] || !MOBILITY_NAME[d.mobility] || !ESCORT_NAME[d.escort]) continue;
      if (!d.fromPlace || (!d.toSite && !OUTSIDE_NAME[d.toOutside])) continue;
      if (!['asap', 'booked'].includes(d.needed) || (d.needed === 'booked' && Number.isNaN(Date.parse(d.bookedFor)))) continue;
      // bookedFor is kept in one spelling of the moment: times here are compared as text (19 Nov).
      all.set(e.subject, {
        id: e.subject, requestedAt: e.at, byRole: e.actorRole, type: d.type, fromPlace: d.fromPlace, toSite: d.toSite || null, toOutside: d.toSite ? null : d.toOutside,
        needed: d.needed, bookedFor: d.needed === 'booked' ? new Date(Date.parse(d.bookedFor)).toISOString() : null, mobility: d.mobility, escort: d.escort,
        equipment: (Array.isArray(d.equipment) ? d.equipment : []).filter((x) => EQUIPMENT_NAME[x]), bayMove: d.bayMove === true,
        state: 'waiting', vehicleId: null, assignedAt: null, steps: {}, delays: [], cancelledAt: null, cancelReason: null, cancelRole: null,
      });
      continue;
    }
    const t = all.get(e.subject);
    if (!t || t.state === 'cancelled' || t.state === 'handed-over') continue;
    if (e.type === 'transfers.assigned') {
      if ((t.state === 'waiting' || t.state === 'assigned') && typeof d.vehicle === 'string') { t.vehicleId = d.vehicle; t.assignedAt = e.at; t.state = 'assigned'; }
    } else if (e.type === 'transfers.delayed') {
      if (REASON[d.reason] && d.reason !== 'not-needed') t.delays.push({ at: e.at, reason: d.reason, byRole: e.actorRole });
    } else if (e.type === 'transfers.cancelled') {
      if (REASON[d.reason] && !['on-the-way', 'at-destination'].includes(t.state)) { t.state = 'cancelled'; t.cancelledAt = e.at; t.cancelReason = d.reason; t.cancelRole = e.actorRole; }
    } else {
      const i = STEPS.findIndex((s) => `transfers.${s.id}` === e.type);
      if (i < 0 || !t.vehicleId) continue;
      if (nextStep(t)?.id !== STEPS[i].id) continue;
      t.steps[STEPS[i].id] = e.at;
      t.state = STEPS[i].state;
    }
  }
  return all;
}
export function nextStep(t) {
  if (!t.vehicleId || t.state === 'cancelled' || t.state === 'handed-over') return null;
  return STEPS.find((s) => !t.steps[s.id]) || null;
}
// The waiting queue: the time each is needed, earliest first.
export const queueOf = (transfers) => [...transfers.values()].filter((t) => t.state === 'waiting').sort(byNeed);
// One vehicle's jobs: the one under way first, then the rest in the order they are needed.
export function jobsOf(transfers, vehicleId) {
  const mine = [...transfers.values()].filter((t) => t.vehicleId === vehicleId && OPEN_STATES.includes(t.state) && t.state !== 'waiting');
  return [...mine.filter((t) => UNDER_WAY.includes(t.state)).sort(byNeed), ...mine.filter((t) => t.state === 'assigned').sort(byNeed)];
}

// ---- vehicles: out of service, checks and crewing, from the events ----
// vehicles: [{ id, name, parentId }] (assets of kind vehicle). Returns Map(id -> vehicle state).
export function deriveFleet(events, vehicles, { now, shift }) {
  const out = new Map(vehicles.map((v) => [v.id, { id: v.id, name: v.name, siteId: v.parentId, offRoad: null, offRoadSpans: [], lastCheck: null, lastStatusAt: null, crewSpans: [], crewed: false }]));
  for (const e of events) {
    const v = out.get(e.subject);
    if (!v || !e.type.startsWith('transfers.vehicle-')) continue;
    const d = e.data || {};
    if (e.type === 'transfers.vehicle-off-road' && !v.offRoad && OFF_ROAD_NAME[d.reason]) { v.offRoad = { since: e.at, reason: d.reason }; v.lastStatusAt = e.at; }
    else if (e.type === 'transfers.vehicle-back' && v.offRoad) { v.offRoadSpans.push([v.offRoad.since, e.at, v.offRoad.reason]); v.offRoad = null; v.lastStatusAt = e.at; }
    else if (e.type === 'transfers.vehicle-checked') {
      const pick = (l) => [...new Set((Array.isArray(l) ? l : []).filter((x) => CHECK_NAME[x]))];
      const failed = pick(d.failed); const passed = pick(d.passed).filter((x) => !failed.includes(x));
      if (passed.length + failed.length) v.lastCheck = { at: e.at, passed, failed, byRole: e.actorRole };
    } else if (e.type === 'transfers.vehicle-crewed' && typeof d.shiftStart === 'string') {
      if (!v.crewSpans.some((s) => s.shiftStart === d.shiftStart && !s.until)) v.crewSpans.push({ shiftStart: d.shiftStart, shiftEnd: d.shiftEnd || null, from: e.at, until: null });
    } else if (e.type === 'transfers.vehicle-uncrewed') {
      const s = v.crewSpans.find((x) => x.shiftStart === d.shiftStart && !x.until);
      if (s) s.until = e.at;
    }
  }
  for (const v of out.values()) {
    if (v.offRoad) v.offRoadSpans.push([v.offRoad.since, null, v.offRoad.reason]);
    v.crewed = !!shift && v.crewSpans.some((s) => s.shiftStart === shift.start && !s.until && now < shift.end);
  }
  return out;
}
// The vehicle as a coordinator sees it: out of service, on a job, or free; crewed or not.
export function vehicleState(v, transfers) {
  const jobs = jobsOf(transfers, v.id);
  const current = jobs.find((t) => UNDER_WAY.includes(t.state)) || null;
  return { state: v.offRoad ? 'off-road' : current ? 'on-job' : 'free', current, assigned: jobs.filter((t) => t.state === 'assigned'), jobs };
}
// A failed check stands until the vehicle is next taken out of service or brought back.
export const checkFailing = (v) => !!v.lastCheck?.failed.length && (!v.lastStatusAt || v.lastStatusAt < v.lastCheck.at);

// ---- KPIs: each (transfers or events, { since, until, ... }) -> { value, numerator, denominator, n, ... } ----
const inPeriod = (at, since, until) => !!at && at < until && (since == null || at >= since);
// Never below zero: a device clock set back between two taps must not give a negative wait.
const mins = (a, b) => Math.max(0, (Date.parse(b) - Date.parse(a)) / MIN);
// The 90th percentile by the nearest-rank method: the value at rank ceil(0.9 n) when sorted.
export const p90 = (xs) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.ceil(0.9 * s.length) - 1]; };
const timeStat = (xs) => ({ value: median(xs), p90: p90(xs), n: xs.length });

// 1. Transfer wait: requested -> departed from pickup, for as-soon-as-possible requests that
// departed in the period; median and p90 minutes, in all and by request type. Booked journeys are
// on-time pickup's, not here. Cancelled journeys never depart, so they are left out.
export function transferWait(transfers, { since, until }) {
  const list = [...transfers.values()].filter((t) => t.needed === 'asap' && inPeriod(t.steps.departed, since, until));
  const all = timeStat(list.map((t) => mins(t.requestedAt, t.steps.departed)));
  return { ...all, numerator: null, denominator: all.n,
    breakdown: TYPES.map((x) => ({ id: x.id, name: x.name, ...timeStat(list.filter((t) => t.type === x.id).map((t) => mins(t.requestedAt, t.steps.departed))) })) };
}

// 2. On-time pickup: booked journeys whose vehicle arrived at pickup no later than the window after
// their booked time / booked journeys due (booked time) in the period. Arrival is the transport
// service's part; departure also waits on the patient and the ward. Left out: a journey delayed or
// cancelled for a requester's reason, and one not yet arrived whose window has not closed. Counted
// as not on time: delayed or cancelled for a transport reason, arrived late, or not arrived when
// its window closed.
export function onTimePickup(transfers, { since, until, windowMinutes = ON_TIME_WINDOW }) {
  let on = 0; let due = 0; let leftOut = 0; let pending = 0; let transportSide = 0;
  for (const t of transfers.values()) {
    if (t.needed !== 'booked' || !inPeriod(t.bookedFor, since, until)) continue;
    const reasons = [...t.delays.map((d) => d.reason), ...(t.state === 'cancelled' ? [t.cancelReason] : [])];
    if (reasons.some((r) => REASON[r]?.side === 'requester')) { leftOut += 1; continue; }
    const closes = Date.parse(t.bookedFor) + windowMinutes * MIN;
    if (reasons.some((r) => REASON[r]?.side === 'transport')) { due += 1; transportSide += 1; continue; }
    const arrived = t.steps['arrived-pickup'];
    if (arrived && Date.parse(arrived) <= closes) { due += 1; on += 1; continue; }
    if (arrived || Date.parse(until) >= closes) { due += 1; continue; }
    pending += 1;
  }
  return { value: due ? (100 * on) / due : null, numerator: on, denominator: due, n: due, leftOut, pending, transportSide };
}

// 3. Handover time at destination: arrived at destination -> handed over, median and p90 minutes,
// journeys handed over in the period.
export function handoverTime(transfers, { since, until }) {
  const xs = [...transfers.values()].filter((t) => inPeriod(t.steps['handed-over'], since, until) && t.steps['arrived-destination']).map((t) => mins(t.steps['arrived-destination'], t.steps['handed-over']));
  return { ...timeStat(xs), numerator: null, denominator: xs.length };
}

// 4. Fleet availability: in-service vehicle-hours / scheduled vehicle-hours in the period, in all
// and by site. Scheduled hours are an example setting (07:00 to 19:00 site time, every day).
// Crewed vehicle-hours inside the scheduled hours are given beside it, not folded into it.
const overlap = (a0, a1, b0, b1) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
function scheduledWindows(sinceMs, untilMs, offsetMinutes) {
  const out = [];
  for (let d = dayStartLocal(sinceMs, offsetMinutes) - offsetMinutes * MIN - DAY; d < untilMs; d += DAY) {
    const a = Math.max(sinceMs, d + SCHEDULED.startHour * HOUR); const b = Math.min(untilMs, d + SCHEDULED.endHour * HOUR);
    if (b > a) out.push([a, b]);
  }
  return out;
}
export function fleetAvailability(fleet, { since, until, offsetMinutes = 0, siteName = (id) => id }) {
  const s = Date.parse(since); const u = Date.parse(until);
  const windows = scheduledWindows(s, u, offsetMinutes);
  const per = [...fleet.values()].map((v) => {
    const scheduled = windows.reduce((sum, [a, b]) => sum + (b - a), 0);
    const off = v.offRoadSpans.reduce((sum, [from, to]) => sum + windows.reduce((x, [a, b]) => x + overlap(a, b, Date.parse(from), to ? Date.parse(to) : u), 0), 0);
    const crewed = v.crewSpans.reduce((sum, c) => {
      const end = c.until ? Date.parse(c.until) : c.shiftEnd ? Math.min(Date.parse(c.shiftEnd), u) : u;
      return sum + windows.reduce((x, [a, b]) => x + overlap(a, b, Date.parse(c.from), end), 0);
    }, 0);
    return { id: v.id, siteId: v.siteId, scheduled: scheduled / HOUR, inService: (scheduled - off) / HOUR, crewed: crewed / HOUR };
  });
  const sum = (list, k) => list.reduce((x, v) => x + v[k], 0);
  const pct = (list) => (sum(list, 'scheduled') ? (100 * sum(list, 'inService')) / sum(list, 'scheduled') : null);
  const sites = [...new Set(per.map((v) => v.siteId))];
  return {
    value: pct(per), numerator: sum(per, 'inService'), denominator: sum(per, 'scheduled'), n: per.length,
    crewedHours: sum(per, 'crewed'),
    breakdown: sites.map((id) => { const l = per.filter((v) => v.siteId === id); return { id, name: siteName(id), value: pct(l), numerator: sum(l, 'inService'), denominator: sum(l, 'scheduled'), n: l.length }; }),
  };
}

// ---- guide rules: fixed, checkable rules. A rule suggests; a person decides. ----
export const GUIDE_RULES = [
  { id: 'discharge-later', name: 'A discharge waits while beds are needed',
    basis: `Example setting, not a standard: a fixed rule. A discharge booked more than ${EARLIER_MINUTES} minutes from now, from a ward where the bed board shows patients waiting for a bed, is pointed out with a free crewed vehicle if there is one, and another journey to the same place needed within ${GROUP_MINUTES} minutes of it. Advice only: the ward and the coordinator decide.` },
  { id: 'check-failed', name: 'A vehicle failed its daily check',
    basis: 'The site\'s own vehicle check policy (set locally); the check list here is an example set. ISO 39001 is a road safety management frame a site may run; Ospeli does not apply it. The rule suggests taking the vehicle out of service and offers a fault report that a person sends, with a priority the person picks.' },
  { id: 'escort-cover', name: 'Delays for no escort keep happening at one time of day',
    basis: `Example setting, not a standard: ${ESCORT_COUNT} or more delays or cancellations for "No escort" in the last ${ESCORT_LOOKBACK_DAYS} days in the same time band. Advice only; it shows when, never who.` },
];
const BASIS = Object.fromEntries(GUIDE_RULES.map((r) => [r.id, r.basis]));
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// Rule 1. waitingByWard: Map(wardId -> patients waiting for a bed there, with no bed held), from
// deriveBoard (core/beds.js). freeVehicles: [{ id, name }] free, crewed and in service now.
export function ruleDischargeLater({ transfers, waitingByWard, freeVehicles, now, offsetMinutes, placeName, destName }) {
  const open = [...transfers.values()].filter((t) => ['waiting', 'assigned'].includes(t.state));
  const out = [];
  for (const t of open) {
    if (t.type !== 'discharge' || t.needed !== 'booked') continue;
    const patients = waitingByWard.get(t.fromPlace) || 0;
    if (!patients || Date.parse(t.bookedFor) - Date.parse(now) <= EARLIER_MINUTES * MIN) continue;
    const dest = destName(t);
    const group = open.filter((x) => x.id !== t.id && (x.toSite || x.toOutside) === (t.toSite || t.toOutside) && Math.abs(Date.parse(neededAt(x)) - Date.parse(t.bookedFor)) <= GROUP_MINUTES * MIN);
    const ward = placeName(t.fromPlace);
    const free = freeVehicles[0];
    out.push({
      rule: 'discharge-later', id: `discharge-later:${t.id}`, transferId: t.id,
      text: `Discharge from ${ward} is booked for ${whenText(t.bookedFor, now, offsetMinutes)}, while ${plural(patients, 'patient waits', 'patients wait')} for a bed there.`,
      why: [free ? `${free.name} is free and crewed now: ask the ward whether the patient can go earlier.` : 'No crewed vehicle is free right now.',
        group.length ? `${group.map((x) => x.id).join(', ')} also ${group.length === 1 ? 'goes' : 'go'} to ${dest} near that time: one journey might take both, if mobility and escort allow.` : null].filter(Boolean).join(' '),
      basis: BASIS['discharge-later'], action: null,
    });
  }
  return out;
}

// Rule 2. fleet: from deriveFleet; openFaults: Map(vehicleId -> [fault titles with an open work order]).
export function ruleCheckFailed({ fleet, openFaults = new Map() }) {
  const out = [];
  for (const v of fleet.values()) {
    if (!checkFailing(v)) continue;
    const items = v.lastCheck.failed.map((x) => CHECK_NAME[x]);
    const fault = v.lastCheck.failed.map((x) => DEFECT_FOR[x]).find(Boolean) || DEFECT_DEFAULT;
    const open = openFaults.get(v.id) || [];
    const actions = [];
    if (!v.offRoad) actions.push({ label: 'Take out of service', command: 'ospeli_transfers_vehicle_status', input: { vehicleId: v.id, status: 'off-road', reason: 'failed-check' } });
    if (!open.includes(fault)) actions.push({ label: 'Report a fault', command: 'ospeli_workorders_report_fault', input: { assetId: v.id, fault }, needs: 'priority' });
    out.push({
      rule: 'check-failed', id: `check-failed:${v.id}:${v.lastCheck.at}`, vehicleId: v.id,
      text: `${v.name} failed its daily check: ${items.join('; ')}.${v.offRoad ? '' : ' Take it out of service until it is fixed.'}`,
      why: `${v.offRoad ? `${v.name} is out of service. ` : ''}${open.length ? `A work order is already open: ${open.join('; ')}.` : 'No work order is open for it yet.'}`,
      basis: BASIS['check-failed'], actions, action: actions[0] || null,
    });
  }
  return out;
}

// Rule 3. Delays and cancellations for no escort in the last 14 days, by time band.
const bandOf = (hour) => BANDS.find((b) => (b.from < b.to ? hour >= b.from && hour < b.to : hour >= b.from || hour < b.to));
export function ruleEscortCover({ transfers, now, offsetMinutes }) {
  const since = Date.parse(now) - ESCORT_LOOKBACK_DAYS * DAY;
  const hits = [];
  for (const t of transfers.values()) {
    for (const d of t.delays) if (d.reason === 'no-escort' && Date.parse(d.at) >= since && d.at <= now) hits.push({ at: d.at, id: t.id });
    if (t.cancelReason === 'no-escort' && Date.parse(t.cancelledAt) >= since && t.cancelledAt <= now) hits.push({ at: t.cancelledAt, id: t.id });
  }
  const out = [];
  for (const b of BANDS) {
    // Journeys, not events: one journey held up three times and then cancelled is one journey (19 Nov).
    const seen = new Set();
    const mine = hits.filter((x) => bandOf(localHour(x.at, offsetMinutes)) === b).sort((x, y) => (x.at < y.at ? -1 : 1))
      .filter((x) => !seen.has(x.id) && seen.add(x.id)).map((x) => x.at);
    if (mine.length < ESCORT_COUNT) continue;
    const byHour = new Map(); const byDay = new Map();
    for (const at of mine) {
      const hr = localHour(at, offsetMinutes);
      byHour.set(hr, (byHour.get(hr) || 0) + 1);
      const wd = WEEKDAYS[new Date(Date.parse(at) + offsetMinutes * MIN).getUTCDay()];
      byDay.set(wd, (byDay.get(wd) || 0) + 1);
    }
    const hours = [...byHour].sort((a, b) => a[0] - b[0]).map(([hr, n]) => ({ hour: `${String(hr).padStart(2, '0')}:00`, n }));
    const days = WEEKDAYS.filter((d) => byDay.has(d)).map((d) => ({ day: d, n: byDay.get(d) }));
    out.push({
      rule: 'escort-cover', id: `escort-cover:${b.id}`, band: b.id,
      text: `Review escort cover from ${b.name}: ${mine.length} journeys were held up for no escort in that band in the last ${ESCORT_LOOKBACK_DAYS} days.`,
      why: `By hour: ${hours.map((x) => `${x.hour} (${x.n})`).join(', ')}. By day: ${days.map((x) => `${x.day} (${x.n})`).join(', ')}. When it happens, never who.`,
      pattern: { byHour: hours, byDay: days }, basis: BASIS['escort-cover'], action: null,
    });
  }
  return out;
}

// The guide is on until a person switches it off (transfers.guide-set, a people-only command).
export function guideOn(events) {
  let on = true;
  for (const e of events) if (e.type === 'transfers.guide-set' && typeof e.data?.on === 'boolean') on = e.data.on;
  return on;
}
