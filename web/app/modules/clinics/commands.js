// Outpatient clinics (area A1): the module's pack (see core/modules.js for the contract).
// Plain data and pure functions; no screen code, so the same file runs in the browser, in tests
// and on a site's own server.
//
// Sessions, slots and appointments are the shared slot object's (core/slots.js, ospeli_slots_*);
// patient codes are the shared patient code object's (core/codes.js, ospeli_codes_*). This module
// writes no booking or code command of its own, and no clinics.* event except its guide switch.
// Its own commands are two reads (the queue, the day summary) and the guide switch.
//
// Operations only: no clinical record, no reason for the visit, no urgency or priority of a
// referral, no advice on treatment. A clinic is a service at a place, never a person: no figure
// names, times or ranks a clinician. A patient is a code ("Patient P12"); two codes are never
// matched as one person. Nothing here calls a model. Every event records the role, never a person.

import {
  CommandError, ALL_ROLES, ID, TIME, SYNTHETIC, LIMIT, TOTAL, TRUNCATED, FORMAT, page, WRITE_STATUS, EVENT_SEQS, isSynthetic, MIN, HOUR, DAY,
} from '../../core/kit.js';
import { currentWords } from '../../core/model.js';
import {
  SLOT_EVENT_TYPES, SESSION_STATES, APPOINTMENT_STATES, LEFT_REASON, DATE_PATTERN, SESSION_ID_PATTERN, slotCatalogue, deriveSlots, validDate, localDate, addDays,
  slotGrid, localInstant, weekdayOf, waitMinutes, noShowFromMs, templateOn,
} from '../../core/slots.js';
import { CODE_EVENT_TYPES, deriveCodes, appointmentsByCode, codeLabel } from '../../core/codes.js';
import {
  SESSION_TYPE, CODE_KIND, GUIDE_SUBJECT, ON_TIME_MINUTES, MIN_GROUP, GUIDE_RULES, guideOn, clinicView, missedRate, slotUtilisation, referralToFirst, clinicWait,
  startPunctuality, queueOf, dayOf, nextFreeSlots, sessionsFromDerived, waitingReferrals, ruleMissedHigh, ruleEmptySoon, ruleArrivalsBunched,
} from './logic.js';

export const id = 'clinics';
export const PREFIX = 'ospeli_clinics_';
export const EVENT_PREFIX = 'clinics.';

// Example services: a pick list, not a standard. A clinic is a service at a place, never a person.
export const SERVICES = {
  'general-medicine': 'General medicine clinic',
  diabetes: 'Diabetes clinic',
  eye: 'Eye clinic',
  antenatal: 'Antenatal clinic',
};

export const SESSION_TYPES = [
  { id: SESSION_TYPE, word: 'Clinic', timed: true, placeTypes: ['department'], services: SERVICES,
    runByRoles: ['clinic-nurse'], planRoles: ['outpatient-manager'], bookRoles: ['booking-clerk', 'outpatient-manager'], stepRoles: ['clinic-receptionist', 'clinic-nurse'] },
];
export const SLOT_TYPES = { new: 'New', 'follow-up': 'Follow-up' };
// Minutes after the booked time before a missed appointment may be recorded. Example setting, not a standard.
export const NO_SHOW_GRACE_MINUTES = 15;

export const CODE_KINDS = [
  { id: CODE_KIND, word: 'Outpatient referral', services: SERVICES, sources: ['referral', 'walk-in'], placeTypes: ['department'],
    openRoles: ['booking-clerk', 'outpatient-manager'], stageRoles: ['booking-clerk', 'outpatient-manager'], closeRoles: ['booking-clerk', 'outpatient-manager'],
    stages: [{ id: 'referral.accepted', word: 'Referral accepted', after: [] }],
    openStage: 'referral.accepted' },
];

