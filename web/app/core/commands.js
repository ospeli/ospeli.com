// The command layer (backlog A2): every user action is a named command with input and output
// JSON schemas, the roles allowed to run it and whether an agent's request needs a person's
// approval. The UI calls these commands; so do agents (window.ospeli, later MCP). No logic
// hides in click handlers.
//
// Rules (docs/RULES.md and the agent-ready standing rule):
// - People decide, Ospeli suggests. An agent may read, and may *propose* a change; a proposal
//   is recorded and waits for a person. Agents never write to the event log themselves.
// - Agent access is off by default, for the hospital and for each ward.
// - Every agent read and proposal is in the audit trail with actor type "agent".
// - Nothing leaves the device: commands run against the local core only.

import { validate } from './schema.js';
import { ROLES, roleById } from './model.js';
import { BED_STATES, OUT_OF_SERVICE_REASONS, deriveBoard, bedActions, actionEvents, countStates } from './beds.js';
import { KPIS, kpiById, computeKpi } from './kpi.js';
import {
  PRIORITIES, TEAMS, OUTCOMES, WO_STATES, ALL_FAULTS, faultsFor, teamFor, deriveWorkOrders, nextWorkOrderId,
} from './workorders.js';
import {
  EXAMPLES as MAP_EXAMPLES, VERSIONS as MAP_VERSIONS, MAX_STEPS, MAX_MINUTES, newMap, analyse, suggest, applyChange, personalDetailIn, personNameIn, NAME_ADVICE,
} from './processmap.js';

export class CommandError extends Error {
  constructor(code, message, detail = null) {
    super(message);
    this.name = 'CommandError';
    this.code = code; // invalid-input | unknown-command | forbidden | not-found | conflict | agents-off
    this.detail = detail;
  }
}

const ALL_ROLES = ROLES.map((r) => r.id);
const FLOOR = ['ward-nurse', 'bed-manager'];
const ID = { type: 'string', pattern: '^[a-z0-9][a-z0-9-]*$' };
const STATE = { type: 'string', enum: Object.keys(BED_STATES) };
const TIME = { type: 'string', format: 'date-time' };
const SYNTHETIC = { type: 'boolean', description: 'True while the data on this device is synthetic.' };

// List reads never dump a whole table (tool-design rule, issue #39): each takes a limit, and says
// how many there are in all and whether the answer was cut short. Counts are worked out before the cut.
const LIMIT = (def, max, what) => ({ type: 'integer', minimum: 1, maximum: max, description: `At most this many ${what}. Default ${def}, ${max} at most. "total" and "truncated" in the answer say if there are more.` });
const TOTAL = { type: 'integer', minimum: 0, description: 'How many there are in all, before the limit.' };
const TRUNCATED = { type: 'boolean', description: 'True when the limit cut the list short. Narrow the filters or raise the limit.' };
const FORMAT = (short, detailed) => ({ type: 'string', enum: ['short', 'detailed'], description: `short: ${short}. detailed (default): ${detailed}.` });
const page = (list, limit, def) => ({ items: list.slice(0, limit ?? def), total: list.length, truncated: list.length > (limit ?? def) });
const idsHint = (list, n = 8) => list.slice(0, n).map((x) => x.id).join(', ') + (list.length > n ? ', …' : '');

const BED_STATE_SCHEMA = {
  type: 'object',
  required: ['id', 'name', 'wardId', 'state'],
  properties: {
    id: ID, name: { type: 'string' }, wardId: ID, state: STATE,
    since: { type: ['string', 'null'] }, encounter: { type: ['string', 'null'] },
    expectedAt: { type: ['string', 'null'] }, reason: { type: ['string', 'null'] }, sideRoom: { type: 'boolean' },
  },
};

const WRITE_OUTPUT = {
  type: 'object',
  required: ['status'],
  properties: {
    status: { type: 'string', enum: ['done', 'proposed'] },
    bedId: ID,
    state: STATE,
    events: { type: 'array', items: { type: 'integer' }, description: 'Sequence numbers of the events written.' },
    proposal: { type: 'object', description: 'When an agent asked: the proposal waiting for a person.' },
  },
};

// Bed actions (core/beds.js) and the state each one leaves the bed in.
const BED_WRITES = [
  { action: 'expect-discharge', name: 'ospeli_beds_flag_expected_discharge', to: 'expected-discharge', roles: FLOOR,
    summary: 'Flag that the patient in this bed is expected to go home today.',
    extra: { expectedAt: { ...TIME, description: 'When the patient is expected to leave. Defaults to now.' } } },
  { action: 'cancel-expected', name: 'ospeli_beds_cancel_expected_discharge', to: 'occupied', roles: FLOOR,
    summary: 'Cancel an expected discharge; the patient stays.' },
  { action: 'vacate', name: 'ospeli_beds_mark_vacated', to: 'vacated', roles: FLOOR,
    summary: 'The patient has left: discharge them from the bed and mark it to clean.' },
  { action: 'start-clean', name: 'ospeli_beds_start_clean', to: 'cleaning', roles: FLOOR,
    summary: 'Cleaning of a vacated bed has started.' },
  { action: 'finish-clean', name: 'ospeli_beds_finish_clean', to: 'available', roles: FLOOR,
    summary: 'Cleaning is finished: the bed is ready for the next patient.' },
  { action: 'allocate', name: 'ospeli_beds_allocate', to: 'allocated', roles: ['bed-manager', 'ae-nic', 'ward-nurse'],
    summary: 'Hold an available bed for a patient waiting for a bed.',
    extra: { encounter: { ...ID, description: 'The waiting patient\'s synthetic encounter id (from ospeli_beds_board waiting).' } },
    required: ['encounter'] },
  { action: 'cancel-allocation', name: 'ospeli_beds_cancel_allocation', to: 'available', roles: ['bed-manager', 'ae-nic', 'ward-nurse'],
    summary: 'Release a held bed; the patient goes back on the waiting list.' },
  { action: 'admit', name: 'ospeli_beds_admit', to: 'occupied', roles: FLOOR,
    summary: 'The patient the bed was held for has arrived in it.' },
  { action: 'out-of-service', name: 'ospeli_beds_take_out_of_service', to: 'out-of-service', roles: [...FLOOR, 'estates-tech'],
    summary: 'Take an empty bed out of service, with a reason.',
    extra: { reason: { type: 'string', enum: OUT_OF_SERVICE_REASONS } }, required: ['reason'] },
  { action: 'back-in-service', name: 'ospeli_beds_return_to_service', to: 'available', roles: [...FLOOR, 'estates-tech'],
    summary: 'Put an out-of-service bed back into use.' },
];

export const ACTION_COMMANDS = Object.fromEntries(BED_WRITES.map((w) => [w.action, w.name]));

const bedOut = (b, info) => ({
  id: b.id, name: info.name, wardId: info.parentId, state: b.state, since: b.since, encounter: b.encounter,
  expectedAt: b.expectedAt, reason: b.reason, sideRoom: !!info.sideRoom,
});

async function loadBoard(core, events) {
  const [beds, wards] = await Promise.all([core.listEntities('bed'), core.listEntities('ward')]);
  return { beds, wards, info: new Map(beds.map((b) => [b.id, b])), board: deriveBoard(beds, events ?? await core.events()) };
}

// A wrong ward id says which ids would work. An agent is only told about the wards it may see.
function noWard(wardId, wards, allowed) {
  const can = wards.filter((w) => !allowed || allowed.has(w.id)).map((w) => ({ id: w.id, name: w.name }));
  return new CommandError('not-found', `No ward ${wardId}. ${can.length ? `Use one of: ${idsHint(can)}.` : 'No ward is open to this caller.'}`, { wards: can });
}

async function wardOfBed(core, input) {
  const bed = await core.getEntity(input.bedId);
  return bed?.type === 'bed' ? bed.parentId : null;
}

function bedWriteCommand(w) {
  return {
    name: w.name,
    summary: w.summary,
    kind: 'write',
    roles: w.roles,
    approval: true,
    input: {
      type: 'object', additionalProperties: false, required: ['bedId', ...(w.required || [])],
      properties: {
        bedId: ID,
        ...(w.extra || {}),
        expectedState: { ...STATE, description: 'The state the caller last saw. If the bed has changed since, the command is refused (conflict).' },
      },
    },
    output: WRITE_OUTPUT,
    wardOf: wardOfBed,
    // What a person needs to check an agent's proposal later: the bed state the agent saw.
    async snapshot(core, input) {
      const { board } = await loadBoard(core);
      return { seenState: input.expectedState ?? board.beds.get(input.bedId)?.state ?? null };
    },
    async run(core, input, { actor }) {
      const recs = await core.appendChecked(async (events) => {
        const info = await core.getEntity(input.bedId);
        if (!info || info.type !== 'bed') throw new CommandError('not-found', `No bed ${input.bedId}.`);
        const { board } = await loadBoard(core, events);
        const bed = board.beds.get(info.id);
        if (input.expectedState && bed.state !== input.expectedState) {
          throw new CommandError('conflict', 'This bed changed since you opened it.', { state: bed.state });
        }
        if (!bedActions(bed).includes(w.action)) {
          throw new CommandError('conflict', `A bed that is ${BED_STATES[bed.state].name.toLowerCase()} cannot do that.`, { state: bed.state });
        }
        if (w.action === 'allocate') {
          const wait = board.waiting.find((x) => x.encounter === input.encounter);
          if (!wait) throw new CommandError('conflict', 'That patient is not waiting for a bed.');
          if (wait.allocatedBed) throw new CommandError('conflict', 'That patient already has a bed held.', { bedId: wait.allocatedBed });
        }
        return actionEvents(w.action, bed, info.parentId, actor.role, core.now(), input);
      });
      return { status: 'done', bedId: input.bedId, state: w.to, events: recs.map((r) => r.seq) };
    },
    example: null, // filled below
  };
}

