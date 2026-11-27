// Facilities and utilities: the module's fixed lists and its pure functions. Everything here reads
// the event log (and the place and asset lists passed in) and nothing else: no screen, no storage,
// no clock (the caller passes `now`), so the schedule, the KPIs and the guide give the same answer
// in the browser, in a test and on a site's own server.
//
// Operations only. A check here records that a check was done, what was picked and by which role;
// it never says that a supply is safe for patients, raises no alarm and switches no plant.
// Measure flows, never people: no number here counts or ranks a member of staff.

import { deriveWorkOrders, REPEAT_WINDOW_DAYS } from '../../core/workorders.js';
import { isId } from '../../core/kit.js';

const MIN = 60e3;
const HOUR = 3600e3;
const DAY = 864e5;
const ms = (iso) => Date.parse(iso);
const iso = (t) => new Date(t).toISOString();

// ---- what can be checked (pick lists only: nothing is typed) ----
export const RESULTS = { pass: 'Pass', fail: 'Fail' };
export const RUN_MINUTES = [15, 30, 60]; // 60 means "60 minutes or more"
export const runText = (m) => (m >= 60 ? '60 min or more' : `${m} min`);
export const LEVELS = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100]; // per cent, a reading from a gauge picked to the nearest 10
export const GAS_BANDS = {
  high: 'More than half',
  half: 'About half',
  low: 'Low: at the reorder mark',
  reserve: 'Running on the reserve supply',
};
const TECH = ['estates-tech', 'facilities-manager'];
const ANY_FACILITIES = ['estates-tech', 'facilities-assistant', 'facilities-manager'];
// Who may record each kind of check. A generator test or a medical gas check is signed by trained
// facilities staff; a fuel or water reading may also be taken by the facilities assistant.
export const CHECK_KINDS = {
  'generator-test': { name: 'Generator test', target: 'asset', assetKind: 'generator', needs: ['result', 'runMinutes'], roles: TECH },
  'fuel-level': { name: 'Fuel level', target: 'asset', assetKind: 'generator', needs: ['levelPct'], roles: ANY_FACILITIES },
  'water-level': { name: 'Water storage', target: 'place', needs: ['levelPct'], roles: ANY_FACILITIES },
  'gas-check': { name: 'Medical gas check', target: 'place', needs: ['result', 'levelBand'], roles: TECH },
};
export const CHECK_FIELDS = ['result', 'runMinutes', 'levelPct', 'levelBand'];
// Slice 2 (20 Nov): the load a generator test ran on, as the technician saw it. It records what was
// seen; it does not say the load was enough or that a generator is fit. Optional in the command (records
// from before 20 Nov have none: "load not recorded"), required on the screen.
export const LOADS = { 'on-load': 'On load (building or load bank)', 'off-load': 'Off load (no load)' };
export const LOAD_WORDS = { 'on-load': 'on load', 'off-load': 'off load' };
export const LOAD_NOT_RECORDED = 'load not recorded';
export const PLACE_TYPES = ['site', 'building', 'department'];

