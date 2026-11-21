// Speed and smoothness report (ospeli/ospeli#153): measures, on a mid-range phone profile, the
// first load, a repeat load and the time from a tap on each built page's menu link to that page
// being drawn. It prints a table and the budgets beside it. It measures only: it never fails a
// build. Synthetic example data; a local static server; nothing leaves this machine.
//   node scripts/speed-report.mjs            the phone profile (360 px, processor 4x slower, 1.6 Mbit/s, 150 ms)
//   node scripts/speed-report.mjs --json     the same numbers as JSON
// The local server sends files uncompressed, so the first load is measured twice: as the local
// server sends the files, and compressed as a static host sends them. Both sizes are printed.
import { createRequire } from 'node:module';
import http from 'node:http';
import zlib from 'node:zlib';
import { createServer } from './serve.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
export const BUDGET = { firstLoadMs: 2000, pageChangeMs: 300 };
const PROFILE = { width: 360, height: 780, cpu: 4, downKbps: 1600, upKbps: 750, latencyMs: 150 };

// A static host compresses text files; the local server does not. With gzip: true the files pass
// through gzip on the way out, as they do from the public host, so the download is like for like.
function compressing(inner) {
  return http.createServer((req, res) => {
    http.get({ host: '127.0.0.1', port: inner.address().port, path: req.url }, (up) => {
      const type = String(up.headers['content-type'] || '');
      const chunks = [];
      up.on('data', (c) => chunks.push(c));
      up.on('end', () => {
        const body = Buffer.concat(chunks);
        if (up.statusCode === 200 && /javascript|css|html|json|svg|text/.test(type)) res.writeHead(200, { 'Content-Type': type, 'Content-Encoding': 'gzip', 'Cache-Control': 'no-cache' }).end(zlib.gzipSync(body));
        else res.writeHead(up.statusCode, up.headers).end(body);
      });
    }).on('error', () => res.writeHead(502).end());
  });
}

export async function measure({ runs = 2, gzip = false, pages = true } = {}) {
  const inner = createServer();
  await new Promise((r) => inner.listen(0, '127.0.0.1', r));
  const server = gzip ? compressing(inner) : inner;
  if (gzip) await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const appUrl = `http://127.0.0.1:${server.address().port}/app/`;
  const browser = await chromium.launch();
  const out = { profile: PROFILE, budget: BUDGET, firstLoadMs: [], firstPaintMs: [], repeatLoadMs: [], transferKb: [], requests: [], setupMs: [], pages: {} };
  try {
    for (let i = 0; i < runs; i++) {
      const context = await browser.newContext({ viewport: { width: PROFILE.width, height: PROFILE.height }, hasTouch: true, isMobile: true });
      const page = await context.newPage();
      const cdp = await context.newCDPSession(page);
      await cdp.send('Network.enable');
      await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: PROFILE.latencyMs, downloadThroughput: (PROFILE.downKbps * 1000) / 8, uploadThroughput: (PROFILE.upKbps * 1000) / 8 });
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: PROFILE.cpu });
      let bytes = 0; let requests = 0; let counting = true;
      cdp.on('Network.loadingFinished', (e) => { if (counting) { bytes += e.encodedDataLength; requests += 1; } });
      let t0 = Date.now();
      await page.goto(appUrl);
      await page.waitForSelector('html[data-ready="true"]', { timeout: 120000 });
      out.firstLoadMs.push(Date.now() - t0); counting = false;
      out.transferKb.push(Math.round(bytes / 1000)); out.requests.push(requests);
      out.firstPaintMs.push(Math.round(await page.evaluate(() => performance.getEntriesByName('first-contentful-paint')[0]?.startTime || 0)));
      // The part of the first load spent after the files arrived (making and storing the example site).
      out.setupMs.push(Math.round(await page.evaluate(() => { const nav = performance.getEntriesByType('navigation')[0]; const last = Math.max(...performance.getEntriesByType('resource').filter((r) => /\.(js|css)$/.test(r.name)).map((r) => r.responseEnd)); return performance.now() - Math.max(last, nav.domContentLoadedEventEnd); })));
      // Let the offline cache finish filling before the repeat load.
      await page.waitForFunction(() => navigator.serviceWorker?.controller || navigator.serviceWorker?.ready.then(() => true), null, { timeout: 120000 }).catch(() => {});
      await page.waitForTimeout(3000);
      t0 = Date.now();
      await page.reload();
      await page.waitForSelector('html[data-ready="true"]', { timeout: 120000 });
      out.repeatLoadMs.push(Date.now() - t0);
      // Every built page: tap its menu link, time until the page's own heading is drawn.
      const ids = await page.evaluate(() => [...document.querySelectorAll('nav a[href^="#/"]')].filter((a) => !a.querySelector('.soon-tag')).map((a) => a.getAttribute('href').slice(2)));
      for (const id of i === 0 && pages ? ids : []) { // page changes are timed on the first run only
        for (const pass of ['first', 'again']) {
          await page.evaluate(() => { location.hash = '#/data'; });
          await page.waitForTimeout(1500); // the page before settles
          const ms = await page.evaluate((to) => new Promise((resolve) => {
            const main = document.querySelector('main'); const before = main.querySelector('h1')?.textContent; const t = performance.now();
            const done = () => { const h1 = main.querySelector('h1'); if (h1 && h1.textContent !== before && !main.querySelector('[aria-busy="true"]')) { obs.disconnect(); requestAnimationFrame(() => resolve(Math.round(performance.now() - t))); } };
            const obs = new MutationObserver(done); obs.observe(main, { childList: true, subtree: true, characterData: true });
            setTimeout(() => { obs.disconnect(); resolve(null); }, 10000);
            location.hash = `#/${to}`;
          }), id);
          if (id !== 'data') (out.pages[id] ||= { first: [], again: [] })[pass].push(ms);
        }
      }
      await context.close();
    }
  } finally { await browser.close(); await new Promise((r) => server.close(r)); if (gzip) await new Promise((r) => inner.close(r)); }
  return out;
}

