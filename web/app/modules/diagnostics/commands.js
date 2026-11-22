// Diagnostics (area A5): the module's pack (see core/modules.js for the contract).
// Plain data and pure functions; no screen code, so the same file runs in the browser, in tests
// and on a site's own server.
//
// Slice 1, the laboratory path: a request is recorded and its specimen marked collected on the
// ward; the lab marks it received at the hatch, or rejected with a picked reason; a scientist
// records the time the result was released (the time only, never a value). Analysers and scanners
// are marked down and back, with the open work order shown read-only. Imaging lists and scan slots
// are slice 2 (planned, not built yet).
//
// Operations only: no result value, no reference range, no choice of test and no clinical
// priority (urgency is the requester's pick, recorded). A code on a screen is not patient
// identification: labels are checked by the lab's own procedure, outside Ospeli. Measures requests
// and steps, never a scientist, radiographer or clerk. Nothing here calls a model. Every event
// records the role, never a person.

import {
  CommandError, ALL_ROLES, ID, TIME, SYNTHETIC, LIMIT, TOTAL, TRUNCATED, FORMAT, page, WRITE_STATUS, PROPOSAL_OUT, EVENT_SEQS, isSynthetic, MIN, HOUR, DAY,
} from '../../core/kit.js';
import { currentWords } from '../../core/model.js';
import { deriveWorkOrders, WO_STATES } from '../../core/workorders.js';
import { deriveBoard } from '../../core/beds.js';
import {
  TEST_GROUPS, URGENCIES, URGENCY_LABEL, REJECT_REASONS, REJECT_HEADING, CANCEL_REASONS, UNDO_REASONS, AGO_MINUTES, LATE_ENTRY_MINUTES, NOT_ARRIVED_MINUTES,
  REVIEW_COUNT, REVIEW_DAYS, MIN_AREA, UNDO_MINUTES, AGAIN_MINUTES, SCHEDULED_HOURS_PER_DAY, EXPECTED_HOURS, STAGES, RELEASED_DEFINITION, EQUIPMENT_KINDS, EQUIPMENT_STATES,
  REQUEST_ID, REQUIRED_STEPS, GUIDE_RULES, isEquipment, nextRequestId, codeParts, codeLabel, deriveRequests, isOpen, noCollection, enteredLate, minutesInStep,
  minutesSinceCollection, deriveEquipment, groupsOff, guideOn, labTurnaround, rejectionRate, equipmentAvailability, completeness, missingSteps,
  ruleNotArrived, ruleEquipmentDown, ruleRejectionReview, localStartOfDay, clockText, localHour, whenText, OWN_ROW_GROUPS,
} from './logic.js';

export const id = 'diagnostics';
export const PREFIX = 'ospeli_diagnostics_';
export const EVENT_PREFIX = 'diagnostics.';

const REQUESTERS = ['unit-clerk', 'ward-nurse', 'ae-nic', 'lab-reception'];
const COLLECTORS = ['unit-clerk', 'ward-nurse', 'ae-nic'];
const LAB = ['lab-reception', 'lab-scientist'];
const EQUIPMENT_ROLES = ['lab-scientist', 'radiographer', 'diagnostics-manager'];
const MANAGER = ['diagnostics-manager'];

const NO_TARGET = 'No target set: track the trend. A target, if a site sets one, is an example setting, not a standard.';
export const KPIS = [
  { id: 'lab-turnaround', name: 'Laboratory turnaround time', unit: 'minutes',
    definition: 'Minutes between "Received at lab" and "Result released", for requests whose result was released in the period, shown for each test group with urgent and routine apart (urgency as set by the requester): the median, and the time 9 in 10 were released within (90th percentile, nearest rank), each with how many results. Received is the tap at the lab hatch; released is the time the lab released the result. There is no headline figure: one figure over every test group and urgency moves when the mix of tests changes, not when the service does. Where one is shown, it is labelled as all test groups and urgencies together, leaves out blood culture, and is not comparable between weeks. Blood culture is reported over days (a first report, then a final one): its row is the time of the first release recorded, never part of a figure across test groups.',
    counts: 'Requests with a result released in the period that were received at the lab first.',
    outOf: 'None (a median and a percentile, each shown with n).',
    leavesOut: 'Rejected and cancelled requests (they never reach "Result released"); requests not released yet; releases undone. Blood culture from any figure across test groups. Data completeness and the count of requests received with no collection time are shown beside it.',
    source: 'local definition (start and end points as set out in Hawkins RC. Laboratory turnaround time. Clin Biochem Rev 2007;28(4):179-94, PMID 18392122; its suggested goal is not adopted)', target: null, targetText: NO_TARGET },
  { id: 'specimen-rejection-rate', name: 'Specimen rejection rate', unit: '%',
    definition: 'Specimens rejected, divided by specimens that reached the lab (received plus rejected) in the period, by reason and by source area. A specimen rejected after it was received (for example found by a scientist) counts as rejected, not received. A recollection is a new specimen and counts once on its own.',
    counts: 'Specimens rejected in the period, at the hatch or after receipt.',
    outOf: 'Specimens that reached the lab in the period: received plus rejected.',
    leavesOut: `Specimens still on the way, cancelled requests. An area with fewer than ${MIN_AREA} specimens shows counts, not a percentage (small-number rule, an example setting).`,
    source: 'local definition (in line with the pre-analytical quality indicators of the IFCC working group: Plebani M et al. Clin Chem Lab Med 2015;53(6):943-8, PMID 25719322; Sciacovelli L et al. Clin Chem Lab Med 2017;55(10):1478-88, PMID 28688224; no threshold from them is quoted, and the lab sets its own)', target: null, targetText: NO_TARGET },
  { id: 'equipment-availability', name: 'Equipment availability', unit: '%',
    definition: `Hours in service divided by scheduled hours in the period, for each analyser and scanner; downtime is shown as its inverse (hours down divided by scheduled hours). Scheduled hours are ${SCHEDULED_HOURS_PER_DAY} a day, every day: an example setting, not a standard; a site sets its own. "Partly down" (some test groups off) counts as in service and its hours are shown apart.`,
    counts: 'Scheduled hours in the period with the analyser or scanner not marked down.',
    outOf: 'Scheduled hours in the period.',
    leavesOut: 'Time an analyser was down that nobody marked in Ospeli.',
    source: 'local definition (shared availability measure, KPI dictionary D-12; it moves to the shared asset in-service and out-of-service events when the core has them)', target: null, targetText: NO_TARGET },
];
const PLANNED = [
  { id: 'request-to-report', name: 'Request to report (imaging)', status: 'planned', note: 'Planned, not built yet: it needs the imaging list (slice 2).' },
  { id: 'reporting-backlog', name: 'Reporting backlog', status: 'planned', note: 'Planned, not built yet: it needs the imaging list (slice 2).' },
];
export const IMAGING_PLANNED = 'Imaging list and scan slots: planned, not built yet.';
export const FAULT_NOTE = 'To report a fault, ask a facilities technician or the operations manager.';
export const NOT_FOR = 'Operations only. Ospeli does not interpret results, hold result values or reference ranges, choose tests or set clinical priority: urgency is the requester\'s pick, recorded. A code on screen is not patient identification; labels are checked by the lab\'s own procedure. No patient names. Measures requests and steps, never a scientist, radiographer or clerk.';
const WARD_FILTER_NOTE = 'The ward you pick is a filter on this device, not access control: anyone with this role can open any ward\'s list.';
const OFFLINE = 'No connection: note the time on the request form and enter it when back in signal.';

// ---- the site, read once per call ----
const GONE = 'a place no longer on this site';
async function siteInfo(core) {
  const all = await core.listEntities();
  const byId = new Map(all.map((e) => [e.id, e]));
  const offsetMinutes = all.find((e) => e.type === 'site' && e.utcOffsetMinutes != null)?.utcOffsetMinutes ?? 0;
  const equipment = all.filter(isEquipment).map((a) => ({ id: a.id, name: currentWords(a.name), kind: a.kind, parentId: a.parentId }));
  const labPlaces = new Set(equipment.map((a) => a.parentId));
  const wards = all.filter((e) => e.type === 'ward');
  const parentsOfWards = new Set(wards.map((w) => w.parentId));
  // Where a request comes from: a ward, or a department with no ward of its own that is not a
  // diagnostic department (the emergency department, outpatients).
  const sources = [...wards, ...all.filter((e) => e.type === 'department' && !parentsOfWards.has(e.id) && !labPlaces.has(e.id))]
    .map((e) => ({ id: e.id, name: currentWords(e.name), type: e.type }));
  const sourceIds = new Set(sources.map((s) => s.id));
  // An id that is not on this site is never answered as its own name (#138).
  const nameOf = (x) => { const e = byId.get(x); return e ? currentWords(e.name) : GONE; };
  const isWard = (x) => byId.get(x)?.type === 'ward';
  return { byId, offsetMinutes, equipment, sources, sourceIds, nameOf, isWard, beds: all.filter((e) => e.type === 'bed') };
}
const OWN = ['diagnostics.request-made', 'diagnostics.specimen-collected', 'diagnostics.collection-undone', 'diagnostics.specimen-received', 'diagnostics.specimen-rejected', 'diagnostics.specimen-undone',
  'diagnostics.result-validated', 'diagnostics.request-cancelled', 'diagnostics.equipment-down', 'diagnostics.equipment-up', 'diagnostics.guide-set'];
const WO_TYPES = ['asset.fault-reported', 'workorder.assigned', 'workorder.started', 'workorder.completed'];
const own = (core) => core.events({ type: OWN });
const backupText = (kind, b) => EQUIPMENT_KINDS[kind]?.backups[b] || 'No backup route';
// What an agent may be told about: a request from a ward it may see. A department cannot be given
// to an agent yet, so an agent is never told about a department's requests.
const visibleTo = (wards) => (r) => !wards || wards.has(r.sourceId);

