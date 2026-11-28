// The words of a walked map's result (walk-first week, crew night 2): whole minutes, "at least"
// only where that walk was paused during that time, "the same" only within 10%, and the walk
// counts said as "1 of 2 walks", never "all 1 walks". Pure functions over the numbers the core
// gives (core/walk.js); nothing here changes a number, it only says it.
import { MIN_LONGEST_WAIT_SEC, waitPlace } from '../core/walk.js';

// Local definition, an example setting and not a standard: two walks' times are called "the same"
// only when the shorter is within 10% of the longer.
export const SAME_WITHIN = 0.1;
export const SAME_RULE = `Two walks are called “the same” only when their times are within ${Math.round(SAME_WITHIN * 100)}% of each other (example setting, not a standard).`;

// Whole minutes for a time on the result: "under 1 min", "27 min", "1 h 49 min", "2 h".
// floor: round down, for a time that is the least it can have been ("at least").
export function minWords(sec, { floor = false } = {}) {
  sec = Math.max(0, +sec || 0);
  if (sec < 60) return 'under 1 min';
  const m = floor ? Math.floor(sec / 60) : Math.round(sec / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60); const r = m % 60;
  return r ? `${h} h ${r} min` : `${h} h`;
}

// A longest wait (Domain lead, 27 Nov): under 5 minutes it keeps its seconds, so 2 min 30 s is not
// read as 3 min ("45 s", "2 min 30 s", "4 min"); from 5 minutes up, whole minutes as minWords.
// floor: round down, for a time that is the least it can have been.
export const SECONDS_UNDER = 300;
export function waitWords(sec, { floor = false } = {}) {
  sec = Math.max(0, +sec || 0);
  if (sec >= SECONDS_UNDER) return minWords(sec, { floor });
  const s = floor ? Math.floor(sec) : Math.round(sec);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60); const r = s % 60;
  return r ? `${m} min ${r} s` : `${m} min`;
}
// A longest wait the walk was paused during: the seen part is the least it can have been.
export const atLeastWait = (seenSec) => `at least ${waitWords(seenSec, { floor: true })}`;
// The longest wait before a step on one walk, with its seconds under 5 minutes.
export const longestAmount = (x) => (x.waitNotSeenSec > 0 ? atLeastWait(x.wait) : waitWords(x.wait));

// The time a step stood still once started (#180 point 2), said apart from its wait: under a
// minute in seconds ("17 s"), so a short stop is not read as nothing; otherwise whole minutes.
export function stoodWords(sec) {
  sec = Math.max(0, Math.round(+sec || 0));
  return sec < 60 ? `${sec} s` : minWords(sec);
}

// A share worked out from the whole minutes shown beside it (#189 night 5 item 6), so "11 min
// waiting" and "14 min start to finish" read as 79%, never a percent from the seconds behind them.
// Null when the whole is under a minute.
export function shareOfShown(partSec, wholeSec) {
  const whole = Math.round(Math.max(0, +wholeSec || 0) / 60);
  if (!whole) return null;
  return Math.round((100 * Math.round(Math.max(0, +partSec || 0) / 60)) / whole);
}

// A seen time that was partly not seen (the walk was paused during it): the seen part is the least
// it can have been. Never "at least under 1 min": a seen part under a minute says what was seen.
export function atLeastWords(seenSec) {
  return seenSec < 60 ? 'under 1 min seen' : `at least ${minWords(seenSec, { floor: true })}`;
}
const minWordsOf = minWords; const atLeastOf = atLeastWords;

// The wait before a step on one walk: "27 min", or "at least 27 min" when the walk was paused during it.
export const waitAmount = (x) => (x.waitNotSeenSec > 0 ? atLeastWords(x.wait) : minWords(x.wait));
export const notSeenPart = (x) => (x.waitNotSeenSec > 0 ? ` (${minWords(x.waitNotSeenSec)} more of it not seen)` : '');
// The same words as core/walk.js interruptedWords, in whole minutes.
export const interruptedPart = (x) => (x.interruptedWaitSec > 0 ? ` (${minWords(x.interruptedWaitSec)} of it while the step was interrupted)` : '');

