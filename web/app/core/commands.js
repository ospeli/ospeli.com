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
  { action: 'expect-discharge', name: 'bed.flag-expected-discharge', to: 'expected-discharge', roles: FLOOR,
    summary: 'Flag that the patient in this bed is expected to go home today.',
    extra: { expectedAt: { ...TIME, description: 'When the patient is expected to leave. Defaults to now.' } } },
  { action: 'cancel-expected', name: 'bed.cancel-expected-discharge', to: 'occupied', roles: FLOOR,
    summary: 'Cancel an expected discharge; the patient stays.' },
  { action: 'vacate', name: 'bed.mark-vacated', to: 'vacated', roles: FLOOR,
    summary: 'The patient has left: discharge them from the bed and mark it to clean.' },
  { action: 'start-clean', name: 'bed.start-clean', to: 'cleaning', roles: FLOOR,
    summary: 'Cleaning of a vacated bed has started.' },
  { action: 'finish-clean', name: 'bed.finish-clean', to: 'available', roles: FLOOR,
    summary: 'Cleaning is finished: the bed is ready for the next patient.' },
  { action: 'allocate', name: 'bed.allocate', to: 'allocated', roles: ['bed-manager', 'ae-nic', 'ward-nurse'],
    summary: 'Hold an available bed for a patient waiting for a bed.',
    extra: { encounter: { ...ID, description: 'The waiting patient\'s synthetic encounter id (from beds.board waiting).' } },
    required: ['encounter'] },
  { action: 'cancel-allocation', name: 'bed.cancel-allocation', to: 'available', roles: ['bed-manager', 'ae-nic', 'ward-nurse'],
    summary: 'Release a held bed; the patient goes back on the waiting list.' },
  { action: 'admit', name: 'bed.admit', to: 'occupied', roles: FLOOR,
    summary: 'The patient the bed was held for has arrived in it.' },
  { action: 'out-of-service', name: 'bed.take-out-of-service', to: 'out-of-service', roles: [...FLOOR, 'estates-tech'],
    summary: 'Take an empty bed out of service, with a reason.',
    extra: { reason: { type: 'string', enum: OUT_OF_SERVICE_REASONS } }, required: ['reason'] },
  { action: 'back-in-service', name: 'bed.return-to-service', to: 'available', roles: [...FLOOR, 'estates-tech'],
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
    name: 'beds.board',
    summary: 'Live bed state for every ward (or one ward), the waiting-for-a-bed list and any conflicting events, derived from the event log.',
    kind: 'read', roles: ALL_ROLES, approval: false,
    input: { type: 'object', additionalProperties: false, properties: { wardId: ID } },
    output: {
      type: 'object', required: ['asOf', 'synthetic', 'wards', 'beds', 'waiting', 'conflicts'],
      properties: {
        asOf: TIME, synthetic: SYNTHETIC,
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
      if (input.wardId && !wards.some((w) => w.id === input.wardId)) throw new CommandError('not-found', `No ward ${input.wardId}.`);
      const wardIds = new Set(wards.map((w) => w.id).filter(keep));
      return {
        asOf: core.now(),
        synthetic: (await core.getMeta('synthetic', false)) === true,
        wards: wards.filter((w) => wardIds.has(w.id)).map((w) => ({
          id: w.id, name: w.name, counts: countStates(beds.filter((b) => b.parentId === w.id).map((b) => board.beds.get(b.id))),
        })),
        beds: beds.filter((b) => wardIds.has(b.parentId)).map((b) => bedOut(board.beds.get(b.id), b)),
        waiting: board.waiting.filter((x) => !x.wardId || wardIds.has(x.wardId) || !allowed),
        conflicts: board.conflicts.filter((c) => wardIds.has(info.get(c.bedId)?.parentId)),
      };
    },
    example: { input: { wardId: 'ward-a1' } },
  },
  {
    name: 'bed.get',
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
  ...BED_WRITES.map(bedWriteCommand),
  {
    name: 'kpi.list',
    summary: 'Every KPI definition: numerator, denominator, exclusions, source standard, owner and target.',
    kind: 'read', roles: ALL_ROLES, approval: false,
    input: { type: 'object', additionalProperties: false, properties: {} },
    output: { type: 'object', required: ['kpis'], properties: { kpis: { type: 'array', items: { type: 'object', required: ['id', 'name'] } } } },
    async run() { return { kpis: KPIS.map((k) => ({ ...k })) }; },
    example: { input: {} },
  },
  {
    name: 'kpi.value',
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
    name: 'agents.access',
    summary: 'Whether agents may work on this hospital, and on which wards. Off by default.',
    kind: 'read', roles: ALL_ROLES, approval: false,
    input: { type: 'object', additionalProperties: false, properties: {} },
    output: { type: 'object', required: ['allowed', 'wards'], properties: { allowed: { type: 'boolean' }, wards: { type: 'object', additionalProperties: { type: 'boolean' } } } },
    async run(core) { return agentAccess(core); },
    example: { input: {} },
  },
  {
    name: 'agents.set-access',
    summary: 'Switch agent access on or off for the hospital and for each ward. People only.',
    kind: 'write', roles: ['ops-manager', 'coo'], approval: true, agents: false,
    input: { type: 'object', additionalProperties: false, required: ['allowed'], properties: { allowed: { type: 'boolean' }, wards: { type: 'object', additionalProperties: { type: 'boolean' } } } },
    output: { type: 'object', required: ['allowed', 'wards'], properties: { allowed: { type: 'boolean' }, wards: { type: 'object' } } },
    async run(core, input, { actor }) {
      const prev = await agentAccess(core);
      const next = { allowed: input.allowed, wards: { ...prev.wards, ...(input.wards || {}) } };
      await core.setMeta('agents', next);
      await core.recordAs(actor, 'agents.access-changed', null, { from: prev, to: next });
      return next;
    },
    example: { input: { allowed: true, wards: { 'ward-a1': true } } },
  },
];

const PROPOSAL = {
  type: 'object', required: ['id', 'command', 'input', 'agent', 'role', 'at', 'status'],
  properties: {
    id: ID, command: { type: 'string' }, input: { type: 'object' }, agent: { type: 'string' }, role: ID, at: TIME,
    status: { type: 'string', enum: ['pending', 'accepting', 'accepted', 'declined', 'expired'] },
    wardId: { type: ['string', 'null'] }, seenState: { type: ['string', 'null'] },
    decidedAt: TIME, decidedByRole: ID, reason: { type: ['string', 'null'] }, events: { type: 'array', items: { type: 'integer' } },
    canDecide: { type: 'boolean', description: 'Whether the caller\'s role may accept or decline it.' },
  },
};
export const DECLINE_REASONS = ['Not needed', 'Wrong bed or patient', 'Already done', 'Needs a conversation first', 'Other'];

async function pendingProposal(core, id) {
  const p = (await core.proposals()).find((x) => x.id === id);
  if (!p) throw new CommandError('not-found', `No proposal ${id}.`);
  if (p.status !== 'pending') throw new CommandError('conflict', `That proposal is already ${p.status}.`, { status: p.status });
  return p;
}
const mayDecide = (p, role) => !!commandByName(p.command)?.roles.includes(role);

// Agent proposals (issue #17, backlog A4): people see what agents asked for, and accept or decline.
COMMAND_LIST.push(
  {
    name: 'proposals.list',
    summary: 'Agent proposals and what happened to them. People see every proposal; an agent sees only its own.',
    kind: 'read', roles: ALL_ROLES, approval: false,
    input: { type: 'object', additionalProperties: false, properties: { status: { type: 'string', enum: ['pending', 'accepted', 'declined', 'expired'] } } },
    output: { type: 'object', required: ['proposals'], properties: { proposals: { type: 'array', items: PROPOSAL } } },
    async run(core, input, { actor }) {
      let list = await core.proposals();
      if (actor.type === 'agent') list = list.filter((p) => p.agent === actor.agent);
      if (input.status) list = list.filter((p) => p.status === input.status);
      return { proposals: list.map((p) => ({ ...p, canDecide: actor.type === 'human' && p.status === 'pending' && mayDecide(p, actor.role) })) };
    },
    example: { input: { status: 'pending' } },
  },
  {
    name: 'proposal.accept',
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
    name: 'proposal.decline',
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
    overdue: { type: 'boolean' }, metSla: { type: ['boolean', 'null'] },
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

function woOut(w, assets, places) {
  const a = assets.get(w.assetId); const loc = a ? places.get(a.parentId) : null;
  return { ...w, assetName: a?.name ?? w.assetId, locationId: a?.parentId ?? null, locationName: loc?.name ?? '' };
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
    name: 'assets.list',
    summary: 'Assets that can have a fault, with where they are and the faults that can be reported for each.',
    kind: 'read', roles: ALL_ROLES, approval: false,
    input: { type: 'object', additionalProperties: false, properties: { locationId: ID } },
    output: { type: 'object', required: ['locations', 'assets'], properties: {
      locations: { type: 'array', items: { type: 'object', required: ['id', 'name', 'type'], properties: { id: ID, name: { type: 'string' }, type: { type: 'string' } } } },
      assets: { type: 'array', items: { type: 'object', required: ['id', 'name', 'kind', 'locationId', 'faults'], properties: { id: ID, name: { type: 'string' }, kind: { type: 'string' }, locationId: ID, faults: { type: 'array', items: { type: 'string' } } } } } } },
    wardOf: (core, input) => (String(input.locationId || '').startsWith('ward-') ? input.locationId : null),
    async run(core, input, { wards: allowed }) {
      const [assets, places] = await Promise.all([core.listEntities('asset'), placesById(core)]);
      const keep = assets.filter((a) => (!input.locationId || a.parentId === input.locationId) && (!allowed || allowed.has(a.parentId)));
      const locIds = new Set(keep.map((a) => a.parentId));
      return {
        locations: [...places.values()].filter((p) => locIds.has(p.id)).map((p) => ({ id: p.id, name: p.name, type: p.type })),
        assets: keep.map((a) => ({ id: a.id, name: a.name, kind: a.kind, locationId: a.parentId, faults: faultsFor(a.kind) })),
      };
    },
    example: { input: { locationId: 'ward-a1' } },
  },
  {
    name: 'workorders.list',
    summary: 'The work-order queue: open (or completed) work orders with priority, team, SLA due time, overdue flag and repeat-fault count, most urgent first.',
    kind: 'read', roles: ALL_ROLES, approval: false,
    input: { type: 'object', additionalProperties: false, properties: {
      state: { type: 'string', enum: ['open', 'completed', 'all'], description: 'open (default) means reported or assigned.' },
      locationId: ID, assetId: ID } },
    output: { type: 'object', required: ['asOf', 'synthetic', 'workOrders', 'counts'], properties: {
      asOf: TIME, synthetic: SYNTHETIC, workOrders: { type: 'array', items: WO_SCHEMA },
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
      const pick = state === 'all' ? all : state === 'open' ? open : all.filter((w) => w.state === 'completed');
      const rank = { urgent: 0, high: 1, routine: 2 };
      pick.sort(state === 'completed' ? (a, b) => (a.completedAt < b.completedAt ? 1 : -1)
        : (a, b) => (b.overdue - a.overdue) || (rank[a.priority] - rank[b.priority]) || (a.dueAt < b.dueAt ? -1 : 1));
      return {
        asOf: now, synthetic: (await core.getMeta('synthetic', false)) === true,
        workOrders: pick.map((w) => woOut(w, assets, places)),
        counts: { open: open.length, overdue: open.filter((w) => w.overdue).length, repeat: open.filter((w) => w.repeat > 0).length },
      };
    },
    example: { input: { state: 'open' } },
  },
  {
    name: 'fault.report',
    summary: 'Report a fault on an asset. Opens a work order with a priority and an SLA due time, and says if it is a repeat fault.',
    kind: 'write', roles: ['ward-nurse', 'bed-manager', 'ae-nic', 'estates-tech', 'ops-manager'], approval: true,
    input: { type: 'object', additionalProperties: false, required: ['assetId', 'fault', 'priority'], properties: {
      assetId: ID, fault: { type: 'string', enum: ALL_FAULTS, description: 'Pick from the asset\'s faults (assets.list). No free text, so no personal details.' },
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
      name: 'workorder.assign', summary: 'Assign (or re-assign) an open work order to a team. Teams, not named people.',
      roles: ['estates-tech', 'ops-manager'], to: 'assigned', required: ['team'],
      extra: { team: { type: 'string', enum: Object.keys(TEAMS) } },
      build: (w, input, role, at) => ({ type: 'workorder.assigned', subject: w.id, actorRole: role, at, data: { asset: w.assetId, trade: input.team } }),
    }),
    example: { input: { workOrderId: 'wo-00001', team: 'estates' } },
  },
  {
    ...workOrderWrite({
      name: 'workorder.complete', summary: 'Close a work order with its outcome: fixed, escalated or no fault found.',
      roles: ['estates-tech'], to: 'completed', required: ['outcome'],
      extra: { outcome: { type: 'string', enum: Object.keys(OUTCOMES) } },
      build: (w, input, role, at) => ({ type: 'workorder.completed', subject: w.id, actorRole: role, at, data: { asset: w.assetId, outcome: input.outcome } }),
    }),
    example: { input: { workOrderId: 'wo-00001', outcome: 'fixed' } },
  },
);

const EXAMPLE_BED = { 'bed.allocate': { encounter: 'enc-000123' }, 'bed.take-out-of-service': { reason: 'Electrical' }, 'bed.flag-expected-discharge': { expectedAt: '2026-11-08T15:00:00.000Z' } };
for (const c of COMMAND_LIST) {
  if (!c.example) c.example = { input: { bedId: 'ward-a1-bed-01', ...(EXAMPLE_BED[c.name] || {}) } };
}

const BY_NAME = new Map(COMMAND_LIST.map((c) => [c.name, c]));
export const commandByName = (name) => BY_NAME.get(name) || null;

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
  const type = actor.type === 'agent' ? 'agent' : 'human';
  if (!roleById(actor.role)) throw new CommandError('forbidden', `Unknown role ${actor.role}.`);
  if (type === 'agent' && !(typeof actor.agent === 'string' && /^[a-z0-9][a-z0-9 ._-]{0,40}$/i.test(actor.agent))) {
    throw new CommandError('forbidden', 'An agent must give its name.');
  }
  return type === 'agent' ? { type, role: actor.role, agent: actor.agent } : { type, role: actor.role };
}

// Run a command. `actor` is { type: 'human', role } or { type: 'agent', agent, role }.
export async function runCommand(core, name, input = {}, actor) {
  const cmd = commandByName(name);
  if (!cmd) throw new CommandError('unknown-command', `There is no command ${name}.`);
  const who = normaliseActor(actor);
  if (!cmd.roles.includes(who.role)) {
    throw new CommandError('forbidden', `${roleById(who.role).name} cannot run ${name}.`, { roles: cmd.roles });
  }
  const errs = validate(cmd.input, input ?? {});
  if (errs.length) throw new CommandError('invalid-input', errs.join('; '), { errors: errs });
  if (who.type === 'human') return cmd.run(core, input ?? {}, { actor: who, wards: null });

  // Agents: off by default, per hospital and per ward; reads are audited; writes become proposals.
  const refuse = async (why) => {
    await core.recordAs(who, 'agent.refused', null, { command: name, why });
    throw new CommandError('agents-off', why);
  };
  if (cmd.agents === false) await refuse('This command is for people only.');
  const access = await agentAccess(core);
  if (!access.allowed) await refuse('Agent access is off for this hospital.');
  const ward = cmd.wardOf ? await cmd.wardOf(core, input) : null;
  if (ward && access.wards[ward] !== true) await refuse(`Agent access is off for ward ${ward}.`);
  const allowedWards = new Set(Object.entries(access.wards).filter(([, on]) => on).map(([id]) => id));
  if (cmd.kind === 'read') {
    const out = await cmd.run(core, input, { actor: who, wards: allowedWards });
    await core.recordAs(who, 'agent.read', null, { command: name, input });
    return out;
  }
  const extra = cmd.snapshot ? await cmd.snapshot(core, input) : {};
  const proposal = await core.propose(who, name, input, { wardId: ward, ...extra });
  return { status: 'proposed', ...(input.bedId ? { bedId: input.bedId } : {}), ...(input.workOrderId ? { workOrderId: input.workOrderId } : {}), proposal };
}
