// Pharmacy operations: pure functions for the screens, the measures and the guide. No screen code,
// no storage and no clock: "now" is always passed in, so the same file runs in the browser, in tests
// and on a site's own server.
//
// A dispensing request is a ward, a kind, a count of items and times. It never holds what was
// prescribed: no medicine names, strengths, doses or notes. "Checked" records only that a pharmacist
// said the check happened at that time; the check itself is done outside Ospeli. Measures count
// requests and stages, never a technician or a pharmacist.

const MIN = 60e3;
const DAY = 864e5;
const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// ---- pick lists (no typed text anywhere) ----
export const KINDS = { discharge: 'Discharge medicines', 'ward-request': 'Ward request', other: 'Other request' };
export const PRIORITIES = { urgent: 'Urgent (ward\'s call)', routine: 'Routine' };
export const PLANNED = { 'this-morning': 'This morning', 'this-afternoon': 'This afternoon', 'this-evening': 'This evening', tomorrow: 'Tomorrow' };
// The time each planned pick means, in minutes after midnight of the day the request was raised
// (site time). Example settings, not a standard: "ready before the planned time" uses them.
export const PLANNED_BY = { 'this-morning': 12 * 60, 'this-afternoon': 17 * 60, 'this-evening': 21 * 60, tomorrow: (24 + 12) * 60 };
export const HOLD_REASONS = {
  'waiting-for-ward': 'Waiting for the ward',
  'not-in-stock': 'Item not in stock',
  'waiting-for-supply': 'Waiting for supply from another store',
};
export const CANCEL_REASONS = {
  'discharge-postponed': 'Discharge postponed',
  'no-longer-needed': 'No longer needed',
  duplicate: 'Duplicate',
  'raised-in-error': 'Raised in error',
};
// A hold placed after Checked for one of these reasons means what goes out may change after the
// pharmacist saw it: on resume the request goes back to Started and waits for Checked again.
export const RECHECK_REASONS = ['not-in-stock', 'waiting-for-supply'];
// The cancel reasons the ward itself may pick (it can cancel its own request without phoning).
export const WARD_CANCEL_REASONS = ['discharge-postponed', 'no-longer-needed', 'raised-in-error'];
export const STAGES = ['raised', 'started', 'checked', 'ready', 'collected'];
export const STATE_WORDS = { raised: 'Raised', started: 'Started', checked: 'Checked', ready: 'Ready', collected: 'Collected', cancelled: 'Cancelled', 'on-hold': 'On hold' };
export const OPEN_STATES = ['raised', 'started', 'checked', 'ready', 'on-hold'];

// Example settings, not standards. Each is shown on screen where it matters.
export const MAX_ITEMS = 30;            // a cap for the form, not a clinical limit
export const UNDO_MINUTES = 10;         // "undo last step" is offered this long after the step
export const DOUBLE_TAP_MINUTES = 2;    // the same new request again within this time is "already saved"
export const WORK_DAY = { from: 8 * 60, to: 18 * 60 }; // an example working day, site time
export const ESTIMATE_LAST = 20;        // the estimate reads this many recent ready requests
export const ESTIMATE_MIN = 5;          // and shows nothing with fewer
export const LATE_HOUR = 12;            // rule 1: a same-day discharge request raised after this hour is late
export const LATE_WINDOW_DAYS = 14;
export const LATE_MIN_REQUESTS = 5;
export const LATE_SHARE = 0.5;          // "most": more than half
export const STALL_MINUTES = 60;        // rule 2: no step for longer than this

export const REQUEST_ID_PATTERN = '^rx-[0-9]{5,}$';
const RX = new RegExp(REQUEST_ID_PATTERN);
const ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const isId = (x) => typeof x === 'string' && x.length <= 64 && ID_RE.test(x);
const ENC = /^enc-[0-9]{6,}$/;

