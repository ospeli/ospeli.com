// The one-screen result (walk-first week, crew night 3): the step table, the bars' longest wait,
// the extra and redone steps, the CSV (with the formula attack) and the plain-text summary.
// Walks are made with the core's own functions; synthetic step names and times only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newWalk, stepStart, stepDone, nameLast, assignLast, stepResume, skipNext, recordFromWalk, walkRanges, stepsInSeconds, mapStepsFromWalk } from '../../web/app/core/walk.js';
import { waitReasonOf, recordFromSteps, walkItems, longestPositions, resultTable, cellWords, extrasOf, newestWalks, columnsNote, csvCell, csvOf, CSV_HEAD, fileNameOf, summaryText } from '../../web/app/modules/result-data.js';
import { longestWalks, rangeBasisWords, hotWords } from '../../web/app/modules/result-words.js';
import { RANGE_BASIS } from '../../web/app/core/walk.js';

const T0 = Date.parse('2026-11-17T09:00:00Z');
const at = (sec) => new Date(T0 + sec * 1000).toISOString();
const LIST = [['Arrived', 'Patient'], ['Registered', 'Reception'], ['Scan', 'Imaging staff'], ['Left', 'Patient']];
const list = LIST.map(([name, role], i) => ({ id: `map-001-s${i + 1}`, name, role }));

// steps: [wait, work, extra] with extra { off: [name, role] } | { again: n } | { stop: [after, stood] }
function walk(steps, { start = 0, plan = true, id = 'walk-001', skip = [] } = {}) {
  const w = newWalk({ id, title: 'Outpatient CT', at: at(start), role: 'ops-manager', ...(plan ? { plan: list.map(({ id: i, name, role }) => ({ id: i, name, role })), repeatOf: 'map-001', walkNo: 2 } : {}) });
  let t = start;
  steps.forEach(([wait, work, x = {}], i) => {
    while (skip.length && skip[0] === i) { skipNext(w); skip.shift(); }
    t += wait; stepStart(w, at(t));
    if (x.stop) { t += x.stop[0]; stepDone(w, at(t), { interrupted: true }); t += x.stop[1]; stepResume(w, at(t)); t += work - x.stop[0]; } else t += work;
    stepDone(w, at(t));
    if (x.off) assignLast(w, { offList: true }), nameLast(w, { name: x.off[0], role: x.off[1] });
    else if (x.again) assignLast(w, { listIndex: x.again - 1 });
    else if (!plan) nameLast(w, { name: LIST[i][0], role: LIST[i][1] });
  });
  return recordFromWalk(w, { finishedAt: at(t), mapId: 'map-001' });
}
const W1 = walk([[60, 120], [240, 180, { stop: [60, 120] }], [600, 900], [60, 30]], { plan: false });
const W2 = walk([[30, 90], [180, 150], [120, 180, { off: ['Contrast check', 'Radiology nurse'] }], [780, 840], [300, 400, { again: 3 }], [45, 30]], { start: 86400, id: 'walk-002' });

test('waitReasonOf: a step with no reason given has none', () => {
  for (const s of [...W1.steps, ...W2.steps]) assert.equal(waitReasonOf(s), null);
});
// The field agreed with the walk Builder (26 Nov, #180 point 1): record step `waitReason`, an id from
// core/walk.js WAIT_REASONS. The words say where the reason came from before the reason itself.
test('waitReasonOf returns the reason once the walk records one, and nothing for an id that is not on the list', () => {
  assert.equal(waitReasonOf({ waitSec: 780, workSec: 840, waitReason: 'room-equipment' }), 'reason recorded on the walk: room or equipment');
  assert.equal(waitReasonOf({ waitSec: 780, workSec: 840, waitReason: 'made-up' }), null);
  assert.equal(waitReasonOf({ waitSec: 780, workSec: 840, reason: 'free text is never read' }), null);
});

test('walkItems: list steps named from the list, an off-list step with its own name and role, a step done again marked', () => {
  const items = walkItems(list, W2);
  assert.deepEqual(items.map((x) => [x.name, x.role, x.onList, x.again]), [
    ['Arrived', 'Patient', true, false], ['Registered', 'Reception', true, false], ['Contrast check', 'Radiology nurse', false, false],
    ['Scan', 'Imaging staff', true, false], ['Scan', 'Imaging staff', true, true], ['Left', 'Patient', true, false]]);
  // Walk 1: the interrupted step stood still 120 s; that is inside its wait (core/walk.js).
  const reg = walkItems(list, W1)[1];
  assert.deepEqual([reg.interruptions, reg.stoppedSec, reg.waitSec, reg.workSec], [1, 120, 240 + 120, 180 - 0]);
});

