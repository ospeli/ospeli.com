// Diagnostics (area A5): pure functions for the screens and the measures. No screen code, no
// storage, no clock: `now` is passed in. Everything is derived from the event log.
//
// Operations only. A request is a code and a few picks: no result value, no reference range, no
// choice of test, no clinical priority (urgency is the requester's pick, recorded). A step is a time
// and the role that recorded it, never a person. Nothing here calls a model.
//
// Slice 1 is the laboratory path: request made, specimen collected, received at the lab (or
// rejected with a picked reason), result released (the time only). One specimen per request.
// Analyser and scanner down and back are held in this module's own events until the core has a
// shared asset in-service / out-of-service pair (brief A5, Shared objects).
import { isId, median, MIN, HOUR, DAY } from '../../core/kit.js';

// ---- pick lists (example lists, not a standard: a site sets its own) ----
export const TEST_GROUPS = {
  'blood-count': 'Blood count',
  chemistry: 'Blood chemistry',
  coagulation: 'Clotting tests',
  urine: 'Urine tests',
  culture: 'Blood culture',
};
export const URGENCIES = { urgent: 'Urgent', routine: 'Routine' };
export const URGENCY_LABEL = 'Urgency (set by requester)';
// The lab sets its acceptance criteria; Ospeli records the reason a person picked (Domain lead, 21 Nov).
export const REJECT_REASONS = {
  unlabelled: 'Unlabelled',
  'label-mismatch': 'Label does not match request',
  'wrong-container': 'Wrong container or tube',
  'too-little': 'Too little',
  clotted: 'Clotted',
  haemolysed: 'Haemolysed',
  leaked: 'Leaked or broken',
  'too-old': 'Too old on arrival',
  'not-sent-as-required': 'Not sent as required (for example temperature or protection from light)',
  'no-request': 'No request with it',
  duplicate: 'Duplicate',
  other: 'Other',
};
export const REJECT_HEADING = 'By your lab\'s acceptance criteria';
export const CANCEL_REASONS = {
  'not-needed': 'No longer needed',
  duplicate: 'Asked for twice',
  'patient-moved': 'Patient left or moved',
  'entered-in-error': 'Entered in error',
};
export const UNDO_REASONS = { 'tapped-by-mistake': 'Tapped by mistake', 'wrong-request': 'Tapped the wrong request' };
// How long before now a collection may be recorded (minutes). 0 = now. Never in the future.
export const AGO_MINUTES = [0, 5, 10, 15, 30, 60];
export const agoText = (m) => (m === 0 ? 'Now' : `${m} min ago`);

// ---- example settings, not a standard ----
export const LATE_ENTRY_MINUTES = 15;   // "entered late": recorded more than this after it happened
export const NOT_ARRIVED_MINUTES = { urgent: 60, routine: 180 }; // guide rule 1, from collection
export const REVIEW_COUNT = 3;          // guide rule 3: rejections for one reason from one area
export const REVIEW_DAYS = 7;
export const MIN_AREA = 10;             // fewer specimens than this from an area: counts, not a percentage
export const UNDO_MINUTES = 5;          // a receipt or rejection may be undone this long after (the screen offers it for 10 seconds)
export const AGAIN_MINUTES = 2;         // the same request again within this time is a double tap
export const SCHEDULED_HOURS_PER_DAY = 24; // scheduled hours per analyser or scanner, every day
export const EXPECTED_HOURS = [1, 2, 4, 8, 24];

export const STAGES = {
  requested: 'Not collected',
  collected: 'Collected, on the way',
  received: 'Received at lab',
  released: 'Result released',
  rejected: 'Rejected',
  cancelled: 'Cancelled',
};
export const RELEASED_DEFINITION = '"Result released" is the time the lab released the result. Ospeli holds the time only, never the result.';

