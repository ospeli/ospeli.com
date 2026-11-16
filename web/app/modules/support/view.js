// Cleaning and portering: the screens. Every read and write goes through ctx.run, the same
// commands an agent would use, so the page works the same on a site's own server.
//   #/support/jobs   My team's jobs (porter, cleaner): the next job and one big button
//   #/support/board  Task board (supervisor, patient flow coordinator, wards): every open job by area
//   #/support/ask    Ask for help (charge nurse): a job in a few taps; #/support/ask/<ward id> preselects the ward
//   #/support/audit  Cleaning audit (supervisor on a phone; others may read the results)
// The role decides which screens it has and which opens first. Measures jobs and waits, never people.
import { h, setKids, fmtWait, moduleStyle } from '../ui.js';
import { roleById } from '../../core/model.js';
import { commandByName } from '../../core/commands.js';
import { proposalsCard } from '../proposals.js';

const can = (role, cmd) => !!commandByName(cmd)?.roles.includes(role);
const roleNames = (ids) => ids.map((r) => roleById(r)?.name || r).join(', ');
const TEAM_OF_ROLE = { porter: 'portering', cleaner: 'cleaning' };
const TITLES = { jobs: 'My team\'s jobs', board: 'Task board', ask: 'Ask for help', audit: 'Cleaning audit' };
// Porters and cleaners get their own queue and nothing that balances the work between teams.
function screensFor(role) {
  if (role === 'porter') return ['jobs'];
  if (role === 'cleaner') return ['jobs', 'audit'];
  if (role === 'ward-nurse' || role === 'ae-nic') return ['ask', 'board', 'audit'];
  if (role === 'support-supervisor' || role === 'bed-manager') return ['board', 'audit', 'ask'];
  return ['board', 'audit'];
}
const ORDINAL = ['First', 'Second', 'Third', 'Fourth', 'Fifth', 'Sixth', 'Seventh', 'Eighth', 'Ninth', 'Tenth'];
const ordinal = (n) => ORDINAL[n - 1] || `Number ${n}`;
const minsSince = (iso, now) => Math.max(0, Math.round((Date.parse(now) - Date.parse(iso)) / 60000));
const fmtKpi = (k) => (k.value == null ? 'None yet' : k.unit === '%' ? `${Math.round(k.value)}%` : `${Math.round(k.value)} min`);
const lower = (s) => s.charAt(0).toLowerCase() + s.slice(1);
const UNDO_MS = 10e3; // "Undo" stays on the confirmation line this long after a start
const LOCK_MS = 5e3; // the done button cannot be tapped this long after a start (a second tap is not a finish)

// Remembered on this device only (a task id or a place id, kept in this browser, never sent, never
// about a person): the job this phone took, so its card stays on top when the app is opened again,
// and the place this device last asked from.
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { if (v) localStorage.setItem(k, v); else localStorage.removeItem(k); } catch { /* still works for this visit */ } },
};
let mine = store.get('ospeli-support-mine');
let tookAt = 0; // when this phone took `mine` in this visit (for Undo and the done-button pause)