test('resultTable: one row per list step in list order, the off-list step under the step it followed, cells to the second', () => {
  const rows = resultTable(list, [W1, W2]);
  assert.deepEqual(rows.map((r) => (r.kind === 'extra' ? `+${r.name}@${r.after}` : r.name)), ['Arrived', 'Registered', '+Contrast check@map-001-s2', 'Scan', 'Left']);
  const scan = rows.find((r) => r.name === 'Scan');
  // A step done again: the cell keeps the sums and says each time on its own.
  assert.deepEqual([scan.cells[1].waitSec, scan.cells[1].workSec, scan.cells[1].times], [780 + 300, 840 + 400, 2]);
  assert.deepEqual([scan.cells[0].waitSec, scan.cells[0].workSec, scan.cells[0].times], [600, 900, 1]);
  const extra = rows.find((r) => r.kind === 'extra');
  assert.deepEqual([extra.walk, extra.role, extra.cells[0].status, extra.cells[1].waitSec, extra.cells[1].workSec], [2, 'Radiology nurse', 'not-on-walk', 120, 180]);
  // Every second of every record is in the table, once (the time a step stood still is kept apart, #180 point 2).
  for (const [k, r] of [W1, W2].entries()) {
    const sum = rows.reduce((n, row) => n + (row.cells[k].waitSec || 0) + (row.cells[k].stoppedSec || 0) + (row.cells[k].workSec || 0), 0);
    assert.equal(sum, r.steps.reduce((n, s) => n + s.waitSec + s.workSec, 0));
  }
});

test('an off-list step that came first sits at the top; "did not happen" and "not timed" are told apart', () => {
  const w = walk([[30, 60, { off: ['Wheelchair fetched', 'Porter'] }], [60, 60], [60, 60]], { skip: [2] });
  const r = { ...w, notTimed: ['map-001-s4'] };
  const rows = resultTable(list, [r]);
  assert.equal(rows[0].kind, 'extra');
  assert.equal(rows[0].after, null);
  assert.deepEqual(rows.filter((x) => x.kind === 'step').map((x) => x.cells[0].status), ['timed', 'did-not-happen', 'timed', 'not-timed'], 'Registered was skipped; Left was not reached');
});

test('cellWords: whole minutes, wait then hands-on, interruptions in the cell, "at least" only after a pause', () => {
  assert.equal(cellWords({ status: 'timed', times: 1, waitSec: 780, workSec: 240, waitNotSeenSec: 0, workNotSeenSec: 0, interruptions: 0, stoppedSec: 0 }), 'wait 13 min · 4 min');
  // #180 point 2 (crew night 5): waitSec is the wait before the step; the time it stood still once started is said apart.
  assert.equal(cellWords({ status: 'timed', times: 1, waitSec: 360, workSec: 180, interruptions: 1, stoppedSec: 120 }), 'wait 6 min · 3 min · stood still 2 min, interrupted 1 time');
  assert.equal(cellWords({ status: 'timed', times: 1, waitSec: 360, workSec: 180, interruptions: 2, stoppedSec: 0 }), 'wait 6 min · 3 min · interrupted 2 times');
  assert.equal(cellWords({ status: 'timed', times: 1, waitSec: 360, workSec: 180, interruptions: 1, stoppedSec: 17 }), 'wait 6 min · 3 min · stood still 17 s, interrupted 1 time');
  assert.equal(cellWords({ status: 'timed', times: 2, waitSec: 1080, workSec: 1260, each: [{ waitSec: 780, workSec: 900 }, { waitSec: 300, workSec: 360 }] }), '1st: wait 13 min · 15 min; 2nd: wait 5 min · 6 min');
  assert.equal(cellWords({ status: 'timed', times: 1, waitSec: 600, workSec: 60, waitNotSeenSec: 300 }), 'wait at least 10 min · 1 min');
  assert.equal(cellWords({ status: 'did-not-happen' }), 'did not happen');
  assert.equal(cellWords({ status: 'not-timed' }), 'not timed');
});

