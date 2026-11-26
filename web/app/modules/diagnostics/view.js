// Diagnostics (area A5): the screens. Every read and write goes through ctx.run, the same commands
// an agent would use, so the page works the same on a site's own server. One page address
// (#/diagnostics); the role decides what shows first:
//   laboratory reception officer (phone or shared tablet at the hatch): specimens on the way, one
//     big "Received" button each, "Reject" on the other side with a picked reason; the count of
//     specimens received today with no collection time under the queue
//   laboratory scientist: the same hatch list, then specimens waiting for their result to be released
//   unit clerk, ward nurse, emergency department nurse in charge: the request tracker for the ward
//     they pick (a filter remembered on this device, not access control), a new request by picks,
//     "Collected" with the time it was taken
//   radiographer: equipment status first (imaging lists are slice 2)
//   diagnostics manager and others: the measures, the guide, equipment status, the day at the hatch
// Operations only: no result value, no choice of test, no clinical priority.
import { h, setKids, fmtWait, moduleStyle, redrawOnChange } from '../ui.js';
import { roleById } from '../../core/model.js';
import { commandByName } from '../../core/commands.js';
import { proposalsCard } from '../proposals.js';
import { laterBox } from '../soon.js';
import { TEST_GROUPS, URGENCIES, URGENCY_LABEL, REJECT_REASONS, REJECT_HEADING, CANCEL_REASONS, AGO_MINUTES, agoText, EXPECTED_HOURS, EQUIPMENT_STATES, LATE_ENTRY_MINUTES } from './logic.js';

const can = (role, cmd) => !!commandByName(cmd)?.roles.includes(role);
const roleNames = (ids) => ids.map((r) => roleById(r)?.name || r).join(', ');
const HATCH = ['lab-reception', 'lab-scientist'];
const WARD = ['unit-clerk', 'ward-nurse', 'ae-nic'];
const UNDO_SECONDS = 10;
const STORE_KEY = 'ospeli-diagnostics-ward';
const remembered = { get() { try { return localStorage.getItem(STORE_KEY) || null; } catch { return null; } }, set(v) { try { if (v) localStorage.setItem(STORE_KEY, v); else localStorage.removeItem(STORE_KEY); } catch { /* still works for this visit */ } } };
const pct = (x) => (x == null ? 'None yet' : `${Math.round(x * 10) / 10}%`);
const mins = (x) => (x == null ? 'None yet' : fmtWait(x));

