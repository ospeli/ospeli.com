// Outpatient clinics: the screens. Every read and write goes through ctx.run, the same commands an
// agent would use, so the page works the same on a site's own server.
//   #/clinics/queue       Clinic queue (clinic receptionist, clinic nurse; phone first)
//   #/clinics/referrals   Waiting list (booking clerk; outpatient manager): referrals by wait, book in two taps
//   #/clinics/summary     Clinic day (outpatient manager): each clinic's day, Move or Cancel, measures, guide
//   #/clinics/templates   Templates, read-only (changing them is planned, not built yet)
// Booking, moving, cancelling, steps, sessions and codes are the shared ospeli_slots_* and
// ospeli_codes_* commands. Measures clinics and waits, never a clinician. A patient is a code.
import { h, setKids, fmtWait, moduleStyle } from '../ui.js';
import { roleById } from '../../core/model.js';
import { commandByName } from '../../core/commands.js';
import { proposalsCard } from '../proposals.js';
import { SERVICES } from './commands.js';
import { CODE_KIND, nextFreeSlots, sessionsFromRead, slotWords, shortDate, addDays } from './logic.js';

const can = (role, cmd) => !!commandByName(cmd)?.roles.includes(role);
const roleNames = (cmd) => (commandByName(cmd)?.roles || []).map((r) => roleById(r)?.name || r).join(', ');
const TITLES = { queue: 'Clinic queue', referrals: 'Waiting list', summary: 'Clinic day', templates: 'Templates' };
function screensFor(role) {
  if (role === 'clinic-receptionist' || role === 'clinic-nurse') return ['queue', 'summary'];
  if (role === 'booking-clerk') return ['referrals', 'queue', 'summary', 'templates'];
  if (role === 'outpatient-manager') return ['summary', 'referrals', 'queue', 'templates'];
  return ['summary', 'queue', 'referrals', 'templates'];
}
const LOCK_MS = 3e3; // after "Call in", the same place's "Finished" cannot be tapped this long
const LONG_WAIT_DAYS = 21; // a long wait on the list is marked (example setting, not a standard)
const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const offline = () => document.documentElement.dataset.site === 'offline';
const fmtKpi = (k) => (k.value == null ? (k.tooFew ? 'Too few to show' : 'None yet') : k.unit === '%' ? `${Math.round(k.value * 100)}%` : k.unit === 'days' ? `${Math.round(k.value)} days` : `${Math.round(k.value)} min`);

// Panels a person opened stay open when the page is drawn again (after a save here or on another device).
const openPanels = new Set();
const detailsBox = (label, test, key, ...kids) => h('details', { class: 'cl-more', 'data-test': test, open: openPanels.has(key),
  ontoggle: (e) => { if (e.currentTarget.open) openPanels.add(key); else openPanels.delete(key); } }, h('summary', {}, label), ...kids);