test('extrasOf: the counts in words, each extra and each redo listed', () => {
  const x = extrasOf(list, [W1, W2]);
  assert.equal(x.words, '1 extra step, 1 step done again');
  assert.deepEqual(x.extra.map((e) => [e.walk, e.name, e.role, e.after]), [[2, 'Contrast check', 'Radiology nurse', 'Registered']]);
  assert.deepEqual(x.again.map((e) => [e.walk, e.name, e.times]), [[2, 'Scan', 2]]);
  assert.equal(extrasOf(list, [W1]).words, '');
});

test('longestPositions and the headline: the outlined segment is the walk\'s own longest wait, by the core\'s rule', () => {
  const rg = walkRanges(list, [W1, W2]);
  const pos2 = longestPositions(walkItems(list, W2), rg.walks[1].longest);
  assert.deepEqual(pos2.map((p) => walkItems(list, W2)[p].name), ['Scan']);
  assert.equal(walkItems(list, W2)[pos2[0]].waitSec, 780, 'the first time the scan was done, not the redo');
  const pos1 = longestPositions(walkItems(list, W1), rg.walks[0].longest);
  assert.deepEqual(pos1.map((p) => walkItems(list, W1)[p].name), ['Scan']);
  assert.match(longestWalks(rg, [W1, W2]).text, /^10 to 13 min before “Scan”, on both walks$/);
});

test('#169 item 5: the headline says "at" a step when that walk\'s longest wait was inside the interrupted step', () => {
  const a = walk([[30, 60], [60, 300, { stop: [60, 900] }], [120, 60], [30, 30]], { plan: false });
  const b = walk([[30, 60], [60, 300, { stop: [60, 840] }], [120, 60], [30, 30]], { start: 86400, id: 'walk-002' });
  const rg = walkRanges(list, [a, b]);
  assert.match(longestWalks(rg).text, /before “Registered”/, 'without the records the range cannot tell');
  assert.match(longestWalks(rg, [a, b]).text, /^15 to 16 min at “Registered”, on both walks$/);
});

test('the headline says where once: never "on both walks …, on 2 of 3 walks"', () => {
  const c = walk([[30, 60], [60, 60], [400, 60], [30, 30]], { start: 172800, id: 'walk-003' });
  const a = walk([[30, 60], [60, 60], [400, 60], [30, 30]], { plan: false });
  const b = walk([[30, 60], [600, 60], [100, 60], [30, 30]], { start: 86400, id: 'walk-002' });
  const text = longestWalks(walkRanges(list, [a, b, c]), [a, b, c]).text;
  assert.doesNotMatch(text, /both walks.*of 3 walks/);
  assert.match(text, /^7 min before “Scan”, on 2 of 3 walks; walk 2, 10 min before “Registered”$/);
});

test('rangeBasisWords says the real count of walks; hotWords says which walk a ring is for', () => {
  const rg2 = { count: 2, aim: 3 };
  assert.match(RANGE_BASIS.range, /3 walks are examples, not a sample/);
  assert.match(rangeBasisWords(RANGE_BASIS.range, rg2), /No average is given: 2 walks are examples, not a sample\. The aim of 3 walks/);
  assert.equal(rangeBasisWords(RANGE_BASIS.range, { count: 3, aim: 3 }), RANGE_BASIS.range);
  const rg = { longest: [{ stepId: 'a', walks: [1] }, { stepId: 'b', walks: [2] }], longestOf: 2 };
  assert.equal(hotWords(rg, 'a'), 'longest wait on walk 1');
  assert.equal(hotWords(rg, 'b'), 'longest wait on walk 2');
  assert.equal(hotWords({ longest: [{ stepId: 'a', walks: [1, 2] }], longestOf: 2 }, 'a'), 'longest wait');
  assert.equal(hotWords(rg, 'zzz'), '');
});

test('newestWalks and the column notes: a phone shows the newest 3, paper the newest 6, the CSV all', () => {
  assert.deepEqual(newestWalks(4, 3), [1, 2, 3]);
  assert.deepEqual(newestWalks(2, 3), [0, 1]);
  assert.equal(columnsNote(4, 3), 'Showing walks 2 to 4 of 4. Print and CSV hold all of them.');
  assert.equal(columnsNote(3, 3), null);
  assert.equal(columnsNote(8, 6, { where: 'print' }), 'Showing the newest 6 walks (3 to 8 of 8). The CSV holds all of them.');
});

