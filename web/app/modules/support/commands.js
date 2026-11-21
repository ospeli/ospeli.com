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
  STOCK_CATEGORIES, STOCK_ITEMS, LINEN, deriveLinen, linenStockOuts, SHIFT_NOTE, localDate, addDays, MEALS, MEAL_NAME, MEAL_MAX, MEAL_BACK_DAYS, MEALS_NOTE,
  mealProblem, deriveMeals, mealWaste, ruleLinenTwoCounts, ruleMealsReturned, MEAL_USUAL_PCT, MEAL_DAYS,
} from './logic.js';
import { validDate, DATE_PATTERN } from '../../core/stock.js';

export const id = 'support';
export const PREFIX = 'ospeli_support_';
export const EVENT_PREFIX = 'support.';
export const TASK_TEAMS = TEAMS;
export const TASK_KINDS = KINDS;
// Linen is the shared stock item: this pack adds its category and example items (logic.js) and
// writes no stock command; counts, top-up levels, requests, issues and stock-outs are ospeli_stock_*.
export { STOCK_CATEGORIES, STOCK_ITEMS };

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
  { id: 'linen-stock-outs', name: 'Linen stock-outs', unit: '%',
    definition: `Area-shifts with a linen item at zero divided by area-shifts, for the wards and departments that hold linen. An area-shift is one area for one shift: ${SHIFT_NOTE} It counts as a stock-out when any linen item there had nothing usable at any time in the shift: a count of zero until the next top-up is issued, or a stock-out a person declared. A top-up counts from when it is issued, which may be before it is on the shelf.`,
    counts: 'Area-shifts in which any linen item was at zero.',
    outOf: 'Area-shifts that began in the period, from each area\'s first linen record. The shift going on now counts up to now.',
    leavesOut: 'The store that supplies the areas, other modules\' stock, and areas with no linen record. A shift with no count is not left out and not guessed: it keeps the balance of the last count and the top-ups issued since. A shift nobody counted keeps the last count, so it may hide a stock-out. How many shifts had no count is shown beside the value.',
    source: 'local definition', target: null, targetText: 'No target set: track the trend.' },
  { id: 'meal-waste', name: 'Meal waste', unit: '%',
    definition: 'Meals returned uneaten divided by meals delivered, for each ward, for each meal (breakfast, midday, evening) and in all. Counts only: no patient, no diet, no allergy.',
    counts: 'Meals returned uneaten.', outOf: 'Meals delivered, on the meal records dated in the period (today and the days before it).',
    leavesOut: 'A ward\'s meal with no record that day (left out, never counted as zero), and earlier versions of a record that was recorded again (the latest wins).',
    source: 'local definition', target: null, targetText: 'No target set: track the trend.' },
];
const TASK_KPIS = ['support-bed-turnaround', 'porter-request-to-done', 'cleanliness-audit-score'];

