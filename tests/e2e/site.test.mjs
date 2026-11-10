// Public front page (web/index.html): phone layout checks (issue #14). Desktop must not change.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './helpers.mjs';

let env;
before(async () => { env = await startApp(); });
after(async () => { await env.close(); });

async function open(width) {
  const mobile = width < 641;
  const context = await env.browser.newContext({ viewport: { width, height: mobile ? 780 : 860 }, isMobile: mobile, hasTouch: mobile });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${env.base}/`);
  await page.waitForLoadState('networkidle');
  return { context, page, errors };
}

// Visible links and buttons on the first screen whose background is filled.
const firstScreen = (page) => page.evaluate(() => [...document.querySelectorAll('a.btn, button.btn')].filter((el) => {
  const r = el.getBoundingClientRect(); const s = getComputedStyle(el);
  return r.width > 0 && r.top < innerHeight && r.bottom > 0 && s.visibility !== 'hidden';
}).map((el) => ({ text: el.innerText.trim(), filled: getComputedStyle(el).backgroundColor !== 'rgba(0, 0, 0, 0)', height: el.getBoundingClientRect().height })));

for (const width of [360, 390]) {
  test(`phone front page at ${width}px: one filled action on the first screen (issue #14)`, async () => {
    const { context, page, errors } = await open(width);
    const acts = await firstScreen(page);
    const filled = acts.filter((a) => a.filled);
    assert.deepEqual(filled.map((a) => a.text), ['Try the live demo']);
    assert.ok(acts.some((a) => /^Talk to us about a pilot/.test(a.text) && !a.filled), 'pilot is a text link');
    assert.ok(acts.every((a) => a.height >= 44), 'tap targets at least 44px');
    // The header pill comes back once the hero has scrolled away.
    await page.evaluate(() => window.scrollTo(0, document.querySelector('.hero').offsetHeight + 200));
    await page.waitForFunction(() => getComputedStyle(document.querySelector('nav.links .btn-primary')).visibility === 'visible');
    const o = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(o <= 0, `scrolls sideways by ${o}px`);
    assert.deepEqual(errors, []);
    await context.close();
  });
}

for (const width of [360, 390]) {
  test(`phone front page at ${width}px is under 7 screens, with the pilot contact intact (issue #14)`, async () => {
    const { context, page, errors } = await open(width);
    const m = await page.evaluate(() => ({
      screens: document.documentElement.scrollHeight / innerHeight,
      mail: (() => { const a = document.querySelector('.contact .mail'); const r = a.getBoundingClientRect(); return { href: a.getAttribute('href'), h: r.height }; })(),
      addrShown: document.getElementById('addr').getBoundingClientRect().height > 0,
      steps: [...document.querySelectorAll('#pilot .timeline li')].map((li) => li.innerText.replace(/\s+/g, ' ').trim()),
      summaries: [...document.querySelectorAll('details.acc > summary')].filter((x) => x.getBoundingClientRect().height > 0).map((x) => Math.round(x.getBoundingClientRect().height)),
    }));
    assert.ok(m.screens < 7, `page is ${m.screens.toFixed(2)} screens`);
    assert.match(m.mail.href, /^mailto:/);
    assert.ok(m.mail.h >= 44 && m.addrShown, 'the address is shown and Email us is a full-size button');
    assert.equal(m.steps.length, 3);
    assert.ok(m.steps.every((t) => /^WEEKS \d/i.test(t)), m.steps.join(' | '));
    assert.ok(m.summaries.length >= 6 && m.summaries.every((x) => x >= 44), `accordion rows ${m.summaries.join(',')}`);
    assert.deepEqual(errors, []);
    await context.close();
  });
}

// Founder decision 9 Nov: while Ospeli is in preview, the demo is the main (coral) action; the pilot is second.
test('desktop front page keeps its three actions, with the demo as the coral main action', async () => {
  const { context, page, errors } = await open(1280);
  const acts = await firstScreen(page);
  assert.deepEqual(acts.map((a) => a.text).sort(), ['Start a pilot', 'Start a pilot conversation', 'Try the live demo'].sort());
  const bg = (sel) => page.evaluate((s) => getComputedStyle(document.querySelector(s)).backgroundColor, sel);
  assert.equal(await bg('.hero a[href="demo/"]'), 'rgb(224, 88, 62)');
  assert.equal(await bg('.hero .btn-cta'), 'rgba(0, 0, 0, 0)');
  assert.deepEqual(errors, []);
  await context.close();
});

test('an agent can discover Ospeli from the public site (backlog A1, issue #18)', async () => {
  const { context, page, errors } = await open(1280);
  const files = await page.evaluate(async () => {
    const out = {};
    for (const p of ['llms.txt', 'agents.md', 'robots.txt', 'sitemap.xml', 'app/api/README.md', 'app/api/commands.json']) {
      const r = await fetch(p); out[p] = { status: r.status, text: await r.text() };
    }
    return out;
  });
  for (const [p, r] of Object.entries(files)) assert.equal(r.status, 200, p);
  assert.match(files['llms.txt'].text, /^# Ospeli\n\n> .*healthcare operations platform/);
  assert.match(files['llms.txt'].text, /agents\.md/);
  assert.match(files['llms.txt'].text, /app\/api\/commands\.json/);
  assert.match(files['agents.md'].text, /off by default/);
  assert.match(files['agents.md'].text, /No clinical decisions/);
  assert.match(files['robots.txt'].text, /Allow: \/\n/);
  assert.match(files['robots.txt'].text, /Sitemap: https:\/\/ospeli\.com\/sitemap\.xml/);
  const ld = await page.evaluate(() => JSON.parse(document.querySelector('script[type="application/ld+json"]').textContent));
  assert.equal(ld['@type'], 'SoftwareApplication');
  assert.equal(ld.potentialAction.target, 'https://ospeli.com/app/');
  assert.deepEqual(errors, []);
  await context.close();
});

for (const width of [360, 390]) {
  test(`phone front page: card links and the logo are 44 px tap targets, captions 15 px (issue #15, ${width}px)`, async () => {
    const { context, page } = await open(width);
    const m = await page.evaluate(() => ({
      links: [...document.querySelectorAll('.mod a, .pb a, .roles a, header.site a[href="#top"]')]
        .map((a) => ({ t: a.textContent.trim() || a.getAttribute('aria-label'), h: a.getBoundingClientRect().height }))
        .filter((x) => x.h > 0),
      text: [...document.querySelectorAll('.op-l, .problem .lbl')]
        .map((e) => ({ t: e.textContent.trim(), fs: parseFloat(getComputedStyle(e).fontSize) })),
    }));
    const short = m.links.filter((x) => x.h < 44);
    assert.ok(m.links.length > 10 && short.length === 0, `short tap targets: ${short.map((x) => `${x.t} ${Math.round(x.h)}px`).join(', ')}`);
    const small = m.text.filter((x) => x.fs < 15);
    assert.ok(m.text.length > 0 && small.length === 0, `text under 15px: ${small.map((x) => `${x.t} ${x.fs}px`).join(', ')}`);
    await context.close();
  });
}