// Every number has a definition and a source. No target is set: where a window or a level is
// used, it is an example setting, not a standard.
const NO_TARGET = 'No target set: track the trend.';
export const KPIS = [
  { id: 'missed-appointment-rate', name: 'Missed appointment rate', unit: '%',
    definition: 'Clinic appointments marked "Missed appointment", divided by clinic appointments due in the period. Clinic sessions only: a home visit or outreach day is never counted here. The follow-up after a missed appointment is measured elsewhere.',
    counts: 'Clinic appointments marked missed (the patient never arrived; recorded only after the booked time plus the grace, an example setting of 15 minutes).',
    outOf: 'Clinic appointments whose booked time is in the period.',
    leavesOut: 'Appointments cancelled before the day of the appointment (site date). A patient who arrived and then left is not missed.',
    source: 'local definition (shared helper noShowRate, core/slots.js)', target: null, targetText: NO_TARGET },
  { id: 'slot-utilisation', name: 'Slot utilisation', unit: '%',
    definition: 'Clinic slots used, divided by clinic slots released, for clinic sessions held in the period, after any reduction. A missed appointment counts as used: the slot could not be given to anyone else. Not the same as theatre session utilisation.',
    counts: 'Slots with a booking that kept its place (attended, missed, or arrived and left).',
    outOf: 'Released slots of clinic sessions marked held, after reductions.',
    leavesOut: 'Cancelled sessions, sessions not yet marked held, and sessions not released for booking.',
    source: 'local definition (shared helper utilisation, core/slots.js)', target: null, targetText: NO_TARGET },
  { id: 'referral-to-first-appointment', name: 'Referral to first appointment', unit: 'days',
    definition: 'Days between "Referral accepted" and the first finished clinic visit of the same patient code, median, in all and by service, for codes whose first visit finished in the period. Shown with the number still waiting.',
    counts: 'Codes whose first finished visit after the referral was accepted falls in the period.',
    outOf: 'None (a median).',
    leavesOut: `Referrals with no finished visit yet: they are counted as "still waiting" beside the median, never hidden. A service with fewer than ${MIN_GROUP} codes shows no median (small-number rule, an example setting).`,
    source: 'local definition (shared helpers firstAttendedAfter and stageToFirstAttended, core/codes.js)', target: null, targetText: NO_TARGET },
  { id: 'clinic-wait', name: 'Waiting time in clinic', unit: 'minutes',
    definition: 'Minutes between "Arrived" and "Called in", median, in all and by clinic, for patients called in the period.',
    counts: 'Clinic appointments called in the period that were marked arrived first.',
    outOf: 'None (a median).', leavesOut: `Patients not called yet (shown live on the queue). A clinic with fewer than ${MIN_GROUP} patients called shows no median (small-number rule, an example setting).`,
    source: 'local definition (shared helper waitInClinic, core/slots.js)', target: null, targetText: NO_TARGET },
  { id: 'clinic-start-punctuality', name: 'Clinic start punctuality', unit: '%',
    definition: `Clinic sessions held in the period whose first patient was called no later than ${ON_TIME_MINUTES} minutes after the planned start (earlier counts as on time), divided by clinic sessions held in which anyone was called. The ${ON_TIME_MINUTES}-minute window is an example setting, not a standard.`,
    counts: `Sessions held whose first "Called in" came within ${ON_TIME_MINUTES} minutes of the planned start, or before it.`,
    outOf: 'Clinic sessions marked held in the period with at least one patient called.',
    leavesOut: 'Sessions held in which nobody was called (their number is shown beside it), cancelled sessions and sessions not yet marked held.',
    source: 'local definition (shared helper firstCalledVsStart, core/slots.js, also used for theatre sessions)', target: null, targetText: NO_TARGET },
];
const PLANNED = [
  { id: 'template-edit', name: 'Changing clinic templates', status: 'planned', note: 'Planned, not built yet. Templates are shown read-only.' },
  { id: 'reminders', name: 'Recording reminder replies', status: 'planned', note: 'Planned, not built yet.' },
];
const NOT_FOR = 'Not for clinical decisions: Ospeli does not judge how urgent a referral is or who needs follow-up; the waiting list is in order of wait only. Holds no names, dates of birth, contact details or reasons for the visit: a patient is a code, and Ospeli cannot know whether two codes are the same person. Measures clinics and waits, never an individual clinician.';
const OFFLINE = 'No connection: note the arrival time on paper and enter it when back in signal.';

// ---- the record, read once per call ----
let catalogueCache = null;
const catalogue = () => (catalogueCache ||= slotCatalogue([{ id, SESSION_TYPES, SLOT_TYPES, NO_SHOW_GRACE_MINUTES }], null));
const READ_TYPES = [...new Set([...SLOT_EVENT_TYPES, ...CODE_EVENT_TYPES, 'clinics.guide-set'])];
async function state(core) {
  const [events, ents] = await Promise.all([core.events({ type: READ_TYPES }), core.listEntities()]);
  const offsetMinutes = ents.find((e) => e.type === 'site' && e.utcOffsetMinutes != null)?.utcOffsetMinutes ?? 0;
  const now = core.now();
  const d = deriveSlots(events, { catalogue: catalogue(), offsetMinutes });
  const codesD = deriveCodes(events, { packs: [{ id, CODE_KINDS }] });
  const places = new Map(ents.map((e) => [e.id, e]));
  return { events, now, offsetMinutes, today: localDate(now, offsetMinutes), d, codesD, index: appointmentsByCode(d), places };
}
const placeName = (s, id_) => { const p = id_ ? s.places.get(id_) : null; return p ? currentWords(p.name) : null; };
const clinicName = (st, s) => `${SERVICES[s.service] || 'Clinic'}${placeName(st, s.placeId) ? `, ${placeName(st, s.placeId)}` : ''}`;
const hhmmAt = (ms, offsetMinutes) => new Date(ms + offsetMinutes * MIN).toISOString().slice(11, 16);
const siteClock = (st, iso) => (iso ? hhmmAt(Date.parse(iso), st.offsetMinutes) : null);
const clinicsOn = (st, date) => [...clinicView(st.d).sessions.values()].filter((s) => s.date === date).sort((a, b) => a.startMs - b.startMs || (a.id < b.id ? -1 : 1));
const noShowPicks = () => catalogue().reasons.noShow.filter((r) => r !== 'No answer at the door'); // a round's reason, never a clinic's

const DIGITS = '^[0-9]{1,6}$';
const SESSION = { type: 'string', pattern: SESSION_ID_PATTERN, maxLength: 20, description: 'A clinic session id, for example ses-00001. ospeli_clinics_queue lists today\'s clinics with their ids.' };
const DATE = (what) => ({ type: 'string', pattern: DATE_PATTERN, maxLength: 10, description: `${what} As YYYY-MM-DD on the site's own calendar.` });
const NULLABLE = (t) => ({ type: [t, 'null'] });
const KPI_OUT = { type: 'object', required: ['id', 'name', 'unit', 'value'], properties: {
  id: { type: 'string' }, name: { type: 'string' }, unit: { type: 'string' }, value: { type: ['number', 'null'], description: 'null when nothing was counted in the period, or the group is too small to show.' },
  numerator: NULLABLE('number'), denominator: NULLABLE('number'), n: NULLABLE('integer'), waiting: { type: ['integer', 'null'], description: 'Referral to first appointment only: open referrals with no finished visit yet, shown beside the median.' },
  byService: { type: 'array', description: 'The same figure for each clinic (service at a place). A clinic with too few cases shows null (small-number rule).' },
  definition: { type: 'string' }, counts: { type: 'string' }, outOf: { type: 'string' }, leavesOut: { type: 'string' }, source: { type: 'string' }, targetText: { type: 'string' } } };
