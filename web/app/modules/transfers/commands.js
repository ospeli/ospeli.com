// Transfers and vehicles: the module's pack (see core/modules.js for the contract).
// Plain data and pure functions; no screen code, so the same file runs in the browser, in tests
// and on a site's own server.
//
// A journey in a vehicle keeps its own record (trf-00001, transfers.* events), not the shared task
// object: a journey has a time needed, four timed steps and a vehicle. Moves on foot inside a site
// are Cleaning and transport's (team `transport`); this module never times one.
// Every action is a pick: no typed text anywhere, so no clinical note and no personal detail can
// go in. Every event records the role, never a person. Nothing here calls a model.

import {
  CommandError, ALL_ROLES, ID, TIME, SYNTHETIC, LIMIT, TOTAL, TRUNCATED, FORMAT, page, WRITE_STATUS, PROPOSAL_OUT, EVENT_SEQS,
  isSynthetic, sameMoment, wardOfPlace, DAY, HOUR, MIN,
} from '../../core/kit.js';
import { currentWords } from '../../core/model.js';
import { deriveBoard } from '../../core/beds.js';
import { deriveWorkOrders } from '../../core/workorders.js';
import {
  TYPES, OUTSIDE, MOBILITY, ESCORT, EQUIPMENT, REASONS, CANCEL_REASONS, CHECK_ITEMS, CHECK_NOTE, OFF_ROAD_REASONS, BACK_REASONS, STEPS, STATE_NAMES,
  OPEN_STATES, UNDER_WAY, TYPE_NAME, OUTSIDE_NAME, MOBILITY_NAME, ESCORT_NAME, EQUIPMENT_NAME, REASON, CHECK_NAME, OFF_ROAD_NAME, BACK_NAME,
  ON_TIME_WINDOW, SCHEDULED, SHIFTS, GUIDE_RULES, deriveTransfers, nextTransferId, nextStep, queueOf, jobsOf, deriveFleet, vehicleState, checkFailing,
  neededAt, whenText, shiftAt, bookingSlots, transferWait, onTimePickup, handoverTime, fleetAvailability, guideOn,
  ruleDischargeLater, ruleCheckFailed, ruleEscortCover,
} from './logic.js';

export const id = 'transfers';
export const PREFIX = 'ospeli_transfers_';
export const EVENT_PREFIX = 'transfers.';

// Every number has a definition and a source. Targets are example settings unless a cited source sets one.
export const KPIS = [
  { id: 'transfer-wait', name: 'Transfer wait', unit: 'minutes',
    definition: 'Minutes from a transfer being asked for to the vehicle departing from pickup, for "as soon as possible" requests that departed in the period: the median and the 90th percentile (nearest rank), in all and by request type.',
    counts: 'As-soon-as-possible journeys that departed from pickup in the period.', outOf: 'None (a median).',
    leavesOut: 'Booked journeys (measured by on-time pickup instead, so a journey booked a day ahead does not look like a long wait); cancelled journeys; journeys not departed yet.',
    source: 'local definition', target: null, targetText: 'No target set: track the trend.' },
  { id: 'on-time-pickup', name: 'On-time pickup', unit: '%',
    definition: `Booked journeys whose vehicle arrived at pickup no later than ${ON_TIME_WINDOW} minutes after the booked time, divided by booked journeys due in the period. Arrival at pickup is measured, not departure: departure also waits on the patient and the ward.`,
    counts: `Booked journeys whose vehicle arrived at pickup within ${ON_TIME_WINDOW} minutes of the booked time, or before it (the window is an example setting, not a standard).`,
    outOf: 'Booked journeys whose booked time is in the period. A journey delayed or cancelled for a transport reason (no vehicle, no escort, no crew, vehicle fault, other) counts as not on time; so does one whose vehicle had not arrived when its window closed.',
    leavesOut: 'Journeys delayed or cancelled for the requester\'s reason (patient, paperwork or destination not ready, no longer needed), and journeys whose window has not closed yet. Only a delay or cancellation recorded before the vehicle arrived at pickup (or, with no arrival, before the window closed) is read: one recorded later is about the rest of the journey.',
    source: 'local definition', target: null, targetText: 'No target set: track the trend.' },
  { id: 'handover-time', name: 'Handover time at destination', unit: 'minutes',
    definition: 'Minutes from the vehicle arriving at the destination to the handover being done: the median and the 90th percentile (nearest rank).',
    counts: 'Journeys handed over in the period.', outOf: 'None (a median).', leavesOut: 'Journeys not handed over yet.',
    source: 'local definition (published definitions of handover delay vary widely: Fouche PF et al., Emerg Med J 2026, PMID 42242732)',
    target: null, targetText: 'No target set: track the trend.' },
  { id: 'fleet-availability', name: 'Fleet availability', unit: '%',
    definition: `In-service vehicle-hours divided by scheduled vehicle-hours in the period, in all and by site. Out-of-service time runs between the vehicle being taken out of service and being back in service. Scheduled hours: ${String(SCHEDULED.startHour).padStart(2, '0')}:00 to ${SCHEDULED.endHour}:00 site time every day for each vehicle (an example setting, not a standard).`,
    counts: 'Scheduled vehicle-hours the vehicle was not out of service.', outOf: 'Scheduled vehicle-hours.',
    leavesOut: 'Hours outside the scheduled hours. Crewed vehicle-hours are shown beside it as their own figure, not folded in.',
    source: 'local definition (the shared availability measure, applied to vehicles)', target: null, targetText: 'No target set: track the trend.' },
];
const PLANNED = [{ id: 'servicing-plan', name: 'Servicing plan', status: 'planned', note: 'Planned, not built yet.' }];
const NOT_FOR = 'Not for emergency calls or emergency dispatch: those stay in the dispatch system. Does not set urgency, mobility or escort level (the ward does; Ospeli records the pick). Holds no clinical notes, patient names, addresses or contact details. Does not track where people are, and does not time, score or rank drivers or crews. Not route planning or billing.';

// ---- the site: places, vehicles, site time ----
async function world(core) {
  const all = await core.listEntities();
  const map = new Map(all.map((e) => [e.id, e]));
  const offsetMinutes = all.find((e) => e.type === 'site' && e.utcOffsetMinutes != null)?.utcOffsetMinutes ?? 0;
  const shifts = all.filter((e) => e.type === 'shift' && /^\d\d:\d\d$/.test(e.start || '')).map((s) => ({ id: s.id, name: s.name, start: s.start, end: s.end }));
  const vehicles = all.filter((e) => e.type === 'asset' && e.kind === 'vehicle').sort((a, b) => (a.id < b.id ? -1 : 1));
  const siteOf = (id) => { let p = map.get(id); for (let i = 0; p && p.type !== 'site' && i < 8; i++) p = map.get(p.parentId); return p?.type === 'site' ? p : null; };
  // An id that is not on this site is never answered as its own name (#138).
  const name = (id, gone = 'a place no longer on this site') => (map.has(id) ? currentWords(map.get(id).name) : gone);
  // Nor is it answered as an id: an imported id-shaped sentence never reaches a reader as one (#138).
  const idOf = (id) => (map.has(id) ? id : null);
  return { all, map, offsetMinutes, shifts: shifts.length ? shifts : SHIFTS, vehicles, siteOf, name, idOf,
    sites: all.filter((e) => e.type === 'site'), wards: all.filter((e) => e.type === 'ward'), departments: all.filter((e) => e.type === 'department'), beds: all.filter((e) => e.type === 'bed') };
}
const wardOfId = (w, placeId) => (w.map.get(placeId)?.type === 'ward' ? placeId : null);
// An agent sees journeys from the wards it is allowed on (`wards`), and nothing else; a person sees all.
const visible = (w, wards) => (t) => !wards || wards.has(wardOfId(w, t.fromPlace));
const destName = (w) => (t) => (t.toSite ? w.name(t.toSite) : OUTSIDE_NAME[t.toOutside]);
const minsBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / MIN);

