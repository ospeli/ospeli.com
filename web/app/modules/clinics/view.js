// Outpatient clinics: the screens. Every read and write goes through ctx.run, the same commands an
// agent would use, so the page works the same on a site's own server.
//   #/clinics/queue       Clinic queue (clinic receptionist, clinic nurse; phone first)
//   #/clinics/referrals   Waiting list (booking clerk; outpatient manager): referrals by wait, book in two taps
//   #/clinics/summary     Clinic day (outpatient manager): each clinic's day, Move or Cancel, measures, guide
//   #/clinics/templates   Templates, read-only (changing them is planned, not built yet)
// Booking, moving, cancelling, steps, sessions and codes are the shared ospeli_slots_* and
// ospeli_codes_* commands. Measures clinics and waits, never a clinician. A patient is a code.
import { h, setKids, fmtWait, moduleStyle, redrawOnChange } from '../ui.js';
import { roleById } from '../../core/model.js';
import { commandByName } from '../../core/commands.js';
import { proposalsCard } from '../proposals.js';
import { TITLES, screensFor, shownOn } from './screens.js';
import { SERVICES } from './commands.js';
import { CODE_KIND, nextFreeSlots, sessionsFromRead, slotWords, shortDate, addDays, firstAppointmentList, rowsFromList, waitedWords, LATE_MINUTES } from './logic.js';

const can = (role, cmd) => !!commandByName(cmd)?.roles.includes(role);
const roleNames = (cmd) => (commandByName(cmd)?.roles || []).map((r) => roleById(r)?.name || r).join(', ');
const UNDO_WORDS = { arrived: (l) => `${l} back to not arrived yet`, called: (l) => `${l} back to waiting`, 'no-show': (l) => `${l} back to not arrived yet: tap Arrived when they are here` };
const keepPx = (el, px) => { if (px) el.style.minHeight = `${px}px`; return el; };
const LOCK_MS = 3e3; // after "Call in", the same place's "Finished" cannot be tapped this long
const LONG_WAIT_DAYS = 21; // a long wait on the list is marked (example setting, not a standard)
const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const cap = (t) => t.charAt(0).toUpperCase() + t.slice(1);
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
  const off = redrawOnChange(ctx, () => view.load());
  // A device that loses or gets back its connection redraws (the queue's taps need one).
  const watch = new MutationObserver(() => view.draw?.());
  watch.observe(document.documentElement, { attributes: true, attributeFilter: ['data-site'] });
  const tick = setInterval(() => view.load(), 60e3); // keep the waits fresh
  return () => { off(); clearInterval(tick); watch.disconnect(); view.stop?.(); };
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
// Issue #194: a step proposal names the patient as the desk sees them (label, booked time, clinic),
// looked up at display time from today's clinics; nothing new is stored. Unknown: the id, as before.
const apptWords = new Map(); // appointmentId -> 'Patient P12, booked 09:10, General medicine clinic'
async function lookUpAppointments(ctx, ids) {
  const found = new Map();
  try {
    const { clinics } = await ctx.run('ospeli_clinics_queue', { limit: 1 });
    for (const c of clinics) {
      if (found.size === ids.size) break;
      const { appointments } = await ctx.run('ospeli_slots_appointments', { sessionId: c.sessionId, limit: 500 });
      for (const a of appointments) {
        if (!ids.has(a.id)) continue;
        const when = a.slotTime ? `, booked ${a.slotTime}` : '';
        found.set(a.id, `Patient ${String(a.code).replace(/^pc-0*/, 'P')}${when}, ${c.serviceWord}`);
      }
    }
  } catch { /* the card falls back to the id */ }
  return found;
}
function proposals(ctx, screen) {
  const steps = new Set();
  const card = proposalsCard(ctx, { describe: (p) => describeProposal(p, apptWords),
    match: (p) => { const on = shownOn(p).includes(screen); if (on && p.command === 'ospeli_slots_step' && p.input?.appointmentId) steps.add(p.input.appointmentId); return on; } });
  const load = async () => {
    steps.clear();
    await card.load();
    if (!steps.size) return;
    const fresh = await lookUpAppointments(ctx, new Set(steps));
    const changed = [...fresh].some(([id, w]) => apptWords.get(id) !== w);
    for (const [id, w] of fresh) apptWords.set(id, w);
    if (changed) await card.load();
  };
  return { el: card.el, load };
}

