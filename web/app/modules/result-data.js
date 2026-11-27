// The one-screen result of a walked map (walk-first week, crew night 3): pure functions over the
// walk records (core/walk.js recordFromWalk) and the map's saved step list. Nothing here changes a
// number; it lays the records out by step, walk by walk, for the table, the bars, the CSV and the
// plain-text summary. Steps and roles only: no person is named, timed or ranked.
import { minWords, atLeastWords, spanOf, stoodWords, longestWalks, longestTimeOf } from './result-words.js';
import { waitReasonText, MIN_LONGEST_WAIT_SEC } from '../core/walk.js';

// Why a wait happened, when the person walking recorded it with one tap (core/walk.js WAIT_REASONS;
// record step field waitReason). Null when none was given. The words say where the reason came
// from first: it is one person's observation on one walk, not a cause found by Ospeli.
export function waitReasonOf(recordStep) {
  const text = waitReasonText(recordStep?.waitReason);
  return text ? `reason recorded on the walk: ${text.charAt(0).toLowerCase()}${text.slice(1)}` : null;
}

// The wait before a step (#180 point 2): the record's wait less the time the step itself stood still
// after it started (interrupted, then carried on; core/walk.js keeps that inside waitSec). The
// longest wait is picked by it, and the time stood still is said apart, on the step's row.
export const waitBeforeOf = (s) => Math.max(0, (s?.waitSec || 0) - (s?.interruptedWaitSec || 0));

// The records a one-walk map shows: its own steps in seconds, so a time changed by hand on the map
// is the time the result shows. A step added by hand was not timed on the walk.
// list: the map's steps with times in seconds (core/walk.js stepsInSeconds).
export function recordFromSteps(list, walk) {
  const timed = list.filter((s) => !(s.waitSec == null && s.workSec == null && !s.edited));
  return { id: walk?.id || 'walk-1', startedAt: walk?.startedAt, finishedAt: walk?.finishedAt, ...(walk?.clockMoved ? { clockMoved: true } : {}),
    steps: timed.map((s) => ({ stepId: s.id, waitSec: s.wait, workSec: s.work,
      ...(s.waitNotSeenSec ? { waitNotSeenSec: s.waitNotSeenSec } : {}), ...(s.workNotSeenSec ? { workNotSeenSec: s.workNotSeenSec } : {}),
      ...(s.interrupted ? { interrupted: true } : {}), ...(s.interruptedWaitSec ? { interruptedWaitSec: s.interruptedWaitSec } : {}), ...(s.interruptions ? { interruptions: s.interruptions } : {}),
      ...(s.waitReason ? { waitReason: s.waitReason } : {}), ...(s.stopReason ? { stopReason: s.stopReason } : {}), ...(s.typed ? { typed: true } : {}) })),
    notTimed: list.filter((s) => !timed.includes(s)).map((s) => s.id) };
}

const interruptionsOf = (s) => s.interruptions || (s.interrupted ? 1 : 0);

// One walk's steps in the order they happened, each with what the table and bars need.
// list: the saved step list ({ id, name, role, plannedWait }); rec: one record.
export function walkItems(list, rec) {
  const byId = new Map(list.map((s, i) => [s.id, { ...s, i }]));
  const seen = new Map();
  return rec.steps.map((s, p) => {
    const on = s.stepId != null && byId.has(s.stepId);
    const st = on ? byId.get(s.stepId) : null;
    const times = (seen.get(s.stepId) || 0) + 1; if (on) seen.set(s.stepId, times);
    return { p, stepId: on ? s.stepId : null, num: on ? String(st.i + 1) : '+', name: on ? st.name : s.name || `Step ${p + 1}`, role: on ? st.role : s.role || 'Not set', onList: on, again: on && times > 1,
      planned: !!(on && st.plannedWait), waitSec: s.waitSec || 0, workSec: s.workSec || 0, waitNotSeenSec: s.waitNotSeenSec || 0, workNotSeenSec: s.workNotSeenSec || 0,
      interruptions: interruptionsOf(s), stoppedSec: s.interruptedWaitSec || 0, waitBeforeSec: waitBeforeOf(s), reason: waitReasonOf(s), rec: s };
  });
}

