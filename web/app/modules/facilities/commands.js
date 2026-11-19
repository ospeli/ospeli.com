// Facilities and utilities: the module's pack (see core/modules.js for the contract).
// Plain data and pure functions; no screen code, so the same file runs in the browser, in tests
// and on a site's own server.
//
// Tonight's slice: the utilities log (generator tests, fuel and water readings, medical gas checks,
// outages), what is due and missed, outage hours, and a guide of two fixed rules. Building and plant
// faults are not here: they are Engineering's work orders (ospeli_workorders_*), used as they are.
// Not a building management or control system: Ospeli never switches plant, reads no sensor and
// raises no alarm. A check records what a person saw; it never says a supply is safe for patients.
// Nothing here calls a model.

import {
  CommandError, ALL_ROLES, ID, TIME, SYNTHETIC, LIMIT, TOTAL, TRUNCATED, FORMAT, page, WRITE_STATUS, PROPOSAL_OUT, EVENT_SEQS,
  isSynthetic, sameMoment, DAY, MIN,
} from '../../core/kit.js';
import { currentWords } from '../../core/model.js';
import { faultsFor } from '../../core/workorders.js';
import {
  CHECK_KINDS, RESULTS, RUN_MINUTES, LEVELS, GAS_BANDS, UTILITIES, CAUSES, AGO_MINUTES, LEVEL_PICKS, PLACE_TYPES, SCHEDULE, SCHEDULE_NOTE,
  GUIDE_RULES, DEFAULT_LEVELS, deriveChecks, deriveOutages, openOutage, nextCheckId, nextOutageId, levelsNow, guideOn, scheduleTargets,
  plannedChecksDone, outageHours, checkStatus, latestReadings, ruleLowLevel, ruleRepeatFaults, ruleRepeatFailedTests, problemChecks, checkProblem, runText, agoText, everyText,
  whenText, dueDayText, dayText, monthBounds,
} from './logic.js';

export const id = 'facilities';
export const PREFIX = 'ospeli_facilities_';
export const EVENT_PREFIX = 'facilities.';

const TECH = ['estates-tech', 'facilities-manager'];
const LOGGERS = ['estates-tech', 'facilities-assistant', 'facilities-manager'];
const OUTAGE_ROLES = [...LOGGERS, 'ops-manager'];
const MANAGER = ['facilities-manager'];
const DOUBLE_TAP = 10 * MIN; // the same check with the same picks within this time is a repeat, not a new check

// Every number has a definition and a source. Targets are example settings unless a cited source sets one.
export const KPIS = [
  { id: 'generator-test-compliance', name: 'Generator test compliance', unit: '%',
    definition: 'The core measure "planned checks done by due date" (KPI dictionary D-13) for check type generator-test: scheduled generator tests recorded (pass or fail) by their due date, divided by generator tests due in the period. Each generator is due once in each period of its schedule. A failed test counts as done for this measure (the test was carried out); failed tests are counted beside it, and the generator stays in Needs attention until a later test passes. A test recorded late counts for the period it was recorded in and does not fill the period it missed.',
    counts: 'Generator test periods with a test recorded inside them, settled in the period.', outOf: 'Generator test periods settled in the period: done, or ended with no test.',
    leavesOut: 'The current period while it is still open and no test has been recorded.',
    source: 'local definition (KPI dictionary D-13). The schedule is an example setting; a site that follows a national or insurer\'s standard for standby power sets its own from that standard.',
    target: null, targetText: 'No target set here. Your site sets its own (example setting, not a standard).' },
  { id: 'utility-outage-hours', name: 'Utility outage hours', unit: 'hours',
    definition: 'For each utility, the hours from outage started to outage ended that fall in the month, summed. An outage still open counts up to now and is marked still open. Planned shutdowns are summed apart and are not in the total.',
    counts: 'Unplanned outage hours in the month.', outOf: 'None (a total, not a share).',
    leavesOut: 'Planned shutdowns (shown apart).', source: 'local definition', target: null, targetText: 'No target set: track the trend.' },
];
// Shown read-only or planned, with no value of this module's own.
const READ_ONLY = [
  { id: 'reactive-completion-time', name: 'Reactive work-order completion time by priority', status: 'read-only', owner: 'engineering',
    note: 'Owned by Engineering (fault reported to work order closed, team Facilities). Engineering does not show it yet, so no value is shown here; this page will not count it a second time.' },
];
const PLANNED = [
  { id: 'planned-maintenance-compliance', name: 'Planned maintenance compliance', status: 'planned', note: 'Planned, not built yet: it needs the shared planned-check object.' },
  { id: 'rooms-out-of-use', name: 'Rooms out of use', status: 'planned', note: 'Planned, not built yet: it needs a room status.' },
];
export const NOT_FOR = 'Not a building management or control system: Ospeli never switches plant, reads no sensor and raises no alarm. A check records what a person saw; it does not say a room or a supply is safe for patients. It does not score staff.';
export const GAS_FIRST = 'Follow your site\'s medical gas procedure first. This records the check; it does not say a supply is safe for patients.';

// ---- places and assets ----
async function siteInfo(core) {
  const all = await core.listEntities();
  const places = new Map(all.filter((e) => PLACE_TYPES.includes(e.type)).map((e) => [e.id, e]));
  const assets = all.filter((e) => e.type === 'asset');
  const offsetMinutes = all.find((e) => e.type === 'site' && e.utcOffsetMinutes != null)?.utcOffsetMinutes ?? 0;
  const assetById = new Map(assets.map((a) => [a.id, a]));
  const anyPlace = new Map(all.filter((e) => ['site', 'building', 'department', 'ward'].includes(e.type)).map((e) => [e.id, e]));
  const nameOf = (x) => { const e = assetById.get(x) || anyPlace.get(x); return e ? currentWords(e.name) : x; };
  return { places, assets, assetById, offsetMinutes, nameOf, targets: scheduleTargets(SCHEDULE, { assets, places }) };
}
const synth = (core) => isSynthetic(core);

