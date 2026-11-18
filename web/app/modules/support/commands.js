// Cleaning and transport: the module's pack (see core/modules.js for the contract).
// Plain data and pure functions; no screen code, so the same file runs in the browser, in tests
// and on a site's own server.
//
// The jobs themselves (ask, start, done, cancel, move to the front) are the shared task commands
// (ospeli_tasks_*): this pack adds its kinds of task as configuration and writes no task command.
// Its own commands are the cleaning audit, the overview (KPIs, team counts, the guide) and the
// guide's off switch. Nothing here calls a model.

import {
  CommandError, ALL_ROLES, ID, TIME, SYNTHETIC, LIMIT, TOTAL, TRUNCATED, FORMAT, page, WRITE_STATUS, PROPOSAL_OUT, EVENT_SEQS,
  placeOrNull, wardOfPlace, isSynthetic, sameMoment, DAY, HOUR, MIN,
} from '../../core/kit.js';
import { currentWords } from '../../core/model.js';
import { deriveTasks, taskTimes, BED_CLEAN } from '../../core/tasks.js';
import { deriveBoard } from '../../core/beds.js';
import {
  TEAMS, KINDS, TEAM_OF, TEAM_NAMES, RISK_CATEGORIES, RISK_NAME, AUDIT_ELEMENTS, ELEMENT_NAME, AUDIT_PLACE_TYPES, AUDIT_SET_NOTE, PASS_MARK,
  BED_TURNAROUND_TARGET, GUIDE_RULES, deriveAudits, nextAuditId, guideOn, queueMarks, bedTurnaround, porterRequestToDone, auditScore,
  ruleCleansFirst, ruleTeamBusy, ruleAuditFailedTwice,
} from './logic.js';

export const id = 'support';
export const PREFIX = 'ospeli_support_';
export const EVENT_PREFIX = 'support.';
export const TASK_TEAMS = TEAMS;
export const TASK_KINDS = KINDS;

// Every number has a definition and a source. Targets are example settings unless a cited source sets one.
export const KPIS = [
  { id: 'support-bed-turnaround', name: 'Bed turnaround time', unit: 'minutes',
    definition: 'Median minutes from a bed being vacated on the bed board to its clean being done and the bed ready.',
    counts: 'Bed cleans finished in the period.', outOf: 'None (a median).',
    leavesOut: 'Beds still waiting for a clean or being cleaned; a bed used again or taken out of service before a clean was recorded (counted apart as leftOut).',
    source: 'local definition (the same as the bed board\'s bed turnaround)',
    target: BED_TURNAROUND_TARGET, targetText: `${BED_TURNAROUND_TARGET} minutes or less (example setting, not a standard; set locally)` },
  { id: 'porter-request-to-done', name: 'Transport request to completion', unit: 'minutes',
    definition: 'Median minutes from a transport job being asked for to it being delivered, for each kind of job, for urgent and normal jobs, and for all transport jobs. A job that was handed back keeps the time it was first asked for.',
    counts: 'Transport jobs delivered in the period.', outOf: 'None (a median).',
    leavesOut: 'Cancelled jobs and jobs still open.',
    source: 'local definition', target: null, targetText: 'No target set: track the trend.' },
  { id: 'cleanliness-audit-score', name: 'Cleanliness audit score', unit: '%',
    definition: 'Items passed divided by items checked, for each type of area and for all audits.',
    counts: 'Items marked pass.', outOf: 'Items marked pass or fail in the audits recorded in the period.',
    leavesOut: 'Items not checked in an audit.',
    source: 'Your site\'s cleanliness standard (set locally). The list of items and the types of area here are an example set, not a standard.',
    target: PASS_MARK, targetText: `${PASS_MARK}% pass mark (example setting, not a standard)` },
];
// Planned with the shared stock item (module B4): listed so a reader knows they are coming, with no value.
const PLANNED_KPIS = [
  { id: 'linen-stock-outs', name: 'Linen stock-outs', status: 'planned', note: 'Planned, not built yet: it needs the shared stock item.' },
  { id: 'meal-waste', name: 'Meal waste', status: 'planned', note: 'Planned, not built yet: it needs the shared stock item.' },
];

