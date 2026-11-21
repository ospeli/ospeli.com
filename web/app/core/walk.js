// Walk mode (backlog PM2): pure functions only, no storage. A person follows one patient visit
// or one item from start to finish and taps as things happen, so the map holds measured times.
//
// What a walk keeps: the clock time of each tap, a name and a role for each step. Never a
// person's name, never a patient detail. Steps are timed, people are not.
//
// Definitions (local definitions, in the manner of lean value stream mapping; not a standard):
//   hands-on time of a step = "Step starts" tap to "Step done" tap: someone is doing something
//     to or for the patient or item being followed;
//   waiting before a step   = the tap that ended the step before (or the start of the walk) to
//     this step's "Step starts" tap: everything else, even when staff are busy elsewhere.
//   not seen               = time between "Pause" and "I am back": the person walking stepped out
//     (a private moment). It is neither waiting nor hands-on. It stays inside start to finish,
//     is taken out of the step or wait it fell in. The seen part of a wait that was partly not
//     seen is a floor: such a wait is compared by its seen part and named as "at least" that long;
//   planned or required wait = a wait a person marked on the map as needed by the process itself.
//     It still counts as waiting; it is only left out of "longest wait". Ospeli holds no list of
//     such waits: the mark records what staff said.
// Times are computed from the stored clock times in whole seconds and rounded only for display;
// a timer on screen is never the record. One walk is one observation, not the process.

export const MAX_WALK_STEPS = 60;
export const ROLE_NOT_SET = 'Not set';
// A "Step done" tap less than this long after "Step starts" is taken as a double tap, not a step.
export const MIN_STEP_MS = 1000;
// Waits shorter than this are not named as the longest wait (a stated local definition, not a standard).
export const MIN_LONGEST_WAIT_SEC = 30;

// Whole seconds a stopwatch started with the walk would show at a tap. Every recorded time on a
// walk is a difference of two of these, so waiting, hands-on and not seen always add up to start
// to finish. (Rounding each part alone drifted a second or two on a long walk with taps between
// whole seconds; #141.)
const offSec = (walk, t) => Math.floor((Date.parse(t) - Date.parse(walk.startedAt)) / 1000);
const secs = (walk, a, b) => Math.max(0, offSec(walk, b) - offSec(walk, a));
// The latest moment any tap on the walk was stamped with.
function latestTap(walk) {
  const all = [walk.startedAt];
  for (const s of walk.steps) all.push(s.startAt, s.endAt);
  if (walk.current) all.push(walk.current.startAt);
  for (const p of walk.pauses || []) { all.push(p.startAt); if (p.endAt) all.push(p.endAt); }
  return Math.max(...all.map((t) => Date.parse(t)));
}

// What the person walking confirms before the first tap (issue #124; decision record 18 Nov 2026).
// The stop rule comes first. Nothing about anyone is stored: only the time the points were confirmed.
export const WALK_BEFORE = [
  'If care is affected or the patient looks unwell, stop and tell the person in charge.',
  'The patient was asked, and can stop the walk at any time.',
  'Staff here know you are timing steps, not people.',
  'Step out for private moments: tap Pause.',
  'In a small team, a role can point to one person.',
  'Not for appraisal or staffing.',
];
export const PLANNED_WAIT_RULE = 'Mark it only if the whole wait was needed by the process itself, for example a booked time not yet reached or a test that must finish. If part of it was queueing, leave it unmarked.';
export const NOT_ALWAYS_WASTE = 'Waiting is not always waste. Some waits are planned or needed.';

// guidanceSeenAt: when the person confirmed the before-you-walk points, or null. No name, no device.
// A repeat walk (issue #124 item 1) carries the saved step list of the map it repeats: plan is
// that map's steps (id, name, role, msg) at the moment the walk started, repeatOf is the map and
// walkNo says which walk of that map this is. A first walk has none of the three.
export function newWalk({ id, title, at, role, guidanceSeen = false, plan = null, repeatOf = null, walkNo = null }) {
  return { id, title, startedAt: at, steps: [], current: null, pauses: [], last: null, status: 'walking', mapId: null, createdByRole: role, finishedAt: null, guidanceSeenAt: guidanceSeen ? at : null,
    ...(plan ? { plan, repeatOf, walkNo, skipped: [] } : {}) };
}