// The marks of the minutes scale under the bars (#189 item 3): 0, then a round step in whole
// minutes, at most four marks after 0, none past the longest walk. maxSec: the longest walk.
const SCALE_STEPS = [1, 2, 5, 10, 15, 20, 30, 60, 120, 180, 240, 360, 480, 720, 1440, 2880];
export function scaleTicks(maxSec) {
  const maxMin = Math.max(0, maxSec) / 60;
  const step = SCALE_STEPS.find((m) => Math.floor(maxMin / m) <= 4) || SCALE_STEPS[SCALE_STEPS.length - 1];
  const out = [{ sec: 0, label: '0' }];
  for (let m = step; m <= maxMin; m += step) out.push({ sec: m * 60, label: minWords(m * 60) });
  return out;
}

// A list step's wait and hands-on time across the walks where it happened (#182 item 22), so
// Result and Edit map say the same thing: the walks are counted where the step was timed, whatever
// came before it. On a walk where it was done again, its longest single wait (the one a walk's
// longest wait is named from) and all its hands-on time. A wait the walk was paused during is the
// least it can have been. usable: per walk, false when its clock moved back (left out).
// Returns Map stepId -> { stepId, wait, work (spans as result-words.js spanOf), happened, of }.
export function stepSpans(list, records, usable = null) {
  const ok = records.map((r, k) => (usable ? usable[k] !== false : !r.clockMoved));
  const per = records.map((r, k) => (ok[k] ? walkItems(list, r) : null));
  const of = ok.filter(Boolean).length;
  return new Map(list.map((st) => {
    const waits = []; const works = [];
    per.forEach((items) => {
      const at = items ? items.filter((x) => x.stepId === st.id) : [];
      if (!at.length) return;
      const top = at.reduce((a, x) => (x.waitSec > a.waitSec ? x : a), at[0]);
      waits.push([top.waitSec, top.waitNotSeenSec > 0]);
      works.push([at.reduce((n, x) => n + x.workSec, 0), at.some((x) => x.workNotSeenSec > 0)]);
    });
    return [st.id, { stepId: st.id, wait: spanOf(waits), work: spanOf(works), happened: waits.length, of }];
  }));
}

// Each walk's own longest wait, picked by the wait before the step (the time a step stood still is
// left out, #180 point 2; the core's range still holds it inside the wait: reported to the Builder).
// Otherwise the core's rule: 30 s or more, waits marked planned or required left out, ties all
// named, a walk whose clock moved back names none. only: the walk numbers to read (one side of a
// change), others name none. Returns the shape of ospeli_maps_get's range that result-words.js
// longestWalks reads ({ walks[].longest, longest, longestOf, steps, usable }), and reason: the
// reason recorded on the walk for the first named wait, said with the walk it came from.
export function walksLongest(list, records, rg, only = null) {
  const order = list.map((s) => s.id);
  const planned = new Set(list.filter((s) => s.plannedWait).map((s) => s.id));
  const nameOf = (id) => list.find((s) => s.id === id)?.name;
  const inSet = records.map((r, k) => rg.walks[k]?.usable !== false && !r.clockMoved && (!only || only.includes(k + 1)));
  const walks = records.map((r, k) => {
    const open = r.steps.filter((s) => !(s.stepId && planned.has(s.stepId)) && (!s.stepId || order.includes(s.stepId)));
    const max = Math.max(0, ...open.map(waitBeforeOf));
    const longest = inSet[k] && max >= MIN_LONGEST_WAIT_SEC ? open.filter((s) => waitBeforeOf(s) === max).map((s) => ({ key: s.stepId || `off:${s.name}`, name: s.stepId ? nameOf(s.stepId) : s.name,
      waitSec: max, before: true, ...(s.waitNotSeenSec ? { atLeast: true } : {}), ...(waitReasonText(s.waitReason) ? { reason: waitReasonText(s.waitReason) } : {}) })) : [];
    return { n: k + 1, usable: inSet[k], longest };
  });
  const tally = new Map();
  for (const w of walks) for (const l of w.longest) { const t = tally.get(l.key) || { stepId: l.key.startsWith('off:') ? null : l.key, name: l.name, walks: [] }; t.walks.push(w.n); tally.set(l.key, t); }
  const longest = [...tally.values()].sort((a, b) => b.walks.length - a.walks.length);
  const steps = list.map((st) => ({ stepId: st.id, happened: records.filter((r, k) => inSet[k] && r.steps.some((s) => s.stepId === st.id)).length }));
  const used = inSet.filter(Boolean).length;
  // The reason a person recorded for that wait, walk by walk; never a count of reasons.
  let reason = null;
  if (longest.length) {
    const key = longest[0].stepId || `off:${longest[0].name}`;
    const said = longest[0].walks.map((n) => [n, walks[n - 1].longest.find((l) => l.key === key)?.reason]).filter((x) => x[1]);
    if (said.length) {
      reason = records.length === 1 ? `Reason recorded on the walk: ${said[0][1]}.`
        : said.every((x) => x[1] === said[0][1]) ? `Reason recorded on ${walkNos(said.map((x) => x[0]))}: ${said[0][1]}.`
          : `Reasons recorded: ${said.map(([n, t]) => `walk ${n}, ${t}`).join('; ')}.`;
    }
  }
  return { count: records.length, usable: used, walks, steps, longest, longestOf: walks.filter((w) => w.longest.length).length, reason };
}