test('CSV attack: a typed name that a spreadsheet would run as a formula is kept as text', () => {
  for (const bad of ['=HYPERLINK("http://example.invalid","x")', '+1+1', '-2+3', '@SUM(A1)', '\t=1', '\r=1']) {
    const cell = csvCell(bad);
    assert.ok(cell.startsWith('"\''), `${JSON.stringify(bad)} is written as ${cell}`);
  }
  assert.equal(csvCell('say "hi", then go'), '"say ""hi"", then go"');
  assert.equal(csvCell(780), '"780"');
  assert.equal(csvCell(null), '""');
  assert.equal(csvCell('Scan'), '"Scan"');
});

test('csvOf: one row per walk per step, every field quoted, the formula attack defused, seconds as recorded', () => {
  const evil = { ...W2, steps: W2.steps.map((s) => (s.stepId ? s : { ...s, name: '=cmd|"/c calc"!A1', role: '@Porter' })) };
  const csv = csvOf({ title: '+Outpatient CT', department: 'Imaging', list, records: [W1, evil], dateOf: (iso) => iso.slice(0, 10) });
  const lines = csv.trimEnd().split('\r\n');
  assert.equal(lines[0], CSV_HEAD.map((x) => `"${x}"`).join(','));
  assert.deepEqual(CSV_HEAD.slice(0, 14), ['map', 'department', 'walk number', 'walk date', 'step order', 'step', 'role', 'on list', 'wait seconds', 'hands-on seconds', 'not-seen seconds', 'interrupted count', 'stopped seconds (inside wait)', 'done again']);
  assert.equal(lines.length, 1 + W1.steps.length + W2.steps.length);
  for (const l of lines) for (const f of l.match(/"(?:[^"]|"")*"/g)) assert.doesNotMatch(f, /^"[=+\-@\t\r]/, `field ${f} could run as a formula`);
  assert.match(csv, /"'\+Outpatient CT","Imaging","2","2026-11-18","3","'=cmd\|""\/c calc""!A1","'@Porter","no","120","180"/);
  assert.match(csv, /"'\+Outpatient CT","Imaging","2","2026-11-18","5","Scan","Imaging staff","yes","300","400","0","0","0","yes","timed"/);
  assert.match(csv, /"'\+Outpatient CT","Imaging","1","2026-11-17","2","Registered","Reception","yes","360","180","0","1","120","no","timed"/);
});

test('fileNameOf: letters and digits only, never a path', () => {
  assert.equal(fileNameOf('Outpatient CT'), 'ospeli-outpatient-ct-walks.csv');
  assert.equal(fileNameOf('../../etc/passwd'), 'ospeli-etc-passwd-walks.csv');
  assert.equal(fileNameOf('=HYPERLINK()'), 'ospeli-hyperlink-walks.csv');
  assert.equal(fileNameOf(''), 'ospeli-map-walks.csv');
  assert.equal(fileNameOf('Ünïcode   café'), 'ospeli-unicode-cafe-walks.csv');
  assert.ok(fileNameOf('x'.repeat(300)).length < 70);
});

test('recordFromSteps: a one-walk map shows its own steps, so a time changed by hand is the time shown; a step added by hand was not timed', () => {
  const steps = mapStepsFromWalk({ ...newWalk({ id: 'walk-001', title: 'x', at: at(0), role: 'r' }), steps: [{ startAt: at(60), endAt: at(180), name: 'Arrived', role: 'Patient' }] }, 'map-001');
  const edited = [...steps, { id: 'map-001-s2', name: 'Left', role: 'Patient', wait: 2, work: 1 }];
  const r = recordFromSteps(stepsInSeconds(edited), { id: 'walk-001', startedAt: at(0) });
  assert.deepEqual(r.steps.map((s) => [s.stepId, s.waitSec, s.workSec]), [['map-001-s1', 60, 120]]);
  assert.deepEqual(r.notTimed, ['map-001-s2']);
  assert.equal(resultTable(edited, [r])[1].cells[0].status, 'not-timed');
});

