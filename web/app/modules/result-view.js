// The Result tab of a walked map (walk-first week, crew night 3): one bar per walk split by step,
// the per-step table walk by walk, the extra and redone steps, and the actions row (Walk the next
// patient, Print, Copy as text, Download CSV, Share). Built from ospeli_maps_get and the walks'
// own records; every typed name goes on screen as text, never as HTML.
import { h } from './ui.js';
import { minWords, NO_LONG_WAIT, waitWords, atLeastWait } from './result-words.js';
import { walkItems, longestPositions, resultTable, cellWords, extrasOf, columnsNote, csvOf, fileNameOf, summaryText, scaleTicks, compareModel, changeLine, walksLongest, againLines, sourceLine } from './result-data.js';
import { waitReasonText } from '../core/walk.js';

export const PHONE_COLUMNS = 3;
export const PRINT_COLUMNS = 6;

// The hands-on time of a step done again (#182, Builder's note of 27 Nov, item 1): its own pattern,
// a sea crosshatch, never colour alone; the legend shows the same pattern with its words. Set on the
// element itself, so the print page keeps it.
export const AGAIN_STYLE = 'background-color:var(--sea);background-image:repeating-linear-gradient(45deg,transparent 0 3px,rgba(255,255,255,.85) 3px 5px),repeating-linear-gradient(-45deg,transparent 0 3px,rgba(255,255,255,.85) 3px 5px)';
// A step with no name or role yet: one 44 px link to Edit map at that step (night 6 item 4).
const NAME_LINK_STYLE = 'display:inline-flex;align-items:center;min-height:44px;margin-left:8px;vertical-align:middle;font-size:1rem;font-weight:700;text-decoration:underline';
export const unnamedStep = (r) => r.kind === 'step' && (r.role === 'Not set' || /^Step \d+$/.test(r.name));

// The walks' records. ospeli_maps_get does not return them yet (reported to the walk Builder), so
// they are read from the map store on this device, read only. A record list from the command is
// used first when it is there.
export async function recordsOf(core, m) {
  if (Array.isArray(m.walks)) return m.walks;
  try {
    const raw = await core.getMeta('process-maps', null);
    const map = raw?.maps?.find((x) => x.id === m.id);
    return Array.isArray(map?.walks) ? map.walks : null;
  } catch { return null; }
}

// The wait before the step: the time the step stood still once started is not part of it (#180 point 2).
// A longest wait under 5 minutes keeps its seconds ("2 min 30 s"), as the headline says it.
const waitWord = (x) => (x.waitNotSeenSec > 0 ? atLeastWait(x.waitBeforeSec) : waitWords(x.waitBeforeSec));
const placeOf = (x) => `before “${x.name}”`;

// The words under a walk's bar for its longest wait.
export function longestLine(items, pos, { usable = true } = {}) {
  if (!usable) return 'The phone\'s clock changed on this walk: no longest wait is named.';
  const at = pos.map((p) => items[p]);
  if (!at.length) return NO_LONG_WAIT(false);
  const said = at.length === 1 ? waitReasonText(at[0].rec?.waitReason) : null;
  if (at.length === 1) return `Longest wait: ${waitWord(at[0])} ${placeOf(at[0])}${said ? `. Reason recorded on the walk: ${said}.` : ''}`;
  return `Longest waits, tied: ${at.map((x) => `${waitWord(x)} ${placeOf(x)}`).join(' and ')}`;
}