function requestOut(r, info, now, { notArrived = new Set(), short = false } = {}) {
  const p = codeParts(r);
  const off = info.offsetMinutes;
  const base = { id: r.id, code: codeLabel(r), codeLead: p.lead, codeDigits: p.digits, sourceId: r.sourceId, sourceName: info.nameOf(r.sourceId),
    testGroup: r.testGroup, testGroupName: TEST_GROUPS[r.testGroup], urgency: r.urgency, urgencyName: URGENCIES[r.urgency], state: r.state, stage: STAGES[r.state],
    minutesInStep: isOpen(r) ? minutesInStep(r, now) : null, stepAt: whenText(r.lastStepAt, info.offsetMinutes, now), minutesSinceCollection: r.state === 'collected' ? minutesSinceCollection(r, now) : null, notArrived: notArrived.has(r.id) };
  if (short) return base;
  const since = Date.parse(r.lastStepAt);
  return { ...base, encounter: r.encounter, madeAt: r.madeAt, collectedAt: r.collectedAt, collectedRecordedAt: r.collectedRecordedAt, enteredLate: enteredLate(r),
    receivedAt: r.receivedAt, rejectedAt: r.rejectedAt, rejectReason: r.rejectReason, rejectReasonName: r.rejectReason ? REJECT_REASONS[r.rejectReason] : null, rejectedAfterReceipt: r.rejectedAfterReceipt,
    releasedAt: r.releasedAt, cancelledAt: r.cancelledAt, cancelReason: r.cancelReason, cancelReasonName: r.cancelReason ? CANCEL_REASONS[r.cancelReason] : null,
    noCollectionTime: noCollection(r), recollectionOf: r.recollectionOf, recollectedBy: r.recollectedBy, corrections: r.undone,
    mayUndo: (r.state === 'received' || r.state === 'rejected' || r.state === 'released') && !r.recollectedBy && Date.parse(now) - since < UNDO_MINUTES * MIN,
    clocks: { made: whenText(r.madeAt, off, now), collected: whenText(r.collectedAt, off, now), received: whenText(r.receivedAt, off, now), rejected: whenText(r.rejectedAt, off, now), released: whenText(r.releasedAt, off, now), cancelled: whenText(r.cancelledAt, off, now) },
    mayUndoCollect: r.state === 'collected' && Date.parse(now) - Date.parse(r.collectedRecordedAt || r.collectedAt) < UNDO_MINUTES * MIN,
    roles: { made: r.madeByRole, collected: r.collectedByRole, received: r.receivedByRole, rejected: r.rejectedByRole, released: r.releasedByRole } };
}

// ---- checks shared by a person's call (inside run) and an agent's proposal (precheck) ----
const notFound = () => new CommandError('not-found', 'No request with that id. ospeli_diagnostics_requests_list lists the requests with their ids (for example dx-00012).');
function findReq(reqs, requestId) { const r = reqs.get(requestId); if (!r) throw notFound(); return r; }
const agentOnDepartment = (actor, info, sourceId) => {
  if (actor?.type === 'agent' && !info.isWard(sourceId)) {
    throw new CommandError('forbidden', 'An agent may act only on a request from a ward that a person switched on for it. Requests from a department are for people to record.');
  }
};
const stateWord = (r, off) => {
  if (r.state === 'received') return `It was received at the lab at ${clockText(r.receivedAt, off)}.`;
  if (r.state === 'rejected') return `It was rejected at ${clockText(r.rejectedAt, off)} (${REJECT_REASONS[r.rejectReason]}). A rejected request is final: record a new request as a recollection.`;
  if (r.state === 'released') return `Its result was released at ${clockText(r.releasedAt, off)}.`;
  if (r.state === 'cancelled') return `It was cancelled at ${clockText(r.cancelledAt, off)}.`;
  if (r.state === 'collected') return `It was collected at ${clockText(r.collectedAt, off)} and is on its way.`;
  return 'It has not been collected yet.';
};

async function checkRequest(core, input, actor, events, info) {
  const i = info ?? await siteInfo(core);
  if (!i.sourceIds.has(input.sourceId)) throw new CommandError('not-found', `sourceId must be a ward or a department that sends requests, for example ${i.sources.slice(0, 3).map((s) => s.id).join(', ')}. ospeli_diagnostics_requests_list gives the list under picks.sources.`);
  agentOnDepartment(actor, i, input.sourceId);
  if (input.encounter) {
    const seen = (await core.events({ subject: input.encounter })).some((e) => /^(patient|ae)\./.test(e.type) || e.type === 'bed.requested');
    if (!seen) throw new CommandError('not-found', 'No patient with that encounter id on this site. Leave encounter out, or pick a patient from picks.patients of ospeli_diagnostics_requests_list with sourceId set to the ward.');
  }
  const evs = events ?? await own(core);
  const reqs = deriveRequests(evs);
  if (input.recollectionOf) {
    const first = reqs.get(input.recollectionOf);
    if (!first) throw new CommandError('not-found', 'recollectionOf must be a rejected request on this site. ospeli_diagnostics_requests_list with stage "rejected" lists them.');
    if (first.state !== 'rejected') throw new CommandError('conflict', `${first.id} is not rejected, so it cannot be collected again as a recollection. ${stateWord(first, i.offsetMinutes)}`);
    if (first.recollectedBy) throw new CommandError('conflict', `${first.id} already has a recollection: ${first.recollectedBy}.`, { existing: first.recollectedBy });
    if (first.testGroup !== input.testGroup) throw new CommandError('invalid-input', `A recollection is for the same test group as the rejected request: ${first.testGroup}.`);
  }
  if (!input.again) {
    const now = Date.parse(core.now());
    const twin = [...reqs.values()].find((r) => r.sourceId === input.sourceId && r.testGroup === input.testGroup && r.urgency === input.urgency && r.encounter === (input.encounter ?? null)
      && (r.recollectionOf ?? null) === (input.recollectionOf ?? null) && Math.abs(now - Date.parse(r.madeAt)) < AGAIN_MINUTES * MIN);
    if (twin) throw new CommandError('conflict', `Already saved: ${twin.id} with the same picks was recorded under ${AGAIN_MINUTES} minutes ago. Nothing new was saved. Send again: true if this is a second request.`, { existing: twin.id, already: true });
  }
}
async function checkCollect(core, input, actor, events, info) {
  const i = info ?? await siteInfo(core);
  const r = findReq(deriveRequests(events ?? await own(core)), input.requestId);
  agentOnDepartment(actor, i, r.sourceId);
  if (r.state !== 'requested') throw new CommandError('conflict', `${r.id} cannot be marked collected now. ${stateWord(r, i.offsetMinutes)}`, { state: r.state, already: r.state === 'collected' });
  return r;
}
async function checkReceive(core, input, actor, events, info) {
  const i = info ?? await siteInfo(core);
  const r = findReq(deriveRequests(events ?? await own(core)), input.requestId);
  agentOnDepartment(actor, i, r.sourceId);
  if (input.outcome === 'received') {
    if (input.reason != null) throw new CommandError('invalid-input', 'A receipt takes no reason. reason is for outcome "rejected".');
    if (r.state === 'received') throw new CommandError('conflict', `Already saved: ${stateWord(r, i.offsetMinutes)}`, { state: r.state, already: true });
    if (r.state !== 'requested' && r.state !== 'collected') throw new CommandError('conflict', `${r.id} cannot be received now. ${stateWord(r, i.offsetMinutes)}`, { state: r.state });
  } else {
    if (!input.reason) throw new CommandError('invalid-input', `A rejection needs reason, picked by your lab's acceptance criteria: ${Object.keys(REJECT_REASONS).join(', ')}.`);
    if (r.state === 'received') {
      if (actor.role !== 'lab-scientist') throw new CommandError('forbidden', `${r.id} was received at ${clockText(r.receivedAt, i.offsetMinutes)}. A specimen already received is rejected by: lab-scientist.`, { roles: ['lab-scientist'] });
    } else if (r.state === 'rejected') throw new CommandError('conflict', `Already saved: ${stateWord(r, i.offsetMinutes)}`, { state: r.state, already: true });
    else if (r.state !== 'requested' && r.state !== 'collected') throw new CommandError('conflict', `${r.id} cannot be rejected now. ${stateWord(r, i.offsetMinutes)}`, { state: r.state });
  }
  return r;
}
async function checkUndo(core, input, actor, events, info) {
  const i = info ?? await siteInfo(core);
  const r = findReq(deriveRequests(events ?? await own(core)), input.requestId);
  if (r.state !== 'received' && r.state !== 'rejected' && r.state !== 'released') throw new CommandError('conflict', `There is no receipt, rejection or release to undo. ${stateWord(r, i.offsetMinutes)}`, { state: r.state });
  if (r.state === 'released' && actor.role !== 'lab-scientist') throw new CommandError('forbidden', 'A result release is undone by: lab-scientist.', { roles: ['lab-scientist'] });
  if (r.recollectedBy) throw new CommandError('conflict', `${r.id} already has a recollection (${r.recollectedBy}), so its rejection stays.`, { existing: r.recollectedBy });
  if (Date.parse(core.now()) - Date.parse(r.lastStepAt) >= UNDO_MINUTES * MIN) throw new CommandError('conflict', `A receipt, rejection or release can be undone for ${UNDO_MINUTES} minutes only (an example setting). Ask the diagnostics manager to look at it.`);
  return r;
}
const COLLECT_UNDO_REASONS = { 'wrong-request': 'Marked on the wrong request', 'not-taken': 'Specimen not taken yet' };
async function checkCollectUndo(core, input, events, info) {
  const i = info ?? await siteInfo(core);
  const r = findReq(deriveRequests(events ?? await own(core)), input.requestId);
  if (r.state !== 'collected') throw new CommandError('conflict', `There is no collection to undo. ${stateWord(r, i.offsetMinutes)}`, { state: r.state });
  if (Date.parse(core.now()) - Date.parse(r.collectedRecordedAt || r.collectedAt) >= UNDO_MINUTES * MIN) throw new CommandError('conflict', `A collection can be undone for ${UNDO_MINUTES} minutes after it was recorded (an example setting). Cancel the request instead if it is not needed.`);
  return r;
}
async function checkResult(core, input, actor, events, info) {
  const i = info ?? await siteInfo(core);
  const r = findReq(deriveRequests(events ?? await own(core)), input.requestId);
  agentOnDepartment(actor, i, r.sourceId);
  if (r.state === 'released') throw new CommandError('conflict', `Already saved: ${stateWord(r, i.offsetMinutes)}`, { state: r.state, already: true });
  if (r.state !== 'received') throw new CommandError('conflict', `A result is released only for a specimen received at the lab. ${stateWord(r, i.offsetMinutes)}`, { state: r.state });
  return r;
}
async function checkCancel(core, input, actor, events, info) {
  const i = info ?? await siteInfo(core);
  const r = findReq(deriveRequests(events ?? await own(core)), input.requestId);
  agentOnDepartment(actor, i, r.sourceId);
  if (r.state === 'cancelled') throw new CommandError('conflict', `Already saved: ${stateWord(r, i.offsetMinutes)}`, { state: r.state, already: true });
  if (r.state !== 'requested' && r.state !== 'collected') throw new CommandError('conflict', `${r.id} cannot be cancelled now. ${stateWord(r, i.offsetMinutes)}`, { state: r.state });
  return r;
}
async function checkEquipment(core, input, actor, events, info) {
  const i = info ?? await siteInfo(core);
  const a = i.equipment.find((x) => x.id === input.assetId);
  if (!a) throw new CommandError('not-found', `assetId must be one of this site's analysers or scanners: ${i.equipment.map((x) => x.id).join(', ') || 'none on this site'}.`, { assets: i.equipment.map((x) => x.id) });
  const k = EQUIPMENT_KINDS[a.kind];
  if (!k.roles.includes(actor.role)) throw new CommandError('forbidden', `${a.name} is marked down and back by: ${k.roles.join(', ')}.`, { roles: k.roles });
  const x = deriveEquipment(events ?? await own(core)).get(a.id);
  const now = x?.state || 'up';
  if (input.state === 'up') {
    for (const f of ['reason', 'testGroups', 'workOrderId', 'expectedBackHours', 'backup']) if (input[f] != null) throw new CommandError('invalid-input', `Marking it back takes assetId and state only, not ${f}.`);
    if (now === 'up') throw new CommandError('conflict', `Already saved: ${a.name} is marked working.`, { already: true });
    return { a, k, x };
  }
  if (now !== 'up') throw new CommandError('conflict', `${a.name} is already marked ${EQUIPMENT_STATES[now].toLowerCase()} since ${clockText(x.since, i.offsetMinutes)}. Mark it back first, then mark it again.`, { state: now });
  if (!input.reason || !k.reasons[input.reason]) throw new CommandError('invalid-input', `reason must be one of: ${Object.entries(k.reasons).map(([v, w]) => `${v} (${w})`).join(', ')}.`);
  if (!input.backup || !k.backups[input.backup]) throw new CommandError('invalid-input', `backup must be one of: ${Object.entries(k.backups).map(([v, w]) => `${v} (${w})`).join(', ')}.`);
  if (input.state === 'partly-down') {
    if (k.runs.length) {
      const g = input.testGroups || [];
      if (!g.length || g.some((x2) => !k.runs.includes(x2)) || g.length >= k.runs.length) throw new CommandError('invalid-input', `Partly down needs testGroups: some, not all, of what ${a.name} runs (${k.runs.join(', ')}). For all of them, send state "down".`);
    } else if (input.testGroups?.length) throw new CommandError('invalid-input', `${a.name} has no test groups: send partly-down without testGroups.`);
  } else if (input.testGroups?.length) throw new CommandError('invalid-input', 'testGroups is for state "partly-down" only.');
  if (input.workOrderId) {
    const wo = deriveWorkOrders(await core.events({ type: WO_TYPES }), core.now()).get(input.workOrderId);
    if (!wo || wo.assetId !== a.id || wo.state === 'completed') throw new CommandError('not-found', `workOrderId must be an open work order for ${a.name}. ospeli_diagnostics_equipment_list lists them under openWorkOrders.`);
  }
  return { a, k, x };
}

