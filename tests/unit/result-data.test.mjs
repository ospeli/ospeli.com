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

test('waitReasonOf: no reason is recorded by the app yet, so every step has none', () => {
  for (const s of [...W1.steps, ...W2.steps]) assert.equal(waitReasonOf(s), null);
});
test('waitReasonOf returns the reason once the walk records one (for the walk Builder)', { todo: 'the walk screen does not record a reason for a wait yet; wire it in result-data.js waitReasonOf' }, () => {
  assert.equal(waitReasonOf({ waitSec: 780, workSec: 840, reason: 'waiting for a room' }), 'waiting for a room');
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
  // Every second of every record is in the table, once.
  for (const [k, r] of [W1, W2].entries()) {
    const sum = rows.reduce((n, row) => n + (row.cells[k].waitSec || 0) + (row.cells[k].workSec || 0), 0);
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
  assert.equal(cellWords({ status: 'timed', times: 1, waitSec: 360, workSec: 180, interruptions: 1, stoppedSec: 120 }), 'wait 6 min (2 min stopped, interrupted 1 time) · 3 min');
  assert.equal(cellWords({ status: 'timed', times: 1, waitSec: 360, workSec: 180, interruptions: 2, stoppedSec: 0 }), 'wait 6 min (interrupted 2 times) · 3 min');
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
