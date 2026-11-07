// Synthetic hospital generator: "Example General Hospital".
// Entirely fictional. Seeded and reproducible: the same seed and end time always give
// exactly the same hospital and the same 30 days of events.
// Patterns (length of stay, discharge hours, turnaround times) are generic, not taken
// from any real hospital.

export const HOSPITAL_NAME = 'Example General Hospital';
export const DEFAULT_SEED = 20261106;
export const UTC_OFFSET_MINUTES = -240; // fictional local time, fixed offset, no daylight saving

// mulberry32: small, fast, good enough for synthetic data.
export function rng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    chance: (p) => next() < p,
    // Log-normal with the given median (hours or days) and spread.
    lognormal: (median, sigma) => {
      const u = Math.max(next(), 1e-9); const v = next();
      return median * Math.exp(sigma * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v));
    },
    weighted: (pairs) => { // [[value, weight], ...]
      const total = pairs.reduce((s, p) => s + p[1], 0);
      let r = next() * total;
      for (const [v, w] of pairs) { r -= w; if (r < 0) return v; }
      return pairs[pairs.length - 1][0];
    },
  };
}

const HOUR = 3600e3;
const MIN = 60e3;
const DAY = 24 * HOUR;
const pad = (n, w = 2) => String(n).padStart(w, '0');

const SITES = [
  { id: 'site-main', name: 'Main site' },
  { id: 'site-north', name: 'North health centre' },
  { id: 'site-east', name: 'East diagnostics campus' },
];
const BUILDINGS = [
  { id: 'bld-main-a', name: 'Block A (inpatients)', parentId: 'site-main' },
  { id: 'bld-main-b', name: 'Block B (emergency and theatres)', parentId: 'site-main' },
  { id: 'bld-main-plant', name: 'Energy centre', parentId: 'site-main' },
  { id: 'bld-north-1', name: 'Clinic building', parentId: 'site-north' },
  { id: 'bld-east-1', name: 'Imaging and laboratory', parentId: 'site-east' },
];
const DEPARTMENTS = [
  { id: 'dept-medicine', name: 'Medicine', parentId: 'bld-main-a' },
  { id: 'dept-surgery', name: 'Surgery', parentId: 'bld-main-a' },
  { id: 'dept-women-children', name: 'Women and children', parentId: 'bld-main-a' },
  { id: 'dept-emergency', name: 'Emergency department', parentId: 'bld-main-b' },
  { id: 'dept-theatres', name: 'Theatres', parentId: 'bld-main-b' },
  { id: 'dept-estates', name: 'Estates and facilities', parentId: 'bld-main-plant' },
  { id: 'dept-outpatients', name: 'Outpatients', parentId: 'bld-north-1' },
  { id: 'dept-primary-care', name: 'Primary care', parentId: 'bld-north-1' },
  { id: 'dept-imaging', name: 'Imaging', parentId: 'bld-east-1' },
  { id: 'dept-laboratory', name: 'Laboratory', parentId: 'bld-east-1' },
];
// Six wards, 20 beds each = 120 beds. losMedianDays and emergencyShare are generic patterns.
const WARDS = [
  { id: 'ward-a1', name: 'Ward A1 (acute medicine)', parentId: 'dept-medicine', specialty: 'Acute medicine', losMedianDays: 3.2, emergencyShare: 0.95 },
  { id: 'ward-a2', name: 'Ward A2 (general medicine)', parentId: 'dept-medicine', specialty: 'General medicine', losMedianDays: 5.5, emergencyShare: 0.9 },
  { id: 'ward-a3', name: 'Ward A3 (care of older people)', parentId: 'dept-medicine', specialty: 'Care of older people', losMedianDays: 8, emergencyShare: 0.92 },
  { id: 'ward-b1', name: 'Ward B1 (general surgery)', parentId: 'dept-surgery', specialty: 'General surgery', losMedianDays: 3, emergencyShare: 0.55 },
  { id: 'ward-b2', name: 'Ward B2 (orthopaedics)', parentId: 'dept-surgery', specialty: 'Orthopaedics', losMedianDays: 4.5, emergencyShare: 0.5 },
  { id: 'ward-c1', name: 'Ward C1 (maternity)', parentId: 'dept-women-children', specialty: 'Maternity', losMedianDays: 1.8, emergencyShare: 0.7 },
];
const BEDS_PER_WARD = 20;