// ---- site time ----
export const localMinuteOfDay = (ms, off = 0) => { const l = ms + off * MIN; return Math.floor((((l % DAY) + DAY) % DAY) / MIN); };
export const localDayStart = (ms, off = 0) => { const l = ms + off * MIN; return l - (((l % DAY) + DAY) % DAY) - off * MIN; };
export const clockText = (ms, off = 0) => { const m = localMinuteOfDay(ms, off); return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; };
export function agoText(minutes) {
  const m = Math.max(0, Math.round(minutes));
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60); const r = m % 60;
  if (h < 24) return r ? `${h} h ${r} min ago` : `${h} h ago`;
  const d = Math.floor(h / 24);
  return d === 1 ? 'yesterday' : `${d} days ago`;
}
// "10:12, 42 min ago" (and the day when it was not today).
export function whenText(ms, nowMs, off = 0) {
  const days = Math.round((localDayStart(nowMs, off) - localDayStart(ms, off)) / DAY);
  const day = days === 0 ? '' : days === 1 ? 'yesterday ' : `${days} days ago at `;
  return days >= 2 ? `${day}${clockText(ms, off)}` : `${day}${clockText(ms, off)}, ${agoText((nowMs - ms) / MIN)}`;
}

// ---- the record, from the event log ----
// A request: { id, wardId, bedId, encounter, kind, priority, planned, items, raisedAt, stage,
// startedAt, checkedAt, readyAt, collectedAt, cancelledAt, cancelReason, held, holdReason, holdSince,
// holds: [{ from, to, reason }], front, frontAt, lastStep: { step, at, role }, lastMoveAt, undone }.
// A step that does not follow from the state is ignored (an edited import cannot skip a stage).
export function deriveRequests(events) {
  const out = new Map();
  for (const e of events) {
    if (typeof e?.type !== 'string' || !e.type.startsWith('pharmacy.request-') && e.type !== 'pharmacy.priority-set' && e.type !== 'pharmacy.step-undone') continue;
    const d = e.data || {};
    if (e.type === 'pharmacy.request-raised') {
      if (!RX.test(String(e.subject)) || out.has(e.subject) || !isId(d.wardId) || !KINDS[d.kind] || !PRIORITIES[d.priority]) continue;
      if (!Number.isInteger(d.items) || d.items < 1 || d.items > MAX_ITEMS) continue;
      out.set(e.subject, {
        id: e.subject, wardId: d.wardId, bedId: isId(d.bedId) ? d.bedId : null, encounter: ENC.test(String(d.encounter || '')) ? d.encounter : null,
        kind: d.kind, priority: d.priority, planned: d.kind === 'discharge' && PLANNED[d.planned] ? d.planned : null, items: d.items,
        raisedAt: e.at, raisedByRole: e.actorRole, stage: 'raised', startedAt: null, checkedAt: null, readyAt: null, collectedAt: null,
        cancelledAt: null, cancelReason: null, cancelledFrom: null, recheck: false, held: false, holdReason: null, holdSince: null, holds: [], front: false, frontAt: null,
        lastStep: { step: 'raised', at: e.at, role: e.actorRole }, lastMoveAt: e.at, undone: 0,
      });
      continue;
    }
    const r = out.get(e.subject);
    if (!r) continue;
    // A closed request takes only an undo of the step that closed it.
    if ((r.stage === 'collected' || r.stage === 'cancelled') && e.type !== 'pharmacy.step-undone') continue;
    const move = (stage, field) => { r.stage = stage; r[field] = e.at; r.lastStep = { step: stage, at: e.at, role: e.actorRole }; r.lastMoveAt = e.at; };
    switch (e.type) {
      case 'pharmacy.request-started': if (r.stage === 'raised' && !r.held) move('started', 'startedAt'); break;
      case 'pharmacy.request-checked': if (r.stage === 'started' && !r.held) { move('checked', 'checkedAt'); r.recheck = false; } break;
      case 'pharmacy.request-ready': if (r.stage === 'checked' && !r.held && !r.recheck) move('ready', 'readyAt'); break;
      case 'pharmacy.request-collected': if (r.stage === 'ready') move('collected', 'collectedAt'); break;
      case 'pharmacy.request-cancelled':
        // What was there before the cancel, exactly (the stage, the hold and its reason), so an undo
        // puts it all back and a hold at Checked for stock or supply still needs a new check.
        r.beforeCancel = { stage: r.stage, held: r.held, holdReason: r.holdReason, holdSince: r.holdSince, holds: r.holds.length, recheck: r.recheck, lastMoveAt: r.lastMoveAt };
        if (r.held) { r.holds.push({ from: r.holdSince, to: e.at, reason: r.holdReason }); r.held = false; r.holdReason = null; r.holdSince = null; }
        r.cancelReason = CANCEL_REASONS[d.reason] ? d.reason : null;
        r.cancelledFrom = r.stage;
        move('cancelled', 'cancelledAt');
        break;
      case 'pharmacy.request-on-hold':
        if (!r.held && ['raised', 'started', 'checked'].includes(r.stage) && HOLD_REASONS[d.reason]) {
          r.held = true; r.holdReason = d.reason; r.holdSince = e.at; r.lastStep = { step: 'on-hold', at: e.at, role: e.actorRole };
        }
        break;
      case 'pharmacy.request-resumed':
        if (r.held) {
          r.holds.push({ from: r.holdSince, to: e.at, reason: r.holdReason });
          // Held after Checked for stock or supply: back to Started, Checked again before Ready. The
          // command writes a correcting event for it; the replay does it too, so no log can skip it.
          if (r.stage === 'checked' && RECHECK_REASONS.includes(r.holdReason)) { r.stage = 'started'; r.checkedAt = null; r.recheck = true; }
          r.held = false; r.holdReason = null; r.holdSince = null; r.lastStep = { step: 'resumed', at: e.at, role: e.actorRole }; r.lastMoveAt = e.at;
        }
        break;
      case 'pharmacy.priority-set': r.front = d.front === true; r.frontAt = r.front ? e.at : null; break;
      case 'pharmacy.step-undone': {
        // A mistaken tap is corrected by a new event, never by changing history: the step's time is
        // cleared and the request goes back one stage. Both events stay in the log.
        // A recheck after a stock or supply hold is written as this event too (reason "recheck"): the
        // replay has already moved the request back, so it changes nothing more.
        const back = { started: ['raised', 'startedAt'], checked: ['started', 'checkedAt'], ready: ['checked', 'readyAt'], collected: ['ready', 'collectedAt'],
          cancelled: [r.cancelledFrom || 'raised', 'cancelledAt'] }[d.step];
        if (!back || r.stage !== d.step || r.held) break;
        r.stage = back[0]; r[back[1]] = null; r.undone += 1;
        if (d.step === 'cancelled') {
          const b = r.beforeCancel;
          if (b) {
            r.holds.length = b.holds; // the hold never ended: it runs on from when it began
            Object.assign(r, { held: b.held, holdReason: b.holdReason, holdSince: b.holdSince, recheck: b.recheck });
          }
          r.cancelReason = null; r.cancelledFrom = null; r.beforeCancel = null;
        }
        r.lastStep = { step: 'undone', at: e.at, role: e.actorRole };
        r.lastMoveAt = e.at;
        break;
      }
      default: break;
    }
  }
  return out;
}
export const stateOf = (r) => (r.held ? 'on-hold' : r.stage);
export const isOpen = (r) => r.stage !== 'collected' && r.stage !== 'cancelled';
export function nextRequestId(events) {
  let n = 0;
  for (const e of events) if (e.type === 'pharmacy.request-raised') { const m = /^rx-([0-9]+)$/.exec(String(e.subject)); if (m) n = Math.max(n, Number(m[1])); }
  return `rx-${String(n + 1).padStart(5, '0')}`;
}

