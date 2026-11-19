// Issue ospeli/ospeli#90, the previews: the bed board preview (web/demo/bed-board/) and the
// emergency department flow preview (web/demo/ed-flow/) follow the same rules as the app.
// 1. Every control's spoken name holds the words on it (WCAG 2.5.3, Label in Name), and for the
//    buttons that act on a patient, the name starts with those words and says which patient.
// 2. One word per bed state, the same words as the app's tiles ("Going home", "To clean").
// 3. Beds that are faded by a filter stay readable: all their text at 4.5:1 or better.
// Fictional data only.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './helpers.mjs';

let env;
before(async () => { env = await startApp(); });
after(async () => { await env.close(); });

async function open(path, width) {
  const context = await env.browser.newContext({ viewport: { width, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(env.base + path);
  return { context, page, errors };
}

const spokenVsShown = (page, sel) => page.evaluate((s) => [...document.querySelectorAll(s)].map((el) => {
  const shown = []; const tw = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let n; (n = tw.nextNode());) { if (n.textContent.trim()) shown.push(n.textContent.trim()); }
  const name = (el.getAttribute('aria-label') ?? el.textContent).replace(/\s+/g, ' ').trim();
  const norm = (t) => t.replace(/\s+/g, ' ').toLowerCase();
  return { name, shown, text: el.textContent.replace(/\s+/g, ' ').trim(), missing: shown.filter((t) => !norm(name).includes(norm(t))) };
}), sel);

test('issue #90: bed board preview: each bed is announced with the words on its tile, and uses the app\'s word for each state', async () => {
  const { context, page, errors } = await open('/demo/bed-board/', 390);
  await page.waitForSelector('.bed');
  const beds = await spokenVsShown(page, '.bed');
  assert.ok(beds.length >= 10);
  assert.deepEqual(beds.filter((b) => b.missing.length).map((b) => `${b.name} | not spoken: ${b.missing.join(', ')}`), []);
  for (const b of beds) assert.match(b.name, /^Bed \S+, /, b.name);
  assert.ok(beds.some((b) => /, P-\d+$/.test(b.name)) && beds.some((b) => /, For \S+$/.test(b.name)), 'who is in the bed is in the spoken name');
  // One word per state, the app's tile words. The example ward has a bed going home and one to clean.
  const words = await page.evaluate(() => [...document.querySelectorAll('.grid .chip, .legend .chip, #legend .chip')].map((c) => c.textContent.trim()));
  assert.ok(words.includes('Going home'), `chips: ${[...new Set(words)].join(', ')}`);
  assert.ok(words.includes('To clean'), `chips: ${[...new Set(words)].join(', ')}`);
  assert.ok(!words.some((w) => w === 'Expected discharge' || w === 'Vacated, to clean'), 'the long state names are not used on chips');
  // The bed's sheet says the same word as its tile.
  const tile = page.locator('.bed', { has: page.locator('.chip.st-expected_discharge') }).first();
  await tile.click();
  await page.waitForSelector('.sheet');
  assert.match(await page.locator('.sheet .sub').innerText(), /^Going home for /);
  assert.deepEqual(errors, []);
  await context.close();
});

for (const width of [390, 1280]) {
  test(`issue #90: bed board preview: beds faded by a filter stay readable at 4.5:1 (${width}px)`, async () => {
    const { context, page, errors } = await open('/demo/bed-board/', width);
    await page.waitForSelector('.bed');
    await page.locator('#filters .filter').nth(1).click();
    await page.waitForSelector('.bed.dim');
    const worst = await page.evaluate(() => {
      const rgb = (c) => (c.match(/[\d.]+/g) || []).map(Number);
      const lum = ([r, g, b]) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
      const over = (fg, bg, a) => fg.slice(0, 3).map((v, i) => v * a + bg[i] * (1 - a));
      const behind = (el) => { for (let e = el; e; e = e.parentElement) { const c = rgb(getComputedStyle(e).backgroundColor); if (c.length === 3 || c[3] === 1) return c.slice(0, 3); } return [255, 255, 255]; };
      const pageBg = behind(document.querySelector('.grid').parentElement);
      let low = { ratio: 99 };
      for (const bed of document.querySelectorAll('.bed.dim')) {
        const fade = parseFloat(getComputedStyle(bed).opacity);
        const tw = document.createTreeWalker(bed, NodeFilter.SHOW_TEXT);
        for (let n; (n = tw.nextNode());) {
          if (!n.textContent.trim()) continue;
          const el = n.parentElement;
          const bg = over(behind(el), pageBg, fade); const fg = over(rgb(getComputedStyle(el).color), pageBg, fade);
          const [a, b] = [lum(fg), lum(bg)].sort((x, y) => y - x);
          const ratio = (a + 0.05) / (b + 0.05);
          if (ratio < low.ratio) low = { ratio: Math.round(ratio * 100) / 100, what: el.className, text: n.textContent.trim(), fade };
        }
      }
      return { low, dim: document.querySelectorAll('.bed.dim').length, all: document.querySelectorAll('.bed').length };
    });
    assert.ok(worst.dim > 0 && worst.dim < worst.all, 'the filter fades some beds, not all');
    assert.ok(worst.low.ratio >= 4.5, `lowest contrast on a faded bed: ${JSON.stringify(worst.low)}`);
    // A faded bed still looks different from one the filter keeps.
    const [kept, faded] = await page.evaluate(() => [getComputedStyle(document.querySelector('.bed:not(.dim)')).backgroundColor, getComputedStyle(document.querySelector('.bed.dim')).backgroundColor]);
    assert.notEqual(kept, faded);
    assert.deepEqual(errors, []);
    await context.close();
  });
}

test('issue #90: emergency department preview: a patient\'s buttons are announced starting with the words on them, then the patient', async () => {
  const { context, page, errors } = await open('/demo/ed-flow/', 390);
  await page.waitForSelector('#stats .stat');
  const check = async (sel) => {
    const rows = await spokenVsShown(page, sel);
    assert.ok(rows.length >= 1, `buttons found for ${sel}`);
    for (const r of rows) {
      assert.deepEqual(r.missing, [], `${r.name} | not spoken: ${r.missing.join(', ')}`);
      assert.ok(r.name.toLowerCase().startsWith(r.text.toLowerCase()), `"${r.name}" starts with "${r.text}"`);
      assert.match(r.name, /Patient \d{4}/, r.name);
    }
    return rows;
  };
  await check('.pt .acts button');
  // A patient with a decision to admit gets a ward choice and the "Bed requested" button.
  await page.locator('.pt button', { hasText: /^Admit$/ }).first().click();
  const bedreq = await check('.pt .acts button');
  assert.ok(bedreq.some((r) => /^Bed requested/.test(r.text)));
  // The flow coordinator's buttons, before and after an escalation.
  await page.click('.roles button[data-role=flow]');
  await page.waitForSelector('.bwrow');
  await check('.bwrow .ctl button');
  const esc = page.locator('.bwrow .ctl button:not([disabled])', { hasText: /^Escalate$/ }).first();
  if (await esc.count()) {
    await esc.click();
    const after = await check('.bwrow .ctl button');
    assert.ok(after.some((r) => r.text === 'Escalated'), 'an escalated row says so and is announced so');
  }
  assert.deepEqual(errors, []);
  await context.close();
});