const COMMAND_LIST = [
  {
    name: 'ospeli_beds_board',
    summary: 'Live bed state for every ward (or one ward), the waiting-for-a-bed list and any conflicting events, derived from the event log. To find a free bed for a waiting patient use ospeli_beds_find_free instead: it answers in one short call. Read-only.',
    kind: 'read', roles: ALL_ROLES, approval: false,
    input: { type: 'object', additionalProperties: false, properties: {
      wardId: { ...ID, description: 'One ward, for example ward-a1. Leave out for every ward.' },
      format: FORMAT('ward counts and the waiting list, no bed list', 'every bed too'),
      limit: LIMIT(200, 2000, 'beds') } },
    output: {
      type: 'object', required: ['asOf', 'synthetic', 'wards', 'beds', 'waiting', 'conflicts', 'total', 'truncated'],
      properties: {
        asOf: TIME, synthetic: SYNTHETIC, total: TOTAL, truncated: TRUNCATED,
        wards: { type: 'array', items: { type: 'object', required: ['id', 'name', 'counts'], properties: { id: ID, name: { type: 'string' }, counts: { type: 'object' } } } },
        beds: { type: 'array', items: BED_STATE_SCHEMA },
        waiting: { type: 'array', items: { type: 'object', required: ['encounter', 'decisionAt'], properties: { encounter: ID, wardId: { type: ['string', 'null'] }, decisionAt: TIME, requestedAt: TIME, allocatedBed: { type: ['string', 'null'] } } } },
        conflicts: { type: 'array', items: { type: 'object' }, description: 'Events that were not applied because the bed held someone else.' },
      },
    },
    wardOf: (core, input) => input.wardId ?? null,
    async run(core, input, { wards: allowed }) {
      const { beds, wards, info, board } = await loadBoard(core);
      const keep = (wardId) => (!input.wardId || wardId === input.wardId) && (!allowed || allowed.has(wardId));
      if (input.wardId && !wards.some((w) => w.id === input.wardId)) throw noWard(input.wardId, wards, allowed);
      const wardIds = new Set(wards.map((w) => w.id).filter(keep));
      const all = beds.filter((b) => wardIds.has(b.parentId));
      const cut = input.format === 'short' ? { items: [], total: all.length, truncated: false } : page(all, input.limit, 200);
      return {
        total: cut.total, truncated: cut.truncated,
        asOf: core.now(),
        synthetic: (await core.getMeta('synthetic', false)) === true,
        wards: wards.filter((w) => wardIds.has(w.id)).map((w) => ({
          id: w.id, name: w.name, counts: countStates(beds.filter((b) => b.parentId === w.id).map((b) => board.beds.get(b.id))),
        })),
        beds: cut.items.map((b) => bedOut(board.beds.get(b.id), b)),
        waiting: board.waiting.filter((x) => !x.wardId || wardIds.has(x.wardId) || !allowed),
        conflicts: board.conflicts.filter((c) => wardIds.has(info.get(c.bedId)?.parentId)),
      };
    },
    example: { input: { wardId: 'ward-a1' } },
  },
  {
    name: 'ospeli_beds_get',
    summary: 'One bed: its state and the commands the caller\'s role may run on it next.',
    kind: 'read', roles: ALL_ROLES, approval: false,
    input: { type: 'object', additionalProperties: false, required: ['bedId'], properties: { bedId: ID } },
    output: { type: 'object', required: ['bed', 'next'], properties: { bed: BED_STATE_SCHEMA, next: { type: 'array', items: { type: 'string' } } } },
    wardOf: wardOfBed,
    async run(core, input, { actor }) {
      const { info, board } = await loadBoard(core);
      const b = info.get(input.bedId);
      if (!b) throw new CommandError('not-found', `No bed ${input.bedId}.`);
      const bed = board.beds.get(b.id);
      const next = bedActions(bed).map((a) => ACTION_COMMANDS[a]).filter((n) => commandByName(n).roles.includes(actor.role));
      return { bed: bedOut(bed, b), next };
    },
    example: { input: { bedId: 'ward-a1-bed-01' } },
  },
  {
    name: 'ospeli_beds_find_free',
    summary: 'Find a free bed for a patient who is waiting: the beds that are available now (the ward the patient was requested for first), and who has waited longest. One call instead of reading the whole board. It lists; it does not judge whether a bed suits a patient, and it holds nothing. To hold a bed, a person runs ospeli_beds_allocate (an agent\'s allocate becomes a proposal). Read-only.',
    kind: 'read', roles: ALL_ROLES, approval: false,
    input: { type: 'object', additionalProperties: false, properties: {
      wardId: { ...ID, description: 'Only look on this ward, for example ward-a1. Leave out to look on every ward the caller may see.' },
      forEncounter: { ...ID, description: 'The waiting patient\'s synthetic encounter id, for example enc-000123. Leave out to see who has waited longest.' },
      limit: { type: 'integer', minimum: 1, maximum: 20, description: 'At most this many beds. Default 5, 20 at most. totalFree and truncated say if there are more.' } } },
    output: {
      type: 'object', required: ['asOf', 'synthetic', 'wardsSearched', 'beds', 'totalFree', 'truncated', 'waiting', 'totalWaiting', 'order', 'nextStep', 'note'],
      properties: {
        asOf: TIME, synthetic: SYNTHETIC,
        wardsSearched: { type: 'array', items: { type: 'object', required: ['id', 'name'], properties: { id: ID, name: { type: 'string' } } } },
        beds: { type: 'array', items: { type: 'object', required: ['bedId', 'bedName', 'wardId', 'wardName', 'requestedWard', 'sideRoom'], properties: {
          bedId: ID, bedName: { type: 'string' }, wardId: ID, wardName: { type: 'string' },
          requestedWard: { type: 'boolean', description: 'True when this is the ward the patient was requested for.' },
          sideRoom: { type: 'boolean' }, freeSince: { type: ['string', 'null'], description: 'When the bed became available.' } } } },
        totalFree: { type: 'integer', minimum: 0, description: 'Available beds on the wards searched, before the limit.' }, truncated: TRUNCATED,
        waiting: { type: 'array', description: 'Patients waiting with no bed held: the one asked for, or the three who have waited longest.', items: { type: 'object', required: ['encounter', 'decisionAt', 'waitingMinutes'], properties: {
          encounter: ID, wardId: { type: ['string', 'null'], description: 'The ward requested, if one was.' }, wardName: { type: ['string', 'null'] },
          decisionAt: TIME, waitingMinutes: { type: 'integer', minimum: 0, description: 'Minutes since the decision to admit.' } } } },
        totalWaiting: { type: 'integer', minimum: 0, description: 'Patients waiting with no bed held, in the caller\'s view.' },
        order: { type: 'string', description: 'How the lists are ordered, in words. An order, not a recommendation.' },
        nextStep: { type: ['object', 'null'], description: 'The command that would hold the first listed bed for the first listed patient. A person decides; any listed bed can be used instead.', properties: { command: { type: 'string' }, input: { type: 'object' } } },
        note: { type: 'string' },
      },
    },
    wardOf: (core, input) => input.wardId ?? null,
    size: (out) => ({ returned: out.beds.length, total: out.totalFree }),
    async run(core, input, { wards: allowed }) {
      const { beds, wards, board } = await loadBoard(core);
      if (input.wardId && !wards.some((w) => w.id === input.wardId)) throw noWard(input.wardId, wards, allowed);
      const now = core.now();
      const wardName = new Map(wards.map((w) => [w.id, w.name]));
      const open = wards.filter((w) => (!input.wardId || w.id === input.wardId) && (!allowed || allowed.has(w.id)));
      const openIds = new Set(open.map((w) => w.id));
      // Same view of the waiting list as ospeli_beds_board: an agent sees patients with no ward
      // requested, and patients requested for a ward it may see.
      const queue = board.waiting.filter((x) => !x.allocatedBed && (!allowed || !x.wardId || allowed.has(x.wardId)))
        .sort((a, b) => (a.decisionAt < b.decisionAt ? -1 : 1));
      let patients = queue.slice(0, 3);
      if (input.forEncounter) {
        const one = queue.find((x) => x.encounter === input.forEncounter);
        // The same answer whether the patient does not exist, already has a bed held, or is outside the caller's wards.
        if (!one) throw new CommandError('not-found', `No patient ${input.forEncounter} is waiting for a bed in your view. Leave forEncounter out to see who is waiting.`);
        patients = [one];
      }
      const wanted = patients[0]?.wardId ?? null;
      const free = beds.filter((b) => openIds.has(b.parentId) && board.beds.get(b.id)?.state === 'available')
        .map((b) => ({ b, s: board.beds.get(b.id) }))
        .sort((x, y) => ((y.b.parentId === wanted) - (x.b.parentId === wanted)) || ((x.s.since || '') < (y.s.since || '') ? -1 : (x.s.since || '') > (y.s.since || '') ? 1 : 0) || (x.b.name < y.b.name ? -1 : 1));
      const cut = page(free, input.limit, 5);
      const first = cut.items[0]; const who = patients[0];
      return {
        asOf: now, synthetic: (await core.getMeta('synthetic', false)) === true,
        wardsSearched: open.map((w) => ({ id: w.id, name: w.name })),
        beds: cut.items.map(({ b, s }) => ({ bedId: b.id, bedName: b.name, wardId: b.parentId, wardName: wardName.get(b.parentId) || b.parentId, requestedWard: !!wanted && b.parentId === wanted, sideRoom: !!b.sideRoom, freeSince: s.since ?? null })),
        totalFree: cut.total, truncated: cut.truncated,
        waiting: patients.map((x) => ({ encounter: x.encounter, wardId: x.wardId ?? null, wardName: x.wardId ? wardName.get(x.wardId) || null : null, decisionAt: x.decisionAt, waitingMinutes: Math.max(0, Math.round((Date.parse(now) - Date.parse(x.decisionAt)) / 60000)) })),
        totalWaiting: queue.length,
        order: 'Beds: the ward the first listed patient was requested for comes first, then the bed that has been free longest. Patients: longest wait first. This is an order, not a recommendation.',
        nextStep: first && who ? { command: 'ospeli_beds_allocate', input: { bedId: first.b.id, encounter: who.encounter, expectedState: 'available' } } : null,
        note: 'Ospeli lists free beds; it does not judge whether a bed suits a patient. A person decides, and an agent\'s allocate is a proposal a person accepts or declines.',
      };
    },
    example: { input: { wardId: 'ward-a1', limit: 5 } },
  },
  ...BED_WRITES.map(bedWriteCommand),
  {
    name: 'ospeli_kpi_list',
    summary: 'Every KPI definition: numerator, denominator, exclusions, source standard, owner and target. Use ospeli_kpi_get for a number. Read-only.',
    kind: 'read', roles: ALL_ROLES, approval: false,
    input: { type: 'object', additionalProperties: false, properties: {
      format: FORMAT('id, name, unit and target only', 'the full definition'), limit: LIMIT(50, 200, 'KPIs') } },
    output: { type: 'object', required: ['kpis', 'total', 'truncated'], properties: { kpis: { type: 'array', items: { type: 'object', required: ['id', 'name'] } }, total: TOTAL, truncated: TRUNCATED } },
    async run(core, input) {
      const cut = page(KPIS, input.limit, 50);
      const short = ({ id, name, unit, target }) => ({ id, name, ...(unit != null ? { unit } : {}), ...(target != null ? { target } : {}) });
      return { kpis: cut.items.map((k) => (input.format === 'short' ? short(k) : { ...k })), total: cut.total, truncated: cut.truncated };
    },
    example: { input: {} },
  },
  {
    name: 'ospeli_kpi_get',
    summary: 'Calculate one KPI from the event log, with its definition beside the number.',
    kind: 'read', roles: ALL_ROLES, approval: false,
    input: { type: 'object', additionalProperties: false, required: ['id'], properties: { id: { type: 'string', enum: KPIS.map((k) => k.id) }, days: { type: 'integer', minimum: 1, maximum: 90 } } },
    output: { type: 'object', required: ['id', 'value', 'definition', 'since', 'until', 'synthetic'], properties: { id: { type: 'string' }, value: { type: ['number', 'null'] }, numerator: { type: ['number', 'null'] }, denominator: { type: ['number', 'null'] }, since: TIME, until: TIME, synthetic: SYNTHETIC, definition: { type: 'object' } } },
    async run(core, input) {
      const [events, beds, sites] = await Promise.all([core.events(), core.listEntities('bed'), core.listEntities('site')]);
      const until = core.now();
      const since = new Date(Date.parse(until) - (input.days ?? 7) * 864e5).toISOString();
      const res = computeKpi(input.id, events, { since, until, bedCount: beds.length, utcOffsetMinutes: sites.find((s) => s.utcOffsetMinutes != null)?.utcOffsetMinutes ?? 0 });
      return { id: input.id, value: res.value ?? null, numerator: res.numerator ?? null, denominator: res.denominator ?? null, since, until,
        synthetic: (await core.getMeta('synthetic', false)) === true, definition: { ...kpiById(input.id) } };
    },
    example: { input: { id: 'occupancy' } },
  },
  {
    name: 'ospeli_agents_access',
    summary: 'Whether agents may work on this hospital, and on which wards. Off by default.',
    kind: 'read', roles: ALL_ROLES, approval: false,
    input: { type: 'object', additionalProperties: false, properties: {} },
    output: { type: 'object', required: ['allowed', 'wards'], properties: { allowed: { type: 'boolean' }, wards: { type: 'object', additionalProperties: { type: 'boolean' } } } },
    async run(core) { return agentAccess(core); },
    example: { input: {} },
  },
  {
    name: 'ospeli_agents_set_access',
    summary: 'Switch agent access on or off for the hospital and for each ward. People only.',
    kind: 'write', roles: ['ops-manager', 'coo'], approval: true, agents: false,
    input: { type: 'object', additionalProperties: false, required: ['allowed'], properties: { allowed: { type: 'boolean' }, wards: { type: 'object', additionalProperties: { type: 'boolean' } } } },
    output: { type: 'object', required: ['allowed', 'wards'], properties: { allowed: { type: 'boolean' }, wards: { type: 'object' } } },
    async run(core, input, { actor }) {
      const prev = await agentAccess(core);
      const next = { allowed: input.allowed, wards: { ...prev.wards, ...(input.wards || {}) } };
      await core.updateMeta('agents', (raw) => ({ ...(raw || {}), ...next }));
      if (next.allowed) await core.setMeta('agents-cleared', null);
      await core.recordAs(actor, 'agents.access-changed', null, { from: prev, to: next });
      return next;
    },
    example: { input: { allowed: true, wards: { 'ward-a1': true } } },
  },
];