// The headline once a change is marked and walks on both sides can be read (#189 night 5 item 1,
// review fix 1): each line names the longest wait of its own side, by the same rule as the page
// (the wait before the step, stood-still time left out, a range across that side's walks; walks
// that disagree are said in longestWalks's own words). When the sides name different steps, same:
// one more line with the after-side step's own wait before the change (its first time on each
// walk, as the before-and-after table). Never an average and never a verdict. Null while one side
// has no walk.
export function changeHeadline({ list, records, rg, afterWalk }) {
  const usable = records.map((r, k) => rg.walks[k]?.usable !== false && !r.clockMoved);
  const ak = records.map((_, k) => k + 1).filter((n) => usable[n - 1] && n > afterWalk);
  const bk = records.map((_, k) => k + 1).filter((n) => usable[n - 1] && n <= afterWalk);
  if (!ak.length || !bk.length) return null;
  const lo = walksLongest(list, records, rg, ak);
  const lw = longestWalks(lo);
  const sides = countWalks(bk.length);
  const loB = walksLongest(list, records, rg, bk);
  const lwB = longestWalks(loB);
  let before;
  if (!lwB) before = `Before the change, no wait was ${MIN_LONGEST_WAIT_SEC} seconds or more (${sides}).`;
  else if (loB.longest.length === 1) {
    const l = loB.longest[0];
    before = `Before the change, the longest wait was ${longestTimeOf(loB, l)} before “${l.name}” (${l.walks.length < bk.length ? `on ${l.walks.length} of ${sides}` : sides}).`;
  } else before = lwB.lead.startsWith('Longest wait moved') ? `Before the change, the longest wait moved: ${lwB.text}.` : `Before the change, the longest wait was ${lwB.text}.`;
  if (!lw) return { lead: '', text: `No wait of ${MIN_LONGEST_WAIT_SEC} seconds or more on the ${ak.length === 1 ? 'walk' : 'walks'} after the change.`, none: true, before, same: null, reason: null };
  const top = lo.longest[0];
  const keyOf = (l) => l.stepId || `off:${l.name}`;
  let same = null;
  if (!loB.longest.some((l) => keyOf(l) === keyOf(top))) {
    const vals = [];
    for (const n of bk) {
      const at = records[n - 1].steps.find((s) => (s.stepId || `off:${s.name}`) === keyOf(top));
      if (at) vals.push([waitBeforeOf(at), !!at.waitNotSeenSec]);
    }
    same = vals.length ? `“${top.name}” before the change: ${sideWords(spanOf(vals))} (${vals.length < bk.length ? `on ${vals.length} of ${sides}` : sides}).`
      : `“${top.name}” was not on the ${sides} before the change.`;
  }
  return { lead: 'Longest wait after the change: ', text: lw.text, before, same, reason: lo.reason };
}

// ---- before and after a change (#189 item 6) ----
// A person marks "we changed how this works after walk N" (ospeli_maps_change_set). Walks 1 to N are
// before, later walks after. Each side is said as its range (lowest to highest, never an average);
// the difference is read from the ranges' ends, and where the ranges overlap it says so. Ospeli
// shows the difference; it never says whether the change worked.
export const CHANGE_CAVEAT = (n) => `Ospeli shows the difference. It does not say whether the change worked. ${n} ${n === 1 ? 'walk is an example' : 'walks are examples'}, not a sample.`;

