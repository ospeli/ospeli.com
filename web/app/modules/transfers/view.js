// Transfers and vehicles: the screens. Every read and write goes through ctx.run, the same
// commands an agent would use, so the page works the same on a site's own server.
//   #/transfers/jobs     My jobs (driver, on a phone): pick the vehicle once a shift, the next job, one big button
//   #/transfers/board    Dispatch board (transport coordinator; patient flow coordinator; read-only for others)
//   #/transfers/request  Book a transfer (ward nurse, ED nurse in charge): picks only, nothing typed
//   #/transfers/fleet    Fleet status (fleet supervisor): daily checks, off the road and back, availability
// The role decides which screens it has and which opens first. Measures journeys and vehicles, never people.
import { h, setKids, fmtWait, moduleStyle } from '../ui.js';
import { roleById } from '../../core/model.js';
import { commandByName } from '../../core/commands.js';
import { proposalsCard } from '../proposals.js';

const can = (role, cmd) => !!commandByName(cmd)?.roles.includes(role);
const roleNames = (cmd) => (commandByName(cmd)?.roles || []).map((r) => roleById(r)?.name || r).join(', ');
const TITLES = { jobs: 'My jobs', board: 'Dispatch board', request: 'Book a transfer', fleet: 'Fleet status' };
function screensFor(role) {
  if (role === 'driver') return ['jobs', 'fleet'];
  if (role === 'transport-coordinator') return ['board', 'request', 'fleet'];
  if (role === 'fleet-supervisor') return ['fleet', 'board'];
  if (role === 'ward-nurse' || role === 'ae-nic') return ['request', 'board'];
  if (role === 'bed-manager') return ['board', 'request'];
  return ['board', 'fleet'];
}
const LOCK_MS = 3e3; // the next step's button cannot be tapped this long after a step (a second tap is not the next step)
const ORDINAL = ['First', 'Second', 'Third', 'Fourth', 'Fifth', 'Sixth', 'Seventh', 'Eighth', 'Ninth', 'Tenth'];
const fmtKpi = (k) => (k.value == null ? 'None yet' : k.unit === '%' ? `${Math.round(k.value)}%` : `${Math.round(k.value)} min`);
const STEP_CLASS = { 'arrived-pickup': 's-pickup', departed: 's-depart', 'arrived-destination': 's-arrive', 'handed-over': 's-hand' };

// Remembered on this device only (a vehicle id and the shift it was picked for, never sent, never
// about a person): the vehicle this phone's crew picked, so its jobs show until the shift ends.
const store = {
  get() { try { return JSON.parse(localStorage.getItem('ospeli-transfers-vehicle') || 'null'); } catch { return null; } },
  set(v) { try { if (v) localStorage.setItem('ospeli-transfers-vehicle', JSON.stringify(v)); else localStorage.removeItem('ospeli-transfers-vehicle'); } catch { /* still works for this visit */ } },
};

export async function render(el, ctx) {
  await moduleStyle('transfers');
  const screens = screensFor(ctx.role);
  const screen = screens.includes(ctx.rest[0]) ? ctx.rest[0] : screens[0];
  const head = h('div', { class: 'page-head' }, h('div', {}, h('p', { class: 'eyebrow' }, 'Transfers and vehicles'), h('h1', {}, TITLES[screen])));
  const tabs = screens.length > 1 ? h('nav', { class: 'trf-tabs', 'aria-label': 'Transfers and vehicles' },
    screens.map((s) => h('a', { href: `#/transfers/${s}`, 'data-screen': s, 'aria-current': s === screen ? 'page' : null }, TITLES[s]))) : null;
  const view = { jobs: jobsScreen, board: boardScreen, request: requestScreen, fleet: fleetScreen }[screen](ctx);
  // The shell moves the page's children into <main>, so the module's class goes on its own wrapper.
  el.append(h('div', { class: 'mod-transfers trf', 'data-screen': screen, 'data-role': ctx.role }, head, tabs, view.el));
  await view.load();
  let t = null;
  const off = ctx.core.onChange(({ kind }) => {
    if (!['event', 'events', 'reset', 'proposals'].includes(kind)) return;
    clearTimeout(t);
    t = setTimeout(() => view.load(), 100);
  });
  const tick = setInterval(() => view.load(), 60e3); // keep the waits fresh
  return () => { off(); clearInterval(tick); clearTimeout(t); view.stop?.(); };
}

// One command for a person, safely: a second tap while the first runs does nothing.
function runner(ctx, reload) {
  let busy = false;
  return async function act(cmd, input, words, { onDone = null, onError = null } = {}) {
    if (busy) return null;
    busy = true;
    try {
      const out = await ctx.run(cmd, input);
      if (words) ctx.toast(words);
      if (onDone) onDone(out);
      return out;
    } catch (err) {
      if (onError && onError(err)) return null;
      ctx.toast(`Not saved. ${err.message}`);
      return null;
    } finally {
      busy = false;
      await reload();
    }
  };
}

// One journey, the way every screen shows it: what and when, from and to, and what it needs.
function facts(t, { big = false } = {}) {
  const wait = t.state === 'waiting' && t.needed === 'asap' ? `Waiting ${fmtWait(t.waitMinutes)}` : null;
  return [
    h('p', { class: 'trf-what' }, h(big ? 'b' : 'span', { class: 'trf-type' }, t.typeName),
      h('span', { class: `chip trf-when${t.needed === 'booked' ? ' is-booked' : ''}` }, t.neededText),
      t.late ? h('span', { class: 'chip trf-late', 'data-test': 'late' }, 'Late') : null,
      t.delays.length ? h('span', { class: 'chip trf-delay', 'data-test': 'delayed' }, `Delayed: ${t.delays.at(-1).reasonName.toLowerCase()}`) : null),
    h('p', { class: 'trf-where' }, h('span', {}, 'From '), h('b', {}, t.pickup.name), t.pickup.siteName ? h('span', { class: 'trf-site' }, `, ${t.pickup.siteName}`) : null),
    h('p', { class: 'trf-where' }, h('span', {}, 'To '), h('b', {}, t.destination.name)),
    h('ul', { class: 'trf-needs', 'aria-label': 'What it needs' },
      h('li', { class: 'chip' }, t.mobilityName), h('li', { class: 'chip' }, t.escortName),
      t.equipment.filter((x) => x.id !== 'none').map((x) => h('li', { class: 'chip' }, x.name))),
    wait ? h('p', { class: 'trf-wait', 'data-test': 'wait' }, wait) : null,
  ];
}
const stateChip = (t) => h('span', { class: `chip trf-st st-${t.state}` }, t.stateName);
const reasonButtons = (list, onPick, attrs) => h('div', { class: 'trf-reasons' }, list.map((r) => h('button', { class: 'btn btn-ghost btn-small', type: 'button', ...attrs, 'data-reason': r.id, onclick: () => onPick(r) }, r.name)));
const detailsBox = (label, test, ...kids) => h('details', { class: 'trf-more', 'data-test': test }, h('summary', {}, label), ...kids);