const WARD_ASSETS = [
  ['infusion-pump', 'Infusion pump', 4], ['suction', 'Suction unit', 2], ['o2-flowmeter', 'Oxygen flowmeter', 4],
  ['call-bell', 'Call bell panel', 1], ['ac', 'Air-conditioning unit', 2], ['sink', 'Clinical hand-wash sink', 2],
  ['door-closer', 'Fire door closer', 2], ['light', 'Light fitting bank', 2],
];
const PLANT_ASSETS = [
  ['asset-generator-1', 'Standby generator 1', 'bld-main-plant', 'generator'],
  ['asset-generator-2', 'Standby generator 2', 'bld-main-plant', 'generator'],
  ['asset-chiller-1', 'Chiller 1', 'bld-main-plant', 'chiller'],
  ['asset-lift-a', 'Bed lift, Block A', 'bld-main-a', 'lift'],
  ['asset-lift-b', 'Bed lift, Block B', 'bld-main-b', 'lift'],
  ['asset-boiler-1', 'Steam boiler 1', 'bld-main-plant', 'boiler'],
  ['asset-xray-1', 'General X-ray room 1', 'dept-imaging', 'imaging'],
  ['asset-analyser-1', 'Chemistry analyser 1', 'dept-laboratory', 'lab'],
];
const FAULTS = {
  'infusion-pump': ['IV pump alarm', 'biomed'], suction: ['Suction unit not pulling', 'biomed'], 'o2-flowmeter': ['Oxygen flowmeter check', 'biomed'],
  'call-bell': ['Call bell not working', 'estates'], ac: ['AC filter blocked', 'estates'], sink: ['Blocked sink', 'estates'],
  'door-closer': ['Door closer broken', 'estates'], light: ['Light fitting out', 'estates'], bed: ['Bed brake faulty', 'estates'],
  generator: ['Generator test fault', 'estates'], chiller: ['Chiller high temperature', 'estates'], lift: ['Lift out of service', 'estates'],
  boiler: ['Boiler pressure low', 'estates'], imaging: ['X-ray detector error', 'biomed'], lab: ['Analyser calibration error', 'biomed'],
};

export function buildModel() {
  const entities = [];
  for (const s of SITES) entities.push({ ...s, type: 'site', ...(s.id === 'site-main' ? { hospital: HOSPITAL_NAME, utcOffsetMinutes: UTC_OFFSET_MINUTES } : {}) });
  for (const b of BUILDINGS) entities.push({ ...b, type: 'building' });
  for (const d of DEPARTMENTS) entities.push({ ...d, type: 'department' });
  for (const w of WARDS) {
    entities.push({ ...w, type: 'ward', beds: BEDS_PER_WARD });
    for (let i = 1; i <= BEDS_PER_WARD; i++) {
      entities.push({ id: `${w.id}-bed-${pad(i)}`, type: 'bed', name: `Bed ${pad(i)}`, parentId: w.id, sideRoom: i > 16 });
    }
    for (const [kind, label, n] of WARD_ASSETS) {
      for (let i = 1; i <= n; i++) {
        entities.push({ id: `asset-${w.id.slice(5)}-${kind}-${i}`, type: 'asset', name: `${label} ${i}`, parentId: w.id, kind });
      }
    }
  }
  for (const [id, name, parentId, kind] of PLANT_ASSETS) entities.push({ id, type: 'asset', name, parentId, kind });
  for (const r of [['ward-nurse', 'Ward nurse'], ['bed-manager', 'Bed manager'], ['estates-tech', 'Estates tech'], ['ae-nic', 'A&E nurse in charge'], ['ops-manager', 'Ops manager'], ['coo', 'COO']]) {
    entities.push({ id: `role-${r[0]}`, type: 'role', name: r[1], roleId: r[0] });
  }
  entities.push({ id: 'shift-day', type: 'shift', name: 'Day shift', start: '07:00', end: '19:00' });
  entities.push({ id: 'shift-night', type: 'shift', name: 'Night shift', start: '19:00', end: '07:00' });
  return entities;
}