// The Agents screen (issues #25, #20; spec A9, first step). A person on the operations side puts
// each agent on the site's list: its name, the one role it works for, the wards it may see and an
// end date (90 days at most). An agent that is not on the list, is past its end date or claims
// another role is refused. This is a control and a record, not security: the app runs in one
// browser with no server, so there is no secret key yet. Keys arrive with the site server (A8).
const AGENT_NAME = '^[A-Za-z0-9][A-Za-z0-9 ._-]{1,40}$';
const AGENT_ADMINS = ['ops-manager', 'coo'];
export const MAX_AGENT_DAYS = 90;
const agentKey = (name) => String(name).trim().toLowerCase();
export async function agentList(core) {
  const a = await core.getMeta('agents', null);
  return Array.isArray(a?.registered) ? a.registered : [];
}
const AGENT_RECORD = {
  type: 'object', required: ['name', 'role', 'roleName', 'wards', 'until', 'ended'],
  properties: {
    name: { type: 'string' }, role: ID, roleName: { type: 'string' },
    wards: { type: 'array', items: ID, description: 'Wards this agent may see. It also needs the ward itself to be switched on.' },
    until: TIME, ended: { type: 'boolean', description: 'True once the end date has passed: the agent is refused until a person adds it again.' },
    addedByRole: ID, addedAt: TIME,
  },
};
const publicAgent = (r, now) => ({ name: r.name, role: r.role, roleName: roleById(r.role)?.name || r.role, wards: [...r.wards], until: r.until, ended: Date.parse(r.until) <= Date.parse(now), addedByRole: r.addedByRole, addedAt: r.addedAt });

COMMAND_LIST.push(
  {
    name: 'ospeli_agents_list',
    summary: 'The Agents screen as data: the dial (off or advise), the agents this site allows, and what each agent did in the last 7 days. People only.',
    kind: 'read', roles: ALL_ROLES, approval: false, agents: false,
    input: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      type: 'object', required: ['dial', 'allowed', 'wards', 'agents', 'recent', 'canChange', 'keys'],
      properties: {
        dial: { type: 'string', enum: ['off', 'advise'], description: 'off: agents can do nothing. advise: listed agents may read and propose; a person accepts or declines each proposal.' },
        allowed: { type: 'boolean' }, wards: { type: 'object', additionalProperties: { type: 'boolean' } },
        agents: { type: 'array', items: AGENT_RECORD },
        recent: { type: 'array', items: { type: 'object', required: ['agent', 'lastAt', 'reads', 'proposals', 'refused'], properties: { agent: { type: 'string' }, lastAt: TIME, reads: { type: 'integer' }, proposals: { type: 'integer' }, refused: { type: 'integer' }, onList: { type: 'boolean' } } } },
        canChange: { type: 'boolean', description: 'Whether the caller\'s role may change these settings.' },
        stopped: { type: ['object', 'null'], description: 'When the dial is off because someone pressed stop: when, and the role that pressed it.', properties: { at: TIME, byRole: ID, byRoleName: { type: 'string' } } },
        cleared: { type: ['object', 'null'], description: 'When agents are off because this device\'s data was reset or replaced (reset, a fresh copy or an import): when, how, and the role that did it.', properties: { at: TIME, by: { type: 'string', enum: ['reset', 'import'] }, byRole: ID, byRoleName: { type: 'string' } } },
        keys: { type: 'string', enum: ['none'], description: 'No secret keys in the browser app: agents are named, not verified. Keys arrive with the site server.' },
      },
    },
    async run(core, input, { actor }) {
      const now = core.now();
      const access = await agentAccess(core);
      const list = await agentList(core);
      const since = Date.parse(now) - 7 * 864e5;
      const by = new Map();
      const row = (name, at) => {
        const k = agentKey(name);
        if (!by.has(k)) by.set(k, { agent: name, lastAt: at, reads: 0, proposals: 0, refused: 0, onList: list.some((r) => agentKey(r.name) === k) });
        const r = by.get(k);
        if (at > r.lastAt) r.lastAt = at;
        return r;
      };
      let stopped = null;
      const note = await core.getMeta('agents-cleared', null);
      const cleared = note ? { at: note.at, by: note.by === 'import' ? 'import' : 'reset', byRole: note.byRole, byRoleName: roleById(note.byRole)?.name || note.byRole } : null;
      for (const e of await core.auditLog()) {
        if (e.action === 'agents.stopped') stopped = { at: e.at, byRole: e.actorRole, byRoleName: roleById(e.actorRole)?.name || e.actorRole };
        else if (e.action === 'agents.access-changed' || e.action === 'agents.access-cleared') stopped = null;
        if (e.actorType !== 'agent' || Date.parse(e.at) < since) continue;
        const r = row(e.agent, e.at);
        if (e.action === 'agent.read') r.reads++;
        else if (e.action === 'agent.proposed') r.proposals++;
        else if (e.action === 'agent.refused') r.refused += 1 + (e.detail?.repeats?.count || 0);
      }
      // Refusals collapsed since the last audit row for the same agent, command and reason.
      for (const rec of Object.values((await core.getMeta('agent-refusals', null)) || {})) {
        if (rec.suppressed && Date.parse(rec.last) >= since) { const r = row(rec.agent, rec.last); r.refused += rec.suppressed; }
      }
      return {
        dial: access.allowed ? 'advise' : 'off', ...access,
        agents: list.map((r) => publicAgent(r, now)),
        recent: [...by.values()].sort((a, b) => (a.lastAt < b.lastAt ? 1 : -1)),
        canChange: AGENT_ADMINS.includes(actor.role), keys: 'none', stopped: access.allowed ? null : stopped, cleared: access.allowed ? null : cleared,
      };
    },
    example: { input: {} },
  },
  {
    name: 'ospeli_agents_add',
    summary: 'Put an agent on this site\'s list: its name, the one role it works for, the wards it may see and how many days until it ends (90 at most). Adding a name again replaces its entry. People only.',
    kind: 'write', roles: AGENT_ADMINS, approval: true, agents: false,
    input: {
      type: 'object', additionalProperties: false, required: ['name', 'role', 'days'],
      properties: {
        name: { type: 'string', pattern: AGENT_NAME, description: 'The name the agent gives when it calls, for example night-flow-helper. Not a person\'s name.' },
        role: { type: 'string', enum: ALL_ROLES, description: 'The one role this agent works for. It is refused if it claims another.' },
        wards: { type: 'array', maxItems: 200, items: ID, description: 'Ward ids, for example ["ward-a1"]. Leave empty for an agent that needs no ward data.' },
        days: { type: 'integer', minimum: 1, maximum: MAX_AGENT_DAYS, description: 'Days until the agent stops working. 90 at most; add it again to renew.' },
      },
    },
    output: { type: 'object', required: ['status', 'agent'], properties: { status: { type: 'string', enum: ['done'] }, agent: AGENT_RECORD } },
    async run(core, input, { actor }) {
      const name = input.name.trim();
      if (personNameIn(name) || personNameIn(name, { roleField: true })) throw new CommandError('invalid-input', 'name looks like a person\'s name. Give the agent a name that says what it does, for example night-flow-helper.');
      const wardIds = new Set((await core.listEntities('ward')).map((w) => w.id));
      const wards = [...new Set(input.wards || [])];
      const bad = wards.find((w) => !wardIds.has(w));
      if (bad) throw new CommandError('invalid-input', `There is no ward ${bad}. Wards on this site: ${[...wardIds].slice(0, 8).join(', ')}.`);
      const now = core.now();
      const rec = { name, role: input.role, wards, until: new Date(Date.parse(now) + input.days * 864e5).toISOString(), addedByRole: actor.role, addedAt: now };
      await core.updateMeta('agents', (raw) => ({ ...(raw || {}), registered: [...(Array.isArray(raw?.registered) ? raw.registered : []).filter((r) => agentKey(r.name) !== agentKey(name)), rec] }));
      await core.recordAs(actor, 'agents.agent-added', null, { agent: name, role: rec.role, wards, until: rec.until });
      return { status: 'done', agent: publicAgent(rec, now) };
    },
    example: { input: { name: 'night-flow-helper', role: 'bed-manager', wards: ['ward-a1'], days: 30 } },
  },
  {
    name: 'ospeli_agents_remove',
    summary: 'Take an agent off this site\'s list. It is refused from its next call. Its proposals still waiting are marked so nobody accepts them without looking. People only.',
    kind: 'write', roles: AGENT_ADMINS, approval: true, agents: false,
    input: { type: 'object', additionalProperties: false, required: ['name'], properties: { name: { type: 'string', pattern: AGENT_NAME } } },
    output: { type: 'object', required: ['status', 'name'], properties: { status: { type: 'string', enum: ['done'] }, name: { type: 'string' } } },
    async run(core, input, { actor }) {
      const list = await agentList(core);
      const found = list.find((r) => agentKey(r.name) === agentKey(input.name));
      if (!found) throw new CommandError('not-found', `No agent called ${input.name} is on the list${list.length ? ` (on the list: ${list.map((r) => r.name).slice(0, 8).join(', ')})` : ''}.`);
      await core.updateMeta('agents', (raw) => ({ ...(raw || {}), registered: (raw?.registered || []).filter((r) => agentKey(r.name) !== agentKey(input.name)) }));
      await core.recordAs(actor, 'agents.agent-removed', null, { agent: found.name });
      return { status: 'done', name: found.name };
    },
    example: { input: { name: 'night-flow-helper' } },
  },
  {
    name: 'ospeli_agents_stop_all',
    summary: 'Stop every agent on this site now: the dial goes to off and every ward is switched off. Anyone can stop; only the operations manager or chief operating officer can start again. People only.',
    kind: 'write', roles: ALL_ROLES, approval: true, agents: false,
    input: { type: 'object', additionalProperties: false, properties: {} },
    output: { type: 'object', required: ['status', 'dial', 'wasOn'], properties: { status: { type: 'string', enum: ['done'] }, dial: { type: 'string', enum: ['off'] }, wasOn: { type: 'boolean' } } },
    async run(core, input, { actor }) {
      const prev = await agentAccess(core);
      await core.updateMeta('agents', (raw) => ({ ...(raw || {}), allowed: false, wards: {} }));
      await core.recordAs(actor, 'agents.stopped', null, { from: prev });
      return { status: 'done', dial: 'off', wasOn: prev.allowed };
    },
    example: { input: {} },
  },
);