// ---- the check schedule: plain data, shaped { checkKind, assetKind or placeId, everyDays } ----
// An example setting, not a standard. A site sets its own; a site that follows a national or
// insurer's standard for standby power sets its generator test interval from that standard
// (#136: no one country's standard is named). The weekly run here is an example, not a standard.
export const SCHEDULE = [
  { checkKind: 'generator-test', assetKind: 'generator', everyDays: 7 },
  { checkKind: 'fuel-level', assetKind: 'generator', everyDays: 7 },
  { checkKind: 'water-level', placeId: 'bld-main-plant', everyDays: 7 },
  { checkKind: 'gas-check', placeId: 'bld-main-plant', everyDays: 1 },
  { checkKind: 'generator-load-test', assetKind: 'generator', everyDays: 28 },
];
// A schedule kind that is not a kind of check of its own: it is filled only by a generator test
// recorded on load. Not a tile and not accepted by the check command. Example setting, not a standard.
export const SCHEDULE_ONLY = {
  'generator-load-test': { name: 'Generator test on load', target: 'asset', assetKind: 'generator', filledBy: 'generator-test', load: 'on-load' },
};
export const scheduleKindName = (k) => CHECK_KINDS[k]?.name || SCHEDULE_ONLY[k]?.name || k;
// The checks the schedule reads: every check as it is, plus each generator test recorded on load once
// more as a 'generator-load-test'. A test with no load recorded, or off load, never fills an on-load
// period. (The weekly generator test row is filled by every test, whatever its load.)
export function scheduleChecks(checks) {
  const out = [...checks];
  for (const c of checks) {
    for (const [kind, k] of Object.entries(SCHEDULE_ONLY)) if (c.checkKind === k.filledBy && c.load === k.load) out.push({ ...c, checkKind: kind });
  }
  return out.sort((a, b) => ms(a.at) - ms(b.at));
}
export const SCHEDULE_NOTE = 'The check schedule is an example setting, not a standard: each site sets its own. A site that follows a national or insurer\'s standard for standby power sets its generator tests from that standard. In this example a week starts on Monday.';
// Due periods are counted from a fixed Monday at midnight, site time: a weekly check is due once
// each Monday-to-Sunday week, a daily check once each day.
export const SLOT_ANCHOR = Date.UTC(2026, 0, 5); // Monday 5 Jan 2026, 00:00 local
export const everyText = (n) => (n === 1 ? 'Every day' : n === 7 ? 'Every week' : n % 7 === 0 ? `Every ${n / 7} weeks` : `Every ${n} days`);

// The things the schedule covers on this site: one row per check kind and asset or place.
// assets: [{ id, kind, name }], places: Map(id -> { id, name }).
export function scheduleTargets(schedule, { assets, places }) {
  const out = [];
  for (const s of schedule) {
    const kind = CHECK_KINDS[s.checkKind] || SCHEDULE_ONLY[s.checkKind];
    if (!kind) continue;
    if (s.assetKind) {
      for (const a of assets.filter((x) => x.kind === s.assetKind)) out.push({ checkKind: s.checkKind, targetId: a.id, everyDays: s.everyDays });
    } else if (s.placeId && places.has(s.placeId)) out.push({ checkKind: s.checkKind, targetId: s.placeId, everyDays: s.everyDays });
  }
  return out;
}

// ---- records, derived from the event log ----
const CHECK_ID = /^chk-(\d{5,})$/;
const OUTAGE_ID = /^out-(\d{5,})$/;
const WASTE_ID = /^wst-(\d{5,})$/;
// facilities.check-recorded, subject = check id: { checkKind, assetId or placeId, result, runMinutes, levelPct, levelBand }.
// Anything that does not fit the fixed lists (an edited import) is left out.
export function deriveChecks(events) {
  const out = [];
  const seen = new Set();
  for (const e of events) {
    if (e.type !== 'facilities.check-recorded' || !CHECK_ID.test(e.subject) || seen.has(e.subject)) continue;
    const d = e.data || {};
    const kind = CHECK_KINDS[d.checkKind];
    if (!kind) continue;
    const targetId = kind.target === 'asset' ? d.assetId : d.placeId;
    if (!isId(targetId)) continue; // an id's shape, never a sentence (#138)
    const c = { id: e.subject, checkKind: d.checkKind, targetId, at: e.at, byRole: e.actorRole };
    if (kind.needs.includes('result')) { if (!RESULTS[d.result]) continue; c.result = d.result; }
    if (kind.needs.includes('runMinutes')) { if (!RUN_MINUTES.includes(d.runMinutes)) continue; c.runMinutes = d.runMinutes; }
    if (kind.needs.includes('levelPct')) { if (!LEVELS.includes(d.levelPct)) continue; c.levelPct = d.levelPct; }
    if (kind.needs.includes('levelBand')) { if (!GAS_BANDS[d.levelBand]) continue; c.levelBand = d.levelBand; }
    if (d.load != null) { if (d.checkKind !== 'generator-test' || !LOADS[d.load]) continue; c.load = d.load; }
    seen.add(e.subject);
    out.push(c);
  }
  return out.sort((a, b) => ms(a.at) - ms(b.at));
}

