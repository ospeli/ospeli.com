// Ospeli app service worker: precache the shell so the app opens offline.
// Strategy: serve from cache at once, refresh the cache from the network in the background.
// Bump VERSION when the precache list changes. scripts/check.py checks that every file exists.
const VERSION = 'ospeli-app-v62';
const PRECACHE = [
  './',
  'index.html',
  'app.css',
  'app.js',
  'manifest.webmanifest',
  'core/audit.js',
  'core/locked-file.js',
  'core/core.js',
  'core/db.js',
  'core/generator.js',
  'core/kpi.js',
  'core/model.js',
  'core/beds.js',
  'core/schema.js',
  'core/commands.js',
  'core/kit.js',
  'core/modules.js',
  'core/tasks.js',
  'core/task-commands.js',
  'core/stock.js',
  'core/stock-commands.js',
  'core/slots.js',
  'core/slot-commands.js',
  'core/codes.js',
  'core/code-commands.js',
  'core/workorders.js',
  'core/processmap.js',
  'core/walk.js',
  'core/site.js',
  'modules/registry.js',
  'modules/ui.js',
  'modules/soon.js',
  'modules/home.js',
  'modules/data.js',
  'modules/kpi-tiles.js',
  'modules/proposals.js',
  'modules/engineering.js',
  'modules/beds.js',
  'modules/process.js',
  'modules/walk.js',
  'modules/agents.js',
  'modules/connect.js',
  'modules/feedback/commands.js',
  'modules/feedback/logic.js',
  'modules/feedback/view.js',
  'modules/feedback/style.css',
  'modules/support/commands.js',
  'modules/support/logic.js',
  'modules/support/view.js',
  'modules/support/style.css',
  'modules/stores/commands.js',
  'modules/stores/logic.js',
  'modules/stores/view.js',
  'modules/stores/style.css',
  'modules/facilities/commands.js',
  'modules/facilities/logic.js',
  'modules/facilities/view.js',
  'modules/facilities/style.css',
  'modules/transfers/commands.js',
  'modules/transfers/logic.js',
  'modules/transfers/view.js',
  'modules/transfers/style.css',
  'fonts/nunito-latin-400-normal.woff2',
  'fonts/nunito-latin-600-normal.woff2',
  'fonts/nunito-latin-700-normal.woff2',
  'fonts/nunito-latin-800-normal.woff2',
  '../brand/ospeli_horizontal_color.svg',
  '../favicon.svg',
  '../brand/icons/ospeli_app_180.png',
  '../brand/icons/ospeli_app_192.png',
];

const APP_PAGE = new URL('./', self.location).pathname;
const APP_PAGES = [APP_PAGE, `${APP_PAGE}index.html`];

self.addEventListener('install', (event) => {
  // 'reload': each file straight from the host, never a copy the browser kept from the release
  // before (a static host may let browsers keep files for ten minutes; issue #108 part 3).
  event.waitUntil(caches.open(VERSION).then((c) => c.addAll(PRECACHE.map((p) => new Request(p, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k.startsWith('ospeli-app-') && k !== VERSION).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  // A site server's live answers (/api/v1/…) are never served from the cache.
  if (new URL(req.url).pathname.startsWith('/api/')) return;
  // Only the app's own page is kept as "the app page". Any other address typed or linked to
  // under /app/ (one of the app's files, or a page that does not exist) is answered by the
  // network, so it can never be saved in the app page's place.
  if (req.mode === 'navigate' && !APP_PAGES.includes(new URL(req.url).pathname)) return;
  event.respondWith((async () => {
    const cache = await caches.open(VERSION);
    const key = req.mode === 'navigate' ? new URL('./', self.location).href : req;
    const cached = await cache.match(key, { ignoreSearch: req.mode === 'navigate' });
    const network = fetch(req).then((res) => {
      if (res.ok && res.type === 'basic') cache.put(key, res.clone());
      return res;
    }).catch(() => null);
    if (cached) { event.waitUntil(network); return cached; }
    return (await network) || new Response('Offline and not cached yet.', { status: 503, headers: { 'Content-Type': 'text/plain' } });
  })());
});