function transferOut(t, w, now, fleetMap) {
  const step = nextStep(t);
  const site = w.siteOf(t.fromPlace);
  const late = t.needed === 'booked' ? !t.steps['arrived-pickup'] && Date.parse(now) > Date.parse(t.bookedFor) + ON_TIME_WINDOW * MIN : false;
  const v = t.vehicleId ? fleetMap?.get(t.vehicleId) : null;
  return {
    id: t.id, type: t.type, typeName: TYPE_NAME[t.type], state: t.state, stateName: STATE_NAMES[t.state],
    pickup: { id: w.idOf(t.fromPlace), name: w.name(t.fromPlace), siteName: site ? currentWords(site.name) : null },
    destination: t.toSite ? { kind: 'site', id: w.idOf(t.toSite), name: w.name(t.toSite) } : { kind: 'outside', id: t.toOutside, name: OUTSIDE_NAME[t.toOutside] },
    needed: t.needed, bookedFor: t.bookedFor, neededText: t.needed === 'booked' ? `Booked for ${whenText(t.bookedFor, now, w.offsetMinutes)}` : 'As soon as possible',
    requestedAt: t.requestedAt, waitMinutes: Math.max(0, minsBetween(t.requestedAt, t.steps.departed || now)),
    minutesToBooked: t.needed === 'booked' ? minsBetween(now, t.bookedFor) : null, late,
    mobility: t.mobility, mobilityName: MOBILITY_NAME[t.mobility], escort: t.escort, escortName: ESCORT_NAME[t.escort],
    equipment: t.equipment.map((x) => ({ id: x, name: EQUIPMENT_NAME[x] })), bayMove: t.bayMove,
    vehicleId: t.vehicleId ? w.idOf(t.vehicleId) : null, vehicleName: t.vehicleId ? w.name(t.vehicleId, 'a vehicle no longer on this site') : null, vehicleOffRoad: !!v?.offRoad,
    nextStep: step ? { id: step.id, label: step.label } : null,
    steps: STEPS.map((s) => ({ id: s.id, label: s.label, at: t.steps[s.id] || null, clock: t.steps[s.id] ? whenText(t.steps[s.id], now, w.offsetMinutes) : null })),
    delays: t.delays.map((d) => ({ at: d.at, reason: d.reason, reasonName: REASON[d.reason].name, byRole: d.byRole })),
    cancelReason: t.cancelReason, byRole: t.byRole,
  };
}

async function state(core) {
  const [events, w] = await Promise.all([core.events(), world(core)]);
  const now = core.now();
  const shift = shiftAt(now, w.offsetMinutes, w.shifts);
  const transfers = deriveTransfers(events);
  const fleet = deriveFleet(events, w.vehicles, { now, shift });
  return { events, w, now, shift, transfers, fleet };
}
// `see` is the caller's view of journeys: an agent is shown a vehicle's state, never the ids of
// journeys from wards it was not given (19 Nov).
function vehicleOut(v, s, see = () => true) {
  const { w, transfers, now } = s;
  const st = vehicleState(v, transfers);
  const site = w.map.get(v.siteId);
  const today = v.lastCheck && whenText(v.lastCheck.at, now, w.offsetMinutes).startsWith('today');
  return {
    id: v.id, name: currentWords(v.name), siteId: v.siteId, siteName: site ? currentWords(site.name) : null, state: st.state,
    stateName: { 'off-road': 'Out of service', 'on-job': 'On a job', free: 'Free' }[st.state], crewed: v.crewed,
    offRoad: v.offRoad ? { since: v.offRoad.since, sinceText: whenText(v.offRoad.since, now, w.offsetMinutes), reason: v.offRoad.reason, reasonName: OFF_ROAD_NAME[v.offRoad.reason] } : null,
    currentJob: st.current && see(st.current) ? st.current.id : null, assignedJobs: st.assigned.filter(see).map((t) => t.id),
    lastCheck: v.lastCheck ? { at: v.lastCheck.at, atText: whenText(v.lastCheck.at, now, w.offsetMinutes), today: !!today, passed: v.lastCheck.passed.length,
      failed: v.lastCheck.failed.map((x) => ({ id: x, name: CHECK_NAME[x] })), byRole: v.lastCheck.byRole } : null,
    checkFailing: checkFailing(v),
  };
}

// ---- the board: queue, vehicles, KPIs and the guide in one read ----
async function board(core, input, wards) {
  const s = await state(core);
  const { events, w, now, shift, transfers, fleet } = s;
  const days = input.days ?? 7;
  const since = new Date(Date.parse(now) - days * DAY).toISOString();
  const see = visible(w, wards);
  const mine = new Map([...transfers].filter(([, t]) => see(t)));
  const out = (t) => transferOut(t, w, now, fleet);
  const waiting = queueOf(mine);
  const open = [...mine.values()].filter((t) => OPEN_STATES.includes(t.state) && t.state !== 'waiting').sort((a, b) => (neededAt(a) < neededAt(b) ? -1 : 1));
  const vehicles = [...fleet.values()].map((v) => vehicleOut(v, s, see));
  const sinceDay = new Date(Date.parse(now) - DAY).toISOString();
  const doneToday = [...mine.values()].filter((t) => t.steps['handed-over'] && t.steps['handed-over'] >= sinceDay).length;
  const values = {
    'transfer-wait': transferWait(mine, { since, until: now }),
    'on-time-pickup': onTimePickup(mine, { since, until: now }),
    'handover-time': handoverTime(mine, { since, until: now }),
    'fleet-availability': fleetAvailability(fleet, { since, until: now, offsetMinutes: w.offsetMinutes, siteName: (id) => w.name(id) }),
  };
  const on = guideOn(events);
  let suggestions = [];
  if (on) {
    const bd = deriveBoard(w.beds, events);
    const waitingByWard = new Map();
    for (const x of bd.waiting) if (!x.allocatedBed && x.wardId && (!wards || wards.has(x.wardId))) waitingByWard.set(x.wardId, (waitingByWard.get(x.wardId) || 0) + 1);
    const free = vehicles.filter((v) => v.state === 'free' && v.crewed).map((v) => ({ id: v.id, name: v.name }));
    const orders = deriveWorkOrders(events, now);
    const openFaults = new Map();
    for (const o of orders.values()) if (o.state !== 'completed' && fleet.has(o.assetId)) openFaults.set(o.assetId, [...(openFaults.get(o.assetId) || []), o.title]);
    suggestions = [
      ...ruleCheckFailed({ fleet, openFaults }),
      ...ruleDischargeLater({ transfers: mine, waitingByWard, freeVehicles: free, now, offsetMinutes: w.offsetMinutes, placeName: w.name, destName: destName(w) }),
      ...(wards ? [] : ruleEscortCover({ transfers: mine, now, offsetMinutes: w.offsetMinutes })),
    ];
  }
  const kpis = KPIS.map((k) => {
    const v = values[k.id];
    const base = { id: k.id, name: k.name, unit: k.unit, value: v.value, p90: v.p90 ?? null, numerator: v.numerator, denominator: v.denominator, n: v.n, target: k.target, targetText: k.targetText };
    if (input.format === 'short') return base;
    return { ...base, breakdown: v.breakdown || [], ...(v.leftOut != null ? { leftOut: v.leftOut, pending: v.pending, transportSide: v.transportSide } : {}),
      ...(v.crewedHours != null ? { crewedHours: v.crewedHours } : {}), definition: k.definition, counts: k.counts, outOf: k.outOf, leavesOut: k.leavesOut, source: k.source };
  });
  const cutW = page(waiting, input.limit, 50);
  const cutO = page(open, input.limit, 50);
  return {
    asOf: now, synthetic: await isSynthetic(core), period: { since, until: now, days },
    shift: { ...shift, startText: whenText(shift.start, now, w.offsetMinutes), endText: whenText(shift.end, now, w.offsetMinutes) },
    counts: { waiting: waiting.length, onTheRoad: open.filter((t) => UNDER_WAY.includes(t.state)).length, assigned: open.filter((t) => t.state === 'assigned').length,
      dischargesWaiting: waiting.filter((t) => t.type === 'discharge').length, late: [...waiting, ...open].filter((t) => out(t).late).length, handedOverLastDay: doneToday,
      vehiclesFree: vehicles.filter((v) => v.state === 'free').length, vehiclesOnJob: vehicles.filter((v) => v.state === 'on-job').length, vehiclesOffRoad: vehicles.filter((v) => v.state === 'off-road').length },
    waiting: cutW.items.map(out), open: cutO.items.map(out), total: cutW.total + cutO.total, truncated: cutW.truncated || cutO.truncated,
    vehicles, kpis, planned: PLANNED.map((x) => ({ ...x })),
    guide: { on, rules: GUIDE_RULES.map((r) => ({ ...r })), suggestions },
    ...(input.format === 'short' ? {} : { picks: picks(), places: placesOut(w), slots: bookingSlots(now, w.offsetMinutes) }),
    note: `Measures journeys and vehicles, never a driver or a crew. ${NOT_FOR}`,
  };
}
const picks = () => ({
  types: TYPES.map((x) => ({ ...x })), outside: OUTSIDE.map((x) => ({ ...x })), mobility: MOBILITY.map((x) => ({ ...x })), escort: ESCORT.map((x) => ({ ...x })),
  equipment: EQUIPMENT.map((x) => ({ ...x })), delayReasons: REASONS.map((x) => ({ ...x })), cancelReasons: CANCEL_REASONS.map((x) => ({ ...x })),
  checkItems: CHECK_ITEMS.map((x) => ({ ...x })), checkNote: CHECK_NOTE, offRoadReasons: OFF_ROAD_REASONS.map((x) => ({ ...x })), backReasons: BACK_REASONS.map((x) => ({ ...x })),
  steps: STEPS.map((x) => ({ id: x.id, label: x.label })), onTimeWindowMinutes: ON_TIME_WINDOW,
});
const placesOut = (w) => ({
  sites: w.sites.map((x) => ({ id: x.id, name: currentWords(x.name) })),
  wards: w.wards.map((x) => ({ id: x.id, name: currentWords(x.name), siteId: w.siteOf(x.id)?.id || null })),
  departments: w.departments.map((x) => ({ id: x.id, name: currentWords(x.name), siteId: w.siteOf(x.id)?.id || null })),
});