// ---- reads ----
const TODAY_WORD = 'today (since 00:00 site time)';
function patientsOn(info, events, wardId) {
  if (!info.isWard(wardId)) return [];
  const beds = info.beds.filter((b) => b.parentId === wardId);
  const board = deriveBoard(beds, events);
  return [...board.beds.values()].filter((b) => b.encounter && b.state !== 'allocated' && b.state !== 'available')
    .map((b) => ({ encounter: b.encounter, label: `Patient ${String(b.encounter).replace(/^enc-0*/, '')}`, bed: info.nameOf(b.id) }))
    .sort((a, b) => (a.bed < b.bed ? -1 : 1));
}
const STAGE_RANK = { requested: 0, collected: 1, received: 2, rejected: 3, released: 4, cancelled: 5 };
async function requestsList(core, input, wards) {
  const now = core.now();
  const BED_TYPES = ['bed.allocated', 'bed.allocation-cancelled', 'patient.admitted', 'patient.discharged', 'patient.expected-discharge', 'patient.expected-discharge-cancelled', 'bed.vacated', 'bed.clean-started', 'bed.clean-stopped', 'bed.cleaned', 'bed.out-of-service', 'bed.back-in-service', 'bed.requested', 'ae.decision-to-admit'];
  const withBeds = !!(input.sourceId && input.format !== 'short' && (!wards || wards.has(input.sourceId)));
  const [events, info] = await Promise.all([core.events({ type: withBeds ? [...OWN, ...BED_TYPES] : OWN }), siteInfo(core)]);
  const reqs = deriveRequests(events);
  const hours = input.hours ?? 24;
  const since = new Date(Date.parse(now) - hours * HOUR).toISOString();
  const stage = input.stage || 'current';
  if (input.sourceId && !info.sourceIds.has(input.sourceId)) throw new CommandError('not-found', `sourceId must be a ward or a department that sends requests, for example ${info.sources.slice(0, 3).map((s) => s.id).join(', ')}. picks.sources lists them.`);
  let list = [...reqs.values()].filter(visibleTo(wards)).filter((r) => !input.sourceId || r.sourceId === input.sourceId);
  if (stage === 'current') list = list.filter((r) => isOpen(r) || r.lastStepAt >= since);
  else if (stage !== 'all') list = list.filter((r) => r.state === stage && (isOpen(r) || r.lastStepAt >= since));
  if (input.find) list = list.filter((r) => codeParts(r).digits === String(Number(input.find)));
  list.sort((a, b) => (isOpen(b) - isOpen(a)) || (isOpen(a) ? STAGE_RANK[a.state] - STAGE_RANK[b.state] || (a.lastStepAt < b.lastStepAt ? -1 : 1) : (a.lastStepAt < b.lastStepAt ? 1 : -1)));
  const on = guideOn(events);
  const notArrived = new Set(on ? ruleNotArrived(reqs, { now }).map((s) => s.requestId) : []);
  const cut = page(list, input.limit, 50);
  const short = input.format === 'short';
  const counts = {};
  for (const r of list) counts[r.state] = (counts[r.state] || 0) + 1;
  const patients = withBeds ? patientsOn(info, events, input.sourceId) : [];
  return {
    asOf: now, synthetic: await isSynthetic(core), sourceId: input.sourceId ?? null, sourceName: input.sourceId ? info.nameOf(input.sourceId) : null, hours,
    requests: cut.items.map((r) => requestOut(r, info, now, { notArrived, short })), total: cut.total, truncated: cut.truncated, counts,
    ...(short ? {} : { picks: { sources: info.sources.filter((s) => !wards || wards.has(s.id)), testGroups: { ...TEST_GROUPS }, urgencies: { ...URGENCIES }, urgencyLabel: URGENCY_LABEL,
      cancelReasons: { ...CANCEL_REASONS }, collectedAgo: [...AGO_MINUTES], lateEntryMinutes: LATE_ENTRY_MINUTES, stages: { ...STAGES }, patients },
    releasedDefinition: RELEASED_DEFINITION, filterNote: WARD_FILTER_NOTE, offlineNote: OFFLINE }),
    note: NOT_FOR,
  };
}
// The order at the hatch: blocks by source area (one bag goes with one block), the block with the
// most urgent and oldest specimen first; inside a block urgent first, then oldest first. Urgency is
// the requester's pick; Ospeli never re-ranks by test or clinical content.
function hatchBlocks(list, info, now, notArrived) {
  const key = (r) => [r.urgency === 'urgent' ? 0 : 1, r.collectedAt || r.madeAt];
  const cmp = (a, b) => { const x = key(a); const y = key(b); return x[0] - y[0] || (x[1] < y[1] ? -1 : x[1] > y[1] ? 1 : 0) || (a.id < b.id ? -1 : 1); };
  const by = new Map();
  for (const r of list) by.set(r.sourceId, [...(by.get(r.sourceId) || []), r]);
  return [...by].map(([sourceId, rs]) => ({ sourceId, sourceName: info.nameOf(sourceId), items: rs.sort(cmp) }))
    .sort((a, b) => cmp(a.items[0], b.items[0]))
    .map((b) => ({ sourceId: b.sourceId, sourceName: b.sourceName, count: b.items.length, items: b.items.map((r) => requestOut(r, info, now, { notArrived })) }));
}
async function specimenLog(core, input, wards) {
  const now = core.now();
  const [events, info] = await Promise.all([own(core), siteInfo(core)]);
  const reqs = deriveRequests(events);
  const all = [...reqs.values()].filter(visibleTo(wards));
  const on = guideOn(events);
  const na = on ? ruleNotArrived(reqs, { now, nameOf: info.nameOf }).filter((s) => !wards || wards.has(s.sourceId)) : [];
  const notArrived = new Set(na.map((s) => s.requestId));
  const today = localStartOfDay(now, info.offsetMinutes);
  const dayAgo = new Date(Date.parse(now) - DAY).toISOString();
  const onTheWay = all.filter((r) => r.state === 'collected');
  const lim = input.limit ?? 100;
  const blocks = hatchBlocks(onTheWay.filter((r) => !notArrived.has(r.id)).slice(), info, now, notArrived);
  const reachedToday = all.filter((r) => { const at = r.state === 'rejected' ? r.rejectedAt : r.receivedAt; return at && at >= today; });
  const recent = all.filter((r) => (r.state === 'received' || r.state === 'rejected') && Date.parse(now) - Date.parse(r.lastStepAt) < UNDO_MINUTES * MIN && !r.recollectedBy)
    .sort((a, b) => (a.lastStepAt < b.lastStepAt ? 1 : -1)).slice(0, 5);
  const waiting = all.filter((r) => r.state === 'received').sort((a, b) => (a.receivedAt < b.receivedAt ? -1 : 1));
  const notCollected = all.filter((r) => r.state === 'requested' && r.madeAt >= dayAgo);
  const short = input.format === 'short';
  const byHour = Array.from({ length: 24 }, (_, h) => ({ hour: h, received: 0, rejected: 0 }));
  const bySource = new Map();
  for (const r of reachedToday) {
    const at = r.state === 'rejected' ? r.rejectedAt : r.receivedAt;
    byHour[localHour(at, info.offsetMinutes)][r.state === 'rejected' ? 'rejected' : 'received'] += 1;
    const s = bySource.get(r.sourceId) || { sourceId: r.sourceId, sourceName: info.nameOf(r.sourceId), received: 0, rejected: 0 };
    s[r.state === 'rejected' ? 'rejected' : 'received'] += 1;
    bySource.set(r.sourceId, s);
  }
  const cutWait = page(waiting, input.limit, 30);
  const out = (r) => requestOut(r, info, now, { notArrived });
  return {
    asOf: now, synthetic: await isSynthetic(core), today: { since: today, word: TODAY_WORD },
    counts: { onTheWay: onTheWay.length, notArrived: notArrived.size, notCollected: notCollected.length, waitingResult: waiting.length,
      receivedToday: reachedToday.filter((r) => r.state !== 'rejected').length, rejectedToday: reachedToday.filter((r) => r.state === 'rejected').length,
      noCollectionToday: reachedToday.filter(noCollection).length },
    notArrived: onTheWay.filter((r) => notArrived.has(r.id)).sort((a, b) => (a.collectedAt < b.collectedAt ? -1 : 1)).map(out),
    onTheWay: blocks.map((b) => ({ ...b, items: b.items.slice(0, lim) })),
    total: onTheWay.length, truncated: blocks.some((b) => b.items.length > lim),
    ...(short ? {} : {
      notCollected: hatchBlocks(notCollected, info, now, notArrived),
      recent: recent.map(out), waitingResult: cutWait.items.map(out), waitingTotal: cutWait.total,
      byHour: byHour.filter((x) => x.received || x.rejected), bySource: [...bySource.values()].sort((a, b) => (b.received + b.rejected) - (a.received + a.rejected) || (a.sourceId < b.sourceId ? -1 : 1)),
      picks: { rejectReasons: { ...REJECT_REASONS }, rejectHeading: REJECT_HEADING, undoReasons: { ...UNDO_REASONS }, undoMinutes: UNDO_MINUTES, urgencyLabel: URGENCY_LABEL, notArrivedMinutes: { ...NOT_ARRIVED_MINUTES } },
      releasedDefinition: RELEASED_DEFINITION,
    }),
    guideOn: on, note: NOT_FOR,
  };
}
function equipmentRows(info, events, woEvents, now) {
  const eq = deriveEquipment(events);
  const wos = [...deriveWorkOrders(woEvents, now).values()];
  const off = info.offsetMinutes;
  return info.equipment.map((a) => {
    const x = eq.get(a.id) || { state: 'up', since: null, episodes: [] };
    const k = EQUIPMENT_KINDS[a.kind];
    const open = wos.filter((w) => w.assetId === a.id && w.state !== 'completed').sort((p, q) => (p.reportedAt < q.reportedAt ? -1 : 1))
      .map((w) => ({ id: w.id, title: w.title, state: w.state, stateName: WO_STATES[w.state], priority: w.priority, reportedAt: w.reportedAt, reportedText: whenText(w.reportedAt, off, now) }));
    const linked = x.workOrder ? wos.find((w) => w.id === x.workOrder) : null;
    const offGroups = groupsOff(x, a.kind);
    return { assetId: a.id, name: a.name, kind: a.kind, kindWord: k.word, placeId: a.parentId, placeName: info.nameOf(a.parentId), state: x.state, stateName: EQUIPMENT_STATES[x.state],
      since: x.since, sinceText: x.since ? whenText(x.since, off, now) : null, reason: x.reason || null, reasonName: x.reason ? k.reasons[x.reason] || null : null,
      runs: k.runs.map((g) => ({ id: g, name: TEST_GROUPS[g] })), testGroupsOff: offGroups.map((g) => ({ id: g, name: TEST_GROUPS[g] })),
      workOrder: linked ? { id: linked.id, title: linked.title, state: linked.state, stateName: WO_STATES[linked.state] } : null, openWorkOrders: open,
      expectedBack: x.expectedBack || null, expectedBackText: x.expectedBack ? `Estimate: back by ${whenText(x.expectedBack, off, now)} (set at ${whenText(x.expectedSetAt, off, now)})` : null,
      backup: x.backup || null, backupText: x.state === 'up' ? null : backupText(a.kind, x.backup), markedByRole: x.byRole || null, roles: [...k.roles] };
  });
}
const equipmentPicks = () => Object.fromEntries(Object.entries(EQUIPMENT_KINDS).map(([k, v]) => [k, { word: v.word, reasons: { ...v.reasons }, backups: { ...v.backups }, runs: [...v.runs], roles: [...v.roles] }]));
async function equipmentList(core, input = {}) {
  const now = core.now();
  const [events, info] = await Promise.all([core.events({ type: [...OWN, ...WO_TYPES] }), siteInfo(core)]);
  const rows = equipmentRows(info, events, events, now);
  const cut = page(rows, input.limit, 50);
  return { asOf: now, synthetic: await isSynthetic(core), equipment: cut.items, total: cut.total, truncated: cut.truncated,
    picks: equipmentPicks(),
    expectedBackHours: [...EXPECTED_HOURS], states: { ...EQUIPMENT_STATES }, faultNote: FAULT_NOTE, imaging: IMAGING_PLANNED, note: NOT_FOR };
}