const SUGGESTION = { type: 'object', required: ['rule', 'id', 'text', 'why', 'basis'], properties: {
  rule: { type: 'string' }, id: { type: 'string' }, text: { type: 'string' }, why: { type: 'string' }, basis: { type: 'string' },
  action: { type: ['object', 'null'], description: 'The first command a person may tap to follow it (a prefilled booking); null: advice only. The guide never runs it.' }, actions: { type: 'array' } } };
const PATIENT_OUT = { type: 'object', required: ['appointmentId', 'code', 'label', 'slotTime', 'state'], properties: {
  appointmentId: { type: 'string' }, code: { type: 'string' }, label: { type: 'string', description: 'What to call the patient on screen, for example "Patient P12". Never a name.' },
  slotTime: { type: 'string' }, slotType: { type: 'string' }, slotTypeWord: { type: 'string' }, state: { type: 'string' }, stateName: { type: 'string' },
  arrivedAt: NULLABLE('string'), calledAt: NULLABLE('string'), finishedAt: NULLABLE('string'),
  waitMinutes: { type: ['integer', 'null'], description: 'Minutes from arrived to called, or to now while still waiting.' },
  mayMarkMissed: { type: 'boolean', description: 'true: still booked after the booked time plus the grace, so "Missed appointment" may be recorded.' },
  clocks: { type: 'object', description: 'The site\'s own clock (HH:MM) for arrived, called and finished; null until then.' },
  missedFrom: NULLABLE('string'), rebook: { type: 'boolean', description: 'This booking replaces a cancelled or missed one.' } } };
const CLINIC_OUT = { type: 'object', required: ['sessionId', 'service', 'name', 'start', 'state'], properties: {
  sessionId: { type: 'string' }, service: { type: 'string' }, serviceWord: { type: 'string' }, name: { type: 'string', description: 'The clinic: a service at a place, never a person.' },
  placeId: NULLABLE('string'), date: { type: 'string' }, start: { type: 'string' }, end: { type: 'string' }, state: { type: 'string' }, stateName: { type: 'string' }, reason: NULLABLE('string'),
  runningNow: { type: 'boolean' }, counts: { type: 'object' } } };

function clinicOut(st, s) {
  const day = dayOf(st.d, s, st.now);
  const nowMs = Date.parse(st.now);
  return { sessionId: s.id, service: s.service, serviceWord: SERVICES[s.service] || s.service, name: clinicName(st, s), placeId: s.placeId, date: s.date, start: s.start,
    end: hhmmAt(s.endMs, st.offsetMinutes), state: s.state, stateName: SESSION_STATES[s.state].name, reason: s.reason,
    runningNow: s.state !== 'cancelled' && nowMs >= s.startMs - 30 * MIN && nowMs <= s.endMs + 60 * MIN,
    counts: { toCome: day.toCome, waiting: day.waitingNow, withClinician: day.withClinician, finished: day.finished, missed: day.missed, empty: day.empty, longestWaitMinutes: day.longestWaitMinutes } };
}
function patientOut(st, { a }) {
  const from = noShowFromMs(st.d, a);
  return { appointmentId: a.id, code: a.code, label: codeLabel(a.code), slotTime: a.slotTime, slotType: a.slotType, slotTypeWord: SLOT_TYPES[a.slotType] || a.slotType,
    state: a.state, stateName: a.state === 'cancelled' ? LEFT_REASON : APPOINTMENT_STATES[a.state].name, arrivedAt: a.arrivedAt, calledAt: a.calledAt, finishedAt: a.finishedAt,
    clocks: { arrived: siteClock(st, a.arrivedAt), called: siteClock(st, a.calledAt), finished: siteClock(st, a.finishedAt) },
    waitMinutes: waitMinutes(a, st.now), mayMarkMissed: a.state === 'booked' && from != null && Date.parse(st.now) >= from, missedFrom: from == null ? null : new Date(from).toISOString(), rebook: Boolean(a.rebookOf) };
}