// ---- checks every write passes (for a person, and before an agent's proposal is queued) ----
// Either side of now: a request stamped ahead by a clock set forward and then corrected blocks the
// same request for two minutes at most, never for as long as the gap lasts (ospeli/ospeli#132).
const DOUBLE_TAP = 2 * MIN;
const sameList = (a, b) => a.length === b.length && a.every((x) => b.includes(x));
async function checkRequest(core, input, events) {
  const w = await world(core);
  const from = w.map.get(input.fromPlace);
  if (!from || !['ward', 'department'].includes(from.type)) throw new CommandError('not-found', 'No ward or department with that id. ospeli_transfers_board (places) lists them, for example ward-a1 or dept-emergency.');
  const hasSite = input.toSite != null; const hasOut = input.toOutside != null;
  if (hasSite === hasOut) throw new CommandError('invalid-input', 'Give exactly one destination: toSite (one of our sites, for example site-north) or toOutside (one of: ' + OUTSIDE.map((x) => x.id).join(', ') + ').');
  if (hasSite) {
    if (w.map.get(input.toSite)?.type !== 'site') throw new CommandError('not-found', `No site with that id. Sites: ${w.sites.map((x) => x.id).join(', ')}.`);
    if (w.siteOf(input.fromPlace)?.id === input.toSite) throw new CommandError('invalid-input', 'The destination is the same site as the pickup. A move inside a site is a patient move in Cleaning and transport, not a vehicle journey.');
  }
  if (input.type === 'between-sites' && !hasSite) throw new CommandError('invalid-input', 'A journey between our sites goes to one of our sites: give toSite.');
  if (input.type === 'to-provider' && (!hasOut || input.toOutside === 'home')) throw new CommandError('invalid-input', 'A journey to another provider goes to another hospital, residential or nursing care, a hospice or somewhere else: give toOutside.');
  if (input.type === 'discharge' && !hasOut) throw new CommandError('invalid-input', 'A discharge leaves the organisation: give toOutside (home, care-home, hospice, other-hospital or other).');
  if (input.needed === 'booked') {
    const t = Date.parse(input.bookedFor); const now = Date.parse(core.now());
    if (!input.bookedFor || Number.isNaN(t)) throw new CommandError('invalid-input', 'A booked journey needs bookedFor, a time such as 2026-11-06T20:30:00.000Z (the board\'s slots list the times to pick).');
    if (t < now - 15 * MIN || t > now + 7 * DAY) throw new CommandError('invalid-input', 'bookedFor must be from now up to seven days ahead.');
  } else if (input.bookedFor != null) throw new CommandError('invalid-input', 'bookedFor is only for a booked journey (needed: "booked").');
  const eq = input.equipment || [];
  if (!eq.length) throw new CommandError('invalid-input', 'Say what equipment must travel, or ["none"] for nothing.', { equipment: EQUIPMENT.map((x) => x.id) });
  if (new Set(eq).size !== eq.length) throw new CommandError('invalid-input', 'Each piece of equipment is listed once.');
  if (eq.includes('none') && eq.length > 1) throw new CommandError('invalid-input', '"none" means no equipment: send it alone, or list the equipment without it.');
  if (input.again !== true) {
    const evs = events ?? await core.events();
    const now = Date.parse(core.now());
    const recent = [...deriveTransfers(evs).values()].filter((t) => t.state !== 'cancelled' && Math.abs(now - Date.parse(t.requestedAt)) < DOUBLE_TAP).find((t) =>
      t.fromPlace === input.fromPlace && t.type === input.type && t.toSite === (input.toSite ?? null) && t.toOutside === (input.toSite ? null : input.toOutside)
      && t.needed === input.needed && (t.bookedFor || null) === (input.needed === 'booked' ? sameMoment(input.bookedFor) : null)
      && t.mobility === input.mobility && t.escort === input.escort && sameList(t.equipment, eq));
    if (recent) throw new CommandError('conflict', `${recent.id}, the same journey, was booked a moment ago. No second one was opened. For a second patient, send again with "again": true.`, { existing: recent.id });
  }
}
async function transferFor(core, input, events) {
  const t = deriveTransfers(events ?? await core.events()).get(input.transferId);
  if (!t) throw new CommandError('not-found', 'No transfer with that id. ospeli_transfers_board lists the open ones (ids look like trf-00012).');
  if (input.expectedState && t.state !== input.expectedState) throw new CommandError('conflict', `It is now "${STATE_NAMES[t.state]}", not "${STATE_NAMES[input.expectedState]}": someone changed it. Look again before you act.`, { state: t.state });
  return t;
}
async function checkAssign(core, input, events) {
  const evs = events ?? await core.events();
  const t = await transferFor(core, input, evs);
  if (!['waiting', 'assigned'].includes(t.state)) throw new CommandError('conflict', `A vehicle can be given only before pickup; it is "${STATE_NAMES[t.state]}".`, { state: t.state });
  const w = await world(core);
  const v = w.vehicles.find((x) => x.id === input.vehicleId);
  if (!v) throw new CommandError('not-found', `No vehicle with that id. Vehicles: ${w.vehicles.map((x) => x.id).join(', ') || 'none on this device'}.`);
  if (t.vehicleId === v.id) throw new CommandError('conflict', `${t.id} is already with ${currentWords(v.name)}.`);
  const fleet = deriveFleet(evs, w.vehicles, { now: core.now(), shift: shiftAt(core.now(), w.offsetMinutes, w.shifts) });
  if (fleet.get(v.id).offRoad) throw new CommandError('conflict', `${currentWords(v.name)} is out of service. Pick a vehicle that is in service.`);
}
async function checkStep(core, input, events) {
  const t = await transferFor(core, input, events);
  if (t.state === 'cancelled') throw new CommandError('conflict', `${t.id} was cancelled.`);
  if (t.state === 'handed-over') throw new CommandError('conflict', `${t.id} is already handed over.`);
  const next = nextStep(t);
  if (!next) throw new CommandError('conflict', `${t.id} has no vehicle yet. The transport coordinator gives it one first.`);
  if (next.id !== input.step) throw new CommandError('conflict', `Steps go in order. The next step for ${t.id} is "${next.label}" (${next.id}).`, { nextStep: next.id });
  // A journey is not started in a vehicle that is out of service (ospeli/ospeli#139): the command
  // refuses it, not only the screen. A journey already on the road may still be finished.
  if (['arrived-pickup', 'departed'].includes(input.step) && t.vehicleId) {
    const w = await world(core);
    const v = w.vehicles.find((x) => x.id === t.vehicleId);
    const f = v && deriveFleet(events ?? await core.events(), w.vehicles, { now: core.now(), shift: null }).get(v.id);
    if (f?.offRoad) throw new CommandError('conflict', `${currentWords(v.name)} is out of service, so ${t.id} cannot start in it. The transport coordinator gives the journey to a vehicle that is in service.`, { vehicleOffRoad: true });
  }
}
async function checkDelay(core, input, events) {
  const t = await transferFor(core, input, events);
  if (!OPEN_STATES.includes(t.state)) throw new CommandError('conflict', `${t.id} is "${STATE_NAMES[t.state]}": only an open journey can be marked delayed.`);
  const last = t.delays.at(-1);
  if (last && last.reason === input.reason && Date.parse(core.now()) - Date.parse(last.at) < 10 * MIN) throw new CommandError('conflict', `${t.id} was marked delayed for the same reason a few minutes ago. Nothing new was saved.`);
}
async function checkCancel(core, input, events) {
  const t = await transferFor(core, input, events);
  if (['on-the-way', 'at-destination', 'handed-over'].includes(t.state)) throw new CommandError('conflict', `${t.id} has departed: it cannot be cancelled now.`);
  if (t.state === 'cancelled') throw new CommandError('conflict', `${t.id} is already cancelled.`);
}
async function vehicleFor(core, vehicleId) {
  const w = await world(core);
  const v = w.vehicles.find((x) => x.id === vehicleId);
  if (!v) throw new CommandError('not-found', `No vehicle with that id. Vehicles: ${w.vehicles.map((x) => x.id).join(', ') || 'none on this device'}.`);
  return { w, v };
}
async function checkCrew(core, input, events) {
  const { w, v } = await vehicleFor(core, input.vehicleId);
  const shift = shiftAt(core.now(), w.offsetMinutes, w.shifts);
  const f = deriveFleet(events ?? await core.events(), w.vehicles, { now: core.now(), shift }).get(v.id);
  if (input.crewed && f.offRoad) throw new CommandError('conflict', `${currentWords(v.name)} is out of service. Pick a vehicle that is in service.`);
  if (input.crewed && f.crewed) throw new CommandError('conflict', `${currentWords(v.name)} is already crewed for this shift. Nothing new was saved; its jobs are the same for every crew phone.`, { alreadyCrewed: true });
  if (!input.crewed && !f.crewed) throw new CommandError('conflict', `${currentWords(v.name)} is not crewed this shift. Nothing to release.`);
  return { w, v, shift };
}
async function checkCheck(core, input, events) {
  const { v } = await vehicleFor(core, input.vehicleId);
  const passed = input.passed || []; const failed = input.failed || [];
  if (new Set(passed).size !== passed.length || new Set(failed).size !== failed.length) throw new CommandError('invalid-input', 'Each item is listed once.');
  const both = passed.filter((x) => failed.includes(x));
  if (both.length) throw new CommandError('invalid-input', `An item is either passed or failed, not both: ${both.join(', ')}.`);
  const missing = CHECK_ITEMS.map((x) => x.id).filter((x) => !passed.includes(x) && !failed.includes(x));
  if (missing.length) throw new CommandError('invalid-input', `A daily check marks every item pass or fail. Not marked: ${missing.join(', ')}.`, { items: CHECK_ITEMS.map((x) => x.id) });
  const evs = events ?? await core.events({ type: 'transfers.vehicle-checked' });
  const last = evs.filter((e) => e.type === 'transfers.vehicle-checked' && e.subject === v.id).at(-1);
  if (last && Date.parse(core.now()) - Date.parse(last.at) < 10 * MIN && sameList(last.data?.failed || [], failed)) throw new CommandError('conflict', `The same check of ${currentWords(v.name)} was saved a few minutes ago. Nothing new was saved.`);
}
async function checkStatus(core, input, events) {
  const { w, v } = await vehicleFor(core, input.vehicleId);
  const f = deriveFleet(events ?? await core.events(), w.vehicles, { now: core.now(), shift: null }).get(v.id);
  const list = input.status === 'off-road' ? OFF_ROAD_NAME : BACK_NAME;
  if (!list[input.reason]) throw new CommandError('invalid-input', `For ${input.status}, the reason is one of: ${Object.keys(list).join(', ')}.`);
  if (input.status === 'off-road' && f.offRoad) throw new CommandError('conflict', `${currentWords(v.name)} is already out of service.`);
  if (input.status === 'back' && !f.offRoad) throw new CommandError('conflict', `${currentWords(v.name)} is already in service.`);
}