export const nextId = (prefix, events, type) => {
  const re = prefix === 'chk' ? CHECK_ID : prefix === 'wst' ? WASTE_ID : OUTAGE_ID;
  let max = 0;
  for (const e of events) { const m = e.type === type ? re.exec(e.subject) : null; if (m) max = Math.max(max, Number(m[1])); }
  return `${prefix}-${String(max + 1).padStart(5, '0')}`;
};
export const nextCheckId = (events) => nextId('chk', events, 'facilities.check-recorded');
export const nextOutageId = (events) => nextId('out', events, 'facilities.outage-started');
export const nextWasteId = (events) => nextId('wst', events, 'facilities.waste-recorded');

// ---- outages ----
export const UTILITIES = {
  power: 'Power',
  water: 'Water',
  'medical-gases': 'Medical gases',
  'medical-air-vacuum': 'Medical air and vacuum',
  'heating-cooling': 'Heating or cooling',
};
export const CAUSES = {
  'not-known': 'Not known yet',
  'outside-supply': 'Outside supply failed',
  'equipment-fault': 'Equipment fault on site',
  'damage-leak': 'Damage or leak',
  weather: 'Weather',
  'planned-shutdown': 'Planned shutdown',
};
export const AGO_MINUTES = [0, 15, 30, 60, 120, 240, 480, 720]; // up to 12 hours: an outage found at shift change
export const agoText = (m) => (m === 0 ? 'Just now' : m < 60 ? `${m} min ago` : m === 60 ? '1 hour ago' : `${m / 60} hours ago`);
// facilities.outage-started, subject = outage id: { utility, placeId, cause }; facilities.outage-ended: { cause }.
export function deriveOutages(events) {
  const map = new Map();
  for (const e of events) {
    if (e.type === 'facilities.outage-started' && OUTAGE_ID.test(e.subject) && !map.has(e.subject)) {
      const d = e.data || {};
      if (!UTILITIES[d.utility] || !isId(d.placeId) || !CAUSES[d.cause]) continue;
      map.set(e.subject, { id: e.subject, utility: d.utility, placeId: d.placeId, cause: d.cause, startedAt: e.at, startedByRole: e.actorRole, endedAt: null, endedByRole: null,
        startBackdatedMinutes: AGO_MINUTES.includes(d.backdatedMinutes) ? d.backdatedMinutes : 0, endBackdatedMinutes: 0 });
    } else if (e.type === 'facilities.outage-ended') {
      const o = map.get(e.subject);
      if (!o || o.endedAt) continue;
      o.endedAt = ms(e.at) < ms(o.startedAt) ? o.startedAt : e.at; // a clock set back never makes a length below zero
      o.endedByRole = e.actorRole;
      o.endBackdatedMinutes = AGO_MINUTES.includes(e.data?.backdatedMinutes) ? e.data.backdatedMinutes : 0;
      if (CAUSES[e.data?.cause]) o.cause = e.data.cause;
    }
  }
  return map;
}
export const openOutage = (outages, utility, placeId) => [...outages.values()].find((o) => !o.endedAt && o.utility === utility && o.placeId === placeId) || null;

// ---- settings: the site's levels and the guide's switch, both from people-only commands ----
export const DEFAULT_LEVELS = { fuelPct: 50, waterPct: 50 }; // example settings, not a standard
export const LEVEL_PICKS = [10, 20, 30, 40, 50, 60, 70, 80, 90];
export function levelsNow(events) {
  const l = { ...DEFAULT_LEVELS, setAt: null };
  for (const e of events) {
    if (e.type !== 'facilities.levels-set') continue;
    if (LEVEL_PICKS.includes(e.data?.fuelPct)) l.fuelPct = e.data.fuelPct;
    if (LEVEL_PICKS.includes(e.data?.waterPct)) l.waterPct = e.data.waterPct;
    l.setAt = e.at;
  }
  return l;
}
export function guideOn(events) {
  let on = true;
  for (const e of events) if (e.type === 'facilities.guide-set' && typeof e.data?.on === 'boolean') on = e.data.on;
  return on;
}

