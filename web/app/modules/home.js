// Now (navigation v2, ospeli/ospeli docs/design/navigation-v2.md "Now"): the department's flow
// strip, what needs the person in flow order, the latest finding from a walk, then the pages.
// Every number here is read from what the modules already store on this device, through their
// read commands; a stage with no honest count shows "–" and says "not counted yet".
import { h, setKids } from './ui.js';
import { shortcutsFor, moduleById, ROLE_MODULES } from './registry.js';
import { departmentById, CHIP_NAMES } from './departments.js';
import { roleById } from '../core/model.js';
import { loadSyntheticHospital, currentHour } from '../core/generator.js';
import { kpiContext, kpiTiles } from './kpi-tiles.js';
import { KPIS } from '../core/kpi.js';
import { fmtWholeMin } from '../core/walk.js';
import { waitingDecisions, proposalWords } from './proposals.js';

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

// What the flow strip counts. Each stage: { n, words } or nothing ("–", not counted yet). `wait`:
// the longest wait now between two stages, in whole minutes, only where the data holds one.
// Definitions and sources (example settings, not a standard):
// - Imaging. Arrive: open patient moves (ospeli_tasks_list, kind patient-move) going to Imaging.
//   Leave: open patient moves starting in Imaging plus journeys waiting for a vehicle from Imaging
//   (ospeli_transfers_board). Wait: the longest of those Leave waits (minutes since asked), between
//   Scan and Leave. Prep and Scan: no source holds imaging patients by stage, so not counted.
// - Outpatients (ospeli_clinics_day_summary, today's clinics). Arrive: booked, not arrived yet.
//   Wait: arrived, not called yet. Seen: with the clinician now. Leave: not counted. Wait: the longest
//   wait of anyone waiting now (minutes since arrival), between Wait and Seen.
// - Emergency. Leave: patients on the waiting-for-a-bed list (ospeli_beds_board). Wait: the longest
//   of them (minutes since the bed was asked for), between Treat and Leave. The rest: not counted
//   (the emergency department module is planned, not built).
// - Pharmacy (ospeli_pharmacy_overview, open requests by stage): Received = raised, Prepared =
//   being prepared, Checked = checked, Collected = ready to collect. Requests on hold are not in a stage.
// - Laboratory (ospeli_diagnostics_requests_list, current): Asked = not collected, Collected = on
//   the way, Received = in the lab, Done = results released in the last 24 h. Wait: the open request
//   longest in its stage (minutes in step), after that stage.
// - Wards: Arrive = waiting-for-a-bed list, Stay = occupied beds, Ready to leave = beds with an
//   expected discharge (ospeli_beds_board); Leave = journeys from a ward waiting for a vehicle
//   (ospeli_transfers_board). Wait: the longest of those waits, between Ready and Leave.
// - Whole hospital: Arrive and book = waiting in today's clinics; Test and treat = open lab
//   requests; Stay = occupied beds (with or without an expected discharge); Leave and move = journeys
//   waiting for a vehicle. Wait: the longest of those, between Stay and Leave.
export async function flowCounts(run, dept) {
  const read = async (name, input) => { try { return await run(name, input); } catch { return null; } };
  const c = {}; let wait = null;
  const put = (stage, n, words) => { c[stage] = { n, words }; };
  const longest = (between, list, minutes, words) => {
    const top = maxOf(list, minutes);
    if (top && minutes(top) >= 1) wait = { between, minutes: minutes(top), words };
  };
  if (dept.id === 'imaging') {
    const [tasks, board] = await Promise.all([read('ospeli_tasks_list', { kind: 'patient-move', limit: 500 }), read('ospeli_transfers_board', { limit: 500 })]);
    if (tasks) {
      put('arrive', tasks.tasks.filter((t) => t.toLocationId === dept.place).length, 'on the way in');
      const out = tasks.tasks.filter((t) => t.locationId === dept.place).map((t) => ({ min: t.waitMinutes }));
      const vans = board ? board.waiting.filter((j) => j.pickup?.id === dept.place).map((j) => ({ min: j.waitMinutes })) : [];
      put('leave', out.length + vans.length, 'waiting to leave');
      longest(['scan', 'leave'], [...out, ...vans], (x) => x.min || 0, 'waiting to leave');
    }
  } else if (dept.id === 'outpatients') {
    const day = await read('ospeli_clinics_day_summary', { limit: 200 });
    if (day) {
      const today = day.clinics.filter((x) => x.date === day.date);
      put('arrive', sum(today, (x) => x.counts?.toCome), 'still to arrive');
      put('wait', sum(today, (x) => x.counts?.waiting), 'waiting');
      put('seen', sum(today, (x) => x.counts?.withClinician), 'with the clinician');
      longest(['wait', 'seen'], today.filter((x) => x.counts?.waiting > 0), (x) => x.counts.longestWaitMinutes || 0, 'waiting to be seen');
    }
  } else if (dept.id === 'emergency' || dept.id === 'wards') {
    const [beds, board] = await Promise.all([read('ospeli_beds_board', { format: 'short' }), dept.id === 'wards' ? read('ospeli_transfers_board', { limit: 500 }) : null]);
    if (beds) {
      const bedWaits = beds.waiting.map((x) => ({ min: minutesSince(x.requestedAt, beds.asOf) }));
      if (dept.id === 'emergency') {
        put('leave', beds.waiting.length, 'waiting for a bed');
        longest(['treat', 'leave'], bedWaits, (x) => x.min, 'waiting for a bed');
      } else {
        put('arrive', beds.waiting.length, 'waiting for a bed');
        put('stay', sum(beds.wards, (w) => w.counts.occupied), 'in a bed');
        put('ready', sum(beds.wards, (w) => w.counts['expected-discharge']), 'expected to leave');
      }
    }
    if (board) {
      const out = board.waiting.filter((j) => inPlace(dept.place, j.pickup?.id));
      put('leave', out.length, 'waiting for a vehicle');
      longest(['ready', 'leave'], out, (j) => j.waitMinutes || 0, 'waiting for a vehicle');
    }
  } else if (dept.id === 'pharmacy') {
    const o = await read('ospeli_pharmacy_overview', {});
    if (o) {
      put('received', o.counts.raised || 0, 'received'); put('prepared', o.counts.started || 0, 'being prepared');
      put('checked', o.counts.checked || 0, 'checked'); put('collected', o.counts.ready || 0, 'ready to collect');
    }
  } else if (dept.id === 'laboratory') {
    const r = await read('ospeli_diagnostics_requests_list', { stage: 'current', limit: 500 });
    if (r) {
      const at = (s) => r.requests.filter((x) => x.state === s);
      put('asked', at('requested').length, 'not collected'); put('collected', at('collected').length, 'on the way');
      put('received', at('received').length, 'in the lab'); put('done', at('released').length, 'released in the last 24 h');
      const after = { requested: ['asked', 'collected'], collected: ['collected', 'received'], received: ['received', 'done'] };
      const open = r.requests.filter((x) => after[x.state]);
      const top = maxOf(open, (x) => x.minutesInStep || 0);
      if (top && top.minutesInStep >= 1) wait = { between: after[top.state], minutes: top.minutesInStep, words: `one request, ${top.stage.toLowerCase()}` };
    }
  } else if (dept.id === 'whole-hospital') {
    const [day, lab, beds, board] = await Promise.all([read('ospeli_clinics_day_summary', { limit: 200 }), read('ospeli_diagnostics_requests_list', { stage: 'current', limit: 500 }),
      read('ospeli_beds_board', { format: 'short' }), read('ospeli_transfers_board', { limit: 500 })]);
    if (day) put('arrive', sum(day.clinics.filter((x) => x.date === day.date), (x) => x.counts?.waiting), 'waiting in clinics');
    if (lab) put('test', lab.requests.filter((x) => ['requested', 'collected', 'received'].includes(x.state)).length, 'lab requests open');
    if (beds) put('stay', sum(beds.wards, (w) => (w.counts.occupied || 0) + (w.counts['expected-discharge'] || 0)), 'in a bed');
    if (board) { put('leave', board.waiting.length, 'waiting for a vehicle'); longest(['stay', 'leave'], board.waiting, (j) => j.waitMinutes || 0, 'waiting for a vehicle'); }
  }
  return { counts: c, wait };
}