// ---------------------------------------------------------------- My jobs (driver, phone)
function jobsScreen(ctx) {
  const box = h('div', { class: 'trf-jobs' });
  let data = null;
  let lastStepAt = 0; // when this phone tapped a step, for the pause on the next one
  let timer = null;
  const load = async () => {
    const b = await ctx.run('ospeli_transfers_board', { format: 'short', limit: 1 });
    let mine = store.get();
    if (mine && (mine.shiftStart !== b.shift.start || !b.vehicles.some((v) => v.id === mine.vehicleId))) { store.set(null); mine = null; }
    const jobs = mine ? await ctx.run('ospeli_transfers_jobs', { vehicleId: mine.vehicleId, limit: 20 }) : null;
    data = { b, mine, jobs };
    draw();
  };
  const act = runner(ctx, load);
  const pick = (v) => act('ospeli_transfers_vehicle_crew', { vehicleId: v.id, crewed: true }, `${v.name}: crewed for this shift`, {
    onDone: () => store.set({ vehicleId: v.id, shiftStart: data.b.shift.start }),
    onError: (err) => { if (err.detail?.alreadyCrewed) { store.set({ vehicleId: v.id, shiftStart: data.b.shift.start }); ctx.toast(`${v.name} is already crewed this shift. This phone now shows its jobs.`); return true; } return false; },
  });
  const release = (v) => act('ospeli_transfers_vehicle_crew', { vehicleId: v.id, crewed: false }, `${v.name} released`, {
    onDone: () => store.set(null), onError: (err) => { if (err.code === 'conflict') { store.set(null); return true; } return false; } });

  function pickScreen() {
    const { b } = data;
    if (!b.vehicles.length) return h('div', { class: 'card notice', 'data-test': 'no-vehicles' }, h('p', {}, 'No vehicles are set up on this device yet.'),
      h('p', { class: 'meta' }, 'A hospital loaded before vehicles were added has none. Load Example General Hospital again on the ', h('a', { href: '#/data' }, 'Data and audit'), ' page.'));
    const mayCrew = can(ctx.role, 'ospeli_transfers_vehicle_crew');
    return h('section', { class: 'trf-card', 'data-test': 'pick-vehicle', 'aria-labelledby': 'trf-pick-h' },
      h('h2', { id: 'trf-pick-h', class: 'trf-label' }, 'Which vehicle are you on?'),
      h('p', { class: 'trf-hint' }, `${b.shift.name}, until ${b.shift.endText.replace(/^today /, '')}. Tap your vehicle once; this phone keeps it until the shift ends.`),
      h('div', { class: 'trf-vpick' }, b.vehicles.map((v) => {
        const off = v.state === 'off-road';
        const n = v.assignedJobs.length + (v.currentJob ? 1 : 0);
        return h('button', { class: `btn btn-big trf-vbtn${off ? ' is-off' : ''}`, type: 'button', 'data-cmd': 'ospeli_transfers_vehicle_crew', 'data-vehicle': v.id, disabled: off || !mayCrew,
          onclick: (e) => { e.currentTarget.disabled = true; pick(v); } },
        h('span', { class: 'trf-vname' }, v.name),
        h('span', { class: 'trf-vsub' }, off ? `Off the road: ${v.offRoad.reasonName.toLowerCase()}` : `${v.siteName} · ${n ? `${n} ${n === 1 ? 'job' : 'jobs'}` : 'no job yet'}${v.crewed ? ' · crewed' : ''}`));
      })));
  }

  function draw() {
    clearTimeout(timer);
    if (!data.mine || !data.jobs) { setKids(box, pickScreen()); return; }
    const { jobs, b } = data;
    const v = jobs.vehicle;
    const [next, ...after] = jobs.jobs;
    const since = Date.now() - lastStepAt;
    const locked = since < LOCK_MS;
    const bar = h('div', { class: 'trf-vbar', 'data-test': 'my-vehicle', 'data-vehicle': v.id },
      h('p', {}, h('b', {}, v.name), ` · ${b.shift.name.toLowerCase()} until ${b.shift.endText.replace(/^today /, '')}`),
      detailsBox('End of shift', 'release', h('p', { class: 'meta' }, `Release ${v.name} when your shift ends, so the board shows it has no crew.`),
        h('button', { class: 'btn btn-ghost btn-small', type: 'button', 'data-cmd': 'ospeli_transfers_vehicle_crew', 'data-test': 'release-vehicle', onclick: () => release(v) }, `Release ${v.name}`)));
    const warn = [
      v.state === 'off-road' ? h('p', { class: 'card notice trf-alert', 'data-test': 'off-road' }, `${v.name} is off the road (${v.offRoad.reasonName.toLowerCase()}). Do not use it. The coordinator will move its jobs.`) : null,
      !v.lastCheck?.today ? h('p', { class: 'trf-checkdue', 'data-test': 'check-due' }, 'Daily check not done today. ', h('a', { href: '#/transfers/fleet' }, 'Do the daily check')) : null,
    ];
    let card;
    if (next) {
      const s = next.nextStep;
      const underWay = next.state !== 'assigned';
      card = h('section', { class: `trf-card${underWay ? ' is-under-way' : ''}`, 'data-test': 'next-job', 'data-transfer': next.id, 'data-state': next.state, 'aria-labelledby': 'trf-next-h' },
        h('p', { class: 'trf-label', id: 'trf-next-h' }, underWay ? 'Job under way' : 'Next job'),
        facts(next, { big: true }),
        h('p', { class: 'trf-bay' }, next.bayMove ? 'Move to the vehicle bay: asked for' : 'Move to the vehicle bay: not asked for'),
        next.vehicleOffRoad ? null : [
          h('ol', { class: 'trf-steps', 'data-test': 'steps' }, next.steps.map((x) => h('li', { class: x.at ? 'is-done' : x.id === s?.id ? 'is-next' : null, 'data-step': x.id },
            h('span', {}, x.label), h('span', { class: 'trf-steptime' }, x.at ? x.clock.replace(/^today /, '') : x.id === s?.id ? 'next' : '')))),
          s ? h('button', { class: `btn btn-big trf-main ${STEP_CLASS[s.id]}`, type: 'button', 'data-test': 'main-action', 'data-cmd': 'ospeli_transfers_step', 'data-step': s.id, 'data-transfer': next.id,
            disabled: locked, 'aria-disabled': String(locked),
            onclick: (e) => { e.currentTarget.disabled = true; act('ospeli_transfers_step', { transferId: next.id, step: s.id, expectedState: next.state }, `${s.label}: ${next.id}`, { onDone: () => { lastStepAt = Date.now(); } }); } },
          stepText(s, since)) : null,
        ],
        h('p', { class: 'trf-pos' }, `${ORDINAL[0]} of ${jobs.total} ${jobs.total === 1 ? 'job' : 'jobs'} for ${v.name}.`));
      if (locked) timer = setTimeout(draw, 1000);
    } else {
      card = h('section', { class: 'trf-card', 'data-test': 'next-job', 'data-state': 'empty', 'aria-labelledby': 'trf-next-h' },
        h('p', { class: 'trf-label', id: 'trf-next-h' }, 'Next job'),
        h('p', { class: 'trf-empty', 'data-test': 'jobs-empty' }, `No job for ${v.name} right now.`),
        h('p', { class: 'meta' }, `New jobs show here by themselves when the coordinator gives one to ${v.name}.${jobs.handedOverThisShift ? ` Handed over this shift: ${jobs.handedOverThisShift}.` : ''}`));
    }
    setKids(box, bar, warn, card,
      after.length ? h('section', { class: 'trf-list', 'aria-labelledby': 'trf-after-h' }, h('h2', { id: 'trf-after-h' }, `Next in line (${after.length})`),
        h('ul', {}, after.map((t) => h('li', { class: 'trf-row', 'data-transfer': t.id }, h('div', { class: 'trf-row-text' }, facts(t)))))) : null);
  }
  const stepText = (s, since) => (since < LOCK_MS ? `${s.label} (wait ${Math.ceil((LOCK_MS - since) / 1000)} s)` : s.label);
  return { el: box, load, stop: () => clearTimeout(timer) };
}

