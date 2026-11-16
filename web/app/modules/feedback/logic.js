// Patient feedback: pure functions. Derive each feedback record from the event log, work out its
// due dates, the four KPIs, the themes board and the guide's fixed rules. No screen code, no
// storage and no clock: every caller passes `now` in.
//
// A record is a complaint, a concern, a compliment or a feedback card. It holds no personal
// details: the person is the record's reference code, the owner is a role, and the optional note
// was checked before it was kept (commands.js). Measures are of the service and the process,
// never of a person.

import { median, DAY, MIN } from '../../core/kit.js';
import { roleById } from '../../core/model.js';

export const EVENT = {
  logged: 'feedback.logged',
  acknowledged: 'feedback.acknowledged',
  ownerSet: 'feedback.owner-set',
  replied: 'feedback.replied',
  closed: 'feedback.closed',
  clinical: 'feedback.clinical-review',
  clinicalReturned: 'feedback.clinical-review-returned',
  shared: 'feedback.shared',
  actionAgreed: 'feedback.action-agreed',
  actionClosed: 'feedback.action-closed',
};

export const RECORD_ID_PATTERN = '^fb-[0-9]{5}$';
export const ACTION_ID_PATTERN = '^fb-[0-9]{5}-a[0-9]{1,2}$';
export const NOTE_MAX = 140;

export const KINDS = {
  complaint: { name: 'Complaint', timed: true },
  concern: { name: 'Concern', timed: true },
  compliment: { name: 'Compliment', timed: false },
  card: { name: 'Feedback card', timed: false },
};
// How it reached the service. "card" is only for the hand-over feedback card.
export const CHANNELS = {
  'in-person': 'In person', phone: 'Phone', letter: 'Letter', email: 'Email', 'online-form': 'Online form', card: 'Feedback card', other: 'Other',
};
export const STAFF_CHANNELS = Object.keys(CHANNELS).filter((c) => c !== 'card');
// How the site acknowledged or replied. Ospeli records that it happened; it sends nothing.
export const REPLY_CHANNELS = { letter: 'Letter', email: 'Email', phone: 'Phone call', meeting: 'Meeting in person' };

// Themes describe a service or a process, never a person. "staff attitude" is the attitude met in
// the service as a whole; no member of staff is named, scored or ranked. `card` is the patient's word.
export const THEMES = {
  waiting: { name: 'Waiting', card: 'Waiting' },
  communication: { name: 'Information and communication', card: 'Being kept informed' },
  environment: { name: 'Environment and cleanliness', card: 'Cleanliness and comfort' },
  access: { name: 'Access and booking', card: 'Getting an appointment' },
  food: { name: 'Food and drink', card: 'Food and drink' },
  billing: { name: 'Billing and paperwork', card: 'Bills and forms' },
  attitude: { name: 'Staff attitude (the service, never a person)', card: 'How we treated you' },
  other: { name: 'Other', card: 'Something else' },
};
export const FACES = [[1, 'Very poor'], [2, 'Poor'], [3, 'OK'], [4, 'Good'], [5, 'Very good']];

// Stages for a complaint or concern, after the handling steps ISO 10002 describes, in plain words.
// A compliment or card is recorded, and can be shared with the service.
export const STAGES = {
  received: 'Received', acknowledged: 'Acknowledged', replied: 'Replied', closed: 'Closed', recorded: 'Recorded', shared: 'Shared with the service',
};
export const TIMED_STAGES = ['received', 'acknowledged', 'replied', 'closed'];
export const OUTCOMES = { resolved: 'Resolved', 'partly-resolved': 'Partly resolved', 'not-resolved': 'Not resolved', withdrawn: 'Withdrawn by the person' };
export const ACTION_KINDS = {
  'process-change': 'Change how something is done',
  information: 'Improve information or signs',
  environment: 'Fix something in the building or room',
  'team-learning': 'Share the learning with the team',
  review: 'Review it with the service',
  other: 'Other',
};
export const OWNER_ROLES = ['patient-liaison', 'ward-nurse', 'quality-lead', 'ops-manager'];
// In this module the role "ward-nurse" stands for whoever leads the ward or department the
// feedback is about. A display label only: the role id and the core's role name do not change.
const ROLE_LABELS = { 'ward-nurse': 'Ward or department lead' };
export const roleLabel = (id) => ROLE_LABELS[id] || roleById(id)?.name || id;
// Whose a record is: the role, and the service it is about.
export const ownerText = (role, serviceName) => (role ? `${roleLabel(role)} · ${serviceName}` : null);
export const DUE_IN_DAYS = [7, 14, 30, 60, 90];