export async function render(el, ctx) {
  await moduleStyle('clinics');
  const screens = screensFor(ctx.role);
  const screen = screens.includes(ctx.rest[0]) ? ctx.rest[0] : screens[0];
  const head = h('div', { class: 'page-head' }, h('div', {}, h('p', { class: 'eyebrow' }, 'Outpatient clinics'), h('h1', {}, TITLES[screen])));
  const tabs = h('nav', { class: 'cl-tabs', 'aria-label': 'Outpatient clinics' },
    screens.map((s) => h('a', { href: `#/clinics/${s}`, 'data-screen': s, 'aria-current': s === screen ? 'page' : null }, TITLES[s])));
  const view = { queue: queueScreen, referrals: referralsScreen, summary: summaryScreen, templates: templatesScreen }[screen](ctx);
  // The shell moves the page's children into <main>, so the module's class goes on its own wrapper.
  const root = h('div', { class: 'mod-clinics cl', 'data-screen': screen, 'data-role': ctx.role }, head, tabs, view.el);
  el.append(root);
  await view.load();
  let t = null;
  const off = ctx.core.onChange(({ kind }) => {
    if (!['event', 'events', 'reset', 'proposals'].includes(kind)) return;
    clearTimeout(t);
    t = setTimeout(() => view.load(), 100);
  });
  // A device that loses or gets back its connection redraws (the queue's taps need one).
  const watch = new MutationObserver(() => view.draw?.());
  watch.observe(document.documentElement, { attributes: true, attributeFilter: ['data-site'] });
  const tick = setInterval(() => view.load(), 60e3); // keep the waits fresh
  return () => { off(); clearInterval(tick); clearTimeout(t); watch.disconnect(); view.stop?.(); };
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
const offlineNote = (text) => (offline() ? h('p', { class: 'card notice cl-offline', role: 'status', 'data-test': 'offline' }, text) : null);
const proposals = (ctx) => proposalsCard(ctx, { match: (p) => /^ospeli_(clinics|slots|codes)_/.test(p.command), describe: describeProposal });

// ---------------------------------------------------------------- Clinic queue (phone)
function queueScreen(ctx) {
  const box = h('div', { class: 'cl-queue' });
  const ui = { sessionId: null, find: '', lockUntil: new Map(), active: new Set() }; // active: rows shown open during this visit stay in place
  let data = null;
  let timer = null;
  const props = proposals(ctx);
  const load = async () => {
    try {
      data = await ctx.run('ospeli_clinics_queue', { ...(ui.sessionId ? { sessionId: ui.sessionId } : {}), ...(ui.find ? { find: ui.find } : {}), limit: 300 });
    } catch (err) {
      // A clinic picked earlier that is no longer listed (another day, a reset): back to the one running now.
      if (ui.sessionId && err.code === 'not-found') { ui.sessionId = null; return load(); }
      throw err;
    }
    draw();
    await props.load();
  };
  const act = runner(ctx, load);
  const mayStep = can(ctx.role, 'ospeli_slots_step');
  const nurse = ctx.role === 'clinic-nurse';
  const desk = mayStep && !nurse; // the desk marks arrivals and missed appointments; the nurse calls in and finishes

  let findInput = null;
  let findTimer = null;
  function findBox() {
    if (!findInput) {
      findInput = h('input', { id: 'cl-find', type: 'text', inputmode: 'numeric', autocomplete: 'off', maxlength: '6', 'data-test': 'find', 'aria-describedby': 'cl-find-hint' });
      findInput.addEventListener('input', () => {
        const digits = findInput.value.replace(/\D/g, '').slice(0, 6); // a number only: nothing typed reaches a command or the screen as text
        if (digits !== findInput.value) findInput.value = digits;
        clearTimeout(findTimer);
        findTimer = setTimeout(() => { ui.find = digits; load(); }, 250);
      });
    }
    return h('div', { class: 'cl-find' }, h('label', { for: 'cl-find' }, 'Find patient number'),
      h('div', { class: 'cl-find-row' }, findInput,
        ui.find ? h('button', { class: 'btn btn-ghost btn-small', type: 'button', 'data-test': 'find-clear', onclick: () => { findInput.value = ''; ui.find = ''; load(); } }, 'Show all') : null),
      h('p', { class: 'cl-hint', id: 'cl-find-hint' }, 'The number after P: for Patient P12, type 12.'));
  }

  function mainButton(p) {
    const off = offline();
    const stepBtn = (step, label, cls, extra = {}) => h('button', { class: `btn cl-main ${cls}`, type: 'button', 'data-cmd': 'ospeli_slots_step', 'data-step': step, 'data-test': 'main-action',
      disabled: off || extra.locked, 'aria-label': `${label}: ${p.label}, booked ${p.slotTime}`,
      onclick: (e) => {
        e.currentTarget.disabled = true;
        act('ospeli_slots_step', { appointmentId: p.appointmentId, step, expectedState: p.state }, `${p.label}: ${label.toLowerCase()}`, {
          onDone: () => { if (step === 'called') ui.lockUntil.set(p.appointmentId, Date.now() + LOCK_MS); },
          onError: (err) => { if (err.code === 'conflict') { ctx.toast(`Already changed: ${err.message}`); return true; } return false; } });
      } }, extra.text || label);
    if (desk && p.state === 'booked') return stepBtn('arrived', 'Arrived', 'cl-arrive');
    if (nurse && p.state === 'arrived') return stepBtn('called', 'Call in', 'cl-call');
    if (nurse && p.state === 'called') {
      const left = (ui.lockUntil.get(p.appointmentId) || 0) - Date.now();
      if (left > 0) { clearTimeout(timer); timer = setTimeout(draw, 500); }
      return stepBtn('finished', 'Finished', 'cl-finish', { locked: left > 0, text: left > 0 ? `Finished (wait ${Math.ceil(left / 1000)} s)` : 'Finished' });
    }
    return null;
  }
  function stateLine(p) {
    if (p.state === 'booked') return p.mayMarkMissed ? h('span', { class: 'cl-st st-late' }, 'Not arrived, past the booked time') : h('span', { class: 'cl-st' }, 'Not arrived yet');
    if (p.state === 'arrived') return h('span', { class: 'cl-st st-wait', 'data-test': 'wait' }, `Waiting ${fmtWait(p.waitMinutes ?? 0)} (arrived ${p.clocks.arrived})`);
    if (p.state === 'called') return h('span', { class: 'cl-st st-in' }, `With the clinician since ${p.clocks.called} (waited ${fmtWait(p.waitMinutes ?? 0)})`);
    if (p.state === 'finished') return h('span', { class: 'cl-st st-done' }, `Finished ${p.clocks.finished}`);
    if (p.state === 'no-show') return h('span', { class: 'cl-st st-missed' }, 'Missed appointment');
    return h('span', { class: 'cl-st st-missed' }, p.stateName);
  }
  function row(p) {
    const off = offline();
    const extra = [];
    if (desk && p.state === 'booked' && p.mayMarkMissed) {
      extra.push(detailsBox('Did not come?', 'missed', `missed:${p.appointmentId}`,
        h('p', { class: 'cl-hint' }, `Record a missed appointment only if ${p.label} has not arrived. Pick why:`),
        h('div', { class: 'cl-reasons' }, data.picks.missedReasons.map((reason) => h('button', { class: 'btn btn-ghost btn-small', type: 'button', 'data-cmd': 'ospeli_slots_step', 'data-step': 'no-show', 'data-reason': reason, disabled: off,
          onclick: () => act('ospeli_slots_step', { appointmentId: p.appointmentId, step: 'no-show', reason, expectedState: 'booked' }, `${p.label}: missed appointment`) }, reason)))));
    }
    if (desk && p.state === 'arrived') {
      extra.push(detailsBox('Left before being seen?', 'left', `left:${p.appointmentId}`,
        h('p', { class: 'cl-hint' }, `Only if ${p.label} has gone home without being called. The slot stays counted as used.`),
        h('button', { class: 'btn btn-ghost btn-small', type: 'button', 'data-cmd': 'ospeli_slots_cancel', disabled: off,
          onclick: () => act('ospeli_slots_cancel', { appointmentId: p.appointmentId, by: 'patient', reason: data.picks.leftReason, expectedState: 'arrived' }, `${p.label}: left before being seen`) }, 'Yes, left before being seen')));
    }
    const done = ['finished', 'no-show', 'cancelled'].includes(p.state);
    return h('li', { class: `cl-row st-${p.state}${done ? ' is-done' : ''}`, 'data-appointment': p.appointmentId, 'data-state': p.state, 'data-code': p.code },
      h('div', { class: 'cl-row-text' },
        h('p', { class: 'cl-who' }, h('b', { class: 'cl-time' }, p.slotTime), h('b', {}, p.label), h('span', { class: 'chip' }, p.slotTypeWord), p.rebook ? h('span', { class: 'chip' }, 'Rebooked') : null),
        h('p', { class: 'cl-state' }, stateLine(p))),
      h('div', { class: 'cl-row-act' }, mainButton(p), extra));
  }
  function draw() {
    if (!data) return;
    clearTimeout(timer);
    const c = data.clinic;
    if (!c) {
      setKids(box, props.el, h('div', { class: 'card notice', 'data-test': 'no-clinic' }, h('p', {}, 'No clinic is planned for today.'),
        h('p', { class: 'cl-hint' }, 'A hospital loaded before clinics were added has none. Load Example General Hospital again on the ', h('a', { href: '#/data' }, 'Data and audit'), ' page.')));
      return;
    }
    const n = c.counts;
    const pick = data.clinics.length > 1 ? h('div', { class: 'cl-pick', role: 'group', 'aria-label': 'Which clinic' }, data.clinics.map((x) => h('button', {
      class: 'chip-btn', type: 'button', 'aria-pressed': String(x.sessionId === data.sessionId), 'data-session': x.sessionId,
      onclick: () => { ui.sessionId = x.sessionId; ui.active.clear(); load(); } }, `${x.serviceWord.replace(/ clinic$/, '')} ${x.start}`))) : null;
    // A row done before this visit folds away; a row this person saw open keeps its place, so a
    // second tap never lands on the row that moved up under it.
    for (const p of data.patients) if (!['finished', 'no-show', 'cancelled'].includes(p.state)) ui.active.add(p.appointmentId);
    const folded = ui.find ? [] : data.patients.filter((p) => !ui.active.has(p.appointmentId));
    const list = data.patients.filter((p) => !folded.includes(p));
    setKids(box,
      props.el,
      offlineNote(data.offlineNote),
      pick,
      h('section', { class: 'cl-clinic', 'data-test': 'clinic', 'data-session': c.sessionId, 'aria-labelledby': 'cl-clinic-h' },
        h('h2', { id: 'cl-clinic-h' }, c.name),
        h('p', { class: 'cl-hint' }, `${shortDate(c.date)}, ${c.start} to ${c.end}${c.state === 'cancelled' ? ` · Cancelled: ${c.reason}` : c.state === 'reduced' ? ` · Reduced: ${c.reason}` : ''}`),
        h('div', { class: 'cl-counts', 'data-test': 'counts' },
          h('div', { class: 'stat', 'data-count': 'to-come' }, h('span', {}, 'To come'), h('b', {}, String(n.toCome))),
          h('div', { class: `stat${n.longestWaitMinutes >= 60 ? ' is-alert' : ''}`, 'data-count': 'waiting' }, h('span', {}, 'Waiting'), h('b', {}, String(n.waiting)),
            h('span', {}, n.longestWaitMinutes != null ? `longest ${fmtWait(n.longestWaitMinutes)}` : 'nobody yet')),
          h('div', { class: 'stat', 'data-count': 'done' }, h('span', {}, 'Finished'), h('b', {}, String(n.finished)), h('span', {}, `${n.withClinician} in now, ${n.missed} missed`)))),
      findBox(),
      folded.length ? detailsBox(`Seen or missed already (${folded.length})`, 'done-rows', `done:${c.sessionId}`, h('ol', { class: 'cl-rows' }, folded.map(row))) : null,
      list.length ? h('ol', { class: 'cl-rows', 'data-test': 'queue' }, list.map(row))
        : h('p', { class: 'cl-empty', 'data-test': 'queue-empty' }, ui.find ? `No Patient P${ui.find} in this clinic today.` : folded.length ? 'Everyone booked has been seen or marked.' : 'Nobody is booked into this clinic.'),
      mayStep ? null : h('p', { class: 'cl-hint', 'data-test': 'read-only' }, `${roleById(ctx.role)?.name || 'This role'} can see the queue. Arrivals and calls are marked by ${roleNames('ospeli_slots_step')}.`),
      h('p', { class: 'cl-hint' }, `The list is in booked-time order. "Did not come?" appears ${data.graceMinutes} minutes after the booked time (an example setting, not a standard).`),
      h('p', { class: 'card meta notice', 'data-test': 'not-for' }, data.note));
    const f = box.querySelector('#cl-find');
    if (f && document.activeElement !== f && ui.find && f.value !== ui.find) f.value = ui.find;
  }
  return { el: box, load, draw, stop: () => { clearTimeout(timer); clearTimeout(findTimer); } };
}

// ---------------------------------------------------------------- Waiting list (booking clerk)
function referralsScreen(ctx) {
  const box = h('div', { class: 'cl-referrals' });
  const ui = { service: SERVICES[ctx.rest[1]] ? ctx.rest[1] : 'all', picked: { service: null, source: null }, ask: null, rebook: new Map(), today: null };
  let data = null;
  const props = proposals(ctx);
  const mayOpen = can(ctx.role, 'ospeli_codes_open');
  const mayBook = can(ctx.role, 'ospeli_slots_book');
  const load = async () => {
    if (!ui.today) ui.today = (await ctx.run('ospeli_slots_sessions', { sessionType: 'clinic', format: 'short', limit: 1 })).from;
    const [codes, sessions] = await Promise.all([
      ctx.run('ospeli_codes_list', { kind: CODE_KIND, state: 'open', booked: false, limit: 500 }),
      ctx.run('ospeli_slots_sessions', { sessionType: 'clinic', from: ui.today, to: addDays(ui.today, 42), limit: 500 }),
    ]);
    data = { codes, sessions: sessionsFromRead(sessions.sessions), asOf: sessions.asOf };
    draw();
    await props.load();
  };
  const act = runner(ctx, load);

  function openForm() {
    const { service, source } = ui.picked;
    const missing = !service ? 'Pick the clinic first' : !source ? 'Pick how it came' : null;
    const send = (again = false) => act('ospeli_codes_open', { kind: CODE_KIND, service, source, ...(again ? { again: true } : {}) }, null, {
      onDone: (out) => { ctx.toast(`${out.label} added to the ${SERVICES[service]} list`); ui.ask = null; ui.picked = { service: null, source: null }; openPanels.add(`book:${out.code}`); },
      onError: (err) => { if (err.detail?.confirm === 'again') { ui.ask = { service, source, label: err.message }; return true; } return false; } });
    return h('section', { class: 'card cl-form', 'data-test': 'open-referral', 'aria-label': 'Add a new referral' },
      h('p', { class: 'cl-hint' }, 'Ospeli gives it a new patient number. No name, date of birth or reason for the visit is kept.'),
      h('p', { class: 'cl-label' }, 'Which clinic?'),
      h('div', { class: 'cl-choices', role: 'group', 'aria-label': 'Which clinic' }, Object.entries(SERVICES).map(([id, word]) => h('button', {
        class: 'chip-btn', type: 'button', 'aria-pressed': String(service === id), 'data-service': id, onclick: () => { ui.picked.service = id; ui.ask = null; draw(); } }, word))),
      h('p', { class: 'cl-label' }, 'How did it come?'),
      h('div', { class: 'cl-choices', role: 'group', 'aria-label': 'How did it come' }, [['referral', 'Referral'], ['walk-in', 'Walk-in']].map(([id, word]) => h('button', {
        class: 'chip-btn', type: 'button', 'aria-pressed': String(source === id), 'data-source': id, onclick: () => { ui.picked.source = id; ui.ask = null; draw(); } }, word))),
      ui.ask ? h('div', { class: 'cl-ask', role: 'alert', 'data-test': 'again' },
        h('p', {}, h('b', {}, 'Is this another patient?')), h('p', { class: 'cl-hint' }, ui.ask.label),
        h('div', { class: 'cl-reasons' },
          h('button', { class: 'btn btn-small', type: 'button', 'data-cmd': 'ospeli_codes_open', 'data-test': 'again-yes', onclick: () => send(true) }, 'Yes, another patient'),
          h('button', { class: 'btn btn-ghost btn-small', type: 'button', 'data-test': 'again-no', onclick: () => { ui.ask = null; ui.picked = { service: null, source: null }; ctx.toast('Kept as one referral'); draw(); } }, 'No, it was the same one')))
        : h('button', { class: 'btn cl-add', type: 'button', 'data-cmd': 'ospeli_codes_open', 'data-test': 'add-referral', disabled: Boolean(missing), onclick: () => send(false) }, missing || 'Add to the list'));
  }

  // The booking a person taps: the referral's own service only, the next free slots in time order.
  async function rebookOf(r) {
    if (!r.appointments) return null;
    if (!ui.rebook.has(r.code)) {
      const list = (await ctx.run('ospeli_slots_appointments', { code: r.code, limit: 50 })).appointments;
      const last = list.filter((a) => ['no-show', 'cancelled'].includes(a.state) && !a.rebookedBy).at(-1) || null;
      ui.rebook.set(r.code, last ? { id: last.id, state: last.stateName, date: last.date } : null);
      draw();
    }
    return ui.rebook.get(r.code);
  }
  function bookBox(r) {
    const free = nextFreeSlots(data.sessions, { service: r.service, nowMs: Date.parse(data.asOf), limit: 3 });
    const prior = ui.rebook.get(r.code);
    if (r.appointments && !ui.rebook.has(r.code)) { rebookOf(r); return h('p', { class: 'cl-hint' }, 'Looking up the last appointment…'); }
    const input = (x) => ({ sessionId: x.sessionId, slotTime: x.slotTime, code: r.code, slotType: r.lastAttendedAt ? 'follow-up' : 'new',
      bookedFrom: prior ? 'rebook' : r.lastAttendedAt ? 'recall' : 'referral', ...(prior ? { rebookOf: prior.id } : {}) });
    return h('div', { class: 'cl-book', 'data-test': 'book-options' },
      prior ? h('p', { class: 'cl-hint' }, `Last appointment: ${prior.state.toLowerCase()} on ${shortDate(prior.date)}. This booking replaces it.`) : null,
      free.length ? h('p', { class: 'cl-hint' }, `Next free in the ${r.serviceWord}:`) : h('p', { 'data-test': 'no-free' }, `No free slot in the ${r.serviceWord} in the next six weeks.`),
      h('div', { class: 'cl-reasons' }, free.map((x) => h('button', { class: 'btn btn-small cl-slot', type: 'button', 'data-cmd': 'ospeli_slots_book', 'data-session': x.sessionId, 'data-slot': x.slotTime,
        onclick: (e) => { e.currentTarget.disabled = true; act('ospeli_slots_book', input(x), `${r.label} booked: ${slotWords(x.date, x.slotTime)}`, { onDone: () => openPanels.delete(`book:${r.code}`) }); } },
      `Book ${slotWords(x.date, x.slotTime)}`))));
  }
  function row(r) {
    const key = `book:${r.code}`;
    const long = r.waitingDays >= LONG_WAIT_DAYS;
    return h('li', { class: `cl-ref${long ? ' is-long' : ''}`, 'data-code': r.code, 'data-service': r.service },
      h('div', { class: 'cl-row-text' },
        h('p', { class: 'cl-who' }, h('b', {}, r.label), h('span', {}, r.serviceWord)),
        h('p', { class: 'cl-state' }, h('b', { 'data-test': 'waited' }, `Waiting ${r.waitingDays} ${r.waitingDays === 1 ? 'day' : 'days'}`), long ? h('span', { class: 'chip cl-long' }, 'Long wait') : null,
          r.appointments ? h('span', { class: 'chip' }, r.lastAttendedAt ? 'Seen before' : 'Missed or cancelled before') : null)),
      mayBook ? h('div', { class: 'cl-row-act' }, h('button', { class: 'btn btn-ghost btn-small', type: 'button', 'aria-expanded': String(openPanels.has(key)), 'data-test': 'book-open',
        onclick: () => { if (openPanels.has(key)) openPanels.delete(key); else openPanels.add(key); draw(); } }, openPanels.has(key) ? 'Close' : 'Book'),
      openPanels.has(key) ? bookBox(r) : null) : null);
  }
  function draw() {
    if (!data) return;
    const all = data.codes.codes;
    const shown = all.filter((r) => ui.service === 'all' || r.service === ui.service);
    const first = shown.filter((r) => !r.lastAttendedAt);
    const seen = shown.filter((r) => r.lastAttendedAt);
    const booked = data.codes.counts.open - data.codes.counts.notBooked;
    setKids(box,
      props.el,
      h('p', { class: 'cl-hint cl-note', 'data-test': 'order-note' }, 'Longest wait first, by wait only: Ospeli does not judge how urgent a referral is. Each referral gets a new number, and Ospeli cannot know whether two numbers are the same person.'),
      mayOpen ? detailsBox('Add a new referral', 'open-referral-box', 'open-form', openForm()) : null,
      h('div', { class: 'chips cl-filter', role: 'group', 'aria-label': 'Which clinic' }, [['all', 'All clinics'], ...Object.entries(SERVICES)].map(([id, word]) => h('button', {
        class: 'chip-btn', type: 'button', 'aria-pressed': String(ui.service === id), 'data-filter': id,
        onclick: () => { ui.service = id; draw(); box.querySelector(`[data-filter="${id}"]`)?.focus(); } }, `${word.replace(/ clinic$/, '')} (${id === 'all' ? all.length : all.filter((r) => r.service === id).length})`))),
      h('section', { class: 'section', 'aria-labelledby': 'cl-first-h' }, h('h2', { id: 'cl-first-h' }, `Waiting for a first appointment (${first.length})`),
        first.length ? h('ul', { class: 'cl-refs', 'data-test': 'waiting' }, first.map(row)) : h('p', { class: 'cl-empty' }, 'Nobody is waiting for a first appointment here.')),
      seen.length ? detailsBox(`Seen before, nothing booked (${seen.length})`, 'seen-before', 'seen-before', h('ul', { class: 'cl-refs' }, seen.map(row))) : null,
      h('p', { class: 'cl-hint', 'data-test': 'booked-count' }, `Already booked: ${booked}. "Long wait" marks ${LONG_WAIT_DAYS} days or more (an example setting, not a standard).`),
      mayBook ? null : h('p', { class: 'cl-hint', 'data-test': 'read-only' }, `${roleById(ctx.role)?.name || 'This role'} can see the list. Booking is for ${roleNames('ospeli_slots_book')}.`));
  }
  return { el: box, load, draw };
}

// ---------------------------------------------------------------- Clinic day (outpatient manager)
function summaryScreen(ctx) {
  const box = h('div', { class: 'cl-summary' });
  const ui = { offset: 0, today: null, cancelReason: new Map() };
  let data = null;
  const props = proposals(ctx);
  const mayPlan = can(ctx.role, 'ospeli_slots_session_change');
  const mayBook = can(ctx.role, 'ospeli_slots_book');
  const load = async () => {
    if (!ui.today) ui.today = (await ctx.run('ospeli_clinics_day_summary', { format: 'short', limit: 1 })).date;
    data = await ctx.run('ospeli_clinics_day_summary', { date: addDays(ui.today, ui.offset), days: 28, limit: 200 });
    draw();
    await props.load();
  };
  const act = runner(ctx, load);

  function cancelFlow(c) {
    const open = c.open || [];
    const here = open.filter((a) => a.state !== 'booked');
    const booked = open.filter((a) => a.state === 'booked');
    const reason = ui.cancelReason.get(c.sessionId) || null;
    return detailsBox('Cancel this clinic', 'cancel-clinic', `cancel:${c.sessionId}`,
      open.length ? [
        h('p', {}, h('b', {}, `${open.length} still booked. Move or cancel each one first, so nobody vanishes from a list.`)),
        here.length ? h('p', { class: 'cl-hint' }, `${here.length} already here (${here.map((a) => a.label).join(', ')}): finish their visit, or record that they left, on the queue.`) : null,
        h('ul', { class: 'cl-moves', 'data-test': 'move-list' }, booked.map((a, i) => {
          const to = c.moveTo[i] || c.moveTo[0] || null;
          return h('li', { 'data-appointment': a.appointmentId },
            h('p', {}, h('b', {}, `${a.slotTime} ${a.label}`)),
            h('div', { class: 'cl-reasons' },
              to ? h('button', { class: 'btn btn-small', type: 'button', 'data-cmd': 'ospeli_slots_move', 'data-test': 'move',
                onclick: () => act('ospeli_slots_move', { appointmentId: a.appointmentId, sessionId: to.sessionId, slotTime: to.slotTime, expectedState: 'booked' }, `${a.label} moved to ${slotWords(to.date, to.slotTime)}`) },
              `Move to ${slotWords(to.date, to.slotTime)}`) : h('span', { class: 'cl-hint' }, 'No free slot in this clinic to move to.'),
              h('button', { class: 'btn btn-ghost btn-small', type: 'button', 'data-cmd': 'ospeli_slots_cancel', 'data-test': 'cancel-booking',
                onclick: () => act('ospeli_slots_cancel', { appointmentId: a.appointmentId, by: 'site', reason: data.picks.cancelForSession, expectedState: 'booked' }, `${a.label}: booking cancelled`) }, 'Cancel booking')));
        })),
      ] : [
        h('p', { class: 'cl-hint' }, 'Nobody is booked. Why is it cancelled?'),
        h('div', { class: 'cl-reasons' }, data.picks.sessionChange.map((r) => h('button', { class: 'chip-btn', type: 'button', 'aria-pressed': String(reason === r), 'data-reason': r,
          onclick: () => { ui.cancelReason.set(c.sessionId, r); draw(); } }, r))),
        h('button', { class: 'btn btn-danger btn-small', type: 'button', 'data-cmd': 'ospeli_slots_session_change', 'data-test': 'cancel-session', disabled: !reason,
          onclick: () => act('ospeli_slots_session_change', { sessionId: c.sessionId, change: 'cancelled', reason, expectedState: c.state }, `${c.name}: cancelled (${reason?.toLowerCase()})`) },
        reason ? 'Cancel the clinic' : 'Pick a reason first'),
      ]);
  }
  function clinicCard(c) {
    const startWords = c.firstCalledMinutes == null ? 'Nobody called yet.' : c.firstCalledMinutes <= 0 ? 'First patient called on time.' : `First patient called ${fmtWait(c.firstCalledMinutes)} after the start.`;
    const endWords = c.overrunMinutes == null ? null : c.overrunMinutes > 0 ? `Last patient finished ${fmtWait(c.overrunMinutes)} after the planned end.` : 'Finished by the planned end.';
    return h('li', { class: `card cl-day st-${c.state}`, 'data-session': c.sessionId, 'data-service': c.service, 'data-state': c.state },
      h('div', { class: 'cl-day-head' }, h('h3', {}, c.name), h('span', { class: `chip cl-sst st-${c.state}` }, c.stateName)),
      h('p', { class: 'cl-hint' }, `${c.start} to ${c.end}${c.reason ? ` · ${c.state === 'cancelled' ? 'Cancelled' : 'Reduced'}: ${c.reason}` : ''}`),
      c.state === 'cancelled' ? null : [
        h('dl', { class: 'cl-figs', 'data-test': 'day-figures' },
          [['In template', c.templateSlots], ['Used', c.used], ['Empty', c.empty], ['Cancelled', c.cancelled], ['Missed', c.missed]].map(([k, v]) => h('div', { 'data-fig': k.toLowerCase().replace(' ', '-') }, h('dt', {}, k), h('dd', {}, String(v ?? 0))))),
        h('p', { 'data-test': 'waiting-now' }, c.counts.waiting ? h('b', {}, `Waiting now: ${c.counts.waiting}, longest ${fmtWait(c.counts.longestWaitMinutes)}.`) : 'Nobody waiting now.', ` ${c.counts.toCome} still to come.`),
        h('p', { class: 'cl-hint' }, startWords, endWords ? ` ${endWords}` : ''),
        h('div', { class: 'cl-reasons' },
          c.empty && mayBook && c.state !== 'held' ? h('a', { class: 'btn btn-small', href: `#/clinics/referrals/${c.service}`, 'data-test': 'fill-empty' }, `Fill ${c.empty} empty from the waiting list`) : null,
          mayPlan && c.mayMarkHeld ? h('button', { class: 'btn btn-ghost btn-small', type: 'button', 'data-cmd': 'ospeli_slots_session_change', 'data-test': 'mark-held',
            onclick: () => act('ospeli_slots_session_change', { sessionId: c.sessionId, change: 'held', expectedState: c.state }, `${c.name}: held`) }, 'Mark the clinic as held') : null),
        mayPlan && (c.state === 'planned' || c.state === 'reduced') ? cancelFlow(c) : null,
      ]);
  }
  function draw() {
    if (!data) return;
    const n = data.counts;
    const days = [[-1, 'Yesterday'], [0, 'Today'], [1, 'Tomorrow']];
    setKids(box,
      props.el,
      h('div', { class: 'cl-counts', 'data-test': 'summary-counts' },
        h('div', { class: 'stat', 'data-count': 'clinics' }, h('span', {}, 'Clinics'), h('b', {}, String(n.clinics)), h('span', {}, n.cancelled ? `${n.cancelled} cancelled` : n.reduced ? `${n.reduced} reduced` : 'none cancelled')),
        h('div', { class: 'stat', 'data-count': 'waiting' }, h('span', {}, 'Waiting now'), h('b', {}, String(n.waitingNow)), h('span', {}, 'in the clinics')),
        h('div', { class: 'stat', 'data-count': 'empty' }, h('span', {}, 'Empty slots'), h('b', {}, String(n.emptySlots)), h('span', {}, `${n.referralsWaiting} referrals waiting`))),
      h('div', { class: 'chips cl-filter', role: 'group', 'aria-label': 'Which day' }, days.map(([o, word]) => h('button', { class: 'chip-btn', type: 'button', 'aria-pressed': String(ui.offset === o), 'data-day': String(o),
        onclick: () => { ui.offset = o; load(); } }, word))),
      h('section', { class: 'section', 'aria-labelledby': 'cl-days-h' }, h('h2', { id: 'cl-days-h' }, `Clinics on ${shortDate(data.date)}`),
        data.clinics.length ? h('ul', { class: 'cl-days', 'data-test': 'clinics' }, data.clinics.map(clinicCard)) : h('p', { class: 'cl-empty' }, 'No clinic is planned on this day.')),
      guideCard(ctx, data.guide, act),
      kpiSection(data),
      h('p', { class: 'card meta notice', 'data-test': 'not-for' }, data.note));
  }
  return { el: box, load, draw };
}

function guideCard(ctx, g, act) {
  const mayToggle = can(ctx.role, 'ospeli_clinics_guide_set');
  return h('section', { class: 'card cl-guide', 'data-test': 'guide', 'data-on': String(g.on), 'aria-labelledby': 'cl-guide-h' },
    h('div', { class: 'cl-guide-head' }, h('h2', { id: 'cl-guide-h' }, 'Guide'),
      mayToggle ? h('button', { class: 'btn btn-ghost btn-small cl-switch', type: 'button', 'aria-pressed': String(g.on), 'data-cmd': 'ospeli_clinics_guide_set', 'data-test': 'guide-switch',
        onclick: () => act('ospeli_clinics_guide_set', { on: !g.on }, `Guide ${g.on ? 'off' : 'on'}`) }, g.on ? 'Guide on: switch off' : 'Guide off: switch on') : null),
    g.on ? [
      h('p', { class: 'cl-hint' }, 'Fixed rules, not AI. They suggest; you decide. Nothing changes until you tap.'),
      g.suggestions.length ? h('ul', { class: 'cl-sugg' }, g.suggestions.map((s) => h('li', { 'data-rule': s.rule, 'data-test': 'suggestion' },
        h('p', {}, h('b', {}, s.text)), h('p', { class: 'cl-hint' }, s.why),
        s.actions.length ? h('div', { class: 'cl-reasons' }, s.actions.map((a) => (can(ctx.role, a.command)
          ? h('button', { class: 'btn btn-small', type: 'button', 'data-cmd': a.command, 'data-test': 'follow', onclick: (e) => { e.currentTarget.disabled = true; act(a.command, a.input, `Booked: ${a.label.replace(/^Book /, '')}`); } }, a.label)
          : h('p', { class: 'cl-hint' }, `${a.label}: ${roleNames(a.command)}.`)))) : null,
        h('details', { class: 'cl-def' }, h('summary', {}, 'Why this rule'), h('p', {}, s.basis)))))
        : h('p', { 'data-test': 'no-suggestion' }, 'Nothing to suggest right now.'),
    ] : h('p', { 'data-test': 'guide-off' }, 'The guide is off. The queue, the waiting list, booking and the measures work the same.'),
    mayToggle ? null : h('p', { class: 'cl-hint' }, `${roleNames('ospeli_clinics_guide_set')} can switch the guide on or off.`));
}

function kpiSection(d) {
  const sub = (k) => {
    if (k.id === 'referral-to-first-appointment') return `Median of ${k.n} referrals first seen in the period. Still waiting counts every open referral not seen yet, booked or not.`;
    if (k.id === 'clinic-wait') return `Median of ${k.n} patients, arrived to called.`;
    if (k.id === 'clinic-start-punctuality') return `${k.numerator} of ${k.denominator} clinics held started on time (window ${d.picks.onTimeMinutes} min, example setting).${k.nobodyCalled ? ` ${k.nobodyCalled} held with nobody called left out.` : ''}`;
    if (k.id === 'slot-utilisation') return `${k.numerator} of ${k.denominator} released slots used in clinics held.`;
    return `${k.numerator} of ${k.denominator} appointments due were missed.`;
  };
  const by = (k, b) => (k.id === 'referral-to-first-appointment' ? `${fmtKpi({ ...b, unit: k.unit })} (${b.n} seen; ${b.waiting} still waiting)` : `${fmtKpi({ ...b, unit: k.unit })}${b.n != null ? ` (${b.n})` : ''}`);
  return h('section', { class: 'section', 'aria-labelledby': 'cl-kpi-h' },
    h('h2', { id: 'cl-kpi-h' }, `Measures, last ${d.period.days} days`),
    h('p', { class: 'cl-hint' }, `Worked out from the event log on this device. They count clinics and waits, never a clinician. A clinic with fewer than ${d.picks.minGroup} cases shows no figure.`),
    h('div', { class: 'cl-kpis' }, d.kpis.map((k) => h('div', { class: 'card cl-kpi', 'data-kpi': k.id, 'data-n': String(k.n ?? 0) },
      h('p', { class: 'cl-kpi-name' }, k.name), h('p', { class: 'cl-kpi-value' }, fmtKpi(k)),
      k.id === 'referral-to-first-appointment' ? h('p', { class: 'cl-kpi-waiting', 'data-test': 'still-waiting' }, `Still waiting: ${k.waiting}`) : null,
      h('p', { class: 'cl-hint' }, sub(k)),
      h('ul', { class: 'cl-breakdown' }, k.byService.map((b) => h('li', {}, `${b.name.replace(/ clinic$/, '')}: ${by(k, b)}`))),
      h('details', { class: 'cl-def' }, h('summary', {}, 'How it is counted'),
        h('p', {}, k.definition), h('p', {}, `Counts: ${k.counts}`), h('p', {}, `Out of: ${k.outOf}`), h('p', {}, `Leaves out: ${k.leavesOut}`), h('p', {}, `Source: ${k.source}`), h('p', {}, `Target: ${k.targetText}`))))));
}

// ---------------------------------------------------------------- Templates (read-only)
function templatesScreen(ctx) {
  const box = h('div', { class: 'cl-templates' });
  let data = null;
  const load = async () => { data = await ctx.run('ospeli_clinics_day_summary', { limit: 1 }); draw(); };
  function draw() {
    if (!data) return;
    const planned = data.planned.find((p) => p.id === 'template-edit');
    const byDay = WEEKDAYS.map((w, i) => [w, data.templates.filter((t) => t.weekday === i + 1)]).filter(([, list]) => list.length);
    setKids(box,
      h('p', { class: 'card notice', 'data-test': 'planned' }, h('b', {}, `${planned.name}: planned, not built yet.`), ` Templates are shown read-only. Each week's sessions are planned from them; a clinic is a service at a place, never a person.`),
      byDay.length ? byDay.map(([w, list]) => h('section', { class: 'section', 'aria-label': w },
        h('h2', {}, w),
        h('ul', { class: 'cl-tpls', 'data-test': 'templates' }, list.map((t) => h('li', { class: 'cl-tpl', 'data-template': t.templateId },
          h('p', {}, h('b', {}, t.name)),
          h('p', { class: 'cl-hint' }, `${t.start} for ${fmtWait(t.minutes)} · ${t.slots} slots of ${t.slotMinutes} min · ${t.slotTypes.join(' and ')} · ${t.released ? 'open for booking when planned' : 'held until released'}`))))))
        : h('p', { class: 'cl-empty' }, 'No clinic template is set up on this device.'),
      can(ctx.role, 'ospeli_slots_template_set') ? h('p', { class: 'cl-hint' }, `Changing a template will be for ${roleNames('ospeli_slots_template_set')}, people only.`) : null);
  }
  return { el: box, load, draw };
}

function describeProposal(p) {
  const i = p.input || {};
  switch (p.command) {
    case 'ospeli_slots_book': return `Book Patient ${String(i.code || '').replace(/^pc-0*/, 'P')} at ${i.slotTime || ''}`;
    case 'ospeli_slots_move': return `Move appointment ${i.appointmentId} to ${i.slotTime || 'another slot'}`;
    case 'ospeli_slots_cancel': return `Cancel appointment ${i.appointmentId}: ${String(i.reason || '').toLowerCase()}`;
    case 'ospeli_slots_step': return `Mark appointment ${i.appointmentId}: ${i.step === 'no-show' ? 'missed appointment' : i.step}`;
    case 'ospeli_slots_session_change': return `${i.change === 'cancelled' ? 'Cancel' : i.change === 'held' ? 'Mark held' : 'Change'} session ${i.sessionId}${i.reason ? `: ${i.reason.toLowerCase()}` : ''}`;
    case 'ospeli_slots_session_plan': return `Plan a clinic on ${i.date}`;
    case 'ospeli_codes_open': return `Add a referral to the ${SERVICES[i.service] || 'clinic'} list`;
    case 'ospeli_codes_close': return `Close Patient ${String(i.code || '').replace(/^pc-0*/, 'P')}: ${String(i.reason || '').toLowerCase()}`;
    default: return p.command.replace(/^ospeli_/, '').replace(/_/g, ' ');
  }
}
