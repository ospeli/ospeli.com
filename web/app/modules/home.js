// Today: the role's shortcuts first, then every module, then what is on this device.
import { h } from './ui.js';
import { MODULES, ROLE_MODULES, moduleById } from './registry.js';
import { roleById } from '../core/model.js';
import { loadSyntheticHospital, currentHour } from '../core/generator.js';

const card = (m) => h('a', { class: `card${m.load ? '' : ' is-soon'}`, href: `#/${m.id}` },
  h('h3', {}, m.name, m.load ? null : h('span', { class: 'pill pill-soon' }, `Week ${m.week}`)),
  h('p', { class: 'meta' }, m.summary));

export async function render(el, ctx) {
  const role = roleById(ctx.role);
  const mine = (ROLE_MODULES[ctx.role] || []).map(moduleById).filter(Boolean);
  const others = MODULES.filter((m) => m.id !== 'home' && !mine.includes(m));
  const [beds, wards, eventCount, auditCount] = await Promise.all([
    ctx.core.listEntities('bed'), ctx.core.listEntities('ward'), ctx.core.eventCount(), ctx.core.db.count('audit'),
  ]);

  el.append(
    h('div', { class: 'page-head' },
      h('div', {},
        h('p', { class: 'eyebrow' }, 'Today'),
        h('h1', {}, `${role.name}`),
        h('p', {}, 'Your shortcuts for this role. Change role at the top of the screen.'))),
    h('h2', {}, 'Your shortcuts'),
    h('div', { class: 'grid', 'data-test': 'role-shortcuts' }, mine.map(card)),
    h('section', { class: 'section', 'aria-labelledby': 'all-h' },
      h('h2', { id: 'all-h' }, 'All modules'),
      h('div', { class: 'grid' }, others.map(card))),
    h('section', { class: 'section', 'aria-labelledby': 'dev-h' },
      h('h2', { id: 'dev-h' }, 'On this device'),
      h('div', { class: 'stats' },
        h('div', { class: 'stat' }, h('b', {}, wards.length), h('span', {}, 'Wards')),
        h('div', { class: 'stat' }, h('b', {}, beds.length), h('span', {}, 'Beds')),
        h('div', { class: 'stat' }, h('b', {}, eventCount), h('span', {}, 'Events logged')),
        h('div', { class: 'stat' }, h('b', {}, auditCount), h('span', {}, 'Audit entries'))),
      beds.length ? null : h('div', { class: 'card notice section' },
        h('p', {}, 'No hospital is loaded on this device.'),
        h('button', { class: 'btn', type: 'button', onclick: async (ev) => {
          ev.target.disabled = true;
          ev.target.textContent = 'Loading…';
          await loadSyntheticHospital(ctx.core, { end: currentHour() });
          ctx.toast('Example General Hospital loaded');
          location.reload();
        } }, 'Load Example General Hospital'))),
  );
}