// The due dates, in one place. Example settings, set locally, not a standard: ISO 10002 names the
// handling steps, not the number of days.
export const SETTINGS = {
  ackWorkingDays: 2,
  replyWorkingDays: 10,
  remindDaysBefore: 3,
  basis: 'Example settings, set locally, not a standard. ISO 10002 names the handling steps, not the number of days.',
};
export const settingsText = (s = SETTINGS) => `Acknowledge within ${s.ackWorkingDays} working days, reply within ${s.replyWorkingDays} working days (Monday to Friday). ${s.basis}`;

// Add working days (Monday to Friday, site local time), keeping the time of day.
export function addWorkingDays(iso, n, offsetMinutes = 0) {
  let t = Date.parse(iso);
  for (let added = 0; added < n;) {
    t += DAY;
    const wd = new Date(t + offsetMinutes * MIN).getUTCDay();
    if (wd !== 0 && wd !== 6) added += 1;
  }
  return new Date(t).toISOString();
}
const days = (a, b) => (Date.parse(b) - Date.parse(a)) / DAY;
const round1 = (x) => (x == null ? null : Math.round(x * 10) / 10);
export const nextRecordId = (events) => {
  let max = 0;
  for (const e of events) if (e.type === EVENT.logged) { const n = Number(String(e.subject).slice(3)); if (n > max) max = n; }
  return `fb-${String(max + 1).padStart(5, '0')}`;
};

// Every record from the event log. Events for a record that was never logged are ignored.
export function deriveRecords(events, { offsetMinutes = 0, settings = SETTINGS } = {}) {
  const map = new Map();
  for (const e of events) {
    if (!e.type.startsWith('feedback.')) continue;
    if (e.type === EVENT.logged) {
      const d = e.data || {};
      const timed = !!KINDS[d.kind]?.timed;
      const receivedAt = d.receivedAt || e.at;
      map.set(e.subject, {
        id: e.subject, kind: d.kind, channel: d.channel, serviceId: d.serviceId, theme: d.theme ?? null, rating: d.rating ?? null,
        note: d.note ?? null, clinical: false, clinicalAt: null, clinicalPeriods: [], ownerRole: timed ? (d.ownerRole || 'patient-liaison') : null,
        receivedAt, loggedAt: e.at, loggedByRole: e.actorRole,
        acknowledgedAt: null, ackChannel: null, repliedAt: null, replyChannel: null, closedAt: null, outcome: null, sharedAt: null,
        stage: timed ? 'received' : 'recorded',
        ackDueAt: timed ? addWorkingDays(receivedAt, settings.ackWorkingDays, offsetMinutes) : null,
        replyDueAt: timed ? addWorkingDays(receivedAt, settings.replyWorkingDays, offsetMinutes) : null,
        actions: [], timeline: [{ step: 'received', at: receivedAt, role: e.actorRole, channel: d.channel }],
      });
      continue;
    }
    const r = map.get(e.subject);
    if (!r) continue;
    const d = e.data || {};
    const line = (step, extra = {}) => r.timeline.push({ step, at: e.at, role: e.actorRole, ...extra });
    if (e.type === EVENT.acknowledged) { r.acknowledgedAt = e.at; r.ackChannel = d.channel ?? null; r.stage = 'acknowledged'; line('acknowledged', { channel: d.channel }); }
    else if (e.type === EVENT.replied) { r.repliedAt = e.at; r.replyChannel = d.channel ?? null; r.stage = 'replied'; line('replied', { channel: d.channel }); }
    else if (e.type === EVENT.closed) { r.closedAt = e.at; r.outcome = d.outcome ?? null; r.stage = 'closed'; line('closed', { outcome: d.outcome }); }
    else if (e.type === EVENT.ownerSet) { r.ownerRole = d.ownerRole; line('owner-set', { ownerRole: d.ownerRole }); }
    else if (e.type === EVENT.clinical && !r.clinical) { r.clinical = true; r.clinicalAt = e.at; r.clinicalPeriods.push({ from: e.at, to: null }); line('clinical-review'); }
    else if (e.type === EVENT.clinicalReturned && r.clinical) { r.clinical = false; r.clinicalAt = null; r.clinicalPeriods.at(-1).to = e.at; line('clinical-review-returned'); }
    else if (e.type === EVENT.shared) { r.sharedAt = e.at; r.stage = 'shared'; line('shared'); }
    else if (e.type === EVENT.actionAgreed) {
      r.actions.push({ id: d.actionId, what: d.what, ownerRole: d.ownerRole, dueAt: d.dueAt, note: d.note ?? null, agreedAt: e.at, agreedByRole: e.actorRole, closedAt: null, closedByRole: null });
      line('action-agreed', { actionId: d.actionId });
    } else if (e.type === EVENT.actionClosed) {
      const a = r.actions.find((x) => x.id === d.actionId);
      if (a && !a.closedAt) { a.closedAt = e.at; a.closedByRole = e.actorRole; line('action-closed', { actionId: d.actionId }); }
    }
  }
  return map;
}

