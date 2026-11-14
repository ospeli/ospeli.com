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

// Issue #42: the "I work in" role links were a 1,702 px strip in a 356 px box with no swipe cue.
// On phones they are now a closed "Find your area" row that opens into a full-width list.
for (const width of [360, 390]) {
  test(`phone front page: every role link is reachable without sideways scrolling (issue #42, ${width}px)`, async () => {
    const { context, page, errors } = await open(width);
    const sum = page.locator('details.roles-wrap > summary');
    assert.equal(await page.locator('details.roles-wrap').evaluate((d) => d.open), false, 'closed at first, to keep the page short');
    assert.match(await sum.innerText(), /^Find your area by role$/);
    assert.ok((await sum.boundingBox()).height >= 44, 'the row is a 44 px tap target');
    await sum.tap();
    const m = await page.evaluate(() => {
      const nav = document.querySelector('nav.roles');
      return {
        open: document.querySelector('details.roles-wrap').open,
        navScroll: nav.scrollWidth - nav.clientWidth,
        pageScroll: document.documentElement.scrollWidth - innerWidth,
        links: [...nav.querySelectorAll('a')].map((a) => {
          const r = a.getBoundingClientRect();
          return { t: a.textContent.trim(), h: r.height, fs: parseFloat(getComputedStyle(a).fontSize), inside: r.left >= 0 && r.right <= innerWidth && r.width > 0, cut: a.scrollWidth > a.clientWidth };
        }),
      };
    });
    assert.equal(m.open, true);
    assert.equal(m.links.length, 11);
    assert.ok(m.navScroll <= 0 && m.pageScroll <= 0, `sideways scroll: list ${m.navScroll}px, page ${m.pageScroll}px`);
    const bad = m.links.filter((l) => !l.inside || l.cut || l.h < 44 || l.fs < 15);
    assert.deepEqual(bad, [], 'every link is fully on screen, not cut, at least 44 px tall and 15 px text');
    assert.deepEqual(errors, []);
    await context.close();
  });
}

test('desktop front page: the role links stay one visible row of chips (issue #42)', async () => {
  const { context, page, errors } = await open(1280);
  const m = await page.evaluate(() => ({
    summaryShown: document.querySelector('details.roles-wrap > summary').getBoundingClientRect().height > 0,
    label: document.querySelector('.roles-k').getBoundingClientRect().height > 0,
    shown: [...document.querySelectorAll('nav.roles a')].filter((a) => a.getBoundingClientRect().height > 0 && a.checkVisibility({ contentVisibilityAuto: true })).length,
  }));
  assert.deepEqual(m, { summaryShown: false, label: true, shown: 11 });
  assert.deepEqual(errors, []);
  await context.close();
});

// Issue #55: the end of the phone page offers the next places to go; desktop has no such list.
for (const width of [360, 390]) {
  test(`phone front page at ${width}px ends with plain footer links (issue #55)`, async () => {
    const { context, page, errors } = await open(width);
    const links = await page.evaluate(() => [...document.querySelectorAll('footer .foot-links a')].map((a) => {
      const r = a.getBoundingClientRect();
      return { text: a.innerText.trim(), href: a.getAttribute('href'), h: r.height, size: parseFloat(getComputedStyle(a).fontSize), lines: Math.round(r.height / 44) };
    }));
    assert.deepEqual(links.map((l) => l.text), ['Demos', 'All areas', 'Roadmap', 'For AI agents']);
    assert.ok(links.every((l) => l.h >= 44 && l.h < 60 && l.size >= 16), JSON.stringify(links));
    for (const l of links.filter((x) => !x.href.startsWith('#'))) {
      const res = await page.request.get(new URL(l.href, page.url()).href);
      assert.equal(res.status(), 200, `${l.href} opens`);
    }
    // "Roadmap" opens the collapsed roadmap row rather than landing on a closed one.
    assert.equal(await page.evaluate(() => document.querySelector('#roadmap details').open), false);
    await page.locator('footer .foot-links a', { hasText: 'Roadmap' }).click();
    await page.waitForFunction(() => document.querySelector('#roadmap details').open);
    assert.ok(await page.locator('#roadmap .timeline li').first().isVisible());
    const o = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(o <= 0, `scrolls sideways by ${o}px`);
    assert.deepEqual(errors, []);
    await context.close();
  });
}