// ---- repeat walks: the saved step list ----
// The walks a site is asked to make of one step list before reading a range (example setting, not a standard).
export const WALKS_AIM = 3;
export const MAX_WALKS_PER_MAP = 20;
// The place on the list (from 0) of the step that comes next, or null when the list is used up
// or the walk has no list. It is one past the furthest list step timed, running or marked "did
// not happen", so a list step done again (rework) does not move it.
export function nextPlanIndex(walk) {
  if (!walk.plan) return null;
  let top = -1;
  for (const s of walk.steps) if (s.planIndex != null) top = Math.max(top, s.planIndex);
  if (walk.current?.planIndex != null) top = Math.max(top, walk.current.planIndex);
  for (const i of walk.skipped || []) top = Math.max(top, i);
  return top + 1 < walk.plan.length ? top + 1 : null;
}
// The next list step did not happen on this visit: one tap, and it can be undone.
export function skipNext(walk) {
  if (!walk.plan) throw new Error('This walk has no saved step list.');
  if (openPause(walk)) throw new Error('The walk is paused. Say you are back first.');
  if (walk.current) throw new Error('A step is running. Mark it done first.');
  const i = nextPlanIndex(walk);
  if (i == null) throw new Error('Every step on the list has been timed or marked.');
  walk.skipped.push(i);
  walk.last = 'skip';
  return i;
}
// The step that just ended was a different list step (listIndex, from 0: a step done again, or one
// out of order), or a step that is not on the list (offList; it is then named like a first walk's).
export function assignLast(walk, { listIndex = null, offList = false }) {
  const last = walk.steps[walk.steps.length - 1];
  if (!walk.plan) throw new Error('This walk has no saved step list.');
  if (!last) throw new Error('No step has ended yet.');
  if (offList) { last.planIndex = null; last.name = null; last.role = null; last.msg = false; return walk; }
  const p = walk.plan[listIndex];
  if (!p) throw new Error(`The list has ${walk.plan.length} steps.`);
  last.planIndex = listIndex; last.name = p.name; last.role = p.role; last.msg = !!p.msg;
  return walk;
}
// The list steps not timed and not marked "did not happen", in list order.
export function planLeft(walk) {
  if (!walk.plan) return [];
  const seen = new Set([...walk.steps.map((s) => s.planIndex), ...(walk.skipped || [])].filter((i) => i != null));
  return walk.plan.map((p, i) => ({ ...p, n: i + 1 })).filter((p) => !seen.has(p.n - 1));
}

const openPause = (walk) => (walk.pauses || []).find((p) => !p.endAt) || null;
// 'paused' while the person has stepped out, 'step' while a step is running, otherwise 'waiting'.
export const walkState = (walk) => (openPause(walk) ? 'paused' : walk.current ? 'step' : 'waiting');
// What is under way behind a pause: 'step' or 'waiting'.
export const walkUnder = (walk) => (walk.current ? 'step' : 'waiting');

// Seconds between two moments that fell inside a pause (an open pause runs to `now`).
export function pausedSec(walk, a, b, now = null) {
  const A = Date.parse(a); const B = Date.parse(b);
  let ms = 0;
  for (const p of walk.pauses || []) {
    const end = p.endAt || now;
    // A pause stamped by a clock that had been set back cannot be placed: it takes nothing out of any step.
    if (!end || p.clockBack) continue;
    ms += Math.max(0, Math.min(B, Date.parse(end)) - Math.max(A, Date.parse(p.startAt)));
  }
  return Math.max(0, Math.round(ms / 1000));
}
// The same for a recorded wait or step, in the walk's whole seconds, so the parts add up.
function pausedWhole(walk, a, b) {
  const A = offSec(walk, a); const B = offSec(walk, b);
  let sec = 0;
  for (const p of walk.pauses || []) if (p.endAt && !p.clockBack) sec += Math.max(0, Math.min(B, offSec(walk, p.endAt)) - Math.max(A, offSec(walk, p.startAt)));
  return sec;
}

// The person walking steps out: nothing is counted until they are back.
export function pauseWalk(walk, at) {
  if (openPause(walk)) throw new Error('The walk is already paused.');
  // A Pause stamped earlier than the tap before it: the device clock was set back (#141).
  const back = Date.parse(at) < latestTap(walk);
  if (back) walk.clockBack = true;
  (walk.pauses ||= []).push({ startAt: at, ...(back ? { clockBack: true } : {}) });
  walk.last = 'pause';
  return walk;
}
export function resumeWalk(walk, at) {
  const p = openPause(walk);
  if (!p) throw new Error('The walk is not paused.');
  if (Date.parse(at) < latestTap(walk)) { walk.clockBack = true; p.clockBack = true; }
  p.endAt = at;
  walk.last = 'resume';
  return walk;
}

// When the present wait (or step) began; while paused, when the pause began.
export function sinceAt(walk) {
  const p = openPause(walk);
  if (p) return p.startAt;
  if (walk.current) return walk.current.startAt;
  const last = walk.steps[walk.steps.length - 1];
  return last ? last.endAt : walk.startedAt;
}

