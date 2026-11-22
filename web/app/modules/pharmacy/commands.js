// Pharmacy operations (area A6): the module's pack (see core/modules.js for the contract).
// Plain data and pure functions; no screen code, so the same file runs in the browser, in tests
// and on a site's own server.
//
// Slice 1: dispensing requests (raised, started, checked, ready, collected; on hold, cancelled) by
// picks only, the queue in working order, discharge medicines asked for from the ward, three
// measures of time by stage, and a guide of two fixed rules. Stock levels and expiry are planned.
// Operations only: a request is a ward, a bed, a kind, a count of items and times. It never holds a
// medicine name, a dose or a note, and Ospeli never checks a prescription. "Checked" records only
// that a pharmacist said the check (done outside Ospeli) happened at that time. Roles are recorded,
// never people; nothing ranks pharmacy staff. Nothing here calls a model.

import {
  CommandError, ALL_ROLES, ID, TIME, SYNTHETIC, LIMIT, TOTAL, TRUNCATED, FORMAT, page, WRITE_STATUS, PROPOSAL_OUT, EVENT_SEQS,
  isSynthetic, DAY, MIN,
} from '../../core/kit.js';
import { currentWords } from '../../core/model.js';
import { deriveBoard } from '../../core/beds.js';
import {
  KINDS, PRIORITIES, PLANNED, HOLD_REASONS, CANCEL_REASONS, STATE_WORDS, MAX_ITEMS, UNDO_MINUTES, DOUBLE_TAP_MINUTES, WORK_DAY, ESTIMATE_LAST, ESTIMATE_MIN,
  STALL_MINUTES, LATE_HOUR, REQUEST_ID_PATTERN, GUIDE_RULES, PLANNED_BY,
  deriveRequests, stateOf, isOpen, nextRequestId, sortQueue, orderReason, nextStep, undoable, estimateFor, plannedByMs, dischargeToday, heldMinutes,
  dischargeTurnaround, stageTimes, collectionWait, guideOn, ruleLateRequests, ruleWaitingTooLong, whenText, clockText, localDayStart,
} from './logic.js';

export const id = 'pharmacy';
export const PREFIX = 'ospeli_pharmacy_';
export const EVENT_PREFIX = 'pharmacy.';

const RAISERS = ['ward-nurse', 'bed-manager', 'pharmacy-technician'];
const PHARMACY = ['pharmacy-technician', 'pharmacist', 'pharmacy-manager'];
const CHECKERS = ['pharmacist'];
const COLLECTORS = ['pharmacy-technician', 'pharmacist', 'pharmacy-manager', 'ward-nurse'];
const MANAGER = ['pharmacy-manager'];

const fmtHM = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const TIMES_TEXT = Object.entries(PLANNED_BY).map(([k, m]) => `${PLANNED[k].toLowerCase()} ${k === 'tomorrow' ? `${fmtHM(m - 24 * 60)} the next day` : fmtHM(m)}`).join(', ');

// Every number has a definition and a source. No target: none is set by a cited source.
const NO_TARGET = 'No target set. Your site sets its own if it wants one (example setting, not a standard).';
export const KPIS = [
  { id: 'discharge-turnaround', name: 'Discharge medicines turnaround', unit: 'min',
    definition: `For discharge requests that reached Ready in the period: the minutes from Raised to Ready on the clock, with time on hold taken out (each On hold to Resumed span), median. The headline is for requests raised inside an example working day (${fmtHM(WORK_DAY.from)} to ${fmtHM(WORK_DAY.to)} site time; example setting, not a standard); requests raised outside it are shown apart, with their own median, so an evening request for tomorrow does not stretch the figure. Shown beside it: the median time on hold of the requests that were held, the figure for each planned pick, and "ready before the planned time: n of N" (planned times: ${TIMES_TEXT}; example settings).`,
    counts: 'Discharge requests raised in the working day that reached Ready in the period.', outOf: 'None (a median, not a share).',
    leavesOut: 'Cancelled requests; requests not ready yet; ward and other requests.', source: 'local definition', target: null, targetText: NO_TARGET },
  { id: 'stage-times', name: 'Time by stage', unit: 'min',
    definition: 'For every kind of request: Raised to Started, Started to Checked and Checked to Ready, median minutes each with time on hold taken out, for steps recorded in the period. The figure shown is the stage with the longest median, so the main delay shows. Method: the time of each stage of a dispensing service, as in a process map (method only, no result is quoted: JMIR Human Factors 2022, PMID 36222805, doi:10.2196/37905).',
    counts: 'Each stage recorded in the period.', outOf: 'None (medians).', leavesOut: 'Cancelled requests; a step undone as tapped by mistake.',
    source: 'local definition (method as in PMID 36222805)', target: null, targetText: NO_TARGET },
  { id: 'collection-wait', name: 'Collection wait', unit: 'min',
    definition: 'For requests collected in the period: the minutes from Ready to Collected, median. A ready request is never put on hold, so this time is counted here and only here.',
    counts: 'Requests collected in the period.', outOf: 'None (a median, not a share).', leavesOut: 'Requests still waiting for collection (shown as a count).',
    source: 'local definition', target: null, targetText: NO_TARGET },
];
const PLANNED_LINES = [
  { id: 'stock', text: 'Stock levels and expiry: planned' },
];
export const NOT_FOR = 'Operations only. Ospeli records when a request moved through a step. It does not hold what was prescribed, choose medicines, doses or substitutes, or check a prescription. "Checked" means a pharmacist recorded that the check happened at that time. It never ranks pharmacy staff.';
export const CHECK_NOTE = 'The check is done outside Ospeli; this records the time.';
const ORDER_NOTE = 'Working order: moved to the front by the manager, then urgent (the ward\'s call), then discharge today (earliest planned time first), then oldest.';
const ESTIMATE_NOTE = `Estimate from recent requests, not a promise: the median time to Ready of the last ${ESTIMATE_LAST} requests of the same kind on this ward, time on hold left out. Fewer than ${ESTIMATE_MIN}: no estimate (example setting, not a standard).`;

// ---- the site ----
const GONE = 'a place no longer on this site';
async function siteInfo(core) {
  const all = await core.listEntities();
  const wards = all.filter((e) => e.type === 'ward');
  const wardById = new Map(wards.map((w) => [w.id, w]));
  const beds = all.filter((e) => e.type === 'bed');
  const bedById = new Map(beds.map((b) => [b.id, b]));
  const offsetMinutes = all.find((e) => e.type === 'site' && e.utcOffsetMinutes != null)?.utcOffsetMinutes ?? 0;
  // An id that is not on this site is never answered as its own name (#138).
  const wardName = (x) => (wardById.has(x) ? currentWords(wardById.get(x).name) : GONE);
  const bedName = (x) => (bedById.has(x) ? currentWords(bedById.get(x).name) : null);
  return { wards, wardById, beds, bedById, offsetMinutes, wardName, bedName };
}
const label = (info) => (r) => `${info.wardName(r.wardId)}${r.bedId && info.bedName(r.bedId) ? `, ${info.bedName(r.bedId)}` : ''}`;