// ---- due periods ("slots") ----
// Slot k of a check that is due every N days runs from anchor + k*N days to anchor + (k+1)*N days,
// site time (offsetMinutes east of UTC). Its due time is the end of the slot.
export function slotIndex(t, everyDays, offsetMinutes = 0) {
  return Math.floor((t + offsetMinutes * MIN - SLOT_ANCHOR) / (everyDays * DAY));
}
export function slotBounds(k, everyDays, offsetMinutes = 0) {
  const start = SLOT_ANCHOR + k * everyDays * DAY - offsetMinutes * MIN;
  return { start, due: start + everyDays * DAY };
}

// The slots of one target between two moments, each with the first check recorded inside it.
// A check recorded after its slot ends belongs to the slot it was recorded in: a late check never
// fills a missed one.
export function targetSlots(checks, target, { from, until, offsetMinutes = 0 }) {
  const mine = checks.filter((c) => c.checkKind === target.checkKind && c.targetId === target.targetId && ms(c.at) < until);
  const out = [];
  for (let k = slotIndex(from, target.everyDays, offsetMinutes); ; k++) {
    const { start, due } = slotBounds(k, target.everyDays, offsetMinutes);
    if (start >= until) break;
    const inSlot = mine.filter((c) => ms(c.at) >= start && ms(c.at) < due);
    const doneAt = inSlot.length ? ms(inSlot[0].at) : null;
    out.push({ k, start, due, doneAt, checks: inSlot, failed: inSlot.some((c) => c.result === 'fail') });
  }
  return out;
}

// ---- KPI: planned checks done by due date (KPI dictionary D-13), filtered by check type ----
// checks done by due / checks due. A slot is counted in the period in which it is settled: when its
// first check is recorded (done by due), or at its due time if no check was recorded (missed). A
// slot still open at `until` with no check is not counted yet. A failed check counts as done; the
// slots with a failed check are counted beside it. A late check counts for the slot it falls in.
// (events or checks, { since, until (ISO), targets, offsetMinutes, checkKind }) -> { value, numerator, denominator, failed, missed, n }
export function plannedChecksDone(checks, { since, until, targets, offsetMinutes = 0, checkKind = null }) {
  const s = ms(since); const u = ms(until);
  let due = 0; let done = 0; let failed = 0;
  const missed = [];
  for (const t of targets.filter((x) => !checkKind || x.checkKind === checkKind)) {
    for (const slot of targetSlots(checks, t, { from: s - t.everyDays * DAY, until: u, offsetMinutes })) {
      const settled = slot.doneAt ?? slot.due;
      if (slot.doneAt == null && slot.due > u) continue; // still open
      if (settled < s || settled >= u) continue;
      due += 1;
      if (slot.doneAt != null) { done += 1; if (slot.failed) failed += 1; } else missed.push({ checkKind: t.checkKind, targetId: t.targetId, start: iso(slot.start), due: iso(slot.due) });
    }
  }
  return { value: due ? (100 * done) / due : null, numerator: done, denominator: due, n: due, failed, missed };
}

