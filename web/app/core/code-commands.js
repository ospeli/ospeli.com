// Commands for the shared patient code with a stage timeline (core/codes.js). One set for every
// module that follows an episode by a reference code: a module adds its kinds of episode as
// configuration (CODE_KINDS) and gets these commands, the audit entries and the agent rules
// without writing them again. No kind of episode, no commands.
//
// People decide, Ospeli suggests: an agent may read; anything it asks to change waits as a
// proposal for a person and is checked again when the person accepts. A due-by date is set by
// a person only, never by a rule or an agent. Codes are site-wide, so only an agent that is
// allowed on every ward of the site may read them or propose a change.
// Operations only: a code Ospeli makes, a service from a list, a place and picks. No field takes
// typed text, a name, a date of birth, a record number, a reason for the visit or an urgency,
// and no command takes a code typed in from another system to open an episode.
// The same step sent again (a double tap, a resend after a lost answer) answers done and writes nothing.

import {
  CommandError, ALL_ROLES, ID, TIME, SYNTHETIC, LIMIT, TOTAL, TRUNCATED, page, WRITE_STATUS, PROPOSAL_OUT, EVENT_SEQS, isSynthetic, MIN,
} from './kit.js';
import { roleById, currentWords } from './model.js';
import { deriveSlots, SLOT_EVENT_TYPES } from './slots.js';
import {
  CODE_ID_PATTERN, ANY_CODE_PATTERN, ENCOUNTER_ID_PATTERN, DATE_PATTERN, STAGE_ID_PATTERN, CODE_STATES, CODE_SOURCES, ERROR_REASON, LINK_RELATIONS, MAX_LINKS,
  CODE_EVENT_TYPES, BED_STAGE_EVENT_TYPES, codeCatalogue, deriveCodes, validDate, localDate, codeLabel, stageAllowed, nextStages, nextCodeId,
  appointmentsByCode, attendanceOf, waitingDays, isOverdue, timelineOf,
} from './codes.js';

const REPEAT = 2 * MIN; // the same opening again within this time is a double tap unless the caller says otherwise
const PLACE_KINDS = ['site', 'building', 'department', 'ward', 'bed'];
const roleNames = (ids) => ids.map((r) => roleById(r)?.name || r).join(', ');
const READ_TYPES = [...new Set([...CODE_EVENT_TYPES, ...SLOT_EVENT_TYPES])];

