// Commands for the shared appointment or slot object (core/slots.js). One set for every module
// that offers capacity at a place and books patient codes into it: a module adds its types of
// session and slot as configuration and gets these commands, the audit entries and the agent
// rules without writing them again. No session type, no commands.
//
// People decide, Ospeli suggests: an agent may read; anything it asks to change waits as a
// proposal for a person and is checked again when the person accepts. Setting a template is for
// people only. Sessions are site-wide, so only an agent that is allowed on every ward of the
// site may read appointments or propose a change.
// Operations only: a code, a time and picks. No field takes typed text, a name, a date of birth,
// a record number, a reason for the visit or an urgency. Ospeli sends no messages.
// The same step sent again (a double tap, a resend after a lost answer) answers done and writes nothing.

import {
  CommandError, ALL_ROLES, ID, TIME, SYNTHETIC, LIMIT, TOTAL, TRUNCATED, FORMAT, page, WRITE_STATUS, PROPOSAL_OUT, EVENT_SEQS, isSynthetic, MIN,
} from './kit.js';
import { roleById, currentWords } from './model.js';
import {
  TEMPLATE_ID_PATTERN, SESSION_ID_PATTERN, APPOINTMENT_ID_PATTERN, CODE_PATTERN, DATE_PATTERN, HHMM_PATTERN, AREA_PATTERN,
  SESSION_STATES, APPOINTMENT_STATES, LEFT_REASON, NO_TIMES_NAME, UNDO_STEPS, UNDO_REASONS, UNDO_REASON_DEFAULT, placedLate, localInstant, BOOKED_FROM, REMINDER_REPLIES, CANCEL_BY, MAX_SESSION_MINUTES, MAX_CAPACITY, SLOT_EVENT_TYPES,
  slotCatalogue, deriveSlots, validDate, weekdayOf, localDate, addDays, slotGrid, slotTimes, capacityOf, holdsPlace, isOpenAppointment, templateOn,
  nextTemplateId, nextSessionId, nextAppointmentId, codeState, appointmentsOf, placeTaken, sessionFill, dueMs, noShowFromMs, waitMinutes,
} from './slots.js';