// ---- places ----
async function placeMap(core) {
  return new Map((await core.listEntities()).filter((e) => ['site', 'building', 'department', 'ward', 'bed'].includes(e.type)).map((e) => [e.id, e]));
}
const siteOffset = async (core) => (await core.listEntities()).find((e) => e.type === 'site' && e.utcOffsetMinutes != null)?.utcOffsetMinutes ?? 0;
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
  const [events, map, offsetMinutes] = await Promise.all([core.events(), placeMap(core), siteOffset(core)]);
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
  // Linen and meals: the shared stock item's linen, and the meal records, for the same days.
  const linen = deriveLinen(events, offsetMinutes);
  const isArea = (pid) => ['ward', 'department'].includes(map.get(pid)?.type) && see(pid);
  const today = localDate(Date.parse(now), offsetMinutes);
  const meals = deriveMeals(events);
  values['linen-stock-outs'] = linenStockOuts(events, { since, until: now, offsetMinutes, stock: linen, isArea });
  values['meal-waste'] = mealWaste(events, { fromDate: addDays(today, -(days - 1)), toDate: today, see: isArea, records: meals });
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
      ...ruleLinenTwoCounts(events, { stock: linen, now, isArea, placeName: (pid) => nameOf(map, pid), itemName: (iid) => linen.items.get(iid)?.name || iid }),
      ...ruleMealsReturned(meals, { toDate: today, see: isArea, placeName: (pid) => nameOf(map, pid) }),
    ];
  }
  const kpis = KPIS.map((k) => {
    const v = values[k.id];
    const base = { id: k.id, name: k.name, unit: k.unit, value: v.value, numerator: v.numerator, denominator: v.denominator, n: v.n, target: k.target, targetText: k.targetText };
    const linenMore = k.id === 'linen-stock-outs' ? { uncounted: v.uncounted, byShift: v.byShift, shifts: SHIFT_NOTE }
      : k.id === 'meal-waste' ? { byWard: v.byWard.map((w) => ({ ...w, name: nameOf(map, w.id), byMeal: w.byMeal.map((m) => ({ ...m, name: MEAL_NAME[m.id] })) })), dates: { from: addDays(today, -(days - 1)), to: today } } : {};
    if (k.id === 'linen-stock-outs') base.uncounted = v.uncounted;
    return input.format === 'short' ? base : { ...base, breakdown: k.id === 'linen-stock-outs' ? v.breakdown.map((b) => ({ ...b, name: nameOf(map, b.id) })) : v.breakdown, ...linenMore,
      ...(v.byPriority ? { byPriority: v.byPriority } : {}), ...(v.leftOut ? { leftOut: v.leftOut } : {}),
      definition: k.definition, counts: k.counts, outOf: k.outOf, leavesOut: k.leavesOut, source: k.source };
  });
  return {
    asOf: now, synthetic: await synth(core), period: { since, until: now, days }, kpis, planned: [], teams, bedDemand, marks,
    guide: { on, rules: GUIDE_RULES.map((r) => ({ ...r })), suggestions },
    taskKpis: [...TASK_KPIS],
    note: `Measures jobs, waits, linen and meal counts, never individual cleaners or transport assistants. Does not set isolation or infection decisions or patient diets. ${MEALS_NOTE}`,
  };
}


// ---- meals: counts per ward, date and meal; never a person, a diet or an allergy ----
const MEAL = { type: 'string', enum: MEALS.map((m) => m.id), description: 'The meal: breakfast, midday or evening.' };
const MEAL_N = (what) => ({ type: 'integer', minimum: 0, maximum: MEAL_MAX, description: `${what}: a whole number from 0 to ${MEAL_MAX}.` });
const DATE = { type: 'string', pattern: DATE_PATTERN, maxLength: 10 };
const MEAL_REPEAT = 2 * MIN; // the same numbers again within this time are a double tap, not a correction
const mealOut = (x, map) => ({ wardId: x.wardId, wardName: nameOf(map, x.wardId), date: x.date, meal: x.meal, mealName: MEAL_NAME[x.meal], ordered: x.ordered, delivered: x.delivered, returned: x.returned,
  wastePercent: x.delivered ? Math.round((1000 * x.returned) / x.delivered) / 10 : null, at: x.at, byRole: x.byRole, corrected: x.versions > 1 });