const worst = (list) => Math.max(...list.filter((x) => x != null));
if (import.meta.url === `file://${process.argv[1]}`) {
  const out = await measure();
  const zipped = await measure({ gzip: true, pages: false });
  if (process.argv.includes('--json')) { console.log(JSON.stringify({ ...out, compressed: zipped }, null, 1)); process.exit(0); }
  const s = (ms) => `${(ms / 1000).toFixed(1)} s`;
  const mark = (ms, budget) => (ms <= budget ? 'within' : 'OVER');
  console.log(`Phone profile: ${PROFILE.width} px, processor ${PROFILE.cpu}x slower, ${PROFILE.downKbps / 1000} Mbit/s, ${PROFILE.latencyMs} ms. Worst of ${out.firstLoadMs.length} runs.`);
  console.log(`First load to ready   ${s(worst(out.firstLoadMs))}   budget ${s(BUDGET.firstLoadMs)}   ${mark(worst(out.firstLoadMs), BUDGET.firstLoadMs)}   (first paint ${s(worst(out.firstPaintMs))}; ${worst(out.transferKb)} kB in ${worst(out.requests)} requests, uncompressed; ${s(worst(out.setupMs))} after the files arrived)`);
  console.log(`  with files compressed, as a static host sends them: ${s(worst(zipped.firstLoadMs))}   ${mark(worst(zipped.firstLoadMs), BUDGET.firstLoadMs)}   (${worst(zipped.transferKb)} kB in ${worst(zipped.requests)} requests; ${s(worst(zipped.setupMs))} after the files arrived)`);
  console.log(`Repeat load           ${s(worst(out.repeatLoadMs))}`);
  console.log('Tap a menu link to the page\'s heading drawn (first time / again), budget 300 ms. A page whose heading is drawn before its data reads low:');
  for (const [id, p] of Object.entries(out.pages)) console.log(`  ${id.padEnd(12)} ${String(worst(p.first)).padStart(5)} ms / ${String(worst(p.again)).padStart(5)} ms   ${mark(worst(p.again), BUDGET.pageChangeMs)}`);
  console.log('This report measures only. It never fails a build (ospeli/ospeli#153).');
}