// What a check record says, in plain words.
function checkWords(c) {
  const parts = [];
  if (c.result) parts.push(RESULTS[c.result]);
  if (c.runMinutes) parts.push(runText(c.runMinutes));
  if (c.levelPct != null) parts.push(`${c.levelPct} %`);
  if (c.levelBand) parts.push(GAS_BANDS[c.levelBand]);
  return parts.join(', ');
}
const checkOut = (c, info) => ({
  id: c.id, kind: 'check', checkKind: c.checkKind, checkName: CHECK_KINDS[c.checkKind].name, targetId: c.targetId, targetName: info.nameOf(c.targetId),
  at: c.at, byRole: c.byRole, ...(c.result ? { result: c.result } : {}), ...(c.runMinutes ? { runMinutes: c.runMinutes } : {}),
  ...(c.levelPct != null ? { levelPct: c.levelPct } : {}), ...(c.levelBand ? { levelBand: c.levelBand } : {}), words: checkWords(c),
});
const outageOut = (o, info, now) => ({
  id: o.id, kind: 'outage', utility: o.utility, utilityName: UTILITIES[o.utility], placeId: o.placeId, placeName: info.nameOf(o.placeId),
  cause: o.cause, causeName: CAUSES[o.cause], planned: o.cause === 'planned-shutdown', startedAt: o.startedAt, endedAt: o.endedAt, at: o.endedAt || o.startedAt,
  open: !o.endedAt, minutes: Math.max(0, Math.round(((o.endedAt ? Date.parse(o.endedAt) : Date.parse(now)) - Date.parse(o.startedAt)) / MIN)),
  startedByRole: o.startedByRole, endedByRole: o.endedByRole, startBackdatedMinutes: o.startBackdatedMinutes, endBackdatedMinutes: o.endBackdatedMinutes,
});

// ---- checks ----
const CHECK_ID = { type: 'string', pattern: '^chk-[0-9]{5,}$', maxLength: 20 };
const OUTAGE_ID = { type: 'string', pattern: '^out-[0-9]{5,}$', maxLength: 20, description: 'An outage id, for example out-00004. ospeli_facilities_overview lists the open ones.' };
const KIND_IN = { type: 'string', enum: Object.keys(CHECK_KINDS), description: 'generator-test (needs assetId, result, runMinutes), fuel-level (assetId, levelPct), water-level (placeId, levelPct), gas-check (placeId, result, levelBand).' };

async function checkCheck(core, input, actor, events, info) {
  const kind = CHECK_KINDS[input.checkKind];
  if (!kind.roles.includes(actor.role)) throw new CommandError('forbidden', `A ${kind.name.toLowerCase()} is recorded by: ${kind.roles.join(', ')}.`, { roles: kind.roles });
  const i = info ?? await siteInfo(core);
  if (kind.target === 'asset') {
    if (input.placeId) throw new CommandError('invalid-input', `A ${kind.name.toLowerCase()} is recorded against a plant asset: send assetId, not placeId.`);
    const a = input.assetId ? i.assetById.get(input.assetId) : null;
    if (!a || a.kind !== kind.assetKind) {
      const ok = i.assets.filter((x) => x.kind === kind.assetKind).map((x) => x.id);
      throw new CommandError('not-found', `assetId must be one of this site's ${kind.assetKind}s: ${ok.join(', ') || 'none on this site'}.`, { assets: ok });
    }
  } else {
    if (input.assetId) throw new CommandError('invalid-input', `A ${kind.name.toLowerCase()} is recorded against a place: send placeId, not assetId.`);
    if (!input.placeId || !i.places.has(input.placeId)) throw new CommandError('not-found', 'placeId must be a site, building or department of this site, for example bld-main-plant. ospeli_facilities_overview lists the scheduled places.');
  }
  for (const f of ['result', 'runMinutes', 'levelPct', 'levelBand']) {
    const need = kind.needs.includes(f);
    if (need && input[f] == null) throw new CommandError('invalid-input', `A ${kind.name.toLowerCase()} needs ${kind.needs.join(', ')}. Missing: ${f}.`, { needs: kind.needs });
    if (!need && input[f] != null) throw new CommandError('invalid-input', `A ${kind.name.toLowerCase()} takes ${kind.needs.join(', ')} only, not ${f}.`, { needs: kind.needs });
  }
  const evs = events ?? await core.events({ type: 'facilities.check-recorded' });
  const target = input.assetId || input.placeId;
  const recent = deriveChecks(evs).filter((c) => c.checkKind === input.checkKind && c.targetId === target && Date.parse(core.now()) - Date.parse(c.at) < DOUBLE_TAP).at(-1);
  if (recent && ['result', 'runMinutes', 'levelPct', 'levelBand'].every((f) => (recent[f] ?? null) === (input[f] ?? null))) {
    throw new CommandError('conflict', `${recent.id} with the same picks was saved a few minutes ago. No second check was saved.`, { existing: recent.id });
  }
}