test('desktop front page has no phone footer links (issue #55)', async () => {
  const { context, page } = await open(1280);
  assert.equal(await page.evaluate(() => document.querySelector('footer .foot-links').getBoundingClientRect().height), 0);
  assert.ok(await page.evaluate(() => document.querySelector('footer .tag').getBoundingClientRect().height > 0));
  await context.close();
});

// Issue #66: every filled button on the front page meets the contrast bar (4.5:1; 3:1 for large
// text, which is 24 px or 18.66 px bold), at phone and desktop widths. "Email us" was white on
// coral at 3.7:1 on phones.
const filledButtons = (page) => page.evaluate(() => {
  const lum = (c) => { const [r, g, b] = c.match(/[\d.]+/g).slice(0, 3).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  return [...document.querySelectorAll('a.btn, button.btn')].filter((el) => {
    const r = el.getBoundingClientRect(); const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && /^rgb\(/.test(s.backgroundColor);
  }).map((el) => {
    const s = getComputedStyle(el); const a = lum(s.color); const b = lum(s.backgroundColor);
    const px = parseFloat(s.fontSize); const bold = Number(s.fontWeight) >= 700;
    return { text: el.innerText.trim(), ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05), need: px >= 24 || (bold && px >= 18.66) ? 3 : 4.5, px };
  });
});
for (const width of [360, 390, 1280]) {
  test(`front page at ${width}px: every filled button meets the contrast bar (issue #66)`, async () => {
    const { context, page } = await open(width);
    const btns = await filledButtons(page);
    assert.ok(btns.length >= 1);
    if (width < 641) assert.ok(btns.some((b) => /Email us/.test(b.text)), 'the Email us button is shown on phones');
    for (const b of btns) assert.ok(b.ratio >= b.need, `"${b.text}" is ${b.ratio.toFixed(2)}:1 at ${b.px}px (needs ${b.need}:1)`);
    await context.close();
  });
}

// Issue #21: the hero preview must not contradict the demo it links to. The demo's numbers change
// every hour, so the card is labelled an illustration, and its bed and work-order numbers are a
// state the seeded Example General Hospital really shows (checked against the generator).
test('front page hero card: labelled an illustration, and its numbers are a state the seeded demo shows (issue #21)', async () => {
  const { context, page } = await open(390);
  const card = await page.evaluate(() => ({
    badge: document.querySelector('.board .sample').textContent.trim(),
    ops: [...document.querySelectorAll('.board .op')].map((o) => ({ k: o.querySelector('.op-k').textContent, n: o.querySelector('.op-n').textContent, l: o.querySelector('.op-l').textContent })),
  }));
  assert.equal(card.badge, 'Illustration');
  const beds = card.ops.find((o) => o.k === 'Beds'); const eng = card.ops.find((o) => o.k === 'Engineering');
  const want = { free: Number(beds.n), waiting: Number(beds.l.match(/(\d+) waiting/)[1]), open: Number(eng.n), overdue: Number(eng.l.match(/(\d+) overdue/)[1]) };
  const { loadSyntheticHospital } = await import('../../web/app/core/generator.js');
  const { Core } = await import('../../web/app/core/core.js');
  const { MemoryAdapter } = await import('../../web/app/core/db.js');
  const { runCommand } = await import('../../web/app/core/commands.js');
  const states = [];
  for (let hr = 0; hr < 24; hr++) {
    const end = `2026-11-12T${String(hr).padStart(2, '0')}:00:00.000Z`;
    const core = await Core.open({ adapter: new MemoryAdapter(), clock: () => new Date(end) });
    await loadSyntheticHospital(core, { end });
    const who = { type: 'human', role: 'coo' };
    const b = await runCommand(core, 'ospeli_beds_board', { format: 'short' }, who);
    const w = await runCommand(core, 'ospeli_workorders_list', { format: 'short' }, who);
    states.push({ free: b.wards.reduce((n, x) => n + x.counts.available, 0), waiting: b.waiting.filter((x) => !x.allocatedBed).length, open: w.counts.open, overdue: w.counts.overdue });
  }
  assert.ok(states.some((s) => s.free === want.free && s.waiting === want.waiting && s.open === want.open && s.overdue === want.overdue),
    `the card says ${JSON.stringify(want)}; the seeded demo on 12 Nov shows ${[...new Set(states.map((s) => JSON.stringify(s)))].join(' ')}`);
  await context.close();
});

// Issue #54: on phones the modules were a sideways row 12 cards wide (about 3,400 px at 360 px).
// Now the built modules are a short stacked list and the previews sit behind one tap-to-open row.
for (const width of [360, 390]) {
  test(`phone front page: built modules are stacked rows and previews open from one row, no sideways row (issue #54, ${width}px)`, async () => {
    const { context, page, errors } = await open(width);
    const before = await page.evaluate(() => {
      const sec = document.getElementById('modules');
      const shown = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const all = [...sec.querySelectorAll('*')].filter(shown);
      const cards = [...sec.querySelectorAll('.modules .mod')];
      const label = (c) => c.querySelector('.st').textContent.trim();
      return {
        screens: document.documentElement.scrollHeight / innerHeight,
        pageScroll: document.documentElement.scrollWidth - innerWidth,
        wide: all.filter((el) => { const r = el.getBoundingClientRect(); return r.width > innerWidth + 0.5 || r.left < -0.5 || r.right > innerWidth + 0.5; }).map((el) => el.className || el.tagName),
        scrollers: all.filter((el) => el.scrollWidth > el.clientWidth + 1 && /auto|scroll/.test(getComputedStyle(el).overflowX)).map((el) => el.className || el.tagName),
        dots: [...sec.querySelectorAll('.dots, .swipe-hint')].filter(shown).length,
        text: sec.innerText,
        labels: cards.map(label),
        built: cards.filter((c) => label(c) === 'Built').map((c) => {
          const r = c.getBoundingClientRect(); const a = c.querySelector('a'); const ar = a.getBoundingClientRect();
          const txt = [...c.querySelectorAll('h3, p, a, .st')].filter(shown);
          return { name: c.querySelector('h3').textContent.trim(), width: r.width, left: r.left, right: r.right, top: r.top, bottom: r.bottom, linkH: ar.height, linkShown: shown(a) && ar.left >= 0 && ar.right <= innerWidth, href: a.getAttribute('href'), minFs: Math.min(...txt.map((e) => parseFloat(getComputedStyle(e).fontSize))), lines: txt.filter((e) => e.tagName === 'P').length };
        }),
        previewCardsShown: cards.filter((c) => label(c) === 'Preview' && shown(c)).length,
        previewHrefs: cards.filter((c) => label(c) === 'Preview').map((c) => c.querySelector('a').getAttribute('href')),
        namedPreviews: cards.filter((c) => label(c) === 'Preview' && !/^And \d+ more$/.test(c.querySelector('h3').textContent.trim())).length,
        more: (cards.map((c) => c.querySelector('h3').textContent.trim()).find((t) => /^And \d+ more$/.test(t)) || '').match(/\d+/)[0],
      };
    });
    assert.ok(before.screens < 7, `page is ${before.screens.toFixed(2)} screens`);
    assert.ok(before.pageScroll <= 0, `page scrolls sideways by ${before.pageScroll}px`);
    assert.deepEqual(before.wide, [], 'nothing in the modules section is wider than, or outside, the screen');
    assert.deepEqual(before.scrollers, [], 'no sideways-scrolling row');
    assert.equal(before.dots, 0, 'no dots and no swipe hint');
    assert.doesNotMatch(before.text, /swipe/i);
    // The labels are unchanged: 3 Built, 9 Preview.
    assert.equal(before.labels.filter((l) => l === 'Built').length, 3);
    assert.equal(before.labels.filter((l) => l === 'Preview').length, 9);
    assert.deepEqual(before.built.map((b) => b.name), ['Bed board', 'Medical equipment and maintenance', 'Process mapping']);
    for (const b of before.built) {
      assert.ok(b.width >= width - 48 && b.left >= 0 && b.right <= width, `${b.name}: a full-width row on screen (${Math.round(b.width)}px)`);
      assert.ok(b.linkShown && b.linkH >= 44, `${b.name}: link is ${Math.round(b.linkH)}px tall`);
      assert.ok(b.minFs >= 15, `${b.name}: text is ${b.minFs}px`);
      assert.equal(b.lines, 1, `${b.name}: one line of description`);
    }
    // Stacked top to bottom, not side by side.
    assert.ok(before.built.every((b, i, a) => i === 0 || b.top >= a[i - 1].bottom), 'built rows are stacked');
    assert.equal(before.previewCardsShown, 0, 'preview cards are not shown as cards on phones');

    const sum = page.locator('#modules details.pv-wrap > summary');
    assert.equal(await page.locator('#modules details.pv-wrap').evaluate((d) => d.open), false, 'closed at first, to keep the page short');
    assert.equal(await sum.innerText(), `${before.namedPreviews} previews and ${before.more} more areas`, 'the counts come from the cards');
    assert.ok((await sum.boundingBox()).height >= 44, 'the row is a 44 px tap target');
    await sum.tap();
    const m = await page.evaluate(() => {
      const nav = document.querySelector('#modules .pv-list');
      return {
        open: document.querySelector('#modules details.pv-wrap').open,
        navScroll: nav.scrollWidth - nav.clientWidth,
        pageScroll: document.documentElement.scrollWidth - innerWidth,
        links: [...nav.querySelectorAll('a')].map((a) => {
          const r = a.getBoundingClientRect();
          return { t: a.textContent.trim(), href: a.getAttribute('href'), h: r.height, fs: parseFloat(getComputedStyle(a).fontSize), inside: r.left >= 0 && r.right <= innerWidth && r.width > 0, cut: a.scrollWidth > a.clientWidth };
        }),
      };
    });
    assert.equal(m.open, true);
    assert.equal(m.links.length, before.previewHrefs.length, 'one link for each preview card');
    assert.deepEqual(m.links.map((l) => l.href), before.previewHrefs, 'the links go where the cards go');
    assert.ok(m.navScroll <= 0 && m.pageScroll <= 0, `sideways scroll: list ${m.navScroll}px, page ${m.pageScroll}px`);
    const bad = m.links.filter((l) => !l.inside || l.cut || l.h < 44 || l.fs < 15);
    assert.deepEqual(bad, [], 'every link is fully on screen, not cut, at least 44 px tall and 15 px text');
    assert.deepEqual(errors, []);
    await context.close();
  });
}

test('desktop front page: the modules grid still shows all 12 cards, with no phone list (issue #54)', async () => {
  const { context, page, errors } = await open(1280);
  const m = await page.evaluate(() => {
    const shown = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const cards = [...document.querySelectorAll('#modules .modules .mod')].filter(shown);
    return {
      cards: cards.length,
      columns: new Set(cards.map((c) => Math.round(c.getBoundingClientRect().left))).size,
      full: cards.every((c) => ['.st', 'h3', 'p:not(.short)', 'a'].every((q) => shown(c.querySelector(q)))),
      shortLines: [...document.querySelectorAll('#modules .mod p.short')].filter(shown).length,
      phoneList: shown(document.querySelector('#modules details.pv-wrap')),
      display: getComputedStyle(document.querySelector('#modules .modules')).display,
    };
  });
  assert.deepEqual(m, { cards: 12, columns: 3, full: true, shortLines: 0, phoneList: false, display: 'grid' });
  assert.deepEqual(errors, []);
  await context.close();
});

// Issue #77: the top bar is one slim line at every phone width, with the pilot button on one line.
for (const width of [320, 360, 375, 390]) {
  test(`phone front page at ${width}px: the top bar is 60 px or less and "Start a pilot" stays on one line (issue #77)`, async () => {
    const { context, page, errors } = await open(width);
    const bar = () => page.evaluate(() => {
      const b = document.querySelector('nav.links .btn-primary'); const r = b.getBoundingClientRect(); const s = getComputedStyle(b);
      return { header: document.querySelector('header.site').getBoundingClientRect().height, w: r.width, h: r.height, font: parseFloat(s.fontSize), lines: Math.round((r.height - parseFloat(s.paddingTop) - parseFloat(s.paddingBottom) - parseFloat(s.borderTopWidth) - parseFloat(s.borderBottomWidth)) / parseFloat(s.lineHeight)), visible: s.visibility, text: b.innerText.trim() };
    });
    const top = await bar();
    assert.ok(top.header <= 60, `at the top of the page the bar is ${top.header} px`);
    await page.evaluate(() => window.scrollTo(0, document.querySelector('.hero').offsetHeight + 200));
    await page.waitForFunction(() => getComputedStyle(document.querySelector('nav.links .btn-primary')).visibility === 'visible');
    const down = await bar();
    assert.equal(down.text, 'Start a pilot');
    assert.ok(down.header <= 60, `after the hero the bar is ${down.header} px`);
    assert.equal(down.lines, 1, `the button is ${down.w} x ${down.h} px`);
    assert.ok(down.h >= 44, 'a 44 px tap target');
    assert.ok(down.font >= 15, `button text is ${down.font} px`);
    const o = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(o <= 0, `scrolls sideways by ${o}px`);
    assert.deepEqual(errors, []);
    await context.close();
  });
}

// Issue #15, last part: every tap target on the phone front page is at least 44 px tall and every
// caption is at least 15 px, with every tap-to-open row closed and then with all of them open.
// Two narrow exemptions, and no others:
//  - tap targets: a link that sits inside a sentence, meaning an <a> whose parent is a <p> that also
//    holds words outside any link. A line of running text cannot be 44 px tall. Today that is only
//    the three links inside the roadmap paragraphs.
//  - text size: the small uppercase section eyebrows (.eyebrow), which the issue excepts as decoration.
const sizes15 = (page) => page.evaluate(() => {
  const seen = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && el.checkVisibility({ contentVisibilityAuto: true, visibilityProperty: true }); };
  const inSentence = (a) => a.tagName === 'A' && a.parentElement.tagName === 'P'
    && [...a.parentElement.childNodes].some((n) => n.nodeType === 3 && /\w/.test(n.textContent));
  const taps = [...document.querySelectorAll('a, button, summary')].filter(seen)
    .map((el) => ({ t: el.innerText.trim() || el.getAttribute('aria-label'), h: el.getBoundingClientRect().height, exempt: inSentence(el) }));
  const text = [];
  const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n; (n = tw.nextNode());) {
    const e = n.parentElement;
    if (!n.textContent.trim() || e.closest('script, style, .eyebrow') || !seen(e)) continue;
    text.push({ t: n.textContent.trim().slice(0, 30), fs: parseFloat(getComputedStyle(e).fontSize) });
  }
  const cut = [...document.querySelectorAll('.op-k, .sample, .timeline .wk')].filter(seen).filter((e) => { const b = e.getBoundingClientRect(); const p = e.parentElement.getBoundingClientRect(); return b.right > p.right + 0.5; }).map((e) => e.textContent);
  return { taps, text, cut, screens: document.documentElement.scrollHeight / innerHeight, sideways: document.documentElement.scrollWidth - innerWidth };
});