// What every part of the Result tab needs. rg: ospeli_maps_get's range; records: one per walk;
// list: the saved step list (map.today.steps); oneWalkTop: the step ids of the longest wait on a
// one-walk map (the same rule as the headline); day, clock: the device's own date and time format.
export function resultModel({ m, rg, records, list, oneWalkTop = null, day, clock }) {
  // Each walk's longest wait by the wait before the step (#180 point 2), for the outline under the bars.
  const lo = records.length && rg?.walks ? walksLongest(list, records, rg) : null;
  // A change a person marked (ospeli_maps_change_set): walks 1 to N before, later walks after.
  const afterWalk = Number.isInteger(m.changeAfterWalk) && m.changeAfterWalk > 0 && records.length ? Math.min(m.changeAfterWalk, records.length) : null;
  const walks = records.map((r, i) => {
    const items = walkItems(list, r);
    const info = rg.walks[i] || {};
    const usable = !r.clockMoved && info.usable !== false;
    const pos = !usable ? [] : oneWalkTop ? items.filter((x) => x.onList && oneWalkTop.includes(x.stepId)).map((x) => x.p) : longestPositions(items, lo ? lo.walks[i].longest : info.longest);
    const sum = (k) => items.reduce((n, x) => n + x[k], 0);
    const elapsed = sum('waitSec') + sum('workSec') + sum('waitNotSeenSec') + sum('workNotSeenSec');
    return { n: i + 1, rec: r, items, pos, usable, elapsed, wait: sum('waitSec'), work: sum('workSec'), notSeen: sum('waitNotSeenSec') + sum('workNotSeenSec'),
      when: r.startedAt ? `${day(r.startedAt)}, ${clock(r.startedAt)}` : '', note: r.clockMoved ? ' (may be wrong)' : r.stoppedEarly ? ' (stopped early)' : '',
      longest: longestLine(items, pos, { usable }), again: againLines(list, [r]) };
  });
  const compare = afterWalk ? compareModel({ list, records, rg, afterWalk }) : null;
  const deptId = m.walk?.department || null;
  const rows = resultTable(list, records);
  // The longest wait's own cell says its time as the headline does (seconds under 5 minutes).
  walks.forEach((w, k) => {
    for (const x of w.pos.map((p) => w.items[p])) {
      const row = rows.find((r) => (x.onList ? r.kind === 'step' && r.stepId === x.stepId : r.kind === 'extra' && r.walk === k + 1 && r.name === x.name));
      const c = row?.cells[k];
      if (!c || c.status !== 'timed') continue;
      if (c.times > 1 && c.each) { const e = c.each.find((y) => y.waitSec === x.waitBeforeSec); if (e) e.longest = true; } else c.longest = true;
    }
  });
  return { walks, rows, extras: extrasOf(list, records), title: m.title, afterWalk, compare, mapId: m.id, deptId,
    // Where the step names and roles came from (#170 point 2), said once.
    namesFrom: records.length ? sourceLine(list, records, deptId) : null,
    // Two or more walks: the steps done again, walk by walk, said under the bars.
    againAll: records.length > 1 ? againLines(list, records) : null };
}