export const sameWithin = (a, b) => Math.max(a, b) === 0 || Math.abs(a - b) <= SAME_WITHIN * Math.max(a, b);

// "on both walks", "on all 3 walks", "on 1 of 2 walks", "on 1 walk".
export function walksWords(n, m = n) {
  if (n >= m) return m === 1 ? 'on 1 walk' : m === 2 ? 'on both walks' : `on all ${m} walks`;
  return `on ${n} of ${m} walks`;
}

// A span from the core (walkRanges: { n, min, max, minAtLeast, maxAtLeast }). Its at-least flags
// say that some walk in it was partly not seen, not which one, so they cannot be put on an end
// (core/walk.js span(): reported to the Builder). With one walk the flag is that walk's own.
export const fromCoreSpan = (r) => (!r || !r.n ? { n: 0 }
  : r.n === 1 ? { n: 1, min: r.min, max: r.max, maxAtLeast: !!r.maxAtLeast }
    : { n: r.n, min: r.min, max: r.max, partly: !!(r.maxAtLeast || r.minAtLeast) });

// A span made here from each walk's own value: vals is [seconds, that walk was paused during it].
// The high end says "at least" only when a walk that gave it was paused; a pause anywhere else is "partly not seen".
export function spanOf(vals) {
  if (!vals.length) return { n: 0 };
  const v = vals.map((x) => x[0]); const min = Math.min(...v); const max = Math.max(...v);
  const maxAtLeast = vals.some((x) => x[0] === max && x[1]);
  const partly = vals.some((x) => x[1] && !(maxAtLeast && x[0] === max));
  return { n: vals.length, min, max, ...(maxAtLeast ? { maxAtLeast } : {}), ...(partly ? { partly } : {}) };
}

// A time across walks, lowest to highest, in whole minutes:
//   "41 to 58 min", "54 min to 1 h 8 min", "53 min (the same on both walks)" (within 10%),
//   "about 2 min on both walks" (the same whole minutes, but more than 10% apart),
//   "41 to at least 58 min" (the walk that gave 58 was paused during it),
//   "… · partly not seen" (another walk was paused during it). of: the walks it could have been timed on.
// fine: a longest wait, with its seconds under 5 minutes (waitWords).
export function rangeWords(r, { of = null, fine = false } = {}) {
  if (!r || !r.n) return 'not timed';
  const minWords = fine ? waitWords : minWordsOf; const atLeastWords = fine ? atLeastWait : atLeastOf;
  const count = of && r.n < of ? ` (${walksWords(r.n, of)})` : '';
  let partly = !!r.partly;
  const end = (sec, atLeast) => { if (atLeast && sec < 60) { partly = true; return minWords(sec); } return atLeast ? atLeastWords(sec) : minWords(sec); };
  if (r.n === 1) return `${r.maxAtLeast ? atLeastWords(r.max) : minWords(r.max)}${count}${partly ? ' · partly not seen' : ''}`;
  const a = end(r.min, false); const b = end(r.max, r.maxAtLeast);
  let text;
  if (a === b && sameWithin(r.min, r.max) && !partly) text = `${a} (the same ${walksWords(r.n, of || r.n)})`;
  else if (a === b || minWords(r.min) === minWords(r.max)) {
    const t = minWords(r.max);
    text = `${t === 'under 1 min' ? t : `about ${t}`} ${walksWords(r.n, of || r.n)}`; if (r.maxAtLeast) partly = true;
  }
  else {
    // "41 to 58 min" says the unit once; "54 min to 1 h 8 min" keeps both.
    const short = /^\d+ min$/.test(a) && /^(at least )?\d+ min$/.test(b);
    text = `${short ? a.replace(' min', '') : a} to ${b}${count}`;
  }
  return `${text}${partly ? ' · partly not seen' : ''}`;
}

// ---- the headline: where the longest wait is ----

