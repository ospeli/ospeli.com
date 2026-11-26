// Ospeli app shell: storage, the department chip, the dock and routing (navigation v2:
// ospeli/ospeli docs/design/navigation-v2.md). The role is set under Me (modules/me.js).
import { Core } from './core/core.js';
import { openStorage } from './core/db.js';
import { roleById } from './core/model.js';
import { MODULES, moduleById, parseRoute } from './modules/registry.js';
import { renderSoon } from './modules/soon.js';
import { loadSyntheticHospital, currentHour, setupUnfinished } from './core/generator.js';
import { runCommand, listCommands, describeCommand, commandByName, CommandError } from './core/commands.js';
import { waitingDecisions, proposalWords } from './modules/proposals.js';
import { installDialogTapGuard, h } from './modules/ui.js';
import { DEPARTMENTS, departmentById, departmentShort, departmentForRole, ME_PAGES } from './modules/departments.js';
import { installRibbon } from './modules/ribbon.js';

const $ = (sel) => document.querySelector(sel);
const main = $('#main');
let cleanup = null;
let toastTimer = null;
let routeToken = 0;

// A short message over the hospital row of the top bar. `ms`: how long it shows (a brief note after
// a tap on the walk ribbon shows for less, #182 item 12).
export function toast(msg, ms = 3200) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

// Issue #52, in navigation v2: the Journey page says where an agent's proposal is waiting for this
// role (a count on the module's chip), and the dock's Journey item carries the total. Redrawn after
// every page change (a role change routes too) and whenever a proposal is made or decided.
let countToken = 0;
function countTag(a, n, words) {
  let tag = a.querySelector('.nav-count');
  if (!n) { tag?.remove(); return; }
  if (!tag) { tag = document.createElement('span'); tag.className = 'nav-count'; a.append(tag); }
  tag.textContent = String(n);
  tag.setAttribute('aria-label', words);
}
async function showWaiting(ctx) {
  const token = ++countToken;
  const { modules, total } = await waitingDecisions(ctx);
  if (token !== countToken) return;
  for (const a of document.querySelectorAll('#main .journey a[data-module]')) {
    const n = modules.find((x) => x.id === a.dataset.module)?.count || 0;
    countTag(a, n, `${proposalWords(n)} waiting for your decision`);
  }
  countTag($('#dock [data-dock="journey"]'), total, `${proposalWords(total)} waiting for your decision`);
}

// The role (job title) is set under Me (modules/me.js calls this). The same role chosen again
// changes nothing: no event, and the page is not drawn again under the person's hands (issue #95).
async function setRole(ctx, to, { why = null } = {}) {
  // A role a person chose (not one a department gave) is theirs: a department chosen later keeps it (#177 item 6).
  if (why !== 'department' && roleById(to)) ctx.roleChosen = true;
  if (!roleById(to) || to === ctx.role || ctx.site) return;
  const from = ctx.role;
  ctx.role = to;
  document.documentElement.dataset.role = to;
  await ctx.core.setMeta('role', to);
  await ctx.core.record(to, 'role.changed', null, why ? { from, to, why } : { from, to });
  toast(`Role: ${roleById(to).name}`);
  route(ctx);
}