// ---- outages ----
async function checkOutageStart(core, input, events, info) {
  const i = info ?? await siteInfo(core);
  if (!i.places.has(input.placeId)) throw new CommandError('not-found', 'placeId must be a site, building or department, for example bld-main-a or dept-emergency.');
  const open = openOutage(deriveOutages(events ?? await core.events()), input.utility, input.placeId);
  if (open) throw new CommandError('conflict', `${open.id} is already open for ${UTILITIES[input.utility].toLowerCase()} at ${i.nameOf(input.placeId)}, since ${open.startedAt}. End it first, or record the outage at another place.`, { existing: open.id });
}
async function findOutage(core, outageId, events) {
  const o = deriveOutages(events ?? await core.events()).get(outageId);
  if (!o) throw new CommandError('not-found', 'No outage with that id. ospeli_facilities_overview lists the open outages.');
  if (o.endedAt) throw new CommandError('conflict', `${o.id} has already ended.`, { endedAt: o.endedAt });
  return o;
}

// The pick lists a screen needs: the plant assets of each kind, the places of each place check
// (the scheduled ones, or every building when none is scheduled), and the places an outage can be at.
function choices(info) {
  const byType = (t) => [...info.places.values()].filter((p) => p.type === t).map((p) => ({ id: p.id, name: currentWords(p.name), type: p.type }));
  const out = { assets: {}, places: {}, outagePlaces: [...byType('site'), ...byType('building'), ...byType('department')] };
  for (const [k, v] of Object.entries(CHECK_KINDS)) {
    if (v.target === 'asset') out.assets[k] = info.assets.filter((a) => a.kind === v.assetKind).map((a) => ({ id: a.id, name: currentWords(a.name) }));
    else {
      const sched = info.targets.filter((t) => t.checkKind === k).map((t) => t.targetId);
      out.places[k] = (sched.length ? sched.map((x) => info.places.get(x)) : [...info.places.values()].filter((p) => p.type === 'building')).map((p) => ({ id: p.id, name: currentWords(p.name) }));
    }
  }
  return out;
}

// ---- the overview: due and missed checks, open outages, measures and the guide in one read ----
async function overview(core, input, wards = null) {
  const now = core.now();
  const t = Date.parse(now);
  const days = input.days ?? 30;
  const since = new Date(t - days * DAY).toISOString();
  const [events, info] = await Promise.all([core.events(), siteInfo(core)]);
  const off = info.offsetMinutes;
  const checks = deriveChecks(events);
  const outages = deriveOutages(events);
  const status = checkStatus(checks, info.targets, { now, offsetMinutes: off });
  const lastOut = (c) => (c ? { id: c.id, at: c.at, words: checkWords(c), atText: whenText(Date.parse(c.at), off) } : null);
  const rows = status.map((s) => ({
    checkKind: s.checkKind, checkName: CHECK_KINDS[s.checkKind].name, targetId: s.targetId, targetName: info.nameOf(s.targetId), everyDays: s.everyDays, everyText: everyText(s.everyDays),
    status: s.status, dueBy: s.dueBy, dueText: `Due by the end of ${dueDayText(Date.parse(s.dueBy), off)}`,
    overdueSince: s.overdueSince, overdueText: s.overdueSince ? `Missed: no check since ${s.last ? dayText(Date.parse(s.last.at), off) : 'the start'}; due by the end of ${dueDayText(Date.parse(s.overdueSince), off)}` : null,
    missedPeriods: s.missedPeriods, last: lastOut(s.last), lastFailed: s.last?.result === 'fail', problem: checkProblem(s.last),
  }));
  const problems = problemChecks(checks).map(({ check: c, problem }) => ({
    checkKind: c.checkKind, checkName: CHECK_KINDS[c.checkKind].name, targetId: c.targetId, targetName: info.nameOf(c.targetId), problem,
    last: lastOut(c), text: `${problem.words}: ${whenText(Date.parse(c.at), off)}. In this list until a later check is normal.`,
    ...(c.checkKind === 'gas-check' ? { procedure: GAS_FIRST } : {}),
  }));
  const rank = { overdue: 0, due: 1, done: 2 };
  rows.sort((a, b) => rank[a.status] - rank[b.status] || Date.parse(a.dueBy) - Date.parse(b.dueBy) || (a.targetName < b.targetName ? -1 : 1));
  const open = [...outages.values()].filter((o) => !o.endedAt).sort((a, b) => (a.startedAt < b.startedAt ? -1 : 1)).map((o) => ({ ...outageOut(o, info, now), startedText: whenText(Date.parse(o.startedAt), off) }));
  const month = monthBounds(t, off);
  const hours = outageHours(outages, { since: new Date(month.start).toISOString(), until: now });
  const gen = plannedChecksDone(checks, { since, until: now, targets: info.targets, offsetMinutes: off, checkKind: 'generator-test' });
  const kpiValues = {
    'generator-test-compliance': { value: gen.value, numerator: gen.numerator, denominator: gen.denominator, n: gen.n, failed: gen.failed,
      missed: gen.missed.map((m) => ({ ...m, targetName: info.nameOf(m.targetId), dueText: dueDayText(Date.parse(m.due), off) })), period: { since, until: now, days } },
    'utility-outage-hours': { value: Math.round(hours.value * 10) / 10, numerator: null, denominator: null, n: hours.n, plannedHours: Math.round(hours.plannedHours * 10) / 10,
      breakdown: hours.byUtility.map((r) => ({ id: r.id, name: r.name, hours: Math.round(r.hours * 10) / 10, plannedHours: Math.round(r.plannedHours * 10) / 10, outages: r.outages, open: r.open })),
      period: { since: new Date(month.start).toISOString(), until: now, month: month.name } },
  };
  const kpis = KPIS.map((k) => {
    const v = kpiValues[k.id];
    const base = { id: k.id, name: k.name, unit: k.unit, value: v.value, numerator: v.numerator, denominator: v.denominator, n: v.n, period: v.period, targetText: k.targetText };
    return input.format === 'short' ? base : { ...base, ...(v.failed != null ? { failed: v.failed, missed: v.missed } : {}), ...(v.breakdown ? { breakdown: v.breakdown, plannedHours: v.plannedHours } : {}),
      definition: k.definition, counts: k.counts, outOf: k.outOf, leavesOut: k.leavesOut, source: k.source };
  });
  const levels = levelsNow(events);
  const readings = latestReadings(checks).map((c) => {
    const set = c.checkKind === 'fuel-level' ? levels.fuelPct : levels.waterPct;
    return { checkKind: c.checkKind, targetId: c.targetId, targetName: info.nameOf(c.targetId), levelPct: c.levelPct, at: c.at, atText: whenText(Date.parse(c.at), off), setPct: set, below: c.levelPct < set };
  });
  const on = guideOn(events);
  const suggestions = on ? [
    ...ruleLowLevel(latestReadings(checks), levels, { nameOf: info.nameOf, offsetMinutes: off }),
    ...ruleRepeatFaults(events, { assets: info.assetById, now, nameOf: info.nameOf, wards }),
    ...ruleRepeatFailedTests(checks, { now, nameOf: info.nameOf, offsetMinutes: off }),
  ] : [];
  return {
    asOf: now, synthetic: await synth(core), offsetMinutes: off,
    attention: { overdue: rows.filter((r) => r.status === 'overdue'), problems, openOutages: open },
    checks: rows, readings, kpis, readOnly: READ_ONLY.map((x) => ({ ...x })), planned: PLANNED.map((x) => ({ ...x })),
    levels: { fuelPct: levels.fuelPct, waterPct: levels.waterPct, setAt: levels.setAt, text: `Fuel ${levels.fuelPct} %, stored water ${levels.waterPct} % (example setting, not a standard; set by this site)` },
    schedule: { note: SCHEDULE_NOTE, items: SCHEDULE.map((s) => ({ ...s })) },
    choices: choices(info),
    guide: { on, rules: GUIDE_RULES.map((r) => ({ ...r })), suggestions },
    note: NOT_FOR,
  };
}