test('summaryText: header, headline, per-walk totals, the table as lines, how to read it and the walk count', () => {
  const t = summaryText({ head: ['Outpatient CT', '2 walks · Imaging · 17 – 18 Nov 2026'], headline: 'Longest wait: 10 to 13 min before “Scan”, on both walks', totals: ['55 min to 1 h 6 min start to finish'],
    walks: ['Walk 1, Tue 17 Nov, 09:00: 55 min start to finish'], columns: ['walk 1', 'walk 2'], rows: [{ name: '1. Arrived (Patient)', cells: ['wait 1 min · 2 min', 'wait under 1 min · 2 min'] }, { extra: true, name: 'Contrast check', cells: ['–', 'wait 2 min · 3 min'] }],
    read: 'Times are whole minutes.', count: 2 });
  assert.match(t, /^Outpatient CT\n2 walks · Imaging/);
  assert.match(t, /\n1\. Arrived \(Patient\): wait 1 min · 2 min \| wait under 1 min · 2 min\n {2}\+ Contrast check: – \| wait 2 min · 3 min\n/);
  assert.match(t, /How to read this: Times are whole minutes\.\nMeasured on 2 walks: examples, not a sample\.$/);
  assert.doesNotMatch(t, /<|>/);
});

// ---- #189 (module crew night 11): numbered bars on a minutes scale; one wording on both tabs ----
import { scaleTicks, stepSpans } from '../../web/app/modules/result-data.js';

test('scaleTicks: 0 and whole-minute marks at a round step, at most 5 marks, never past the longest walk', () => {
  const words = (sec) => scaleTicks(sec).map((t) => t.label);
  assert.deepEqual(words(47 * 60), ['0', '10 min', '20 min', '30 min', '40 min']);
  assert.deepEqual(words(60 * 60), ['0', '15 min', '30 min', '45 min', '1 h']);
  assert.deepEqual(words(109 * 60), ['0', '30 min', '1 h', '1 h 30 min']);
  assert.deepEqual(words(5 * 3600 + 120), ['0', '2 h', '4 h']);
  assert.deepEqual(words(170), ['0', '1 min', '2 min']);
  assert.deepEqual(words(30), ['0']);
  for (const max of [61, 600, 3000, 7000, 40000, 100000]) {
    const t = scaleTicks(max);
    assert.ok(t.length <= 5 && t.every((x, i) => x.sec <= max && (i === 0 || x.sec > t[i - 1].sec)), `${max}: ${JSON.stringify(t)}`);
    assert.ok(t.length >= 3 || max < 180, `${max}: at least two marks after 0`);
  }
});

test('walkItems gives each step its number on the list ("+" for a step not on the list)', () => {
  assert.deepEqual(walkItems(list, W1).map((x) => x.num), ['1', '2', '3', '4']);
  assert.deepEqual(walkItems(list, W2).map((x) => x.num), ['1', '2', '+', '3', '3', '4']);
});

test('stepSpans (#182 item 22): a step\'s wait across the walks where it happened, whatever came before it; its longest single wait on a walk done again', () => {
  const s = stepSpans(list, [W1, W2]);
  // Scan: 10 min on walk 1; on walk 2 an off-list step came before it (13 min, then 5 min done again).
  assert.deepEqual(s.get('map-001-s3').wait, { n: 2, min: 600, max: 780 });
  assert.deepEqual(s.get('map-001-s3').work, { n: 2, min: 900, max: 1240 }, 'hands-on adds up the times on a walk');
  assert.equal(s.get('map-001-s3').happened, 2);
  assert.equal(s.get('map-001-s3').of, 2);
  // Registered stood still 2 min on walk 1: that is waiting, inside its wait.
  assert.deepEqual(s.get('map-001-s2').wait, { n: 2, min: 180, max: 360 });
  // A walk whose clock moved back is left out.
  const moved = { ...W2, clockMoved: true };
  assert.deepEqual(stepSpans(list, [W1, moved], [true, false]).get('map-001-s3'), { stepId: 'map-001-s3', wait: { n: 1, min: 600, max: 600 }, work: { n: 1, min: 900, max: 900 }, happened: 1, of: 1 });
  // A step that did not happen on a walk counts only the walk where it did.
  const skipped = walk([[30, 90], [180, 150], [45, 30]], { start: 86400, id: 'walk-003', skip: [2] });
  const k = stepSpans(list, [W1, skipped]).get('map-001-s3');
  assert.equal(k.happened, 1); assert.equal(k.of, 2); assert.equal(k.wait.n, 1);
  // A paused wait is a floor on that walk: the at-least flag goes with the walk that gave it.
  const paused = { ...W2, steps: W2.steps.map((x) => (x.stepId === 'map-001-s1' ? { ...x, waitNotSeenSec: 300 } : x)) };
  assert.deepEqual(stepSpans(list, [W1, paused]).get('map-001-s1').wait, { n: 2, min: 30, max: 60, partly: true });
});