async function checkMeal(core, input, events) {
  const ward = input.wardId ? await core.getEntity(input.wardId) : null;
  if (!ward || ward.type !== 'ward') throw new CommandError('not-found', 'No ward with that id. Use a ward id, for example ward-a1 (ospeli_support_places lists the wards).');
  const today = localDate(Date.parse(core.now()), await siteOffset(core));
  const date = input.date ?? today;
  if (!validDate(date)) throw new CommandError('invalid-input', `date is a calendar date as YYYY-MM-DD, for example ${today}. Leave it out for today.`);
  if (date > today) throw new CommandError('invalid-input', `A meal cannot be recorded for a day that has not come yet. Today here is ${today}.`);
  const first = addDays(today, -(MEAL_BACK_DAYS - 1));
  if (date < first) throw new CommandError('invalid-input', `A meal can be recorded or corrected for today and the ${MEAL_BACK_DAYS - 1} days before (from ${first}; an example setting, not a standard).`);
  const why = mealProblem(input);
  if (why) throw new CommandError('invalid-input', why);
  const evs = events ?? await core.events({ type: 'support.meals-recorded' });
  const t = Date.parse(core.now());
  for (let i = evs.length - 1; i >= 0; i--) {
    const e = evs[i];
    // Only meal records are read: a back-dated record of another kind must not end the look back.
    if (e.type !== 'support.meals-recorded') continue;
    if (t - Date.parse(e.at) >= MEAL_REPEAT) break;
    const d = e.data || {};
    if (e.subject === input.wardId && d.date === date && d.meal === input.meal && d.ordered === input.ordered && d.delivered === input.delivered && d.returned === input.returned) {
      throw new CommandError('conflict', 'These numbers for this ward, day and meal were saved a moment ago. Nothing new was saved.', { already: true });
    }
  }
  const previous = deriveMeals(evs).find((x) => x.wardId === input.wardId && x.date === date && x.meal === input.meal) || null;
  return { date, previous };
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
    summary: 'Cleaning and transport at a glance, in one call: the five measures with their definitions and sources (bed turnaround, transport request to completion, cleanliness audit score, linen stock-outs, meal waste), open jobs per team with the longest wait, and the guide\'s suggestions with their reasons and basis (empty while the guide is off). A linen suggestion carries the ospeli_stock_request a person may send. Measures jobs, waits and counts, never people. Read-only.',
    kind: 'read', roles: ALL_ROLES, approval: false,
    input: { type: 'object', additionalProperties: false, properties: {
      days: { type: 'integer', minimum: 1, maximum: 30, description: 'The period for the measures: the last this many days. Default 7.' },
      format: FORMAT('the values without their definitions', 'each value with its definition, source and breakdown') } },
    output: { type: 'object', required: ['asOf', 'synthetic', 'period', 'kpis', 'planned', 'teams', 'guide'], properties: {
      asOf: TIME, synthetic: SYNTHETIC, period: { type: 'object' }, kpis: { type: 'array', items: KPI_OUT },
      planned: { type: 'array', description: 'Measures planned but not built yet, with no value. Empty now: all five are built.', maxItems: 10, items: { type: 'object', required: ['id', 'name', 'status'] } },
      taskKpis: { type: 'array', description: 'The ids of the three job measures (the task board shows these; Linen and meals shows the other two).' },
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
    name: 'ospeli_support_meals_list',
    summary: 'Meal counts: for each ward, date and meal (breakfast, midday, evening) how many were ordered, delivered and returned uneaten, newest first, with meal waste (returned uneaten / delivered) by ward and meal over the period. Counts only: no patient, no diet, no allergy; those stay with the site\'s own catering and clinical process. Read-only.',
    kind: 'read', roles: ALL_ROLES, approval: false,
    input: { type: 'object', additionalProperties: false, properties: {
      wardId: { ...ID, description: 'One ward, for example ward-a1.' },
      days: { type: 'integer', minimum: 1, maximum: 30, description: 'Today and the days before it, this many in all. Default 7.' },
      limit: LIMIT(100, 500, 'meal records') } },
    output: { type: 'object', required: ['asOf', 'synthetic', 'today', 'dates', 'records', 'waste', 'meals', 'note', 'total', 'truncated'], properties: {
      asOf: TIME, synthetic: SYNTHETIC, today: { type: 'string', description: 'Today\'s date at the site, YYYY-MM-DD.' }, dates: { type: 'object', description: '{ from, to }: the dates covered.' },
      records: { type: 'array', items: { type: 'object', required: ['wardId', 'date', 'meal', 'ordered', 'delivered', 'returned'] } },
      waste: { type: 'object', description: 'Meal waste over the dates: value (%), numerator (returned uneaten), denominator (delivered), by meal (breakdown) and by ward (byWard, each with byMeal).' },
      meals: { type: 'array' }, settings: { type: 'object' }, note: { type: 'string' }, total: TOTAL, truncated: TRUNCATED } },
    wardOf: (core, input) => (input.wardId ? wardOfPlace(core, input.wardId) : null),
    async run(core, input, { wards }) {
      const map = await placeMap(core);
      if (input.wardId && map.get(input.wardId)?.type !== 'ward') throw new CommandError('not-found', 'No ward with that id. ospeli_support_places lists the wards.');
      const days = input.days ?? 7;
      const today = localDate(Date.parse(core.now()), await siteOffset(core));
      const from = addDays(today, -(days - 1));
      const see = (w) => map.get(w)?.type === 'ward' && (!wards || wards.has(w)) && (!input.wardId || w === input.wardId);
      const all = deriveMeals(await core.events({ type: 'support.meals-recorded' })).filter((x) => see(x.wardId) && x.date >= from && x.date <= today);
      const order = Object.fromEntries(MEALS.map((m, i) => [m.id, i]));
      all.sort((a, b) => (a.date !== b.date ? (a.date < b.date ? 1 : -1) : order[b.meal] - order[a.meal] || (nameOf(map, a.wardId) < nameOf(map, b.wardId) ? -1 : 1)));
      const cut = page(all, input.limit, 100);
      const w = mealWaste([], { fromDate: from, toDate: today, records: all });
      return {
        asOf: core.now(), synthetic: await synth(core), today, dates: { from, to: today }, total: cut.total, truncated: cut.truncated,
        records: cut.items.map((x) => mealOut(x, map)),
        waste: { ...w, byWard: w.byWard.map((x) => ({ ...x, name: nameOf(map, x.id), byMeal: x.byMeal.map((m) => ({ ...m, name: MEAL_NAME[m.id] })) })) },
        meals: MEALS.map((m) => ({ ...m })), settings: { backDays: MEAL_BACK_DAYS, usualPercent: MEAL_USUAL_PCT, usualDays: MEAL_DAYS, note: 'Example settings, not standards.' },
        note: MEALS_NOTE,
      };
    },
    example: { input: { wardId: 'ward-a1', days: 7, limit: 10 } },
  },
  {
    name: 'ospeli_support_meals_record',
    summary: 'Record the meal count for one ward, day and meal: how many meals were ordered, delivered and returned uneaten (whole numbers, nothing typed). Recording the same ward, day and meal again corrects it: the latest wins and both stay in the log. Counts only: no patient, no diet, no allergy. An agent\'s call becomes a proposal for a person.',
    kind: 'write', roles: ['ward-nurse', 'cleaner', 'support-supervisor'], approval: true,
    input: { type: 'object', additionalProperties: false, required: ['wardId', 'meal', 'ordered', 'delivered', 'returned'], properties: {
      wardId: { ...ID, description: 'The ward, for example ward-a1.' },
      date: { ...DATE, description: `The day, as YYYY-MM-DD in the site's own time. Leave it out for today. Today or the ${MEAL_BACK_DAYS - 1} days before.` },
      meal: MEAL, ordered: MEAL_N('Meals ordered for the ward'), delivered: MEAL_N('Meals delivered to the ward'), returned: MEAL_N('Meals returned uneaten (not more than delivered)') } },
    output: { type: 'object', required: ['status'], properties: {
      status: WRITE_STATUS, wardId: ID, date: { type: 'string' }, meal: { type: 'string' }, replaced: { type: 'boolean', description: 'true when this corrected an earlier record for the same ward, day and meal.' },
      previous: { type: ['object', 'null'], description: 'The record it corrected: { ordered, delivered, returned }.' }, wastePercent: { type: ['number', 'null'] },
      events: EVENT_SEQS, proposal: PROPOSAL_OUT } },
    target: (input) => ({ id: `meals:${input.wardId}:${input.date || 'today'}:${input.meal}`, word: 'meal record' }),
    wardOf: (core, input) => wardOfPlace(core, input.wardId),
    async precheck(core, input) { await checkMeal(core, input); },
    async run(core, input, { actor }) {
      let res = null;
      const recs = await core.appendChecked(async (events) => {
        res = await checkMeal(core, input, events);
        return [{ type: 'support.meals-recorded', subject: input.wardId, actorRole: actor.role, at: core.now(),
          data: { date: res.date, meal: input.meal, ordered: input.ordered, delivered: input.delivered, returned: input.returned } }];
      });
      await core.recordAs(actor, 'support.meals-recorded', input.wardId, { date: res.date, meal: input.meal, ordered: input.ordered, delivered: input.delivered, returned: input.returned, replaced: !!res.previous });
      const p = res.previous;
      return { status: 'done', wardId: input.wardId, date: res.date, meal: input.meal, replaced: !!p, previous: p ? { ordered: p.ordered, delivered: p.delivered, returned: p.returned } : null,
        wastePercent: input.delivered ? Math.round((1000 * input.returned) / input.delivered) / 10 : null, events: recs.map((r) => r.seq) };
    },
    example: { input: { wardId: 'ward-a1', meal: 'midday', ordered: 20, delivered: 19, returned: 3 } },
  },
  {
    name: 'ospeli_support_guide_set',
    summary: 'Switch the cleaning and transport guide on or off for this site. The guide is a set of fixed rules that suggest which cleans to do first, when a team is busier than usual, when an area should be audited again, when linen stays under its top-up level and when many meals come back uneaten; a person decides. With it off everything else works the same. People only.',
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
  // In this order, so the linen and meals history (added on 19 Nov) draws from the random stream
  // after the jobs and audits and leaves them exactly as they were.
  const audits = seedAudits(r, startMs, endMs, has, atLocal);
  const tasks = seedTasks(r, startMs, endMs, entities, localHour);
  return [...audits, ...tasks, ...seedLinen(r, startMs, endMs, entities, offset), ...seedMeals(r, startMs, endMs, entities, offset, atLocal)];
}

// ---- linen: thirty days of counts against top-up levels, top-ups from the store, a few nights at zero ----
// Generic patterns only, entirely fictional. Four wards count their linen twice a day (before each
// shift ends), now and then a count is missed; what is under the top-up level is asked for just
// after the count (as the screen does: the count asks for nothing by itself) and the storekeeper
// issues it from the store within a few hours, in the day. Clean linen comes back to the store from the
// laundry every morning. On a few nights a ward runs out of an item before the morning count, and
// once a ward declares it. At the end: on one ward towels were under level on the last two counts
// (the newest top-up still waiting); on another the top-up raised by the last count but one was
// never issued and was cancelled after the last count, so the guide has a top-up to offer.
// Request and stock-out ids start at 100001 so they never meet another module's seeded ids.
const LINEN_WARDS = ['ward-a1', 'ward-a3', 'ward-b1', 'ward-c1'];
const LINEN_LEVEL = { 'bed-sheet': 40, pillowcase: 30, blanket: 12, towel: 30, 'patient-gown': 24 }; // top-up levels, example settings
const LINEN_USE = { 'bed-sheet': 22, pillowcase: 14, blanket: 3, towel: 18, 'patient-gown': 10 }; // a day, on a ward of average use
const LINEN_BUSY = [1, 0.9, 1.1, 1.2];
function seedLinen(r, startMs, endMs, entities, offset) {
  const midnight = (t) => t + offset - ((((t + offset) % DAY) + DAY) % DAY) - offset; // local midnight before t
  const at = (t, hour, minute = 0) => midnight(t) + hour * HOUR + minute * MIN;
  const hourOf = (t) => Math.floor((t - midnight(t)) / HOUR);
  const store = entities.find((e) => e.type === 'store');
  const wards = LINEN_WARDS.filter((w) => entities.some((e) => e.id === w && e.type === 'ward'));
  if (!store || wards.length < 2) return []; // an older example hospital with no store: no linen history
  const S = store.id;
  const items = STOCK_ITEMS.map((it) => it.id);
  const out = [];
  const emit = (t, type, subject, actorRole, data) => { if (t >= startMs && t <= endMs) out.push({ t: Math.round(t / 1000) * 1000, type, subject, actorRole, data }); };
  let reqN = 100000; let soN = 100000;
  // The store: an opening stock, then the laundry's delivery each morning.
  const total = Object.fromEntries(items.map((i) => [i, wards.reduce((n, w, k) => n + LINEN_USE[i] * (LINEN_BUSY[k] ?? 1), 0)]));
  emit(startMs + 5 * MIN, 'stock.received', S, 'storekeeper', { lines: items.map((i) => ({ itemId: i, qty: Math.ceil(total[i] * 4) })), source: 'Transfer from outside', orderRef: null });
  for (let d = startMs + DAY; d <= endMs; d += DAY) {
    emit(at(d, 5, r.int(0, 40)), 'stock.received', S, 'storekeeper', { lines: items.map((i) => ({ itemId: i, qty: Math.ceil(total[i] * 1.5) })), source: 'Transfer from outside', orderRef: null });
  }
  const [gWait, gCancel] = [wards[2 % wards.length], wards[3 % wards.length]];
  wards.forEach((w, k) => {
    const busy = LINEN_BUSY[k] ?? 1;
    const bal = Object.fromEntries(items.map((i) => [i, LINEN_LEVEL[i] - r.int(0, Math.ceil(LINEN_LEVEL[i] * 0.3))]));
    // The opening count, then the levels a second later (a level set before any count would read as zero stock).
    const t0 = startMs + (20 + 3 * k) * MIN;
    emit(t0, 'stock.counted', w, 'support-supervisor', { lines: items.map((i) => ({ itemId: i, qty: bal[i] })) });
    for (const i of items) emit(t0 + 1000, 'stock.level-set', w, 'support-supervisor', { itemId: i, level: LINEN_LEVEL[i] });
    // Count times: before each shift ends, about 06:30 and 18:30 local.
    const times = [];
    for (let d = startMs; d <= endMs; d += DAY) for (const hr of [6, 18]) { const t = at(d, hr, r.int(0, 50)); if (t > t0 + HOUR && t <= endMs) times.push(t); }
    times.sort((a, b) => a - b);
    const keep = times.filter((t, n) => n >= times.length - 2 || !r.chance(0.05)); // now and then a count is missed
    // Nights a ward ran out before the morning count (night count index -> item at zero).
    const zeroAt = new Map();
    // One in the first three weeks and one in the last week (never on the last two counts), always found at the morning count.
    const mornings = keep.map((t, n) => [t, n]).filter(([t, n]) => hourOf(t) < 12 && n > 1 && n < keep.length - 2);
    const early = mornings.filter(([t]) => t < endMs - 8 * DAY); const late = mornings.filter(([t]) => t >= endMs - 7 * DAY);
    for (const list of [early, k < 2 ? late : []]) if (list.length) zeroAt.set(r.pick(list)[1], r.pick(['towel', 'bed-sheet', 'patient-gown']));
    let last = t0; let open = null; // the request waiting for this ward: { id, lines, issueAt }
    keep.forEach((t, n) => {
      if (open && open.issueAt <= t) { for (const l of open.lines) bal[l.itemId] += l.qty; open = null; }
      const hours = (t - last) / HOUR; last = t;
      for (const i of items) bal[i] = Math.max(0, bal[i] - LINEN_USE[i] * busy * (hours / 24) * (0.6 + r.int(0, 80) / 100));
      const counted = Object.fromEntries(items.map((i) => [i, Math.floor(bal[i])]));
      if (zeroAt.has(n)) counted[zeroAt.get(n)] = 0;
      const lastTwo = n >= keep.length - 2;
      if (lastTwo && w === gWait) counted.towel = Math.min(counted.towel, 11 + (n % 2) * 2);
      if (lastTwo && w === gCancel) counted.pillowcase = Math.min(counted.pillowcase, 9 + (n % 2) * 3);
      for (const i of items) bal[i] = counted[i];
      emit(t, 'stock.counted', w, r.pick(['cleaner', 'cleaner', 'ward-nurse']), { lines: items.map((i) => ({ itemId: i, qty: counted[i] })) });
      if (zeroAt.has(n) && n === [...zeroAt.keys()][0] && k === 0) {
        const id = `so-${++soN}`;
        emit(t + 10 * MIN, 'stock.stock-out-started', id, 'cleaner', { itemId: zeroAt.get(n), placeId: w, cause: 'Used faster than expected' });
        zeroAt.set(n, { id, item: zeroAt.get(n) });
      }
      const ask = open ? [] : items.filter((i) => counted[i] < LINEN_LEVEL[i]).map((i) => ({ itemId: i, qty: LINEN_LEVEL[i] - counted[i] }));
      if (ask.length) {
        const id = `req-${++reqN}`;
        emit(t + 2 * MIN, 'stock.requested', id, 'cleaner', { placeId: w, fromPlaceId: S, lines: ask, raisedBy: 'request' }); // asked for after the count, as on screen
        const start = hourOf(t) < 7 ? at(t, 7) : t; // the store issues in the day
        const held = n === keep.length - 2 && w === gCancel; // scripted: not issued, then cancelled after the next count
        const issueAt = held ? Infinity : start + Math.round(r.lognormal(90, 0.5)) * MIN;
        open = { id, lines: ask, issueAt };
        if (!held) emit(issueAt, 'stock.issued', id, 'storekeeper', { fromPlaceId: S, lines: ask });
        const so = zeroAt.get(n);
        if (so?.id && !held) emit(issueAt + 30 * MIN, 'stock.stock-out-ended', so.id, 'cleaner', { careAffected: false });
        if (held && w === gCancel && keep.length) emit(keep.at(-1) + 20 * MIN, 'stock.request-cancelled', id, 'support-supervisor', { reason: 'Supplied another way' });
      }
    });
  });
  return out;
}

// ---- meals: thirty days of counts for the same wards ----
// Generic patterns only, entirely fictional: about as many meals ordered as beds in use, nearly all
// delivered, a few in ten returned uneaten; now and then a meal is not recorded (left out, never
// read as zero), and one record is corrected. On one ward more midday meals come back over the last
// ten days, so the guide has something real to say.
const MEAL_TIMES = { breakfast: 9, midday: 13, evening: 19 }; // local hour the count is recorded, after the trays come back
const MEAL_RETURN = { breakfast: 0.07, midday: 0.1, evening: 0.09 };
function seedMeals(r, startMs, endMs, entities, offset, atLocal) {
  const wards = LINEN_WARDS.filter((w) => entities.some((e) => e.id === w && e.type === 'ward'));
  const high = wards[2 % Math.max(1, wards.length)];
  const out = [];
  let corrected = false;
  for (let d = startMs; d <= endMs; d += DAY) {
    for (const w of wards) {
      for (const m of MEALS) {
        const t = atLocal(d, MEAL_TIMES[m.id]) + r.int(30, 59) * MIN;
        if (t < startMs || t > endMs || r.chance(0.04)) continue;
        const ordered = r.int(15, 20);
        const delivered = Math.max(0, ordered - (r.chance(0.2) ? r.int(1, 2) : 0) + (r.chance(0.08) ? 1 : 0));
        const rate = MEAL_RETURN[m.id] * (w === high && m.id === 'midday' && endMs - t < 10 * DAY ? 2.8 : 1);
        const returned = Math.min(delivered, Math.round(delivered * rate * (0.5 + r.int(0, 100) / 100)));
        const date = new Date(t + offset).toISOString().slice(0, 10);
        const actorRole = r.pick(['ward-nurse', 'cleaner']);
        out.push({ t, type: 'support.meals-recorded', subject: w, actorRole, data: { date, meal: m.id, ordered, delivered, returned } });
        if (!corrected && d > startMs + 4 * DAY && m.id === 'midday') {
          corrected = true; // counted again half an hour later: one more tray came back
          out.push({ t: t + 30 * MIN, type: 'support.meals-recorded', subject: w, actorRole, data: { date, meal: m.id, ordered, delivered, returned: Math.min(delivered, returned + 1) } });
        }
      }
    }
  }
  return out.filter((e) => e.t >= startMs && e.t <= endMs);
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