// The department chip and its sheet (navigation v2). The department is where a person works; it
// is kept on this device. A first open asks for it; the chip changes it at any time.
function showDepartment(ctx) {
  const d = departmentById(ctx.department);
  $('#dept-name').textContent = d ? departmentShort(d) : 'Department';
  $('#dept-btn').setAttribute('aria-label', d ? `Department: ${d.name}. Change department` : 'Choose your department');
  if (d) document.documentElement.dataset.department = d.id; else delete document.documentElement.dataset.department;
}
// `walk`: "Walk a visit now" on the first-open sheet (#187 item 1): the department is set and the
// page drawn is Before you walk, the same place the homepage's "Try a walk" opens, in one tap.
async function setDepartment(ctx, id, { walk = false } = {}) {
  const d = departmentById(id);
  if (!d) return;
  if (walk && location.hash !== WALK_HASH) history.pushState(null, '', WALK_HASH);
  const from = ctx.department;
  const firstRole = !ctx.site && !ctx.roleChosen;
  if (id !== from) {
    ctx.department = id;
    showDepartment(ctx);
    await ctx.saveDepartment(id, from);
    toast(`Department: ${departmentShort(d)}`);
  }
  // A device where nobody has chosen a role yet starts with the department's usual one, so an
  // imaging department does not open as a ward nurse (UX review 22 Nov, finding 1). It is changed under Me.
  ctx.roleChosen = true;
  if (firstRole && d.role !== ctx.role) { await setRole(ctx, d.role, { why: 'department' }); return; }
  if (firstRole) await ctx.core.setMeta('role', ctx.role);
  if (id !== from || walk) route(ctx);
}
const WALK_HASH = '#/process/walk';
// On a first open (no department yet) each department has a second way out beside it, "Walk a visit
// now" (#187 item 1). Not when the page is already the walk (the homepage's "Try a walk"), where the
// department alone goes there, and not when the department is changed later from the chip.
function openDepartments(ctx) {
  const sheet = $('#dept-sheet');
  const offerWalk = !ctx.department && parseRoute(location.hash).id !== 'process';
  $('#dept-sheet').classList.toggle('has-walk', offerWalk);
  $('#dept-why').textContent = offerWalk
    ? 'Tap your department to see its pages. Or tap "Walk a visit now" beside it to time one patient\'s visit straight away. You can change the department at any time at the top of the screen.'
    : 'Ospeli shows your department\'s pages and words first. You can change this at any time at the top of the screen.';
  $('#dept-list').replaceChildren(...DEPARTMENTS.map((d) => {
    const pick = h('button', { type: 'button', class: `dept-opt${d.id === ctx.department ? ' is-on' : ''}`, 'data-dept': d.id,
      'aria-pressed': String(d.id === ctx.department), onclick: () => { sheet.close(); setDepartment(ctx, d.id); } },
    h('span', { class: 'dept-opt-name' }, d.name), h('span', { class: 'dept-opt-hint' }, d.hint),
    d.id === ctx.department ? h('span', { class: 'dept-opt-on' }, 'Chosen') : null);
    if (!offerWalk) return pick;
    return h('div', { class: 'dept-row' }, pick,
      h('button', { type: 'button', class: 'dept-walk', 'data-dept-walk': d.id, 'aria-label': `Walk a visit now, in ${d.name}`,
        onclick: () => { sheet.close(); setDepartment(ctx, d.id, { walk: true }); } }, 'Walk a visit now'));
  }));
  if (!sheet.open) sheet.showModal();
}
function buildShell(ctx) {
  showDepartment(ctx);
  document.documentElement.dataset.role = ctx.role;
  $('#dept-btn').addEventListener('click', () => openDepartments(ctx));
  // A tap on the dimmed page behind the sheet closes it, as Escape does.
  $('#dept-sheet').addEventListener('click', (e) => { if (e.target === e.currentTarget) e.currentTarget.close(); });
  // "Sun 22 Nov · 21:00" in the device's own date form; on a narrow phone the day's name gives way.
  const tick = () => {
    const now = new Date();
    const time = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    $('#top-time').replaceChildren(h('span', { class: 'top-day' }, `${now.toLocaleDateString(undefined, { weekday: 'short' })} `),
      h('span', { class: 'top-date' }, now.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })), ' · ', h('span', { class: 'top-clock' }, time));
  };
  tick();
  setInterval(tick, 20000);
  // The walk ribbon (issue #179): a running walk shows on every page but the walk itself.
  ctx.ribbon = installRibbon(ctx, { toast });
}
// Which dock item a page belongs to: its own, or Journey for a module page reached from there.
function dockFor(id, rest) {
  if (id === 'home') return 'home';
  if (id === 'process') return rest[0] === 'walk' ? 'walk' : 'maps';
  if (id === 'me' || ME_PAGES.includes(id)) return 'me';
  return 'journey';
}

installDialogTapGuard(); // issue #147: a quick extra tap never falls through a closed dialog

// Issue #108 part 1: a new release took over while this page was open (sw.js). The files already
// loaded are the old ones and the next page's file would be a new one, so the next change of page
// starts the app again on the new release, before any new module is loaded. Nothing is lost:
// what a person saved is in storage.
let newRelease = false;
if (navigator.serviceWorker?.controller) navigator.serviceWorker.addEventListener('controllerchange', () => { newRelease = true; });