// ---- places ----
async function placeMap(core) {
  return new Map((await core.listEntities()).filter((e) => ['site', 'building', 'department', 'ward', 'bed'].includes(e.type)).map((e) => [e.id, e]));
}
const nameOf = (map, id) => {
  const p = map.get(id);
  if (!p) return id;
  const parent = p.type === 'bed' ? map.get(p.parentId) : null;
  return currentWords(parent ? `${parent.name}, ${p.name}` : p.name);
};
const wardIn = (map, id) => { const p = map.get(id); return p?.type === 'ward' ? p.id : p?.type === 'bed' ? p.parentId : null; };
// An agent sees what sits in the wards it is allowed on (`wards`), and nothing else; a person sees all.
const visible = (map, wards) => (placeId) => !wards || wards.has(wardIn(map, placeId));
const synth = (core) => isSynthetic(core);

// ---- cleaning audits ----
const ELEMENT = { type: 'string', enum: AUDIT_ELEMENTS.map((e) => e.id) };
const RISK = { type: 'string', enum: RISK_CATEGORIES.map((c) => c.id), description: 'The risk category of the area, from the site\'s list (this example: very-high, high, moderate, low).' };
const AUDIT_ID = { type: 'string', pattern: '^aud-[0-9]{5,}$', maxLength: 20 };
const DOUBLE_TAP = 10 * MIN; // the same audit of the same area within this time is a repeat, not a new audit
const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x));

async function checkAudit(core, input, events) {
  const p = await placeOrNull(core, input.locationId);
  if (!p) throw new CommandError('not-found', 'No place with that id. Use a ward or department id, for example ward-a1 or dept-imaging (ospeli_support_places lists them).');
  if (!AUDIT_PLACE_TYPES.includes(p.type)) throw new CommandError('invalid-input', `An audit is for a ward or a department, not a ${p.type}.`, { placeTypes: AUDIT_PLACE_TYPES });
  const passed = input.passed || []; const failed = input.failed || [];
  if (!passed.length && !failed.length) throw new CommandError('invalid-input', 'Mark at least one element pass or fail, for example { "passed": ["floor"], "failed": ["bins"] }.', { elements: AUDIT_ELEMENTS.map((e) => e.id) });
  if (new Set(passed).size !== passed.length || new Set(failed).size !== failed.length) throw new CommandError('invalid-input', 'Each element is listed once.');
  const both = passed.filter((x) => failed.includes(x));
  if (both.length) throw new CommandError('invalid-input', `An element is either passed or failed, not both: ${both.join(', ')}.`);
  const evs = events ?? await core.events({ type: 'support.audit-recorded' });
  const recent = deriveAudits(evs).filter((a) => a.locationId === input.locationId && Date.parse(core.now()) - Date.parse(a.at) < DOUBLE_TAP).at(-1);
  if (recent && recent.riskCategory === input.riskCategory && sameSet(recent.passed, passed) && sameSet(recent.failed, failed)) {
    throw new CommandError('conflict', `${recent.id} with the same results was saved for this area a few minutes ago. No second audit was saved.`, { existing: recent.id });
  }
}

const auditOut = (a, map) => ({
  id: a.id, locationId: a.locationId, locationName: nameOf(map, a.locationId), riskCategory: a.riskCategory, riskName: RISK_NAME[a.riskCategory],
  at: a.at, byRole: a.byRole, audited: a.audited, passed: a.passed.length, score: Math.round(a.score * 10) / 10,
  failed: a.failed.map((x) => ({ id: x, name: ELEMENT_NAME[x] })), belowPassMark: a.score < PASS_MARK,
});