// One walk: top is core/walk.js longestWaits(steps in seconds). Null when no wait reaches the floor.
export function longestOneWalk(top) {
  if (!top.length) return null;
  const whole = (x) => `${longestAmount(x)} ${waitPlace(x)}${interruptedPart(x)}${notSeenPart(x)}`;
  if (top.length === 1) return { lead: 'Longest wait: ', text: whole(top[0]) };
  // Tied: one time when none of them was paused or interrupted, otherwise each said in full.
  const plain = top.every((x) => !(x.waitNotSeenSec > 0) && !(x.interruptedWaitSec > 0));
  return { lead: 'Longest waits, tied: ', text: plain ? `${waitWords(top[0].wait)} before ${top.map((x) => `“${x.name}”`).join(' and ')}` : top.map(whole).join(' and ') };
}
export const NO_LONG_WAIT = (several) => `No wait of ${MIN_LONGEST_WAIT_SEC} seconds or more on ${several ? 'these walks' : 'this walk'}.`;

// Two or more walks: rg is ospeli_maps_get's range. Each walk's own longest wait, with its own
// time and its own pause; "n of m walks" counts the walks where that step happened.
// records (optional): the walks' own records, in walk order. The range does not carry the time a
// step stood still, so "at" a step (the wait was inside an interrupted step, #169 item 5) is read
// from them; without them every wait reads "before".
const keyOfLongest = (l) => (l.stepId || `off:${l.name}`);
// One named step's time across the walks where it was the longest: "10 to 13 min", "4 min".
// rg: the range longestWalks reads; l: one of rg.longest.
export function longestTimeOf(rg, l) {
  const r = spanOf(l.walks.map((n) => { const v = rg.walks[n - 1]?.longest.find((x) => x.key === keyOfLongest(l)); return [v?.waitSec || 0, !!v?.atLeast]; }));
  if (r.n > 1 && waitWords(r.min) === waitWords(r.max)) return `${r.maxAtLeast ? atLeastWait(r.max) : waitWords(r.max)}${r.partly ? ' · partly not seen' : ''}`;
  return rangeWords(r, { fine: true });
}
export function longestWalks(rg, records = null) {
  const lo = rg.longest || [];
  if (!lo.length) return null;
  const keyOf = keyOfLongest;
  const valOf = (l, n) => rg.walks[n - 1]?.longest.find((x) => x.key === keyOf(l));
  const happened = (l) => (l.stepId ? rg.steps.find((s) => s.stepId === l.stepId)?.happened || l.walks.length : l.walks.length);
  const usable = rg.usable ?? rg.walks.filter((w) => w.usable).length;
  // The time alone: where it happened is said once, after it ("on 2 of 3 walks"), never twice.
  const timeOf = (l) => longestTimeOf(rg, l);
  const where = (l) => {
    const m = happened(l);
    if (!l.stepId && l.walks.length === 1) return `on walk ${l.walks[0]} only`;
    return `${walksWords(l.walks.length, m)}${m < usable && l.walks.length === m ? ' it happened on' : ''}`;
  };
  // "at" when, on any walk where it was the longest, that wait was partly the step standing still.
  const stood = (l) => !!records && l.walks.some((n) => { const v = valOf(l, n); const r = records[n - 1];
    return v && r && r.steps.some((s) => (s.stepId || `off:${s.name}`) === keyOf(l) && s.waitSec === v.waitSec && s.interruptedWaitSec > 0); });
  const one = (l) => `${timeOf(l)} ${stood(l) ? 'at' : 'before'} “${l.name}”`;
  // Every walk's longest wait at one step: one sentence.
  if (lo.length === 1) return { lead: 'Longest wait: ', text: `${one(lo[0])}, ${where(lo[0])}` };
  // It moved: walk by walk.
  if (lo.every((l) => l.walks.length === 1)) {
    const byWalk = lo.map((l) => [l.walks[0], l]).sort((a, b) => a[0] - b[0]);
    return { lead: 'Longest wait moved: ', text: byWalk.map(([n, l]) => `walk ${n}, ${one(l)}`).join('; ') };
  }
  const [first, ...rest] = lo;
  return { lead: 'Longest wait: ', text: `${one(first)}, ${where(first)}; ${rest.map((l) => `walk ${l.walks.join(' and ')}, ${one(l)}`).join('; ')}` };
}