// ---------------------------------------------------------------- Dispatch board
function boardScreen(ctx) {
  const box = h('div', { class: 'trf-board' });
  const ui = { filter: 'all', pickedVehicle: new Map(), status: new Map() }; // kept across redraws
  let data = null;
  const props = proposalsCard(ctx, { match: (p) => /^ospeli_transfers_/.test(p.command), describe: (p) => describeProposal(p, data) });
  const load = async () => {
    data = await ctx.run('ospeli_transfers_board', { days: 7, limit: 200 });
    draw();
    await props.load();
  };
  const act = runner(ctx, load);
  const mayAssign = can(ctx.role, 'ospeli_transfers_assign');
  const mayDelay = can(ctx.role, 'ospeli_transfers_delay');
  const mayCancel = can(ctx.role, 'ospeli_transfers_cancel');

  function assignBox(t) {
    const usable = data.vehicles.filter((v) => v.state !== 'off-road' && v.id !== t.vehicleId);
    const sel = h('select', { 'aria-label': `Vehicle for ${t.id}`, 'data-test': 'assign-vehicle' }, h('option', { value: '' }, t.vehicleId ? 'Move to another vehicle' : 'Choose a vehicle'),
      usable.map((v) => h('option', { value: v.id }, `${v.name}: ${v.stateName.toLowerCase()}, ${v.crewed ? 'crewed' : 'no crew yet'}`)));
    sel.value = ui.pickedVehicle.get(t.id) || '';
    sel.addEventListener('change', () => { ui.pickedVehicle.set(t.id, sel.value); ui.status.delete(t.id); });
    const status = h('p', { class: 'trf-status', role: 'status' }, ui.status.get(t.id) || '');
    return h('div', { class: 'trf-assign' }, sel,
      h('button', { class: 'btn btn-small', type: 'button', 'data-cmd': 'ospeli_transfers_assign', 'data-test': 'assign',
        onclick: () => {
          if (!sel.value) { ui.status.set(t.id, 'Choose a vehicle first.'); status.textContent = 'Choose a vehicle first.'; return; }
          const v = data.vehicles.find((x) => x.id === sel.value);
          act('ospeli_transfers_assign', { transferId: t.id, vehicleId: sel.value, expectedState: t.state }, `${t.id} given to ${v.name}`, { onDone: () => ui.pickedVehicle.delete(t.id) });
        } }, t.vehicleId ? 'Move' : 'Give to vehicle'), status);
  }
  function row(t) {
    const departed = ['on-the-way', 'at-destination'].includes(t.state);
    return h('li', { class: `trf-row${t.late ? ' is-late' : ''}${t.vehicleOffRoad ? ' is-late' : ''}`, 'data-transfer': t.id, 'data-type': t.type },
      h('div', { class: 'trf-row-text' }, facts(t),
        t.vehicleId ? h('p', { class: 'trf-onv' }, stateChip(t), ` ${t.vehicleName}`, t.vehicleOffRoad ? h('b', { class: 'trf-warn', 'data-test': 'vehicle-off-road' }, ': vehicle off the road, give it to another') : null) : null,
        h('p', { class: 'trf-id meta' }, t.id)),
      h('div', { class: 'trf-row-acts' },
        mayAssign && ['waiting', 'assigned'].includes(t.state) ? assignBox(t) : null,
        mayDelay ? detailsBox('Mark delayed', 'delay', h('p', { class: 'meta' }, 'Why? It keeps its place in the queue.'),
          reasonButtons(data.picks.delayReasons, (r) => act('ospeli_transfers_delay', { transferId: t.id, reason: r.id }, `${t.id} delayed: ${r.name.toLowerCase()}`), { 'data-cmd': 'ospeli_transfers_delay' })) : null,
        mayCancel && !departed ? detailsBox('Cancel', 'cancel', h('p', { class: 'meta' }, 'Why?'),
          reasonButtons(data.picks.cancelReasons, (r) => act('ospeli_transfers_cancel', { transferId: t.id, reason: r.id }, `${t.id} cancelled`), { 'data-cmd': 'ospeli_transfers_cancel' })) : null));
  }
  function draw() {
    const d = data;
    const c = d.counts;
    const shown = (list) => list.filter((t) => ui.filter === 'all' || t.type === 'discharge');
    const longest = d.waiting.filter((t) => t.needed === 'asap').reduce((m, t) => Math.max(m, t.waitMinutes), 0);
    const readOnly = !mayAssign && !mayDelay && !mayCancel;
    setKids(box,
      props.el,
      h('div', { class: 'trf-counts', 'data-test': 'board-counts' },
        h('div', { class: 'stat', 'data-count': 'waiting' }, h('span', {}, 'Waiting'), h('b', {}, String(c.waiting)), h('span', {}, longest ? `longest ${fmtWait(longest)}` : 'none long')),
        h('div', { class: 'stat', 'data-count': 'vehicles' }, h('span', {}, 'Free vehicles'), h('b', {}, `${c.vehiclesFree} of ${d.vehicles.length}`), h('span', {}, `${d.vehicles.filter((v) => v.state === 'free' && v.crewed).length} crewed`)),
        h('div', { class: `stat${c.vehiclesOffRoad || c.late ? ' is-alert' : ''}`, 'data-count': 'road' }, h('span', {}, 'On the road'), h('b', {}, String(c.onTheRoad)),
          h('span', {}, [c.vehiclesOffRoad ? `${c.vehiclesOffRoad} off road` : null, c.late ? `${c.late} late` : null].filter(Boolean).join(', ') || 'none late'))),
      h('p', { class: 'meta trf-countline', 'data-test': 'count-line' }, `Discharges waiting for transport: ${c.dischargesWaiting}. Given to a vehicle, not yet at pickup: ${c.assigned}. Off the road: ${c.vehiclesOffRoad}.`),
      readOnly ? h('p', { class: 'meta', 'data-test': 'read-only' }, `${roleById(ctx.role).name} can see the board. Vehicles are given by ${roleNames('ospeli_transfers_assign')}.`) : null,
      h('section', { class: 'section', 'aria-labelledby': 'trf-q-h' }, h('h2', { id: 'trf-q-h' }, `Waiting for a vehicle (${shown(d.waiting).length})`),
        h('p', { class: 'meta' }, 'In the order they are needed: a booked time, or when an as-soon-as-possible request was made.'),
        h('div', { class: 'chips', role: 'group', 'aria-label': 'Show' }, [['all', 'All journeys'], ['discharge', 'Discharges only']].map(([id, label]) => h('button', {
          class: 'chip-btn', type: 'button', 'aria-pressed': String(ui.filter === id), 'data-filter': id, onclick: () => { ui.filter = id; draw(); box.querySelector(`[data-filter="${id}"]`)?.focus(); } }, label))),
        shown(d.waiting).length ? h('ul', { class: 'trf-rows', 'data-test': 'queue' }, shown(d.waiting).map(row)) : h('p', { class: 'trf-empty', 'data-test': 'queue-empty' }, 'Nothing is waiting for a vehicle.')),
      h('section', { class: 'section', 'aria-labelledby': 'trf-v-h' }, h('h2', { id: 'trf-v-h' }, `Vehicles (${d.vehicles.length})`),
        d.vehicles.length ? h('ul', { class: 'trf-vlist', 'data-test': 'vehicles' }, d.vehicles.map((v) => h('li', { class: `trf-vrow st-${v.state}`, 'data-vehicle': v.id, 'data-state': v.state },
          h('b', {}, v.name), h('span', { class: 'meta' }, ` ${v.siteName}`),
          h('span', { class: `chip trf-vst st-${v.state}` }, v.stateName), h('span', { class: `chip${v.crewed ? ' trf-ok' : ''}`, 'data-test': 'crewed' }, v.crewed ? 'Crewed' : 'No crew'),
          v.currentJob ? h('span', { class: 'meta' }, ` · ${v.currentJob}`) : null, v.assignedJobs.length ? h('span', { class: 'meta' }, ` · ${v.assignedJobs.length} next`) : null,
          v.checkFailing ? h('span', { class: 'chip trf-late' }, 'Failed check') : null)))
          : h('p', { class: 'card notice', 'data-test': 'no-vehicles' }, 'No vehicles are set up on this device. A hospital loaded before vehicles were added has none.')),
      h('section', { class: 'section', 'aria-labelledby': 'trf-o-h' }, h('h2', { id: 'trf-o-h' }, `With a vehicle (${shown(d.open).length})`),
        shown(d.open).length ? h('ul', { class: 'trf-rows', 'data-test': 'open' }, shown(d.open).map(row)) : h('p', { class: 'meta' }, 'No journey is with a vehicle.')),
      guideCard(ctx, d.guide, act),
      kpiSection(d),
      h('p', { class: 'card meta notice', 'data-test': 'not-for' }, d.note));
  }
  return { el: box, load };
}