// ---- the overview: KPIs, team counts and the guide in one read ----
async function overview(core, input, wards) {
  const now = core.now();
  const days = input.days ?? 7;
  const since = new Date(Date.parse(now) - days * DAY).toISOString();
  const [events, map] = await Promise.all([core.events(), placeMap(core)]);
  const bedList = [...map.values()].filter((p) => p.type === 'bed');
  const beds = new Map(bedList.map((b) => [b.id, b.parentId]));
  const see = visible(map, wards);
  const { all } = deriveTasks(events, { beds });
  const mine = all.filter((t) => see(t.locationId));
  const audits = deriveAudits(events).filter((a) => see(a.locationId));
  const open = mine.filter((t) => t.state === 'requested' || t.state === 'started');
  const teams = Object.entries(TEAM_NAMES).map(([teamId, name]) => {
    const list = open.filter((t) => TEAM_OF[t.kind] === teamId);
    const waiting = list.filter((t) => t.state === 'requested');
    return { id: teamId, name, open: list.length, waiting: waiting.length, inProgress: list.length - waiting.length, urgent: list.filter((t) => t.priority === 'urgent').length,
      longestWaitMinutes: waiting.length ? Math.max(...waiting.map((t) => taskTimes(t, now).waitMinutes)) : null };
  });
  // An agent's numbers cover its own wards only.
  const seenBeds = wards ? new Map([...beds].filter(([, w]) => wards.has(w))) : beds;
  const values = {
    'support-bed-turnaround': bedTurnaround(events, { since, until: now, beds: seenBeds }),
    'porter-request-to-done': porterRequestToDone(events, { since, until: now, tasks: mine }),
    'cleanliness-audit-score': auditScore(events, { since, until: now, audits }),
  };
  // Bed demand is a fact from the bed board, shown with the guide on or off: patients waiting for a
  // bed on each ward with no bed held, and the beds free there now.
  const board = deriveBoard(bedList, events);
  const wardName = new Map([...map.values()].filter((p) => p.type === 'ward').map((w) => [w.id, currentWords(w.name)]));
  const patientsWaiting = new Map(); const freeBeds = new Map();
  for (const w of board.waiting) if (!w.allocatedBed && w.wardId && (!wards || wards.has(w.wardId))) patientsWaiting.set(w.wardId, (patientsWaiting.get(w.wardId) || 0) + 1);
  for (const [bedId, s] of board.beds) if (s.state === 'available') freeBeds.set(beds.get(bedId), (freeBeds.get(beds.get(bedId)) || 0) + 1);
  const bedDemand = [...wardName.keys()].filter((w) => !wards || wards.has(w)).map((w) => ({ wardId: w, patientsWaiting: patientsWaiting.get(w) || 0, freeBeds: freeBeds.get(w) || 0 }));
  const openIds = new Set(open.map((t) => t.id));
  const marks = Object.fromEntries([...queueMarks(events)].filter(([taskId]) => openIds.has(taskId)));
  const on = guideOn(events);
  let suggestions = [];
  if (on) {
    const openCleans = open.filter((t) => t.kind === BED_CLEAN.id).map((t) => ({ id: t.id, wardId: beds.get(t.locationId), state: t.state, priority: t.priority, requestedAt: t.requestedAt, bedName: map.get(t.locationId)?.name || t.locationId }));
    suggestions = [
      ...ruleCleansFirst({ openCleans, patientsWaiting, freeBeds, wardName }),
      ...ruleTeamBusy(teams),
      ...ruleAuditFailedTwice(audits, (pid) => nameOf(map, pid)),
    ];
  }
  const kpis = KPIS.map((k) => {
    const v = values[k.id];
    const base = { id: k.id, name: k.name, unit: k.unit, value: v.value, numerator: v.numerator, denominator: v.denominator, n: v.n, target: k.target, targetText: k.targetText };
    return input.format === 'short' ? base : { ...base, breakdown: v.breakdown, ...(v.byPriority ? { byPriority: v.byPriority } : {}), ...(v.leftOut ? { leftOut: v.leftOut } : {}),
      definition: k.definition, counts: k.counts, outOf: k.outOf, leavesOut: k.leavesOut, source: k.source };
  });
  return {
    asOf: now, synthetic: await synth(core), period: { since, until: now, days }, kpis, planned: PLANNED_KPIS.map((x) => ({ ...x })), teams, bedDemand, marks,
    guide: { on, rules: GUIDE_RULES.map((r) => ({ ...r })), suggestions },
    note: 'Measures jobs and waits, never individual cleaners or transport assistants. Does not set isolation or infection decisions or patient diets.',
  };
}

const KPI_OUT = { type: 'object', required: ['id', 'name', 'unit', 'value'], properties: {
  id: { type: 'string' }, name: { type: 'string' }, unit: { type: 'string' }, value: { type: ['number', 'null'], description: 'null when nothing was counted in the period.' },
  numerator: { type: ['number', 'null'] }, denominator: { type: ['number', 'null'] }, n: { type: 'integer', description: 'How many jobs or audits the value is from.' },
  target: { type: ['number', 'null'] }, targetText: { type: 'string' }, breakdown: { type: 'array', description: 'By kind of job or by risk category.' },
  definition: { type: 'string' }, counts: { type: 'string' }, outOf: { type: 'string' }, leavesOut: { type: 'string' }, source: { type: 'string' } } };
const SUGGESTION = { type: 'object', required: ['rule', 'id', 'text', 'why', 'basis'], properties: {
  rule: { type: 'string' }, id: { type: 'string' }, text: { type: 'string' }, why: { type: 'string' }, basis: { type: 'string' },
  action: { type: ['object', 'null'], description: 'The commands a person may run to follow the suggestion (each one, for an agent, a proposal). null: advice only.' } } };

