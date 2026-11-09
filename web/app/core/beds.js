// Bed state (foundation section 5.3: live state boards), derived only from the event log.
// Pure functions: (beds, events, now) -> state. Nothing about a bed is stored except events,
// so the board, the KPIs and an auditor all read the same record.

export const BED_STATES = {
  occupied: { name: 'Occupied', short: 'Occupied' },
  'expected-discharge': { name: 'Expected discharge', short: 'Going home' },
  vacated: { name: 'Vacated, to clean', short: 'To clean' },
  cleaning: { name: 'Cleaning', short: 'Cleaning' },
  available: { name: 'Available', short: 'Available' },
  allocated: { name: 'Allocated', short: 'Allocated' },
  'out-of-service': { name: 'Out of service', short: 'Out of service' },
};

export const OUT_OF_SERVICE_REASONS = ['Equipment fault', 'Plumbing or leak', 'Electrical', 'Bed frame or mattress', 'Infection control clean', 'Other'];

const ms = (iso) => Date.parse(iso);

// A bed "holds" a patient when someone is in it or it is held for someone.
const HOLDS = new Set(['occupied', 'expected-discharge', 'allocated']);

// Replay the event log. Returns { beds: Map(bedId -> state), waiting: [...], conflicts: [...] }.
// A bed state is { id, state, since, encounter, expectedAt, reason }.
// An event that would push a patient out of a bed without a discharge (for example taking an
// occupied bed out of service, issue #9) is not applied; it is listed in `conflicts` so an
// auditor can see it, and the board stays in step with the occupancy KPI.
export function deriveBoard(bedEntities, events) {
  const beds = new Map(bedEntities.map((b) => [b.id, { id: b.id, state: 'available', since: null, encounter: null, expectedAt: null, reason: null }]));
  const encounterBed = new Map(); // encounter -> bed it is in or allocated to
  const requests = new Map(); // encounter -> { encounter, wardId, requestedAt, decisionAt }
  const decisions = new Map(); // encounter -> decision-to-admit time
  const conflicts = [];
  const set = (id, state, at, extra = {}) => {
    const b = beds.get(id);
    if (!b) return null;
    Object.assign(b, { state, since: at, reason: null }, extra);
    return b;
  };
  // True (and recorded) when the event would overwrite a bed that holds someone else.
  const clash = (e, bedId, encounter = null) => {
    const b = beds.get(bedId);
    if (!b) return false;
    const blocked = (HOLDS.has(b.state) && b.encounter !== encounter) || (encounter && b.state === 'out-of-service');
    if (blocked) conflicts.push({ seq: e.seq ?? null, type: e.type, bedId, at: e.at, actorRole: e.actorRole, reason: `bed was ${b.state}` });
    return blocked;
  };

  for (const e of events) {
    const d = e.data || {};
    switch (e.type) {
      case 'ae.decision-to-admit': decisions.set(e.subject, e.at); break;
      case 'bed.requested':
        requests.set(e.subject, { encounter: e.subject, wardId: d.wardId ?? null, requestedAt: e.at, decisionAt: decisions.get(e.subject) ?? e.at });
        break;
      case 'bed.allocated': {
        if (clash(e, e.subject, d.encounter ?? null)) break;
        const prev = encounterBed.get(d.encounter);
        if (prev && prev !== e.subject && beds.get(prev)?.state === 'allocated') set(prev, 'available', e.at, { encounter: null });
        if (set(e.subject, 'allocated', e.at, { encounter: d.encounter ?? null, expectedAt: null })) encounterBed.set(d.encounter, e.subject);
        break;
      }
      case 'bed.allocation-cancelled': {
        const b = beds.get(e.subject);
        if (b && b.state === 'allocated') {
          encounterBed.delete(b.encounter);
          set(e.subject, 'available', e.at, { encounter: null });
        }
        break;
      }
      case 'patient.admitted':
        if (clash(e, d.bedId, e.subject)) break;
        if (set(d.bedId, 'occupied', e.at, { encounter: e.subject, expectedAt: null })) encounterBed.set(e.subject, d.bedId);
        requests.delete(e.subject);
        break;
      case 'patient.expected-discharge': {
        const b = beds.get(d.bedId);
        if (b && b.encounter === e.subject && (b.state === 'occupied' || b.state === 'expected-discharge')) {
          set(d.bedId, 'expected-discharge', b.state === 'occupied' ? e.at : b.since, { expectedAt: d.expectedAt ?? null });
        }
        break;
      }
      case 'patient.expected-discharge-cancelled': {
        const b = beds.get(d.bedId);
        if (b && b.state === 'expected-discharge' && b.encounter === e.subject) set(d.bedId, 'occupied', e.at, { expectedAt: null });
        break;
      }
      case 'patient.discharged':
        encounterBed.delete(e.subject);
        if (beds.get(d.bedId)?.encounter === e.subject) set(d.bedId, 'vacated', e.at, { encounter: null, expectedAt: null });
        break;
      case 'bed.vacated': {
        const b = beds.get(e.subject);
        if (b && b.state !== 'vacated') set(e.subject, 'vacated', e.at, { encounter: null, expectedAt: null });
        break;
      }
      // A bed can be allocated while it is still being cleaned: it stays held for that patient.
      case 'bed.clean-started':
        if (beds.get(e.subject)?.state !== 'allocated' && !clash(e, e.subject)) set(e.subject, 'cleaning', e.at);
        break;
      case 'bed.cleaned':
        if (beds.get(e.subject)?.state !== 'allocated' && !clash(e, e.subject)) set(e.subject, 'available', e.at);
        break;
      case 'bed.out-of-service':
        if (!clash(e, e.subject)) set(e.subject, 'out-of-service', e.at, { encounter: null, expectedAt: null, reason: d.reason ?? null });
        break;
      case 'bed.back-in-service': if (beds.get(e.subject)?.state === 'out-of-service') set(e.subject, 'available', e.at); break;
      default: break;
    }
  }

  // Waiting for a bed: requested, not yet admitted. Allocated ones show which bed is held.
  const waiting = [...requests.values()]
    .map((r) => ({ ...r, allocatedBed: beds.get(encounterBed.get(r.encounter))?.state === 'allocated' ? encounterBed.get(r.encounter) : null }))
    .sort((a, b) => (a.decisionAt < b.decisionAt ? -1 : 1));
  return { beds, waiting, conflicts };
}