// ---- the queue ----
async function queue(core, input) {
  const st = await state(core);
  const date = input.date ?? st.today;
  if (!validDate(date)) throw new CommandError('invalid-input', 'date is not a real date. Use YYYY-MM-DD, for example "2026-11-09".');
  const clinics = clinicsOn(st, date);
  let chosen = null;
  if (input.sessionId) {
    chosen = clinicView(st.d).sessions.get(input.sessionId) || null;
    if (!chosen) throw new CommandError('not-found', 'No clinic session with that id. Leave sessionId out to see today\'s clinics with their ids.');
  } else {
    const nowMs = Date.parse(st.now);
    const live = clinics.filter((s) => s.state !== 'cancelled');
    chosen = live.find((s) => nowMs >= s.startMs - 30 * MIN && nowMs <= s.endMs + 60 * MIN) || live.find((s) => s.startMs > nowMs) || live[0] || clinics[0] || null;
  }
  let patients = chosen ? queueOf(st.d, chosen.id, st.now) : [];
  if (input.find) patients = patients.filter(({ a }) => codeLabel(a.code) === `Patient P${Number(input.find)}`);
  const cut = page(patients, input.limit, 100);
  return {
    asOf: st.now, synthetic: await isSynthetic(core), date, clinics: clinics.map((s) => clinicOut(st, s)),
    sessionId: chosen?.id ?? null, clinic: chosen ? clinicOut(st, chosen) : null,
    patients: cut.items.map((p) => patientOut(st, p)), total: cut.total, truncated: cut.truncated,
    graceMinutes: NO_SHOW_GRACE_MINUTES, picks: { missedReasons: noShowPicks(), leftReason: LEFT_REASON },
    offlineNote: OFFLINE, note: NOT_FOR,
  };
}

// ---- the day summary: each clinic's day, the measures, the guide, the templates ----
function kpisOut(st, { since, until }, short) {
  const services = Object.keys(SERVICES);
  const small = (r) => (r.denominator != null && r.denominator < MIN_GROUP ? { ...r, value: null, tooFew: true } : r);
  const ratio = (fn) => {
    const all = fn({ since, until });
    return { value: all.value, numerator: all.numerator, denominator: all.denominator, n: all.denominator,
      byService: services.map((s) => ({ service: s, name: SERVICES[s], ...small(fn({ since, until, service: s })) })) };
  };
  const ref = referralToFirst(st.codesD, st.index, { since, until });
  const wait = clinicWait(st.d, { since, until });
  const values = {
    'missed-appointment-rate': ratio((o) => missedRate(st.d, o)),
    'slot-utilisation': ratio((o) => slotUtilisation(st.d, o)),
    'referral-to-first-appointment': { value: ref.medianDays, n: ref.n, waiting: ref.waiting, numerator: null, denominator: null,
      byService: services.map((s) => ({ service: s, name: SERVICES[s], value: ref.byService[s]?.medianDays ?? null, n: ref.byService[s]?.n ?? 0,
        waiting: referralToFirst({ ...st.codesD, codes: new Map([...st.codesD.codes].filter(([, c]) => c.service === s)) }, st.index, { since, until }).waiting })) },
    'clinic-wait': { value: wait.medianMinutes, n: wait.n, numerator: null, denominator: null,
      byService: services.map((s) => { const w = clinicWait(st.d, { since, until, service: s }); return { service: s, name: SERVICES[s], value: w.n >= MIN_GROUP ? w.medianMinutes : null, n: w.n, tooFew: w.n < MIN_GROUP }; }) },
    'clinic-start-punctuality': (() => { const r = ratio((o) => startPunctuality(st.d, o)); return { ...r, nobodyCalled: startPunctuality(st.d, { since, until }).nobodyCalled }; })(),
  };
  return KPIS.map((k) => {
    const v = values[k.id];
    const base = { id: k.id, name: k.name, unit: k.unit, value: v.value, numerator: v.numerator, denominator: v.denominator, n: v.n, waiting: v.waiting ?? null, targetText: k.targetText };
    if (short) return base;
    return { ...base, byService: v.byService, ...(v.nobodyCalled != null ? { nobodyCalled: v.nobodyCalled } : {}), definition: k.definition, counts: k.counts, outOf: k.outOf, leavesOut: k.leavesOut, source: k.source };
  });
}
function templatesOut(st) {
  return [...st.d.templates.values()].filter((t) => t.sessionType === SESSION_TYPE)
    .map((t) => {
      const v = templateOn(t, st.today) || t.versions[0];
      return { templateId: t.id, service: t.service, serviceWord: SERVICES[t.service] || t.service, name: `${SERVICES[t.service] || 'Clinic'}${placeName(st, t.placeId) ? `, ${placeName(st, t.placeId)}` : ''}`,
        weekday: t.weekday, start: v.start, minutes: v.minutes, slotMinutes: v.slotMinutes, slots: slotGrid(v.start, v.minutes, v.slotMinutes).length,
        slotTypes: v.slotTypes.map((x) => SLOT_TYPES[x] || x), released: v.released, from: v.from };
    })
    .sort((a, b) => a.weekday - b.weekday || (a.start < b.start ? -1 : 1) || (a.service < b.service ? -1 : 1));
}
async function daySummary(core, input) {
  const st = await state(core);
  const date = input.date ?? st.today;
  if (!validDate(date)) throw new CommandError('invalid-input', 'date is not a real date. Use YYYY-MM-DD, for example "2026-11-09".');
  const days = input.days ?? 28;
  const since = new Date(Date.parse(st.now) - days * DAY).toISOString();
  const short = input.format === 'short';
  const nowMs = Date.parse(st.now);
  const all = sessionsFromDerived(st.d);
  const clinics = clinicsOn(st, date).map((s) => {
    const day = dayOf(st.d, s, st.now);
    const base = { ...clinicOut(st, s), templateSlots: day.templateSlots, capacity: day.capacity, used: day.used, empty: day.empty, cancelled: day.cancelled, missed: day.missed,
      attended: day.attended, leftBeforeSeen: day.leftBeforeSeen, firstCalledMinutes: day.firstCalledMinutes, overrunMinutes: day.overrunMinutes,
      mayMarkHeld: (s.state === 'planned' || s.state === 'reduced') && st.today >= s.date && nowMs >= s.startMs && (nowMs >= s.endMs || !day.open.length) };
    if (short) return base;
    // The Move-or-Cancel list: every open booking, with the next free slots of the same service.
    const moveTo = nextFreeSlots(all, { service: s.service, nowMs, exceptSessionId: s.id, limit: 3 })
      .map((x) => ({ ...x, words: `${localDate(new Date(x.atMs).toISOString(), st.offsetMinutes)} ${x.slotTime}` }));
    return { ...base, open: day.open.map((a) => ({ appointmentId: a.id, code: a.code, label: codeLabel(a.code), slotTime: a.slotTime, state: a.state, stateName: APPOINTMENT_STATES[a.state].name })), moveTo };
  });
  const on = guideOn(st.events);
  const words = { serviceWords: SERVICES, offsetMinutes: st.offsetMinutes };
  const suggestions = on ? [
    ...ruleEmptySoon(st.d, st.codesD, st.index, { now: st.now, ...words }),
    ...ruleMissedHigh(st.d, { now: st.now, ...words }),
    ...ruleArrivalsBunched(st.d, { now: st.now, ...words }),
  ] : [];
  const waiting = waitingReferrals(st.codesD, st.index, { now: st.now });
  const cut = page(clinics, input.limit, 50);
  return {
    asOf: st.now, synthetic: await isSynthetic(core), date, period: { since, until: st.now, days },
    clinics: cut.items, total: cut.total, truncated: cut.truncated,
    counts: { clinics: clinics.length, cancelled: clinics.filter((c) => c.state === 'cancelled').length, reduced: clinics.filter((c) => c.state === 'reduced').length,
      waitingNow: clinics.reduce((n, c) => n + c.counts.waiting, 0), emptySlots: clinics.reduce((n, c) => n + c.empty, 0), referralsWaiting: waiting.length,
      longestReferralWaitDays: waiting.length ? waiting[0].waitingDays : null },
    kpis: kpisOut(st, { since, until: st.now }, short),
    guide: { on, rules: GUIDE_RULES.map((r) => ({ ...r })), suggestions },
    ...(short ? {} : { templates: templatesOut(st), planned: PLANNED.map((x) => ({ ...x })),
      picks: { sessionChange: [...catalogue().reasons.sessionChange], cancelForSession: 'Session cancelled or reduced', onTimeMinutes: ON_TIME_MINUTES, minGroup: MIN_GROUP } }),
    note: NOT_FOR,
  };
}