export const COMMANDS = [
  {
    name: 'ospeli_support_places',
    summary: 'The places a job can be asked for or a cleaning audit recorded: each ward with its beds, and the departments, with ids and plain names. Use the ids with ospeli_tasks_request (locationId, toLocationId) and ospeli_support_audit_record. Read-only.',
    kind: 'read', roles: ALL_ROLES, approval: false,
    input: { type: 'object', additionalProperties: false, properties: { limit: LIMIT(100, 500, 'wards and departments') } },
    output: { type: 'object', required: ['wards', 'departments', 'total', 'truncated'], properties: {
      wards: { type: 'array', items: { type: 'object', required: ['id', 'name', 'beds'], properties: { id: ID, name: { type: 'string' }, beds: { type: 'array' } } } },
      departments: { type: 'array', items: { type: 'object', required: ['id', 'name'], properties: { id: ID, name: { type: 'string' } } } },
      total: TOTAL, truncated: TRUNCATED } },
    async run(core, input, { wards }) {
      const map = await placeMap(core);
      const list = [...map.values()];
      const all = [
        ...list.filter((p) => p.type === 'ward' && (!wards || wards.has(p.id))),
        ...list.filter((p) => p.type === 'department'),
      ];
      const cut = page(all, input.limit, 100);
      return {
        wards: cut.items.filter((p) => p.type === 'ward').map((w) => ({ id: w.id, name: currentWords(w.name), beds: list.filter((b) => b.type === 'bed' && b.parentId === w.id).map((b) => ({ id: b.id, name: b.name })) })),
        departments: cut.items.filter((p) => p.type === 'department').map((d) => ({ id: d.id, name: currentWords(d.name) })),
        total: cut.total, truncated: cut.truncated,
      };
    },
    example: { input: {} },
  },
  {
    name: 'ospeli_support_overview',
    summary: 'Cleaning and transport at a glance, in one call: the three measures with their definitions and sources (bed turnaround, transport request to completion, cleanliness audit score), open jobs per team with the longest wait, and the guide\'s suggestions with their reasons and basis (empty while the guide is off). Linen and meal measures are listed as planned, with no value. Measures jobs and waits, never people. Read-only.',
    kind: 'read', roles: ALL_ROLES, approval: false,
    input: { type: 'object', additionalProperties: false, properties: {
      days: { type: 'integer', minimum: 1, maximum: 30, description: 'The period for the measures: the last this many days. Default 7.' },
      format: FORMAT('the values without their definitions', 'each value with its definition, source and breakdown') } },
    output: { type: 'object', required: ['asOf', 'synthetic', 'period', 'kpis', 'planned', 'teams', 'guide'], properties: {
      asOf: TIME, synthetic: SYNTHETIC, period: { type: 'object' }, kpis: { type: 'array', items: KPI_OUT },
      planned: { type: 'array', items: { type: 'object', required: ['id', 'name', 'status'] } },
      teams: { type: 'array', items: { type: 'object', required: ['id', 'name', 'open', 'waiting', 'inProgress', 'urgent', 'longestWaitMinutes'] } },
      guide: { type: 'object', required: ['on', 'rules', 'suggestions'], properties: { on: { type: 'boolean' }, rules: { type: 'array' }, suggestions: { type: 'array', items: SUGGESTION } } },
      bedDemand: { type: 'array', description: 'For each ward: patients waiting for a bed there with no bed held, and beds free now. A fact from the bed board, with the guide on or off.' },
      marks: { type: 'object', description: 'Open jobs first in their queue, by id: "asked-urgent" (the ward asked for it urgently) or "do-next" (moved to the front by the people who balance the work).' },
      note: { type: 'string' } } },
    async run(core, input, { wards }) { return overview(core, input, wards); },
    example: { input: { days: 7, format: 'short' } },
  },
  {
    name: 'ospeli_support_audits_list',
    summary: 'Cleaning audit results: each audit with its score (elements passed / elements audited) and the elements that failed and need action, newest first; a line per area with its last score; and the checklist in use (an example set, set locally, not a standard). Filter by locationId or riskCategory. Read-only.',
    kind: 'read', roles: ALL_ROLES, approval: false,
    input: { type: 'object', additionalProperties: false, properties: {
      locationId: { ...ID, description: 'One ward or department, for example ward-a1.' }, riskCategory: RISK,
      since: { ...TIME, description: 'Only audits recorded at or after this time.' },
      format: FORMAT('audits without the checklist', 'the checklist too'), limit: LIMIT(20, 200, 'audits') } },
    output: { type: 'object', required: ['asOf', 'synthetic', 'audits', 'areas', 'total', 'truncated'], properties: {
      asOf: TIME, synthetic: SYNTHETIC, total: TOTAL, truncated: TRUNCATED,
      audits: { type: 'array', items: { type: 'object', required: ['id', 'locationId', 'riskCategory', 'at', 'audited', 'passed', 'score', 'failed'] } },
      areas: { type: 'array', items: { type: 'object', required: ['locationId', 'locationName', 'audits', 'last'] } },
      checklist: { type: 'object', description: 'Risk categories, elements and the pass mark in use.' } } },
    wardOf: (core, input) => (input.locationId ? wardOfPlace(core, input.locationId) : null),
    async run(core, input, { wards }) {
      const map = await placeMap(core);
      if (input.locationId && !map.has(input.locationId)) throw new CommandError('not-found', 'No place with that id. ospeli_support_places lists the wards and departments.');
      const see = visible(map, wards);
      const all = deriveAudits(await core.events({ type: 'support.audit-recorded' })).filter((a) => see(a.locationId));
      const areas = [];
      for (const pid of [...new Set(all.map((a) => a.locationId))]) {
        const list = all.filter((a) => a.locationId === pid);
        const [prev, last] = list.length > 1 ? list.slice(-2) : [null, list[0]];
        areas.push({ locationId: pid, locationName: nameOf(map, pid), riskCategory: last.riskCategory, riskName: RISK_NAME[last.riskCategory], audits: list.length,
          last: { id: last.id, at: last.at, score: Math.round(last.score * 10) / 10 }, belowPassMark: last.score < PASS_MARK,
          failedTwice: !!prev && prev.score < PASS_MARK && last.score < PASS_MARK });
      }
      areas.sort((a, b) => (a.locationName < b.locationName ? -1 : 1));
      const since = sameMoment(input.since);
      const pick = all.filter((a) => (!input.locationId || a.locationId === input.locationId) && (!input.riskCategory || a.riskCategory === input.riskCategory) && (!since || a.at >= since)).reverse();
      const cut = page(pick, input.limit, 20);
      return {
        asOf: core.now(), synthetic: await synth(core), total: cut.total, truncated: cut.truncated,
        audits: cut.items.map((a) => auditOut(a, map)), areas,
        ...(input.format === 'short' ? {} : { checklist: { note: AUDIT_SET_NOTE, passMark: PASS_MARK, passMarkText: `${PASS_MARK}% (example setting, not a standard)`,
          categories: RISK_CATEGORIES.map((c) => ({ ...c })), elements: AUDIT_ELEMENTS.map((e) => ({ ...e })), placeTypes: [...AUDIT_PLACE_TYPES] } }),
      };
    },
    example: { input: { locationId: 'ward-a1', limit: 5 } },
  },
  {
    name: 'ospeli_support_audit_record',
    summary: 'Record a cleaning audit of a ward or department: its risk category and each element checked, pass or fail (pick lists only, nothing typed). The score is elements passed / elements audited; failed elements are listed as needing action. The checklist is an example set, set locally, not a standard: ospeli_support_audits_list returns it. An agent\'s call becomes a proposal for a person.',
    kind: 'write', roles: ['support-supervisor'], approval: true,
    input: { type: 'object', additionalProperties: false, required: ['locationId', 'riskCategory'], properties: {
      locationId: { ...ID, description: 'The ward or department audited, for example ward-a1.' }, riskCategory: RISK,
      passed: { type: 'array', items: ELEMENT, maxItems: AUDIT_ELEMENTS.length, description: 'Element ids that passed. Leave an element out of both lists if it was not checked.' },
      failed: { type: 'array', items: ELEMENT, maxItems: AUDIT_ELEMENTS.length, description: 'Element ids that failed and need action.' } } },
    output: { type: 'object', required: ['status'], properties: {
      status: WRITE_STATUS, auditId: AUDIT_ID, score: { type: 'number' }, audited: { type: 'integer' }, passed: { type: 'integer' },
      failed: { type: 'array' }, belowPassMark: { type: 'boolean' }, events: EVENT_SEQS, proposal: PROPOSAL_OUT } },
    target: (input) => ({ id: input.locationId, word: 'area' }),
    wardOf: (core, input) => wardOfPlace(core, input.locationId),
    async precheck(core, input) { await checkAudit(core, input); },
    async run(core, input, { actor }) {
      let auditId = null;
      const recs = await core.appendChecked(async (events) => {
        await checkAudit(core, input, events);
        auditId = nextAuditId(events);
        return [{ type: 'support.audit-recorded', subject: input.locationId, actorRole: actor.role, at: core.now(),
          data: { auditId, riskCategory: input.riskCategory, passed: [...(input.passed || [])], failed: [...(input.failed || [])] } }];
      });
      const passed = (input.passed || []).length; const audited = passed + (input.failed || []).length;
      const score = Math.round((1000 * passed) / audited) / 10;
      await core.recordAs(actor, 'support.audit-recorded', auditId, { locationId: input.locationId, riskCategory: input.riskCategory, audited, passed });
      return { status: 'done', auditId, score, audited, passed, failed: (input.failed || []).map((x) => ({ id: x, name: ELEMENT_NAME[x] })), belowPassMark: score < PASS_MARK, events: recs.map((r) => r.seq) };
    },
    example: { input: { locationId: 'ward-a1', riskCategory: 'high', passed: ['floor', 'bed-frame', 'bedside', 'high-touch', 'hand-wash', 'toilet', 'bins', 'curtains', 'dispensers'], failed: ['high-surfaces'] } },
  },
  {
    name: 'ospeli_support_guide_set',
    summary: 'Switch the cleaning and transport guide on or off for this site. The guide is a set of fixed rules that suggest which cleans to do first, when a team is busier than usual and when an area should be audited again; a person decides. With it off everything else works the same. People only.',
    kind: 'write', roles: ['support-supervisor', 'ops-manager', 'coo'], approval: true, agents: false,
    input: { type: 'object', additionalProperties: false, required: ['on'], properties: { on: { type: 'boolean', description: 'true: show the guide\'s suggestions. false: none.' } } },
    output: { type: 'object', required: ['status', 'on'], properties: { status: WRITE_STATUS, on: { type: 'boolean' }, events: EVENT_SEQS } },
    async precheck(core, input) {
      if (guideOn(await core.events({ type: 'support.guide-set' })) === input.on) throw new CommandError('conflict', `The guide is already ${input.on ? 'on' : 'off'}.`);
    },
    async run(core, input, { actor }) {
      const recs = await core.appendChecked(async (events) => {
        if (guideOn(events) === input.on) throw new CommandError('conflict', `The guide is already ${input.on ? 'on' : 'off'}.`);
        return [{ type: 'support.guide-set', subject: 'support-guide', actorRole: actor.role, at: core.now(), data: { on: input.on } }];
      });
      await core.recordAs(actor, 'support.guide-set', 'support-guide', { on: input.on });
      return { status: 'done', on: input.on, events: recs.map((r) => r.seq) };
    },
    example: { input: { on: false } },
  },
];

