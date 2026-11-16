// Commands for the shared task object (core/tasks.js). One set for every module that asks a team
// to do a job at a place: a module adds its kinds of task as configuration and gets these
// commands, the audit entries and the agent rules without writing them again.
//
// People decide, Ospeli suggests: an agent may read the queue; anything it asks to change waits
// as a proposal for a person. No free text anywhere on a task, so no personal detail can be typed.

import {
  CommandError, ALL_ROLES, ID, TIME, SYNTHETIC, LIMIT, TOTAL, TRUNCATED, FORMAT, page, idsHint, WRITE_STATUS, PROPOSAL_OUT, EVENT_SEQS,
  placeOrNull, wardOfPlace, isSynthetic,
} from './kit.js';
import { roleById, currentWords } from './model.js';
import {
  TASK_STATES, TASK_PRIORITIES, CANCEL_REASONS, TASK_ID_PATTERN, taskCatalogue, deriveTasks, nextTaskId, openDuplicate, taskTimes, sortQueue,
  bedOfCleanId,
} from './tasks.js';

const TASK_ID = { type: 'string', pattern: TASK_ID_PATTERN, maxLength: 80, description: 'A task id from ospeli_tasks_list: task-00001 for a task someone asked for, clean-<bed id> for the clean of a vacated bed.' };
const STATE = { type: 'string', enum: Object.keys(TASK_STATES) };
const roleNames = (ids) => ids.map((r) => roleById(r)?.name || r).join(', ');

