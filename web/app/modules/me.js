// Me (navigation v2): what is about the person and this device, not about the patient's journey.
// Role (job title), appearance, AI helpers with their off switches, data and audit, and what is
// coming later. The role is set here once; it is no longer asked on first open.
import { h } from './ui.js';
import { MODULES, moduleById } from './registry.js';
import { ROLES, roleById } from '../core/model.js';
import { departmentById, roleGroups } from './departments.js';

const row = (href, title, text, test) => h('a', { class: 'card me-row', href, 'data-test': test }, h('h2', {}, title), h('p', { class: 'meta' }, text));

export async function render(el, ctx) {
  const role = roleById(ctx.role);
  const dept = departmentById(ctx.department);
  const planned = MODULES.filter((m) => !m.load).length;
  const home = moduleById(role.home);
  // The AI helpers' setting now, in words, beside the way to it (#166 item 6). Ospeli works with it off.
  // null: the setting could not be read for this role, so the row does not claim one.
  let aiOn = null;
  try { aiOn = (await ctx.run('ospeli_agents_list', {})).dial === 'advise'; } catch { aiOn = null; }
  let roleBox;
  if (ctx.site) {
    // On a site's own server the role was chosen for this device there; nothing to pick here.
    roleBox = h('p', { class: 'me-role-fixed' }, role.name, h('span', { class: 'meta' }, ' · set for this device at your site\'s server'));
  } else {
    // Grouped by department, the chosen one first, each group with its heading (#166 item 3).
    const sel = h('select', { id: 'role-select', 'aria-label': 'Your role' }, roleGroups(ROLES.map((r) => r.id), ctx.department)
      .map((g) => h('optgroup', { label: g.label }, g.ids.map((id) => h('option', { value: id }, roleById(id).name)))));
    sel.value = ctx.role;
    sel.addEventListener('change', () => ctx.setRole(sel.value));
    roleBox = h('div', { class: 'field' }, h('label', { for: 'role-select' }, 'Your role (job title)'), sel);
  }
  el.append(
    h('div', { class: 'page-head' }, h('div', {},
      h('p', { class: 'eyebrow' }, 'Me'),
      h('h1', {}, role.name),
      h('p', {}, dept ? `Department: ${dept.name}. Change it at the top of the screen.` : 'No department chosen yet. Choose it at the top of the screen.'))),
    h('section', { class: 'card me-role', 'aria-labelledby': 'me-role-h', 'data-test': 'me-role' },
      h('h2', { id: 'me-role-h' }, 'Role'),
      h('p', { class: 'meta' }, 'Your role decides what you may record and approve. Set it once; change it here when your job changes.'),
      roleBox,
      home?.load ? h('p', { class: 'me-home' }, h('a', { href: `#/${home.id}`, 'data-test': 'me-role-home' }, `Open ${home.name}`)) : null),
    h('section', { class: 'card', 'aria-labelledby': 'me-look-h', 'data-test': 'me-appearance' },
      h('h2', { id: 'me-look-h' }, 'Appearance'),
      h('p', {}, 'Light. Ospeli stays light when a phone is set to dark.'),
      h('p', { class: 'meta' }, 'A dark theme is planned, not built yet.')),
    row('#/agents', 'AI helpers', `${aiOn == null ? '' : `Now: ${aiOn ? 'on, suggest only' : 'off'}. `}AI helpers (agents) can read and suggest; a person decides each time. Off until you turn it on. Open it: the off switch is first on the page.`, 'me-agents'),
    row('#/data', 'Data and audit', 'Export, import, reset and the audit trail.', 'me-data'),
    row('#/journey', `Coming later (${planned})`, 'Pages that are planned and not built yet. They are listed at the end of the Journey page.', 'me-later'),
    h('section', { class: 'card', 'aria-labelledby': 'me-dev-h' },
      h('h2', { id: 'me-dev-h' }, 'On this device'),
      h('p', { id: 'storage-status', 'data-test': 'storage-status' }, ctx.storageText())));
}