// ---------------------------------------------------------------- Clinic queue (phone)
function queueScreen(ctx) {
  const box = h('div', { class: 'cl-queue' });
  const ui = { sessionId: null, find: '', lockUntil: new Map(), active: new Set(), keepHeight: new Map(), stay: new Set(), undone: new Set() }; // active: rows shown open during this visit stay in place
  // A row a person acted on keeps its place and its height for this visit, so a second tap never lands
  // on another patient's button that slid up under the finger.
  const hold = (e, p) => { ui.stay.add(p.appointmentId); ui.keepHeight.set(p.appointmentId, Math.round(e.currentTarget.closest('li')?.getBoundingClientRect().height || 0)); };
  let data = null;
  let timer = null;
  const props = proposals(ctx, 'queue');
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
  const mayCorrect = can(ctx.role, 'ospeli_slots_step_correct');
  // Undo a step marked by mistake (shared ospeli_slots_step_correct). Nothing is erased: the wrong step
  // and the undo both stay in the log, and the figures are worked out again.
  const undoBtn = (p, undo, label, reason = null) => h('button', { class: 'btn btn-ghost btn-small', type: 'button', 'data-cmd': 'ospeli_slots_step_correct', 'data-undo': undo, 'data-test': `undo-${undo}`,
    ...(reason ? { 'data-reason': reason } : {}), disabled: offline(),
    onclick: (e) => {
      hold(e, p);
      e.currentTarget.disabled = true;
      // After an undo the row's panels start closed, so nothing that writes opens under the finger.
      for (const k of ['missed', 'unmiss', 'left', 'uncall']) openPanels.delete(`${k}:${p.appointmentId}`);
      ui.undone.add(p.appointmentId);
      // The button the row gets back (Arrived, Call in) waits a moment, as Finished does after Call in,
      // so a second tap on the redrawn row cannot record the step just undone.
      ui.lockUntil.set(p.appointmentId, Date.now() + LOCK_MS);
      act('ospeli_slots_step_correct', { appointmentId: p.appointmentId, undo, expectedState: p.state, ...(reason ? { reason } : {}) }, UNDO_WORDS[undo](p.label), {
        onError: (err) => { if (err.code === 'conflict') { ctx.toast(`Not undone: ${err.message}`); return true; } return false; } });
    } }, label);

  let findInput = null;
  let findTimer = null;
  function findBox() {
    if (!findInput) {
      findInput = h('input', { id: 'cl-find', type: 'text', inputmode: 'numeric', autocomplete: 'off', maxlength: '6', placeholder: 'e.g. 12', 'data-test': 'find', 'aria-describedby': 'cl-find-hint' });
      findInput.addEventListener('input', () => {
        const digits = findInput.value.replace(/\D/g, '').slice(0, 6); // a number only: nothing typed reaches a command or the screen as text
        if (digits !== findInput.value) findInput.value = digits;
        clearTimeout(findTimer);
        findTimer = setTimeout(() => { ui.find = digits; load(); }, 250);
      });
    }
    return h('div', { class: 'cl-find' },
      h('div', { class: 'cl-find-row' }, h('label', { for: 'cl-find' }, 'Find patient P'), findInput,
        ui.find ? h('button', { class: 'btn btn-ghost btn-small', type: 'button', 'data-test': 'find-clear', onclick: () => { findInput.value = ''; ui.find = ''; load(); } }, 'Show all') : null),
      h('span', { class: 'sr-only', id: 'cl-find-hint' }, 'Type the number after P: for Patient P12, type 12.'));
  }

  function mainButton(p) {
    const off = offline();
    const stepBtn = (step, label, cls, extra = {}) => h('button', { class: `btn cl-main ${cls}`, type: 'button', 'data-cmd': 'ospeli_slots_step', 'data-step': step, 'data-test': 'main-action',
      disabled: off || extra.locked, 'aria-label': `${label}: ${p.label}, booked ${p.slotTime}`,
      onclick: (e) => {
        hold(e, p);
        e.currentTarget.disabled = true;
        act('ospeli_slots_step', { appointmentId: p.appointmentId, step, expectedState: p.state }, `${p.label}: ${label.toLowerCase()}`, {
          onDone: () => { if (step === 'called') ui.lockUntil.set(p.appointmentId, Date.now() + LOCK_MS); },
          onError: (err) => { if (err.code === 'conflict') { ctx.toast(`Already changed: ${err.message}`); return true; } return false; } });
      } }, extra.text || label);
    const wait = (label) => {
      const left = (ui.lockUntil.get(p.appointmentId) || 0) - Date.now();
      if (left > 0) { clearTimeout(timer); timer = setTimeout(draw, 500); }
      return left > 0 ? { locked: true, text: `${label} (wait ${Math.ceil(left / 1000)} s)` } : {};
    };
    if (desk && p.state === 'booked') return stepBtn('arrived', 'Arrived', 'cl-arrive', wait('Arrived'));
    if (nurse && p.state === 'arrived') return stepBtn('called', 'Call in', 'cl-call', wait('Call in'));
    if (nurse && p.state === 'called') {
      const left = (ui.lockUntil.get(p.appointmentId) || 0) - Date.now();
      if (left > 0) { clearTimeout(timer); timer = setTimeout(draw, 500); }
      return stepBtn('finished', 'Finished', 'cl-finish', { locked: left > 0, text: left > 0 ? `Finished (wait ${Math.ceil(left / 1000)} s)` : 'Finished' });
    }
    return null;
  }
  function stateLine(p) {
    if (p.state === 'booked') return p.late ? h('span', { class: 'cl-st st-late' }, `Not arrived, ${fmtWait(p.pastBookedMinutes)} past the booked time`) : h('span', { class: 'cl-st' }, 'Not arrived yet');
    // The wait runs from arrival; the colour follows the time past the later of arrival and the booked
    // slot (#193), so neither an early arrival's long wait nor a late arrival reads as the clinic running late.
    // A late arrival is said in words, as the patient's arrival, not the clinic's lateness.
    if (p.state === 'arrived') {
      return h('span', { class: `cl-st ${p.late ? 'st-late' : 'st-wait'}`, 'data-test': 'wait' }, `Waiting ${fmtWait(p.waitMinutes ?? 0)} · booked ${p.slotTime}, arrived ${p.clocks.arrived}`,
        p.arrivedAfterBookedMinutes ? h('span', { class: 'cl-arr-late', 'data-test': 'arrived-after' }, ` · arrived ${fmtWait(p.arrivedAfterBookedMinutes)} after the booked time`) : null,
        p.pastBookedMinutes ? h('span', { class: 'cl-past', 'data-test': 'past-booked' }, ` · past booked time: ${fmtWait(p.pastBookedMinutes)}`) : null);
    }
    if (p.state === 'called') return h('span', { class: 'cl-st st-in' }, `With the clinician since ${p.clocks.called} (waited ${fmtWait(p.waitMinutes ?? 0)})`);
    if (p.state === 'finished' && p.noTimes) return h('span', { class: 'cl-st st-done', 'data-test': 'no-times' }, `${data.picks.noTimesName} (seen, call and finish not tapped)`);
    if (p.state === 'finished') return h('span', { class: 'cl-st st-done' }, `Finished ${p.clocks.finished}`);
    if (p.state === 'no-show') return h('span', { class: 'cl-st st-missed' }, 'Missed appointment');
    return h('span', { class: 'cl-st st-missed' }, p.stateName);
  }
  function row(p) {
    const off = offline();
    const extra = [];
    if (desk && p.state === 'booked' && ui.undone.has(p.appointmentId)) extra.push(h('p', { class: 'cl-hint', 'data-test': 'undone' }, 'Back to not arrived yet. Tap Arrived when the patient is here.'));
    else if (desk && p.state === 'booked' && p.mayMarkMissed) {
      extra.push(detailsBox('Did not come?', 'missed', `missed:${p.appointmentId}`,
        h('p', { class: 'cl-hint' }, `Record a missed appointment only if ${p.label} has not arrived. Pick why:`),
        h('div', { class: 'cl-reasons' }, data.picks.missedReasons.map((reason) => h('button', { class: 'btn btn-ghost btn-small', type: 'button', 'data-cmd': 'ospeli_slots_step', 'data-step': 'no-show', 'data-reason': reason, disabled: off,
          onclick: (e) => { hold(e, p); e.currentTarget.disabled = true; act('ospeli_slots_step', { appointmentId: p.appointmentId, step: 'no-show', reason, expectedState: 'booked' }, `${p.label}: missed appointment`); } }, reason)))));
    }
    if (desk && p.state === 'arrived') {
      extra.push(detailsBox('Left, or marked by mistake?', 'left', `left:${p.appointmentId}`,
        h('p', { class: 'cl-hint' }, `If ${p.label} has gone home without being called (the slot stays counted as used):`),
        h('button', { class: 'btn btn-ghost btn-small', type: 'button', 'data-cmd': 'ospeli_slots_cancel', disabled: off,
          onclick: (e) => { hold(e, p); e.currentTarget.disabled = true; act('ospeli_slots_cancel', { appointmentId: p.appointmentId, by: 'patient', reason: data.picks.leftReason, expectedState: 'arrived' }, `${p.label}: left before being seen`); } }, 'Yes, left before being seen'),
        mayCorrect && p.mayUndo ? [h('p', { class: 'cl-hint', 'data-test': 'wrong-arrived' }, `Marked arrived by mistake? Undo it: ${p.label} goes back to not arrived yet. The mistake and the undo both stay in the record.`),
          undoBtn(p, 'arrived', 'Undo Arrived')] : null));
    }
    if (desk && p.state === 'no-show' && mayCorrect && p.mayUndo) {
      extra.push(detailsBox('Marked missed by mistake?', 'wrong-missed', `unmiss:${p.appointmentId}`,
        h('p', { class: 'cl-hint' }, `${p.label} goes back to booked, so Arrived can be marked. Only today, before the clinic is marked held. Pick why:`),
        h('div', { class: 'cl-reasons' }, data.picks.undoReasons.map((r) => undoBtn(p, 'no-show', r === data.picks.undoReasons[0] ? 'Undo: marked by mistake' : `Undo: ${r.toLowerCase()}`, r)))));
    }
    if (nurse && p.state === 'called' && mayCorrect && p.mayUndo) {
      extra.push(detailsBox('Called in by mistake?', 'wrong-called', `uncall:${p.appointmentId}`,
        h('p', { class: 'cl-hint' }, `${p.label} goes back to waiting, keeping the arrival time.`), undoBtn(p, 'called', 'Undo Call in')));
    }
    const done = ['finished', 'no-show', 'cancelled'].includes(p.state);
    const li = h('li', { class: `cl-row st-${p.state}${done ? ' is-done' : ''}`, 'data-appointment': p.appointmentId, 'data-state': p.state, 'data-code': p.code },
      h('div', { class: 'cl-row-text' },
        h('p', { class: 'cl-who' }, h('b', { class: 'cl-time' }, p.slotTime), h('b', {}, p.label), h('span', { class: 'chip' }, p.slotTypeWord), p.rebook ? h('span', { class: 'chip' }, 'Rebooked') : null),
        h('p', { class: 'cl-state' }, stateLine(p))),
      h('div', { class: 'cl-row-act' }, mainButton(p), extra));
    const px = ui.keepHeight.get(p.appointmentId);
    if (px) li.style.minHeight = `${px}px`;
    return li;
  }
  // Issue #163: on a day with no clinic, a look at the next or the last clinic day. Read only: no
  // Arrived, Call in, Finished, missed or undo. Since #192 the shared step command also refuses
  // Arrived and Call in off the session's own day; close-out after the day is on Clinic day.
  const lookBtn = (which, label, sessionId) => h('button', { class: 'btn btn-ghost', type: 'button', 'data-test': `look-${which}`,
    onclick: () => { ui.sessionId = sessionId; ui.find = ''; if (findInput) findInput.value = ''; ui.active.clear(); ui.stay.clear(); load(); } }, label);
  function drawLook(c) {
    const lookRow = (p) => h('li', { class: `cl-row st-${p.state}`, 'data-appointment': p.appointmentId, 'data-state': p.state },
      h('div', { class: 'cl-row-text' },
        h('p', { class: 'cl-who' }, h('b', { class: 'cl-time' }, p.slotTime), h('b', {}, p.label), h('span', { class: 'chip' }, p.slotTypeWord)),
        h('p', { class: 'cl-state' }, stateLine(p))));
    const ahead = c.date > data.date;
    setKids(box,
      h('div', { class: 'card notice', 'data-test': 'look', role: 'status' },
        h('p', {}, h('b', {}, `${shortDate(c.date)}: a look ${ahead ? 'ahead' : 'back'}, read only.`)),
        h('p', { class: 'cl-hint' }, `Today is ${shortDate(data.date)}. Arrived and Call in are marked on the clinic's own day.`),
        h('button', { class: 'btn btn-ghost', type: 'button', 'data-test': 'look-back', onclick: () => { ui.sessionId = null; load(); } }, 'Back to today')),
      h('section', { class: 'cl-clinic', 'data-test': 'clinic', 'data-session': c.sessionId, 'aria-labelledby': 'cl-clinic-h' },
        h('h2', { id: 'cl-clinic-h' }, c.name),
        h('p', { class: 'cl-hint' }, `${shortDate(c.date)}, ${c.start} to ${c.end}${c.state === 'cancelled' ? ` · Cancelled: ${c.reason}` : c.state === 'reduced' ? ` · Reduced: ${c.reason}` : ''}`)),
      h('h3', { class: 'cl-sec' }, `Booked (${data.patients.length})`),
      data.patients.length ? h('ol', { class: 'cl-rows', 'data-test': 'look-rows' }, data.patients.map(lookRow))
        : h('p', { class: 'cl-empty', 'data-test': 'queue-empty' }, 'Nobody is booked in this clinic.'),
      h('p', { class: 'card meta notice', 'data-test': 'not-for' }, data.note));
  }
  function draw() {
    if (!data) return;
    clearTimeout(timer);
    const c = data.clinic;
    if (!c) {
      // Issue #163: say what is true. Only a site with no clinics at all was loaded before clinics were added.
      const when = (x) => `${x.serviceWord.replace(/ clinic$/, '')}, ${shortDate(x.date)}, ${x.start}`;
      setKids(box, props.el, data.hasClinics === false
        ? h('div', { class: 'card notice', 'data-test': 'no-clinic' }, h('p', {}, 'This hospital has no clinics.'),
          h('p', { class: 'cl-hint' }, 'A hospital loaded before clinics were added has none. Load Example General Hospital again on the ', h('a', { href: '#/data' }, 'Data and audit'), ' page.'))
        : h('div', { class: 'card notice', 'data-test': 'no-clinic' }, h('p', {}, `No clinic today (${shortDate(data.date)}).`),
          h('p', { class: 'cl-hint', 'data-test': 'next-clinic' }, data.nextClinic ? `Next clinic: ${when(data.nextClinic)}.` : 'No clinic is planned in the coming weeks.'),
          data.lastClinic ? h('p', { class: 'cl-hint', 'data-test': 'last-clinic' }, `Last clinic: ${when(data.lastClinic)}.`) : null,
          // A look at another day's list, read only (Arrived and Call in are refused off the clinic's day, #192).
          data.nextClinic || data.lastClinic ? h('div', { class: 'cl-look-btns' },
            data.nextClinic ? lookBtn('next', `See the list for ${shortDate(data.nextClinic.date)}`, data.nextClinic.sessionId) : null,
            data.lastClinic ? lookBtn('last', `See the list for ${shortDate(data.lastClinic.date)}`, data.lastClinic.sessionId) : null) : null));
      return;
    }
    if (c.date !== data.date) return drawLook(c);
    const n = c.counts;
    const pick = data.clinics.length > 1 ? h('div', { class: 'cl-pick', role: 'group', 'aria-label': 'Which clinic' }, data.clinics.map((x) => h('button', {
      class: 'chip-btn', type: 'button', 'aria-pressed': String(x.sessionId === data.sessionId), 'data-session': x.sessionId,
      onclick: () => { ui.sessionId = x.sessionId; ui.active.clear(); ui.stay.clear(); load(); } }, `${x.serviceWord.replace(/ clinic$/, '')} ${x.start}`))) : null;
    // A row done before this visit folds away; a row this person saw open keeps its place, so a
    // second tap never lands on the row that moved up under it.
    // The desk works the patients still to come; the nurse works everyone here or to come. A row
    // first shown in that list keeps its place for this visit, whatever happens to it.
    const mine = desk ? ['booked'] : ['booked', 'arrived', 'called'];
    for (const p of data.patients) if (mine.includes(p.state)) ui.active.add(p.appointmentId);
    const isDone = (p) => ['finished', 'no-show', 'cancelled'].includes(p.state);
    const list = ui.find ? data.patients : data.patients.filter((p) => ui.active.has(p.appointmentId));
    const hereNow = ui.find || !desk ? [] : data.patients.filter((p) => !ui.active.has(p.appointmentId) && (!isDone(p) || ui.stay.has(p.appointmentId)));
    const folded = ui.find ? [] : data.patients.filter((p) => !ui.active.has(p.appointmentId) && isDone(p) && !ui.stay.has(p.appointmentId));
    setKids(box,
      props.el,
      offlineNote(data.offlineNote),
      pick,
      h('section', { class: 'cl-clinic', 'data-test': 'clinic', 'data-session': c.sessionId, 'aria-labelledby': 'cl-clinic-h' },
        h('h2', { id: 'cl-clinic-h' }, c.name),
        h('p', { class: 'cl-hint' }, `${shortDate(c.date)}, ${c.start} to ${c.end}${c.state === 'cancelled' ? ` · Cancelled: ${c.reason}` : c.state === 'reduced' ? ` · Reduced: ${c.reason}` : ''}`),
        h('div', { class: 'cl-counts', 'data-test': 'counts' },
          h('div', { class: 'stat', 'data-count': 'to-come' }, h('span', {}, 'To come'), h('b', {}, String(n.toCome))),
          h('div', { class: `stat${n.longestPastBookedMinutes >= LATE_MINUTES ? ' is-alert' : ''}`, 'data-count': 'waiting' }, h('span', {}, 'Waiting'), h('b', {}, String(n.waiting)),
            h('span', { 'data-test': 'waiting-sub' }, !n.waiting ? 'nobody yet' : n.longestPastBookedMinutes ? `${fmtWait(n.longestPastBookedMinutes)} past booked time` : 'none past booked time')),
          h('div', { class: 'stat', 'data-count': 'done' }, h('span', {}, 'Finished'), h('b', {}, String(n.finished)), h('span', {}, `${n.withClinician} in now, ${n.missed} missed`)))),
      desk ? findBox() : null,
      desk && !ui.find ? h('h3', { class: 'cl-sec' }, `Still to come (${list.length})`) : null,
      list.length ? h('ol', { class: 'cl-rows', 'data-test': 'queue' }, list.map(row))
        : h('p', { class: 'cl-empty', 'data-test': 'queue-empty' }, ui.find ? `No Patient P${ui.find} in this clinic today.` : desk ? 'Nobody else is booked to come.' : 'Nobody is waiting or to come.'),
      hereNow.length ? [h('h3', { class: 'cl-sec' }, `Here now (${hereNow.length})`), h('ol', { class: 'cl-rows', 'data-test': 'here-now' }, hereNow.map(row))] : null,
      folded.length ? detailsBox(`Seen, left or missed (${folded.length})`, 'done-rows', `done:${c.sessionId}`, h('ol', { class: 'cl-rows' }, folded.map(row))) : null,
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
  // Kept for this visit: the order rows were first shown in, and what this person booked or removed,
  // so a row never vanishes and lets the next row's button slide under the finger.
  const ui = { service: SERVICES[ctx.rest[1]] ? ctx.rest[1] : 'all', picked: { service: null, source: null }, ask: null, rebook: new Map(), today: null,
    order: [], rows: new Map(), bookedNow: new Map(), removedNow: new Set(), scrollTo: null, keepHeight: new Map() };
  let data = null;
  const props = proposals(ctx, 'referrals');
  const mayOpen = can(ctx.role, 'ospeli_codes_open');
  const mayBook = can(ctx.role, 'ospeli_slots_book');
  const mayCancel = can(ctx.role, 'ospeli_slots_cancel');
  const mayClose = can(ctx.role, 'ospeli_codes_close');
  const load = async () => {
    if (!ui.today) ui.today = (await ctx.run('ospeli_slots_sessions', { sessionType: 'clinic', format: 'short', limit: 1 })).from;
    const [codes, booked, sessions] = await Promise.all([
      ctx.run('ospeli_codes_list', { kind: CODE_KIND, state: 'open', booked: false, limit: 500 }),
      ctx.run('ospeli_codes_list', { kind: CODE_KIND, state: 'open', booked: true, limit: 500 }),
      ctx.run('ospeli_slots_sessions', { sessionType: 'clinic', from: ui.today, to: addDays(ui.today, 42), limit: 500 }),
    ]);
    // Where each booked appointment sits, from the sessions' own slots.
    const at = new Map();
    for (const s of sessions.sessions) for (const x of s.slots || []) if (x.appointmentId) at.set(x.appointmentId, { date: s.date, slotTime: x.time, atMs: Date.parse(s.startsAt) + (toMin(x.time) - toMin(s.start)) * 60e3 });
    data = { codes, booked, at, sessions: sessionsFromRead(sessions.sessions), asOf: sessions.asOf };
    draw();
    await props.load();
  };
  const toMin = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));
  const act = runner(ctx, load);

  function openForm() {
    const { service, source } = ui.picked;
    const missing = !service ? 'Pick the clinic first' : !source ? 'Pick how it came' : null;
    const send = (again = false) => act('ospeli_codes_open', { kind: CODE_KIND, service, source, ...(again ? { again: true } : {}) }, null, {
      onDone: (out) => {
        ctx.toast(`${out.label} added to the ${SERVICES[service]} list`);
        ui.ask = null; ui.picked = { service: null, source: null };
        for (const k of [...openPanels]) if (k.startsWith('book:')) openPanels.delete(k);
        openPanels.add(`book:${out.code}`); ui.scrollTo = out.code;
        if (ui.service !== 'all' && ui.service !== service) ui.service = 'all';
      },
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

  // The last missed or cancelled appointment, so a new booking is recorded as its rebook.
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
  // The booking a person taps: the referral's own service only, the next free slots in time order.
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
        onclick: (e) => {
          e.currentTarget.disabled = true;
          // The row keeps its height for this visit, so the next row's button never slides up under the finger.
          ui.keepHeight.set(r.code, Math.round(e.currentTarget.closest('li')?.getBoundingClientRect().height || 0));
          act('ospeli_slots_book', input(x), `${r.label} booked: ${slotWords(x.date, x.slotTime)}`, {
            onDone: (out) => { openPanels.delete(`book:${r.code}`); ui.bookedNow.set(r.code, { appointmentId: out.appointmentId, words: slotWords(x.date, x.slotTime) }); } });
        } },
      `Book ${slotWords(x.date, x.slotTime)}`))));
  }
  // "Booked by mistake": the shared cancel, by the site, reason "Booked in error", after one confirm.
  function mistakeBooking(r, appointmentId, words) {
    if (!mayCancel) return null;
    return detailsBox('Booked by mistake?', 'booked-mistake', `undo-book:${appointmentId}`,
      h('p', { class: 'cl-hint' }, `This cancels the booking for ${words} and puts ${r.label} back on the waiting list.`),
      h('button', { class: 'btn btn-danger btn-small', type: 'button', 'data-cmd': 'ospeli_slots_cancel', 'data-test': 'confirm-unbook',
        onclick: (e) => { e.currentTarget.disabled = true; act('ospeli_slots_cancel', { appointmentId, by: 'site', reason: 'Booked in error', expectedState: 'booked' }, `${r.label}: booking cancelled (booked in error)`, {
          onDone: () => { ui.bookedNow.delete(r.code); openPanels.delete(`undo-book:${appointmentId}`); } }); } }, 'Yes, cancel this booking'));
  }
  // "Added by mistake": the shared close, reason "Opened in error", after one confirm.
  function mistakeReferral(r) {
    if (!mayClose || r.appointments) return null;
    return detailsBox('Added by mistake?', 'added-mistake', `undo-add:${r.code}`,
      h('p', { class: 'cl-hint' }, `This removes ${r.label} from the list, recorded as opened in error.`),
      h('button', { class: 'btn btn-danger btn-small', type: 'button', 'data-cmd': 'ospeli_codes_close', 'data-test': 'confirm-remove',
        onclick: (e) => { e.currentTarget.disabled = true; ui.keepHeight.set(r.code, Math.round(e.currentTarget.closest('li')?.getBoundingClientRect().height || 0)); act('ospeli_codes_close', { code: r.code, reason: 'Opened in error' }, `${r.label}: removed (added by mistake)`, {
          onDone: () => { ui.removedNow.add(r.code); openPanels.delete(`undo-add:${r.code}`); } }); } }, `Yes, remove ${r.label}`));
  }
  function row(r) {
    const key = `book:${r.code}`;
    const long = r.waitingDays >= LONG_WAIT_DAYS;
    const done = ui.bookedNow.get(r.code);
    const removed = ui.removedNow.has(r.code);
    const head = h('div', { class: 'cl-row-text' },
      h('p', { class: 'cl-who' }, h('b', {}, r.label), h('span', {}, r.serviceWord)),
      h('p', { class: 'cl-state' }, h('b', { 'data-test': 'waited' }, cap(waitedWords(r.waitingDays))), long && !done && !removed ? h('span', { class: 'chip cl-long' }, 'Long wait') : null,
        r.appointments && !done ? h('span', { class: 'chip' }, r.lastAttendedAt ? 'Seen before' : 'Missed or cancelled before') : null));
    const keep = (el) => { const px = ui.keepHeight.get(r.code); if (px) el.style.minHeight = `${px}px`; return el; };
    if (removed) return keep(h('li', { class: 'cl-ref is-done', 'data-code': r.code, 'data-service': r.service, 'data-state': 'removed' }, head, h('p', { class: 'cl-booked' }, 'Removed: added by mistake')));
    if (done) {
      return keep(h('li', { class: 'cl-ref is-booked', 'data-code': r.code, 'data-service': r.service, 'data-state': 'booked' }, head,
        h('div', { class: 'cl-row-act' }, h('p', { class: 'cl-booked', 'data-test': 'booked-now' }, `Booked: ${done.words}`), mistakeBooking(r, done.appointmentId, done.words))));
    }
    return h('li', { class: `cl-ref${long ? ' is-long' : ''}`, 'data-code': r.code, 'data-service': r.service, 'data-state': 'waiting' }, head,
      mayBook || mayClose ? h('div', { class: 'cl-row-act' },
        mayBook ? h('button', { class: 'btn btn-ghost btn-small', type: 'button', 'aria-expanded': String(openPanels.has(key)), 'data-test': 'book-open',
          onclick: () => {
            const was = openPanels.has(key);
            for (const k of [...openPanels]) if (k.startsWith('book:')) openPanels.delete(k); // one Book panel open at a time
            if (!was) openPanels.add(key);
            draw();
          } }, openPanels.has(key) ? 'Close' : 'Book') : null,
        mayBook && openPanels.has(key) ? bookBox(r) : null,
        mistakeReferral(r)) : null);
  }
  function draw() {
    if (!data) return;
    const rows = rowsFromList(data.codes.codes);
    for (const r of rows) ui.rows.set(r.code, r);
    // The waiting list's own order (the guide uses the same function), kept in place for this visit.
    const first = firstAppointmentList(rows);
    for (const r of first) if (!ui.order.includes(r.code)) ui.order.push(r.code);
    const still = new Set(first.map((r) => r.code));
    const shownFirst = ui.order.filter((c) => still.has(c) || ui.bookedNow.has(c) || ui.removedNow.has(c)).map((c) => ui.rows.get(c))
      .filter((r) => ui.service === 'all' || r.service === ui.service);
    const seen = rows.filter((r) => r.attended && !r.booked && (ui.service === 'all' || r.service === ui.service));
    const booked = rowsFromList(data.booked.codes).filter((r) => !ui.bookedNow.has(r.code) && (ui.service === 'all' || r.service === ui.service));
    const nowMs = Date.parse(data.asOf);
    const bookedRow = (r) => {
      const id = r.openAppointments[0];
      const at = data.at.get(id);
      const words = at ? slotWords(at.date, at.slotTime) : 'a later date';
      return h('li', { class: 'cl-ref is-booked', 'data-code': r.code, 'data-service': r.service, 'data-state': 'booked' },
        h('div', { class: 'cl-row-text' }, h('p', { class: 'cl-who' }, h('b', {}, r.label), h('span', {}, r.serviceWord)), h('p', { class: 'cl-booked' }, `Booked: ${words}`)),
        at && at.atMs > nowMs ? h('div', { class: 'cl-row-act' }, mistakeBooking(r, id, words)) : null);
    };
    const counts = (id) => (id === 'all' ? first.length : first.filter((r) => r.service === id).length);
    setKids(box,
      props.el,
      h('p', { class: 'cl-hint cl-note', 'data-test': 'order-note' }, 'Longest wait first, by wait only: Ospeli does not judge how urgent a referral is. Each referral gets a new number, and Ospeli cannot know whether two numbers are the same person.'),
      mayOpen ? detailsBox('Add a new referral', 'open-referral-box', 'open-form', openForm()) : null,
      h('div', { class: 'chips cl-filter', role: 'group', 'aria-label': 'Which clinic' }, [['all', 'All clinics'], ...Object.entries(SERVICES)].map(([id, word]) => h('button', {
        class: 'chip-btn', type: 'button', 'aria-pressed': String(ui.service === id), 'data-filter': id,
        onclick: () => { ui.service = id; draw(); box.querySelector(`[data-filter="${id}"]`)?.focus(); } }, `${word.replace(/ clinic$/, '')} (${counts(id)})`))),
      h('section', { class: 'section', 'aria-labelledby': 'cl-first-h' }, h('h2', { id: 'cl-first-h' }, `Waiting for a first appointment (${shownFirst.filter((r) => still.has(r.code)).length})`),
        shownFirst.length ? h('ul', { class: 'cl-refs', 'data-test': 'waiting' }, shownFirst.map(row)) : h('p', { class: 'cl-empty' }, 'Nobody is waiting for a first appointment here.')),
      seen.length ? detailsBox(`Seen before, nothing booked (${seen.length})`, 'seen-before', 'seen-before', h('ul', { class: 'cl-refs' }, seen.map(row))) : null,
      booked.length ? detailsBox(`Booked (${booked.length})`, 'booked-list', 'booked-list', h('ul', { class: 'cl-refs' }, booked.map(bookedRow))) : null,
      h('p', { class: 'cl-hint' }, `"Long wait" marks ${LONG_WAIT_DAYS} days or more (an example setting, not a standard).`),
      mayBook ? null : h('p', { class: 'cl-hint', 'data-test': 'read-only' }, `${roleById(ctx.role)?.name || 'This role'} can see the list. Booking is for ${roleNames('ospeli_slots_book')}.`));
    if (ui.scrollTo) {
      const el = box.querySelector(`[data-test="waiting"] [data-code="${ui.scrollTo}"]`);
      if (el) { el.scrollIntoView({ block: 'center' }); ui.scrollTo = null; }
    }
  }
  return { el: box, load, draw };
}

