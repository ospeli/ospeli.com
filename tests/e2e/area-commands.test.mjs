// Issue #45: area pages name only assistant commands that exist. A Built area lists the app's own
// commands for it, read from commands.json; a preview area lists none. Checked at 360, 390, 1280 px.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { startApp } from './helpers.mjs';

const spec = JSON.parse(readFileSync(new URL('../../web/app/api/commands.json', import.meta.url), 'utf8')).commands;
const real = new Set(spec.map((c) => c.name));
const built = {
  'beds-and-patient-flow': ['ospeli_beds_'],
  'medical-equipment': ['ospeli_workorders_', 'ospeli_assets_'],
  'process-mapping': ['ospeli_maps_', 'ospeli_walks_'],
  // Built in first versions since 17 and 18 Nov (issue #118).
  'support-services': ['ospeli_support_', 'ospeli_tasks_'],
  'supply-chain-stores': ['ospeli_stores_', 'ospeli_stock_'],
  'patient-experience': ['ospeli_experience_'],
  'facilities-utilities': ['ospeli_facilities_'],
  'patient-transport': ['ospeli_transfers_'],
};

let env;
before(async () => { env = await startApp(); });
after(async () => { await env.close(); });

async function open(slug, width) {
  const mobile = width < 641;
  const context = await env.browser.newContext({ viewport: { width, height: mobile ? 780 : 860 }, isMobile: mobile, hasTouch: mobile });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${env.base}/areas/${slug}/`);
  const names = await page.$$eval('#ag ~ * code, #ag + * code, section[aria-labelledby="ag"] code', (els) => [...new Set(els.map((e) => e.textContent.trim()))]);
  const text = await page.$eval('section[aria-labelledby="ag"]', (s) => s.innerText);
  const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  const link = await page.$eval('section[aria-labelledby="ag"] a[href$="commands.json"]', (a) => a.href);
  await context.close();
  return { names, text, over, link, errors };
}

for (const width of [360, 390, 1280]) {
  test(`Built area pages list exactly the app's commands for that area at ${width}px (issue #45)`, async () => {
    for (const [slug, prefixes] of Object.entries(built)) {
      const r = await open(slug, width);
      const want = spec.map((c) => c.name).filter((n) => prefixes.some((p) => n.startsWith(p)));
      assert.ok(want.length > 0, slug);
      assert.deepEqual(r.names, want, `${slug} lists the registry's commands`);
      assert.ok(r.over <= 0, `${slug} scrolls sideways by ${r.over}px`);
      assert.ok(r.link.endsWith('/app/api/commands.json'));
      assert.deepEqual(r.errors, []);
    }
  });

  test(`preview area pages name no command at ${width}px (issue #45)`, async () => {
    for (const slug of ['emergency-department-flow', 'critical-care-capacity', 'theatres-and-procedures']) {
      const r = await open(slug, width);
      assert.deepEqual(r.names, [], `${slug} names no command`);
      assert.match(r.text, /defined and tested when this area is built/);
      assert.ok(r.over <= 0, `${slug} scrolls sideways by ${r.over}px`);
    }
  });
}

test('every ospeli_ name on any area page is a real command (issue #45)', async () => {
  const index = readFileSync(new URL('../../web/areas/areas.json', import.meta.url), 'utf8');
  assert.ok(!/ospeli_[a-z_]+/.test(index), 'areas.json holds no command names');
  for (const slug of JSON.parse(index).map((a) => a.slug)) {
    const html = readFileSync(new URL(`../../web/areas/${slug}/index.html`, import.meta.url), 'utf8');
    for (const n of html.match(/\bospeli_[a-z_]+\b/g) || []) assert.ok(real.has(n), `${slug}: ${n} is not in commands.json`);
  }
});