// ---- equipment: what each kind of asset is called, runs, and how it goes down ----
export const EQUIPMENT_KINDS = {
  lab: {
    word: 'Analyser', place: 'dept-laboratory',
    // The test groups an analyser of this kind runs: an example setting; a site lists its own.
    runs: ['chemistry', 'urine'],
    reasons: { breakdown: 'Breakdown', 'planned-maintenance': 'Planned maintenance', 'qc-failed': 'Quality control failed or recalibrating', 'no-reagent': 'No reagent or consumable', 'no-power-it': 'No power or IT link' },
    backups: { 'other-analyser': 'Send to: the other analyser in this lab', 'partner-lab': 'Send to: the partner laboratory, by the usual transport', hold: 'Hold samples in the lab until it is back', none: 'No backup route' },
    roles: ['lab-scientist', 'diagnostics-manager'],
  },
  imaging: {
    word: 'Scanner', place: 'dept-imaging',
    runs: [],
    reasons: { breakdown: 'Breakdown', 'planned-maintenance': 'Planned maintenance', 'qc-failed': 'Quality check failed or recalibrating', 'no-power-it': 'No power or IT link' },
    backups: { 'other-room': 'Send to: the other X-ray room', 'other-site': 'Send to: imaging at another site, by the usual transport', 'mobile-unit': 'Use the mobile X-ray unit', none: 'No backup route' },
    roles: ['radiographer', 'diagnostics-manager'],
  },
};
export const EQUIPMENT_STATES = { up: 'Working', down: 'Down', 'partly-down': 'Partly down' };
export const isEquipment = (asset) => !!(asset && asset.type === 'asset' && EQUIPMENT_KINDS[asset.kind]);

const ms = (iso) => Date.parse(iso);
const pad = (n, w = 5) => String(n).padStart(w, '0');

// ---- ids and labels ----
export const REQUEST_ID = '^dx-[0-9]{5,}$';
const REQUEST_RE = new RegExp(REQUEST_ID);
const ENC_RE = /^enc-[0-9]{1,9}$/;
export function nextRequestId(events) {
  let n = 0;
  for (const e of events) if (e.type === 'diagnostics.request-made' && REQUEST_RE.test(e.subject)) n = Math.max(n, Number(e.subject.slice(3)));
  return `dx-${pad(n + 1)}`;
}
// What a person sees: "Patient 123" when the request carries an encounter, else the request number.
export function codeParts(r) {
  if (r.encounter) return { lead: 'Patient ', digits: String(r.encounter).replace(/^enc-0*/, '') || '0' };
  return { lead: 'Request ', digits: String(r.id).replace(/^dx-0*/, '') || '0' };
}
export const codeLabel = (r) => { const p = codeParts(r); return `${p.lead}${p.digits}`; };