// One bar per walk, on one shared scale (the longest walk is the full width). Inside a bar each
// step is its wait (striped) then its hands-on time (solid), in the order they happened, with a
// thin gap between steps. The longest wait is outlined, and said in words under the bar.
// Under each bar, each step's number on the list ("+" for a step not on it) at the start of its
// segments; where two would touch, the later one is left out, never the longest wait's (#189 item 3).
// Under the bars, a minutes scale from the start of the walk.
export function barsCard(model, change = null, read = null) {
  const max = Math.max(1, ...model.walks.map((w) => w.elapsed));
  const any = (f) => model.walks.some((w) => w.items.some(f));
  const key = (cls, text) => h('span', { class: 'key' }, h('span', { class: `rsw ${cls}` }), text);
  const ticks = scaleTicks(max);
  const scale = h('div', { class: 'rscale', 'data-test': 'bar-scale', role: 'img', 'aria-label': `Scale: minutes from the start of the walk, marks at ${ticks.map((t) => t.label).join(', ')}.` },
    ticks.map((t) => h('span', { class: `rtick${(100 * t.sec) / max > 80 ? ' end' : ''}`, 'data-test': 'bar-tick', 'data-sec': String(t.sec), style: `left:${(100 * t.sec) / max}%` }, t.label)));
  const card = h('section', { class: 'card bars result-bars', 'aria-labelledby': 'bars-h', 'data-test': 'walk-bars' },
    h('h3', { id: 'bars-h' }, 'Where the time went'),
    model.walks.map((w) => {
      const total = w.elapsed || 1;
      const width = Math.max(8, (100 * w.elapsed) / max);
      const bar = h('div', { class: 'rbar', role: 'img', style: `width:${width}%`, 'data-test': 'bar-walk', 'data-sec': String(w.elapsed),
        'aria-label': `Walk ${w.n}${model.compare?.both ? (w.n > model.afterWalk ? ', after the change' : ', before the change') : ''}: ${minWords(w.wait)} waiting and ${minWords(w.work)} hands-on, over ${w.items.length} ${w.items.length === 1 ? 'step' : 'steps'}.${w.notSeen ? ` ${minWords(w.notSeen)} more was not seen.` : ''} ${w.longest}.${w.again ? ` ${w.again}` : ''} The numbers are the step numbers in the table.` });
      const nums = h('div', { class: 'rnums', 'aria-hidden': 'true', style: `width:${width}%` });
      let at = 0;
      w.items.forEach((x, k) => {
        const hot = w.pos.includes(x.p);
        // The wait before the step (outlined when it is the longest), then hands-on; the time the step
        // stood still once started is waiting too, so it is striped, after the hands-on (#180 point 2).
        // A step done again: its hands-on has its own pattern (AGAIN_STYLE) and data-again.
        const redo = x.marked || x.again;
        const parts = [[x.planned ? 'p' : 'w', x.waitBeforeSec, hot], ['n', x.waitNotSeenSec], ['k', x.workSec, false, redo], ['w', x.stoppedSec], ['n', x.workNotSeenSec]].filter((s) => s[1] > 0);
        nums.append(h('span', { class: `rnum${hot ? ' is-longest' : ''}`, 'data-test': 'bar-num', ...(hot ? { 'data-longest': 'true' } : {}), style: `left:${(100 * at) / total}%` }, x.num));
        // Only the first part of a step leaves the thin gap after the step before.
        parts.forEach(([cls, sec, isHot, isAgain], j) => bar.append(h('i', { class: `${cls}${isHot ? ' is-longest' : ''}${k && !j ? ' gap' : ''}`, style: `width:${(100 * sec) / total}%${isAgain ? `;${AGAIN_STYLE}` : ''}`,
          'data-step': x.stepId || `off:${x.name}`, ...(isHot ? { 'data-longest': 'true' } : {}), ...(isAgain ? { 'data-again': 'true' } : {}) })));
        at += parts.reduce((n, p) => n + p[1], 0);
      });
      const row = h('div', { class: 'bar-row' },
        h('span', { class: 'bar-label' }, `Walk ${w.n} · ${w.when} · ${minWords(w.elapsed)}${w.note}`), bar, nums,
        h('p', { class: 'bar-longest', 'data-test': 'bar-longest' }, w.longest));
      // Where a person marked the change: one line in words between the last "before" bar and the first "after" bar.
      return model.compare?.both && w.n === model.afterWalk + 1
        ? [h('p', { class: 'bar-change', 'data-test': 'bar-change' }, `Change made after walk ${model.afterWalk}: walks above it are before, below it after.`), row] : row;
    }),
    scale,
    h('p', { class: 'legend meta', 'data-test': 'bar-legend' },
      key('w', 'Waiting'), any((x) => x.planned && x.waitSec) ? key('p', 'Planned or required wait') : null, key('k', 'Hands-on'),
      any((x) => (x.marked || x.again) && x.workSec) ? h('span', { class: 'key' }, h('span', { class: 'rsw', style: AGAIN_STYLE }), 'Done again') : null,
      any((x) => x.waitNotSeenSec || x.workNotSeenSec) ? key('n', 'Not seen') : null, key('w is-longest', 'Longest wait'),
      h('span', { class: 'key' }, h('span', { class: 'rnum-key', 'aria-hidden': 'true' }, '1'), 'Step number, + not on the list')),
    // "Mark a change" (or the mark already made, with "Remove the mark") at the foot of the bars it
    // splits (#189 night 5 item 3), in one row with "How to read this".
    change || read ? h('div', { class: 'rb-foot' }, change, read) : null);
  // Leave out a number that would touch the one before it, keeping the longest wait's; again
  // whenever the card's width changes (a turned phone, the print page).
  const thin = () => {
    for (const row of card.querySelectorAll('.rnums, .rscale')) {
      const marks = [...row.children]; marks.forEach((m) => { m.hidden = false; });
      const scaleRow = row.classList.contains('rscale');
      const prio = (m) => (m.dataset.longest === 'true' ? 3 : scaleRow && (m === marks[0] || m === marks[marks.length - 1]) ? 2 : m === marks[0] ? 1 : 0);
      const kept = [];
      for (const m of marks) {
        const r = m.getBoundingClientRect();
        while (kept.length && r.left < kept[kept.length - 1].r.right + 4) {
          const last = kept[kept.length - 1];
          if (prio(m) <= prio(last.m)) { m.hidden = true; break; }
          last.m.hidden = true; kept.pop();
        }
        if (!m.hidden) kept.push({ m, r });
      }
    }
  };
  if (typeof ResizeObserver === 'function') new ResizeObserver(() => thin()).observe(card);
  const onPrint = () => { if (!card.isConnected) { window.removeEventListener('beforeprint', onPrint); return; } thin(); };
  window.addEventListener('beforeprint', onPrint);
  return card;
}