export async function render(el, ctx) {
  await moduleStyle('support');
  el.classList.add('mod-support');
  const screens = screensFor(ctx.role);
  const screen = screens.includes(ctx.rest[0]) ? ctx.rest[0] : screens[0];
  const places = await ctx.run('ospeli_support_places', { limit: 500 });
  const head = h('div', { class: 'page-head' }, h('div', {}, h('p', { class: 'eyebrow' }, 'Cleaning and portering'), h('h1', {}, TITLES[screen])));
  if (!places.wards.length && !places.departments.length) {
    el.append(h('div', { class: 'mod-support sup' }, head), h('div', { class: 'card notice' }, h('p', {}, 'No hospital is loaded on this device. Load Example General Hospital on the ', h('a', { href: '#/data' }, 'Data and audit'), ' page.')));
    return null;
  }
  const names = placeNames(places);
  const tabs = screens.length > 1 ? h('nav', { class: 'sup-tabs', 'aria-label': 'Cleaning and portering' },
    screens.map((s) => h('a', { href: `#/support/${s}`, 'data-screen': s, 'aria-current': s === screen ? 'page' : null }, TITLES[s]))) : null;
  const view = { jobs: jobsScreen, board: boardScreen, ask: askScreen, audit: auditScreen }[screen](ctx, { places, names });
  // The shell moves the page's children into <main>, so the module's class goes on its own wrapper too.
  el.append(h('div', { class: 'mod-support sup', 'data-screen': screen, 'data-role': ctx.role }, head, tabs, view.el));
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

// id -> plain name, for wards, beds ("Ward A1 (acute medicine), Bed 04") and departments.
function placeNames(places) {
  const m = new Map();
  for (const w of places.wards) { m.set(w.id, w.name); for (const b of w.beds) m.set(b.id, `${w.name}, ${b.name}`); }
  for (const d of places.departments) m.set(d.id, d.name);
  return m;
}
function placeSelect(id, places, { blank }) {
  return h('select', { id, 'data-test': id },
    h('option', { value: '' }, blank),
    h('optgroup', { label: 'Wards' }, places.wards.map((w) => new Option(w.name, w.id))),
    h('optgroup', { label: 'Departments' }, places.departments.map((d) => new Option(d.name, d.id))));
}

// Why a job is first in its queue, in words that keep a ward's urgent ask apart from a job the
// people who balance the work moved up (overview.marks).
function markChip(t, marks) {
  const m = marks?.[t.id] || (t.priority === 'urgent' ? 'asked-urgent' : null);
  if (m === 'do-next') return h('span', { class: 'chip sup-next', 'data-mark': 'do-next' }, 'Do this next');
  if (m === 'asked-urgent') return h('span', { class: 'chip sup-urgent', 'data-mark': 'asked-urgent' }, 'Urgent');
  return null;
}
// One job, the way every screen shows it: what, where (and where to), how long it has waited, and
// the facts that change what a person does: handed back, and for a bed clean, a patient waiting.
function jobFacts(t, now, info = {}) {
  const wait = minsSince(t.requestedAt, now);
  const waitText = t.state === 'started' ? `${t.stateName}${t.startedAt && minsSince(t.startedAt, now) ? ` for ${fmtWait(minsSince(t.startedAt, now))}` : ': just started'}`
    : wait < 1 ? 'Just now' : `Waiting ${fmtWait(wait)}`;
  const demand = t.kind === 'bed-clean' ? info.demand?.get(t.wardId) : null;
  return [
    h('p', { class: 'sup-what' }, h('b', {}, t.kindName), t.detail ? h('span', { class: 'chip' }, t.detail) : null, markChip(t, info.marks)),
    h('p', { class: 'sup-where' }, t.toLocationName ? [h('span', {}, 'From '), h('b', {}, t.locationName), h('span', {}, ' to '), h('b', {}, t.toLocationName)] : h('b', {}, t.locationName)),
    h('p', { class: `sup-wait${t.state === 'started' ? ' is-started' : ''}`, 'data-test': 'wait' }, waitText),
    t.state === 'requested' && t.releases ? h('p', { class: 'sup-fact', 'data-test': 'handed-back' }, `Handed back: ${lower(t.lastReleaseReason || 'no reason given')}`) : null,
    demand?.patientsWaiting ? h('p', { class: 'sup-fact', 'data-test': 'bed-demand' }, `${demand.patientsWaiting} ${demand.patientsWaiting === 1 ? 'patient is' : 'patients are'} waiting for a bed on this ward`) : null,
  ];
}
const demandMap = (ov) => new Map((ov?.bedDemand || []).map((d) => [d.wardId, d]));

// Run one task command for a person, safely: a second tap while the first runs does nothing, and
// expectedState makes the command refuse a job someone else changed meanwhile.
function taskActions(ctx, reload) {
  let busy = false;
  return async function act(cmd, t, extra = {}, words, onDone = null) {
    if (busy) return null;
    busy = true;
    try {
      const out = await ctx.run(cmd, { taskId: t.id, expectedState: t.state, ...extra });
      if (words) ctx.toast(`${words}: ${t.kindName}, ${t.locationName}`);
      if (onDone) onDone(out);
      return out;
    } catch (err) {
      ctx.toast(`Not saved. ${err.message}`);
      return null;
    } finally {
      busy = false;
      await reload();
    }
  };
}
// Hand a started job back to the queue: one tap per reason.
function handBack(t, reasons, act, { label = 'Hand back this job', onDone = null } = {}) {
  return h('details', { class: 'sup-handback', 'data-test': 'hand-back' }, h('summary', {}, label),
    h('p', { class: 'meta' }, 'It goes back in the queue in its old place. Why?'),
    h('div', { class: 'sup-reasons' }, reasons.map((r) => h('button', { class: 'btn btn-ghost btn-small', type: 'button', 'data-cmd': 'ospeli_tasks_release', 'data-release': r,
      onclick: () => act('ospeli_tasks_release', t, { reason: r }, 'Handed back', onDone) }, r))));
}

// ---------------------------------------------------------------- My team's jobs (phone)
function jobsScreen(ctx) {
  const team = TEAM_OF_ROLE[ctx.role];
  const box = h('div', { class: 'sup-jobs' });
  const ui = { confirm: null }; // the waiting job this person asked to take instead, waiting for "Yes"
  let data = null;
  let timer = null;
  const load = async () => {
    const [list, kinds, ov] = await Promise.all([
      ctx.run('ospeli_tasks_list', { team, limit: 200 }), ctx.run('ospeli_tasks_kinds', {}), ctx.run('ospeli_support_overview', { days: 7, format: 'short' })]);
    data = { list, kinds: new Map(kinds.kinds.map((k) => [k.id, k])), releaseReasons: kinds.releaseReasons, teamName: kinds.teams.find((x) => x.id === team)?.name || team, ov };
    draw();
  };
  const act = taskActions(ctx, load);
  const mayDo = (t) => !!data.kinds.get(t.kind)?.doRoles.includes(ctx.role);
  const take = (t) => act('ospeli_tasks_start', t, {}, t.startLabel, () => { mine = t.id; tookAt = Date.now(); store.set('ospeli-support-mine', mine); ui.confirm = null; });
  const release = () => { mine = null; tookAt = 0; store.set('ospeli-support-mine', null); };

  function draw() {
    clearTimeout(timer);
    const { list, ov } = data;
    const now = list.asOf;
    const info = { marks: ov.marks, demand: demandMap(ov) };
    const waiting = list.tasks.filter((t) => t.state === 'requested');
    const started = list.tasks.filter((t) => t.state === 'started');
    const current = started.find((t) => t.id === mine) || null;
    if (!current && mine) release();
    const next = current || waiting[0] || null;
    const since = current && tookAt ? Date.now() - tookAt : Infinity;
    const locked = since < LOCK_MS;
    const c = list.counts;

    let card;
    if (current) {
      // The job this phone took: it looks different at once, so nobody taps again to check.
      card = h('section', { class: 'sup-card is-mine', 'data-test': 'next-job', 'data-task': current.id, 'data-mode': 'mine', 'aria-labelledby': 'sup-next-h' },
        h('p', { class: 'sup-label sup-have', id: 'sup-next-h' }, 'You have this job'),
        since < UNDO_MS ? h('p', { class: 'sup-confirm', role: 'status', 'data-test': 'confirm' }, `${current.stateName}. Saved.`,
          h('button', { class: 'linkish', type: 'button', 'data-cmd': 'ospeli_tasks_release', 'data-test': 'undo',
            onclick: () => act('ospeli_tasks_release', current, { reason: 'Started by mistake' }, 'Undone', release) }, 'Undo')) : null,
        jobFacts(current, now, info),
        h('p', { class: 'sup-hint' }, `Tap ${current.doneLabel} when it is done.`),
        h('button', { class: 'btn btn-big sup-main sup-done', type: 'button', 'data-task': current.id, 'data-test': 'main-action', 'data-cmd': 'ospeli_tasks_complete',
          disabled: locked, 'aria-disabled': String(locked),
          onclick: (e) => { e.currentTarget.disabled = true; act('ospeli_tasks_complete', current, {}, current.doneLabel, release); } },
        doneText(current, since)),
        handBack(current, data.releaseReasons, act, { onDone: release }));
    } else if (next) {
      card = h('section', { class: `sup-card${markChip(next, ov.marks) ? ' is-urgent' : ''}`, 'data-test': 'next-job', 'data-task': next.id, 'data-mode': 'next', 'aria-labelledby': 'sup-next-h' },
        h('p', { class: 'sup-label', id: 'sup-next-h' }, 'Next job'),
        jobFacts(next, now, info),
        mayDo(next) ? [
          h('p', { class: 'sup-hint' }, `Tap ${next.startLabel} to take this job.`),
          h('button', { class: 'btn btn-big sup-main', type: 'button', 'data-task': next.id, 'data-test': 'main-action', 'data-cmd': 'ospeli_tasks_start',
            onclick: (e) => { e.currentTarget.disabled = true; take(next); } }, next.startLabel),
        ] : h('p', { class: 'meta' }, `Done by: ${roleNames(data.kinds.get(next.kind)?.doRoles || [])}`),
        h('p', { class: 'sup-pos' }, `First of ${waiting.length} ${waiting.length === 1 ? 'job' : 'jobs'}.`));
    } else {
      card = h('section', { class: 'sup-card', 'data-test': 'next-job', 'data-mode': 'empty', 'aria-labelledby': 'sup-next-h' },
        h('p', { class: 'sup-label', id: 'sup-next-h' }, 'Next job'),
        h('p', { class: 'sup-empty', 'data-test': 'queue-empty' }, `No job is waiting for ${data.teamName}.`),
        h('p', { class: 'meta' }, `New jobs show here by themselves, the moment a ward asks${team === 'cleaning' ? ' or a bed is vacated on the bed board' : ''}.`));
    }

    // Other waiting jobs: a small "take this one instead" that asks once; none while you have a job.
    const row = (t, action) => h('li', { class: 'sup-row', 'data-task': t.id }, h('div', { class: 'sup-row-text' }, jobFacts(t, now, info)), action);
    const insteadOf = (t) => {
      if (current || !mayDo(t)) return null;
      if (ui.confirm === t.id) {
        return h('div', { class: 'sup-ask-again', 'data-test': 'confirm-take' }, h('p', {}, 'Take this job instead of the next one?'),
          h('div', { class: 'actions' },
            h('button', { class: 'btn btn-small', type: 'button', 'data-cmd': 'ospeli_tasks_start', 'data-task': t.id, onclick: (e) => { e.currentTarget.disabled = true; take(t); } }, `Yes, ${lower(t.startLabel)}`),
            h('button', { class: 'btn btn-ghost btn-small', type: 'button', onclick: () => { ui.confirm = null; draw(); } }, 'No')));
      }
      return h('button', { class: 'btn btn-ghost btn-small sup-instead', type: 'button', 'data-test': 'take-instead', onclick: () => { ui.confirm = t.id; draw(); box.querySelector('[data-test="confirm-take"] button')?.focus(); } }, 'Take this one instead');
    };
    if (since < UNDO_MS) timer = setTimeout(() => tick(card), 1000);
    const after = waiting.filter((t) => t !== next);
    const others = started.filter((t) => t !== current);
    setKids(box,
      h('p', { class: 'sup-counts', 'data-test': 'queue-counts' }, h('b', {}, c.waiting), ' waiting · ', h('b', {}, c.inProgress), ' in progress',
        c.longestWaitMinutes ? [' · longest wait ', h('b', {}, fmtWait(c.longestWaitMinutes))] : null),
      card,
      after.length ? h('section', { class: 'sup-list', 'aria-labelledby': 'sup-after-h' }, h('h2', { id: 'sup-after-h' }, `Next in line (${after.length})`),
        current ? h('p', { class: 'meta' }, 'Finish or hand back your job to take another.') : null,
        h('ul', {}, after.map((t) => row(t, insteadOf(t))))) : null,
      others.length ? h('section', { class: 'sup-list', 'aria-labelledby': 'sup-others-h' }, h('h2', { id: 'sup-others-h' }, `Being done by your team (${others.length})`),
        h('ul', {}, others.map((t) => row(t, null)))) : null);
  }
  // Count down in place (the hand-back list stays open): the pause on the done button, then the Undo.
  const doneText = (t, since) => (since < LOCK_MS ? `${t.doneLabel} (wait ${Math.ceil((LOCK_MS - since) / 1000)} s)` : `✓ ${t.doneLabel}`);
  function tick(card) {
    const since = Date.now() - tookAt;
    const btn = card.querySelector('[data-test="main-action"]');
    const t = data.list.tasks.find((x) => x.id === mine);
    if (btn && t) {
      btn.textContent = doneText(t, since);
      if (since >= LOCK_MS && btn.disabled) { btn.disabled = false; btn.setAttribute('aria-disabled', 'false'); }
    }
    if (since >= UNDO_MS) card.querySelector('[data-test="confirm"]')?.remove();
    else timer = setTimeout(() => tick(card), 1000);
  }
  return { el: box, load, stop: () => clearTimeout(timer) };
}

// ---------------------------------------------------------------- Task board
function boardScreen(ctx, { names }) {
  const box = h('div', { class: 'sup-board' });
  const ui = { team: 'all' };
  let data = null;
  const props = proposalsCard(ctx, { match: (p) => /^ospeli_(support|tasks)_/.test(p.command), describe: (p) => describeProposal(p, data, names) });
  const load = async () => {
    const [list, kinds, ov] = await Promise.all([ctx.run('ospeli_tasks_list', { limit: 500 }), ctx.run('ospeli_tasks_kinds', {}), ctx.run('ospeli_support_overview', { days: 7 })]);
    data = { list, kinds, kindById: new Map(kinds.kinds.map((k) => [k.id, k])), ov, tasks: new Map(list.tasks.map((t) => [t.id, t])) };
    draw();
    await props.load();
  };
  const act = taskActions(ctx, load);
  let busy = false;

  async function follow(s) {
    if (busy) return;
    busy = true;
    let done = 0;
    try {
      for (const input of s.action.inputs) { await ctx.run(s.action.command, input); done += 1; }
      ctx.toast(`${done} marked: do this next`);
    } catch (err) {
      ctx.toast(`${done ? `${done} marked. ` : ''}Not saved. ${err.message}`);
    } finally { busy = false; await load(); }
  }
  async function setGuide(on) {
    if (busy) return;
    busy = true;
    try { await ctx.run('ospeli_support_guide_set', { on }); ctx.toast(`Guide ${on ? 'on' : 'off'}`); } catch (err) { ctx.toast(`Not saved. ${err.message}`); } finally { busy = false; await load(); }
  }

  function guideCard(g) {
    const mayAct = (s) => s.action && can(ctx.role, s.action.command);
    const mayToggle = can(ctx.role, 'ospeli_support_guide_set');
    return h('section', { class: 'card sup-guide', 'data-test': 'guide', 'data-on': String(g.on), 'aria-labelledby': 'sup-guide-h' },
      h('div', { class: 'sup-guide-head' }, h('h2', { id: 'sup-guide-h' }, 'Guide'),
        mayToggle ? h('button', { class: 'btn btn-ghost btn-small guide-switch', type: 'button', 'aria-pressed': String(g.on), 'data-cmd': 'ospeli_support_guide_set', 'data-test': 'guide-switch', onclick: () => setGuide(!g.on) }, g.on ? 'Guide on: switch off' : 'Guide off: switch on') : null),
      g.on ? [
        h('p', { class: 'meta' }, 'Fixed rules, not AI. They suggest; you decide. Nothing changes until you tap.'),
        g.suggestions.length ? h('ul', { class: 'sup-sugg' }, g.suggestions.map((s) => h('li', { 'data-rule': s.rule, 'data-test': 'suggestion' },
          h('p', {}, h('b', {}, s.text)), h('p', { class: 'meta' }, s.why),
          mayAct(s) ? h('button', { class: 'btn btn-small', type: 'button', 'data-cmd': s.action.command, 'data-test': 'follow', onclick: () => follow(s) }, s.action.inputs.length === 1 ? 'Do this clean next' : `Do these ${s.action.inputs.length} cleans next`) : null,
          h('details', { class: 'sup-def' }, h('summary', {}, 'Why this rule'), h('p', {}, s.basis)))))
          : h('p', { 'data-test': 'no-suggestion' }, 'Nothing to suggest right now.'),
      ] : h('p', { 'data-test': 'guide-off' }, 'The guide is off. Jobs, measures and audits work the same.'),
      mayToggle ? null : h('p', { class: 'meta' }, 'The Support services supervisor, Operations manager or COO can switch the guide on or off.'));
  }

  function row(t, now, info) {
    const k = data.kindById.get(t.kind);
    const mayDo = k?.doRoles.includes(ctx.role);
    const mark = info.marks[t.id];
    // The queue order matters only before a job starts, and a ward's own urgent ask is not undone here.
    const mayLead = t.state === 'requested' && mark !== 'asked-urgent' && can(ctx.role, 'ospeli_tasks_set_priority');
    const mayCancel = t.source === 'task' && k && [...k.requestRoles, ...k.doRoles].includes(ctx.role);
    const reason = h('select', { 'aria-label': `Reason to cancel: ${t.kindName}, ${t.locationName}` }, data.kinds.cancelReasons.map((r) => new Option(r, r)));
    return h('li', { class: `sup-row${mark ? ' is-urgent' : ''}`, 'data-task': t.id, 'data-team': t.team },
      h('div', { class: 'sup-row-text' }, jobFacts(t, now, info)),
      h('div', { class: 'sup-row-acts' },
        mayDo ? h('button', { class: `btn btn-small${t.state === 'started' ? ' sup-done' : ''}`, type: 'button', 'data-cmd': t.state === 'started' ? 'ospeli_tasks_complete' : 'ospeli_tasks_start',
          onclick: () => (t.state === 'started' ? act('ospeli_tasks_complete', t, {}, t.doneLabel) : act('ospeli_tasks_start', t, {}, t.startLabel)) }, t.state === 'started' ? t.doneLabel : t.startLabel) : null,
        mayLead ? h('button', { class: 'btn btn-ghost btn-small', type: 'button', 'data-cmd': 'ospeli_tasks_set_priority', 'data-test': 'to-front',
          onclick: () => act('ospeli_tasks_set_priority', t, { priority: mark === 'do-next' ? 'routine' : 'urgent' }, mark === 'do-next' ? 'Back to its place' : 'Do this next') },
        mark === 'do-next' ? 'Undo: back to its place' : 'Do this next') : null,
        mayDo && t.state === 'started' ? handBack(t, data.kinds.releaseReasons, act, { label: 'Hand back' }) : null,
        mayCancel ? h('details', { class: 'sup-cancel' }, h('summary', {}, 'Cancel'),
          h('div', { class: 'sup-cancel-body' }, reason,
            h('button', { class: 'btn btn-ghost btn-small', type: 'button', 'data-cmd': 'ospeli_tasks_cancel', onclick: () => act('ospeli_tasks_cancel', t, { reason: reason.value }, 'Cancelled') }, 'Cancel this job'))) : null));
  }

  function draw() {
    const { list, ov } = data;
    const now = list.asOf;
    const info = { marks: ov.marks, demand: demandMap(ov) };
    const shown = list.tasks.filter((t) => ui.team === 'all' || t.team === ui.team);
    // By area (a bed's ward, or the department), the area with the oldest job first; oldest first inside.
    const groups = new Map();
    for (const t of [...shown].sort((a, b) => (a.requestedAt < b.requestedAt ? -1 : 1))) {
      const area = t.wardId || t.locationId;
      if (!groups.has(area)) groups.set(area, []);
      groups.get(area).push(t);
    }
    const doers = [...new Set(data.kinds.kinds.flatMap((k) => k.doRoles))];
    const actsHere = data.kinds.kinds.some((k) => k.doRoles.includes(ctx.role)) || can(ctx.role, 'ospeli_tasks_set_priority');
    setKids(box,
      props.el,
      h('div', { class: 'stats sup-teams', 'data-test': 'team-counts' }, ov.teams.map((t) => h('div', { class: 'stat', 'data-team': t.id },
        h('span', {}, t.name), h('b', {}, `${t.waiting} waiting`),
        h('span', {}, `${t.inProgress} in progress${t.longestWaitMinutes ? ` · longest ${fmtWait(t.longestWaitMinutes)}` : ''}${t.urgent ? ` · ${t.urgent} first in line` : ''}`)))),
      guideCard(ov.guide),
      h('section', { class: 'section', 'aria-labelledby': 'sup-open-h' },
        h('h2', { id: 'sup-open-h' }, `Open jobs (${shown.length})`),
        h('div', { class: 'chips', role: 'group', 'aria-label': 'Show jobs for' }, [['all', 'All teams'], ...data.kinds.teams.map((x) => [x.id, x.name])].map(([id, label]) => h('button', {
          class: 'chip-btn', type: 'button', 'aria-pressed': String(ui.team === id), 'data-filter': id, onclick: () => { ui.team = id; draw(); box.querySelector(`[data-filter="${id}"]`)?.focus(); } }, label))),
        actsHere ? h('p', { class: 'meta' }, 'Grouped by area, the oldest job first. "Do this next" puts a job first in its team\'s queue; it starts or assigns nothing. "Urgent" is how the ward asked.')
          : h('p', { class: 'meta', 'data-test': 'read-only' }, `${roleById(ctx.role).name} can see the board. Jobs are done by ${roleNames(doers)}; put first in line by Support services supervisor or Patient flow coordinator.`),
        groups.size ? h('div', { class: 'sup-groups', 'data-test': 'board' }, [...groups].map(([area, items]) => h('section', { class: 'sup-group', 'data-area': area },
          h('h3', {}, names.get(area) || items[0].locationName, h('span', {}, ` ${items.length}`)), h('ul', {}, items.map((t) => row(t, now, info))))))
          : h('p', { class: 'sup-empty', 'data-test': 'board-empty' }, 'No open jobs.')),
      h('p', { class: 'card meta notice', 'data-test': 'planned' }, 'Linen and meals: planned, not built yet.'),
      kpiSection(ov));
  }
  return { el: box, load };
}

function kpiSection(ov) {
  const extra = (k) => {
    if (k.leftOut) {
      return h('p', { class: 'meta', 'data-test': 'left-out' }, k.leftOut.total
        ? `Left out of the median: ${k.leftOut.total} ${k.leftOut.total === 1 ? 'bed' : 'beds'} used again (${k.leftOut.usedAgain}) or taken out of service (${k.leftOut.outOfService}) before a clean was recorded.`
        : 'No bed was used again or taken out of service before a clean was recorded.');
    }
    if (k.byPriority) {
      return [h('p', { class: 'meta', 'data-test': 'by-priority' }, k.byPriority.map((b) => `${b.name}: ${fmtKpi({ ...b, unit: k.unit })} (${b.n})`).join(' · ')),
        h('p', { class: 'meta' }, 'A job that was handed back keeps the time it was first asked for.')];
    }
    return null;
  };
  return h('section', { class: 'section', 'aria-labelledby': 'sup-kpi-h' },
    h('h2', { id: 'sup-kpi-h' }, `Measures, last ${ov.period.days} days`),
    h('p', { class: 'meta' }, 'Calculated from the event log on this device. They count jobs and waits for the team, never a person.'),
    h('div', { class: 'sup-kpis' }, ov.kpis.map((k) => h('div', { class: 'card sup-kpi', 'data-kpi': k.id, 'data-n': k.n },
      h('p', { class: 'sup-kpi-name' }, k.name),
      h('p', { class: 'sup-kpi-value' }, fmtKpi(k)),
      h('p', { class: 'meta' }, k.unit === '%' ? `${k.numerator ?? 0} of ${k.denominator ?? 0} items passed, ${k.n} audits` : `Median of ${k.n} ${k.id === 'support-bed-turnaround' ? 'bed cleans' : 'jobs'} done`),
      extra(k),
      k.breakdown?.length ? h('ul', { class: 'sup-breakdown' }, k.breakdown.filter((b) => b.n).map((b) => h('li', {}, `${b.name}: ${fmtKpi({ ...b, unit: k.unit })} (${b.n})`))) : null,
      h('details', { class: 'sup-def' }, h('summary', {}, 'How it is counted'),
        h('p', {}, k.definition), h('p', {}, `Counts: ${k.counts}`), h('p', {}, `Leaves out: ${k.leavesOut}`), h('p', {}, `Source: ${k.source}`), h('p', {}, `Target: ${k.targetText}`))))),
    h('ul', { class: 'sup-planned' }, ov.planned.map((p) => h('li', { class: 'meta' }, `${p.name}: ${p.note}`))));
}

function describeProposal(p, data, names) {
  const t = data?.tasks.get(p.input.taskId);
  const job = t ? `${t.kindName}, ${t.locationName}` : 'a job that is no longer open';
  switch (p.command) {
    case 'ospeli_tasks_set_priority': return `${p.input.priority === 'urgent' ? 'Do this next' : 'Back to its place'}: ${job}`;
    case 'ospeli_tasks_start': return `Start: ${job}`;
    case 'ospeli_tasks_complete': return `Mark done: ${job}`;
    case 'ospeli_tasks_release': return `Hand back (${lower(p.input.reason)}): ${job}`;
    case 'ospeli_tasks_cancel': return `Cancel (${p.input.reason}): ${job}`;
    case 'ospeli_tasks_request': {
      const k = data?.kindById.get(p.input.kind);
      return `Ask for ${k?.name.toLowerCase() || 'a job'}: ${names.get(p.input.locationId) || 'a place'}${p.input.toLocationId ? ` to ${names.get(p.input.toLocationId) || 'a place'}` : ''}`;
    }
    case 'ospeli_support_audit_record': {
      const n = (p.input.passed || []).length; const all = n + (p.input.failed || []).length;
      return `Record a cleaning audit: ${names.get(p.input.locationId) || 'an area'}, ${n} of ${all} items passed`;
    }
    default: return p.command;
  }
}

// ---------------------------------------------------------------- Ask for help
// The words of each kind's pick list, so the question reads as a person would ask it.
const DETAIL_QUESTION = { 'patient-move': 'How will they travel?', 'room-clean': 'What kind of clean?' };
function askScreen(ctx, { places, names }) {
  const box = h('div', { class: 'sup-ask' });
  const status = h('p', { class: 'sup-status', role: 'status', 'data-test': 'ask-status' });
  const openBox = h('div', { 'data-test': 'ask-open' });
  const pick = { kind: null, detail: null, priority: 'routine' };
  const known = (id) => [...places.wards, ...places.departments].some((p) => p.id === id);
  const fromRoute = known(ctx.rest[1]) ? ctx.rest[1] : null;
  const lastPlace = store.get('ospeli-support-place');
  let data = null;
  let busy = false;

  const where = placeSelect('ask-where', places, { blank: 'Choose a ward or department' });
  const bed = h('select', { id: 'ask-bed', 'data-test': 'ask-bed' });
  const to = placeSelect('ask-to', places, { blank: 'Choose where to' });
  const whereLabel = h('label', { for: 'ask-where' }, 'Where');
  const bedField = h('div', { class: 'field' }, h('label', { for: 'ask-bed' }, 'Bed (if it is for one bed)'), bed);
  const toField = h('div', { class: 'field' }, h('label', { for: 'ask-to' }, 'To'), to);
  const kindBox = h('div', { class: 'sup-choices', role: 'group', 'aria-labelledby': 'ask-h' });
  const detailLabel = h('span', { id: 'ask-detail-l', class: 'label' }, 'Detail');
  const detailBox = h('div', { class: 'sup-choices', role: 'group', 'aria-labelledby': 'ask-detail-l' });
  const detailField = h('div', { class: 'field' }, detailLabel, detailBox);
  const prioBox = h('div', { class: 'sup-choices sup-two', role: 'group', 'aria-labelledby': 'ask-prio-l' });
  const send = h('button', { class: 'btn btn-big', type: 'submit', 'data-cmd': 'ospeli_tasks_request', 'data-test': 'ask-send' }, 'Ask');
  const form = h('form', { class: 'card sup-form', 'aria-labelledby': 'ask-h', 'data-test': 'ask-form' });

  const fillBeds = () => {
    const w = places.wards.find((x) => x.id === where.value);
    const keep = bed.value;
    bed.replaceChildren(new Option('The whole ward', ''), ...(w ? w.beds.map((b) => new Option(b.name, b.id)) : []));
    if (w?.beds.some((x) => x.id === keep)) bed.value = keep;
    bedField.hidden = !w || !data?.kindById.get(pick.kind)?.placeTypes.includes('bed');
  };
  where.addEventListener('change', () => { if (where.value) store.set('ospeli-support-place', where.value); fillBeds(); drawOpen(); });
  where.value = fromRoute || (known(lastPlace) ? lastPlace : '');
  fillBeds();

  const choice = (label, pressed, onclick, attrs = {}) => h('button', { class: 'chip-btn sup-choice', type: 'button', 'aria-pressed': String(pressed), onclick, ...attrs }, label);
  function drawForm() {
    const askable = data.kinds.kinds.filter((k) => k.askable && k.requestRoles.includes(ctx.role));
    const k = data.kindById.get(pick.kind);
    kindBox.replaceChildren(...askable.map((x) => choice(x.name, pick.kind === x.id, () => { pick.kind = x.id; pick.detail = null; drawForm(); kindBox.querySelector(`[data-kind="${x.id}"]`)?.focus(); }, { 'data-kind': x.id })));
    detailBox.replaceChildren(...(k?.details || []).map((d) => choice(d, pick.detail === d, () => { pick.detail = d; drawForm(); detailBox.querySelector(`[data-detail="${d}"]`)?.focus(); }, { 'data-detail': d })));
    prioBox.replaceChildren(...[['routine', 'Normal'], ['urgent', 'Urgent']].map(([id, label]) => choice(label, pick.priority === id, () => { pick.priority = id; drawForm(); prioBox.querySelector(`[data-prio="${id}"]`)?.focus(); }, { 'data-prio': id })));
    whereLabel.textContent = k?.needsTo ? 'From' : 'Where';
    toField.hidden = !k?.needsTo;
    detailField.hidden = !k?.details;
    detailLabel.textContent = DETAIL_QUESTION[k?.id] || 'What is it?';
    fillBeds();
    const teamName = k ? data.kinds.teams.find((x) => x.id === k.team)?.name : null;
    send.textContent = teamName ? `Ask ${teamName}` : 'Ask';
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (busy) return;
    const k = data.kindById.get(pick.kind);
    const missing = !k ? 'what is needed' : !where.value ? 'where' : k.needsTo && !to.value ? 'where to' : k.details && !pick.detail ? lower(DETAIL_QUESTION[k.id] || 'what it is').replace('?', '') : null;
    if (missing) { status.textContent = `Choose ${missing} first.`; return; }
    const place = bed.value && !bedField.hidden ? bed.value : where.value;
    busy = true;
    send.disabled = true;
    try {
      const out = await ctx.run('ospeli_tasks_request', { kind: k.id, locationId: place, ...(k.needsTo ? { toLocationId: to.value } : {}), ...(k.details ? { detail: pick.detail } : {}), priority: pick.priority });
      await load();
      const pos = queuePosition(out.taskId);
      status.textContent = `Asked: ${k.name}, ${names.get(place)}.${pos ? ` ${pos}.` : ''}`;
      ctx.toast(`Asked: ${k.name}`);
      pick.detail = null; pick.priority = 'routine';
      drawForm();
    } catch (err) {
      status.textContent = err.code === 'conflict' && err.detail?.existing ? duplicateWords(err.detail.existing, k) : `Not saved. ${err.message}`;
    } finally { busy = false; send.disabled = false; }
  });

  // A refused second ask names the job that is open and its place, so it can never seem to cover
  // a different patient: one bed has one open move, and a ward can ask again for another patient.
  function duplicateWords(id, k) {
    const t = data.list.tasks.find((x) => x.id === id);
    if (!t) return 'Not sent: the same job is already open. No new job was opened.';
    const job = `${t.kindName} from ${t.locationName}${t.toLocationName ? ` to ${t.toLocationName}` : ''}${t.detail ? ` (${t.detail})` : ''}`;
    const more = k.repeatable ? ' For a different patient, choose their own bed or the whole ward.' : ' It is one job: no second one was opened.';
    return `Not sent: ${job} is already open, ${lower(queuePosition(id))}.${more}`;
  }
  // "Second of 5 waiting for Portering": the job's place among its team's open jobs, in working order.
  function queuePosition(taskId) {
    const t = data.list.tasks.find((x) => x.id === taskId);
    if (!t) return null;
    if (t.state === 'started') return `${t.stateName} now`;
    const queue = data.list.tasks.filter((x) => x.team === t.team && x.state === 'requested');
    return `${ordinal(queue.indexOf(t) + 1)} of ${queue.length} waiting for ${t.teamName}`;
  }
  const act = taskActions(ctx, () => load());
  function drawOpen() {
    if (!data) return;
    const here = where.value;
    const list = here ? data.list.tasks.filter((t) => t.locationId === here || t.wardId === here) : [];
    setKids(openBox, here ? h('section', { class: 'section', 'aria-labelledby': 'ask-open-h' },
      h('h2', { id: 'ask-open-h' }, `Open jobs for ${names.get(here)} (${list.length})`),
      list.length ? h('ul', { class: 'sup-list-plain' }, list.map((t) => {
        const k = data.kindById.get(t.kind);
        const reason = h('select', { 'aria-label': `Reason to cancel: ${t.kindName}, ${t.locationName}` }, data.kinds.cancelReasons.map((r) => new Option(r, r)));
        return h('li', { class: 'sup-row', 'data-task': t.id },
          h('div', { class: 'sup-row-text' }, jobFacts(t, data.list.asOf, { marks: data.marks }), h('p', { class: 'sup-pos', 'data-test': 'position' }, queuePosition(t.id))),
          t.source === 'task' && k?.requestRoles.includes(ctx.role) ? h('details', { class: 'sup-cancel' }, h('summary', {}, 'Cancel'),
            h('div', { class: 'sup-cancel-body' }, reason, h('button', { class: 'btn btn-ghost btn-small', type: 'button', 'data-cmd': 'ospeli_tasks_cancel', onclick: () => act('ospeli_tasks_cancel', t, { reason: reason.value }, 'Cancelled') }, 'Cancel this job'))) : null);
      })) : h('p', { class: 'meta' }, 'Nothing open here.')) : null);
  }

  const load = async () => {
    const [list, kinds, ov] = await Promise.all([ctx.run('ospeli_tasks_list', { limit: 500 }), ctx.run('ospeli_tasks_kinds', {}), ctx.run('ospeli_support_overview', { days: 1, format: 'short' })]);
    data = { list, kinds, kindById: new Map(kinds.kinds.map((k) => [k.id, k])), marks: ov.marks };
    if (!form.childElementCount && !build()) return;
    drawForm();
    drawOpen();
  };
  function build() {
    const askable = data.kinds.kinds.some((k) => k.askable && k.requestRoles.includes(ctx.role));
    if (!askable) {
      const who = [...new Set(data.kinds.kinds.flatMap((k) => (k.askable ? k.requestRoles : [])))];
      form.replaceWith(h('p', { class: 'card meta', 'data-test': 'read-only' }, `${roleById(ctx.role).name} cannot ask for jobs here. Jobs are asked for by ${roleNames(who)}.`));
      return false;
    }
    // In the order a person thinks it, with the button straight after the last pick.
    form.append(
      h('h2', { id: 'ask-h' }, 'What is needed?'), kindBox,
      h('div', { class: 'field' }, h('span', { id: 'ask-prio-l', class: 'label' }, 'How urgent'), prioBox),
      h('div', { class: 'field' }, whereLabel, where),
      bedField, toField, detailField,
      send, status,
      h('p', { class: 'meta' }, 'Pick from the lists; nothing is typed, so no personal details go in. Ospeli does not set isolation, infection or diet decisions: the ward decides what it needs.'));
    return true;
  }
  box.append(form, openBox);
  return { el: box, load };
}

