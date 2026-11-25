// The Result tab of a walked map (walk-first week, crew night 3): one bar per walk split by step,
// the per-step table walk by walk, the extra and redone steps, and the actions row (Walk the next
// patient, Print, Copy as text, Download CSV, Share). Built from ospeli_maps_get and the walks'
// own records; every typed name goes on screen as text, never as HTML.
import { h } from './ui.js';
import { minWords, atLeastWords, NO_LONG_WAIT } from './result-words.js';
import { walkItems, longestPositions, resultTable, cellWords, extrasOf, columnsNote, csvOf, fileNameOf, summaryText } from './result-data.js';

export const PHONE_COLUMNS = 3;
export const PRINT_COLUMNS = 6;

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

const waitWord = (x) => (x.waitNotSeenSec > 0 ? atLeastWords(x.waitSec) : minWords(x.waitSec));
const placeOf = (x) => `${x.stoppedSec > 0 ? 'at' : 'before'} “${x.name}”`;

// The words under a walk's bar for its longest wait.
export function longestLine(items, pos, { usable = true } = {}) {
  if (!usable) return 'The phone\'s clock changed on this walk: no longest wait is named.';
  const at = pos.map((p) => items[p]);
  if (!at.length) return NO_LONG_WAIT(false);
  const reason = at.length === 1 && at[0].reason ? ` · ${at[0].reason}` : '';
  if (at.length === 1) return `Longest wait: ${waitWord(at[0])} ${placeOf(at[0])}${reason}`;
  return `Longest waits, tied: ${at.map((x) => `${waitWord(x)} ${placeOf(x)}`).join(' and ')}`;
}

// What every part of the Result tab needs. rg: ospeli_maps_get's range; records: one per walk;
// list: the saved step list (map.today.steps); oneWalkTop: the step ids of the longest wait on a
// one-walk map (the same rule as the headline); day, clock: the device's own date and time format.
export function resultModel({ m, rg, records, list, oneWalkTop = null, day, clock }) {
  const walks = records.map((r, i) => {
    const items = walkItems(list, r);
    const info = rg.walks[i] || {};
    const usable = !r.clockMoved && info.usable !== false;
    const pos = !usable ? [] : oneWalkTop ? items.filter((x) => x.onList && oneWalkTop.includes(x.stepId)).map((x) => x.p) : longestPositions(items, info.longest);
    const sum = (k) => items.reduce((n, x) => n + x[k], 0);
    const elapsed = sum('waitSec') + sum('workSec') + sum('waitNotSeenSec') + sum('workNotSeenSec');
    return { n: i + 1, rec: r, items, pos, usable, elapsed, wait: sum('waitSec'), work: sum('workSec'), notSeen: sum('waitNotSeenSec') + sum('workNotSeenSec'),
      when: r.startedAt ? `${day(r.startedAt)}, ${clock(r.startedAt)}` : '', note: r.clockMoved ? ' (may be wrong)' : r.stoppedEarly ? ' (stopped early)' : '',
      longest: longestLine(items, pos, { usable }) };
  });
  return { walks, rows: resultTable(list, records), extras: extrasOf(list, records), title: m.title };
}