async function overview(core, input, wards) {
  const now = core.now();
  const days = input.days ?? 7;
  const since = new Date(Date.parse(now) - days * DAY).toISOString();
  const [events, info] = await Promise.all([core.events({ type: [...OWN, ...WO_TYPES] }), siteInfo(core)]);
  const woEvents = events;
  const reqs = deriveRequests(events);
  const seen = new Map([...reqs].filter(([, r]) => !wards || wards.has(r.sourceId)));
  const period = { since, until: now, days };
  const short = input.format === 'short';
  const ar = (o) => ({ ...o, value: o.value == null ? null : Math.round(o.value * 10) / 10 });
  const tat = labTurnaround(seen, { ...period, leaveOut: OWN_ROW_GROUPS });
  const groups = Object.keys(TEST_GROUPS);
  const tatRows = groups.map((g) => ({ testGroup: g, name: TEST_GROUPS[g], ownRow: OWN_ROW_GROUPS.includes(g), note: OWN_ROW_GROUPS.includes(g) ? 'first report, not final' : null, urgent: labTurnaround(seen, { ...period, testGroup: g, urgency: 'urgent' }), routine: labTurnaround(seen, { ...period, testGroup: g, urgency: 'routine' }) }))
    .filter((x) => x.urgent.n || x.routine.n);
  const rej = rejectionRate(seen, period);
  const byReason = Object.entries(REJECT_REASONS).map(([reason, name]) => ({ reason, name, count: rejectionRate(seen, { ...period, reason }).numerator })).filter((x) => x.count);
  const sourcesSeen = [...new Set([...seen.values()].map((r) => r.sourceId))];
  const byArea = sourcesSeen.map((s) => { const v = rejectionRate(seen, { ...period, sourceId: s }); return { sourceId: s, name: info.nameOf(s), rejected: v.numerator, reached: v.denominator, value: v.denominator >= MIN_AREA ? Math.round(v.value * 10) / 10 : null, tooFew: v.denominator < MIN_AREA }; })
    .filter((x) => x.reached).sort((a, b) => b.rejected - a.rejected || b.reached - a.reached || (a.sourceId < b.sourceId ? -1 : 1));
  const eqRows = equipmentRows(info, events, woEvents, now);
  const eq = deriveEquipment(events);
  const avail = eqRows.map((row) => ({ assetId: row.assetId, name: row.name, state: row.state, stateName: row.stateName, ...equipmentAvailability(eq.get(row.assetId), period) }));
  const comp = completeness(seen, period);
  const miss = missingSteps(seen, period);
  const compByArea = sourcesSeen.map((s) => ({ sourceId: s, name: info.nameOf(s), ...ar(completeness(seen, { ...period, sourceId: s })), ...missingSteps(seen, { ...period, sourceId: s }) })).filter((x) => x.denominator)
    .sort((a, b) => (a.value ?? 101) - (b.value ?? 101) || (a.sourceId < b.sourceId ? -1 : 1));
  const values = {
    // No headline: urgent and routine by test group lead. The blend is returned apart, labelled.
    'lab-turnaround': { value: null, median: null, p90: null, n: tat.n, numerator: null, denominator: null, byGroup: tatRows,
      blended: { median: tat.median, p90: tat.p90, n: tat.n, label: 'All test groups except blood culture, urgent and routine together: not comparable between weeks (it moves when the mix of tests changes).' } },
    'specimen-rejection-rate': { ...ar(rej), byReason, byArea, other: byReason.find((x) => x.reason === 'other')?.count || 0 },
    'equipment-availability': { value: avail.length ? Math.round((avail.reduce((n, x) => n + x.numerator, 0) / Math.max(1, avail.reduce((n, x) => n + x.denominator, 0))) * 1000) / 10 : null, numerator: null, denominator: null, n: avail.length, byAsset: avail },
  };
  const kpis = KPIS.map((k) => {
    const v = values[k.id];
    const base = { id: k.id, name: k.name, unit: k.unit, value: v.value, numerator: v.numerator, denominator: v.denominator, n: v.n, period, targetText: k.targetText,
      ...(k.id === 'lab-turnaround' ? { median: v.median, p90: v.p90 } : {}) };
    if (short) return base;
    const extra = k.id === 'lab-turnaround' ? { byGroup: v.byGroup, blended: v.blended } : k.id === 'specimen-rejection-rate' ? { byReason: v.byReason, byArea: v.byArea, other: v.other } : { byAsset: v.byAsset };
    return { ...base, ...extra, completeness: ar(comp), missing: miss, definition: k.definition, counts: k.counts, outOf: k.outOf, leavesOut: k.leavesOut, source: k.source };
  });
  const on = guideOn(events);
  const eqList = info.equipment.map((a) => ({ assetId: a.id, kind: a.kind, name: a.name, x: eq.get(a.id) }));
  const vis = (s) => !wards || wards.has(s.sourceId);
  const suggestions = on ? [
    ...ruleEquipmentDown(seen, eqList, { nameOf: info.nameOf, backupText, offsetMinutes: info.offsetMinutes }),
    ...ruleNotArrived(seen, { now, nameOf: info.nameOf }),
    ...ruleRejectionReview(seen, { now, nameOf: info.nameOf }),
  ].filter(vis) : [];
  const today = localStartOfDay(now, info.offsetMinutes);
  const todayReached = [...seen.values()].filter((r) => { const at = r.state === 'rejected' ? r.rejectedAt : r.receivedAt; return at && at >= today; });
  return {
    asOf: now, synthetic: await isSynthetic(core), period,
    counts: { onTheWay: [...seen.values()].filter((r) => r.state === 'collected').length, waitingResult: [...seen.values()].filter((r) => r.state === 'received').length,
      noCollectionToday: todayReached.filter(noCollection).length, equipmentDown: eqRows.filter((x) => x.state !== 'up').length },
    kpis, planned: PLANNED.map((x) => ({ ...x })),
    ...(short ? {} : { completeness: { ...ar(comp), missing: miss, byArea: compByArea, requiredSteps: [...REQUIRED_STEPS],
      definition: 'Data completeness (KPI dictionary D-21): requests finished in the period (result released, or rejected) with every required step timed, divided by requests finished in the period, per source area.' },
    equipment: eqRows, equipmentPicks: equipmentPicks(), expectedBackHours: [...EXPECTED_HOURS], imaging: IMAGING_PLANNED, faultNote: FAULT_NOTE }),
    guide: { on, rules: GUIDE_RULES.map((r) => ({ ...r })), suggestions },
    note: NOT_FOR,
  };
}

// ---- schemas ----
const REQ = { type: 'string', pattern: REQUEST_ID, maxLength: 20, description: 'A request id, for example dx-00012. ospeli_diagnostics_requests_list lists them.' };
const NULLABLE = (t) => ({ type: [t, 'null'] });
const REQUEST_OUT = { type: 'object', required: ['id', 'code', 'sourceId', 'testGroup', 'urgency', 'state', 'stage'], properties: {
  id: { type: 'string' }, code: { type: 'string', description: 'What to call it on screen: "Patient 123" when the request carries an encounter, else "Request 12". Never a name, and not patient identification.' },
  codeLead: { type: 'string' }, codeDigits: { type: 'string' }, encounter: NULLABLE('string'), sourceId: { type: 'string' }, sourceName: { type: 'string' },
  testGroup: { type: 'string' }, testGroupName: { type: 'string' }, urgency: { type: 'string', description: 'As set by the requester; recorded, never decided by Ospeli.' }, urgencyName: { type: 'string' },
  state: { type: 'string', enum: Object.keys(STAGES) }, stage: { type: 'string' },
  minutesInStep: { type: ['integer', 'null'], description: 'Open requests: minutes in the current step, to now. null once finished (released, rejected or cancelled).' },
  stepAt: { type: 'string', description: 'When the current step happened, on the site clock: "08:35" today, "Wed 18 Nov, 23:10" on another day.' },
  mayUndoCollect: { type: 'boolean', description: `Collected, not yet at the lab, recorded in the last ${UNDO_MINUTES} minutes: may be undone with ospeli_diagnostics_collect_undo.` },
  minutesSinceCollection: { type: ['integer', 'null'], description: 'Collected, not received: minutes since the specimen was taken.' },
  notArrived: { type: 'boolean', description: 'Guide rule 1 (only while the guide is on): collected and not received within the example time for its urgency.' },
  enteredLate: { type: 'boolean', description: `The collection was recorded more than ${LATE_ENTRY_MINUTES} minutes after it was taken (an example setting).` },
  noCollectionTime: { type: 'boolean', description: 'Reached the lab with no collection recorded.' },
  mayUndo: { type: 'boolean', description: `A receipt or rejection in the last ${UNDO_MINUTES} minutes that may still be undone with ospeli_diagnostics_specimen_undo.` },
  recollectionOf: NULLABLE('string'), recollectedBy: NULLABLE('string'), clocks: { type: 'object', description: 'Site clock of each step ("08:35" today, "Wed 18 Nov, 23:10" on another day), null until then.' }, roles: { type: 'object', description: 'The role that recorded each step, never a person.' } } };