// The whole minutes a side's cell shows (sideWords): its low end and its high end ("at least"
// rounds down; under a minute shows as 0).
const shownMin = (sec, floor = false) => (sec < 60 ? 0 : floor ? Math.floor(sec / 60) : Math.round(sec / 60));
// "6 to 11 min", "8 min", "1 h 13 min to 1 h 47 min", "up to 2 min" (from under a minute); whole minutes.
function gapMinWords(lo, hi) {
  const a = lo ? minWords(lo * 60) : 'under 1 min'; const b = minWords(hi * 60);
  if (lo === hi) return a;
  if (!lo) return `up to ${b}`;
  return /^\d+ min$/.test(a) && /^\d+ min$/.test(b) ? `${a.replace(' min', '')} to ${b}` : `${a} to ${b}`;
}
// The difference between a "before" and an "after" span ({ n, min, max, maxAtLeast?, partly? }, seconds),
// worked out from the whole minutes the two cells show (review fix 2), so the sum a reader checks
// gives the same answer: range ends, smallest gap to largest gap; ranges that overlap or touch in
// whole minutes: no clear difference. A side of one walk says so (review fix 4).
// Returns { dir: shorter | longer | same | overlap | none, text }.
export function diffWords(before, after) {
  if (!before?.n || !after?.n) return { dir: 'none', text: 'not timed on both sides' };
  const partly = [before, after].some((x) => x.maxAtLeast || x.partly) ? ' · partly not seen' : '';
  const one = [before.n === 1 ? '1 walk before' : null, after.n === 1 ? '1 walk after' : null].filter(Boolean);
  const from = one.length ? ` (${one.join(', ')})` : '';
  const [bl, bh] = [shownMin(before.min), shownMin(before.max, before.maxAtLeast)];
  const [al, ah] = [shownMin(after.min), shownMin(after.max, after.maxAtLeast)];
  if (before.n === 1 && after.n === 1) {
    const d = ah - bh;
    if (d === 0) return { dir: 'same', text: `the same in whole minutes${partly}${from}` };
    return { dir: d < 0 ? 'shorter' : 'longer', text: `${d < 0 ? 'shorter' : 'longer'} by ${gapMinWords(Math.abs(d), Math.abs(d))}${partly}${from}` };
  }
  if (ah < bl) return { dir: 'shorter', text: `shorter by ${gapMinWords(bl - ah, bh - al)}${partly}${from}` };
  if (al > bh) return { dir: 'longer', text: `longer by ${gapMinWords(al - bh, ah - bl)}${partly}${from}` };
  return { dir: 'overlap', text: `ranges overlap: no clear difference${partly}` };
}

// A span's ends in seconds: "6 to 11 min", "1 h 13 min to 1 h 47 min", "up to 2 min".
function gapWords(lo, hi) {
  const a = minWords(lo); const b = minWords(hi);
  if (a === b) return a;
  if (a === 'under 1 min') return `up to ${b}`;
  return /^\d+ min$/.test(a) && /^\d+ min$/.test(b) ? `${a.replace(' min', '')} to ${b}` : `${a} to ${b}`;
}
// One side's span in a cell, kept short: "10 to 13 min", "3 min" (when every walk gives the same
// whole minutes), "at least 8 min", "… · partly not seen", "(on 1 of 2 walks)".
export function sideWords(sp, of = null) {
  if (!sp?.n) return 'not timed';
  const count = of && sp.n < of ? ` (on ${sp.n} of ${of} walks)` : '';
  const hi = sp.maxAtLeast ? atLeastWords(sp.max) : minWords(sp.max);
  const text = minWords(sp.min) === minWords(sp.max) ? hi : sp.maxAtLeast ? `${minWords(sp.min)} to ${hi}` : gapWords(sp.min, sp.max);
  return `${text}${count}${sp.partly ? ' · partly not seen' : ''}`;
}
const walkNos = (ns) => (ns.length === 1 ? `walk ${ns[0]}` : `walks ${ns.slice(0, -1).join(', ')} and ${ns[ns.length - 1]}`);
const countWalks = (n) => `${n} ${n === 1 ? 'walk' : 'walks'}`;
// "walk 3", "walks 1 and 2", "walks 1 to 4".
const walksFromTo = (a, b) => (a === b ? `walk ${a}` : b === a + 1 ? `walks ${a} and ${b}` : `walks ${a} to ${b}`);
// The line beside "Remove the mark": what counts as before and after. count: the walks on the map.
export function changeLine(afterWalk, count) {
  const n = Math.min(afterWalk, count);
  const before = `${walksFromTo(1, n)} ${n === 1 ? 'is' : 'are'} before it`;
  return n < count ? `Change marked after walk ${n}: ${before}, ${walksFromTo(n + 1, count)} after.` : `Change marked after walk ${n}: ${before}. The next walk will be the first after the change.`;
}