export const isTimed = (r) => !!KINDS[r.kind]?.timed;
export const isOpen = (r) => isTimed(r) && r.stage !== 'closed';

// Was the record with clinical review at this moment?
export const withClinicalAt = (r, iso) => r.clinicalPeriods.some((p) => p.from <= iso && (!p.to || p.to > iso));

// Where a record stands against its due dates at `now`. Clinical review does not take a complaint
// out of the complaints process: the acknowledgement is timed as usual. Only the reply waits: while
// the record is with clinical review its reply is not called overdue here and the guide does not chase it.
export function timing(r, now, settings = SETTINGS) {
  if (!isTimed(r)) return { timed: false, overdue: false, ackOverdue: false, replyOverdue: false, dueSoon: false, daysToReplyDue: null, ackLate: false, replyLate: false };
  const ackLate = r.acknowledgedAt ? r.acknowledgedAt > r.ackDueAt : now > r.ackDueAt;
  const replyLate = r.repliedAt ? r.repliedAt > r.replyDueAt : now > r.replyDueAt;
  const open = r.stage !== 'closed';
  const toDue = days(now, r.replyDueAt);
  const waitingReply = open && !r.repliedAt && r.outcome !== 'withdrawn';
  const ackOverdue = open && !r.acknowledgedAt && now > r.ackDueAt;
  const replyOverdue = waitingReply && !r.clinical && now > r.replyDueAt;
  const overdue = ackOverdue || replyOverdue;
  return {
    timed: true, overdue, ackOverdue, replyOverdue, ackLate, replyLate,
    dueSoon: waitingReply && !r.clinical && !overdue && toDue <= settings.remindDaysBefore,
    daysToReplyDue: waitingReply ? round1(toDue) : null,
  };
}

// The queue order: overdue first, then the nearest reply due date. A record with clinical review
// keeps its place by its due date.
export function sortQueue(list, now) {
  const key = (r) => {
    const t = timing(r, now);
    return [t.overdue ? 0 : 1, r.repliedAt ? Infinity : Date.parse(r.replyDueAt), Date.parse(r.receivedAt)];
  };
  return [...list].sort((a, b) => {
    const ka = key(a); const kb = key(b);
    for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i] < kb[i] ? -1 : 1;
    return a.id < b.id ? -1 : 1;
  });
}

