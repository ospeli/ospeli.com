// Now (navigation v2, ospeli/ospeli docs/design/navigation-v2.md "Now"): the department's flow
// strip, what needs the person in flow order, the latest finding from a walk, then the pages.
// Every number here is read from what the modules already store on this device, through their
// read commands; a stage with no honest count shows "–" and says "not counted yet".
import { h, setKids } from './ui.js';
import { shortcutsFor, moduleById, ROLE_MODULES } from './registry.js';
import { departmentById, departmentShort, DEPARTMENTS, CHIP_NAMES } from './departments.js';
import { roleById } from '../core/model.js';
import { loadSyntheticHospital, currentHour } from '../core/generator.js';
import { kpiContext, kpiTiles } from './kpi-tiles.js';
import { KPIS } from '../core/kpi.js';
import { fmtWholeMin } from '../core/walk.js';
import { waitingDecisions, proposalWords } from './proposals.js';
import { longestWalks, NO_LONG_WAIT } from './result-words.js';

const card = (m) => h('a', { class: `card${m.load ? '' : ' is-soon'}`, href: `#/${m.id}` },
  h('h3', {}, m.name, m.load ? null : h('span', { class: 'pill pill-soon' }, 'Planned')),
  h('p', { class: 'meta' }, m.summary));
const pageName = (id) => CHIP_NAMES[id] || moduleById(id)?.name || id;
// Key numbers are about beds and emergency flow: shown for the departments they describe (#166 item 1).
const KEY_NUMBER_DEPARTMENTS = ['wards', 'emergency', 'whole-hospital'];
const inPlace = (place, id) => place === '*' || (place === 'ward-*' ? /^ward-/.test(id || '') : !!place && id === place);
const sum = (list, f) => list.reduce((n, x) => n + (f(x) || 0), 0);
const maxOf = (list, f) => list.reduce((m, x) => (f(x) > (m ? f(m) : -1) ? x : m), null);
const minutesSince = (iso, nowIso) => Math.max(0, Math.round((Date.parse(nowIso) - Date.parse(iso)) / 60000));

