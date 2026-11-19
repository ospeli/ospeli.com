// Facilities and utilities: the screens. Every read and write goes through ctx.run, the same
// commands an agent would use, so the page works the same on a site's own server.
// One page address (#/facilities); the role decides what shows first:
//   facilities technician and assistant (phone): open outages with one big "Outage ended" button,
//     then six big tiles to log a check or an outage, picks only, saved in a few taps
//   facilities manager, operations manager and others: what needs attention first (missed checks,
//     open outages), the guide, this week's checks, outage hours, measures, the faults card, levels
// Building and plant faults are Engineering's work orders: this page shows the next one only and
// links there. Not a building management or control system: it switches nothing.
import { h, setKids, fmtWait, moduleStyle } from '../ui.js';
import { roleById } from '../../core/model.js';
import { commandByName } from '../../core/commands.js';
import { proposalsCard } from '../proposals.js';
import { CHECK_KINDS, RESULTS, RUN_MINUTES, LEVELS, GAS_BANDS, UTILITIES, CAUSES, AGO_MINUTES, LEVEL_PICKS, runText, agoText } from './logic.js';

const can = (role, cmd) => !!commandByName(cmd)?.roles.includes(role);
const roleNames = (ids) => ids.map((r) => roleById(r)?.name || r).join(', ');
const FRONT_LINE = ['estates-tech', 'facilities-assistant'];
const GAS_FIRST = 'Follow your site\'s medical gas procedure first. This records the check; it does not say a supply is safe for patients.';
const TILES = [
  ['generator-test', 'Generator test'], ['fuel-level', 'Fuel level'], ['water-level', 'Water storage'], ['gas-check', 'Medical gas check'],
  ['outage-start', 'Outage started'], ['outage-end', 'Outage ended'],
];
const PRIORITIES = [['urgent', 'Urgent', 'Unsafe, or stops care now'], ['high', 'High', 'Needed today'], ['routine', 'Routine', 'Can wait for the planned round']];
const STATUS_WORDS = { overdue: 'Missed', due: 'Due', done: 'Done' };
const hoursText = (x) => (x == null ? 'None' : `${Math.round(x * 10) / 10} h`);
const pctText = (x) => (x == null ? 'Nothing due yet' : `${Math.round(x)}%`);