// ---- the requests ----
// Each request has at most one collection and one receipt or rejection (brief A5: a rejected
// request is final; a recollection is a new request with recollectionOf). A rejection after receipt
// (found by a scientist) is allowed and makes it rejected. An undo removes the last receipt or
// rejection; both stay in the log. Events are read in log order. Picks that are not on the lists and
// ids that are not an id's shape are dropped, so an edited import never shows a sentence (#138).
export function deriveRequests(events) {
  const reqs = new Map();
  for (const e of events) {
    if (!e.type?.startsWith('diagnostics.') || !REQUEST_RE.test(e.subject || '')) continue;
    const d = e.data || {};
    if (e.type === 'diagnostics.request-made') {
      if (reqs.has(e.subject) || !isId(d.sourceId) || !TEST_GROUPS[d.testGroup] || !URGENCIES[d.urgency]) continue;
      reqs.set(e.subject, {
        id: e.subject, sourceId: d.sourceId, testGroup: d.testGroup, urgency: d.urgency,
        encounter: typeof d.encounter === 'string' && ENC_RE.test(d.encounter) ? d.encounter : null,
        recollectionOf: typeof d.recollectionOf === 'string' && REQUEST_RE.test(d.recollectionOf) ? d.recollectionOf : null, recollectedBy: null,
        madeAt: e.at, madeByRole: e.actorRole, state: 'requested',
        collectedAt: null, collectedRecordedAt: null, collectedByRole: null, backdatedMinutes: 0,
        receivedAt: null, receivedByRole: null, rejectedAt: null, rejectedByRole: null, rejectReason: null, rejectedAfterReceipt: false,
        releasedAt: null, releasedByRole: null, cancelledAt: null, cancelReason: null, cancelledByRole: null, undone: 0, lastStepAt: e.at,
      });
      continue;
    }
    const r = reqs.get(e.subject);
    if (!r) continue;
    switch (e.type) {
      case 'diagnostics.specimen-collected': {
        if (r.state !== 'requested') break;
        const back = AGO_MINUTES.includes(d.backdatedMinutes) ? d.backdatedMinutes : 0;
        Object.assign(r, { state: 'collected', collectedAt: e.at, collectedRecordedAt: new Date(ms(e.at) + back * MIN).toISOString(), collectedByRole: e.actorRole, backdatedMinutes: back, lastStepAt: e.at });
        break;
      }
      case 'diagnostics.specimen-received':
        if (r.state !== 'requested' && r.state !== 'collected') break;
        Object.assign(r, { state: 'received', receivedAt: e.at, receivedByRole: e.actorRole, lastStepAt: e.at });
        break;
      case 'diagnostics.specimen-rejected': {
        if (!REJECT_REASONS[d.reason]) break;
        const after = r.state === 'received';
        if (!after && r.state !== 'requested' && r.state !== 'collected') break;
        Object.assign(r, { state: 'rejected', rejectedAt: e.at, rejectedByRole: e.actorRole, rejectReason: d.reason, rejectedAfterReceipt: after, lastStepAt: e.at });
        break;
      }
      case 'diagnostics.specimen-undone':
        if (r.state === 'rejected') {
          Object.assign(r, { state: r.rejectedAfterReceipt ? 'received' : r.collectedAt ? 'collected' : 'requested', rejectedAt: null, rejectedByRole: null, rejectReason: null, rejectedAfterReceipt: false });
        } else if (r.state === 'received') {
          Object.assign(r, { state: r.collectedAt ? 'collected' : 'requested', receivedAt: null, receivedByRole: null });
        } else break;
        r.undone += 1;
        r.lastStepAt = r.receivedAt || r.collectedAt || r.madeAt;
        break;
      case 'diagnostics.result-validated':
        if (r.state !== 'received') break;
        Object.assign(r, { state: 'released', releasedAt: e.at, releasedByRole: e.actorRole, lastStepAt: e.at });
        break;
      case 'diagnostics.request-cancelled':
        if ((r.state !== 'requested' && r.state !== 'collected') || !CANCEL_REASONS[d.reason]) break;
        Object.assign(r, { state: 'cancelled', cancelledAt: e.at, cancelReason: d.reason, cancelledByRole: e.actorRole, lastStepAt: e.at });
        break;
      default:
    }
  }
  for (const r of reqs.values()) {
    const first = r.recollectionOf ? reqs.get(r.recollectionOf) : null;
    if (first && !first.recollectedBy) first.recollectedBy = r.id;
  }
  return reqs;
}
export const isOpen = (r) => r.state === 'requested' || r.state === 'collected' || r.state === 'received';
export const reachedLab = (r) => r.receivedAt || (r.state === 'rejected' ? r.rejectedAt : null);
// Received with no collection time: the bag reached the lab but nobody recorded the collection.
export const noCollection = (r) => !r.collectedAt && !!reachedLab(r);
export const enteredLate = (r) => !!r.collectedAt && r.backdatedMinutes > LATE_ENTRY_MINUTES;
// Minutes in the current step, to now (or to the end, once finished).
export function minutesInStep(r, now) {
  const end = r.state === 'released' || r.state === 'rejected' || r.state === 'cancelled' ? ms(r.lastStepAt) : ms(now);
  return Math.max(0, Math.round((end - ms(r.lastStepAt)) / MIN));
}
export const minutesSinceCollection = (r, now) => (r.collectedAt ? Math.max(0, Math.round((ms(now) - ms(r.collectedAt)) / MIN)) : null);