function requestOut(r, info, nowMs, all = null, format = 'detailed') {
  const off = info.offsetMinutes;
  const st = stateOf(r);
  const clocks = {};
  for (const [k, f] of [['raised', 'raisedAt'], ['started', 'startedAt'], ['checked', 'checkedAt'], ['ready', 'readyAt'], ['collected', 'collectedAt'], ['cancelled', 'cancelledAt']]) {
    if (r[f]) clocks[k] = whenText(Date.parse(r[f]), nowMs, off);
  }
  if (r.held) clocks.held = whenText(Date.parse(r.holdSince), nowMs, off);
  const base = {
    id: r.id, wardId: r.wardId, wardName: info.wardName(r.wardId), bedId: r.bedId, bedName: r.bedId ? info.bedName(r.bedId) : null, label: label(info)(r),
    kind: r.kind, kindName: KINDS[r.kind], priority: r.priority, urgent: r.priority === 'urgent', planned: r.planned, plannedName: r.planned ? PLANNED[r.planned] : null,
    items: r.items, state: st, stateName: STATE_WORDS[st], stage: r.stage, held: r.held, front: r.front,
    raisedAt: r.raisedAt, waitMinutes: Math.max(0, Math.floor(((r.collectedAt || r.cancelledAt ? Date.parse(r.collectedAt || r.cancelledAt) : nowMs) - Date.parse(r.raisedAt)) / MIN)),
    sinceStepMinutes: Math.max(0, Math.floor((nowMs - Date.parse(r.held ? r.holdSince : r.lastMoveAt)) / MIN)),
    nextStep: nextStep(r), clocks,
  };
  if (format === 'short') return base;
  const est = all ? estimateFor(all, r, nowMs) : null;
  return {
    ...base, raisedByRole: r.raisedByRole, startedAt: r.startedAt, checkedAt: r.checkedAt, readyAt: r.readyAt, collectedAt: r.collectedAt, cancelledAt: r.cancelledAt,
    cancelReason: r.cancelReason, cancelReasonName: r.cancelReason ? CANCEL_REASONS[r.cancelReason] : null,
    holdReason: r.holdReason, holdReasonName: r.holdReason ? HOLD_REASONS[r.holdReason] : null, holdSince: r.holdSince,
    heldMinutes: Math.round(heldMinutes(r, Date.parse(r.raisedAt), nowMs, nowMs)),
    plannedBy: plannedByMs(r, info.offsetMinutes) != null ? new Date(plannedByMs(r, info.offsetMinutes)).toISOString() : null,
    dischargeToday: dischargeToday(r, nowMs, info.offsetMinutes), orderReason: orderReason(r, nowMs, info.offsetMinutes),
    lastStep: { step: r.lastStep.step, at: r.lastStep.at, byRole: r.lastStep.role }, undo: undoable(r, nowMs), undone: r.undone,
    ...(est ? { estimate: { minutes: est.minutes == null ? null : Math.round(est.minutes), n: est.n, readyBy: est.atMs ? new Date(est.atMs).toISOString() : null,
      readyByText: est.atMs ? clockText(est.atMs, off) : null, late: est.late } } : {}),
  };
}
const synth = (core) => isSynthetic(core);

// ---- inputs ----
const REQUEST_ID = { type: 'string', pattern: REQUEST_ID_PATTERN, maxLength: 20, description: 'A request id, rx- and five digits, for example rx-00012. ospeli_pharmacy_queue_list lists the open ones.' };
const STATE_IN = { type: 'string', enum: ['raised', 'started', 'checked', 'ready', 'on-hold'], description: 'The state you saw the request in (from ospeli_pharmacy_queue_list). If it has moved on since, nothing is saved and the answer says what it is now, so a double tap never skips a stage. Recommended.' };
const WARD_IN = { ...ID, description: 'A ward id, for example ward-a1. ospeli_pharmacy_ward_requests lists the wards.' };
const pickList = (o) => Object.entries(o).map(([k, v]) => `${k} (${v})`).join(', ');

async function findRequest(core, requestId, events) {
  const r = deriveRequests(events ?? await core.events()).get(requestId);
  if (!r) throw new CommandError('not-found', 'No request with that id. ospeli_pharmacy_queue_list lists the open requests with their ids.');
  return r;
}
function expect(r, input) {
  const st = stateOf(r);
  if (input.expectedState && input.expectedState !== st) {
    throw new CommandError('conflict', `Already changed: ${r.id} is now ${STATE_WORDS[st]}. Nothing was saved.`, { state: st });
  }
  return st;
}
const closedMsg = (r) => `${r.id} is ${STATE_WORDS[r.stage].toLowerCase()}: nothing more can be recorded on it.`;