for (const width of [360, 390]) {
  test(`phone front page: every tap target is 44 px and every caption 15 px, rows closed and open (issue #15, ${width}px)`, async () => {
    const { context, page, errors } = await open(width);
    for (const state of ['closed', 'open']) {
      if (state === 'open') await page.evaluate(() => document.querySelectorAll('details').forEach((d) => { d.open = true; }));
      const m = await sizes15(page);
      const short = m.taps.filter((x) => !x.exempt && x.h < 44);
      assert.ok(m.taps.length > 20, `${m.taps.length} tap targets found`);
      assert.deepEqual(short.map((x) => `${x.t} ${Math.round(x.h)}px`), [], `tap targets under 44 px (${state})`);
      assert.ok(m.taps.filter((x) => x.exempt).length <= 3, 'the in-sentence exemption stays narrow');
      const small = m.text.filter((x) => x.fs < 15);
      assert.ok(m.text.length > 40, `${m.text.length} pieces of text found`);
      assert.deepEqual(small.map((x) => `${x.t} ${x.fs.toFixed(1)}px`), [], `text under 15 px (${state})`);
      assert.deepEqual(m.cut, [], 'bigger labels still fit their tiles');
      assert.ok(m.sideways <= 0, `scrolls sideways by ${m.sideways}px`);
      if (state === 'closed') assert.ok(m.screens < 6.85, `page is ${m.screens.toFixed(2)} screens; the bigger captions must not lengthen it`);
    }
    // The named items from the issue, by name.
    const named = await page.evaluate(() => Object.fromEntries(['.op-k', '.sample', '.steps .short', '.contact small', '.pb .io', '.swipe-hint', '.timeline .wk', 'footer .wrap > span']
      .map((s) => [s, parseFloat(getComputedStyle(document.querySelector(s)).fontSize)])));
    for (const [sel, fs] of Object.entries(named)) assert.ok(fs >= 15, `${sel} is ${fs}px`);
    assert.equal(await page.locator('.board .sample').innerText(), 'ILLUSTRATION', 'the example-data badge stays');
    assert.ok(await page.locator('.board .sample').isVisible());
    assert.deepEqual(errors, []);
    await context.close();
  });
}