// The per-step table: a row per list step, a column per walk. A phone shows the newest three walks,
// a print or a wide screen the newest six; the CSV holds every walk.
export function tableCard(model, after = null) {
  const count = model.walks.length;
  const age = (k) => count - 1 - k;
  const colCls = (k) => [age(k) >= PHONE_COLUMNS ? 'old3' : null, age(k) >= PRINT_COLUMNS ? 'old6' : null].filter(Boolean).join(' ') || null;
  const phoneNote = columnsNote(count, PHONE_COLUMNS); const wideNote = columnsNote(count, PRINT_COLUMNS, { where: 'print' });
  return h('section', { class: 'card result-table-card', 'aria-label': 'Step by step', 'data-test': 'result-table' },
    phoneNote ? h('p', { class: 'meta note-phone', 'data-test': 'columns-note' }, phoneNote) : null,
    wideNote ? h('p', { class: 'meta note-wide', 'data-test': 'columns-note-wide' }, wideNote) : null,
    namesLine(model),
    // A real table. On a phone its rows are laid out as blocks (the step above its cells), so the
    // table roles are also given in full: a screen reader still reads a table.
    h('table', { class: `rtable cols-${Math.min(count, PHONE_COLUMNS)}`, role: 'table' },
      h('caption', {}, h('b', {}, 'Step by step'), h('span', {}, ' Each cell: wait · hands-on.')),
      h('thead', { role: 'rowgroup' }, h('tr', { role: 'row' }, h('th', { scope: 'col', role: 'columnheader', class: 'rt-stephead' }, 'Step'), model.walks.map((w, k) => h('th', { scope: 'col', role: 'columnheader', class: colCls(k) }, `Walk ${w.n}`)))),
      h('tbody', { role: 'rowgroup' }, model.rows.map((r) => h('tr', { role: 'row', class: r.kind === 'extra' ? 'is-extra' : null, 'data-row': r.kind === 'extra' ? 'extra' : r.stepId },
        h('th', { scope: 'row', role: 'rowheader' },
          h('b', r.marked ? { 'data-test': 'row-again' } : {}, r.kind === 'extra' ? `+ ${r.name}` : `${r.order}. ${r.name}${r.marked ? ', done again' : ''}`),
          h('span', { class: 'rt-role' }, ` · ${r.role}`),
          r.kind === 'extra' ? h('span', { class: 'rt-only', 'data-test': 'only-on' }, `Not on the list · Only on walk ${r.walk}`) : null,
          nameLink(model, r)),
        r.cells.map((c, k) => h('td', { role: 'cell', class: colCls(k), 'data-status': c.status, ...(c.status === 'timed' ? { 'data-sec': `${c.waitSec},${c.workSec}`, ...(c.stoppedSec ? { 'data-stood': String(c.stoppedSec) } : {}) } : {}) },
          c.status === 'not-on-walk' ? [h('span', { 'aria-hidden': 'true' }, '–'), h('span', { class: 'sr-only' }, 'not on this walk')] : cellWords(c),
          c.times > 1 ? h('span', { class: 'rt-again', 'data-test': 'done-again' }, `Done ${c.times} times`) : null,
          c.reason ? h('span', { class: 'rt-reason', 'data-test': 'cell-reason' }, c.reason) : null,
          c.stopReason ? h('span', { class: 'rt-reason', 'data-test': 'cell-stop-reason' }, c.stopReason) : null)))))),
    after);
}