const KPI_OUT = { type: 'object', required: ['id', 'name', 'unit', 'value'], properties: {
  id: { type: 'string' }, name: { type: 'string' }, unit: { type: 'string' }, value: { type: ['number', 'null'], description: 'null when nothing was due in the period.' },
  numerator: { type: ['number', 'null'] }, denominator: { type: ['number', 'null'] }, n: { type: 'integer' }, period: { type: 'object' }, targetText: { type: 'string' },
  failed: { type: 'integer', description: 'Generator test periods done with a failed test (counted as done).' }, missed: { type: 'array', description: 'Periods that ended with no test.' },
  breakdown: { type: 'array', description: 'Outage hours by utility, with planned shutdowns apart.' }, plannedHours: { type: 'number' },
  definition: { type: 'string' }, counts: { type: 'string' }, outOf: { type: 'string' }, leavesOut: { type: 'string' }, source: { type: 'string' } } };
const SUGGESTION = { type: 'object', required: ['rule', 'id', 'text', 'why', 'basis'], properties: {
  rule: { type: 'string' }, id: { type: 'string' }, text: { type: 'string' }, why: { type: 'string' }, basis: { type: 'string' },
  workOrders: { type: 'array', items: { type: 'string' } }, action: { type: ['object', 'null'], description: 'Always null tonight: advice only. A person decides.' } } };
const AGO = (what) => ({ type: 'integer', enum: AGO_MINUTES, description: `How many minutes ago the ${what}: ${AGO_MINUTES.join(', ')}. Leave out for now.` });