test('phone front page at 320px: the bigger labels fit and nothing scrolls sideways (issue #15)', async () => {
  const { context, page } = await open(320);
  const m = await sizes15(page);
  assert.deepEqual(m.cut, []);
  assert.ok(m.sideways <= 0, `scrolls sideways by ${m.sideways}px`);
  await context.close();
});

// Measured on main before the phone fix; the fix lives only inside max-width 640px rules.
const DESKTOP15 = {
  fs: { '.op-k': 11.52, '.sample': 10.88, '.op-l': 12.8, '.steps .long': 15.68, '.contact small': 14.17, '.pb .io': 14.72, '.timeline .wk': 12.8, '.timeline.road p': 15.68, 'footer .wrap': 14.72 },
  spacing: ['1.3824px', '1.28px'],
  pad: ['72px', '16px', '72px', '16px', '20px', '18px'],
  hidden: ['none', 'none'],
};
test('desktop front page: captions and labels keep their desktop sizes (issue #15)', async () => {
  const { context, page } = await open(1280);
  const m = await page.evaluate(() => {
    const q = (s) => document.querySelector(s);
    const fs = (s) => +parseFloat(getComputedStyle(q(s)).fontSize).toFixed(2);
    return {
      fs: Object.fromEntries(['.op-k', '.sample', '.op-l', '.steps .long', '.contact small', '.pb .io', '.timeline .wk', '.timeline.road p', 'footer .wrap'].map((s) => [s, fs(s)])),
      spacing: [getComputedStyle(q('.op-k')).letterSpacing, getComputedStyle(q('.timeline .wk')).letterSpacing],
      pad: [getComputedStyle(q('#how')).paddingTop, getComputedStyle(q('.ops')).paddingTop, getComputedStyle(q('.hero .wrap')).paddingBottom, getComputedStyle(q('.contact')).rowGap, getComputedStyle(q('.steps')).rowGap, getComputedStyle(q('.steps li')).paddingTop],
      hidden: ['.swipe-hint', '.steps .short'].map((s) => getComputedStyle(q(s)).display),
    };
  });
  assert.deepEqual(m, DESKTOP15);
  await context.close();
});

