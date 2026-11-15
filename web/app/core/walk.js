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
// Times are computed from the stored clock times in whole seconds and rounded only for display;
// a timer on screen is never the record. One walk is one observation, not the process.

export const MAX_WALK_STEPS = 60;
export const ROLE_NOT_SET = 'Not set';

const secs = (a, b) => Math.max(0, Math.round((Date.parse(b) - Date.parse(a)) / 1000));

export function newWalk({ id, title, at, role }) {
  return { id, title, startedAt: at, steps: [], current: null, status: 'walking', mapId: null, createdByRole: role, finishedAt: null };
}

// 'step' while a step is running, otherwise 'waiting'.
export const walkState = (walk) => (walk.current ? 'step' : 'waiting');

// When the present wait (or step) began.
export function sinceAt(walk) {
  if (walk.current) return walk.current.startAt;
  const last = walk.steps[walk.steps.length - 1];
  return last ? last.endAt : walk.startedAt;
}

export function stepStart(walk, at) {
  if (walk.current) throw new Error('A step is already running.');
  if (walk.steps.length >= MAX_WALK_STEPS) throw new Error(`A walk holds at most ${MAX_WALK_STEPS} steps.`);
  walk.current = { startAt: at };
  return walk;
}

// End the running step. interrupted: the work stopped before it was finished.
export function stepDone(walk, at, { interrupted = false } = {}) {
  if (!walk.current) throw new Error('No step is running.');
  walk.steps.push({ startAt: walk.current.startAt, endAt: at, name: null, role: null, msg: false, ...(interrupted ? { interrupted: true } : {}) });
  walk.current = null;
  return walk;
}

// Name the step that just ended. nextStarted: the next step began the moment this one ended
// (a hand-over with no wait), so it starts at this step's end time, not at the time of this tap.
export function nameLast(walk, { name, role, msg = false, nextStarted = false }) {
  const last = walk.steps[walk.steps.length - 1];
  if (!last) throw new Error('No step has ended yet.');
  if (name != null) last.name = name;
  if (role != null) last.role = role;
  last.msg = !!msg;
  if (nextStarted) {
    if (walk.current) throw new Error('The next step is already running.');
    stepStart(walk, last.endAt);
  }
  return walk;
}

// Take back the last tap: a running step goes back to waiting; otherwise the last ended step
// runs again (its name is dropped with it).
export function undoLast(walk) {
  if (walk.current) { walk.current = null; return 'step-start'; }
  const last = walk.steps.pop();
  if (!last) throw new Error('There is nothing to undo.');
  walk.current = { startAt: last.startAt };
  return 'step-done';
}

// The measured steps, recomputed from the stored tap times.
export function walkSteps(walk) {
  return walk.steps.map((s, i) => ({
    name: s.name || `Step ${i + 1}`, role: s.role || ROLE_NOT_SET, msg: !!s.msg, interrupted: !!s.interrupted,
    waitSec: secs(i === 0 ? walk.startedAt : walk.steps[i - 1].endAt, s.startAt), workSec: secs(s.startAt, s.endAt),
  }));
}

export function walkTotals(walk, now = null) {
  const steps = walkSteps(walk);
  const workSec = steps.reduce((n, s) => n + s.workSec, 0); const waitSec = steps.reduce((n, s) => n + s.waitSec, 0);
  const end = walk.finishedAt || now || (walk.steps.length ? walk.steps[walk.steps.length - 1].endAt : walk.startedAt);
  return { steps: steps.length, workSec, waitSec, elapsedSec: secs(walk.startedAt, end) };
}

// The steps of the map a finished walk becomes. Minutes are rounded for the map's own fields;
// the seconds stay beside them and are what the screen and the totals use.
export function mapStepsFromWalk(walk, mapId) {
  return walkSteps(walk).map((s, i) => ({
    id: `${mapId}-s${i + 1}`, name: s.name, role: s.role, wait: Math.round(s.waitSec / 60), work: Math.round(s.workSec / 60),
    waitSec: s.waitSec, workSec: s.workSec, msg: s.msg, par: false, ...(s.interrupted ? { interrupted: true } : {}),
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

// What the guide says about a walked map. One walk is one observation, so nothing here offers
// to change a time: it asks what the longest wait was waiting for, and to walk again.
export function suggestWalk(list) {
  const out = [];
  const inSec = stepsInSeconds(list);
  const worst = [...inSec].sort((a, b) => b.wait - a.wait)[0];
  if (worst && worst.wait > 0) {
    out.push({ id: `walk-wait-${worst.id}`, kind: 'ask', stepId: worst.id,
      title: `Longest wait on this walk: ${fmtSeconds(worst.wait)} before “${worst.name}”`,
      text: 'Ask what it was waiting for: a person, information, a room, equipment or supplies, transport, a decision, or a queue. Then walk it again on another day or at another time before changing anything.',
      why: 'Calculated from the tap times of this one walk.' });
  }
  const unnamed = list.filter((s) => s.role === ROLE_NOT_SET || /^Step \d+$/.test(s.name));
  if (unnamed.length) {
    out.push({ id: 'walk-unnamed', kind: 'ask', title: `${unnamed.length} step${unnamed.length > 1 ? 's have' : ' has'} no name or role yet`,
      text: 'Tap the step and say what happened and which role did it, while you still remember.', why: 'Steps saved with “Name it later”.' });
  }
  out.push({ id: 'walk-limits', kind: 'ask', title: 'What one walk can and cannot show',
    text: 'This is what happened once. People may work differently when someone is watching, and work that ran at the same time as another step is not recorded. Tell staff what you are doing: the steps are timed, never the people.',
    why: 'A single observation is not a measurement of the process.' });
  return out;
}

// Short lists to tap while walking, so nothing has to be typed. Example settings, not a
// standard: a site's own words come from the steps and roles it has already used.
export const WALK_STEP_CHIPS = ['Checked in at reception', 'Seen by a nurse', 'Seen by a doctor', 'Test or scan done', 'Medicines collected', 'Next visit booked'];
export const WALK_ROLE_CHIPS = ['Reception', 'Nurse', 'Doctor', 'Pharmacy', 'Laboratory', 'Imaging'];
