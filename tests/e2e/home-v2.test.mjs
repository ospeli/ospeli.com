// Website v2, "one slide, then read more" (founder approved 24 Nov 2026; spec ospeli/ospeli
// docs/design/website-v2.md). The rules of the spec, as the design auditor checks them:
// one filled button that opens the walk; the slide fits one 1440x900 screen; the page is no more
// than about 2 desktop screens with the rows closed; about 450 words or fewer with every row open;
// the five rows open and close by tap and keyboard; no sideways scroll on a phone; taps 44 px and
// body text 17 px on a phone; example figures say "Example data"; no "Try the demo" text.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './helpers.mjs';

let env;
before(async () => { env = await startApp(); });
after(async () => { await env.close(); });

async function open(width, height, phone = false) {
  const context = await env.browser.newContext({ viewport: { width, height }, isMobile: phone, hasTouch: phone });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(`${env.base}/`);
  await page.waitForLoadState('networkidle');
  return { context, page, errors };
}

const filled = (page) => page.evaluate(() => [...document.querySelectorAll('a, button')].filter((el) => {
  const s = getComputedStyle(el); const r = el.getBoundingClientRect();
  return r.width > 0 && s.backgroundColor !== 'rgba(0, 0, 0, 0)' && s.backgroundColor !== 'transparent';
}).map((el) => ({ text: el.textContent.trim(), href: el.getAttribute('href'), h: el.getBoundingClientRect().height })));

for (const [width, height] of [[1440, 900], [1280, 800]]) {
  test(`desktop ${width} px: one filled button opens the walk, the first screen is headline and button only, two screens at most with rows closed`, async () => {
    const { context, page, errors } = await open(width, height);
    const btns = await filled(page);
    assert.equal(btns.length, 1, JSON.stringify(btns));
    assert.match(btns[0].text, /^Try a walk/);
    assert.equal(btns[0].href, 'app/#/process/walk');
    const m = await page.evaluate(() => ({
      first: document.querySelector('.act').getBoundingClientRect().bottom,
      visit: document.querySelector('.visit').getBoundingClientRect().top,
      page: document.documentElement.scrollHeight,
      closed: [...document.querySelectorAll('details')].every((d) => !d.open),
      rows: document.querySelectorAll('details').length,
    }));
    assert.equal(m.rows, 5);
    assert.ok(m.closed, 'every row starts closed');
    // Founder, 28 Nov: the first screen is only the headline, the button and the line under it;
    // the visit bar and its chip sit below it.
    assert.ok(m.first <= height, `headline, button and line end at ${m.first} px`);
    assert.ok(m.visit >= height, `visit bar starts at ${m.visit} px, inside the first screen`);
    assert.ok(m.page <= 2 * 900 + 100, `page is ${m.page} px with rows closed`);
    assert.deepEqual(errors, []);
    await context.close();
  });
}

test('words: about 450 or fewer with every row open, about 60 on the slide; example figures labelled; no "Try the demo"', async () => {
  const { context, page } = await open(1280, 800);
  await page.evaluate(() => document.querySelectorAll('details').forEach((d) => { d.open = true; }));
  const t = await page.evaluate(() => ({ all: document.body.innerText, slide: document.querySelector('.slide').innerText }));
  const count = (s) => s.split(/\s+/).filter((w) => /[A-Za-z0-9]/.test(w)).length;
  assert.ok(count(t.all) <= 450, `${count(t.all)} words`);
  assert.ok(count(t.slide) <= 75, `${count(t.slide)} words on the slide`);
  assert.match(await page.locator('.visit figcaption').innerText(), /[Ee]xample data/);
  assert.doesNotMatch(t.all, /try the (live )?demo/i);
  await context.close();
});

for (const width of [360, 390]) {
  test(`phone ${width} px: no sideways scroll, taps 44 px, body text 17 px, rows open and close by tap`, async () => {
    const { context, page, errors } = await open(width, 780, true);
    const sums = page.locator('summary');
    for (let i = 0; i < 5; i++) await sums.nth(i).tap();
    const m = await page.evaluate(() => ({
      open: [...document.querySelectorAll('details')].filter((d) => d.open).length,
      wide: document.documentElement.scrollWidth > innerWidth,
      small: [...document.querySelectorAll('a, summary')].filter((e) => e.getBoundingClientRect().height < 44).map((e) => e.textContent.trim().slice(0, 30)),
      body: [...document.querySelectorAll('.body p, .body li, .body dd, .facts li, .act .note')].map((e) => parseFloat(getComputedStyle(e).fontSize)),
    }));
    assert.equal(m.open, 5);
    assert.equal(m.wide, false, 'no sideways scroll with every row open');
    assert.deepEqual(m.small, []);
    assert.ok(Math.min(...m.body) >= 17, `smallest body text ${Math.min(...m.body)} px`);
    for (let i = 0; i < 5; i++) await sums.nth(i).tap();
    assert.equal(await page.evaluate(() => [...document.querySelectorAll('details')].filter((d) => d.open).length), 0);
    assert.deepEqual(errors, []);
    await context.close();
  });
}

test('keyboard: every row opens with Enter and closes with Space', async () => {
  const { context, page } = await open(1280, 800);
  const sums = page.locator('summary');
  for (let i = 0; i < 5; i++) { await sums.nth(i).focus(); await page.keyboard.press('Enter'); }
  assert.equal(await page.evaluate(() => [...document.querySelectorAll('details')].filter((d) => d.open).length), 5);
  for (let i = 0; i < 5; i++) { await sums.nth(i).focus(); await page.keyboard.press('Space'); }
  assert.equal(await page.evaluate(() => [...document.querySelectorAll('details')].filter((d) => d.open).length), 0);
  await context.close();
});

test('the footer links land on sections that exist on the overview page', async () => {
  const { context, page } = await open(1280, 800);
  const hrefs = await page.$$eval('footer nav a, .body a[href*="overview"]', (as) => as.map((a) => a.getAttribute('href')));
  for (const h of hrefs) {
    const [file, id] = h.split('#');
    await page.goto(`${env.base}/${file}`);
    assert.equal(await page.locator(`#${id}`).count(), 1, `${h} has no section #${id}`);
  }
  await context.close();
});

// Issue #195 point 1: the "READ MORE" label above the five rows is 15 px on a phone, the text floor.
for (const width of [360, 390]) {
  test(`phone ${width} px: the READ MORE label is at least 15 px (issue #195)`, async () => {
    const { context, page } = await open(width, 780, true);
    const px = await page.evaluate(() => parseFloat(getComputedStyle(document.getElementById('more-h')).fontSize));
    assert.ok(px >= 15, `READ MORE is ${px} px`);
    await context.close();
  });
}
