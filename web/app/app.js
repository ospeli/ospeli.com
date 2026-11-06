// Ospeli app shell: storage, role switcher, navigation and routing.
import { Core } from './core/core.js';
import { openStorage } from './core/db.js';
import { ROLES, roleById } from './core/model.js';
import { MODULES, moduleById, parseRoute } from './modules/registry.js';
import { renderSoon } from './modules/soon.js';

const $ = (sel) => document.querySelector(sel);
const main = $('#main');
let cleanup = null;
let toastTimer = null;

export function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
}

function buildNav() {
  const list = $('#nav-list');
  list.replaceChildren(...MODULES.map((m) => {
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.href = `#/${m.id}`;
    a.dataset.module = m.id;
    a.textContent = m.name;
    if (!m.load) {
      const tag = document.createElement('span');
      tag.className = 'soon-tag';
      tag.textContent = `Week ${m.week}`;
      tag.setAttribute('aria-label', `coming in week ${m.week}`);
      a.append(tag);
    }
    li.append(a);
    return li;
  }));
}

function buildRoles(ctx) {
  const sel = $('#role-select');
  sel.replaceChildren(...ROLES.map((r) => new Option(r.name, r.id)));
  sel.value = ctx.role;
  sel.addEventListener('change', async () => {
    const to = sel.value;
    if (!roleById(to)) return;
    const from = ctx.role;
    ctx.role = to;
    await ctx.core.setMeta('role', to);
    await ctx.core.record(to, 'role.changed', null, { from, to });
    toast(`Role: ${roleById(to).name}`);
    route(ctx);
  });
}

function setMenu(open) {
  $('#nav').classList.toggle('open', open);
  $('#menu-btn').setAttribute('aria-expanded', String(open));
}

async function route(ctx) {
  const { id, rest } = parseRoute(location.hash);
  const mod = moduleById(id);
  for (const a of document.querySelectorAll('#nav-list a')) {
    if (a.dataset.module === id) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  }
  setMenu(false);
  if (typeof cleanup === 'function') { try { cleanup(); } catch { /* ignore */ } }
  cleanup = null;
  main.replaceChildren();
  document.title = `${mod.name} · Ospeli`;
  try {
    if (mod.load) {
      const view = await mod.load();
      cleanup = await view.render(main, { ...ctx, rest, toast });
    } else {
      renderSoon(main, mod);
    }
  } catch (err) {
    console.error(err);
    main.innerHTML = '<div class="card notice"><h2>Something went wrong</h2><p>This page could not load. Your data is safe. Try again, or go back to <a href="#/home">Today</a>.</p></div>';
  }
  if (ctx.routed) main.focus({ preventScroll: true });
  ctx.routed = true;
  window.scrollTo(0, 0);
}

async function boot() {
  const adapter = await openStorage('ospeli');
  const core = await Core.open({ adapter });
  const saved = await core.getMeta('role');
  const ctx = { core, role: roleById(saved) ? saved : 'ward-nurse', storage: adapter.kind, routed: false };
  window.ospeli = { core, version: '0.1.0' }; // handy for debugging and end-to-end tests

  $('#storage-status').textContent = adapter.kind === 'indexeddb'
    ? 'Saved on this device'
    : 'Not saved: this browser blocks storage';
  buildNav();
  buildRoles(ctx);
  $('#menu-btn').addEventListener('click', () => setMenu(!$('#nav').classList.contains('open')));
  window.addEventListener('hashchange', () => route(ctx));
  await route(ctx);
  document.documentElement.dataset.ready = 'true';

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => { /* the app still works online */ });
  }
}

boot().catch((err) => {
  console.error(err);
  main.innerHTML = '<div class="card notice"><h2>Ospeli could not start</h2><p>Reload the page. If this keeps happening, your browser may be blocking storage.</p></div>';
});