// One bar per walk, on one shared scale (the longest walk is the full width). Inside a bar each
// step is its wait (hatched) then its hands-on time (solid), in the order they happened, with a
// thin gap between steps. The longest wait is outlined, and said in words under the bar.
export function barsCard(model) {
  const max = Math.max(1, ...model.walks.map((w) => w.elapsed));
  const any = (f) => model.walks.some((w) => w.items.some(f));
  const key = (cls, text) => h('span', { class: 'key' }, h('span', { class: `rsw ${cls}` }), text);
  return h('section', { class: 'card bars result-bars', 'aria-labelledby': 'bars-h', 'data-test': 'walk-bars' },
    h('h3', { id: 'bars-h' }, 'Where the time went'),
    model.walks.map((w) => {
      const total = w.elapsed || 1;
      const bar = h('div', { class: 'rbar', role: 'img', style: `width:${Math.max(8, (100 * w.elapsed) / max)}%`, 'data-test': 'bar-walk', 'data-sec': String(w.elapsed),
        'aria-label': `Walk ${w.n}: ${minWords(w.wait)} waiting and ${minWords(w.work)} hands-on, over ${w.items.length} ${w.items.length === 1 ? 'step' : 'steps'}.${w.notSeen ? ` ${minWords(w.notSeen)} more was not seen.` : ''} ${w.longest}` });
      w.items.forEach((x, k) => {
        const hot = w.pos.includes(x.p);
        const parts = [[x.planned ? 'p' : 'w', x.waitSec, hot], ['n', x.waitNotSeenSec], ['k', x.workSec], ['n', x.workNotSeenSec]].filter((s) => s[1] > 0);
        // Only the first part of a step leaves the thin gap after the step before.
        parts.forEach(([cls, sec, isHot], j) => bar.append(h('i', { class: `${cls}${isHot ? ' is-longest' : ''}${k && !j ? ' gap' : ''}`, style: `width:${(100 * sec) / total}%`,
          'data-step': x.stepId || `off:${x.name}`, ...(isHot ? { 'data-longest': 'true' } : {}) })));
      });
      return h('div', { class: 'bar-row' },
        h('span', { class: 'bar-label' }, `Walk ${w.n} · ${w.when} · ${minWords(w.elapsed)}${w.note}`), bar,
        h('p', { class: 'bar-longest', 'data-test': 'bar-longest' }, w.longest));
    }),
    h('p', { class: 'legend meta', 'data-test': 'bar-legend' },
      key('w', 'Waiting'), any((x) => x.planned && x.waitSec) ? key('p', 'Planned or required wait') : null, key('k', 'Hands-on'),
      any((x) => x.waitNotSeenSec || x.workNotSeenSec) ? key('n', 'Not seen') : null, key('w is-longest', 'Longest wait')));
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
    // A real table. On a phone its rows are laid out as blocks (the step above its cells), so the
    // table roles are also given in full: a screen reader still reads a table.
    h('table', { class: `rtable cols-${Math.min(count, PHONE_COLUMNS)}`, role: 'table' },
      h('caption', {}, h('b', {}, 'Step by step'), h('span', {}, ' Each cell: wait before the step · hands-on, in whole minutes.')),
      h('thead', { role: 'rowgroup' }, h('tr', { role: 'row' }, h('th', { scope: 'col', role: 'columnheader', class: 'rt-stephead' }, 'Step'), model.walks.map((w, k) => h('th', { scope: 'col', role: 'columnheader', class: colCls(k) }, `Walk ${w.n}`)))),
      h('tbody', { role: 'rowgroup' }, model.rows.map((r) => h('tr', { role: 'row', class: r.kind === 'extra' ? 'is-extra' : null, 'data-row': r.kind === 'extra' ? 'extra' : r.stepId },
        h('th', { scope: 'row', role: 'rowheader' },
          h('b', {}, r.kind === 'extra' ? `+ ${r.name}` : `${r.order}. ${r.name}`),
          h('span', { class: 'rt-role' }, ` · ${r.role}`),
          r.kind === 'extra' ? h('span', { class: 'rt-only', 'data-test': 'only-on' }, `Not on the list · Only on walk ${r.walk}`) : null),
        r.cells.map((c, k) => h('td', { role: 'cell', class: colCls(k), 'data-status': c.status, ...(c.status === 'timed' ? { 'data-sec': `${c.waitSec},${c.workSec}` } : {}) },
          c.status === 'not-on-walk' ? [h('span', { 'aria-hidden': 'true' }, '–'), h('span', { class: 'sr-only' }, 'not on this walk')] : cellWords(c),
          c.times > 1 ? h('span', { class: 'rt-again', 'data-test': 'done-again' }, `Done ${c.times} times`) : null)))))),
    after);
}

// Extra steps and steps done again, listed in words; never dropped.
export function extrasCard(model) {
  const { extra, again, words } = model.extras;
  if (!extra.length && !again.length) return null;
  // One folded line on screen (the table already marks each one); opened on paper.
  return h('details', { class: 'result-extras', 'data-test': 'result-extras' },
    h('summary', {}, h('b', {}, `Not as listed: ${words}`)),
    h('ul', {},
      extra.map((x) => h('li', {}, h('b', {}, `“${x.name}”`), ` (${x.role}): only on walk ${x.walk}${x.after ? `, after “${x.after}”` : ', before the first list step'}. Wait ${minWords(x.waitSec)} · ${minWords(x.workSec)} hands-on.`)),
      again.map((x) => h('li', {}, h('b', {}, `“${x.name}”`), `: done ${x.times} times on walk ${x.walk}. The table shows each time on its own.`))),
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
    const body = csvOf({ title: model.title, department, list, records, dateOf: localDate });
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
    walks: model.walks.map((w) => `Walk ${w.n}, ${w.when}: ${minWords(w.elapsed)} start to finish${w.note} · waiting ${minWords(w.wait)} · hands-on ${minWords(w.work)}${w.notSeen ? ` · ${minWords(w.notSeen)} not seen` : ''}. ${w.longest}`),
    columns: model.walks.map((w) => `walk ${w.n}`),
    rows: model.rows.map((r) => ({ extra: r.kind === 'extra', name: r.kind === 'extra' ? `${r.name} (${r.role}, not on the list)` : `${r.order}. ${r.name} (${r.role})`, cells: r.cells.map(cellWords) })),
    read,
  });
}