const PROPOSAL = {
  type: 'object', required: ['id', 'command', 'input', 'agent', 'role', 'at', 'status'],
  properties: {
    id: ID, command: { type: 'string' }, input: { type: 'object' }, agent: { type: 'string' }, role: ID, at: TIME,
    status: { type: 'string', enum: ['pending', 'accepting', 'accepted', 'declined', 'expired'] },
    wardId: { type: ['string', 'null'] }, seenState: { type: ['string', 'null'] },
    decidedAt: TIME, decidedByRole: ID, reason: { type: ['string', 'null'] }, events: { type: 'array', items: { type: 'integer' } },
    canDecide: { type: 'boolean', description: 'Whether the caller\'s role may accept or decline it.' },
    agentOnList: { type: 'boolean', description: 'False when the agent that asked has since been removed or has passed its end date. Check before accepting.' },
  },
};
export const DECLINE_REASONS = ['Not needed', 'Wrong bed or patient', 'Already done', 'Needs a conversation first', 'Other'];

// Proposals queued under an old command name (before issue #39) read back under the new one.
const proposalsOf = async (core) => (await core.proposals()).map((p) => ({ ...p, command: canonicalName(p.command) || p.command }));
async function pendingProposal(core, id) {
  const p = (await proposalsOf(core)).find((x) => x.id === id);
  if (!p) throw new CommandError('not-found', `No proposal ${id}.`);
  if (p.status !== 'pending') throw new CommandError('conflict', `That proposal is already ${p.status}.`, { status: p.status });
  return p;
}
const mayDecide = (p, role) => !!commandByName(p.command)?.roles.includes(role);

// Agent proposals (issue #17, backlog A4): people see what agents asked for, and accept or decline.
COMMAND_LIST.push(
  {
    name: 'ospeli_proposals_list',
    summary: 'Agent proposals and what happened to them. People see every proposal; an agent sees only its own.',
    kind: 'read', roles: ALL_ROLES, approval: false,
    input: { type: 'object', additionalProperties: false, properties: { status: { type: 'string', enum: ['pending', 'accepted', 'declined', 'expired'] }, limit: LIMIT(20, 200, 'proposals, oldest first') } },
    output: { type: 'object', required: ['proposals', 'total', 'truncated'], properties: { proposals: { type: 'array', items: PROPOSAL }, total: TOTAL, truncated: TRUNCATED } },
    async run(core, input, { actor }) {
      let list = await proposalsOf(core);
      if (actor.type === 'agent') list = list.filter((p) => p.agent === actor.agent);
      if (input.status) list = list.filter((p) => p.status === input.status);
      const now = core.now();
      const live = new Set((await agentList(core)).filter((r) => Date.parse(r.until) > Date.parse(now)).map((r) => agentKey(r.name)));
      const cut = page(list, input.limit, 20);
      return { proposals: cut.items.map((p) => ({ ...p, canDecide: actor.type === 'human' && p.status === 'pending' && mayDecide(p, actor.role), agentOnList: live.has(agentKey(p.agent)) })), total: cut.total, truncated: cut.truncated };
    },
    example: { input: { status: 'pending' } },
  },
  {
    name: 'ospeli_proposals_accept',
    summary: 'Accept an agent\'s proposal: its command runs now, as you, against the bed as the agent saw it. People only.',
    kind: 'write', roles: ALL_ROLES, approval: true, agents: false,
    input: { type: 'object', additionalProperties: false, required: ['id'], properties: { id: ID } },
    output: { type: 'object', required: ['status', 'proposal'], properties: {
      status: { type: 'string', enum: ['accepted', 'expired'] }, proposal: PROPOSAL, result: { type: 'object' },
      message: { type: 'string', description: 'Why an expired proposal could not run.' } } },
    async run(core, input, { actor }) {
      const p = await pendingProposal(core, input.id);
      if (!mayDecide(p, actor.role)) throw new CommandError('forbidden', `${roleById(actor.role).name} cannot run ${p.command}.`);
      await core.decideProposal(p.id, actor, { status: 'accepting' });
      const args = { ...p.input };
      if (p.seenState && commandByName(p.command).input.properties.expectedState && !args.expectedState) args.expectedState = p.seenState;
      if (p.seenRevision && commandByName(p.command).input.properties.expectedRevision && !args.expectedRevision) args.expectedRevision = p.seenRevision;
      try {
        const result = await runCommand(core, p.command, args, actor);
        const proposal = await core.decideProposal(p.id, actor, { status: 'accepted', events: result.events || [] });
        return { status: 'accepted', proposal, result };
      } catch (err) {
        if (!(err instanceof CommandError)) throw err;
        const proposal = await core.decideProposal(p.id, actor, { status: 'expired', reason: err.message });
        return { status: 'expired', proposal, message: err.message };
      }
    },
    example: { input: { id: 'prop-0001' } },
  },
  {
    name: 'ospeli_proposals_decline',
    summary: 'Decline an agent\'s proposal, with a reason. Nothing changes. People only.',
    kind: 'write', roles: ALL_ROLES, approval: true, agents: false,
    input: { type: 'object', additionalProperties: false, required: ['id', 'reason'], properties: { id: ID, reason: { type: 'string', enum: DECLINE_REASONS } } },
    output: { type: 'object', required: ['status', 'proposal'], properties: { status: { type: 'string', enum: ['declined'] }, proposal: PROPOSAL } },
    async run(core, input, { actor }) {
      const p = await pendingProposal(core, input.id);
      if (!mayDecide(p, actor.role)) throw new CommandError('forbidden', `${roleById(actor.role).name} cannot decide on ${p.command}.`);
      return { status: 'declined', proposal: await core.decideProposal(p.id, actor, { status: 'declined', reason: input.reason }) };
    },
    example: { input: { id: 'prop-0001', reason: 'Not needed' } },
  },
);

// Engineering (backlog item 7): report a fault, run the work-order queue. Command-first.
const WO_ID = { type: 'string', pattern: '^wo-[0-9]{5}$' };
const WO_SCHEMA = {
  type: 'object', required: ['id', 'assetId', 'title', 'priority', 'state', 'reportedAt', 'dueAt', 'overdue', 'repeat'],
  properties: {
    id: WO_ID, assetId: ID, assetName: { type: 'string' }, locationId: ID, locationName: { type: 'string' },
    title: { type: 'string' }, team: { type: 'string', enum: Object.keys(TEAMS) }, priority: { type: 'string', enum: Object.keys(PRIORITIES) },
    state: { type: 'string', enum: Object.keys(WO_STATES) }, reportedAt: TIME, reportedByRole: { type: 'string' },
    assignedAt: { type: ['string', 'null'] }, completedAt: { type: ['string', 'null'] }, outcome: { type: ['string', 'null'] },
    dueAt: { ...TIME, description: 'Reported time plus the response target for its priority (urgent 4 h, high 24 h, routine 72 h; examples, set locally).' },
    overdue: { type: 'boolean' }, overdueByMinutes: { type: 'integer', minimum: 0, description: 'Minutes past the due time; 0 when not overdue.' }, metSla: { type: ['boolean', 'null'] },
    repeat: { type: 'integer', minimum: 0, description: 'Earlier faults on the same asset in the 30 days before this one. 1 or more is a repeat fault.' },
  },
};
const WO_WRITE_OUTPUT = {
  type: 'object', required: ['status'],
  properties: {
    status: { type: 'string', enum: ['done', 'proposed'] }, workOrderId: WO_ID, state: { type: 'string', enum: Object.keys(WO_STATES) },
    repeat: { type: 'integer', minimum: 0 }, events: { type: 'array', items: { type: 'integer' } },
    proposal: { type: 'object', description: 'When an agent asked: the proposal waiting for a person.' },
  },
};

async function placesById(core) {
  const all = await core.listEntities();
  return new Map(all.filter((e) => ['ward', 'department', 'building', 'site'].includes(e.type)).map((e) => [e.id, e]));
}
const wardOrNull = (place) => (place?.type === 'ward' ? place.id : null);
async function wardOfAsset(core, assetId) {
  const a = await core.getEntity(assetId);
  if (!a || a.type !== 'asset') return null;
  return wardOrNull(await core.getEntity(a.parentId));
}
async function wardOfWorkOrder(core, input) {
  const rep = (await core.events({ type: 'asset.fault-reported' })).find((e) => e.data?.workOrder === input.workOrderId);
  return rep ? wardOfAsset(core, rep.subject) : null;
}

function woOut(w, assets, places, now, short = false) {
  const a = assets.get(w.assetId); const loc = a ? places.get(a.parentId) : null;
  const full = { ...w, assetName: a?.name ?? w.assetId, locationId: a?.parentId ?? null, locationName: loc?.name ?? '',
    overdueByMinutes: w.overdue ? Math.max(0, Math.round((Date.parse(now) - Date.parse(w.dueAt)) / 60000)) : 0 };
  if (!short) return full;
  const { id, assetId, assetName, locationName, title, team, priority, state, reportedAt, dueAt, overdue, overdueByMinutes, repeat } = full;
  return { id, assetId, assetName, locationName, title, team, priority, state, reportedAt, dueAt, overdue, overdueByMinutes, repeat };
}

function workOrderWrite({ name, summary, roles, to, extra, required, build }) {
  return {
    name, summary, kind: 'write', roles, approval: true,
    input: {
      type: 'object', additionalProperties: false, required: ['workOrderId', ...required],
      properties: { workOrderId: WO_ID, ...extra,
        expectedState: { type: 'string', enum: Object.keys(WO_STATES), description: 'The state the caller last saw. If the work order has changed since, the command is refused (conflict).' } },
    },
    output: WO_WRITE_OUTPUT,
    wardOf: wardOfWorkOrder,
    async snapshot(core, input) {
      const w = deriveWorkOrders(await core.events(), core.now()).get(input.workOrderId);
      return { seenState: input.expectedState ?? w?.state ?? null };
    },
    async run(core, input, { actor }) {
      const recs = await core.appendChecked(async (events) => {
        const w = deriveWorkOrders(events, core.now()).get(input.workOrderId);
        if (!w) throw new CommandError('not-found', `No work order ${input.workOrderId}.`);
        if (input.expectedState && w.state !== input.expectedState) throw new CommandError('conflict', 'This work order changed since you opened it.', { state: w.state });
        if (w.state === 'completed') throw new CommandError('conflict', 'This work order is already completed.', { state: w.state });
        return [build(w, input, actor.role, core.now())];
      });
      return { status: 'done', workOrderId: input.workOrderId, state: to, events: recs.map((r) => r.seq) };
    },
  };
}