// ---- KPIs ----
// Each is (events, { since, until, now, offsetMinutes }) -> { value, numerator, denominator }.
// For a median, numerator is null and denominator is how many complaints the median is of.
// leftOut counts what the definition leaves out, by reason, so the screen can say it beside the number.
//
// Clinical review and the reply measures: a complaint is left out of response time and responses on
// time only if it was with clinical review at its deciding moment: when the reply was sent, if that
// was by the reply due date; otherwise at the reply due date. So a complaint passed to clinical review
// after its due date had passed still counts as late, and nothing changes in a past period.
export const replyDecidedAt = (r) => (r.repliedAt && r.repliedAt <= r.replyDueAt ? r.repliedAt : r.replyDueAt);
const CLINICAL_RULE = 'A complaint is left out if it was with clinical review at its deciding moment: when the reply was sent, if that was by the reply due date; otherwise at the reply due date. A complaint passed to clinical review after its due date counts as late.';
const NOT_COMPLAINTS = 'Concerns, compliments and cards are left out.';
export const KPIS = [
  {
    id: 'feedback-ack-time', name: 'Acknowledgement time', unit: 'calendar days', decimals: 1,
    definition: 'Median calendar days from a complaint being received to the site acknowledging it, for complaints acknowledged in the period. Complaints with clinical review count as usual.',
    counts: 'Calendar days from received to acknowledged, for each complaint acknowledged in the period.', outOf: 'Complaints acknowledged in the period.',
    leavesOut: NOT_COMPLAINTS, source: 'local definition', target: null,
    targetText: `No target. The acknowledgement due date (${SETTINGS.ackWorkingDays} working days) is an example setting, not a standard.`,
  },
  {
    id: 'feedback-response-time', name: 'Response time', unit: 'calendar days', decimals: 1,
    definition: 'Median calendar days from a complaint being received to the full reply being sent, for complaints replied to in the period.',
    counts: 'Calendar days from received to replied, for each complaint replied to in the period.', outOf: 'Complaints replied to in the period.',
    leavesOut: `${CLINICAL_RULE} ${NOT_COMPLAINTS}`, source: 'local definition', target: null,
    targetText: `No target. The reply due date (${SETTINGS.replyWorkingDays} working days) is an example setting, not a standard.`,
  },
  {
    id: 'feedback-responses-on-time', name: 'Responses on time', unit: '%', decimals: 0,
    definition: 'Complaints replied to by their reply due date, out of complaints whose reply fell due in the period (up to now).',
    counts: 'Complaints replied to on or before the reply due date.', outOf: 'Complaints whose reply due date is in the period and has passed.',
    leavesOut: `${CLINICAL_RULE} Complaints withdrawn before a reply are left out. ${NOT_COMPLAINTS}`, source: 'local definition', target: null,
    targetText: `No target. The due date (${SETTINGS.replyWorkingDays} working days) is an example setting, not a standard.`,
  },
  {
    id: 'feedback-actions-closed', name: 'Actions closed on time', unit: '%', decimals: 0,
    definition: 'Actions agreed on a complaint or concern and closed by their due date, out of those actions that fell due in the period (up to now).',
    counts: 'Actions closed on or before their due date.', outOf: 'Actions on complaints and concerns whose due date is in the period and has passed.',
    leavesOut: 'Actions not yet due. The due date of each action is the one the person agreeing it chose.', source: 'local definition', target: null,
    targetText: 'No target set. A site may set one locally.',
  },
];
export const kpiById = (id) => KPIS.find((k) => k.id === id) || null;

const complaints = (events, opts) => [...deriveRecords(events, opts).values()].filter((r) => r.kind === 'complaint');
const inPeriod = (iso, since, until) => !!iso && (!since || iso >= since) && (!until || iso < until);
const atClinical = (r) => withClinicalAt(r, replyDecidedAt(r));

