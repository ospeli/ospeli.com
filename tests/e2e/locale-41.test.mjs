// Issue #41 item 3: three screens pinned British date and time formats ('en-GB', 24-hour). Dates
// and times now follow the device's own language and region, like the rest of the app.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startApp } from './helpers.mjs';

let env;
before(async () => { env = await startApp(); });
after(async () => { await env.close(); });

const CLOCK = '2026-11-14T15:05:00Z';
async function open(locale, path, width = 390) {
  const context = await env.browser.newContext({ viewport: { width, height: 800 }, locale, timezoneId: 'UTC', acceptDownloads: true });
  await context.addInitScript(() => { window.__OSPELI_TEST__ = true; });
  const page = await context.newPage();
  await page.clock.install({ time: new Date(CLOCK) });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(env.appUrl + path);
  await page.waitForSelector('html[data-ready="true"]');
  return { context, page, errors };
}

for (const locale of ['en-US', 'de-DE', 'en-GB']) {
  test(`#41: the last-export line and a walk's date follow the device (${locale})`, async () => {
    const { context, page, errors } = await open(locale, '#/data');
    const line = page.locator('[data-test="last-export"]');
    await line.waitFor();
    await Promise.all([page.waitForEvent('download'), page.locator('button:has-text("Export JSON")').click()]);
    await page.waitForFunction(() => /^Last export: /.test(document.querySelector('[data-test="last-export"]').innerText));
    const want = await page.evaluate(() => new Date().toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }));
    assert.equal(await line.innerText(), `Last export: ${want}.`);
    if (locale === 'en-US') assert.match(want, /PM/, 'a US device shows a 12-hour clock');

    // A walk made as a person, then its map.
    await page.evaluate(async () => {
      const { runCommand } = await import('./core/commands.js');
      const me = { type: 'human', role: 'ops-manager' };
      const core = window.ospeli.core;
      await runCommand(core, 'ospeli_walks_start', {}, me);
      await runCommand(core, 'ospeli_walks_step_start', {}, me);
      await new Promise((r) => setTimeout(r, 1100)); // past the 1 s double-tap guard (walk-mode fixes, #102)
      await runCommand(core, 'ospeli_walks_step_done', {}, me);
      await runCommand(core, 'ospeli_walks_step_name', { name: 'Checked in at reception', role: 'Reception' }, me);
      await runCommand(core, 'ospeli_walks_finish', {}, me);
    });
    await page.goto(`${env.appUrl}#/process/map-001`);
    await page.waitForSelector('.walk-when');
    const when = await page.evaluate(() => {
      const d = new Date();
      return { day: d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' }), time: d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) };
    });
    const text = await page.textContent('.walk-when');
    assert.ok(text.includes(`Walked ${when.day}, started `), `${text} has ${when.day}`);
    assert.ok(text.includes(`started ${when.time}`), `${text} has ${when.time}`);
    if (locale === 'en-US') assert.match(when.time, /[AP]M/);
    else assert.match(when.time, /^\d\d[:.]\d\d$/);
    assert.deepEqual(errors, []);
    await context.close();
  });
}

test('#41: no screen pins a locale for dates and times', () => {
  const root = fileURLToPath(new URL('../../web/app/', import.meta.url));
  const files = [];
  const walk = (d) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (p.endsWith('.js')) files.push(p); } };
  walk(root);
  const pinned = files.flatMap((p) => readFileSync(p, 'utf8').split('\n').map((l, i) => [p, i + 1, l]))
    .filter(([, , l]) => /toLocale(Date|Time)?String\(\s*'[a-z]{2}(-[A-Z]{2})?'/.test(l)).map(([p, i]) => `${p.slice(root.length)}:${i}`);
  assert.deepEqual(pinned, []);
});
