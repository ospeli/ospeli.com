// Placeholder page for a module that is planned but not built yet, and the "Coming later (n)" box a
// built page uses for its own planned parts (navigation v2: planned things sit together, closed).
import { h } from './ui.js';

export function renderSoon(el, mod) {
  el.append(
    h('div', { class: 'page-head' },
      h('div', {},
        h('p', { class: 'eyebrow' }, 'Planned, not built yet'),
        h('h1', {}, mod.name),
        h('p', {}, mod.summary))),
    h('div', { class: 'card' },
      h('h2', {}, 'What this module is planned to do'),
      h('p', {}, mod.soon),
      h('p', { class: 'meta' }, 'Ospeli is built in the open. Each module runs on the same core: one hospital model, one event log and one audit trail.')),
    // A 44 px target, not a line of small link text (#187 item 4).
    h('p', { class: 'section' }, h('a', { class: 'btn btn-ghost', href: '#/journey', 'data-test': 'soon-back' }, 'Back to Journey')),
  );
}

// One closed "Coming later (n)" for a page's planned parts. `items`: { text, attrs } or null (left
// out); each text is set as text, never as HTML. Returns null when there is nothing planned.
export function laterBox(items, { test = 'page-coming-later' } = {}) {
  const list = items.filter(Boolean);
  if (!list.length) return null;
  return h('details', { class: 'card later-box', 'data-test': test },
    h('summary', {}, `Coming later (${list.length})`),
    h('ul', { class: 'later-list' }, list.map(({ text, attrs }) => h('li', attrs || {}, text))));
}