export function kpiAckTime(events, { since, until, offsetMinutes } = {}) {
  const xs = complaints(events, { offsetMinutes }).filter((r) => inPeriod(r.acknowledgedAt, since, until)).map((r) => days(r.receivedAt, r.acknowledgedAt));
  return { value: round1(median(xs)), numerator: null, denominator: xs.length, leftOut: {} };
}
export function kpiResponseTime(events, { since, until, offsetMinutes } = {}) {
  const replied = complaints(events, { offsetMinutes }).filter((r) => inPeriod(r.repliedAt, since, until));
  const xs = replied.filter((r) => !atClinical(r)).map((r) => days(r.receivedAt, r.repliedAt));
  return { value: round1(median(xs)), numerator: null, denominator: xs.length, leftOut: { clinical: replied.length - xs.length } };
}
const upTo = (until, now) => (until && now ? (until < now ? until : now) : until || now);
export function kpiResponsesOnTime(events, { since, until, now, offsetMinutes } = {}) {
  const end = upTo(until, now);
  const fell = complaints(events, { offsetMinutes }).filter((r) => inPeriod(r.replyDueAt, since, end));
  const withdrawn = fell.filter((r) => r.outcome === 'withdrawn' && !r.repliedAt);
  const clinical = fell.filter((r) => !withdrawn.includes(r) && atClinical(r));
  const due = fell.filter((r) => !withdrawn.includes(r) && !clinical.includes(r));
  const ok = due.filter((r) => r.repliedAt && r.repliedAt <= r.replyDueAt).length;
  return { value: due.length ? Math.round((100 * ok) / due.length) : null, numerator: ok, denominator: due.length, leftOut: { clinical: clinical.length, withdrawn: withdrawn.length } };
}
export function kpiActionsClosed(events, { since, until, now, offsetMinutes } = {}) {
  const end = upTo(until, now);
  const acts = [...deriveRecords(events, { offsetMinutes }).values()].filter(isTimed).flatMap((r) => r.actions).filter((a) => inPeriod(a.dueAt, since, end));
  const ok = acts.filter((a) => a.closedAt && a.closedAt <= a.dueAt).length;
  return { value: acts.length ? Math.round((100 * ok) / acts.length) : null, numerator: ok, denominator: acts.length, leftOut: {} };
}
// What the screen says beside a number about what was left out.
export function leftOutText(leftOut = {}) {
  const parts = [];
  if (leftOut.clinical) parts.push(`${leftOut.clinical} with clinical review`);
  if (leftOut.withdrawn) parts.push(`${leftOut.withdrawn} withdrawn before a reply`);
  const n = (leftOut.clinical || 0) + (leftOut.withdrawn || 0);
  return n ? `${n} left out: ${parts.join('; ')}` : null;
}
export const KPI_FUNCTIONS = {
  'feedback-ack-time': kpiAckTime, 'feedback-response-time': kpiResponseTime,
  'feedback-responses-on-time': kpiResponsesOnTime, 'feedback-actions-closed': kpiActionsClosed,
};

// ---- the themes board ----
// Counts only. A "higher than usual" flag needs a named method (for example a c-chart) and many
// months of history; the example site holds about one month, so no flag is shown (guide rule 2 is left out).
export const monthOf = (iso, offsetMinutes = 0) => new Date(Date.parse(iso) + offsetMinutes * MIN).toISOString().slice(0, 7);
export function monthBounds(month, offsetMinutes = 0) {
  const [y, m] = month.split('-').map(Number);
  const start = Date.UTC(y, m - 1, 1) - offsetMinutes * MIN;
  const end = Date.UTC(y, m, 1) - offsetMinutes * MIN;
  return { since: new Date(start).toISOString(), until: new Date(end).toISOString() };
}
const blankCounts = () => ({ complaints: 0, concerns: 0, compliments: 0, cards: 0, cardsGood: 0, cardsPoor: 0, actionsAgreed: 0, actionsClosed: 0 });
function add(c, r) {
  if (r.kind === 'complaint') c.complaints += 1;
  else if (r.kind === 'concern') c.concerns += 1;
  else if (r.kind === 'compliment') c.compliments += 1;
  else if (r.kind === 'card') { c.cards += 1; if (r.rating >= 4) c.cardsGood += 1; if (r.rating <= 2) c.cardsPoor += 1; }
  c.actionsAgreed += r.actions.length;
  c.actionsClosed += r.actions.filter((a) => a.closedAt).length;
}
export function themesBoard(records, { since, until, offsetMinutes = 0 } = {}) {
  const list = records.filter((r) => inPeriod(r.receivedAt, since, until));
  const byTheme = new Map(Object.keys(THEMES).map((t) => [t, blankCounts()]));
  const unsaid = blankCounts(); // cards where the person did not pick what it was about
  const byService = new Map();
  const ratings = [0, 0, 0, 0, 0];
  const totals = blankCounts();
  for (const r of list) {
    add(totals, r);
    add(r.theme && byTheme.has(r.theme) ? byTheme.get(r.theme) : unsaid, r);
    if (!byService.has(r.serviceId)) byService.set(r.serviceId, blankCounts());
    add(byService.get(r.serviceId), r);
    if (r.kind === 'card' && r.rating >= 1 && r.rating <= 5) ratings[r.rating - 1] += 1;
  }
  const months = [...new Set(records.map((r) => monthOf(r.receivedAt, offsetMinutes)))].sort().reverse();
  return {
    records: list.length, totals, ratings, months,
    byTheme: [...byTheme.entries()].map(([theme, c]) => ({ theme, ...c })),
    themeNotGiven: unsaid,
    byService: [...byService.entries()].map(([serviceId, c]) => ({ serviceId, ...c })).sort((a, b) => (b.complaints + b.concerns) - (a.complaints + a.concerns) || (b.cards - a.cards)),
  };
}

