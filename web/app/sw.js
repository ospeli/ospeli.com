// Ospeli app service worker: precache the shell so the app opens offline.
// Strategy: serve from cache at once, refresh the cache from the network in the background.
// Bump VERSION when the precache list changes. scripts/check.py checks that every file exists.
const VERSION = 'ospeli-app-v17';
const PRECACHE = [
  './',
  'index.html',
  'app.css',
  'app.js',
  'manifest.webmanifest',
  'core/audit.js',
  'core/core.js',
  'core/db.js',
  'core/generator.js',
  'core/kpi.js',
  'core/model.js',
  'core/beds.js',
  'core/schema.js',
  'core/commands.js',
  'core/workorders.js',
  'core/processmap.js',
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
  'modules/agents.js',
  'modules/connect.js',
  'fonts/nunito-latin-400-normal.woff2',
  'fonts/nunito-latin-600-normal.woff2',
  'fonts/nunito-latin-700-normal.woff2',
  'fonts/nunito-latin-800-normal.woff2',
  '../brand/ospeli_horizontal_color.svg',
  '../favicon.svg',
  '../brand/icons/ospeli_app_180.png',
  '../brand/icons/ospeli_app_192.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
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