// ---------------------------------------------------------------- Cleaning audit (phone)
function auditScreen(ctx, { places, names }) {
  const box = h('div', { class: 'sup-audit' });
  const mayRecord = can(ctx.role, 'ospeli_support_audit_record');
  const marks = new Map(); // item id -> 'pass' | 'fail'; left out = not checked
  const pick = { risk: null, askRest: false };
  const props = proposalsCard(ctx, { match: (p) => p.command === 'ospeli_support_audit_record', describe: (p) => describeProposal(p, null, names) });
  const where = placeSelect('aud-where', places, { blank: 'Choose the area' });
  const status = h('div', { role: 'status', 'data-test': 'aud-result' });
  let data = null;
  let busy = false;

  where.addEventListener('change', () => {
    const last = data?.audits.areas.find((a) => a.locationId === where.value);
    if (last) pick.risk = last.riskCategory; // the type it was audited as last time
    drawForm();
  });

  const form = h('form', { class: 'card sup-form', 'aria-labelledby': 'aud-h', 'data-test': 'aud-form' });
  const riskBox = h('div', { class: 'sup-choices', role: 'group', 'aria-labelledby': 'aud-risk-l' });
  const elBox = h('ul', { class: 'sup-elements' });
  const score = h('p', { class: 'sup-score', 'data-test': 'aud-score' });
  const restBox = h('div', { class: 'sup-rest' });
  const save = h('button', { class: 'btn btn-big', type: 'submit', 'data-cmd': 'ospeli_support_audit_record', 'data-test': 'aud-save' }, 'Save audit');

  function drawForm() {
    const c = data.audits.checklist;
    riskBox.replaceChildren(...c.categories.map((r) => h('button', { class: 'chip-btn sup-choice', type: 'button', 'aria-pressed': String(pick.risk === r.id), 'data-risk': r.id, title: r.examples,
      onclick: () => { pick.risk = r.id; drawForm(); riskBox.querySelector(`[data-risk="${r.id}"]`)?.focus(); } }, r.name)));
    elBox.replaceChildren(...c.elements.map((e) => h('li', { 'data-element': e.id, class: marks.get(e.id) ? `is-${marks.get(e.id)}` : null },
      h('span', { class: 'sup-el-name', id: `el-${e.id}` }, e.name),
      h('span', { class: 'sup-pf', role: 'group', 'aria-labelledby': `el-${e.id}` }, ['pass', 'fail'].map((m) => h('button', {
        class: `sup-mark sup-${m}`, type: 'button', 'aria-pressed': String(marks.get(e.id) === m), 'data-mark': m,
        onclick: () => { if (marks.get(e.id) === m) marks.delete(e.id); else marks.set(e.id, m); drawForm(); elBox.querySelector(`[data-element="${e.id}"] [data-mark="${m}"]`)?.focus(); },
      }, m === 'pass' ? 'Pass' : 'Fail'))))));
    const passed = [...marks.values()].filter((m) => m === 'pass').length;
    score.textContent = marks.size ? `${passed} of ${marks.size} items passed: ${Math.round((100 * passed) / marks.size)}%` : 'Nothing marked yet. Leave out what you did not check.';
    // A shortcut for the items that passed, only after the auditor says every one was checked.
    const left = c.elements.filter((e) => !marks.has(e.id)).length;
    setKids(restBox, !left || !marks.size ? null : pick.askRest
      ? h('div', { class: 'sup-ask-again', 'data-test': 'aud-rest-confirm' }, h('p', {}, h('b', {}, 'Have you checked every one?'), ` ${left} ${left === 1 ? 'item is' : 'items are'} not marked yet.`),
        h('div', { class: 'actions' },
          h('button', { class: 'btn btn-small', type: 'button', 'data-test': 'aud-rest-yes', onclick: () => { for (const e of c.elements) if (!marks.has(e.id)) marks.set(e.id, 'pass'); pick.askRest = false; drawForm(); } }, 'Yes, mark the rest as pass'),
          h('button', { class: 'btn btn-ghost btn-small', type: 'button', onclick: () => { pick.askRest = false; drawForm(); } }, 'No, go back')))
      : h('button', { class: 'btn btn-ghost', type: 'button', 'data-test': 'aud-rest', onclick: () => { pick.askRest = true; drawForm(); restBox.querySelector('[data-test="aud-rest-yes"]')?.focus(); } }, 'Mark the rest as pass'));
  }
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (busy) return;
    const missing = !where.value ? 'the area' : !pick.risk ? 'the type of area' : !marks.size ? 'at least one item' : null;
    if (missing) { setKids(status, h('p', { class: 'sup-status' }, `Choose ${missing} first.`)); return; }
    busy = true; save.disabled = true;
    try {
      const ids = (m) => [...marks].filter(([, v]) => v === m).map(([k]) => k);
      const out = await ctx.run('ospeli_support_audit_record', { locationId: where.value, riskCategory: pick.risk, passed: ids('pass'), failed: ids('fail') });
      setKids(status, h('div', { class: `card sup-result${out.belowPassMark ? ' is-below' : ''}` },
        h('p', {}, h('b', {}, `Saved: ${names.get(where.value)}, ${Math.round(out.score)}%`), ` (${out.passed} of ${out.audited} items passed${out.belowPassMark ? `, under the ${data.audits.checklist.passMarkText} pass mark` : ''}).`),
        out.failed.length ? [h('p', {}, h('b', {}, 'Needs action:')), h('ul', {}, out.failed.map((f) => h('li', {}, f.name)))] : h('p', {}, 'No item failed.')));
      ctx.toast('Audit saved');
      marks.clear();
      await load();
    } catch (err) {
      setKids(status, h('p', { class: 'sup-status' }, `Not saved. ${err.message}`));
    } finally { busy = false; save.disabled = false; }
  });

  const history = h('section', { class: 'section', 'aria-labelledby': 'aud-hist-h' });
  const day = (iso) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  function drawHistory() {
    const { areas, audits } = data.audits;
    setKids(history, h('h2', { id: 'aud-hist-h' }, 'Results by area'),
      h('p', { class: 'meta' }, `Score = items passed / items checked. Pass mark ${data.audits.checklist.passMarkText}.`),
      areas.length ? h('ul', { class: 'sup-areas', 'data-test': 'aud-areas' }, areas.map((a) => {
        const here = audits.filter((x) => x.locationId === a.locationId);
        return h('li', { 'data-area': a.locationId },
          h('details', {}, h('summary', {},
            h('span', { class: 'sup-area-name' }, a.locationName),
            h('span', { class: `chip${a.belowPassMark ? ' sup-below' : ' sup-ok'}` }, `${Math.round(a.last.score)}%`),
            a.failedTwice ? h('span', { class: 'chip sup-below' }, 'Under the pass mark twice') : null,
            h('span', { class: 'meta' }, `${a.riskName} · ${a.audits} audits · last ${day(a.last.at)}`)),
          h('ul', { class: 'sup-audit-list' }, here.slice(0, 5).map((x) => h('li', {},
            h('b', {}, `${day(x.at)}: ${Math.round(x.score)}%`), ` (${x.passed} of ${x.audited})`,
            x.failed.length ? h('span', { class: 'meta' }, ` Needs action: ${x.failed.map((f) => f.name).join('; ')}`) : null)))));
      })) : h('p', { class: 'sup-empty', 'data-test': 'aud-empty' }, 'No cleaning audit has been recorded on this device yet.'));
  }

  const load = async () => {
    data = { audits: await ctx.run('ospeli_support_audits_list', { limit: 200 }) };
    if (mayRecord && !form.childElementCount) {
      form.append(h('h2', { id: 'aud-h' }, 'Record an audit'),
        h('div', { class: 'field' }, h('label', { for: 'aud-where' }, 'Area'), where),
        h('div', { class: 'field' }, h('span', { id: 'aud-risk-l', class: 'label' }, 'Type of area'), riskBox),
        h('div', { class: 'field' }, h('span', { class: 'label' }, 'Each item: tap Pass or Fail'), elBox),
        score, restBox, save, status);
    }
    if (mayRecord) drawForm();
    drawHistory();
    await props.load();
  };
  box.append(
    props.el,
    h('p', { class: 'card meta notice', 'data-test': 'aud-note' }, 'The list of items and the types of area are an example set, set locally, not a standard. Your site uses its own cleanliness standard.'),
    mayRecord ? form : h('p', { class: 'meta', 'data-test': 'read-only' }, `${roleById(ctx.role).name} can see the results. Audits are recorded by the Support services supervisor.`),
    history);
  return { el: box, load };
}