function guideCard(ctx, g, act, { only = null } = {}) {
  const mayToggle = can(ctx.role, 'ospeli_transfers_guide_set');
  const list = only ? g.suggestions.filter((s) => s.rule === only) : g.suggestions;
  const asked = new Set(); // a fault report waiting for its priority
  const card = h('section', { class: 'card trf-guide', 'data-test': 'guide', 'data-on': String(g.on), 'aria-labelledby': 'trf-guide-h' });
  const draw = () => setKids(card,
    h('div', { class: 'trf-guide-head' }, h('h2', { id: 'trf-guide-h' }, 'Guide'),
      mayToggle ? h('button', { class: 'btn btn-ghost btn-small guide-switch', type: 'button', 'aria-pressed': String(g.on), 'data-cmd': 'ospeli_transfers_guide_set', 'data-test': 'guide-switch',
        onclick: () => act('ospeli_transfers_guide_set', { on: !g.on }, `Guide ${g.on ? 'off' : 'on'}`) }, g.on ? 'Guide on: switch off' : 'Guide off: switch on') : null),
    g.on ? [
      h('p', { class: 'meta' }, 'Fixed rules, not AI. They suggest; you decide. Nothing changes until you tap.'),
      list.length ? h('ul', { class: 'trf-sugg' }, list.map((s) => h('li', { 'data-rule': s.rule, 'data-test': 'suggestion' },
        h('p', {}, h('b', {}, s.text)), h('p', { class: 'meta' }, s.why),
        (s.actions || []).length ? h('div', { class: 'actions' }, s.actions.map((a) => {
          if (!can(ctx.role, a.command)) return h('p', { class: 'meta' }, `${a.label}: ${roleNames(a.command)}.`);
          if (a.needs === 'priority') {
            if (!asked.has(s.id)) return h('button', { class: 'btn btn-ghost btn-small', type: 'button', 'data-test': 'report-fault', onclick: () => { asked.add(s.id); draw(); card.querySelector('[data-priority]')?.focus(); } }, a.label);
            return h('div', { class: 'trf-ask', 'data-test': 'fault-priority' }, h('p', {}, h('b', {}, `How soon must "${a.input.fault}" be fixed?`)),
              h('div', { class: 'trf-reasons' }, [['urgent', 'Urgent: unsafe now'], ['high', 'High: needed today'], ['routine', 'Routine: can wait']].map(([p, label]) => h('button', {
                class: 'btn btn-small', type: 'button', 'data-cmd': a.command, 'data-priority': p, onclick: () => act(a.command, { ...a.input, priority: p }, `Fault reported: ${a.input.fault}`, {
                  onError: (err) => { if (err.code === 'conflict') { ctx.toast(`Already reported. ${err.message}`); return true; } return false; } }) }, label))));
          }
          return h('button', { class: 'btn btn-small', type: 'button', 'data-cmd': a.command, 'data-test': 'follow', onclick: () => act(a.command, a.input, a.label) }, a.label);
        })) : null,
        h('details', { class: 'trf-def' }, h('summary', {}, 'Why this rule'), h('p', {}, s.basis)))))
        : h('p', { 'data-test': 'no-suggestion' }, 'Nothing to suggest right now.'),
    ] : h('p', { 'data-test': 'guide-off' }, 'The guide is off. Booking, the board, the jobs and the measures work the same.'),
    mayToggle ? null : h('p', { class: 'meta' }, `${roleNames('ospeli_transfers_guide_set')} can switch the guide on or off.`));
  draw();
  return card;
}