// ---- equipment status ----
// One state per asset: up (no event yet, or back), down, or partly down (some test groups off).
// Each episode keeps its start and end, for availability.
export function deriveEquipment(events) {
  const eq = new Map();
  const get = (id) => {
    if (!eq.has(id)) eq.set(id, { assetId: id, state: 'up', since: null, reason: null, testGroups: [], workOrder: null, expectedBack: null, expectedSetAt: null, backup: null, byRole: null, episodes: [] });
    return eq.get(id);
  };
  for (const e of events) {
    if (e.type !== 'diagnostics.equipment-down' && e.type !== 'diagnostics.equipment-up') continue;
    if (!isId(e.subject)) continue;
    const d = e.data || {};
    if (e.type === 'diagnostics.equipment-down') {
      const scope = d.scope === 'part' ? 'partly-down' : 'down';
      if (typeof d.reason !== 'string' || !isId(d.reason) || typeof d.backup !== 'string' || !isId(d.backup)) continue;
      const x = get(e.subject);
      if (x.state !== 'up') continue;
      const groups = Array.isArray(d.testGroups) ? d.testGroups.filter((g) => TEST_GROUPS[g]) : [];
      const ep = { from: e.at, to: null, scope, reason: d.reason, testGroups: groups, workOrder: isId(d.workOrder) ? d.workOrder : null, backup: d.backup };
      x.episodes.push(ep);
      Object.assign(x, { state: scope, since: e.at, reason: d.reason, testGroups: groups, workOrder: ep.workOrder,
        expectedBack: typeof d.expectedBack === 'string' && !Number.isNaN(ms(d.expectedBack)) ? d.expectedBack : null, expectedSetAt: e.at, backup: d.backup, byRole: e.actorRole });
    } else {
      const x = get(e.subject);
      if (x.state === 'up') continue;
      x.episodes.at(-1).to = e.at;
      Object.assign(x, { state: 'up', since: e.at, reason: null, testGroups: [], workOrder: null, expectedBack: null, expectedSetAt: null, backup: null, byRole: e.actorRole });
    }
  }
  return eq;
}
// The test groups an analyser cannot run now: all it runs when down, the picked ones when partly down.
export function groupsOff(x, kind) {
  if (!x || x.state === 'up') return [];
  const runs = EQUIPMENT_KINDS[kind]?.runs || [];
  return x.state === 'down' ? runs : x.testGroups.filter((g) => runs.includes(g));
}

export function guideOn(events) {
  let on = true;
  for (const e of events) if (e.type === 'diagnostics.guide-set' && typeof e.data?.on === 'boolean') on = e.data.on;
  return on;
}

// ---- measures ----
// Nearest-rank percentile: the value at rank ceil(p * n) in the sorted list.
export function percentile(xs, p) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.max(0, Math.ceil(p * s.length) - 1)];
}
const inPeriod = (at, since, until) => !!at && (!since || at >= since) && (!until || at < until);

// KPI 1. Laboratory turnaround time: received at lab -> result released, minutes, for requests whose
// result was released in the period. Rejected and cancelled requests never reach "released".
export function labTurnaround(reqs, { since, until, testGroup = null, urgency = null } = {}) {
  const mins = [];
  for (const r of reqs.values()) {
    if (r.state !== 'released' || !r.receivedAt || !inPeriod(r.releasedAt, since, until)) continue;
    if (testGroup && r.testGroup !== testGroup) continue;
    if (urgency && r.urgency !== urgency) continue;
    mins.push((ms(r.releasedAt) - ms(r.receivedAt)) / MIN);
  }
  const round = (x) => (x == null ? null : Math.round(x));
  return { value: round(median(mins)), median: round(median(mins)), p90: round(percentile(mins, 0.9)), n: mins.length, numerator: null, denominator: null };
}

// KPI 2. Specimen rejection rate: rejected / (received + rejected), for specimens that reached the
// lab in the period (by the time of the receipt, or of the rejection when never received). A
// specimen rejected after receipt counts as rejected only.
export function rejectionRate(reqs, { since, until, sourceId = null, reason = null } = {}) {
  let rejected = 0; let reached = 0;
  for (const r of reqs.values()) {
    const at = r.state === 'rejected' ? r.rejectedAt : r.receivedAt;
    if (!at || !inPeriod(at, since, until)) continue;
    if (sourceId && r.sourceId !== sourceId) continue;
    reached += 1;
    if (r.state === 'rejected' && (!reason || r.rejectReason === reason)) rejected += 1;
  }
  return { value: reached ? (100 * rejected) / reached : null, numerator: rejected, denominator: reached, n: reached };
}

