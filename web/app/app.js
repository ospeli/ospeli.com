// Ospeli app shell: storage, role switcher, navigation and routing.
import { Core } from './core/core.js';
import { openStorage } from './core/db.js';
import { ROLES, roleById } from './core/model.js';
import { MODULES, moduleById, parseRoute } from './modules/registry.js';
import { renderSoon } from './modules/soon.js';
import { loadSyntheticHospital, currentHour, setupUnfinished } from './core/generator.js';
import { runCommand, listCommands, describeCommand } from './core/commands.js';

const $ = (sel) => document.querySelector(sel);
const main = $('#main');
let cleanup = null;
let toastTimer = null;
let routeToken = 0;

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

function setMenu(open, { focusButton = false } = {}) {
  $('#nav').classList.toggle('open', open);
  $('#menu-btn').setAttribute('aria-expanded', String(open));
  if (!open && focusButton) $('#menu-btn').focus();
}

// Escape closes the phone menu and returns focus to the Menu button (issue #8).
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && $('#nav').classList.contains('open')) setMenu(false, { focusButton: true });
});

async function route(ctx) {
  const { id, rest } = parseRoute(location.hash);
  const mod = moduleById(id);
  for (const a of document.querySelectorAll('#nav-list a')) {
    if (a.dataset.module === id) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  }
  setMenu(false);
  if (typeof cleanup === 'function') { try { cleanup(); } catch { /* ignore */ } }
  cleanup = null;
  // Render off-screen, then swap in only if no newer navigation started meanwhile, so two
  // quick route changes can never stack two pages in <main>.
  const token = ++routeToken;
  const page = document.createElement('div');
  page.className = 'page';
  document.title = `${mod.name} · Ospeli`;
  let pageCleanup = null;
  try {
    if (mod.load) {
      const view = await mod.load();
      pageCleanup = await view.render(page, { ...ctx, rest, toast });
    } else {
      renderSoon(page, mod);
    }
  } catch (err) {
    console.error(err);
    page.innerHTML = '<div class="card notice"><h2>Something went wrong</h2><p>This page could not load. Your data is safe. Try again, or go back to <a href="#/home">Today</a>.</p></div>';
  }
  if (token !== routeToken) {
    if (typeof pageCleanup === 'function') { try { pageCleanup(); } catch { /* ignore */ } }
    return;
  }
  cleanup = pageCleanup;
  main.replaceChildren(...page.childNodes);
  if (ctx.routed) main.focus({ preventScroll: true });
  ctx.routed = true;
  window.scrollTo(0, 0);
}

// The badge says only what the stored data shows, never more (issue #5).
async function showSynthetic(core) {
  const badge = $('#synthetic-badge');
  const synthetic = (await core.getMeta('synthetic', null)) === true;
  const empty = (await core.listEntities('site')).length === 0;
  badge.classList.toggle('badge-synthetic', synthetic);
  badge.classList.toggle('badge-warn', !synthetic && !empty);
  badge.textContent = synthetic ? 'Synthetic data' : empty ? 'No data loaded' : 'Not marked synthetic';
  badge.title = synthetic ? 'This is a fictional hospital. Every name and number is generated.'
    : empty ? 'Nothing is loaded on this device.' : 'The data on this device is not marked synthetic. This build is for synthetic data only.';
}

// Test hook (issue #16): only when a test runner set the flag before any page script ran, and
// only on a loopback address. Never on ospeli.com or a hospital's server name.
function testHookAllowed() {
  return window.__OSPELI_TEST__ === true && ['127.0.0.1', 'localhost', '[::1]'].includes(location.hostname);
}

async function boot() {
  const adapter = await openStorage('ospeli');
  const core = await Core.open({ adapter });
  // First run on this device: load the synthetic Example General Hospital.
  // If an earlier setup was interrupted, start it again so the hospital is never half loaded.
  const unfinished = await setupUnfinished(core);
  if (unfinished || (!(await core.getMeta('firstRunDone')) && (await core.listEntities('site')).length === 0)) {
    main.innerHTML = '<p class="loading">Setting up Example General Hospital (synthetic data)…</p>';
    if (unfinished) await core.reset();
    await loadSyntheticHospital(core, { end: currentHour() });
    if (unfinished) await core.record('system', 'setup.restarted', null, { reason: 'previous setup did not finish' });
  }
  await core.setMeta('firstRunDone', true);
  const saved = await core.getMeta('role');
  const ctx = { core, role: roleById(saved) ? saved : 'ward-nurse', storage: adapter.kind, routed: false };
  // People act through the same commands an agent would (backlog A2).
  ctx.run = (name, input) => runCommand(core, name, input, { type: 'human', role: ctx.role });
  // Read-and-propose API for browser agents: they act as a named agent for a role, are
  // audited as agents, need agent access switched on, and can only propose changes.
  // The core itself stays in module scope (issue #16): a page script cannot reach the event
  // log, the audit trail or the agent switches except through the commands. End-to-end tests
  // get the core only on a local address with a flag set before the app loads.
  const api = {
    version: '0.3.0',
    commands: () => listCommands(),
    describe: (name) => describeCommand(name),
    run: (name, input = {}, { agent = 'browser-agent', role = ctx.role } = {}) => runCommand(core, name, input, { type: 'agent', agent, role }),
  };
  if (testHookAllowed()) api.core = core;
  Object.defineProperty(window, 'ospeli', { value: Object.freeze(api), writable: false, configurable: false, enumerable: true });
  await showSynthetic(core);
  core.onChange(({ kind }) => { if (kind === 'reset' || kind === 'entities') showSynthetic(core); });

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