// Minutes on hold between fromMs and toMs (a hold still open counts up to nowMs).
export function heldMinutes(r, fromMs, toMs, nowMs = toMs) {
  let ms = 0;
  const spans = [...r.holds.map((x) => [Date.parse(x.from), Date.parse(x.to)]), ...(r.held ? [[Date.parse(r.holdSince), nowMs]] : [])];
  for (const [a, b] of spans) ms += Math.max(0, Math.min(b, toMs) - Math.max(a, fromMs));
  return ms / MIN;
}
// Minutes from one time to another with time on hold taken out.
export const activeMinutes = (r, fromIso, toIso) => (Date.parse(toIso) - Date.parse(fromIso)) / MIN - heldMinutes(r, Date.parse(fromIso), Date.parse(toIso));

// When the planned pick means, as a time (site time), for a discharge request.
export function plannedByMs(r, off = 0) {
  if (r.kind !== 'discharge' || !r.planned) return null;
  return localDayStart(Date.parse(r.raisedAt), off) + PLANNED_BY[r.planned] * MIN;
}
// A discharge request whose planned time falls today or earlier (site time).
export function dischargeToday(r, nowMs, off = 0) {
  const by = plannedByMs(r, off);
  return by != null && by < localDayStart(nowMs, off) + DAY;
}
export const inWorkDay = (iso, off = 0) => { const m = localMinuteOfDay(Date.parse(iso), off); return m >= WORK_DAY.from && m < WORK_DAY.to; };