// What the flow strip counts. The tile dictionary (unit, time window, source states) is at the top
// of departments.js. Each counted stage: { n, words } (and `longest` on a tile that carries its own
// wait). `waits`: every wait the reads give a start time for, as whole minutes; `untimed`: waits the
// reads list with no start time; `wait`: the longest of `waits` (people's before vehicles' and
// requests' when equal), only from 1 minute; `asOf`: the earliest time the reads were true, or null.
const PEOPLE = new Set(['patient']);
export const plural = (n, unit) => `${n} ${unit}${n === 1 ? '' : 's'}`;
// "6 h 10 min", "6 h", "47 min", "under 1 min" (whole minutes, as the decision record words it).
export const fmtWait = (min) => (min < 1 ? 'under 1 min' : min < 60 ? `${min} min` : `${Math.floor(min / 60)} h${min % 60 ? ` ${min % 60} min` : ''}`);
// Wards: occupied beds split by whether a discharge date is set, so Stay + Expected to leave = every occupied bed.
// Clinics (#183, night 5 item 3): a patient's wait to be seen runs from the later of their arrival
// and their booked time, never from an early arrival. From one patient of ospeli_clinics_queue:
// arrivedAt, and pastBookedMinutes (minutes past the booked time now, 0 before it). null: no arrival time.
export function waitPastBooked(p, asOf) {
  if (!p || !p.arrivedAt || p.pastBookedMinutes == null || !Number.isFinite(Date.parse(p.arrivedAt))) return null;
  return Math.min(minutesSince(p.arrivedAt, asOf), Math.max(0, p.pastBookedMinutes));
}
export function wardBedCounts(wards) {
  const stay = sum(wards, (w) => w.counts?.occupied); const expected = sum(wards, (w) => w.counts?.['expected-discharge']);
  return { stay, expected, occupied: stay + expected };
}
export async function flowCounts(run, dept) {
  const times = [];
  const read = async (name, input) => { try { const r = await run(name, input); if (r?.asOf) times.push(r.asOf); return r; } catch { return null; } };
  const c = {}; const waits = []; const untimed = [];
  // words: what the number counts, in full (read out); show: the same on screen, short (night 5
  // item 1: the tile's meaning is on screen, not only for screen readers; shown where the tile has no words of its own).
  const put = (stage, n, words, show = words) => { c[stage] = { n, words, show }; };
  // Waits from a list: each item's minutes (null: no start time). `weight`: how many items one entry
  // stands for. `at`: for a request, the tile that shows its age (requests never head the strip).
  const timed = (between, list, minutes, forWords, unit, untimedWords, weight = () => 1, at = null) => {
    let none = 0;
    for (const x of list) {
      const m = minutes(x);
      if (m == null || !Number.isFinite(m)) none += weight(x); else waits.push({ between, minutes: Math.round(m), forWords, unit, ...(at ? { at } : {}) });
    }
    if (none) untimed.push({ n: none, unit, words: untimedWords });
  };
  const notStarted = (t) => !t.startedAt;
  // Each patient waiting in today's clinics, from the later of arrival and booked time (waitPastBooked).
  const clinicWaits = async (between, today) => {
    for (const x of today.filter((k) => k.counts?.waiting > 0)) {
      const q = await read('ospeli_clinics_queue', { sessionId: x.sessionId, limit: 300 });
      const here = q ? q.patients.filter((p) => p.state === 'arrived') : null;
      if (!here) { untimed.push({ n: x.counts.waiting, unit: 'patient', words: 'waiting with no arrival time' }); continue; }
      timed(between, here, (p) => waitPastBooked(p, q.asOf), 'to be seen since booked time or later arrival', 'patient', 'waiting with no arrival time');
    }
    mergeUntimed(untimed);
  };
  if (dept.id === 'imaging') {
    const [tasks, board] = await Promise.all([read('ospeli_tasks_list', { kind: 'patient-move', limit: 500 }), read('ospeli_transfers_board', { limit: 500 })]);
    if (tasks) {
      const into = tasks.tasks.filter((t) => t.toLocationId === dept.place);
      put('arrive', into.length, 'being moved to Imaging', 'being moved in');
      timed(['arrive', 'prep'], into.filter(notStarted), (t) => t.waitMinutes, 'to be moved in', 'patient', 'waiting to be moved in');
      const out = tasks.tasks.filter((t) => t.locationId === dept.place);
      const vans = board ? board.waiting.filter((j) => j.pickup?.id === dept.place) : [];
      put('leave', out.length + vans.length, out.length + vans.length ? `waiting to leave (${plural(out.length, 'move')}, ${plural(vans.length, 'journey')})` : 'waiting to leave', 'waiting to leave');
      timed(['scan', 'leave'], out.filter(notStarted), (t) => t.waitMinutes, 'to be moved out', 'patient', 'waiting to be moved out');
      timed(['scan', 'leave'], vans, (j) => j.waitMinutes, 'for a vehicle', 'journey', 'waiting for a vehicle');
    }
  } else if (dept.id === 'outpatients') {
    const day = await read('ospeli_clinics_day_summary', { limit: 200 });
    if (day) {
      const today = day.clinics.filter((x) => x.date === day.date);
      put('arrive', sum(today, (x) => x.counts?.toCome), 'booked today, not arrived yet', 'booked, not here yet');
      put('wait', sum(today, (x) => x.counts?.waiting), 'arrived, waiting to be seen', 'arrived, waiting');
      put('seen', sum(today, (x) => x.counts?.withClinician), 'with the clinician');
      await clinicWaits(['wait', 'seen'], today);
    }
  } else if (dept.id === 'emergency' || dept.id === 'wards') {
    const [beds, board] = await Promise.all([read('ospeli_beds_board', { format: 'short' }), dept.id === 'wards' ? read('ospeli_transfers_board', { limit: 500 }) : null]);
    if (beds) {
      // From the decision to admit, the start the bed board shows as "waiting".
      const bedMin = (x) => (x.decisionAt ? minutesSince(x.decisionAt, beds.asOf) : null);
      if (dept.id === 'emergency') {
        put('leave', beds.waiting.length, 'waiting for a ward bed', '');
        timed(['treat', 'leave'], beds.waiting, bedMin, 'for a ward bed', 'patient', 'waiting for a ward bed');
        const top = maxOf(waits, (w) => w.minutes);
        if (top) c.leave.longest = top.minutes;
      } else {
        const b = wardBedCounts(beds.wards);
        put('arrive', beds.waiting.length, 'waiting for a bed');
        put('stay', b.stay, 'occupied, no discharge date');
        put('ready', b.expected, 'occupied, with a discharge date');
        timed(['arrive', 'stay'], beds.waiting, bedMin, 'for a bed', 'patient', 'waiting for a bed');
      }
    }
    if (board) {
      const out = board.waiting.filter((j) => inPlace(dept.place, j.pickup?.id));
      put('leave', out.length, 'waiting for a vehicle');
      timed(['ready', 'leave'], out, (j) => j.waitMinutes, 'for a vehicle', 'journey', 'waiting for a vehicle');
    }
  } else if (dept.id === 'pharmacy') {
    // Issue #197: every open request is on the strip, a request on hold on the tile of the step it
    // reached ("1 on hold"), and each tile shows its oldest request (time since its last step, or
    // since it was put on hold), as the laboratory's tiles do. Requests never head the strip.
    const TILES = [['raised', 'received', 'received, not started yet', 'not started'], ['started', 'prepared', 'being prepared'],
      ['checked', 'checked', 'checked, not ready yet', 'checked, not ready'], ['ready', 'collected', 'ready, waiting to be collected', 'ready to collect']];
    const q = await read('ospeli_pharmacy_queue_list', { format: 'short', limit: 500 });
    if (q) {
      TILES.forEach(([stage, tile, words, show], i) => {
        const here = q.requests.filter((r) => r.stage === stage);
        put(tile, here.length, words, show);
        const held = here.filter((r) => r.held).length;
        if (held) c[tile].also = `${held} on hold`;
        timed([tile, TILES[i + 1]?.[1] || tile], here, (r) => r.sinceStepMinutes, 'since the last step', 'request', 'with no step time', undefined, tile);
      });
      mergeUntimed(untimed);
    } else {
      // The overview's counts only: a held request has no step there, so it is said on the first tile.
      const o = await read('ospeli_pharmacy_overview', {});
      if (o) {
        TILES.forEach(([stage, tile, words, show]) => put(tile, o.counts[stage] || 0, words, show));
        if (o.counts['on-hold']) c.received.also = `${o.counts['on-hold']} more on hold`;
      }
    }
  } else if (dept.id === 'laboratory') {
    const r = await read('ospeli_diagnostics_requests_list', { stage: 'current', limit: 500 });
    if (r) {
      const at = (s) => r.requests.filter((x) => x.state === s);
      put('asked', at('requested').length, 'not collected'); put('collected', at('collected').length, 'on the way');
      put('received', at('received').length, 'in the lab');
      put('done', at('released').length, 'released in the last 24 h', 'released');
      const after = { requested: [['asked', 'collected'], 'to be collected', 'asked'], collected: [['collected', 'received'], 'to reach the lab', 'collected'], received: [['received', 'done'], 'for a result', 'received'] };
      for (const [state, [between, words, tile]] of Object.entries(after)) timed(between, at(state), (x) => x.minutesInStep, words, 'request', 'with no step time', undefined, tile);
      mergeUntimed(untimed);
    }
  } else if (dept.id === 'whole-hospital') {
    const [day, lab, beds, board] = await Promise.all([read('ospeli_clinics_day_summary', { limit: 200 }), read('ospeli_diagnostics_requests_list', { stage: 'current', limit: 500 }),
      read('ospeli_beds_board', { format: 'short' }), read('ospeli_transfers_board', { limit: 500 })]);
    if (day) {
      const today = day.clinics.filter((x) => x.date === day.date);
      put('arrive', sum(today, (x) => x.counts?.waiting), 'waiting in clinics');
      await clinicWaits(['arrive', 'test'], today);
    }
    if (lab) {
      const open = lab.requests.filter((x) => ['requested', 'collected', 'received'].includes(x.state));
      put('test', open.length, 'open in the laboratory', 'open in the lab');
      const words = { requested: 'to be collected', collected: 'to reach the lab', received: 'for a result' };
      for (const st of Object.keys(words)) timed(['test', 'stay'], open.filter((x) => x.state === st), (x) => x.minutesInStep, words[st], 'request', 'with no step time', undefined, 'test');
      mergeUntimed(untimed);
    }
    if (beds) {
      put('stay', wardBedCounts(beds.wards).occupied, 'every occupied bed, with or without a discharge date', 'occupied');
      // Now review fix 2: the headline's bed wait points at this tile, so the tile counts who waits for a bed.
      c.stay.also = `${plural(beds.waiting.length, 'patient')} waiting for a bed`;
      timed(['test', 'stay'], beds.waiting, (x) => (x.decisionAt ? minutesSince(x.decisionAt, beds.asOf) : null), 'for a bed', 'patient', 'waiting for a bed');
    }
    if (board) { put('leave', board.waiting.length, 'waiting for a vehicle'); timed(['stay', 'leave'], board.waiting, (j) => j.waitMinutes, 'for a vehicle', 'journey', 'waiting for a vehicle'); }
  }
  // Night 5 item 2: a patient's wait heads the strip whenever one exists. A vehicle's wait heads
  // only when no patient's wait is timed; a request never does (no module here gives a request an
  // expected time with a source, so its age is on its own tile instead).
  const longestOf = (f) => waits.filter((w) => w.minutes >= 1 && f(w)).reduce((m, w) => (!m || w.minutes > m.minutes ? w : m), null);
  const person = longestOf((w) => PEOPLE.has(w.unit));
  const vehicle = longestOf((w) => w.unit === 'journey');
  for (const w of waits) if (w.at && c[w.at] && (c[w.at].longest == null || w.minutes > c[w.at].longest)) { c[w.at].longest = w.minutes; c[w.at].oldest = true; }
  const asOf = times.length ? times.reduce((a, b) => (Date.parse(b) < Date.parse(a) ? b : a)) : null;
  return { counts: c, waits, untimed, wait: person || vehicle || null, vehicle, asOf };
}
// Untimed entries of the same unit and words, added up.
function mergeUntimed(list) {
  const out = [];
  for (const u of list) { const same = out.find((x) => x.unit === u.unit && x.words === u.words); if (same) same.n += u.n; else out.push({ ...u }); }
  list.splice(0, list.length, ...out);
}
const andList = (xs) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
const nounOf = (s) => s.noun || s.name.toLowerCase();
// What the whole hospital cannot time (Now review fix 1): every other department's stages where
// people wait with no start time, from the stage data in departments.js. A department whose
// untimed stages are all planned is named as a whole ("emergency department steps"), first; then
// the stages of the others ("imaging prep and scan"). Empty for a department that is not `every`.
export function untimedStages(dept) {
  if (!dept?.every) return [];
  const each = DEPARTMENTS.filter((d) => d !== dept && !d.every).map((d) => ({ d, us: d.stages.filter((s) => s.wait === 'untimed') })).filter((x) => x.us.length);
  const whole = each.filter((x) => x.us.every((s) => s.planned));
  return [...whole.map((x) => `${x.d.name.toLowerCase()} steps`),
    ...each.filter((x) => !whole.includes(x)).map((x) => `${departmentShort(x.d).toLowerCase()} ${andList(x.us.map(nounOf))}`)];
}
// The headline over the strip, and what it leaves out, in words (Now review fixes 1, 3, 4, 5).
// "Longest wait now" only when every stage is counted, no stage where people wait is untimed and
// every wait has a start time; otherwise "Longest timed wait", or "Only timed wait" when there is
// just one, and what is not timed is named.
export function flowHeadline(dept, flow) {
  const notCounted = dept.stages.filter((s) => !s.planned && !flow.counts[s.id]).map((s) => s.name);
  const planned = dept.stages.filter((s) => s.planned);
  const left = [];
  if (notCounted.length) left.push(`${andList(notCounted)} ${notCounted.length === 1 ? 'is' : 'are'} not counted yet.`);
  const notTimed = [
    planned.length ? `${andList(planned.map(nounOf))} (planned, not built)` : '',
    andList(dept.stages.filter((s) => s.wait === 'untimed' && !s.planned && flow.counts[s.id]).map(nounOf)),
    ...untimedStages(dept),
    ...flow.untimed.map((u) => `${plural(u.n, u.unit)} ${u.words}`),
  ].filter(Boolean);
  if (notTimed.length) left.push(`Not timed: ${notTimed.join(', ')}.`);
  const w = flow.wait;
  const requests = flow.waits.some((x) => x.unit === 'request');
  // Requests are never ranked with people's waits (night 5 item 2): their age stays on their tile ("oldest …").
  const notRanked = w && requests ? 'Requests are not ranked.' : '';
  // Under a patient's wait, a longer vehicle wait is said, so it is not hidden either.
  const also = w && PEOPLE.has(w.unit) && flow.vehicle && flow.vehicle.minutes > w.minutes ? `A vehicle wait is longer: ${fmtWait(flow.vehicle.minutes)} (1 journey).` : '';
  // No timed patient or vehicle wait, only requests: say so; no request heads the strip.
  const none = !w && requests ? 'No timed patient wait. Requests are not ranked; each tile shows its oldest.' : '';
  const subset = left.length || (w && !PEOPLE.has(w.unit) && requests);
  const timedN = flow.waits.filter((x) => x.unit !== 'request').length;
  const lead = !subset ? 'Longest wait now' : timedN === 1 ? 'Only timed wait' : 'Longest timed wait';
  return { text: w ? `${lead}: ${fmtWait(w.minutes)} ${w.forWords} (1 ${w.unit})` : null,
    also, none, leftOut: [...left, notRanked].filter(Boolean).join(' ') };
}