export async function render(el, ctx) {
  await moduleStyle('facilities');
  const role = ctx.role;
  const manager = !FRONT_LINE.includes(role);
  const mayCheck = Object.entries(CHECK_KINDS).filter(([, k]) => k.roles.includes(role)).map(([id]) => id);
  const mayOutage = can(role, 'ospeli_facilities_outage_start');
  const mayFault = can(role, 'ospeli_workorders_report_fault');
  const mayLevels = can(role, 'ospeli_facilities_levels_set');
  const mayGuide = can(role, 'ospeli_facilities_guide_set');
  const logs = mayCheck.length > 0 || mayOutage;

  const root = h('div', { class: 'mod-facilities fac', 'data-role': role, 'data-view': manager ? 'manager' : 'front-line' });
  el.append(root);

  // What this person opened or picked survives a redraw (after a save, or another tab's change).
  const ui = { form: null, picks: {}, saved: null, fault: null, ending: null, endPicks: {}, levels: {}, busy: false, msg: null };
  let data = null;
  const props = proposalsCard(ctx, { match: (p) => p.command.startsWith('ospeli_facilities_'), describe: (p) => describeProposal(p, data) });

  const load = async () => {
    const [ov, log, next] = await Promise.all([
      ctx.run('ospeli_facilities_overview', {}),
      ctx.run('ospeli_facilities_log_list', { limit: 8 }),
      ctx.run('ospeli_workorders_next', { team: 'estates' }).catch(() => null),
    ]);
    data = { ov, log, next, names: nameMap(ov) };
    draw();
    await props.load();
  };

  async function act(cmd, input, words, after) {
    if (ui.busy) return null;
    ui.busy = true;
    try {
      const out = await ctx.run(cmd, input);
      if (words) ctx.toast(words);
      if (after) after(out);
      return out;
    } catch (err) {
      if (after?.onError) after.onError(err); else { ui.msg = `Not saved. ${err.message}`; ctx.toast(ui.msg); }
      return null;
    } finally {
      ui.busy = false;
      await load();
    }
  }

  // ---------------------------------------------------------------- pieces
  const head = () => h('div', { class: 'page-head' }, h('div', {},
    h('p', { class: 'eyebrow' }, 'Facilities and utilities'),
    h('h1', {}, manager ? 'Facilities and utilities' : 'Utilities log')),
  role === 'estates-tech' ? h('a', { class: 'btn btn-ghost fac-link', href: '#/engineering', 'data-test': 'to-engineering' }, 'Work orders: Engineering page') : null);

  function outageRow(o) {
    const mine = ui.ending === o.id;
    const gas = o.utility === 'medical-gases' || o.utility === 'medical-air-vacuum';
    return h('li', { class: `fac-outage${mine ? ' is-open' : ''}`, 'data-outage': o.id, 'data-test': 'open-outage' },
      h('p', { class: 'fac-what' }, h('b', {}, `${o.utilityName} outage`), h('span', { class: 'chip fac-hot' }, 'Still open')),
      h('p', {}, o.placeName),
      h('p', { class: 'meta' }, `Since ${o.startedText} (${fmtWait(o.minutes)}). Cause: ${o.causeName}.`),
      gas ? h('p', { class: 'fac-gas' }, GAS_FIRST) : null,
      mayOutage ? (mine ? endPanel(o) : h('button', { class: 'btn btn-big fac-main', type: 'button', 'data-test': 'outage-end', 'data-outage': o.id,
        onclick: () => { ui.ending = o.id; ui.endPicks = { cause: null, ago: 0 }; draw(); root.querySelector('[data-test="end-cause"] button')?.focus(); } }, 'Outage ended')) : null);
  }
  function endPanel(o) {
    const p = ui.endPicks;
    return h('div', { class: 'fac-end', 'data-test': 'end-panel' },
      h('p', { class: 'fac-q', id: `end-c-${o.id}` }, 'What caused it? (you can keep the one recorded)'),
      choices('end-cause', Object.entries(CAUSES), p.cause ?? o.cause, (v) => { p.cause = v; draw(); }, `end-c-${o.id}`),
      h('details', { class: 'fac-ago' }, h('summary', {}, p.ago ? `Came back ${agoText(p.ago).toLowerCase()}` : 'Came back earlier?'),
        choices('end-ago', AGO_MINUTES.map((m) => [String(m), agoText(m)]), String(p.ago), (v) => { p.ago = Number(v); draw(); })),
      h('div', { class: 'actions' },
        h('button', { class: 'btn btn-big fac-save', type: 'button', 'data-cmd': 'ospeli_facilities_outage_end', 'data-test': 'end-save',
          onclick: () => act('ospeli_facilities_outage_end', { outageId: o.id, ...(p.cause && p.cause !== o.cause ? { cause: p.cause } : {}), ...(p.ago ? { endedMinutesAgo: p.ago } : {}) },
            `Saved: ${o.utilityName.toLowerCase()} supply back`, () => { ui.ending = null; ui.saved = { text: `Saved: ${o.utilityName} outage ended, ${o.placeName}.` }; }) }, 'Save: supply is back'),
        h('button', { class: 'btn btn-ghost', type: 'button', 'data-test': 'end-cancel', onclick: () => { ui.ending = null; draw(); } }, 'Not yet')));
  }
  const openOutages = (list) => (list.length ? h('section', { class: 'section fac-sec', 'aria-labelledby': 'fac-out-h' },
    h('h2', { id: 'fac-out-h' }, `Open outages (${list.length})`), h('ul', { class: 'fac-list' }, list.map(outageRow))) : null);

  // A row of pick buttons. value: the picked id (or null); onPick(id).
  function choices(test, items, value, onPick, labelledBy) {
    return h('div', { class: 'fac-choices', role: 'group', 'data-test': test, ...(labelledBy ? { 'aria-labelledby': labelledBy } : {}) },
      items.map(([v, label, hint]) => h('button', { class: 'chip-btn fac-choice', type: 'button', 'aria-pressed': String(String(value) === String(v)), 'data-value': v,
        onclick: () => { onPick(v); root.querySelector(`[data-test="${test}"] [data-value="${v}"]`)?.focus(); } }, label, hint ? h('small', {}, hint) : null)));
  }

  // ---------------------------------------------------------------- the log: tiles and forms
  function tiles() {
    const shown = TILES.filter(([id]) => (id.startsWith('outage') ? mayOutage : mayCheck.includes(id)));
    return h('div', { class: 'fac-tiles', role: 'group', 'aria-label': 'What are you logging?', 'data-test': 'tiles' }, shown.map(([id, label]) => h('button', {
      class: 'fac-tile', type: 'button', 'data-tile': id, onclick: () => {
        ui.saved = null; ui.fault = null; ui.msg = null;
        if (id === 'outage-end') {
          const open = data.ov.attention.openOutages;
          if (open.length === 1) { ui.ending = open[0].id; ui.endPicks = { cause: null, ago: 0 }; }
          ui.form = open.length ? null : 'none-open';
          draw();
          root.querySelector('[data-test="open-outage"] button, [data-test="none-open"]')?.focus();
          return;
        }
        ui.form = id; ui.picks = {};
        const ch = data.ov.choices;
        const only = id === 'outage-start' ? null : (CHECK_KINDS[id].target === 'asset' ? ch.assets[id] : ch.places[id]);
        if (only?.length === 1) ui.picks.target = only[0].id; // the only one there is: nothing to choose
        draw();
        const f = root.querySelector('[data-test="form"]');
        f?.scrollIntoView?.({ block: 'nearest' });
        f?.querySelector('button, select')?.focus();
      } }, h('span', { class: 'fac-tile-label' }, label))));
  }

  // What the form still needs, in order, or null when it can be saved.
  function missing() {
    const p = ui.picks;
    if (ui.form === 'outage-start') return !p.utility ? 'the utility' : !p.placeId ? 'the place' : !p.cause ? 'the cause' : null;
    const k = CHECK_KINDS[ui.form];
    if (!p.target) return k.target === 'asset' ? 'the generator' : 'the place';
    for (const f of k.needs) if (p[f] == null) return { result: 'the result', runMinutes: 'how long it ran', levelPct: 'the level', levelBand: 'the supply level' }[f];
    return null;
  }

  function form() {
    if (ui.form === 'none-open') {
      return h('div', { class: 'card fac-form', 'data-test': 'none-open', tabindex: '-1' }, h('p', {}, h('b', {}, 'No outage is open.')),
        h('p', { class: 'meta' }, 'To record one, tap Outage started.'), h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => { ui.form = null; draw(); } }, 'Back'));
    }
    const p = ui.picks;
    const ch = data.ov.choices;
    const back = h('button', { class: 'btn btn-ghost fac-back', type: 'button', 'data-test': 'back', onclick: () => { ui.form = null; ui.picks = {}; draw(); } }, 'Back');
    const field = (q, id, ...kids) => h('div', { class: 'field fac-field' }, h('p', { class: 'fac-q', id }, q), ...kids);
    const set = (k) => (v) => { p[k] = v; draw(); };
    const need = missing();
    const saveBtn = h('button', { class: 'btn btn-big fac-save', type: 'submit', 'data-test': 'save', disabled: !!need, 'aria-disabled': String(!!need),
      'data-cmd': ui.form === 'outage-start' ? 'ospeli_facilities_outage_start' : 'ospeli_facilities_check_record' }, need ? `Pick ${need} first` : 'Save');
    let body;
    let title;
    if (ui.form === 'outage-start') {
      title = 'Outage started';
      const gas = p.utility === 'medical-gases' || p.utility === 'medical-air-vacuum';
      const sel = h('select', { id: 'fac-place', 'data-test': 'place', 'aria-labelledby': 'fq-place', onchange: (e) => { p.placeId = e.target.value || null; draw(); } },
        h('option', { value: '' }, 'Choose the place'),
        [['site', 'Sites'], ['building', 'Buildings'], ['department', 'Departments']].map(([t, label]) => {
          const list = ch.outagePlaces.filter((x) => x.type === t);
          return list.length ? h('optgroup', { label }, list.map((x) => new Option(x.name, x.id, false, x.id === p.placeId))) : null;
        }));
      body = [
        field('Which supply stopped?', 'fq-util', choices('utility', Object.entries(UTILITIES), p.utility, set('utility'), 'fq-util')),
        gas ? h('p', { class: 'fac-gas', 'data-test': 'gas-first' }, 'Follow your site\'s medical gas procedure first. Ospeli raises no alarm and switches nothing.') : null,
        field('Where?', 'fq-place', sel),
        field('Cause', 'fq-cause', choices('cause', Object.entries(CAUSES), p.cause, set('cause'), 'fq-cause')),
        h('details', { class: 'fac-ago' }, h('summary', {}, p.ago ? `Started ${agoText(p.ago).toLowerCase()}` : 'Started earlier?'),
          choices('start-ago', AGO_MINUTES.map((m) => [String(m), agoText(m)]), String(p.ago || 0), (v) => { p.ago = Number(v); draw(); })),
      ];
    } else {
      const k = CHECK_KINDS[ui.form];
      title = k.name;
      const targets = k.target === 'asset' ? ch.assets[ui.form] : ch.places[ui.form];
      body = [
        ui.form === 'gas-check' ? h('p', { class: 'fac-gas', 'data-test': 'gas-first' }, GAS_FIRST) : null,
        field(k.target === 'asset' ? 'Which generator?' : 'Where?', 'fq-target', targets.length
          ? choices('target', targets.map((x) => [x.id, x.name]), p.target, set('target'), 'fq-target')
          : h('p', { class: 'meta' }, 'Nothing to check on this site yet.')),
        k.needs.includes('result') ? field('Result', 'fq-result', choices('result', Object.entries(RESULTS), p.result, set('result'), 'fq-result')) : null,
        k.needs.includes('runMinutes') ? field('How long did it run?', 'fq-run', choices('run', RUN_MINUTES.map((m) => [m, runText(m)]), p.runMinutes, (v) => set('runMinutes')(Number(v)), 'fq-run')) : null,
        k.needs.includes('levelPct') ? field('Level on the gauge', 'fq-level', choices('level', LEVELS.map((v) => [v, `${v}%`]), p.levelPct, (v) => set('levelPct')(Number(v)), 'fq-level')) : null,
        k.needs.includes('levelBand') ? field('Main supply level', 'fq-band', choices('band', Object.entries(GAS_BANDS), p.levelBand, set('levelBand'), 'fq-band')) : null,
      ];
    }
    const f = h('form', { class: 'card fac-form', 'data-test': 'form', 'data-form': ui.form, 'aria-labelledby': 'fac-form-h' },
      h('div', { class: 'fac-form-head' }, h('h2', { id: 'fac-form-h' }, title), back), body, saveBtn,
      h('p', { class: 'meta' }, 'Pick from the lists; nothing is typed. The log keeps your role, never your name.'));
    f.addEventListener('submit', (e) => { e.preventDefault(); save(); });
    return f;
  }

  async function save() {
    if (missing() || ui.busy) return;
    const p = ui.picks;
    if (ui.form === 'outage-start') {
      const name = data.names.get(p.placeId);
      await act('ospeli_facilities_outage_start', { utility: p.utility, placeId: p.placeId, cause: p.cause, ...(p.ago ? { startedMinutesAgo: p.ago } : {}) },
        `Saved: ${UTILITIES[p.utility].toLowerCase()} outage started`, Object.assign((out) => { ui.form = null; ui.picks = {}; ui.saved = { text: `Saved: ${UTILITIES[p.utility]} outage, ${name}. It is listed at the top until you end it.`, id: out.outageId }; },
          { onError: (err) => { ui.msg = err.code === 'conflict' && err.detail?.existing ? `Not saved: ${err.detail.existing.toUpperCase()} is already open for this supply and place. End it at the top of the page.` : `Not saved. ${err.message}`; } }));
      return;
    }
    const k = CHECK_KINDS[ui.form];
    const input = { checkKind: ui.form, [k.target === 'asset' ? 'assetId' : 'placeId']: p.target };
    for (const fld of k.needs) input[fld] = p[fld];
    const target = data.names.get(p.target);
    await act('ospeli_facilities_check_record', input, `Saved: ${k.name.toLowerCase()}`, Object.assign((out) => {
      ui.form = null; ui.picks = {};
      ui.saved = { text: `Saved: ${k.name}, ${target}: ${out.words}.`, failed: input.result === 'fail', id: out.checkId };
      ui.fault = out.reportFault ? { ...out.reportFault.input, assetName: target, priority: null, done: null } : null;
    }, { onError: (err) => { ui.msg = err.code === 'conflict' && err.detail?.existing ? `Already saved: the same ${k.name.toLowerCase()} was saved a few minutes ago. Nothing new was saved.` : `Not saved. ${err.message}`; } }));
  }

  function savedCard() {
    if (!ui.saved && !ui.msg) return null;
    return h('div', { class: `card fac-saved${ui.saved?.failed ? ' is-fail' : ''}${ui.msg && !ui.saved ? ' is-msg' : ''}`, role: 'status', 'data-test': 'saved' },
      ui.saved ? h('p', {}, h('b', {}, ui.saved.text)) : null,
      ui.msg ? h('p', { 'data-test': 'msg' }, ui.msg) : null,
      ui.fault ? faultPanel() : null,
      ui.saved?.failed && !ui.fault ? h('p', { class: 'meta' }, 'A failed check opens no work order by itself.') : null);
  }
  function faultPanel() {
    const f = ui.fault;
    if (!mayFault) return h('p', { class: 'meta' }, `A failed test opens no work order by itself. Faults are reported by ${roleNames(commandByName('ospeli_workorders_report_fault').roles)}.`);
    if (f.done) return h('p', { 'data-test': 'fault-done' }, f.done, ' ', h('a', { href: '#/engineering', class: 'fac-a' }, 'See it on the Engineering page'));
    return h('div', { class: 'fac-fault', 'data-test': 'fault' },
      h('p', {}, h('b', {}, 'Report a fault to the facilities team?'), ` ${f.fault}, ${f.assetName}. A failed test opens no work order by itself.`),
      h('p', { class: 'fac-q', id: 'fq-prio' }, 'How soon?'),
      choices('priority', PRIORITIES, f.priority, (v) => { f.priority = v; draw(); }, 'fq-prio'),
      h('button', { class: 'btn btn-big fac-save', type: 'button', 'data-cmd': 'ospeli_workorders_report_fault', 'data-test': 'fault-send', disabled: !f.priority, 'aria-disabled': String(!f.priority),
        onclick: () => act('ospeli_workorders_report_fault', { assetId: f.assetId, fault: f.fault, priority: f.priority }, 'Fault reported',
          Object.assign((out) => { f.done = `Reported: ${out.workOrderId.toUpperCase()}, ${f.fault}.`; },
            { onError: (err) => { f.done = err.code === 'conflict' && err.detail?.existing ? `Already reported: ${String(err.detail.existing).toUpperCase()} is open for this fault. No new work order was opened.` : null; if (!f.done) ui.msg = `Not sent. ${err.message}`; } })) },
      f.priority ? 'Report fault' : 'Pick how soon first'),
      h('button', { class: 'btn btn-ghost', type: 'button', 'data-test': 'fault-skip', onclick: () => { ui.fault = null; draw(); } }, 'Not now'));
  }

  function logSection() {
    if (!logs) return h('p', { class: 'card meta notice', 'data-test': 'read-only' }, `${roleById(role)?.name || role} can see the log. Checks are recorded by ${roleNames(['estates-tech', 'facilities-assistant', 'facilities-manager'])}; outages also by ${roleNames(['ops-manager'])}.`);
    return h('section', { class: 'section fac-sec', 'aria-labelledby': 'fac-log-h', 'data-test': 'log' },
      h('h2', { id: 'fac-log-h' }, ui.form ? 'Log' : 'What are you logging?'),
      savedCard(),
      ui.form ? form() : tiles());
  }

  // ---------------------------------------------------------------- the manager's pieces
  function attention() {
    const { overdue, openOutages: open } = data.ov.attention;
    return h('section', { class: 'card fac-attention', 'aria-labelledby': 'fac-att-h', 'data-test': 'attention' },
      h('h2', { id: 'fac-att-h' }, 'Needs attention'),
      !overdue.length && !open.length ? h('p', { 'data-test': 'all-clear' }, 'No check missed and no outage open.') : null,
      overdue.length ? h('ul', { class: 'fac-list' }, overdue.map((c) => h('li', { class: 'fac-missed', 'data-test': 'missed', 'data-check': `${c.checkKind}:${c.targetId}` },
        h('p', { class: 'fac-what' }, h('b', {}, `${c.checkName}: ${c.targetName}`), h('span', { class: 'chip fac-hot' }, 'Missed')),
        h('p', { class: 'meta' }, c.overdueText),
        c.last ? h('p', { class: 'meta' }, `Last: ${c.last.atText}, ${c.last.words}.`) : null))) : null,
      open.length ? h('ul', { class: 'fac-list' }, open.map(outageRow)) : null);
  }

  function guideCard() {
    const g = data.ov.guide;
    return h('section', { class: 'card fac-guide', 'data-test': 'guide', 'data-on': String(g.on), 'aria-labelledby': 'fac-guide-h' },
      h('div', { class: 'fac-guide-head' }, h('h2', { id: 'fac-guide-h' }, 'Guide'),
        mayGuide ? h('button', { class: 'btn btn-ghost btn-small', type: 'button', 'aria-pressed': String(g.on), 'data-cmd': 'ospeli_facilities_guide_set', 'data-test': 'guide-switch',
          onclick: () => act('ospeli_facilities_guide_set', { on: !g.on }, `Guide ${g.on ? 'off' : 'on'}`) }, g.on ? 'Guide on: switch off' : 'Guide off: switch on') : null),
      g.on ? [
        h('p', { class: 'meta' }, 'Fixed rules, not AI. They suggest; you decide. Nothing changes until a person acts.'),
        g.suggestions.length ? h('ul', { class: 'fac-sugg' }, g.suggestions.map((s) => h('li', { 'data-rule': s.rule, 'data-test': 'suggestion' },
          h('p', {}, h('b', {}, s.text)), h('p', { class: 'meta' }, s.why),
          s.rule === 'repeat-faults' ? h('a', { href: '#/engineering', class: 'fac-a' }, 'See the work orders on the Engineering page') : null,
          h('details', { class: 'fac-def' }, h('summary', {}, 'Why this rule'), h('p', {}, s.basis))))) : h('p', { 'data-test': 'no-suggestion' }, 'Nothing to suggest right now.'),
        h('p', { class: 'meta' }, 'Before severe weather: planned, not built yet.'),
      ] : h('p', { 'data-test': 'guide-off' }, 'The guide is off. The log, the checks and the measures work the same.'),
      mayGuide ? null : h('p', { class: 'meta' }, 'The facilities manager can switch the guide on or off.'));
  }

  function checksSection() {
    const rows = data.ov.checks;
    return h('section', { class: 'section fac-sec', 'aria-labelledby': 'fac-chk-h', 'data-test': 'checks' },
      h('h2', { id: 'fac-chk-h' }, 'Scheduled checks'),
      rows.length ? h('ul', { class: 'fac-list fac-checks' }, rows.map((c) => h('li', { class: `fac-check is-${c.status}`, 'data-check': `${c.checkKind}:${c.targetId}`, 'data-status': c.status },
        h('p', { class: 'fac-what' }, h('b', {}, `${c.checkName}: ${c.targetName}`), h('span', { class: `chip fac-st-${c.status}` }, STATUS_WORDS[c.status])),
        h('p', { class: 'meta' }, c.status === 'overdue' ? c.overdueText : c.status === 'done' ? `Done this period. ${c.everyText}.` : `${c.dueText}. ${c.everyText}.`),
        c.last ? h('p', { class: 'meta' }, `Last: ${c.last.atText}, ${c.last.words}${c.lastFailed ? ' (failed)' : ''}.`) : h('p', { class: 'meta' }, 'No check recorded yet.'))))
        : h('p', { class: 'fac-empty', 'data-test': 'checks-empty' }, 'No scheduled check on this site yet.'),
      h('p', { class: 'meta' }, data.ov.schedule.note));
  }

  function readingsSection() {
    const r = data.ov.readings;
    return h('section', { class: 'section fac-sec', 'aria-labelledby': 'fac-rd-h', 'data-test': 'readings' },
      h('h2', { id: 'fac-rd-h' }, 'Fuel and water, newest readings'),
      r.length ? h('ul', { class: 'fac-list' }, r.map((x) => h('li', { class: `fac-reading${x.below ? ' is-below' : ''}`, 'data-reading': `${x.checkKind}:${x.targetId}`, 'data-below': String(x.below) },
        h('p', { class: 'fac-what' }, h('b', {}, `${x.checkKind === 'fuel-level' ? 'Fuel' : 'Stored water'}: ${x.targetName}`), h('span', { class: `chip${x.below ? ' fac-hot' : ''}` }, `${x.levelPct}%`)),
        h('p', { class: 'meta' }, `${x.atText}. Site level ${x.setPct}%${x.below ? ': below it' : ''}.`)))) : h('p', { class: 'fac-empty' }, 'No fuel or water reading recorded yet.'));
  }

  function measures() {
    const [gen, out] = data.ov.kpis;
    const def = (k) => h('details', { class: 'fac-def' }, h('summary', {}, 'How it is counted'),
      h('p', {}, k.definition), h('p', {}, `Counts: ${k.counts}`), h('p', {}, `Out of: ${k.outOf}`), h('p', {}, `Leaves out: ${k.leavesOut}`), h('p', {}, `Source: ${k.source}`), h('p', {}, `Target: ${k.targetText}`));
    return h('section', { class: 'section fac-sec', 'aria-labelledby': 'fac-kpi-h', 'data-test': 'measures' },
      h('h2', { id: 'fac-kpi-h' }, 'Measures'),
      h('p', { class: 'meta' }, 'Calculated from the log on this device. They count checks and outages, never a person.'),
      h('div', { class: 'fac-kpis' },
        h('div', { class: 'card fac-kpi', 'data-kpi': gen.id, 'data-value': gen.value == null ? '' : String(Math.round(gen.value * 10) / 10), 'data-n': `${gen.numerator}/${gen.denominator}` },
          h('p', { class: 'fac-kpi-name' }, `${gen.name}, last ${gen.period.days} days`),
          h('p', { class: 'fac-kpi-value' }, pctText(gen.value)),
          h('p', { class: 'meta' }, `${gen.numerator} of ${gen.denominator} tests done by their due date${gen.failed ? `; ${gen.failed} of them failed` : ''}.`),
          gen.missed?.length ? h('p', { class: 'meta' }, `Missed: ${gen.missed.map((m) => `${m.targetName}, week to ${m.dueText}`).join('; ')}.`) : null,
          def(gen)),
        h('div', { class: 'card fac-kpi', 'data-kpi': out.id, 'data-value': String(out.value) },
          h('p', { class: 'fac-kpi-name' }, `${out.name}, ${out.period.month}`),
          h('p', { class: 'fac-kpi-value' }, hoursText(out.value)),
          h('ul', { class: 'fac-hours', 'data-test': 'hours' }, out.breakdown.filter((b) => b.outages).map((b) => h('li', { 'data-utility': b.id },
            `${b.name}: ${hoursText(b.hours)}${b.plannedHours ? ` (planned shutdown ${hoursText(b.plannedHours)}, not in the total)` : ''}${b.open ? ', still open' : ''}`))),
          out.breakdown.some((b) => b.outages) ? null : h('p', { class: 'meta' }, 'No outage this month.'),
          def(out))),
      h('ul', { class: 'fac-planned' },
        data.ov.readOnly.map((x) => h('li', { class: 'meta', 'data-kpi': x.id }, `${x.name}: ${x.note}`)),
        data.ov.planned.map((x) => h('li', { class: 'meta', 'data-kpi': x.id }, `${x.name}: ${x.note}`))));
  }

  function faultsCard() {
    const n = data.next;
    const w = n?.workOrder;
    // The next job only, read from Engineering's own rule; no count of this page's own.
    return h('section', { class: 'card fac-faults', 'aria-labelledby': 'fac-wo-h', 'data-test': 'faults' },
      h('h2', { id: 'fac-wo-h' }, 'Building and plant faults'),
      w ? h('div', { 'data-test': 'next-job', 'data-wo': w.id },
        h('p', { class: 'meta' }, 'Next job for the facilities team, by Engineering\'s rule:'),
        h('p', {}, h('b', {}, `${w.id.toUpperCase()}: ${w.title}`)),
        h('p', {}, [w.assetName, w.locationName].filter(Boolean).join(', ')),
        h('p', { class: 'meta' }, `${n.priorityName}. ${n.lateText}.`)) : h('p', { 'data-test': 'no-job' }, 'No job is waiting for the facilities team.'),
      h('a', { class: 'btn btn-ghost fac-link', href: '#/engineering', 'data-test': 'open-engineering' }, mayFault ? 'Report or work a fault: Engineering page' : 'Open the Engineering page'),
      h('p', { class: 'meta' }, 'Room labels for fault reports: planned, not built yet.'));
  }

  function levelsCard() {
    const l = data.ov.levels;
    const pick = ui.levels;
    const fuel = pick.fuelPct ?? l.fuelPct; const water = pick.waterPct ?? l.waterPct;
    const changed = fuel !== l.fuelPct || water !== l.waterPct;
    return h('section', { class: 'card fac-levels', 'aria-labelledby': 'fac-lv-h', 'data-test': 'levels' },
      h('h2', { id: 'fac-lv-h' }, 'Levels for the refill suggestion'),
      h('p', { class: 'meta' }, `Now: ${l.text}.`),
      mayLevels ? [
        h('p', { class: 'fac-q', id: 'fq-lv-fuel' }, 'Fuel'),
        choices('level-fuel', LEVEL_PICKS.map((v) => [v, `${v}%`]), fuel, (v) => { pick.fuelPct = Number(v); draw(); }, 'fq-lv-fuel'),
        h('p', { class: 'fac-q', id: 'fq-lv-water' }, 'Stored water'),
        choices('level-water', LEVEL_PICKS.map((v) => [v, `${v}%`]), water, (v) => { pick.waterPct = Number(v); draw(); }, 'fq-lv-water'),
        h('button', { class: 'btn fac-save', type: 'button', 'data-cmd': 'ospeli_facilities_levels_set', 'data-test': 'levels-save', disabled: !changed, 'aria-disabled': String(!changed),
          onclick: () => act('ospeli_facilities_levels_set', { ...(fuel !== l.fuelPct ? { fuelPct: fuel } : {}), ...(water !== l.waterPct ? { waterPct: water } : {}) }, 'Levels saved', () => { ui.levels = {}; }) },
        changed ? 'Save levels' : 'Pick a new level to save'),
      ] : h('p', { class: 'meta' }, 'The facilities manager sets the levels.'));
  }

  function recent() {
    const list = data.log.entries;
    return h('section', { class: 'section fac-sec', 'aria-labelledby': 'fac-rec-h', 'data-test': 'recent' },
      h('h2', { id: 'fac-rec-h' }, 'Recently logged'),
      list.length ? h('ul', { class: 'fac-list fac-recent' }, list.map((x) => h('li', { 'data-entry': x.id },
        h('p', {}, h('b', {}, x.kind === 'check' ? `${x.checkName}: ${x.words}` : `${x.utilityName} outage${x.open ? ', still open' : `, ${fmtWait(x.minutes)}`}`)),
        h('p', { class: 'meta' }, `${x.kind === 'check' ? x.targetName : `${x.placeName}. ${x.causeName}`}. ${x.atText}. ${roleById(x.kind === 'check' ? x.byRole : (x.endedByRole || x.startedByRole))?.name || ''}`))))
        : h('p', { class: 'fac-empty', 'data-test': 'log-empty' }, 'Nothing has been logged on this device yet.'));
  }

  const footer = () => [
    h('p', { class: 'card meta notice', 'data-test': 'planned' }, 'Compliance calendar: planned, not built yet. Waste log: planned, not built yet.'),
    h('p', { class: 'meta fac-note' }, data.ov.note),
  ];

  // ---------------------------------------------------------------- the page
  function draw() {
    if (!data) return;
    const focusKey = document.activeElement && root.contains(document.activeElement) ? document.activeElement.dataset?.value : null;
    const open = data.ov.attention.openOutages;
    const missedCount = data.ov.attention.overdue.length;
    if (!manager) {
      setKids(root, head(), props.el,
        openOutages(open),
        logSection(),
        missedCount ? h('p', { class: 'card meta notice fac-hint', 'data-test': 'missed-hint' }, `${missedCount} scheduled ${missedCount === 1 ? 'check was' : 'checks were'} missed: see Scheduled checks below.`) : null,
        checksSection(),
        faultsCard(),
        recent(),
        footer());
    } else {
      setKids(root, head(), props.el,
        attention(),
        guideCard(),
        checksSection(),
        readingsSection(),
        measures(),
        faultsCard(),
        levelsCard(),
        logSection(),
        recent(),
        footer());
    }
    if (focusKey) root.querySelector(`[aria-pressed="true"][data-value="${CSS.escape(focusKey)}"]`)?.focus();
  }

  await load();
  let t = null;
  const off = ctx.core.onChange(({ kind }) => {
    if (!['event', 'events', 'reset', 'proposals'].includes(kind)) return;
    clearTimeout(t);
    t = setTimeout(() => load(), 100);
  });
  const tick = setInterval(() => load(), 60e3); // keep the outage lengths fresh
  return () => { off(); clearInterval(tick); clearTimeout(t); };
}

