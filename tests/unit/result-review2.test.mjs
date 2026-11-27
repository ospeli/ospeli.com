// Result review fixes (#189, the night 5 review): each side of a change names its own longest
// wait; every "shorter by / longer by" adds up from the whole minutes shown in the same row; a
// difference from one walk says so; the "(walk 1)" note sits after what it belongs to. The scene
// is the synthetic imaging visit of tests/e2e/result-seed.mjs (Outpatient CT, 3 walks), made with
// the core's own functions; synthetic step names and times only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newWalk, stepStart, stepDone, nameLast, assignLast, stepResume, recordFromWalk, walkRanges } from '../../web/app/core/walk.js';
import { compareModel, changeHeadline, diffWords } from '../../web/app/modules/result-data.js';
import { minWords } from '../../web/app/modules/result-words.js';

const T0 = Date.parse('2026-11-17T09:00:00Z');
const at = (sec) => new Date(T0 + sec * 1000).toISOString();
const IMAGING = [['Arrived', 'Patient'], ['Registered', 'Reception'], ['Safety questions', 'Imaging staff'], ['Cannula or prep', 'Radiology nurse'], ['Scan', 'Imaging staff'], ['Left', 'Patient']];
const list = IMAGING.map(([name, role], i) => ({ id: `map-001-s${i + 1}`, name, role }));

// steps as result-seed.mjs: { wait, work, stopAfter?, stood?, off?, again? }
function walk(steps, { start = 0, first = false, id }) {
  const w = newWalk({ id, title: 'Outpatient CT', at: at(start), role: 'ops-manager', ...(first ? {} : { plan: list.map(({ id: i, name, role }) => ({ id: i, name, role })), repeatOf: 'map-001', walkNo: 2 }) });
  let t = start;
  steps.forEach((s, i) => {
    t += s.wait; stepStart(w, at(t));
    if (s.stopAfter) { t += s.stopAfter; stepDone(w, at(t), { interrupted: true }); t += s.stood; stepResume(w, at(t)); t += s.work - s.stopAfter; } else t += s.work;
    stepDone(w, at(t));
    if (s.off) { assignLast(w, { offList: true }); nameLast(w, { name: s.off[0], role: s.off[1] }); }
    else if (s.again) assignLast(w, { listIndex: s.again - 1 });
    else if (first) nameLast(w, { name: IMAGING[i][0], role: IMAGING[i][1] });
  });
  return recordFromWalk(w, { finishedAt: at(t), mapId: 'map-001' });
}
const S1 = [{ wait: 60, work: 120 }, { wait: 240, work: 180 }, { wait: 120, work: 240 }, { wait: 300, work: 240, stopAfter: 120, stood: 180 }, { wait: 600, work: 900 }, { wait: 60, work: 30 }];
const S2 = [{ wait: 30, work: 90 }, { wait: 180, work: 150 }, { wait: 90, work: 200 }, { wait: 240, work: 300 }, { wait: 120, work: 180, off: ['Contrast check', 'Radiology nurse'] },
  { wait: 780, work: 840 }, { wait: 300, work: 400, again: 5 }, { wait: 45, work: 30 }];
const S3 = S1.map((s, i) => ({ ...s, wait: i === 4 ? 180 : Math.round(s.wait * 0.8) }));
const W1 = walk(S1, { first: true, id: 'walk-001' });
const W2 = walk(S2, { start: 86400, id: 'walk-002' });
const W3 = walk(S3, { start: 2 * 86400, id: 'walk-003' });
const ALL = [W1, W2, W3];
const rg = walkRanges(list, ALL);

test('fix 1: each line of the headline names the longest wait of its own side', () => {
  const hd = changeHeadline({ list, records: ALL, rg, afterWalk: 2 });
  assert.equal(`${hd.lead}${hd.text}`, 'Longest wait after the change: 4 min before “Cannula or prep”, on 1 walk');
  assert.equal(hd.before, 'Before the change, the longest wait was 10 to 13 min before “Scan” (2 walks).');
  // The sides name different steps: the after-side step's own figure before, as a line of its own.
  assert.equal(hd.same, '“Cannula or prep” before the change: 4 to 5 min (2 walks).');
  assert.doesNotMatch(`${hd.text} ${hd.before} ${hd.same}`, /average|mean|better|worse|improv|worked/i);
  // The same step on both sides: no extra line.
  const one = changeHeadline({ list, records: [W1, W2, walk(S1, { start: 2 * 86400, id: 'walk-003' })], rg: walkRanges(list, [W1, W2, walk(S1, { start: 2 * 86400, id: 'walk-003' })]), afterWalk: 2 });
  assert.equal(one.before, 'Before the change, the longest wait was 10 to 13 min before “Scan” (2 walks).');
  assert.equal(one.same, null);
  // The walks before disagree about which step is longest: said walk by walk, in longestWalks's words.
  const W1b = walk(S1.map((s, i) => (i === 1 ? { ...s, wait: 900 } : s)), { first: true, id: 'walk-001' });
  const moved = changeHeadline({ list, records: [W1b, W2, W3], rg: walkRanges(list, [W1b, W2, W3]), afterWalk: 2 });
  assert.equal(moved.before, 'Before the change, the longest wait moved: walk 1, 15 min before “Registered”; walk 2, 13 min before “Scan”.');
});