export function stepStart(walk, at) {
  if (openPause(walk)) throw new Error('The walk is paused. Say you are back first.');
  if (walk.current) throw new Error('A step is already running.');
  if (walk.steps.length >= MAX_WALK_STEPS) throw new Error(`A walk holds at most ${MAX_WALK_STEPS} steps.`);
  if (isDoubleStart(walk, at)) throw new Error('That tap came less than a second after the step before ended.');
  const next = nextPlanIndex(walk);
  walk.current = { startAt: at, ...(next != null ? { planIndex: next } : {}) };
  walk.last = 'start';
  return walk;
}

// End the running step. interrupted: the work stopped before it was finished.
export function stepDone(walk, at, { interrupted = false } = {}) {
  if (openPause(walk)) throw new Error('The walk is paused. Say you are back first.');
  if (!walk.current) throw new Error('No step is running.');
  if (isDoubleTap(walk, at)) throw new Error('That tap came less than a second after the step started.');
  // On a repeat walk the step takes its name and role from the saved list: nothing to name.
  const p = walk.plan && walk.current.planIndex != null ? walk.plan[walk.current.planIndex] : null;
  walk.steps.push({ startAt: walk.current.startAt, endAt: at, name: p ? p.name : null, role: p ? p.role : null, msg: p ? !!p.msg : false,
    ...(p ? { planIndex: walk.current.planIndex } : {}), ...(interrupted ? { interrupted: true } : {}) });
  walk.current = null;
  walk.last = 'done';
  return walk;
}

// True when "Step done" at this time would end the running step under a second after it began.
export function isDoubleTap(walk, at) {
  if (!walk.current) return false;
  const ms = Date.parse(at) - Date.parse(walk.current.startAt);
  return ms >= 0 && ms < MIN_STEP_MS;
}

// True when "Step starts" at this time would come under a second after the step before ended:
// the second half of a double tap on "Step done" (the same button then reads "Step starts").
// A hand-over with no wait is still recorded: nameLast starts the next step at the same moment
// on purpose and does not pass through here with a later time.
export function isDoubleStart(walk, at) {
  const last = walk.steps[walk.steps.length - 1];
  if (!last || walk.current) return false;
  const ms = Date.parse(at) - Date.parse(last.endAt);
  return ms > 0 && ms < MIN_STEP_MS;
}

// True when any tap is earlier than the tap before it (the device clock moved back mid-walk),
// so the walk's times cannot be trusted and the totals may not add up.
export function clockMoved(walk) {
  if (walk.clockBack) return true;
  const taps = [walk.startedAt];
  for (const s of walk.steps) taps.push(s.startAt, s.endAt);
  if (walk.current) taps.push(walk.current.startAt);
  if (walk.finishedAt) taps.push(walk.finishedAt);
  for (let i = 1; i < taps.length; i++) if (Date.parse(taps[i]) < Date.parse(taps[i - 1])) return true;
  for (const p of walk.pauses || []) if (Date.parse(p.startAt) < Date.parse(walk.startedAt) || (p.endAt && Date.parse(p.endAt) < Date.parse(p.startAt))) return true;
  return false;
}

// Name the step that just ended. nextStarted: the next step began the moment this one ended
// (a hand-over with no wait), so it starts at this step's end time, not at the time of this tap.
export function nameLast(walk, { name, role, msg, nextStarted = false }) {
  const last = walk.steps[walk.steps.length - 1];
  if (!last) throw new Error('No step has ended yet.');
  // A step given its own words on a repeat walk is no longer the list step it was offered as.
  if (walk.plan && last.planIndex != null && ((name != null && name !== last.name) || (role != null && role !== last.role))) delete last.planIndex;
  if (name != null) last.name = name;
  if (role != null) last.role = role;
  if (msg != null) last.msg = !!msg;
  if (nextStarted) {
    if (walk.current) throw new Error('The next step is already running.');
    stepStart(walk, last.endAt);
  }
  return walk;
}

// Take back the last tap: a running step goes back to waiting; otherwise the last ended step
// runs again (its name is dropped with it).
export function undoLast(walk) {
  const pauses = walk.pauses || [];
  // A pause or a coming back is a tap like any other: it can be taken back while it is the last tap.
  if (walk.last === 'pause' && openPause(walk)) { pauses.pop(); walk.last = null; return 'pause'; }
  if (walk.last === 'resume' && pauses.length && pauses[pauses.length - 1].endAt) { delete pauses[pauses.length - 1].endAt; walk.last = null; return 'resume'; }
  if (openPause(walk)) throw new Error('The walk is paused. Say you are back first.');
  if (walk.last === 'skip' && walk.skipped?.length) { walk.skipped.pop(); walk.last = null; return 'skip'; }
  walk.last = null;
  if (walk.current) { walk.current = null; return 'step-start'; }
  const last = walk.steps.pop();
  if (!last) throw new Error('There is nothing to undo.');
  walk.current = { startAt: last.startAt, ...(last.planIndex != null ? { planIndex: last.planIndex } : {}) };
  return 'step-done';
}