// Issue #88: a row tagged Built opens the built module in the app, and says only what that module does.
// Issue #22 (leftover): the sentence under the H1 names only what is built; other areas are previews.
for (const width of [360, 1280]) {
  test(`front page: every Built row opens the app, and the hero names only built modules (issues #88, #22, ${width}px)`, async () => {
    const { context, page, errors } = await open(width);
    const shownText = (sel) => page.evaluate((s) => [...document.querySelectorAll(s)].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; }).map((e) => e.innerText.trim()).join(' '), sel);
    const rows = await page.evaluate(() => [...document.querySelectorAll('#modules .modules .mod')].filter((c) => c.querySelector('.st').textContent.trim() === 'Built').map((c) => ({
      name: c.querySelector('h3').textContent.trim(), href: c.querySelector('a').getAttribute('href'), link: c.querySelector('a').textContent.trim(), text: c.textContent })));
    assert.deepEqual(rows.map((r) => [r.name, r.href, r.link]), [
      ['Bed board', 'app/#/beds', 'Open the app'],
      ['Medical equipment and maintenance', 'app/#/engineering', 'Open the app'],
      ['Process mapping', 'app/#/process', 'Open the app'],
    ]);
    const beds = rows[0].text;
    assert.doesNotMatch(beds, /declin/i, 'the built bed board has no decline step');
    assert.match(beds, /find a bed with undo/i);
    // The hero sentence: emergency department flow is a preview, so it is not listed as part of the system.
    const lead = await shownText('.hero .lead');
    assert.ok(lead.length > 40, 'a lead sentence is shown');
    assert.doesNotMatch(lead.split(/previews? of/i)[0], /\bED flow\b|emergency department flow/i, 'ED flow is not listed as built');
    assert.match(lead, /previews? of/i);
    assert.doesNotMatch(lead, /prove what/i, 'no promised result');
    // The link really opens the built module.
    await page.locator('#modules .modules .mod a[href="app/#/beds"]').evaluate((a) => a.click());
    await page.waitForSelector('html[data-ready="true"]');
    assert.match(page.url(), /\/app\/#\/beds/);
    await page.waitForFunction(() => /Ward A1/.test(document.body.innerText));
    assert.doesNotMatch(await page.locator('body').innerText(), /4B · Adult medical/);
    assert.deepEqual(errors, []);
    await context.close();
  });
}
