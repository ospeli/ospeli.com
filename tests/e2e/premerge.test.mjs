// The pre-merge checklist, browser part (founder, 24 Nov 2026, build review scenario E). The same
// faults were being found by hand, module after module: a page that scrolls sideways on a phone, a
// button too small for a thumb, text under 15 px, an accessibility fault a tool finds in a second,
// an error in the console. This file opens EVERY built page of the app (read from the module
// registry, so a new module is checked the night it lands, with no line added here) at 360 and
// 390 px, as the role that uses it, and checks all five.
//
// Faults already in the app on 25 Nov 2026 are listed in tests/premerge-known.json, by page and
// by kind of element. The rule is a ratchet:
//   - a fault that is NOT on the list fails the test (so nothing new gets in);
//   - a fault on the list that is no longer found is printed, and its line should be deleted;
//   - a line is never added to the list to make a test pass. Fix the page instead.
// To rewrite the list after fixing faults:  PREMERGE_WRITE=1 node --test tests/e2e/premerge.test.mjs
// (it only ever shortens the list for pages already on it).
//
// The static part of the checklist (neutral words, "only light", the offline cache list and its
// version) is in scripts/check.py. Speed against ospeli/ospeli#153 is scripts/speed-report.mjs.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { startApp, openPage, setRole } from './helpers.mjs';
import { MODULES, ROLE_MODULES } from '../../web/app/modules/registry.js';

const KNOWN_FILE = fileURLToPath(new URL('../premerge-known.json', import.meta.url));
const WRITE = process.env.PREMERGE_WRITE === '1';
const known = existsSync(KNOWN_FILE) ? JSON.parse(readFileSync(KNOWN_FILE, 'utf8')) : { pages: {} };
const WIDTHS = [360, 390];
export const CHECKS = ['sideways', 'taps', 'text', 'axe', 'console'];

// Every page the app has built, and the role that opens it first. The walk screen is a page of
// Process maps with its own layout, so it is listed by hand.
const roleFor = (id) => Object.keys(ROLE_MODULES).find((r) => ROLE_MODULES[r][0] === id) || Object.keys(ROLE_MODULES).find((r) => ROLE_MODULES[r].includes(id)) || 'ward-nurse';
export const PAGES = [
  ...MODULES.filter((m) => m.load).map((m) => ({ route: `#/${m.id === 'home' ? '' : m.id}`, id: m.id, role: roleFor(m.id) })),
  { route: '#/process/walk', id: 'process', role: roleFor('process') },
];

