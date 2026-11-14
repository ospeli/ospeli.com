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
      tag.textContent = 'Planned';
      tag.setAttribute('aria-label', 'planned, not built yet');
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

// Opened from a site's own server (tools/ospeli-server marks the page): this device shows that
// site's information and sends every change to it. The role is the one chosen for this device
// at the server. Nothing is loaded into the browser from the made-up hospital.
const ON_SITE_SERVER = !!document.querySelector('meta[name="ospeli-site-server"]');

async function bootOnSite() {
  const { MirrorAdapter, SiteLink } = await import('./core/site.js');
  const { renderConnect } = await import('./modules/connect.js');
  const mirror = new MirrorAdapter(await openStorage('ospeli-site'));
  const link = new SiteLink({ mirror });
  let who = await link.session();
  if (who.needsCode) {
    await mirror.wipe(); // nothing from an earlier connection stays on a device that must ask again
    document.documentElement.dataset.site = 'connect'; // one task on this screen: no menu, no role, no badge
    document.documentElement.dataset.ready = 'connect';
    who = await renderConnect(main, link);
    main.innerHTML = '<p class="loading">Opening Ospeli…</p>';
    delete document.documentElement.dataset.site;
  }
  const remembered = await mirror.get('meta', 'site-device');
  if (who.offline) {
    if (!remembered?.value || !(await mirror.syncState())) {
      main.innerHTML = '<div class="card notice" data-test="site-unreachable"><h2>Not connected</h2><p>This device cannot reach Ospeli on your site right now. Check the Wi-Fi, then try again.</p><p class="actions"><button class="btn" type="button" id="site-retry">Try again</button></p></div>';
      $('#site-retry').addEventListener('click', () => location.reload());
      document.documentElement.dataset.ready = 'offline';
      return;
    }
    who = { device: remembered.value };
  } else {
    await mirror.put('meta', { id: 'site-device', value: who.device });
  }
  const core = await Core.open({ adapter: mirror });
  link.core = core;
  if (link.connected) await link.pull();
  const ctx = { core, role: who.device.role, storage: 'site', routed: false, site: link, device: who.device };
  ctx.run = (name, input) => link.run(name, input, ctx.role);
  // Agents do not come in through the page here: they use their own key over the site's API.
  const api = {
    version: '0.4.0',
    commands: () => listCommands(),
    describe: (name) => describeCommand(name),
    run: async () => { throw new Error('On a site server, an agent uses its own key over the API (GET /api/v1/whoami). The page has no agent door.'); },
  };
  if (testHookAllowed()) api.core = core;
  Object.defineProperty(window, 'ospeli', { value: Object.freeze(api), writable: false, configurable: false, enumerable: true });
  await showSynthetic(core);
  core.onChange(({ kind }) => { if (kind === 'reset' || kind === 'entities') showSynthetic(core); });

  // The role was chosen for this device at the server, so there is nothing to pick here.
  const fixed = document.createElement('span');
  fixed.className = 'role-fixed';
  fixed.dataset.test = 'device-role';
  fixed.textContent = roleById(ctx.role).name;
  $('#role-select').closest('label').replaceWith(fixed);

  const bar = document.createElement('p');
  bar.className = 'site-bar';
  bar.setAttribute('role', 'status');
  bar.dataset.test = 'site-status';
  $('.topbar').append(bar); // in the top bar, which stays on screen while the page scrolls
  const hhmm = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const showLink = ({ connected, reason } = { connected: link.connected }) => {
    if (reason === 'needs-code') { location.reload(); return; }
    document.documentElement.dataset.site = connected ? 'connected' : 'offline';
    bar.hidden = connected;
    bar.textContent = connected ? '' : `Not connected. You see the information from ${link.lastAt ? hhmm(link.lastAt) : 'the last time this device was connected'}. You cannot save changes now.`;
    // The menu column starts under the top bar, which is taller while the line shows.
    if (connected) document.documentElement.style.removeProperty('--top');
    else document.documentElement.style.setProperty('--top', `${$('.topbar').offsetHeight}px`);
    $('#storage-status').textContent = connected ? `Connected. Changes are saved. ${who.device.label}.` : `Not connected. ${who.device.label}.`;
  };
  link.onState(showLink);
  showLink();
  buildNav();
  $('#menu-btn').addEventListener('click', () => setMenu(!$('#nav').classList.contains('open')));
  window.addEventListener('hashchange', () => route(ctx));
  // A connected device opens on its role's own screen: the job is one tap away, not a menu away.
  if (!location.hash || location.hash === '#/') history.replaceState(null, '', `#/${roleById(ctx.role).home}`);
  await route(ctx);
  document.documentElement.dataset.ready = 'true';
  // Keep the copy fresh while the page is in view, and at once when the device comes back.
  setInterval(() => { if (document.visibilityState === 'visible') link.pull(); }, 4000);
  window.addEventListener('online', () => link.pull());
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') link.pull(); });
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => { /* the app still works online */ });
  }
}

async function boot() {
  if (ON_SITE_SERVER) return bootOnSite();
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
    version: '0.4.0',
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