function kpiSection(d, ids = null) {
  const list = ids ? d.kpis.filter((k) => ids.includes(k.id)) : d.kpis;
  const sub = (k) => {
    if (k.id === 'on-time-pickup') return `${k.numerator ?? 0} of ${k.denominator ?? 0} booked pickups on time${k.leftOut ? `; ${k.leftOut} left out (requester's reason)` : ''}`;
    if (k.id === 'fleet-availability') return `${Math.round(k.numerator || 0)} of ${Math.round(k.denominator || 0)} scheduled vehicle-hours in service. Crewed: ${Math.round(k.crewedHours || 0)} vehicle-hours.`;
    return `Median of ${k.n} journeys${k.p90 != null ? `; 90th percentile ${Math.round(k.p90)} min` : ''}`;
  };
  return h('section', { class: 'section', 'aria-labelledby': 'trf-kpi-h' },
    h('h2', { id: 'trf-kpi-h' }, `Measures, last ${d.period.days} days`),
    h('p', { class: 'meta' }, 'Calculated from the event log on this device. They count journeys and vehicles, never a driver or a crew.'),
    h('div', { class: 'trf-kpis' }, list.map((k) => h('div', { class: 'card trf-kpi', 'data-kpi': k.id, 'data-n': k.n },
      h('p', { class: 'trf-kpi-name' }, k.name), h('p', { class: 'trf-kpi-value' }, fmtKpi(k)), h('p', { class: 'meta' }, sub(k)),
      k.breakdown?.filter((b) => b.n).length ? h('ul', { class: 'trf-breakdown' }, k.breakdown.filter((b) => b.n).map((b) => h('li', {}, `${b.name}: ${fmtKpi({ ...b, unit: k.unit })} (${b.n})`))) : null,
      h('details', { class: 'trf-def' }, h('summary', {}, 'How it is counted'),
        h('p', {}, k.definition), h('p', {}, `Counts: ${k.counts}`), h('p', {}, `Out of: ${k.outOf}`), h('p', {}, `Leaves out: ${k.leavesOut}`), h('p', {}, `Source: ${k.source}`), h('p', {}, `Target: ${k.targetText}`))))));
}

function describeProposal(p, data) {
  const t = data ? [...data.waiting, ...data.open].find((x) => x.id === p.input.transferId) : null;
  const v = (id) => data?.vehicles.find((x) => x.id === id)?.name || 'a vehicle';
  const job = t ? `${t.id}, ${t.typeName.toLowerCase()} from ${t.pickup.name}` : 'a journey that is no longer open';
  switch (p.command) {
    case 'ospeli_transfers_request': return `Book a transfer: ${data?.picks?.types.find((x) => x.id === p.input.type)?.name || 'journey'} from ${data?.places?.wards.concat(data.places.departments).find((x) => x.id === p.input.fromPlace)?.name || 'a ward'}`;
    case 'ospeli_transfers_assign': return `Give ${job} to ${v(p.input.vehicleId)}`;
    case 'ospeli_transfers_step': return `Step ${p.input.step}: ${job}`;
    case 'ospeli_transfers_delay': return `Mark delayed (${p.input.reason}): ${job}`;
    case 'ospeli_transfers_cancel': return `Cancel (${p.input.reason}): ${job}`;
    case 'ospeli_transfers_vehicle_crew': return `${p.input.crewed ? 'Crew' : 'Release'} ${v(p.input.vehicleId)} for this shift`;
    case 'ospeli_transfers_vehicle_check': return `Daily check of ${v(p.input.vehicleId)}: ${(p.input.failed || []).length} failed`;
    case 'ospeli_transfers_vehicle_status': return `${p.input.status === 'off-road' ? 'Take off the road' : 'Back in service'}: ${v(p.input.vehicleId)}`;
    default: return p.command;
  }
}

// ---------------------------------------------------------------- Book a transfer (ward, phone)
function requestScreen(ctx) {
  const box = h('div', { class: 'trf-request' });
  const status = h('div', { role: 'status', 'data-test': 'req-status' });
  const openBox = h('div', { 'data-test': 'req-open' });
  // Nothing is chosen in advance: each question is answered by a tap (equipment "None" included).
  const pick = { type: null, to: null, needed: null, slot: '', mobility: null, escort: null, equipment: new Set(), bay: false };
  let data = null;
  let busy = false;
  const form = h('form', { class: 'card trf-form', 'aria-labelledby': 'req-h', 'data-test': 'req-form' });
  const from = h('select', { id: 'req-from', 'data-test': 'req-from' });
  const slot = h('select', { id: 'req-slot', 'data-test': 'req-slot' });
  const send = h('button', { class: 'btn btn-big', type: 'submit', 'data-cmd': 'ospeli_transfers_request', 'data-test': 'req-send' }, 'Book transfer');
  const groups = {};
  const group = (key, label) => { groups[key] = h('div', { class: 'trf-choices', role: 'group', 'aria-labelledby': `req-${key}-l` }); return h('div', { class: 'field', 'data-field': key }, h('span', { class: 'label', id: `req-${key}-l` }, label), groups[key]); };
  const slotField = h('div', { class: 'field', hidden: true }, h('label', { for: 'req-slot' }, 'Booked time (site time)'), slot);
  const bay = h('input', { type: 'checkbox', id: 'req-bay', 'data-test': 'req-bay' });
  bay.addEventListener('change', () => { pick.bay = bay.checked; });
  let lastFrom = null;
  try { lastFrom = localStorage.getItem('ospeli-transfers-from'); } catch { /* none */ }
  from.addEventListener('change', () => { try { if (from.value) localStorage.setItem('ospeli-transfers-from', from.value); } catch { /* still works */ } drawForm(); drawOpen(); });
  slot.addEventListener('change', () => { pick.slot = slot.value; });

  const choice = (label, pressed, onclick, attrs = {}) => h('button', { class: 'chip-btn trf-choice', type: 'button', 'aria-pressed': String(pressed), onclick, ...attrs }, label);
  const refocus = (key, sel) => groups[key].querySelector(sel)?.focus();
  function destinations() {
    const fromSite = [...data.places.wards, ...data.places.departments].find((x) => x.id === from.value)?.siteId;
    const sites = data.places.sites.filter((s) => s.id !== fromSite).map((s) => ({ key: `site:${s.id}`, name: s.name }));
    const outside = data.picks.outside.map((o) => ({ key: `out:${o.id}`, name: o.name }));
    if (pick.type === 'between-sites') return sites;
    if (pick.type === 'discharge') return outside;
    if (pick.type === 'to-provider') return outside.filter((o) => o.key !== 'out:home');
    return [...sites, ...outside];
  }
  function drawForm() {
    const p = data.picks;
    groups.type.replaceChildren(...p.types.map((t) => choice(t.name, pick.type === t.id, () => { pick.type = t.id; if (!destinations().some((d) => d.key === pick.to)) pick.to = null; drawForm(); refocus('type', `[data-type="${t.id}"]`); }, { 'data-type': t.id, title: t.hint })));
    const dests = pick.type ? destinations() : [];
    groups.to.replaceChildren(...(dests.length ? dests.map((d) => choice(d.name, pick.to === d.key, () => { pick.to = d.key; drawForm(); refocus('to', `[data-to="${d.key}"]`); }, { 'data-to': d.key })) : [h('p', { class: 'meta' }, 'Choose the kind of journey first.')]));
    groups.when.replaceChildren(...[['asap', 'As soon as possible'], ['booked', 'At a booked time']].map(([id, label]) => choice(label, pick.needed === id, () => { pick.needed = id; drawForm(); refocus('when', `[data-when="${id}"]`); }, { 'data-when': id })));
    slotField.hidden = pick.needed !== 'booked';
    groups.mobility.replaceChildren(...p.mobility.map((m) => choice(m.name, pick.mobility === m.id, () => { pick.mobility = m.id; drawForm(); refocus('mobility', `[data-mobility="${m.id}"]`); }, { 'data-mobility': m.id })));
    groups.escort.replaceChildren(...p.escort.map((m) => choice(m.name, pick.escort === m.id, () => { pick.escort = m.id; drawForm(); refocus('escort', `[data-escort="${m.id}"]`); }, { 'data-escort': m.id })));
    groups.equipment.replaceChildren(...p.equipment.map((m) => choice(m.name, pick.equipment.has(m.id), () => {
      if (m.id === 'none') { pick.equipment = new Set(pick.equipment.has('none') ? [] : ['none']); } else { pick.equipment.delete('none'); if (pick.equipment.has(m.id)) pick.equipment.delete(m.id); else pick.equipment.add(m.id); }
      drawForm(); refocus('equipment', `[data-equipment="${m.id}"]`);
    }, { 'data-equipment': m.id })));
  }
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (busy) return;
    const missing = !pick.type ? 'the kind of journey' : !from.value ? 'where from' : !pick.to ? 'where to' : !pick.needed ? 'when' : pick.needed === 'booked' && !pick.slot ? 'the booked time'
      : !pick.mobility ? 'how the patient travels' : !pick.escort ? 'the escort' : !pick.equipment.size ? 'the equipment (or No equipment)' : null;
    if (missing) { setKids(status, h('p', { class: 'trf-status' }, `Choose ${missing} first.`)); return; }
    const [kind, dest] = pick.to.split(':');
    const input = { type: pick.type, fromPlace: from.value, ...(kind === 'site' ? { toSite: dest } : { toOutside: dest }), needed: pick.needed, ...(pick.needed === 'booked' ? { bookedFor: pick.slot } : {}),
      mobility: pick.mobility, escort: pick.escort, equipment: [...pick.equipment], bayMove: pick.bay };
    busy = true; send.disabled = true;
    try {
      const out = await ctx.run('ospeli_transfers_request', input);
      await load();
      setKids(status, h('div', { class: 'card trf-result', 'data-test': 'req-done' }, h('p', {}, h('b', {}, `Booked: ${out.transferId}.`), ` ${ORDINAL[out.queuePosition - 1] || `Number ${out.queuePosition}`} of ${out.waiting} waiting for a vehicle.`),
        h('p', { class: 'meta' }, 'The transport coordinator gives it to a vehicle. You can see it below, with its status.')));
      ctx.toast(`Booked: ${out.transferId}`);
      Object.assign(pick, { type: null, to: null, needed: null, slot: '', mobility: null, escort: null, equipment: new Set(), bay: false });
      bay.checked = false;
      drawForm();
    } catch (err) {
      setKids(status, h('p', { class: 'trf-status' }, err.code === 'conflict' && err.detail?.existing ? `Already saved: ${err.detail.existing} is the same journey, booked a moment ago. No second one was opened.` : `Not saved. ${err.message}`));
    } finally { busy = false; send.disabled = false; }
  });
  const act = runner(ctx, () => load());
  function drawOpen() {
    if (!data) return;
    const here = from.value;
    const list = here ? [...data.waiting, ...data.open].filter((t) => t.pickup.id === here) : [];
    const mayCancel = can(ctx.role, 'ospeli_transfers_cancel');
    setKids(openBox, here ? h('section', { class: 'section', 'aria-labelledby': 'req-open-h' },
      h('h2', { id: 'req-open-h' }, `Open transfers from ${[...data.places.wards, ...data.places.departments].find((x) => x.id === here)?.name} (${list.length})`),
      list.length ? h('ul', { class: 'trf-rows' }, list.map((t) => h('li', { class: 'trf-row', 'data-transfer': t.id },
        h('div', { class: 'trf-row-text' }, facts(t), h('p', { class: 'trf-onv' }, stateChip(t), t.vehicleName ? ` ${t.vehicleName}` : '', h('span', { class: 'meta' }, ` · ${t.id}`))),
        mayCancel && !['on-the-way', 'at-destination'].includes(t.state) ? detailsBox('Cancel', 'cancel', h('p', { class: 'meta' }, 'Why?'),
          reasonButtons(data.picks.cancelReasons.filter((r) => r.side === 'requester' || r.id === 'other'), (r) => act('ospeli_transfers_cancel', { transferId: t.id, reason: r.id }, `${t.id} cancelled`), { 'data-cmd': 'ospeli_transfers_cancel' })) : null)))
        : h('p', { class: 'meta' }, 'Nothing open from here.')) : null);
  }
  const load = async () => {
    data = await ctx.run('ospeli_transfers_board', { days: 1, limit: 500 });
    if (!form.childElementCount) {
      if (!can(ctx.role, 'ospeli_transfers_request')) {
        form.replaceWith(h('p', { class: 'card meta', 'data-test': 'read-only' }, `${roleById(ctx.role).name} cannot book transfers. They are booked by ${roleNames('ospeli_transfers_request')}.`));
      } else {
        const places = [...data.places.wards, ...data.places.departments];
        from.replaceChildren(h('option', { value: '' }, 'Choose a ward or department'),
          h('optgroup', { label: 'Wards' }, data.places.wards.map((w) => h('option', { value: w.id }, w.name))),
          h('optgroup', { label: 'Departments' }, data.places.departments.map((x) => h('option', { value: x.id }, x.name))));
        if (lastFrom && places.some((x) => x.id === lastFrom)) from.value = lastFrom;
        form.append(h('h2', { id: 'req-h' }, 'Which journey?'), group('type', 'Kind of journey'),
          h('div', { class: 'field' }, h('label', { for: 'req-from' }, 'From'), from),
          group('to', 'To'), group('when', 'When'), slotField,
          group('mobility', 'How the patient travels (the ward decides)'), group('escort', 'Escort (the ward decides)'), group('equipment', 'Equipment (tap all that travel)'),
          h('label', { class: 'trf-tick', for: 'req-bay' }, bay, h('span', {}, 'A move to the vehicle bay is already asked for in Cleaning and transport')),
          send, status,
          h('p', { class: 'meta' }, 'Pick from the lists; nothing is typed, so no names, addresses or clinical notes go in. Not for emergencies: call the emergency number.'));
      }
    }
    const keep = slot.value;
    slot.replaceChildren(h('option', { value: '' }, 'Choose a time'), data.slots.map((s) => h('option', { value: s.at }, s.label)));
    if (data.slots.some((s) => s.at === keep)) slot.value = keep; else pick.slot = '';
    if (can(ctx.role, 'ospeli_transfers_request')) drawForm();
    drawOpen();
  };
  box.append(form, openBox);
  return { el: box, load };
}