// Who a transfer is about, for agents: the ward it leaves from.
const wardOfTransfer = async (core, input) => {
  const t = deriveTransfers(await core.events({ type: 'transfers.requested' })).get(input.transferId);
  // By the place's type, never by how its id is spelt: a ward may have any id (19 Nov).
  return t && typeof t.fromPlace === 'string' ? wardOfPlace(core, t.fromPlace) : null;
};
// An agent's proposal keeps the state the journey was in when the agent looked, and is checked
// against it when a person accepts: a journey that has moved on is not cancelled, delayed or handed
// to another vehicle on old information (19 Nov; the bed and job commands do the same).
const snapshotTransfer = async (core, input) => ({ seenState: input.expectedState ?? deriveTransfers(await core.events()).get(input.transferId)?.state ?? null });
const step = (type, subject, actor, core, data) => ({ type, subject, actorRole: actor.role, at: core.now(), data });

const TRF = { type: 'string', pattern: '^trf-[0-9]{5,}$', maxLength: 20, description: 'A transfer id, for example trf-00012 (ospeli_transfers_board lists them).' };
const VEHICLE = { ...ID, description: 'A vehicle\'s id, for example asset-vehicle-2 (ospeli_transfers_board lists the vehicles).' };
const STATE_IN = { type: 'string', enum: Object.keys(STATE_NAMES), description: 'Optional: the state you saw. If it has changed since, nothing is saved and you are told.' };
const enumOf = (list, d) => ({ type: 'string', enum: list.map((x) => x.id), description: `${d} One of: ${list.map((x) => `${x.id} (${x.name})`).join(', ')}.` });
const TRANSFER_OUT = { type: 'object', required: ['id', 'type', 'state', 'pickup', 'destination', 'needed', 'mobility', 'escort', 'equipment'] };
const KPI_OUT = { type: 'object', required: ['id', 'name', 'unit', 'value', 'n'], properties: {
  id: { type: 'string' }, name: { type: 'string' }, unit: { type: 'string' }, value: { type: ['number', 'null'], description: 'null when nothing was counted in the period.' },
  p90: { type: ['number', 'null'] }, numerator: { type: ['number', 'null'] }, denominator: { type: ['number', 'null'] }, n: { type: 'integer' },
  target: { type: ['number', 'null'] }, targetText: { type: 'string' }, breakdown: { type: 'array' }, definition: { type: 'string' }, source: { type: 'string' } } };
const SUGGESTION = { type: 'object', required: ['rule', 'id', 'text', 'why', 'basis'], properties: {
  rule: { type: 'string' }, id: { type: 'string' }, text: { type: 'string' }, why: { type: 'string' }, basis: { type: 'string' },
  action: { type: ['object', 'null'], description: 'The first command a person may run to follow it; null: advice only. actions lists them all. A fault report needs a priority the person picks.' },
  actions: { type: 'array' } } };