COMMAND_LIST.push(
  {
    name: 'ospeli_assets_list',
    summary: 'Assets that can have a fault, with where they are and the faults that can be reported for each. Read-only.',
    kind: 'read', roles: ALL_ROLES, approval: false,
    input: { type: 'object', additionalProperties: false, properties: {
      locationId: { ...ID, description: 'A ward, room or other place id, for example ward-a1. Leave out for every place.' },
      format: FORMAT('id, name, kind and place only', 'the faults that can be reported for each asset too'), limit: LIMIT(50, 1000, 'assets') } },
    output: { type: 'object', required: ['locations', 'assets', 'total', 'truncated'], properties: {
      total: TOTAL, truncated: TRUNCATED,
      locations: { type: 'array', items: { type: 'object', required: ['id', 'name', 'type'], properties: { id: ID, name: { type: 'string' }, type: { type: 'string' } } } },
      assets: { type: 'array', items: { type: 'object', required: ['id', 'name', 'kind', 'locationId'], properties: { id: ID, name: { type: 'string' }, kind: { type: 'string' }, locationId: ID, faults: { type: 'array', items: { type: 'string' } } } } } } },
    wardOf: (core, input) => (String(input.locationId || '').startsWith('ward-') ? input.locationId : null),
    async run(core, input, { wards: allowed }) {
      const [assets, places] = await Promise.all([core.listEntities('asset'), placesById(core)]);
      const cut = page(assets.filter((a) => (!input.locationId || a.parentId === input.locationId) && (!allowed || allowed.has(a.parentId))), input.limit, 50);
      const keep = cut.items;
      const locIds = new Set(keep.map((a) => a.parentId));
      return {
        total: cut.total, truncated: cut.truncated,
        locations: [...places.values()].filter((p) => locIds.has(p.id)).map((p) => ({ id: p.id, name: p.name, type: p.type })),
        assets: keep.map((a) => ({ id: a.id, name: a.name, kind: a.kind, locationId: a.parentId, ...(input.format === 'short' ? {} : { faults: faultsFor(a.kind) }) })),
      };
    },
    example: { input: { locationId: 'ward-a1' } },
  },
  {
    name: 'ospeli_workorders_list',
    summary: 'The work-order queue: open (or completed) work orders with priority, team, due time, overdue flag and repeat-fault count, overdue and most urgent first. For "what is overdue on this ward" pass overdue: true and locationId. Read-only.',
    kind: 'read', roles: ALL_ROLES, approval: false,
    input: { type: 'object', additionalProperties: false, properties: {
      state: { type: 'string', enum: ['open', 'completed', 'all'], description: 'open (default) means reported or assigned.' },
      overdue: { type: 'boolean', description: 'true: only open work orders past their due time. Only with state open (the default).' },
      locationId: { ...ID, description: 'A ward, room or other place id, for example ward-a1.' },
      assetId: { ...ID, description: 'One asset, for example asset-a1-sink-1.' },
      format: FORMAT('what, where, priority, team, due time and overdue', 'who reported it, assignment and outcome too'),
      limit: LIMIT(20, 500, 'work orders') } },
    output: { type: 'object', required: ['asOf', 'synthetic', 'workOrders', 'counts', 'total', 'truncated'], properties: {
      asOf: TIME, synthetic: SYNTHETIC, total: TOTAL, truncated: TRUNCATED, workOrders: { type: 'array', items: WO_SCHEMA },
      counts: { type: 'object', required: ['open', 'overdue', 'repeat'], properties: { open: { type: 'integer' }, overdue: { type: 'integer' }, repeat: { type: 'integer' } } } } },
    wardOf: (core, input) => (String(input.locationId || '').startsWith('ward-') ? input.locationId : input.assetId ? wardOfAsset(core, input.assetId) : null),
    async run(core, input, { wards: allowed }) {
      const now = core.now();
      const [events, assetList, places] = await Promise.all([core.events(), core.listEntities('asset'), placesById(core)]);
      const assets = new Map(assetList.map((a) => [a.id, a]));
      const all = [...deriveWorkOrders(events, now).values()]
        .filter((w) => !allowed || allowed.has(assets.get(w.assetId)?.parentId))
        .filter((w) => (!input.assetId || w.assetId === input.assetId) && (!input.locationId || assets.get(w.assetId)?.parentId === input.locationId));
      const open = all.filter((w) => w.state !== 'completed');
      const state = input.state || 'open';
      if (input.overdue && state !== 'open') throw new CommandError('invalid-input', 'overdue: true only works with open work orders. For example { "state": "open", "overdue": true }.', { example: { state: 'open', overdue: true } });
      if (input.locationId && !places.has(input.locationId)) {
        const can = [...places.values()].filter((pl) => !allowed || allowed.has(pl.id)).map((pl) => ({ id: pl.id, name: pl.name }));
        throw new CommandError('not-found', `No place ${input.locationId}. ${can.length ? `Use one of: ${idsHint(can)}.` : 'No place is open to this caller.'}`, { locations: can.slice(0, 50) });
      }
      const pick = state === 'all' ? all : state === 'open' ? open.filter((w) => !input.overdue || w.overdue) : all.filter((w) => w.state === 'completed');
      const rank = { urgent: 0, high: 1, routine: 2 };
      pick.sort(state === 'completed' ? (a, b) => (a.completedAt < b.completedAt ? 1 : -1)
        : (a, b) => (b.overdue - a.overdue) || (rank[a.priority] - rank[b.priority]) || (a.dueAt < b.dueAt ? -1 : 1));
      const cut = page(pick, input.limit, 20);
      return {
        asOf: now, synthetic: (await core.getMeta('synthetic', false)) === true,
        workOrders: cut.items.map((w) => woOut(w, assets, places, now, input.format === 'short')),
        total: cut.total, truncated: cut.truncated,
        counts: { open: open.length, overdue: open.filter((w) => w.overdue).length, repeat: open.filter((w) => w.repeat > 0).length },
      };
    },
    example: { input: { state: 'open' } },
  },
  {
    name: 'ospeli_workorders_report_fault',
    summary: 'Report a fault on an asset. Opens a work order with a priority and an SLA due time, and says if it is a repeat fault.',
    kind: 'write', roles: ['ward-nurse', 'bed-manager', 'ae-nic', 'estates-tech', 'ops-manager'], approval: true,
    input: { type: 'object', additionalProperties: false, required: ['assetId', 'fault', 'priority'], properties: {
      assetId: ID, fault: { type: 'string', enum: ALL_FAULTS, description: 'Pick from the asset\'s faults (ospeli_assets_list). No free text, so no personal details.' },
      priority: { type: 'string', enum: Object.keys(PRIORITIES) } } },
    output: WO_WRITE_OUTPUT,
    wardOf: (core, input) => wardOfAsset(core, input.assetId),
    async run(core, input, { actor }) {
      let id = null;
      const recs = await core.appendChecked(async (events) => {
        const a = await core.getEntity(input.assetId);
        if (!a || a.type !== 'asset') throw new CommandError('not-found', `No asset ${input.assetId}.`);
        if (!faultsFor(a.kind).includes(input.fault)) throw new CommandError('invalid-input', `"${input.fault}" is not a fault for ${a.name}.`, { faults: faultsFor(a.kind) });
        id = nextWorkOrderId(events);
        return [{ type: 'asset.fault-reported', subject: a.id, actorRole: actor.role, at: core.now(),
          data: { workOrder: id, title: input.fault, trade: teamFor(a.kind, input.fault), priority: input.priority } }];
      });
      const w = deriveWorkOrders(await core.events(), core.now()).get(id);
      return { status: 'done', workOrderId: id, state: 'open', repeat: w?.repeat ?? 0, events: recs.map((r) => r.seq) };
    },
    example: { input: { assetId: 'asset-a1-sink-1', fault: 'Blocked sink', priority: 'routine' } },
  },
  {
    ...workOrderWrite({
      name: 'ospeli_workorders_assign', summary: 'Assign (or re-assign) an open work order to a team. Teams, not named people.',
      roles: ['estates-tech', 'ops-manager'], to: 'assigned', required: ['team'],
      extra: { team: { type: 'string', enum: Object.keys(TEAMS) } },
      build: (w, input, role, at) => ({ type: 'workorder.assigned', subject: w.id, actorRole: role, at, data: { asset: w.assetId, trade: input.team } }),
    }),
    example: { input: { workOrderId: 'wo-00001', team: 'estates' } },
  },
  {
    ...workOrderWrite({
      name: 'ospeli_workorders_complete', summary: 'Close a work order with its outcome: fixed, escalated or no fault found.',
      roles: ['estates-tech'], to: 'completed', required: ['outcome'],
      extra: { outcome: { type: 'string', enum: Object.keys(OUTCOMES) } },
      build: (w, input, role, at) => ({ type: 'workorder.completed', subject: w.id, actorRole: role, at, data: { asset: w.assetId, outcome: input.outcome } }),
    }),
    example: { input: { workOrderId: 'wo-00001', outcome: 'fixed' } },
  },
);

// Process maps (backlog PM1): map a process step by step, see where the time goes, and try a
// change in a Proposed version beside Today. Nothing here changes how the hospital runs, but an
// agent still only proposes; a person accepts. The guide is rule-based, explainable, and has an
// off switch (ospeli_maps_guide_set, people only). Maps are kept on this device (setting "process-maps").
const MAP_ID = { type: 'string', pattern: '^map-[0-9]{3,}$', description: 'A map id from ospeli_maps_list, e.g. map-001.' };
const STEP_ID = { type: 'string', pattern: '^map-[0-9]{3,}-s[0-9]+$', description: 'A step id from ospeli_maps_get, e.g. map-001-s3.' };
const VERSION = { type: 'string', enum: MAP_VERSIONS, description: '"today" is the process as it runs now; "proposed" is the what-if. Defaults to today.' };
const MINUTES = { type: 'integer', minimum: 0, maximum: MAX_MINUTES };
const STEP_TEXT = { type: 'string', minLength: 1, maxLength: 140 };
const REVISION = { type: 'integer', minimum: 1, description: 'The map revision the caller last saw (from ospeli_maps_get). If the map changed since, the command is refused (conflict).' };
const MAP_STEP = {
  type: 'object', required: ['id', 'name', 'role', 'wait', 'work', 'msg', 'par'],
  properties: {
    id: STEP_ID, name: { type: 'string', description: 'What happens, in the site\'s own words.' },
    role: { type: 'string', description: 'Who does it, in the site\'s own words (a role, never a named person).' },
    wait: { ...MINUTES, description: 'Minutes waiting before this step starts.' }, work: { ...MINUTES, description: 'Hands-on minutes.' },
    msg: { type: 'boolean', description: 'The step only passes on information (a call, message or form).' },
    par: { type: 'boolean', description: 'Starts alongside the step before instead of after it.' },
  },
};
const MAP_STATS = {
  type: 'object', required: ['steps', 'elapsed', 'work', 'wait', 'handoffs'],
  properties: {
    steps: { type: 'integer' }, elapsed: { type: 'integer', description: 'Minutes from start to finish (steps that run alongside overlap).' },
    work: { type: 'integer', description: 'Hands-on minutes, summed.' }, wait: { type: 'integer', description: 'Waiting minutes, summed.' },
    handoffs: { type: 'integer', description: 'Times the role changes from one step to the next.' }, infoSteps: { type: 'integer' },
    workShare: { type: ['integer', 'null'], description: 'Hands-on time as a % of start to finish.' },
    biggestWaitStepId: { type: ['string', 'null'] }, roles: { type: 'array', items: { type: 'string' } },
  },
};
const SUGGESTION = {
  type: 'object', required: ['id', 'kind', 'title', 'text', 'why'],
  properties: {
    id: { type: 'string' }, kind: { type: 'string', enum: ['time', 'ask'] }, title: { type: 'string' }, text: { type: 'string' },
    why: { type: 'string', description: 'The rule or data behind it, so a person can check it.' }, stepId: STEP_ID,
    tryLabel: { type: 'string' }, tryable: { type: 'boolean', description: 'ospeli_maps_try_suggestion can apply it to the Proposed version.' },
    tried: { type: 'boolean' },
  },
};
const MAP_WRITE_OUTPUT = {
  type: 'object', required: ['status'],
  properties: {
    status: { type: 'string', enum: ['done', 'proposed'] }, mapId: MAP_ID, revision: { type: 'integer' }, stepId: STEP_ID,
    proposal: { type: 'object', description: 'When an agent asked: the proposal waiting for a person.' },
  },
};
const MAP_SOURCES = [...Object.keys(MAP_EXAMPLES), 'blank'];
const MAPS_KEY = 'process-maps';
const mapStore = (v) => v || { maps: [], guideOn: true, nextId: 1 };

