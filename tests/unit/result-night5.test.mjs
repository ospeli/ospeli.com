// Crew night 5 (#189 held branch): the headline does not mix before and after, a redone step's
// second wait stays in the Before and After rows, the wait reason in the headline and the table,
// time stood still kept out of the wait, shares from the minutes shown. Walks are made with the
// core's own functions; synthetic step names and times only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newWalk, stepStart, stepDone, nameLast, assignLast, stepResume, recordFromWalk, walkRanges } from '../../web/app/core/walk.js';
import { compareModel, changeHeadline, walksLongest, walkItems, cellWords, resultTable, waitBeforeOf, longestPositions } from '../../web/app/modules/result-data.js';
import { longestWalks, shareOfShown, stoodWords } from '../../web/app/modules/result-words.js';
import { longestLine } from '../../web/app/modules/result-view.js';

const T0 = Date.parse('2026-11-17T09:00:00Z');
const at = (sec) => new Date(T0 + sec * 1000).toISOString();
const LIST = [['Arrived', 'Patient'], ['Registered', 'Reception'], ['Seen by a nurse', 'Nurse'], ['Left', 'Patient']];
const list = LIST.map(([name, role], i) => ({ id: `map-001-s${i + 1}`, name, role }));

// steps: [wait, work, extra] with extra { off: [name, role] } | { again: n } | { stop: [after, stood] } | { reason }
function walk(steps, { start = 0, plan = true, id = 'walk-001' } = {}) {
  const w = newWalk({ id, title: 'Clinic visit', at: at(start), role: 'ops-manager', ...(plan ? { plan: list.map(({ id: i, name, role }) => ({ id: i, name, role })), repeatOf: 'map-001', walkNo: 2 } : {}) });
  let t = start;
  steps.forEach(([wait, work, x = {}], i) => {
    t += wait; stepStart(w, at(t));
    if (x.stop) { t += x.stop[0]; stepDone(w, at(t), { interrupted: true }); t += x.stop[1]; stepResume(w, at(t)); t += work - x.stop[0]; } else t += work;
    stepDone(w, at(t));
    if (x.off) { assignLast(w, { offList: true }); nameLast(w, { name: x.off[0], role: x.off[1] }); }
    else if (x.again) assignLast(w, { listIndex: x.again - 1 });
    else if (!plan) nameLast(w, { name: LIST[i][0], role: LIST[i][1] });
  });
  const rec = recordFromWalk(w, { finishedAt: at(t), mapId: 'map-001' });
  steps.forEach(([, , x = {}], i) => { if (x.reason) rec.steps[i].waitReason = x.reason; });
  return rec;
}
// Before: walk 1 (the nurse step stood still 4 min), walk 2 (the nurse step done again, an off-list step).
const W1 = walk([[60, 120], [240, 180], [1500, 600, { stop: [120, 240] }], [60, 30]], { plan: false });
const W2 = walk([[30, 90], [180, 150], [2400, 500], [300, 200, { off: ['Blood test', 'Nurse'] }], [420, 300, { again: 3 }], [45, 30]], { start: 86400, id: 'walk-002' });
// After: walk 3 (the nurse step done again, its wait reason recorded), walk 4.
const W3 = walk([[30, 100], [60, 150], [840, 400, { reason: 'room-equipment' }], [200, 250, { again: 3 }], [30, 30]], { start: 2 * 86400, id: 'walk-003' });
const W4 = walk([[40, 100], [90, 150], [600, 450], [30, 30]], { start: 3 * 86400, id: 'walk-004' });
const ALL = [W1, W2, W3, W4];
const rg = walkRanges(list, ALL);

test('item 2: on every walk, each side\'s rows add up to that walk\'s waiting and hands-on; the redo and the off-list step are listed', () => {
  const c = compareModel({ list, records: ALL, rg, afterWalk: 2 });
  assert.equal(c.both, true);
  for (const n of [1, 2, 3, 4]) {
    const wait = c.rows.reduce((s, r) => s + (r.walks[n]?.waitSec || 0) + (r.walks[n]?.stoodSec || 0), 0);
    const work = c.rows.reduce((s, r) => s + (r.walks[n]?.workSec || 0), 0);
    assert.equal(wait, rg.walks[n - 1].waitSec, `walk ${n}: the rows' waits add up to the walk's waiting`);
    assert.equal(work, rg.walks[n - 1].workSec, `walk ${n}: the rows' hands-on adds up`);
  }
  const again = c.rows.filter((r) => r.kind === 'again');
  assert.equal(again.length, 1, 'one row for the nurse step done again');
  assert.equal(again[0].beforeText, 'on walk 2: wait 7 min · 5 min');
  assert.equal(again[0].afterText, 'on walk 3: wait 3 min · 4 min');
  assert.ok(c.rows.some((r) => r.kind === 'extra' && r.name === 'Blood test'), 'the off-list step is listed');
  // The step's own row holds its first time on each walk, never the redo's.
  const nurse = c.rows.find((r) => r.stepId === 'map-001-s3');
  assert.equal(nurse.walks[2].waitSec, 2400);
  assert.equal(nurse.walks[3].waitSec, 840);
});