// The before-and-after table. list: the saved step list; records: one per walk, in walk order;
// rg: ospeli_maps_get's range (usable and complete walks); afterWalk: the mark.
// Returns { both: false, line } while one side has no walk, else { both: true, before, after,
// heads, rows, totals, caveat }. Each row: { kind, stepId?, order?, name, role, beforeText,
// afterText, diff, before, after } (spans in seconds, for data-sec and the CSV).
export function compareModel({ list, records, rg, afterWalk }) {
  const usable = records.map((r, k) => rg.walks[k]?.usable !== false && !r.clockMoved);
  const side = (after) => records.map((_, k) => k).filter((k) => usable[k] && ((k + 1 > afterWalk) === after));
  const bk = side(false); const ak = side(true);
  if (!bk.length || !ak.length) {
    return { both: false, line: ak.length ? `${changeLine(afterWalk, records.length)} No walk before the change can be compared.` : changeLine(afterWalk, records.length) };
  }
  // Every timed step of every usable walk lands in exactly one row (#189 night 5 item 2), so each
  // side's rows add up, walk by walk, to that walk's waiting and hands-on: a list step's first time
  // on a walk is its own row; its later times on that walk (done again) are the row under it; a
  // step not on the list is its own row under the list step it followed. Each row keeps, per walk,
  // the wait before the step, the time it stood still and the hands-on, in seconds (walks).
  const add = (row, n, x) => {
    const o = row.walks[n] || (row.walks[n] = { waitSec: 0, stoodSec: 0, workSec: 0, interruptions: 0, times: 0, paused: false, workPaused: false, reasons: [] });
    o.waitSec += x.waitBeforeSec; o.stoodSec += x.stoppedSec; o.workSec += x.workSec; o.interruptions += x.interruptions; o.times += 1;
    o.paused = o.paused || x.waitNotSeenSec > 0; o.workPaused = o.workPaused || x.workNotSeenSec > 0;
    const rs = waitReasonText(x.rec.waitReason); if (rs) o.reasons.push(rs);
  };
  const stepRows = new Map(list.map((st, i) => [st.id, { kind: 'step', stepId: st.id, order: i + 1, name: st.name, role: st.role, walks: {} }]));
  const againRows = new Map(list.map((st, i) => [st.id, { kind: 'again', stepId: st.id, order: i + 1, name: st.name, role: st.role, walks: {} }]));
  const extras = new Map(); // anchor step id ('' first) -> Map(key -> row)
  records.forEach((r, k) => {
    if (!usable[k]) return;
    let anchor = '';
    for (const x of walkItems(list, r)) {
      if (x.onList) { anchor = x.stepId; add(x.again ? againRows.get(x.stepId) : stepRows.get(x.stepId), k + 1, x); continue; }
      const key = `${x.name}\u0000${x.role}`;
      const at = extras.get(anchor) || extras.set(anchor, new Map()).get(anchor);
      add(at.get(key) || at.set(key, { kind: 'extra', name: x.name, role: x.role, walks: {} }).get(key), k + 1, x);
    }
  });
  const sideOf = (row, ks) => {
    const on = ks.map((k) => k + 1).filter((n) => row.walks[n]);
    if (!on.length) return null;
    const v = on.map((n) => row.walks[n]);
    return { walks: on, happened: on.length, wait: spanOf(v.map((o) => [o.waitSec, o.paused])), work: spanOf(v.map((o) => [o.workSec, o.workPaused])),
      stood: on.filter((n) => row.walks[n].interruptions).map((n) => [n, row.walks[n]]) };
  };
  const stoodText = (sd, n) => (sd.stood.length ? ` · ${sd.stood.map(([w, o]) => `${o.stoodSec ? `stood still ${stoodWords(o.stoodSec)}, ` : ''}interrupted ${o.interruptions} ${o.interruptions === 1 ? 'time' : 'times'}${n > 1 ? ` on walk ${w}` : ''}`).join('; ')}` : '');
  const reasonsOf = (row) => {
    const said = Object.entries(row.walks).flatMap(([n, o]) => o.reasons.map((t) => [Number(n), t]));
    if (!said.length) return null;
    return said.every((x) => x[1] === said[0][1]) ? `Reason recorded on ${walkNos([...new Set(said.map((x) => x[0]))])}: ${said[0][1]}` : `Reasons recorded: ${said.map(([n, t]) => `walk ${n}, ${t}`).join('; ')}`;
  };
  const rows = [];
  const listedRow = (row) => {
    const b = sideOf(row, bk); const a = sideOf(row, ak);
    const cell = (sd, n) => (!sd ? 'did not happen' : `wait ${sideWords(sd.wait, n)} · ${sideWords(sd.work)}${stoodText(sd, n)}`);
    return { ...row, before: b, after: a, reasonText: reasonsOf(row),
      againText: Object.keys(againRows.get(row.stepId).walks).length ? `Done again on ${walkNos(Object.keys(againRows.get(row.stepId).walks).map(Number))}` : null,
      beforeText: cell(b, bk.length), afterText: cell(a, ak.length),
      diff: b && a ? diffWords(b.wait, a.wait) : { dir: 'none', text: b ? 'did not happen after the change' : a ? 'did not happen before the change' : 'did not happen' } };
  };
  // A row that is on some walks only: the step not on the list, and a list step's later times.
  const someRow = (row) => {
    const b = sideOf(row, bk); const a = sideOf(row, ak);
    const text = (sd) => (sd ? `on ${walkNos(sd.walks)}: wait ${sideWords(sd.wait)} · ${sideWords(sd.work)}${stoodText(sd, sd.walks.length)}` : 'not on these walks');
    return { ...row, before: b, after: a, beforeText: text(b), afterText: text(a), reasonText: reasonsOf(row),
      diff: b && a ? diffWords(b.wait, a.wait) : { dir: 'none', text: b ? 'only before the change' : 'only after the change' } };
  };
  const pushExtras = (anchor) => { for (const row of (extras.get(anchor) || new Map()).values()) rows.push(someRow(row)); };
  pushExtras('');
  list.forEach((st) => {
    rows.push(listedRow(stepRows.get(st.id)));
    if (Object.keys(againRows.get(st.id).walks).length) rows.push(someRow(againRows.get(st.id)));
    pushExtras(st.id);
  });
  // Totals over the walks walked to the end, from each walk's own numbers.
  const full = (ks) => ks.filter((k) => rg.walks[k]?.complete !== false);
  const tot = (ks, pick) => spanOf(full(ks).map((k) => pick(rg.walks[k])));
  const totals = [['Start to finish', (w) => [w.elapsedSec, false]], ['Waiting in all', (w) => [w.waitSec, w.waitNotSeenSec > 0]], ['Hands-on in all', (w) => [w.workSec, w.workNotSeenSec > 0]]]
    .map(([label, pick]) => { const b = tot(bk, pick); const a = tot(ak, pick); return { label, before: b, after: a, beforeText: sideWords(b), afterText: sideWords(a), diff: diffWords(b, a) }; });
  return { both: true, afterWalk, line: changeLine(afterWalk, records.length), before: { walks: bk.map((k) => k + 1) }, after: { walks: ak.map((k) => k + 1) },
    heads: [`Before (${countWalks(bk.length)})`, `After (${countWalks(ak.length)})`, 'Difference in the wait'],
    rows, totals, caveat: CHANGE_CAVEAT(bk.length + ak.length) };
}