// KPI 3. Equipment availability (KPI dictionary D-12): in-service hours / scheduled hours in the
// period, per asset. Scheduled hours: SCHEDULED_HOURS_PER_DAY every day (example setting). Partly
// down counts as in service (some test groups still run) and is shown apart. Downtime is the inverse.
export function equipmentAvailability(x, { since, until, hoursPerDay = SCHEDULED_HOURS_PER_DAY } = {}) {
  const a = ms(since); const b = ms(until);
  const scheduled = ((b - a) / HOUR) * (hoursPerDay / 24);
  let down = 0; let part = 0;
  for (const ep of x?.episodes || []) {
    const from = Math.max(a, ms(ep.from)); const to = Math.min(b, ep.to ? ms(ep.to) : b);
    if (to <= from) continue;
    const hrs = ((to - from) / HOUR) * (hoursPerDay / 24);
    if (ep.scope === 'down') down += hrs; else part += hrs;
  }
  const r1 = (v) => Math.round(v * 10) / 10;
  return { value: scheduled ? r1((100 * (scheduled - down)) / scheduled) : null, numerator: r1(scheduled - down), denominator: r1(scheduled),
    downHours: r1(down), partHours: r1(part), downtimePct: scheduled ? r1((100 * down) / scheduled) : null };
}

// Data completeness (KPI dictionary D-21): requests finished in the period (result released, or
// rejected) with every required step timed, out of requests finished in the period. Required steps:
// request made, specimen collected, received or rejected, and result released for a released one.
export const REQUIRED_STEPS = ['request-made', 'specimen-collected', 'specimen-received or specimen-rejected', 'result-validated (released requests)'];
export function completeness(reqs, { since, until, sourceId = null } = {}) {
  let done = 0; let full = 0;
  for (const r of reqs.values()) {
    const end = r.state === 'released' ? r.releasedAt : r.state === 'rejected' ? r.rejectedAt : null;
    if (!end || !inPeriod(end, since, until) || (sourceId && r.sourceId !== sourceId)) continue;
    done += 1;
    if (r.madeAt && r.collectedAt && reachedLab(r)) full += 1;
  }
  return { value: done ? (100 * full) / done : null, numerator: full, denominator: done, n: done };
}
// Records with a missing or late step, for requests that reached the lab in the period.
export function missingSteps(reqs, { since, until, sourceId = null } = {}) {
  let none = 0; let late = 0;
  for (const r of reqs.values()) {
    const at = reachedLab(r);
    if (!at || !inPeriod(at, since, until) || (sourceId && r.sourceId !== sourceId)) continue;
    if (noCollection(r)) none += 1;
    if (enteredLate(r)) late += 1;
  }
  return { noCollection: none, enteredLate: late };
}

// ---- guide rules: fixed rules, not a model. They suggest; a person decides. ----
export const GUIDE_RULES = [
  { id: 'not-arrived', name: 'Collected but not received at the lab',
    basis: `Example setting, not a standard: ${NOT_ARRIVED_MINUTES.urgent} minutes after collection for urgent, ${NOT_ARRIVED_MINUTES.routine} for routine (urgency as set by the requester). The time starts when the collection was recorded as taken, never when the request was made. It works only when wards record the collection: the count of specimens received with no collection time shows when it is going blind.` },
  { id: 'equipment-down', name: 'An analyser or scanner is down',
    basis: 'Example setting, not a standard: an analyser marked down or partly down is shown on every ward with open requests for the test groups it runs (the list each analyser runs is an example setting, set by the site), with the backup route the lab picked. Nothing is sent outside Ospeli.' },
  { id: 'rejection-review', name: 'Rejections for one reason from one area',
    basis: `Example setting, not a standard: a plain count, ${REVIEW_COUNT} or more specimens rejected for the same reason from the same area in ${REVIEW_DAYS} days. It is not a statistical test of "higher than usual". Advice only: the review is for the lab and that area to arrange.` },
];
const BASIS = Object.fromEntries(GUIDE_RULES.map((r) => [r.id, r.basis]));