// "Needs you, in flow order": what the person may need to act on, as cards labelled by stage and
// page, in the order of the department's flow. Agents' proposals waiting for this role are the
// first card (render below, in the same flow order); then open work orders in the department's place (ospeli_workorders_list), its
// equipment that is down (ospeli_diagnostics_equipment_list) and journeys from it waiting for a
// vehicle (ospeli_transfers_board). Each in words; nothing invented.
export async function needsYou(run, dept) {
  const read = async (name, input) => { try { return await run(name, input); } catch { return null; } };
  const stageOf = (page) => dept.stages.findIndex((s) => s.pages.includes(page));
  const items = new Map();
  const add = (page, chip, href = `#/${page}`) => {
    const i = stageOf(page);
    const key = `${i}:${page}`;
    const it = items.get(key) || { stage: i >= 0 ? dept.stages[i] : null, order: i >= 0 ? i : dept.stages.length, page, href, chips: [] };
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
    const mine = wo.workOrders.filter((w) => inPlace(dept.place, w.locationId));
    if (mine.length) { const late = mine.filter((w) => w.overdue).length; add('engineering', `${mine.length} open work ${mine.length === 1 ? 'order' : 'orders'}${late ? `, ${late} overdue` : ''}`); }
  }
  if (eq) {
    const down = eq.equipment.filter((e) => inPlace(dept.place, e.placeId) && e.state !== 'up');
    for (const e of down) add('diagnostics', `${e.name}: ${String(e.stateName || 'not working').toLowerCase()}`);
  }
  if (board) {
    const out = board.waiting.filter((j) => inPlace(dept.place, j.pickup?.id));
    if (out.length) { const late = out.filter((j) => j.late).length; add('transfers', `${out.length} waiting for a vehicle${late ? `, ${late} late` : ''}`); }
  }
  return [...items.values()].sort((a, b) => a.order - b.order || (a.stage ? a.stage.pages.indexOf(a.page) - a.stage.pages.indexOf(b.page) : 0));
}