// The positions (in walkItems) of a walk's longest wait or waits. longest: that walk's entries in
// ospeli_maps_get's range.walks[n].longest ({ key, waitSec }), keyed by step id or "off:<name>", or
// walksLongest's (before: true, whose waitSec is the wait before the step, stood-still time left out).
export function longestPositions(items, longest) {
  const out = [];
  for (const l of longest || []) {
    const hit = items.find((x) => !out.includes(x.p) && (x.stepId || `off:${x.name}`) === l.key && (l.before ? x.waitBeforeSec : x.waitSec) === l.waitSec);
    if (hit) out.push(hit.p);
  }
  return out;
}

// The table: one row per list step, in list order, with one cell per walk; a step not on the list
// is its own row under the list step it followed on its walk (at the top when it came first).
// Each cell keeps the seconds; a list step done more than once on a walk adds its times together.
export function resultTable(list, records) {
  const perWalk = records.map((r) => walkItems(list, r));
  const rows = [];
  const extrasAfter = new Map(); // list step id (or '') -> off-list rows
  perWalk.forEach((items, w) => {
    let anchor = '';
    for (const x of items) {
      if (x.onList) { anchor = x.stepId; continue; }
      const cells = records.map((_, k) => (k === w ? cellOf([x], records[k], null) : { status: 'not-on-walk' }));
      const row = { kind: 'extra', name: x.name, role: x.role, walk: w + 1, after: anchor || null, cells };
      (extrasAfter.get(anchor) || extrasAfter.set(anchor, []).get(anchor)).push(row);
    }
  });
  rows.push(...(extrasAfter.get('') || []));
  list.forEach((st, i) => {
    rows.push({ kind: 'step', order: i + 1, stepId: st.id, name: st.name, role: st.role,
      cells: records.map((r, k) => cellOf(perWalk[k].filter((x) => x.stepId === st.id), r, st.id)) });
    rows.push(...(extrasAfter.get(st.id) || []));
  });
  return rows;
}
function cellOf(at, rec, stepId) {
  if (!at.length) {
    if (stepId && (rec.didNotHappen || []).includes(stepId)) return { status: 'did-not-happen' };
    return { status: 'not-timed' };
  }
  const sum = (k) => at.reduce((n, x) => n + (x[k] || 0), 0);
  // waitSec: the wait before the step, the time it stood still apart (stoppedSec; #180 point 2).
  const reason = at.map((x) => waitReasonText(x.rec.waitReason)).find(Boolean);
  const stop = at.map((x) => waitReasonText(x.rec.stopReason)).find(Boolean);
  return { status: 'timed', times: at.length, ...(reason ? { reason: `Reason recorded on the walk: ${reason}` } : {}), ...(stop ? { stopReason: `What stopped it, recorded on the walk: ${stop}` } : {}),
    each: at.map((x) => ({ waitSec: x.waitBeforeSec, workSec: x.workSec, waitNotSeenSec: x.waitNotSeenSec, workNotSeenSec: x.workNotSeenSec, interruptions: x.interruptions, stoppedSec: x.stoppedSec })), waitSec: sum('waitBeforeSec'), workSec: sum('workSec'), waitNotSeenSec: sum('waitNotSeenSec'), workNotSeenSec: sum('workNotSeenSec'),
    interruptions: sum('interruptions'), stoppedSec: sum('stoppedSec') };
}