// The working order: moved to the front by the manager (in the order moved), then urgent (the
// ward's call), then discharge today (earliest planned time first), then oldest. Ties by id.
export function orderKey(r, nowMs, off = 0) {
  const today = dischargeToday(r, nowMs, off);
  return [r.front ? 0 : 1, r.front ? Date.parse(r.frontAt) : 0, r.priority === 'urgent' ? 0 : 1, today ? 0 : 1, today ? plannedByMs(r, off) : 0, Date.parse(r.raisedAt)];
}
export function sortQueue(list, nowMs, off = 0) {
  const keyed = list.map((r) => [orderKey(r, nowMs, off), r]);
  keyed.sort(([a, x], [b, y]) => { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i]; return x.id < y.id ? -1 : 1; });
  return keyed.map(([, r]) => r);
}
export function orderReason(r, nowMs, off = 0) {
  if (r.front) return 'Moved to the front by the manager';
  if (r.priority === 'urgent') return 'Urgent (ward\'s call)';
  if (dischargeToday(r, nowMs, off)) return `Discharge today: ${PLANNED[r.planned].toLowerCase()}`;
  return 'Oldest first';
}

// The step a request waits for next, and who records it.
export function nextStep(r) {
  if (r.held || !isOpen(r)) return null;
  return { raised: 'start', started: 'check', checked: 'ready', ready: 'collect' }[r.stage] || null;
}
// The last step, if it can still be undone (within UNDO_MINUTES; not while on hold).
export function undoable(r, nowMs) {
  if (r.held || !['started', 'checked', 'ready', 'collected', 'cancelled'].includes(r.stage) || r.lastStep.step !== r.stage) return null;
  return nowMs - Date.parse(r.lastStep.at) <= UNDO_MINUTES * MIN ? r.stage : null;
}

// ---- the estimate on the ward's phone ----
// The median raised → ready time (hold time left out) of the last ESTIMATE_LAST ready requests of
// the same kind on the same ward, added to this request's raise time and its own time on hold so
// far. Fewer than ESTIMATE_MIN: no estimate. Example setting, not a standard; not a promise.
export function estimateFor(all, r, nowMs) {
  if (!isOpen(r) || r.stage === 'ready') return null;
  const sample = [...all.values()].filter((x) => x.id !== r.id && x.wardId === r.wardId && x.kind === r.kind && x.readyAt && Date.parse(x.readyAt) <= nowMs)
    .sort((a, b) => (a.readyAt < b.readyAt ? 1 : -1)).slice(0, ESTIMATE_LAST);
  if (sample.length < ESTIMATE_MIN) return { minutes: null, n: sample.length, atMs: null, late: false };
  const minutes = median(sample.map((x) => activeMinutes(x, x.raisedAt, x.readyAt)));
  const atMs = Date.parse(r.raisedAt) + (heldMinutes(r, Date.parse(r.raisedAt), nowMs, nowMs) + minutes) * MIN;
  return { minutes, n: sample.length, atMs, late: atMs < nowMs };
}

// ---- measures (each recomputed from the log in tests/unit/pharmacy-kpis.test.mjs) ----
const inPeriod = (iso, since, until) => iso != null && iso >= since && iso < until;

