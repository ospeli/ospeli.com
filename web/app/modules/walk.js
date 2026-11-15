// Walk mode (backlog PM2): follow one patient visit or one item with a phone and tap as things
// happen. One screen, one big button. Every tap runs a named command (core/commands.js:
// ospeli_walks_get, ospeli_walks_step_start, ospeli_walks_step_done, ospeli_walks_step_name,
// ospeli_walks_undo, ospeli_walks_finish, ospeli_walks_discard); the command stamps the time, and
// the walk is saved on every tap, so a locked phone, a reload or a handed-over phone loses nothing.
// The timer on screen is worked out from those saved times; it is never the record.
import { h } from './ui.js';
import { fmtClock, fmtSeconds } from '../core/walk.js';

const UNDO_MS = 10000;

// Draws the walk in progress into `box`. Returns a function that stops its timer.
export async function renderWalk(box, ctx) {
  const ui = { busy: false, sheet: false, name: '', role: '', msg: false, next: false, confirm: false, undoUntil: 0, question: null, error: '' };
  let data = null; let offset = 0; let timer = null; let undoTimer = null; let lock = null; let stopped = false;

  const keepAwake = async () => { try { lock = await navigator.wakeLock?.request('screen'); } catch { lock = null; } };
  const onVisible = () => { if (document.visibilityState === 'visible') { keepAwake(); tick(); } };
  document.addEventListener('visibilitychange', onVisible);
  keepAwake();

  const nowMs = () => Date.now() - offset;
  const secsSince = (iso) => Math.max(0, (nowMs() - Date.parse(iso)) / 1000);

  async function load() {
    data = await ctx.run('ospeli_walks_get', {});
    offset = Date.now() - Date.parse(data.now);
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
  const resetSheet = () => { ui.sheet = false; ui.name = ''; ui.role = ''; ui.msg = false; ui.next = false; ui.question = null; ui.error = ''; };
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
    if (t) t.textContent = fmtClock(secsSince(w.since));
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

  function draw() {
    if (stopped) return;
    const w = data?.walk;
    if (!w || w.status !== 'walking') {
      box.replaceChildren(h('section', { class: 'card', 'data-test': 'walk-none' },
        h('h2', {}, 'No walk in progress'),
        h('p', {}, 'Start a walk from the Process maps page.'),
        h('a', { class: 'btn', href: '#/process' }, 'Go to Process maps')));
      return;
    }
    const step = w.state === 'step';
    const canUndo = Date.now() < ui.undoUntil && (step || w.steps.length > 0);
    const main = h('button', { type: 'button', class: 'btn walk-main', 'data-test': 'walk-main', 'data-cmd': step ? 'ospeli_walks_step_done' : 'ospeli_walks_step_start',
      onclick: async () => {
        // A half-answered sheet belongs to the step before: keep what was chosen before moving on.
        if (step && ui.sheet && (ui.name || ui.role)) await tap('ospeli_walks_step_name', { ...(ui.name ? { name: ui.name } : {}), ...(ui.role ? { role: ui.role } : {}), msg: ui.msg });
        const out = await tap(step ? 'ospeli_walks_step_done' : 'ospeli_walks_step_start');
        if (!out) return;
        if (step) { resetSheet(); ui.sheet = true; }
        ui.confirm = false; showUndo(); draw();
        if (step) box.querySelector('[data-test="walk-sheet"]')?.scrollIntoView({ block: 'nearest' });
      } }, step ? 'Step done' : 'Step starts');
    box.replaceChildren(h('section', { class: `walk ${step ? 'is-step' : 'is-waiting'}`, 'data-test': 'walk', 'data-state': w.state, 'aria-labelledby': 'wk-h' },
      h('div', { class: 'walk-top' },
        h('h1', { id: 'wk-h' }, 'Walk in progress'),
        h('p', { class: 'walk-sub' }, `${w.title} · one visit, step by step`)),
      h('div', { class: 'walk-now', 'aria-live': 'off' },
        h('span', { class: 'walk-state', 'data-test': 'walk-state' }, step ? 'Hands-on' : 'Waiting'),
        h('span', { class: 'walk-timer', role: 'timer', 'data-test': 'walk-timer' }, fmtClock(secsSince(w.since))),
        h('span', { class: 'walk-meta' }, h('span', { 'data-test': 'walk-total' }, `Whole walk ${fmtClock(secsSince(w.startedAt))}`), ` · ${w.steps.length} ${w.steps.length === 1 ? 'step' : 'steps'} saved`)),
      main,
      h('p', { class: 'walk-def', 'data-test': 'walk-def' }, step
        ? 'Hands-on: someone is working on this patient or item.'
        : 'Waiting: no one is working on this patient or item, even if staff are busy elsewhere.'),
      h('div', { class: 'walk-side' },
        step ? h('button', { type: 'button', class: 'btn btn-ghost walk-stop', 'data-test': 'walk-stopped', 'data-cmd': 'ospeli_walks_step_done',
          onclick: async () => { const out = await tap('ospeli_walks_step_done', { interrupted: true }); if (out) { resetSheet(); ui.sheet = true; showUndo(); draw(); } } }, 'Interrupted') : null,
        canUndo ? h('button', { type: 'button', class: 'btn btn-ghost walk-undo', 'data-test': 'walk-undo', 'data-cmd': 'ospeli_walks_undo',
          onclick: async () => { const out = await tap('ospeli_walks_undo'); if (out) { resetSheet(); ui.undoUntil = 0; ctx.toast(out.undone === 'step-done' ? 'Undone. The step is running again.' : 'Undone. Waiting again.'); draw(); } } }, 'Undo last tap') : null),
      ui.sheet && w.steps.length ? sheet(w) : null,
      h('div', { class: 'walk-end' },
        ui.confirm
          ? h('div', { class: 'walk-confirm', role: 'alertdialog', 'aria-labelledby': 'wk-fin-h', 'data-test': 'walk-confirm' },
            h('p', { id: 'wk-fin-h' }, h('b', {}, 'Finish and see the map?')),
            h('p', { class: 'meta' }, 'You can still change a name, a role or a time on the map.'),
            h('div', { class: 'form-actions' },
              h('button', { type: 'button', class: 'btn', 'data-test': 'walk-finish-yes', 'data-cmd': 'ospeli_walks_finish',
                onclick: async () => { const out = await tap('ospeli_walks_finish'); if (out) { location.hash = `#/process/${out.mapId}`; } } }, 'Yes, finish'),
              h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => { ui.confirm = false; draw(); } }, 'Keep walking')))
          : h('button', { type: 'button', class: 'btn btn-ghost walk-finish', 'data-test': 'walk-finish', disabled: w.steps.length && !step ? null : true,
            onclick: () => { ui.confirm = true; draw(); box.querySelector('[data-test="walk-finish-yes"]')?.focus(); } }, 'Finish walk'),
        !w.steps.length || step ? h('p', { class: 'meta' }, step ? 'Mark the step done before you finish.' : 'Time at least one step before you finish.') : null),
      h('p', { class: 'meta walk-foot' }, 'Time the steps, never the people. Tell staff what you are doing. People decide; Ospeli suggests.'),
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
    stopped = true; clearInterval(timer); clearTimeout(undoTimer);
    document.removeEventListener('visibilitychange', onVisible);
    try { lock?.release?.(); } catch { /* nothing to release */ }
  };
}
