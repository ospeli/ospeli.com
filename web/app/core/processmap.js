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
    start: 'The doctor decides the patient can go home',
    steps: [
      ['Doctor confirms the patient can go home', 'Doctor', 0, 5],
      ['Doctor writes the discharge letter and take-home prescription', 'Doctor', 95, 25],
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
// A record number is a label (MRN, ID, No., record or hospital number) followed by six or more
// digits; a short phone number is a calling word followed by six or more digits (issue #38).
// A label that only ever names a record (MRN, NHS, ID, record, chart, case) is enough with three or
// more digits: many small sites use four- or five-digit numbers (#150). "Room 12", "Bed 14B" and
// "No 12 bus" still pass.
const RECORD_NUMBER = { test: (t) => /\b(?:MRN|NHS|ID|IDs|No|Nr|Num|Number|Ref|Reference|Record|Chart|Case|Account|Policy|Insurance)\b[\s.:#-]*(?:(?:no|nr|num|number)\b[\s.:#-]*)?\d{6,}\b/i.test(t)
  || /\b(?:MRN|NHS|ID|IDs|Record|Chart|Case)\b[\s.:#-]*(?:(?:no|nr|num|number)\b[\s.:#-]*)?\d{3,}\b/i.test(t)
  // "Hosp no 44871", "Hospital number 4487", "Patient # 512" (#150, critic 22 Nov): a hospital or patient
  // number needs the number word or # after it, so "Hospital 2" and "Patient 3 of 12" still pass.
  // The number may be written with a letter in front or in groups ("A44871", "44 871"): the same number (23 Nov).
  || /\b(?:Hosp|Hospital|Patient|Pt)\b\.?[\s:-]*(?:(?:no|nr|num|number)\b\.?|#)[\s.:#-]*[A-Za-z]{0,3}\d(?:[\s-]?\d){2,}\b/i.test(t) };
const CALL_NUMBER = /\b(?:phone|call|ring|tel|telephone|text|page|fax|ext|extension|mobile|cell|whatsapp)\b\D{0,12}(\d[\d\s().-]{4,}\d)/gi;
const PERSONAL = [
  [/[\w.+-]+@[\w-]+\.[\w.]+/, 'an email address'],
  [RECORD_NUMBER, 'a record or ID number'],
  [/\+?\d[\d\s().-]{7,}\d/, 'a phone or ID number'],
  // Every calling word is tried: a short extension first must not hide a phone number after it.
  [{ test: (t) => [...String(t).matchAll(CALL_NUMBER)].some((m) => m[1].replace(/\D/g, '').length >= 6) }, 'a phone or ID number'],
  [/\b\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}\b/, 'a date'],
];
// Maps measure flows, never people (issue #38): a title followed by a name ("Dr Sarah Jones",
// "Sister Mary Brown") is refused. A title followed by a job word ("Nurse Manager") is a role.
// A title is read as typed in the usual way or all in capitals ("Mr", "MR"); not all in small
// letters, so "near miss A and E" is not a title.
const titles = (list) => list.flatMap((t) => [t, t.toUpperCase()]).join('|');
const TITLE_NAME = new RegExp(`\\b(?:${titles(['Dr', 'Doctor', 'Nurse', 'Sister', 'Matron', 'Mr', 'Mrs', 'Ms', 'Miss', 'Mx', 'Prof', 'Professor'])})\\.?\\s+([A-Z][A-Za-z'’-]+)`, 'g');
const JOB_WORDS = new Set(`admin administrator admissions anaesthetist assistant biomedical booking care caretaker carer charge chief
  cleaner cleaning clerk clinic clinical clinician community consultant coordinator dental dentist department desk diagnostics dietitian
  discharge dispenser doctor driver duty education educator emergency engineer engineering equipment facilities family finance flow
  general head health helpdesk housekeeper housekeeping imaging infection junior lab laboratory lead leader liaison maintenance manager
  matron medical medicines midwife nurse nursing occupational office officer on-call operations operator outpatient outpatients patient
  pharmacist pharmacy physician physio physiotherapist physiotherapy porter practice practitioner prevention quality radiographer
  radiology reception receptionist records registrar relative review round safety security senior service services shift site social
  specialist staff stores supervisor support surgeon surgical team technician theatre therapist therapy transport triage unit visitor
  volunteer ward worker and for in of on the at`.split(/\s+/));
// A personal title and an initial ("Mr J. Smith", "Dr K Patel", "Ms A") is a person (#150, critic 22 Nov).
// The spelt-out titles count too ("Doctor K Patel"), 23 Nov.
const TITLE_INITIAL = new RegExp(`\\b(?:${titles(['Dr', 'Doctor', 'Mr', 'Mrs', 'Ms', 'Miss', 'Mx', 'Prof', 'Professor'])})\\.?\\s+[A-Z](?:\\.|\\b)`);
const isJobWord = (w) => JOB_WORDS.has(w.toLowerCase().replace(/[^a-z-]/g, ''));
export function personNameIn(text, { roleField = false } = {}) {
  const s = String(text);
  for (const m of s.matchAll(TITLE_NAME)) if (!isJobWord(m[1])) return true;
  if (TITLE_INITIAL.test(s)) return true;
  if (roleField) {
    // In the role field, two or three capitalised words with no job word among them read as a name.
    const words = s.trim().split(/\s+/);
    if (words.length >= 2 && words.length <= 3 && words.every((w) => /^[A-Z][A-Za-z'’-]+$/.test(w)) && !words.some(isJobWord)) return true;
  }
  return false;
}
// A name with no title cannot be told from ordinary words by a list (issue #38), so this only
// finds text that MAY be a name, and the command asks once instead of refusing:
// - two capitalised words in a row, neither a role or place word ("Sarah Jones signs the form");
// - one capitalised word straight after a word that usually comes before a person ("Check with Anita").
// Returns the words that look like a name, or null. Names typed in lower case are not found.
const NOT_NAMES = new Set(`bed beds bay bays room rooms recovery home blood bank lab labs imaging x-ray scan ward wards unit units
  monday tuesday wednesday thursday friday saturday sunday january february march april may june july august september october
  november december today tomorrow day night morning evening shift example hospital clinic site stores store kitchen laundry
  mortuary main north south east west block floor level wing entrance exit car park helpdesk it hr my our their process map step
  form forms list lists chart charts order orders request requests result results sample samples medicine medicines oxygen`.split(/\s+/));
const BEFORE_A_PERSON = new Set('patient with ask asks asked tell tells told call calls phone phones ring rings by from see find page text email contact inform notify'.split(' '));
const CAP_WORD = /^[A-Z][a-z'’-]+$/;
const plainWord = (w) => w.replace(/^[^A-Za-z]+|[^A-Za-z'’-]+$/g, '');
const nameLike = (w) => CAP_WORD.test(w) && !isJobWord(w) && !NOT_NAMES.has(w.toLowerCase()) && !BEFORE_A_PERSON.has(w.toLowerCase());
export function possibleNameIn(text) {
  const words = String(text).trim().split(/\s+/).map(plainWord).filter(Boolean);
  for (let i = 0; i < words.length - 1; i++) if (nameLike(words[i]) && nameLike(words[i + 1])) return `${words[i]} ${words[i + 1]}`;
  for (let i = 0; i < words.length - 1; i++) if (BEFORE_A_PERSON.has(words[i].toLowerCase()) && nameLike(words[i + 1])) return words[i + 1];
  // An initial and a capitalised word ("S. Jones to sign"), asked once like the rest (#150, critic 22 Nov).
  const m = String(text).match(/(?:^|\s)([A-Z])\.\s?([A-Z][a-z'’-]+)\b/);
  if (m && nameLike(m[2])) return `${m[1]}. ${m[2]}`;
  return null;
}
// Place, asset and device names (issue #94): "Day Surgery", "Water Cooler" and "Night Tablet" are
// two capitalised words with no job word, and are not people. A word that says what a thing is or
// where it is ("Surgery", "Cooler", "Tablet") is set aside; what is left is judged as the role
// field is: two or three capitalised words with no job word read as a name ("Jane Placeholder",
// "Anita Khan Phone"). A titled name is refused as everywhere else. A list cannot know every
// word: a place called after one unlisted word pair still reads as a name and is refused.
const PLACE_OR_THING = new Set(`tablet tablets phone phones laptop laptops pc computer computers kiosk screen screens terminal
  ipad device devices scanner scanners printer printers mobile handset desk front reception station nurses office offices
  corridor surgery surgeries building buildings plant cooler coolers room rooms theatre theatres suite centre center hall
  lounge garden pharmacy dispensary outpatients outpatient inpatient department dept service services storage storeroom
  boiler generator generators chiller pump pumps fridge freezer heater lift lifts elevator elevators ramp stairs door doors
  gate machine machines monitor monitors cart carts stretcher stretchers chair chairs couch sink sinks toilet toilets shower showers bath
  water air gas power light lights lighting fan fans heating cooling ventilation alarm alarms panel cabinet cupboard locker
  steriliser sterilizer autoclave washer dryer utility macerator wheelchair wheelchairs hoist stretcher ultrasound radiology
  physiotherapy physio dental eye maternity paediatric pediatric surgical medical day upper lower ground first second
  third annex annexe wing tower house cottage lodge court yard depot workshop garage bay`.split(/\s+/));
export function thingNameReadsAsPerson(name) {
  const s = String(name);
  if (personNameIn(s)) return true;
  const rest = s.trim().split(/\s+/).filter((w) => !PLACE_OR_THING.has(w.toLowerCase()) && !NOT_NAMES.has(w.toLowerCase()));
  return rest.length >= 2 && rest.length <= 3 && rest.every((w) => /^[A-Z][A-Za-z'’-]+$/.test(w)) && !rest.some(isJobWord);
}
export const deviceLabelNamesPerson = thingNameReadsAsPerson;
export const nameQuestion = (field, looksLike) => `${field} may hold a person's name ("${looksLike}"). A map is shared with everyone who uses this site's data, and Ospeli times steps, never people. Use a role instead (for example Doctor, Charge nurse, Pharmacy). If it is not a person's name, send the same input again with "notAName": true.`;
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
    // A step whose role nobody has said yet (a walk's "Not set") is not a change of role: nothing is known about it.
    if (i > 0 && s.role !== list[i - 1].role && s.role !== 'Not set' && list[i - 1].role !== 'Not set') handoffs++;
    if (s.msg) msgs++;
    work += +s.work || 0; wait += +s.wait || 0;
    prevStart = start; prevEnd = Math.max(end, s.par ? prevEnd : end);
    t = Math.max(t, end);
    return { id: s.id, start, end };
  });
  // A wait a person marked planned or required still counts as waiting, and is never named the longest (#141).
  const byWait = list.filter((x) => !x.plannedWait).sort((a, b) => (b.wait || 0) - (a.wait || 0));
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
      why: 'A map starts from a clear trigger and ends at a clear finish.', basis: 'Method: lean value stream mapping (Rother and Shook, Learning to See).' }];
  }
  const share = (m) => (a.elapsed ? Math.round((100 * m) / a.elapsed) : 0);
  const byWait = list.map((s, i) => ({ s, i })).sort((x, y) => (y.s.wait || 0) - (x.s.wait || 0));
  byWait.slice(0, 2).forEach(({ s, i }, k) => {
    if (!s.wait || share(s.wait) < 12) return;
    const prev = list[i - 1];
    out.push({ id: `wait-${s.id}`, kind: 'time', stepId: s.id,
      title: `${k === 0 ? 'Biggest wait' : 'Next biggest wait'}: ${fmtMinutes(s.wait)} before “${s.name}”`,
      text: `This wait is ${share(s.wait)}% of the whole process. Ask the team what it is waiting for. Could it be prepared earlier${prev ? `, before “${prev.name}” finishes` : ''}, or done in a fixed slot so others can plan around it?`,
      why: 'Calculated from the times on this map.', basis: 'Example setting, not a standard: a wait is named when it is 12% or more of start to finish.',
      tryLabel: 'Try in Proposed: halve this wait', change: { op: 'halve-wait', stepId: s.id } });
  });
  const msgSteps = list.filter((s) => s.msg && s.wait >= 15);
  if (msgSteps.length) {
    const mw = msgSteps.reduce((n, s) => n + s.wait, 0);
    out.push({ id: 'msgs', kind: 'time',
      title: `${msgSteps.length} step${msgSteps.length > 1 ? 's' : ''} only pass${msgSteps.length > 1 ? '' : 'es'} on information, after ${fmtMinutes(mw)} of waiting`,
      text: 'Calls, messages and forms that tell the next person to start. If whoever finishes a step updates its status once, everyone who needs it can see it at once, without a call.',
      why: 'Steps marked “only passes on information” on this map.', basis: 'Example setting, not a standard: counted when the wait before the step is 15 minutes or more.',
      tryLabel: 'Try in Proposed: one-tap status update', change: { op: 'status-update' } });
  }
  if (a.handoffs >= 4) {
    out.push({ id: 'handoffs', kind: 'ask', title: `${a.handoffs} handoffs between roles`,
      text: 'Each handoff is a place where work can sit in someone else’s queue. Look at neighbouring steps done by different people: could one person do both, or could the next person be told before the step ends?',
      why: 'Counted where the role changes from one step to the next. A step with no role set yet is not counted.', basis: 'Example setting, not a standard: shown at 4 handoffs or more.' });
  }
  for (let i = 1; i < list.length; i++) {
    const s = list[i]; const p = list[i - 1];
    if (!s.par && !p.par && s.role !== p.role && s.wait >= 30 && !s.msg && !p.msg) {
      out.push({ id: `par-${s.id}`, kind: 'ask', stepId: s.id, title: `Does “${s.name}” need the step before to finish?`,
        text: `If it does not, it could run at the same time as “${p.name}”. Check with both teams before changing anything.`,
        why: `Different roles, and a wait of ${fmtMinutes(s.wait)} between them.`, basis: 'Example setting, not a standard: asked when the wait between two roles is 30 minutes or more.',
        tryLabel: 'Try in Proposed: run together', change: { op: 'run-alongside', stepId: s.id } });
      break;
    }
  }
  const blank = list.filter((s) => !(+s.work) && !(+s.wait));
  if (blank.length) {
    out.push({ id: 'blank', kind: 'ask', title: `${blank.length} step${blank.length > 1 ? 's have' : ' has'} no times yet`,
      text: `Time ${blank.length > 1 ? 'them' : 'it'} on your next walk of the process, so the map shows where time really goes.`,
      why: 'Steps with no waiting or hands-on time recorded.', basis: 'Local definition: a step with no time recorded.' });
  }
  out.push({ id: 'questions', kind: 'ask', title: 'Questions to ask on your next walk',
    text: 'Who decides each step is done? What tells the next person to start? Where does the patient or item sit while it waits? Which step would you remove first, and what would stop you?',
    why: 'Standard process-walk questions; they apply to any process.', basis: 'Method: lean value stream mapping (Rother and Shook, Learning to See).' });
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
