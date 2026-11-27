// Walk mode (backlog PM2): follow one patient visit or one item with a phone and tap as things
// happen. One screen, one big button. Every tap runs a named command (core/commands.js:
// ospeli_walks_get, ospeli_walks_step_start, ospeli_walks_step_done, ospeli_walks_step_name,
// ospeli_walks_undo, ospeli_walks_pause, ospeli_walks_resume, ospeli_walks_finish, ospeli_walks_discard,
// and ospeli_walks_start from the before-you-walk points); the command stamps the time, and
// the walk is saved on every tap, so a locked phone, a reload or a handed-over phone loses nothing.
// The timer on screen is worked out from those saved times; it is never the record.
//
// Walk-first week (founder, 22 Nov 2026; ospeli/ospeli docs/briefs/2026-11-22-walk-first.md):
// the walk is full screen (the shell hides its dock while <html data-walk-full> is set) and the
// main button, with Pause and Undo, is pinned to the bottom, so it never leaves the screen.
// Naming is a short sheet above the button: one row of step words and one of roles, from the
// department chosen on the device (ctx.department); typing and the two tick boxes are behind
// "More options". Tapping the main button while naming saves what is chosen.
//
// The tap-through walk sheet (brief, Builder nights 4 to 6; 27 Nov 2026): on a first walk in a
// department with a step list, the list is the page, as large rows. The main button is named for
// the step offered next and starts it by that name; a tapped row starts that step instead (any
// step, any order: the list never forces one); the running row ends its step. "+ Another step"
// starts a step that is not on the list, named afterwards. Nothing is typed during the walk. The
// record keeps where each name and role came from (#170): a tapped row is "chosen", the main
// button's step is "from the list", and the list's role is "from the list" until a person picks one.
import { h } from './ui.js';
import { fmtClock, fmtSeconds } from '../core/walk.js';

const UNDO_MS = 10000;