// A cell in words, whole minutes: "wait 13 min · 4 min", "did not happen", "not timed".
// The wait is the wait before the step; time the step stood still once started is said apart
// (#180 point 2): "wait 5 min · 4 min · stood still 3 min, interrupted 1 time".
// A step done more than once on a walk says each time on its own, so no wait reads longer than
// the walk's longest wait: "1st: wait 13 min · 15 min; 2nd: wait 5 min · 6 min".
const ORDINAL = ['1st', '2nd', '3rd'];
function onceWords(c) {
  const wait = c.waitNotSeenSec > 0 ? atLeastWords(c.waitSec) : minWords(c.waitSec);
  const work = c.workNotSeenSec > 0 ? atLeastWords(c.workSec) : minWords(c.workSec);
  const times = c.interruptions ? `interrupted ${c.interruptions} ${c.interruptions === 1 ? 'time' : 'times'}` : '';
  const stood = c.interruptions ? ` · ${c.stoppedSec ? `stood still ${stoodWords(c.stoppedSec)}, ` : ''}${times}` : '';
  return `wait ${wait} · ${work}${stood}`;
}
export function cellWords(c) {
  if (c.status === 'did-not-happen') return 'did not happen';
  if (c.status === 'not-timed') return 'not timed';
  if (c.status === 'not-on-walk') return '–';
  if (c.times > 1 && c.each) return c.each.map((x, i) => `${ORDINAL[i] || `${i + 1}th`}: ${onceWords(x)}`).join('; ');
  return onceWords(c);
}

// The steps not on the list and the list steps done again, walk by walk, never dropped.
export function extrasOf(list, records) {
  const extra = []; const again = [];
  records.forEach((r, w) => {
    const items = walkItems(list, r);
    for (const x of items) if (!x.onList) extra.push({ walk: w + 1, name: x.name, role: x.role, waitSec: x.waitSec, workSec: x.workSec, after: items.slice(0, x.p).reverse().find((y) => y.onList)?.name || null });
    const counts = new Map();
    for (const x of items) if (x.onList) counts.set(x.stepId, (counts.get(x.stepId) || 0) + 1);
    for (const [id, n] of counts) if (n > 1) again.push({ walk: w + 1, stepId: id, name: list.find((s) => s.id === id)?.name, times: n });
  });
  const steps = (n) => `${n} ${n === 1 ? 'step' : 'steps'}`;
  const words = [extra.length ? `${extra.length} extra ${extra.length === 1 ? 'step' : 'steps'}` : null, again.length ? `${steps(again.length)} done again` : null].filter(Boolean).join(', ');
  return { extra, again, words };
}

