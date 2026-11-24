// The words of a walked map's result (walk-first week, crew night 2): whole minutes and "1 h 49 min";
// "at least" only where that walk was paused during that time, never "at least under"; "the same"
// only within 10%; "1 of 2 walks", never "all 1 walks". Synthetic numbers only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { minWords, atLeastWords, waitAmount, rangeWords, fromCoreSpan, spanOf, sameWithin, walksWords, longestOneWalk, longestWalks, longestTitle, totalSpan, SAME_RULE } from '../../web/app/modules/result-words.js';
import { walkRanges, fmtRange, longestWaits } from '../../web/app/core/walk.js';

test('whole minutes; hours say "h" and "min"; under a minute stays "under 1 min"', () => {
  assert.equal(minWords(0), 'under 1 min');
  assert.equal(minWords(59), 'under 1 min');
  assert.equal(minWords(60), '1 min');
  assert.equal(minWords(89), '1 min');
  assert.equal(minWords(90), '2 min');
  assert.equal(minWords(27 * 60 + 10), '27 min');
  assert.equal(minWords(109 * 60), '1 h 49 min');
  assert.equal(minWords(109 * 60 + 20), '1 h 49 min');
  assert.equal(minWords(64 * 60 + 5), '1 h 4 min');
  assert.equal(minWords(120 * 60), '2 h');
  assert.equal(minWords(150, { floor: true }), '2 min', 'a least value rounds down: 2 min 30 s is at least 2 min, not 3');
  for (const s of [3600, 3661, 6540, 7199]) assert.match(minWords(s), /^\d+ h( \d+ min)?$/, `${s} s reads ${minWords(s)}`);
});

test('"at least" only with a pause during that wait, and never "at least under"', () => {
  assert.equal(waitAmount({ wait: 400 }), '7 min', 'no pause: no "at least"');
  assert.equal(waitAmount({ wait: 400, waitNotSeenSec: 0 }), '7 min');
  assert.equal(waitAmount({ wait: 660, waitNotSeenSec: 300 }), 'at least 11 min');
  assert.equal(waitAmount({ wait: 150, waitNotSeenSec: 300 }), 'at least 2 min');
  assert.equal(waitAmount({ wait: 40, waitNotSeenSec: 300 }), 'under 1 min seen');
  assert.equal(atLeastWords(30), 'under 1 min seen');
  for (const s of [0, 10, 59, 60, 61, 3600]) assert.doesNotMatch(atLeastWords(s), /at least under/);
});

test('within 10% is "the same"; the same whole minutes further apart are "about"', () => {
  assert.equal(sameWithin(53 * 60, 53 * 60), true);
  assert.equal(sameWithin(100, 110), true);
  assert.equal(sameWithin(100, 112), false);
  assert.equal(sameWithin(0, 0), true);
  assert.match(SAME_RULE, /within 10%.*example setting, not a standard/);
  assert.equal(rangeWords({ n: 2, min: 3180, max: 3180 }), '53 min (the same on both walks)');
  assert.equal(rangeWords({ n: 2, min: 3150, max: 3200 }), '53 min (the same on both walks)', '1.6% apart');
  // 1 min 30 s and 2 min 22 s both round to 2 min, but are 37% apart: not "the same".
  assert.equal(rangeWords({ n: 2, min: 90, max: 142 }), 'about 2 min on both walks');
  assert.equal(rangeWords({ n: 2, min: 30, max: 59 }), 'under 1 min on both walks');
  assert.equal(rangeWords({ n: 3, min: 2160, max: 2220 }), '36 to 37 min');
  assert.equal(rangeWords({ n: 2, min: 54 * 60, max: 68 * 60 }), '54 min to 1 h 8 min');
  assert.equal(rangeWords({ n: 2, min: 20, max: 200 }), 'under 1 min to 3 min');
  assert.equal(rangeWords({ n: 3, min: 600, max: 600 }), '10 min (the same on all 3 walks)');
  assert.equal(rangeWords({ n: 2, min: 600, max: 600 }, { of: 3 }), '10 min (the same on 2 of 3 walks)');
});

test('"1 of 2 walks", never "all 1 walks"', () => {
  assert.equal(walksWords(1, 2), 'on 1 of 2 walks');
  assert.equal(walksWords(2, 2), 'on both walks');
  assert.equal(walksWords(3, 3), 'on all 3 walks');
  assert.equal(walksWords(1, 1), 'on 1 walk');
  assert.equal(rangeWords({ n: 1, min: 240, max: 240 }, { of: 2 }), '4 min (on 1 of 2 walks)');
  for (let n = 1; n <= 4; n++) for (let m = n; m <= 4; m++) assert.doesNotMatch(walksWords(n, m), /all 1 walks|all 2 walks/);
});

// The case reviewers saw (UX review 22 Nov, simulated walks 23 Nov): walk 1 was paused during the
// wait before step B; walk 2 was never paused and waited longer. The core's range words put "at least"
// on walk 2's time, and "at least under 1 min" on walk 1's.
const LIST = [{ id: 'm-s1', name: 'Checked in' }, { id: 'm-s2', name: 'Scan' }];
const W1 = { id: 'w1', startedAt: '2026-11-20T09:00:00Z', finishedAt: '2026-11-20T09:10:00Z', steps: [{ stepId: 'm-s1', waitSec: 20, workSec: 60 }, { stepId: 'm-s2', waitSec: 40, waitNotSeenSec: 60, workSec: 60 }] };
const W2 = { id: 'w2', startedAt: '2026-11-21T14:00:00Z', finishedAt: '2026-11-21T14:10:00Z', steps: [{ stepId: 'm-s1', waitSec: 20, workSec: 60 }, { stepId: 'm-s2', waitSec: 150, workSec: 60 }] };