// ---- synthetic history for Example General Hospital: thirty days of jobs and cleaning audits ----
// Generic patterns only, entirely fictional: busier by day, longer waits around shift change, most
// audit elements pass while high surfaces and curtains fail more often, and one ward (B2) fails its
// last two audits so the guide has something real to say. A handful of jobs are left open at the
// end so a transport assistant and a cleaner who open the app see a real queue.
const AUDITED = [['ward-a1', 'high'], ['ward-a2', 'high'], ['ward-a3', 'high'], ['ward-b1', 'high'], ['ward-b2', 'high'], ['ward-c1', 'high'],
  ['dept-emergency', 'high'], ['dept-theatres', 'very-high'], ['dept-imaging', 'moderate'], ['dept-outpatients', 'moderate']];
const WEAK = { 'high-surfaces': 0.18, curtains: 0.12 }; // fail more often than the rest (generic pattern)
const WEAK_WARD = 'ward-b2';
// Jobs asked for per hour by local hour of day (generic: busy 08:00 to 18:00, quiet at night).
const PORTER_PER_HOUR = [0.6, 0.4, 0.4, 0.4, 0.5, 0.6, 1, 1.6, 2.6, 3, 3, 2.8, 2.6, 2.8, 3, 2.8, 2.4, 2, 1.6, 1.2, 1, 0.8, 0.7, 0.6];
const CLEAN_PER_HOUR = PORTER_PER_HOUR.map((x) => x / 4);
const SHIFT_CHANGE = [6, 7, 18, 19]; // local hours around 07:00 and 19:00, when waits run longer
const CANCEL = ['No longer needed', 'Asked for by mistake', 'Done another way'];