let axeSource;
try { axeSource = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8'); } catch { axeSource = null; }

let env;
before(async () => { env = await startApp(); });
after(async () => { await env.close(); });

// Runs in the page. Returns what is wrong, each fault named by the kind of element it is on
// (tag, type and classes), so twenty rows of the same list are one line and example data that
// changes the number of rows does not change the answer.
function inspect() {
  const sig = (n) => {
    const cls = [...n.classList].filter((c) => !/^(is-|has-)?(active|open|selected|current|on|off)$/.test(c)).sort().slice(0, 4).join('.');
    const type = n.getAttribute('type') || n.getAttribute('role');
    return n.tagName.toLowerCase() + (type ? `[${type}]` : '') + (cls ? `.${cls}` : n.id ? `#${n.id}` : '');
  };
  const where = (n) => { // the nearest named part of the page, so the line can be found
    const p = n.parentElement?.closest('[data-test], [id], dialog, nav, header, footer, main');
    return p ? (p.dataset.test ? `[data-test=${p.dataset.test}]` : p.id ? `#${p.id}` : p.tagName.toLowerCase()) : '';
  };
  const shown = (n) => {
    const r = n.getBoundingClientRect(); const s = getComputedStyle(n);
    return r.width > 1 && r.height > 1 && s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.01;
  };
  const out = { sideways: [], taps: [], text: [] };
  const over = document.documentElement.scrollWidth - document.documentElement.clientWidth;
  if (over > 0) out.sideways.push(`the page is ${over > 40 ? 'more than 40' : 'up to 40'} px wider than the screen`);
  // Text: every element that holds words of its own is at least 15 px (issue #13).
  for (const n of document.querySelectorAll('body *')) {
    if (!shown(n)) continue;
    if ([...n.childNodes].some((c) => c.nodeType === 3 && c.textContent.trim()) && parseFloat(getComputedStyle(n).fontSize) < 14.95) out.text.push(`${where(n)} ${sig(n)}`);
  }
  // Taps: everything a finger can press is at least 44 by 44 px. A tick box or radio button is
  // measured with its label, which is what the finger lands on. A link inside a sentence is left
  // out: it is as tall as its line of text (the exception WCAG 2.5.8 also makes).
  const pressable = 'a[href], button, input:not([type="hidden"]), select, textarea, summary, [role="button"], [role="tab"], [role="link"], [role="switch"], [role="checkbox"], [role="radio"], [tabindex]:not([tabindex="-1"])';
  for (const n of document.querySelectorAll(pressable)) {
    if (!shown(n) || n.disabled || n.closest('[inert]')) continue;
    if (n.tagName === 'A' && getComputedStyle(n).display === 'inline' && [...n.parentElement.childNodes].some((c) => c.nodeType === 3 && c.textContent.trim().length > 1)) continue;
    let r = n.getBoundingClientRect();
    if (n.tagName === 'INPUT' && /^(checkbox|radio)$/.test(n.type)) {
      const label = n.closest('label') || (n.id && document.querySelector(`label[for="${CSS.escape(n.id)}"]`));
      if (label) { const l = label.getBoundingClientRect(); if (l.width * l.height > r.width * r.height) r = l; }
    }
    if (r.width < 43.5 || r.height < 43.5) out.taps.push(`${where(n)} ${sig(n)}`);
  }
  for (const k of Object.keys(out)) out[k] = [...new Set(out[k])].sort();
  return out;
}

// axe-core's WCAG 2.1 A and AA rules, each fault named by rule and kind of element.
async function axeFaults(page) {
  await page.evaluate(axeSource);
  return page.evaluate(async () => {
    const res = await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] }, resultTypes: ['violations'] });
    const sig = (sel) => {
      const n = typeof sel === 'string' ? document.querySelector(sel) : null;
      if (!n) return String(sel).slice(0, 60);
      const cls = [...n.classList].sort().slice(0, 4).join('.');
      return n.tagName.toLowerCase() + (cls ? `.${cls}` : n.id ? `#${n.id}` : '');
    };
    return [...new Set(res.violations.flatMap((v) => v.nodes.map((node) => `${v.id}: ${sig(node.target[node.target.length - 1])}`)))].sort();
  });
}