// KPI 1. Discharge medicines turnaround: discharge requests that reached Ready in the period
// (cancelled left out): raised → ready in clock minutes, minus time on hold. The headline median is of
// requests raised inside the example working day; those raised outside it are shown apart.
export function dischargeTurnaround(all, { since, until, offsetMinutes = 0 }) {
  const sel = [...all.values()].filter((r) => r.kind === 'discharge' && r.stage !== 'cancelled' && inPeriod(r.readyAt, since, until));
  const rows = sel.map((r) => ({ r, minutes: activeMinutes(r, r.raisedAt, r.readyAt), held: heldMinutes(r, Date.parse(r.raisedAt), Date.parse(r.readyAt)), inHours: inWorkDay(r.raisedAt, offsetMinutes) }));
  const main = rows.filter((x) => x.inHours);
  const outside = rows.filter((x) => !x.inHours);
  const heldRows = rows.filter((x) => x.held > 0);
  const byPlanned = Object.entries(PLANNED).map(([id, word]) => { const xs = rows.filter((x) => x.r.planned === id); return { id, name: word, value: median(xs.map((x) => x.minutes)), n: xs.length }; });
  const wards = [...new Set(rows.map((x) => x.r.wardId))].sort();
  const byWard = wards.map((w) => { const xs = rows.filter((x) => x.r.wardId === w); return { wardId: w, value: median(xs.map((x) => x.minutes)), n: xs.length }; });
  const before = rows.filter((x) => Date.parse(x.r.readyAt) <= plannedByMs(x.r, offsetMinutes)).length;
  return {
    value: median(main.map((x) => x.minutes)), n: main.length, numerator: null, denominator: null,
    outsideWorkDay: { value: median(outside.map((x) => x.minutes)), n: outside.length },
    hold: { value: median(heldRows.map((x) => x.held)), n: heldRows.length },
    readyBeforePlanned: { numerator: before, denominator: rows.length },
    byPlanned, byWard, all: rows.length,
  };
}

// KPI 2. Time by stage: raised → started, started → checked, checked → ready, median minutes each
// with time on hold taken out, for steps recorded in the period. Cancelled requests left out.
export const STAGE_PAIRS = [
  { id: 'raised-started', name: 'Raised to started', from: 'raisedAt', to: 'startedAt' },
  { id: 'started-checked', name: 'Started to checked', from: 'startedAt', to: 'checkedAt' },
  { id: 'checked-ready', name: 'Checked to ready', from: 'checkedAt', to: 'readyAt' },
];
export function stageTimes(all, { since, until }) {
  const list = [...all.values()].filter((r) => r.stage !== 'cancelled');
  const stages = STAGE_PAIRS.map((p) => {
    const xs = list.filter((r) => r[p.from] && inPeriod(r[p.to], since, until)).map((r) => activeMinutes(r, r[p.from], r[p.to]));
    return { id: p.id, name: p.name, value: median(xs), n: xs.length };
  });
  const known = stages.filter((s) => s.value != null);
  const longest = known.length ? known.reduce((a, b) => (b.value > a.value ? b : a)) : null;
  return { value: longest ? longest.value : null, longest: longest ? longest.id : null, n: stages.reduce((s, x) => s + x.n, 0), numerator: null, denominator: null, stages };
}

// KPI 3. Collection wait: ready → collected, median minutes, for requests collected in the period.
export function collectionWait(all, { since, until }) {
  const xs = [...all.values()].filter((r) => r.stage === 'collected' && inPeriod(r.collectedAt, since, until)).map((r) => (Date.parse(r.collectedAt) - Date.parse(r.readyAt)) / MIN);
  return { value: median(xs), n: xs.length, numerator: null, denominator: null };
}

// ---- the guide: two fixed rules (not a model). They suggest; a person decides. ----
export const GUIDE_RULES = [
  { id: 'late-requests', name: 'Late discharge requests',
    basis: `Example setting, not a standard: over the last ${LATE_WINDOW_DAYS} days, more than half of a ward's same-day discharge requests (at least ${LATE_MIN_REQUESTS}) were raised after ${LATE_HOUR}:00 site time. Advice for the ward only; the ward decides when to ask.` },
  { id: 'waiting-too-long', name: 'Discharge request waiting too long',
    basis: `Example setting, not a standard: a discharge request planned for today has had no step for more than ${STALL_MINUTES} minutes and is not on hold. It flags the request and its stage, never a person.` },
];
const BASIS = Object.fromEntries(GUIDE_RULES.map((r) => [r.id, r.basis]));
export function guideOn(events) {
  let on = true;
  for (const e of events) if (e.type === 'pharmacy.guide-set' && typeof e.data?.on === 'boolean') on = e.data.on;
  return on;
}