export const COMMANDS = [
  {
    name: 'ospeli_transfers_board',
    summary: 'The dispatch board in one call: journeys waiting for a vehicle (in the order they are needed: a booked time, or when an as-soon-as-possible request was made), journeys with a vehicle, every vehicle (free, on a job or out of service; crewed this shift or not; its last daily check), the four measures with their definitions and sources, and the guide\'s suggestions with their reasons and basis (empty while the guide is off). Also the pick lists, places and bookable times. Measures journeys and vehicles, never drivers. Read-only.',
    kind: 'read', roles: ALL_ROLES, approval: false,
    input: { type: 'object', additionalProperties: false, properties: {
      days: { type: 'integer', minimum: 1, maximum: 30, description: 'The period for the measures: the last this many days. Default 7.' },
      format: FORMAT('no pick lists, places or definitions', 'the measures with definitions, plus pick lists, places and bookable times'),
      limit: LIMIT(50, 500, 'journeys in each list') } },
    output: { type: 'object', required: ['asOf', 'synthetic', 'shift', 'counts', 'waiting', 'open', 'vehicles', 'kpis', 'guide', 'total', 'truncated'], properties: {
      asOf: TIME, synthetic: SYNTHETIC, period: { type: 'object' }, shift: { type: 'object' }, counts: { type: 'object' },
      waiting: { type: 'array', items: TRANSFER_OUT }, open: { type: 'array', items: TRANSFER_OUT, description: 'Journeys with a vehicle, not yet handed over.' },
      vehicles: { type: 'array', items: { type: 'object', required: ['id', 'name', 'state', 'crewed'] } }, kpis: { type: 'array', items: KPI_OUT },
      planned: { type: 'array' }, guide: { type: 'object', required: ['on', 'rules', 'suggestions'], properties: { on: { type: 'boolean' }, rules: { type: 'array' }, suggestions: { type: 'array', items: SUGGESTION } } },
      picks: { type: 'object' }, places: { type: 'object' }, slots: { type: 'array' }, total: TOTAL, truncated: TRUNCATED, note: { type: 'string' } } },
    async run(core, input, { wards }) { return board(core, input, wards); },
    example: { input: { days: 7, format: 'short' } },
  },
  {
    name: 'ospeli_transfers_jobs',
    summary: 'One vehicle\'s jobs for the crew: the journey under way first, then the rest in the order they are needed, each with pickup, destination, mobility, escort, equipment and the next step to tap. Also whether the vehicle is crewed this shift or out of service. Read-only.',
    kind: 'read', roles: ['driver', 'transport-coordinator', 'fleet-supervisor'], approval: false,
    input: { type: 'object', additionalProperties: false, required: ['vehicleId'], properties: { vehicleId: VEHICLE, limit: LIMIT(20, 100, 'jobs') } },
    output: { type: 'object', required: ['asOf', 'vehicle', 'shift', 'jobs', 'total', 'truncated'], properties: {
      asOf: TIME, synthetic: SYNTHETIC, vehicle: { type: 'object' }, shift: { type: 'object' }, jobs: { type: 'array', items: TRANSFER_OUT },
      handedOverThisShift: { type: 'integer' }, total: TOTAL, truncated: TRUNCATED } },
    async run(core, input, { wards }) {
      const s = await state(core);
      const v = s.fleet.get(input.vehicleId);
      if (!v) throw new CommandError('not-found', `No vehicle with that id. Vehicles: ${[...s.fleet.keys()].join(', ') || 'none on this device'}.`);
      const see = visible(s.w, wards);
      const jobs = jobsOf(s.transfers, v.id).filter(see);
      const cut = page(jobs, input.limit, 20);
      const done = [...s.transfers.values()].filter((t) => see(t) && t.vehicleId === v.id && t.steps['handed-over'] && t.steps['handed-over'] >= s.shift.start).length;
      return { asOf: s.now, synthetic: await isSynthetic(core), vehicle: vehicleOut(v, s, see), shift: { ...s.shift, endText: whenText(s.shift.end, s.now, s.w.offsetMinutes) },
        jobs: cut.items.map((t) => transferOut(t, s.w, s.now, s.fleet)), handedOverThisShift: done, total: cut.total, truncated: cut.truncated };
    },
    example: { input: { vehicleId: 'asset-vehicle-1' } },
  },
  {
    name: 'ospeli_transfers_request',
    summary: 'Book a journey in a vehicle: from a ward or department, to one of our sites or an outside category (never a name or an address), as soon as possible or for a booked time, with how the patient travels, who escorts them and the equipment, all picked from lists. No typed text and no clinical notes. The ward sets mobility and escort; Ospeli records the pick. A move on foot inside a site is a Cleaning and transport job instead. The same journey sent twice within two minutes is one booking unless "again" is true (a second patient). An agent\'s call becomes a proposal for a person.',
    kind: 'write', roles: ['ward-nurse', 'ae-nic', 'bed-manager', 'transport-coordinator'], approval: true,
    input: { type: 'object', additionalProperties: false, required: ['type', 'fromPlace', 'needed', 'mobility', 'escort', 'equipment'], properties: {
      type: enumOf(TYPES, 'What kind of journey.'),
      fromPlace: { ...ID, description: 'The ward or department the patient leaves from, for example ward-a1.' },
      toSite: { ...ID, description: 'One of our sites, for example site-north. Give this or toOutside.' },
      toOutside: enumOf(OUTSIDE, 'An outside destination as a category, never a name or address. Give this or toSite.'),
      needed: { type: 'string', enum: ['asap', 'booked'], description: 'asap: as soon as possible (the wait starts now). booked: at bookedFor.' },
      bookedFor: { ...TIME, description: 'For a booked journey: when the patient must leave, up to seven days ahead.' },
      mobility: enumOf(MOBILITY, 'How the patient travels, as the ward set it.'),
      escort: enumOf(ESCORT, 'Who travels with the patient, as the ward set it.'),
      equipment: { type: 'array', minItems: 1, maxItems: EQUIPMENT.length, items: { type: 'string', enum: EQUIPMENT.map((x) => x.id) }, description: `What must travel. ["none"] for nothing. One or more of: ${EQUIPMENT.map((x) => x.id).join(', ')}.` },
      bayMove: { type: 'boolean', description: 'true when a move to the vehicle bay is already asked for in Cleaning and transport. This command does not ask for it.' },
      again: { type: 'boolean', description: 'true to book a second, identical journey (another patient) within two minutes of the first.' } } },
    output: { type: 'object', required: ['status'], properties: { status: WRITE_STATUS, transferId: TRF, queuePosition: { type: 'integer' }, waiting: { type: 'integer' }, events: EVENT_SEQS, proposal: PROPOSAL_OUT } },
    wardOf: (core, input) => (typeof input.fromPlace === 'string' ? wardOfPlace(core, input.fromPlace) : null),
    async precheck(core, input) { await checkRequest(core, input); },
    async run(core, input, { actor }) {
      let transferId = null;
      const recs = await core.appendChecked(async (events) => {
        await checkRequest(core, input, events);
        transferId = nextTransferId(events);
        return [step('transfers.requested', transferId, actor, core, {
          type: input.type, fromPlace: input.fromPlace, ...(input.toSite ? { toSite: input.toSite } : { toOutside: input.toOutside }), needed: input.needed,
          ...(input.needed === 'booked' ? { bookedFor: sameMoment(input.bookedFor) } : {}), mobility: input.mobility, escort: input.escort, equipment: [...input.equipment], bayMove: input.bayMove === true })];
      });
      await core.recordAs(actor, 'transfers.requested', transferId, { type: input.type, fromPlace: input.fromPlace, needed: input.needed });
      const q = queueOf(deriveTransfers(await core.events()));
      return { status: 'done', transferId, queuePosition: q.findIndex((t) => t.id === transferId) + 1, waiting: q.length, events: recs.map((r) => r.seq) };
    },
    example: { input: { type: 'between-sites', fromPlace: 'ward-a3', toSite: 'site-north', needed: 'asap', mobility: 'wheelchair', escort: 'none', equipment: ['none'] } },
  },
  {
    name: 'ospeli_transfers_assign',
    summary: 'Give a journey to a vehicle (or move it to another vehicle before pickup). The vehicle must be in service; whether it is crewed this shift is shown on the board. It then shows in that vehicle\'s jobs. An agent\'s call becomes a proposal for a person.',
    kind: 'write', roles: ['transport-coordinator'], approval: true,
    input: { type: 'object', additionalProperties: false, required: ['transferId', 'vehicleId'], properties: { transferId: TRF, vehicleId: VEHICLE, expectedState: STATE_IN } },
    snapshot: snapshotTransfer,
    output: { type: 'object', required: ['status'], properties: { status: WRITE_STATUS, transferId: TRF, vehicleId: ID, dispatchMinutes: { type: 'integer' }, events: EVENT_SEQS, proposal: PROPOSAL_OUT } },
    target: (input) => ({ id: input.transferId, word: 'transfer' }), wardOf: wardOfTransfer,
    async precheck(core, input) { await checkAssign(core, input); },
    async run(core, input, { actor }) {
      let t = null;
      const recs = await core.appendChecked(async (events) => {
        await checkAssign(core, input, events);
        t = deriveTransfers(events).get(input.transferId);
        return [step('transfers.assigned', t.id, actor, core, { vehicle: input.vehicleId })];
      });
      await core.recordAs(actor, 'transfers.assigned', t.id, { vehicle: input.vehicleId });
      return { status: 'done', transferId: t.id, vehicleId: input.vehicleId, dispatchMinutes: Math.max(0, minsBetween(t.requestedAt, core.now())), events: recs.map((r) => r.seq) };
    },
    example: { input: { transferId: 'trf-00001', vehicleId: 'asset-vehicle-1' }, needs: 'A journey waiting for a vehicle: book one with ospeli_transfers_request, or find one in ospeli_transfers_board (waiting).' },
  },
  {
    name: 'ospeli_transfers_step',
    summary: 'Time the next step of a journey, one tap each, in order: arrived-pickup, departed, arrived-destination, handed-over (the handover is operational, with no clinical content; it ends the journey and frees the vehicle). A step out of order is refused with the next valid step. An agent\'s call becomes a proposal for a person.',
    kind: 'write', roles: ['driver', 'transport-coordinator'], approval: true,
    input: { type: 'object', additionalProperties: false, required: ['transferId', 'step'], properties: { transferId: TRF, step: { type: 'string', enum: STEPS.map((x) => x.id), description: 'The next step: arrived-pickup, departed, arrived-destination or handed-over.' }, expectedState: STATE_IN } },
    snapshot: snapshotTransfer,
    output: { type: 'object', required: ['status'], properties: { status: WRITE_STATUS, transferId: TRF, state: { type: 'string' }, nextStep: { type: ['string', 'null'] }, events: EVENT_SEQS, proposal: PROPOSAL_OUT } },
    target: (input) => ({ id: input.transferId, word: 'transfer' }), wardOf: wardOfTransfer,
    async precheck(core, input) { await checkStep(core, input); },
    async run(core, input, { actor }) {
      let t = null;
      const recs = await core.appendChecked(async (events) => {
        await checkStep(core, input, events);
        t = deriveTransfers(events).get(input.transferId);
        return [step(`transfers.${input.step}`, t.id, actor, core, { vehicle: t.vehicleId })];
      });
      await core.recordAs(actor, `transfers.${input.step}`, t.id, { vehicle: t.vehicleId });
      const after = deriveTransfers(await core.events()).get(t.id);
      return { status: 'done', transferId: t.id, state: after.state, nextStep: nextStep(after)?.id ?? null, events: recs.map((r) => r.seq) };
    },
    example: { input: { transferId: 'trf-00001', step: 'arrived-pickup' }, needs: 'A journey with a vehicle and no step yet: ospeli_transfers_request, then ospeli_transfers_assign; or find one in ospeli_transfers_jobs.' },
  },
  {
    name: 'ospeli_transfers_delay',
    summary: 'Mark an open journey delayed, with a reason picked from a list (no vehicle, no escort, no crew, vehicle fault, patient, paperwork or destination not ready, other). It keeps its place; the reason feeds on-time pickup and the guide. Transport coordinator only. An agent\'s call becomes a proposal for a person.',
    kind: 'write', roles: ['transport-coordinator'], approval: true,
    input: { type: 'object', additionalProperties: false, required: ['transferId', 'reason'], properties: { transferId: TRF, reason: enumOf(REASONS, 'Why.'), expectedState: STATE_IN } },
    snapshot: snapshotTransfer,
    output: { type: 'object', required: ['status'], properties: { status: WRITE_STATUS, transferId: TRF, delays: { type: 'integer' }, events: EVENT_SEQS, proposal: PROPOSAL_OUT } },
    target: (input) => ({ id: input.transferId, word: 'transfer' }), wardOf: wardOfTransfer,
    async precheck(core, input) { await checkDelay(core, input); },
    async run(core, input, { actor }) {
      let t = null;
      const recs = await core.appendChecked(async (events) => {
        await checkDelay(core, input, events);
        t = deriveTransfers(events).get(input.transferId);
        return [step('transfers.delayed', t.id, actor, core, { reason: input.reason })];
      });
      await core.recordAs(actor, 'transfers.delayed', t.id, { reason: input.reason });
      return { status: 'done', transferId: t.id, delays: t.delays.length + 1, events: recs.map((r) => r.seq) };
    },
    example: { input: { transferId: 'trf-00001', reason: 'no-escort' }, needs: 'An open journey: book one with ospeli_transfers_request, or find one in ospeli_transfers_board.' },
  },
  {
    name: 'ospeli_transfers_cancel',
    summary: 'Cancel a journey before it departs, with a reason picked from a list. Refused once the vehicle has departed with the patient. An agent\'s call becomes a proposal for a person.',
    kind: 'write', roles: ['transport-coordinator', 'ward-nurse', 'ae-nic', 'bed-manager'], approval: true,
    input: { type: 'object', additionalProperties: false, required: ['transferId', 'reason'], properties: { transferId: TRF, reason: enumOf(CANCEL_REASONS, 'Why.'), expectedState: STATE_IN } },
    snapshot: snapshotTransfer,
    output: { type: 'object', required: ['status'], properties: { status: WRITE_STATUS, transferId: TRF, events: EVENT_SEQS, proposal: PROPOSAL_OUT } },
    target: (input) => ({ id: input.transferId, word: 'transfer' }), wardOf: wardOfTransfer,
    async precheck(core, input) { await checkCancel(core, input); },
    async run(core, input, { actor }) {
      const recs = await core.appendChecked(async (events) => {
        await checkCancel(core, input, events);
        return [step('transfers.cancelled', input.transferId, actor, core, { reason: input.reason })];
      });
      await core.recordAs(actor, 'transfers.cancelled', input.transferId, { reason: input.reason });
      return { status: 'done', transferId: input.transferId, events: recs.map((r) => r.seq) };
    },
    example: { input: { transferId: 'trf-00001', reason: 'not-needed' }, needs: 'A journey not yet departed: book one with ospeli_transfers_request, or find one in ospeli_transfers_board.' },
  },
  {
    name: 'ospeli_transfers_vehicle_crew',
    summary: 'A crew picks a vehicle for this shift (crewed: true), or releases it at the end (crewed: false). Records the vehicle, the shift and the role, never who. One crewing per vehicle and shift: a second crew phone picking the same vehicle is told it is already crewed and nothing new is saved. An agent\'s call becomes a proposal for a person.',
    kind: 'write', roles: ['driver', 'transport-coordinator'], approval: true,
    input: { type: 'object', additionalProperties: false, required: ['vehicleId', 'crewed'], properties: { vehicleId: VEHICLE, crewed: { type: 'boolean', description: 'true: crewed for this shift. false: released.' } } },
    output: { type: 'object', required: ['status'], properties: { status: WRITE_STATUS, vehicleId: ID, crewed: { type: 'boolean' }, shift: { type: 'object' }, events: EVENT_SEQS, proposal: PROPOSAL_OUT } },
    target: (input) => ({ id: input.vehicleId, word: 'vehicle' }),
    async precheck(core, input) { await checkCrew(core, input); },
    async run(core, input, { actor }) {
      let shift = null;
      const recs = await core.appendChecked(async (events) => {
        ({ shift } = await checkCrew(core, input, events));
        return [step(input.crewed ? 'transfers.vehicle-crewed' : 'transfers.vehicle-uncrewed', input.vehicleId, actor, core, { shift: shift.id, shiftStart: shift.start, shiftEnd: shift.end })];
      });
      await core.recordAs(actor, input.crewed ? 'transfers.vehicle-crewed' : 'transfers.vehicle-uncrewed', input.vehicleId, { shift: shift.id });
      return { status: 'done', vehicleId: input.vehicleId, crewed: input.crewed, shift, events: recs.map((r) => r.seq) };
    },
    example: { input: { vehicleId: 'asset-vehicle-2', crewed: true } },
  },
  {
    name: 'ospeli_transfers_vehicle_check',
    summary: 'Record a vehicle\'s daily check: every item on the example check list marked pass or fail (picks only). A failed item shows as a guide suggestion to take the vehicle out of service and to report a fault; nothing else happens by itself. The list is an example set, set locally, not a standard. An agent\'s call becomes a proposal for a person.',
    kind: 'write', roles: ['fleet-supervisor', 'driver'], approval: true,
    input: { type: 'object', additionalProperties: false, required: ['vehicleId'], properties: { vehicleId: VEHICLE,
      passed: { type: 'array', maxItems: CHECK_ITEMS.length, items: { type: 'string', enum: CHECK_ITEMS.map((x) => x.id) }, description: `Items that passed. Every item is in passed or failed: ${CHECK_ITEMS.map((x) => x.id).join(', ')}.` },
      failed: { type: 'array', maxItems: CHECK_ITEMS.length, items: { type: 'string', enum: CHECK_ITEMS.map((x) => x.id) }, description: 'Items that failed.' } } },
    output: { type: 'object', required: ['status'], properties: { status: WRITE_STATUS, vehicleId: ID, failed: { type: 'array' }, events: EVENT_SEQS, proposal: PROPOSAL_OUT } },
    target: (input) => ({ id: input.vehicleId, word: 'vehicle' }),
    async precheck(core, input) { await checkCheck(core, input); },
    async run(core, input, { actor }) {
      const recs = await core.appendChecked(async (events) => {
        await checkCheck(core, input, events);
        return [step('transfers.vehicle-checked', input.vehicleId, actor, core, { passed: [...(input.passed || [])], failed: [...(input.failed || [])] })];
      });
      await core.recordAs(actor, 'transfers.vehicle-checked', input.vehicleId, { passed: (input.passed || []).length, failed: (input.failed || []).length });
      return { status: 'done', vehicleId: input.vehicleId, failed: (input.failed || []).map((x) => ({ id: x, name: CHECK_NAME[x] })), events: recs.map((r) => r.seq) };
    },
    example: { input: { vehicleId: 'asset-vehicle-1', passed: CHECK_ITEMS.map((x) => x.id), failed: [] } },
  },
  {
    name: 'ospeli_transfers_vehicle_status',
    summary: 'Take a vehicle out of service (status off-road) or bring it back (status back), with a reason from a list. Off-road time lowers fleet availability. Journeys already given to it show "vehicle out of service" so the coordinator can give them to another vehicle. An agent\'s call becomes a proposal for a person.',
    kind: 'write', roles: ['fleet-supervisor', 'transport-coordinator'], approval: true,
    input: { type: 'object', additionalProperties: false, required: ['vehicleId', 'status', 'reason'], properties: { vehicleId: VEHICLE,
      status: { type: 'string', enum: ['off-road', 'back'], description: 'off-road or back (in service).' },
      reason: { type: 'string', enum: [...new Set([...OFF_ROAD_REASONS, ...BACK_REASONS].map((x) => x.id))], description: `Out of service: ${OFF_ROAD_REASONS.map((x) => x.id).join(', ')}. Back: ${BACK_REASONS.map((x) => x.id).join(', ')}.` } } },
    output: { type: 'object', required: ['status'], properties: { status: WRITE_STATUS, vehicleId: ID, onRoad: { type: 'boolean' }, events: EVENT_SEQS, proposal: PROPOSAL_OUT } },
    target: (input) => ({ id: input.vehicleId, word: 'vehicle' }),
    async precheck(core, input) { await checkStatus(core, input); },
    async run(core, input, { actor }) {
      const type = input.status === 'off-road' ? 'transfers.vehicle-off-road' : 'transfers.vehicle-back';
      const recs = await core.appendChecked(async (events) => {
        await checkStatus(core, input, events);
        return [step(type, input.vehicleId, actor, core, { reason: input.reason })];
      });
      await core.recordAs(actor, type, input.vehicleId, { reason: input.reason });
      return { status: 'done', vehicleId: input.vehicleId, onRoad: input.status === 'back', events: recs.map((r) => r.seq) };
    },
    example: { input: { vehicleId: 'asset-vehicle-3', status: 'off-road', reason: 'service' } },
  },
  {
    name: 'ospeli_transfers_guide_set',
    summary: 'Switch the transfers guide on or off for this site. The guide is three fixed rules (a discharge booked late while beds are needed, a failed daily check, delays for no escort at one time of day) that suggest; a person decides. With it off everything else works the same. People only.',
    kind: 'write', roles: ['transport-coordinator', 'fleet-supervisor'], approval: true, agents: false,
    input: { type: 'object', additionalProperties: false, required: ['on'], properties: { on: { type: 'boolean', description: 'true: show the guide\'s suggestions. false: none.' } } },
    output: { type: 'object', required: ['status', 'on'], properties: { status: WRITE_STATUS, on: { type: 'boolean' }, events: EVENT_SEQS } },
    async precheck(core, input) { if (guideOn(await core.events({ type: 'transfers.guide-set' })) === input.on) throw new CommandError('conflict', `The guide is already ${input.on ? 'on' : 'off'}.`); },
    async run(core, input, { actor }) {
      const recs = await core.appendChecked(async (events) => {
        if (guideOn(events) === input.on) throw new CommandError('conflict', `The guide is already ${input.on ? 'on' : 'off'}.`);
        return [step('transfers.guide-set', 'transfers-guide', actor, core, { on: input.on })];
      });
      await core.recordAs(actor, 'transfers.guide-set', 'transfers-guide', { on: input.on });
      return { status: 'done', on: input.on, events: recs.map((r) => r.seq) };
    },
    example: { input: { on: false } },
  },
];

