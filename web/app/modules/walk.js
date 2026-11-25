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
import { h } from './ui.js';
import { fmtClock, fmtSeconds } from '../core/walk.js';

const UNDO_MS = 10000;

// Draws the walk in progress into `box`. Returns a function that stops its timer.
// againOf: the map whose saved step list is walked again (a repeat walk), or null for a first walk.
export async function renderWalk(box, ctx, againOf = null) {
  // picked: which of the two answers the person chose by hand (the other may be the offer, already chosen).
  const ui = { busy: false, sheet: false, more: false, name: '', role: '', picked: { name: false, role: false }, msg: false, next: false, confirm: false, undoUntil: 0, question: null, error: '', flash: null, kept: null, rename: false, title: '', startError: null };
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
  const resetSheet = () => { box.querySelectorAll('#wk-name, #wk-role').forEach((i) => { i.value = ''; }); ui.sheet = false; ui.more = false; ui.name = ''; ui.role = ''; ui.picked = { name: false, role: false }; ui.msg = false; ui.next = false; ui.question = null; ui.error = ''; };
  // Open the naming sheet for the step that just ended. In a department with a step list the
  // usual next step and its usual role are offered already chosen (an example setting): one tap
  // on another chip changes either, and nothing is saved until the person's next tap.
  function openSheet(w) {
    resetSheet(); ui.sheet = true; ui.flash = null;
    if (w.suggest) { ui.name = w.suggest.name; ui.role = w.suggest.role || ''; }
  }
  // The step and role words can change with every name saved (a name typed once is offered at once).
  async function refreshChips() { try { const d = await ctx.run('ospeli_walks_get', {}); data = { ...data, stepChips: d.stepChips, roleChips: d.roleChips, usualRoles: d.usualRoles }; } catch { /* the words on screen stay */ } }
  async function afterNamed() { resetSheet(); await refreshChips(); draw(); }
  // What is chosen or typed in the sheet and not yet saved.
  function pending() {
    const name = box.querySelector('#wk-name')?.value.trim() || ui.name; const role = box.querySelector('#wk-role')?.value.trim() || ui.role;
    return ui.sheet === true && (name || role) ? { ...(name ? { name } : {}), ...(role ? { role } : {}), msg: ui.msg } : null;
  }
  // Save it for the step that ended last. The sheet closes and one line says what was saved; when
  // the words are refused (they look like a person's name) the sheet stays open with the reason.
  async function savePending(p) {
    const n = data.walk.steps.length;
    const out = await tap('ospeli_walks_step_name', p);
    if (!out) return false;
    const st = out.walk.steps[n - 1];
    resetSheet(); ui.flash = st ? { n: st.n, name: p.name || null, role: p.role || null } : null;
    await refreshChips();
    return true;
  }

  async function saveName() {
    const typedName = box.querySelector('#wk-name')?.value.trim() || ''; const typedRole = box.querySelector('#wk-role')?.value.trim() || '';
    const name = typedName || ui.name; const role = typedRole || ui.role;
    if (!name || !role) { ctx.toast(!name ? 'Say what happened, or tap “Name it later”.' : 'Say which role did it, or tap “Name it later”.'); return; }
    ui.name = name; ui.role = role; ui.error = '';
    const out = await tap('ospeli_walks_step_name', { name, role, msg: ui.msg, ...(ui.next && data.walk.state === 'waiting' ? { nextStarted: true } : {}) });
    if (out) afterNamed(); else draw();
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
        ui[kind] = text; ui.picked[kind] = true; if (typed[kind]) typed[kind].value = '';
        // A step from the department's list brings the role that usually does it, unless the person chose one.
        if (kind === 'name' && !ui.picked.role && data.usualRoles?.[text]) ui.role = data.usualRoles[text];
        // The second of the person's two answers saves the step: no extra tap. An answer that was
        // only offered is not the person's, so it waits for the main button or "Save step".
        if (ui.name && ui.role && (ui.picked[other] || typed[other]?.value.trim())) saveName(); else draw();
      } }, text);
    // The chosen word first, so it is seen without sliding the row.
    const first = (list, on) => (on && list.includes(on) ? [on, ...list.filter((c) => c !== on)] : list);
    const row = (kind, word, label, list) => h('div', { class: 'walk-chips is-row', role: 'group', 'aria-label': label, 'data-test': `walk-row-${kind}` },
      h('span', { class: 'walk-row-word', 'aria-hidden': 'true' }, word), first(list, ui[kind]).map((c) => chip(kind, c)));
    return h('section', { class: `walk-sheet${ui.more ? ' is-more' : ''}`, 'data-test': 'walk-sheet', 'aria-labelledby': 'wk-sheet-h' },
      h('div', { class: 'walk-sheet-head' },
        h('h2', { id: 'wk-sheet-h' }, `Step ${last.n}: ${fmtSeconds(last.workSec)}`),
        h('p', { class: 'walk-sheet-hint', 'data-test': 'walk-sheet-hint' }, offered ? 'Next on the list. Tap another if not.' : w.canResume ? 'Name the step that was interrupted.' : 'Name this step. The clock keeps running.')),
      row('name', 'Step', 'What happened?', data.stepChips),
      row('role', 'Role', 'Which role did it? A role, never a name', data.roleChips),
      ui.more ? h('div', { class: 'walk-more-box', 'data-test': 'walk-more-box' },
        h('div', { class: 'field' },
          h('label', { for: 'wk-name' }, 'What happened?'),
          h('input', { id: 'wk-name', maxlength: '140', placeholder: 'Say what happened', value: data.stepChips.includes(ui.name) ? '' : ui.name, autocomplete: 'off' })),
        h('div', { class: 'field' },
          h('label', { for: 'wk-role' }, 'Which role did it? (a role, never a name)'),
          h('input', { id: 'wk-role', maxlength: '60', placeholder: 'Say which role', value: data.roleChips.includes(ui.role) ? '' : ui.role, autocomplete: 'off' })),
        h('label', { class: 'check' }, h('input', { type: 'checkbox', id: 'wk-msg', checked: ui.msg ? true : null, onchange: (e) => { ui.msg = e.target.checked; } }), 'It only passed on information (a call, message or form)'),
        w.state === 'waiting' ? h('label', { class: 'check' }, h('input', { type: 'checkbox', id: 'wk-next', checked: ui.next ? true : null, onchange: (e) => { ui.next = e.target.checked; } }), 'The next step has already started') : null) : null,
      ui.question ? h('div', { class: 'name-question', role: 'alert', 'data-test': 'name-question' },
        h('p', {}, h('b', {}, `Is “${ui.question.looks}” a person's name?`)),
        h('p', {}, 'Ospeli times steps, never people. Use a role instead, for example Doctor, Nurse or Pharmacy.'),
        h('div', { class: 'form-actions' },
          h('button', { type: 'button', class: 'btn', onclick: () => { ui.question = null; ui.more = true; draw(); } }, 'Change the wording'),
          h('button', { type: 'button', class: 'btn btn-ghost', 'data-test': 'name-keep', onclick: () => { const q = ui.question; ui.question = null; q.retry(); } }, 'Not a name. Save it'))) : null,
      ui.error ? h('p', { class: 'walk-error', role: 'alert', 'data-test': 'walk-error' }, ui.error) : null,
      h('div', { class: 'walk-sheet-foot' },
        h('button', { type: 'button', class: 'btn btn-ghost', 'data-test': 'walk-more', 'aria-expanded': String(ui.more),
          onclick: () => { for (const kind of ['name', 'role']) { const t = box.querySelector(`#wk-${kind}`)?.value.trim(); if (t) ui[kind] = t; } ui.more = !ui.more; draw(); if (ui.more) box.querySelector('#wk-name')?.focus({ preventScroll: true }); } }, ui.more ? 'Fewer options' : 'More options'),
        h('button', { type: 'button', class: 'btn btn-ghost', 'data-test': 'walk-later',
          // "The next step has already started" still counts when the name is left for later.
          onclick: async () => { if (ui.next && data.walk.state === 'waiting') await tap('ospeli_walks_step_name', { nextStarted: true }); resetSheet(); draw(); } }, 'Name it later'),
        h('button', { type: 'button', class: 'btn', 'data-cmd': 'ospeli_walks_step_name', 'data-test': 'walk-save', onclick: saveName }, 'Save step')));
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
    h('a', { class: 'walk-leave', href: '#/home', 'data-test': 'walk-leave' }, h('span', { class: 'walk-leave-mark', 'aria-hidden': 'true' }), 'Leave walk running'),
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
    const stepName = step ? rp?.now?.name : resume ? (last.named ? last.name : (ui.sheet === true && ui.name) || null) : rp?.next?.name;
    const mainText = step ? `${stepName || 'Step'} done` : resume ? `${stepName || 'Step'} carries on` : `${stepName || 'Step'} starts`;
    const starts = async ({ fresh = false } = {}) => {
      const p = pending();
      // Carrying on: what was chosen names the interrupted step, so it is saved before the step runs again.
      // Words refused for the name (they look like a person's name) stop the tap: the question shows in
      // the sheet and the step carries on only once it is answered, never unnamed without a word (#177 item 7).
      if (resume && !fresh && p && !(await savePending(p))) { draw(); return; }
      const out = await tap('ospeli_walks_step_start', resume && !fresh ? { resume: true } : {});
      if (!out) { draw(); return; }
      // A new step: the tap is stamped first, then what was chosen is saved for the step before it.
      if ((!resume || fresh) && p) await savePending(p);
      else if (resume && !fresh) { resetSheet(); }
      say(resume && !fresh ? 'The same step carries on. Hands-on.' : 'Step started. Hands-on.');
      ui.confirm = false; showUndo(); draw();
    };
    const main = h('button', { type: 'button', class: `btn walk-main${mainText.length > 18 ? ' is-long' : ''}`, 'data-test': 'walk-main', 'data-cmd': step ? 'ospeli_walks_step_done' : 'ospeli_walks_step_start',
      onclick: async () => {
        if (!step) { await starts(); return; }
        // A half-answered sheet belongs to the step before: keep what was chosen before moving on.
        const p = pending();
        if (p) await tap('ospeli_walks_step_name', p);
        const out = await tap('ospeli_walks_step_done');
        if (!out) return;
        const done = out.walk.steps[out.walk.steps.length - 1];
        // On a repeat walk a list step is already named, and so is a step named when it was interrupted:
        // one line says so. Anything else is named in the sheet.
        if (done.listStep) { resetSheet(); ui.sheet = 'saved'; ui.flash = null; } else if (done.named) { resetSheet(); ui.flash = { n: done.n, name: done.name, role: done.role }; } else openSheet(out.walk);
        say(done.named ? `Step done. Saved as ${done.name}. Waiting.` : 'Step done. Waiting. Name the step, or carry on.');
        ui.confirm = false; showUndo(); draw();
      } }, mainText);
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
    box.replaceChildren(h('section', { class: `walk ${step ? 'is-step' : 'is-waiting'}${rp ? ' is-repeat' : ''}${showSheet || ui.confirm ? ' has-sheet' : ''}`, 'data-test': 'walk', 'data-state': w.state, 'aria-labelledby': 'wk-h' },
      top(sub),
      rp ? nextLine(w) : null,
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
        !w.steps.length || step ? h('p', { class: 'meta' }, step ? 'Mark the step done before you finish.' : 'Time at least one step before you finish.') : null),
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
          // The walk's bar is pinned to the foot of the screen: bring the field and its question up above it.
          if (!out) box.querySelector('[data-test="walk-rename-form"]')?.scrollIntoView({ block: 'start' });
        } },
          h('label', { for: 'wk-rename' }, 'What are you walking?'),
          h('input', { id: 'wk-rename', maxlength: '80', autocomplete: 'off', value: ui.renameText ?? (/^Walk \d+$/.test(w.title) ? '' : w.title), placeholder: `For example, ${(data.titles || [])[0] || 'Clinic visit'}`, oninput: (e) => { ui.renameText = e.target.value; } }),
          ui.question && !ui.sheet ? h('div', { class: 'name-question', role: 'alert', 'data-test': 'name-question' },
            h('p', {}, h('b', {}, `Is “${ui.question.looks}” a person's name?`)),
            h('p', {}, 'Ospeli times steps, never people. Name what is followed instead, for example Outpatient CT.'),
            h('div', { class: 'form-actions' },
              h('button', { type: 'button', class: 'btn', onclick: () => { ui.question = null; draw(); box.querySelector('#wk-rename')?.focus(); } }, 'Change the wording'),
              h('button', { type: 'button', class: 'btn btn-ghost', 'data-test': 'name-keep', onclick: async () => {
                const title = box.querySelector('#wk-rename').value.trim(); ui.question = null;
                const out = await tap('ospeli_walks_rename', { title, notAName: true });
                if (out) { ui.rename = false; ui.renameText = undefined; say(`Walk named ${title}.`); }
                draw();
              } }, 'Not a name. Save it'))) : null,
          h('div', { class: 'form-actions' },
            h('button', { type: 'submit', class: 'btn', 'data-cmd': 'ospeli_walks_rename', 'data-test': 'walk-rename-save' }, 'Save name'),
            h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => { ui.rename = false; ui.question = null; ui.renameText = undefined; draw(); } }, 'Cancel')))
        : h('p', { class: 'meta walk-foot' }, h('button', { type: 'button', class: 'linkish', 'data-test': 'walk-rename', onclick: () => { ui.rename = true; draw(); box.querySelector('#wk-rename')?.focus(); } }, 'Rename this walk')),
      h('p', { class: 'meta walk-foot' }, h('button', { type: 'button', class: 'linkish', 'data-test': 'walk-delete', 'data-cmd': 'ospeli_walks_discard',
        onclick: async () => { if (!window.confirm('Delete this walk? Its times are not kept.')) return; const out = await tap('ospeli_walks_discard'); if (out) { ctx.toast('Walk deleted.'); location.hash = '#/process'; } } }, 'Delete this walk')),
      // Pinned to the bottom of the screen: the naming sheet (or the line that says what was saved),
      // then Pause, Undo and the one other choice, then the main button. It never scrolls away.
      h('div', { class: 'walk-bar', 'data-test': 'walk-bar' },
        ui.confirm ? confirmBox() : showSheet ? (ui.sheet === true || !rp || !last.listStep ? sheet(w) : savedLine(w))
          : ui.flash ? h('p', { class: 'walk-saved walk-flash', 'data-test': 'walk-flash' },
            h('span', {}, `Step ${ui.flash.n} saved as `, h('b', {}, ui.flash.name || 'no name yet'), ui.flash.role ? ` · ${ui.flash.role}` : ''),
            h('button', { type: 'button', class: 'btn btn-ghost walk-change', 'data-test': 'walk-flash-change',
              onclick: () => { const f = ui.flash; resetSheet(); ui.sheet = true; ui.name = f.name || ''; ui.role = f.role || ''; ui.picked = { name: true, role: true }; ui.flash = null; draw(); } }, 'Change')) : null,
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