// ---- KPI: utility outage hours, per utility, in a period ----
// The part of each outage (start -> end) that falls in the period, summed per utility; an outage
// still open counts up to `until` and is marked open. Planned shutdowns are summed apart.
export function outageHours(outages, { since, until }) {
  const s = ms(since); const u = ms(until);
  const by = Object.fromEntries(Object.entries(UTILITIES).map(([id, name]) => [id, { id, name, hours: 0, plannedHours: 0, outages: 0, open: 0 }]));
  for (const o of (outages instanceof Map ? [...outages.values()] : outages)) {
    const a = Math.max(ms(o.startedAt), s);
    const b = Math.min(o.endedAt ? ms(o.endedAt) : u, u);
    if (b <= a && !(ms(o.startedAt) >= s && ms(o.startedAt) < u)) continue;
    const h = Math.max(0, b - a) / HOUR;
    const row = by[o.utility];
    if (o.cause === 'planned-shutdown') row.plannedHours += h; else row.hours += h;
    row.outages += 1;
    if (!o.endedAt || ms(o.endedAt) > u) row.open += 1;
  }
  const rows = Object.values(by);
  const total = rows.reduce((n, r) => n + r.hours, 0);
  return { value: total, byUtility: rows, n: rows.reduce((n, r) => n + r.outages, 0), plannedHours: rows.reduce((n, r) => n + r.plannedHours, 0) };
}

// ---- where each scheduled check stands now ----
// status: done (this period's check is recorded), due (not yet, still in time), overdue (one or more
// whole periods have passed with no check since the last one).
export function checkStatus(checks, targets, { now, offsetMinutes = 0 }) {
  const t = ms(now);
  return targets.map((tg) => {
    const mine = checks.filter((c) => c.checkKind === tg.checkKind && c.targetId === tg.targetId && ms(c.at) <= t);
    const last = mine.at(-1) || null;
    const cur = slotIndex(t, tg.everyDays, offsetMinutes);
    const { start, due } = slotBounds(cur, tg.everyDays, offsetMinutes);
    const doneNow = mine.some((c) => ms(c.at) >= start);
    let overdueSince = null; let missedPeriods = 0;
    if (!doneNow && last) {
      const lastK = slotIndex(ms(last.at), tg.everyDays, offsetMinutes);
      missedPeriods = Math.max(0, cur - lastK - 1);
      if (missedPeriods) overdueSince = iso(slotBounds(lastK + 1, tg.everyDays, offsetMinutes).due);
    }
    return { ...tg, status: doneNow ? 'done' : overdueSince ? 'overdue' : 'due', periodStart: iso(start), dueBy: iso(due), last, overdueSince, missedPeriods };
  });
}

// ---- checks that need a person's attention ----
// A check whose newest record is a fail, or a medical gas check whose supply level was picked as low
// or on reserve, stays in "Needs attention" until a later check on the same asset or place is
// normal. This says what was recorded; it never says whether a supply is safe, and orders nothing.
export const GAS_LOW_BANDS = ['low', 'reserve'];
export function checkProblem(c) {
  if (!c) return null;
  if (c.result === 'fail') return { id: 'failed', words: 'Failed' };
  if (c.checkKind === 'gas-check' && GAS_LOW_BANDS.includes(c.levelBand)) return { id: c.levelBand, words: `Supply level picked: ${GAS_BANDS[c.levelBand]}` };
  return null;
}
// Each asset or place whose newest check of a kind is a problem: [{ check, problem }], oldest first.
export function problemChecks(checks) {
  const last = new Map();
  for (const c of checks) last.set(`${c.checkKind}|${c.targetId}`, c);
  return [...last.values()].map((c) => ({ check: c, problem: checkProblem(c) })).filter((x) => x.problem);
}

// The newest reading of each fuel or water target.
export function latestReadings(checks) {
  const m = new Map();
  for (const c of checks) if (c.levelPct != null) m.set(`${c.checkKind}|${c.targetId}`, c);
  return [...m.values()];
}

// ---- dates in site time, in words ----
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const local = (t, off) => new Date(t + off * MIN);
export const dayText = (t, off = 0) => { const d = local(t, off); return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`; };
export const timeText = (t, off = 0) => { const d = local(t, off); return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`; };
export const whenText = (t, off = 0) => `${dayText(t, off)}, ${timeText(t, off)}`;
// The last day of a slot (its due time is midnight at the start of the next day).
export const dueDayText = (dueMs, off = 0) => dayText(dueMs - MIN, off);
export function monthBounds(t, off = 0) {
  const d = local(t, off);
  const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) - off * MIN;
  const end = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) - off * MIN;
  return { start, end, name: `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}` };
}

