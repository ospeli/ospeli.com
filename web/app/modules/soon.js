// Placeholder page for a module that is planned but not built yet.
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
    h('p', { class: 'section' }, h('a', { href: '#/home' }, 'Back to Today')),
  );
}