async function loadMap(core, mapId) {
  const store = mapStore(await core.getMeta(MAPS_KEY, null));
  const map = store.maps.find((m) => m.id === mapId);
  if (!map) {
    throw new CommandError('not-found', `No map ${mapId}. Use ospeli_maps_list to see the maps on this device${store.maps.length ? ` (for example ${store.maps[0].id})` : ''}, or ospeli_maps_create to start one.`,
      { maps: store.maps.slice(0, 20).map((m) => ({ id: m.id, title: m.title })) });
  }
  return { store, map };
}

function checkText(input) {
  for (const k of ['name', 'role', 'title']) {
    if (input[k] == null) continue;
    const what = personalDetailIn(input[k]);
    if (what) throw new CommandError('invalid-input', `${k} looks like it holds ${what}. Describe the step and the role only; never personal details.`);
    if (personNameIn(input[k], { roleField: k === 'role' })) throw new CommandError('invalid-input', `${k} looks like it names a person. ${NAME_ADVICE}`);
    if (!String(input[k]).trim()) throw new CommandError('invalid-input', `${k} cannot be empty.`);
  }
}

// One shape for every map write: check, change the map inside the write queue, audit (ids only,
// no free text), and bump the revision.
function mapWrite({ name, summary, required = [], props, example, mutate, audit }) {
  return {
    name, summary, kind: 'write', roles: ALL_ROLES, approval: true,
    input: { type: 'object', additionalProperties: false, required: ['mapId', ...required], properties: { mapId: MAP_ID, ...props, expectedRevision: REVISION } },
    output: MAP_WRITE_OUTPUT,
    check: checkText,
    async snapshot(core, input) {
      const store = mapStore(await core.getMeta(MAPS_KEY, null));
      const m = store.maps.find((x) => x.id === input.mapId);
      return { seenRevision: input.expectedRevision ?? m?.revision ?? null };
    },
    async run(core, input, { actor }) {
      checkText(input);
      let out = {};
      await core.updateMeta(MAPS_KEY, async (raw) => {
        const store = mapStore(raw);
        const i = store.maps.findIndex((m) => m.id === input.mapId);
        if (i < 0) throw new CommandError('not-found', `No map ${input.mapId}. Use ospeli_maps_list to see the maps on this device.`);
        const map = JSON.parse(JSON.stringify(store.maps[i]));
        if (input.expectedRevision && map.revision !== input.expectedRevision) {
          throw new CommandError('conflict', 'This map changed since you opened it. Open it again (ospeli_maps_get) and retry.', { revision: map.revision });
        }
        out = mutate(map, input, core) || {};
        map.revision += 1; map.updatedAt = core.now();
        store.maps[i] = map;
        out.revision = map.revision;
        return store;
      });
      await core.recordAs(actor, audit, input.mapId, { ...(out.stepId ? { stepId: out.stepId } : {}), ...(input.version ? { version: input.version } : {}), ...(input.suggestionId ? { suggestion: input.suggestionId } : {}) });
      return { status: 'done', mapId: input.mapId, ...out };
    },
    example: { input: { mapId: 'map-001', ...example } },
  };
}

function stepIndex(map, version, stepId) {
  const list = map[version];
  const i = list.findIndex((s) => s.id === stepId);
  if (i < 0) throw new CommandError('not-found', `No step ${stepId} in the ${version} version of this map. Step ids come from ospeli_maps_get.`);
  return i;
}

const mapSummary = (m) => {
  const t = analyse(m.today); const p = analyse(m.proposed);
  return { id: m.id, title: m.title, from: m.from, steps: m.today.length, elapsedToday: t.elapsed, elapsedProposed: p.elapsed, revision: m.revision, updatedAt: m.updatedAt };
};
const visibleSuggestions = (map, list) => suggest(list)
  .filter((sg) => !map.hidden.includes(sg.id))
  .map(({ change, ...sg }) => ({ ...sg, tryable: !!change, tried: map.tried.includes(sg.id) }));