// Before and after a change (#189 item 6): a row per list step (and per step not on the list),
// Before · After · Difference in the wait, with the walk counts in the heads; then the totals and one
// line: Ospeli shows the difference and does not say whether the change worked.
export function compareCard(model, after = null) {
  const c = model.compare;
  const sec = (sp) => (sp?.wait?.n ? `${sp.wait.min}-${sp.wait.max}` : null);
  // data-label: on a phone each cell is its own line, the column's name before it (review fix 3).
  const tds = (r) => [
    h('td', { role: 'cell', 'data-label': c.heads[0], ...(sec(r.before) ? { 'data-sec': sec(r.before) } : {}) }, r.beforeText),
    h('td', { role: 'cell', 'data-label': c.heads[1], ...(sec(r.after) ? { 'data-sec': sec(r.after) } : {}) }, r.afterText),
    h('td', { role: 'cell', class: 'rc-diff', 'data-label': 'Difference', 'data-dir': r.diff.dir }, r.diff.text)];
  return h('section', { class: 'card result-table-card', 'aria-label': 'Before and after', 'data-test': 'result-table' },
    namesLine(model),
    h('table', { class: 'rtable cols-3 rcompare', role: 'table' },
      h('caption', {}, h('b', {}, 'Before and after'), h('span', {}, ` Changed after walk ${c.afterWalk}. Each cell: wait · hands-on, lowest to highest.`)),
      h('thead', { role: 'rowgroup' }, h('tr', { role: 'row' }, h('th', { scope: 'col', role: 'columnheader', class: 'rt-stephead' }, 'Step'), c.heads.map((t) => h('th', { scope: 'col', role: 'columnheader' }, t)))),
      h('tbody', { role: 'rowgroup' },
        c.rows.map((r) => h('tr', { role: 'row', class: r.kind === 'step' ? null : r.kind === 'again' ? 'is-again' : 'is-extra', 'data-row': r.kind === 'step' ? r.stepId : r.kind === 'again' ? `again-${r.stepId}` : 'extra' },
          h('th', { scope: 'row', role: 'rowheader' },
            h('b', {}, r.kind === 'extra' ? `+ ${r.name}` : r.kind === 'again' ? `${r.order}. ${r.name}, done again` : `${r.order}. ${r.name}`), h('span', { class: 'rt-role' }, ` · ${r.role}`),
            r.kind === 'extra' ? h('span', { class: 'rt-only' }, 'Not on the list') : null,
            r.kind === 'again' ? h('span', { class: 'rt-only', 'data-test': 'again-row' }, 'Its later times on the same walk') : null,
            r.againText ? h('span', { class: 'rt-again', 'data-test': 'done-again' }, r.againText) : null,
            r.reasonText ? h('span', { class: 'rt-reason', 'data-test': 'row-reason' }, r.reasonText) : null,
            nameLink(model, r)),
          tds(r))),
        c.totals.map((t) => h('tr', { role: 'row', class: 'is-total', 'data-row': 'total' }, h('th', { scope: 'row', role: 'rowheader' }, h('b', {}, t.label)), tds(t))))),
    h('p', { class: 'rc-caveat', 'data-test': 'change-caveat' }, c.caveat),
    after);
}