// ---- the guide: fixed rules, each with its basis; one switch for all ----
export const GUIDE_RULES = [
  {
    id: 'reply-due-soon',
    words: `A complaint or concern is within ${SETTINGS.remindDaysBefore} days of its reply due date, or past it, and no reply is recorded: shown to the owner role and the patient liaison officer. Not while it is with clinical review.`,
    basis: `Fixed rule. The ${SETTINGS.remindDaysBefore} days and the due dates are example settings, not a standard.`,
  },
  {
    id: 'reply-template',
    words: 'A template reply filled from the record\'s picks (type, service, theme, actions agreed), for the owner to edit outside Ospeli. It stores nothing and sends nothing.',
    basis: 'Fixed template, not a model and not a standard. The owner writes the reply.',
  },
];
export const GUIDE_LEFT_OUT = 'Not in this version: a "theme higher than usual" flag. It needs a named method such as a c-chart and many months of history; this example site holds about one month.';

export function guideReplyDue(records, now, settings = SETTINGS) {
  const out = [];
  for (const r of records) {
    if (!isOpen(r) || r.clinical || r.repliedAt || r.outcome === 'withdrawn') continue;
    const left = days(now, r.replyDueAt);
    if (left > settings.remindDaysBefore) continue;
    const d = Math.abs(Math.round(left));
    out.push({
      id: `reply-due-${r.id}`, rule: 'reply-due-soon', recordId: r.id, ownerRole: r.ownerRole, forRoles: [...new Set([r.ownerRole, 'patient-liaison'])],
      overdue: left < 0, daysLeft: round1(left),
      title: left < 0 ? `${r.id.toUpperCase()}: reply ${d === 0 ? 'less than a day' : `${d} day${d === 1 ? '' : 's'}`} late` : `${r.id.toUpperCase()}: reply due in ${d === 0 ? 'less than a day' : `${d} day${d === 1 ? '' : 's'}`}`,
      why: GUIDE_RULES[0].basis,
    });
  }
  return out.sort((a, b) => a.daysLeft - b.daysLeft);
}

// Guide rule 3: a fixed template filled from the record's picks. Words in [brackets] are for the
// owner to fill in. No model writes it; nothing is stored or sent.
export function replyTemplate(r, { serviceName, actionName = (k) => ACTION_KINDS[k] || k, dateText = (iso) => iso.slice(0, 10) } = {}) {
  if (!isTimed(r)) return null;
  const theme = (THEMES[r.theme]?.name || 'your experience').replace(/ \(.*\)$/, '').toLowerCase();
  const lines = [
    `Reference ${r.id.toUpperCase()}`,
    '',
    `Thank you for telling us about ${theme} at ${serviceName || 'our service'}.`,
    'What we looked at: [what was checked, in plain words]',
    'What we found: [what happened, about the service and the process]',
  ];
  if (r.actions.length) {
    lines.push('What we have agreed to do:');
    for (const a of r.actions) lines.push(`- ${actionName(a.what)}, by ${dateText(a.dueAt)}`);
  } else lines.push('What we will do: [the change agreed, and by when]');
  if (r.clinical || r.clinicalPeriods.length) lines.push('The part about clinical care has been passed to clinical review, who will reply on that part. [how and when]');
  lines.push('If you are not happy with this reply: [how to take it further at your organisation]');
  return lines.join('\n');
}