// What a step writes, after every check against the log as it is now. Throws when it may not.
function planStep(r, input, actor, now) {
  const st = expect(r, input);
  if (!isOpen(r)) throw new CommandError('conflict', closedMsg(r), { state: st });
  const ev = (type, data = {}) => [{ type, subject: r.id, actorRole: actor.role, at: now, data }];
  const nowMs = Date.parse(now);
  const s = input.step;
  if ((s === 'hold' || s === 'cancel') !== (input.reason != null)) {
    throw new CommandError('invalid-input', s === 'hold' ? `A hold needs reason: ${pickList(HOLD_REASONS)}.` : s === 'cancel' ? `A cancel needs reason: ${pickList(CANCEL_REASONS)}.` : `reason is for hold and cancel only, not ${s}.`);
  }
  switch (s) {
    case 'start':
      if (st === 'on-hold') throw new CommandError('conflict', `${r.id} is on hold (${HOLD_REASONS[r.holdReason].toLowerCase()}). Resume it first.`, { state: st });
      if (st !== 'raised') throw new CommandError('conflict', `${r.id} is already ${STATE_WORDS[st].toLowerCase()}. Nothing was saved.`, { state: st });
      return ev('pharmacy.request-started');
    case 'ready':
      if (st === 'on-hold') throw new CommandError('conflict', `${r.id} is on hold. Resume it first.`, { state: st });
      if (st === 'raised' || st === 'started') throw new CommandError('conflict', `Ready needs Checked first: a pharmacist records the check (ospeli_pharmacy_request_check). ${r.id} is ${STATE_WORDS[st].toLowerCase()}.`, { state: st });
      if (st !== 'checked') throw new CommandError('conflict', `${r.id} is already ${STATE_WORDS[st].toLowerCase()}. Nothing was saved.`, { state: st });
      return ev('pharmacy.request-ready');
    case 'hold':
      if (!HOLD_REASONS[input.reason]) throw new CommandError('invalid-input', `A hold reason is one of: ${pickList(HOLD_REASONS)}.`);
      if (st === 'on-hold') throw new CommandError('conflict', `${r.id} is already on hold.`, { state: st });
      if (st === 'ready') throw new CommandError('conflict', `${r.id} is ready and waits for collection. That time counts as collection wait, so it is not put on hold.`, { state: st });
      return ev('pharmacy.request-on-hold', { reason: input.reason });
    case 'resume':
      if (st !== 'on-hold') throw new CommandError('conflict', `${r.id} is not on hold.`, { state: st });
      return ev('pharmacy.request-resumed');
    case 'cancel':
      if (!CANCEL_REASONS[input.reason]) throw new CommandError('invalid-input', `A cancel reason is one of: ${pickList(CANCEL_REASONS)}.`);
      return ev('pharmacy.request-cancelled', { reason: input.reason });
    case 'front':
    case 'back':
      if (!MANAGER.includes(actor.role)) throw new CommandError('forbidden', 'Moving a request to the front, or back to the usual order, is for the pharmacy manager.', { roles: MANAGER });
      if ((s === 'front') === r.front) throw new CommandError('conflict', s === 'front' ? `${r.id} is already at the front.` : `${r.id} is already in the usual order.`);
      return ev('pharmacy.priority-set', { front: s === 'front' });
    case 'undo': {
      const u = undoable(r, nowMs);
      if (u === 'checked') throw new CommandError('conflict', `The last step on ${r.id} is Checked: a pharmacist undoes it with ospeli_pharmacy_request_check and undo: true.`);
      if (!u) throw new CommandError('conflict', `Nothing to undo on ${r.id}: only the last step (Started or Ready), within ${UNDO_MINUTES} minutes, and not while on hold.`);
      return ev('pharmacy.step-undone', { step: u });
    }
    default: throw new CommandError('invalid-input', 'step is one of start, ready, hold, resume, cancel, front, back, undo.');
  }
}
function planCheck(r, input, actor, now) {
  const st = expect(r, input);
  if (!isOpen(r)) throw new CommandError('conflict', closedMsg(r), { state: st });
  if (input.undo === true) {
    if (undoable(r, Date.parse(now)) !== 'checked') throw new CommandError('conflict', `Nothing to undo: Checked is undone only while it is the last step on ${r.id}, within ${UNDO_MINUTES} minutes.`, { state: st });
    return [{ type: 'pharmacy.step-undone', subject: r.id, actorRole: actor.role, at: now, data: { step: 'checked' } }];
  }
  if (st === 'on-hold') throw new CommandError('conflict', `${r.id} is on hold. Resume it first.`, { state: st });
  if (st === 'raised') throw new CommandError('conflict', `${r.id} has not been started. Start it first.`, { state: st });
  if (st !== 'started') throw new CommandError('conflict', `${r.id} is already ${STATE_WORDS[st].toLowerCase()}. Nothing was saved.`, { state: st });
  return [{ type: 'pharmacy.request-checked', subject: r.id, actorRole: actor.role, at: now, data: {} }];
}
function planCollect(r, input, actor, now) {
  const st = expect(r, input);
  if (st === 'collected') throw new CommandError('conflict', `${r.id} is already collected. Nothing was saved.`, { state: st });
  if (!isOpen(r)) throw new CommandError('conflict', closedMsg(r), { state: st });
  if (st !== 'ready') throw new CommandError('conflict', `${r.id} is not ready yet (${STATE_WORDS[st].toLowerCase()}). It can be collected once it is Ready.`, { state: st });
  return [{ type: 'pharmacy.request-collected', subject: r.id, actorRole: actor.role, at: now, data: {} }];
}

// A new request: the ward exists, the bed is on that ward, the picks fit the kind, one open
// discharge request per bed, and the same picks again within two minutes is "already saved".
async function checkRaise(core, input, events, info) {
  const i = info ?? await siteInfo(core);
  if (!i.wardById.has(input.wardId)) throw new CommandError('not-found', `wardId must be one of this site's wards: ${i.wards.map((w) => w.id).join(', ') || 'none on this site'}.`, { wards: i.wards.map((w) => w.id) });
  if (input.bedId != null && i.bedById.get(input.bedId)?.parentId !== input.wardId) throw new CommandError('not-found', 'bedId must be a bed on that ward, for example ward-a1-bed-04. ospeli_pharmacy_ward_requests with the wardId lists its beds.');
  if (input.kind === 'discharge') {
    if (!input.planned) throw new CommandError('invalid-input', `A discharge request needs planned, the planned discharge: ${pickList(PLANNED)}.`);
    if (!input.bedId) throw new CommandError('invalid-input', 'A discharge request needs bedId: the bed of the patient going home.');
  } else if (input.planned) throw new CommandError('invalid-input', 'planned is for a discharge request only.');
  const all = deriveRequests(events ?? await core.events());
  const nowMs = Date.parse(core.now());
  if (input.kind === 'discharge') {
    const open = [...all.values()].find((r) => isOpen(r) && r.kind === 'discharge' && r.bedId === input.bedId);
    if (open) throw new CommandError('conflict', `${open.id} is already open for discharge medicines for this bed (${STATE_WORDS[stateOf(open)].toLowerCase()}). Nothing new was saved.`, { existing: open.id });
  }
  const same = [...all.values()].find((r) => r.wardId === input.wardId && (r.bedId ?? null) === (input.bedId ?? null) && r.kind === input.kind && r.priority === input.priority
    && (r.planned ?? null) === (input.planned ?? null) && r.items === input.items && Math.abs(nowMs - Date.parse(r.raisedAt)) < DOUBLE_TAP_MINUTES * MIN);
  if (same) throw new CommandError('conflict', `Already saved: ${same.id} with the same picks was saved a moment ago. No second request was saved.`, { existing: same.id });
}

async function encounterOf(core, info, bedId, events) {
  if (!bedId) return null;
  const board = deriveBoard(info.beds.filter((b) => b.id === bedId), events.filter((e) => /^(bed|patient)\./.test(e.type)));
  const b = board.beds.get(bedId);
  return b && ['occupied', 'expected-discharge'].includes(b.state) ? b.encounter : null;
}

const wardOfRequest = async (core, input) => deriveRequests(await core.events()).get(input.requestId)?.wardId ?? null;
const visible = (wards) => (r) => !wards || wards.has(r.wardId);