// Where the names and roles came from, once, above the table (and so on the print page).
function namesLine(model) {
  return model.namesFrom ? h('p', { class: 'rt-from', 'data-test': 'names-from', style: 'margin:0 0 8px' }, model.namesFrom) : null;
}
// "Name this step": Edit map, opened at that step.
function nameLink(model, r) {
  if (!unnamedStep(r) || !model.mapId) return null;
  return h('a', { href: `#/process/${encodeURIComponent(model.mapId)}/edit/${encodeURIComponent(r.stepId)}`, class: 'rt-name', 'data-test': 'name-step', style: NAME_LINK_STYLE,
    'aria-label': `Name step ${r.order} in Edit map` }, 'Name this step');
}

// "Mark a change": a person says after which walk the way this works was changed
// (ospeli_maps_change_set, people only). set(n) saves it; 0 removes it. No typed text is kept.
export function changeBox({ count, afterWalk, set }) {
  if (afterWalk) {
    return h('section', { class: 'result-change is-marked', 'aria-label': 'Before and after a change', 'data-test': 'change-box' },
      h('p', { 'data-test': 'change-line' }, changeLine(afterWalk, count)),
      h('button', { type: 'button', class: 'btn btn-ghost', 'data-test': 'change-remove', 'data-cmd': 'ospeli_maps_change_set', onclick: () => set(0) }, 'Remove the mark'));
  }
  // A plain button beside the bars (#189 night 5 item 3). Its choice gives a table when one is
  // possible: with 2 or more walks, after the walk before the newest; with one walk, the next walk
  // will be the first "after" walk.
  const def = count >= 2 ? count - 1 : 1;
  const pick = h('select', { id: 'change-after', 'data-test': 'change-after' },
    Array.from({ length: count }, (_, i) => h('option', { value: String(i + 1), ...(i + 1 === def ? { selected: true } : {}) }, `walk ${i + 1}`)));
  const body = h('div', { class: 'rc-body', id: 'change-body', hidden: true },
    h('p', { 'data-test': 'change-help' }, count >= 2 ? 'For a before and after. Walks up to the one you choose count as before the change; later walks count as after.'
      : 'For a before and after. This walk counts as before the change; the next walk will be the first “after” walk.'),
    h('div', { class: 'rc-pick' }, h('label', { for: 'change-after' }, 'We changed something after'), pick),
    h('button', { type: 'button', class: 'btn', 'data-test': 'change-save', 'data-cmd': 'ospeli_maps_change_set', onclick: () => set(Number(pick.value)) }, 'Save the mark'));
  const open = h('button', { type: 'button', class: 'btn btn-ghost rc-open', 'data-test': 'change-open', 'aria-expanded': 'false', 'aria-controls': 'change-body',
    onclick: () => { body.hidden = !body.hidden; open.setAttribute('aria-expanded', String(!body.hidden)); if (!body.hidden) pick.focus(); } }, 'Mark a change');
  return h('section', { class: 'result-change', 'aria-label': 'Before and after a change', 'data-test': 'change-box' }, open, body);
}

// Extra steps and steps done again, listed in words; never dropped.
export function extrasCard(model) {
  const { extra, again, marked = [], words } = model.extras;
  if (!extra.length && !again.length && !marked.length) return null;
  // One folded line on screen (the table already marks each one); opened on paper.
  return h('details', { class: 'result-extras', 'data-test': 'result-extras' },
    h('summary', {}, h('b', {}, `Not as listed: ${words}`)),
    h('ul', {},
      extra.map((x) => h('li', {}, h('b', {}, `“${x.name}”`), ` (${x.role}): only on walk ${x.walk}${x.after ? `, after “${x.after}”` : ', before the first list step'}. Wait ${minWords(x.waitSec)} · ${minWords(x.workSec)} hands-on.`)),
      again.map((x) => h('li', {}, h('b', {}, `“${x.name}”`), `: done ${x.times} times on walk ${x.walk}. The table shows each time on its own.`)),
      marked.map((x) => h('li', { 'data-test': 'marked-again' }, h('b', {}, `“${x.name}”, done again`), ` (${x.role}): marked on walk ${x.walk}. Wait ${minWords(x.waitSec)} · ${minWords(x.workSec)} hands-on.`))),
    // Its own total is on the first result now (night 6 item 1, walk-again), not folded in here.
    h('p', { class: 'meta' }, 'A step not on the list stays on its own walk; the saved list is not changed.'));
}