// Examples that need something in place first (tests/unit/examples.test.mjs): made the way people would.
export async function prepareExample(core, command, { run }) {
  const book = async () => (await run('ospeli_transfers_request', { type: 'discharge', fromPlace: 'ward-b1', toOutside: 'home', needed: 'asap', mobility: 'walks', escort: 'none', equipment: ['none'], again: true }, 'ward-nurse')).transferId;
  const n = command.name;
  if (n === 'ospeli_transfers_assign' || n === 'ospeli_transfers_delay' || n === 'ospeli_transfers_cancel') return { transferId: await book() };
  if (n === 'ospeli_transfers_step') {
    const transferId = await book();
    await run('ospeli_transfers_assign', { transferId, vehicleId: 'asset-vehicle-1' }, 'transport-coordinator');
    return { transferId };
  }
  if (n === 'ospeli_transfers_vehicle_crew') {
    const b = await run('ospeli_transfers_board', { format: 'short' }, 'transport-coordinator');
    const v = b.vehicles.find((x) => !x.crewed && x.state !== 'off-road');
    return v ? { vehicleId: v.id } : {};
  }
  return {};
}

// ---- synthetic history for the example hospital: thirty days of journeys and vehicles ----
// Generic patterns only, entirely fictional: about eight journeys a day, discharges peaking in the
// afternoon, journeys between the three sites and to outside categories; each vehicle checked each
// morning and crewed for the day shift; a few delays for no escort clustered late in the day in
// the last two weeks; one vehicle out of service for two days after a failed check. At the end: a
// few journeys waiting, one given to a vehicle not yet crewed, one under way, one free crewed vehicle.
const JOURNEYS_PER_HOUR = [0, 0, 0, 0, 0, 0, 0, 0.3, 0.6, 0.8, 0.9, 0.8, 0.7, 0.8, 1, 1.1, 1, 0.6, 0.3, 0, 0, 0, 0, 0];
const TYPE_W = [['discharge', 45], ['between-sites', 30], ['to-provider', 15], ['appointment', 10]];
const MOB_W = [['walks', 30], ['wheelchair', 40], ['stretcher', 20], ['two-crew', 8], ['special', 2]];
const ESC_W = [['none', 55], ['carer', 25], ['nurse', 15], ['clinician', 5]];
export function seed({ r, startMs, endMs, entities }) {
  const vehicles = entities.filter((e) => e.type === 'asset' && e.kind === 'vehicle').map((e) => e.id).sort();
  const wards = entities.filter((e) => e.type === 'ward').map((e) => e.id);
  const sites = entities.filter((e) => e.type === 'site').map((e) => e.id);
  const has = (id) => entities.some((e) => e.id === id);
  if (vehicles.length < 2 || !wards.length || sites.length < 2) return []; // an older example hospital: no history
  const offset = entities.find((e) => e.type === 'site' && e.utcOffsetMinutes != null)?.utcOffsetMinutes ?? 0;
  const OFF = offset * MIN;
  const localHourOf = (t) => Math.floor(((((t + OFF) % DAY) + DAY) % DAY) / HOUR);
  const dayStart = (t) => { const l = t + OFF; return l - (((l % DAY) + DAY) % DAY) - OFF; };
  const out = [];
  const ev = (t, type, subject, actorRole, data) => out.push({ t, type, subject, actorRole, data });
  const minutes = (m, s, cap) => Math.min(cap, Math.max(2, Math.round(r.lognormal(m, s)))) * MIN;
  const lastDay = dayStart(endMs);
  const v2 = vehicles[1];
  const offFrom = lastDay - 12 * DAY; const offTo = lastDay - 10 * DAY;

  // Vehicles: a morning check and a day-shift crew each day; vehicle 2 fails its tyres one morning
  // and is out of service for two days.
  for (let d = dayStart(startMs) + DAY; d <= lastDay; d += DAY) {
    for (const v of vehicles) {
      const checkAt = d + 7 * HOUR + r.int(5, 40) * MIN;
      if (checkAt > endMs || checkAt < startMs) continue;
      const end = d === lastDay;
      if (v === v2 && end) continue; // vehicle 2's crew has not started yet today
      if (v === v2 && d > offFrom && d < offTo) continue; // out of service
      const failed = v === v2 && d === offFrom ? ['tyres'] : [];
      ev(checkAt, 'transfers.vehicle-checked', v, r.chance(0.8) ? 'driver' : 'fleet-supervisor', { passed: CHECK_ITEMS.map((x) => x.id).filter((x) => !failed.includes(x)), failed });
      if (failed.length) { ev(checkAt + 20 * MIN, 'transfers.vehicle-off-road', v, 'fleet-supervisor', { reason: 'failed-check' }); continue; }
      const shiftStart = new Date(d + 7 * HOUR).toISOString(); const shiftEnd = new Date(d + 19 * HOUR).toISOString();
      ev(checkAt + 2 * MIN, 'transfers.vehicle-crewed', v, 'driver', { shift: 'shift-day', shiftStart, shiftEnd });
      const off = d + 19 * HOUR - r.int(0, 15) * MIN;
      if (off < endMs) ev(off, 'transfers.vehicle-uncrewed', v, 'driver', { shift: 'shift-day', shiftStart, shiftEnd });
    }
    if (d === offTo) ev(d + 9 * HOUR, 'transfers.vehicle-back', v2, 'fleet-supervisor', { reason: 'repaired' });
  }

  // Journeys over the history: every one asked for more than three hours before the end is closed.
  const siteOf = (id) => { let p = entities.find((e) => e.id === id); for (let i = 0; p && p.type !== 'site' && i < 8; i++) p = entities.find((e) => e.id === p.parentId); return p?.id; };
  let n = 0;
  const nextId = () => `trf-${String(++n).padStart(5, '0')}`;
  const pickFrom = (type) => (type === 'appointment' && has('dept-emergency') && r.chance(0.1) ? 'dept-emergency' : r.pick(wards));
  function journey(at, { type = r.weighted(TYPE_W), open = null } = {}) {
    const from = pickFrom(type);
    const fromSite = siteOf(from);
    const toSite = type === 'between-sites' || (type === 'appointment' && r.chance(0.6)) ? r.pick(sites.filter((s) => s !== fromSite)) : null;
    const toOutside = toSite ? null : type === 'discharge' ? r.weighted([['home', 70], ['care-home', 20], ['hospice', 5], ['other-hospital', 5]]) : type === 'to-provider' ? r.weighted([['other-hospital', 60], ['care-home', 25], ['hospice', 15]]) : 'other-hospital';
    const booked = r.chance(type === 'discharge' ? 0.35 : 0.6);
    let bookedFor = booked ? Math.ceil((at + r.int(2, 20) * HOUR) / (30 * MIN)) * 30 * MIN : null;
    // Booked journeys fall in the crews' day (08:00 to 18:00 site time): a later time moves to the next morning.
    if (bookedFor && (localHourOf(bookedFor) < 8 || localHourOf(bookedFor) >= 18)) bookedFor = dayStart(bookedFor + (localHourOf(bookedFor) >= 18 ? DAY : 0)) + (9 + r.int(0, 3)) * HOUR;
    const mobility = r.weighted(MOB_W);
    const escort = r.weighted(ESC_W);
    const equipment = r.chance(0.7) ? ['none'] : [r.weighted([['oxygen', 40], ['pump', 15], ['wide', 15], ['aids', 20], ['belongings', 10]])];
    const id = nextId();
    const role = from === 'dept-emergency' ? 'ae-nic' : r.chance(0.2) ? 'bed-manager' : 'ward-nurse';
    return { id, at, type, from, toSite, toOutside, booked, bookedFor, mobility, escort, equipment, role, open };
  }
  const list = [];
  for (let h = startMs; h < endMs - 3 * HOUR; h += HOUR) {
    const rate = JOURNEYS_PER_HOUR[localHourOf(h)];
    const k = Math.floor(rate) + (r.chance(rate % 1) ? 1 : 0);
    for (let i = 0; i < k; i++) list.push(journey(h + r.int(0, 59) * MIN));
  }
  for (const j of list) if (j.bookedFor && j.bookedFor > endMs - 3 * HOUR) { j.bookedFor = null; j.booked = false; }
  // Four journeys held up for no escort, late in the day in the last two weeks (the guide's pattern).
  const escortDelays = new Set();
  const late = list.filter((j) => j.at > endMs - 13 * DAY && localHourOf(j.at) >= 15 && localHourOf(j.at) < 18 && !j.booked && j.escort !== 'none');
  while (escortDelays.size < Math.min(4, late.length)) escortDelays.add(r.pick(late).id);
  for (const j of list) {
    ev(j.at, 'transfers.requested', j.id, j.role, { type: j.type, fromPlace: j.from, ...(j.toSite ? { toSite: j.toSite } : { toOutside: j.toOutside }), needed: j.booked ? 'booked' : 'asap',
      ...(j.booked ? { bookedFor: new Date(j.bookedFor).toISOString() } : {}), mobility: j.mobility, escort: j.escort, equipment: j.equipment, bayMove: r.chance(0.3) });
    if (r.chance(0.05)) { ev(j.at + r.int(10, 60) * MIN, 'transfers.cancelled', j.id, j.role, { reason: r.weighted([['not-needed', 60], ['patient-not-ready', 30], ['no-vehicle', 10]]) }); continue; }
    const ready = j.booked ? j.bookedFor - r.int(40, 70) * MIN : j.at;
    const atV = j.at > offFrom && j.at < offTo + 9 * HOUR ? vehicles.filter((v) => v !== v2) : vehicles;
    const assign = Math.max(j.at + 2 * MIN, ready) + minutes(10, 0.6, 60);
    const vehicle = r.pick(atV);
    ev(assign, 'transfers.assigned', j.id, 'transport-coordinator', { vehicle });
    let t = assign;
    const held = escortDelays.has(j.id) ? 35 * MIN : 0;
    if (held) ev(assign + 5 * MIN, 'transfers.delayed', j.id, 'transport-coordinator', { reason: 'no-escort' });
    else if (r.chance(0.04)) ev(assign + 5 * MIN, 'transfers.delayed', j.id, 'transport-coordinator', { reason: r.weighted([['patient-not-ready', 50], ['paperwork-not-ready', 30], ['no-vehicle', 20]]) });
    t = Math.max(t + minutes(20, 0.5, 60), j.booked ? j.bookedFor - r.int(10, 20) * MIN : 0) + held;
    ev(t, 'transfers.arrived-pickup', j.id, 'driver', { vehicle });
    t += minutes(12, 0.5, 45);
    ev(t, 'transfers.departed', j.id, 'driver', { vehicle });
    t += minutes(30, 0.4, 90);
    ev(t, 'transfers.arrived-destination', j.id, 'driver', { vehicle });
    t += minutes(12, 0.6, 60);
    ev(t, 'transfers.handed-over', j.id, 'driver', { vehicle });
  }
  // Open at the end time: a real queue for the coordinator and a job for each crew.
  const v1 = vehicles[0]; const v3 = vehicles[2] || vehicles[0];
  const a = (minsAgo, opts) => { const j = journey(endMs - minsAgo * MIN, opts); return j; };
  const req = (j, data = {}) => ev(j.at, 'transfers.requested', j.id, j.role, { type: j.type, fromPlace: j.from, ...(j.toSite ? { toSite: j.toSite } : { toOutside: j.toOutside }), needed: j.booked ? 'booked' : 'asap',
    ...(j.booked ? { bookedFor: new Date(j.bookedFor).toISOString() } : {}), mobility: j.mobility, escort: j.escort, equipment: j.equipment, bayMove: false, ...data });
  // Under way with vehicle 1: departed a few minutes ago.
  const u = a(70, { type: 'between-sites' }); u.booked = false; req(u);
  ev(u.at + 8 * MIN, 'transfers.assigned', u.id, 'transport-coordinator', { vehicle: v1 });
  ev(u.at + 35 * MIN, 'transfers.arrived-pickup', u.id, 'driver', { vehicle: v1 });
  ev(u.at + 50 * MIN, 'transfers.departed', u.id, 'driver', { vehicle: v1 });
  // Given to vehicle 2, whose crew has not picked it yet: a discharge home, as soon as possible.
  const g = a(50, { type: 'discharge' }); g.booked = false; g.toSite = null; g.toOutside = 'home'; req(g);
  ev(g.at + 10 * MIN, 'transfers.assigned', g.id, 'transport-coordinator', { vehicle: v2 });
  // Waiting for a vehicle: the oldest first.
  for (const [ago, type] of [[42, 'discharge'], [25, 'to-provider'], [12, 'between-sites']]) { const w = a(ago, { type }); w.booked = false; req(w); }
  // A discharge booked four hours ahead from the busiest ward (acute medicine in the example) is for the guide's first rule; it waits too.
  const d = a(30, { type: 'discharge' }); d.booked = true; d.bookedFor = Math.ceil((endMs + 4 * HOUR) / (30 * MIN)) * 30 * MIN; d.toSite = null; d.toOutside = 'care-home'; d.from = wards[0]; req(d);
  void v3;
  return out.filter((e) => e.t <= endMs && e.t >= startMs).sort((x, y) => x.t - y.t);
}