// "Needs you" in one order: the work cards (from needsYou, already in flow order) and the agents'
// card where its earliest page sits on the flow (ospeli/ospeli#183 item 5). Pages on no stage go
// after the stages; on a tie (same stage and page) the work card comes first. The agents' card is
// never pinned first, and with nothing waiting (agents off) the other cards keep their order.
export function orderNeeds(dept, items, waiting) {
  const at = (page) => { const i = dept.stages.findIndex((s) => s.pages.includes(page)); return i < 0 ? [dept.stages.length, 0] : [i, dept.stages[i].pages.indexOf(page)]; };
  const keyed = items.map((it, k) => ({ it, key: [...at(it.page), 0, k] }));
  const pages = waiting?.pages || [];
  if (pages.length) {
    const first = pages.map((x) => at(x.id)).sort((a, b) => a[0] - b[0] || a[1] - b[1])[0];
    keyed.push({ it: { decisions: true, order: first[0] }, key: [...first, 1, 0] });
  }
  const cmp = (a, b) => { for (let i = 0; i < 4; i += 1) if (a.key[i] !== b.key[i]) return a.key[i] - b.key[i]; return 0; };
  return keyed.sort(cmp).map((x) => x.it);
}

// "Needs you, in flow order": what the person may need to act on, as cards labelled by stage and
// page, in the order of the department's flow. Agents' proposals waiting for this role are the
// first card (render below, in the same flow order); then open work orders in the department's place (ospeli_workorders_list), its
// equipment that is down (ospeli_diagnostics_equipment_list) and journeys from it waiting for a
// vehicle (ospeli_transfers_board). Each in words; nothing invented.
export async function needsYou(run, dept) {
  const read = async (name, input) => { try { return await run(name, input); } catch { return null; } };
  let asOf = null; // the source read's own time, shown on its card (As of hh:mm)
  const stageOf = (page) => dept.stages.findIndex((s) => s.pages.includes(page));
  const items = new Map();
  const add = (page, chip, href = `#/${page}`) => {
    const i = stageOf(page);
    const key = `${i}:${page}`;
    const it = items.get(key) || { stage: i >= 0 ? dept.stages[i] : null, order: i >= 0 ? i : dept.stages.length, page, href, chips: [], asOf };
    if (asOf && (!it.asOf || Date.parse(asOf) < Date.parse(it.asOf))) it.asOf = asOf;
    it.chips.push(chip);
    items.set(key, it);
  };
  const uses = (page) => dept.stages.some((s) => s.pages.includes(page));
  const local = dept.place && dept.place !== '*';
  const [wo, eq, board] = await Promise.all([
    uses('engineering') && local ? read('ospeli_workorders_list', { state: 'open', limit: 500 }) : null,
    uses('diagnostics') && local ? read('ospeli_diagnostics_equipment_list', { limit: 200 }) : null,
    uses('transfers') && local ? read('ospeli_transfers_board', { limit: 500 }) : null]);
  if (wo) {
    asOf = wo.asOf || null;
    const mine = wo.workOrders.filter((w) => inPlace(dept.place, w.locationId));
    if (mine.length) { const late = mine.filter((w) => w.overdue).length; add('engineering', `${mine.length} open work ${mine.length === 1 ? 'order' : 'orders'}${late ? `, ${late} overdue` : ''}`); }
  }
  if (eq) {
    asOf = eq.asOf || null;
    const down = eq.equipment.filter((e) => inPlace(dept.place, e.placeId) && e.state !== 'up');
    for (const e of down) add('diagnostics', `${e.name}: ${String(e.stateName || 'not working').toLowerCase()}`);
  }
  if (board) {
    asOf = board.asOf || null;
    const out = board.waiting.filter((j) => inPlace(dept.place, j.pickup?.id));
    if (out.length) { const late = out.filter((j) => j.late).length; add('transfers', `${out.length} waiting for a vehicle${late ? `, ${late} late` : ''}`); }
  }
  return [...items.values()].sort((a, b) => a.order - b.order || (a.stage ? a.stage.pages.indexOf(a.page) - a.stage.pages.indexOf(b.page) : 0));
}