// The whole minutes a side's cell shows: its low and high ends, as sideWords says them.
const shown = (sp) => [Math.round(sp.min / 60) * (sp.min >= 60 ? 1 : 0), (sp.maxAtLeast ? Math.floor(sp.max / 60) : Math.round(sp.max / 60)) * (sp.max >= 60 ? 1 : 0)];
const words = (a, b) => (a === b ? minWords(a * 60) : `${a} to ${minWords(b * 60)}`);

test('fix 2: every "shorter by / longer by" is worked out from the whole minutes shown in the same row', () => {
  const c = compareModel({ list, records: ALL, rg, afterWalk: 2 });
  const wait = c.totals.find((t) => t.label === 'Waiting in all');
  assert.equal(wait.beforeText, '26 to 30 min');
  assert.equal(wait.afterText, '16 min');
  assert.equal(wait.diff.text, 'shorter by 10 to 14 min (1 walk after)');
  let checked = 0;
  for (const r of [...c.rows, ...c.totals]) {
    const b = r.before?.wait || r.before; const a = r.after?.wait || r.after;
    if (!(r.diff.dir === 'shorter' || r.diff.dir === 'longer')) {
      if (r.diff.dir === 'overlap') { const [bl, bh] = shown(b); const [al, ah] = shown(a); assert.ok(!(ah < bl || al > bh), `${r.name || r.label}: overlap only where the shown ranges meet`); }
      continue;
    }
    const [bl, bh] = shown(b); const [al, ah] = shown(a);
    const lo = r.diff.dir === 'shorter' ? bl - ah : al - bh; const hi = r.diff.dir === 'shorter' ? bh - al : ah - bl;
    assert.ok(r.diff.text.startsWith(`${r.diff.dir} by ${words(lo, hi)}`), `${r.name || r.label}: ${r.diff.text} from ${bl}-${bh} and ${al}-${ah}`);
    checked += 1;
  }
  assert.ok(checked >= 3, `${checked} rows checked`);
  // Ranges that touch in whole minutes: no clear difference.
  assert.equal(diffWords({ n: 2, min: 300, max: 600 }, { n: 2, min: 610, max: 900 }).dir, 'overlap');
  // From the minutes shown, not the seconds: 10 min (629 s) and 7 min (409 s) shown, 3 min apart.
  assert.equal(diffWords({ n: 1, min: 629, max: 629 }, { n: 1, min: 409, max: 409 }).text, 'shorter by 3 min (1 walk before, 1 walk after)');
});

test('fix 4: a difference from one walk on a side says so', () => {
  assert.equal(diffWords({ n: 2, min: 600, max: 780 }, { n: 1, min: 180, max: 180 }).text, 'shorter by 7 to 10 min (1 walk after)');
  assert.equal(diffWords({ n: 1, min: 180, max: 180 }, { n: 2, min: 600, max: 780 }).text, 'longer by 7 to 10 min (1 walk before)');
  assert.equal(diffWords({ n: 2, min: 300, max: 600 }, { n: 1, min: 400, max: 400 }).text, 'ranges overlap: no clear difference');
  const c = compareModel({ list, records: ALL, rg, afterWalk: 2 });
  for (const r of [...c.rows, ...c.totals]) if (/^(shorter|longer) by/.test(r.diff.text)) assert.match(r.diff.text, /\(1 walk after\)$/, r.name || r.label);
});

test('fix 5: "on walk 1" goes straight after the interruption it belongs to', () => {
  const c = compareModel({ list, records: ALL, rg, afterWalk: 2 });
  const prep = c.rows.find((r) => r.stepId === 'map-001-s4');
  assert.equal(prep.beforeText, 'wait 4 to 5 min · 4 to 5 min · stood still 3 min, interrupted 1 time on walk 1');
});
