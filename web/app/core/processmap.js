// Process maps (backlog PM1): pure functions only, no storage. A map has two versions of the
// same process: "today" (as it is) and "proposed" (a what-if). The guide's rules read a version
// and say why; trying a suggestion changes only the proposed version. People decide.
//
// Times are minutes. Each step has: name, role (who does it, in the site's own words), wait
// (minutes waiting before the step starts), work (hands-on minutes), msg (the step only passes
// on information), par (starts alongside the step before instead of after it).

// Fictional example processes. General patterns only; no real site, figures or wording.
export const EXAMPLES = {
  discharge: {
    title: 'Discharge home from a medical ward',
    start: 'Senior doctor decides the patient can go home',
    steps: [
      ['Senior doctor confirms the patient can go home', 'Doctor', 0, 5],
      ['Junior doctor writes the discharge letter and take-home prescription', 'Doctor', 95, 25],
      ['Pharmacy checks and dispenses take-home medicines', 'Pharmacy', 130, 20],
      ['Medicines collected from pharmacy and brought to the ward', 'Patient transport', 35, 10],
      ['Nurse explains medicines and gives advice', 'Nurse', 40, 15],
      ['Patient waits to be collected, then leaves', 'Patient and family', 70, 5],
      ['Ward tells the patient flow team the bed is empty', 'Nurse', 35, 2, 'msg'],
      ['Request for the bed to be cleaned', 'Patient flow team', 20, 2, 'msg'],
      ['Bed and bay cleaned', 'Housekeeping', 45, 20],
      ['Bed marked ready for the next patient', 'Patient flow team', 25, 1, 'msg'],
    ],
  },
  fault: {
    title: 'Report and fix broken equipment',
    start: 'A nurse finds a suction unit not working',
    steps: [
      ['Nurse finds the fault and looks for the helpdesk number', 'Nurse', 0, 5],
      ['Fault phoned through to the helpdesk', 'Nurse', 20, 5, 'msg'],
      ['Helpdesk logs a job and passes it on', 'Helpdesk', 30, 5, 'msg'],
      ['Supervisor assigns a technician', 'Facilities supervisor', 120, 5],
      ['Technician visits and finds a part is needed', 'Technician', 180, 30],
      ['Part requested from stores', 'Technician', 30, 10, 'msg'],
      ['Stores issues the part', 'Stores', 240, 10],
      ['Technician fits the part and tests the unit', 'Technician', 120, 40],
      ['Ward told the unit is back in service', 'Helpdesk', 45, 2, 'msg'],
    ],
  },
  ed: {
    title: 'Emergency department arrival to ward bed',
    start: 'Patient arrives at the emergency department',
    steps: [
      ['Patient arrives and is booked in', 'Reception', 0, 5],
      ['Triage by a nurse', 'Nurse', 25, 10],
      ['Seen by a doctor', 'Doctor', 85, 20],
      ['Blood tests and imaging', 'Diagnostics', 20, 15, '', 'par'],
      ['Results reviewed; decision to admit', 'Doctor', 110, 10],
      ['Ward specialist accepts the patient', 'Specialist team', 60, 10, 'msg'],
      ['Bed requested from the patient flow team', 'Nurse', 15, 3, 'msg'],
      ['Bed found and allocated', 'Patient flow team', 150, 5],
      ['Patient transport takes the patient to the ward', 'Patient transport', 40, 15],
    ],
  },
};

export const VERSIONS = ['today', 'proposed'];
export const MAX_STEPS = 60;
export const MAX_MINUTES = 7 * 24 * 60;

const clone = (x) => JSON.parse(JSON.stringify(x));

export function stepsFromExample(key, mapId) {
  const ex = EXAMPLES[key];
  return ex.steps.map((s, i) => ({ id: `${mapId}-s${i + 1}`, name: s[0], role: s[1], wait: s[2], work: s[3], msg: s[4] === 'msg', par: s[5] === 'par' }));
}

export function newMap({ id, from = 'blank', title, at, role }) {
  const ex = EXAMPLES[from];
  const steps = ex ? stepsFromExample(from, id) : [];
  return {
    id, title: title || (ex ? ex.title : 'My process'), start: ex ? ex.start : '', from,
    today: steps, proposed: clone(steps), tried: [], hidden: [], revision: 1, nextStep: steps.length + 1,
    createdAt: at, createdByRole: role, updatedAt: at,
  };
}