// ---- #189 item 6: before and after a change ----
import { diffWords, compareModel, CHANGE_CAVEAT } from '../../web/app/modules/result-data.js';

test('diffWords: one walk a side gives whole minutes; more gives the gap between the ranges\' ends; overlapping ranges say so; never an average', () => {
  const one = (sec) => ({ n: 1, min: sec, max: sec });
  const span = (min, max, n = 2) => ({ n, min, max });
  assert.deepEqual(diffWords(one(780), one(300)), { dir: 'shorter', text: 'shorter by 8 min' });
  assert.deepEqual(diffWords(one(300), one(780)), { dir: 'longer', text: 'longer by 8 min' });
  assert.deepEqual(diffWords(one(300), one(320)), { dir: 'same', text: 'the same in whole minutes' });
  // Before 10 to 13 min, after 2 to 4 min: shorter by 6 (10 - 4) to 11 (13 - 2) min.
  assert.deepEqual(diffWords(span(600, 780), span(120, 240)), { dir: 'shorter', text: 'shorter by 6 to 11 min' });
  assert.deepEqual(diffWords(span(120, 240), span(600, 780)), { dir: 'longer', text: 'longer by 6 to 11 min' });
  assert.deepEqual(diffWords(span(600, 780), span(700, 900)), { dir: 'overlap', text: 'ranges overlap: no clear difference' });
  // Touching ends overlap.
  assert.equal(diffWords(span(600, 780), span(300, 600)).dir, 'overlap');
  // One walk on one side, a range on the other.
  assert.deepEqual(diffWords(one(900), span(120, 240)), { dir: 'shorter', text: 'shorter by 11 to 13 min' });
  assert.deepEqual(diffWords(span(3000, 4000), one(600)), { dir: 'shorter', text: 'shorter by 40 to 57 min' });
  assert.deepEqual(diffWords(span(5000, 7000), one(600)), { dir: 'shorter', text: 'shorter by 1 h 13 min to 1 h 47 min' });
  assert.deepEqual(diffWords(span(620, 700), one(600)), { dir: 'shorter', text: 'shorter by up to 2 min' });
  // A side with nothing timed, and a time partly not seen.
  assert.deepEqual(diffWords({ n: 0 }, one(300)), { dir: 'none', text: 'not timed on both sides' });
  assert.deepEqual(diffWords({ ...one(780), maxAtLeast: true }, one(300)), { dir: 'shorter', text: 'shorter by 8 min · partly not seen' });
  for (const d of [diffWords(span(600, 780), span(120, 240)), diffWords(one(780), one(300))]) assert.doesNotMatch(d.text, /average|mean|better|worse|improv|worked/i);
});