export function seed({ r, startMs, endMs, entities }) {
  const offset = (entities.find((e) => e.type === 'site' && e.utcOffsetMinutes != null)?.utcOffsetMinutes ?? 0) * MIN;
  const localHour = (t) => Math.floor((((t + offset) % DAY) + DAY) % DAY / HOUR);
  const atLocal = (t, hour) => { const local = t + offset; return local - (local % DAY) + hour * HOUR + r.int(0, 59) * MIN - offset; };
  const has = (id) => entities.some((e) => e.id === id);
  return [...seedAudits(r, startMs, endMs, has, atLocal), ...seedTasks(r, startMs, endMs, entities, localHour)];
}

function seedAudits(r, startMs, endMs, has, atLocal) {
  const raw = [];
  for (const [place, risk] of AUDITED) {
    if (!has(place)) continue;
    const elements = AUDIT_ELEMENTS.map((e) => e.id).filter((x) => place.startsWith('ward-') || !['bed-frame', 'bedside'].includes(x));
    const stop = place === WEAK_WARD ? endMs - 4 * DAY : endMs;
    for (let t = startMs + r.int(0, 3) * DAY; t < stop; t += r.int(3, 5) * DAY) {
      const at = atLocal(t, r.int(9, 15));
      if (at < startMs || at > stop) continue;
      const failed = elements.filter((x) => r.chance((WEAK[x] ?? 0.04) * (place === WEAK_WARD ? 2 : 1)));
      raw.push({ t: at, place, risk, failed, passed: elements.filter((x) => !failed.includes(x)) });
    }
    if (place === WEAK_WARD) {
      // The last two audits of this ward fail (7 of 10 and 8 of 10), with two elements failing both times.
      for (const [daysBack, failed] of [[3, ['high-surfaces', 'curtains', 'bins']], [1, ['high-surfaces', 'curtains']]]) {
        raw.push({ t: atLocal(endMs - daysBack * DAY, 10), place, risk, failed, passed: elements.filter((x) => !failed.includes(x)) });
      }
    }
  }
  raw.sort((a, b) => a.t - b.t || (a.place < b.place ? -1 : 1));
  return raw.filter((a) => a.t <= endMs).map((a, i) => ({
    t: a.t, type: 'support.audit-recorded', subject: a.place, actorRole: 'support-supervisor',
    data: { auditId: `aud-${String(i + 1).padStart(5, '0')}`, riskCategory: a.risk, passed: a.passed, failed: a.failed },
  }));
}