// ---- guide rules: fixed, checkable rules. A rule suggests; the facilities manager decides. ----
// Faults counted by rule 2: picked from Engineering's own fault lists (core/workorders.js).
export const REPEAT_FAULTS = {
  water: { name: 'leak', faults: ['Tap leaking'] },
  power: { name: 'power', faults: ['Tripped breaker'] },
};
export const REPEAT_MIN = 2;
export const GUIDE_RULES = [
  { id: 'low-level', name: 'Fuel or stored water below the site\'s level',
    basis: `Example setting, not a standard: the levels are set by this site's facilities manager (the example starts at ${DEFAULT_LEVELS.fuelPct} % for fuel and ${DEFAULT_LEVELS.waterPct} % for stored water). The rule reads the newest reading only. It cannot yet say whether a delivery is booked: that needs delivery records (supply chain), not built yet.` },
  { id: 'repeat-faults', name: 'Repeat building faults in one place',
    basis: `Example setting, not a standard: ${REPEAT_MIN} or more work orders for leak faults (${REPEAT_FAULTS.water.faults.join(', ')}), or for power faults (${REPEAT_FAULTS.power.faults.join(', ')}), on assets in the same ward, department or building, reported within ${REPEAT_WINDOW_DAYS} days (the same window as Engineering's repeat faults). Advice only.` },
  { id: 'repeat-failed-tests', name: 'Repeat failed tests on one generator',
    basis: `Example setting, not a standard: ${REPEAT_MIN} or more failed generator tests on the same generator within ${REPEAT_WINDOW_DAYS} days. A failed test counts whatever its load: on load, off load or load not recorded. Advice only: a person decides whether its maintenance needs a review.` },
  { id: 'severe-weather', name: 'Before severe weather', planned: true,
    basis: 'Planned, not built yet: it needs a warning period to be recorded and the compliance calendar.' },
];
const BASIS = Object.fromEntries(GUIDE_RULES.map((r) => [r.id, r.basis]));

// Rule 1. readings: latestReadings(); levels: levelsNow(); nameOf(id) -> plain name.
export function ruleLowLevel(readings, levels, { nameOf, offsetMinutes = 0 }) {
  const out = [];
  for (const c of readings) {
    const set = c.checkKind === 'fuel-level' ? levels.fuelPct : c.checkKind === 'water-level' ? levels.waterPct : null;
    if (set == null || c.levelPct >= set) continue;
    const what = c.checkKind === 'fuel-level' ? 'fuel' : 'stored water';
    out.push({
      rule: 'low-level', id: `low-level:${c.checkKind}:${c.targetId}:${c.id}`,
      text: `Arrange a ${c.checkKind === 'fuel-level' ? 'fuel' : 'water'} refill for ${nameOf(c.targetId)}.`,
      why: `The newest reading is ${c.levelPct} %, taken ${whenText(ms(c.at), offsetMinutes)}; the site's level for ${what} is ${set} % (example setting, not a standard).`,
      basis: BASIS['low-level'], action: null,
    });
  }
  return out;
}

