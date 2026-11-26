// The one-screen result of a walked map (walk-first week, crew night 3): pure functions over the
// walk records (core/walk.js recordFromWalk) and the map's saved step list. Nothing here changes a
// number; it lays the records out by step, walk by walk, for the table, the bars, the CSV and the
// plain-text summary. Steps and roles only: no person is named, timed or ranked.
import { minWords, atLeastWords, spanOf } from './result-words.js';
import { waitReasonText } from '../core/walk.js';

// Why a wait happened, when the person walking recorded it with one tap (core/walk.js WAIT_REASONS;
// record step field waitReason). Null when none was given. The words say where the reason came
// from first: it is one person's observation on one walk, not a cause found by Ospeli.
export function waitReasonOf(recordStep) {
  const text = waitReasonText(recordStep?.waitReason);
  return text ? `reason recorded on the walk: ${text.charAt(0).toLowerCase()}${text.slice(1)}` : null;
}

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
      interruptions: interruptionsOf(s), stoppedSec: s.interruptedWaitSec || 0, reason: waitReasonOf(s), rec: s };
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

// The positions (in walkItems) of a walk's longest wait or waits. longest: that walk's entries in
// ospeli_maps_get's range.walks[n].longest ({ key, waitSec }), keyed by step id or "off:<name>".
export function longestPositions(items, longest) {
  const out = [];
  for (const l of longest || []) {
    const hit = items.find((x) => !out.includes(x.p) && (x.stepId || `off:${x.name}`) === l.key && x.waitSec === l.waitSec);
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
  return { status: 'timed', times: at.length, each: at.map((x) => ({ waitSec: x.waitSec, workSec: x.workSec, waitNotSeenSec: x.waitNotSeenSec, workNotSeenSec: x.workNotSeenSec, interruptions: x.interruptions, stoppedSec: x.stoppedSec })), waitSec: sum('waitSec'), workSec: sum('workSec'), waitNotSeenSec: sum('waitNotSeenSec'), workNotSeenSec: sum('workNotSeenSec'),
    interruptions: sum('interruptions'), stoppedSec: sum('stoppedSec') };
}

// A cell in words, whole minutes: "wait 13 min · 4 min", "did not happen", "not timed".
// Time a step stood still is inside its wait (core/walk.js), so it is said as part of the wait,
// never beside it: "wait 8 min (3 min stopped, interrupted 1 time) · 4 min".
// A step done more than once on a walk says each time on its own, so no wait reads longer than
// the walk's longest wait: "1st: wait 13 min · 15 min; 2nd: wait 5 min · 6 min".
const ORDINAL = ['1st', '2nd', '3rd'];
function onceWords(c) {
  const wait = c.waitNotSeenSec > 0 ? atLeastWords(c.waitSec) : minWords(c.waitSec);
  const work = c.workNotSeenSec > 0 ? atLeastWords(c.workSec) : minWords(c.workSec);
  const times = c.interruptions ? `interrupted ${c.interruptions} ${c.interruptions === 1 ? 'time' : 'times'}` : '';
  const stop = c.interruptions ? ` (${c.stoppedSec ? `${minWords(c.stoppedSec)} stopped, ` : ''}${times})` : '';
  return `wait ${wait}${stop} · ${work}`;
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
export const CSV_HEAD = ['map', 'department', 'walk number', 'walk date', 'step order', 'step', 'role', 'on list', 'wait seconds', 'hands-on seconds', 'not-seen seconds', 'interrupted count', 'stopped seconds (inside wait)', 'done again', 'status', 'wait reason (recorded on the walk)', 'last stop reason (recorded on the walk)', 'step name typed'];
// One row per walk per step, in the order the steps happened; then, for that walk, each list step
// that did not happen or was not timed (no seconds). dateOf: the walk's date as YYYY-MM-DD.
export function csvOf({ title, department, list, records, dateOf }) {
  const lines = [CSV_HEAD.map(csvCell).join(',')];
  records.forEach((r, w) => {
    const items = walkItems(list, r);
    const row = (o) => lines.push([title, department || '', w + 1, dateOf(r.startedAt), ...o].map(csvCell).join(','));
    for (const x of items) row([x.p + 1, x.name, x.role, x.onList ? 'yes' : 'no', x.waitSec, x.workSec, x.waitNotSeenSec + x.workNotSeenSec, x.interruptions, x.stoppedSec, x.again ? 'yes' : 'no', 'timed', waitReasonText(x.rec.waitReason) || '', waitReasonText(x.rec.stopReason) || '', x.rec.typed || (list.find((st) => st.id === x.stepId)?.typed) ? 'yes' : 'no']);
    for (const st of list) {
      if (items.some((x) => x.stepId === st.id)) continue;
      row(['', st.name, st.role, 'yes', '', '', '', '', '', 'no', (r.didNotHappen || []).includes(st.id) ? 'did not happen' : 'not timed', '', '', st.typed ? 'yes' : 'no']);
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
export function summaryText({ head, headline, totals, walks, rows, columns, read, count }) {
  const out = [...head.filter(Boolean), '', headline, ...totals.filter(Boolean), '', ...walks, '', `Steps (wait before the step · hands-on), ${columns.join(', ')}:`];
  for (const r of rows) out.push(`${r.extra ? '  + ' : ''}${r.name}: ${r.cells.join(' | ')}`);
  out.push('', `How to read this: ${read}`, `Measured on ${count} ${count === 1 ? 'walk' : 'walks'}: examples, not a sample.`);
  return out.join('\n');
}