const KPI_OUT = { type: 'object', required: ['id', 'name', 'unit', 'value'], properties: {
  id: { type: 'string' }, name: { type: 'string' }, unit: { type: 'string' }, value: { type: ['number', 'null'], description: 'null when nothing was counted in the period.' },
  numerator: NULLABLE('number'), denominator: NULLABLE('number'), n: { type: 'integer' }, median: NULLABLE('number'), p90: NULLABLE('number'), period: { type: 'object' }, targetText: { type: 'string' },
  byGroup: { type: 'array', description: 'Turnaround by test group, urgent and routine apart, each with median, p90 and n: the figures to read. Blood culture is its own row only (first report, not final).' },
  blended: { type: 'object', description: 'Turnaround only: one median over every test group except blood culture, urgent and routine together, with its label. Not comparable between weeks; never the headline.' },
  byReason: { type: 'array' }, byArea: { type: 'array', description: `Rejections by source area; value is null where fewer than ${MIN_AREA} specimens reached the lab (counts only).` }, other: { type: 'integer', description: 'Rejections with the reason "Other": if it grows, the reason list needs changing.' },
  byAsset: { type: 'array', description: 'Availability per analyser and scanner: hours in service, scheduled hours, hours down and hours partly down.' },
  completeness: { type: 'object', description: 'Data completeness (D-21) for the same period.' }, missing: { type: 'object', description: 'Requests that reached the lab with no collection time, and collections entered late.' },
  definition: { type: 'string' }, counts: { type: 'string' }, outOf: { type: 'string' }, leavesOut: { type: 'string' }, source: { type: 'string' } } };
const SUGGESTION = { type: 'object', required: ['rule', 'id', 'text', 'why', 'basis'], properties: {
  rule: { type: 'string' }, id: { type: 'string' }, text: { type: 'string' }, why: { type: 'string' }, basis: { type: 'string' }, sourceId: { type: 'string' },
  action: { type: ['object', 'null'], description: 'Always null: advice only. A person decides.' } } };
const ev = (type, subject, actor, at, data) => ({ type, subject, actorRole: actor.role, at, data });
const reqWard = async (core, input) => {
  const r = deriveRequests(await own(core)).get(input.requestId);
  return r ? r.sourceId : null;
};