// ---- the overview ----
async function overview(core, input, wards) {
  const now = core.now();
  const nowMs = Date.parse(now);
  const days = input.days ?? 7;
  const since = new Date(nowMs - days * DAY).toISOString();
  const [events, info] = await Promise.all([core.events(), siteInfo(core)]);
  const off = info.offsetMinutes;
  const everything = deriveRequests(events);
  const all = new Map([...everything].filter(([, r]) => visible(wards)(r)));
  const open = [...all.values()].filter(isOpen);
  const counts = { raised: 0, started: 0, checked: 0, ready: 0, 'on-hold': 0 };
  for (const r of open) counts[stateOf(r)] += 1;
  const turn = dischargeTurnaround(all, { since, until: now, offsetMinutes: off });
  const stages = stageTimes(all, { since, until: now });
  const coll = collectionWait(all, { since, until: now });
  const byWardTurn = new Map(turn.byWard.map((w) => [w.wardId, w]));
  const wardIds = info.wards.map((w) => w.id).filter((w) => !wards || wards.has(w));
  const byWard = wardIds.map((w) => {
    const mine = open.filter((r) => r.wardId === w);
    const c = { raised: 0, started: 0, checked: 0, ready: 0, 'on-hold': 0 };
    for (const r of mine) c[stateOf(r)] += 1;
    const t = byWardTurn.get(w);
    return { wardId: w, wardName: info.wardName(w), open: mine.length, counts: c,
      oldestMinutes: mine.length ? Math.floor((nowMs - Math.min(...mine.map((r) => Date.parse(r.raisedAt)))) / MIN) : null,
      turnaround: t ? { value: t.value == null ? null : Math.round(t.value), n: t.n } : { value: null, n: 0 } };
  });
  const kpiValues = {
    'discharge-turnaround': { value: turn.value, n: turn.n, extra: { outsideWorkDay: turn.outsideWorkDay, hold: turn.hold, readyBeforePlanned: turn.readyBeforePlanned, byPlanned: turn.byPlanned,
      byWard: turn.byWard.map((w) => ({ ...w, wardName: info.wardName(w.wardId) })) } },
    'stage-times': { value: stages.value, n: stages.n, extra: { longest: stages.longest, stages: stages.stages } },
    'collection-wait': { value: coll.value, n: coll.n, extra: { waitingNow: counts.ready } },
  };
  const kpis = KPIS.map((k) => {
    const v = kpiValues[k.id];
    const base = { id: k.id, name: k.name, unit: k.unit, value: v.value, n: v.n, numerator: null, denominator: null, period: { since, until: now, days }, targetText: k.targetText, ...v.extra };
    return input.format === 'short' ? { id: k.id, name: k.name, unit: k.unit, value: v.value, n: v.n, period: base.period, ...(k.id === 'stage-times' ? { longest: stages.longest } : {}) }
      : { ...base, definition: k.definition, counts: k.counts, outOf: k.outOf, leavesOut: k.leavesOut, source: k.source };
  });
  const on = guideOn(events);
  const suggestions = on ? [
    ...ruleWaitingTooLong(all, { nowMs, offsetMinutes: off, label: label(info) }),
    ...ruleLateRequests(all, { nowMs, offsetMinutes: off, wardName: info.wardName }),
  ] : [];
  const oldest = sortQueue(open.filter((r) => r.stage !== 'ready'), nowMs, off).sort((a, b) => (a.raisedAt < b.raisedAt ? -1 : 1)).slice(0, input.format === 'short' ? 3 : 8)
    .map((r) => requestOut(r, info, nowMs, null, input.format));
  return {
    asOf: now, synthetic: await synth(core), offsetMinutes: off, counts, open: open.length, byWard, oldest, kpis,
    guide: { on, rules: GUIDE_RULES.map((r) => ({ ...r })), suggestions },
    planned: PLANNED_LINES.map((x) => ({ ...x })),
    settings: { workDay: `${fmtHM(WORK_DAY.from)} to ${fmtHM(WORK_DAY.to)}`, plannedTimes: TIMES_TEXT, undoMinutes: UNDO_MINUTES, stallMinutes: STALL_MINUTES, lateHour: LATE_HOUR, maxItems: MAX_ITEMS,
      note: 'Each is an example setting, not a standard.' },
    note: NOT_FOR,
  };
}

const KPI_OUT = { type: 'object', required: ['id', 'name', 'unit', 'value', 'n'], properties: {
  id: { type: 'string' }, name: { type: 'string' }, unit: { type: 'string' }, value: { type: ['number', 'null'], description: 'Median minutes; null when nothing is in the period.' },
  n: { type: 'integer', description: 'How many requests (or stages, for time by stage) the figure reads.' }, period: { type: 'object' }, targetText: { type: 'string' },
  outsideWorkDay: { type: 'object', description: 'Discharge turnaround only: requests raised outside the example working day, with their own median.' },
  hold: { type: 'object', description: 'Discharge turnaround only: the median time on hold of the requests that were held, and how many.' },
  readyBeforePlanned: { type: 'object', description: 'Discharge turnaround only: ready by the planned time, n of N.' },
  byPlanned: { type: 'array' }, byWard: { type: 'array' }, stages: { type: 'array', description: 'Time by stage only: each stage\'s median and count.' },
  longest: { type: ['string', 'null'] }, waitingNow: { type: 'integer' },
  numerator: { type: ['number', 'null'] }, denominator: { type: ['number', 'null'] },
  definition: { type: 'string' }, counts: { type: 'string' }, outOf: { type: 'string' }, leavesOut: { type: 'string' }, source: { type: 'string' } } };
const REQUEST_OUT = { type: 'object', required: ['id', 'wardId', 'kind', 'priority', 'items', 'state', 'raisedAt'], properties: {
  id: REQUEST_ID, wardId: ID, wardName: { type: 'string' }, bedId: { type: ['string', 'null'] }, bedName: { type: ['string', 'null'] }, label: { type: 'string' },
  kind: { type: 'string', enum: Object.keys(KINDS) }, priority: { type: 'string', enum: Object.keys(PRIORITIES) }, planned: { type: ['string', 'null'] }, items: { type: 'integer' },
  state: { type: 'string', enum: Object.keys(STATE_WORDS) }, nextStep: { type: ['string', 'null'], description: 'start, check (a pharmacist), ready, collect, or null (on hold, or closed).' },
  raisedAt: TIME, waitMinutes: { type: 'integer' }, clocks: { type: 'object', description: 'Each step as clock time (site time) and how long ago.' },
  estimate: { type: 'object', description: 'Ward reads only: when it may be ready, from recent requests. Not a promise.' } } };
const WRITE_OUT = { type: 'object', required: ['status'], properties: {
  status: WRITE_STATUS, requestId: REQUEST_ID, state: { type: 'string' }, stateName: { type: 'string' }, events: EVENT_SEQS, proposal: PROPOSAL_OUT } };