// Snap a time to a given local hour on the same local day (plus random minutes).
const atLocalHour = (t, hour, r) => {
  const local = t + UTC_OFFSET_MINUTES * MIN;
  const dayStart = local - (local % DAY);
  return dayStart + hour * HOUR + r.int(0, 59) * MIN - UTC_OFFSET_MINUTES * MIN;
};

// Discharge hours lean to the afternoon, with a small morning share (a common pattern).
const DISCHARGE_HOURS = [[8, 1], [9, 2], [10, 4], [11, 6], [12, 8], [13, 10], [14, 12], [15, 12], [16, 11], [17, 9], [18, 6], [19, 4], [20, 2], [21, 1]];

export function generateHospital({ seed = DEFAULT_SEED, end, days = 30 } = {}) {
  if (end == null) throw new Error('end time is required so output is reproducible');
  const endMs = new Date(end).getTime();
  const startMs = endMs - days * DAY;
  const r = rng(seed);
  const entities = buildModel();
  const raw = [];
  let enc = 0;
  let wo = 0;
  const iso = (t) => new Date(Math.round(t / 1000) * 1000).toISOString();
  // Only events inside the window are kept, except the admissions of patients already in a bed at the start.
  const push = (t, type, subject, actorRole, data, early = false) => { if (t <= endMs && (t >= startMs || early)) raw.push({ t, type, subject, actorRole, data }); };

  // Emergency department journey up to the decision (and departure if not admitted).
  const aeJourney = (encId, decisionAt, admitted) => {
    const seenToDecision = r.lognormal(1.2, 0.5) * HOUR;
    const triageToSeen = r.lognormal(0.9, 0.6) * HOUR;
    const arrivalToTriage = r.lognormal(12, 0.6) * MIN;
    const seen = decisionAt - seenToDecision;
    const triaged = seen - triageToSeen;
    const arrived = triaged - arrivalToTriage;
    const acuity = r.weighted([[1, 1], [2, 12], [3, 45], [4, 30], [5, 12]]);
    push(arrived, 'ae.arrived', encId, 'ae-nic', { mode: r.chance(0.2) ? 'ambulance' : 'walk-in' });
    push(triaged, 'ae.triaged', encId, 'ae-nic', { acuity });
    push(seen, 'ae.seen', encId, 'ae-nic', null);
    push(decisionAt, admitted ? 'ae.decision-to-admit' : 'ae.decision-to-discharge', encId, 'ae-nic', null);
  };

  // Inpatient flow: each bed cycles through occupied -> vacated -> cleaned -> idle -> occupied.
  for (const w of WARDS) {
    for (let i = 1; i <= BEDS_PER_WARD; i++) {
      const bedId = `${w.id}-bed-${pad(i)}`;
      // Start-of-window state: most beds already occupied by someone admitted earlier.
      let t;
      if (r.chance(0.88)) {
        const encId = `enc-${pad(++enc, 6)}`;
        const admittedAt = startMs - r.next() * w.losMedianDays * DAY;
        push(admittedAt, 'patient.admitted', encId, 'ward-nurse', { bedId, wardId: w.id, route: 'emergency' }, true);
        t = dischargeCycle(encId, admittedAt, startMs + HOUR);
      } else {
        t = startMs + (8 + r.next() * 10) * HOUR;
      }
      while (t < endMs) {
        const encId = `enc-${pad(++enc, 6)}`;
        const emergency = r.chance(w.emergencyShare);
        let admittedAt;
        if (emergency) {
          const decisionToBed = r.lognormal(3, 0.7) * HOUR;
          admittedAt = t;
          const decision = admittedAt - decisionToBed;
          aeJourney(encId, decision, true);
          const requested = decision + Math.min(r.lognormal(25, 0.5) * MIN, decisionToBed / 3);
          push(requested, 'bed.requested', encId, 'ae-nic', { wardId: w.id });
          push(Math.max(requested + 5 * MIN, admittedAt - r.lognormal(40, 0.5) * MIN), 'bed.allocated', bedId, 'bed-manager', { encounter: encId });
        } else {
          admittedAt = atLocalHour(t + r.lognormal(4, 0.5) * HOUR, r.int(8, 14), r);
          if (admittedAt < t) admittedAt = t + r.int(30, 180) * MIN;
          push(admittedAt - r.int(30, 120) * MIN, 'bed.allocated', bedId, 'bed-manager', { encounter: encId });
        }
        push(admittedAt, 'patient.admitted', encId, 'ward-nurse', { bedId, wardId: w.id, route: emergency ? 'emergency' : 'elective' });
        t = dischargeCycle(encId, admittedAt);
      }

      function dischargeCycle(encId, admittedAt, notBefore = 0) {
        const los = Math.max(0.3, r.lognormal(w.losMedianDays, 0.6)) * DAY;
        let dischargeAt = atLocalHour(Math.max(admittedAt + los, notBefore + r.next() * 2 * DAY), r.weighted(DISCHARGE_HOURS), r);
        if (dischargeAt < notBefore) dischargeAt += DAY;
        if (dischargeAt <= admittedAt + 4 * HOUR) dischargeAt = admittedAt + 4 * HOUR + r.int(0, 120) * MIN;
        if (dischargeAt > endMs) {
          // Still in the bed at the end of the window. Some are already flagged to go home soon.
          if (dischargeAt < endMs + 30 * HOUR && r.chance(0.6)) {
            const flagAt = dischargeAt - r.lognormal(18, 0.4) * HOUR;
            if (flagAt > admittedAt) push(flagAt, 'patient.expected-discharge', encId, 'ward-nurse', { bedId, expectedAt: iso(dischargeAt) });
          }
          return endMs + 1;
        }
        if (r.chance(0.6)) push(dischargeAt - r.lognormal(18, 0.4) * HOUR, 'patient.expected-discharge', encId, 'ward-nurse', { bedId, expectedAt: iso(dischargeAt) });
        push(dischargeAt, 'patient.discharged', encId, 'ward-nurse', { bedId, wardId: w.id });
        push(dischargeAt + r.int(1, 15) * MIN, 'bed.vacated', bedId, 'ward-nurse', { encounter: encId });
        const cleanStart = dischargeAt + r.lognormal(35, 0.6) * MIN;
        const cleanDone = cleanStart + r.lognormal(40, 0.35) * MIN;
        push(cleanStart, 'bed.clean-started', bedId, 'ward-nurse', null);
        push(cleanDone, 'bed.cleaned', bedId, 'ward-nurse', null);
        return cleanDone + r.lognormal(2.5, 0.9) * HOUR; // idle until the next patient
      }
    }
  }

  // A&E attendances that go home (more than are admitted).
  for (let day = 0; day < days; day++) {
    const n = r.int(55, 80);
    for (let k = 0; k < n; k++) {
      const encId = `enc-${pad(++enc, 6)}`;
      const dayStart = startMs + day * DAY;
      const hour = r.weighted([[0, 2], [2, 1], [4, 1], [6, 2], [8, 6], [10, 9], [12, 9], [14, 8], [16, 8], [18, 7], [20, 5], [22, 3]]);
      const decision = dayStart + (hour + r.next() * 2) * HOUR + 3 * HOUR;
      aeJourney(encId, decision, false);
      push(decision + r.lognormal(20, 0.6) * MIN, 'ae.departed', encId, 'ae-nic', null);
    }
  }

  // Engineering: faults, work orders and fixes.
  const assets = entities.filter((e) => e.type === 'asset');
  for (let day = 0; day < days; day++) {
    const n = r.int(2, 6);
    for (let k = 0; k < n; k++) {
      const asset = r.pick(assets);
      const [title, trade] = FAULTS[asset.kind];
      const priority = r.weighted([['urgent', 2], ['high', 4], ['routine', 10]]);
      const reported = startMs + day * DAY + (7 + r.next() * 13) * HOUR;
      const woId = `wo-${pad(++wo, 5)}`;
      const reporter = asset.parentId.startsWith('ward-') ? 'ward-nurse' : 'estates-tech';
      push(reported, 'asset.fault-reported', asset.id, reporter, { workOrder: woId, title, trade, priority });
      const respondH = { urgent: 0.5, high: 2, routine: 8 }[priority];
      const assigned = reported + r.lognormal(respondH, 0.6) * HOUR;
      push(assigned, 'workorder.assigned', woId, 'estates-tech', { asset: asset.id, trade });
      const fixH = { urgent: 2, high: 6, routine: 30 }[priority];
      const done = assigned + r.lognormal(fixH, 0.8) * HOUR;
      push(done, 'workorder.completed', woId, 'estates-tech', { asset: asset.id, outcome: r.chance(0.9) ? 'fixed' : 'escalated' });
    }
  }

  // A few A&E patients decided for admission in the last hours, still waiting for a bed.
  const waitingNow = r.int(3, 6);
  for (let k = 0; k < waitingNow; k++) {
    const encId = `enc-${pad(++enc, 6)}`;
    const w = r.weighted(WARDS.map((x) => [x, x.emergencyShare]));
    const decision = endMs - Math.min(6, r.lognormal(1.5, 0.7)) * HOUR;
    aeJourney(encId, decision, true);
    push(Math.min(endMs, decision + r.lognormal(20, 0.5) * MIN), 'bed.requested', encId, 'ae-nic', { wardId: w.id });
  }

  raw.sort((a, b) => a.t - b.t || (a.type < b.type ? -1 : a.type > b.type ? 1 : 0) || (a.subject < b.subject ? -1 : 1));
  const events = raw.map((e) => ({ type: e.type, subject: e.subject, actorRole: e.actorRole, at: iso(e.t), data: e.data ?? null }));
  return { entities, events, meta: { seed, end: iso(endMs), days, hospital: HOSPITAL_NAME } };
}

