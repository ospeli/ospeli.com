// Now (navigation v2): the department's pages first, then the role's, the key numbers, and what is
// on this device. Every other page is on the Journey page; planned pages are listed only there.
// The flow strip and "Needs you, in flow order" come next (docs/briefs/2026-11-22-walk-first.md).
import { h } from './ui.js';
import { shortcutsFor, moduleById, ROLE_MODULES } from './registry.js';
import { departmentById } from './departments.js';
import { roleById } from '../core/model.js';
import { loadSyntheticHospital, currentHour } from '../core/generator.js';
import { kpiContext, kpiTiles } from './kpi-tiles.js';
import { KPIS } from '../core/kpi.js';
import { waitingDecisions, proposalWords } from './proposals.js';

const card = (m) => h('a', { class: `card${m.load ? '' : ' is-soon'}`, href: `#/${m.id}` },
  h('h3', {}, m.name, m.load ? null : h('span', { class: 'pill pill-soon' }, 'Planned')),
  h('p', { class: 'meta' }, m.summary));

export async function render(el, ctx) {
  const role = roleById(ctx.role);
  const dept = departmentById(ctx.department);
  // The department's pages first, then the role's own; each page once, built pages only.
  const builtPages = (ids) => ids.map(moduleById).filter((m) => m && m.load);
  const mine = dept ? [...new Set([...builtPages(dept.pinned), ...builtPages(ROLE_MODULES[ctx.role] || [])])] : shortcutsFor(ctx.role);
  // KPIs this role owns first, then the rest.
  const kpiIds = [...KPIS.filter((k) => k.owner === ctx.role), ...KPIS.filter((k) => k.owner !== ctx.role)].map((k) => k.id);
  const synthetic = (await ctx.core.getMeta('synthetic', null)) === true;
  const [beds, wards, eventCount, auditCount] = await Promise.all([
    ctx.core.listEntities('bed'), ctx.core.listEntities('ward'), ctx.core.eventCount(), ctx.core.db.count('audit'),
  ]);

  // On a phone the role's shortcuts come first, so the day's first tap is on the first screen
  // (issue #10); wider screens keep Key numbers first.
  const phone = window.matchMedia('(max-width: 640px)').matches;
  const keyNumbers = beds.length ? h('section', { class: 'section', style: phone ? null : 'margin-top:0', 'aria-labelledby': 'kpi-h' },
    h('h2', { id: 'kpi-h' }, 'Key numbers'),
    h('p', { class: 'meta' }, 'Last 7 days, calculated from the event log. Tap a number to see how it is defined.'),
    kpiTiles(kpiIds, await kpiContext(ctx.core))) : null;
  const shortcuts = [
    h('h2', { class: 'section', style: phone ? 'margin-top:0' : null }, 'Your pages'),
    h('div', { class: 'grid', 'data-test': 'role-shortcuts' }, mine.map(card)),
  ];

  // Issue #52: a decision an agent is waiting for is the first thing on Today, with one tap to
  // the page where it is made. Nothing is drawn when nothing waits for this role.
  const waitingBox = h('div', {});
  const drawWaiting = async () => {
    const { total, pages } = await waitingDecisions(ctx);
    if (!total) { waitingBox.replaceChildren(); return; }
    waitingBox.replaceChildren(h('section', { class: 'card decisions', 'data-test': 'decisions-waiting', 'aria-labelledby': 'dec-h' },
      h('h2', { id: 'dec-h' }, `Waiting for your decision (${total})`),
      h('p', { class: 'meta' }, 'An agent suggested these. Nothing changes until a person accepts or declines.'),
      h('ul', { class: 'decision-list' }, pages.map((x) => h('li', {},
        h('a', { href: x.href }, `${moduleById(x.id).name}${x.screenName ? `, ${x.screenName}` : ''}: ${proposalWords(x.count)}`))))));
  };
  await drawWaiting();
  const off = ctx.core.onChange(({ kind }) => { if (kind === 'proposals' || kind === 'reset') drawWaiting(); });

  // Element.append would print a null child as the word "null" (issue #7), so drop them.
  el.append(...[
    h('div', { class: 'page-head' },
      h('div', {},
        h('p', { class: 'eyebrow' }, 'Now'),
        h('h1', {}, dept ? dept.name : 'Choose your department'),
        h('p', { 'data-test': 'now-role' }, `${role.name}. Every other page is under Journey; your role is under Me.`))),
    waitingBox,
    ...(phone ? [...shortcuts, keyNumbers] : [keyNumbers, ...shortcuts]),
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
    synthetic ? h('p', { class: 'meta now-foot', 'data-test': 'now-foot' }, 'Synthetic demo data · no real patients or sites') : null,
  ].filter(Boolean));
  return off;
}
