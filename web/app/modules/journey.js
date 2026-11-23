// Journey (navigation v2): every page of the app, laid out along the patient's journey. It replaces
// the long menu. Search at the top; a spine of stages with the modules that serve each; then what
// keeps the place running and what helps people see and improve. Planned modules appear only
// under "Coming later", closed until a person opens it.
import { h } from './ui.js';
import { MODULES, moduleById } from './registry.js';
import { departmentById, JOURNEY, KEEPS_RUNNING, SEE_AND_IMPROVE, CHIP_NAMES } from './departments.js';

export async function render(el, ctx) {
  const dept = departmentById(ctx.department);
  const built = (ids) => ids.map(moduleById).filter((m) => m && m.load);
  const planned = MODULES.filter((m) => !m.load);
  const chip = (m) => h('a', { class: `j-chip${dept?.module === m.id ? ' is-mine' : ''}`, href: `#/${m.id}`, 'data-module': m.id, 'data-words': `${m.name} ${CHIP_NAMES[m.id] || ''} ${m.summary}`.toLowerCase(),
    title: m.summary }, h('span', { class: 'j-chip-name' }, CHIP_NAMES[m.id] || m.name),
  dept?.module === m.id ? h('span', { class: 'j-mine' }, 'Your department') : null);

  const search = h('input', { type: 'search', id: 'journey-search', class: 'j-search', 'data-test': 'journey-search', placeholder: 'Search pages', 'aria-label': 'Search pages', autocomplete: 'off', enterkeyhint: 'search' });
  const none = h('p', { class: 'meta', 'data-test': 'journey-none', hidden: true, role: 'status' }, 'No page matches. Try another word.');
  const later = h('details', { class: 'j-later', 'data-test': 'coming-later' },
    h('summary', {}, `Coming later (${planned.length})`),
    h('p', { class: 'meta' }, 'Planned, not built yet. Each opens a short note on what it is planned to do.'),
    h('div', { class: 'j-chips' }, planned.map((m) => h('a', { class: 'j-chip is-planned', href: `#/${m.id}`, 'data-module': m.id, 'data-planned': 'true', 'data-words': `${m.name} ${m.summary}`.toLowerCase() },
      h('span', { class: 'j-chip-name' }, m.name), h('span', { class: 'soon-tag' }, 'Planned')))));

  const spine = h('ol', { class: 'j-spine', 'data-test': 'journey-spine' }, JOURNEY.map((s) => h('li', { class: `j-stage j-${s.id}` },
    h('span', { class: 'j-marker', 'aria-hidden': 'true' }, s.forward ? '→' : ''),
    h('h2', {}, s.name),
    h('div', { class: 'j-chips' }, built(s.modules).map(chip)))));
  const running = h('section', { class: 'card j-box', 'aria-labelledby': 'j-run-h' },
    h('h2', { id: 'j-run-h' }, 'Keeps it running'),
    h('div', { class: 'j-chips' }, built(KEEPS_RUNNING).map(chip)));
  const improve = h('section', { class: 'card j-box', 'aria-labelledby': 'j-imp-h' },
    h('h2', { id: 'j-imp-h' }, 'See and improve'),
    h('div', { class: 'j-chips' }, built(SEE_AND_IMPROVE).map(chip)),
    planned.length ? later : null);

  // The page's own box: `el` is emptied into the screen by the shell, so it cannot be searched later.
  const wrap = h('div', { class: 'journey', 'data-test': 'journey' }, search, none, spine, running, improve);
  const filter = () => {
    const q = search.value.trim().toLowerCase();
    let shown = 0;
    for (const a of wrap.querySelectorAll('.j-chip')) { const hit = !q || a.dataset.words.includes(q); a.hidden = !hit; if (hit) shown += 1; }
    // A search opens "Coming later" when a planned page matches, and closes it again when the box is cleared.
    later.open = !!q && [...later.querySelectorAll('.j-chip')].some((a) => !a.hidden);
    for (const st of wrap.querySelectorAll('.j-stage, .j-box')) st.classList.toggle('is-empty', !!q && ![...st.querySelectorAll('.j-chip')].some((a) => !a.hidden));
    none.hidden = shown > 0;
  };
  search.addEventListener('input', filter);

  el.append(
    h('div', { class: 'page-head' }, h('div', {},
      h('p', { class: 'eyebrow' }, 'Journey'),
      h('h1', {}, 'Every page, along the patient\'s journey'),
      h('p', {}, dept ? `Your department: ${dept.name}. Change it at the top of the screen.` : 'Choose your department at the top of the screen.'))),
    wrap);
  // Opened from Search in the top bar: the box is ready to type in.
  if (ctx.rest[0] === 'search') setTimeout(() => search.focus(), 0);
}