test('the unpaused walk: no "at least" on its time, and no "at least under" (reproduced from the core\'s span)', () => {
  const rg = walkRanges(LIST, [W1, W2]);
  const words = rangeWords(fromCoreSpan(rg.steps[1].wait));
  assert.doesNotMatch(words, /at least/, `step B reads "${words}"`);
  assert.equal(words, 'under 1 min to 3 min · partly not seen');
  // Totals from each walk's own numbers: "at least" only on the end the paused walk gave.
  assert.equal(rangeWords(totalSpan(rg, 'wait')), '1 to 3 min · partly not seen', 'walk 2 (not paused) gave the high end');
  const W1long = { ...W1, steps: [W1.steps[0], { ...W1.steps[1], waitSec: 400 }] };
  assert.equal(rangeWords(totalSpan(walkRanges(LIST, [W1long, W2]), 'wait')), '3 to at least 7 min', 'walk 1 (paused) gave the high end');
  assert.equal(rangeWords(totalSpan(rg, 'elapsed')), rangeWords(spanOf([[rg.walks[0].elapsedSec, false], [rg.walks[1].elapsedSec, false]])), 'start to finish holds the time not seen, so it is exact');
  assert.doesNotMatch(rangeWords(fromCoreSpan(walkRanges(LIST, [W1, { ...W2, steps: [W2.steps[0], { ...W2.steps[1], waitSec: 45 }] }]).steps[1].wait)), /at least under/);
});

test('core/walk.js fmtRange: "at least" on an unpaused walk\'s time and "at least under 1 min" (for the Builder)', { todo: 'core/walk.js span() and fmtRange(): reported to the Builder, crew night 2' }, () => {
  const rg = walkRanges(LIST, [W1, W2]);
  assert.doesNotMatch(fmtRange(rg.steps[1].wait, { count: false }), /at least 3 min/);
  assert.doesNotMatch(fmtRange(rg.steps[1].wait, { count: false }), /at least under/);
});

test('one walk: the headline names the place, the interrupted part and the part not seen, in whole minutes', () => {
  const steps = [{ id: 'a', name: 'Registered', wait: 120 }, { id: 'b', name: 'Scan', wait: 362, interruptedWaitSec: 302 }];
  assert.deepEqual(longestOneWalk(longestWaits(steps)), { lead: 'Longest wait: ', text: '6 min at “Scan” (5 min of it while the step was interrupted)' });
  const paused = [{ id: 'a', name: 'Seen by a nurse', wait: 240 }, { id: 'b', name: 'Seen by a doctor', wait: 660, waitNotSeenSec: 300 }];
  assert.equal(longestOneWalk(longestWaits(paused)).text, 'at least 11 min before “Seen by a doctor” (5 min more of it not seen)');
  const plain = [{ id: 'a', name: 'Seen by a nurse', wait: 400 }, { id: 'b', name: 'Seen by a doctor', wait: 120 }];
  assert.doesNotMatch(longestOneWalk(longestWaits(plain)).text, /at least/);
  const tied = [{ id: 'a', name: 'Seen by a nurse', wait: 1080 }, { id: 'b', name: 'Seen by a doctor', wait: 1080 }];
  assert.deepEqual(longestOneWalk(longestWaits(tied)), { lead: 'Longest waits, tied: ', text: '18 min before “Seen by a nurse” and “Seen by a doctor”' });
  assert.equal(longestOneWalk(longestWaits([{ id: 'a', name: 'A', wait: 5 }])), null, 'under the 30 s floor');
});

test('two walks: where the longest wait fell, counted from the walks where the step happened', () => {
  // Only walk 1 had a wait over the floor: "on 1 of 2 walks", not "on all 1 walks".
  const quiet = { ...W2, steps: [{ stepId: 'm-s1', waitSec: 5, workSec: 60 }, { stepId: 'm-s2', waitSec: 10, workSec: 60 }] };
  const rg = walkRanges(LIST, [W1, quiet]);
  const w = longestWalks(rg);
  assert.equal(w.text, 'under 1 min seen before “Scan”, on 1 of 2 walks');
  assert.doesNotMatch(longestTitle(rg), /all 1 walks/);
  assert.equal(longestTitle(rg), 'The longest wait was under 1 min seen before “Scan”, on 1 of 2 walks');
  // Both walks at one step: one time range and "on both walks", "at least" only on the paused walk's end.
  const both = walkRanges(LIST, [{ ...W1, steps: [W1.steps[0], { ...W1.steps[1], waitSec: 400 }] }, W2]);
  assert.equal(longestWalks(both).text, '3 to at least 6 min before “Scan”, on both walks', 'at least rounds down: 6 min 40 s seen');
  // It moved.
  const moved = walkRanges(LIST, [{ ...W2, steps: [{ stepId: 'm-s1', waitSec: 300, workSec: 60 }, { stepId: 'm-s2', waitSec: 60, workSec: 60 }] }, W2]);
  assert.deepEqual(longestWalks(moved), { lead: 'Longest wait moved: ', text: 'walk 1, 5 min before “Checked in”; walk 2, 3 min before “Scan”' });
  assert.equal(longestTitle(moved), 'The longest wait moved on each walk');
});