// The guide's title for where the longest wait fell, in the same words (core/walk.js
// suggestWalks says "on all 1 walks" when only one walk had a wait over the floor).
export function longestTitle(rg, records = null) {
  const w = longestWalks(rg, records);
  if (!w) return null;
  return w.lead.startsWith('Longest wait moved') ? 'The longest wait moved on each walk' : `The longest wait was ${w.text}`;
}

// Totals across the walks walked to the end, from each walk's own numbers (so "at least" sits
// only on the end that a paused walk gave). key: 'elapsed', 'wait' or 'work'.
export function totalSpan(rg, key) {
  const full = rg.walks.filter((w) => w.complete);
  const pick = { elapsed: (w) => [w.elapsedSec, false], wait: (w) => [w.waitSec, w.waitNotSeenSec > 0], work: (w) => [w.workSec, w.workNotSeenSec > 0] }[key];
  return spanOf(full.map(pick));
}

// The guide's titles on a walked map, in the same whole minutes as the result. The guide's rules
// and their reasons are the core's (core/walk.js suggestWalk, suggestWalks); only the times in a
// title are said again here, from the same steps. steps: the map's steps in seconds.
export function guideTitle(sg, steps, rg = null, records = null) {
  if (sg.id === 'walks-longest' && rg) return longestTitle(rg, records) || sg.title;
  if (rg) return sg.title;
  if (sg.id.startsWith('walk-wait-')) {
    const top = steps.filter((x) => !x.plannedWait);
    const max = Math.max(0, ...top.map((x) => x.wait || 0));
    const tied = top.filter((x) => x.wait === max);
    const w = longestOneWalk(tied);
    if (!w) return sg.title;
    return tied.length === 1 ? `Longest wait on this walk: ${w.text}` : `Longest wait on this walk, tied: ${waitWords(max)} each, ${tied.map((x) => waitPlace(x)).join(' and ')}${tied.some((x) => x.waitNotSeenSec > 0) ? ' · partly not seen' : ''}`;
  }
  if (sg.id === 'walk-planned') {
    const p = steps.filter((x) => x.plannedWait);
    return `${p.length} ${p.length === 1 ? 'wait is' : 'waits are'} marked planned or required: ${minWords(p.reduce((n, x) => n + (x.wait || 0), 0))}`;
  }
  if (sg.id === 'walk-not-seen') return `${minWords(steps.reduce((n, x) => n + (x.waitNotSeenSec || 0) + (x.workNotSeenSec || 0), 0))} of this walk was not seen`;
  if (sg.id === 'walk-interrupted') {
    const stops = steps.reduce((n, x) => n + (x.interruptions || 0), 0); const stood = steps.reduce((n, x) => n + (x.interruptedWaitSec || 0), 0);
    return `${stops} ${stops === 1 ? 'interruption' : 'interruptions'} on this walk${stood ? `: ${minWords(stood)} stood still` : ''}`;
  }
  return sg.title;
}

// The core's range basis says "3 walks are examples, not a sample" from the aim, whatever the
// count (core/walk.js RANGE_BASIS.range). Said with the real count of walks on this map.
export function rangeBasisWords(text, rg) {
  if (!text || !rg || rg.count === rg.aim) return text;
  return text.replace(`${rg.aim} walks are examples, not a sample`, `${rg.count} ${rg.count === 1 ? 'walk is an example' : 'walks are examples'}, not a sample`);
}

// What a step's ring says on a map with two or more walks: "longest wait" when it was the longest
// on every walk that named one, otherwise which walks ("longest wait on walk 1", "… on walks 1 and 3").
export function hotWords(rg, stepId) {
  const l = (rg?.longest || []).find((x) => x.stepId === stepId);
  if (!l) return '';
  if (l.walks.length >= (rg.longestOf || 0) && rg.longest.length === 1) return 'longest wait';
  return `longest wait on ${l.walks.length === 1 ? 'walk' : 'walks'} ${l.walks.join(' and ')}`;
}