// Rule 1. wardName(id) -> plain name. Wards with suggestions, most late first.
export function ruleLateRequests(all, { nowMs, offsetMinutes = 0, wardName = (x) => x }) {
  const since = nowMs - LATE_WINDOW_DAYS * DAY;
  const byWard = new Map();
  for (const r of all.values()) {
    if (r.kind !== 'discharge' || r.planned === 'tomorrow' || !r.planned) continue;
    const t = Date.parse(r.raisedAt);
    if (t < since || t > nowMs) continue;
    if (!byWard.has(r.wardId)) byWard.set(r.wardId, []);
    byWard.get(r.wardId).push(r);
  }
  const out = [];
  for (const [w, list] of byWard) {
    const late = list.filter((r) => localMinuteOfDay(Date.parse(r.raisedAt), offsetMinutes) >= LATE_HOUR * 60);
    if (list.length < LATE_MIN_REQUESTS || late.length / list.length <= LATE_SHARE) continue;
    const times = list.sort((a, b) => (a.raisedAt < b.raisedAt ? -1 : 1)).slice(-10).map((r) => clockText(Date.parse(r.raisedAt), offsetMinutes));
    out.push({ rule: 'late-requests', id: `late-requests:${w}`, wardId: w, late: late.length, of: list.length,
      text: `${wardName(w)}: ${late.length} of ${list.length} same-day discharge requests in the last ${LATE_WINDOW_DAYS} days were raised after ${LATE_HOUR}:00.`,
      why: `Suggest the ward asks earlier, for example after the morning round. Recent request times: ${times.join(', ')}.`, times, basis: BASIS['late-requests'], action: null });
  }
  return out.sort((a, b) => b.late / b.of - a.late / a.of || (a.wardId < b.wardId ? -1 : 1));
}

// Rule 2. label(r) -> "Ward A2, Bed 04". Longest without a step first.
export function ruleWaitingTooLong(all, { nowMs, offsetMinutes = 0, label = (r) => r.id }) {
  const out = [];
  for (const r of all.values()) {
    if (r.kind !== 'discharge' || r.held || !['raised', 'started', 'checked'].includes(r.stage) || !dischargeToday(r, nowMs, offsetMinutes)) continue;
    const minutes = Math.floor((nowMs - Date.parse(r.lastMoveAt)) / MIN);
    if (minutes <= STALL_MINUTES) continue;
    const waitFor = { raised: 'Start', started: 'Checked', checked: 'Ready' }[r.stage];
    out.push({ rule: 'waiting-too-long', id: `waiting-too-long:${r.id}`, requestId: r.id, wardId: r.wardId, stage: r.stage, minutes,
      text: `${label(r)}: discharge ${PLANNED[r.planned].toLowerCase()}, no step for ${minutes} min (${STATE_WORDS[r.stage]}, waiting for ${waitFor}).`,
      why: `Planned for today and no step for more than ${STALL_MINUTES} minutes. See where it is; Ospeli does not say why.`, basis: BASIS['waiting-too-long'], action: null });
  }
  return out.sort((a, b) => b.minutes - a.minutes || (a.requestId < b.requestId ? -1 : 1));
}

// ---- which screens a role has, and where an agent's proposal is decided (ospeli/ospeli#148) ----
// Plain data and rules, no screen code. Kept here rather than in a screens.js so the module's files
// stay the four the offline list already holds; the shell's "Waiting for your decision" list
// (modules/screens.js) can import screensFor and shownOn from this file.
export const SCREEN_TITLES = { queue: 'Dispensing queue', discharge: 'Discharge medicines', summary: 'Turnaround' };
export const TITLES = SCREEN_TITLES; // the name the shell's "Waiting for your decision" reads (modules/proposals.js)
export function screensFor(role) {
  if (role === 'pharmacy-technician' || role === 'pharmacist') return ['queue', 'discharge', 'summary'];
  if (role === 'pharmacy-manager') return ['summary', 'queue', 'discharge'];
  if (role === 'ward-nurse' || role === 'bed-manager') return ['discharge', 'queue', 'summary'];
  return ['queue', 'discharge', 'summary'];
}
// The screens whose card shows this proposal, best first: a new request where the ward asks and on
// the queue; a collection also on the ward's screen; every other step on the queue and Turnaround.
export function shownOn(p) {
  const c = p.command;
  if (!/^ospeli_pharmacy_/.test(c)) return [];
  if (c === 'ospeli_pharmacy_request_raise') return ['discharge', 'queue'];
  if (c === 'ospeli_pharmacy_request_collect') return ['queue', 'discharge', 'summary'];
  return ['queue', 'summary'];
}