// The commands for one catalogue of task kinds. commands.js calls this once with the kinds the
// modules add; tests call it with their own.
export function taskCommands(packs = []) {
  const { teams, kinds } = taskCatalogue(packs, ALL_ROLES);
  const kindList = [...kinds.values()];
  const askable = kindList.filter((k) => !k.derived);
  const union = (key, list = kindList) => ALL_ROLES.filter((r) => list.some((k) => k[key].includes(r)));

  const TASK = {
    type: 'object', required: ['id', 'kind', 'kindName', 'team', 'locationId', 'priority', 'state', 'requestedAt', 'waitMinutes'],
    properties: {
      id: TASK_ID, kind: { type: 'string', enum: kindList.map((k) => k.id) }, kindName: { type: 'string' },
      team: { type: 'string', enum: Object.keys(teams) }, teamName: { type: 'string' },
      source: { type: 'string', enum: ['task', 'bed'], description: 'bed: read from the bed board (a vacated bed is a clean task). task: someone asked for it.' },
      locationId: ID, locationName: { type: 'string' }, wardId: { type: ['string', 'null'] },
      toLocationId: { type: ['string', 'null'] }, toLocationName: { type: ['string', 'null'] },
      priority: { type: 'string', enum: Object.keys(TASK_PRIORITIES) }, detail: { type: ['string', 'null'] },
      state: STATE, stateName: { type: 'string' },
      requestedAt: TIME, requestedByRole: { type: 'string', description: 'The role that asked. No person is recorded.' },
      startedAt: { type: ['string', 'null'] }, completedAt: { type: ['string', 'null'] }, cancelledAt: { type: ['string', 'null'] }, cancelReason: { type: ['string', 'null'] },
      waitMinutes: { type: 'integer', minimum: 0, description: 'Minutes from asked-for to started (or to now while it waits).' },
      totalMinutes: { type: ['integer', 'null'], description: 'Minutes from asked-for to done; null until it is done.' },
      startLabel: { type: 'string' }, doneLabel: { type: 'string' },
    },
  };
  const WRITE_OUT = {
    type: 'object', required: ['status'],
    properties: { status: WRITE_STATUS, taskId: TASK_ID, state: STATE, events: EVENT_SEQS, proposal: PROPOSAL_OUT },
  };

  async function load(core, events) {
    const [bedList, evs] = await Promise.all([core.listEntities('bed'), events ?? core.events()]);
    const beds = new Map(bedList.map((b) => [b.id, b.parentId]));
    return { beds, ...deriveTasks(evs, { beds }) };
  }
  async function places(core) {
    return new Map((await core.listEntities()).filter((e) => ['site', 'building', 'department', 'ward', 'bed'].includes(e.type)).map((e) => [e.id, e]));
  }
  const placeName = (id, map) => {
    const p = id ? map.get(id) : null;
    if (!p) return id ?? null;
    const parent = p.type === 'bed' ? map.get(p.parentId) : null;
    return currentWords(parent ? `${parent.name}, ${p.name}` : p.name);
  };
  const wardOf = (id, map) => { const p = map.get(id); return p?.type === 'ward' ? p.id : p?.type === 'bed' ? p.parentId : null; };
  function out(t, map, now, short = false) {
    const k = kinds.get(t.kind) || { name: t.kind, team: 'cleaning', startLabel: 'Start', startedName: 'In progress', doneLabel: 'Done' };
    const times = taskTimes(t, now);
    const full = {
      id: t.id, kind: t.kind, kindName: k.name, team: k.team, teamName: teams[k.team] || k.team, source: t.source,
      locationId: t.locationId, locationName: placeName(t.locationId, map), wardId: wardOf(t.locationId, map),
      toLocationId: t.toLocationId, toLocationName: placeName(t.toLocationId, map),
      priority: t.priority, detail: t.detail, state: t.state, stateName: t.state === 'started' ? k.startedName : TASK_STATES[t.state].name,
      requestedAt: t.requestedAt, requestedByRole: t.requestedByRole, startedAt: t.startedAt, completedAt: t.completedAt,
      cancelledAt: t.cancelledAt, cancelReason: t.cancelReason, waitMinutes: times.waitMinutes, totalMinutes: times.totalMinutes,
      startLabel: k.startLabel, doneLabel: k.doneLabel,
    };
    if (!short) return full;
    const { id, kind, kindName, team, locationId, locationName, toLocationName, priority, detail, state, stateName, requestedAt, waitMinutes } = full;
    return { id, kind, kindName, team, locationId, locationName, toLocationName, priority, detail, state, stateName, requestedAt, waitMinutes };
  }

  // The open task a write names, checked the same way for a person, an agent's proposal and a dry run.
  function openTask(tasks, input, role, verb) {
    const t = tasks.open.get(input.taskId);
    if (!t) {
      const bed = bedOfCleanId(input.taskId);
      throw new CommandError('not-found', bed ? `No clean is waiting for bed ${tasks.beds.has(bed) ? bed : '(unknown)'}. ospeli_tasks_list shows the open tasks.` : `No open task ${input.taskId}. It may be done or cancelled already; ospeli_tasks_list shows the open tasks.`);
    }
    if (input.expectedState && t.state !== input.expectedState) throw new CommandError('conflict', 'This task changed since you opened it.', { state: t.state });
    const k = kinds.get(t.kind);
    if (!k) throw new CommandError('conflict', `This kind of task (${t.kind}) is not set up on this site.`);
    const may = verb === 'cancel' ? [...new Set([...k.requestRoles, ...k.doRoles])] : verb === 'reorder' ? (k.leadRoles || k.doRoles) : k.doRoles;
    if (role && !may.includes(role)) throw new CommandError('forbidden', `${roleById(role)?.name || 'This role'} cannot ${verb} a ${k.name.toLowerCase()} task. That is for: ${roleNames(may)}.`, { roles: may });
    return { t, k };
  }

  function taskWrite({ name, summary, verb, to, extra = {}, required = [], events, guard, example }) {
    return {
      name, summary, kind: 'write', approval: true,
      roles: verb === 'cancel' ? ALL_ROLES.filter((r) => askable.some((k) => k.requestRoles.includes(r) || k.doRoles.includes(r)))
        : verb === 'reorder' ? ALL_ROLES.filter((r) => kindList.some((k) => (k.leadRoles || k.doRoles).includes(r))) : union('doRoles'),
      input: {
        type: 'object', additionalProperties: false, required: ['taskId', ...required],
        properties: { taskId: TASK_ID, ...extra, expectedState: { ...STATE, description: 'The state the caller last saw. If the task has changed since, the command is refused (conflict).' } },
      },
      output: WRITE_OUT,
      target: (input) => ({ id: input.taskId, word: 'task' }),
      async wardOf(core, input) {
        const bed = bedOfCleanId(input.taskId);
        if (bed) return wardOfPlace(core, bed);
        const t = (await load(core)).open.get(input.taskId);
        return t ? wardOfPlace(core, t.locationId) : null;
      },
      async snapshot(core, input) { return { seenState: input.expectedState ?? (await load(core)).open.get(input.taskId)?.state ?? null }; },
      async precheck(core, input, { actor } = {}) { const { t } = openTask(await load(core), input, actor?.role, verb); if (guard) guard(t, input); },
      async run(core, input, { actor }) {
        let kind = null; let was = null;
        const recs = await core.appendChecked(async (evs) => {
          const { t } = openTask(await load(core, evs), input, actor.role, verb);
          if (guard) guard(t, input);
          kind = t.kind; was = t.state;
          return events(t, input, actor.role, core.now());
        });
        // `to` is the state the task is left in; a change of priority leaves the state as it was.
        await core.recordAs(actor, `task.${to || 'prioritised'}`, input.taskId, { kind, ...(to ? {} : { priority: input.priority }) });
        return { status: 'done', taskId: input.taskId, state: to || was, events: recs.map((r) => r.seq) };
      },
      example,
    };
  }
  const ev = (type, subject, role, at, data = null) => ({ type, subject, actorRole: role, at, data });
  const NEED_OPEN = 'An open task. clean-ward-a1-bed-01 is an example id (the clean of a bed that has just been vacated), and beds move on through the day: ospeli_tasks_list with { "state": "open" } lists the open tasks with their ids.';

  // Every check a request passes, for a person, an agent's proposal and a dry run.
  async function verifyRequest(core, input, role, events) {
    const k = kinds.get(input.kind);
    if (role && !k.requestRoles.includes(role)) throw new CommandError('forbidden', `${roleById(role)?.name || 'This role'} cannot ask for a ${k.name.toLowerCase()}. It is for: ${roleNames(k.requestRoles)}.`, { roles: k.requestRoles });
    const where = async (id, what) => {
      const p = await placeOrNull(core, id);
      if (!p) throw new CommandError('not-found', `No place with that id for ${what}. Use a ward, department or bed id, for example ward-a1.`);
      if (!k.placeTypes.includes(p.type)) throw new CommandError('invalid-input', `A ${k.name.toLowerCase()} is asked for a ${k.placeTypes.join(' or ')}, not a ${p.type}.`, { placeTypes: k.placeTypes });
      return p;
    };
    await where(input.locationId, 'locationId');
    if (k.needsTo) {
      if (!input.toLocationId) throw new CommandError('invalid-input', `A ${k.name.toLowerCase()} needs a place to go to: add toLocationId.`, { example: { kind: k.id, locationId: input.locationId, toLocationId: 'dept-imaging' } });
      await where(input.toLocationId, 'toLocationId');
      if (input.toLocationId === input.locationId) throw new CommandError('invalid-input', 'The place to go to must be different from the place to collect from.');
    } else if (input.toLocationId) throw new CommandError('invalid-input', `A ${k.name.toLowerCase()} has no destination: leave out toLocationId.`);
    if (k.details) {
      if (!k.details.includes(input.detail)) throw new CommandError('invalid-input', `detail must be one of: ${k.details.join(', ')}.`, { details: k.details });
    } else if (input.detail != null) throw new CommandError('invalid-input', `A ${k.name.toLowerCase()} takes no detail: leave it out.`);
    const tasks = await load(core, events);
    const dup = openDuplicate(tasks.open, input);
    if (dup) throw new CommandError('conflict', `${dup.id} is already open for the same job at the same place. No new task was opened.`, { existing: dup.id });
  }

  const list = [
    {
      name: 'ospeli_tasks_kinds',
      summary: 'The kinds of task this site can ask for (a clean, a move, a delivery), with the team that does each, the roles that may ask for and do it, and the details to pick from. Read-only.',
      kind: 'read', roles: ALL_ROLES, approval: false,
      input: { type: 'object', additionalProperties: false, properties: {} },
      output: { type: 'object', required: ['teams', 'kinds', 'priorities', 'cancelReasons'], properties: {
        teams: { type: 'array', items: { type: 'object', required: ['id', 'name'], properties: { id: { type: 'string' }, name: { type: 'string' } } } },
        kinds: { type: 'array', items: { type: 'object', required: ['id', 'name', 'team', 'askable'], properties: {
          id: { type: 'string' }, name: { type: 'string' }, team: { type: 'string' },
          askable: { type: 'boolean', description: 'false: nobody asks for it by hand. A bed clean starts by itself when a bed is vacated on the bed board.' },
          needsTo: { type: 'boolean', description: 'true: the task also needs a place to go to (toLocationId).' },
          details: { type: ['array', 'null'], items: { type: 'string' }, description: 'When present, pick one as the task\'s detail.' },
          placeTypes: { type: 'array', items: { type: 'string' } }, requestRoles: { type: 'array', items: { type: 'string' } }, doRoles: { type: 'array', items: { type: 'string' } },
          startLabel: { type: 'string' }, doneLabel: { type: 'string' } } } },
        priorities: { type: 'array', items: { type: 'string' } }, cancelReasons: { type: 'array', items: { type: 'string' } } } },
      async run() {
        return {
          teams: Object.entries(teams).map(([id, name]) => ({ id, name })),
          kinds: kindList.map((k) => ({ id: k.id, name: k.name, team: k.team, askable: !k.derived, needsTo: !!k.needsTo, details: k.details || null,
            placeTypes: k.derived ? ['bed'] : k.placeTypes, requestRoles: [...k.requestRoles], doRoles: [...k.doRoles], startLabel: k.startLabel, doneLabel: k.doneLabel })),
          priorities: Object.keys(TASK_PRIORITIES), cancelReasons: [...CANCEL_REASONS],
        };
      },
      example: { input: {} },
    },
    {
      name: 'ospeli_tasks_list',
      summary: 'A team\'s queue: open tasks (cleans, moves, deliveries) with place, how long each has waited and its state, urgent first and then the longest wait. A vacated bed appears here as a clean task by itself. For "what is waiting on this ward" pass locationId. Read-only.',
      kind: 'read', roles: ALL_ROLES, approval: false,
      input: { type: 'object', additionalProperties: false, properties: {
        state: { type: 'string', enum: ['open', 'completed', 'cancelled', 'all'], description: 'open (default) means waiting or in progress.' },
        team: { type: 'string', enum: Object.keys(teams), description: 'One team\'s queue. Leave out for every team.' },
        kind: { type: 'string', enum: kindList.map((k) => k.id) },
        locationId: { ...ID, description: 'A ward, department or bed id, for example ward-a1. A ward matches its beds too.' },
        since: { ...TIME, description: 'Only tasks asked for at or after this time. Useful with completed.' },
        format: FORMAT('what, where, priority, state and wait', 'who asked (role only), times and labels too'),
        limit: LIMIT(30, 500, 'tasks') } },
      output: { type: 'object', required: ['asOf', 'synthetic', 'tasks', 'counts', 'total', 'truncated'], properties: {
        asOf: TIME, synthetic: SYNTHETIC, total: TOTAL, truncated: TRUNCATED, tasks: { type: 'array', items: TASK },
        counts: { type: 'object', required: ['open', 'waiting', 'inProgress', 'urgent', 'byTeam'], description: 'Open tasks for the same filters, before the limit.', properties: {
          open: { type: 'integer' }, waiting: { type: 'integer' }, inProgress: { type: 'integer' }, urgent: { type: 'integer' },
          longestWaitMinutes: { type: ['integer', 'null'], description: 'The longest wait among tasks not yet started.' },
          byTeam: { type: 'object', description: 'Open tasks per team id.' } } } } },
      wardOf: (core, input) => (input.locationId ? wardOfPlace(core, input.locationId) : null),
      async run(core, input, { wards: allowed }) {
        const now = core.now();
        const [tasks, map] = await Promise.all([load(core), places(core)]);
        if (input.locationId && !(await placeOrNull(core, input.locationId))) {
          const can = [...map.values()].filter((p) => p.type === 'ward' && (!allowed || allowed.has(p.id))).map((p) => ({ id: p.id, name: currentWords(p.name) }));
          throw new CommandError('not-found', `No place with that id. ${can.length ? `For a ward use one of: ${idsHint(can)}.` : 'No ward is open to this caller.'}`, { wards: can.slice(0, 50) });
        }
        const teamOf = (t) => kinds.get(t.kind)?.team;
        const here = (t) => !input.locationId || t.locationId === input.locationId || wardOf(t.locationId, map) === input.locationId || t.toLocationId === input.locationId;
        // An agent sees the tasks of the wards it is allowed on, and no others.
        const mine = tasks.all.filter((t) => (!allowed || allowed.has(wardOf(t.locationId, map)))
          && here(t) && (!input.team || teamOf(t) === input.team) && (!input.kind || t.kind === input.kind) && (!input.since || t.requestedAt >= input.since));
        const open = mine.filter((t) => t.state === 'requested' || t.state === 'started');
        const state = input.state || 'open';
        const newest = (key) => (a, b) => ((a[key] || '') < (b[key] || '') ? 1 : -1);
        const pick = state === 'open' ? sortQueue(open)
          : state === 'completed' ? mine.filter((t) => t.state === 'completed').sort(newest('completedAt'))
            : state === 'cancelled' ? mine.filter((t) => t.state === 'cancelled').sort(newest('cancelledAt'))
              : [...sortQueue(open), ...mine.filter((t) => t.state === 'completed' || t.state === 'cancelled').sort(newest('requestedAt'))];
        const cut = page(pick, input.limit, 30);
        const waiting = open.filter((t) => t.state === 'requested');
        const byTeam = {};
        for (const t of open) byTeam[teamOf(t)] = (byTeam[teamOf(t)] || 0) + 1;
        return {
          asOf: now, synthetic: await isSynthetic(core),
          tasks: cut.items.map((t) => out(t, map, now, input.format === 'short')), total: cut.total, truncated: cut.truncated,
          counts: { open: open.length, waiting: waiting.length, inProgress: open.length - waiting.length, urgent: open.filter((t) => t.priority === 'urgent').length,
            longestWaitMinutes: waiting.length ? Math.max(...waiting.map((t) => taskTimes(t, now).waitMinutes)) : null, byTeam },
        };
      },
      example: { input: { state: 'open' } },
    },
    taskWrite({
      name: 'ospeli_tasks_start', verb: 'start', to: 'started',
      summary: 'A team has started a task that was waiting (cleaning started, patient or goods collected). For the clean of a vacated bed, the bed board shows the bed as being cleaned.',
      guard: (t) => { if (t.state !== 'requested') throw new CommandError('conflict', 'This task is already in progress.', { state: t.state }); },
      events: (t, input, role, at) => [t.source === 'bed' ? ev('bed.clean-started', t.locationId, role, at) : ev('task.started', t.id, role, at)],
      example: { input: { taskId: 'clean-ward-a1-bed-01' }, needs: `${NEED_OPEN} It must still be waiting, not in progress.` },
    }),
    taskWrite({
      name: 'ospeli_tasks_complete', verb: 'complete', to: 'completed',
      summary: 'A task is done (clean finished, patient or goods delivered). For the clean of a vacated bed, the bed board shows the bed as ready. A task that was never marked started is recorded as started and done at the same moment.',
      events: (t, input, role, at) => (t.source === 'bed'
        ? [...(t.state === 'requested' ? [ev('bed.clean-started', t.locationId, role, at)] : []), ev('bed.cleaned', t.locationId, role, at)]
        : [...(t.state === 'requested' ? [ev('task.started', t.id, role, at)] : []), ev('task.completed', t.id, role, at)]),
      example: { input: { taskId: 'clean-ward-a1-bed-01' }, needs: NEED_OPEN },
    }),
    taskWrite({
      name: 'ospeli_tasks_set_priority', verb: 'reorder', to: null,
      summary: 'Move an open task to the front of its team\'s queue (urgent) or back to its place by waiting time (routine). For the people who balance the work; an agent may propose it with its reasons and a person decides. It changes the order only: nothing is started or assigned to anyone.',
      extra: { priority: { type: 'string', enum: Object.keys(TASK_PRIORITIES), description: 'urgent: to the front of the queue. routine: back to its place by waiting time.' } }, required: ['priority'],
      guard: (t, input) => { if (t.priority === input.priority) throw new CommandError('conflict', `This task is already ${TASK_PRIORITIES[t.priority].name.toLowerCase()}.`, { priority: t.priority }); },
      events: (t, input, role, at) => [ev('task.prioritised', t.id, role, at, { priority: input.priority })],
      example: { input: { taskId: 'clean-ward-a1-bed-01', priority: 'urgent' }, needs: NEED_OPEN },
    }),
  ];

  if (askable.length) {
    const first = askable[0];
    list.push(
      {
        name: 'ospeli_tasks_request',
        summary: `Ask a team to do a job at a place: ${askable.map((k) => k.name.toLowerCase()).join(', ')}. It joins that team's queue. If the same job is already open for the same place, nothing new is opened: the answer is a conflict that names it in detail.existing. A bed clean is never asked for here: it starts by itself when a bed is vacated.`,
        kind: 'write', roles: union('requestRoles', askable), approval: true,
        input: { type: 'object', additionalProperties: false, required: ['kind', 'locationId'], properties: {
          kind: { type: 'string', enum: askable.map((k) => k.id), description: 'What is needed. ospeli_tasks_kinds lists each kind with the details to pick from.' },
          locationId: { ...ID, description: 'Where the job is, or where to collect from: a ward, department or bed id, for example ward-a1.' },
          toLocationId: { ...ID, description: 'Where to take the patient or goods. Only for kinds that need a destination.' },
          priority: { type: 'string', enum: Object.keys(TASK_PRIORITIES), description: 'routine (default) or urgent. Urgent goes to the front of the team\'s queue.' },
          detail: { type: 'string', maxLength: 60, description: 'Pick one from the kind\'s details list (ospeli_tasks_kinds). No free text, so no personal details.' } } },
        output: { type: 'object', required: ['status'], properties: { status: WRITE_STATUS, taskId: TASK_ID, state: STATE, team: { type: 'string' }, events: EVENT_SEQS, proposal: PROPOSAL_OUT } },
        wardOf: (core, input) => wardOfPlace(core, input.locationId),
        async precheck(core, input, { actor } = {}) { await verifyRequest(core, input, actor?.role); },
        async run(core, input, { actor }) {
          let id = null;
          const recs = await core.appendChecked(async (evs) => {
            await verifyRequest(core, input, actor.role, evs);
            id = nextTaskId(evs);
            return [ev('task.requested', id, actor.role, core.now(), {
              kind: input.kind, locationId: input.locationId, toLocationId: input.toLocationId ?? null, priority: input.priority || 'routine', detail: input.detail ?? null })];
          });
          await core.recordAs(actor, 'task.requested', id, { kind: input.kind, locationId: input.locationId, priority: input.priority || 'routine' });
          return { status: 'done', taskId: id, state: 'requested', team: kinds.get(input.kind).team, events: recs.map((r) => r.seq) };
        },
        example: { input: { kind: first.id, locationId: 'ward-a1', ...(first.needsTo ? { toLocationId: 'dept-imaging' } : {}), ...(first.details ? { detail: first.details[0] } : {}) } },
      },
      taskWrite({
        name: 'ospeli_tasks_cancel', verb: 'cancel', to: 'cancelled',
        summary: 'Cancel an open task that someone asked for, with a reason from the list. A bed clean cannot be cancelled here: it follows the bed board.',
        extra: { reason: { type: 'string', enum: CANCEL_REASONS } }, required: ['reason'],
        guard: (t) => { if (t.source === 'bed') throw new CommandError('conflict', 'A bed clean follows the bed board and cannot be cancelled here. If the bed should not be used, take it out of service on the bed board.'); },
        events: (t, input, role, at) => [ev('task.cancelled', t.id, role, at, { reason: input.reason })],
        example: { input: { taskId: 'task-00001', reason: CANCEL_REASONS[0] }, needs: 'An open task that someone asked for. task-00001 is an example id: ospeli_tasks_list with { "state": "open" } lists the open tasks, and ospeli_tasks_request opens one.' },
      }),
    );
  }
  return list;
}