// The measured steps, recomputed from the stored tap times.
// Time that fell inside a pause is taken out of the wait or the step it fell in and kept beside
// it as "not seen" (waitNotSeenSec, workNotSeenSec), so nothing is counted that nobody watched.
export function walkSteps(walk) {
  return walk.steps.map((s, i) => {
    const from = i === 0 ? walk.startedAt : walk.steps[i - 1].endAt;
    const waitNotSeenSec = Math.min(secs(walk, from, s.startAt), pausedWhole(walk, from, s.startAt));
    const workNotSeenSec = Math.min(secs(walk, s.startAt, s.endAt), pausedWhole(walk, s.startAt, s.endAt));
    return {
      name: s.name || `Step ${i + 1}`, role: s.role || ROLE_NOT_SET, msg: !!s.msg, interrupted: !!s.interrupted, ...(s.planIndex != null ? { planIndex: s.planIndex } : {}),
      waitSec: secs(walk, from, s.startAt) - waitNotSeenSec, workSec: secs(walk, s.startAt, s.endAt) - workNotSeenSec,
      ...(waitNotSeenSec ? { waitNotSeenSec } : {}), ...(workNotSeenSec ? { workNotSeenSec } : {}),
    };
  });
}

// elapsedSec is the whole walk, start to finish, with any time not seen inside it.
// notSeenSec is the paused time inside the steps and waits recorded so far.
export function walkTotals(walk, now = null) {
  const steps = walkSteps(walk);
  const workSec = steps.reduce((n, s) => n + s.workSec, 0); const waitSec = steps.reduce((n, s) => n + s.waitSec, 0);
  const notSeenSec = steps.reduce((n, s) => n + (s.waitNotSeenSec || 0) + (s.workNotSeenSec || 0), 0);
  const end = walk.finishedAt || now || (walk.steps.length ? walk.steps[walk.steps.length - 1].endAt : walk.startedAt);
  return { steps: steps.length, workSec, waitSec, notSeenSec, elapsedSec: secs(walk, walk.startedAt, end) };
}

// Share of the observed time that was waiting, as a whole percentage: waiting / (waiting + hands-on).
// Time not seen is in neither part. Null when nothing was observed.
export const waitShareOf = (waitSec, workSec) => (waitSec + workSec > 0 ? Math.round((100 * waitSec) / (waitSec + workSec)) : null);

// The steps of the map a finished walk becomes. Minutes are rounded for the map's own fields;
// the seconds stay beside them and are what the screen and the totals use.
export function mapStepsFromWalk(walk, mapId) {
  return walkSteps(walk).map((s, i) => ({
    id: `${mapId}-s${i + 1}`, name: s.name, role: s.role, wait: Math.round(s.waitSec / 60), work: Math.round(s.workSec / 60),
    waitSec: s.waitSec, workSec: s.workSec, msg: s.msg, par: false, ...(s.interrupted ? { interrupted: true } : {}),
    ...(s.waitNotSeenSec ? { waitNotSeenSec: s.waitNotSeenSec } : {}), ...(s.workNotSeenSec ? { workNotSeenSec: s.workNotSeenSec } : {}),
  }));
}

// A map's steps with times in seconds: measured seconds where a walk gave them, otherwise the
// step's minutes. A step whose minutes were changed by hand no longer carries seconds.
export const stepsInSeconds = (list) => list.map((s) => ({ ...s, wait: s.waitSec ?? (+s.wait || 0) * 60, work: s.workSec ?? (+s.work || 0) * 60 }));

// After any change to a map: a step whose minutes no longer match its measured seconds was
// changed by hand, so the seconds are dropped and the step is marked as edited.
export function dropStaleSeconds(list) {
  for (const s of list) {
    if (s.waitSec != null && Math.round(s.waitSec / 60) !== s.wait) { delete s.waitSec; s.edited = true; }
    if (s.workSec != null && Math.round(s.workSec / 60) !== s.work) { delete s.workSec; s.edited = true; }
  }
  return list;
}

export function fmtSeconds(sec) {
  sec = Math.max(0, Math.round(+sec || 0));
  if (sec < 60) return `${sec} s`;
  const m = Math.floor(sec / 60); const s = sec % 60;
  if (m < 60) return s ? `${m} min ${s} s` : `${m} min`;
  const h = Math.floor(m / 60); const r = m % 60;
  return `${h} h${r ? ` ${r < 10 ? '0' : ''}${r}` : ''}`;
}