export const COMMANDS = [
  {
    name: 'ospeli_facilities_overview',
    summary: 'Utilities at a glance, in one call: what needs attention first (scheduled checks missed with no check since; the newest check failed, or a medical gas supply level picked as low or on reserve, until a later check is normal; open outages with how long), every scheduled check with its status (done, due, overdue) and due day, the newest fuel and water readings against the site\'s levels, outage hours this month by utility, the measures with their definitions and sources, and the guide\'s suggestions with their reasons (empty while the guide is off). Building and plant faults are Engineering\'s work orders: use ospeli_workorders_next with team estates. Read-only.',
    kind: 'read', roles: ALL_ROLES, approval: false,
    input: { type: 'object', additionalProperties: false, properties: {
      days: { type: 'integer', minimum: 7, maximum: 90, description: 'The period for generator test compliance: the last this many days. Default 30. Outage hours are always for the current month.' },
      format: FORMAT('the values without their definitions', 'each value with its definition, source and breakdown') } },
    output: { type: 'object', required: ['asOf', 'synthetic', 'attention', 'checks', 'readings', 'kpis', 'readOnly', 'planned', 'levels', 'guide', 'note'], properties: {
      asOf: TIME, synthetic: SYNTHETIC, offsetMinutes: { type: 'integer', description: 'The site\'s offset from UTC, used for due days and months.' },
      attention: { type: 'object', required: ['overdue', 'problems', 'openOutages'], properties: { overdue: { type: 'array' }, problems: { type: 'array', description: 'Each asset or place whose newest check failed, or whose medical gas supply level was picked as low or on reserve, until a later check is normal. It records what was seen; it never says whether a supply is safe.' }, openOutages: { type: 'array' } } },
      checks: { type: 'array', items: { type: 'object', required: ['checkKind', 'targetId', 'targetName', 'status', 'dueBy'] } },
      readings: { type: 'array', description: 'The newest fuel and water reading of each tank, with the site\'s level and whether it is below.' },
      kpis: { type: 'array', items: KPI_OUT }, readOnly: { type: 'array' }, planned: { type: 'array' },
      levels: { type: 'object', required: ['fuelPct', 'waterPct'] }, schedule: { type: 'object' },
      choices: { type: 'object', description: 'Pick lists: the generators for each asset check, the places for each place check, and the places an outage can be at (sites, buildings, departments).' },
      guide: { type: 'object', required: ['on', 'rules', 'suggestions'], properties: { on: { type: 'boolean' }, rules: { type: 'array' }, suggestions: { type: 'array', items: SUGGESTION } } },
      note: { type: 'string' } } },
    async run(core, input, { wards }) { return overview(core, input, wards); },
    example: { input: { format: 'short' } },
  },
  {
    name: 'ospeli_facilities_log_list',
    summary: 'The utilities log, newest first: checks (generator tests, fuel and water readings, medical gas checks) with what was picked, and outages with their utility, place, cause and length. Filter by kind (checks, outages) and checkKind. Each entry records the role, never a person. Read-only.',
    kind: 'read', roles: ALL_ROLES, approval: false,
    input: { type: 'object', additionalProperties: false, properties: {
      kind: { type: 'string', enum: ['all', 'checks', 'outages'], description: 'all (default), checks or outages.' },
      checkKind: { ...KIND_IN, description: 'Only checks of this kind.' },
      since: { ...TIME, description: 'Only entries at or after this time.' },
      format: FORMAT('id, what, where and when only', 'every field'), limit: LIMIT(20, 500, 'entries') } },
    output: { type: 'object', required: ['asOf', 'synthetic', 'entries', 'total', 'truncated'], properties: {
      asOf: TIME, synthetic: SYNTHETIC, total: TOTAL, truncated: TRUNCATED, entries: { type: 'array', items: { type: 'object', required: ['id', 'kind', 'at'] } } } },
    async run(core, input) {
      const now = core.now();
      const [events, info] = await Promise.all([core.events(), siteInfo(core)]);
      const kind = input.kind || 'all';
      const since = sameMoment(input.since);
      let list = [];
      if (kind !== 'outages') list.push(...deriveChecks(events).filter((c) => !input.checkKind || c.checkKind === input.checkKind).map((c) => checkOut(c, info)));
      if (kind !== 'checks' && !input.checkKind) list.push(...[...deriveOutages(events).values()].map((o) => outageOut(o, info, now)));
      list = list.filter((x) => !since || x.at >= since).sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : (a.id < b.id ? 1 : -1)));
      const cut = page(list, input.limit, 20);
      for (const x of cut.items) x.atText = whenText(Date.parse(x.at), info.offsetMinutes);
      const short = (x) => ({ id: x.id, kind: x.kind, at: x.at, atText: x.atText, what: x.kind === 'check' ? `${x.checkName}: ${x.words}` : `${x.utilityName} outage, ${x.causeName}${x.open ? ', still open' : ''}`, where: x.targetName || x.placeName });
      return { asOf: now, synthetic: await synth(core), total: cut.total, truncated: cut.truncated, entries: cut.items.map((x) => (input.format === 'short' ? short(x) : x)) };
    },
    example: { input: { kind: 'checks', checkKind: 'generator-test', limit: 5 } },
  },
  {
    name: 'ospeli_facilities_check_record',
    summary: 'Record a utility check, by picks only (nothing typed): a generator test (generator, pass or fail, run time), a fuel level (generator, per cent to the nearest 10), a stored water level (place, per cent) or a medical gas check (place, pass or fail, supply level band). A generator test or a medical gas check is recorded by the facilities technician or manager; a reading may also be taken by the facilities assistant. A failed generator test does not open a work order: report it with ospeli_workorders_report_fault (fault "Generator test fault"). A gas check records what was seen after the site\'s own procedure; it never says a supply is safe. An agent\'s call becomes a proposal for a person.',
    kind: 'write', roles: LOGGERS, approval: true,
    input: { type: 'object', additionalProperties: false, required: ['checkKind'], properties: {
      checkKind: KIND_IN,
      assetId: { ...ID, description: 'For generator-test and fuel-level: the generator, for example asset-generator-1.' },
      placeId: { ...ID, description: 'For water-level and gas-check: the place of the tank or gas plant, for example bld-main-plant.' },
      result: { type: 'string', enum: Object.keys(RESULTS), description: 'For generator-test and gas-check: pass or fail.' },
      runMinutes: { type: 'integer', enum: RUN_MINUTES, description: 'For generator-test: how long it ran, 15, 30 or 60 (60 means 60 minutes or more).' },
      levelPct: { type: 'integer', enum: LEVELS, description: 'For fuel-level and water-level: the gauge reading to the nearest 10 per cent, 0 to 100.' },
      levelBand: { type: 'string', enum: Object.keys(GAS_BANDS), description: `For gas-check: the main supply's level band: ${Object.entries(GAS_BANDS).map(([k, v]) => `${k} (${v})`).join(', ')}.` } } },
    output: { type: 'object', required: ['status'], properties: {
      status: WRITE_STATUS, checkId: CHECK_ID, checkName: { type: 'string' }, words: { type: 'string' },
      reportFault: { type: ['object', 'null'], description: 'After a failed generator test: the fault report a person may send with ospeli_workorders_report_fault (pick a priority first).' },
      events: EVENT_SEQS, proposal: PROPOSAL_OUT } },
    target: (input) => ({ id: `${input.checkKind}:${input.assetId || input.placeId || ''}`, word: 'check' }),
    async precheck(core, input, { actor }) { await checkCheck(core, input, actor); },
    async run(core, input, { actor }) {
      let checkId = null;
      const info = await siteInfo(core);
      const recs = await core.appendChecked(async (events) => {
        await checkCheck(core, input, actor, events, info);
        checkId = nextCheckId(events);
        const data = { checkKind: input.checkKind, ...(input.assetId ? { assetId: input.assetId } : { placeId: input.placeId }) };
        for (const f of ['result', 'runMinutes', 'levelPct', 'levelBand']) if (input[f] != null) data[f] = input[f];
        return [{ type: 'facilities.check-recorded', subject: checkId, actorRole: actor.role, at: core.now(), data }];
      });
      const c = deriveChecks(recs).find((x) => x.id === checkId) || { ...input };
      await core.recordAs(actor, 'facilities.check-recorded', checkId, { checkKind: input.checkKind, targetId: input.assetId || input.placeId, ...(input.result ? { result: input.result } : {}) });
      const fault = 'Generator test fault';
      const a = info.assetById.get(input.assetId);
      const reportFault = input.checkKind === 'generator-test' && input.result === 'fail' && a && faultsFor(a.kind).includes(fault)
        ? { command: 'ospeli_workorders_report_fault', input: { assetId: a.id, fault }, needs: 'priority (urgent, high or routine), picked by a person' } : null;
      return { status: 'done', checkId, checkName: CHECK_KINDS[input.checkKind].name, words: checkWords(c), reportFault, events: recs.map((r) => r.seq) };
    },
    example: { input: { checkKind: 'generator-test', assetId: 'asset-generator-1', result: 'pass', runMinutes: 30 } },
  },
  {
    name: 'ospeli_facilities_outage_start',
    summary: `Record that a utility supply stopped: the utility (${Object.keys(UTILITIES).join(', ')}), the site, building or department, and the cause (pick "not-known" if it is not known yet; it can be corrected when the outage ends). startedMinutesAgo records an outage noticed a little after it started. One open outage per utility and place: a second is refused and names the first. For medical gases, follow the site's medical gas procedure first; Ospeli raises no alarm and switches nothing. An agent's call becomes a proposal for a person.`,
    kind: 'write', roles: OUTAGE_ROLES, approval: true,
    input: { type: 'object', additionalProperties: false, required: ['utility', 'placeId', 'cause'], properties: {
      utility: { type: 'string', enum: Object.keys(UTILITIES), description: `The supply that stopped: ${Object.entries(UTILITIES).map(([k, v]) => `${k} (${v})`).join(', ')}.` },
      placeId: { ...ID, description: 'The site, building or department without the supply, for example bld-main-a.' },
      cause: { type: 'string', enum: Object.keys(CAUSES), description: `${Object.entries(CAUSES).map(([k, v]) => `${k} (${v})`).join(', ')}. Planned shutdowns are counted apart from outages.` },
      startedMinutesAgo: AGO('outage started') } },
    output: { type: 'object', required: ['status'], properties: { status: WRITE_STATUS, outageId: OUTAGE_ID, startedAt: TIME, events: EVENT_SEQS, proposal: PROPOSAL_OUT } },
    target: (input) => ({ id: `${input.utility}:${input.placeId}`, word: 'outage' }),
    async precheck(core, input) { await checkOutageStart(core, input); },
    async run(core, input, { actor }) {
      let outageId = null; let at = null;
      const info = await siteInfo(core);
      const recs = await core.appendChecked(async (events) => {
        await checkOutageStart(core, input, events, info);
        outageId = nextOutageId(events);
        at = new Date(Date.parse(core.now()) - (input.startedMinutesAgo || 0) * MIN).toISOString();
        return [{ type: 'facilities.outage-started', subject: outageId, actorRole: actor.role, at, data: { utility: input.utility, placeId: input.placeId, cause: input.cause, ...(input.startedMinutesAgo ? { backdatedMinutes: input.startedMinutesAgo } : {}) } }];
      });
      await core.recordAs(actor, 'facilities.outage-started', outageId, { utility: input.utility, placeId: input.placeId, cause: input.cause });
      return { status: 'done', outageId, startedAt: at, events: recs.map((r) => r.seq) };
    },
    example: { input: { utility: 'power', placeId: 'bld-main-a', cause: 'not-known' } },
  },
  {
    name: 'ospeli_facilities_outage_end',
    summary: 'Record that the supply is back: closes an open outage, so its length counts in the outage hours. The cause may be corrected now (for example from not-known to outside-supply). endedMinutesAgo records an end noticed a little late; it never goes before the start. An outage that has already ended is refused. An agent\'s call becomes a proposal for a person.',
    kind: 'write', roles: OUTAGE_ROLES, approval: true,
    input: { type: 'object', additionalProperties: false, required: ['outageId'], properties: {
      outageId: OUTAGE_ID,
      cause: { type: 'string', enum: Object.keys(CAUSES), description: 'The cause, if it is known now. Leave out to keep the one recorded at the start.' },
      endedMinutesAgo: AGO('supply came back') } },
    output: { type: 'object', required: ['status'], properties: { status: WRITE_STATUS, outageId: OUTAGE_ID, minutes: { type: 'integer' }, events: EVENT_SEQS, proposal: PROPOSAL_OUT } },
    target: (input) => ({ id: input.outageId, word: 'outage' }),
    async precheck(core, input) { await findOutage(core, input.outageId); },
    async run(core, input, { actor }) {
      let minutes = 0;
      const recs = await core.appendChecked(async (events) => {
        const o = await findOutage(core, input.outageId, events);
        const end = Math.max(Date.parse(o.startedAt), Date.parse(core.now()) - (input.endedMinutesAgo || 0) * MIN);
        minutes = Math.round((end - Date.parse(o.startedAt)) / MIN);
        return [{ type: 'facilities.outage-ended', subject: o.id, actorRole: actor.role, at: new Date(end).toISOString(), data: { ...(input.cause ? { cause: input.cause } : {}), ...(input.endedMinutesAgo ? { backdatedMinutes: input.endedMinutesAgo } : {}) } }];
      });
      await core.recordAs(actor, 'facilities.outage-ended', input.outageId, input.cause ? { cause: input.cause } : {});
      return { status: 'done', outageId: input.outageId, minutes, events: recs.map((r) => r.seq) };
    },
    example: { input: { outageId: 'out-00001', cause: 'outside-supply' }, needs: 'An open outage: ospeli_facilities_outage_start opens one, and ospeli_facilities_overview (attention.openOutages) lists the open ones with their ids.' },
  },
  {
    name: 'ospeli_facilities_levels_set',
    summary: `Set the site's levels for the guide's refill suggestion: fuel and stored water, per cent (${LEVEL_PICKS[0]} to ${LEVEL_PICKS.at(-1)}, in tens). The example starts at ${DEFAULT_LEVELS.fuelPct} % for both; it is an example setting, not a standard. People only (the facilities manager).`,
    kind: 'write', roles: MANAGER, approval: true, agents: false,
    input: { type: 'object', additionalProperties: false, properties: {
      fuelPct: { type: 'integer', enum: LEVEL_PICKS, description: 'Suggest a fuel refill when the newest reading is below this.' },
      waterPct: { type: 'integer', enum: LEVEL_PICKS, description: 'Suggest a water refill when the newest reading is below this.' } } },
    output: { type: 'object', required: ['status', 'fuelPct', 'waterPct'], properties: { status: WRITE_STATUS, fuelPct: { type: 'integer' }, waterPct: { type: 'integer' }, events: EVENT_SEQS } },
    async precheck(core, input) {
      if (input.fuelPct == null && input.waterPct == null) throw new CommandError('invalid-input', 'Send fuelPct, waterPct or both, for example { "fuelPct": 40 }.');
      const l = levelsNow(await core.events({ type: 'facilities.levels-set' }));
      if ((input.fuelPct ?? l.fuelPct) === l.fuelPct && (input.waterPct ?? l.waterPct) === l.waterPct) throw new CommandError('conflict', `The levels are already fuel ${l.fuelPct} % and water ${l.waterPct} %.`);
    },
    async run(core, input, { actor }) {
      if (input.fuelPct == null && input.waterPct == null) throw new CommandError('invalid-input', 'Send fuelPct, waterPct or both, for example { "fuelPct": 40 }.');
      let next = null;
      const recs = await core.appendChecked(async (events) => {
        const l = levelsNow(events);
        next = { fuelPct: input.fuelPct ?? l.fuelPct, waterPct: input.waterPct ?? l.waterPct };
        if (next.fuelPct === l.fuelPct && next.waterPct === l.waterPct) throw new CommandError('conflict', `The levels are already fuel ${l.fuelPct} % and water ${l.waterPct} %.`);
        return [{ type: 'facilities.levels-set', subject: 'facilities-levels', actorRole: actor.role, at: core.now(), data: next }];
      });
      await core.recordAs(actor, 'facilities.levels-set', 'facilities-levels', next);
      return { status: 'done', ...next, events: recs.map((r) => r.seq) };
    },
    example: { input: { fuelPct: 40 } },
  },
  {
    name: 'ospeli_facilities_guide_set',
    summary: 'Switch the facilities guide on or off for this site. The guide is three fixed rules (fuel or stored water below the site\'s level; repeat leak or power faults in one place; repeat failed tests on one generator) that suggest; the facilities manager decides. With it off everything else works the same. People only.',
    kind: 'write', roles: MANAGER, approval: true, agents: false,
    input: { type: 'object', additionalProperties: false, required: ['on'], properties: { on: { type: 'boolean', description: 'true: show the guide\'s suggestions. false: none.' } } },
    output: { type: 'object', required: ['status', 'on'], properties: { status: WRITE_STATUS, on: { type: 'boolean' }, events: EVENT_SEQS } },
    async precheck(core, input) {
      if (guideOn(await core.events({ type: 'facilities.guide-set' })) === input.on) throw new CommandError('conflict', `The guide is already ${input.on ? 'on' : 'off'}.`);
    },
    async run(core, input, { actor }) {
      const recs = await core.appendChecked(async (events) => {
        if (guideOn(events) === input.on) throw new CommandError('conflict', `The guide is already ${input.on ? 'on' : 'off'}.`);
        return [{ type: 'facilities.guide-set', subject: 'facilities-guide', actorRole: actor.role, at: core.now(), data: { on: input.on } }];
      });
      await core.recordAs(actor, 'facilities.guide-set', 'facilities-guide', { on: input.on });
      return { status: 'done', on: input.on, events: recs.map((r) => r.seq) };
    },
    example: { input: { on: false } },
  },
];