export async function render(el, ctx) {
  await moduleStyle('diagnostics');
  const role = ctx.role;
  const hatchRole = HATCH.includes(role);
  const wardRole = WARD.includes(role);
  const manager = !hatchRole && !wardRole && role !== 'radiographer';
  const mayReceive = can(role, 'ospeli_diagnostics_specimen_receive');
  const mayResult = can(role, 'ospeli_diagnostics_result_record');
  const mayRequest = can(role, 'ospeli_diagnostics_request_record');
  const mayCollect = can(role, 'ospeli_diagnostics_specimen_collect');
  const mayCancel = can(role, 'ospeli_diagnostics_request_cancel');
  const mayUndo = can(role, 'ospeli_diagnostics_specimen_undo');
  const mayGuide = can(role, 'ospeli_diagnostics_guide_set');

  const root = h('div', { class: 'mod-diagnostics dx', 'data-role': role, 'data-view': manager ? 'manager' : hatchRole ? 'hatch' : wardRole ? 'tracker' : 'equipment' });
  el.append(root);

  // What this person opened or picked survives a redraw (after a save, or another tab's change).
  const ui = { ward: remembered.get(), form: null, picks: {}, open: null, openPicks: {}, eq: null, eqPicks: {}, ghosts: new Map(), done: new Map(), pinned: new Map(), saved: null, msg: null, busy: false, justSaved: false };
  let data = null;
  const props = proposalsCard(ctx, { match: (p) => p.command.startsWith('ospeli_diagnostics_'), describe: (p) => describeProposal(p) });

  // A read that finishes after a newer one was shown is dropped, so stale lists never replace fresh ones.
  let ticket = 0; let shown = 0;
  async function load() {
    const mine = ++ticket;
    // One read of the log per command; a screen asks only for what it shows.
    const ward = wardRole ? ui.ward : null;
    const needReqs = wardRole || (mayRequest && ui.form === 'request');
    const [log, ov, reqs] = await Promise.all([
      wardRole ? null : ctx.run('ospeli_diagnostics_specimen_log', {}),
      ctx.run('ospeli_diagnostics_overview', {}),
      needReqs ? ctx.run('ospeli_diagnostics_requests_list', ward ? { sourceId: ward } : { limit: 1 }) : null,
    ]);
    if (mine < shown) return;
    shown = mine;
    data = { log, ov, reqs, eq: { equipment: ov.equipment, picks: ov.equipmentPicks, faultNote: ov.faultNote, imaging: ov.imaging } };
    if (wardRole && ward && !reqs.picks.sources.some((s) => s.id === ward)) { ui.ward = null; remembered.set(null); }
    draw();
    await props.load();
  }

  async function act(cmd, input, words, after) {
    if (ui.busy) return null;
    ui.busy = true;
    try {
      const out = await ctx.run(cmd, input);
      if (words) ctx.toast(words);
      if (after) after(out);
      // Read again, then draw once (in `finally`): what was saved and the lists it changed appear together (ospeli/ospeli#153).
      ui.justSaved = true;
      return out;
    } catch (err) {
      if (after?.onError) after.onError(err);
      else ui.msg = err.detail?.already ? `Already saved. ${err.message.replace(/^Already saved: /, '')}` : `Not saved. ${err.message}`;
      ui.justSaved = true;
      return null;
    } finally {
      ui.busy = false;
      await load();
    }
  }

  function describeProposal(p) {
    const i = p.input || {};
    const what = {
      ospeli_diagnostics_request_record: () => `Record a ${TEST_GROUPS[i.testGroup]?.toLowerCase() || 'lab'} request (${URGENCIES[i.urgency]?.toLowerCase() || ''})`,
      ospeli_diagnostics_specimen_collect: () => `Mark ${i.requestId?.toUpperCase()} collected`,
      ospeli_diagnostics_specimen_receive: () => (i.outcome === 'rejected' ? `Reject ${i.requestId?.toUpperCase()}: ${REJECT_REASONS[i.reason] || ''}` : `Mark ${i.requestId?.toUpperCase()} received at lab`),
      ospeli_diagnostics_result_record: () => `Record result released for ${i.requestId?.toUpperCase()}`,
      ospeli_diagnostics_request_cancel: () => `Cancel ${i.requestId?.toUpperCase()}: ${CANCEL_REASONS[i.reason] || ''}`,
      ospeli_diagnostics_equipment_set: () => `Mark ${i.assetId} ${EQUIPMENT_STATES[i.state]?.toLowerCase() || ''}`,
    }[p.command];
    return what ? what() : null;
  }

  // ---------------------------------------------------------------- small pieces
  function choices(test, items, value, onPick, labelledBy, multi = false) {
    const on = (v) => (multi ? (value || []).includes(v) : String(value) === String(v));
    return h('div', { class: 'dx-choices', role: 'group', 'data-test': test, ...(labelledBy ? { 'aria-labelledby': labelledBy } : {}) },
      items.map(([v, label, hint]) => h('button', { class: 'chip-btn dx-choice', type: 'button', 'aria-pressed': String(on(v)), 'data-value': v,
        onclick: () => { onPick(v); root.querySelector(`[data-test="${test}"] [data-value="${CSS.escape(String(v))}"]`)?.focus(); } }, label, hint ? h('small', {}, hint) : null)));
  }
  const q = (text, id) => h('p', { class: 'dx-q', id }, text);
  const code = (r) => h('p', { class: 'dx-code', 'data-test': 'code' }, r.codeLead, h('b', {}, r.codeDigits));
  const urgencyChip = (r) => h('span', { class: `chip dx-urg is-${r.urgency}`, title: URGENCY_LABEL }, r.urgency === 'urgent' ? 'Urgent' : 'Routine');
  const head = () => h('div', { class: 'page-head' }, h('div', {},
    h('p', { class: 'eyebrow' }, 'Diagnostics'),
    h('h1', {}, role === 'lab-reception' ? 'Specimens on the way' : role === 'lab-scientist' ? 'Laboratory' : wardRole ? 'Lab requests' : role === 'radiographer' ? 'Equipment status' : 'Diagnostics')));

  function savedCard() {
    if (!ui.saved && !ui.msg) return null;
    return h('div', { tabindex: '-1', class: `card dx-saved${ui.msg && !ui.saved ? ' is-msg' : ''}`, role: 'status', 'data-test': 'saved' },
      ui.saved ? h('p', {}, h('b', {}, ui.saved)) : null, ui.msg ? h('p', { 'data-test': 'msg' }, ui.msg) : null);
  }

  // ---------------------------------------------------------------- the hatch
  // A row keeps its place for a few seconds after Received or Reject, showing what was saved with
  // Undo on the right: the left side is then text, so a second tap there does nothing.
  // The row keeps its height, and Undo sits at its top right: where the finger was (Received, Reject's
  // Save, Result released) is now plain text, so a second tap there does nothing.
  function ghostRow(g) {
    const left = Math.max(0, Math.ceil((g.until - Date.now()) / 1000));
    const undoOk = g.outcome === 'released' ? mayResult : mayUndo;
    const words = g.outcome === 'rejected' ? `Rejected: ${REJECT_REASONS[g.reason]}` : g.outcome === 'released' ? 'Result released' : 'Received at lab';
    const li = h('li', { class: `dx-row is-done${g.outcome === 'rejected' ? ' is-rejected' : ''}`, 'data-request': g.r.id, 'data-test': 'done-row', 'data-outcome': g.outcome },
      h('div', { class: 'dx-done-head' }, code(g.r),
        undoOk ? h('button', { class: 'btn btn-ghost dx-undo', type: 'button', 'data-cmd': 'ospeli_diagnostics_specimen_undo', 'data-test': 'undo', 'aria-label': `Undo: ${words.toLowerCase()}, ${left} seconds left`,
          onclick: () => act('ospeli_diagnostics_specimen_undo', { requestId: g.r.id, reason: 'tapped-by-mistake' }, 'Undone', () => {
            ui.ghosts.delete(g.r.id); ui.done.delete(g.r.id);
            ui.saved = g.outcome === 'released' ? `Undone: the result release for ${g.r.code}. It waits for its result again.` : `Undone: ${g.r.code} is back in the list.`;
          }) }, 'Undo') : null),
      h('p', { class: 'dx-done-what' }, h('b', {}, words), ` ${g.clock}`), g.note ? h('p', { class: 'meta' }, g.note) : null);
    if (g.height) li.style.minHeight = `${g.height}px`;
    return li;
  }
  function hatchRow(r, { afterReceipt = false } = {}) {
    const opened = ui.open === `reject:${r.id}`;
    const facts = [
      h('p', { class: 'dx-facts' }, h('b', {}, r.testGroupName), ` · ${r.sourceName}`),
      h('p', { class: 'dx-facts' }, urgencyChip(r), ' ', r.state === 'collected' ? `Collected ${fmtWait(r.minutesSinceCollection)} ago` : r.state === 'received' ? `Received ${r.clocks.received}, ${fmtWait(r.minutesInStep)} ago` : `Asked for ${fmtWait(r.minutesInStep)} ago, not marked collected`,
        r.enteredLate ? h('span', { class: 'chip dx-late', 'data-test': 'entered-late' }, 'Entered late') : null,
        r.notArrived ? h('span', { class: 'chip dx-hot' }, 'Not arrived') : null),
    ];
    let actions = null;
    if (afterReceipt) {
      actions = mayResult ? h('div', { class: 'dx-row-actions' },
        h('button', { class: 'btn btn-big dx-main', type: 'button', 'data-cmd': 'ospeli_diagnostics_result_record', 'data-test': 'release',
          onclick: () => act('ospeli_diagnostics_result_record', { requestId: r.id }, `Saved: result released for ${r.code}`, (out) => { ghost(r, 'released', null, out.clock); ui.ghosts.get(r.id).note = `${fmtWait(out.turnaroundMinutes)} after receipt.`; }) }, 'Result released'),
        h('button', { class: 'btn btn-ghost dx-reject', type: 'button', 'data-test': 'reject', 'aria-expanded': String(opened), onclick: () => { ui.open = opened ? null : `reject:${r.id}`; ui.openPicks = {}; draw(); } }, 'Reject')) : null;
    } else if (mayReceive) {
      actions = h('div', { class: 'dx-row-actions' },
        h('button', { class: 'btn btn-big dx-main', type: 'button', 'data-cmd': 'ospeli_diagnostics_specimen_receive', 'data-test': 'receive',
          onclick: () => receive(r) }, 'Received'),
        h('button', { class: 'btn btn-ghost dx-reject', type: 'button', 'data-test': 'reject', 'aria-expanded': String(opened), onclick: () => { ui.open = opened ? null : `reject:${r.id}`; ui.openPicks = {}; draw(); } }, 'Reject'));
    }
    return h('li', { class: `dx-row${r.notArrived ? ' is-late' : ''}${r.urgency === 'urgent' ? ' is-urgent' : ''}${opened ? ' is-open' : ''}`, 'data-request': r.id, 'data-test': 'hatch-row' },
      h('div', { class: 'dx-row-main' }, code(r), facts), actions, opened ? rejectPanel(r) : null);
  }
  function rejectPanel(r) {
    const p = ui.openPicks;
    return h('div', { class: 'dx-panel', 'data-test': 'reject-panel' },
      q(`Reject: ${REJECT_HEADING.charAt(0).toLowerCase()}${REJECT_HEADING.slice(1)}`, `rj-${r.id}`),
      choices('reject-reason', Object.entries(REJECT_REASONS), p.reason, (v) => { p.reason = v; draw(); }, `rj-${r.id}`),
      h('p', { class: 'meta' }, 'Ospeli records the reason you pick; your lab\'s criteria decide. A rejected request is final: the ward records a recollection.'),
      h('div', { class: 'dx-panel-actions' },
        h('button', { class: 'btn btn-big dx-save is-coral', type: 'button', 'data-cmd': 'ospeli_diagnostics_specimen_receive', 'data-test': 'reject-save', disabled: !p.reason, 'aria-disabled': String(!p.reason),
          onclick: () => reject(r, p.reason) }, p.reason ? `Save: rejected, ${REJECT_REASONS[p.reason].split(' (')[0].toLowerCase()}` : 'Pick a reason first'),
        h('button', { class: 'btn btn-ghost', type: 'button', 'data-test': 'reject-back', onclick: () => { ui.open = null; draw(); } }, 'Back')));
  }
  function ghost(r, outcome, reason, at) {
    ui.done.set(r.id, Date.now() + 30e3);
    ui.ghosts.set(r.id, { r, outcome, reason, clock: at || '', until: Date.now() + UNDO_SECONDS * 1000, sourceId: r.sourceId, after: r.state === 'received' });
    setTimeout(() => { const g = ui.ghosts.get(r.id); if (g && Date.now() >= g.until) { ui.ghosts.delete(r.id); draw(); } }, UNDO_SECONDS * 1000 + 50);
  }
  async function receive(r) {
    ui.saved = null; ui.msg = null;
    await act('ospeli_diagnostics_specimen_receive', { requestId: r.id, outcome: 'received' }, `Received: ${r.code}`, Object.assign((out) => {
      ghost(r, 'received', null, out.clock);
      if (out.noCollectionTime) ui.ghosts.get(r.id).note = 'No collection time was recorded for it.';
    }, { onError: (err) => { ui.msg = err.detail?.already ? `Already saved: ${r.code} was received. Nothing new was saved.` : `Not saved. ${err.message}`; } }));
  }
  async function reject(r, reason) {
    ui.saved = null; ui.msg = null;
    await act('ospeli_diagnostics_specimen_receive', { requestId: r.id, outcome: 'rejected', reason }, `Rejected: ${r.code}`, Object.assign((out) => {
      ui.open = null; ghost(r, 'rejected', reason, out.clock);
    }, { onError: (err) => { ui.msg = err.detail?.already ? `Already saved: ${r.code} was rejected. Nothing new was saved.` : `Not saved. ${err.message}`; } }));
  }
  // Rows for one list (key: its data-block), with the ghosts of rows just saved kept at their place.
  function withGhosts(items, key, after = false) {
    // A row saved here a moment ago stays out of the list even if a read started before the save
    // answers late (for half a minute; an undo puts it back at once).
    const now = Date.now();
    const rows = items.filter((r) => !(ui.done.get(r.id) > now)).map((r) => hatchRow(r, { afterReceipt: after }));
    const mine = [...ui.ghosts.values()].filter((g) => g.placed === key).sort((a, b) => a.index - b.index);
    for (const g of mine) rows.splice(Math.min(g.index, rows.length), 0, ghostRow(g));
    return rows;
  }
  // Remember where each row sat, so a ghost goes back to the same place.
  function placeGhosts() {
    for (const g of ui.ghosts.values()) {
      if (g.placed) continue;
      const li = root.querySelector(`[data-test="hatch-row"][data-request="${g.r.id}"]`);
      const list = li?.parentElement;
      g.index = list ? [...list.children].indexOf(li) : 0;
      g.placed = list?.dataset.block || 'none';
      g.height = li ? Math.round(li.getBoundingClientRect().height) : 0;
    }
  }
  // Blocks by source, with a block kept while a ghost still sits in it.
  function keepBlocks(blocks, prefix) {
    const out = [...blocks];
    for (const g of ui.ghosts.values()) {
      if (!g.placed?.startsWith(prefix) || g.placed === 'not-arrived' || g.placed === 'waiting') continue;
      const src = g.placed.slice(prefix.length);
      if (!out.some((b) => b.sourceId === src)) out.push({ sourceId: src, sourceName: g.r.sourceName, count: 0, items: [] });
    }
    return out;
  }
  const hasGhost = (key) => [...ui.ghosts.values()].some((g) => g.placed === key);
  function hatch() {
    const log = data.log;
    const blocks = keepBlocks(log.onTheWay, '');
    const na = log.notArrived;
    return h('section', { class: 'section dx-sec', 'aria-labelledby': 'dx-hatch-h', 'data-test': 'hatch' },
      h('h2', { id: 'dx-hatch-h' }, `On the way (${log.counts.onTheWay})`),
      // On the first screen, so a gap in ward recording is seen where it happens (brief A5, screen 2).
      h('p', { class: 'dx-count', 'data-test': 'no-collection-count', 'data-n': String(log.counts.noCollectionToday) },
        h('b', {}, `Received with no collection time: ${log.counts.noCollectionToday} today`), ' (since 00:00 site time)'),
      savedCard(),
      na.length || hasGhost('not-arrived') ? h('div', { class: 'dx-block is-late', 'data-test': 'not-arrived' },
        h('h3', {}, `Not arrived (${na.length}): check where it is`),
        h('ul', { class: 'dx-list', 'data-block': 'not-arrived' }, withGhosts(na, 'not-arrived'))) : null,
      blocks.length ? blocks.map((b) => h('div', { class: 'dx-block', 'data-test': 'block', 'data-source': b.sourceId },
        h('h3', {}, `${b.sourceName} (${b.count})`),
        h('ul', { class: 'dx-list', 'data-block': b.sourceId }, withGhosts(b.items, b.sourceId))))
        : na.length ? null : h('p', { class: 'dx-empty', 'data-test': 'nothing-on-the-way' }, 'Nothing on the way right now.'),
      notCollectedList(),
      mayRequest ? labRequest() : null,
      mayReceive ? null : h('p', { class: 'meta notice', 'data-test': 'read-only' }, `Specimens are marked received or rejected by ${roleNames(commandByName('ospeli_diagnostics_specimen_receive').roles)}.`));
  }
  function notCollectedList() {
    const list = keepBlocks(data.log.notCollected || [], 'nc-');
    const n = list.reduce((s, b) => s + b.count, 0);
    if (!list.length) return null;
    return h('details', { class: 'dx-more', 'data-test': 'not-collected', ...(ui.openNotCollected ? { open: true } : {}), ontoggle: (e) => { ui.openNotCollected = e.target.open; } },
      h('summary', {}, `Asked for, not marked collected (${n})`),
      h('p', { class: 'meta' }, 'A bag can reach the hatch before the ward marks it collected. Receive it here; it is counted as received with no collection time.'),
      list.map((b) => h('div', { class: 'dx-block', 'data-source': b.sourceId }, h('h3', {}, `${b.sourceName} (${b.count})`),
        h('ul', { class: 'dx-list', 'data-block': `nc-${b.sourceId}` }, withGhosts(b.items, `nc-${b.sourceId}`)))));
  }
  function labRequest() {
    if (ui.form !== 'request') {
      return h('button', { class: 'btn btn-ghost dx-link', type: 'button', 'data-test': 'not-on-list', onclick: () => { ui.form = 'request'; ui.picks = {}; load(); } }, 'A specimen not on the list? Record its request');
    }
    return data.reqs ? requestForm() : null;
  }
  function waitingResult() {
    const list = data.log.waitingResult || [];
    return h('section', { class: 'section dx-sec', 'aria-labelledby': 'dx-wait-h', 'data-test': 'waiting-result' },
      h('h2', { id: 'dx-wait-h' }, `Received, result not released yet (${data.log.waitingTotal ?? list.length})`),
      h('p', { class: 'meta' }, data.log.releasedDefinition),
      list.length || hasGhost('waiting') ? h('ul', { class: 'dx-list', 'data-block': 'waiting' }, withGhosts(list, 'waiting', true)) : h('p', { class: 'dx-empty' }, 'Nothing waiting.'));
  }

  // ---------------------------------------------------------------- the request tracker (ward)
  function trackerHead() {
    const sources = data.reqs.picks.sources;
    const sel = h('select', { id: 'dx-ward', 'data-test': 'ward', onchange: (e) => { ui.ward = e.target.value || null; remembered.set(ui.ward); ui.form = null; ui.open = null; load(); } },
      h('option', { value: '' }, 'Pick your ward or area'),
      h('optgroup', { label: 'Wards' }, sources.filter((s) => s.type === 'ward').map((s) => new Option(s.name, s.id, false, s.id === ui.ward))),
      h('optgroup', { label: 'Other areas' }, sources.filter((s) => s.type !== 'ward').map((s) => new Option(s.name, s.id, false, s.id === ui.ward))));
    return h('div', { class: 'card dx-filter' }, h('label', { for: 'dx-ward', class: 'dx-q' }, 'Your ward or area'), sel, h('p', { class: 'meta' }, data.reqs.filterNote));
  }
  function requestForm() {
    const p = ui.picks;
    const pk = data.reqs.picks;
    const src = wardRole ? ui.ward : p.sourceId;
    const patients = wardRole ? pk.patients || [] : [];
    const need = !src ? 'the ward or area' : !p.testGroup ? 'the test group' : !p.urgency ? 'the urgency' : (patients.length && p.encounter === undefined) ? 'the patient (or No patient code)' : null;
    const sel = !wardRole ? h('select', { 'data-test': 'request-source', 'aria-labelledby': 'rq-src', onchange: (e) => { p.sourceId = e.target.value || null; draw(); } },
      h('option', { value: '' }, 'Pick the ward or area'), (pk.sources || []).map((s) => new Option(s.name, s.id, false, s.id === p.sourceId))) : null;
    const f = h('form', { class: 'card dx-form', 'data-test': 'request-form' },
      h('div', { class: 'dx-form-head' }, h('h2', {}, p.recollectionOf ? 'Recollection request' : 'New request'),
        h('button', { class: 'btn btn-ghost', type: 'button', 'data-test': 'form-back', onclick: () => { ui.form = null; ui.picks = {}; draw(); } }, 'Back')),
      sel ? [q('From which ward or area?', 'rq-src'), sel] : null,
      patients.length ? [q('Patient', 'rq-pt'), choices('patient', [['', 'No patient code'], ...patients.map((x) => [x.encounter, x.label, x.bed])], p.encounter === undefined ? '\u0000' : (p.encounter || ''), (v) => { p.encounter = v || null; draw(); }, 'rq-pt')] : null,
      q('Test group', 'rq-tg'), choices('test-group', Object.entries(TEST_GROUPS), p.testGroup, (v) => { p.testGroup = v; draw(); }, 'rq-tg'),
      q(URGENCY_LABEL, 'rq-urg'), choices('urgency', Object.entries(URGENCIES), p.urgency, (v) => { p.urgency = v; draw(); }, 'rq-urg'),
      h('button', { class: 'btn btn-big dx-save', type: 'submit', 'data-cmd': 'ospeli_diagnostics_request_record', 'data-test': 'request-save', disabled: !!need, 'aria-disabled': String(!!need) }, need ? `Pick ${need} first` : 'Save request'),
      h('p', { class: 'meta' }, 'Picks only; nothing is typed. The log keeps your role, never your name.'));
    f.addEventListener('submit', (e) => {
      e.preventDefault();
      if (need) return;
      act('ospeli_diagnostics_request_record', { sourceId: src, testGroup: p.testGroup, urgency: p.urgency, ...(p.encounter ? { encounter: p.encounter } : {}), ...(p.recollectionOf ? { recollectionOf: p.recollectionOf } : {}) },
        'Saved: request', Object.assign((out) => { ui.form = null; ui.picks = {}; ui.saved = `Saved: ${out.code}, ${TEST_GROUPS[p.testGroup]}. Mark it Collected when the specimen is taken.`; },
          { onError: (err) => { ui.msg = err.detail?.already ? 'Already saved: the same request was saved a moment ago. Nothing new was saved.' : `Not saved. ${err.message}`; } }));
    });
    return f;
  }
  function trackerRow(r) {
    const opened = ui.open && ui.open.endsWith(`:${r.id}`) ? ui.open.split(':')[0] : null;
    const p = ui.openPicks;
    const times = [r.clocks?.made ? `Asked ${r.clocks.made}` : null, r.clocks?.collected ? `collected ${r.clocks.collected}` : null, r.clocks?.received ? `received ${r.clocks.received}` : null,
      r.clocks?.rejected ? `rejected ${r.clocks.rejected}` : null, r.clocks?.released ? `released ${r.clocks.released}` : null].filter(Boolean).join(', ');
    let actions = null;
    if (r.state === 'requested' && mayCollect && !opened) {
      actions = h('div', { class: 'dx-row-actions' },
        h('button', { class: 'btn btn-big dx-main', type: 'button', 'data-test': 'collect', onclick: () => { ui.open = `collect:${r.id}`; ui.openPicks = { ago: null }; draw(); } }, 'Collected'),
        mayCancel ? h('button', { class: 'btn btn-ghost dx-reject', type: 'button', 'data-test': 'cancel', onclick: () => { ui.open = `cancel:${r.id}`; ui.openPicks = {}; draw(); } }, 'Cancel') : null);
    } else if (r.state === 'rejected' && !r.recollectedBy && mayRequest && !opened) {
      actions = h('div', { class: 'dx-row-actions' }, h('button', { class: 'btn btn-ghost dx-wide', type: 'button', 'data-test': 'recollect',
        onclick: () => { ui.form = 'request'; ui.picks = { testGroup: r.testGroup, urgency: r.urgency, encounter: r.encounter || null, recollectionOf: r.id }; draw(); root.querySelector('[data-test="request-form"]')?.scrollIntoView?.({ block: 'nearest' }); } }, 'Ask for a recollection'));
    }
    let panel = null;
    if (opened === 'collect') {
      panel = h('div', { class: 'dx-panel', 'data-test': 'collect-panel' }, q('When was it taken?', `ct-${r.id}`),
        choices('collect-ago', AGO_MINUTES.map((m) => [String(m), agoText(m)]), p.ago == null ? '' : String(p.ago), (v) => { p.ago = Number(v); draw(); }, `ct-${r.id}`),
        p.ago > LATE_ENTRY_MINUTES ? h('p', { class: 'meta' }, `More than ${LATE_ENTRY_MINUTES} minutes back: it will show "entered late".`) : null,
        h('div', { class: 'dx-panel-actions' },
          h('button', { class: 'btn btn-big dx-save', type: 'button', 'data-cmd': 'ospeli_diagnostics_specimen_collect', 'data-test': 'collect-save', disabled: p.ago == null, 'aria-disabled': String(p.ago == null),
            onclick: () => act('ospeli_diagnostics_specimen_collect', { requestId: r.id, ...(p.ago ? { minutesAgo: p.ago } : {}) }, `Saved: ${r.code} collected`, (out) => { ui.open = null; ui.saved = null; ui.msg = null; pin(r.id, out.clock); }) },
          p.ago == null ? 'Pick when first' : 'Save: collected'),
          h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => { ui.open = null; draw(); } }, 'Back')));
    } else if (opened === 'cancel') {
      panel = h('div', { class: 'dx-panel', 'data-test': 'cancel-panel' }, q('Why cancel it?', `cn-${r.id}`),
        choices('cancel-reason', Object.entries(CANCEL_REASONS), p.reason, (v) => { p.reason = v; draw(); }, `cn-${r.id}`),
        h('div', { class: 'dx-panel-actions' },
          h('button', { class: 'btn btn-big dx-save is-coral', type: 'button', 'data-cmd': 'ospeli_diagnostics_request_cancel', 'data-test': 'cancel-save', disabled: !p.reason, 'aria-disabled': String(!p.reason),
            onclick: () => act('ospeli_diagnostics_request_cancel', { requestId: r.id, reason: p.reason }, 'Saved: cancelled', () => { ui.open = null; ui.saved = `Saved: ${r.code} cancelled.`; }) }, p.reason ? 'Save: cancel request' : 'Pick a reason first'),
          h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => { ui.open = null; draw(); } }, 'Back')));
    }
    return h('li', { class: `dx-row is-${r.state}${r.notArrived ? ' is-late' : ''}`, 'data-request': r.id, 'data-state': r.state, 'data-test': 'request-row' },
      h('div', { class: 'dx-row-main' }, code(r),
        h('p', { class: 'dx-facts' }, h('b', {}, r.testGroupName), ' ', urgencyChip(r)),
        h('p', { class: 'dx-facts' }, h('span', { class: `chip dx-stage is-${r.state}` }, r.stage), ` ${r.state === 'rejected' ? `${r.stepAt}, ${r.rejectReasonName}${r.rejectedAfterReceipt ? ' (after receipt)' : ''}` : r.state === 'cancelled' ? `${r.stepAt}, ${r.cancelReasonName}` : r.state === 'released' ? r.stepAt : `${fmtWait(r.minutesInStep)} in this step`}`,
          r.notArrived ? h('span', { class: 'chip dx-hot' }, 'Not arrived') : null, r.enteredLate ? h('span', { class: 'chip dx-late' }, 'Entered late') : null,
          r.noCollectionTime ? h('span', { class: 'chip dx-late', 'data-test': 'no-collection' }, 'Collection not recorded') : null),
        r.recollectionOf ? h('p', { class: 'meta', 'data-test': 'recollection-of' }, `Recollection of ${r.recollectionOf.toUpperCase()}`) : null,
        r.recollectedBy ? h('p', { class: 'meta', 'data-test': 'recollected-by' }, `Recollected as ${r.recollectedBy.toUpperCase()}`) : null,
        times ? h('p', { class: 'meta' }, `${times}.`) : null),
      actions, panel);
  }
  // A row just marked collected keeps its place and its height for this visit, greyed, with Undo at
  // its top right: the list does not re-sort under the finger, so a second tap lands on plain text.
  function pin(id, clock) {
    const li = root.querySelector(`[data-test="request-row"][data-request="${id}"]`);
    const list = li?.parentElement;
    ui.pinned.set(id, { clock, index: list ? [...list.children].indexOf(li) : 0, height: li ? Math.round(li.getBoundingClientRect().height) : 0 });
  }
  function withPinned(list) {
    const rows = list.filter((r) => !ui.pinned.has(r.id)).map(trackerRow);
    for (const [id, pn] of [...ui.pinned].sort((a, b) => a[1].index - b[1].index)) {
      const r = list.find((x) => x.id === id);
      if (r) rows.splice(Math.min(pn.index, rows.length), 0, pinnedRow(r, pn));
    }
    return rows;
  }
  function pinnedRow(r, pn) {
    const undo = r.state === 'collected' && r.mayUndoCollect && can(role, 'ospeli_diagnostics_collect_undo');
    const li = h('li', { class: 'dx-row is-done', 'data-request': r.id, 'data-state': r.state, 'data-test': 'pinned-row' },
      h('div', { class: 'dx-done-head' }, code(r),
        undo ? h('button', { class: 'btn btn-ghost dx-undo', type: 'button', 'data-cmd': 'ospeli_diagnostics_collect_undo', 'data-test': 'collect-undo',
          onclick: () => act('ospeli_diagnostics_collect_undo', { requestId: r.id, reason: 'wrong-request' }, 'Undone', () => { ui.pinned.delete(r.id); ui.saved = `Undone: ${r.code} is not collected.`; }) }, 'Undo') : null),
      // Until the list is read again the row still says "Not collected": show what was saved.
      h('p', { class: 'dx-done-what' }, h('b', {}, r.state === 'collected' ? `Collected ${r.clocks.collected}` : r.state === 'requested' ? `Collected ${pn.clock || ''}` : r.stage), ` · ${r.testGroupName}`));
    if (pn.height) li.style.minHeight = `${pn.height}px`;
    return li;
  }
  function tracker() {
    const r = data.reqs;
    const ward = ui.ward;
    const notices = (data.ov.guide.on ? data.ov.guide.suggestions : []).filter((s) => ward && s.sourceId === ward && s.rule !== 'rejection-review');
    return h('section', { class: 'section dx-sec', 'aria-labelledby': 'dx-trk-h', 'data-test': 'tracker' },
      h('h2', { id: 'dx-trk-h', class: 'sr-only' }, 'Request tracker'),
      trackerHead(),
      savedCard(),
      notices.length ? h('ul', { class: 'dx-notices', 'data-test': 'ward-notices' }, notices.map((s) => h('li', { 'data-rule': s.rule, 'data-test': 'ward-notice' }, h('p', {}, h('b', {}, s.text)), h('p', { class: 'meta' }, s.why)))) : null,
      !ward ? h('p', { class: 'dx-empty', 'data-test': 'pick-ward' }, 'Pick your ward or area to see its requests.') : [
        mayRequest ? (ui.form === 'request' ? requestForm() : h('button', { class: 'btn btn-big dx-main dx-new', type: 'button', 'data-test': 'new-request', onclick: () => { ui.form = 'request'; ui.picks = {}; ui.saved = null; ui.msg = null; draw(); root.querySelector('[data-test="request-form"] button')?.focus(); } }, 'New request')) : null,
        h('h3', {}, `${r.sourceName}: ${r.total} ${r.total === 1 ? 'request' : 'requests'} open or in the last ${r.hours} hours`),
        r.requests.length ? h('ul', { class: 'dx-list', 'data-test': 'requests' }, withPinned(r.requests)) : h('p', { class: 'dx-empty' }, 'No request open or in the last day.'),
        h('p', { class: 'meta' }, r.releasedDefinition),
      ],
      mayRequest ? null : h('p', { class: 'meta notice', 'data-test': 'read-only' }, `Requests are recorded by ${roleNames(commandByName('ospeli_diagnostics_request_record').roles)}.`));
  }

  // ---------------------------------------------------------------- equipment status
  function eqCard(x) {
    const k = data.eq.picks[x.kind];
    const mine = can(role, 'ospeli_diagnostics_equipment_set') && x.roles.includes(role);
    const opened = ui.eq === x.assetId;
    const down = x.state !== 'up';
    return h('li', { class: `dx-eq is-${x.state}`, 'data-asset': x.assetId, 'data-state': x.state, 'data-test': 'equipment' },
      h('p', { class: 'dx-what' }, h('b', {}, x.name), h('span', { class: `chip dx-eqst is-${x.state}` }, x.stateName)),
      h('p', { class: 'meta' }, x.placeName, down ? `. Since ${x.sinceText}. ${x.reasonName || ''}.` : x.sinceText ? `. Back since ${x.sinceText}.` : '.'),
      x.testGroupsOff.length ? h('p', {}, `Cannot run now: ${x.testGroupsOff.map((g) => g.name).join(', ')}.`) : null,
      down ? h('p', { class: 'dx-backup', 'data-test': 'backup' }, x.backupText) : null,
      x.expectedBackText ? h('p', { class: 'meta', 'data-test': 'expected' }, x.expectedBackText) : null,
      x.workOrder ? h('p', { 'data-test': 'linked-wo' }, `Work order ${x.workOrder.id.toUpperCase()}: ${x.workOrder.title} (${x.workOrder.stateName}).`) : null,
      x.openWorkOrders.length && !x.workOrder ? h('p', { class: 'meta', 'data-test': 'open-wo' }, `Open work order: ${x.openWorkOrders.map((w) => `${w.id.toUpperCase()} ${w.title} (${w.stateName})`).join('; ')}.`) : null,
      x.runs.length ? h('p', { class: 'meta' }, `Runs: ${x.runs.map((g) => g.name).join(', ')} (example list, set by the site).`) : null,
      mine && !opened ? h('button', { class: `btn ${down ? 'btn-ghost' : 'btn-ghost'} dx-wide`, type: 'button', 'data-test': down ? 'mark-up' : 'mark-down',
        onclick: () => { ui.eq = x.assetId; ui.eqPicks = down ? { state: 'up' } : { state: null, groups: [] }; ui.saved = null; ui.msg = null; draw(); } }, down ? 'Mark back working' : 'Mark down') : null,
      opened ? eqForm(x, k) : null);
  }
  function eqForm(x, k) {
    const p = ui.eqPicks;
    const back = h('button', { class: 'btn btn-ghost', type: 'button', 'data-test': 'eq-back', onclick: () => { ui.eq = null; draw(); } }, 'Back');
    if (p.state === 'up') {
      return h('div', { class: 'dx-panel', 'data-test': 'eq-form' }, h('p', {}, `Mark ${x.name} back working?`),
        h('div', { class: 'dx-panel-actions' }, h('button', { class: 'btn btn-big dx-save', type: 'button', 'data-cmd': 'ospeli_diagnostics_equipment_set', 'data-test': 'eq-save',
          onclick: () => act('ospeli_diagnostics_equipment_set', { assetId: x.assetId, state: 'up' }, 'Saved: back working', () => { ui.eq = null; ui.saved = `Saved: ${x.name} is back working.`; }) }, 'Save: back working'), back));
    }
    const groupsNeeded = p.state === 'partly-down' && x.runs.length;
    const need = !p.state ? 'down or partly down' : !p.reason ? 'the reason' : groupsNeeded && !(p.groups.length && p.groups.length < x.runs.length) ? 'what it cannot run' : !p.backup ? 'the backup route' : (x.openWorkOrders.length && p.wo === undefined) ? 'the work order (or None)' : null;
    return h('div', { class: 'dx-panel', 'data-test': 'eq-form' },
      q('Is it down, or partly down?', `eq-st-${x.assetId}`), choices('eq-state', [['down', 'Down'], ['partly-down', 'Partly down', x.runs.length ? 'Some test groups off' : 'For example one room or protocol']], p.state, (v) => { p.state = v; draw(); }, `eq-st-${x.assetId}`),
      groupsNeeded ? [q('Which cannot run now?', `eq-g-${x.assetId}`), choices('eq-groups', x.runs.map((g) => [g.id, g.name]), p.groups, (v) => { p.groups = p.groups.includes(v) ? p.groups.filter((y) => y !== v) : [...p.groups, v]; draw(); }, `eq-g-${x.assetId}`, true)] : null,
      q('Reason', `eq-r-${x.assetId}`), choices('eq-reason', Object.entries(k.reasons), p.reason, (v) => { p.reason = v; draw(); }, `eq-r-${x.assetId}`),
      q('Backup route', `eq-b-${x.assetId}`), choices('eq-backup', Object.entries(k.backups), p.backup, (v) => { p.backup = v; draw(); }, `eq-b-${x.assetId}`),
      x.openWorkOrders.length ? [q('Link the open work order', `eq-w-${x.assetId}`), choices('eq-wo', [...x.openWorkOrders.map((w) => [w.id, `${w.id.toUpperCase()}: ${w.title}`, w.stateName]), ['', 'None']], p.wo === undefined ? '\u0000' : (p.wo || ''), (v) => { p.wo = v || null; draw(); }, `eq-w-${x.assetId}`)]
        : h('p', { class: 'meta', 'data-test': 'no-open-wo' }, `No open work order for it. ${data.eq.faultNote}`),
      q('Expected back (an estimate, optional)', `eq-e-${x.assetId}`), choices('eq-expected', [['', 'Not known'], ...EXPECTED_HOURS.map((n) => [String(n), n === 1 ? 'About 1 hour' : `About ${n} hours`])], p.hours == null ? '' : String(p.hours), (v) => { p.hours = v ? Number(v) : null; draw(); }, `eq-e-${x.assetId}`),
      h('div', { class: 'dx-panel-actions' }, h('button', { class: 'btn btn-big dx-save is-coral', type: 'button', 'data-cmd': 'ospeli_diagnostics_equipment_set', 'data-test': 'eq-save', disabled: !!need, 'aria-disabled': String(!!need),
        onclick: () => act('ospeli_diagnostics_equipment_set', { assetId: x.assetId, state: p.state, reason: p.reason, backup: p.backup, ...(groupsNeeded ? { testGroups: p.groups } : {}), ...(p.wo ? { workOrderId: p.wo } : {}), ...(p.hours ? { expectedBackHours: p.hours } : {}) },
          `Saved: ${x.name} ${EQUIPMENT_STATES[p.state].toLowerCase()}`, () => { ui.eq = null; ui.saved = `Saved: ${x.name} marked ${EQUIPMENT_STATES[p.state].toLowerCase()}. Every ward sees it.`; }) }, need ? `Pick ${need} first` : `Save: ${EQUIPMENT_STATES[p.state].toLowerCase()}`), back));
  }
  function equipment() {
    const list = data.eq.equipment;
    const anyRights = can(role, 'ospeli_diagnostics_equipment_set');
    return h('section', { class: 'section dx-sec', 'aria-labelledby': 'dx-eq-h', 'data-test': 'equipment-status' },
      h('h2', { id: 'dx-eq-h' }, 'Equipment status'),
      role === 'radiographer' || manager ? savedCard() : null,
      list.length ? h('ul', { class: 'dx-list' }, list.map(eqCard)) : h('p', { class: 'dx-empty' }, 'No analyser or scanner on this site yet.'),
      h('p', { class: 'meta', 'data-test': 'fault-note' }, data.eq.faultNote),
      anyRights ? null : h('p', { class: 'meta', 'data-test': 'eq-read-only' }, `Analysers are marked down and back by ${roleNames(['lab-scientist', 'diagnostics-manager'])}; scanners by ${roleNames(['radiographer', 'diagnostics-manager'])}.`));
  }

  // ---------------------------------------------------------------- the manager's pieces
  function summary() {
    const c = data.ov.counts;
    const [, rej] = data.ov.kpis;
    return h('div', { class: 'dx-stats', 'data-test': 'summary' },
      // No turnaround tile: one figure over every test group misleads; the measures lead with each group.
      h('div', { class: 'dx-stat', 'data-test': 'waiting-count' }, h('b', {}, String(c.waitingResult)), h('span', {}, 'Received, result not released yet')),
      h('div', { class: 'dx-stat', 'data-kpi': rej.id }, h('b', {}, pct(rej.value)), h('span', {}, `Rejected, last ${data.ov.period.days} days (${rej.numerator} of ${rej.denominator} specimens)`)),
      h('div', { class: `dx-stat${c.equipmentDown ? ' is-hot' : ''}`, 'data-test': 'down-count' }, h('b', {}, String(c.equipmentDown)), h('span', {}, c.equipmentDown === 1 ? 'Analyser or scanner down' : 'Analysers or scanners down')),
      h('div', { class: 'dx-stat' }, h('b', {}, String(c.onTheWay)), h('span', {}, 'Specimens on the way')),
      null);
  }
  function guideCard() {
    const g = data.ov.guide;
    return h('section', { class: 'card dx-guide', 'data-test': 'guide', 'data-on': String(g.on), 'aria-labelledby': 'dx-guide-h' },
      h('div', { class: 'dx-guide-head' }, h('h2', { id: 'dx-guide-h' }, 'Guide'),
        mayGuide ? h('button', { class: 'btn btn-ghost btn-small', type: 'button', 'aria-pressed': String(g.on), 'data-cmd': 'ospeli_diagnostics_guide_set', 'data-test': 'guide-switch',
          onclick: () => act('ospeli_diagnostics_guide_set', { on: !g.on }, `Guide ${g.on ? 'off' : 'on'}`) }, g.on ? 'Guide on: switch off' : 'Guide off: switch on') : null),
      g.on ? [
        h('p', { class: 'meta' }, 'Fixed rules, not AI. They suggest; you decide. Nothing changes until a person acts.'),
        g.suggestions.length ? h('ul', { class: 'dx-sugg' }, g.suggestions.map((s) => h('li', { 'data-rule': s.rule, 'data-test': 'suggestion', ...(s.sourceId ? { 'data-source': s.sourceId } : {}) },
          h('p', {}, h('b', {}, s.text)), h('p', { class: 'meta' }, s.why),
          h('details', { class: 'dx-def' }, h('summary', {}, 'Why this rule'), h('p', {}, s.basis))))) : h('p', { 'data-test': 'no-suggestion' }, 'Nothing to suggest right now.'),
      ] : h('p', { 'data-test': 'guide-off' }, 'The guide is off. The lists, the equipment status and the measures work the same.'),
      mayGuide ? null : h('p', { class: 'meta' }, 'The diagnostics manager can switch the guide on or off.'));
  }
  const def = (k) => h('details', { class: 'dx-def' }, h('summary', {}, 'How it is counted'),
    h('p', {}, k.definition), h('p', {}, `Counts: ${k.counts}`), h('p', {}, `Out of: ${k.outOf}`), h('p', {}, `Leaves out: ${k.leavesOut}`), h('p', {}, `Source: ${k.source}`), h('p', {}, `Target: ${k.targetText}`));
  function measures() {
    const [tat, rej, av] = data.ov.kpis;
    const comp = data.ov.completeness;
    const days = data.ov.period.days;
    return h('section', { class: 'section dx-sec', 'aria-labelledby': 'dx-kpi-h', 'data-test': 'measures' },
      h('h2', { id: 'dx-kpi-h' }, `Measures, last ${days} days`),
      h('p', { class: 'meta' }, 'Calculated from the log on this device. They count requests and steps, never a person.'),
      h('div', { class: 'dx-kpis' },
        h('div', { class: 'card dx-kpi', 'data-kpi': tat.id, 'data-n': String(tat.n) },
          h('p', { class: 'dx-kpi-name' }, `${tat.name}, by test group`),
          h('p', { class: 'meta' }, 'From received at lab to result released. Urgent and routine apart (urgency as set by the requester). Middle time (median); "9 in 10 within" is the 90th percentile.'),
          tat.byGroup.length ? h('ul', { class: 'dx-tat', 'data-test': 'tat-by-group' }, tat.byGroup.map((g) => h('li', { 'data-group': g.testGroup },
            h('p', { class: 'dx-tat-name' }, g.name, g.note ? h('span', { class: 'meta' }, ` (${g.note})`) : null),
            ['urgent', 'routine'].map((u) => h('p', { 'data-urgency': u }, h('b', {}, `${u === 'urgent' ? 'Urgent' : 'Routine'}: `),
              g[u].n ? `${mins(g[u].median)}; 9 in 10 within ${mins(g[u].p90)} (${g[u].n} ${g[u].n === 1 ? 'result' : 'results'})` : 'no results'))))) : h('p', { class: 'dx-empty' }, 'No result released in the period.'),
          tat.blended?.n ? h('p', { class: 'meta', 'data-test': 'tat-blended' }, `${tat.blended.label} Middle time ${mins(tat.blended.median)} (${tat.blended.n} results).`) : null,
          def(tat)),
        h('div', { class: 'card dx-kpi', 'data-kpi': rej.id, 'data-value': rej.value == null ? '' : String(rej.value), 'data-n': `${rej.numerator}/${rej.denominator}` },
          h('p', { class: 'dx-kpi-name' }, rej.name),
          h('p', { class: 'dx-kpi-value' }, pct(rej.value)),
          h('p', { class: 'meta' }, `${rej.numerator} rejected of ${rej.denominator} specimens that reached the lab (received plus rejected).`),
          rej.byArea.length ? [h('p', { class: 'dx-sub' }, 'By area'), h('ul', { class: 'dx-rows', 'data-test': 'rej-by-area' }, rej.byArea.map((a) => h('li', { 'data-source': a.sourceId },
            h('b', {}, a.name), `: ${a.rejected} of ${a.reached}${a.value == null ? ' (too few for a percentage)' : `, ${pct(a.value)}`}`)))] : null,
          rej.byReason.length ? [h('p', { class: 'dx-sub' }, 'By reason'), h('ul', { class: 'dx-rows', 'data-test': 'rej-by-reason' }, rej.byReason.map((x) => h('li', { 'data-reason': x.reason }, `${x.name}: ${x.count}`)))] : null,
          h('p', { class: 'meta' }, `"Other": ${rej.other}. If it grows, the reason list needs changing.`),
          def(rej)),
        h('div', { class: 'card dx-kpi', 'data-kpi': av.id, 'data-value': av.value == null ? '' : String(av.value) },
          h('p', { class: 'dx-kpi-name' }, av.name),
          h('ul', { class: 'dx-rows', 'data-test': 'availability' }, av.byAsset.map((a) => h('li', { 'data-asset': a.assetId },
            h('b', {}, a.name), `: ${pct(a.value)} in service; down ${a.downHours} h of ${a.denominator} h scheduled (${pct(a.downtimePct)})${a.partHours ? `; partly down ${a.partHours} h` : ''}`))),
          def(av)),
        h('div', { class: 'card dx-kpi', 'data-test': 'completeness', 'data-value': comp.value == null ? '' : String(comp.value) },
          h('p', { class: 'dx-kpi-name' }, 'Data completeness'),
          h('p', { class: 'dx-kpi-value' }, pct(comp.value)),
          h('p', { class: 'meta' }, `${comp.numerator} of ${comp.denominator} finished requests have every step timed. Received with no collection time: ${comp.missing.noCollection}. Collections entered late: ${comp.missing.enteredLate}.`),
          comp.byArea.length ? h('ul', { class: 'dx-rows' }, comp.byArea.slice(0, 8).map((a) => h('li', { 'data-source': a.sourceId }, h('b', {}, a.name), `: ${pct(a.value)} (${a.numerator} of ${a.denominator}); no collection time ${a.noCollection}`))) : null,
          h('details', { class: 'dx-def' }, h('summary', {}, 'How it is counted'), h('p', {}, comp.definition), h('p', {}, `Required steps: ${comp.requiredSteps.join('; ')}.`), h('p', {}, 'Source: local definition (KPI dictionary D-21).')))));
  }
  function dayAtHatch() {
    const log = data.log;
    return h('section', { class: 'section dx-sec', 'aria-labelledby': 'dx-day-h', 'data-test': 'day' },
      h('h2', { id: 'dx-day-h' }, 'Today at the lab hatch'),
      h('p', {}, `${log.counts.receivedToday} received and ${log.counts.rejectedToday} rejected today (since 00:00 site time). ${log.counts.onTheWay} on the way, ${log.counts.notArrived} not arrived. Received with no collection time: ${log.counts.noCollectionToday}.`),
      log.byHour?.length ? [h('p', { class: 'dx-sub' }, 'By hour'), h('ul', { class: 'dx-hours', 'data-test': 'by-hour' }, log.byHour.map((x) => h('li', {}, h('b', {}, `${String(x.hour).padStart(2, '0')}:00`), ` ${x.received} received${x.rejected ? `, ${x.rejected} rejected` : ''}`)))] : null,
      log.bySource?.length ? [h('p', { class: 'dx-sub' }, 'By source'), h('ul', { class: 'dx-rows', 'data-test': 'by-source' }, log.bySource.map((x) => h('li', {}, h('b', {}, x.sourceName), `: ${x.received} received${x.rejected ? `, ${x.rejected} rejected` : ''}`)))] : null);
  }
  // The page's planned parts sit together, closed, under one "Coming later (n)" (design audit 25 Nov):
  // the imaging list (every view shows equipment) and, where the measures show, the planned measures.
  const comingLater = (withMeasures) => laterBox([
    { text: data.eq.imaging, attrs: { 'data-test': 'imaging-planned' } },
    ...(withMeasures ? data.ov.planned.map((x) => ({ text: `${x.name}: ${x.note.replace(/^Planned, not built yet:\s*/, 'planned, not built yet; ')}`, attrs: { 'data-kpi': x.id } })) : []),
  ]);
  const footer = (withMeasures = false) => [comingLater(withMeasures), h('p', { class: 'meta dx-note' }, data.ov.note)];
  const readOnlyLine = () => h('p', { class: 'card meta notice', 'data-test': 'read-only' }, `${roleById(role)?.name || role} can see this page. Requests are recorded by ${roleNames(['unit-clerk', 'ward-nurse', 'ae-nic'])}; specimens are received at the lab by ${roleNames(['lab-reception', 'lab-scientist'])}; equipment is marked down and back by ${roleNames(['lab-scientist', 'radiographer', 'diagnostics-manager'])}.`);

  // ---------------------------------------------------------------- the page
  function draw() {
    if (!data) return;
    const focusKey = document.activeElement && root.contains(document.activeElement) ? document.activeElement.dataset?.value : null;
    placeGhosts();
    if (hatchRole) {
      setKids(root, head(), props.el, hatch(), role === 'lab-scientist' ? waitingResult() : null, equipment(), role === 'lab-scientist' ? guideCard() : null, footer());
    } else if (wardRole) {
      setKids(root, head(), props.el, tracker(), equipment(), footer());
    } else if (role === 'radiographer') {
      setKids(root, head(), props.el, equipment(), dayAtHatch(), footer());
    } else {
      const rights = mayGuide || can(role, 'ospeli_diagnostics_equipment_set') || mayCancel;
      setKids(root, head(), props.el, summary(), guideCard(), equipment(), measures(), dayAtHatch(), rights ? null : readOnlyLine(), footer(true));
    }
    if (ui.justSaved) {
      ui.justSaved = false;
      const sv = root.querySelector('[data-test="saved"]');
      sv?.scrollIntoView?.({ block: 'nearest' });
      sv?.focus({ preventScroll: true });
    } else if (focusKey) root.querySelector(`[aria-pressed="true"][data-value="${CSS.escape(focusKey)}"]`)?.focus();
  }

  await load();
  const off = redrawOnChange(ctx, () => load());
  const tick = setInterval(() => load(), 60e3); // keep the minutes fresh
  return () => { off(); clearInterval(tick); };
}