// The commands for one catalogue of kinds. commands.js calls this once with the modules' packs;
// tests call it with their own.
export function codeCommands(packs = []) {
  const catalogue = codeCatalogue(packs, ALL_ROLES);
  const { kinds, closeReasons } = catalogue;
  const all = [...kinds.values()];
  if (!all.length) return [];
  const kindIds = all.map((k) => k.id);
  const serviceWords = Object.assign({}, ...all.map((k) => k.services));
  const serviceIds = Object.keys(serviceWords);
  const stageIds = [...new Set(all.flatMap((k) => [...k.stages.keys()]))];
  const union = (...lists) => ALL_ROLES.filter((r) => all.some((k) => lists.some((l) => (k[l] || []).includes(r))));
  const stageRolesOf = (k, s) => s?.roles || k.stageRoles;
  const anyStageRoles = ALL_ROLES.filter((r) => all.some((k) => k.stageRoles.includes(r) || [...k.stages.values()].some((s) => s.roles?.includes(r))));
  const first = all[0];
  const firstService = Object.keys(first.services)[0];
  const firstStaged = all.find((k) => [...k.stages.values()].some((s) => s.id !== k.openStage)) || null;
  const dueKinds = all.filter((k) => k.dueBy);
  const linkKinds = all.filter((k) => k.links);

  const CODE = { type: 'string', pattern: CODE_ID_PATTERN, maxLength: 20, description: 'A patient code Ospeli made, for example pc-00001: from ospeli_codes_list, or the answer of ospeli_codes_open. Never a name, a record number or a date of birth.' };
  const KIND = { type: 'string', enum: kindIds, description: `The kind of episode: ${all.map((k) => `${k.id} (${k.word})`).join(', ')}. ospeli_codes_kinds lists each with its services, stages and roles.` };
  const SERVICE = { type: 'string', enum: serviceIds, description: `The service, picked from the site's list: ${serviceIds.map((id) => `${id} (${serviceWords[id]})`).join(', ')}. Each kind of episode has its own list (ospeli_codes_kinds).` };
  const SOURCE = { type: 'string', enum: Object.keys(CODE_SOURCES), description: `How the episode began: ${Object.keys(CODE_SOURCES).join(', ')}.` };
  const PLACE = { ...ID, description: 'Optional: where the episode sits, a site, building, department, ward or bed id, for example dept-outpatients.' };
  const STAGE = { type: 'string', enum: stageIds.length ? stageIds : ['none'], description: `The stage reached: ${stageIds.join(', ') || 'no kind of episode has stages'}. Each kind has its own stages and order (ospeli_codes_kinds); ospeli_codes_get lists the stages that may come next for one code.` };
  const STATE = { type: 'string', enum: Object.keys(CODE_STATES) };
  const NULLABLE = (t) => ({ type: [t, 'null'] });
  const EXPECTED_STAGE = { type: ['string', 'null'], pattern: STAGE_ID_PATTERN, maxLength: 42, description: 'The stage the caller last saw on this code (null: none yet). If the code has moved on since, the command is refused (conflict). The same step sent twice still answers done.' };

  // ---- reading the record ----
  async function ctx(core, events, { bed = false } = {}) {
    const [evs, ents] = await Promise.all([events ?? core.events({ type: bed ? [...READ_TYPES, ...BED_STAGE_EVENT_TYPES] : READ_TYPES }), core.listEntities()]);
    const offsetMinutes = ents.find((e) => e.type === 'site' && e.utcOffsetMinutes != null)?.utcOffsetMinutes ?? 0;
    const now = core.now();
    // Appointments are read as the log has them: packs: [] replays every type of session as written.
    const slots = deriveSlots(evs, { packs: [], offsetMinutes });
    return { core, events: evs, now, offsetMinutes, today: localDate(now, offsetMinutes), entities: new Map(ents.map((e) => [e.id, e])), d: deriveCodes(evs, { catalogue }), slots, index: appointmentsByCode(slots) };
  }
  // A place this site does not have has no name: the id is never handed back as one (an imported
  // file could put words there).
  const placeName = (c, id) => { const p = id ? c.entities.get(id) : null; return p ? currentWords(p.name) : null; };
  const ev = (type, subject, role, at, data = null) => ({ type, subject, actorRole: role, at, data });
  const invalid = (why, detail = null) => new CommandError('invalid-input', why, detail);
  const conflict = (why, detail = null) => new CommandError('conflict', why, detail);
  const kindOf = (id) => {
    const k = kinds.get(id);
    if (!k) throw conflict('This kind of episode is not set up on this site.');
    return k;
  };
  function may(roles, role, doing, word) {
    if (role && !roles.includes(role)) throw new CommandError('forbidden', `${roleById(role)?.name || 'This role'} cannot ${doing} ${word}. That is for: ${roleNames(roles)}.`, { roles });
  }
  const a = (word) => `${/^[aeiou]/i.test(word) ? 'an' : 'a'} ${word.toLowerCase()}`;
  function codeOr404(c, id) {
    const code = c.d.codes.get(id);
    if (!code) throw new CommandError('not-found', 'No patient code with that id has been opened. ospeli_codes_list lists the open codes.');
    return code;
  }
  function openCode(c, id, expectedStage) {
    const code = codeOr404(c, id);
    if (code.state === 'closed') throw conflict('This code is closed. A new referral or a new episode is a new code (ospeli_codes_open).', { state: 'closed' });
    if (expectedStage !== undefined && (code.stage ?? null) !== expectedStage) throw conflict('This code changed since you opened it. Read it again.', { stage: code.stage });
    return code;
  }
  function placeFor(c, kind, placeId) {
    if (placeId == null) return null;
    const p = c.entities.get(placeId);
    if (!p || !PLACE_KINDS.includes(p.type)) throw new CommandError('not-found', 'No place with that id. Use a site, building, department, ward or bed id, for example dept-outpatients.');
    if (!kind.placeTypes.includes(p.type)) throw invalid(`${a(kind.word).replace(/^./, (x) => x.toUpperCase())} sits in a ${kind.placeTypes.join(' or ')}, not a ${p.type}.`, { placeTypes: kind.placeTypes });
    return p.id;
  }

  // ---- what each write decides: refuse (throw), or { out, events, audit } ----
  // `events: []` means the same thing was already done: the answer is done and nothing is written.
  const DECIDE = {
    open(c, input, role) {
      const kind = kindOf(input.kind);
      may(kind.openRoles, role, 'open', a(kind.word));
      if (!kind.services[input.service]) throw invalid(`${a(kind.word).replace(/^./, (x) => x.toUpperCase())} is for one of: ${Object.keys(kind.services).join(', ')}.`, { services: Object.keys(kind.services) });
      if (!kind.sources.includes(input.source)) throw invalid(`${a(kind.word).replace(/^./, (x) => x.toUpperCase())} begins from: ${kind.sources.join(', ')}.`, { sources: kind.sources });
      const placeId = placeFor(c, kind, input.placeId);
      // A double tap would open a second code for the same person, and two codes can never be
      // matched afterwards. So the same opening by the same role within two minutes asks first.
      if (input.again !== true) {
        const t = Date.parse(c.now);
        for (let i = c.events.length - 1; i >= 0; i--) {
          const e = c.events[i];
          if (t - Date.parse(e.at) >= REPEAT) break;
          if (e.type === 'code.opened' && e.actorRole === role && e.data?.kind === kind.id && e.data?.service === input.service && e.data?.source === input.source && (e.data?.placeId ?? null) === placeId) {
            throw conflict(`${codeLabel(e.subject)} was opened for the same service a moment ago, so no second code was made. If this really is another patient, send it again with again: true.`, { confirm: 'again', code: e.subject });
          }
        }
      }
      const code = nextCodeId(c.events);
      const data = { kind: kind.id, service: input.service, source: input.source, ...(placeId ? { placeId } : {}) };
      const events = [ev('code.opened', code, role, c.now, data)];
      if (kind.openStage) events.push(ev('code.stage', code, role, c.now, { stage: kind.openStage, ...(placeId ? { placeId } : {}) }));
      return { out: { code, label: codeLabel(code), state: 'open', stage: kind.openStage }, events, audit: ['code.opened', code, { kind: kind.id, service: input.service, source: input.source }] };
    },

    stage(c, input, role) {
      const peek = codeOr404(c, input.code);
      const kind = kindOf(peek.kind);
      const s = kind.stages.get(input.stage);
      if (!s) throw invalid(`${input.stage} is not a stage of ${a(kind.word)}. Its stages: ${[...kind.stages.keys()].join(', ') || 'none'}.`, { stages: [...kind.stages.keys()] });
      may(stageRolesOf(kind, s), role, `mark "${s.word}" on`, a(kind.word));
      const placeId = placeFor(c, kind, input.placeId);
      // Already there (same stage and, when a place was sent, the same place): done, nothing written.
      // Only on an open code: a closed one goes on to openCode and is refused as closed.
      if (peek.state === 'open' && peek.stage === s.id && (placeId == null || peek.placeId === placeId)) return { out: { code: peek.code, state: peek.state, stage: peek.stage }, events: [] };
      const code = openCode(c, input.code, input.expectedStage);
      const ok = stageAllowed(kind, code, s.id);
      if (!ok.ok) {
        const next = nextStages(kind, code).map((x) => x.id);
        throw conflict(code.stage == null
          ? `"${s.word}" cannot be the first stage. First: ${next.join(', ') || 'none'}.`
          : `"${s.word}" does not follow "${kind.stages.get(code.stage)?.word || code.stage}". Next may be: ${next.join(', ') || 'nothing; close the code when the episode ends'}.`, { stage: code.stage, next });
      }
      if (input.appointmentId != null) {
        const appt = c.slots.appointments.get(input.appointmentId);
        if (!appt) throw new CommandError('not-found', 'No appointment with that id.');
        if (appt.code !== code.code) throw invalid('That appointment belongs to another code.');
      }
      const data = { stage: s.id, ...(placeId ? { placeId } : {}), ...(input.appointmentId ? { appointmentId: input.appointmentId } : {}) };
      return { out: { code: code.code, state: 'open', stage: s.id }, events: [ev('code.stage', code.code, role, c.now, data)], audit: ['code.stage', code.code, { stage: s.id, from: code.stage }] };
    },

    due_set(c, input, role) {
      const peek = codeOr404(c, input.code);
      const kind = kindOf(peek.kind);
      if (!kind.dueBy) throw invalid(`${a(kind.word).replace(/^./, (x) => x.toUpperCase())} has no due-by date.`);
      may(kind.dueRoles, role, 'set the due-by date of', a(kind.word));
      if (input.dueBy !== null && !validDate(input.dueBy)) throw invalid('dueBy is not a real date. Use YYYY-MM-DD, for example "2026-12-01", or null to clear it.');
      if (peek.dueBy === input.dueBy && peek.state === 'open') return { out: { code: peek.code, state: 'open', dueBy: peek.dueBy }, events: [] };
      const code = openCode(c, input.code);
      if (input.dueBy !== null && input.dueBy < localDate(code.openedAt, c.offsetMinutes)) throw invalid('dueBy is before the day the code was opened.', { openedOn: localDate(code.openedAt, c.offsetMinutes) });
      return { out: { code: code.code, state: 'open', dueBy: input.dueBy }, events: [ev('code.due-set', code.code, role, c.now, { dueBy: input.dueBy })], audit: ['code.due-set', code.code, { dueBy: input.dueBy }] };
    },

    link(c, input, role) {
      if (input.code === input.otherCode) throw invalid('A code cannot be linked to itself.');
      const x = codeOr404(c, input.code); const y = codeOr404(c, input.otherCode);
      const kx = kindOf(x.kind); const ky = kindOf(y.kind);
      if (!kx.links || !ky.links) throw invalid(`Codes of this kind are not linked: ${!kx.links ? kx.word : ky.word}.`);
      may([...new Set([...kx.stageRoles, ...ky.stageRoles])].filter((r) => kx.stageRoles.includes(r) && ky.stageRoles.includes(r)), role, 'link', 'these codes');
      if (x.links.some((l) => l.otherCode === y.code)) return { out: { code: x.code, state: x.state, otherCode: y.code }, events: [] };
      openCode(c, x.code); openCode(c, y.code);
      if (x.links.length >= MAX_LINKS || y.links.length >= MAX_LINKS) throw conflict(`A code is linked to at most ${MAX_LINKS} others.`);
      return { out: { code: x.code, state: 'open', otherCode: y.code }, events: [ev('code.linked', x.code, role, c.now, { otherCode: y.code, relation: input.relation })], audit: ['code.linked', x.code, { otherCode: y.code, relation: input.relation }] };
    },

    close(c, input, role) {
      const peek = codeOr404(c, input.code);
      const kind = kindOf(peek.kind);
      may(kind.closeRoles, role, 'close', a(kind.word));
      if (peek.state === 'closed') return { out: { code: peek.code, state: 'closed', stage: peek.stage }, events: [] };
      const code = openCode(c, input.code, input.expectedStage);
      // Nobody vanishes from a list: a code with a booking still open is not closed until a
      // person has cancelled or finished each one.
      const open = attendanceOf(c.index, code.code).open;
      if (open.length) throw conflict(`This code still has ${open.length === 1 ? 'an appointment' : `${open.length} appointments`} open (${open.map((x) => x.id).join(', ')}). Cancel or finish ${open.length === 1 ? 'it' : 'each one'} first (ospeli_slots_cancel), then close the code.`, { openAppointments: open.map((x) => x.id) });
      return { out: { code: code.code, state: 'closed', stage: code.stage }, events: [ev('code.closed', code.code, role, c.now, { reason: input.reason })], audit: ['code.closed', code.code, { reason: input.reason, stage: code.stage }] };
    },
  };

  const WRITE_OUT = { type: 'object', required: ['status'], properties: {
    status: WRITE_STATUS, code: CODE, label: { type: 'string', description: 'What to call the code on screen, for example "Patient P12".' }, state: STATE,
    stage: { type: ['string', 'null'], description: 'The stage the code is left at.' }, dueBy: NULLABLE('string'), otherCode: CODE,
    events: { ...EVENT_SEQS, description: 'Sequence numbers of the events written. Empty when the same thing was already done: nothing was written twice.' }, proposal: PROPOSAL_OUT } };
  // Codes are site-wide: an agent may read or propose only if it is allowed on every ward of the site.
  const everyWard = async (core) => (await core.listEntities('ward')).map((w) => w.id);
  function write({ verb, summary, roles, required, properties, target, people = false, example }) {
    return {
      name: `ospeli_codes_${verb}`, summary, kind: 'write', roles, approval: true, ...(people ? { agents: false } : {}),
      input: { type: 'object', additionalProperties: false, required, properties },
      output: WRITE_OUT,
      ...(target ? { target } : {}),
      wardOf: everyWard,
      async snapshot(core, input) {
        const c = await ctx(core);
        return { seenStage: input.expectedStage ?? c.d.codes.get(input.code)?.stage ?? null };
      },
      async precheck(core, input, { actor } = {}) { DECIDE[verb](await ctx(core), input, actor?.role); },
      async run(core, input, { actor }) {
        let res = null;
        const recs = await core.appendChecked(async (evs) => { res = DECIDE[verb](await ctx(core, evs), input, actor.role); return res.events; });
        if (res.audit && recs.length) await core.recordAs(actor, ...res.audit);
        return { status: 'done', ...res.out, events: recs.map((r) => r.seq) };
      },
      example,
    };
  }

  // ---- what the reads answer with ----
  const CODE_OUT = { type: 'object', required: ['code', 'label', 'kind', 'service', 'state'], properties: {
    code: { type: 'string', pattern: ANY_CODE_PATTERN, maxLength: 20 }, label: { type: 'string', description: 'What to call the code on screen, for example "Patient P12". Never a name.' },
    kind: NULLABLE('string'), kindWord: NULLABLE('string'), service: NULLABLE('string'), serviceWord: NULLABLE('string'),
    placeId: NULLABLE('string'), placeName: NULLABLE('string'), source: NULLABLE('string'), state: STATE, stateName: { type: 'string' },
    stage: NULLABLE('string'), stageWord: NULLABLE('string'), stageAt: NULLABLE('string'), openedAt: TIME, closedAt: NULLABLE('string'), closeReason: NULLABLE('string'),
    waitingDays: { type: 'integer', minimum: 0, description: 'Whole days since the code was opened (to its closing, once closed).' },
    dueBy: { type: ['string', 'null'], description: 'A date a person set, YYYY-MM-DD. Never set by a rule.' },
    overdue: { type: 'boolean', description: 'true: open, with a due-by date before today on the site\'s own calendar. Worked out from now; never a stored state.' },
    appointments: { type: 'integer', minimum: 0, description: 'How many appointments were ever booked for this code.' },
    openAppointments: { type: 'array', items: { type: 'string' }, description: 'The ids of its appointments that are booked, arrived or called.' },
    booked: { type: 'boolean', description: 'true: it has an appointment open now.' },
    lastAttendedAt: { type: ['string', 'null'], description: 'When the patient last arrived for an appointment. null: never yet.' },
    linkedCodes: { type: 'array', items: { type: 'string' }, description: 'Codes that move with this one.' },
    nextStages: { type: 'array', items: { type: 'string' }, description: 'The stages that may be marked next.' },
  } };
  function codeOut(c, code) {
    const kind = kinds.get(code.kind) || null;
    const att = attendanceOf(c.index, code.code);
    return { code: code.code, label: codeLabel(code.code), kind: code.kind, kindWord: kind?.word ?? null, service: code.service, serviceWord: kind?.services[code.service] ?? null,
      placeId: code.placeId, placeName: placeName(c, code.placeId), source: code.source, state: code.state, stateName: CODE_STATES[code.state].name,
      stage: code.stage, stageWord: kind?.stages.get(code.stage)?.word ?? null, stageAt: code.stageAt, openedAt: code.openedAt, closedAt: code.closedAt, closeReason: code.closeReason,
      waitingDays: waitingDays(code, c.now), dueBy: code.dueBy, overdue: isOverdue(code, c.today),
      appointments: att.count, openAppointments: att.open.map((x) => x.id), booked: att.open.length > 0, lastAttendedAt: att.lastAttendedAt,
      linkedCodes: code.links.map((l) => l.otherCode), nextStages: code.state === 'open' ? nextStages(kind, code).map((s) => s.id) : [] };
  }
  const TIMELINE_ITEM = { type: 'object', required: ['at', 'source', 'what', 'word'], properties: {
    at: TIME, source: { type: 'string', enum: ['code', 'appointment', 'bed'], description: 'Which record the entry was read from. Each step is written once, in one of them.' },
    what: { type: 'string' }, word: { type: 'string', description: 'The entry in plain words, for example "Referral accepted" or "Arrived".' },
    stage: { type: 'string' }, placeId: NULLABLE('string'), placeName: NULLABLE('string'), appointmentId: NULLABLE('string'), byRole: { type: 'string', description: 'The role that acted. No person is recorded.' },
    dueBy: NULLABLE('string'), otherCode: { type: 'string' }, reason: NULLABLE('string') } };

  const NEED_CODE = 'An open patient code. pc-00001 is an example id: ospeli_codes_list lists the open codes, and ospeli_codes_open makes one.';

  const list = [
    {
      name: 'ospeli_codes_kinds',
      summary: 'The kinds of episode this site follows by a patient code (a referral, a programme), each with its services, the stages in order, how it may begin, and the roles that open, mark stages and close; and the reasons to pick from when closing. Read-only.',
      kind: 'read', roles: ALL_ROLES, approval: false,
      input: { type: 'object', additionalProperties: false, properties: {} },
      output: { type: 'object', required: ['kinds', 'closeReasons'], properties: {
        kinds: { type: 'array', items: { type: 'object', required: ['id', 'word', 'services', 'stages'], properties: {
          id: { type: 'string' }, word: { type: 'string' },
          services: { type: 'array', items: { type: 'object', required: ['id', 'word'], properties: { id: { type: 'string' }, word: { type: 'string' } } } },
          sources: { type: 'array', items: { type: 'string' } }, placeTypes: { type: 'array', items: { type: 'string' } },
          stages: { type: 'array', items: { type: 'object', required: ['id', 'word', 'after'], properties: { id: { type: 'string' }, word: { type: 'string' },
            after: { type: 'array', items: { type: 'string' }, description: 'The stages this one may follow. Empty: it can only be the first stage.' }, roles: { type: 'array', items: { type: 'string' } } } } },
          openStage: { type: ['string', 'null'], description: 'The stage written when a code of this kind is opened.' },
          dueBy: { type: 'boolean', description: 'true: a person may set a due-by date.' }, links: { type: 'boolean', description: 'true: two codes of this kind may be linked to move together.' },
          openRoles: { type: 'array', items: { type: 'string' } }, stageRoles: { type: 'array', items: { type: 'string' } }, closeRoles: { type: 'array', items: { type: 'string' } }, dueRoles: { type: 'array', items: { type: 'string' } } } } },
        closeReasons: { type: 'array', items: { type: 'string' } }, sources: { type: 'array', items: { type: 'string' } },
        note: { type: 'string' } } },
      async run() {
        return {
          kinds: all.map((k) => ({ id: k.id, word: k.word, services: Object.entries(k.services).map(([id, word]) => ({ id, word })), sources: [...k.sources], placeTypes: [...k.placeTypes],
            stages: [...k.stages.values()].map((s) => ({ id: s.id, word: s.word, after: [...s.after], roles: [...stageRolesOf(k, s)] })), openStage: k.openStage, dueBy: k.dueBy, links: k.links,
            openRoles: [...k.openRoles], stageRoles: [...k.stageRoles], closeRoles: [...k.closeRoles], dueRoles: [...k.dueRoles] })),
          closeReasons: [...closeReasons], sources: Object.keys(CODE_SOURCES),
          note: 'A code is one episode. A new referral is a new code: Ospeli cannot and must not know that two codes are the same person.',
        };
      },
      example: { input: {} },
    },
    {
      name: 'ospeli_codes_list',
      summary: 'Patient codes, longest waiting first: the kind of episode, service, stage, whole days waited, whether an appointment is booked, when the patient last attended, and any due-by date a person set. Filter by kind, service, state, not booked or overdue. Codes and picks only: no name or other personal detail is held. Read-only.',
      kind: 'read', roles: ALL_ROLES, approval: false,
      input: { type: 'object', additionalProperties: false, properties: {
        kind: { ...KIND, description: `Only this kind of episode: ${kindIds.join(', ')}.` }, service: { ...SERVICE, description: `Only this service: ${serviceIds.join(', ')}.` },
        state: { type: 'string', enum: ['open', 'closed', 'all'], description: 'Which codes to list: open (still being followed), closed, or all. Default: open.' },
        booked: { type: 'boolean', description: 'false: only codes with no appointment open now (the list to book from). true: only codes with one.' },
        overdue: { type: 'boolean', description: 'true: only open codes whose due-by date has passed.' },
        limit: LIMIT(100, 500, 'codes') } },
      output: { type: 'object', required: ['asOf', 'synthetic', 'codes', 'counts', 'total', 'truncated'], properties: {
        asOf: TIME, synthetic: SYNTHETIC, total: TOTAL, truncated: TRUNCATED, codes: { type: 'array', items: CODE_OUT },
        counts: { type: 'object', description: 'For the same kind and service, before the other filters and the limit: open, closed, notBooked (open with no appointment open) and overdue.' } } },
      wardOf: everyWard,
      async run(core, input) {
        const c = await ctx(core);
        const mine = [...c.d.codes.values()].filter((x) => (!input.kind || x.kind === input.kind) && (!input.service || x.service === input.service));
        const counts = { open: 0, closed: 0, notBooked: 0, overdue: 0 };
        const booked = new Map();
        for (const x of mine) {
          counts[x.state]++;
          const has = attendanceOf(c.index, x.code).open.length > 0;
          booked.set(x.code, has);
          if (x.state === 'open' && !has) counts.notBooked++;
          if (isOverdue(x, c.today)) counts.overdue++;
        }
        const state = input.state || 'open';
        const pick = mine.filter((x) => (state === 'all' || x.state === state) && (input.booked == null || booked.get(x.code) === input.booked) && (input.overdue == null || isOverdue(x, c.today) === input.overdue))
          .sort((x, y) => Date.parse(x.openedAt) - Date.parse(y.openedAt) || (x.code < y.code ? -1 : 1));
        const cut = page(pick, input.limit, 100);
        return { asOf: c.now, synthetic: await isSynthetic(core), codes: cut.items.map((x) => codeOut(c, x)), counts, total: cut.total, truncated: cut.truncated };
      },
      example: { input: {} },
    },
    {
      name: 'ospeli_codes_get',
      summary: 'One patient code with its timeline, oldest first: when it was opened, each stage, each appointment step (booked, arrived, called, finished, missed, cancelled) and, for a stay on the bed board (an enc- id), the bed board\'s own steps. Each step is written once, in one record, and read here together. Read-only.',
      kind: 'read', roles: ALL_ROLES, approval: false,
      input: { type: 'object', additionalProperties: false, required: ['code'], properties: {
        code: { type: 'string', pattern: ANY_CODE_PATTERN, maxLength: 20, description: 'A patient code (pc-00001) from ospeli_codes_list, or a stay\'s id from the bed board (enc-000123).' } } },
      output: { type: 'object', required: ['asOf', 'synthetic', 'code', 'timeline'], properties: {
        asOf: TIME, synthetic: SYNTHETIC, code: CODE_OUT, timeline: { type: 'array', items: TIMELINE_ITEM },
        note: { type: 'string' } } },
      wardOf: everyWard,
      async run(core, input) {
        const stay = new RegExp(ENCOUNTER_ID_PATTERN).test(input.code);
        const c = await ctx(core, null, { bed: stay });
        const tl = timelineOf(c.d, input.code, { index: c.index, events: stay ? c.events : [] }).map((x) => (x.placeId ? { ...x, placeName: placeName(c, x.placeId) } : x));
        let out;
        if (stay) {
          if (!tl.length) throw new CommandError('not-found', 'No stay with that id on the bed board.');
          const last = tl.at(-1);
          const closed = last.what === 'patient.discharged';
          out = { code: input.code, label: codeLabel(input.code), kind: null, kindWord: 'Stay on the bed board', service: null, serviceWord: null, placeId: null, placeName: null, source: null,
            state: closed ? 'closed' : 'open', stateName: CODE_STATES[closed ? 'closed' : 'open'].name, stage: last.what, stageWord: last.word, stageAt: last.at, openedAt: tl[0].at, closedAt: closed ? last.at : null, closeReason: null,
            waitingDays: Math.max(0, Math.floor((Date.parse(closed ? last.at : c.now) - Date.parse(tl[0].at)) / 864e5)), dueBy: null, overdue: false, appointments: 0, openAppointments: [], booked: false, lastAttendedAt: null, linkedCodes: [], nextStages: [] };
        } else out = codeOut(c, codeOr404(c, input.code));
        return { asOf: c.now, synthetic: await isSynthetic(core), code: out, timeline: tl, note: 'A code is one episode. Ospeli cannot and must not know that two codes are the same person.' };
      },
      example: { input: { code: 'pc-00001' }, needs: NEED_CODE },
    },
    write({
      verb: 'open', roles: union('openRoles'), target: null,
      summary: 'Open a patient code for a new episode: a kind, a service from the list and how it began. Ospeli makes the code (pc-00001, shown as "Patient P1"); none can be typed in. A new referral is always a new code: two codes are never matched as one person. It holds no name, no date of birth, no contact and no reason for the visit. The same opening within two minutes asks before making a second code.',
      required: ['kind', 'service', 'source'],
      properties: { kind: KIND, service: SERVICE, source: SOURCE, placeId: PLACE,
        again: { type: 'boolean', description: 'Send true only after the command asked whether this is really another patient (the same kind, service and source was opened a moment ago), and it is.' } },
      example: { input: { kind: first.id, service: firstService, source: first.sources[0] } },
    }),
  ];
  if (stageIds.length) {
    const ex = firstStaged ? [...firstStaged.stages.values()].find((s) => s.id !== firstStaged.openStage) : null;
    list.push(write({
      verb: 'stage', roles: anyStageRoles, target: (input) => ({ id: input.code, word: 'patient code' }),
      summary: 'Mark the stage a patient code has reached. Each kind of episode has its own stages and order; a stage that does not follow the current one is refused, and the answer lists what may come next. Arrived, called and finished are not stages: they are written once, on the appointment (ospeli_slots_step). The same stage sent twice answers done and writes nothing. No clinical step and no outcome is recorded.',
      required: ['code', 'stage'],
      properties: { code: CODE, stage: STAGE, placeId: { ...PLACE, description: 'Optional: where the code is now, if the stage is a move.' },
        appointmentId: { type: 'string', pattern: '^apt-[0-9]{5,}$', maxLength: 20, description: 'Optional: the appointment of this code the stage belongs to.' }, expectedStage: EXPECTED_STAGE },
      example: { input: { code: 'pc-00001', stage: ex?.id ?? stageIds[0] }, needs: `${NEED_CODE} For this example it must be at a stage that "${ex?.word ?? stageIds[0]}" may follow.` },
    }));
  }
  if (dueKinds.length) {
    list.push(write({
      verb: 'due_set', roles: ALL_ROLES.filter((r) => dueKinds.some((k) => k.dueRoles.includes(r))), people: true, target: (input) => ({ id: input.code, word: 'patient code' }),
      summary: 'Set or clear the date by which an open code is due to be seen again. A person sets it, from an interval decided outside Ospeli; no rule and no agent ever sets or changes it. Ospeli only lists what is overdue.',
      required: ['code', 'dueBy'],
      properties: { code: CODE, dueBy: { type: ['string', 'null'], pattern: DATE_PATTERN, maxLength: 10, description: 'The date, as YYYY-MM-DD on the site\'s own calendar, for example "2026-12-01". null clears it.' } },
      example: { input: { code: 'pc-00001', dueBy: '2026-12-01' }, needs: NEED_CODE },
    }));
  }
  if (linkKinds.length) {
    list.push(write({
      verb: 'link', roles: ALL_ROLES.filter((r) => linkKinds.some((k) => k.stageRoles.includes(r))), target: (input) => ({ id: input.code, word: 'patient code' }),
      summary: 'Link two open codes that move together (a mother and a baby). A move of one then offers the same move for the other; Ospeli never makes it. The same link sent twice answers done.',
      required: ['code', 'otherCode', 'relation'],
      properties: { code: CODE, otherCode: { ...CODE, description: 'The other open code, for example pc-00002.' }, relation: { type: 'string', enum: Object.keys(LINK_RELATIONS), description: 'moves-with: the two move together.' } },
      example: { input: { code: 'pc-00001', otherCode: 'pc-00002', relation: 'moves-with' }, needs: 'Two open patient codes of a kind that may be linked. pc-00001 and pc-00002 are example ids.' },
    }));
  }
  list.push(write({
    verb: 'close', roles: union('closeRoles'), target: (input) => ({ id: input.code, word: 'patient code' }),
    summary: `Close a patient code when the episode ends, with a reason from the list ("${ERROR_REASON}" for a code made by mistake). Refused while the code still has an appointment open, and the answer lists them, so nobody vanishes from a list. Closed is final: a new referral is a new code. The same close sent twice answers done.`,
    required: ['code', 'reason'],
    properties: { code: CODE, reason: { type: 'string', enum: closeReasons, description: `Pick one: ${closeReasons.join(', ')}.` }, expectedStage: EXPECTED_STAGE },
    example: { input: { code: 'pc-00001', reason: closeReasons[0] }, needs: `${NEED_CODE} With no appointment still open.` },
  }));
  return list;
}