// "From your walks": the latest map made from a walk, in one sentence. One walk: ospeli_maps_summary
// (the map screen's longest-wait rule). Two or more walks (#191 point 1): the map's own walks, read
// with longestWalks as the Result tab reads them, so a longest wait that moved is said to have moved.
// A walk whose phone clock changed (#191 point 2) names no longest wait and never says "no wait".
const CLOCK_MOVED = 'the phone\'s clock changed during this walk, so its times may be wrong and no longest wait is named';
export async function latestWalk(run) {
  try {
    const list = await run('ospeli_maps_list', { limit: 200 });
    const m = list.maps.filter((x) => x.walk).sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))[0];
    if (!m) return null;
    const map = await run('ospeli_maps_get', { mapId: m.id });
    const rg = map.range;
    const title = map.title || m.title;
    if (rg && rg.count > 1) {
      const lw = longestWalks(rg);
      const left = rg.walks.filter((w) => w.clockMoved).map((w) => w.n);
      const leftWords = left.length ? ` The phone's clock changed on walk ${left.join(' and ')}: left out.` : '';
      const text = lw ? `${lw.lead}${lw.text}.${leftWords}` : rg.usable ? `${NO_LONG_WAIT(true)}${leftWords}` : `The phone's clock changed on every walk, so no longest wait is named.`;
      return { id: m.id, title, text, sentence: `${title}, ${rg.count} walks. ${text}` };
    }
    if (map.walk?.clockMoved) return { id: m.id, title, text: CLOCK_MOVED, clockMoved: true, sentence: `${title}: ${CLOCK_MOVED}.` };
    const s = await run('ospeli_maps_summary', { mapId: m.id });
    const b = s.biggestWait;
    const sec = b ? (b.waitSec ?? b.wait * 60) : 0;
    const text = b ? `longest wait ${b.atLeast ? 'at least ' : ''}${fmtWholeMin(sec)} before ${b.name}` : 'no wait of 30 seconds or more';
    return { id: m.id, title: s.title, text, sentence: `${s.title}: ${text}` };
  } catch { return null; }
}