const localDate = (iso) => { const d = new Date(iso); const two = (n) => String(n).padStart(2, '0'); return Number.isNaN(+d) ? '' : `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`; };

// The actions row: "Walk the next patient" first, then Print, Copy as text, Download CSV, and
// Share where the browser has it. text(): the plain-text summary, made when it is asked for.
export function actionsRow({ ctx, model, list, records, department, again, text }) {
  const copy = async () => {
    const t = text();
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(t);
      else {
        const ta = h('textarea', { class: 'copy-buffer', readonly: true, 'aria-hidden': 'true' }); ta.value = t; document.body.append(ta); ta.select();
        const ok = document.execCommand('copy'); ta.remove(); if (!ok) throw new Error('no copy');
      }
      ctx.toast('Copied as text. Paste it into a message or a note.');
    } catch { ctx.toast('Could not copy here. Use Print or Download CSV instead.'); }
  };
  const csv = () => {
    const body = csvOf({ title: model.title, department, deptId: model.deptId, list, records, dateOf: localDate, afterWalk: model.afterWalk });
    const url = URL.createObjectURL(new Blob(['﻿', body], { type: 'text/csv;charset=utf-8' }));
    const a = h('a', { href: url, download: fileNameOf(model.title), hidden: true });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    ctx.toast(`Downloaded ${fileNameOf(model.title)}.`);
  };
  const share = async () => {
    try { await navigator.share({ title: model.title, text: text() }); } catch (e) { if (e?.name !== 'AbortError') ctx.toast('Could not share here. Use Copy as text instead.'); }
  };
  const btn = (id, label, onclick) => h('button', { type: 'button', class: 'btn btn-ghost', 'data-test': id, onclick }, label);
  return h('section', { class: 'result-actions', 'aria-label': 'What to do with this result', 'data-test': 'result-actions' },
    again,
    h('div', { class: 'ra-row' },
      btn('result-print', 'Print', () => window.print()),
      btn('result-copy', 'Copy as text', copy),
      btn('result-csv', 'Download CSV', csv),
      typeof navigator.share === 'function' ? btn('result-share', 'Share', share) : null));
}

// The summary for Copy and Share, from what the page shows.
export function summaryOf({ model, headLines, headline, totals, read }) {
  return summaryText({
    head: headLines, headline, totals, count: model.walks.length,
    walks: model.walks.map((w) => `Walk ${w.n}${model.compare?.both ? (w.n > model.afterWalk ? ' (after the change)' : ' (before the change)') : ''}, ${w.when}: ${minWords(w.elapsed)} start to finish${w.note} · waiting ${minWords(w.wait)} · hands-on ${minWords(w.work)}${w.notSeen ? ` · ${minWords(w.notSeen)} not seen` : ''}. ${w.longest}`),
    columns: model.walks.map((w) => `walk ${w.n}`),
    rows: model.rows.map((r) => ({ extra: r.kind === 'extra', name: r.kind === 'extra' ? `${r.name} (${r.role}, not on the list)` : `${r.order}. ${r.name} (${r.role})`, cells: r.cells.map(cellWords) })),
    read,
    notes: [model.againAll, model.namesFrom],
    compare: compareLines(model),
  });
}
// The before-and-after table as lines of text, the same columns as on screen.
function compareLines(model) {
  const c = model.compare;
  if (!c) return null;
  if (!c.both) return [c.line];
  const line = (name, r) => `${name}: ${r.beforeText} | ${r.afterText} | ${r.diff.text}`;
  return [`Before and after (change marked after walk ${c.afterWalk}): ${c.heads.join(' | ')}`,
    ...c.rows.map((r) => line(r.kind === 'extra' ? `  + ${r.name} (${r.role}, not on the list)` : r.kind === 'again' ? `  ${r.order}. ${r.name}, done again (${r.role}, its later times on the same walk)`
      : `${r.order}. ${r.name} (${r.role}${r.againText ? `, ${r.againText.toLowerCase()}` : ''})`, r)),
    ...c.totals.map((t) => line(t.label, t)), c.caveat];
}