export const COMMANDS = [
  {
    name: 'ospeli_diagnostics_requests_list',
    summary: 'The request tracker: laboratory requests by patient code ("Patient 123", or "Request 12" with no encounter; never a name) and stage (not collected, collected and on the way, received at lab, result released, rejected with its reason, cancelled), for one ward or area or all, with the time in the current step and a recollection linked to the request it replaces. Default: open requests, and those finished in the last 24 hours. Also the pick lists for recording a request (sources, test groups, urgency as set by the requester) and, with sourceId set to a ward, the patients in its beds. Read-only.',
    kind: 'read', roles: ALL_ROLES, approval: false,
    input: { type: 'object', additionalProperties: false, properties: {
      sourceId: { ...ID, description: 'Only requests from this ward or area, for example ward-a2 or dept-emergency.' },
      stage: { type: 'string', enum: ['current', 'all', ...Object.keys(STAGES)], description: 'current (default): open requests and those finished in the last hours. all: every request. Or one stage: requested (not collected), collected, received, released, rejected, cancelled.' },
      find: { type: 'string', pattern: '^[0-9]{1,9}$', maxLength: 9, description: 'Only the request whose code ends in this number: "123" finds Patient 123 or Request 123. A filter on what is shown, never a way to identify a patient.' },
      hours: { type: 'integer', minimum: 1, maximum: 168, description: 'Finished requests are kept in the list this many hours. Default 24.' },
      format: FORMAT('id, code, place, test group, urgency, stage and minutes only', 'with every step\'s time and role, the pick lists and the patients on the ward'),
      limit: LIMIT(50, 500, 'requests') } },
    output: { type: 'object', required: ['asOf', 'synthetic', 'requests', 'total', 'truncated', 'counts', 'note'], properties: {
      asOf: TIME, synthetic: SYNTHETIC, sourceId: NULLABLE('string'), sourceName: NULLABLE('string'), hours: { type: 'integer' }, requests: { type: 'array', items: REQUEST_OUT },
      total: TOTAL, truncated: TRUNCATED, counts: { type: 'object', description: 'Requests in the list by state, before the limit.' }, picks: { type: 'object' },
      releasedDefinition: { type: 'string' }, filterNote: { type: 'string' }, offlineNote: { type: 'string' }, note: { type: 'string' } } },
    async run(core, input, { wards }) { return requestsList(core, input, wards); },
    example: { input: { sourceId: 'ward-a2', format: 'short', limit: 10 } },
  },
  {
    name: 'ospeli_diagnostics_specimen_log',
    summary: 'The lab reception\'s hatch list: specimens collected and on their way, in blocks by source area (one bag goes with one block), urgent first then oldest first inside each block (urgency as set by the requester; never re-ranked by test); those not arrived within the example time at the top (while the guide is on); the count of specimens received today with no collection time, so a gap in ward recording is seen where it happens; requests not marked collected; receipts and rejections that may still be undone; specimens received and waiting for a released result; received and rejected today by hour and by source. Read-only.',
    kind: 'read', roles: ALL_ROLES, approval: false,
    input: { type: 'object', additionalProperties: false, properties: {
      format: FORMAT('the counts, not arrived and on the way only', 'also not collected, recent, waiting for a result, by hour and by source, and the pick lists'),
      limit: LIMIT(100, 500, 'specimens in each block') } },
    output: { type: 'object', required: ['asOf', 'synthetic', 'counts', 'notArrived', 'onTheWay', 'total', 'truncated', 'note'], properties: {
      asOf: TIME, synthetic: SYNTHETIC, today: { type: 'object', description: 'Since 00:00 on the site\'s own clock: a night shift crosses it.' },
      counts: { type: 'object', required: ['onTheWay', 'noCollectionToday'], properties: { noCollectionToday: { type: 'integer', description: 'Specimens that reached the lab today with no collection time recorded.' } } },
      notArrived: { type: 'array', items: REQUEST_OUT }, onTheWay: { type: 'array', description: 'Blocks by source area: { sourceId, sourceName, count, items }.' },
      notCollected: { type: 'array' }, recent: { type: 'array', items: REQUEST_OUT }, waitingResult: { type: 'array', items: REQUEST_OUT }, waitingTotal: { type: 'integer' },
      byHour: { type: 'array' }, bySource: { type: 'array' }, picks: { type: 'object' }, releasedDefinition: { type: 'string' }, guideOn: { type: 'boolean' },
      total: TOTAL, truncated: TRUNCATED, note: { type: 'string' } } },
    async run(core, input, { wards }) { return specimenLog(core, input, wards); },
    example: { input: { format: 'short' } },
  },
  {
    name: 'ospeli_diagnostics_request_record',
    summary: 'Record a laboratory request, by picks only (nothing typed): the ward or area it comes from, the test group, the urgency as set by the requester (recorded, never decided by Ospeli) and, optionally, the patient\'s encounter id from the bed board (shown as "Patient 123"). A recollection of a rejected specimen is a new request with recollectionOf. The same picks again within two minutes are refused as already saved unless sent with again: true. It does not choose a test or hold any result. An agent\'s call becomes a proposal for a person.',
    kind: 'write', roles: REQUESTERS, approval: true,
    input: { type: 'object', additionalProperties: false, required: ['sourceId', 'testGroup', 'urgency'], properties: {
      sourceId: { ...ID, description: 'The ward or area the request comes from, for example ward-a2 or dept-emergency.' },
      testGroup: { type: 'string', enum: Object.keys(TEST_GROUPS), description: `${Object.entries(TEST_GROUPS).map(([k, v]) => `${k} (${v})`).join(', ')}. An example list: a site sets its own.` },
      urgency: { type: 'string', enum: Object.keys(URGENCIES), description: 'urgent or routine, as set by the requester.' },
      encounter: { type: 'string', pattern: '^enc-[0-9]{1,9}$', maxLength: 13, description: 'Optional: the encounter id from the bed board, for example enc-000123 (shown as Patient 123). Leave out when there is none.' },
      recollectionOf: { ...REQ, description: 'Optional: the rejected request this one replaces, for example dx-00031. Same test group.' },
      again: { type: 'boolean', description: 'true: a second request with the same picks within two minutes is meant.' } } },
    output: { type: 'object', required: ['status'], properties: { status: WRITE_STATUS, requestId: { type: 'string' }, code: { type: 'string' }, events: EVENT_SEQS, proposal: PROPOSAL_OUT } },
    wardOf: (core, input) => input.sourceId,
    async precheck(core, input, { actor }) { await checkRequest(core, input, actor); },
    async run(core, input, { actor }) {
      let requestId = null;
      const info = await siteInfo(core);
      const recs = await core.appendChecked(async (events) => {
        await checkRequest(core, input, actor, events.filter((e) => e.type.startsWith('diagnostics.')), info);
        requestId = nextRequestId(events);
        const data = { sourceId: input.sourceId, testGroup: input.testGroup, urgency: input.urgency, ...(input.encounter ? { encounter: input.encounter } : {}), ...(input.recollectionOf ? { recollectionOf: input.recollectionOf } : {}) };
        return [ev('diagnostics.request-made', requestId, actor, core.now(), data)];
      });
      await core.recordAs(actor, 'diagnostics.request-made', requestId, { sourceId: input.sourceId, testGroup: input.testGroup, urgency: input.urgency, ...(input.recollectionOf ? { recollectionOf: input.recollectionOf } : {}) });
      return { status: 'done', requestId, code: input.encounter ? `Patient ${input.encounter.replace(/^enc-0*/, '')}` : `Request ${requestId.replace(/^dx-0*/, '')}`, events: recs.map((r) => r.seq) };
    },
    example: { input: { sourceId: 'ward-a2', testGroup: 'blood-count', urgency: 'routine' } },
  },
  {
    name: 'ospeli_diagnostics_specimen_collect',
    summary: `Mark a request's specimen collected: the time it was taken, now or a few minutes back (minutesAgo: ${AGO_MINUTES.join(', ')}; never in the future). Recorded more than ${LATE_ENTRY_MINUTES} minutes after it was taken, it shows "entered late". The "not arrived" timer starts here, never at the request. One collection per request (slice 1 has one specimen per request). An agent's call becomes a proposal for a person.`,
    kind: 'write', roles: COLLECTORS, approval: true,
    input: { type: 'object', additionalProperties: false, required: ['requestId'], properties: {
      requestId: REQ, minutesAgo: { type: 'integer', enum: AGO_MINUTES, description: 'How many minutes ago it was taken. Leave out for now.' } } },
    output: { type: 'object', required: ['status'], properties: { status: WRITE_STATUS, requestId: { type: 'string' }, collectedAt: TIME, clock: { type: 'string', description: 'The time it was taken, on the site clock, HH:MM.' }, events: EVENT_SEQS, proposal: PROPOSAL_OUT } },
    target: (input) => ({ id: input.requestId, word: 'request' }),
    wardOf: reqWard,
    async precheck(core, input, { actor }) { await checkCollect(core, input, actor); },
    async run(core, input, { actor }) {
      const info = await siteInfo(core);
      const back = input.minutesAgo || 0;
      const at = new Date(Date.parse(core.now()) - back * MIN).toISOString();
      const recs = await core.appendChecked(async (events) => {
        await checkCollect(core, input, actor, events, info);
        return [ev('diagnostics.specimen-collected', input.requestId, actor, at, back ? { backdatedMinutes: back } : null)];
      });
      await core.recordAs(actor, 'diagnostics.specimen-collected', input.requestId, back ? { backdatedMinutes: back } : {});
      return { status: 'done', requestId: input.requestId, collectedAt: at, clock: clockText(at, info.offsetMinutes), events: recs.map((r) => r.seq) };
    },
    example: { input: { requestId: 'dx-99999' }, needs: 'A request not collected yet: ospeli_diagnostics_request_record makes one, and ospeli_diagnostics_requests_list with stage "requested" lists them with their ids.' },
  },
  {
    name: 'ospeli_diagnostics_collect_undo',
    summary: `Undo a "Collected" marked by mistake on the ward, within ${UNDO_MINUTES} minutes of recording it (an example setting) and before the lab received the specimen. The request goes back to "Not collected". Both events stay in the log; no time is edited in place. People only.`,
    kind: 'write', roles: COLLECTORS, approval: true, agents: false,
    input: { type: 'object', additionalProperties: false, required: ['requestId', 'reason'], properties: {
      requestId: REQ, reason: { type: 'string', enum: Object.keys(COLLECT_UNDO_REASONS), description: `Why: ${Object.entries(COLLECT_UNDO_REASONS).map(([k, v]) => `${k} (${v})`).join(', ')}.` } } },
    output: { type: 'object', required: ['status'], properties: { status: WRITE_STATUS, requestId: { type: 'string' }, state: { type: 'string' }, events: EVENT_SEQS } },
    async precheck(core, input) { await checkCollectUndo(core, input); },
    async run(core, input, { actor }) {
      const info = await siteInfo(core);
      const recs = await core.appendChecked(async (events) => {
        await checkCollectUndo(core, input, events, info);
        return [ev('diagnostics.collection-undone', input.requestId, actor, core.now(), { reason: input.reason })];
      });
      await core.recordAs(actor, 'diagnostics.collection-undone', input.requestId, { reason: input.reason });
      return { status: 'done', requestId: input.requestId, state: 'requested', events: recs.map((x) => x.seq) };
    },
    example: { input: { requestId: 'dx-99999', reason: 'wrong-request' }, needs: 'A request marked collected in the last few minutes and not yet received: ospeli_diagnostics_request_record then ospeli_diagnostics_specimen_collect make one.' },
  },
  {
    name: 'ospeli_diagnostics_specimen_receive',
    summary: `At the lab hatch: mark a specimen received at the lab (outcome "received", the time of the call), or rejected with a reason picked by the lab's own acceptance criteria (outcome "rejected"). A specimen may be received with no collection recorded; it is counted as "received with no collection time". A rejected request is final: a recollection is a new request. A specimen already received may still be rejected by laboratory bench staff (for example clotted or haemolysed (hemolyzed), found later). Receiving twice is refused as already saved. Ospeli records the reason a person picked; it never decides whether a sample is acceptable, and "received" is not an identity check. An agent's call becomes a proposal for a person.`,
    kind: 'write', roles: LAB, approval: true,
    input: { type: 'object', additionalProperties: false, required: ['requestId', 'outcome'], properties: {
      requestId: REQ, outcome: { type: 'string', enum: ['received', 'rejected'], description: 'received or rejected.' },
      reason: { type: 'string', enum: Object.keys(REJECT_REASONS), description: `rejected only: ${Object.entries(REJECT_REASONS).map(([k, v]) => `${k} (${v})`).join(', ')}.` } } },
    output: { type: 'object', required: ['status'], properties: { status: WRITE_STATUS, requestId: { type: 'string' }, outcome: { type: 'string' }, at: TIME, clock: { type: 'string', description: 'The time on the site clock, HH:MM.' }, noCollectionTime: { type: 'boolean' }, events: EVENT_SEQS, proposal: PROPOSAL_OUT } },
    target: (input) => ({ id: input.requestId, word: 'request' }),
    wardOf: reqWard,
    async precheck(core, input, { actor }) { await checkReceive(core, input, actor); },
    async run(core, input, { actor }) {
      const info = await siteInfo(core);
      let r = null;
      const recs = await core.appendChecked(async (events) => {
        r = await checkReceive(core, input, actor, events, info);
        return [input.outcome === 'received' ? ev('diagnostics.specimen-received', input.requestId, actor, core.now(), null)
          : ev('diagnostics.specimen-rejected', input.requestId, actor, core.now(), { reason: input.reason, ...(r.state === 'received' ? { afterReceipt: true } : {}) })];
      });
      await core.recordAs(actor, `diagnostics.specimen-${input.outcome}`, input.requestId, input.reason ? { reason: input.reason } : {});
      const at = recs[0]?.at || core.now();
      return { status: 'done', requestId: input.requestId, outcome: input.outcome, at, clock: clockText(at, info.offsetMinutes), noCollectionTime: !r.collectedAt, events: recs.map((x) => x.seq) };
    },
    example: { input: { requestId: 'dx-99999', outcome: 'received' }, needs: 'A request collected and not yet received: ospeli_diagnostics_request_record then ospeli_diagnostics_specimen_collect make one, and ospeli_diagnostics_specimen_log lists those on the way.' },
  },
  {
    name: 'ospeli_diagnostics_specimen_undo',
    summary: `Undo a receipt, a rejection or a result release tapped by mistake, within ${UNDO_MINUTES} minutes (an example setting; the screen offers it for about 10 seconds after the tap). An undone receipt goes back on the way, an undone release back to waiting for its result (and out of the turnaround). Only laboratory bench staff undo a release. The wrong step and the undo both stay in the log; no time is edited in place. Not for a rejection that already has a recollection. People only.`,
    kind: 'write', roles: LAB, approval: true, agents: false,
    input: { type: 'object', additionalProperties: false, required: ['requestId', 'reason'], properties: {
      requestId: REQ, reason: { type: 'string', enum: Object.keys(UNDO_REASONS), description: `${Object.entries(UNDO_REASONS).map(([k, v]) => `${k} (${v})`).join(', ')}.` } } },
    output: { type: 'object', required: ['status'], properties: { status: WRITE_STATUS, requestId: { type: 'string' }, state: { type: 'string' }, events: EVENT_SEQS } },
    async precheck(core, input, { actor }) { await checkUndo(core, input, actor); },
    async run(core, input, { actor }) {
      const info = await siteInfo(core);
      const recs = await core.appendChecked(async (events) => {
        const r = await checkUndo(core, input, actor, events, info);
        return [ev('diagnostics.specimen-undone', input.requestId, actor, core.now(), { reason: input.reason, undid: r.state })];
      });
      await core.recordAs(actor, 'diagnostics.specimen-undone', input.requestId, { reason: input.reason });
      const r = deriveRequests(await own(core)).get(input.requestId);
      return { status: 'done', requestId: input.requestId, state: r.state, events: recs.map((x) => x.seq) };
    },
    example: { input: { requestId: 'dx-99999', reason: 'tapped-by-mistake' }, needs: 'A specimen received or rejected in the last few minutes: ospeli_diagnostics_request_record then ospeli_diagnostics_specimen_receive make one; ospeli_diagnostics_specimen_log lists them under recent.' },
  },
  {
    name: 'ospeli_diagnostics_result_record',
    summary: 'Record that the lab released the result of a specimen received at the lab: the time only, never a value, a range or a flag. This ends the laboratory turnaround time. Whether a site calls this step validated or authorised, it is the time the lab released the result. An agent\'s call becomes a proposal for a person.',
    kind: 'write', roles: ['lab-scientist'], approval: true,
    input: { type: 'object', additionalProperties: false, required: ['requestId'], properties: { requestId: REQ } },
    output: { type: 'object', required: ['status'], properties: { status: WRITE_STATUS, requestId: { type: 'string' }, releasedAt: TIME, clock: { type: 'string' }, turnaroundMinutes: { type: 'integer' }, events: EVENT_SEQS, proposal: PROPOSAL_OUT } },
    target: (input) => ({ id: input.requestId, word: 'request' }),
    wardOf: reqWard,
    async precheck(core, input, { actor }) { await checkResult(core, input, actor); },
    async run(core, input, { actor }) {
      const info = await siteInfo(core);
      let r = null;
      const recs = await core.appendChecked(async (events) => {
        r = await checkResult(core, input, actor, events, info);
        return [ev('diagnostics.result-validated', input.requestId, actor, core.now(), null)];
      });
      await core.recordAs(actor, 'diagnostics.result-validated', input.requestId, {});
      const at = recs[0]?.at || core.now();
      return { status: 'done', requestId: input.requestId, releasedAt: at, clock: clockText(at, info.offsetMinutes), turnaroundMinutes: Math.round((Date.parse(at) - Date.parse(r.receivedAt)) / MIN), events: recs.map((x) => x.seq) };
    },
    example: { input: { requestId: 'dx-99999' }, needs: 'A specimen received at the lab with no result yet: ospeli_diagnostics_request_record then ospeli_diagnostics_specimen_receive make one; ospeli_diagnostics_specimen_log lists them under waitingResult.' },
  },
  {
    name: 'ospeli_diagnostics_request_cancel',
    summary: `Cancel a request that is not yet at the lab (not collected, or collected and on the way), with a picked reason: ${Object.entries(CANCEL_REASONS).map(([k, v]) => `${k} (${v})`).join(', ')}. A cancelled request is left out of every measure. An agent's call becomes a proposal for a person.`,
    kind: 'write', roles: [...REQUESTERS, 'diagnostics-manager'], approval: true,
    input: { type: 'object', additionalProperties: false, required: ['requestId', 'reason'], properties: {
      requestId: REQ, reason: { type: 'string', enum: Object.keys(CANCEL_REASONS), description: `Why it is cancelled: ${Object.entries(CANCEL_REASONS).map(([k, v]) => `${k} (${v})`).join(', ')}.` } } },
    output: { type: 'object', required: ['status'], properties: { status: WRITE_STATUS, requestId: { type: 'string' }, events: EVENT_SEQS, proposal: PROPOSAL_OUT } },
    target: (input) => ({ id: input.requestId, word: 'request' }),
    wardOf: reqWard,
    async precheck(core, input, { actor }) { await checkCancel(core, input, actor); },
    async run(core, input, { actor }) {
      const info = await siteInfo(core);
      const recs = await core.appendChecked(async (events) => {
        await checkCancel(core, input, actor, events, info);
        return [ev('diagnostics.request-cancelled', input.requestId, actor, core.now(), { reason: input.reason })];
      });
      await core.recordAs(actor, 'diagnostics.request-cancelled', input.requestId, { reason: input.reason });
      return { status: 'done', requestId: input.requestId, events: recs.map((x) => x.seq) };
    },
    example: { input: { requestId: 'dx-99999', reason: 'not-needed' }, needs: 'A request not yet at the lab: ospeli_diagnostics_request_record makes one, and ospeli_diagnostics_requests_list with stage "requested" lists them.' },
  },
  {
    name: 'ospeli_diagnostics_equipment_list',
    summary: 'Equipment status: each analyser and scanner on this site, working, down or partly down (some test groups off), since when, the reason, the test groups it cannot run now, the linked work order and every open work order for it (read-only: faults are reported by a facilities technician or the operations manager, on the Engineering page), the estimate of when it is back with the time the estimate was set, and the backup route in plain words. Read-only.',
    kind: 'read', roles: ALL_ROLES, approval: false,
    input: { type: 'object', additionalProperties: false, properties: { limit: LIMIT(50, 200, 'analysers and scanners') } },
    output: { type: 'object', required: ['asOf', 'synthetic', 'equipment', 'total', 'truncated', 'note'], properties: {
      asOf: TIME, synthetic: SYNTHETIC, equipment: { type: 'array', items: { type: 'object', required: ['assetId', 'name', 'state', 'stateName'] } }, total: TOTAL, truncated: TRUNCATED,
      picks: { type: 'object' }, expectedBackHours: { type: 'array' }, states: { type: 'object' }, faultNote: { type: 'string' }, imaging: { type: 'string' }, note: { type: 'string' } } },
    async run(core, input) { return equipmentList(core, input); },
    example: { input: {} },
  },
  {
    name: 'ospeli_diagnostics_equipment_set',
    summary: `Mark an analyser or scanner down, partly down (some test groups off; send testGroups) or back working ("up"). Down needs a reason and a backup route, both picked; it may link the open work order for it (workOrderId) and an estimate of when it is back (expectedBackHours: ${EXPECTED_HOURS.join(', ')}). Analysers are marked by laboratory bench staff or the diagnostics manager; scanners by imaging staff or the diagnostics manager. It writes no work order: a fault is reported by a facilities technician or the operations manager. Nothing is sent outside Ospeli. An agent's call becomes a proposal for a person.`,
    kind: 'write', roles: EQUIPMENT_ROLES, approval: true,
    input: { type: 'object', additionalProperties: false, required: ['assetId', 'state'], properties: {
      assetId: { ...ID, description: 'The analyser or scanner, for example asset-analyser-1 or asset-xray-1.' },
      state: { type: 'string', enum: Object.keys(EQUIPMENT_STATES), description: 'down, partly-down or up (back working).' },
      reason: { type: 'string', pattern: '^[a-z-]{2,30}$', maxLength: 30, description: 'down and partly-down: an analyser: breakdown, planned-maintenance, qc-failed, no-reagent, no-power-it; a scanner: the same without no-reagent.' },
      testGroups: { type: 'array', maxItems: 5, items: { type: 'string', enum: Object.keys(TEST_GROUPS) }, description: 'partly-down only: the test groups it cannot run now.' },
      workOrderId: { type: 'string', pattern: '^wo-[0-9]{5,}$', maxLength: 20, description: 'Optional: the open work order for this analyser or scanner, for example wo-00012.' },
      expectedBackHours: { type: 'integer', enum: EXPECTED_HOURS, description: 'Optional: about how many hours until it is back. Shown as an estimate with the time it was set.' },
      backup: { type: 'string', pattern: '^[a-z-]{2,30}$', maxLength: 30, description: 'down and partly-down: an analyser: other-analyser, partner-lab, hold, none; a scanner: other-room, other-site, mobile-unit, none.' } } },
    output: { type: 'object', required: ['status'], properties: { status: WRITE_STATUS, assetId: { type: 'string' }, state: { type: 'string' }, events: EVENT_SEQS, proposal: PROPOSAL_OUT } },
    target: (input) => ({ id: input.assetId, word: 'analyser or scanner' }),
    async precheck(core, input, { actor }) { await checkEquipment(core, input, actor); },
    async run(core, input, { actor }) {
      const info = await siteInfo(core);
      const recs = await core.appendChecked(async (events) => {
        await checkEquipment(core, input, actor, events, info);
        const now = core.now();
        if (input.state === 'up') return [ev('diagnostics.equipment-up', input.assetId, actor, now, null)];
        const data = { scope: input.state === 'partly-down' ? 'part' : 'all', reason: input.reason, backup: input.backup,
          ...(input.testGroups?.length ? { testGroups: [...new Set(input.testGroups)] } : {}), ...(input.workOrderId ? { workOrder: input.workOrderId } : {}),
          ...(input.expectedBackHours ? { expectedBack: new Date(Date.parse(now) + input.expectedBackHours * HOUR).toISOString() } : {}) };
        return [ev('diagnostics.equipment-down', input.assetId, actor, now, data)];
      });
      await core.recordAs(actor, `diagnostics.equipment-${input.state === 'up' ? 'up' : 'down'}`, input.assetId, { state: input.state, ...(input.reason ? { reason: input.reason } : {}), ...(input.workOrderId ? { workOrderId: input.workOrderId } : {}) });
      return { status: 'done', assetId: input.assetId, state: input.state, events: recs.map((x) => x.seq) };
    },
    example: { input: { assetId: 'asset-analyser-1', state: 'down', reason: 'qc-failed', backup: 'partner-lab', expectedBackHours: 2 } },
  },
  {
    name: 'ospeli_diagnostics_overview',
    summary: `The diagnostics manager's summary for the last days (default 7): laboratory turnaround time (received to result released, median and 90th percentile with n, by test group, urgent and routine apart), specimen rejection rate (rejected out of received plus rejected) by reason and by source area, equipment availability per analyser and scanner (downtime as its inverse), data completeness and the count of requests with a missing step beside them, each with its definition and source; equipment status; and the guide's suggestions with their basis (empty while the guide is off). Request to report and reporting backlog are planned (imaging, slice 2). Requests and steps, never a person. Read-only.`,
    kind: 'read', roles: ALL_ROLES, approval: false,
    input: { type: 'object', additionalProperties: false, properties: {
      days: { type: 'integer', minimum: 1, maximum: 30, description: 'The period: the last this many days. Default 7.' },
      format: FORMAT('the values without definitions, breakdowns or equipment', 'each value with its definition, source and breakdown, completeness and equipment') } },
    output: { type: 'object', required: ['asOf', 'synthetic', 'period', 'counts', 'kpis', 'planned', 'guide', 'note'], properties: {
      asOf: TIME, synthetic: SYNTHETIC, period: { type: 'object' }, counts: { type: 'object' }, kpis: { type: 'array', items: KPI_OUT }, planned: { type: 'array' },
      completeness: { type: 'object' }, equipment: { type: 'array' }, imaging: { type: 'string' }, faultNote: { type: 'string' },
      guide: { type: 'object', required: ['on', 'rules', 'suggestions'], properties: { on: { type: 'boolean' }, rules: { type: 'array' }, suggestions: { type: 'array', items: SUGGESTION } } },
      note: { type: 'string' } } },
    async run(core, input, { wards }) { return overview(core, input, wards); },
    example: { input: { format: 'short' } },
  },
  {
    name: 'ospeli_diagnostics_guide_set',
    summary: 'Switch the diagnostics guide on or off for this site. The guide is three fixed rules (a specimen collected and not received within an example time; an analyser down shown on the wards with open requests for what it runs, with the backup route; rejections for one reason from one area reaching an example count in seven days) that suggest; a person decides. With it off everything else works the same. People only.',
    kind: 'write', roles: MANAGER, approval: true, agents: false,
    input: { type: 'object', additionalProperties: false, required: ['on'], properties: { on: { type: 'boolean', description: 'true: show the guide\'s suggestions. false: none.' } } },
    output: { type: 'object', required: ['status', 'on'], properties: { status: WRITE_STATUS, on: { type: 'boolean' }, events: EVENT_SEQS } },
    async precheck(core, input) { if (guideOn(await core.events({ type: 'diagnostics.guide-set' })) === input.on) throw new CommandError('conflict', `The guide is already ${input.on ? 'on' : 'off'}.`); },
    async run(core, input, { actor }) {
      const recs = await core.appendChecked(async (events) => {
        if (guideOn(events) === input.on) throw new CommandError('conflict', `The guide is already ${input.on ? 'on' : 'off'}.`);
        return [ev('diagnostics.guide-set', 'diagnostics-guide', actor, core.now(), { on: input.on })];
      });
      await core.recordAs(actor, 'diagnostics.guide-set', 'diagnostics-guide', { on: input.on });
      return { status: 'done', on: input.on, events: recs.map((x) => x.seq) };
    },
    example: { input: { on: false } },
  },
];