// Numbers older than this read as old, in words (ospeli/ospeli#183 item 2). An example setting,
// not a standard: the screen says so wherever it shows it.
export const STALE_MINUTES = 15;
const hhmm = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const asOfWords = (iso) => (iso ? `As of ${hhmm(iso)}` : 'Time not known');
const unitWord = (s, n) => (s.unit ? (n === 1 ? s.unit : `${s.unit}s`) : '');

function flowStrip(dept, flow) {
  const pick = h('div', { class: 'flow-pick', 'data-test': 'flow-pick', hidden: true });
  const shown = dept.stages.filter((s) => !s.planned);
  const line = flowHeadline(dept, flow);
  const one = shown.length === 1; // a single tile carries its own longest wait
  // Now review fix 3: a single tile whose stages before it are planned (Emergency) still has its
  // wait in the headline, and the bar leads into the tile, as it does between two tiles on Wards.
  const led = one && !!flow.wait && flow.wait.between[1] === shown[0].id;
  const tiles = [];
  shown.forEach((s, i) => {
    const c = flow.counts[s.id];
    if (i > 0 || led) {
      const w = flow.wait && flow.wait.between[1] === s.id ? flow.wait : null;
      tiles.push(h('span', { class: `flow-conn${w ? ' is-wait' : ''}`, 'aria-hidden': 'true', 'data-test': w ? 'flow-wait-bar' : null }, w ? '›' : ''));
    }
    const opens = s.pages.length === 1 ? `Opens ${pageName(s.pages[0])}` : `Pages: ${s.pages.map(pageName).join(', ')}`;
    // The tile's name is its own text (no aria-label, so what is read is what is seen): the stage,
    // the number with its unit, then in hidden words what the number counts and where the tile goes.
    // Night 5 item 1: what the number counts is on the tile in words ("requests ready to collect").
    // A tile with its own words (s.tile) already says it; a tile named by its stage gets a short line.
    const show = c && c.show && !s.tile ? ` ${c.show}` : '';
    const body = [
      h('span', { class: 'flow-name' }, s.tile || s.name), ' ',
      h('b', { class: 'flow-n' }, c ? String(c.n) : '–'), ' ',
      h('span', { class: 'flow-what', 'data-test': 'flow-what' },
        h('span', { class: 'flow-unit', 'data-test': 'flow-unit' }, c ? (s.apart ? `${unitWord(s, c.n)}, last 24 h` : unitWord(s, c.n)) : 'not counted yet'), show),
      c && c.longest != null ? [' ', h('span', { class: 'flow-longest', 'data-test': 'flow-longest' }, `${c.oldest ? 'oldest' : 'longest'} ${fmtWait(c.longest)}`)] : null,
      c && c.also ? [' ', h('span', { class: 'flow-also', 'data-test': 'flow-also' }, c.also)] : null,
      h('span', { class: 'sr-only' }, `${c && c.words && c.words !== (s.tile ? s.tile.toLowerCase() : c.show) ? ` (${c.words})` : ''}. ${opens}.`),
    ];
    const cls = `flow-tile${c ? '' : ' is-none'}${s.apart ? ' is-apart' : ''}`;
    tiles.push(s.pages.length === 1
      ? h('a', { class: cls, href: `#/${s.pages[0]}`, 'data-stage': s.id }, body)
      : h('button', { type: 'button', class: cls, 'data-stage': s.id, 'aria-expanded': 'false', 'aria-controls': 'flow-pick',
        onclick: (e) => {
          const was = pick.dataset.stage === s.id && !pick.hidden;
          for (const b of e.currentTarget.parentNode.querySelectorAll('button.flow-tile')) b.setAttribute('aria-expanded', 'false');
          pick.hidden = was; pick.dataset.stage = s.id;
          if (!was) { e.currentTarget.setAttribute('aria-expanded', 'true'); pick.replaceChildren(h('p', { class: 'flow-pick-h' }, `${s.tile || s.name}: pages that serve it`), h('ul', {}, s.pages.map((p) => h('li', {}, h('a', { href: `#/${p}` }, pageName(p)))))); }
        } }, body));
  });
  pick.id = 'flow-pick';
  const note = keyNote(dept, flow);
  return h('section', { class: 'flow', 'aria-labelledby': 'flow-h', 'data-test': 'now-flow' },
    h('h2', { id: 'flow-h', class: 'sr-only' }, `${dept.name} flow now`),
    h('div', { class: `flow-strip${led ? ' is-led' : ''}`, 'data-test': 'flow-strip', 'data-n': shown.length }, tiles),
    line.text && (!one || led) ? h('p', { class: 'flow-wait', 'data-test': 'flow-wait' }, h('span', { class: 'flow-swatch', 'aria-hidden': 'true' }), h('span', { class: 'flow-arrow', 'aria-hidden': 'true' }, '→'),
      h('span', { class: 'flow-wait-text' }, line.text)) : null,
    line.none ? h('p', { class: 'flow-none', 'data-test': 'flow-none' }, line.none) : null,
    h('p', { class: 'flow-key', 'data-test': 'flow-key' },
      // When the numbers were true, what a tile name alone does not say, and what the strip leaves out.
      // Each tile carries its unit; its full words are in its accessible name.
      h('span', { class: 'flow-asof', 'data-test': 'flow-asof', 'data-asof': flow.asOf || '' }, asOfWords(flow.asOf)),
      [line.also, note, line.leftOut].filter(Boolean).map((t) => ` · ${t}`).join('')),
    h('p', { class: 'flow-stale', 'data-test': 'flow-stale', role: 'status', hidden: true }),
    pick,
  );
}