COMMAND_LIST.push(
  {
    name: 'ospeli_maps_list',
    summary: 'The process maps on this device, with steps and start-to-finish time for Today and Proposed, plus the example processes a new map can start from. Read-only.',
    kind: 'read', roles: ALL_ROLES, approval: false,
    input: { type: 'object', additionalProperties: false, properties: { limit: LIMIT(20, 200, 'maps') } },
    output: { type: 'object', required: ['guideOn', 'maps', 'examples', 'total', 'truncated'], properties: {
      guideOn: { type: 'boolean' }, total: TOTAL, truncated: TRUNCATED,
      maps: { type: 'array', items: { type: 'object', required: ['id', 'title', 'steps'], properties: {
        id: MAP_ID, title: { type: 'string' }, from: { type: 'string' }, steps: { type: 'integer' },
        elapsedToday: { type: 'integer' }, elapsedProposed: { type: 'integer' }, revision: { type: 'integer' }, updatedAt: TIME } } },
      examples: { type: 'array', items: { type: 'object', required: ['from', 'title'], properties: { from: { type: 'string' }, title: { type: 'string' } } } } } },
    async run(core, input) {
      const store = mapStore(await core.getMeta(MAPS_KEY, null));
      const cut = page(store.maps, input.limit, 20);
      return { guideOn: store.guideOn !== false, total: cut.total, truncated: cut.truncated, maps: cut.items.map(mapSummary), examples: Object.entries(MAP_EXAMPLES).map(([from, e]) => ({ from, title: e.title })) };
    },
    example: { input: {} },
  },
  {
    name: 'ospeli_maps_get',
    summary: 'One process map: its steps (Today and Proposed) and the numbers for each: start to finish, hands-on time, waiting, handoffs and the biggest wait. Use "short" for the numbers only. Read-only.',
    kind: 'read', roles: ALL_ROLES, approval: false,
    input: { type: 'object', additionalProperties: false, required: ['mapId'], properties: {
      mapId: MAP_ID, format: { type: 'string', enum: ['short', 'detailed'], description: 'short: numbers only; detailed (default): steps too.' } } },
    output: { type: 'object', required: ['id', 'title', 'revision', 'today', 'proposed', 'changed'], properties: {
      id: MAP_ID, title: { type: 'string' }, start: { type: 'string' }, revision: { type: 'integer' }, changed: { type: 'boolean', description: 'Proposed differs from Today.' },
      tried: { type: 'array', items: { type: 'string' } },
      today: { type: 'object', required: ['stats'], properties: { stats: MAP_STATS, steps: { type: 'array', items: MAP_STEP } } },
      proposed: { type: 'object', required: ['stats'], properties: { stats: MAP_STATS, steps: { type: 'array', items: MAP_STEP } } } } },
    async run(core, input) {
      const { map } = await loadMap(core, input.mapId);
      const part = (list) => {
        const { timed, ...stats } = analyse(list);
        return input.format === 'short' ? { stats } : { stats, steps: list };
      };
      return { id: map.id, title: map.title, start: map.start, revision: map.revision,
        changed: JSON.stringify(map.today) !== JSON.stringify(map.proposed), tried: [...map.tried],
        today: part(map.today), proposed: part(map.proposed) };
    },
    example: { input: { mapId: 'map-001', format: 'short' } },
  },
  {
    name: 'ospeli_maps_summary',
    summary: 'One process map in one short call: the numbers for Today and Proposed, the difference between them, the biggest wait and the guide\'s top suggestions with their reasons. Use this to answer "where does the time go in this process?". For every step use ospeli_maps_get. Read-only; suggests only.',
    kind: 'read', roles: ALL_ROLES, approval: false,
    input: { type: 'object', additionalProperties: false, required: ['mapId'], properties: {
      mapId: MAP_ID, version: { ...VERSION, description: 'Which version the biggest wait and the suggestions are for: "today" (default) or "proposed". ospeli_maps_try_suggestion only takes suggestion ids from "proposed".' } } },
    output: { type: 'object', required: ['id', 'title', 'revision', 'version', 'changed', 'today', 'proposed', 'difference', 'biggestWait', 'guideOn', 'suggestions', 'suggestionsTotal'], properties: {
      id: MAP_ID, title: { type: 'string' }, revision: { type: 'integer' }, version: VERSION, changed: { type: 'boolean', description: 'Proposed differs from Today.' },
      today: MAP_STATS, proposed: MAP_STATS,
      difference: { type: 'object', description: 'Proposed minus Today, in minutes (handoffs as a count). Negative means Proposed is shorter. A what-if, not a prediction.', required: ['elapsed', 'wait', 'work', 'handoffs'], properties: { elapsed: { type: 'integer' }, wait: { type: 'integer' }, work: { type: 'integer' }, handoffs: { type: 'integer' } } },
      biggestWait: { type: ['object', 'null'], description: 'The step with the longest wait before it, in the version asked for. Null when no step has a wait.', properties: {
        stepId: STEP_ID, name: { type: 'string' }, role: { type: 'string' }, wait: MINUTES, shareOfElapsed: { type: ['integer', 'null'], description: 'This wait as a % of start to finish.' } } },
      guideOn: { type: 'boolean', description: 'False when a person switched the guide off: suggestions is then empty; the numbers still work.' },
      suggestions: { type: 'array', items: SUGGESTION, description: 'The first three suggestions for the version asked for.' },
      suggestionsTotal: { type: 'integer', minimum: 0 } } },
    async run(core, input) {
      const { store, map } = await loadMap(core, input.mapId);
      const version = input.version || 'today';
      const stats = (list) => { const { timed, ...s } = analyse(list); return s; };
      const t = stats(map.today); const p = stats(map.proposed); const mine = version === 'today' ? t : p;
      const worst = mine.biggestWaitStepId ? map[version].find((s) => s.id === mine.biggestWaitStepId) : null;
      const guideOn = store.guideOn !== false;
      const all = guideOn ? visibleSuggestions(map, map[version]) : [];
      return {
        id: map.id, title: map.title, revision: map.revision, version,
        changed: JSON.stringify(map.today) !== JSON.stringify(map.proposed), today: t, proposed: p,
        difference: { elapsed: p.elapsed - t.elapsed, wait: p.wait - t.wait, work: p.work - t.work, handoffs: p.handoffs - t.handoffs },
        biggestWait: worst ? { stepId: worst.id, name: worst.name, role: worst.role, wait: worst.wait, shareOfElapsed: mine.elapsed ? Math.round((100 * worst.wait) / mine.elapsed) : null } : null,
        guideOn, suggestions: all.slice(0, 3), suggestionsTotal: all.length,
      };
    },
    example: { input: { mapId: 'map-001' } },
  },
  {
    name: 'ospeli_maps_suggest',
    summary: 'The guide\'s suggestions for one version of a map: biggest waits, steps that only pass on information, handoffs, steps that could run alongside, missing times and walk questions. Each says why. Rule-based; empty when the guide is switched off. Suggests only; changes nothing.',
    kind: 'read', roles: ALL_ROLES, approval: false,
    input: { type: 'object', additionalProperties: false, required: ['mapId'], properties: { mapId: MAP_ID, version: VERSION } },
    output: { type: 'object', required: ['guideOn', 'suggestions'], properties: {
      guideOn: { type: 'boolean' }, hidden: { type: 'integer' }, suggestions: { type: 'array', items: SUGGESTION } } },
    async run(core, input) {
      const { store, map } = await loadMap(core, input.mapId);
      if (store.guideOn === false) return { guideOn: false, hidden: map.hidden.length, suggestions: [] };
      return { guideOn: true, hidden: map.hidden.length, suggestions: visibleSuggestions(map, map[input.version || 'today']) };
    },
    example: { input: { mapId: 'map-001', version: 'today' } },
  },
  {
    name: 'ospeli_maps_create',
    summary: 'Start a new process map, from one of the example processes (see ospeli_maps_list) or blank. Proposed starts as a copy of Today.',
    kind: 'write', roles: ALL_ROLES, approval: true,
    input: { type: 'object', additionalProperties: false, required: ['from'], properties: {
      from: { type: 'string', enum: MAP_SOURCES, description: 'An example process to start from, or "blank".' },
      title: { ...STEP_TEXT, description: 'The map\'s name, e.g. "Discharge from ward 3". Defaults to the example\'s title.' } } },
    output: MAP_WRITE_OUTPUT,
    check: checkText,
    async run(core, input, { actor }) {
      checkText(input);
      let id = null; let revision = 1;
      await core.updateMeta(MAPS_KEY, (raw) => {
        const store = mapStore(raw);
        id = `map-${String(store.nextId).padStart(3, '0')}`;
        store.nextId += 1;
        const m = newMap({ id, from: input.from, title: input.title, at: core.now(), role: actor.role });
        revision = m.revision;
        store.maps.push(m);
        return store;
      });
      await core.recordAs(actor, 'map.created', id, { from: input.from });
      return { status: 'done', mapId: id, revision };
    },
    example: { input: { from: 'discharge' } },
  },
  mapWrite({
    name: 'ospeli_maps_step_add', audit: 'map.step-added',
    summary: 'Add a step to one version of a map: what happens, who does it, minutes waiting before it and hands-on minutes. Added at the end unless a position is given.',
    required: ['name', 'role'],
    props: { version: VERSION, name: { ...STEP_TEXT, description: 'What happens, e.g. "Bed cleaned". No personal details.' },
      role: { ...STEP_TEXT, description: 'Who does it, e.g. "Housekeeping". A role, never a person\'s name.' },
      wait: { ...MINUTES, description: 'Minutes waiting before this step starts. Default 0.' }, work: { ...MINUTES, description: 'Hands-on minutes. Default 0.' },
      msg: { type: 'boolean', description: 'True if the step only passes on information.' }, par: { type: 'boolean', description: 'True if it starts alongside the step before.' },
      position: { type: 'integer', minimum: 1, description: '1 = first. Default: last.' } },
    example: { version: 'today', name: 'Bed cleaned', role: 'Housekeeping', wait: 30, work: 20 },
    mutate(map, input) {
      const v = input.version || 'today'; const list = map[v];
      if (list.length >= MAX_STEPS) throw new CommandError('invalid-input', `A map holds up to ${MAX_STEPS} steps. Split the process into two maps.`);
      const step = { id: `${map.id}-s${map.nextStep}`, name: input.name.trim(), role: input.role.trim(), wait: input.wait || 0, work: input.work || 0, msg: !!input.msg, par: !!input.par };
      map.nextStep += 1;
      const at = input.position ? Math.min(input.position - 1, list.length) : list.length;
      list.splice(at, 0, step);
      return { stepId: step.id };
    },
  }),
  mapWrite({
    name: 'ospeli_maps_step_update', audit: 'map.step-updated',
    summary: 'Change a step in one version of a map: its wording, who does it, its times or its flags. Only the fields given change.',
    required: ['stepId'],
    props: { version: VERSION, stepId: STEP_ID, name: STEP_TEXT, role: STEP_TEXT, wait: MINUTES, work: MINUTES, msg: { type: 'boolean' }, par: { type: 'boolean' } },
    example: { version: 'proposed', stepId: 'map-001-s3', wait: 60 },
    mutate(map, input) {
      const v = input.version || 'today'; const s = map[v][stepIndex(map, v, input.stepId)];
      for (const k of ['name', 'role']) if (input[k] != null) s[k] = input[k].trim();
      for (const k of ['wait', 'work', 'msg', 'par']) if (input[k] != null) s[k] = input[k];
      return { stepId: s.id };
    },
  }),
  mapWrite({
    name: 'ospeli_maps_step_move', audit: 'map.step-moved',
    summary: 'Move a step one place up or down in one version of a map.',
    required: ['stepId', 'direction'],
    props: { version: VERSION, stepId: STEP_ID, direction: { type: 'string', enum: ['up', 'down'] } },
    example: { version: 'proposed', stepId: 'map-001-s3', direction: 'up' },
    mutate(map, input) {
      const v = input.version || 'today'; const list = map[v]; const i = stepIndex(map, v, input.stepId);
      const j = input.direction === 'up' ? i - 1 : i + 1;
      if (j < 0 || j >= list.length) throw new CommandError('invalid-input', `Step ${input.stepId} is already ${input.direction === 'up' ? 'first' : 'last'}.`);
      [list[i], list[j]] = [list[j], list[i]];
      return { stepId: input.stepId };
    },
  }),
  mapWrite({
    name: 'ospeli_maps_step_remove', audit: 'map.step-removed',
    summary: 'Remove a step from one version of a map.',
    required: ['stepId'],
    props: { version: VERSION, stepId: STEP_ID },
    example: { version: 'proposed', stepId: 'map-001-s3' },
    mutate(map, input) {
      const v = input.version || 'today'; map[v].splice(stepIndex(map, v, input.stepId), 1);
      return { stepId: input.stepId };
    },
  }),
  mapWrite({
    name: 'ospeli_maps_try_suggestion', audit: 'map.suggestion-tried',
    summary: 'Apply one of the guide\'s suggestions (from ospeli_maps_suggest on the proposed version, where tryable is true) to the Proposed version only. Today never changes. A what-if, not a prediction.',
    required: ['suggestionId'],
    props: { suggestionId: { type: 'string', minLength: 1, maxLength: 80, description: 'The id of a tryable suggestion from ospeli_maps_suggest (version "proposed").' } },
    example: { suggestionId: 'msgs' },
    mutate(map, input, core) {
      const sg = suggest(map.proposed).find((x) => x.id === input.suggestionId);
      if (!sg || !sg.change) {
        const ids = suggest(map.proposed).filter((x) => x.change).map((x) => x.id);
        throw new CommandError('invalid-input', `"${input.suggestionId}" is not a suggestion that can be tried on this map now. Try one of: ${ids.join(', ') || 'none'}.`, { tryable: ids });
      }
      map.proposed = applyChange(map.proposed, sg.change);
      if (!map.tried.includes(sg.id)) map.tried.push(sg.id);
      return {};
    },
  }),
  mapWrite({
    name: 'ospeli_maps_hide_suggestion', audit: 'map.suggestion-hidden',
    summary: 'Hide one guide suggestion on this map (not useful here). Changes no steps.',
    required: ['suggestionId'],
    props: { suggestionId: { type: 'string', minLength: 1, maxLength: 80 } },
    example: { suggestionId: 'questions' },
    mutate(map, input) { if (!map.hidden.includes(input.suggestionId)) map.hidden.push(input.suggestionId); return {}; },
  }),
  mapWrite({
    name: 'ospeli_maps_reset_proposed', audit: 'map.proposed-reset',
    summary: 'Throw away every change in the Proposed version: it becomes a copy of Today again, and hidden suggestions come back.',
    props: {},
    example: {},
    mutate(map) { map.proposed = JSON.parse(JSON.stringify(map.today)); map.tried = []; map.hidden = []; return {}; },
  }),
  {
    name: 'ospeli_maps_guide_set',
    summary: 'Switch the process-map guide on or off on this device. With it off, maps, times and editing all still work. People only.',
    kind: 'write', roles: ALL_ROLES, approval: true, agents: false,
    input: { type: 'object', additionalProperties: false, required: ['on'], properties: { on: { type: 'boolean' } } },
    output: { type: 'object', required: ['status', 'guideOn'], properties: { status: { type: 'string', enum: ['done'] }, guideOn: { type: 'boolean' } } },
    async run(core, input, { actor }) {
      await core.updateMeta(MAPS_KEY, (raw) => ({ ...mapStore(raw), guideOn: input.on }));
      await core.recordAs(actor, input.on ? 'map.guide-on' : 'map.guide-off', null, null);
      return { status: 'done', guideOn: input.on };
    },
    example: { input: { on: false } },
  },
);

const EXAMPLE_BED = { 'ospeli_beds_allocate': { encounter: 'enc-000123' }, 'ospeli_beds_take_out_of_service': { reason: 'Electrical' }, 'ospeli_beds_flag_expected_discharge': { expectedAt: '2026-11-08T15:00:00.000Z' } };
for (const c of COMMAND_LIST) {
  if (!c.example) c.example = { input: { bedId: 'ward-a1-bed-01', ...(EXAMPLE_BED[c.name] || {}) } };
}

const BY_NAME = new Map(COMMAND_LIST.map((c) => [c.name, c]));