// A clock for the walk screen: 0:07, 12:40, 1:02:05.
export function fmtClock(sec) {
  sec = Math.max(0, Math.floor(+sec || 0));
  const h = Math.floor(sec / 3600); const m = Math.floor((sec % 3600) / 60); const s = sec % 60;
  const two = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${two(m)}:${two(s)}` : `${m}:${two(s)}`;
}

// The longest wait or waits on a walked map: every step whose wait equals the longest, when
// that is at or above the floor. An empty list when no wait reaches the floor.
// Left out: a wait marked planned or required (it is needed, so it is not the question to ask).
// A wait that was partly not seen is compared by its seen part, which is the least it can have
// been, and is then named as "at least" that long: a shorter wait is never named over it.
export const waitCanBeNamed = (x) => !x.plannedWait;
// How a named wait reads: "27 min", or "at least 27 min" with the part not seen beside it.
export const waitWords = (x) => (x.waitNotSeenSec ? `at least ${fmtSeconds(x.wait)}` : fmtSeconds(x.wait));
export const notSeenWords = (x) => (x.waitNotSeenSec ? ` (${fmtSeconds(x.waitNotSeenSec)} more of it not seen)` : '');
export function longestWaits(stepsSec) {
  const open = stepsSec.filter(waitCanBeNamed);
  const max = Math.max(0, ...open.map((x) => x.wait || 0));
  return max >= MIN_LONGEST_WAIT_SEC ? open.filter((x) => x.wait === max) : [];
}

// What the guide says about a walked map. One walk is one observation, so nothing here offers
// to change a time: it asks what the longest wait was waiting for, and to walk again.
export const WALK_BASIS = {
  longestWait: `Example setting, not a standard: waits under ${MIN_LONGEST_WAIT_SEC} seconds are not named, so the gap between two taps is not read as a wait.`,
  unnamed: 'Local definition: a step needs a name and a role to be read on a map.',
  limits: 'Method: a process walk in the manner of lean value stream mapping (Rother and Shook, Learning to See). One walk is one observation.',
  clock: 'Local definition: a tap stamped earlier than the tap before it (a step tap, Pause or I am back) means the device clock was set back.',
  planned: 'Local definition: a planned or required wait is one a person marked as needed by the process itself. It counts as waiting and is left out of the longest wait. Ospeli keeps no list of such waits.',
  notSeen: 'Local definition: time between Pause and I am back is not seen. It is neither waiting nor hands-on. A wait that was partly not seen is compared by the part that was seen and named as "at least" that long.',
};
export function suggestWalk(list, { clockMoved: moved = false } = {}) {
  const out = [];
  const inSec = stepsInSeconds(list);
  const top = longestWaits(inSec);
  const left = inSec.some((x) => !waitCanBeNamed(x));
  if (moved) {
    // Times from a clock that was set back cannot be ranked: name no longest wait.
    out.push({ id: 'walk-clock', kind: 'ask', title: 'The phone\'s clock changed during this walk',
      text: 'The times on this map may be wrong. Your steps are kept. Walk it again to get times you can use. A clock that jumps forward cannot be detected, so check the phone\'s time before a walk.',
      why: 'One tap was stamped earlier than the tap before it.', basis: WALK_BASIS.clock });
  } else if (top.length) {
    const t = fmtSeconds(top[0].wait);
    out.push({ id: `walk-wait-${top[0].id}`, kind: 'ask', stepId: top[0].id,
      title: top.length === 1 ? `Longest wait on this walk: ${waitWords(top[0])} before “${top[0].name}”${notSeenWords(top[0])}`
        : `Longest wait on this walk, tied: ${t} each${top.some((x) => x.waitNotSeenSec) ? ' or more' : ''}, before ${top.map((x) => `“${x.name}”`).join(' and before ')}`,
      text: 'Ask what it was waiting for: a person, information, a room, equipment or supplies, transport, a decision, or a queue. A wait belongs to the process, not to the role that comes next. Then walk it again on another day or at another time before changing anything.',
      why: `Calculated from the tap times of this one walk.${left ? ' Waits marked planned or required are left out.' : ''}${top.some((x) => x.waitNotSeenSec) ? ' Part of this wait was not seen, so it was at least this long.' : ''}`, basis: WALK_BASIS.longestWait });
  }
  const planned = inSec.filter((x) => x.plannedWait);
  if (planned.length) {
    out.push({ id: 'walk-planned', kind: 'ask', title: `${planned.length} ${planned.length === 1 ? 'wait is' : 'waits are'} marked planned or required: ${fmtSeconds(planned.reduce((n, x) => n + (x.wait || 0), 0))}`,
      text: `These still count as waiting and are left out of the longest wait. ${PLANNED_WAIT_RULE}`,
      why: 'A person marked them on this map. Ospeli does not judge which waits are needed.', basis: WALK_BASIS.planned });
  }
  const notSeen = inSec.reduce((n, x) => n + (x.waitNotSeenSec || 0) + (x.workNotSeenSec || 0), 0);
  if (notSeen) {
    out.push({ id: 'walk-not-seen', kind: 'ask', title: `${fmtSeconds(notSeen)} of this walk was not seen`,
      text: 'The walk was paused while the person walking stepped out. That time is inside start to finish, and is counted as neither waiting nor hands-on.',
      why: 'Calculated from the Pause and I am back taps.', basis: WALK_BASIS.notSeen });
  }
  const unnamed = list.filter((s) => s.role === ROLE_NOT_SET || /^Step \d+$/.test(s.name));
  if (unnamed.length) {
    out.push({ id: 'walk-unnamed', kind: 'ask', title: `${unnamed.length} step${unnamed.length > 1 ? 's have' : ' has'} no name or role yet`,
      text: 'Tap the step and say what happened and which role did it, while you still remember.', why: 'Steps saved with “Name it later”.', basis: WALK_BASIS.unnamed });
  }
  out.push({ id: 'walk-limits', kind: 'ask', title: 'What one walk can and cannot show',
    text: 'This is what happened once. People may work differently when someone is watching, and work that ran at the same time as another step is not recorded. Tell staff what you are doing: the steps are timed, never the people.',
    why: 'A single observation is not a measurement of the process.', basis: WALK_BASIS.limits });
  return out;
}

// Short lists to tap while walking, so nothing has to be typed. Example settings, not a
// standard: a site's own words come from the steps and roles it has already used.
export const WALK_STEP_CHIPS = ['Checked in at reception', 'Seen by a nurse', 'Seen by a doctor', 'Test or scan done', 'Medicines collected', 'Next visit booked'];
export const WALK_ROLE_CHIPS = ['Reception', 'Nurse', 'Doctor', 'Pharmacy', 'Laboratory', 'Imaging'];

// ---- repeat walks: one record per walk, and the ranges across walks (issue #124 item 1) ----
// Local definitions, not a standard (decision record 18 Nov 2026):
//   a range is the lowest to the highest value across the walks, with the number of walks beside
//     it. Never a mean or a median: two or three walks are examples, not a sample;
//   totals (start to finish, waiting, hands-on) use every walk that was walked to its end on a
//     clock that did not move back. A walk that stopped early is listed and left out of totals;
//   a step's hands-on time on a walk is the sum of the times it was done on that walk (a step done
//     again is rework, and is said so);
//   the wait before a step is compared only on walks where the step happened and the step timed
//     just before it was the step before it on the list (for the first list step: nothing before
//     it). Otherwise it is not the same wait, and it belongs to that walk alone;
//   a walk whose clock moved back is listed and left out of every range;
//   no percentage is given for more than one walk.
// A record keeps seconds only: no clock time beyond the walk's start and end.
export function recordFromWalk(walk, { finishedAt, mapId = null, leftover = 'not-seen' } = {}) {
  const ids = (walk.plan || []).map((p) => p.id);
  const left = planLeft(walk).map((p) => p.id);
  const tot = walkTotals({ ...walk, finishedAt });
  return {
    id: walk.id, startedAt: walk.startedAt, finishedAt, guidanceSeen: !!walk.guidanceSeenAt,
    ...(clockMoved(walk) ? { clockMoved: true } : {}), ...(tot.notSeenSec ? { notSeenSec: tot.notSeenSec } : {}),
    steps: walkSteps(walk).map((s, i) => ({
      stepId: walk.plan ? (s.planIndex != null ? ids[s.planIndex] : null) : `${mapId}-s${i + 1}`,
      ...(walk.plan && s.planIndex == null ? { name: s.name, role: s.role } : {}),
      waitSec: s.waitSec, workSec: s.workSec, ...(s.waitNotSeenSec ? { waitNotSeenSec: s.waitNotSeenSec } : {}), ...(s.workNotSeenSec ? { workNotSeenSec: s.workNotSeenSec } : {}),
      ...(s.interrupted ? { interrupted: true } : {}) })),
    ...(walk.plan ? { didNotHappen: [...(walk.skipped || []).map((i) => ids[i]), ...(leftover === 'did-not-happen' ? left : [])] } : {}),
    // List steps left when the walk was finished and not said to be missing: the person stopped early.
    ...(walk.plan && left.length && leftover !== 'did-not-happen' ? { stoppedEarly: true, notTimed: left } : {}),
  };
}
// The record of a first walk made before records were kept, from the map's own measured steps.
export function recordFromMap(map) {
  return { id: map.walk.id, startedAt: map.walk.startedAt, finishedAt: map.walk.finishedAt, guidanceSeen: map.walk.guidanceSeen,
    ...(map.walk.clockMoved ? { clockMoved: true } : {}), ...(map.walk.notSeenSec ? { notSeenSec: map.walk.notSeenSec } : {}),
    steps: map.today.filter((s) => s.waitSec != null && s.workSec != null).map((s) => ({ stepId: s.id, waitSec: s.waitSec, workSec: s.workSec,
      ...(s.waitNotSeenSec ? { waitNotSeenSec: s.waitNotSeenSec } : {}), ...(s.workNotSeenSec ? { workNotSeenSec: s.workNotSeenSec } : {}), ...(s.interrupted ? { interrupted: true } : {}) })) };
}
export const walkRecords = (map) => (map.walk ? (map.walks?.length ? map.walks : [recordFromMap(map)]) : []);

// Whole minutes for a time across walks: seconds read as more exact than a tap is.
export const fmtWholeMin = (sec) => (sec < 60 ? 'under 1 min' : fmtSeconds(Math.round(sec / 60) * 60));
// "41 to 58 min", lowest to highest. Equal values: "27 min on both walks". One walk: "27 min (1 walk)".
export function fmtRange(r, { count = true } = {}) {
  if (!r || !r.n) return 'not timed';
  const a = fmtWholeMin(r.min); const b = fmtWholeMin(r.max);
  const least = r.atLeast ? ' or more' : '';
  if (r.n === 1) return `${a}${least}${count ? ' (1 walk)' : ''}`;
  if (a === b) return `${a}${least} on ${r.n === 2 ? 'both' : `all ${r.n}`} walks`;
  // "54 min to 1 h 08" keeps both units; "41 to 58 min" says the unit once.
  const short = /^\d+ min$/.test(a) && /^\d+ min$/.test(b);
  return `${short ? a.replace(' min', '') : a} to ${b}${least}`;
}
const span = (vals, atLeast = false) => (vals.length ? { min: Math.min(...vals), max: Math.max(...vals), n: vals.length, ...(atLeast ? { atLeast: true } : {}) } : { n: 0 });

// The ranges of a map's walks. list: the map's saved step list (its first version's steps).
export function walkRanges(list, records) {
  const order = list.map((s) => s.id);
  const planned = new Set(list.filter((s) => s.plannedWait).map((s) => s.id));
  const nameOf = (id) => list.find((s) => s.id === id)?.name;
  const walks = records.map((r, i) => {
    const sum = (k) => r.steps.reduce((n, s) => n + (s[k] || 0), 0);
    const waitSec = sum('waitSec'); const workSec = sum('workSec'); const notSeenSec = sum('waitNotSeenSec') + sum('workNotSeenSec');
    const usable = !r.clockMoved; const complete = usable && !r.stoppedEarly;
    // This walk's own longest wait: by the seen part, 30 s or more, planned waits left out, ties all named.
    const open = r.steps.map((s, p) => ({ ...s, p })).filter((s) => !(s.stepId && planned.has(s.stepId)) && (!s.stepId || order.includes(s.stepId)));
    const max = Math.max(0, ...open.map((s) => s.waitSec));
    const longest = usable && max >= MIN_LONGEST_WAIT_SEC ? open.filter((s) => s.waitSec === max).map((s) => ({ key: s.stepId || `off:${s.name}`, name: s.stepId ? nameOf(s.stepId) : s.name, waitSec: s.waitSec, ...(s.waitNotSeenSec ? { atLeast: true } : {}) })) : [];
    return { n: i + 1, id: r.id, startedAt: r.startedAt, finishedAt: r.finishedAt, usable, complete, ...(r.clockMoved ? { clockMoved: true } : {}), ...(r.stoppedEarly ? { stoppedEarly: true } : {}),
      guidanceSeen: r.guidanceSeen, elapsedSec: waitSec + workSec + notSeenSec, waitSec, workSec, notSeenSec,
      plannedWaitSec: r.steps.reduce((n, s) => n + (s.stepId && planned.has(s.stepId) ? s.waitSec : 0), 0),
      steps: r.steps.length, offList: r.steps.filter((s) => !s.stepId).length, longest };
  });
  const used = records.filter((r) => !r.clockMoved);
  const full = walks.filter((w) => w.complete);
  const steps = list.map((st, li) => {
    const work = []; const wait = []; let happened = 0; let again = 0; let didNot = 0; let waitLeast = false;
    for (const r of used) {
      const at = r.steps.map((s, p) => ({ ...s, p })).filter((s) => s.stepId === st.id);
      if (!at.length) { if ((r.didNotHappen || []).includes(st.id)) didNot += 1; continue; }
      happened += 1; if (at.length > 1) again += 1;
      work.push(at.reduce((n, s) => n + s.workSec, 0));
      const first = at[0]; const before = first.p > 0 ? r.steps[first.p - 1].stepId : null;
      if (li === 0 ? first.p === 0 : before === order[li - 1]) { wait.push(first.waitSec); if (first.waitNotSeenSec) waitLeast = true; }
    }
    return { stepId: st.id, happened, of: used.length, didNotHappen: didNot, again, work: span(work), wait: span(wait, waitLeast) };
  });
  // Where the longest wait fell, walk by walk: the test of whether it stays in one place.
  const tally = new Map();
  for (const w of walks) for (const l of w.longest) { const t = tally.get(l.key) || { stepId: l.key.startsWith('off:') ? null : l.key, name: l.name, walks: [] }; t.walks.push(w.n); tally.set(l.key, t); }
  const usable = walks.filter((w) => w.usable);
  return {
    count: records.length, usable: usable.length, complete: full.length, aim: WALKS_AIM, walks, steps,
    totals: { elapsed: span(full.map((w) => w.elapsedSec)), wait: span(full.map((w) => w.waitSec)), work: span(full.map((w) => w.workSec)) },
    longest: [...tally.values()].sort((a, b) => b.walks.length - a.walks.length), longestOf: usable.filter((w) => w.longest.length).length,
  };
}

// What the guide says about a map with two or more walks: it reads the range, never a middle value.
export const RANGE_BASIS = {
  range: `Local definition, not a standard: a range is the lowest to the highest value across the walks. No average is given: ${WALKS_AIM} walks are examples, not a sample. The aim of ${WALKS_AIM} walks is an example setting.`,
  compare: 'Local definition: the wait before a step is compared only on walks where the step happened and the step timed just before it was the step before it on the list. A step\'s hands-on time on a walk is the sum of the times it was done on that walk. A walk that stopped early or whose clock moved back is left out.',
  when: 'Practice, no published source: walks at one hour of one day show that hour, not the service.',
};
export function suggestWalks(list, ranges, { sameHour = false } = {}) {
  const out = [];
  const name = (l) => `“${l.name}”`;
  const top = ranges.longest;
  if (top.length) {
    const of = ranges.longestOf;
    const stays = top[0].walks.length === of && top.length === 1;
    const moved = top.every((l) => l.walks.length === 1) && top.length > 1;
    out.push({ id: 'walks-longest', kind: 'ask', ...(top[0].stepId ? { stepId: top[0].stepId } : {}),
      title: stays ? `The longest wait was before ${name(top[0])} on ${of === 2 ? 'both' : `all ${of}`} walks`
        : moved ? 'The longest wait moved on each walk' : `The longest wait was before ${name(top[0])} on ${top[0].walks.length} of ${of} walks`,
      text: stays ? 'Ask what it was waiting for: a person, information, a room, equipment or supplies, transport, a decision, or a queue. A wait belongs to the process, not to the role that comes next.'
        : `${top.map((l) => `Before ${name(l)} on walk ${l.walks.join(' and ')}`).join('. ')}. When the longest wait moves, ask what was different on each visit before changing anything.`,
      why: `Each walk's own longest wait, from its tap times. Waits under ${MIN_LONGEST_WAIT_SEC} seconds and waits marked planned or required are left out.`, basis: WALK_BASIS.longestWait });
  }
  if (ranges.count < ranges.aim || sameHour) {
    out.push({ id: 'walks-more', kind: 'ask', title: ranges.count < ranges.aim ? `${ranges.count} of ${ranges.aim} walks so far` : 'Every walk started at about the same hour',
      text: 'Walk it again on another day or at another hour. The same steps can take a different time when the service is busier or quieter.',
      why: sameHour ? 'The walks on this map all started within the same hour of the day.' : 'Calculated from the number of walks on this map.', basis: RANGE_BASIS.when });
  }
  const gaps = ranges.steps.filter((s) => s.happened < s.of || s.again || s.wait.n < s.happened);
  const left = ranges.walks.filter((w) => !w.usable || !w.complete);
  out.push({ id: 'walks-compare', kind: 'ask', title: 'How the walks are compared',
    text: `Each range is the shortest to the longest across the walks. ${gaps.length ? `${gaps.length} ${gaps.length === 1 ? 'step was' : 'steps were'} not the same on every walk; the step list says on how many walks each was compared. ` : ''}${left.length ? `Walk ${left.map((w) => w.n).join(' and ')} ${left.length === 1 ? 'is' : 'are'} listed and left out of the totals. ` : ''}People may work differently when someone is watching, and work that ran at the same time as another step is not recorded.`,
    why: 'Two or three walks are examples. They are not a measurement of the service.', basis: `${RANGE_BASIS.range} ${RANGE_BASIS.compare}` });
  return out;
}