const everyWard = async (core) => (await core.listEntities('ward')).map((w) => w.id); // appointments are site-wide, as in the slot object
const ev = (type, subject, actor, core, data) => ({ type, subject, actorRole: actor.role, at: core.now(), data });

export const COMMANDS = [
  {
    name: 'ospeli_clinics_queue',
    summary: 'Today\'s queue for one clinic, in booked-time order: each patient by code ("Patient P12", never a name), booked time, new or follow-up, state (booked, arrived, called, finished, missed) and minutes waited since arriving; whether a missed appointment may be recorded yet. Also today\'s clinics with their counts. Leave sessionId out for the clinic running now. Steps are marked with ospeli_slots_step. Read-only.',
    kind: 'read', roles: ALL_ROLES, approval: false,
    input: { type: 'object', additionalProperties: false, properties: {
      sessionId: { ...SESSION, description: 'The clinic session to show. Leave out for the one running now (or the next today).' },
      date: DATE('The day to list clinics for. Default: today.'),
      find: { type: 'string', pattern: DIGITS, maxLength: 6, description: 'Only the patient with this number: "12" finds Patient P12. Digits only; a filter on what is shown, never a way to open a code.' },
      limit: LIMIT(100, 300, 'patients') } },
    output: { type: 'object', required: ['asOf', 'synthetic', 'date', 'clinics', 'sessionId', 'patients', 'total', 'truncated'], properties: {
      asOf: TIME, synthetic: SYNTHETIC, date: { type: 'string' }, clinics: { type: 'array', items: CLINIC_OUT }, sessionId: NULLABLE('string'), clinic: { type: ['object', 'null'] },
      patients: { type: 'array', items: PATIENT_OUT }, total: TOTAL, truncated: TRUNCATED, graceMinutes: { type: 'integer', description: 'Example setting, not a standard.' },
      picks: { type: 'object' }, offlineNote: { type: 'string' }, note: { type: 'string' } } },
    wardOf: everyWard,
    async run(core, input) { return queue(core, input); },
    example: { input: {} },
  },
  {
    name: 'ospeli_clinics_day_summary',
    summary: 'Each clinic\'s day in numbers: slots in the template, used, empty, cancelled and missed; patients waiting now; first patient called against the planned start; overrun past the planned end; sessions cancelled or reduced with the reason; and for a session that still has bookings, each one with the next free slots of the same service (Move or Cancel). Also the five measures with definitions and sources, the guide\'s suggestions with their basis (empty while the guide is off), and the templates (read-only). Clinics and waits, never a clinician. Read-only.',
    kind: 'read', roles: ALL_ROLES, approval: false,
    input: { type: 'object', additionalProperties: false, properties: {
      date: DATE('The day to summarise. Default: today.'),
      days: { type: 'integer', minimum: 1, maximum: 30, description: 'The period for the measures: the last this many days. Default 28.' },
      format: FORMAT('counts and measure values only', 'with each booking still open, move options, measure definitions by clinic, templates and pick lists'),
      limit: LIMIT(50, 200, 'clinics') } },
    output: { type: 'object', required: ['asOf', 'synthetic', 'date', 'clinics', 'counts', 'kpis', 'guide', 'total', 'truncated'], properties: {
      asOf: TIME, synthetic: SYNTHETIC, date: { type: 'string' }, period: { type: 'object' }, clinics: { type: 'array', items: CLINIC_OUT }, counts: { type: 'object' },
      kpis: { type: 'array', items: KPI_OUT }, guide: { type: 'object', required: ['on', 'rules', 'suggestions'], properties: { on: { type: 'boolean' }, rules: { type: 'array' }, suggestions: { type: 'array', items: SUGGESTION } } },
      templates: { type: 'array' }, planned: { type: 'array' }, picks: { type: 'object' }, total: TOTAL, truncated: TRUNCATED, note: { type: 'string' } } },
    wardOf: everyWard,
    async run(core, input) { return daySummary(core, input); },
    example: { input: { format: 'short' } },
  },
  {
    name: 'ospeli_clinics_guide_set',
    summary: 'Switch the clinics guide on or off for this site. The guide is three fixed rules (missed appointments above the usual level, empty slots within two days, patients arriving at the start instead of their slot) that suggest; a person decides, and a suggested booking is a button a person taps. With it off everything else works the same. People only.',
    kind: 'write', roles: ['outpatient-manager'], approval: true, agents: false,
    input: { type: 'object', additionalProperties: false, required: ['on'], properties: { on: { type: 'boolean', description: 'true: show the guide\'s suggestions. false: none.' } } },
    output: { type: 'object', required: ['status', 'on'], properties: { status: WRITE_STATUS, on: { type: 'boolean' }, events: EVENT_SEQS } },
    async precheck(core, input) { if (guideOn(await core.events({ type: 'clinics.guide-set' })) === input.on) throw new CommandError('conflict', `The guide is already ${input.on ? 'on' : 'off'}.`); },
    async run(core, input, { actor }) {
      const recs = await core.appendChecked(async (events) => {
        if (guideOn(events.filter((e) => e.type === 'clinics.guide-set')) === input.on) throw new CommandError('conflict', `The guide is already ${input.on ? 'on' : 'off'}.`);
        return [ev('clinics.guide-set', GUIDE_SUBJECT, actor, core, { on: input.on })];
      });
      await core.recordAs(actor, 'clinics.guide-set', GUIDE_SUBJECT, { on: input.on });
      return { status: 'done', on: input.on, events: recs.map((r) => r.seq) };
    },
    example: { input: { on: false } },
  },
];