// ---------------------------------------------------------------- Clinic day (outpatient manager)
function summaryScreen(ctx) {
  const box = h('div', { class: 'cl-summary' });
  const ui = { offset: 0, today: null, cancelReason: new Map(), closed: new Map() }; // closed: sessionId -> rows closed during this visit
  let data = null;
  const props = proposals(ctx, 'summary');
  const mayPlan = can(ctx.role, 'ospeli_slots_session_change');
  const mayBook = can(ctx.role, 'ospeli_slots_book');
  const mayStep = can(ctx.role, 'ospeli_slots_step');
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
    const moves = c.moves || [];
    const reason = ui.cancelReason.get(c.sessionId) || null;
    // While the cancel list is open, "Fill N empty" is not offered on the same clinic.
    const wasOpen = openPanels.has(`cancel:${c.sessionId}`);
    const box_ = detailsBox('Cancel this clinic', 'cancel-clinic', `cancel:${c.sessionId}`,
      open.length ? [
        h('p', {}, h('b', {}, `${open.length} still booked. Move or cancel each one first, so nobody vanishes from a list.`)),
        h('p', { class: 'cl-hint', 'data-test': 'tell-patient' }, 'Tell each patient by your usual means: Ospeli sends no messages.'),
        h('p', { class: 'cl-hint' }, `Each booking is offered its own free slot in this clinic's service, at least ${data.picks.moveNoticeHours} hours from now (an example setting, not a standard) and not before its own date.`),
        here.length ? h('p', { class: 'cl-hint' }, `${here.length} already here (${here.map((a) => a.label).join(', ')}): finish their visit, or record that they left, on the queue.`) : null,
        h('ul', { class: 'cl-moves', 'data-test': 'move-list' }, moves.map((a) => {
          const to = a.moveTo;
          return h('li', { 'data-appointment': a.appointmentId, 'data-move': to ? `${to.sessionId} ${to.slotTime}` : 'none' },
            h('p', {}, h('b', {}, `${a.slotTime} ${a.label}`)),
            h('div', { class: 'cl-reasons' },
              to ? h('button', { class: 'btn btn-small', type: 'button', 'data-cmd': 'ospeli_slots_move', 'data-test': 'move',
                onclick: (e) => { e.currentTarget.disabled = true; act('ospeli_slots_move', { appointmentId: a.appointmentId, sessionId: to.sessionId, slotTime: to.slotTime, expectedState: 'booked' }, `${a.label} moved to ${slotWords(to.date, to.slotTime)}`); } },
              `Move to ${slotWords(to.date, to.slotTime)}`) : h('span', { class: 'cl-hint', 'data-test': 'no-move' }, 'No free slot in this clinic to move to: cancel only.'),
              h('button', { class: 'btn btn-ghost btn-small', type: 'button', 'data-cmd': 'ospeli_slots_cancel', 'data-test': 'cancel-booking',
                onclick: (e) => { e.currentTarget.disabled = true; act('ospeli_slots_cancel', { appointmentId: a.appointmentId, by: 'site', reason: data.picks.cancelForSession, expectedState: 'booked' }, `${a.label}: booking cancelled`); } }, 'Cancel booking')));
        })),
      ] : [
        h('p', { class: 'cl-hint' }, 'Nobody is booked. Why is it cancelled?'),
        h('div', { class: 'cl-reasons' }, data.picks.sessionChange.map((r) => h('button', { class: 'chip-btn', type: 'button', 'aria-pressed': String(reason === r), 'data-reason': r,
          onclick: () => { ui.cancelReason.set(c.sessionId, r); draw(); } }, r))),
        h('button', { class: 'btn btn-danger btn-small', type: 'button', 'data-cmd': 'ospeli_slots_session_change', 'data-test': 'cancel-session', disabled: !reason,
          onclick: () => act('ospeli_slots_session_change', { sessionId: c.sessionId, change: 'cancelled', reason, expectedState: c.state }, `${c.name}: cancelled (${reason?.toLowerCase()})`) },
        reason ? 'Cancel the clinic' : 'Pick a reason first'),
      ]);
    box_.addEventListener('toggle', () => { if (box_.open !== wasOpen) draw(); });
    return box_;
  }
  // After the clinic's end: each appointment still booked, waiting or in is closed with the shared
  // commands before the clinic is marked held, so nobody is left open on a list.
  // A row closed during this visit stays where it was, greyed with what was recorded, so the next
  // patient's buttons never slide up under the finger (a close-out step has no undo).
  function closeOut(c) {
    const kept = ui.closed.get(c.sessionId) || new Map();
    if (!c.ended || !(c.state === 'planned' || c.state === 'reduced') || (!c.open?.length && !kept.size)) return null;
    const openIds = new Set(c.open.map((a) => a.appointmentId));
    const pastDay = !!(c.date && ui.today && c.date < ui.today);
    const rows = [...c.open, ...[...kept.values()].filter((a) => !openIds.has(a.appointmentId))].sort((x, y) => (x.slotTime < y.slotTime ? -1 : x.slotTime > y.slotTime ? 1 : x.appointmentId < y.appointmentId ? -1 : 1));
    const remember = (e, a, words) => { if (!ui.closed.has(c.sessionId)) ui.closed.set(c.sessionId, kept); kept.set(a.appointmentId, { ...a, closedWords: words, px: Math.round(e.currentTarget.closest('li')?.getBoundingClientRect().height || 0) }); };
    const step = (a, s, label, extra = {}) => h('button', { class: 'btn btn-ghost btn-small', type: 'button', 'data-cmd': 'ospeli_slots_step', 'data-step': s, ...extra.attrs,
      onclick: (e) => { remember(e, a, label); e.currentTarget.disabled = true; act('ospeli_slots_step', { appointmentId: a.appointmentId, step: s, expectedState: a.state, ...(extra.reason ? { reason: extra.reason } : {}) }, `${a.label}: ${label.toLowerCase()}`); } }, label);
    // The hints read every row shown, closed here or not, so none vanishes and moves the list up.
    return h('section', { class: 'cl-close', 'data-test': 'close-out' },
      h('p', {}, h('b', {}, c.open.length ? `Still open (${c.open.length}): close each one, then mark the clinic held.` : 'All closed: the clinic can be marked held.')),
      // Issue #155: the queue link opens today's queue, and Arrived is marked on the clinic's own day,
      // so a past day's close-out has no link and says what is true.
      rows.some((a) => a.state === 'booked') ? h('p', { class: 'cl-hint', 'data-test': 'seen-not-arrived' }, pastDay
        ? `Seen on ${shortDate(c.date)} but never marked Arrived? Do not record a missed appointment. Arrived is marked only on the clinic's own day, so this booking stays open: a way to close it on a later day is not built yet.`
        : 'Seen but never marked Arrived? Do not record a missed appointment: mark Arrived on the clinic queue, then come back here for "Seen, no times".') : null,
      rows.some((a) => a.state === 'booked') && !pastDay ? h('p', {}, h('a', { class: 'btn btn-ghost btn-small', href: '#/clinics/queue', 'data-test': 'to-queue' }, 'Open the clinic queue')) : null,
      rows.some((a) => a.state === 'called') ? h('p', { class: 'cl-hint', 'data-test': 'late-finish' }, 'A Finished tapped now is recorded at this time, after the clinic\'s end, so the overrun figure will include it.') : null,
      rows.some((a) => a.state === 'arrived' || a.state === 'called') ? h('p', { class: 'cl-hint', 'data-test': 'not-tapped' }, `Seen but not tapped through? "${data.picks.noTimesName}" closes the visit as attended with no call or finish time. The start, wait and overrun figures leave it out and say how many.`) : null,
      h('ul', { class: 'cl-moves' }, rows.map((a) => (!openIds.has(a.appointmentId) ? keepPx(h('li', { class: 'is-done', 'data-appointment': a.appointmentId, 'data-state': 'closed', 'data-test': 'closed-here' },
        h('p', {}, h('b', {}, `${a.slotTime} ${a.label}`), ` · Closed: ${a.closedWords}`)), a.px) : h('li', { 'data-appointment': a.appointmentId, 'data-state': a.state },
        h('p', {}, h('b', {}, `${a.slotTime} ${a.label}`), ` · ${a.stateName}`),
        mayStep ? h('div', { class: 'cl-reasons' },
          a.state === 'called' ? step(a, 'finished', 'Finished (recorded now, late)') : null,
          a.state === 'arrived' || a.state === 'called' ? step(a, 'seen-no-times', data.picks.noTimesName, { attrs: { 'data-test': 'seen-no-times' } }) : null,
          a.state === 'arrived' ? h('button', { class: 'btn btn-ghost btn-small', type: 'button', 'data-cmd': 'ospeli_slots_cancel',
            onclick: (e) => { remember(e, a, 'Left before being seen'); e.currentTarget.disabled = true; act('ospeli_slots_cancel', { appointmentId: a.appointmentId, by: 'patient', reason: data.picks.leftReason, expectedState: 'arrived' }, `${a.label}: left before being seen`); } }, 'Left before being seen') : null,
          a.state === 'booked' && a.mayMarkMissed ? data.picks.missedReasons.map((r) => step(a, 'no-show', `Missed appointment: ${r.toLowerCase()}`, { reason: r, attrs: { 'data-reason': r } })) : null)
          : h('p', { class: 'cl-hint' }, `Closed by ${roleNames('ospeli_slots_step')}.`))))));
  }
  function clinicCard(c) {
    // With patients closed as "Seen, no times", the start figure may be later than the truth and the end
    // figure is only the earliest the clinic can have ended: the words say which way they lean.
    const startWords = c.firstCalledMinutes == null ? (c.noTimes ? 'No call time recorded.' : 'Nobody called yet.')
      : c.firstCalledAtMost ? (c.firstCalledMinutes <= 0 ? 'First recorded call on time.' : `First recorded call ${fmtWait(c.firstCalledMinutes)} after the start; the first patient may have been seen sooner.`)
      : c.firstCalledMinutes <= 0 ? 'First patient called on time.' : `First patient called ${fmtWait(c.firstCalledMinutes)} after the start.`;
    const endWords = c.overrunMinutes == null ? null
      : c.overrunAtLeast ? (c.overrunMinutes > 0 ? `Last recorded finish ${fmtWait(c.overrunMinutes)} after the planned end, at least.` : 'Last recorded finish by the planned end; the clinic may have ended later.')
      : c.overrunMinutes > 0 ? `Last patient finished ${fmtWait(c.overrunMinutes)} after the planned end.` : 'Finished by the planned end.';
    const trust = [c.noTimes ? `${c.noTimes} seen with no times (${data.picks.noTimesName}): left out of the end figure, and of the start figure when never called in.` : null,
      c.corrections ? `${c.corrections} ${c.corrections === 1 ? 'step' : 'steps'} undone as marked by mistake.` : null].filter(Boolean);
    const open = c.state === 'planned' || c.state === 'reduced';
    const usedOf = [c.missed ? `missed ${c.missed}` : null, c.leftBeforeSeen ? `left before being seen ${c.leftBeforeSeen}` : null].filter(Boolean);
    return h('li', { class: `card cl-day st-${c.state}`, 'data-session': c.sessionId, 'data-service': c.service, 'data-state': c.state },
      h('div', { class: 'cl-day-head' }, h('h3', {}, c.name), h('span', { class: `chip cl-sst st-${c.state}` }, c.stateName)),
      h('p', { class: 'cl-hint' }, `${c.start} to ${c.end}${c.reason ? ` · ${c.state === 'cancelled' ? 'Cancelled' : 'Reduced'}: ${c.reason}` : ''}`),
      c.state === 'cancelled' ? null : [
        // The figures add up: used + empty = offered.
        h('dl', { class: 'cl-figs', 'data-test': 'day-figures' },
          [['Used', c.used], ['Empty', c.empty], ['Offered', c.capacity]].map(([k, v]) => h('div', { 'data-fig': k.toLowerCase() }, h('dt', {}, k), h('dd', {}, String(v ?? 0))))),
        h('p', { class: 'cl-sum', 'data-test': 'day-sum' }, `Used ${c.used}${usedOf.length ? ` (of which ${usedOf.join(', ')})` : ''} + empty ${c.empty} = ${c.capacity} offered${c.templateSlots !== c.capacity ? ` (${c.templateSlots} in the template, reduced)` : ' (as in the template)'}.`),
        c.cancelled ? h('p', { class: 'cl-hint', 'data-test': 'day-cancelled' }, `Bookings cancelled: ${c.cancelled}. A cancelled booking's slot is either empty again or refilled by another booking, so it is counted there.`) : null,
        h('p', { 'data-test': 'waiting-now' }, c.counts.waiting ? h('b', {}, `Waiting now: ${c.counts.waiting}, longest ${fmtWait(c.counts.longestWaitMinutes)}.`) : 'Nobody waiting now.', ` ${c.counts.toCome} still to come.`),
        h('p', { class: 'cl-hint', 'data-test': 'start-end' }, startWords, endWords ? ` ${endWords}` : ''),
        trust.length ? h('p', { class: 'cl-hint', 'data-test': 'no-times-count' }, trust.join(' ')) : null,
        closeOut(c),
        h('div', { class: 'cl-reasons' },
          c.empty && mayBook && open && !c.ended && !openPanels.has(`cancel:${c.sessionId}`) ? h('a', { class: 'btn btn-small', href: `#/clinics/referrals/${c.service}`, 'data-test': 'fill-empty' }, `Fill ${c.empty} empty from the waiting list`) : null,
          mayPlan && c.mayMarkHeld ? h('button', { class: 'btn btn-ghost btn-small', type: 'button', 'data-cmd': 'ospeli_slots_session_change', 'data-test': 'mark-held',
            onclick: () => act('ospeli_slots_session_change', { sessionId: c.sessionId, change: 'held', expectedState: c.state }, `${c.name}: held`) }, 'Mark the clinic as held') : null),
        mayPlan && open && !c.ended ? cancelFlow(c) : null,
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
    if (k.id === 'clinic-wait') return `Median of ${k.n} patients, arrived to called.${k.leftOut ? ` ${k.leftOut} seen with no times (${d.picks.noTimesName}) left out.` : ''}`;
    if (k.id === 'clinic-start-punctuality') return `${k.numerator} of ${k.denominator} clinics held started on time (window ${d.picks.onTimeMinutes} min, example setting).${k.lateMaybe ? ` ${k.lateMaybe} counted late may have started on time: a patient seen with no times arrived before the first recorded call.` : ''}${k.nobodyCalled ? ` ${k.nobodyCalled} held with nobody called left out.` : ''}${k.noCallTimes ? ` ${k.noCallTimes} held with patients seen but no call time left out.` : ''}`;
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
      k.id === 'clinic-wait' && k.pastBooked ? h('p', { class: 'cl-hint', 'data-test': 'past-booked' }, `Headline: arrived to called. Beside it, wait past booked time: ${k.pastBooked.medianMinutes == null ? 'none yet' : `median ${fmtWait(k.pastBooked.medianMinutes)}`}, from the later of arrival and the booked time, so an early arrival is not the clinic running late.`) : null,
      k.id === 'slot-utilisation' && k.attended != null ? h('p', { class: 'cl-hint', 'data-test': 'used-split' }, `A missed appointment counts as a used slot: of the ${k.numerator} used, ${k.attended} attended and ${k.missed} missed.`) : null,
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

const STEP_WORDS = { arrived: 'mark arrived', called: 'call in', finished: 'mark finished', 'no-show': 'mark missed appointment', 'seen-no-times': 'mark seen, no times' };
function describeProposal(p, words = new Map()) {
  const i = p.input || {};
  if (p.command === 'ospeli_slots_step' && words.has(i.appointmentId)) return `${words.get(i.appointmentId)}: ${STEP_WORDS[i.step] || i.step}`;
  switch (p.command) {
    case 'ospeli_slots_book': return `Book Patient ${String(i.code || '').replace(/^pc-0*/, 'P')} at ${i.slotTime || ''}`;
    case 'ospeli_slots_move': return `Move appointment ${i.appointmentId} to ${i.slotTime || 'another slot'}`;
    case 'ospeli_slots_cancel': return `Cancel appointment ${i.appointmentId}: ${String(i.reason || '').toLowerCase()}`;
    case 'ospeli_slots_step': return `Mark appointment ${i.appointmentId}: ${i.step === 'no-show' ? 'missed appointment' : i.step === 'seen-no-times' ? 'seen, no times' : i.step}`;
    case 'ospeli_slots_session_change': return `${i.change === 'cancelled' ? 'Cancel' : i.change === 'held' ? 'Mark held' : 'Change'} session ${i.sessionId}${i.reason ? `: ${i.reason.toLowerCase()}` : ''}`;
    case 'ospeli_slots_session_plan': return `Plan a clinic on ${i.date}`;
    case 'ospeli_codes_open': return `Add a referral to the ${SERVICES[i.service] || 'clinic'} list`;
    case 'ospeli_codes_close': return `Close Patient ${String(i.code || '').replace(/^pc-0*/, 'P')}: ${String(i.reason || '').toLowerCase()}`;
    default: return p.command.replace(/^ospeli_/, '').replace(/_/g, ' ');
  }
}