// Rule 2. events: the whole log (for deriveWorkOrders); assets: Map(id -> { parentId }); now: ISO.
export function ruleRepeatFaults(events, { assets, now, nameOf, wards = null, isWard = (id) => String(id).startsWith('ward-') }) {
  const t = ms(now);
  const groups = new Map();
  for (const w of deriveWorkOrders(events, now).values()) {
    const cat = Object.entries(REPEAT_FAULTS).find(([, c]) => c.faults.includes(w.title))?.[0];
    const place = assets.get(w.assetId)?.parentId;
    if (wards && isWard(place) && !wards.has(place)) continue; // an agent sees its own wards only
    if (!cat || !place || t - ms(w.reportedAt) > REPEAT_WINDOW_DAYS * DAY || ms(w.reportedAt) > t) continue;
    const key = `${place}|${cat}`;
    if (!groups.has(key)) groups.set(key, { place, cat, orders: [] });
    groups.get(key).orders.push(w);
  }
  const out = [];
  for (const g of groups.values()) {
    if (g.orders.length < REPEAT_MIN) continue;
    g.orders.sort((a, b) => ms(a.reportedAt) - ms(b.reportedAt));
    out.push({
      rule: 'repeat-faults', id: `repeat-faults:${g.place}:${g.cat}`, workOrders: g.orders.map((w) => w.id),
      text: `Plan a survey of the ${g.cat === 'water' ? 'water pipework and fittings' : 'electrical supply'} in ${nameOf(g.place)}, instead of more one-off fixes.`,
      why: `${g.orders.length} ${REPEAT_FAULTS[g.cat].name} faults there in ${REPEAT_WINDOW_DAYS} days: ${g.orders.map((w) => `${w.id.toUpperCase()} ${w.title.toLowerCase()}`).join('; ')}.`,
      basis: BASIS['repeat-faults'], action: null,
    });
  }
  return out.sort((a, b) => b.workOrders.length - a.workOrders.length || (a.id < b.id ? -1 : 1));
}

// Rule 3. Repeat failed tests on one generator within the window: suggest reviewing its maintenance.
export function ruleRepeatFailedTests(checks, { now, nameOf, offsetMinutes = 0 }) {
  const t = ms(now);
  const by = new Map();
  for (const c of checks) {
    if (c.checkKind !== 'generator-test' || c.result !== 'fail' || ms(c.at) > t || t - ms(c.at) > REPEAT_WINDOW_DAYS * DAY) continue;
    by.set(c.targetId, [...(by.get(c.targetId) || []), c]);
  }
  return [...by].filter(([, list]) => list.length >= REPEAT_MIN).map(([target, list]) => ({
    rule: 'repeat-failed-tests', id: `repeat-failed-tests:${target}:${list.at(-1).id}`, checks: list.map((c) => c.id),
    text: `Review the maintenance of ${nameOf(target)}.`,
    why: `${list.length} failed tests in ${REPEAT_WINDOW_DAYS} days: ${list.map((c) => dayText(ms(c.at), offsetMinutes)).join('; ')}.`,
    basis: BASIS['repeat-failed-tests'], action: null,
  }));
}


// ---- KPI: generator on-load tests done by due date (slice 2) ----
// The same shared measure as generator tests carried out on time ("planned checks done by due date", D-13),
// for the schedule row generator-load-test: an on-load period is done when a generator test recorded
// on load falls inside it. Off-load runs and tests with no load recorded never fill one. A failed
// on-load test counts as done, with the failures counted beside it.
export const LOAD_TEST_DAYS = 84; // three periods of four weeks
export function loadTestsDone(checks, { since, until, targets, offsetMinutes = 0 }) {
  return plannedChecksDone(scheduleChecks(checks), { since, until, targets, offsetMinutes, checkKind: 'generator-load-test' });
}