export async function prepareExample(core, command, { run }) {
  if (command.name === 'ospeli_facilities_outage_end') {
    const made = await run('ospeli_facilities_outage_start', { utility: 'power', placeId: 'bld-main-a', cause: 'not-known' }, 'estates-tech');
    return { outageId: made.outageId };
  }
  return {};
}

// ---- synthetic history: thirty days of utility checks and outages ----
// Generic patterns only, entirely fictional. Weekly generator tests on both generators, one failed
// run, and Generator 2's last full week missed with no test since (so the manager has a missed check
// to see). The current week's tests are not done yet. Fuel and water readings every few days, with
// Generator 1's fuel below the example level near the end. A medical gas check most mornings, with
// one day missed. Four outages: a short power cut, a water pump fault, a planned heating shutdown and
// a water outage still open at the end.
export function seed({ r, startMs, endMs, entities }) {
  const has = (x) => entities.some((e) => e.id === x);
  const gens = entities.filter((e) => e.type === 'asset' && e.kind === 'generator').map((e) => e.id);
  const plant = 'bld-main-plant';
  if (!gens.length || !has(plant)) return [];
  const off = entities.find((e) => e.type === 'site' && e.utcOffsetMinutes != null)?.utcOffsetMinutes ?? 0;
  const HOUR = 60 * MIN;
  const localDayStart = (t) => { const l = t + off * MIN; return l - (((l % DAY) + DAY) % DAY) - off * MIN; };
  const raw = [];
  const check = (t, data, role) => { if (t >= startMs && t < endMs) raw.push({ t, kind: 'check', data, role }); };
  // Weeks from Monday, site time (the same periods the schedule uses).
  const weekOf = (t) => { const d = new Date(t + off * MIN).getUTCDay(); return localDayStart(t) - ((d + 6) % 7) * DAY; };
  const thisWeek = weekOf(endMs);
  for (let w = weekOf(startMs); w < thisWeek; w += 7 * DAY) {
    gens.forEach((g, i) => {
      if (i === 1 && w === thisWeek - 7 * DAY) return; // Generator 2's last full week: missed
      const t = w + r.int(0, 3) * DAY + (9 + r.int(0, 3)) * HOUR + r.int(0, 59) * MIN;
      const fail = i === 0 && w === thisWeek - 14 * DAY; // one failed run, two weeks back
      check(t, { checkKind: 'generator-test', assetId: g, result: fail ? 'fail' : 'pass', runMinutes: fail ? 15 : r.pick([30, 30, 60]) }, 'estates-tech');
    });
  }
  // Fuel: every two to four days per generator, used slowly by the tests, topped up once; Generator 1 low at the end.
  gens.forEach((g, i) => {
    let level = i === 0 ? 80 : 90;
    for (let t = startMs + r.int(0, 2) * DAY; t < endMs - 2 * DAY; t += r.int(2, 4) * DAY) {
      const at = localDayStart(t) + (8 + r.int(0, 2)) * HOUR + r.int(0, 59) * MIN;
      check(at, { checkKind: 'fuel-level', assetId: g, levelPct: level }, r.chance(0.5) ? 'facilities-assistant' : 'estates-tech');
      level = level <= 60 ? 90 : level - 10;
    }
    if (i === 0) check(localDayStart(endMs - DAY) + 8 * HOUR + 20 * MIN, { checkKind: 'fuel-level', assetId: g, levelPct: 40 }, 'facilities-assistant');
  });
  // Stored water: every two to four days.
  for (let t = startMs + DAY; t < endMs - DAY; t += r.int(2, 4) * DAY) {
    check(localDayStart(t) + (8 + r.int(0, 2)) * HOUR + r.int(0, 59) * MIN, { checkKind: 'water-level', placeId: plant, levelPct: r.pick([60, 70, 70, 80, 90]) }, r.chance(0.5) ? 'facilities-assistant' : 'estates-tech');
  }
  // Medical gas plant: a check most mornings at about 08:00, one day missed.
  const missDay = localDayStart(endMs - 10 * DAY);
  for (let d = localDayStart(startMs) + DAY; d <= localDayStart(endMs); d += DAY) {
    if (d === missDay) continue;
    const at = d + 7 * HOUR + 30 * MIN + r.int(0, 50) * MIN;
    if (at >= endMs) continue;
    check(at, { checkKind: 'gas-check', placeId: plant, result: 'pass', levelBand: r.pick(['high', 'high', 'half']) }, 'estates-tech');
  }
  // Outages.
  const outages = [
    { daysBack: 22, hour: 14, minutes: 35, utility: 'power', placeId: 'bld-main-a', cause: 'outside-supply' },
    { daysBack: 12, hour: 9, minutes: 130, utility: 'water', placeId: plant, cause: 'equipment-fault' },
    { daysBack: 6, hour: 6, minutes: 180, utility: 'heating-cooling', placeId: 'bld-north-1', cause: 'planned-shutdown' },
  ].filter((o) => has(o.placeId));
  const out = [];
  raw.sort((a, b) => a.t - b.t);
  raw.forEach((c, i) => out.push({ t: c.t, type: 'facilities.check-recorded', subject: `chk-${String(i + 1).padStart(5, '0')}`, actorRole: c.role, data: c.data }));
  let n = 0;
  const outId = () => `out-${String(++n).padStart(5, '0')}`;
  for (const o of outages) {
    const s = localDayStart(endMs - o.daysBack * DAY) + o.hour * HOUR + r.int(0, 40) * MIN;
    const idOut = outId();
    out.push({ t: s, type: 'facilities.outage-started', subject: idOut, actorRole: 'estates-tech', data: { utility: o.utility, placeId: o.placeId, cause: o.cause === 'planned-shutdown' ? o.cause : 'not-known' } });
    out.push({ t: s + o.minutes * MIN, type: 'facilities.outage-ended', subject: idOut, actorRole: 'estates-tech', data: { cause: o.cause } });
  }
  if (has('bld-main-b')) out.push({ t: endMs - 50 * MIN, type: 'facilities.outage-started', subject: outId(), actorRole: 'estates-tech', data: { utility: 'water', placeId: 'bld-main-b', cause: 'not-known' } });
  return out.filter((e) => e.t < endMs && e.t >= startMs).sort((a, b) => a.t - b.t);
}