// Load the synthetic hospital into a (normally empty) core.
export async function loadSyntheticHospital(core, { seed = DEFAULT_SEED, end, days = 30 } = {}) {
  const { entities, events, meta } = generateHospital({ seed, end, days });
  // Mark setup as unfinished until every event is stored, so a reload mid-way is detected
  // and setup starts again on the next boot (issue #1).
  await core.setMeta('setup', 'started');
  await core.putEntities(entities, 'system', `${HOSPITAL_NAME}, seed ${seed}`);
  await core.appendEvents(events, 'system', `${days} days of synthetic events, seed ${seed}`);
  await core.setMeta('synthetic', true);
  await core.setMeta('generator', meta);
  await core.setMeta('setup', 'done');
  return { entities: entities.length, events: events.length, meta };
}

// True when a synthetic setup on this device was interrupted (reload, tab closed, app killed)
// and must be run again. Also catches devices left with beds but no events by older builds.
export async function setupUnfinished(core) {
  const setup = await core.getMeta('setup');
  if (setup === 'started') return true;
  if (setup === 'done') return false;
  const sites = await core.listEntities('site');
  return sites.length > 0 && !(await core.getMeta('generator')) && (await core.eventCount()) === 0;
}

// The default "end" for a new device: the start of the current hour, so the data looks current.
export const currentHour = (now = Date.now()) => new Date(now - (now % HOUR)).toISOString();
