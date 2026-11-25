// Issue #44: every measure on an area page shows its full definition (what is counted, out of
// what, between which two events, how it is shown, what is not counted, where it comes from), and
// none says "local definition". Phone first: the definition opens with one tap, fits the screen and
// reads at 15 px or more on a phone.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { startApp } from './helpers.mjs';

let env;
before(async () => { env = await startApp(); });
after(async () => { await env.close(); });

const areas = JSON.parse(readFileSync(new URL('../../web/areas/areas.json', import.meta.url), 'utf8'));
const ed = areas.find((a) => a.id === 'A2');

for (const width of [360, 390, 1280]) {
  test(`area page measures: each opens to its full definition, cited where a standard exists (${width}px)`, async () => {
    const phone = width < 641;
    const context = await env.browser.newContext({ viewport: { width, height: 800 }, ...(phone ? { hasTouch: true, isMobile: true } : {}) });
    const page = await context.newPage();
    const errors = []; page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(`${env.base}/areas/${ed.slug}/`);
    const rows = page.locator('#kp ~ .tw tbody tr, section[aria-labelledby="kp"] tbody tr');
    assert.equal(await rows.count(), ed.kpis.length);
    assert.equal(await page.locator('section[aria-labelledby="kp"]').getByText(/local definition/i).count(), 0);
    // Time to triage: start and end events, its statistic, and the consensus source.
    const row = page.locator('section[aria-labelledby="kp"] tbody tr', { hasText: 'Time to triage' });
    const sum = row.locator('details.kd summary');
    assert.ok((await sum.boundingBox()).height >= 44, 'the tap target is 44 px');
    if (phone) await sum.tap(); else await sum.click();
    const dl = row.locator('details.kd[open] dl');
    await dl.waitFor();
    const text = (await dl.innerText()).replace(/\s+/g, ' ');
    for (const want of ['From', 'Arrival to Triage recorded', 'Counts', 'Out of', 'Shown as', 'Median, with the 90th percentile and n', 'Not counted']) assert.ok(text.includes(want), `${want} in: ${text}`);
    assert.match(await row.locator('td').nth(2).innerText(), /Welch et al\. 2011.*PMID 21067846/);
    // It stays inside the screen and reads at 15 px or more on a phone.
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), 0, 'no sideways scroll');
    if (phone) {
      const small = await dl.evaluate((el) => [...el.querySelectorAll('dt, dd')].map((n) => parseFloat(getComputedStyle(n).fontSize)).filter((px) => px < 15));
      assert.deepEqual(small, []);
    }
    assert.deepEqual(errors, []);
    await context.close();
  });
}

test('every area-page measure has the template filled in, and every area page shows it', async () => {
  let checked = 0;
  for (const a of areas) for (const k of a.kpis) {
    checked++;
    for (const f of ['numerator', 'denominator', 'statistic', 'exclusions', 'source']) assert.ok(String(k[f] || '').trim(), `${a.id} ${k.name}: ${f}`);
    if (k.kind === 'time') assert.ok(k.startEvent && k.endEvent, `${a.id} ${k.name}: start and end`);
    assert.notEqual(k.source.toLowerCase(), 'local definition', `${a.id} ${k.name}`);
    const html = readFileSync(new URL(`../../web/areas/${a.slug}/index.html`, import.meta.url), 'utf8');
    assert.ok(html.includes('How it is counted'), a.slug);
  }
  assert.ok(checked > 0, 'there were area-page measures to check');
});