test('item 5: the wait before a step leaves out the time it stood still; the row says it apart', () => {
  const nurse1 = walkItems(list, W1)[2];
  assert.equal(nurse1.waitSec, 1500 + 240, 'the core keeps the stood-still time inside the wait');
  assert.equal(waitBeforeOf(nurse1.rec), 1500);
  const rows = resultTable(list, [W1]);
  const cell = rows.find((r) => r.stepId === 'map-001-s3').cells[0];
  assert.equal(cellWords(cell), 'wait 25 min · 10 min · stood still 4 min, interrupted 1 time');
  assert.equal(stoodWords(17), '17 s');
  assert.equal(stoodWords(240), '4 min');
  const c = compareModel({ list, records: ALL, rg, afterWalk: 2 });
  const nurse = c.rows.find((r) => r.stepId === 'map-001-s3');
  assert.equal(nurse.walks[1].waitSec, 1500);
  assert.equal(nurse.walks[1].stoodSec, 240);
  assert.match(nurse.beforeText, /^wait 25 to 40 min · 8 to 10 min · stood still 4 min, interrupted 1 time on walk 1$/);
  // The longest wait is picked by the wait before the step: walk 1's nurse step (25 min) not a
  // 29 min that holds 4 min stood still.
  const lo = walksLongest(list, [W1], walkRanges(list, [W1]));
  assert.deepEqual(lo.walks[0].longest.map((l) => [l.key, l.waitSec]), [['map-001-s3', 1500]]);
  assert.deepEqual(longestPositions(walkItems(list, W1), lo.walks[0].longest), [2]);
  assert.equal(longestWalks(lo).text, '25 min before “Seen by a nurse”, on 1 walk');
  // A step that stood still longer than the wait before the next: the pick moves to the real wait.
  const W5 = walk([[60, 120], [400, 180, { stop: [60, 300] }], [500, 60], [10, 30]], { plan: false, id: 'walk-005' });
  const lo5 = walksLongest(list, [W5], walkRanges(list, [W5]));
  assert.deepEqual(lo5.walks[0].longest.map((l) => l.key), ['map-001-s3']);
  assert.equal(walkRanges(list, [W5]).walks[0].longest[0].key, 'map-001-s2', '(the core still picks the step that stood still: reported to the Builder)');
});

test('item 1: once a change is marked, the headline names the longest wait after it and says in one line what it was before', () => {
  const hd = changeHeadline({ list, records: ALL, rg, afterWalk: 2 });
  assert.equal(hd.lead, 'Longest wait after the change: ');
  assert.equal(hd.text, '10 to 14 min before “Seen by a nurse”, on both walks');
  assert.equal(hd.before, 'Before the change, the longest wait was 25 to 40 min before “Seen by a nurse” (2 walks).');
  assert.doesNotMatch(`${hd.text} ${hd.before}`, /average|mean|better|worse|improv|worked/i);
  // Nothing after the mark yet: no split headline.
  assert.equal(changeHeadline({ list, records: [W1, W2], rg: walkRanges(list, [W1, W2]), afterWalk: 2 }), null);
});

test('item 4: the reason recorded on the walk is in the headline and in the step table, from that walk only', () => {
  const hd = changeHeadline({ list, records: ALL, rg, afterWalk: 2 });
  assert.equal(hd.reason, 'Reason recorded on walk 3: Room or equipment.');
  const one = walksLongest(list, [W3], walkRanges(list, [W3]));
  assert.equal(one.reason, 'Reason recorded on the walk: Room or equipment.');
  const items = walkItems(list, W3);
  assert.equal(longestLine(items, longestPositions(items, one.walks[0].longest)), 'Longest wait: 14 min before “Seen by a nurse”. Reason recorded on the walk: Room or equipment.');
  const cell = resultTable(list, [W3]).find((r) => r.stepId === 'map-001-s3').cells[0];
  assert.match(cellWords(cell), /^1st: wait 14 min · 7 min; 2nd: wait 3 min · 4 min$/);
  assert.equal(cell.reason, 'Reason recorded on the walk: Room or equipment');
  const c = compareModel({ list, records: ALL, rg, afterWalk: 2 });
  assert.equal(c.rows.find((r) => r.stepId === 'map-001-s3').reasonText, 'Reason recorded on walk 3: Room or equipment');
  assert.doesNotMatch(JSON.stringify(c), /\d+ (times|walks?) (gave|said) /, 'no count of reasons');
});

test('item 6: the waiting share is worked out from the minutes shown', () => {
  // 11 min of 14 min shown: 79%, never 78% from the seconds behind them.
  assert.equal(shareOfShown(11 * 60 + 20, 14 * 60 + 25), 79);
  assert.equal(shareOfShown(660, 840), 79);
  assert.equal(shareOfShown(20, 25), null, 'under a minute shown: no share');
});

import { csvOf, CSV_HEAD } from '../../web/app/modules/result-data.js';
test('item 7 (#191 point 3): the CSV says for each walk whether its times can be used', () => {
  const col = CSV_HEAD.indexOf('walk usable');
  assert.ok(col > 0);
  const csv = csvOf({ title: 'Clinic visit', department: 'Outpatients', list, records: [W1, { ...W2, clockMoved: true }, { ...W3, stoppedEarly: true }], dateOf: (iso) => iso.slice(0, 10) });
  const byWalk = new Map();
  for (const l of csv.trimEnd().split('\r\n').slice(1)) { const c = l.split(','); byWalk.set(c[2], c[col]); }
  assert.deepEqual([...byWalk.entries()], [['"1"', '"yes"'], ['"2"', '"clock moved back"'], ['"3"', '"stopped early"']]);
  assert.deepEqual(CSV_HEAD.slice(-3), ['wait reason (recorded on the walk)', 'last stop reason (recorded on the walk)', 'step name typed'], 'the walk Builder\'s columns stay last');
});