// One plain sentence where a tile's name could be misread (decision record, angles 4 and 10).
function keyNote(dept, flow) {
  const c = flow.counts;
  if (dept.id === 'wards' && c.stay && c.ready) return `${plural(c.stay.n + c.ready.n, 'occupied bed')}; ${c.ready.n} ${c.ready.n === 1 ? 'has' : 'have'} a discharge date.`;
  if (dept.id === 'whole-hospital' && c.stay) return 'Occupied: every occupied bed, with or without a discharge date.';
  if (dept.id === 'laboratory' && c.done) return 'Released: in the last 24 h, not open work.';
  return '';
}

// The agents' card: proposals waiting for this role (issue #52), in the department's flow order.
function decisionsCard(dept, waiting, asOf) {
  const stageAt = (id) => { const i = dept ? dept.stages.findIndex((s) => s.pages.includes(id)) : -1; return i < 0 ? Infinity : i; };
  const pages = [...waiting.pages].sort((a, b) => stageAt(a.id) - stageAt(b.id));
  return h('section', { class: 'card decisions', 'data-test': 'decisions-waiting', 'aria-labelledby': 'dec-h' },
    h('h2', { id: 'dec-h' }, `Waiting for your decision (${waiting.total})`),
    h('p', { class: 'meta' }, 'An agent suggested these. Nothing changes until a person accepts or declines.'),
    h('ul', { class: 'decision-list' }, pages.map((x) => h('li', {},
      stageAt(x.id) < Infinity ? h('span', { class: 'needs-where', 'data-test': 'needs-where' }, `At ${dept.stages[stageAt(x.id)].name}`) : null,
      h('a', { href: x.href }, `${moduleById(x.id).name}${x.screenName ? `, ${x.screenName}` : ''}: ${proposalWords(x.count)}`)))),
    h('p', { class: 'needs-asof', 'data-test': 'needs-asof', 'data-asof': asOf }, asOfWords(asOf)));
}