// What an example needs, put in place the way people would on screen.
export async function prepareExample(core, command, { run }) {
  const make = async () => (await run('ospeli_diagnostics_request_record', { sourceId: 'ward-a2', testGroup: 'chemistry', urgency: 'routine', again: true }, 'unit-clerk')).requestId;
  const n = command.name;
  if (n === 'ospeli_diagnostics_specimen_collect' || n === 'ospeli_diagnostics_request_cancel') return { requestId: await make() };
  if (n === 'ospeli_diagnostics_specimen_receive' || n === 'ospeli_diagnostics_collect_undo') {
    const requestId = await make();
    await run('ospeli_diagnostics_specimen_collect', { requestId }, 'unit-clerk');
    return { requestId };
  }
  if (n === 'ospeli_diagnostics_specimen_undo' || n === 'ospeli_diagnostics_result_record') {
    const requestId = await make();
    await run('ospeli_diagnostics_specimen_collect', { requestId }, 'unit-clerk');
    await run('ospeli_diagnostics_specimen_receive', { requestId, outcome: 'received' }, 'lab-reception');
    return { requestId };
  }
  return {};
}

// ---- synthetic history: thirty days of Example General Hospital's laboratory requests ----
// Entirely fictional, generic patterns only. Requests from the wards bunched after the morning
// rounds, and from the emergency department through the day and night (more of them urgent);
// collections mostly recorded at once, some a little later and a few entered late; a few specimens
// reach the lab with no collection recorded; rejections scattered over the reasons, with haemolysed
// specimens concentrated from one ward (Ward A3) and some of them found after receipt; most rejected
// specimens recollected as a new request linked to the rejected one; results released after a
// time that depends on the test group. One analyser down episode matching the generator's work order
// for it, if there is one in the window (else a planned maintenance with no work order). At the end
// time: specimens on their way, one overdue, requests not yet collected, and results not yet released.
const SOURCES = [['ward-a1', 6], ['ward-a2', 5], ['ward-a3', 5], ['ward-b1', 4], ['ward-b2', 3], ['ward-c1', 2], ['dept-emergency', 7]];
const GROUP_WEIGHTS = [['blood-count', 35], ['chemistry', 35], ['coagulation', 10], ['urine', 12], ['culture', 8]];
const RELEASE_MIN = { 'blood-count': 35, chemistry: 70, coagulation: 55, urine: 45, culture: 2400 };
const OTHER_REASONS = [['unlabelled', 3], ['label-mismatch', 3], ['wrong-container', 2], ['too-little', 4], ['clotted', 4], ['haemolysed', 4], ['leaked', 1], ['too-old', 1], ['not-sent-as-required', 1], ['no-request', 1], ['duplicate', 1], ['other', 1]];
const WARD_HOURS = [[0, 1], [2, 1], [4, 2], [6, 4], [8, 12], [9, 12], [10, 9], [12, 5], [14, 4], [16, 4], [18, 3], [20, 2], [22, 1]];
const ED_HOURS = [[0, 3], [2, 2], [4, 2], [6, 3], [8, 5], [10, 6], [12, 6], [14, 6], [16, 6], [18, 6], [20, 5], [22, 4]];
export function seed({ r, startMs, endMs, days, entities, events = [] }) {
  const has = (x) => entities.some((e) => e.id === x);
  if (!has('dept-laboratory')) return []; // an older example hospital: no history
  const off = entities.find((e) => e.type === 'site' && e.utcOffsetMinutes != null)?.utcOffsetMinutes ?? 0;
  const sources = SOURCES.filter(([s]) => has(s));
  const localDay = (t) => { const l = t + off * MIN; return l - (((l % DAY) + DAY) % DAY) - off * MIN; };
  // Who is in which ward when: from the bed board's own events, so a request names a real synthetic encounter.
  const stays = new Map();
  for (const e of events) {
    if (e.type === 'patient.admitted' && e.data?.wardId) stays.set(e.subject, { enc: e.subject, ward: e.data.wardId, from: e.t, to: Infinity });
    else if (e.type === 'patient.discharged' && stays.has(e.subject)) stays.get(e.subject).to = e.t;
  }
  const byWard = new Map();
  for (const s of stays.values()) byWard.set(s.ward, [...(byWard.get(s.ward) || []), s]);
  const encounterAt = (ward, t) => { const list = (byWard.get(ward) || []).filter((s) => s.from <= t && s.to > t); return list.length ? r.pick(list).enc : null; };
  // The analyser's down episode.
  const analyser = entities.find((e) => e.type === 'asset' && e.kind === 'lab');
  let episode = null;
  if (analyser) {
    const done = new Map(events.filter((e) => e.type === 'workorder.completed').map((e) => [e.subject, e.t]));
    const wo = events.filter((e) => e.type === 'asset.fault-reported' && e.subject === analyser.id && e.data?.workOrder && done.has(e.data.workOrder))
      .filter((e) => e.t >= startMs + DAY && done.get(e.data.workOrder) + 10 * MIN < endMs - HOUR).at(-1);
    if (wo) episode = { from: wo.t + 5 * MIN, to: done.get(wo.data.workOrder) + 10 * MIN, reason: 'qc-failed', workOrder: wo.data.workOrder };
    else {
      const from = localDay(endMs - 9 * DAY) + 13 * HOUR;
      if (from > startMs) episode = { from, to: from + 3 * HOUR, reason: 'planned-maintenance', workOrder: null };
    }
  }
  const runsOff = analyser ? EQUIPMENT_KINDS.lab.runs : [];
  const list = [];
  const make = (t, source, extra = {}) => {
    const ed = source.startsWith('dept-');
    const x = { t, source, group: extra.group || r.weighted(GROUP_WEIGHTS), urgency: extra.urgency || (r.chance(ed ? 0.6 : 0.2) ? 'urgent' : 'routine'),
      enc: extra.enc !== undefined ? extra.enc : (!ed && r.chance(0.85) ? encounterAt(source, t) : null), by: ed ? 'ae-nic' : r.chance(0.6) ? 'unit-clerk' : 'ward-nurse', ...extra };
    list.push(x);
    return x;
  };
  for (let d = 0; d < (days || 30) + 1; d++) {
    const day = localDay(startMs) + d * DAY;
    for (const [source, perDay] of sources) {
      const n = Math.max(0, Math.round(perDay + (r.next() - 0.5) * 3));
      for (let i = 0; i < n; i++) {
        const t = day + (r.weighted(source.startsWith('dept-') ? ED_HOURS : WARD_HOURS) + r.next() * 2) * HOUR;
        if (t > startMs + HOUR && t < endMs) make(t, source);
      }
    }
  }
  // Steps for each request. Times in milliseconds; null where the step never happened (yet).
  const steps = (x) => {
    if (r.chance(0.02)) { x.cancel = x.t + r.int(20, 120) * MIN; x.cancelReason = r.pick(['not-needed', 'duplicate', 'patient-moved', 'entered-in-error']); return; }
    const urgent = x.urgency === 'urgent';
    const noCollect = r.chance(x.source.startsWith('dept-') ? 0.08 : 0.04);
    if (!noCollect) {
      x.collect = x.t + Math.max(2, r.lognormal(urgent ? 10 : 25, 0.6)) * MIN;
      x.back = r.weighted([[0, 80], [5, 6], [10, 4], [15, 3], [30, 3], [60, 1]]);
    }
    x.reach = (x.collect || x.t) + Math.max(5, r.lognormal(urgent ? 18 : 40, 0.5)) * MIN + (noCollect ? 20 * MIN : 0);
    const haem = x.source === 'ward-a3' && r.chance(0.1);
    if (!x.recollectionOf && (haem || r.chance(0.03))) {
      x.reason = haem ? 'haemolysed' : r.weighted(OTHER_REASONS);
      x.after = (x.reason === 'haemolysed' || x.reason === 'clotted') && r.chance(0.5);
      if (x.after) x.reject = x.reach + r.int(15, 45) * MIN; else { x.reject = x.reach; x.reach = null; }
      return;
    }
    let rel = x.reach + Math.max(8, r.lognormal(RELEASE_MIN[x.group] * (urgent ? 0.6 : 1), 0.45)) * MIN;
    if (episode && runsOff.includes(x.group) && rel > episode.from && x.reach < episode.to) rel = Math.max(rel, episode.to + r.lognormal(30, 0.4) * MIN);
    x.release = rel;
  };
  for (const x of list) steps(x);
  // Most rejected specimens are collected again, as a new request linked to the rejected one.
  for (const x of [...list]) {
    if (!x.reason || !r.chance(0.85)) continue;
    const y = make(x.reject + r.int(15, 60) * MIN, x.source, { group: x.group, urgency: x.urgency, enc: x.enc, recollectionOf: x });
    steps(y);
  }
  // At the end time: one routine specimen from Ward B1 collected four hours ago and not arrived;
  // and one specimen from Ward A2 received early today with no collection recorded.
  if (has('ward-b1')) make(endMs - 4 * HOUR - 25 * MIN, 'ward-b1', { urgency: 'routine', group: 'blood-count', collect: endMs - 4 * HOUR, back: 0 });
  const early = localDay(endMs) + 7 * HOUR;
  if (has('ward-a2') && early > startMs && early + 2 * HOUR < endMs) make(early, 'ward-a2', { urgency: 'routine', group: 'blood-count', reach: early + 50 * MIN, release: early + 95 * MIN });
  // Haemolysed specimens from Ward A3 in the last six days: at least the example count, so guide rule 3 has something to show.
  if (has('ward-a3')) {
    const recent = list.filter((x) => x.source === 'ward-a3' && x.t > endMs - 6 * DAY && x.t < endMs - 6 * HOUR && !x.recollectionOf && !x.cancel);
    let n = recent.filter((x) => x.reason === 'haemolysed').length;
    for (const x of recent) {
      if (n >= REVIEW_COUNT) break;
      if (x.reason || !x.reach) continue;
      Object.assign(x, { reason: 'haemolysed', after: false, reject: x.reach, reach: null, release: null });
      n += 1;
    }
  }
  // Number in the order the requests were made; then write the events.
  list.sort((a, b) => a.t - b.t);
  list.forEach((x, i) => { x.id = `dx-${String(i + 1).padStart(5, '0')}`; });
  const out = [];
  const push = (t, type, subject, actorRole, data = null) => { if (t != null && t >= startMs && t <= endMs) out.push({ t: Math.round(t), type, subject, actorRole, data }); };
  push(startMs + 10 * MIN, 'diagnostics.guide-set', 'diagnostics-guide', 'diagnostics-manager', { on: true });
  for (const x of list) {
    const recId = x.recollectionOf?.id;
    push(x.t, 'diagnostics.request-made', x.id, x.by, { sourceId: x.source, testGroup: x.group, urgency: x.urgency, ...(x.enc ? { encounter: x.enc } : {}), ...(recId ? { recollectionOf: recId } : {}) });
    if (x.cancel) { push(x.cancel, 'diagnostics.request-cancelled', x.id, x.by, { reason: x.cancelReason }); continue; }
    // A collection is written only once it was recorded (taken time + the minutes it was entered later).
    if (x.collect && x.collect + (x.back || 0) * MIN <= endMs) push(x.collect, 'diagnostics.specimen-collected', x.id, x.source.startsWith('dept-') ? 'ae-nic' : 'ward-nurse', x.back ? { backdatedMinutes: x.back } : null);
    if (x.reach) push(x.reach, 'diagnostics.specimen-received', x.id, 'lab-reception');
    if (x.reject) push(x.reject, 'diagnostics.specimen-rejected', x.id, x.after ? 'lab-scientist' : 'lab-reception', { reason: x.reason, ...(x.after ? { afterReceipt: true } : {}) });
    if (x.release) push(x.release, 'diagnostics.result-validated', x.id, 'lab-scientist');
  }
  if (episode && analyser) {
    push(episode.from, 'diagnostics.equipment-down', analyser.id, 'lab-scientist', { scope: 'all', reason: episode.reason, backup: 'partner-lab', ...(episode.workOrder ? { workOrder: episode.workOrder } : {}), expectedBack: new Date(episode.from + 4 * HOUR).toISOString() });
    push(episode.to, 'diagnostics.equipment-up', analyser.id, 'lab-scientist');
  }
  // A collection entered late is written at its taken time; keep the log in time order with the
  // receipt after it (a receipt may come before a late collection is entered: the receipt then wins).
  return out.sort((a, b) => a.t - b.t);
}
