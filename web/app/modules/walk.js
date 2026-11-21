// Walk mode (backlog PM2): follow one patient visit or one item with a phone and tap as things
// happen. One screen, one big button. Every tap runs a named command (core/commands.js:
// ospeli_walks_get, ospeli_walks_step_start, ospeli_walks_step_done, ospeli_walks_step_name,
// ospeli_walks_undo, ospeli_walks_pause, ospeli_walks_resume, ospeli_walks_finish, ospeli_walks_discard,
// and ospeli_walks_start from the before-you-walk points); the command stamps the time, and
// the walk is saved on every tap, so a locked phone, a reload or a handed-over phone loses nothing.
// The timer on screen is worked out from those saved times; it is never the record.
import { h } from './ui.js';
import { fmtClock, fmtSeconds } from '../core/walk.js';

const UNDO_MS = 10000;

// Draws the walk in progress into `box`. Returns a function that stops its timer.
// againOf: the map whose saved step list is walked again (a repeat walk), or null for a first walk.
export async function renderWalk(box, ctx, againOf = null) {
  const ui = { busy: false, sheet: false, name: '', role: '', msg: false, next: false, confirm: false, undoUntil: 0, question: null, error: '' };
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
  const shown = (w) => (w.state === 'paused' ? secsSince(w.since) : Math.max(0, secsSince(w.presentSince || w.since) - (w.sinceNotSeenSec || 0)));

  async function load() {
    data = await ctx.run('ospeli_walks_get', {});
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
  const resetSheet = () => { box.querySelectorAll('#wk-name, #wk-role').forEach((i) => { i.value = ''; }); ui.sheet = false; ui.name = ''; ui.role = ''; ui.msg = false; ui.next = false; ui.question = null; ui.error = ''; };
  function afterNamed() { resetSheet(); draw(); }

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
    const chip = (kind, text) => h('button', { type: 'button', class: 'chip-btn walk-chip', 'data-chip': kind, 'aria-pressed': String(ui[kind] === text),
      onclick: () => {
        const typed = { name: box.querySelector('#wk-name'), role: box.querySelector('#wk-role') };
        ui.name = typed.name.value.trim() || ui.name; ui.role = typed.role.value.trim() || ui.role;
        ui[kind] = text; typed[kind].value = '';
        // The second of the two answers saves the step: no extra tap.
        if (ui.name && ui.role) saveName(); else draw();
      } }, text);
    return h('section', { class: 'card walk-sheet', 'data-test': 'walk-sheet', 'aria-labelledby': 'wk-sheet-h' },
      h('h2', { id: 'wk-sheet-h' }, `Step ${last.n}: ${fmtSeconds(last.workSec)}`),
      h('p', { class: 'walk-sheet-hint', 'data-test': 'walk-sheet-hint' }, 'Name the step you just timed. The clock keeps running.'),
      h('div', { class: 'field' },
        h('label', { for: 'wk-name' }, 'What happened?'),
        h('div', { class: 'walk-chips' }, data.stepChips.map((c) => chip('name', c))),
        h('input', { id: 'wk-name', maxlength: '140', placeholder: 'or type it', value: data.stepChips.includes(ui.name) ? '' : ui.name, autocomplete: 'off' })),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', id: 'wk-msg', checked: ui.msg ? true : null, onchange: (e) => { ui.msg = e.target.checked; } }), 'It only passed on information (a call, message or form)'),
      w.state === 'waiting' ? h('label', { class: 'check' }, h('input', { type: 'checkbox', id: 'wk-next', checked: ui.next ? true : null, onchange: (e) => { ui.next = e.target.checked; } }), 'The next step has already started') : null,
      h('div', { class: 'field' },
        h('label', { for: 'wk-role' }, 'Which role did it? (a role, never a name)'),
        h('div', { class: 'walk-chips' }, data.roleChips.map((c) => chip('role', c))),
        h('input', { id: 'wk-role', maxlength: '60', placeholder: 'or type it', value: data.roleChips.includes(ui.role) ? '' : ui.role, autocomplete: 'off' })),
      ui.question ? h('div', { class: 'name-question', role: 'alert', 'data-test': 'name-question' },
        h('p', {}, h('b', {}, `Is “${ui.question.looks}” a person's name?`)),
        h('p', {}, 'Ospeli times steps, never people. Use a role instead, for example Doctor, Nurse or Pharmacy.'),
        h('div', { class: 'form-actions' },
          h('button', { type: 'button', class: 'btn', onclick: () => { ui.question = null; draw(); } }, 'Change the wording'),
          h('button', { type: 'button', class: 'btn btn-ghost', 'data-test': 'name-keep', onclick: () => { const q = ui.question; ui.question = null; q.retry(); } }, 'Not a name. Save it'))) : null,
      ui.error ? h('p', { class: 'walk-error', role: 'alert', 'data-test': 'walk-error' }, ui.error) : null,
      h('div', { class: 'form-actions' },
        h('button', { type: 'button', class: 'btn', 'data-cmd': 'ospeli_walks_step_name', 'data-test': 'walk-save', onclick: saveName }, 'Save step'),
        h('button', { type: 'button', class: 'btn btn-ghost', 'data-test': 'walk-later',
          // "The next step has already started" still counts when the name is left for later.
          onclick: async () => { if (ui.next && data.walk.state === 'waiting') await tap('ospeli_walks_step_name', { nextStarted: true }); resetSheet(); draw(); } }, 'Name it later')));
  }

  // Repeat walk: the step that just ended took its name from the list. One line says so, with one
  // way out when the visit differed: pick the list step it really was, or say it is not on the list.
  function savedLine(w) {
    const last = w.steps[w.steps.length - 1];
    if (ui.sheet === 'pick') {
      return h('section', { class: 'card walk-sheet', 'data-test': 'walk-pick', 'aria-labelledby': 'wk-pick-h' },
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
      h('button', { type: 'button', class: 'btn btn-ghost walk-change', 'data-test': 'walk-change', onclick: () => { ui.sheet = 'pick'; draw(); box.querySelector('[data-test="walk-pick"]')?.scrollIntoView({ block: 'nearest' }); } }, 'Change'));
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
    paint();
    refocus(key);
  }
  function paint() {
    const w = data?.walk;
    if (!w || w.status !== 'walking') {
      // Before the first tap (issue #124): the points a person confirms, the stop rule first.
      // One tap starts the walk and the clock. Nothing about anyone is kept, only the time.
      box.replaceChildren(h('section', { class: 'card walk-before', 'data-test': 'walk-before', 'aria-labelledby': 'wk-before-h' },
        h('h1', { id: 'wk-before-h' }, 'Before you walk'),
        again ? h('p', { class: 'walk-sub', 'data-test': 'walk-before-again' }, `${/^Walk \d+$/.test(again.title) ? '' : `${again.title} · `}Walk ${again.walkNo}${again.walkNo <= again.aim ? ` of ${again.aim}` : ''} · same step list`) : null,
        h('ul', { class: 'walk-before-list' }, (data.before || []).map((line, i) => h('li', { class: i === 0 ? 'first' : null }, line))),
        h('button', { type: 'button', class: 'btn walk-before-ok', 'data-test': 'walk-before-ok', 'data-cmd': 'ospeli_walks_start',
          onclick: async () => {
            if (ui.busy) return;
            ui.busy = true;
            try { await ctx.run('ospeli_walks_start', { guidanceSeen: true, ...(again ? { mapId: again.mapId } : {}) }); await load(); say('Walk started. Waiting.'); }
            catch (err) { ctx.toast(`Not started. ${err.message}`); }
            finally { ui.busy = false; }
            draw(); box.querySelector('[data-test="walk-main"]')?.focus({ preventScroll: true });
          } }, 'Done. Start the walk'),
        h('p', { class: 'meta walk-before-foot' }, 'The clock starts when you tap. ', h('a', { href: again ? `#/process/${again.mapId}` : '#/process', 'data-test': 'walk-before-no' }, 'Not now'))));
      return;
    }
    const paused = w.state === 'paused';
    const step = w.state === 'step';
    const rp = w.repeat || null;
    // A walk nobody named is called "Walk 1": on a repeat walk that would read as a walk number, so it is left out.
    const walkOf = rp ? `Walk ${rp.walkNo}${rp.walkNo <= rp.aim ? ` of ${rp.aim}` : ''}` : '';
    const sub = rp ? (/^Walk \d+$/.test(w.title) ? `${walkOf} · same step list` : `${w.title} · ${walkOf.toLowerCase()}`) : `${w.title} · one visit, step by step`;
    if (paused) {
      // The person has stepped out: one state word, one button, nothing counted.
      box.replaceChildren(h('section', { class: `walk is-paused${rp ? ' is-repeat' : ''}`, 'data-test': 'walk', 'data-state': 'paused', 'aria-labelledby': 'wk-h' },
        h('div', { class: 'walk-top' },
          h('h1', { id: 'wk-h' }, 'Walk in progress'),
          h('p', { class: 'walk-sub' }, sub)),
        h('div', { class: 'walk-now', 'aria-live': 'off' },
          h('span', { class: 'walk-state', 'data-test': 'walk-state' }, 'Paused'),
          h('span', { class: 'walk-timer', role: 'timer', 'data-test': 'walk-timer' }, fmtClock(shown(w))),
          h('span', { class: 'walk-meta' }, h('span', { 'data-test': 'walk-total' }, `Whole walk ${fmtClock(secsSince(w.startedAt))}`), ` · ${w.steps.length} ${w.steps.length === 1 ? 'step' : 'steps'} saved`)),
        h('button', { type: 'button', class: 'btn walk-main', 'data-test': 'walk-main', 'data-cmd': 'ospeli_walks_resume',
          onclick: async () => { const out = await tap('ospeli_walks_resume'); if (!out) return; say(out.walk.state === 'step' ? 'You are back. The step carries on. Hands-on.' : 'You are back. Waiting.'); showUndo(); draw(); } }, 'I am back'),
        h('p', { class: 'walk-def', 'data-test': 'walk-def' }, `Paused: nothing is counted. This time shows on the map as “not seen”. ${w.under === 'step' ? 'The step carries on when you are back.' : 'The wait carries on when you are back.'}`),
        h('div', { class: 'walk-side' },
          Date.now() < ui.undoUntil ? h('button', { type: 'button', class: 'btn btn-ghost walk-undo', 'data-test': 'walk-undo', 'data-cmd': 'ospeli_walks_undo',
            onclick: async () => { const out = await tap('ospeli_walks_undo'); if (out) { ui.undoUntil = 0; say('Undone. Not paused.'); ctx.toast('Undone. Not paused.'); draw(); } } }, 'Undo last tap') : null),
        h('p', { class: 'meta walk-foot' }, 'Time the steps, never the people. People decide; Ospeli suggests.')));
      return;
    }
    const canUndo = Date.now() < ui.undoUntil && (step || w.steps.length > 0 || w.sinceNotSeenSec > 0 || (rp && rp.list.some((p) => p.state === 'did-not-happen')));
    const main = h('button', { type: 'button', class: 'btn walk-main', 'data-test': 'walk-main', 'data-cmd': step ? 'ospeli_walks_step_done' : 'ospeli_walks_step_start',
      onclick: async () => {
        // A half-answered sheet belongs to the step before: keep what was chosen before moving on.
        if (step && ui.sheet === true && (ui.name || ui.role)) await tap('ospeli_walks_step_name', { ...(ui.name ? { name: ui.name } : {}), ...(ui.role ? { role: ui.role } : {}), msg: ui.msg });
        const out = await tap(step ? 'ospeli_walks_step_done' : 'ospeli_walks_step_start');
        if (!out) return;
        const done = out.walk.steps[out.walk.steps.length - 1];
        // On a repeat walk a list step is already named: one line says so. Anything else is named as before.
        if (step) { resetSheet(); ui.sheet = done.listStep ? 'saved' : true; }
        say(step ? (done.listStep ? `Step done. Saved as ${done.name}. Waiting.` : 'Step done. Waiting. Name the step, or carry on.') : 'Step started. Hands-on.');
        ui.confirm = false; showUndo(); draw();
        if (step) box.querySelector('[data-test="walk-sheet"]')?.scrollIntoView({ block: 'nearest' });
      } }, step ? 'Step done' : 'Step starts');
    box.replaceChildren(h('section', { class: `walk ${step ? 'is-step' : 'is-waiting'}${rp ? ' is-repeat' : ''}`, 'data-test': 'walk', 'data-state': w.state, 'aria-labelledby': 'wk-h' },
      h('div', { class: 'walk-top' },
        h('h1', { id: 'wk-h' }, 'Walk in progress'),
        h('p', { class: 'walk-sub' }, sub)),
      rp ? nextLine(w) : null,
      h('div', { class: 'walk-now', 'aria-live': 'off' },
        h('span', { class: 'walk-state', 'data-test': 'walk-state' }, step ? 'Hands-on' : 'Waiting'),
        h('span', { class: 'walk-timer', role: 'timer', 'data-test': 'walk-timer' }, fmtClock(shown(w))),
        h('span', { class: 'walk-meta' }, h('span', { 'data-test': 'walk-total' }, `Whole walk ${fmtClock(secsSince(w.startedAt))}`), ` · ${w.steps.length} ${w.steps.length === 1 ? 'step' : 'steps'} saved`)),
      w.clockMoved ? h('p', { class: 'walk-clock', role: 'alert', 'data-test': 'walk-clock' }, h('b', {}, 'The phone\'s clock changed during this walk.'), ' Its times may be wrong. You can finish it, but walk it again to get times you can use.') : null,
      main,
      // A repeat walk has the list step on screen; the person has walked before, so the definition gives way to it.
      rp ? null : h('p', { class: 'walk-def', 'data-test': 'walk-def' }, step
        ? 'Hands-on: someone is working on this patient or item.'
        : 'Waiting: no one is working on this patient or item right now.'),
      h('div', { class: 'walk-side' },
        step ? h('button', { type: 'button', class: 'btn btn-ghost walk-stop', 'data-test': 'walk-stopped', 'data-cmd': 'ospeli_walks_step_done',
          onclick: async () => { const out = await tap('ospeli_walks_step_done', { interrupted: true }); if (out) { resetSheet(); ui.sheet = true; say('Step marked as interrupted. Waiting.'); showUndo(); draw(); } } }, 'Step interrupted') : null,
        rp && !step && rp.next ? h('button', { type: 'button', class: 'btn btn-ghost walk-skip', 'data-test': 'walk-skip', 'data-cmd': 'ospeli_walks_step_skip', 'aria-label': `Did not happen: ${rp.next.name}`,
          onclick: async () => { const out = await tap('ospeli_walks_step_skip'); if (out) { if (ui.sheet !== true) ui.sheet = false; say(`Marked as did not happen: ${rp.next.name}.`); showUndo(); draw(); } } }, 'Did not happen') : null,
        h('button', { type: 'button', class: 'btn btn-ghost walk-pause', 'data-test': 'walk-pause', 'data-cmd': 'ospeli_walks_pause', 'aria-label': 'Pause: I have stepped out',
          onclick: async () => { const out = await tap('ospeli_walks_pause'); if (out) { say('Paused. Nothing is counted until you are back.'); showUndo(); draw(); box.querySelector('[data-test="walk-main"]')?.focus({ preventScroll: true }); } } }, 'Pause'),
        canUndo ? h('button', { type: 'button', class: 'btn btn-ghost walk-undo', 'data-test': 'walk-undo', 'data-cmd': 'ospeli_walks_undo',
          onclick: async () => { const out = await tap('ospeli_walks_undo'); if (out) { resetSheet(); ui.undoUntil = 0; const msg = out.undone === 'skip' ? 'Undone. The step is back on the list.' : out.undone === 'resume' ? 'Undone. Paused again.' : out.undone === 'step-done' ? 'Undone. The step is running again.' : out.walk.state === 'step' ? 'Undone. The step is running.' : 'Undone. Waiting again.'; say(msg); ctx.toast(msg); draw(); } } }, 'Undo last tap') : null),
      step ? h('p', { class: 'meta walk-foot walk-which', 'data-test': 'walk-which' }, 'Step interrupted: the work stopped. Pause: you stepped out.') : null,
      ui.sheet && w.steps.length ? (ui.sheet === true || !rp || !w.steps[w.steps.length - 1].listStep ? sheet(w) : savedLine(w)) : null,
      h('div', { class: 'walk-end' },
        ui.confirm
          ? h('div', { class: 'walk-confirm', role: 'alertdialog', 'aria-labelledby': 'wk-fin-h', 'data-test': 'walk-confirm' },
            // A repeat walk with list steps left: not seen is not the same as did not happen, so the person says which.
            ...(rp && rp.left.length ? [
              h('p', { id: 'wk-fin-h', 'data-test': 'walk-left' }, h('b', {}, `${rp.left.length} ${rp.left.length === 1 ? 'step on the list was' : 'steps on the list were'} not timed: `), rp.left.map((p) => p.name).join('; '), '.'),
              h('div', { class: 'form-actions' },
                h('button', { type: 'button', class: 'btn', 'data-test': 'walk-finish-none', 'data-cmd': 'ospeli_walks_finish',
                  onclick: async () => { const out = await tap('ospeli_walks_finish', { leftover: 'did-not-happen' }); if (out) { location.hash = `#/process/${out.mapId}`; } } }, rp.left.length === 1 ? 'It did not happen. Finish' : 'They did not happen. Finish'),
                h('button', { type: 'button', class: 'btn btn-ghost', 'data-test': 'walk-finish-early', 'data-cmd': 'ospeli_walks_finish',
                  onclick: async () => { const out = await tap('ospeli_walks_finish', { leftover: 'not-seen' }); if (out) { location.hash = `#/process/${out.mapId}`; } } }, 'I stopped early. Finish'),
                h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => { ui.confirm = false; draw(); } }, 'Keep walking')),
              h('p', { class: 'meta' }, 'A walk that stopped early is shown on the map and left out of the totals.'),
            ] : [
              h('p', { id: 'wk-fin-h' }, h('b', {}, rp ? `Finish and add walk ${rp.walkNo} to the map?` : 'Finish and see the map?')),
              rp ? null : h('p', { class: 'meta' }, 'You can still change a name, a role or a time on the map.'),
              h('div', { class: 'form-actions' },
                h('button', { type: 'button', class: 'btn', 'data-test': 'walk-finish-yes', 'data-cmd': 'ospeli_walks_finish',
                  onclick: async () => { const out = await tap('ospeli_walks_finish'); if (out) { location.hash = `#/process/${out.mapId}`; } } }, 'Yes, finish'),
                h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => { ui.confirm = false; draw(); } }, 'Keep walking')),
            ]))
          : h('button', { type: 'button', class: 'btn btn-ghost walk-finish', 'data-test': 'walk-finish', disabled: w.steps.length && !step ? null : true,
            onclick: () => { ui.confirm = true; draw(); box.querySelector('[data-test="walk-finish-yes"], [data-test="walk-finish-none"]')?.focus(); } }, 'Finish walk'),
        !w.steps.length || step ? h('p', { class: 'meta' }, step ? 'Mark the step done before you finish.' : 'Time at least one step before you finish.') : null),
      h('p', { class: 'meta walk-foot' }, 'Time the steps, never the people. People decide; Ospeli suggests.'),
      h('p', { class: 'meta walk-foot' }, h('button', { type: 'button', class: 'linkish', 'data-test': 'walk-delete', 'data-cmd': 'ospeli_walks_discard',
        onclick: async () => { if (!window.confirm('Delete this walk? Its times are not kept.')) return; const out = await tap('ospeli_walks_discard'); if (out) { ctx.toast('Walk deleted.'); location.hash = '#/process'; } } }, 'Delete this walk'))));
  }

  await load();
  // A step that ended with no name yet (a reload in the middle): offer the sheet again.
  const w0 = data.walk;
  if (w0 && w0.steps.length && !w0.steps[w0.steps.length - 1].named && w0.state === 'waiting') ui.sheet = true;
  draw();
  timer = setInterval(tick, 500);
  return () => {
    stopped = true; clearInterval(timer); clearTimeout(undoTimer); status.remove();
    document.removeEventListener('visibilitychange', onVisible);
    try { lock?.release?.(); } catch { /* nothing to release */ }
  };
}