export async function render(el, ctx) {
  const role = roleById(ctx.role);
  const dept = departmentById(ctx.department);
  // The department's pages first, then the role's own; each page once, built pages only.
  const builtPages = (ids) => ids.map(moduleById).filter((m) => m && m.load);
  const mine = dept ? [...new Set([...builtPages(dept.pinned), ...builtPages(ROLE_MODULES[ctx.role] || [])])] : shortcutsFor(ctx.role);
  // KPIs this role owns first, then the rest.
  const kpiIds = [...KPIS.filter((k) => k.owner === ctx.role), ...KPIS.filter((k) => k.owner !== ctx.role)].map((k) => k.id);
  const synthetic = (await ctx.core.getMeta('synthetic', null)) === true;
  const [beds, wards, eventCount, auditCount] = await Promise.all([
    ctx.core.listEntities('bed'), ctx.core.listEntities('ward'), ctx.core.eventCount(), ctx.core.db.count('audit'),
  ]);
  const nowIso = () => (typeof ctx.core.now === 'function' ? ctx.core.now() : new Date().toISOString());

  // On a phone the role's shortcuts come first, so the day's first tap is on the first screen
  // (issue #10); wider screens keep Key numbers first.
  const phone = window.matchMedia('(max-width: 640px)').matches;
  const showKeys = beds.length && (!dept || KEY_NUMBER_DEPARTMENTS.includes(dept.id));
  const keyNumbers = showKeys ? h('section', { class: 'section', style: phone ? null : 'margin-top:0', 'aria-labelledby': 'kpi-h' },
    h('h2', { id: 'kpi-h' }, 'Key numbers'),
    h('p', { class: 'meta' }, 'Last 7 days, calculated from the event log. Tap a number to see how it is defined.'),
    kpiTiles(kpiIds, await kpiContext(ctx.core))) : null;
  const shortcuts = [
    h('h2', { class: 'section', style: phone || !keyNumbers ? 'margin-top:0' : null }, 'Your pages'),
    h('div', { class: 'grid', 'data-test': 'role-shortcuts' }, mine.map(card)),
  ];

  // "Needs you, in flow order" (#183 item 5): the agents' card (issue #52: one tap to where it is
  // decided) takes its place along the flow with the work cards; it is never pinned first. With
  // nothing waiting, or agents off, there is no card and the other cards keep their order.
  const needsBox = h('div', {});
  const stripBox = h('div', {});
  let drawing = 0;
  const drawNeeds = async () => {
    const mineNow = ++drawing;
    const [waiting, list] = await Promise.all([waitingDecisions(ctx), dept ? needsYou(ctx.run, dept) : []]);
    if (mineNow !== drawing) return; // a newer draw has started
    const asOf = nowIso();
    const decisions = waiting.total ? decisionsCard(dept, waiting, asOf) : null;
    if (!dept) { setKids(needsBox, decisions); return; }
    const order = orderNeeds(dept, list, waiting.total ? waiting : { pages: [] });
    setKids(needsBox, order.length
      ? h('ol', { class: 'needs-list', 'data-test': 'needs-list' }, order.map((it) => (it.decisions ? h('li', { class: 'needs-decisions' }, decisions)
        : h('li', {}, h('a', { class: 'card needs-card', href: it.href, 'data-stage': it.stage?.id || 'other', 'data-page': it.page },
          h('span', { class: 'needs-where', 'data-test': 'needs-where' }, `${it.stage ? `At ${it.stage.name}` : 'Elsewhere'} · ${pageName(it.page)}`),
          h('span', { class: 'needs-chips' }, it.chips.map((t) => h('span', { class: 'chip-word' }, t))),
          h('span', { class: 'needs-asof', 'data-test': 'needs-asof', 'data-asof': it.asOf || '' }, asOfWords(it.asOf)))))))
      : h('p', { class: 'meta', 'data-test': 'needs-none' }, 'Nothing needs you right now. Proposals, work orders, equipment and journeys for your department show here.'));
    showAge();
  };
  const drawStrip = async () => { if (dept) setKids(stripBox, flowStrip(dept, await flowCounts(ctx.run, dept))); };

  // Age, in words (#183 item 2): each "As of" says how old it is once it is past STALE_MINUTES,
  // and the strip says so plainly, with one tap to read the numbers again. A device that works
  // through a site server and has lost the connection says that instead.
  const readAgain = h('button', { type: 'button', class: 'btn flow-again', 'data-test': 'flow-again',
    onclick: async (e) => { e.currentTarget.disabled = true; await Promise.all([drawStrip(), drawNeeds()]); showAge(); } }, 'Read again');
  const showAge = () => {
    const now = Date.parse(nowIso());
    // The shell moves the page's children out of `el` into <main>, so look in this page's own boxes.
    for (const n of [stripBox, needsBox].flatMap((b) => [...b.querySelectorAll('[data-asof]')])) {
      const at = n.dataset.asof;
      if (!at) continue;
      const age = Math.max(0, Math.floor((now - Date.parse(at)) / 60000));
      n.textContent = age > STALE_MINUTES ? `${asOfWords(at)}, ${fmtWait(age)} old` : asOfWords(at);
      n.classList.toggle('is-old', age > STALE_MINUTES);
    }
    const stale = stripBox.querySelector('[data-test="flow-stale"]');
    if (!stale) return;
    const at = stripBox.querySelector('[data-test="flow-asof"]')?.dataset.asof;
    const age = at ? Math.max(0, Math.floor((now - Date.parse(at)) / 60000)) : 0;
    const cut = document.documentElement.dataset.site === 'offline';
    const words = cut ? `Not connected${ctx.site?.lastAt ? ` since ${hhmm(ctx.site.lastAt)}` : ''}. These numbers may be out of date.`
      : age > STALE_MINUTES ? `These numbers are ${fmtWait(age)} old. Old after ${STALE_MINUTES} min (example setting, not a standard).` : '';
    stale.hidden = !words;
    readAgain.disabled = false;
    stale.replaceChildren(...(words ? [h('span', {}, words), cut ? null : readAgain].filter(Boolean) : []));
  };
  const [, walkLine] = await Promise.all([drawStrip(), latestWalk(ctx.run), drawNeeds()]);
  const off = ctx.core.onChange(({ kind }) => { if (kind === 'proposals' || kind === 'reset') drawNeeds(); });
  const tick = setInterval(showAge, 60000);

  const needs = dept ? h('section', { class: 'section needs', 'aria-labelledby': 'needs-h', 'data-test': 'now-needs' },
    h('h2', { id: 'needs-h' }, 'Needs you, in flow order'), needsBox) : needsBox;
  const walks = walkLine ? h('section', { class: 'section', 'aria-labelledby': 'walks-h', 'data-test': 'now-walks' },
    h('h2', { id: 'walks-h' }, 'From your walks'),
    h('div', { class: 'card now-walk' }, h('p', { 'data-test': 'now-walk-line' }, walkLine.sentence),
      h('a', { href: `#/process/${walkLine.id}`, class: 'now-walk-link', 'data-test': 'now-walk-map' }, 'See map'))) : null;

  // Element.append would print a null child as the word "null" (issue #7), so drop them.
  el.append(...[
    h('div', { class: 'page-head' },
      h('div', {},
        h('p', { class: 'eyebrow' }, 'Now'),
        h('h1', {}, dept ? dept.name : 'Choose your department'),
        h('p', { 'data-test': 'now-role' }, `${role.name}. Your role is under Me; every page is under Journey.`))),
    dept ? stripBox : null,
    needs,
    walks,
    ...(phone || !keyNumbers ? [...shortcuts, keyNumbers] : [keyNumbers, ...shortcuts]),
    h('section', { class: 'section', 'aria-labelledby': 'dev-h' },
      h('h2', { id: 'dev-h' }, 'On this device'),
      h('div', { class: 'stats' },
        h('div', { class: 'stat' }, h('b', {}, wards.length), h('span', {}, 'Wards')),
        h('div', { class: 'stat' }, h('b', {}, beds.length), h('span', {}, 'Beds')),
        h('div', { class: 'stat' }, h('b', {}, eventCount), h('span', {}, 'Events logged')),
        h('div', { class: 'stat' }, h('b', {}, auditCount), h('span', {}, 'Audit entries'))),
      beds.length ? null : h('div', { class: 'card notice section' },
        h('p', {}, 'No hospital is loaded on this device.'),
        h('button', { class: 'btn', type: 'button', onclick: async (ev) => {
          ev.target.disabled = true;
          ev.target.textContent = 'Loading…';
          await loadSyntheticHospital(ctx.core, { end: currentHour() });
          ctx.toast('Example General Hospital loaded');
          location.reload();
        } }, 'Load Example General Hospital'))),
    synthetic ? h('p', { class: 'meta now-foot', 'data-test': 'now-foot' }, 'Synthetic demo data · no real patients or sites') : null,
  ].filter(Boolean));
  showAge();
  return () => { clearInterval(tick); if (typeof off === 'function') off(); };
}