// Names (issue #39, tool-design rule): every command is ospeli_<module>_<action>, so an agent that
// runs many tool servers cannot confuse them. The dotted names used before 12 Nov 2026 still work
// in this build as deprecated names: a call by an old name runs the same command, and the audit
// trail and the proposal queue always record the new name (plus calledAs for an agent, taken from
// this table, never from what the agent typed).
const DEPRECATED_NAMES = {
  'beds.board': 'ospeli_beds_board',
  'bed.get': 'ospeli_beds_get',
  'bed.flag-expected-discharge': 'ospeli_beds_flag_expected_discharge',
  'bed.cancel-expected-discharge': 'ospeli_beds_cancel_expected_discharge',
  'bed.mark-vacated': 'ospeli_beds_mark_vacated',
  'bed.start-clean': 'ospeli_beds_start_clean',
  'bed.finish-clean': 'ospeli_beds_finish_clean',
  'bed.allocate': 'ospeli_beds_allocate',
  'bed.cancel-allocation': 'ospeli_beds_cancel_allocation',
  'bed.admit': 'ospeli_beds_admit',
  'bed.take-out-of-service': 'ospeli_beds_take_out_of_service',
  'bed.return-to-service': 'ospeli_beds_return_to_service',
  'kpi.list': 'ospeli_kpi_list',
  'kpi.value': 'ospeli_kpi_get',
  'agents.access': 'ospeli_agents_access',
  'agents.set-access': 'ospeli_agents_set_access',
  'agents.list': 'ospeli_agents_list',
  'agent.add': 'ospeli_agents_add',
  'agent.remove': 'ospeli_agents_remove',
  'agents.stop-all': 'ospeli_agents_stop_all',
  'proposals.list': 'ospeli_proposals_list',
  'proposal.accept': 'ospeli_proposals_accept',
  'proposal.decline': 'ospeli_proposals_decline',
  'assets.list': 'ospeli_assets_list',
  'workorders.list': 'ospeli_workorders_list',
  'fault.report': 'ospeli_workorders_report_fault',
  'workorder.assign': 'ospeli_workorders_assign',
  'workorder.complete': 'ospeli_workorders_complete',
  'maps.list': 'ospeli_maps_list',
  'map.get': 'ospeli_maps_get',
  'map.suggest': 'ospeli_maps_suggest',
  'map.create': 'ospeli_maps_create',
  'map.step.add': 'ospeli_maps_step_add',
  'map.step.update': 'ospeli_maps_step_update',
  'map.step.move': 'ospeli_maps_step_move',
  'map.step.remove': 'ospeli_maps_step_remove',
  'map.try-suggestion': 'ospeli_maps_try_suggestion',
  'map.hide-suggestion': 'ospeli_maps_hide_suggestion',
  'map.reset-proposed': 'ospeli_maps_reset_proposed',
  'map.guide.set': 'ospeli_maps_guide_set',
};
for (const [oldName, name] of Object.entries(DEPRECATED_NAMES)) BY_NAME.get(name).deprecatedName = oldName;
export const canonicalName = (name) => (BY_NAME.has(name) ? name : Object.hasOwn(DEPRECATED_NAMES, String(name)) ? DEPRECATED_NAMES[name] : null);
export const commandByName = (name) => BY_NAME.get(canonicalName(name)) || null;

// Plain, serialisable description (no functions): what agents and commands.json see.
export function describeCommand(name) {
  const c = commandByName(name);
  if (!c) return null;
  return {
    name: c.name, summary: c.summary, kind: c.kind, roles: [...c.roles],
    humanApproval: c.approval, agentsMayCall: c.agents !== false,
    agentBehaviour: c.agents === false ? 'refused: people only'
      : c.kind === 'read' ? 'runs and is audited as an agent read'
        : 'recorded as a proposal for a person to accept or decline; nothing changes until they do',
    ...(c.deprecatedName ? { deprecatedName: c.deprecatedName } : {}),
    input: c.input, output: c.output, example: c.example,
  };
}
export const listCommands = () => COMMAND_LIST.map((c) => describeCommand(c.name));

export async function agentAccess(core) {
  const a = await core.getMeta('agents', null);
  return { allowed: a?.allowed === true, wards: { ...(a?.wards || {}) } };
}

function normaliseActor(actor) {
  if (!actor || typeof actor !== 'object') throw new CommandError('forbidden', 'Every command needs an actor.');
  // Exactly 'human' or 'agent': anything else is refused, never treated as a person.
  if (actor.type !== 'human' && actor.type !== 'agent') throw new CommandError('forbidden', 'The actor type must be "human" or "agent".');
  const type = actor.type;
  if (!roleById(actor.role)) throw new CommandError('forbidden', type === 'agent' ? `Unknown role. Use one of: ${ALL_ROLES.join(', ')}.` : `Unknown role ${actor.role}.`);
  if (type === 'agent' && !(typeof actor.agent === 'string' && /^[a-z0-9][a-z0-9 ._-]{0,40}$/i.test(actor.agent))) {
    throw new CommandError('forbidden', 'An agent must give its name.');
  }
  return type === 'agent' ? { type, role: actor.role, agent: actor.agent } : { type, role: actor.role };
}

// Every refused agent call leaves an audit entry (issue #27), whatever the reason: unknown
// command, unknown or wrong role, bad input, agents off, not on the list. Nothing the agent
// typed is stored: the command name only if it is a real one, the agent's name only if a person
// put it on the site's list (otherwise "unlisted"), the names of input fields only if the
// command has them, never their values, and a fixed reason for bad input. A looping agent cannot flood the
// trail: the same agent, command and reason within a minute is counted, and the count is
// written on the next entry for that agent, command and reason.
const REFUSAL_WINDOW_MS = 60_000;
async function auditRefusal(core, name, input, actor, err) {
  const cmd = commandByName(name);
  const known = !!cmd;
  const role = roleById(actor?.role) ? actor.role : 'system';
  const listed = typeof actor?.agent === 'string' ? (await agentList(core)).find((r) => agentKey(r.name) === agentKey(actor.agent)) : null;
  const agent = listed ? listed.name : 'unlisted';
  const ownFields = new Set(Object.keys(cmd?.input?.properties || {}));
  const command = known ? cmd.name : '(unknown)';
  const detail = {
    command, code: err.code, reason: err.reason || err.code,
    why: err.code === 'invalid-input' ? 'The input did not match what the command accepts.' : err.code === 'unknown-command' ? 'There is no such command.' : err.message,
    claimedRole: role === 'system' ? '(unknown)' : role,
    fields: input && typeof input === 'object' ? Object.keys(input).filter((k) => ownFields.has(k)).slice(0, 12) : [],
    ...(known && name !== cmd.name ? { calledAs: cmd.deprecatedName } : {}),
  };
  const key = `${agent.toLowerCase()}|${command}|${err.code}|${err.reason || ''}`;
  const now = core.now();
  let write = null;
  await core.updateMeta('agent-refusals', (raw) => {
    const all = { ...(raw || {}) };
    for (const [k, r] of Object.entries(all)) if (Date.parse(now) - Date.parse(r.rowAt) > 7 * 864e5) delete all[k];
    const rec = all[key];
    if (rec && Date.parse(now) - Date.parse(rec.rowAt) < REFUSAL_WINDOW_MS) {
      all[key] = { ...rec, suppressed: (rec.suppressed || 0) + 1, first: rec.first || now, last: now };
    } else {
      write = rec?.suppressed ? { count: rec.suppressed, first: rec.first, last: rec.last } : false;
      all[key] = { agent, rowAt: now, suppressed: 0 };
    }
    return all;
  });
  if (write !== null) await core.recordAs({ type: 'agent', role, agent }, 'agent.refused', null, write ? { ...detail, repeats: write } : detail);
}

// Run a command. `actor` is { type: 'human', role } or { type: 'agent', agent, role }.
export async function runCommand(core, name, input = {}, actor) {
  if (actor?.type !== 'agent') return runChecked(core, name, input, actor);
  try {
    return await runChecked(core, name, input, actor);
  } catch (err) {
    if (err instanceof CommandError && err.refusal) await auditRefusal(core, name, input, actor, err);
    throw err;
  }
}

async function runChecked(core, name, input, actor) {
  // A refusal: the call was turned away before the command ran. (A read that runs and then
  // answers not-found is recorded as an agent read with its outcome, further down.)
  const refuse = (code, why, detail = null, reason = code) => { throw Object.assign(new CommandError(code, why, detail), { refusal: true, reason }); };
  const cmd = commandByName(name);
  if (!cmd) refuse('unknown-command', `There is no command ${String(name).slice(0, 60)}. Command names look like ospeli_beds_find_free; the full list is in commands.json.`);
  // From here on the command goes by its one real name, whatever name it was called by.
  const calledAs = name !== cmd.name ? { calledAs: cmd.deprecatedName } : {};
  name = cmd.name;
  let who;
  try { who = normaliseActor(actor); } catch (err) { err.refusal = true; err.reason = 'actor'; throw err; }
  if (who.type === 'human') {
    if (!cmd.roles.includes(who.role)) refuse('forbidden', `${roleById(who.role).name} cannot run ${name}.`, { roles: cmd.roles });
    const errs = validate(cmd.input, input ?? {});
    if (errs.length) refuse('invalid-input', errs.join('; '), { errors: errs });
    return cmd.run(core, input ?? {}, { actor: who, wards: null });
  }

  // Agents: off by default, per hospital and per ward; only agents on the site's list, in the
  // role they were listed for; reads are audited; writes become proposals.
  if (cmd.agents === false) refuse('agents-off', 'This command is for people only.', null, 'people-only');
  const access = await agentAccess(core);
  if (!access.allowed) refuse('agents-off', 'Agent access is off for this hospital.', null, 'dial-off');
  const listed = (await agentList(core)).find((r) => agentKey(r.name) === agentKey(who.agent));
  if (!listed) refuse('forbidden', `Agent ${who.agent} is not on this site's list. ${AGENT_ADMINS.map((r) => roleById(r).name).join(' or ')} can add it on the Agents screen.`, null, 'not-listed');
  if (Date.parse(listed.until) <= Date.parse(core.now())) refuse('forbidden', `Agent ${who.agent} passed its end date. A person can add it again on the Agents screen.`, null, 'ended');
  if (listed.role !== who.role) refuse('forbidden', `Agent ${who.agent} works for ${roleById(listed.role).name} on this site, not ${roleById(who.role).name}.`, null, 'other-role');
  if (!cmd.roles.includes(who.role)) refuse('forbidden', `${roleById(who.role).name} cannot run ${name}.`, { roles: cmd.roles }, 'role-cannot');
  const errs = validate(cmd.input, input ?? {});
  if (errs.length) refuse('invalid-input', errs.join('; '), { errors: errs });
  // Free text is checked before a proposal is queued, so a personal detail never waits in the queue (#38).
  if (cmd.check) {
    try { cmd.check(input); } catch (err) { if (err instanceof CommandError) { err.refusal = true; err.reason = 'personal-detail'; } throw err; }
  }
  const ward = cmd.wardOf ? await cmd.wardOf(core, input) : null;
  if (ward && access.wards[ward] !== true) refuse('agents-off', `Agent access is off for ward ${ward}.`, null, 'ward-off');
  if (ward && !listed.wards.includes(ward)) refuse('forbidden', `Agent ${who.agent} is not allowed on ward ${ward}.`, null, 'ward-not-listed');
  const allowedWards = new Set(listed.wards.filter((id) => access.wards[id] === true));
  who.agent = listed.name; // the name as a person wrote it on the list
  if (cmd.kind === 'read') {
    // A read that fails (for example not-found) is audited too: every agent call leaves a trace.
    let out;
    try {
      out = await cmd.run(core, input, { actor: who, wards: allowedWards });
    } catch (err) {
      await core.recordAs(who, 'agent.read', null, { command: name, input, outcome: err instanceof CommandError ? err.code : 'error', ...calledAs });
      throw err;
    }
    // How much the agent was shown, so a reviewer can see what a read returned without the data itself.
    const size = cmd.size ? cmd.size(out) : typeof out?.total === 'number' ? { total: out.total, truncated: out.truncated === true } : {};
    await core.recordAs(who, 'agent.read', null, { command: name, input, ...size, ...calledAs });
    return out;
  }
  const extra = cmd.snapshot ? await cmd.snapshot(core, input) : {};
  const proposal = await core.propose(who, name, input, { wardId: ward, ...extra, ...calledAs });
  return { status: 'proposed', ...(input.bedId ? { bedId: input.bedId } : {}), ...(input.workOrderId ? { workOrderId: input.workOrderId } : {}), ...(input.mapId ? { mapId: input.mapId } : {}), proposal };
}