export const COMMANDS = [
  {
    name: 'ospeli_pharmacy_queue_list',
    summary: `The dispensing queue: every open request in working order (${ORDER_NOTE.replace(/^Working order: /, '').replace(/\.$/, '')}), then those on hold, then those ready for collection. Each has its ward, bed, kind, items count, time waiting, stage and the next step's words. Counts by stage. A request holds no medicine names or doses. Read-only.`,
    kind: 'read', roles: ALL_ROLES, approval: false,
    input: { type: 'object', additionalProperties: false, properties: {
      wardId: { ...WARD_IN, description: 'Only this ward\'s requests.' },
      format: FORMAT('id, ward, stage and wait only', 'every field'), limit: LIMIT(50, 500, 'requests') } },
    output: { type: 'object', required: ['asOf', 'synthetic', 'counts', 'requests', 'total', 'truncated'], properties: {
      asOf: TIME, synthetic: SYNTHETIC, offsetMinutes: { type: 'integer' }, counts: { type: 'object' }, total: TOTAL, truncated: TRUNCATED,
      requests: { type: 'array', items: { ...REQUEST_OUT, properties: { ...REQUEST_OUT.properties, section: { type: 'string', enum: ['working', 'on-hold', 'ready'] } } } },
      orderNote: { type: 'string' }, checkNote: { type: 'string' }, picks: { type: 'object' }, note: { type: 'string' } } },
    wardOf: (core, input) => input.wardId ?? null,
    async run(core, input, { wards }) {
      const now = core.now(); const nowMs = Date.parse(now);
      const [events, info] = await Promise.all([core.events(), siteInfo(core)]);
      const all = deriveRequests(events);
      const open = [...all.values()].filter((r) => isOpen(r) && visible(wards)(r) && (!input.wardId || r.wardId === input.wardId));
      const counts = { raised: 0, started: 0, checked: 0, ready: 0, 'on-hold': 0 };
      for (const r of open) counts[stateOf(r)] += 1;
      const off = info.offsetMinutes;
      const working = sortQueue(open.filter((r) => !r.held && r.stage !== 'ready'), nowMs, off).map((r) => ['working', r]);
      const held = open.filter((r) => r.held).sort((a, b) => (a.holdSince < b.holdSince ? -1 : 1)).map((r) => ['on-hold', r]);
      const ready = open.filter((r) => r.stage === 'ready').sort((a, b) => (a.readyAt < b.readyAt ? -1 : 1)).map((r) => ['ready', r]);
      const cut = page([...working, ...held, ...ready], input.limit, 50);
      return {
        asOf: now, synthetic: await synth(core), offsetMinutes: off, counts, total: cut.total, truncated: cut.truncated,
        requests: cut.items.map(([section, r]) => ({ ...requestOut(r, info, nowMs, null, input.format), section })),
        orderNote: ORDER_NOTE, checkNote: CHECK_NOTE,
        picks: { holdReasons: { ...HOLD_REASONS }, cancelReasons: { ...CANCEL_REASONS }, undoMinutes: UNDO_MINUTES }, note: NOT_FOR,
      };
    },
    example: { input: { format: 'short', limit: 10 } },
  },
  {
    name: 'ospeli_pharmacy_ward_requests',
    summary: `One ward's requests for the ward's phone: those still open and those closed in the last 24 hours, each with its stage, clock times and, while not ready, an estimate of when it may be ready (${ESTIMATE_NOTE.replace(/\.$/, '')}). With wardId it also lists the ward's beds with a patient (for the discharge form). Without wardId: the list of wards, and every planned discharge on the bed board with whether its medicines are asked for and where they are (for the patient flow coordinator). Read-only.`,
    kind: 'read', roles: ALL_ROLES, approval: false,
    input: { type: 'object', additionalProperties: false, properties: {
      wardId: WARD_IN, format: FORMAT('id, stage and estimate only', 'every field'), limit: LIMIT(50, 300, 'requests') } },
    output: { type: 'object', required: ['asOf', 'synthetic', 'wards', 'requests', 'total', 'truncated'], properties: {
      asOf: TIME, synthetic: SYNTHETIC, wardId: { type: ['string', 'null'] }, wardName: { type: ['string', 'null'] }, wards: { type: 'array' },
      beds: { type: 'array', description: 'With wardId: the ward\'s beds with a patient, and whether a discharge request is open for each.' },
      plannedDischarges: { type: 'array', description: 'Beds whose patient has a planned discharge, with the discharge request for it, if any.' },
      requests: { type: 'array', items: REQUEST_OUT }, total: TOTAL, truncated: TRUNCATED, estimateNote: { type: 'string' }, picks: { type: 'object' }, note: { type: 'string' } } },
    wardOf: (core, input) => input.wardId ?? null,
    async run(core, input, { wards }) {
      const now = core.now(); const nowMs = Date.parse(now);
      const [events, info] = await Promise.all([core.events(), siteInfo(core)]);
      if (input.wardId && !info.wardById.has(input.wardId)) throw new CommandError('not-found', `wardId must be one of this site's wards: ${info.wards.map((w) => w.id).join(', ')}.`);
      const all = deriveRequests(events);
      const seen = visible(wards);
      const board = deriveBoard(info.beds, events.filter((e) => /^(bed|patient)\./.test(e.type)));
      const openDischarge = new Map([...all.values()].filter((r) => isOpen(r) && r.kind === 'discharge' && r.bedId).map((r) => [r.bedId, r]));
      const list = [...all.values()].filter((r) => seen(r) && (!input.wardId || r.wardId === input.wardId)
        && (isOpen(r) || nowMs - Date.parse(r.collectedAt || r.cancelledAt) <= DAY)).sort((a, b) => (a.raisedAt < b.raisedAt ? 1 : -1));
      const cut = page(list, input.limit, 50);
      const bedRow = (b) => { const s = board.beds.get(b.id); const r = openDischarge.get(b.id);
        return { bedId: b.id, bedName: currentWords(b.name), wardId: b.parentId, wardName: info.wardName(b.parentId), plannedDischarge: s.state === 'expected-discharge',
          ...(s.expectedAt ? { expectedAt: s.expectedAt, expectedText: whenText(Date.parse(s.expectedAt), nowMs, info.offsetMinutes) } : {}),
          request: r ? { id: r.id, state: stateOf(r), stateName: STATE_WORDS[stateOf(r)] } : null }; };
      const withPatient = info.beds.filter((b) => ['occupied', 'expected-discharge'].includes(board.beds.get(b.id)?.state));
      return {
        asOf: now, synthetic: await synth(core), wardId: input.wardId ?? null, wardName: input.wardId ? info.wardName(input.wardId) : null,
        wards: info.wards.filter((w) => !wards || wards.has(w.id)).map((w) => ({ id: w.id, name: info.wardName(w.id) })),
        beds: input.wardId ? withPatient.filter((b) => b.parentId === input.wardId).map(bedRow) : [],
        plannedDischarges: withPatient.filter((b) => board.beds.get(b.id).state === 'expected-discharge' && (!wards || wards.has(b.parentId)) && (!input.wardId || b.parentId === input.wardId)).map(bedRow),
        requests: cut.items.map((r) => requestOut(r, info, nowMs, all, input.format)), total: cut.total, truncated: cut.truncated,
        estimateNote: ESTIMATE_NOTE,
        picks: { kinds: { ...KINDS }, priorities: { ...PRIORITIES }, planned: { ...PLANNED }, maxItems: MAX_ITEMS, maxItemsNote: `1 to ${MAX_ITEMS} items: a cap for the form, not a clinical limit (example setting, not a standard).` },
        note: NOT_FOR,
      };
    },
    example: { input: { wardId: 'ward-a1', format: 'short' } },
  },
  {
    name: 'ospeli_pharmacy_overview',
    summary: 'Pharmacy at a glance, in one call: open requests by stage and by ward (with each ward\'s oldest wait and discharge turnaround), the oldest open requests, the three measures with their definitions and sources (discharge medicines turnaround with hold time taken out, time by stage, collection wait), the guide\'s suggestions with their reasons (empty while the guide is off), and the example settings. Measures count requests, never a person. Read-only.',
    kind: 'read', roles: ALL_ROLES, approval: false,
    input: { type: 'object', additionalProperties: false, properties: {
      days: { type: 'integer', minimum: 1, maximum: 30, description: 'The period for the measures: the last this many days. Default 7.' },
      format: FORMAT('the values without their definitions', 'each value with its definition, source and breakdown') } },
    output: { type: 'object', required: ['asOf', 'synthetic', 'counts', 'byWard', 'kpis', 'guide', 'planned', 'note'], properties: {
      asOf: TIME, synthetic: SYNTHETIC, offsetMinutes: { type: 'integer' }, counts: { type: 'object' }, open: { type: 'integer' }, byWard: { type: 'array' }, oldest: { type: 'array' },
      kpis: { type: 'array', items: KPI_OUT },
      guide: { type: 'object', required: ['on', 'rules', 'suggestions'], properties: { on: { type: 'boolean' }, rules: { type: 'array' }, suggestions: { type: 'array', items: { type: 'object', required: ['rule', 'id', 'text', 'why', 'basis'] } } } },
      planned: { type: 'array' }, settings: { type: 'object' }, note: { type: 'string' } } },
    async run(core, input, { wards }) { return overview(core, input, wards); },
    example: { input: { format: 'short' } },
  },
  {
    name: 'ospeli_pharmacy_request_raise',
    summary: `Ask the pharmacy for something, by picks only (nothing typed): the ward, the bed (needed for discharge medicines), the kind (${pickList(KINDS)}), urgent or routine (the ward's own operational call; Ospeli never sets it), the planned discharge for a discharge request (${pickList(PLANNED)}), and how many items, 1 to ${MAX_ITEMS} (a count only, never what they are). One open discharge request per bed; the same picks again within ${DOUBLE_TAP_MINUTES} minutes are refused as already saved. An agent's call becomes a proposal for a person.`,
    kind: 'write', roles: RAISERS, approval: true,
    input: { type: 'object', additionalProperties: false, required: ['wardId', 'kind', 'priority', 'items'], properties: {
      wardId: WARD_IN,
      bedId: { ...ID, description: 'The bed, for example ward-a1-bed-04. Needed for discharge medicines.' },
      kind: { type: 'string', enum: Object.keys(KINDS), description: pickList(KINDS) },
      priority: { type: 'string', enum: Object.keys(PRIORITIES), description: `${pickList(PRIORITIES)}. The ward's call; it is never worked out from clinical content.` },
      planned: { type: 'string', enum: Object.keys(PLANNED), description: `Discharge requests only: when the patient is planned to go home. ${pickList(PLANNED)}.` },
      items: { type: 'integer', minimum: 1, maximum: MAX_ITEMS, description: `How many items, 1 to ${MAX_ITEMS}. A count only.` } } },
    output: WRITE_OUT,
    target: (input) => ({ id: `${input.wardId}:${input.bedId || input.kind}`, word: 'request' }),
    wardOf: (core, input) => input.wardId ?? null,
    async precheck(core, input) { await checkRaise(core, input); },
    async run(core, input, { actor }) {
      let requestId = null;
      const info = await siteInfo(core);
      const recs = await core.appendChecked(async (events) => {
        await checkRaise(core, input, events, info);
        requestId = nextRequestId(events);
        const encounter = await encounterOf(core, info, input.bedId, events);
        const data = { wardId: input.wardId, ...(input.bedId ? { bedId: input.bedId } : {}), ...(encounter ? { encounter } : {}), kind: input.kind, priority: input.priority,
          ...(input.planned ? { planned: input.planned } : {}), items: input.items };
        return [{ type: 'pharmacy.request-raised', subject: requestId, actorRole: actor.role, at: core.now(), data }];
      });
      await core.recordAs(actor, 'pharmacy.request-raised', requestId, { wardId: input.wardId, kind: input.kind, priority: input.priority, items: input.items });
      return { status: 'done', requestId, state: 'raised', stateName: STATE_WORDS.raised, events: recs.map((r) => r.seq) };
    },
    example: { input: { wardId: 'ward-a1', kind: 'ward-request', priority: 'routine', items: 6 } },
  },
  {
    name: 'ospeli_pharmacy_request_step',
    summary: `Move a request on, by the pharmacy: start (Raised to Started), ready (Checked to Ready; refused until a pharmacist has recorded Checked, so no order of taps records Ready without a check), hold with a reason (${pickList(HOLD_REASONS)}; not once ready), resume, cancel with a reason (${pickList(CANCEL_REASONS)}), undo (the last step, Started or Ready, within ${UNDO_MINUTES} minutes: a correction event, history is kept), and front or back (pharmacy manager only: move to the front of the queue, shown as moved by the manager). Send expectedState so a double tap saves nothing. The check itself is ospeli_pharmacy_request_check; collection is ospeli_pharmacy_request_collect. An agent's call becomes a proposal for a person.`,
    kind: 'write', roles: PHARMACY, approval: true,
    input: { type: 'object', additionalProperties: false, required: ['requestId', 'step'], properties: {
      requestId: REQUEST_ID,
      step: { type: 'string', enum: ['start', 'ready', 'hold', 'resume', 'cancel', 'front', 'back', 'undo'], description: 'start, ready, hold (send reason), resume, cancel (send reason), front or back (pharmacy manager), undo.' },
      reason: { type: 'string', enum: [...Object.keys(HOLD_REASONS), ...Object.keys(CANCEL_REASONS)], description: `hold: ${pickList(HOLD_REASONS)}. cancel: ${pickList(CANCEL_REASONS)}.` },
      expectedState: STATE_IN } },
    output: WRITE_OUT,
    target: (input) => ({ id: input.requestId, word: 'request' }),
    wardOf: wardOfRequest,
    async snapshot(core, input) { const r = deriveRequests(await core.events()).get(input.requestId); return r ? { seenState: stateOf(r) } : {}; },
    async precheck(core, input, { actor }) { planStep(await findRequest(core, input.requestId), input, actor, core.now()); },
    async run(core, input, { actor }) {
      let r = null;
      const recs = await core.appendChecked(async (events) => { r = await findRequest(core, input.requestId, events); return planStep(r, input, actor, core.now()); });
      await core.recordAs(actor, recs[0].type, input.requestId, { step: input.step, ...(input.reason ? { reason: input.reason } : {}) });
      const after = deriveRequests(await core.events()).get(input.requestId);
      return { status: 'done', requestId: input.requestId, state: stateOf(after), stateName: STATE_WORDS[stateOf(after)], events: recs.map((x) => x.seq) };
    },
    example: { input: { requestId: 'rx-00001', step: 'start', expectedState: 'raised' }, needs: 'A request that is Raised: ospeli_pharmacy_request_raise makes one, and ospeli_pharmacy_queue_list lists the open ones with their ids and states.' },
  },
  {
    name: 'ospeli_pharmacy_request_check',
    summary: `Record that a pharmacist's check happened, at this time: Started to Checked. ${CHECK_NOTE} It does not say the request is clinically right or safe, and it is not a second, independent check. Pharmacist only. undo: true takes back a Checked tapped by mistake (within ${UNDO_MINUTES} minutes, while it is the last step). An agent's call becomes a proposal for a person.`,
    kind: 'write', roles: CHECKERS, approval: true,
    input: { type: 'object', additionalProperties: false, required: ['requestId'], properties: {
      requestId: REQUEST_ID, expectedState: STATE_IN,
      undo: { type: 'boolean', description: 'true: take back Checked tapped by mistake. Leave out to record the check.' } } },
    output: WRITE_OUT,
    target: (input) => ({ id: input.requestId, word: 'request' }),
    wardOf: wardOfRequest,
    async snapshot(core, input) { const r = deriveRequests(await core.events()).get(input.requestId); return r ? { seenState: stateOf(r) } : {}; },
    async precheck(core, input, { actor }) { planCheck(await findRequest(core, input.requestId), input, actor, core.now()); },
    async run(core, input, { actor }) {
      const recs = await core.appendChecked(async (events) => planCheck(await findRequest(core, input.requestId, events), input, actor, core.now()));
      await core.recordAs(actor, recs[0].type, input.requestId, input.undo ? { step: 'checked', undo: true } : {});
      const after = deriveRequests(await core.events()).get(input.requestId);
      return { status: 'done', requestId: input.requestId, state: stateOf(after), stateName: STATE_WORDS[stateOf(after)], events: recs.map((x) => x.seq) };
    },
    example: { input: { requestId: 'rx-00001', expectedState: 'started' }, needs: 'A request that is Started: ospeli_pharmacy_request_raise and then ospeli_pharmacy_request_step (start) make one; ospeli_pharmacy_queue_list lists them.' },
  },
  {
    name: 'ospeli_pharmacy_request_collect',
    summary: 'Record that a ready request was collected (Ready to Collected): by the pharmacy, or by the ward when its staff collect. Refused before Ready. Send expectedState so a double tap saves nothing. An agent\'s call becomes a proposal for a person.',
    kind: 'write', roles: COLLECTORS, approval: true,
    input: { type: 'object', additionalProperties: false, required: ['requestId'], properties: { requestId: REQUEST_ID, expectedState: STATE_IN } },
    output: WRITE_OUT,
    target: (input) => ({ id: input.requestId, word: 'request' }),
    wardOf: wardOfRequest,
    async snapshot(core, input) { const r = deriveRequests(await core.events()).get(input.requestId); return r ? { seenState: stateOf(r) } : {}; },
    async precheck(core, input, { actor }) { planCollect(await findRequest(core, input.requestId), input, actor, core.now()); },
    async run(core, input, { actor }) {
      const recs = await core.appendChecked(async (events) => planCollect(await findRequest(core, input.requestId, events), input, actor, core.now()));
      await core.recordAs(actor, 'pharmacy.request-collected', input.requestId, {});
      return { status: 'done', requestId: input.requestId, state: 'collected', stateName: STATE_WORDS.collected, events: recs.map((x) => x.seq) };
    },
    example: { input: { requestId: 'rx-00001', expectedState: 'ready' }, needs: 'A request that is Ready: raised, started, checked by a pharmacist and made ready (ospeli_pharmacy_request_raise, ospeli_pharmacy_request_step, ospeli_pharmacy_request_check); ospeli_pharmacy_queue_list lists the ready ones.' },
  },
  {
    name: 'ospeli_pharmacy_guide_set',
    summary: 'Switch the pharmacy guide on or off for this site. The guide is two fixed rules (late discharge requests from a ward; a discharge request for today with no step for too long) that suggest; people decide. With it off the queue, the ward view and the measures work the same. People only (the pharmacy manager).',
    kind: 'write', roles: MANAGER, approval: true, agents: false,
    input: { type: 'object', additionalProperties: false, required: ['on'], properties: { on: { type: 'boolean', description: 'true: show the guide\'s suggestions. false: none.' } } },
    output: { type: 'object', required: ['status', 'on'], properties: { status: WRITE_STATUS, on: { type: 'boolean' }, events: EVENT_SEQS } },
    async precheck(core, input) {
      if (guideOn(await core.events({ type: 'pharmacy.guide-set' })) === input.on) throw new CommandError('conflict', `The guide is already ${input.on ? 'on' : 'off'}.`);
    },
    async run(core, input, { actor }) {
      const recs = await core.appendChecked(async (events) => {
        if (guideOn(events) === input.on) throw new CommandError('conflict', `The guide is already ${input.on ? 'on' : 'off'}.`);
        return [{ type: 'pharmacy.guide-set', subject: 'pharmacy-guide', actorRole: actor.role, at: core.now(), data: { on: input.on } }];
      });
      await core.recordAs(actor, 'pharmacy.guide-set', 'pharmacy-guide', { on: input.on });
      return { status: 'done', on: input.on, events: recs.map((r) => r.seq) };
    },
    example: { input: { on: false } },
  },
];