function seedTasks(r, startMs, endMs, entities, localHour) {
  const wards = entities.filter((e) => e.type === 'ward').map((e) => e.id);
  const bedsOf = (w) => entities.filter((e) => e.type === 'bed' && e.parentId === w).map((e) => e.id);
  const dept = (id) => (entities.some((e) => e.id === id) ? id : null);
  const [ED, IMAGING, THEATRES, LAB] = ['dept-emergency', 'dept-imaging', 'dept-theatres', 'dept-laboratory'].map(dept);
  if (!wards.length || !ED || !IMAGING || !LAB) return [];
  const otherWard = (w) => r.pick(wards.filter((x) => x !== w));
  const minutes = (median, sigma, cap) => Math.min(cap, Math.max(1, Math.round(r.lognormal(median, sigma)))) * MIN;

  // One job: where, what, who asked. Places and details are generic picks from the module's own lists.
  function porterJob() {
    const kind = r.weighted([['patient-move', 55], ['item-run', 30], ['equipment-move', 15]]);
    const ward = r.pick(wards);
    if (kind === 'patient-move') {
      const fromEd = r.chance(0.2);
      const from = fromEd ? ED : r.chance(0.75) ? r.pick(bedsOf(ward)) : ward;
      const to = fromEd ? ward : r.weighted([[IMAGING, 40], [THEATRES || IMAGING, 25], [otherWard(ward), 35]]);
      return { kind, from, to, detail: r.weighted([['Wheelchair', 40], ['Bed', 30], ['Stretcher', 20], ['Walking with help', 10]]), role: fromEd ? 'ae-nic' : r.chance(0.15) ? 'bed-manager' : 'ward-nurse' };
    }
    if (kind === 'item-run') {
      const detail = r.weighted([['Specimen', 60], ['Medicines', 15], ['Supplies', 15], ['Other item', 10]]);
      const from = r.chance(0.2) ? ED : ward;
      return { kind, from, to: detail === 'Specimen' ? LAB : r.chance(0.5) ? otherWard(ward) : IMAGING, detail, role: from === ED ? 'ae-nic' : 'ward-nurse' };
    }
    return { kind, from: ward, to: otherWard(ward), detail: r.weighted([['Empty bed', 40], ['Wheelchair or stretcher', 40], ['Other equipment', 20]]), role: r.chance(0.3) ? 'support-supervisor' : 'ward-nurse' };
  }
  function cleanJob() {
    const inWard = r.chance(0.65);
    const place = inWard ? (r.chance(0.3) ? r.pick(bedsOf(r.pick(wards))) : r.pick(wards)) : r.pick([ED, IMAGING, THEATRES, dept('dept-outpatients')].filter(Boolean));
    return { kind: 'room-clean', from: place, to: null, detail: r.weighted([['Routine clean', 45], ['Spill', 25], ['After a patient leaves a room', 20], ['Extra clean asked for by the ward', 10]]), role: place === ED ? 'ae-nic' : 'ward-nurse' };
  }

  // History: every job asked for more than two hours before the end time is closed by then.
  const jobs = [];
  for (let h = startMs; h < endMs - 2 * HOUR; h += HOUR) {
    const lh = localHour(h);
    for (const [rate, make, team] of [[PORTER_PER_HOUR[lh], porterJob, 'transport'], [CLEAN_PER_HOUR[lh], cleanJob, 'cleaning']]) {
      const n = Math.floor(rate) + (r.chance(rate % 1) ? 1 : 0);
      for (let k = 0; k < n; k++) {
        const job = make();
        const at = h + r.int(0, 59) * MIN;
        const urgent = r.chance(job.detail === 'Specimen' ? 0.15 : 0.07);
        const slow = SHIFT_CHANGE.includes(localHour(at)) ? 2 : 1;
        const wait = urgent ? minutes(5, 0.5, 30) : minutes((team === 'transport' ? 12 : 25) * slow, 0.6, 90);
        const work = minutes(team === 'transport' ? { 'patient-move': 20, 'item-run': 15, 'equipment-move': 18 }[job.kind] : 20, 0.4, 25);
        const cancelled = r.chance(0.04);
        jobs.push({ ...job, at, urgent, started: cancelled ? null : at + wait, done: cancelled ? null : at + wait + work,
          cancelledAt: cancelled ? at + r.int(5, 40) * MIN : null, reason: cancelled ? r.pick(CANCEL) : null, doer: team === 'transport' ? 'porter' : 'cleaner' });
      }
    }
  }
  // Open at the end time: a real queue for the transport assistant and the cleaner, waits under the guide's usual levels.
  const open = (job, minsAgo, state, urgent = false) => jobs.push({ ...job, at: endMs - minsAgo * MIN, urgent,
    started: state === 'started' ? endMs - Math.floor(minsAgo / 2) * MIN : null, done: null, cancelledAt: null, reason: null, doer: job.kind === 'room-clean' ? 'cleaner' : 'porter' });
  const [w1, w2, w3, w4] = [wards[0], wards[1 % wards.length], wards[3 % wards.length], wards[4 % wards.length]];
  open({ kind: 'item-run', from: w3, to: LAB, detail: 'Specimen', role: 'ward-nurse' }, 9, 'requested', true);
  open({ kind: 'patient-move', from: bedsOf(w2)[6] || w2, to: IMAGING, detail: 'Bed', role: 'ward-nurse' }, 24, 'requested');
  open({ kind: 'patient-move', from: ED, to: w1, detail: 'Stretcher', role: 'ae-nic' }, 16, 'requested');
  open({ kind: 'equipment-move', from: w4, to: w2, detail: 'Wheelchair or stretcher', role: 'ward-nurse' }, 6, 'requested');
  open({ kind: 'patient-move', from: bedsOf(w1)[2] || w1, to: THEATRES || IMAGING, detail: 'Wheelchair', role: 'ward-nurse' }, 20, 'started');
  open({ kind: 'room-clean', from: w2, to: null, detail: 'Spill', role: 'ward-nurse' }, 18, 'requested');
  open({ kind: 'room-clean', from: IMAGING, to: null, detail: 'Routine clean', role: 'ward-nurse' }, 30, 'started');

  jobs.sort((a, b) => a.at - b.at || (a.kind < b.kind ? -1 : 1));
  const out = [];
  jobs.forEach((j, i) => {
    const id = `task-${String(i + 1).padStart(5, '0')}`;
    out.push({ t: j.at, type: 'task.requested', subject: id, actorRole: j.role,
      data: { kind: j.kind, locationId: j.from, toLocationId: j.to, priority: j.urgent ? 'urgent' : 'routine', detail: j.detail } });
    if (j.cancelledAt) out.push({ t: j.cancelledAt, type: 'task.cancelled', subject: id, actorRole: j.role, data: { reason: j.reason } });
    if (j.started) out.push({ t: j.started, type: 'task.started', subject: id, actorRole: j.doer });
    if (j.done) out.push({ t: j.done, type: 'task.completed', subject: id, actorRole: j.doer });
  });
  return out.filter((e) => e.t <= endMs);
}