async function settle(page, route) {
  const was = await page.evaluate(() => ({ n: Number(document.documentElement.dataset.drawn || 0), hash: location.hash }));
  await page.evaluate((h) => { location.hash = h; }, route);
  if (was.hash !== route) await page.waitForFunction((n) => Number(document.documentElement.dataset.drawn || 0) > n && !document.querySelector('main [aria-busy="true"]'), was.n, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(500); // a page that draws its numbers after its frame
  // A message fading in or out is part way between two colours, and the contrast check would read
  // that in-between colour. Wait until nothing on the page is moving (at most 4 s).
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running'), null, { timeout: 4000 }).catch(() => {});
}

const found = {}; // route -> check -> set of faults, over both widths
const note = (route, check, list) => { const s = ((found[route] ||= {})[check] ||= new Set()); for (const x of list) s.add(x); };

test('the accessibility checker is installed (npm install --no-save --no-package-lock axe-core@4.14.1)', () => {
  assert.ok(axeSource, 'axe-core is not installed, so the accessibility part of the checklist cannot run');
});

test('the checklist covers every built page in the module registry', () => {
  const built = MODULES.filter((m) => m.load).map((m) => m.id);
  assert.ok(built.length >= 16, `found ${built.length} built pages`);
  assert.deepEqual(built.filter((id) => !PAGES.some((p) => p.id === id)), []);
});

test('the checklist can fail: a small button, small text, a wide box and an unlabelled field put on a page are all found', async () => {
  const { context, page } = await openPage(env, { width: 360, height: 780, path: '#/me', clock: '2026-11-10T10:00:00Z', touch: true });
  await settle(page, '#/me');
  await page.evaluate(() => {
    const m = document.querySelector('main');
    m.insertAdjacentHTML('beforeend', '<div data-test="bad"><button class="tiny" style="width:30px;height:30px;padding:0">x</button><p class="fine" style="font-size:12px">small words</p><div style="width:900px;height:4px"></div><input class="nolabel" type="text"></div>');
  });
  const got = await page.evaluate(inspect);
  if (axeSource) got.axe = await axeFaults(page);
  await context.close();
  assert.ok(got.taps.some((f) => /button\.tiny/.test(f)), `small button found: ${got.taps}`);
  assert.ok(got.text.some((f) => /p\.fine/.test(f)), `small text found: ${got.text}`);
  assert.equal(got.sideways.length, 1, 'sideways scroll found');
  if (axeSource) assert.ok(got.axe.some((f) => /^label: input\.nolabel/.test(f)), `unlabelled field found: ${got.axe}`);
});

for (const width of WIDTHS) {
  test(`pre-merge checklist at ${width} px: every built page, no fault that is not already on the known list`, { timeout: 600000 }, async () => {
    const { context, page, errors } = await openPage(env, { width, height: 780, clock: '2026-11-10T10:00:00Z', touch: true });
    const fresh = [];
    let role = null;
    for (const p of [...PAGES].sort((a, b) => a.role.localeCompare(b.role))) {
      if (p.role !== role) { await setRole(page, p.role); role = p.role; }
      const before = errors.length;
      await settle(page, p.route);
      const got = await page.evaluate(inspect);
      got.axe = axeSource ? await axeFaults(page) : [];
      got.console = [...new Set(errors.slice(before).map((e) => e.replace(/\d+/g, 'N').slice(0, 140)))];
      for (const check of CHECKS) {
        note(p.route, check, got[check]);
        const ok = new Set(known.pages?.[p.route]?.[check] || []);
        for (const fault of got[check]) if (!ok.has(fault)) fresh.push(`${p.route} (${p.role}, ${width} px) ${check}: ${fault}`);
      }
    }
    await context.close();
    if (!WRITE) assert.deepEqual(fresh, [], `${fresh.length} new fault(s). Fix the page; never add a line to tests/premerge-known.json`);
  });
}

test('the known list only shrinks: faults on it that are gone are named, so their lines can be deleted', () => {
  const gone = [];
  const next = { note: known.note || 'Faults in the app when the pre-merge checklist was added (25 Nov 2026). Lines are only ever deleted. See tests/e2e/premerge.test.mjs.', pages: {} };
  for (const p of PAGES) {
    for (const check of CHECKS) {
      const now = [...(found[p.route]?.[check] || [])].sort();
      const was = known.pages?.[p.route]?.[check];
      // A page already on the list can only lose lines; a page not on it yet is written as found
      // (only the first time the list is made).
      const keep = was && known.pages[p.route] ? now.filter((f) => was.includes(f)) : (known.pages?.[p.route] ? [] : now);
      for (const f of was || []) if (!now.includes(f)) gone.push(`${p.route} ${check}: ${f}`);
      if (keep.length) (next.pages[p.route] ||= {})[check] = keep;
    }
  }
  const total = Object.values(next.pages).reduce((n, c) => n + Object.values(c).reduce((m, l) => m + l.length, 0), 0);
  console.log(`Pre-merge checklist: ${PAGES.length} pages at ${WIDTHS.join(' and ')} px; ${total} known fault line(s) still found; ${gone.length} no longer found.`);
  for (const g of gone) console.log(`  gone, delete its line: ${g}`);
  if (WRITE) writeFileSync(KNOWN_FILE, `${JSON.stringify(next, null, 1)}\n`);
});