// Examples that need a request in a given state: made the way people make it on screen.
export async function prepareExample(core, command, { run }) {
  const steps = { ospeli_pharmacy_request_step: 0, ospeli_pharmacy_request_check: 1, ospeli_pharmacy_request_collect: 3 }[command.name];
  if (steps == null) return {};
  const made = await run('ospeli_pharmacy_request_raise', { wardId: 'ward-b2', kind: 'other', priority: 'routine', items: 2 }, 'ward-nurse');
  const requestId = made.requestId;
  if (steps >= 1) await run('ospeli_pharmacy_request_step', { requestId, step: 'start' }, 'pharmacy-technician');
  if (steps >= 2) await run('ospeli_pharmacy_request_check', { requestId }, 'pharmacist');
  if (steps >= 3) await run('ospeli_pharmacy_request_step', { requestId, step: 'ready' }, 'pharmacy-technician');
  return { requestId };
}

// ---- synthetic history: thirty days of dispensing requests on Example General Hospital's wards ----
// Generic patterns only, entirely fictional. Requests peak in the late morning and afternoon, with a
// cluster of discharge requests after the morning rounds and a few late in the day (Ward A3's come
// later than the others, so the guide has something to say). Most reach Ready and are collected,
// with a long tail on collection; some are cancelled (mostly postponed discharges); a few are held,
// mostly waiting for the ward. At the end: a few open at each stage and one on hold.
const SEED_HOURS = {
  discharge: [[8, 0.5], [9, 1.5], [10, 3.5], [11, 5.5], [12, 2], [13, 1.5], [14, 1.5], [15, 1], [16, 0.8], [17, 0.5], [19, 0.3], [20, 0.2]],
  late: [[9, 0.5], [10, 1], [11, 1.5], [12, 2], [13, 3], [14, 3], [15, 2.5], [16, 2], [17, 1], [19, 0.5]],
  'ward-request': [[8, 1], [9, 2], [10, 3], [11, 3], [12, 2], [13, 2], [14, 3], [15, 3], [16, 2], [17, 1]],
  other: [[9, 1], [11, 1], [14, 1], [16, 1]],
};
export function seed({ r, startMs, endMs, entities }) {
  const wards = entities.filter((e) => e.type === 'ward').map((e) => e.id);
  const bedsOf = (w) => entities.filter((e) => e.type === 'bed' && e.parentId === w).map((e) => e.id);
  if (!wards.length) return [];
  const off = entities.find((e) => e.type === 'site' && e.utcOffsetMinutes != null)?.utcOffsetMinutes ?? 0;
  const HOUR = 60 * MIN;
  const planned = (hour) => (hour < 11 ? r.weighted([['this-morning', 1], ['this-afternoon', 3]]) : hour < 16 ? r.weighted([['this-afternoon', 3], ['this-evening', 1]]) : r.weighted([['this-evening', 1], ['tomorrow', 3]]));
  const reqs = [];
  for (let d = localDayStart(startMs, off); d < endMs; d += DAY) {
    for (const w of wards) {
      const beds = bedsOf(w);
      const add = (kind, n) => {
        for (let i = 0; i < n; i++) {
          const hour = r.weighted(SEED_HOURS[kind === 'discharge' && w === 'ward-a3' ? 'late' : kind]);
          const t = d + hour * HOUR + r.int(0, 59) * MIN;
          if (t < startMs || t >= endMs - 2 * HOUR) continue;
          reqs.push({ t, wardId: w, kind, bedId: kind === 'discharge' && beds.length ? r.pick(beds) : null, priority: r.chance(0.1) ? 'urgent' : 'routine',
            planned: kind === 'discharge' ? planned(hour) : null, items: kind === 'discharge' ? r.int(2, 12) : kind === 'ward-request' ? r.int(1, 20) : r.int(1, 5), busy: hour >= 10 && hour <= 15 });
        }
      };
      if (!beds.length) continue;
      add('discharge', r.int(2, 4));
      add('ward-request', r.int(1, 3));
      if (r.chance(0.3)) add('other', 1);
    }
  }
  reqs.sort((a, b) => a.t - b.t);
  const out = [];
  const openBeds = new Map(); // bed -> time its discharge request closes, so one bed has one open request
  let n = 0;
  const push = (t, type, subject, actorRole, data = {}) => { if (t < endMs) out.push({ t, type, subject, actorRole, data }); };
  const lifecycle = (q, subject, plan) => {
    push(q.t, 'pharmacy.request-raised', subject, q.raisedBy, { wardId: q.wardId, ...(q.bedId ? { bedId: q.bedId } : {}), kind: q.kind, priority: q.priority, ...(q.planned ? { planned: q.planned } : {}), items: q.items });
    let t = q.t;
    for (const [type, at, role, data] of plan) { t = at; push(t, type, subject, role, data); }
    return t;
  };
  for (const q of reqs) {
    if (q.bedId && (openBeds.get(q.bedId) ?? 0) > q.t) continue;
    const subject = `rx-${String(++n).padStart(5, '0')}`;
    q.raisedBy = q.kind === 'discharge' ? r.weighted([['ward-nurse', 6], ['bed-manager', 1]]) : r.weighted([['ward-nurse', 5], ['pharmacy-technician', 1]]);
    const slow = q.busy ? 1.4 : 1;
    const plan = [];
    let t = q.t + r.lognormal(22 * slow * (q.priority === 'urgent' ? 0.4 : 1), 0.6) * MIN;
    plan.push(['pharmacy.request-started', t, r.chance(0.8) ? 'pharmacy-technician' : 'pharmacist', {}]);
    if (r.chance(0.08)) { // held while being dispensed, mostly waiting for the ward
      t += r.int(3, 10) * MIN;
      plan.push(['pharmacy.request-on-hold', t, 'pharmacy-technician', { reason: r.weighted([['waiting-for-ward', 7], ['not-in-stock', 2], ['waiting-for-supply', 1]]) }]);
      t += r.lognormal(40, 0.6) * MIN;
      plan.push(['pharmacy.request-resumed', t, 'pharmacy-technician', {}]);
    }
    const cancel = q.kind === 'discharge' && r.chance(0.07) ? 'discharge-postponed' : r.chance(0.02) ? r.pick(['no-longer-needed', 'duplicate', 'raised-in-error']) : null;
    if (cancel) {
      plan.push(['pharmacy.request-cancelled', t + r.int(5, 60) * MIN, r.chance(0.5) ? 'ward-nurse' : 'pharmacy-technician', { reason: cancel }]);
    } else {
      t += r.lognormal(18 * slow, 0.5) * MIN;
      plan.push(['pharmacy.request-checked', t, 'pharmacist', {}]);
      t += r.lognormal(9, 0.5) * MIN;
      plan.push(['pharmacy.request-ready', t, 'pharmacy-technician', {}]);
      t += r.lognormal(40, 0.9) * MIN;
      plan.push(['pharmacy.request-collected', t, r.chance(0.6) ? 'ward-nurse' : 'pharmacy-technician', {}]);
    }
    const end = lifecycle(q, subject, plan);
    if (q.bedId) openBeds.set(q.bedId, end);
  }
  // The end of the history, so a device opened now has work at each stage (site time does not matter here).
  const has = (w) => wards.includes(w);
  const tail = [
    { ago: 52, wardId: 'ward-a2', kind: 'discharge', priority: 'routine', planned: 'this-afternoon', items: 5, steps: [] },
    { ago: 44, wardId: 'ward-b1', kind: 'discharge', priority: 'routine', planned: 'this-evening', items: 3, steps: [['started', 30, 'pharmacy-technician'], ['checked', 8, 'pharmacist']] },
    { ago: 38, wardId: 'ward-a1', kind: 'ward-request', priority: 'urgent', items: 4, steps: [] },
    { ago: 70, wardId: 'ward-b2', kind: 'discharge', priority: 'routine', planned: 'this-afternoon', items: 7, steps: [['started', 55, 'pharmacy-technician'], ['on-hold', 35, 'pharmacy-technician', { reason: 'waiting-for-ward' }]] },
    { ago: 30, wardId: 'ward-a3', kind: 'discharge', priority: 'routine', planned: 'this-evening', items: 6, steps: [['started', 20, 'pharmacist']] },
    { ago: 95, wardId: 'ward-c1', kind: 'discharge', priority: 'routine', planned: 'this-afternoon', items: 2, steps: [['started', 80, 'pharmacy-technician'], ['checked', 65, 'pharmacist'], ['ready', 60, 'pharmacy-technician']] },
  ].filter((x) => has(x.wardId));
  const usedTail = new Set();
  for (const x of tail) {
    const beds = bedsOf(x.wardId).filter((b) => (openBeds.get(b) ?? 0) <= endMs - x.ago * MIN && !usedTail.has(b));
    if (x.kind === 'discharge' && !beds.length) continue;
    const bedId = x.kind === 'discharge' ? beds[beds.length - 1] : null;
    if (bedId) usedTail.add(bedId);
    const subject = `rx-${String(++n).padStart(5, '0')}`;
    const q = { ...x, t: endMs - x.ago * MIN, bedId, raisedBy: 'ward-nurse' };
    lifecycle(q, subject, x.steps.map(([s, ago, role, data]) => [`pharmacy.request-${s}`, endMs - ago * MIN, role, data || {}]));
  }
  return out.filter((e) => e.t >= startMs && e.t < endMs).sort((a, b) => a.t - b.t);
}