const REPEAT = 2 * MIN; // the same reminder reply again within this time is a double tap
const MAX_RANGE_DAYS = 92;
const PLACE_KINDS = ['site', 'building', 'department', 'ward', 'bed'];
const roleNames = (ids) => ids.map((r) => roleById(r)?.name || r).join(', ');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// The commands for one catalogue of session types. commands.js calls this once with the modules'
// packs; tests call it with their own.
export function slotCommands(packs = []) {
  const catalogue = slotCatalogue(packs, ALL_ROLES);
  const { sessionTypes, slotTypes, reasons } = catalogue;
  const types = [...sessionTypes.values()];
  if (!types.length) return [];
  const typeIds = types.map((t) => t.id);
  const slotTypeIds = Object.keys(slotTypes);
  const union = (...lists) => ALL_ROLES.filter((r) => types.some((t) => lists.some((l) => t[l].includes(r))));
  const firstTimed = types.find((t) => t.timed) || null;
  const first = firstTimed || types[0];

  const TEMPLATE_ID = { type: 'string', pattern: TEMPLATE_ID_PATTERN, maxLength: 20, description: 'A template id, for example tpl-00001. ospeli_slots_template_set answers with it.' };
  const SESSION_ID = { type: 'string', pattern: SESSION_ID_PATTERN, maxLength: 20, description: 'A session id from ospeli_slots_sessions, for example ses-00001.' };
  const APPOINTMENT_ID = { type: 'string', pattern: APPOINTMENT_ID_PATTERN, maxLength: 20, description: 'An appointment id from ospeli_slots_appointments, for example apt-00001.' };
  const CODE = { type: 'string', pattern: CODE_PATTERN, maxLength: 20, description: 'The patient code Ospeli made for this visit, for example pc-00001. Never a name, a record number or a date of birth.' };
  const DATE = (what) => ({ type: 'string', pattern: DATE_PATTERN, maxLength: 10, description: `${what} As YYYY-MM-DD on the site's own calendar, for example "2026-11-09".` });
  const HHMM = (what) => ({ type: 'string', pattern: HHMM_PATTERN, maxLength: 5, description: `${what} As HH:MM on the site's own clock, 24-hour, for example "09:00".` });
  const SESSION_TYPE = { type: 'string', enum: typeIds, description: `The type of session: ${types.map((t) => `${t.id} (${t.word})`).join(', ')}. ospeli_slots_types lists each with who may plan, book and mark steps.` };
  const SLOT_TYPE = { type: 'string', enum: slotTypeIds.length ? slotTypeIds : ['none'], description: `The type of slot: ${slotTypeIds.map((id) => `${id} (${slotTypes[id]})`).join(', ') || 'none is set up'}. A session may offer only some of them (its slotTypes in ospeli_slots_sessions).` };
  const PLACE = { ...ID, description: 'Where the session is held: a site, building, department or ward id, for example dept-outpatients.' };
  const ASSET = { ...ID, description: 'Only for a type of session held on a piece of equipment (its placeTypes include "asset"): the asset id. Send this or placeId, never both.' };
  const MINUTES = { type: 'integer', minimum: 5, maximum: MAX_SESSION_MINUTES, description: 'How long the session runs, in minutes, for example 180.' };
  const SLOT_MINUTES = { type: 'integer', minimum: 1, maximum: 480, description: 'The length of one slot in minutes, for example 20. 09:00 for 80 minutes in 20-minute slots gives 09:00, 09:20, 09:40 and 10:00.' };
  const SLOT_TYPES_IN = { type: 'array', minItems: 1, maxItems: 20, items: { type: 'string', enum: slotTypeIds.length ? slotTypeIds : ['none'] }, description: 'The slot types this session offers. A booking must pick one of them.' };
  const CAPACITY = { type: 'integer', minimum: 1, maximum: MAX_CAPACITY, description: `How many patients the session can take (a session with a visit order, not timed slots). From 1 to ${MAX_CAPACITY}.` };
  const SLOT_TIME = HHMM('The slot to take, one of the session\'s free slots (ospeli_slots_sessions lists them). Only for a session with timed slots.');
  const VISIT_ORDER = { type: 'integer', minimum: 1, maximum: MAX_CAPACITY, description: 'The place in the visit order: a place from 1 to the capacity the session was planned with, 1 first. Only for a session with a capacity and a visit order (a round), which has no slot times.' };
  // Services: only for the types of session that list them (a clinic for one service).
  const serviceWords = Object.assign({}, ...types.map((t) => t.services || {}));
  const serviceIds = Object.keys(serviceWords);
  const SERVICE = serviceIds.length ? { service: { type: 'string', enum: serviceIds, description: `The service the session is held for, picked from the list: ${serviceIds.map((id) => `${id} (${serviceWords[id]})`).join(', ')}. Needed for a type of session that lists services (ospeli_slots_types), and only for those. With a templateId, leave it out: the template gives it.` } } : {};
  // The service a template or a session asks for, checked against its type. null: the type has none.
  function serviceFor(type, service) {
    if (!type.services) {
      if (service != null) throw invalid(`A ${type.word.toLowerCase()} is not held for a service: leave service out.`);
      return null;
    }
    if (service == null || !type.services[service]) throw invalid(`A ${type.word.toLowerCase()} is held for one service. Send service: ${Object.keys(type.services).join(', ')}.`, { services: Object.keys(type.services) });
    return service;
  }
  const SESSION_STATE = { type: 'string', enum: Object.keys(SESSION_STATES) };
  const APPOINTMENT_STATE = { type: 'string', enum: Object.keys(APPOINTMENT_STATES) };
  const EXPECTED = (schema, what) => ({ ...schema, description: `The state the caller last saw. If the ${what} has changed since, the command is refused (conflict). The same step sent twice still answers done.` });
  const REF = { type: 'object', additionalProperties: false, required: ['module', 'id'], description: 'Optional: the record in another module this booking came from, as { module, id } (ids only, no text).',
    properties: { module: { type: 'string', pattern: '^[a-z][a-z0-9-]{1,30}$', maxLength: 31, description: 'The module the record belongs to, in lower case, for example "diagnostics".' },
      id: { ...ID, description: 'The record\'s id in that module. An id only, never a name or free text.' } } };
  const NULLABLE = (t) => ({ type: [t, 'null'] });

  // ---- reading the record ----
  async function ctx(core, events) {
    const [evs, ents] = await Promise.all([events ?? core.events({ type: SLOT_EVENT_TYPES }), core.listEntities()]);
    const offsetMinutes = ents.find((e) => e.type === 'site' && e.utcOffsetMinutes != null)?.utcOffsetMinutes ?? 0;
    return { core, events: evs, now: core.now(), offsetMinutes, entities: new Map(ents.map((e) => [e.id, e])), d: deriveSlots(evs, { catalogue, offsetMinutes }) };
  }
  const placeName = (c, id) => { const p = id ? c.entities.get(id) : null; return p ? currentWords(p.name) : id ?? null; };
  const ev = (type, subject, role, at, data = null) => ({ type, subject, actorRole: role, at, data });
  // A moment as the site's own clock, "09:45", for a refusal a person reads.
  const siteClock = (c, ms) => new Date(ms + c.offsetMinutes * MIN).toISOString().slice(11, 16);
  // Timed slots carry a time and no date, so a session with timed slots ends at midnight or before.
  function endsByMidnight(type, start, minutes) {
    if (type.timed && Number(start.slice(0, 2)) * 60 + Number(start.slice(3)) + minutes > 24 * 60) {
      throw invalid(`Ospeli cannot yet plan timed slots past midnight. End this ${type.word.toLowerCase()} at midnight or before, and plan the time after midnight as a second session on the next day.`, { latestEnd: '24:00' });
    }
  }
  // What a person can do with an appointment that has no final status yet.
  const waysOut = (a) => (a.state === 'booked' ? ['no-show', 'cancel'] : a.state === 'called' ? ['finished', 'seen-no-times', 'left'] : ['seen-no-times', 'left']);
  const invalid = (why, detail = null) => new CommandError('invalid-input', why, detail);
  const conflict = (why, detail = null) => new CommandError('conflict', why, detail);
  const typeOf = (id) => {
    const t = sessionTypes.get(id);
    if (!t) throw conflict('This type of session is not set up on this site.');
    return t;
  };
  // The role check is per type of session: a role that books clinics does not thereby book rounds.
  function may(type, lists, role, doing) {
    const roles = [...new Set(lists.flatMap((l) => type[l]))];
    if (role && !roles.includes(role)) throw new CommandError('forbidden', `${roleById(role)?.name || 'This role'} cannot ${doing} a ${type.word.toLowerCase()}. That is for: ${roleNames(roles)}.`, { roles });
  }
  function sessionOr404(c, id) {
    const s = c.d.sessions.get(id);
    if (!s) throw new CommandError('not-found', 'No session with that id. ospeli_slots_sessions lists the sessions with their ids.');
    return s;
  }
  function appointmentOr404(c, id) {
    const a = c.d.appointments.get(id);
    if (!a) throw new CommandError('not-found', 'No appointment with that id. ospeli_slots_appointments lists a session\'s appointments with their ids.');
    return a;
  }
  // A session that can still take a booking or a move.
  function bookable(c, s) {
    if (s.state !== 'planned' && s.state !== 'reduced') throw conflict(`This session is ${SESSION_STATES[s.state].name.toLowerCase()} and takes no bookings.`, { state: s.state });
    if (!s.released) throw conflict('This session is not released for booking yet. A planner releases it with ospeli_slots_session_change { "change": "released" }.', { released: false });
  }
  // The place a booking or a move asks for, checked against the kind of session. Returns { slotTime, visitOrder }.
  function wantedPlace(s, type, input) {
    if (s.timed) {
      if (input.visitOrder != null) throw invalid(`A ${type.word.toLowerCase()} has timed slots: send slotTime, not visitOrder.`, { free: freeSlots(s).slice(0, 12) });
      if (!input.slotTime) throw invalid('Send slotTime: one of the session\'s free slots.', { free: freeSlots(s).slice(0, 12) });
      return { slotTime: input.slotTime, visitOrder: null };
    }
    if (input.slotTime != null) throw invalid(`A ${type.word.toLowerCase()} has a visit order and no slot times: send visitOrder, not slotTime.`);
    if (input.visitOrder == null) throw invalid('Send visitOrder: the place in the visit order, 1 for first.');
    return { slotTime: null, visitOrder: input.visitOrder };
  }
  const sameSet = (a, b) => { const x = [...(a || [])].sort(); const y = [...(b || [])].sort(); return x.length === y.length && x.every((v, i) => v === y[i]); };
  let lookup = null; // the derived record in use while a check runs (set by decide)
  const freeSlots = (s) => (lookup ? slotTimes(s).filter((t) => !placeTaken(lookup, s, { slotTime: t })) : []);
  function freePlace(c, s, want, exceptId = null) {
    if (s.timed && !slotTimes(s).includes(want.slotTime)) throw invalid('That time is not a slot in this session.', { free: freeSlots(s).slice(0, 12) });
    const fill = sessionFill(c.d, s.id);
    const mine = exceptId && c.d.appointments.get(exceptId)?.sessionId === s.id;
    if (!s.timed && !mine && fill.booked >= fill.capacity) throw conflict('This session is full.', { capacity: fill.capacity, booked: fill.booked });
    const taken = placeTaken(c.d, s, want, exceptId);
    if (!s.timed && want.visitOrder > s.plannedCapacity) throw invalid(`This session was planned with ${s.plannedCapacity} place${s.plannedCapacity === 1 ? '' : 's'}: the visit order is a place from 1 to ${s.plannedCapacity}.`, { places: s.plannedCapacity });
    if (taken) throw conflict(s.timed ? 'That slot is already taken.' : 'That place in the visit order is already taken.', s.timed ? { free: freeSlots(s).slice(0, 12) } : { takenOrders: appointmentsOf(c.d, s.id).filter(holdsPlace).map((a) => a.visitOrder).sort((x, y) => x - y) });
  }
  function codeOpenElsewhere(c, s, code, exceptId = null) {
    const other = appointmentsOf(c.d, s.id).find((a) => a.id !== exceptId && a.code === code && isOpenAppointment(a));
    if (other) throw conflict(`This code already has ${other.id} open in this session. Move that appointment instead of booking a second one.`, { existing: other.id });
  }

  // ---- what each write decides: refuse (throw), or { out, events, audit } ----
  // `events: []` means the same thing was already done: the answer is done and nothing is written.
  const DECIDE = {
    template_set(c, input, role) {
      const type = typeOf(input.sessionType);
      may(type, ['planRoles'], role, 'set a template for');
      if (!type.timed) throw invalid(`A ${type.word.toLowerCase()} has a capacity and a visit order, not timed slots, so it has no template. Plan each one with ospeli_slots_session_plan.`);
      const p = c.entities.get(input.placeId);
      if (!p || !PLACE_KINDS.includes(p.type)) throw new CommandError('not-found', 'No place with that id. Use a site, building, department or ward id, for example dept-outpatients.');
      if (!type.placeTypes.includes(p.type)) throw invalid(`A ${type.word.toLowerCase()} is held in a ${type.placeTypes.join(' or ')}, not a ${p.type}.`, { placeTypes: type.placeTypes });
      if (!validDate(input.from)) throw invalid('from is not a real date. Use YYYY-MM-DD, for example "2026-11-09".');
      const service = serviceFor(type, input.service);
      if (input.slotMinutes > input.minutes) throw invalid('slotMinutes cannot be longer than the session (minutes).');
      endsByMidnight(type, input.start, input.minutes);
      if (new Set(input.slotTypes).size !== input.slotTypes.length) throw invalid('slotTypes lists a type twice.');
      const version = { start: input.start, minutes: input.minutes, slotMinutes: input.slotMinutes, slotTypes: [...input.slotTypes], released: input.released, from: input.from };
      const strip = (v) => ({ start: v.start, minutes: v.minutes, slotMinutes: v.slotMinutes, slotTypes: v.slotTypes, released: v.released, from: v.from });
      let id = input.templateId;
      if (id) {
        const t = c.d.templates.get(id);
        if (!t) throw new CommandError('not-found', 'No template with that id. Leave templateId out to make a new template.');
        if (t.sessionType !== input.sessionType || t.placeId !== input.placeId || t.weekday !== input.weekday || (t.service ?? null) !== service) throw invalid('A change to a template keeps its type of session, service, place and weekday. For another service, place or day, make a new template (leave templateId out).', { sessionType: t.sessionType, service: t.service ?? null, placeId: t.placeId, weekday: t.weekday });
        const latest = t.versions.reduce((a, b) => (b.from >= a.from ? b : a));
        if (same(strip(latest), version)) return { out: { templateId: id }, events: [] };
        if (input.from < latest.from) throw conflict(`This template already has a change that starts on ${latest.from}. A new change starts on or after that date.`, { from: latest.from });
      } else {
        const twin = [...c.d.templates.values()].find((t) => t.sessionType === input.sessionType && (t.service ?? null) === service && t.placeId === input.placeId && t.weekday === input.weekday
          && t.versions.reduce((a, b) => (b.from >= a.from ? b : a)).start === input.start);
        if (twin) {
          if (same(strip(twin.versions.reduce((a, b) => (b.from >= a.from ? b : a))), version)) return { out: { templateId: twin.id }, events: [] };
          throw conflict(`${twin.id} is already the template for this type${service ? ', service' : ''}, place, weekday and start. Send templateId to change it.`, { existing: twin.id });
        }
        id = nextTemplateId(c.events);
      }
      return { out: { templateId: id }, events: [ev('slot.template-set', id, role, c.now, { templateId: id, sessionType: input.sessionType, ...(service ? { service } : {}), placeId: input.placeId, weekday: input.weekday, ...version })],
        audit: ['slot.template-set', id, { sessionType: input.sessionType, placeId: input.placeId, weekday: input.weekday, from: input.from }] };
    },

    session_plan(c, input, role) {
      const type = typeOf(input.sessionType);
      may(type, ['planRoles'], role, 'plan');
      if (!type.runByRoles.includes(input.runByRole)) throw invalid(`A ${type.word.toLowerCase()} is run by one of: ${type.runByRoles.join(', ')}. runByRole is a role, never a person.`, { runByRoles: type.runByRoles });
      if ((input.placeId == null) === (input.assetId == null)) throw invalid('Send placeId (where the session is held) or, for a session on a piece of equipment, assetId: one of them, not both.');
      if (input.assetId != null) {
        if (!type.placeTypes.includes('asset')) throw invalid(`A ${type.word.toLowerCase()} is held in a ${type.placeTypes.join(' or ')}, not on a piece of equipment. Send placeId.`, { placeTypes: type.placeTypes });
        if (c.entities.get(input.assetId)?.type !== 'asset') throw new CommandError('not-found', 'No equipment with that id. ospeli_assets_list lists the assets with their ids.');
      } else {
        const p = c.entities.get(input.placeId);
        if (p?.type === 'asset') throw invalid(type.placeTypes.includes('asset') ? 'That id is a piece of equipment: send it as assetId.' : `A ${type.word.toLowerCase()} is held in a ${type.placeTypes.filter((t) => t !== 'asset').join(' or ')}, not on a piece of equipment.`, { placeTypes: type.placeTypes });
        if (!p || !PLACE_KINDS.includes(p.type)) throw new CommandError('not-found', 'No place with that id. Use a site, building, department or ward id, for example dept-outpatients.');
        if (!type.placeTypes.includes(p.type)) throw invalid(`A ${type.word.toLowerCase()} is held in a ${type.placeTypes.join(' or ')}, not a ${p.type}.`, { placeTypes: type.placeTypes });
      }
      if (!validDate(input.date)) throw invalid('date is not a real date. Use YYYY-MM-DD, for example "2026-11-09".');
      const data = { sessionType: type.id, ...(input.assetId != null ? { assetId: input.assetId } : { placeId: input.placeId }), date: input.date, runByRole: input.runByRole };
      if (input.templateId) {
        const t = c.d.templates.get(input.templateId);
        if (!t) throw new CommandError('not-found', 'No template with that id. Leave templateId out to plan a one-off session.');
        if (t.sessionType !== type.id || t.placeId !== input.placeId) throw invalid('This template is for another type of session or another place.', { sessionType: t.sessionType, placeId: t.placeId });
        if (input.service != null && input.service !== (t.service ?? null)) throw invalid('This template is for another service. Leave service out: the template gives it.', { service: t.service ?? null });
        if (t.service) data.service = t.service;
        if (weekdayOf(input.date) !== t.weekday) throw invalid(`This template is for weekday ${t.weekday} (Monday is 1); ${input.date} is weekday ${weekdayOf(input.date)}.`, { weekday: t.weekday });
        const v = templateOn(t, input.date);
        if (!v) throw conflict('This template does not start until after that date.', { from: t.versions[0].from });
        if ((input.start && input.start !== v.start) || (input.minutes && input.minutes !== v.minutes)) throw invalid(`On ${input.date} this template runs from ${v.start} for ${v.minutes} minutes. Leave start and minutes out, or send those.`, { start: v.start, minutes: v.minutes });
        if (input.capacity != null || input.slotMinutes != null || input.slotTypes != null) throw invalid('A session planned from a template takes its slots from the template: leave out capacity, slotMinutes and slotTypes.');
        // Copied at plan time, so a later change to the template never rewrites a planned session.
        Object.assign(data, { start: v.start, minutes: v.minutes, slotMinutes: v.slotMinutes, slotTypes: [...v.slotTypes], released: v.released, templateId: t.id });
      } else {
        if (!input.start || !input.minutes) throw invalid('Send start and minutes, or a templateId that gives them.', { example: { start: '09:00', minutes: 180 } });
        const service = serviceFor(type, input.service);
        if (service) data.service = service;
        Object.assign(data, { start: input.start, minutes: input.minutes, released: true, ...(input.slotTypes ? { slotTypes: [...new Set(input.slotTypes)] } : {}) });
        if (type.timed) {
          if (input.capacity != null) throw invalid(`A ${type.word.toLowerCase()} has timed slots: send slotMinutes (or a templateId), not capacity.`);
          if (!input.slotMinutes) throw invalid(`A ${type.word.toLowerCase()} has timed slots: send slotMinutes, or a templateId that gives the slots.`, { example: { slotMinutes: 20 } });
          data.slotMinutes = input.slotMinutes;
        } else {
          if (input.slotMinutes != null) throw invalid(`A ${type.word.toLowerCase()} has a capacity and a visit order: send capacity, not slotMinutes.`);
          if (input.capacity == null) throw invalid(`A ${type.word.toLowerCase()} needs a capacity: how many patients it can take.`, { example: { capacity: 8 } });
          data.capacity = input.capacity;
        }
      }
      endsByMidnight(type, data.start, data.minutes);
      if (type.timed && !slotGrid(data.start, data.minutes, data.slotMinutes).length) throw invalid('The session is shorter than one slot.');
      const twin = [...c.d.sessions.values()].find((s) => s.state !== 'cancelled' && s.sessionType === type.id && (s.service ?? null) === (data.service ?? null) && s.placeId === (input.placeId ?? null) && s.assetId === (input.assetId ?? null) && s.date === data.date && s.start === data.start);
      if (twin) {
        if (twin.minutes === data.minutes && twin.runByRole === data.runByRole && (twin.slotMinutes ?? null) === (data.slotMinutes ?? null) && sameSet(twin.slotTypes, data.slotTypes) && (twin.timed || twin.plannedCapacity === data.capacity)) return { out: { sessionId: twin.id, state: twin.state }, events: [] };
        throw conflict(`${twin.id} is already planned for this type${data.service ? ', service' : ''}, place, date and start. Change that session instead.`, { existing: twin.id });
      }
      const id = nextSessionId(c.events);
      return { out: { sessionId: id, state: 'planned' }, events: [ev('session.planned', id, role, c.now, data)],
        audit: ['session.planned', id, { sessionType: type.id, date: data.date, ...(data.templateId ? { templateId: data.templateId } : {}) }] };
    },

    session_change(c, input, role) {
      const s = sessionOr404(c, input.sessionId);
      const type = typeOf(s.sessionType);
      may(type, ['planRoles'], role, 'change');
      const { change } = input;
      const needsReason = change === 'reduced' || change === 'cancelled';
      if (needsReason && !input.reason) throw invalid(`A session that is ${change} needs a reason: ${reasons.sessionChange.join(', ')}.`, { reasons: reasons.sessionChange });
      if (!needsReason && input.reason) throw invalid(`"${change}" takes no reason: leave it out.`);
      if (change !== 'reduced' && (input.capacity != null || input.removeSlotTimes != null)) throw invalid('capacity and removeSlotTimes are only for "reduced".');
      // The same change again answers done and writes nothing.
      if ((change === 'held' || change === 'cancelled') && s.state === change) return { out: { sessionId: s.id, state: s.state }, events: [] };
      if (change === 'released' && s.released && (s.state === 'planned' || s.state === 'reduced')) return { out: { sessionId: s.id, state: s.state }, events: [] };
      if (input.expectedState && s.state !== input.expectedState) throw conflict('This session changed since you opened it.', { state: s.state });
      if (s.state !== 'planned' && s.state !== 'reduced') throw conflict(`This session is ${SESSION_STATES[s.state].name.toLowerCase()}: it cannot be changed any more.`, { state: s.state });
      const done = (state, type_, data, extra = {}) => ({ out: { sessionId: s.id, state }, events: [ev(type_, s.id, role, c.now, data)], audit: [type_, s.id, { sessionType: s.sessionType, ...extra }] });
      if (change === 'released') return done(s.state, 'session.released', null);
      if (change === 'held') {
        if (localDate(c.now, c.offsetMinutes) < s.date) throw conflict(`This session is on ${s.date}. "Held" records that it ran, so it cannot be set before its day.`, { date: s.date });
        // "Held" is final, so every patient needs a final status first: nobody is left booked, waiting or in a room on the record.
        const open = appointmentsOf(c.d, s.id).filter(isOpenAppointment);
        if (open.length) {
          throw conflict(`${open.length} patient${open.length === 1 ? '' : 's'} in this session ${open.length === 1 ? 'has' : 'have'} no final status. Mark each one Finished, Seen (no times), Left before being seen, Missed appointment or Cancelled, or undo a wrong tap. Then mark the session as held.`,
            { open: open.map((a) => ({ appointmentId: a.id, code: a.code, state: a.state, can: waysOut(a) })) });
        }
        return done('held', 'session.held', null);
      }
      if (change === 'cancelled') {
        const open = appointmentsOf(c.d, s.id).filter(isOpenAppointment).map((a) => a.id);
        if (open.length) throw conflict(`${open.length} booking${open.length === 1 ? ' is' : 's are'} still open in this session. Move or cancel each one first (ospeli_slots_move, ospeli_slots_cancel), so nobody vanishes from a list.`, { open });
        return done('cancelled', 'session.cancelled', { reason: input.reason }, { reason: input.reason });
      }
      // reduced
      if (s.timed) {
        if (input.capacity != null) throw invalid('A session with timed slots is reduced by taking slots out: send removeSlotTimes, not capacity.', { free: slotTimes(s).filter((t) => !placeTaken(c.d, s, { slotTime: t })) });
        const out = [...new Set(input.removeSlotTimes || [])];
        if (!out.length) throw invalid('Send removeSlotTimes: the free slots to take out.', { free: slotTimes(s).filter((t) => !placeTaken(c.d, s, { slotTime: t })) });
        const now = slotTimes(s);
        if (out.some((t) => !now.includes(t))) throw invalid('removeSlotTimes names a time that is not a slot in this session.', { slots: now });
        const booked = out.filter((t) => placeTaken(c.d, s, { slotTime: t }));
        if (booked.length) throw conflict('Only free slots can be taken out. Move or cancel the bookings in these slots first.', { booked });
        return done('reduced', 'session.reduced', { reason: input.reason, removeSlotTimes: out }, { reason: input.reason, removed: out.length });
      }
      if (input.removeSlotTimes != null) throw invalid('A session with a visit order is reduced by a smaller capacity: send capacity, not removeSlotTimes.');
      if (input.capacity == null) throw invalid('Send capacity: the new, smaller number of patients the session can take.');
      if (input.capacity >= s.capacity) throw invalid(`A reduction makes the session smaller: capacity is ${s.capacity} now.`, { capacity: s.capacity });
      const fill = sessionFill(c.d, s.id);
      if (input.capacity < fill.booked) throw conflict(`${fill.booked} are booked, so the capacity cannot go below that. Move or cancel bookings first.`, { booked: fill.booked });
      return done('reduced', 'session.reduced', { reason: input.reason, capacity: input.capacity }, { reason: input.reason, capacity: input.capacity });
    },

    book(c, input, role) {
      const s = sessionOr404(c, input.sessionId);
      const type = typeOf(s.sessionType);
      may(type, ['bookRoles'], role, 'book into');
      const want = wantedPlace(s, type, input);
      if (s.timed || !type.areas) {
        if (input.area != null) throw invalid(`A ${type.word.toLowerCase()} takes no area: leave it out.`);
      } else if (!type.areas.includes(input.area)) throw invalid(`Pick the area from this list: ${type.areas.join(', ')}. An area is a zone code, never an address.`, { areas: type.areas });
      const offered = s.slotTypes.length ? s.slotTypes : slotTypeIds;
      if (!offered.includes(input.slotType)) throw invalid(`This session offers: ${offered.join(', ')}.`, { slotTypes: offered });
      const state = codeState(c.d, input.code);
      if (!state) throw new CommandError('not-found', 'No patient code with that id is open. Ospeli makes the code when the visit is opened; it is never typed in from another system.');
      // The same booking again (a double tap, a resend after a lost answer): the first one is the answer.
      const mine = appointmentsOf(c.d, s.id).find((a) => a.state === 'booked' && a.code === input.code && a.slotTime === want.slotTime && a.visitOrder === want.visitOrder && a.slotType === input.slotType && (a.rebookOf ?? null) === (input.rebookOf ?? null));
      if (mine) return { out: { appointmentId: mine.id, sessionId: s.id, state: 'booked' }, events: [] };
      if (state === 'closed') throw conflict('This patient code is closed. A new visit gets a new code.');
      bookable(c, s);
      if (s.timed && !slotTimes(s).includes(want.slotTime)) throw invalid('That time is not a slot in this session.', { free: freeSlots(s).slice(0, 12) });
      codeOpenElsewhere(c, s, input.code);
      freePlace(c, s, want);
      if (input.rebookOf) {
        const old = c.d.appointments.get(input.rebookOf);
        if (!old) throw new CommandError('not-found', 'rebookOf names no appointment. Leave it out unless this booking replaces a cancelled or missed one.');
        if (old.code !== input.code) throw invalid('A rebook keeps the same patient code as the appointment it replaces.');
        if (isOpenAppointment(old)) throw conflict('That appointment is still open: move it (ospeli_slots_move) instead of booking a second one.', { state: old.state });
        if (old.state === 'finished') throw conflict('That appointment was finished, so there is nothing to rebook.', { state: old.state });
        if (old.rebookedBy) throw conflict(`That appointment was already rebooked as ${old.rebookedBy}.`, { existing: old.rebookedBy });
      }
      const id = nextAppointmentId(c.events);
      const data = { sessionId: s.id, sessionType: s.sessionType, ...(s.timed ? { slotTime: want.slotTime } : { visitOrder: want.visitOrder }), ...(input.area ? { area: input.area } : {}),
        code: input.code, slotType: input.slotType, bookedFrom: input.bookedFrom, ...(input.rebookOf ? { rebookOf: input.rebookOf } : {}), ...(input.requestRef ? { requestRef: { module: input.requestRef.module, id: input.requestRef.id } } : {}) };
      return { out: { appointmentId: id, sessionId: s.id, state: 'booked' }, events: [ev('appointment.booked', id, role, c.now, data)],
        audit: ['appointment.booked', id, { sessionId: s.id, sessionType: s.sessionType, slotType: input.slotType, bookedFrom: input.bookedFrom }] };
    },

    move(c, input, role) {
      const a = appointmentOr404(c, input.appointmentId);
      const type = typeOf(a.sessionType);
      may(type, ['bookRoles'], role, 'move a booking in');
      const s = sessionOr404(c, input.sessionId);
      const want = wantedPlace(s, type, input);
      if (a.state === 'booked' && a.sessionId === s.id && a.slotTime === want.slotTime && a.visitOrder === want.visitOrder) return { out: { appointmentId: a.id, sessionId: s.id, state: 'booked' }, events: [] };
      if (input.expectedState && a.state !== input.expectedState) throw conflict('This appointment changed since you opened it.', { state: a.state });
      if (a.state !== 'booked') throw conflict(`Only a booked appointment can be moved. This one is ${APPOINTMENT_STATES[a.state].name.toLowerCase()}.`, { state: a.state });
      if (s.sessionType !== a.sessionType) throw invalid('An appointment moves to a session of the same type. For another type, cancel it and book again.', { sessionType: a.sessionType });
      bookable(c, s);
      const offered = s.slotTypes.length ? s.slotTypes : slotTypeIds;
      if (!offered.includes(a.slotType)) throw conflict(`That session does not offer this appointment's slot type. It offers: ${offered.join(', ')}.`, { slotTypes: offered });
      codeOpenElsewhere(c, s, a.code, a.id);
      freePlace(c, s, want, a.id);
      return { out: { appointmentId: a.id, sessionId: s.id, state: 'booked' }, events: [ev('appointment.moved', a.id, role, c.now, { sessionId: s.id, ...(s.timed ? { slotTime: want.slotTime } : { visitOrder: want.visitOrder }) })],
        audit: ['appointment.moved', a.id, { sessionId: s.id, fromSessionId: a.sessionId }] };
    },

    cancel(c, input, role) {
      const a = appointmentOr404(c, input.appointmentId);
      const type = typeOf(a.sessionType);
      // The desk that marks arrivals may also record that a patient left before being seen.
      may(type, input.reason === LEFT_REASON ? ['bookRoles', 'stepRoles'] : ['bookRoles'], role, 'cancel a booking in');
      if (a.state === 'cancelled') return { out: { appointmentId: a.id, state: 'cancelled' }, events: [] };
      if (input.expectedState && a.state !== input.expectedState) throw conflict('This appointment changed since you opened it.', { state: a.state });
      if (!isOpenAppointment(a)) throw conflict(`This appointment is ${APPOINTMENT_STATES[a.state].name.toLowerCase()} and cannot be cancelled.`, { state: a.state });
      if (a.state === 'booked') {
        if (input.reason === LEFT_REASON) throw conflict(`"${LEFT_REASON}" is for a patient who arrived. This one has not been marked arrived: pick another reason, or record no-show.`, { state: a.state });
      } else if (input.by !== 'patient' || input.reason !== LEFT_REASON) {
        throw conflict(`This patient has arrived. The only cancel now is by the patient, with the reason "${LEFT_REASON}".`, { state: a.state, example: { by: 'patient', reason: LEFT_REASON } });
      }
      return { out: { appointmentId: a.id, state: 'cancelled' }, events: [ev('appointment.cancelled', a.id, role, c.now, { by: input.by, reason: input.reason })],
        audit: ['appointment.cancelled', a.id, { sessionId: a.sessionId, by: input.by, reason: input.reason }] };
    },

    step(c, input, role) {
      const a = appointmentOr404(c, input.appointmentId);
      const type = typeOf(a.sessionType);
      may(type, ['stepRoles'], role, 'mark a step in');
      const { step } = input;
      if (step === 'no-show' && !input.reason) throw invalid(`A no-show needs a reason: ${reasons.noShow.join(', ')}.`, { reasons: reasons.noShow });
      if (step !== 'no-show' && input.reason) throw invalid(`"${step}" takes no reason: leave it out.`);
      // The same step again answers done and writes nothing, even if the caller's view is old.
      if (a.state === step || (step === 'seen-no-times' && a.state === 'finished' && a.noTimes)) return { out: { appointmentId: a.id, state: a.state }, events: [] };
      if (input.expectedState && a.state !== input.expectedState) throw conflict('This appointment changed since you opened it.', { state: a.state });
      if (step === 'seen-no-times') {
        // For a patient who was seen but not tapped through. From the patient's own booked time on,
        // so it cannot stand in for the real steps before the visit could have happened.
        if (a.state === 'booked') throw conflict('This patient has not been marked arrived. If they were seen, mark Arrived first. If they did not come, record a missed appointment.', { state: a.state });
        if (!isOpenAppointment(a)) throw conflict(`This appointment is ${APPOINTMENT_STATES[a.state].name.toLowerCase()}: no more steps.`, { state: a.state });
        const due = dueMs(c.d, a);
        if (Date.parse(c.now) < due) throw conflict(`"${NO_TIMES_NAME}" is for a patient who was seen but not tapped through. It can be used from the patient's booked time, ${siteClock(c, due)}.`, { from: new Date(due).toISOString() });
        return { out: { appointmentId: a.id, state: 'finished' }, events: [ev('appointment.seen-no-times', a.id, role, c.now, null)],
          audit: ['appointment.seen-no-times', a.id, { sessionId: a.sessionId, from: a.state }] };
      }
      const need = { arrived: 'booked', called: 'arrived', finished: 'called', 'no-show': 'booked' }[step];
      if (a.state !== need) {
        const why = !isOpenAppointment(a) ? `This appointment is ${APPOINTMENT_STATES[a.state].name.toLowerCase()}: no more steps.`
          : step === 'no-show' ? 'This patient has arrived, so it is not a no-show. If they left before being seen, cancel it by the patient with that reason.'
            : `The steps go in order: arrived, called, finished. This appointment is ${APPOINTMENT_STATES[a.state].name.toLowerCase()}.`;
        throw conflict(why, { state: a.state });
      }
      if (step === 'no-show') {
        const from = noShowFromMs(c.d, a);
        if (Date.parse(c.now) < from) {
          throw conflict(placedLate(c.d, a)
            ? `This booking was put in this place at ${siteClock(c, Date.parse(a.placedAt))}. A missed appointment can be recorded from ${siteClock(c, from)}: ${type.graceMinutes} minutes later (example setting, not a standard).`
            : `A no-show can be recorded from ${type.graceMinutes} minutes after the booked time (example setting, not a standard). Before then the patient may still arrive.`, { from: new Date(from).toISOString() });
        }
      }
      return { out: { appointmentId: a.id, state: step }, events: [ev(`appointment.${step}`, a.id, role, c.now, step === 'no-show' ? { reason: input.reason } : null)],
        audit: [`appointment.${step}`, a.id, { sessionId: a.sessionId, ...(input.reason ? { reason: input.reason } : {}) }] };
    },

    // A step marked by mistake, undone by a person at the desk. The wrong step stays in the log.
    step_correct(c, input, role) {
      const a = appointmentOr404(c, input.appointmentId);
      const type = typeOf(a.sessionType);
      may(type, ['stepRoles'], role, 'correct a step in');
      const { undo } = input;
      const back = UNDO_STEPS[undo];
      const reason = input.reason ?? UNDO_REASON_DEFAULT;
      if (reason !== UNDO_REASON_DEFAULT && undo !== 'no-show') throw invalid(`"${reason}" is for undoing a missed appointment. Leave reason out here.`, { reasons: [UNDO_REASON_DEFAULT] });
      // The same undo again (a double tap) answers done and writes nothing.
      if (a.state === back && a.corrections.at(-1)?.undo === undo && !input.expectedState) return { out: { appointmentId: a.id, state: a.state }, events: [] };
      if (a.state === back && a.corrections.at(-1)?.undo === undo && input.expectedState === undo) return { out: { appointmentId: a.id, state: a.state }, events: [] };
      if (input.expectedState && a.state !== input.expectedState) throw conflict('This appointment changed since you opened it.', { state: a.state });
      const s = c.d.sessions.get(a.sessionId);
      if (!s || (s.state !== 'planned' && s.state !== 'reduced')) throw conflict(`This session is marked as ${SESSION_STATES[s?.state]?.name.toLowerCase() || 'closed'}: its steps can no longer be corrected.`, { sessionState: s?.state ?? null });
      if (a.state !== undo) {
        if (undo === 'arrived' && a.state === 'called') throw conflict('This patient has already been called in, so Arrived cannot be undone. If the wrong patient was called in, undo Called in first.', { state: a.state, canUndo: 'called' });
        const can = Object.keys(UNDO_STEPS).find((k) => k === a.state) ?? null;
        throw conflict(`This appointment is ${APPOINTMENT_STATES[a.state].name.toLowerCase()}, so there is no "${APPOINTMENT_STATES[undo].name}" to undo.${a.state === 'finished' ? ' A finished appointment is not corrected.' : ''}`, { state: a.state, canUndo: can });
      }
      if (undo === 'no-show') {
        if (localDate(c.now, c.offsetMinutes) !== s.date) throw conflict('A missed appointment can be undone on the same day only. After that, book the patient again (ospeli_slots_book with rebookOf).', { date: s.date });
        if (a.rebookedBy) throw conflict(`This missed appointment was already booked again as ${a.rebookedBy}. Use that appointment.`, { existing: a.rebookedBy });
        if (codeState(c.d, a.code) === 'closed') throw conflict('This patient code is closed. A new visit gets a new code.');
        codeOpenElsewhere(c, s, a.code, a.id);
      }
      return { out: { appointmentId: a.id, state: back }, events: [ev('appointment.step-undone', a.id, role, c.now, { undo, reason })],
        audit: ['appointment.step-undone', a.id, { sessionId: a.sessionId, undo, reason }] };
    },

    reminder_record(c, input, role) {
      const a = appointmentOr404(c, input.appointmentId);
      const type = typeOf(a.sessionType);
      may(type, ['bookRoles'], role, 'record a reminder for');
      const last = a.reminders.at(-1);
      if (last && last.reply === input.reply && Date.parse(c.now) - Date.parse(last.at) < REPEAT) return { out: { appointmentId: a.id, state: a.state }, events: [] };
      if (a.state !== 'booked') throw conflict(`A reminder is recorded for a booked appointment. This one is ${APPOINTMENT_STATES[a.state].name.toLowerCase()}.`, { state: a.state });
      return { out: { appointmentId: a.id, state: a.state }, events: [ev('appointment.reminder-recorded', a.id, role, c.now, { reply: input.reply })],
        audit: ['appointment.reminder-recorded', a.id, { sessionId: a.sessionId, reply: input.reply }] };
    },
  };
  const decide = (verb, c, input, role) => { lookup = c.d; try { return DECIDE[verb](c, input, role); } finally { lookup = null; } };

  const WRITE_OUT = { type: 'object', required: ['status'], properties: {
    status: WRITE_STATUS, templateId: TEMPLATE_ID, sessionId: SESSION_ID, appointmentId: APPOINTMENT_ID,
    state: { type: 'string', enum: [...new Set([...Object.keys(SESSION_STATES), ...Object.keys(APPOINTMENT_STATES)])], description: 'The state the session or appointment is left in.' },
    events: { ...EVENT_SEQS, description: 'Sequence numbers of the events written. Empty when the same thing was already done: nothing was written twice.' }, proposal: PROPOSAL_OUT } };
  // Sessions are site-wide: an agent may propose only if it is allowed on every ward of the site.
  const everyWard = async (core) => (await core.listEntities('ward')).map((w) => w.id);
  function write({ verb, summary, roles, required, properties, target, people = false, example }) {
    return {
      name: `ospeli_slots_${verb}`, summary, kind: 'write', roles, approval: true, ...(people ? { agents: false } : {}),
      input: { type: 'object', additionalProperties: false, required, properties },
      output: WRITE_OUT,
      ...(target ? { target } : {}),
      wardOf: everyWard,
      async snapshot(core, input) {
        const c = await ctx(core);
        return { seenState: input.expectedState ?? c.d.appointments.get(input.appointmentId)?.state ?? c.d.sessions.get(input.sessionId)?.state ?? null };
      },
      async precheck(core, input, { actor } = {}) { decide(verb, await ctx(core), input, actor?.role); },
      async run(core, input, { actor }) {
        let res = null;
        const recs = await core.appendChecked(async (evs) => { res = decide(verb, await ctx(core, evs), input, actor.role); return res.events; });
        if (res.audit && recs.length) await core.recordAs(actor, ...res.audit);
        return { status: 'done', ...res.out, events: recs.map((r) => r.seq) };
      },
      example,
    };
  }

  // ---- what the reads answer with ----
  const SESSION_OUT = { type: 'object', required: ['id', 'sessionType', 'date', 'start', 'minutes', 'state', 'capacity', 'booked', 'free'], properties: {
    id: SESSION_ID, sessionType: { type: 'string' }, typeWord: { type: 'string' }, service: { type: ['string', 'null'], description: 'The service the session is held for, when its type lists services.' }, serviceWord: NULLABLE('string'), timed: { type: 'boolean', description: 'true: timed slots. false: a capacity and a visit order.' },
    placeId: NULLABLE('string'), placeName: NULLABLE('string'), assetId: NULLABLE('string'),
    date: { type: 'string', description: 'The site\'s own date, YYYY-MM-DD.' }, start: { type: 'string', description: 'The site\'s own clock, HH:MM.' }, minutes: { type: 'integer' },
    startsAt: TIME, endsAt: TIME, state: SESSION_STATE, stateName: { type: 'string' },
    released: { type: 'boolean', description: 'false: planned but not yet open for booking.' },
    reason: NULLABLE('string'), runByRole: { type: 'string', description: 'The role that runs the session. No person is recorded.' }, templateId: NULLABLE('string'),
    capacity: { type: 'integer', minimum: 0, description: 'Places offered now, after any reduction.' },
    booked: { type: 'integer', minimum: 0, description: 'Places taken. A no-show still used its place.' }, free: { type: 'integer', minimum: 0 },
    slotTypes: { type: 'array', items: { type: 'string' }, description: 'The slot types a booking here may pick.' },
    slots: { type: 'array', description: 'Timed sessions, detailed format: each slot with the appointment in it, if any. No patient code is shown here.',
      items: { type: 'object', required: ['time'], properties: { time: { type: 'string' }, appointmentId: APPOINTMENT_ID } } },
  } };
  const APPOINTMENT_OUT = { type: 'object', required: ['id', 'sessionId', 'sessionType', 'code', 'state'], properties: {
    id: APPOINTMENT_ID, sessionId: SESSION_ID, sessionType: { type: 'string' }, date: { type: 'string' },
    slotTime: NULLABLE('string'), visitOrder: NULLABLE('integer'), area: { type: ['string', 'null'], description: 'The zone picked for a visit. Shown only to the roles that book or mark steps for this type of session.' },
    code: CODE, slotType: { type: 'string' }, state: APPOINTMENT_STATE, stateName: { type: 'string' }, bookedFrom: NULLABLE('string'),
    dueAt: { type: ['string', 'null'], description: 'When the appointment is due: its slot time, or the session\'s start for a visit order.' },
    bookedAt: TIME, arrivedAt: NULLABLE('string'), calledAt: NULLABLE('string'), finishedAt: NULLABLE('string'), closedAt: NULLABLE('string'),
    waitMinutes: { type: ['integer', 'null'], description: 'Minutes from arrived to called, or to now while still waiting. null before arriving, and null for a patient seen with no call time recorded: no wait is made up.' },
    noTimes: { type: 'boolean', description: `true: closed as "${NO_TIMES_NAME}". The patient was seen but the call and the finish were not tapped, so there is no finish time and the appointment is left out of the waiting, start and overrun figures.` },
    noShowFrom: { type: ['string', 'null'], description: 'While booked: the earliest moment a missed appointment may be recorded. The grace after the booked time, or after the booking or move if that came later. null in any other state.' },
    corrections: { type: 'integer', minimum: 0, description: 'How many steps of this appointment a person has undone (marked by mistake). The wrong step and the undo stay in the log.' },
    overdue: { type: 'boolean', description: 'true: still booked after the booked time plus the grace, so no-show may be recorded. Worked out from now; never a stored state.' },
    reason: { type: ['string', 'null'], description: 'The reason picked for a cancel or a no-show.' }, cancelBy: NULLABLE('string'),
    rebookOf: NULLABLE('string'), rebookedBy: NULLABLE('string'), moves: { type: 'integer', minimum: 0 },
    reminderReply: { type: ['string', 'null'], description: 'The last reminder reply recorded: confirmed, cancelled or no-reply. A reply never changes the state.' },
  } };
  function sessionOut(c, s, short) {
    const fill = sessionFill(c.d, s.id);
    const offered = s.slotTypes.length ? s.slotTypes : slotTypeIds;
    const base = { id: s.id, sessionType: s.sessionType, typeWord: sessionTypes.get(s.sessionType)?.word || s.sessionType, service: s.service ?? null, serviceWord: s.service ? (sessionTypes.get(s.sessionType)?.services?.[s.service] ?? s.service) : null, timed: s.timed, placeId: s.placeId, placeName: placeName(c, s.placeId ?? s.assetId),
      date: s.date, start: s.start, minutes: s.minutes, state: s.state, stateName: SESSION_STATES[s.state].name, released: s.released, capacity: fill.capacity, booked: fill.booked, free: s.state === 'planned' || s.state === 'reduced' ? fill.free : 0 };
    if (short) return base;
    return { ...base, assetId: s.assetId, startsAt: new Date(s.startMs).toISOString(), endsAt: new Date(s.endMs).toISOString(), reason: s.reason, runByRole: s.runByRole, templateId: s.templateId, slotTypes: [...offered],
      ...(s.timed ? { slots: slotTimes(s).map((time) => { const a = placeTaken(c.d, s, { slotTime: time }); return a ? { time, appointmentId: a.id } : { time }; }) } : {}) };
  }
  function appointmentOut(c, a, role) {
    const s = c.d.sessions.get(a.sessionId); const type = sessionTypes.get(a.sessionType);
    const due = dueMs(c.d, a);
    const seesArea = type && role && (type.bookRoles.includes(role) || type.stepRoles.includes(role));
    return { id: a.id, sessionId: a.sessionId, sessionType: a.sessionType, date: s?.date ?? null, slotTime: a.slotTime, visitOrder: a.visitOrder, area: seesArea ? a.area : null,
      code: a.code, slotType: a.slotType, state: a.state, stateName: a.noTimes ? NO_TIMES_NAME : APPOINTMENT_STATES[a.state].name, noTimes: a.noTimes,
      noShowFrom: a.state === 'booked' && noShowFromMs(c.d, a) != null ? new Date(noShowFromMs(c.d, a)).toISOString() : null, corrections: a.corrections.length, bookedFrom: a.bookedFrom, dueAt: due == null ? null : new Date(due).toISOString(),
      bookedAt: a.bookedAt, arrivedAt: a.arrivedAt, calledAt: a.calledAt, finishedAt: a.finishedAt, closedAt: a.closedAt, waitMinutes: waitMinutes(a, c.now),
      overdue: a.state === 'booked' && Date.parse(c.now) >= noShowFromMs(c.d, a), reason: a.noShowReason ?? a.cancelReason ?? null, cancelBy: a.cancelBy,
      rebookOf: a.rebookOf, rebookedBy: a.rebookedBy, moves: a.moves, reminderReply: a.reminders.at(-1)?.reply ?? null };
  }

  const NEED_SESSION = 'A session that is planned and released, with a free place. ses-00001 is an example id: ospeli_slots_sessions lists the sessions with their free slots, and ospeli_slots_session_plan plans one.';
  const NEED_APPOINTMENT = 'A booked appointment. apt-00001 is an example id: ospeli_slots_appointments with a sessionId lists a session\'s appointments, and ospeli_slots_book makes one.';
  const planExample = firstTimed
    ? { sessionType: first.id, ...(first.services ? { service: Object.keys(first.services)[0] } : {}), placeId: 'dept-outpatients', date: '2026-11-09', start: '09:00', minutes: 80, slotMinutes: 20, runByRole: first.runByRoles[0] }
    : { sessionType: first.id, placeId: 'site-north', date: '2026-11-09', start: '08:30', minutes: 240, capacity: 8, runByRole: first.runByRoles[0] };

  const list = [
    {
      name: 'ospeli_slots_types',
      summary: 'The types of session this site can plan (a clinic, a round), with the roles that plan, book and mark steps for each, the slot types, and the reasons to pick from for a change, a cancel and a no-show. Read-only.',
      kind: 'read', roles: ALL_ROLES, approval: false,
      input: { type: 'object', additionalProperties: false, properties: {} },
      output: { type: 'object', required: ['sessionTypes', 'slotTypes', 'reasons'], properties: {
        sessionTypes: { type: 'array', items: { type: 'object', required: ['id', 'word', 'timed'], properties: {
          id: { type: 'string' }, word: { type: 'string' }, timed: { type: 'boolean', description: 'true: timed slots from a template. false: a capacity and a visit order.' },
          placeTypes: { type: 'array', items: { type: 'string' } }, areas: { type: ['array', 'null'], items: { type: 'string' }, description: 'Zone codes to pick from for a visit. Never an address.' },
          services: { type: ['array', 'null'], items: { type: 'object', required: ['id', 'word'], properties: { id: { type: 'string' }, word: { type: 'string' } } }, description: 'The services a session of this type is held for. null: the type has none, and a session names no service.' },
          runByRoles: { type: 'array', items: { type: 'string' } }, planRoles: { type: 'array', items: { type: 'string' } }, bookRoles: { type: 'array', items: { type: 'string' } }, stepRoles: { type: 'array', items: { type: 'string' } },
          graceMinutes: { type: 'integer', description: 'Minutes after the booked time before no-show may be recorded. Example setting, not a standard.' } } } },
        slotTypes: { type: 'array', items: { type: 'object', required: ['id', 'word'], properties: { id: { type: 'string' }, word: { type: 'string' } } } },
        reasons: { type: 'object', required: ['sessionChange', 'appointmentCancel', 'noShow'], properties: {
          sessionChange: { type: 'array', items: { type: 'string' } }, appointmentCancel: { type: 'array', items: { type: 'string' } }, noShow: { type: 'array', items: { type: 'string' } } } },
        leftReason: { type: 'string', description: 'The one cancel reason for a patient who arrived and then left.' },
        bookedFrom: { type: 'array', items: { type: 'string' } }, reminderReplies: { type: 'array', items: { type: 'string' } } } },
      async run() {
        return {
          sessionTypes: types.map((t) => ({ id: t.id, word: t.word, timed: t.timed, placeTypes: [...t.placeTypes], areas: t.areas ? [...t.areas] : null, services: t.services ? Object.entries(t.services).map(([id, word]) => ({ id, word })) : null,
            runByRoles: [...t.runByRoles], planRoles: [...t.planRoles], bookRoles: [...t.bookRoles], stepRoles: [...t.stepRoles], graceMinutes: t.graceMinutes })),
          slotTypes: slotTypeIds.map((id) => ({ id, word: slotTypes[id] })),
          reasons: { sessionChange: [...reasons.sessionChange], appointmentCancel: [...reasons.appointmentCancel], noShow: [...reasons.noShow] },
          leftReason: LEFT_REASON, bookedFrom: [...BOOKED_FROM], reminderReplies: [...REMINDER_REPLIES],
        };
      },
      example: { input: {} },
    },
    {
      name: 'ospeli_slots_sessions',
      summary: 'The sessions between two dates (today and the next seven days if left out): where, when, state, how many places are offered, booked and free, and for a timed session each slot. It shows capacity only: no patient code. Read-only.',
      kind: 'read', roles: ALL_ROLES, approval: false,
      input: { type: 'object', additionalProperties: false, properties: {
        from: DATE('The first date to list. Default: today.'), to: DATE(`The last date to list. Default: seven days after "from". At most ${MAX_RANGE_DAYS} days.`),
        sessionType: { ...SESSION_TYPE, description: `Only this type of session: ${typeIds.join(', ')}. Leave out for every type.` },
        placeId: { ...ID, description: 'Only sessions held at this place (or on this asset), for example dept-outpatients.' },
        ...(serviceIds.length ? { service: { type: 'string', enum: serviceIds, description: `Only sessions held for this service: ${serviceIds.join(', ')}.` } } : {}),
        state: { ...SESSION_STATE, description: 'Only sessions in this state: planned, reduced, held or cancelled. Leave out for all.' },
        format: FORMAT('where, when, state and the counts', 'each slot, the slot types, who runs it (role only) and the reason for a change too'),
        limit: LIMIT(50, 500, 'sessions') } },
      output: { type: 'object', required: ['asOf', 'synthetic', 'from', 'to', 'sessions', 'total', 'truncated'], properties: {
        asOf: TIME, synthetic: SYNTHETIC, from: { type: 'string' }, to: { type: 'string' }, total: TOTAL, truncated: TRUNCATED, sessions: { type: 'array', items: SESSION_OUT } } },
      async run(core, input) {
        const c = await ctx(core);
        const from = input.from ?? localDate(c.now, c.offsetMinutes);
        const to = input.to ?? addDays(from, 7);
        if (!validDate(from) || !validDate(to)) throw invalid('from and to must be real dates, as YYYY-MM-DD.');
        if (to < from) throw invalid('to is before from.');
        if (to > addDays(from, MAX_RANGE_DAYS)) throw invalid(`Ask for at most ${MAX_RANGE_DAYS} days at a time.`);
        if (input.placeId && !c.entities.has(input.placeId)) throw new CommandError('not-found', 'No place with that id. Use a site, building, department or ward id, for example dept-outpatients.');
        const mine = [...c.d.sessions.values()].filter((s) => s.date >= from && s.date <= to && (!input.sessionType || s.sessionType === input.sessionType)
          && (!input.placeId || s.placeId === input.placeId || s.assetId === input.placeId) && (!input.state || s.state === input.state) && (!input.service || s.service === input.service))
          .sort((a, b) => a.startMs - b.startMs || (a.id < b.id ? -1 : 1));
        const cut = page(mine, input.limit, 50);
        return { asOf: c.now, synthetic: await isSynthetic(core), from, to, sessions: cut.items.map((s) => sessionOut(c, s, input.format === 'short')), total: cut.total, truncated: cut.truncated };
      },
      example: { input: {} },
    },
    {
      name: 'ospeli_slots_appointments',
      summary: 'The appointments of one session, in slot or visit order, or every appointment of one patient code: state, the times of each step, minutes waited since arriving and whether it is overdue. Codes and picks only: no name or other personal detail is held. Read-only.',
      kind: 'read', roles: ALL_ROLES, approval: false,
      input: { type: 'object', additionalProperties: false, properties: {
        sessionId: { ...SESSION_ID, description: 'The session whose appointments to list. Send this or code.' },
        code: { ...CODE, description: 'A patient code, for example pc-00001: every appointment made for it. Send this or sessionId.' },
        state: { type: 'string', enum: ['open', ...Object.keys(APPOINTMENT_STATES), 'all'], description: 'open means booked, arrived or called. Default: all.' },
        limit: LIMIT(100, 500, 'appointments') } },
      output: { type: 'object', required: ['asOf', 'synthetic', 'appointments', 'counts', 'total', 'truncated'], properties: {
        asOf: TIME, synthetic: SYNTHETIC, total: TOTAL, truncated: TRUNCATED, appointments: { type: 'array', items: APPOINTMENT_OUT },
        counts: { type: 'object', description: 'How many appointments are in each state, for the same session or code, before the state filter and the limit.' } } },
      wardOf: everyWard,
      async run(core, input, { actor } = {}) {
        if ((input.sessionId == null) === (input.code == null)) throw invalid('Send sessionId (one session\'s list) or code (one patient code\'s appointments): one of them.', { example: { sessionId: 'ses-00001' } });
        const c = await ctx(core);
        let mine;
        if (input.sessionId) {
          const s = sessionOr404(c, input.sessionId);
          const now = appointmentsOf(c.d, s.id);
          // A cancelled booking sits where it was booked; the order is slot or visit order, then the id.
          mine = now.sort((a, b) => (s.timed ? (a.slotTime < b.slotTime ? -1 : a.slotTime > b.slotTime ? 1 : 0) : a.visitOrder - b.visitOrder) || (a.id < b.id ? -1 : 1));
        } else {
          if (!codeState(c.d, input.code)) throw new CommandError('not-found', 'No patient code with that id has been opened.');
          mine = [...c.d.appointments.values()].filter((a) => a.code === input.code).sort((a, b) => (dueMs(c.d, a) ?? 0) - (dueMs(c.d, b) ?? 0));
        }
        const counts = {};
        for (const a of mine) counts[a.state] = (counts[a.state] || 0) + 1;
        const state = input.state || 'all';
        const pick = mine.filter((a) => state === 'all' || (state === 'open' ? isOpenAppointment(a) : a.state === state));
        const cut = page(pick, input.limit, 100);
        return { asOf: c.now, synthetic: await isSynthetic(core), appointments: cut.items.map((a) => appointmentOut(c, a, actor?.role)), counts, total: cut.total, truncated: cut.truncated };
      },
      example: { input: { sessionId: 'ses-00001' }, needs: 'A session. ses-00001 is an example id: ospeli_slots_sessions lists the sessions with their ids, and ospeli_slots_session_plan plans one.' },
    },
    write({
      verb: 'session_plan', roles: union('planRoles'), target: null,
      summary: 'Plan one session: a type, a place, a date and who runs it (a role, never a person). From a template (send templateId) it takes the template\'s start, length and slots as they stand on that date; a later change to the template never rewrites it. Without a template, send start and minutes, and slotMinutes for timed slots or capacity for a visit order. The same session planned twice answers with the first.',
      required: ['sessionType', 'date', 'runByRole'],
      properties: { sessionType: SESSION_TYPE, ...SERVICE, placeId: PLACE, assetId: ASSET, date: DATE('The day of the session.'), start: HHMM('When it starts. Leave out with a templateId.'), minutes: { ...MINUTES, description: `${MINUTES.description} Leave out with a templateId.` },
        slotMinutes: { ...SLOT_MINUTES, description: `${SLOT_MINUTES.description} Only for a one-off session with timed slots and no template.` }, slotTypes: { ...SLOT_TYPES_IN, description: 'Only without a template: the slot types this session offers. Leave out to offer every type.' },
        capacity: CAPACITY, runByRole: { type: 'string', enum: union('runByRoles'), description: 'The role that runs the session, one of the type\'s runByRoles (ospeli_slots_types). A role, never a person.' },
        templateId: { ...TEMPLATE_ID, description: 'The template to plan from. The date must fall on the template\'s weekday.' } },
      example: { input: planExample },
    }),
    write({
      verb: 'session_change', roles: union('planRoles'), target: (input) => ({ id: input.sessionId, word: 'session' }),
      summary: 'Change a planned session: "held" records that it ran (on or after its day; refused while any patient has no final status, and the answer lists each one with what can be done), "reduced" makes it smaller with a reason (a smaller capacity, or free slots taken out; never below what is booked), "cancelled" ends it with a reason, "released" opens a session planned from a not-released template for booking. Cancel is refused while any booking is still open, and the answer lists them, so nobody vanishes from a list. Held and cancelled are final.',
      required: ['sessionId', 'change'],
      properties: { sessionId: SESSION_ID, change: { type: 'string', enum: ['held', 'reduced', 'cancelled', 'released'], description: 'held: it ran. reduced: fewer places. cancelled: it will not run. released: open it for booking.' },
        reason: { type: 'string', enum: reasons.sessionChange, description: `Needed for reduced and cancelled: ${reasons.sessionChange.join(', ')}.` },
        capacity: { ...CAPACITY, description: 'For reduced, a session with a visit order: the new, smaller capacity. Never below the number booked.' },
        removeSlotTimes: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'string', pattern: HHMM_PATTERN, maxLength: 5 }, description: 'For reduced, a session with timed slots: the free slots to take out, for example ["10:00", "10:20"]. A booked slot cannot be taken out.' },
        expectedState: EXPECTED(SESSION_STATE, 'session') },
      example: { input: { sessionId: 'ses-00001', change: 'reduced', reason: reasons.sessionChange[0], ...(firstTimed ? { removeSlotTimes: ['10:00'] } : { capacity: 4 }) }, needs: `${NEED_SESSION} For this example it must have a free slot at 10:00 (or, for a visit order, a capacity above 4 with no more than 4 booked).` },
    }),
    write({
      verb: 'book', roles: union('bookRoles'), target: (input) => ({ id: `${input.sessionId}:${input.slotTime ?? input.visitOrder ?? ''}`, word: 'slot' }),
      summary: 'Book a patient code into a free place in a session: a slot time for timed slots, or a place in the visit order (with an area from the list) for a round. Refused if the place is taken, the session is full, not released, held or cancelled, or the code was never opened. The same booking sent twice answers with the first and writes nothing. It holds a code, a time and picks: no name, no reason for the visit, no urgency.',
      required: ['sessionId', 'code', 'slotType', 'bookedFrom'],
      properties: { sessionId: SESSION_ID, slotTime: SLOT_TIME, visitOrder: VISIT_ORDER,
        area: { type: 'string', pattern: AREA_PATTERN, maxLength: 20, description: 'Only for a type of session with areas (ospeli_slots_types): pick one zone code from its list, for example "North 2". Never an address.' },
        code: CODE, slotType: SLOT_TYPE, bookedFrom: { type: 'string', enum: BOOKED_FROM, description: `How the booking came about: ${BOOKED_FROM.join(', ')}.` },
        rebookOf: { ...APPOINTMENT_ID, description: 'Only when this booking replaces a cancelled or missed appointment of the same code: that appointment\'s id. One rebook per appointment.' },
        requestRef: REF },
      example: { input: { sessionId: 'ses-00001', ...(first.timed ? { slotTime: '09:00' } : { visitOrder: 1, ...(first.areas ? { area: first.areas[0] } : {}) }), code: 'pc-00001', slotType: slotTypeIds[0] ?? 'none', bookedFrom: BOOKED_FROM[0] },
        needs: `${NEED_SESSION} And an open patient code: pc-00001 is an example.` },
    }),
    write({
      verb: 'move', roles: union('bookRoles'), target: (input) => ({ id: input.appointmentId, word: 'appointment' }),
      summary: 'Move a booked appointment to a free place in the same session or another session of the same type. It keeps its id and stays booked. Refused once the patient has arrived, or if the place is taken.',
      required: ['appointmentId', 'sessionId'],
      properties: { appointmentId: APPOINTMENT_ID, sessionId: { ...SESSION_ID, description: 'The session to move it into (it may be the one it is in). ospeli_slots_sessions lists the sessions with their free slots.' },
        slotTime: SLOT_TIME, visitOrder: VISIT_ORDER, expectedState: EXPECTED(APPOINTMENT_STATE, 'appointment') },
      example: { input: { appointmentId: 'apt-00001', sessionId: 'ses-00001', ...(first.timed ? { slotTime: '09:20' } : { visitOrder: 2 }) }, needs: `${NEED_APPOINTMENT} And a free place to move it to: ospeli_slots_sessions shows the free slots.` },
    }),
    write({
      verb: 'cancel', roles: [...union('bookRoles'), ...union('stepRoles').filter((r) => !union('bookRoles').includes(r))], // the roles that may cancel for any reason first target: (input) => ({ id: input.appointmentId, word: 'appointment' }),
      summary: `Cancel a booked appointment, by the site or by the patient, with a reason from the list; its place becomes free. Once the patient has arrived the only cancel is by the patient with the reason "${LEFT_REASON}", so the list never holds someone who has gone. A finished or missed appointment cannot be cancelled. The same cancel sent twice answers done.`,
      required: ['appointmentId', 'by', 'reason'],
      properties: { appointmentId: APPOINTMENT_ID, by: { type: 'string', enum: CANCEL_BY, description: 'Who cancelled: site or patient.' },
        reason: { type: 'string', enum: reasons.appointmentCancel, description: `Pick one: ${reasons.appointmentCancel.join(', ')}.` }, expectedState: EXPECTED(APPOINTMENT_STATE, 'appointment') },
      example: { input: { appointmentId: 'apt-00001', by: 'patient', reason: reasons.appointmentCancel[0] }, needs: NEED_APPOINTMENT },
    }),
    write({
      verb: 'step', roles: union('stepRoles'), target: (input) => ({ id: input.appointmentId, word: 'appointment' }),
      summary: `Mark one step of an appointment: arrived, then called, then finished, in that order; or no-show, with a reason, only for a patient who never arrived and only after the booked time plus the grace (an example setting, not a standard; for a booking made or moved into a time already past, the grace counts from that booking or move). "seen-no-times" closes a patient who arrived and was seen but was not tapped through, from their booked time on: attended and finished with no call or finish time, left out of the waiting, start and overrun figures, which say how many. Each step is written once with its time; the same step sent twice answers done and writes nothing. No clinical step and no outcome is recorded.`,
      required: ['appointmentId', 'step'],
      properties: { appointmentId: APPOINTMENT_ID, step: { type: 'string', enum: ['arrived', 'called', 'finished', 'no-show', 'seen-no-times'], description: `arrived: the patient is here. called: called in from the wait. finished: the visit is over, tapped at the time it ended. no-show: never arrived. seen-no-times: "${NO_TIMES_NAME}", for a patient who was seen but not tapped through.` },
        reason: { type: 'string', enum: reasons.noShow, description: `Only for no-show, and needed then: ${reasons.noShow.join(', ')}.` }, expectedState: EXPECTED(APPOINTMENT_STATE, 'appointment') },
      example: { input: { appointmentId: 'apt-00001', step: 'arrived' }, needs: NEED_APPOINTMENT },
    }),
    write({
      verb: 'step_correct', roles: union('stepRoles'), people: true, target: (input) => ({ id: input.appointmentId, word: 'appointment' }),
      summary: 'Undo a step marked by mistake. Undo "arrived": back to booked, only before the patient is called in. Undo "called": back to arrived, keeping the arrival time, only before finished. Undo "no-show" (a missed appointment): back to booked, only on the same day and before the session is marked held. Nothing is erased: the wrong step and the undo both stay in the log with the time and the role, and every figure is worked out again. Once the session is held, steps can no longer be corrected. People only.',
      required: ['appointmentId', 'undo'],
      properties: { appointmentId: APPOINTMENT_ID, undo: { type: 'string', enum: Object.keys(UNDO_STEPS), description: 'The step to undo, which must be the state the appointment is in now: arrived, called or no-show.' },
        reason: { type: 'string', enum: UNDO_REASONS, description: `Optional pick. Default: "${UNDO_REASON_DEFAULT}". "Patient arrived late" is for undoing a missed appointment only.` }, expectedState: EXPECTED(APPOINTMENT_STATE, 'appointment') },
      example: { input: { appointmentId: 'apt-00001', undo: 'arrived' }, needs: 'An appointment marked arrived by mistake and not yet called in. apt-00001 is an example id: ospeli_slots_appointments with a sessionId lists a session\'s appointments.' },
    }),
    write({
      verb: 'reminder_record', roles: union('bookRoles'), target: (input) => ({ id: input.appointmentId, word: 'appointment' }),
      summary: 'Record the answer to a reminder a person gave by their own means: confirmed, cancelled or no reply. Ospeli sends no messages and holds no phone number. A reply never changes the appointment: if the patient cancelled, cancel it with ospeli_slots_cancel.',
      required: ['appointmentId', 'reply'],
      properties: { appointmentId: APPOINTMENT_ID, reply: { type: 'string', enum: REMINDER_REPLIES, description: 'What came back: confirmed, cancelled or no-reply.' } },
      example: { input: { appointmentId: 'apt-00001', reply: 'confirmed' }, needs: NEED_APPOINTMENT },
    }),
  ];
  if (firstTimed) {
    list.push(write({
      verb: 'template_set', roles: ALL_ROLES.filter((r) => types.some((t) => t.timed && t.planRoles.includes(r))), people: true, target: null,
      summary: 'Set the weekly pattern for a session with timed slots: the weekday, start, length, slot length, slot types and whether its sessions open for booking at once ("released"). Leave templateId out for a new template; send it to change one from a date ("from") onwards. Sessions already planned keep the slots they were planned with. People only.',
      required: ['sessionType', 'placeId', 'weekday', 'start', 'minutes', 'slotMinutes', 'slotTypes', 'released', 'from'],
      properties: { templateId: { ...TEMPLATE_ID, description: 'Only to change a template: its id. Leave out to make a new one.' },
        sessionType: { type: 'string', enum: types.filter((t) => t.timed).map((t) => t.id), description: 'The type of session, one with timed slots.' }, ...SERVICE, placeId: PLACE,
        weekday: { type: 'integer', minimum: 1, maximum: 7, description: 'The day of the week: 1 is Monday, 7 is Sunday.' }, start: HHMM('When the session starts.'), minutes: MINUTES, slotMinutes: SLOT_MINUTES,
        slotTypes: SLOT_TYPES_IN, released: { type: 'boolean', description: 'true: sessions planned from this template are open for booking at once. false: each is planned "not released" until a planner releases it.' },
        from: DATE('The first date this version applies to.') },
      example: { input: { sessionType: firstTimed.id, ...(firstTimed.services ? { service: Object.keys(firstTimed.services)[0] } : {}), placeId: 'dept-outpatients', weekday: 1, start: '09:00', minutes: 80, slotMinutes: 20, slotTypes: [slotTypeIds[0] ?? 'none'], released: true, from: '2026-11-09' } },
    }));
  }
  return list;
}