// Every example runs as written on a fresh example hospital; nothing to prepare.
export async function prepareExample() { return {}; }

// ---- synthetic history: thirty days of Example General Hospital's outpatient clinics ----
// Entirely fictional, generic patterns only: weekly templates for four example services in the
// outpatients department; referrals opened by the booking clerk and booked by wait into the first
// free slot of the same service; patients who arrive bunched at the start of the general medicine
// clinic; a missed appointment share that varies by clinic (higher in the diabetes clinic); some
// short-notice cancellations by patients, with rebooks; one session reduced and one cancelled for
// staff short (its bookings moved first); sessions marked held at the end of each day; some codes
// closed when the episode ends. At the end time: today's clinics running with a live queue,
// sessions planned for the coming week, and referrals still waiting.
const TEMPLATES = [
  // service, weekdays (1 = Monday), start, minutes, slot minutes
  ['general-medicine', [1, 2, 3, 4, 5], '08:30', 240, 20],
  ['diabetes', [1, 3, 5], '13:00', 180, 20],
  ['eye', [2, 4], '09:00', 180, 15],
  ['antenatal', [1, 4], '13:30', 150, 15],
];
const REFERRALS_PER_WEEK = { 'general-medicine': 48, diabetes: 20, eye: 20, antenatal: 16 };
const MISSED_SHARE = { 'general-medicine': 0.07, diabetes: 0.2, eye: 0.06, antenatal: 0.04 };
const BUNCHED = { 'general-medicine': 0.75, diabetes: 0.25, eye: 0.2, antenatal: 0.15 };
const PLACE = 'dept-outpatients';
export function seed({ r, startMs, endMs, entities }) {
  const site = entities.find((e) => e.type === 'site' && e.utcOffsetMinutes != null);
  if (!entities.some((e) => e.id === PLACE) || !site) return []; // an older example hospital: no history
  const off = site.utcOffsetMinutes;
  const out = [];
  const push = (t, type, subject, actorRole, data = null) => { out.push({ t: Math.round(t), type, subject, actorRole, data }); };
  const dateOf = (t) => localDate(new Date(t).toISOString(), off);
  const at = (date, hhmm) => localInstant(date, hhmm, off);
  const pad = (n) => String(n).padStart(5, '0');
  let nTpl = 0; let nSes = 0; let nApt = 0; let nCode = 0;
  const first = dateOf(startMs); const last = addDays(dateOf(endMs), 8);

  push(startMs + 10 * MIN, 'clinics.guide-set', GUIDE_SUBJECT, 'outpatient-manager', { on: true });
  // Templates, set when the history begins.
  const templates = [];
  let k = 0;
  for (const [service, weekdays, start, minutes, slotMinutes] of TEMPLATES) {
    for (const weekday of weekdays) {
      const id_ = `tpl-${pad(++nTpl)}`;
      templates.push({ id: id_, service, weekday, start, minutes, slotMinutes });
      push(startMs + (20 + k++) * MIN, 'slot.template-set', id_, 'outpatient-manager',
        { templateId: id_, sessionType: SESSION_TYPE, service, placeId: PLACE, weekday, start, minutes, slotMinutes, slotTypes: ['new', 'follow-up'], released: true, from: first });
    }
  }
  // Sessions from each template, planned three weeks ahead (or when the history begins).
  const sessions = [];
  for (let date = first; date <= last; date = addDays(date, 1)) {
    for (const t of templates.filter((x) => x.weekday === weekdayOf(date))) {
      const s = { ...t, id: `ses-${pad(++nSes)}`, templateId: t.id, date, startMs: at(date, t.start), slots: slotGrid(t.start, t.minutes, t.slotMinutes), taken: new Map(), state: 'planned', removed: [] };
      s.endMs = s.startMs + t.minutes * MIN;
      s.plannedAt = Math.max(startMs + 2 * HOUR + nSes * MIN, s.startMs - 21 * DAY);
      if (s.plannedAt >= endMs || s.startMs < startMs + DAY) { nSes--; continue; }
      sessions.push(s);
      push(s.plannedAt, 'session.planned', s.id, 'outpatient-manager', { sessionType: SESSION_TYPE, service: t.service, placeId: PLACE, date, runByRole: 'clinic-nurse',
        start: t.start, minutes: t.minutes, slotMinutes: t.slotMinutes, slotTypes: ['new', 'follow-up'], released: true, templateId: s.templateId });
    }
  }
  // One general medicine session reduced (staff short) as soon as it was planned: its last three slots taken out.
  const midDate = dateOf(startMs + 12 * DAY);
  const reduced = sessions.find((s) => s.service === 'general-medicine' && s.date >= midDate);
  if (reduced) {
    reduced.removed = reduced.slots.slice(-3);
    reduced.slots = reduced.slots.slice(0, -3);
    reduced.state = 'reduced';
    push(reduced.plannedAt + 30 * MIN, 'session.reduced', reduced.id, 'outpatient-manager', { reason: 'Staff short', removeSlotTimes: reduced.removed });
  }
  const free = (s, after) => (s.state === 'cancelled' ? [] : s.slots.filter((x) => !s.taken.has(x) && at(s.date, x) > after));
  // The first free slot of the same service on or after a date, in a session already planned at `t`.
  function findSlot(service, fromDate, t, except = null) {
    for (const s of sessions) {
      if (s.service !== service || s.date < fromDate || s.plannedAt >= t || s === except || s.state === 'cancelled') continue;
      const f = free(s, t);
      if (f.length) return { s, slot: f[0] };
    }
    return null;
  }
  const codes = [];
  const book = (code, t, fromDate, { slotType = 'new', bookedFrom = 'referral', rebookOf = null } = {}) => {
    const hit = findSlot(code.service, fromDate, t);
    if (!hit) return null;
    const a = { id: `apt-${pad(++nApt)}`, code, s: hit.s, slot: hit.slot, slotType, bookedAt: t, rebookOf };
    hit.s.taken.set(hit.slot, a);
    code.appts.push(a);
    push(t, 'appointment.booked', a.id, 'booking-clerk', { sessionId: hit.s.id, sessionType: SESSION_TYPE, slotTime: hit.slot, code: code.code, slotType, bookedFrom, ...(rebookOf ? { rebookOf } : {}) });
    return a;
  };
  // Referrals: opened on weekdays in office hours, about as many as the clinics can take. The
  // first morning, the waiting list already held moves onto Ospeli.
  const open = (t, service) => {
    const code = { code: `pc-${pad(++nCode)}`, service, openedAt: t, appts: [] };
    codes.push(code);
    push(t, 'code.opened', code.code, 'booking-clerk', { kind: CODE_KIND, service, source: r.chance(0.9) ? 'referral' : 'walk-in', placeId: PLACE });
    push(t + 1000, 'code.stage', code.code, 'booking-clerk', { stage: 'referral.accepted', placeId: PLACE });
    return code;
  };
  const refs = [];
  for (const service of Object.keys(SERVICES)) for (let i = 0; i < Math.round(REFERRALS_PER_WEEK[service] * 0.9); i++) refs.push({ t: startMs + 3 * HOUR + r.int(0, 180) * MIN, service, backlog: true });
  for (let day = first; day <= dateOf(endMs); day = addDays(day, 1)) {
    if (weekdayOf(day) > 5) continue;
    for (const service of Object.keys(SERVICES)) {
      const n = Math.round(REFERRALS_PER_WEEK[service] / 5 + (r.next() - 0.5) * 3);
      for (let i = 0; i < n; i++) refs.push({ t: at(day, '08:00') + r.int(0, 540) * MIN, service, backlog: false });
    }
  }
  refs.sort((a, b) => a.t - b.t);
  for (const x of refs) {
    if (x.t < startMs + 3 * HOUR || x.t >= endMs) continue;
    const code = open(x.t, x.service);
    // Booked by wait: the booking clerk works the list within a day or two; the first slot at least a week out (two days for the list moved over).
    const bookAt = x.t + r.int(30, x.backlog ? 240 : 2400) * MIN;
    if (bookAt >= endMs - 2 * HOUR && r.chance(0.5)) continue; // a few of the newest are not booked yet
    book(code, bookAt, addDays(dateOf(x.t), x.backlog ? 1 + r.int(0, 9) : 7 + r.int(0, 7)));
  }
  // One diabetes session cancelled two days ahead (staff short): each booking moved to the next free slot first, or cancelled by the site and rebooked.
  const cancelled = sessions.find((s) => s.service === 'diabetes' && s.date >= dateOf(startMs + 16 * DAY) && s.startMs < endMs);
  if (cancelled) {
    let t = Math.max(cancelled.startMs - 2 * DAY, cancelled.plannedAt + HOUR);
    for (const a of [...cancelled.taken.values()].filter((x) => x.bookedAt < t)) {
      t += 2 * MIN;
      const hit = findSlot(a.code.service, cancelled.date, t, cancelled);
      cancelled.taken.delete(a.slot);
      if (hit) { hit.s.taken.set(hit.slot, a); a.s = hit.s; a.slot = hit.slot; push(t, 'appointment.moved', a.id, 'booking-clerk', { sessionId: hit.s.id, slotTime: hit.slot }); }
      else { a.cancelledAt = t; push(t, 'appointment.cancelled', a.id, 'booking-clerk', { by: 'site', reason: 'Session cancelled or reduced' }); }
    }
    // A booking made after the cancel would be refused: drop any that came later.
    for (const a of [...cancelled.taken.values()]) { a.dropped = true; cancelled.taken.delete(a.slot); }
    cancelled.state = 'cancelled';
    push(t + 5 * MIN, 'session.cancelled', cancelled.id, 'outpatient-manager', { reason: 'Staff short' });
  }
  const dropped = new Set(codes.flatMap((c) => c.appts.filter((a) => a.dropped).map((a) => a.id)));
  if (dropped.size) for (let i = out.length - 1; i >= 0; i--) if (out[i].type === 'appointment.booked' && dropped.has(out[i].subject)) out.splice(i, 1);

  // A few patients cancel ahead (short notice for some), and are rebooked.
  for (const c of codes) {
    const a = c.appts[0];
    if (!a || a.dropped || a.cancelledAt || !r.chance(0.06)) continue;
    const t = Math.min(at(a.s.date, a.slot) - r.int(6, 70) * HOUR, endMs - HOUR);
    if (t <= a.bookedAt + HOUR) continue;
    a.cancelledAt = t; // its slot stays empty: a short-notice cancel is a slot nobody else gets
    push(t, 'appointment.cancelled', a.id, 'booking-clerk', { by: 'patient', reason: 'Patient asked to cancel' });
    book(c, t + 20 * MIN, addDays(dateOf(t), 3), { bookedFrom: 'rebook', rebookOf: a.id });
  }

  // The clinic days, in time order: arrivals, calls and finishes, one clinician working through in
  // booked order. After each day: some are given a follow-up (a recall), half of those who missed
  // are rebooked, and most other episodes are closed.
  for (const s of sessions.filter((x) => x.state !== 'cancelled' && x.startMs < endMs).sort((a, b) => a.startMs - b.startMs)) {
    const appts = [...s.taken.values()].filter((a) => !a.cancelledAt && !a.dropped).sort((a, b) => (a.slot < b.slot ? -1 : 1));
    let freeAt = s.startMs + Math.min(45, Math.max(0, r.lognormal(8, 0.9) - 4)) * MIN; // the clinic starts a little late, some days more
    for (const a of appts) {
      const due = at(s.date, a.slot);
      if (r.chance(MISSED_SHARE[s.service])) {
        a.missed = true;
        push(due + (NO_SHOW_GRACE_MINUTES + r.int(5, 50)) * MIN, 'appointment.no-show', a.id, 'clinic-receptionist', { reason: 'Did not arrive' });
        continue;
      }
      const arrived = Math.max(r.chance(BUNCHED[s.service]) ? s.startMs + r.int(-15, 10) * MIN : due - r.int(-5, 20) * MIN, a.bookedAt + MIN);
      const called = Math.max(freeAt, arrived + 2 * MIN);
      const finished = called + Math.max(6, Math.round(r.lognormal(a.slotType === 'new' ? 17 : 12, 0.35))) * MIN;
      freeAt = finished + MIN;
      push(arrived, 'appointment.arrived', a.id, 'clinic-receptionist');
      push(called, 'appointment.called', a.id, 'clinic-nurse');
      push(finished, 'appointment.finished', a.id, 'clinic-nurse');
      a.finishedAt = finished;
    }
    const heldAt = Math.max(s.endMs + 70 * MIN, freeAt + 30 * MIN);
    if (heldAt < endMs) push(heldAt, 'session.held', s.id, 'outpatient-manager');
    for (const a of appts) {
      const c = a.code;
      if (c.appts.at(-1) !== a) continue;
      const t = (a.finishedAt || at(a.s.date, a.slot) + 2 * HOUR) + r.int(5, 60) * MIN;
      if (t >= endMs) continue;
      if (a.missed) { if (r.chance(0.5)) book(c, t + DAY, addDays(dateOf(t), 2), { bookedFrom: 'rebook', rebookOf: a.id }); continue; }
      if (a.slotType === 'new' && r.chance(0.3)) { book(c, t, addDays(dateOf(t), 14), { slotType: 'follow-up', bookedFrom: 'recall' }); continue; }
      if (r.chance(0.85)) push(t, 'code.closed', c.code, 'booking-clerk', { reason: 'Episode finished' });
    }
  }
  return out.filter((e) => e.t >= startMs && e.t <= endMs).sort((x, y) => x.t - y.t);
}