// "From your walks": the latest map made from a walk, in one sentence (ospeli_maps_list, then
// ospeli_maps_summary: the same longest-wait rule as the map screen).
export async function latestWalk(run) {
  try {
    const list = await run('ospeli_maps_list', { limit: 200 });
    const m = list.maps.filter((x) => x.walk).sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))[0];
    if (!m) return null;
    const s = await run('ospeli_maps_summary', { mapId: m.id });
    const b = s.biggestWait;
    const sec = b ? (b.waitSec ?? b.wait * 60) : 0;
    return { id: m.id, title: s.title, text: b ? `longest wait ${b.atLeast ? 'at least ' : ''}${fmtWholeMin(sec)} before ${b.name}` : 'no wait of 30 seconds or more' };
  } catch { return null; }
}

function flowStrip(dept, flow) {
  const pick = h('div', { class: 'flow-pick', 'data-test': 'flow-pick', hidden: true });
  const tiles = [];
  dept.stages.forEach((s, i) => {
    const c = flow.counts[s.id];
    if (i > 0) {
      const w = flow.wait && flow.wait.between[1] === s.id ? flow.wait : null;
      tiles.push(h('span', { class: `flow-conn${w ? ' is-wait' : ''}`, 'aria-hidden': 'true', 'data-test': w ? 'flow-wait-bar' : null }, w ? '›' : ''));
    }
    const label = `${s.name}: ${c ? `${c.n} ${c.words}` : 'not counted yet'}. ${s.pages.length === 1 ? `Opens ${pageName(s.pages[0])}` : `Pages: ${s.pages.map(pageName).join(', ')}`}`;
    const body = [h('span', { class: 'flow-name' }, s.name), h('b', { class: 'flow-n' }, c ? String(c.n) : '–')];
    tiles.push(s.pages.length === 1
      ? h('a', { class: `flow-tile${c ? '' : ' is-none'}`, href: `#/${s.pages[0]}`, 'data-stage': s.id, 'aria-label': label }, body)
      : h('button', { type: 'button', class: `flow-tile${c ? '' : ' is-none'}`, 'data-stage': s.id, 'aria-label': label, 'aria-expanded': 'false', 'aria-controls': `flow-pick`,
        onclick: (e) => {
          const was = pick.dataset.stage === s.id && !pick.hidden;
          for (const b of e.currentTarget.parentNode.querySelectorAll('button.flow-tile')) b.setAttribute('aria-expanded', 'false');
          pick.hidden = was; pick.dataset.stage = s.id;
          if (!was) { e.currentTarget.setAttribute('aria-expanded', 'true'); pick.replaceChildren(h('p', { class: 'flow-pick-h' }, `${s.name}: pages that serve it`), h('ul', {}, s.pages.map((p) => h('li', {}, h('a', { href: `#/${p}` }, pageName(p)))))); }
        } }, body));
  });
  pick.id = 'flow-pick';
  const counted = dept.stages.filter((s) => flow.counts[s.id]);
  const none = dept.stages.filter((s) => !flow.counts[s.id]);
  const w = flow.wait;
  const between = w ? w.between.map((id) => dept.stages.find((s) => s.id === id)?.name) : null;
  return h('section', { class: 'flow', 'aria-labelledby': 'flow-h', 'data-test': 'now-flow' },
    h('h2', { id: 'flow-h', class: 'sr-only' }, `${dept.name} flow now`),
    h('div', { class: 'flow-strip', 'data-test': 'flow-strip' }, tiles),
    w ? h('p', { class: 'flow-wait', 'data-test': 'flow-wait' }, h('span', { class: 'flow-swatch', 'aria-hidden': 'true' }), h('span', { class: 'flow-arrow', 'aria-hidden': 'true' }, '→'),
      h('span', { class: 'flow-wait-text', title: w.words }, `Longest wait now: ${fmtWholeMin(w.minutes * 60)} before ${between[1]}`)) : null,
    h('p', { class: 'flow-key', 'data-test': 'flow-key' },
      // Left to right, as the tiles above: the number and what it counts, in words.
      counted.map((s) => `${flow.counts[s.id].n} ${flow.counts[s.id].words}`).join(' · '),
      none.length ? `${counted.length ? ' · ' : ''}${none.map((s) => s.name).join(', ')}: not counted yet` : '',
      ' · ', h('span', { class: 'flow-caption' }, 'Example setting, a site can edit these stages.')),
    pick,
  );
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

  // Issue #52: a decision an agent is waiting for is the first card under "Needs you", with one tap
  // to the page where it is made. Nothing is drawn when nothing waits for this role.
  const waitingBox = h('div', {});
  const needsBox = h('div', {});
  const drawWaiting = async () => {
    const waiting = await waitingDecisions(ctx);
    // In the department's flow order; pages on no stage of it last. Within a stage, the menu's order (#52).
    const stageAt = (id) => { const i = dept ? dept.stages.findIndex((s) => s.pages.includes(id)) : -1; return i < 0 ? Infinity : i; };
    const pages = [...waiting.pages].sort((a, b) => stageAt(a.id) - stageAt(b.id));
    const { total } = waiting;
    waitingBox.replaceChildren(...(total ? [h('section', { class: 'card decisions', 'data-test': 'decisions-waiting', 'aria-labelledby': 'dec-h' },
      h('h2', { id: 'dec-h' }, `Waiting for your decision (${total})`),
      h('p', { class: 'meta' }, 'An agent suggested these. Nothing changes until a person accepts or declines.'),
      h('ul', { class: 'decision-list' }, pages.map((x) => h('li', {},
        stageAt(x.id) < Infinity ? h('span', { class: 'needs-where', 'data-test': 'needs-where' }, `At ${dept.stages[stageAt(x.id)].name}`) : null,
        h('a', { href: x.href }, `${moduleById(x.id).name}${x.screenName ? `, ${x.screenName}` : ''}: ${proposalWords(x.count)}`)))))] : []));
    if (!dept) return;
    const list = await needsYou(ctx.run, dept);
    setKids(needsBox, list.length
      ? h('ol', { class: 'needs-list', 'data-test': 'needs-list' }, list.map((it) => h('li', {}, h('a', { class: 'card needs-card', href: it.href, 'data-stage': it.stage?.id || 'other', 'data-page': it.page },
        h('span', { class: 'needs-where', 'data-test': 'needs-where' }, `${it.stage ? `At ${it.stage.name}` : 'Elsewhere'} · ${pageName(it.page)}`),
        h('span', { class: 'needs-chips' }, it.chips.map((t) => h('span', { class: 'chip-word' }, t)))))))
      : total ? null : h('p', { class: 'meta', 'data-test': 'needs-none' }, 'Nothing needs you right now. Proposals, work orders, equipment and journeys for your department show here.'));
  };
  const [flow, walkLine] = await Promise.all([dept ? flowCounts(ctx.run, dept) : null, latestWalk(ctx.run), drawWaiting()]);
  const off = ctx.core.onChange(({ kind }) => { if (kind === 'proposals' || kind === 'reset') drawWaiting(); });

  const needs = dept ? h('section', { class: 'section needs', 'aria-labelledby': 'needs-h', 'data-test': 'now-needs' },
    h('h2', { id: 'needs-h' }, 'Needs you, in flow order'), waitingBox, needsBox) : waitingBox;
  const walks = walkLine ? h('section', { class: 'section', 'aria-labelledby': 'walks-h', 'data-test': 'now-walks' },
    h('h2', { id: 'walks-h' }, 'From your walks'),
    h('div', { class: 'card now-walk' }, h('p', { 'data-test': 'now-walk-line' }, `${walkLine.title}: ${walkLine.text}`),
      h('a', { href: `#/process/${walkLine.id}`, class: 'now-walk-link', 'data-test': 'now-walk-map' }, 'See map'))) : null;

  // Element.append would print a null child as the word "null" (issue #7), so drop them.
  el.append(...[
    h('div', { class: 'page-head' },
      h('div', {},
        h('p', { class: 'eyebrow' }, 'Now'),
        h('h1', {}, dept ? dept.name : 'Choose your department'),
        h('p', { 'data-test': 'now-role' }, `${role.name}. Your role is under Me; every page is under Journey.`))),
    dept ? flowStrip(dept, flow) : null,
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
  return off;
}