// ---- the waste log (slice 2): collections and missed collections, picks only ----
// Example lists, not a standard: a site's own waste policy names its streams.
export const WASTE_STREAMS = {
  general: 'General', infectious: 'Infectious', sharps: 'Sharps', pharmaceutical: 'Pharmaceutical', chemical: 'Chemical', recycling: 'Recycling',
};
export const WASTE_CONTAINERS = [1, 2, 3, 4, 5, 6, 8, 10, 15, 20]; // 20 means "20 or more"
export const containersText = (n) => (n >= 20 ? '20 or more containers' : n === 1 ? '1 container' : `${n} containers`);
// A total over several collections: the plain number (a "20 or more" pick counts as 20).
export const totalContainersText = (n) => (n === 1 ? '1 container' : `${n} containers`);
export const containersPick = (n) => (n >= 20 ? '20 or more' : String(n));
export const WASTE_OUTCOMES = { collected: 'Collected', missed: 'Collection missed' };
export const WASTE_REASONS = { 'did-not-come': 'Collection did not come', 'could-not-take': 'Came but could not take it', 'not-known': 'Not known' };
// facilities.waste-recorded, subject = waste record id wst-00001:
// { placeId, stream, outcome, containers (collected only), reason (missed only), backdatedMinutes }.
// Anything that does not fit the fixed lists (an edited import) is left out.
export function deriveWaste(events) {
  const out = [];
  const seen = new Set();
  for (const e of events) {
    if (e.type !== 'facilities.waste-recorded' || !WASTE_ID.test(e.subject) || seen.has(e.subject)) continue;
    const d = e.data || {};
    if (!isId(d.placeId) || !WASTE_STREAMS[d.stream] || !WASTE_OUTCOMES[d.outcome]) continue;
    const w = { id: e.subject, placeId: d.placeId, stream: d.stream, outcome: d.outcome, at: e.at, byRole: e.actorRole,
      backdatedMinutes: AGO_MINUTES.includes(d.backdatedMinutes) ? d.backdatedMinutes : 0 };
    if (d.outcome === 'collected') { if (!WASTE_CONTAINERS.includes(d.containers) || d.reason != null) continue; w.containers = d.containers; }
    else { if (!WASTE_REASONS[d.reason] || d.containers != null) continue; w.reason = d.reason; }
    seen.add(e.subject);
    out.push(w);
  }
  return out.sort((a, b) => ms(a.at) - ms(b.at) || (a.id < b.id ? -1 : 1));
}
export function wasteWords(w) {
  return w.outcome === 'collected' ? `${WASTE_STREAMS[w.stream]}: ${containersText(w.containers)} collected` : `${WASTE_STREAMS[w.stream]}: collection missed (${WASTE_REASONS[w.reason]})`;
}
// Missed collections still waiting at `now`: a miss stays until a later collection of the same stream
// at the same place is recorded. Oldest first.
export function wasteMissedWaiting(waste, { now }) {
  const t = ms(now);
  return waste.filter((w) => w.outcome === 'missed' && ms(w.at) <= t
    && !waste.some((x) => x.outcome === 'collected' && x.stream === w.stream && x.placeId === w.placeId && ms(x.at) > ms(w.at) && ms(x.at) <= t));
}
const inPeriod = (w, s, u) => ms(w.at) >= s && ms(w.at) < u;
// KPI: missed waste collections. collections recorded as missed / collections recorded (collected or
// missed) in the period, in all and per stream. A later collection does not cancel the miss.
export function wasteMissedShare(waste, { since, until }) {
  const s = ms(since); const u = ms(until);
  const mine = waste.filter((w) => inPeriod(w, s, u));
  const byStream = Object.entries(WASTE_STREAMS).map(([id, name]) => {
    const list = mine.filter((w) => w.stream === id);
    const missed = list.filter((w) => w.outcome === 'missed').length;
    return { id, name, missed, recorded: list.length, value: list.length ? (100 * missed) / list.length : null };
  });
  const missed = mine.filter((w) => w.outcome === 'missed').length;
  return { value: mine.length ? (100 * missed) / mine.length : null, numerator: missed, denominator: mine.length, n: mine.length, byStream };
}
// KPI: waste containers collected, per stream, in the period. A total, not a share; no weight (container
// sizes differ, so streams are not compared).
export function wasteContainers(waste, { since, until }) {
  const s = ms(since); const u = ms(until);
  const mine = waste.filter((w) => w.outcome === 'collected' && inPeriod(w, s, u));
  const byStream = Object.entries(WASTE_STREAMS).map(([id, name]) => {
    const list = mine.filter((w) => w.stream === id);
    return { id, name, containers: list.reduce((n, w) => n + w.containers, 0), collections: list.length };
  });
  return { value: mine.reduce((n, w) => n + w.containers, 0), numerator: null, denominator: null, n: mine.length, byStream };
}