// Draws the walk in progress into `box`. Returns a function that stops its timer.
// againOf: the map whose saved step list is walked again (a repeat walk), or null for a first walk.
export async function renderWalk(box, ctx, againOf = null) {
  // picked: which of the two answers the person chose by hand (the other may be the offer, already chosen).
  const ui = { busy: false, sheet: false, more: false, name: '', role: '', picked: { name: false, role: false }, msg: false, next: false, confirm: false, undoUntil: 0, question: null, error: '', flash: null, kept: null, rename: false, title: '', startError: null, typed: false, from: { name: null, role: null }, follow: false };
  const root = document.documentElement;
  root.dataset.walkFull = '1';
  let data = null; let again = null; let offset = 0; let timer = null; let undoTimer = null; let lock = null; let stopped = false;

  const keepAwake = async () => { try { lock = await navigator.wakeLock?.request('screen'); } catch { lock = null; } };
  const onVisible = () => { if (document.visibilityState === 'visible') { keepAwake(); tick(); } };
  document.addEventListener('visibilitychange', onVisible);
  keepAwake();

  // Spoken state (#103): one polite line beside the walk, kept across redraws so a screen reader
  // hears "Step started. Hands-on." after a tap. The big timer itself stays silent.
  const status = h('p', { class: 'sr-only', role: 'status', 'aria-live': 'polite', 'data-test': 'walk-status' });
  box.after(status);
  const say = (text) => { status.textContent = text; };
  // Keyboard focus (#103): the screen is redrawn after every tap, so focus is put back on the
  // control that had it, or on the main button when that control is gone.
  const focusKey = () => {
    const a = document.activeElement;
    if (!a || !box.contains(a)) return null;
    if (a.dataset.test) return `[data-test="${a.dataset.test}"]`;
    if (a.id) return `#${a.id}`;
    return '[data-test="walk-main"]';
  };
  const refocus = (key) => { if (key) (box.querySelector(key) || box.querySelector('[data-test="walk-main"]'))?.focus({ preventScroll: true }); };

  const nowMs = () => Date.now() - offset;
  const secsSince = (iso) => Math.max(0, (nowMs() - Date.parse(iso)) / 1000);
  // The big timer: the present wait or step without any time not seen; while paused, the pause itself.
  const shown = (w) => (w.state === 'paused' ? secsSince(w.since) : Math.max(0, secsSince(w.presentSince || w.since) - (w.sinceNotSeenSec || 0) - (w.sinceStoodSec || 0)));

  async function load() {
    data = await ctx.run('ospeli_walks_get', ctx.department ? { department: ctx.department } : {});
    // Whether this phone has agreed to keep the app's data (asked for when a walk starts).
    try { ui.kept = (await navigator.storage?.persisted?.()) ?? null; } catch { ui.kept = null; }
    offset = Date.now() - Date.parse(data.now);
    // Before a repeat walk starts: which walk of the map this will be. A map that is gone or was
    // not made from a walk falls back to a first walk.
    again = null;
    if (!data.walk && againOf) { try { const m = await ctx.run('ospeli_maps_get', { mapId: againOf, format: 'short' }); if (m.range) again = { mapId: m.id, title: m.title, walkNo: m.range.count + 1, aim: m.range.aim }; } catch { again = null; } }
  }
  async function tap(name, input = {}) {
    if (ui.busy) return null;
    ui.busy = true;
    try {
      const out = await ctx.run(name, input);
      data = { ...data, walk: out.walk };
      return out;
    } catch (err) {
      if (err.detail?.confirm === 'notAName') ui.question = { looks: err.detail.looksLike, retry: () => tap(name, { ...input, notAName: true }).then((o) => { if (o) afterNamed(); }) };
      // While the naming sheet is open the reason shows inside it, under the fields, and stays.
      else if (ui.sheet && name === 'ospeli_walks_step_name') ui.error = /names a person/.test(err.message) ? 'That looks like a person\'s name. Use a role instead, like Doctor or Nurse.' : err.message;
      else ctx.toast(`Not saved. ${err.message}`);
      return null;
    } finally { ui.busy = false; }
  }
  const showUndo = () => { ui.undoUntil = Date.now() + UNDO_MS; clearTimeout(undoTimer); undoTimer = setTimeout(() => { if (!stopped) draw(); }, UNDO_MS + 50); };
  const resetSheet = () => { box.querySelectorAll('#wk-name, #wk-role').forEach((i) => { i.value = ''; }); ui.sheet = false; ui.more = false; ui.name = ''; ui.role = ''; ui.picked = { name: false, role: false }; ui.from = { name: null, role: null }; ui.typed = false; ui.again = null; ui.msg = false; ui.next = false; ui.question = null; ui.error = ''; };
  // Open the naming sheet for the step that just ended. In a department with a step list the
  // usual next step and its usual role are offered already chosen (an example setting): one tap
  // on another chip changes either, and nothing is saved until the person's next tap.
  function openSheet(w) {
    resetSheet(); ui.sheet = true; ui.flash = null;
    // With the list on the page, a step that ends unnamed was started as "not on the list": nothing is offered for it.
    if (w.suggest && !w.list) { ui.name = w.suggest.name; ui.role = w.suggest.role || ''; ui.from = { name: 'list', role: w.suggest.role ? 'list' : null }; }
  }
  // Where the words in the sheet came from (#170): sent with them, so the record can tell a name the
  // person chose from one that was only offered.
  const sources = (name, role) => ({ ...(name && ui.from.name && ui.from.name !== 'typed' ? { nameFrom: ui.from.name } : {}), ...(role && ui.from.role ? { roleFrom: ui.from.role } : {}) });
  // The step and role words can change with every name saved (a name typed once is offered at once).
  async function refreshChips() { try { const d = await ctx.run('ospeli_walks_get', {}); data = { ...data, stepChips: d.stepChips, roleChips: d.roleChips, usualRoles: d.usualRoles }; } catch { /* the words on screen stay */ } }
  // Scroll an element up so it ends above the walk's bar when that bar is pinned (phones).
  function liftAboveBar(el) {
    const bar = box.querySelector('[data-test="walk-bar"]');
    if (!el || !bar || !/fixed|sticky/.test(getComputedStyle(bar).position)) return;
    const over = el.getBoundingClientRect().bottom - (bar.getBoundingClientRect().top - 8);
    if (over > 0) window.scrollBy(0, over);
  }
  async function afterNamed() { resetSheet(); await refreshChips(); draw(); }
  // A step name is "typed" when it came from the field and is not one of the words offered (#188 item 4).
  const typedNow = (name) => !!name && (ui.typed || !!box.querySelector('#wk-name')?.value.trim()) && !data.stepChips.includes(name);
  // Words typed in a field are the person's own answer (#188 item 1): they take the place of any chip,
  // and a role that was only offered with the offered step goes with it. The chips are un-pressed in
  // place, with no redraw, so the keyboard stays open.
  function typing(kind, value) {
    const text = value.trim();
    if (kind === 'name') {
      ui.name = text; ui.typed = !!text; ui.picked.name = !!text; ui.from.name = text ? 'typed' : null;
      if (text && !ui.picked.role) { ui.from.role = null; ui.role = ''; for (const c of box.querySelectorAll('[data-chip="role"]')) c.setAttribute('aria-pressed', 'false'); }
    } else { ui.role = text; ui.picked.role = !!text; ui.from.role = text ? 'typed' : null; }
    for (const c of box.querySelectorAll(`[data-chip="${kind}"]`)) c.setAttribute('aria-pressed', 'false');
    if (ui.error) { ui.error = ''; box.querySelector('[data-test="walk-error"]')?.remove(); }
  }
  // What is chosen or typed in the sheet and not yet saved.
  function pending() {
    const name = box.querySelector('#wk-name')?.value.trim() || ui.name; const role = box.querySelector('#wk-role')?.value.trim() || ui.role;
    return ui.sheet === true && (name || role) ? { ...(name ? { name, ...(typedNow(name) ? { typed: true } : {}) } : {}), ...(role ? { role } : {}), ...sources(name, role), msg: ui.msg } : null;
  }
  // Save it for the step that ended last. The sheet closes and one line says what was saved; when
  // the words are refused (they look like a person's name) the sheet stays open with the reason.
  async function savePending(p) {
    const n = data.walk.steps.length;
    const out = await tap('ospeli_walks_step_name', p);
    if (!out) return false;
    const st = out.walk.steps[n - 1];
    resetSheet(); ui.flash = st ? flashOf(st) : null;
    await refreshChips();
    return true;
  }

  // The line that says what a step was saved as, from the saved step itself.
  const flashOf = (st) => ({ n: st.n, name: st.named || !/^Step \d+$/.test(st.name) ? st.name : null, role: st.role && st.role !== 'Not set' ? st.role : null, nameFrom: st.nameFrom || null, roleFrom: st.roleFrom || null, again: !!st.again });

  async function saveName() {
    const typedName = box.querySelector('#wk-name')?.value.trim() || ''; const typedRole = box.querySelector('#wk-role')?.value.trim() || '';
    const name = typedName || ui.name; const role = typedRole || ui.role;
    // The reason shows inside the sheet, beside Save, and stays until it is put right (#188 item 2).
    if (!name || !role) { ui.name = name; ui.role = role; ui.error = !name ? 'Choose or type a step, or tap “Name it later”.' : 'Choose or type a role, or tap “Name it later”.'; draw(); return; }
    const typed = typedNow(name); const n = data.walk.steps.length;
    ui.name = name; ui.role = role; ui.error = '';
    const out = await tap('ospeli_walks_step_name', { name, role, msg: ui.msg, ...(typed ? { typed: true } : {}), ...sources(name, role), ...(ui.again != null ? { again: ui.again } : {}), ...(ui.next && data.walk.state === 'waiting' ? { nextStarted: true } : {}) });
    // One line says what was saved, in the person's own words, with a way to change it.
    if (out) { const st = out.walk.steps[n - 1]; await afterNamed(); if (st) { ui.flash = flashOf(st); say(`Step ${st.n} saved as ${name}, ${role}.`); draw(); } } else draw();
  }

  function tick() {
    if (stopped || !data?.walk) return;
    const w = data.walk;
    const t = box.querySelector('[data-test="walk-timer"]'); const total = box.querySelector('[data-test="walk-total"]');
    if (t) t.textContent = fmtClock(shown(w));
    if (total) total.textContent = `Whole walk ${fmtClock(secsSince(w.startedAt))}`;
  }

  function sheet(w) {
    const last = w.steps[w.steps.length - 1];
    const offered = !!w.suggest && !ui.picked.name && ui.name === w.suggest.name;
    const chip = (kind, text) => h('button', { type: 'button', class: 'chip-btn walk-chip', 'data-chip': kind, 'aria-pressed': String(ui[kind] === text),
      onclick: () => {
        const typed = { name: box.querySelector('#wk-name'), role: box.querySelector('#wk-role') };
        ui.name = typed.name?.value.trim() || ui.name; ui.role = typed.role?.value.trim() || ui.role;
        const other = kind === 'name' ? 'role' : 'name';
        ui[kind] = text; ui.picked[kind] = true; ui.from[kind] = 'chosen'; if (typed[kind]) typed[kind].value = ''; if (kind === 'name') ui.typed = false; ui.error = '';
        // A step from the department's list brings the role that usually does it, unless the person chose one.
        if (kind === 'name' && !ui.picked.role && data.usualRoles?.[text]) { ui.role = data.usualRoles[text]; ui.from.role = 'list'; }
        // The second of the person's two answers saves the step: no extra tap. An answer that was
        // only offered is not the person's, so it waits for the main button or "Save step".
        if (ui.name && ui.role && (ui.picked[other] || typed[other]?.value.trim())) saveName(); else draw();
      } }, text);
    // The chosen word first, so it is seen without sliding the row.
    const first = (list, on) => (on && list.includes(on) ? [on, ...list.filter((c) => c !== on)] : list);
    const row = (kind, word, label, list) => h('div', { class: 'walk-chips is-row', role: 'group', 'aria-label': label, 'data-test': `walk-row-${kind}` },
      h('span', { class: 'walk-row-word', 'aria-hidden': 'true' }, word), first(list, ui[kind]).map((c) => chip(kind, c)),
      // The step row ends with the way to a step that is not among the words offered (#188 item 3).
      kind === 'name' ? h('button', { type: 'button', class: 'chip-btn walk-chip walk-own', 'data-test': 'walk-own', onclick: () => { ui.more = true; draw(); box.querySelector('#wk-name')?.focus({ preventScroll: true }); } }, '+ Add your own') : null);
    return h('section', { class: `walk-sheet${ui.more ? ' is-more' : ''}`, 'data-test': 'walk-sheet', 'aria-labelledby': 'wk-sheet-h' },
      h('div', { class: 'walk-sheet-head' },
        h('h2', { id: 'wk-sheet-h' }, `Step ${last.n}: ${fmtSeconds(last.workSec)}`),
        h('p', { class: 'walk-sheet-hint', 'data-test': 'walk-sheet-hint' }, offered ? 'Next on the list. Tap another if not.' : w.canResume ? 'Name the step that was interrupted.' : 'Name this step. The clock keeps running.')),
      // The reason a save was refused sits at the top of the sheet, where it is seen without sliding the sheet.
      ui.error ? h('p', { class: 'walk-error', role: 'alert', 'data-test': 'walk-error' }, ui.error) : null,
      row('name', 'Step', 'What happened?', data.stepChips),
      row('role', 'Role', 'Which role did it? A role, never a name', data.roleChips),
      ui.more ? h('div', { class: 'walk-more-box', 'data-test': 'walk-more-box' },
        h('div', { class: 'field' },
          h('label', { for: 'wk-name' }, 'What happened?'),
          h('input', { id: 'wk-name', maxlength: '140', placeholder: 'Say what happened', value: data.stepChips.includes(ui.name) ? '' : ui.name, autocomplete: 'off', oninput: (e) => typing('name', e.target.value) })),
        h('div', { class: 'field' },
          h('label', { for: 'wk-role' }, 'Which role did it? (a role, never a name)'),
          h('input', { id: 'wk-role', maxlength: '60', placeholder: 'Say which role', value: data.roleChips.includes(ui.role) ? '' : ui.role, autocomplete: 'off', oninput: (e) => typing('role', e.target.value) })),
        h('label', { class: 'check' }, h('input', { type: 'checkbox', id: 'wk-msg', checked: ui.msg ? true : null, onchange: (e) => { ui.msg = e.target.checked; } }), 'It only passed on information (a call, message or form)'),
        h('label', { class: 'check' }, h('input', { type: 'checkbox', id: 'wk-again', 'data-test': 'walk-again-tick', checked: (ui.again ?? !!last.again) ? true : null, onchange: (e) => { ui.again = e.target.checked; } }), 'This step was done again on this visit'),
        w.state === 'waiting' ? h('label', { class: 'check' }, h('input', { type: 'checkbox', id: 'wk-next', checked: ui.next ? true : null, onchange: (e) => { ui.next = e.target.checked; } }), 'The next step has already started') : null) : null,
      ui.question ? h('div', { class: 'name-question', role: 'alert', 'data-test': 'name-question' },
        h('p', {}, h('b', {}, `Is “${ui.question.looks}” a person's name?`)),
        h('p', {}, 'Ospeli times steps, never people. Use a role instead, for example Doctor, Nurse or Pharmacy.'),
        h('div', { class: 'form-actions' },
          h('button', { type: 'button', class: 'btn', onclick: () => { ui.question = null; ui.more = true; draw(); } }, 'Change the wording'),
          h('button', { type: 'button', class: 'btn btn-ghost', 'data-test': 'name-keep', onclick: () => { const q = ui.question; ui.question = null; q.retry(); } }, 'Not a name. Save it'))) : null,
      h('div', { class: 'walk-sheet-foot' },
        h('button', { type: 'button', class: 'btn btn-ghost', 'data-test': 'walk-more', 'aria-expanded': String(ui.more),
          onclick: () => { for (const kind of ['name', 'role']) { const t = box.querySelector(`#wk-${kind}`)?.value.trim(); if (t) ui[kind] = t; } ui.more = !ui.more; draw(); if (ui.more) box.querySelector('#wk-name')?.focus({ preventScroll: true }); } }, ui.more ? 'Fewer options' : 'More options'),
        h('button', { type: 'button', class: 'btn btn-ghost', 'data-test': 'walk-later',
          // "The next step has already started" still counts when the name is left for later.
          onclick: async () => { if (ui.next && data.walk.state === 'waiting') await tap('ospeli_walks_step_name', { nextStarted: true }); resetSheet(); draw(); } }, 'Name it later'),
        h('button', { type: 'button', class: 'btn', 'data-cmd': 'ospeli_walks_step_name', 'data-test': 'walk-save', onclick: saveName }, 'Save step')));
  }

  // "Waiting for what?" (#180 point 1): after a wait of two minutes or more, and after "Step
  // interrupted", the reasons above the buttons, wrapped so every one is seen. One tap keeps one; no tap keeps nothing and
  // the walk goes on the same. The words say what was missing, never who (an example setting).
  function reasonRow(w) {
    const of = w.askReason.of; const label = of === 'stop' ? 'What stopped it?' : 'What was the wait for?';
    return h('div', { class: 'walk-chips walk-reason', role: 'group', 'aria-label': `${label} You can leave this.`, 'data-test': 'walk-reason', 'data-of': of },
      h('span', { class: 'walk-row-word walk-reason-word', 'aria-hidden': 'true' }, label),
      (data.waitReasons || []).map((r) => h('button', { type: 'button', class: 'chip-btn walk-chip walk-reason-chip', 'data-reason': r.id, 'data-cmd': 'ospeli_walks_reason',
        onclick: async () => { const out = await tap('ospeli_walks_reason', { of, reason: r.id }); if (out) { ui.given = { of, n: of === 'stop' ? w.steps.length : w.steps.length + 1, text: r.text }; say(`Saved: ${r.text}.`); } draw(); } }, r.text)));
  }
  // The reason just given, with one way to take it back, while the step it belongs to is the present one.
  function reasonLine(w) {
    const g = ui.given; if (!g) return null;
    const here = g.of === 'stop' ? (w.state === 'waiting' && w.canResume && w.steps.length === g.n) : (w.state === 'step' && w.steps.length + 1 === g.n);
    if (!here) { ui.given = null; return null; }
    return h('p', { class: 'walk-saved walk-reason-line', 'data-test': 'walk-reason-line' },
      h('span', {}, g.of === 'stop' ? 'Stopped by: ' : 'Waited for: ', h('b', {}, g.text)),
      h('button', { type: 'button', class: 'btn btn-ghost walk-change', 'data-test': 'walk-reason-change', 'data-cmd': 'ospeli_walks_reason',
        onclick: async () => { const out = await tap('ospeli_walks_reason', { of: g.of, reason: null }); if (out) ui.given = null; draw(); } }, 'Change reason'));
  }

  // Repeat walk: the step that just ended took its name from the list. One line says so, with one
  // way out when the visit differed: pick the list step it really was, or say it is not on the list.
  function savedLine(w) {
    const last = w.steps[w.steps.length - 1];
    if (ui.sheet === 'pick') {
      return h('section', { class: 'walk-sheet walk-pick', 'data-test': 'walk-pick', 'aria-labelledby': 'wk-pick-h' },
        h('h2', { id: 'wk-pick-h' }, 'Which step was it?'),
        h('div', { class: 'walk-chips' },
          w.repeat.list.map((p) => h('button', { type: 'button', class: 'chip-btn walk-chip', 'data-test': 'walk-pick-step', 'data-cmd': 'ospeli_walks_step_name', 'aria-pressed': String(last.listStep === p.n),
            onclick: async () => { const out = await tap('ospeli_walks_step_name', { listStep: p.n }); if (out) { ui.sheet = 'saved'; say(`Saved as ${p.name}.`); draw(); } } }, `${p.n}. ${p.name}`)),
          h('button', { type: 'button', class: 'chip-btn walk-chip', 'data-test': 'walk-pick-off', 'data-cmd': 'ospeli_walks_step_name',
            onclick: async () => { const out = await tap('ospeli_walks_step_name', { offList: true }); if (out) { resetSheet(); ui.sheet = true; draw(); } } }, 'Not on the list')),
        h('div', { class: 'form-actions' }, h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => { ui.sheet = 'saved'; draw(); } }, 'Back')));
    }
    return h('p', { class: 'walk-saved', 'data-test': 'walk-saved' },
      h('span', {}, `Step ${last.n} saved as `, h('b', {}, last.name), ` · ${fmtSeconds(last.workSec)}`),
      h('button', { type: 'button', class: 'btn btn-ghost walk-change', 'data-test': 'walk-change', onclick: () => { ui.sheet = 'pick'; draw(); } }, 'Change'));
  }
  // Repeat walk: the list step that comes next (or is running), above the timer.
  function nextLine(w) {
    const rp = w.repeat; const item = rp.now || (w.state === 'step' ? null : rp.next);
    if (!item) return h('p', { class: 'walk-next', 'data-test': 'walk-next' }, h('span', { class: 'walk-next-n' }, w.state === 'step' ? 'A step not on the list' : 'End of the list'), w.state === 'step' ? null : h('span', { class: 'walk-next-role' }, 'More steps? Tap Step starts.'));
    return h('p', { class: 'walk-next', 'data-test': 'walk-next' },
      h('span', { class: 'walk-next-n' }, `${rp.now ? 'Now' : 'Next'}: step ${item.n} of ${rp.list.length} · ${item.role}`),
      h('b', { class: 'walk-next-name' }, item.name));
  }

  // The tap-through sheet: the department's step list as rows. While waiting, a row starts its step
  // now; while a step runs, its own row ends it and the others wait. Every row says what happened to
  // its step on this walk in words (never by colour alone): the wait before it and its hands-on time.
  const min = (sec) => (sec < 60 ? 'under 1 min' : `${Math.round(sec / 60)} min`);
  function listBox(w, { starts, done }) {
    const step = w.state === 'step';
    const row = (p) => {
      const running = p.state === 'running';
      const word = running ? 'Timing now' : p.state === 'next' && !step ? 'Next' : p.afterVisit && p.state !== 'timed' ? 'After the visit' : '';
      // A timed row says what the taps gave, to check against what was just seen: the wait before it, then its hands-on time.
      const timed = p.state === 'timed' ? `waited ${min(p.waitSec)} · ${min(p.workSec)} ${p.role === 'Patient' ? 'patient step' : 'hands-on'}${p.times > 1 ? ` · done ${p.times} times` : ''}` : null;
      return h('li', {}, h('button', { type: 'button', class: `walk-rowbtn is-${p.state}`, 'data-test': 'walk-list-row', 'data-n': String(p.n), 'data-state': p.state, 'data-cmd': running ? 'ospeli_walks_step_done' : 'ospeli_walks_step_start',
        disabled: step && !running ? true : null, ...(running ? { 'aria-current': 'step' } : {}),
        onclick: () => (running ? done() : starts({ fresh: true, list: { listStep: p.n, picked: true } })) },
        h('span', { class: 'wl-n', 'aria-hidden': 'true' }, p.state === 'timed' ? '✓' : String(p.n)),
        h('span', { class: 'wl-what' }, h('b', {}, p.name), p.role || timed ? h('span', { class: 'wl-role' }, [p.role, timed].filter(Boolean).join(' · ')) : null),
        word ? h('span', { class: 'wl-state' }, word) : null));
    };
    return h('section', { class: 'walk-list', 'data-test': 'walk-list', 'aria-labelledby': 'wk-list-h' },
      h('h2', { id: 'wk-list-h' }, 'Example steps. Yours may differ.'),
      h('p', { class: 'walk-list-hint', 'data-test': 'walk-list-hint' }, step ? 'Tap it again when it ends.' : 'Tap a step when it starts. Any order.'),
      h('ol', { class: 'walk-rows' }, w.list.map(row),
        h('li', {}, h('button', { type: 'button', class: 'walk-rowbtn is-other', 'data-test': 'walk-list-other', 'data-cmd': 'ospeli_walks_step_start', disabled: step ? true : null,
          onclick: () => starts({ fresh: true, list: {} }) }, h('span', { class: 'wl-n', 'aria-hidden': 'true' }, '+'), h('span', { class: 'wl-what' }, h('b', {}, 'Another step'), h('span', { class: 'wl-role' }, 'Not on this list. Name it after.')),
          // A step that is not on the list is running: its row says so, and no list row reads as next.
          step && !w.running?.name ? h('span', { class: 'wl-state', 'data-test': 'walk-other-now' }, 'Timing now') : null)))); 
  }
  // After a tap the list follows: the row before the present one sits at the top, so the step done
  // last, the present step and the next one are the three in sight above the bar.
  function followList() {
    const rows = [...box.querySelectorAll('[data-test="walk-list-row"]')];
    const i = rows.findIndex((r) => r.dataset.state === 'running' || r.dataset.state === 'next');
    if (i < 0) return;
    const head = document.querySelector('.topbar'); const fixed = head && /fixed|sticky/.test(getComputedStyle(head).position) ? head.getBoundingClientRect().bottom : 0;
    // Room between the top bar and the walk's bar: the row before stays in sight when all three fit.
    const bar = box.querySelector('[data-test="walk-bar"]'); const pinned = bar && /fixed/.test(getComputedStyle(bar).position);
    const room = (pinned ? bar.getBoundingClientRect().top : window.innerHeight) - fixed - 16;
    const from = rows[Math.max(0, i - 1)]; const to = rows[Math.min(rows.length - 1, i + 1)];
    const first = i > 0 && to.getBoundingClientRect().bottom - from.getBoundingClientRect().top <= room ? from : rows[i];
    window.scrollBy(0, first.getBoundingClientRect().top - fixed - 8);
  }

  function draw() {
    if (stopped) return;
    const key = focusKey();
    // Words typed but not yet saved survive a redraw (the Undo button leaving after 10 seconds).
    for (const kind of ['name', 'role']) { const typed = box.querySelector(`#wk-${kind}`)?.value.trim(); if (typed) ui[kind] = typed; }
    // A row of chips slid sideways stays where the person left it.
    const slid = Object.fromEntries([...box.querySelectorAll('.walk-chips.is-row')].map((r) => [r.dataset.test, r.scrollLeft]));
    paint();
    for (const r of box.querySelectorAll('.walk-chips.is-row')) if (slid[r.dataset.test] && !r.querySelector('[aria-pressed="true"]')) r.scrollLeft = slid[r.dataset.test];
    // The pinned bar covers the bottom of the page: the page keeps that much room under the walk.
    const bar = box.querySelector('.walk-bar');
    box.style.setProperty('--walk-bar', bar ? `${Math.ceil(bar.getBoundingClientRect().height)}px` : '0px');
    if (ui.follow) { ui.follow = false; followList(); }
    refocus(key);
  }

  // Before the first tap (issue #124): the points a person confirms, the stop rule first. A first
  // walk also says what it follows: a title, typed or tapped from the department's examples, or
  // left empty. One tap starts the walk and the clock. Nothing about anyone is kept, only the time.
  function paintBefore() {
    const start = async (extra = {}) => {
      if (ui.busy) return;
      ui.busy = true; ui.startError = null;
      const title = again ? '' : (box.querySelector('#wk-title')?.value || ui.title).trim();
      try {
        await ctx.run('ospeli_walks_start', { guidanceSeen: true, ...(again ? { mapId: again.mapId } : {}), ...(title ? { title } : {}), ...(!again && ctx.department ? { department: ctx.department } : {}), ...extra });
        // Ask the phone to keep the app's data: without it a phone short of space may clear a walk.
        try { const kept = await navigator.storage?.persist?.(); if (typeof kept === 'boolean') ui.kept = kept; } catch { /* not offered on this phone */ }
        const keptNow = ui.kept; await load(); if (keptNow != null) ui.kept = keptNow;
        say('Walk started. Waiting.');
      } catch (err) {
        if (err.detail?.confirm === 'notAName') ui.startError = { text: `Is “${err.detail.looksLike}” a person's name? A walk is named for what it follows, never for a person.`, ask: true };
        else if (title) ui.startError = { text: /names a person|personal|holds/.test(err.message) ? 'That looks like a person\'s name or a personal detail. Say what you are walking, for example “Outpatient CT”.' : err.message };
        else ctx.toast(`Not started. ${err.message}`);
      } finally { ui.busy = false; }
      draw(); box.querySelector('[data-test="walk-main"]')?.focus({ preventScroll: true });
    };
    box.replaceChildren(h('section', { class: 'card walk-before', 'data-test': 'walk-before', 'aria-labelledby': 'wk-before-h' },
      h('h1', { id: 'wk-before-h' }, 'Before you walk'),
      again ? h('p', { class: 'walk-sub', 'data-test': 'walk-before-again' }, `${/^Walk \d+$/.test(again.title) ? '' : `${again.title} · `}Walk ${again.walkNo}${again.walkNo <= again.aim ? ` of ${again.aim}` : ''} · same step list`)
        : h('div', { class: 'field walk-title', 'data-test': 'walk-title' },
          h('label', { for: 'wk-title' }, 'What are you walking?'),
          h('input', { id: 'wk-title', maxlength: '80', autocomplete: 'off', enterkeyhint: 'done', placeholder: `For example, ${(data.titles || [])[0] || 'Clinic visit'}`, value: ui.title, oninput: (e) => { ui.title = e.target.value; ui.startError = null; } }),
          h('div', { class: 'walk-chips is-row', role: 'group', 'aria-label': 'Examples', 'data-test': 'walk-row-title' },
            (data.titles || []).map((t) => h('button', { type: 'button', class: 'chip-btn walk-chip', 'data-chip': 'title', 'aria-pressed': String(ui.title === t), onclick: () => { ui.title = ui.title === t ? '' : t; ui.startError = null; draw(); } }, t)))),
      ui.startError ? h('p', { class: 'walk-error', role: 'alert', 'data-test': 'walk-error' }, ui.startError.text,
        ui.startError.ask ? h('button', { type: 'button', class: 'btn btn-ghost', 'data-test': 'name-keep', onclick: () => start({ notAName: true }) }, 'Not a name. Start the walk') : null) : null,
      h('ul', { class: 'walk-before-list' }, (data.before || []).map((line, i) => h('li', { class: i === 0 ? 'first' : null }, line))),
      h('button', { type: 'button', class: 'btn walk-before-ok', 'data-test': 'walk-before-ok', 'data-cmd': 'ospeli_walks_start', onclick: () => start() }, 'Done. Start the walk'),
      h('p', { class: 'meta walk-before-foot' }, 'The clock starts when you tap. ', h('a', { href: again ? `#/process/${again.mapId}` : '#/process', 'data-test': 'walk-before-no' }, 'Not now'))));
  }

  // The top of the walk: the way out that leaves the walk running, and what is being walked.
  const top = (sub) => h('div', { class: 'walk-top' },
    // A plain full-width button, not a heading with a chevron (#187 item 2): it was read as a fold-away section.
    h('a', { class: 'btn btn-ghost walk-leave', href: '#/home', 'data-test': 'walk-leave' }, h('span', { class: 'walk-leave-mark', 'aria-hidden': 'true' }), 'Hide walk (keeps timing)'),
    h('h1', { id: 'wk-h', class: 'sr-only' }, 'Walk in progress'),
    h('p', { class: 'walk-sub', 'data-test': 'walk-sub' }, sub));
  // The state word and the clock, in the pinned bar with the main button.
  const now = (word, w) => h('div', { class: 'walk-now', 'aria-live': 'off' },
    h('span', { class: 'walk-state', 'data-test': 'walk-state' }, word),
    h('span', { class: 'walk-timer', role: 'timer', 'data-test': 'walk-timer' }, fmtClock(shown(w))),
    h('span', { class: 'walk-meta' }, h('span', { 'data-test': 'walk-total' }, `Whole walk ${fmtClock(secsSince(w.startedAt))}`), ` · ${w.steps.length} ${w.steps.length === 1 ? 'step' : 'steps'} saved`));
  // Three places that never move: Pause, Undo, and the one other choice the moment offers.
  const side = (a, b, c) => h('div', { class: 'walk-side' }, [a, b, c].map((x) => x || h('span', { class: 'walk-slot', 'aria-hidden': 'true' })));

  function paint() {
    const w = data?.walk;
    if (!w || w.status !== 'walking') { paintBefore(); return; }
    const paused = w.state === 'paused';
    const step = w.state === 'step';
    const rp = w.repeat || null;
    // A walk nobody named is called "Walk 1": on a repeat walk that would read as a walk number, so it is left out.
    const walkOf = rp ? `Walk ${rp.walkNo}${rp.walkNo <= rp.aim ? ` of ${rp.aim}` : ''}` : '';
    const sub = rp ? (/^Walk \d+$/.test(w.title) ? `${walkOf} · same step list` : `${w.title} · ${walkOf.toLowerCase()}`) : (/^Walk \d+$/.test(w.title) ? 'One visit, step by step' : `${w.title} · step by step`);
    const undoBtn = (onclick) => h('button', { type: 'button', class: 'btn btn-ghost walk-undo', 'data-test': 'walk-undo', 'data-cmd': 'ospeli_walks_undo', onclick }, 'Undo last tap');
    if (paused) {
      // The person has stepped out: one state word, one button, nothing counted.
      box.replaceChildren(h('section', { class: `walk is-paused${rp ? ' is-repeat' : ''}`, 'data-test': 'walk', 'data-state': 'paused', 'aria-labelledby': 'wk-h' },
        top(sub),
        h('p', { class: 'walk-def', 'data-test': 'walk-def' }, `Paused: nothing is counted. This time shows on the map as “not seen”. ${w.under === 'step' ? 'The step carries on when you are back.' : 'The wait carries on when you are back.'}`),
        h('p', { class: 'meta walk-foot' }, 'Time the steps, never the people. People decide; Ospeli suggests.'),
        h('div', { class: 'walk-bar', 'data-test': 'walk-bar' },
          now('Paused', w),
          side(null, Date.now() < ui.undoUntil ? undoBtn(async () => { const out = await tap('ospeli_walks_undo'); if (out) { ui.undoUntil = 0; say('Undone. Not paused.'); ctx.toast('Undone. Not paused.'); draw(); } }) : null, null),
          h('button', { type: 'button', class: 'btn walk-main', 'data-test': 'walk-main', 'data-cmd': 'ospeli_walks_resume',
            onclick: async () => { const out = await tap('ospeli_walks_resume'); if (!out) return; say(out.walk.state === 'step' ? 'You are back. The step carries on. Hands-on.' : 'You are back. Waiting.'); showUndo(); draw(); } }, 'I am back'))));
      return;
    }
    const last = w.steps[w.steps.length - 1] || null;
    // The step that ended last was interrupted: by default the next tap is the same step carrying
    // on, so it is not saved twice. "No, new step" is one tap beside it.
    const resume = !step && w.canResume;
    const canUndo = Date.now() < ui.undoUntil && (step || w.steps.length > 0 || w.sinceNotSeenSec > 0 || (rp && rp.list.some((p) => p.state === 'did-not-happen')));
    // The main button says which step it is for, where that is known: the step on a repeat walk's list,
    // or the interrupted step by its name.
    // First walk with a list: the step offered next (the main button starts it by that name).
    const nextRow = !rp && w.list ? w.list.find((p) => p.state === 'next') || null : null;
    const stepName = step ? (rp?.now?.name || w.running?.name) : resume ? (last.named ? last.name : (ui.sheet === true && ui.name) || null) : rp?.next?.name || nextRow?.name;
    const mainText = step ? `${stepName || 'Step'} done` : resume ? `${stepName || 'Step'} carries on` : `${stepName || 'Step'} starts`;
    const starts = async ({ fresh = false, list = null } = {}) => {
      const p = pending();
      // Which step starts: the row that was tapped, or the step offered next (kept as "from the list").
      const which = list || (nextRow ? { listStep: nextRow.n } : {});
      // Carrying on: what was chosen names the interrupted step, so it is saved before the step runs again.
      // Words refused for the name (they look like a person's name) stop the tap: the question shows in
      // the sheet and the step carries on only once it is answered, never unnamed without a word (#177 item 7).
      if (resume && !fresh && p && !(await savePending(p))) { draw(); return; }
      const out = await tap('ospeli_walks_step_start', resume && !fresh ? { resume: true } : which);
      if (!out) { draw(); return; }
      ui.follow = true; if (list || which.listStep) ui.flash = null;
      // A new step: the tap is stamped first, then what was chosen is saved for the step before it.
      if ((!resume || fresh) && p) await savePending(p);
      else if (resume && !fresh) { resetSheet(); }
      say(resume && !fresh ? 'The same step carries on. Hands-on.' : 'Step started. Hands-on.');
      ui.confirm = false; showUndo(); draw();
    };
    const doneNow = async () => {
        // A half-answered sheet belongs to the step before: keep what was chosen before moving on.
        const p = pending();
        if (p) await tap('ospeli_walks_step_name', p);
        const out = await tap('ospeli_walks_step_done');
        if (!out) return;
        const done = out.walk.steps[out.walk.steps.length - 1];
        // On a repeat walk a list step is already named, and so is a step named when it was interrupted:
        // one line says so. Anything else is named in the sheet.
        if (done.listStep) { resetSheet(); ui.sheet = 'saved'; ui.flash = null; } else if (done.named) { resetSheet(); ui.flash = flashOf(done); } else openSheet(out.walk);
        say(done.named ? `Step done. Saved as ${done.name}${done.again ? ', done again' : ''}. Waiting.` : 'Step done. Waiting. Name the step, or carry on.');
        ui.confirm = false; ui.follow = true; showUndo(); draw();
    };
    const main = h('button', { type: 'button', class: `btn walk-main${mainText.length > 18 ? ' is-long' : ''}`, 'data-test': 'walk-main', 'data-cmd': step ? 'ospeli_walks_step_done' : 'ospeli_walks_step_start',
      onclick: async () => { if (!step) await starts(); else await doneNow(); } }, mainText);
    const third = step ? h('button', { type: 'button', class: 'btn btn-ghost walk-stop', 'data-test': 'walk-stopped', 'data-cmd': 'ospeli_walks_step_done',
        onclick: async () => { const p = pending(); if (p) await tap('ospeli_walks_step_name', p); const out = await tap('ospeli_walks_step_done', { interrupted: true }); if (!out) return; const done = out.walk.steps[out.walk.steps.length - 1]; if (done.named) { resetSheet(); ui.flash = null; } else openSheet(out.walk); say('Step marked as interrupted. Waiting.'); showUndo(); draw(); } }, 'Step interrupted')
      : resume ? h('button', { type: 'button', class: 'btn btn-ghost walk-new', 'data-test': 'walk-new-step', 'data-cmd': 'ospeli_walks_step_start', onclick: () => starts({ fresh: true }) }, 'No, new step')
      : rp && rp.next ? h('button', { type: 'button', class: 'btn btn-ghost walk-skip', 'data-test': 'walk-skip', 'data-cmd': 'ospeli_walks_step_skip', 'aria-label': `Did not happen: ${rp.next.name}`,
        onclick: async () => { const out = await tap('ospeli_walks_step_skip'); if (out) { if (ui.sheet !== true) ui.sheet = false; say(`Marked as did not happen: ${rp.next.name}.`); showUndo(); draw(); } } }, `Step ${rp.next.n} did not happen`) : null;
    const pauseBtn = h('button', { type: 'button', class: 'btn btn-ghost walk-pause', 'data-test': 'walk-pause', 'data-cmd': 'ospeli_walks_pause', 'aria-label': 'Pause: I have stepped out',
      onclick: async () => { const out = await tap('ospeli_walks_pause'); if (out) { say('Paused. Nothing is counted until you are back.'); showUndo(); draw(); box.querySelector('[data-test="walk-main"]')?.focus({ preventScroll: true }); } } }, 'Pause');
    const undo = canUndo ? undoBtn(async () => { const out = await tap('ospeli_walks_undo'); if (out) { resetSheet(); ui.flash = null; ui.undoUntil = 0; const msg = out.undone === 'skip' ? 'Undone. The step is back on the list.' : out.undone === 'resume' ? 'Undone. Paused again.' : out.undone === 'step-resume' ? 'Undone. The step is interrupted again.' : out.undone === 'step-done' ? 'Undone. The step is running again.' : out.walk.state === 'step' ? 'Undone. The step is running.' : 'Undone. Waiting again.'; say(msg); ctx.toast(msg); draw(); } }) : null;
    // Finishing keeps what was chosen in the sheet, like the main button does.
    const finish = async (input = {}) => { const out = await tap('ospeli_walks_finish', input); if (out) { location.hash = `#/process/${out.mapId}`; } };
    const showSheet = ui.sheet && w.steps.length;
    // "Finish walk" is beside Pause and Undo whenever a walk can be finished and that place is free, so
    // the way to end is on the screen without scrolling. Its question opens in the bar, above the buttons.
    const finishBtn = h('button', { type: 'button', class: 'btn btn-ghost walk-finish', 'data-test': 'walk-finish', disabled: w.steps.length && !step ? null : true,
            onclick: async () => {
              // What is chosen in the sheet is saved first; words that are refused keep the sheet open.
              const p = pending();
              if (p && !(await savePending(p))) { draw(); return; }
              if (ui.sheet === true) resetSheet();
              ui.confirm = true; draw();
              const yes = box.querySelector('[data-test="walk-finish-yes"], [data-test="walk-finish-none"]');
              yes?.focus({ preventScroll: true });
            } }, 'Finish walk');
    const finishInBar = !third && !step && w.steps.length > 0;
    const confirmBox = () => h('div', { class: 'walk-confirm', role: 'alertdialog', 'aria-labelledby': 'wk-fin-h', 'data-test': 'walk-confirm' },
            // A repeat walk with list steps left: not seen is not the same as did not happen, so the person says which.
            ...(rp && rp.left.length ? [
              h('p', { id: 'wk-fin-h', 'data-test': 'walk-left' }, h('b', {}, `${rp.left.length} ${rp.left.length === 1 ? 'step on the list was' : 'steps on the list were'} not timed: `), rp.left.map((p) => p.name).join('; '), '.'),
              h('div', { class: 'form-actions' },
                h('button', { type: 'button', class: 'btn', 'data-test': 'walk-finish-none', 'data-cmd': 'ospeli_walks_finish', onclick: () => finish({ leftover: 'did-not-happen' }) }, rp.left.length === 1 ? 'It did not happen. Finish' : 'They did not happen. Finish'),
                h('button', { type: 'button', class: 'btn btn-ghost', 'data-test': 'walk-finish-early', 'data-cmd': 'ospeli_walks_finish', onclick: () => finish({ leftover: 'not-seen' }) }, 'I stopped early. Finish'),
                h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => { ui.confirm = false; draw(); } }, 'Keep walking')),
              h('p', { class: 'meta' }, 'A walk that stopped early is shown on the map and left out of the totals.'),
            ] : [
              h('p', { id: 'wk-fin-h' }, h('b', {}, rp ? `Finish and add walk ${rp.walkNo} to the map?` : 'Finish and see the map?')),
              rp ? null : h('p', { class: 'meta' }, 'You can still change a name, a role or a time on the map.'),
              h('div', { class: 'form-actions' },
                h('button', { type: 'button', class: 'btn', 'data-test': 'walk-finish-yes', 'data-cmd': 'ospeli_walks_finish', onclick: () => finish() }, 'Yes, finish'),
                h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => { ui.confirm = false; draw(); } }, 'Keep walking')),
            ]));
    const listed = !rp && !!w.list;
    const fromList = !!ui.flash && !!ui.flash.name && (ui.flash.nameFrom === 'list' || ui.flash.roleFrom === 'list');
    box.replaceChildren(h('section', { class: `walk ${step ? 'is-step' : 'is-waiting'}${rp ? ' is-repeat' : ''}${listed ? ' has-list' : ''}${listed && ui.flash ? ' has-flash' : ''}${showSheet || ui.confirm ? ' has-sheet' : ''}`, 'data-test': 'walk', 'data-state': w.state, 'aria-labelledby': 'wk-h' },
      top(sub),
      rp ? nextLine(w) : null,
      // The step list is the page (the tap-through sheet); what the two states mean comes under it.
      listed ? listBox(w, { starts, done: doneNow }) : null,
      w.clockMoved ? h('p', { class: 'walk-clock', role: 'alert', 'data-test': 'walk-clock' }, h('b', {}, 'The phone\'s clock changed during this walk.'), ' Its times may be wrong. You can finish it, but walk it again to get times you can use.') : null,
      // One honest line when the phone has not agreed to keep the app's data, until the first step is saved.
      ui.kept === false && !w.steps.length ? h('p', { class: 'walk-keep', 'data-test': 'walk-keep' }, 'This phone may clear saved walks. Finish, then print or save the map today.') : null,
      // A repeat walk has the list step on screen; the person has walked before, so the definition gives way to it.
      rp ? null : h('p', { class: 'walk-def', 'data-test': 'walk-def' }, step
        ? 'Hands-on: someone is working on this patient or item.'
        : 'Waiting: no one is working on this patient or item right now.'),
      step ? h('p', { class: 'meta walk-foot walk-which', 'data-test': 'walk-which' }, 'Step interrupted: the work stopped. Pause: you stepped out.') : null,
      h('div', { class: 'walk-end' },
        finishInBar || ui.confirm ? null : finishBtn,
        !w.steps.length || step ? h('p', { class: 'meta' }, step ? 'Mark the step done before you finish.' : 'Time one step before you finish.') : null),
      h('p', { class: 'meta walk-foot' }, 'Time the steps, never the people. People decide; Ospeli suggests.'),
      // What the walk follows can be said or changed at any time (a repeat walk carries its map's title).
      rp ? null : ui.rename
        ? h('form', { class: 'walk-rename', 'data-test': 'walk-rename-form', onsubmit: async (e) => {
          e.preventDefault();
          const title = box.querySelector('#wk-rename').value.trim();
          if (!title) { ui.rename = false; draw(); return; }
          const out = await tap('ospeli_walks_rename', { title });
          if (out) { ui.rename = false; ui.question = null; ui.renameText = undefined; say(`Walk named ${title}.`); }
          draw(); // a refused name shows its question here, under the field (#177 item 7)
          // On a phone the walk's bar is pinned to the foot of the screen: lift the question and both
          // answers clear above it (Adoption lead, 25 Nov: they were under the bar at 360 px).
          if (!out) liftAboveBar(box.querySelector('[data-test="walk-rename-form"] [data-test="name-question"]'));
        } },
          h('label', { for: 'wk-rename' }, 'What are you walking?'),
          h('input', { id: 'wk-rename', maxlength: '80', autocomplete: 'off', value: ui.renameText ?? (/^Walk \d+$/.test(w.title) ? '' : w.title), placeholder: `For example, ${(data.titles || [])[0] || 'Clinic visit'}`, oninput: (e) => { ui.renameText = e.target.value; } }),
          ui.question && !ui.sheet ? h('div', { class: 'name-question', role: 'alert', 'data-test': 'name-question' },
            h('p', {}, h('b', {}, `Is “${ui.question.looks}” a person's name?`)),
            h('p', {}, 'Name the place or service instead, for example Outpatient CT.'),
            h('div', { class: 'form-actions' },
              h('button', { type: 'button', class: 'btn', onclick: () => { ui.question = null; draw(); box.querySelector('#wk-rename')?.focus(); } }, 'Change it'),
              h('button', { type: 'button', class: 'btn btn-ghost', 'data-test': 'name-keep', onclick: async () => {
                const title = box.querySelector('#wk-rename').value.trim(); ui.question = null;
                const out = await tap('ospeli_walks_rename', { title, notAName: true });
                if (out) { ui.rename = false; ui.renameText = undefined; say(`Walk named ${title}.`); }
                draw();
              } }, 'Not a name. Save it'))) : null,
          h('div', { class: 'form-actions' },
            // While the question shows, its two answers are the ways forward: no second "save" beside them.
            ui.question && !ui.sheet ? null : h('button', { type: 'submit', class: 'btn', 'data-cmd': 'ospeli_walks_rename', 'data-test': 'walk-rename-save' }, 'Save name'),
            h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => { ui.rename = false; ui.question = null; ui.renameText = undefined; draw(); } }, 'Cancel')))
        : h('p', { class: 'meta walk-foot' }, h('button', { type: 'button', class: 'linkish', 'data-test': 'walk-rename', onclick: () => { ui.rename = true; draw(); box.querySelector('#wk-rename')?.focus(); } }, 'Rename this walk')),
      h('p', { class: 'meta walk-foot' }, h('button', { type: 'button', class: 'linkish', 'data-test': 'walk-delete', 'data-cmd': 'ospeli_walks_discard',
        onclick: async () => { if (!window.confirm('Delete this walk? Its times are not kept.')) return; const out = await tap('ospeli_walks_discard'); if (out) { ctx.toast('Walk deleted.'); location.hash = '#/process'; } } }, 'Delete this walk')),
      // Pinned to the bottom of the screen: the naming sheet (or the line that says what was saved),
      // then Pause, Undo and the one other choice, then the main button. It never scrolls away.
      h('div', { class: 'walk-bar', 'data-test': 'walk-bar' },
        ui.confirm ? confirmBox() : showSheet ? (ui.sheet === true || !rp || !last.listStep ? sheet(w) : savedLine(w))
          : ui.flash ? h('p', { class: `walk-saved walk-flash${fromList ? ' is-short' : ''}`, 'data-test': 'walk-flash' },
            // A list step: one short line (Adoption lead, 27 Nov), which says at the moment of saving what
            // was the list's and not the person's (#170). Any other step keeps the full line.
            fromList ? h('span', {}, h('b', {}, ui.flash.name), ' saved', h('span', { class: 'walk-from', 'data-test': 'walk-from' }, ui.flash.nameFrom === 'list' ? ' · from the list' : ' · role from the list'),
              ui.flash.again ? h('b', { class: 'walk-again-mark', 'data-test': 'walk-again-mark' }, ' · done again') : null)
            : h('span', {}, `Step ${ui.flash.n} saved as `, h('b', {}, ui.flash.name || 'no name yet'), ui.flash.role ? ` · ${ui.flash.role}` : '',
              ui.flash.again ? h('b', { class: 'walk-again-mark', 'data-test': 'walk-again-mark' }, ' · done again') : null),
            // A second tap on a timed step may be a slip, or an ordinary second time: one tap takes the mark away.
            ui.flash.again ? h('button', { type: 'button', class: 'btn btn-ghost walk-change', 'data-test': 'walk-not-again', 'data-cmd': 'ospeli_walks_step_name',
              onclick: async () => { const out = await tap('ospeli_walks_step_name', { again: false }); if (out) { ui.flash = { ...ui.flash, again: false }; say('Not marked as done again.'); } draw(); } }, 'Not again') : null,
            h('button', { type: 'button', class: 'btn btn-ghost walk-change', 'data-test': 'walk-flash-change',
              onclick: () => { const f = ui.flash; resetSheet(); ui.sheet = true; ui.name = f.name || ''; ui.role = f.role || ''; ui.picked = { name: true, role: true }; ui.from = { name: f.nameFrom || null, role: f.roleFrom || null }; ui.typed = !!f.name && !data.stepChips.includes(f.name); ui.flash = null; draw(); } }, 'Change')) : null,
        // Never beside the naming sheet or the finish question: those come first.
        !ui.confirm && !showSheet ? (w.askReason ? reasonRow(w) : reasonLine(w)) : null,
        // Never out of sight (Adoption lead): the way to a step that is not on the list, while waiting.
        listed && !step && !ui.confirm && !showSheet && !w.askReason ? h('button', { type: 'button', class: 'btn btn-ghost walk-other', 'data-test': 'walk-other', 'data-cmd': 'ospeli_walks_step_start', onclick: () => starts({ fresh: true, list: {} }) }, '+ Another step, not on the list') : null,
        now(step ? 'Hands-on' : 'Waiting', w),
        resume ? h('p', { class: 'walk-resume', 'data-test': 'walk-resume' }, `Step ${last.n} was interrupted. Same step again?`) : null,
        side(pauseBtn, undo, third || (finishInBar && !ui.confirm ? finishBtn : null)),
        main)));
  }

  await load();
  // A step that ended with no name yet (a reload in the middle): offer the sheet again.
  const w0 = data.walk;
  if (w0 && w0.steps.length && !w0.steps[w0.steps.length - 1].named && w0.state === 'waiting') openSheet(w0);
  draw();
  timer = setInterval(tick, 500);
  return () => {
    stopped = true; clearInterval(timer); clearTimeout(undoTimer); status.remove();
    delete root.dataset.walkFull; box.style.removeProperty('--walk-bar');
    document.removeEventListener('visibilitychange', onVisible);
    try { lock?.release?.(); } catch { /* nothing to release */ }
  };
}