// ---------------------------------------------------------------- Fleet status
function fleetScreen(ctx) {
  const box = h('div', { class: 'trf-fleet' });
  const marks = new Map(); // item -> 'pass' | 'fail'
  const ui = { vehicle: '', askRest: false, result: null };
  let data = null;
  const props = proposalsCard(ctx, { match: (p) => /^ospeli_transfers_vehicle_/.test(p.command), describe: (p) => describeProposal(p, data) });
  const load = async () => {
    data = await ctx.run('ospeli_transfers_board', { days: 30, limit: 1 });
    if (!ui.vehicle) { const mine = store.get(); if (mine && data.vehicles.some((v) => v.id === mine.vehicleId)) ui.vehicle = mine.vehicleId; }
    draw();
    await props.load();
  };
  const act = runner(ctx, load);
  const mayCheck = can(ctx.role, 'ospeli_transfers_vehicle_check');
  const mayStatus = can(ctx.role, 'ospeli_transfers_vehicle_status');

  function vehicleCard(v) {
    return h('li', { class: `card trf-vcard st-${v.state}`, 'data-vehicle': v.id, 'data-state': v.state },
      h('p', { class: 'trf-vhead' }, h('b', {}, v.name), h('span', { class: 'meta' }, ` ${v.siteName}`), h('span', { class: `chip trf-vst st-${v.state}` }, v.stateName), h('span', { class: `chip${v.crewed ? ' trf-ok' : ''}` }, v.crewed ? 'Crewed' : 'No crew')),
      v.offRoad ? h('p', { class: 'trf-warn' }, `Off the road since ${v.offRoad.sinceText}: ${v.offRoad.reasonName.toLowerCase()}.`) : null,
      h('p', { class: 'meta', 'data-test': 'last-check' }, v.lastCheck ? `Daily check ${v.lastCheck.atText}: ${v.lastCheck.failed.length ? `failed ${v.lastCheck.failed.map((x) => x.name).join('; ')}` : `all ${v.lastCheck.passed} items passed`}.` : 'No daily check recorded.'),
      v.lastCheck?.today ? null : h('p', { class: 'chip trf-due' }, 'Check due today'),
      mayStatus ? (v.offRoad
        ? detailsBox('Back in service', 'back', h('p', { class: 'meta' }, 'Why is it safe to use again?'), reasonButtons(data.picks.backReasons, (r) => act('ospeli_transfers_vehicle_status', { vehicleId: v.id, status: 'back', reason: r.id }, `${v.name} back in service`), { 'data-cmd': 'ospeli_transfers_vehicle_status' }))
        : detailsBox('Take off the road', 'off-road', h('p', { class: 'meta' }, 'Why?'), reasonButtons(data.picks.offRoadReasons, (r) => act('ospeli_transfers_vehicle_status', { vehicleId: v.id, status: 'off-road', reason: r.id }, `${v.name} off the road`), { 'data-cmd': 'ospeli_transfers_vehicle_status' })))
        : null);
  }
  function checkForm() {
    if (!mayCheck) return h('p', { class: 'meta', 'data-test': 'read-only' }, `${roleById(ctx.role).name} can see the fleet. Daily checks are recorded by ${roleNames('ospeli_transfers_vehicle_check')}.`);
    const items = data.picks.checkItems;
    const sel = h('select', { id: 'chk-vehicle', 'data-test': 'chk-vehicle' }, h('option', { value: '' }, 'Choose the vehicle'), data.vehicles.map((v) => h('option', { value: v.id }, v.name)));
    sel.value = ui.vehicle;
    sel.addEventListener('change', () => { ui.vehicle = sel.value; ui.result = null; });
    const passed = [...marks.values()].filter((m) => m === 'pass').length;
    const left = items.filter((x) => !marks.has(x.id)).length;
    return h('form', { class: 'card trf-form', 'data-test': 'chk-form', 'aria-labelledby': 'chk-h', onsubmit: (e) => {
      e.preventDefault();
      const missing = !ui.vehicle ? 'the vehicle' : left ? `every item (${left} not marked)` : null;
      if (missing) { ui.result = h('p', { class: 'trf-status' }, `Mark ${missing} first.`); draw(); return; }
      const ids = (m) => [...marks].filter(([, x]) => x === m).map(([k]) => k);
      const v = data.vehicles.find((x) => x.id === ui.vehicle);
      act('ospeli_transfers_vehicle_check', { vehicleId: ui.vehicle, passed: ids('pass'), failed: ids('fail') }, `Check saved: ${v.name}`, { onDone: (out) => {
        ui.result = h('div', { class: `card trf-result${out.failed.length ? ' is-below' : ''}`, 'data-test': 'chk-result' }, h('p', {}, h('b', {}, `Saved: ${v.name}, ${out.failed.length ? `${out.failed.length} failed` : 'all passed'}.`)),
          out.failed.length ? h('p', {}, `Failed: ${out.failed.map((f) => f.name).join('; ')}. See the guide above: take it off the road and report the fault.`) : null);
        marks.clear();
      } });
    } },
    h('h2', { id: 'chk-h' }, 'Daily check'), h('p', { class: 'meta' }, data.picks.checkNote),
    h('div', { class: 'field' }, h('label', { for: 'chk-vehicle' }, 'Vehicle'), sel),
    h('ul', { class: 'trf-items' }, items.map((x) => h('li', { 'data-item': x.id, class: marks.get(x.id) ? `is-${marks.get(x.id)}` : null },
      h('span', { class: 'trf-item-name', id: `chk-${x.id}` }, x.name),
      h('span', { class: 'trf-pf', role: 'group', 'aria-labelledby': `chk-${x.id}` }, ['pass', 'fail'].map((m) => h('button', { class: `trf-mark trf-${m}`, type: 'button', 'aria-pressed': String(marks.get(x.id) === m), 'data-mark': m,
        onclick: () => { if (marks.get(x.id) === m) marks.delete(x.id); else marks.set(x.id, m); draw(); box.querySelector(`[data-item="${x.id}"] [data-mark="${m}"]`)?.focus(); } }, m === 'pass' ? 'Pass' : 'Fail')))))),
    h('p', { class: 'trf-score', 'data-test': 'chk-score' }, marks.size ? `${passed} of ${marks.size} marked items passed` : 'Nothing marked yet. Every item is marked before saving.'),
    left && marks.size ? (ui.askRest
      ? h('div', { class: 'trf-ask', 'data-test': 'chk-rest-confirm' }, h('p', {}, h('b', {}, 'Have you checked every one?'), ` ${left} ${left === 1 ? 'item is' : 'items are'} not marked yet.`),
        h('div', { class: 'actions' }, h('button', { class: 'btn btn-small', type: 'button', 'data-test': 'chk-rest-yes', onclick: () => { for (const x of items) if (!marks.has(x.id)) marks.set(x.id, 'pass'); ui.askRest = false; draw(); } }, 'Yes, mark the rest as pass'),
          h('button', { class: 'btn btn-ghost btn-small', type: 'button', onclick: () => { ui.askRest = false; draw(); } }, 'No, go back')))
      : h('button', { class: 'btn btn-ghost', type: 'button', 'data-test': 'chk-rest', onclick: () => { ui.askRest = true; draw(); } }, 'Mark the rest as pass')) : null,
    h('button', { class: 'btn btn-big', type: 'submit', 'data-cmd': 'ospeli_transfers_vehicle_check', 'data-test': 'chk-save' }, 'Save check'),
    ui.result);
  }
  function draw() {
    const d = data;
    const failing = d.guide.on ? d.guide.suggestions.filter((s) => s.rule === 'check-failed') : [];
    setKids(box, props.el,
      !d.vehicles.length ? h('p', { class: 'card notice', 'data-test': 'no-vehicles' }, 'No vehicles are set up on this device. A hospital loaded before vehicles were added has none: load Example General Hospital again on the Data and audit page.') : null,
      failing.length || !d.guide.on ? guideCard(ctx, d.guide, act, { only: 'check-failed' }) : null,
      d.vehicles.length ? h('section', { class: 'section', 'aria-labelledby': 'flt-h' }, h('h2', { id: 'flt-h' }, `Vehicles (${d.vehicles.length})`), h('ul', { class: 'trf-vcards', 'data-test': 'fleet' }, d.vehicles.map(vehicleCard))) : null,
      d.vehicles.length ? checkForm() : null,
      kpiSection(d, ['fleet-availability']),
      h('p', { class: 'card meta notice', 'data-test': 'planned' }, 'Servicing plan: planned, not built yet.'));
  }
  return { el: box, load };
}