async function route(ctx) {
  if (newRelease) { location.reload(); return; }
  const { id, rest } = parseRoute(location.hash);
  const mod = moduleById(id);
  const at = dockFor(id, rest);
  const exact = { home: 'home', journey: 'journey', me: 'me' }[id] === at || (id === 'process' && (at === 'walk' || !rest.length));
  for (const a of document.querySelectorAll('#dock a')) {
    if (a.dataset.dock === at) a.setAttribute('aria-current', exact ? 'page' : 'true'); else a.removeAttribute('aria-current');
  }
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
      pageCleanup = await view.render(page, { ...ctx, ...trackRuns(ctx.run), rest, toast, setRole: (to) => setRole(ctx, to) });
    } else {
      renderSoon(page, mod);
    }
  } catch (err) {
    // A page left while it loaded (another page, or a role change, started meanwhile) is thrown
    // away below: what went wrong for it is not this page's error (issue #95).
    if (token !== routeToken) return;
    console.error(err);
    page.innerHTML = '<div class="card notice"><h2>Something went wrong</h2><p>This page could not load. Your data is safe. Try again, or go back to <a href="#/home">Now</a>.</p></div>';
  }
  if (token !== routeToken) {
    if (typeof pageCleanup === 'function') { try { pageCleanup(); } catch { /* ignore */ } }
    return;
  }
  cleanup = pageCleanup;
  main.replaceChildren(...page.childNodes);
  // Which page is on screen now, and how many have been drawn: for the shell's styles and for tests
  // that must wait for a page to be drawn before they act.
  document.documentElement.dataset.route = `#/${[id, ...rest].join('/')}`;
  document.documentElement.dataset.drawn = String(Number(document.documentElement.dataset.drawn || 0) + 1);
  showWaiting(ctx);
  ctx.ribbon?.refresh();
  if (ctx.routed) main.focus({ preventScroll: true });
  ctx.routed = true;
  window.scrollTo(0, 0);
}

// What the person's own commands are doing, for pages that redraw when the data changes
// (modules/ui.js redrawOnChange): how many changes are being saved now, and two counters that say
// whether a read started after the last change was saved. Counters, not clock times: two things
// in the same millisecond still have an order. Each page gets its own (route() below), so a change
// still being saved by the page a person has just left is never taken for the new page's own.
function trackRuns(run) {
  const flow = { writing: 0, writeDoneAt: 0, readStartedAt: 0, n: 0 };
  const tracked = (name, input) => {
    // The card of agents' suggestions sits on many pages and reads and saves by itself; the page
    // around it does not redraw itself after it. So its commands are not counted, and the page
    // redraws when one of them changes the data.
    if (String(name).startsWith('ospeli_proposals_')) return run(name, input);
    if (commandByName(name)?.kind === 'read') { flow.readStartedAt = ++flow.n; return run(name, input); }
    flow.writing += 1;
    const done = () => { flow.writing -= 1; flow.writeDoneAt = ++flow.n; };
    let p;
    try { p = Promise.resolve(run(name, input)); } catch (err) { p = Promise.reject(err); }
    return p.then((out) => { done(); return out; }, (err) => { done(); throw err; });
  };
  return { run: tracked, flow };
}