// Counts per state for a set of bed states.
export function countStates(states) {
  const c = Object.fromEntries(Object.keys(BED_STATES).map((k) => [k, 0]));
  for (const s of states) c[s.state]++;
  return c;
}

// What a person can do next with a bed in each state. Each action becomes event(s).
// People decide, Ospeli suggests: every change is a tap by a named role, logged.
export function bedActions(bed) {
  switch (bed.state) {
    case 'occupied': return ['expect-discharge', 'vacate'];
    case 'expected-discharge': return ['vacate', 'cancel-expected'];
    case 'vacated': return ['start-clean', 'finish-clean'];
    case 'cleaning': return ['finish-clean'];
    case 'available': return ['allocate', 'out-of-service'];
    case 'allocated': return ['admit', 'cancel-allocation'];
    case 'out-of-service': return ['back-in-service'];
    default: return [];
  }
}

export const ACTION_LABELS = {
  'expect-discharge': 'Flag expected discharge today',
  vacate: 'Patient has left: bed to clean',
  'cancel-expected': 'Cancel expected discharge',
  'start-clean': 'Cleaning started',
  'finish-clean': 'Clean finished: bed ready',
  allocate: 'Allocate to a waiting patient',
  'out-of-service': 'Take out of service',
  admit: 'Patient has arrived in the bed',
  'cancel-allocation': 'Cancel allocation',
  'back-in-service': 'Back in service',
};

// Turn an action into the events to append. `opts` carries the reason or the encounter.
export function actionEvents(action, bed, wardId, role, at, opts = {}) {
  const ev = (type, subject, data = null) => ({ type, subject, actorRole: role, at, data });
  switch (action) {
    case 'expect-discharge': {
      const exp = opts.expectedAt ?? at;
      return [ev('patient.expected-discharge', bed.encounter, { bedId: bed.id, expectedAt: exp })];
    }
    case 'cancel-expected': return [ev('patient.expected-discharge-cancelled', bed.encounter, { bedId: bed.id })];
    case 'vacate': return [
      ev('patient.discharged', bed.encounter, { bedId: bed.id, wardId }),
      ev('bed.vacated', bed.id, { encounter: bed.encounter }),
    ];
    case 'start-clean': return [ev('bed.clean-started', bed.id)];
    case 'finish-clean': return bed.state === 'vacated'
      ? [ev('bed.clean-started', bed.id), ev('bed.cleaned', bed.id)]
      : [ev('bed.cleaned', bed.id)];
    case 'allocate':
      if (!opts.encounter) throw new Error('allocate needs an encounter');
      return [ev('bed.allocated', bed.id, { encounter: opts.encounter })];
    case 'cancel-allocation': return [ev('bed.allocation-cancelled', bed.id, { encounter: bed.encounter })];
    case 'admit': return [ev('patient.admitted', bed.encounter, { bedId: bed.id, wardId, route: 'emergency' })];
    case 'out-of-service':
      if (!opts.reason) throw new Error('a reason is required');
      return [ev('bed.out-of-service', bed.id, { reason: opts.reason })];
    case 'back-in-service': return [ev('bed.back-in-service', bed.id)];
    default: throw new Error(`unknown action ${action}`);
  }
}

// Short human duration: "35 min", "3 h 05 min", "2 d 4 h".
export function since(iso, now) {
  if (!iso) return '';
  const m = Math.max(0, Math.round((now - ms(iso)) / 60000));
  if (m < 60) return `${m} min`;
  const hrs = Math.floor(m / 60);
  if (hrs < 48) return `${hrs} h ${String(m % 60).padStart(2, '0')} min`;
  return `${Math.floor(hrs / 24)} d ${hrs % 24} h`;
}

// A short, non-identifying reference for a synthetic encounter id: "enc-004512" -> "Patient 4512".
export const encounterLabel = (enc) => (enc ? `Patient ${String(enc).replace(/^enc-0*/, '')}` : '');