// Rule 1. Collected and not received within the example time for its urgency.
export function ruleNotArrived(reqs, { now, nameOf = (x) => x }) {
  const t = ms(now);
  const out = [];
  for (const r of reqs.values()) {
    if (r.state !== 'collected') continue;
    const limit = NOT_ARRIVED_MINUTES[r.urgency];
    const mins = Math.round((t - ms(r.collectedAt)) / MIN);
    if (mins < limit) continue;
    out.push({ rule: 'not-arrived', id: `not-arrived:${r.id}`, requestId: r.id, sourceId: r.sourceId,
      text: `${codeLabel(r)} from ${nameOf(r.sourceId)}: not arrived. Check where it is.`,
      why: `Collected ${mins} min ago (${URGENCIES[r.urgency].toLowerCase()}, as set by the requester) and not received at the lab; the example time is ${limit} min.`,
      basis: BASIS['not-arrived'], action: null });
  }
  return out.sort((a, b) => (a.requestId < b.requestId ? -1 : 1));
}
// Rule 2. An analyser down or partly down: each ward or area with open requests for a test group it cannot run now.
// equipment: [{ assetId, kind, name, x }] for each analyser or scanner on this site.
export function ruleEquipmentDown(reqs, equipment, { nameOf = (x) => x, backupText = () => '', offsetMinutes = 0 }) {
  const out = [];
  for (const { assetId, kind, name, x } of equipment) {
    const off = groupsOff(x, kind);
    if (!off.length) continue;
    const by = new Map();
    for (const r of reqs.values()) {
      if (!isOpen(r) || r.state === 'received' || !off.includes(r.testGroup)) continue;
      by.set(r.sourceId, [...(by.get(r.sourceId) || []), r]);
    }
    for (const [sourceId, list] of [...by].sort((a, b) => b[1].length - a[1].length || (a[0] < b[0] ? -1 : 1))) {
      const groups = [...new Set(list.map((r) => TEST_GROUPS[r.testGroup].toLowerCase()))].join(' and ');
      out.push({ rule: 'equipment-down', id: `equipment-down:${assetId}:${sourceId}`, assetId, sourceId, requestIds: list.map((r) => r.id),
        text: `${name} is ${x.state === 'down' ? 'down' : 'partly down'}: ${list.length} open ${groups} ${list.length === 1 ? 'request' : 'requests'} from ${nameOf(sourceId)}. ${backupText(kind, x.backup)}.`,
        why: `Marked ${EQUIPMENT_STATES[x.state].toLowerCase()} at ${clockText(x.since, offsetMinutes)}${x.state === 'partly-down' ? ` (off: ${off.map((g) => TEST_GROUPS[g].toLowerCase()).join(', ')})` : ''}; the backup route was picked when it was marked.`,
        basis: BASIS['equipment-down'], action: null });
    }
  }
  return out;
}
// Rule 3. The same rejection reason from the same area, REVIEW_COUNT or more times in REVIEW_DAYS days.
export function ruleRejectionReview(reqs, { now, nameOf = (x) => x }) {
  const t = ms(now);
  const by = new Map();
  for (const r of reqs.values()) {
    if (r.state !== 'rejected' || ms(r.rejectedAt) > t || t - ms(r.rejectedAt) > REVIEW_DAYS * DAY) continue;
    const k = `${r.sourceId}|${r.rejectReason}`;
    by.set(k, [...(by.get(k) || []), r]);
  }
  return [...by].filter(([, list]) => list.length >= REVIEW_COUNT).map(([k, list]) => {
    const [sourceId, reason] = k.split('|');
    return { rule: 'rejection-review', id: `rejection-review:${sourceId}:${reason}`, sourceId, reason, count: list.length,
      text: `Suggest a short review with ${nameOf(sourceId)}: "${REJECT_REASONS[reason]}" ${list.length} times in ${REVIEW_DAYS} days.`,
      why: `${list.length} specimens from ${nameOf(sourceId)} rejected as "${REJECT_REASONS[reason]}" in the last ${REVIEW_DAYS} days (example count ${REVIEW_COUNT}).`,
      basis: BASIS['rejection-review'], action: null };
  }).sort((a, b) => b.count - a.count || (a.id < b.id ? -1 : 1));
}

// ---- local time ----
export const localStartOfDay = (now, offsetMinutes = 0) => {
  const l = ms(now) + offsetMinutes * MIN;
  return new Date(l - (((l % DAY) + DAY) % DAY) - offsetMinutes * MIN).toISOString();
};
export const clockText = (iso, offsetMinutes = 0) => (iso ? new Date(ms(iso) + offsetMinutes * MIN).toISOString().slice(11, 16) : null);
export const localHour = (iso, offsetMinutes = 0) => new Date(ms(iso) + offsetMinutes * MIN).getUTCHours();