// Which walks show as table columns: the newest `max`, oldest first. Returns walk indexes (from 0).
export function newestWalks(count, max) {
  const from = Math.max(0, count - max);
  return Array.from({ length: count - from }, (_, i) => from + i);
}
// "Showing walks 2 to 4 of 4. Print and CSV hold all of them." Null when every walk shows.
export function columnsNote(count, max, { where = 'phone' } = {}) {
  if (count <= max) return null;
  const from = count - max + 1;
  return where === 'print' ? `Showing the newest ${max} walks (${from} to ${count} of ${count}). The CSV holds all of them.`
    : `Showing walks ${from} to ${count} of ${count}. Print and CSV hold all of them.`;
}

// ---- CSV ----
// Every field is quoted. A cell that a spreadsheet would read as a formula (it begins with =, +,
// -, @, a tab or a carriage return, also after leading spaces of any kind, which some spreadsheets
// drop first) gets a ' in front, so it is shown as text and never run.
export function csvCell(v) {
  let s = v == null ? '' : String(v);
  if (/^[\s\u00a0\u3000\ufeff]*[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}
export const CSV_HEAD = ['map', 'department', 'walk number', 'walk date', 'step order', 'step', 'role', 'on list', 'wait seconds', 'hands-on seconds', 'not-seen seconds', 'interrupted count', 'stopped seconds (inside wait)', 'done again', 'status', 'walk usable', 'before or after the change', 'wait reason (recorded on the walk)', 'last stop reason (recorded on the walk)', 'step name typed'];
// Whether a walk's times can be used (#191 point 3), as the Result tab says it: a walk whose clock
// moved back is left out of every range, a walk stopped early out of the totals.
export const walkUsableWord = (r) => (r.clockMoved ? 'clock moved back' : r.stoppedEarly ? 'stopped early' : 'yes');
// One row per walk per step, in the order the steps happened; then, for that walk, each list step
// that did not happen or was not timed (no seconds). dateOf: the walk's date as YYYY-MM-DD.
// afterWalk: the change a person marked (ospeli_maps_change_set); each row says before or after it.
export function csvOf({ title, department, list, records, dateOf, afterWalk = null }) {
  const lines = [CSV_HEAD.map(csvCell).join(',')];
  records.forEach((r, w) => {
    const items = walkItems(list, r);
    const side = afterWalk ? (w + 1 <= afterWalk ? 'before' : 'after') : '';
    const row = (o, tail) => lines.push([title, department || '', w + 1, dateOf(r.startedAt), ...o, walkUsableWord(r), side, ...tail].map(csvCell).join(','));
    for (const x of items) row([x.p + 1, x.name, x.role, x.onList ? 'yes' : 'no', x.waitSec, x.workSec, x.waitNotSeenSec + x.workNotSeenSec, x.interruptions, x.stoppedSec, x.again ? 'yes' : 'no', 'timed'], [waitReasonText(x.rec.waitReason) || '', waitReasonText(x.rec.stopReason) || '', x.rec.typed || (list.find((st) => st.id === x.stepId)?.typed) ? 'yes' : 'no']);
    for (const st of list) {
      if (items.some((x) => x.stepId === st.id)) continue;
      row(['', st.name, st.role, 'yes', '', '', '', '', '', 'no', (r.didNotHappen || []).includes(st.id) ? 'did not happen' : 'not timed'], ['', '', st.typed ? 'yes' : 'no']);
    }
  });
  return `${lines.join('\r\n')}\r\n`;
}
// A file name from a typed title: letters and digits only, never a path.
export function fileNameOf(title, ext = 'csv') {
  const slug = String(title || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
  return `ospeli-${slug || 'map'}-walks.${ext}`;
}

// ---- the plain-text summary for "Copy as text" and "Share" ----
// head: [title, header line]; headline, totals: lines; walks: lines, one per walk;
// rows: { name, cells: [words per walk], extra }; read: the "How to read this" line.
// compare: the before-and-after lines when a change is marked (heads, rows, totals, caveat).
export function summaryText({ head, headline, totals, walks, rows, columns, read, count, compare = null }) {
  const out = [...head.filter(Boolean), '', headline, ...totals.filter(Boolean), '', ...walks, '', `Steps (wait before the step · hands-on), ${columns.join(', ')}:`];
  for (const r of rows) out.push(`${r.extra ? '  + ' : ''}${r.name}: ${r.cells.join(' | ')}`);
  if (compare?.length) out.push('', ...compare);
  out.push('', `How to read this: ${read}`, `Measured on ${count} ${count === 1 ? 'walk' : 'walks'}: examples, not a sample.`);
  return out.join('\n');
}