// The badge says only what the stored data shows, never more (issue #5).
async function showSynthetic(core) {
  const badge = $('#synthetic-badge');
  const synthetic = (await core.getMeta('synthetic', null)) === true;
  const empty = (await core.listEntities('site')).length === 0;
  badge.classList.toggle('badge-synthetic', synthetic);
  badge.classList.toggle('badge-warn', !synthetic && !empty);
  badge.textContent = synthetic ? 'Synthetic data' : empty ? 'No data loaded' : 'Not marked synthetic';
  // Never a hospital's name beside "No data loaded" (issue #62).
  const name = $('.hospital-name');
  if (name) name.hidden = empty;
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
  const ctx = { core, role: who.device.role, storage: 'site', routed: false, site: link, device: who.device, roleChosen: true };
  ctx.run = (name, input) => link.run(name, input, ctx.role);
  // The department is this device's own setting: kept on the device, never sent to the site.
  // It starts as the department the device's role works in, so nothing is asked here.
  const keptDept = (await mirror.get('meta', 'device-department'))?.value;
  ctx.department = departmentById(keptDept) ? keptDept : departmentForRole(ctx.role);
  ctx.saveDepartment = (id) => mirror.put('meta', { id: 'device-department', value: id });
  let siteStorage = '';
  ctx.storageText = () => siteStorage;
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
  core.onChange(({ kind }) => { if (kind === 'proposals' || kind === 'reset') showWaiting(ctx); });

  // The role was chosen for this device at the server, so there is nothing to pick here.
  const fixed = document.createElement('span');
  fixed.className = 'role-fixed';
  fixed.dataset.test = 'device-role';
  fixed.textContent = roleById(ctx.role).name;
  $('#top-search').after(fixed);

  const bar = document.createElement('p');
  bar.className = 'site-bar';
  bar.setAttribute('role', 'status');
  bar.dataset.test = 'site-status';
  $('.topbar').append(bar); // in the top bar, which stays on screen while the page scrolls
  const hhmm = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const showLink = ({ connected, reason } = { connected: link.connected }) => {
    if (reason === 'needs-code') { location.reload(); return; }
    document.documentElement.dataset.site = connected ? 'connected' : 'offline';
    bar.hidden = connected;
    bar.textContent = connected ? '' : `Not connected. You see the information from ${link.lastAt ? hhmm(link.lastAt) : 'the last time this device was connected'}. You cannot save changes now.`;
    // The menu column starts under the top bar, which is taller while the line shows.
    if (connected) document.documentElement.style.removeProperty('--top');
    else document.documentElement.style.setProperty('--top', `${$('.topbar').offsetHeight}px`);
    siteStorage = connected ? `Connected. Changes are saved · ${who.device.label}` : `Not connected · ${who.device.label}`;
    const line = $('#storage-status');
    if (line) line.textContent = siteStorage;
  };
  link.onState(showLink);
  showLink();
  buildShell(ctx);
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

// Issue #87: a browser can clear a site's storage by itself (low space, long disuse). The app
// keeps a small marker outside its database, in localStorage and in Cache Storage: only the time
// the data was last seen here, nothing from the data. If the database comes back empty while a
// marker is still there, the data was cleared and the app says so. A wipe of every kind of
// storage at once cannot be told from a first visit.
const MARKER_KEY = 'ospeli-device-marker';
const MARKER_URL = './__device-marker';
async function readMarker() {
  const found = [];
  try { found.push(JSON.parse(localStorage.getItem(MARKER_KEY))); } catch { /* blocked or not JSON */ }
  try {
    const hit = await (await caches.open(MARKER_KEY)).match(MARKER_URL);
    if (hit) found.push(await hit.json());
  } catch { /* no Cache Storage here */ }
  const times = found.map((m) => m?.lastSeen).filter((x) => typeof x === 'string' && !Number.isNaN(Date.parse(x))).sort();
  return times.length ? { lastSeen: times.at(-1) } : null;
}
async function writeMarker(lastSeen) {
  const body = JSON.stringify({ lastSeen });
  try { localStorage.setItem(MARKER_KEY, body); } catch { /* blocked */ }
  try { await (await caches.open(MARKER_KEY)).put(MARKER_URL, new Response(body, { headers: { 'Content-Type': 'application/json' } })); } catch { /* no Cache Storage here */ }
}
const dayAndTime = (iso) => new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
// The notice sits in the top bar, in the page (not a toast), until a person closes it.
async function showDataLost(core) {
  const lost = await core.getMeta('data-lost', null);
  if (!lost || document.querySelector('[data-test="data-lost"]')) return;
  const bar = document.createElement('div');
  bar.className = 'site-bar device-notice';
  bar.setAttribute('role', 'alert');
  bar.dataset.test = 'data-lost';
  const text = document.createElement('span');
  text.textContent = `The browser cleared the data saved on this device. It was last here on ${dayAndTime(lost.lastSeen)}. A fresh example copy was loaded; anything entered on this device before is gone.`;
  const ok = document.createElement('button');
  ok.type = 'button'; ok.className = 'btn btn-ghost'; ok.textContent = 'OK';
  const top = () => document.documentElement.style.setProperty('--top', `${$('.topbar').offsetHeight}px`);
  ok.addEventListener('click', async () => {
    await core.setMeta('data-lost', null);
    bar.remove();
    document.documentElement.style.removeProperty('--top');
    main.focus();
  });
  bar.append(text, ok);
  $('.topbar').append(bar);
  top();
}

// Marks for the speed report (ospeli/ospeli#153): where a load's time goes. Only names and times;
// read with performance.getEntriesByType('mark'). Nothing is sent anywhere.
const mark = (name) => { try { performance.mark(`ospeli:${name}`); } catch { /* no marks here */ } };

async function boot() {
  mark('files-read');
  if (ON_SITE_SERVER) return bootOnSite();
  // The first page's own file is asked for now, while storage opens and the example site is made,
  // not after (ospeli/ospeli#153). route() below gets the same file from the browser's module map.
  moduleById(parseRoute(location.hash).id)?.load?.().catch(() => { /* route() reports it */ });
  const adapter = await openStorage('ospeli');
  const core = await Core.open({ adapter });
  mark('storage-open');
  // First run on this device: load the synthetic Example General Hospital.
  // If an earlier setup was interrupted, start it again so the hospital is never half loaded.
  const unfinished = await setupUnfinished(core);
  const emptyStore = !(await core.getMeta('firstRunDone')) && (await core.listEntities('site')).length === 0;
  // An empty database with a marker left behind: the browser cleared it (issue #87). A reset a
  // person chose keeps "firstRunDone", so it never lands here.
  const marker = adapter.kind === 'indexeddb' && emptyStore && !unfinished ? await readMarker() : null;
  if (unfinished || emptyStore) {
    main.innerHTML = '<p class="loading">Setting up Example General Hospital (synthetic data)…</p>';
    if (unfinished) await core.reset();
    await loadSyntheticHospital(core, { end: currentHour() });
    if (unfinished) await core.record('system', 'setup.restarted', null, { reason: 'previous setup did not finish' });
    if (marker) {
      await core.record('system', 'data.lost', null, { cause: 'browser storage cleared', lastSeen: marker.lastSeen });
      await core.setMeta('history-replaced', { at: core.now(), by: 'storage-cleared' });
      await core.setMeta('data-lost', { at: core.now(), lastSeen: marker.lastSeen });
    }
  }
  mark('site-stored');
  await core.setMeta('firstRunDone', true);
  if (adapter.kind === 'indexeddb') await writeMarker(core.now());
  const saved = await core.getMeta('role');
  const savedDept = await core.getMeta('department');
  const ctx = { core, role: roleById(saved) ? saved : 'ward-nurse', storage: adapter.kind, routed: false,
    roleChosen: !!roleById(saved), department: departmentById(savedDept) ? savedDept : null };
  // The department is a setting of this device. Like a change of role it goes in the audit trail
  // (who works where is not something that happened to a patient, so it is not in the event log).
  ctx.saveDepartment = async (id, from) => {
    await core.setMeta('department', id);
    await core.record(ctx.role, 'department.changed', null, { from: from || null, to: id });
  };
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
    // The third argument holds { agent, role, dryRun } and nothing else. An option this door does
    // not know is refused, never dropped: an agent that asks for a dry run and misspells it must
    // not write to a person's queue (issue #101).
    run: async (name, input = {}, options = {}) => {
      const allowed = ['agent', 'role', 'dryRun'];
      const example = '{ agent: "your-agent-name", role: "bed-manager", dryRun: true }';
      if (options === null || typeof options !== 'object' || Array.isArray(options)) {
        throw new CommandError('invalid-input', `The third argument must be an object of options, for example ${example}.`, { allowed });
      }
      const unknown = Object.keys(options).filter((k) => !allowed.includes(k));
      if (unknown.length) {
        throw new CommandError('invalid-input', `Unknown option${unknown.length > 1 ? 's' : ''}: ${unknown.map((k) => String(k).slice(0, 40)).join(', ')}. The options are ${allowed.join(', ')}, for example ${example}. Nothing was run.`, { allowed });
      }
      if (options.dryRun !== undefined && typeof options.dryRun !== 'boolean') {
        throw new CommandError('invalid-input', `dryRun must be true or false, for example ${example}. Nothing was run.`, { allowed });
      }
      const { agent = 'browser-agent', role = ctx.role, dryRun = false } = options;
      return runCommand(core, name, input, { type: 'agent', agent, role }, dryRun ? { dryRun: true } : {});
    },
  };
  if (testHookAllowed()) api.core = core;
  Object.defineProperty(window, 'ospeli', { value: Object.freeze(api), writable: false, configurable: false, enumerable: true });
  await showSynthetic(core);
  core.onChange(({ kind }) => { if (kind === 'reset' || kind === 'entities') showSynthetic(core); });
  core.onChange(({ kind }) => { if (kind === 'proposals' || kind === 'reset') showWaiting(ctx); });

  // Ask the browser to keep this site's data, and say what it answered (issue #87).
  let kept = false;
  try { kept = adapter.kind === 'indexeddb' && !!(await navigator.storage?.persist?.()); } catch { kept = false; }
  const storageText = adapter.kind !== 'indexeddb' ? 'Not saved: this browser blocks storage'
    : kept ? 'Saved on this device' : 'Saved on this device. The browser may clear it: export a backup.';
  ctx.storageText = () => storageText;
  await showDataLost(core);
  buildShell(ctx);
  window.addEventListener('hashchange', () => route(ctx));
  mark('shell-drawn');
  await route(ctx);
  document.documentElement.dataset.ready = 'true';
  mark('ready');
  // Navigation v2: a first open asks where the person works, not their job title.
  if (!ctx.department) openDepartments(ctx);

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => { /* the app still works online */ });
  }
}

boot().catch((err) => {
  console.error(err);
  main.innerHTML = '<div class="card notice"><h2>Ospeli could not start</h2><p>Reload the page. If this keeps happening, your browser may be blocking storage.</p></div>';
});