// Free text is needed (steps and roles in the site's own words), so refuse anything that looks
// like a personal detail: phone numbers, email addresses, long ID numbers, dates of birth.
const PERSONAL = [
  [/[\w.+-]+@[\w-]+\.[\w.]+/, 'an email address'],
  [/\+?\d[\d\s().-]{7,}\d/, 'a phone or ID number'],
  [/\b\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}\b/, 'a date'],
];
// Maps measure flows, never people (issue #38): a title followed by a name ("Dr Sarah Jones",
// "Sister Mary Brown") is refused. A title followed by a job word ("Nurse Manager") is a role.
const TITLE_NAME = /\b(?:Dr|Doctor|Nurse|Sister|Matron|Mr|Mrs|Ms|Miss|Mx|Prof|Professor)\.?\s+([A-Z][A-Za-z'’-]+)/g;
const JOB_WORDS = new Set(`admin administrator admissions anaesthetist assistant biomedical booking care caretaker carer charge chief
  cleaner cleaning clerk clinic clinical clinician community consultant coordinator dental dentist department desk diagnostics dietitian
  discharge dispenser doctor driver duty education educator emergency engineer engineering equipment facilities family finance flow
  general head health helpdesk housekeeper housekeeping imaging infection junior lab laboratory lead leader liaison maintenance manager
  matron medical medicines midwife nurse nursing occupational office officer on-call operations operator outpatient outpatients patient
  pharmacist pharmacy physician physio physiotherapist physiotherapy porter practice practitioner prevention quality radiographer
  radiology reception receptionist records registrar relative review round safety security senior service services shift site social
  specialist staff stores supervisor support surgeon surgical team technician theatre therapist therapy transport triage unit visitor
  volunteer ward worker and for in of on the at`.split(/\s+/));
const isJobWord = (w) => JOB_WORDS.has(w.toLowerCase().replace(/[^a-z-]/g, ''));
export function personNameIn(text, { roleField = false } = {}) {
  const s = String(text);
  for (const m of s.matchAll(TITLE_NAME)) if (!isJobWord(m[1])) return true;
  if (roleField) {
    // In the role field, two or three capitalised words with no job word among them read as a name.
    const words = s.trim().split(/\s+/);
    if (words.length >= 2 && words.length <= 3 && words.every((w) => /^[A-Z][A-Za-z'’-]+$/.test(w)) && !words.some(isJobWord)) return true;
  }
  return false;
}
export const NAME_ADVICE = 'Use a role, not a person\'s name (for example Doctor, Charge nurse, Pharmacy). Ospeli times steps, never people.';

export function personalDetailIn(text) {
  for (const [re, what] of PERSONAL) if (re.test(String(text))) return what;
  return null;
}

// ---- analysis ----
export function analyse(list) {
  let t = 0; let prevStart = 0; let prevEnd = 0; let work = 0; let wait = 0; let handoffs = 0; let msgs = 0;
  const timed = list.map((s, i) => {
    const base = s.par && i > 0 ? prevStart : prevEnd;
    const start = base + (+s.wait || 0); const end = start + (+s.work || 0);
    if (i > 0 && s.role !== list[i - 1].role) handoffs++;
    if (s.msg) msgs++;
    work += +s.work || 0; wait += +s.wait || 0;
    prevStart = start; prevEnd = Math.max(end, s.par ? prevEnd : end);
    t = Math.max(t, end);
    return { id: s.id, start, end };
  });
  const byWait = [...list].sort((a, b) => (b.wait || 0) - (a.wait || 0));
  const worst = byWait[0] && byWait[0].wait > 0 ? byWait[0].id : null;
  const roles = [];
  for (const s of list) if (!roles.includes(s.role)) roles.push(s.role);
  return {
    steps: list.length, elapsed: t, work, wait, handoffs, infoSteps: msgs, roles,
    workShare: t ? Math.round((100 * work) / t) : null, biggestWaitStepId: worst, timed,
  };
}

export function fmtMinutes(m) {
  m = Math.round(+m || 0);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60); const r = m % 60;
  return `${h} h${r ? ` ${r < 10 ? '0' : ''}${r}` : ''}`;
}

// ---- the guide: plain, explainable rules ----
// Each suggestion: { id, kind: 'time'|'ask', title, text, why, stepId?, change? }.
// `change` is data, not code: what "Try in Proposed" does. applyChange() carries it out.
export function suggest(list) {
  const a = analyse(list); const out = [];
  if (!list.length) {
    return [{ id: 'start', kind: 'ask', title: 'Start with what triggers the process',
      text: 'Add the first step: the moment the process starts (a decision, an arrival, a fault found). Then add each step in order, with who does it. Rough times are fine.',
      why: 'A map starts from a clear trigger and ends at a clear finish.' }];
  }
  const share = (m) => (a.elapsed ? Math.round((100 * m) / a.elapsed) : 0);
  const byWait = list.map((s, i) => ({ s, i })).sort((x, y) => (y.s.wait || 0) - (x.s.wait || 0));
  byWait.slice(0, 2).forEach(({ s, i }, k) => {
    if (!s.wait || share(s.wait) < 12) return;
    const prev = list[i - 1];
    out.push({ id: `wait-${s.id}`, kind: 'time', stepId: s.id,
      title: `${k === 0 ? 'Biggest wait' : 'Next biggest wait'}: ${fmtMinutes(s.wait)} before “${s.name}”`,
      text: `This wait is ${share(s.wait)}% of the whole process. Ask the team what it is waiting for. Could it be prepared earlier${prev ? `, before “${prev.name}” finishes` : ''}, or done in a fixed slot so others can plan around it?`,
      why: 'Calculated from the times on this map.',
      tryLabel: 'Try in Proposed: halve this wait', change: { op: 'halve-wait', stepId: s.id } });
  });
  const msgSteps = list.filter((s) => s.msg && s.wait >= 15);
  if (msgSteps.length) {
    const mw = msgSteps.reduce((n, s) => n + s.wait, 0);
    out.push({ id: 'msgs', kind: 'time',
      title: `${msgSteps.length} step${msgSteps.length > 1 ? 's' : ''} only pass${msgSteps.length > 1 ? '' : 'es'} on information, after ${fmtMinutes(mw)} of waiting`,
      text: 'Calls, messages and forms that tell the next person to start. If whoever finishes a step updates its status once, everyone who needs it can see it at once, without a call.',
      why: 'Steps marked “only passes on information” on this map.',
      tryLabel: 'Try in Proposed: one-tap status update', change: { op: 'status-update' } });
  }
  if (a.handoffs >= 4) {
    out.push({ id: 'handoffs', kind: 'ask', title: `${a.handoffs} handoffs between roles`,
      text: 'Each handoff is a place where work can sit in someone else’s queue. Look at neighbouring steps done by different people: could one person do both, or could the next person be told before the step ends?',
      why: 'Counted where the role changes from one step to the next.' });
  }
  for (let i = 1; i < list.length; i++) {
    const s = list[i]; const p = list[i - 1];
    if (!s.par && !p.par && s.role !== p.role && s.wait >= 30 && !s.msg && !p.msg) {
      out.push({ id: `par-${s.id}`, kind: 'ask', stepId: s.id, title: `Does “${s.name}” need the step before to finish?`,
        text: `If it does not, it could run at the same time as “${p.name}”. Check with both teams before changing anything.`,
        why: `Different roles, and a wait of ${fmtMinutes(s.wait)} between them.`,
        tryLabel: 'Try in Proposed: run together', change: { op: 'run-alongside', stepId: s.id } });
      break;
    }
  }
  const blank = list.filter((s) => !(+s.work) && !(+s.wait));
  if (blank.length) {
    out.push({ id: 'blank', kind: 'ask', title: `${blank.length} step${blank.length > 1 ? 's have' : ' has'} no times yet`,
      text: `Time ${blank.length > 1 ? 'them' : 'it'} on your next walk of the process, so the map shows where time really goes.`,
      why: 'Steps with no waiting or hands-on time recorded.' });
  }
  out.push({ id: 'questions', kind: 'ask', title: 'Questions to ask on your next walk',
    text: 'Who decides each step is done? What tells the next person to start? Where does the patient or item sit while it waits? Which step would you remove first, and what would stop you?',
    why: 'Standard process-walk questions; they apply to any process.' });
  return out;
}

// Carry out a suggestion's change on a list of steps (returns a new list).
export function applyChange(list, change) {
  const next = clone(list);
  if (change.op === 'halve-wait') next.forEach((s) => { if (s.id === change.stepId) s.wait = Math.round(s.wait / 2); });
  else if (change.op === 'status-update') next.forEach((s) => { if (s.msg) { s.wait = Math.min(s.wait, 5); s.work = Math.min(s.work, 1); } });
  else if (change.op === 'run-alongside') next.forEach((s) => { if (s.id === change.stepId) { s.par = true; s.wait = 0; } });
  else throw new Error(`unknown change ${change.op}`);
  return next;
}