test('compareModel: walks 1 to N before, the rest after; a row per list step, the step not on the list kept, totals; the caveat with the real count', () => {
  const W3 = walk([[30, 100], [60, 150], [120, 600], [30, 30]], { start: 2 * 86400, id: 'walk-003' });
  const records = [W1, W2, W3];
  const rg = walkRanges(list, records);
  const c = compareModel({ list, records, rg, afterWalk: 2 });
  assert.equal(c.both, true);
  assert.deepEqual([c.before.walks, c.after.walks], [[1, 2], [3]]);
  assert.deepEqual(c.heads, ['Before (2 walks)', 'After (1 walk)', 'Difference in the wait']);
  const scan = c.rows.find((r) => r.stepId === 'map-001-s3');
  // The scan's first time on each walk; its second time on walk 2 is its own row (#189 night 5 item 2).
  assert.equal(scan.beforeText, 'wait 10 to 13 min · 14 to 15 min');
  assert.equal(c.rows.find((r) => r.kind === 'again' && r.stepId === 'map-001-s3').beforeText, 'on walk 2: wait 5 min · 7 min');
  assert.equal(scan.afterText, 'wait 2 min · 10 min');
  assert.deepEqual(scan.diff, { dir: 'shorter', text: 'shorter by 8 to 11 min' });
  assert.equal(scan.againText, 'Done again on walk 2', 'the step done again is said on its row');
  const extra = c.rows.find((r) => r.kind === 'extra');
  assert.equal(extra.name, 'Contrast check');
  assert.equal(extra.beforeText, 'on walk 2: wait 2 min · 3 min');
  assert.equal(extra.afterText, 'not on these walks');
  assert.deepEqual(extra.diff, { dir: 'none', text: 'only before the change' });
  assert.deepEqual(c.totals.map((t) => t.label), ['Start to finish', 'Waiting in all', 'Hands-on in all']);
  assert.equal(c.totals[0].diff.dir, 'shorter');
  assert.equal(c.caveat, 'Ospeli shows the difference. It does not say whether the change worked. 3 walks are examples, not a sample.');
  assert.ok(CHANGE_CAVEAT(2).endsWith('2 walks are examples, not a sample.'));
  // A step that did not happen on an "after" walk is counted on the walks where it happened.
  const skipped = walk([[30, 90], [180, 150], [45, 30]], { start: 3 * 86400, id: 'walk-004', skip: [2] });
  const c4 = compareModel({ list, records: [W1, W2, W3, skipped], rg: walkRanges(list, [W1, W2, W3, skipped]), afterWalk: 2 });
  assert.equal(c4.rows.find((r) => r.stepId === 'map-001-s3').afterText, 'wait 2 min (on 1 of 2 walks) · 10 min');
  // A mark with no walk after it yet: no table of sides, one line on what the next walk counts as.
  const one = compareModel({ list, records, rg, afterWalk: 3 });
  assert.equal(one.both, false);
  assert.equal(one.line, 'Change marked after walk 3: walks 1 to 3 are before it. The next walk will be the first after the change.');
  assert.equal(compareModel({ list, records: [W1], rg: walkRanges(list, [W1]), afterWalk: 1 }).line, 'Change marked after walk 1: walk 1 is before it. The next walk will be the first after the change.');
});

test('csvOf and summaryText carry the change: each walk row says before or after; the text has the same three columns and the caveat', () => {
  const csv = csvOf({ title: 'Outpatient CT', department: 'Imaging', list, records: [W1, W2], dateOf: (iso) => iso.slice(0, 10), afterWalk: 1 });
  const lines = csv.trimEnd().split('\r\n');
  // The column sits before the walk Builder's three, which stay last (walk-reason-180); found by its head.
  const col = CSV_HEAD.indexOf('before or after the change');
  assert.ok(col > 0);
  const cell = (l) => l.split(',')[col];
  assert.ok(lines.slice(1).every((l) => /^"(before|after)"$/.test(cell(l))));
  assert.ok(lines.slice(1).filter((l) => l.startsWith('"Outpatient CT","Imaging","1"')).every((l) => cell(l) === '"before"'));
  assert.ok(lines.slice(1).filter((l) => l.startsWith('"Outpatient CT","Imaging","2"')).every((l) => cell(l) === '"after"'));
  const none = csvOf({ title: 'Outpatient CT', department: 'Imaging', list, records: [W1, W2], dateOf: (iso) => iso.slice(0, 10) });
  assert.ok(none.trimEnd().split('\r\n').slice(1).every((l) => cell(l) === '""'), 'no mark: the column is empty');
  const t = summaryText({ head: ['Outpatient CT'], headline: 'Longest wait: x', totals: [], walks: [], columns: ['walk 1', 'walk 2'], rows: [], read: 'r', count: 2,
    compare: ['Before and after (change marked after walk 1): Before (1 walk) | After (1 walk) | Difference in the wait', '3. Scan (Imaging staff): wait 10 min · 15 min | wait 13 min · 21 min | longer by 3 min', CHANGE_CAVEAT(2)] });
  assert.match(t, /\n\nBefore and after \(change marked after walk 1\): Before \(1 walk\) \| After \(1 walk\) \| Difference in the wait\n3\. Scan .+\| longer by 3 min\nOspeli shows the difference\. It does not say whether the change worked\. 2 walks are examples, not a sample\.\n\nHow to read this/);
});