function nameMap(ov) {
  const m = new Map();
  for (const list of [...Object.values(ov.choices.assets), ...Object.values(ov.choices.places), ov.choices.outagePlaces]) for (const x of list) m.set(x.id, x.name);
  return m;
}

function describeProposal(p, data) {
  const names = data?.names || new Map();
  const i = p.input || {};
  switch (p.command) {
    case 'ospeli_facilities_check_record': {
      const k = CHECK_KINDS[i.checkKind];
      const bits = [i.result && RESULTS[i.result], i.runMinutes && runText(i.runMinutes), i.levelPct != null && `${i.levelPct}%`, i.levelBand && GAS_BANDS[i.levelBand]].filter(Boolean).join(', ');
      return `Record a ${k ? k.name.toLowerCase() : 'check'}: ${names.get(i.assetId || i.placeId) || 'a place'}${bits ? `, ${bits}` : ''}`;
    }
    case 'ospeli_facilities_outage_start': return `Record an outage: ${UTILITIES[i.utility] || 'a utility'}, ${names.get(i.placeId) || 'a place'}, ${CAUSES[i.cause] || ''}`;
    case 'ospeli_facilities_outage_end': return `End outage ${String(i.outageId || '').toUpperCase()}${i.cause ? ` (cause: ${CAUSES[i.cause]})` : ''}`;
    default: return p.command;
  }
}
