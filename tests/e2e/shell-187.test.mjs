// Issue #187 items 1, 3 and 4 and #182 items 11 and 12 (design audit 25 Nov 2026; crew night 4,
// crew/shell-187). Checked on a touch phone at 360 by 640 and 390 by 844. Synthetic hospital only.
//  1. Walk is 1 tap from the first cold open: the department sheet offers "Walk a visit now"
//     beside each department, which sets it and goes straight to Before you walk.
//  2. With a walk running, every button on every page of the module registry can be scrolled clear
//     of the ribbon and the dock and tapped (read from the registry: a new module is covered by itself).
//  3. On a short screen the ribbon is one row (words beside the button), and its message after a tap
//     is in plain words and goes away soon.
//  4. Coming-later pages: "Back to Journey" is a 44 px target. Diagnostics and Facilities keep their
//     "planned, not built yet" lines together, closed, under one "Coming later (n)".
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, openPage, setRole } from './helpers.mjs';
import { MODULES, ROLE_MODULES } from '../../web/app/modules/registry.js';
import { DEPARTMENTS } from '../../web/app/modules/departments.js';

let env;
before(async () => { env = await startApp(); });
after(async () => { await env.close(); });

const SIZES = [[360, 640], [390, 844]];
const route = (page, h) => page.waitForFunction((x) => document.documentElement.dataset.route === x, h);
const go = async (page, h) => { await page.evaluate((x) => { location.hash = x; }, h); await route(page, h); };
const ribbonShown = (page) => page.evaluate(() => { const r = document.querySelector('#walk-ribbon'); return !!r && !r.hidden && r.getBoundingClientRect().height > 0; });
// A walk started through the walk's own command, as the walk screen does; the ribbon then shows.
async function startWalk(page) {
  await page.evaluate(async () => {
    const { runCommand } = await import('./core/commands.js');
    await runCommand(window.ospeli.core, 'ospeli_walks_start', { guidanceSeen: true }, { type: 'human', role: document.documentElement.dataset.role });
  });
  await page.waitForFunction(() => { const r = document.querySelector('#walk-ribbon'); return r && !r.hidden; });
}

// ---------------------------------------------------------------- 1. one tap to Before you walk
for (const [width, height] of SIZES) {
  test(`${width}x${height}: from a fresh browser, one tap on the department sheet reaches Before you walk`, async () => {
    const { page, context, errors } = await openPage(env, { width, height, touch: true, department: null });
    let taps = 0;
    const tap = async (sel) => { await page.locator(sel).tap(); taps += 1; };
    assert.equal(await page.locator('#dept-sheet[open]').count(), 1, 'a first open asks for the department');
    // One plain "Walk a visit now" beside each department, a 44 px target with a name that says which department.
    const walks = await page.locator('#dept-sheet [data-dept-walk]').evaluateAll((els) => els.map((e) => ({
      id: e.dataset.deptWalk, text: e.textContent.trim(), label: e.getAttribute('aria-label') || e.textContent.trim(),
      w: e.getBoundingClientRect().width, h: e.getBoundingClientRect().height, f: parseFloat(getComputedStyle(e).fontSize), tag: e.tagName })));
    assert.deepEqual(walks.map((x) => x.id), DEPARTMENTS.map((d) => d.id));
    for (const x of walks) {
      assert.equal(x.text, 'Walk a visit now');
      assert.equal(x.tag, 'BUTTON');
      assert.ok(x.w >= 44 && x.h >= 44, `${x.id}: a ${x.w}x${x.h} px target`);
      assert.ok(x.f >= 15, `${x.id}: ${x.f} px words`);
      assert.ok(x.label.includes(DEPARTMENTS.find((d) => d.id === x.id).name), `${x.id}: its name says the department (${x.label})`);
    }
    // The department rows are as they were: one tap there still opens Now (navigation-v2.test.mjs).
    assert.equal(await page.locator('#dept-sheet [data-dept]').count(), DEPARTMENTS.length);
    await tap('#dept-sheet [data-dept-walk="outpatients"]');
    await page.waitForSelector('[data-test="walk-before"]');
    assert.equal(taps, 1, 'one tap from the cold open to Before you walk');
    assert.equal(await page.evaluate(() => location.hash), '#/process/walk');
    await page.waitForFunction(() => document.documentElement.dataset.department === 'outpatients' && document.documentElement.dataset.role === 'clinic-receptionist');
    assert.equal(await page.locator('#dept-sheet[open]').count(), 0);
    assert.equal((await page.textContent('#dept-name')).trim(), 'Outpatients');
    // Not now goes back to the maps page, with the department kept.
    await page.locator('[data-test="walk-before-no"]').tap();
    await route(page, '#/process');
    // The walk line is for the first open: changing department later from the chip keeps the sheet short.
    await page.locator('#dept-btn').tap();
    await page.waitForSelector('#dept-sheet[open]');
    assert.equal(await page.locator('#dept-sheet [data-dept-walk]').count(), 0);
    await page.keyboard.press('Escape');
    // The walk started from there takes the chosen department's words.
    await page.reload();
    await page.waitForSelector('html[data-ready="true"]');
    assert.equal(await page.locator('#dept-sheet[open]').count(), 0, 'the department is kept');
    assert.deepEqual(errors, []);
    await context.close();
  });
}

test('keyboard: "Walk a visit now" is reached with Tab and works with Enter', async () => {
  const { page, context, errors } = await openPage(env, { width: 390, height: 844, department: null });
  await page.locator('#dept-sheet [data-dept="imaging"]').focus();
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.dataset.deptWalk), 'imaging');
  await page.keyboard.press('Enter');
  await page.waitForSelector('[data-test="walk-before"]');
  await page.waitForFunction(() => document.documentElement.dataset.department === 'imaging');
  assert.deepEqual(errors, []);
  await context.close();
});

test('the homepage route ("Try a walk") is already on the walk: the sheet there offers the departments only', async () => {
  const { page, context, errors } = await openPage(env, { width: 360, height: 640, touch: true, department: null, path: '#/process/walk' });
  assert.equal(await page.locator('#dept-sheet[open]').count(), 1);
  assert.equal(await page.locator('#dept-sheet [data-dept-walk]').count(), 0);
  await page.locator('#dept-sheet [data-dept="outpatients"]').tap();
  await page.waitForSelector('[data-test="walk-before"]');
  assert.deepEqual(errors, []);
  await context.close();
});

// ---------------------------------------------------------------- 2. nothing under the ribbon and dock
const roleFor = (id) => Object.keys(ROLE_MODULES).find((r) => ROLE_MODULES[r][0] === id) || Object.keys(ROLE_MODULES).find((r) => ROLE_MODULES[r].includes(id)) || 'ward-nurse';
// Every page of the registry: built ones as the role that uses them first, planned ones as they come.
// A built page is also seen as a ward nurse (the role a ward department gives), where that is another
// role: some pages show a person who records more buttons, and a bar of their own pinned to the foot.
const PAGES = MODULES.flatMap((m) => [...new Set([m.load ? roleFor(m.id) : 'ward-nurse', 'ward-nurse'])].map((role) => ({ route: `#/${m.id}`, role })));
// The page's own screens (a row of links to #/<module>/<screen>, or tabs) are opened one by one.
const screensOf = (page, id) => page.evaluate((m) => [...new Set([...document.querySelectorAll(`#main a[href^="#/${m}/"]`)]
  .filter((a) => a.closest('nav, [class*="tabs"], [data-screen]') || a.dataset.screen || a.dataset.tab).map((a) => a.getAttribute('href')))], id);

// Runs in the page: each control a finger can press is scrolled to the middle of the free part of
// the screen (under the top bar, above the ribbon and dock) and must then be the thing under its
// own centre, inside that free part. Returns the ones that cannot.
function covered() {
  const pressable = 'a[href], button, input:not([type="hidden"]), select, textarea, summary, [role="button"], [role="tab"], [role="switch"], [role="checkbox"], [role="radio"]';
  const shown = (n) => { if (!n.checkVisibility({ contentVisibilityAuto: true, opacityProperty: true, visibilityProperty: true })) return false; const r = n.getBoundingClientRect(); const s = getComputedStyle(n); return r.width > 1 && r.height > 1 && s.visibility !== 'hidden' && Number(s.opacity) > 0.01; };
  const top = () => document.querySelector('.topbar').getBoundingClientRect().bottom;
  const foot = () => Math.min(document.querySelector('#walk-ribbon').getBoundingClientRect().top, document.querySelector('#dock').getBoundingClientRect().top);
  const name = (n) => `${n.tagName.toLowerCase()}${n.dataset.test ? `[data-test=${n.dataset.test}]` : ''}${n.className && typeof n.className === 'string' ? `.${n.className.trim().split(/\s+/).slice(0, 2).join('.')}` : ''} "${(n.textContent || n.value || n.getAttribute('aria-label') || '').trim().slice(0, 30)}"`;
  const bad = [];
  let n = 0;
  // A bar of the page's own pinned to the foot of the screen must stop above the ribbon and dock.
  for (const el of document.querySelectorAll('#main *')) {
    const s = getComputedStyle(el);
    if (!/sticky|fixed/.test(s.position) || s.bottom === 'auto' || !shown(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.bottom > foot() + 1 && r.top < innerHeight) bad.push(`${name(el)} is pinned ${s.bottom} from the foot of the screen, under the ribbon or dock (ends at ${Math.round(r.bottom)}, free part ends at ${Math.round(foot())})`);
  }
  for (const el of document.querySelectorAll(`#main :is(${pressable})`)) {
    if (!shown(el) || el.disabled || el.closest('[inert], dialog:not([open])')) continue;
    n += 1;
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' }); // a list that scrolls sideways
    const a = el.getBoundingClientRect();
    const mid = (top() + foot()) / 2;
    window.scrollTo(0, window.scrollY + a.top + a.height / 2 - mid);
    const r = el.getBoundingClientRect();
    const cx = Math.min(Math.max(r.left + r.width / 2, 1), innerWidth - 1);
    const cy = r.top + r.height / 2;
    const hit = document.elementFromPoint(cx, cy);
    const label = el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`) : null;
    const isMine = hit && (el.contains(hit) || hit.contains(el) && hit.closest('label') === hit || (label && label.contains(hit)));
    if (cy < top() || cy > foot() || !isMine) bad.push(`${name(el)} (centre at ${Math.round(cy)}, free part ${Math.round(top())} to ${Math.round(foot())}${isMine ? '' : `, under ${hit ? name(hit) : 'nothing'}`})`);
  }
  return { n, bad };
}

for (const [width, height] of SIZES) {
  test(`${width}x${height}: with a walk running, every button on every page of the registry can be scrolled clear of the ribbon and dock and tapped`, { timeout: 300000 }, async () => {
    const { page, context, errors } = await openPage(env, { width, height, touch: true, department: 'outpatients', clock: '2026-11-17T09:00:00Z' });
    await startWalk(page);
    const faults = [];
    let checked = 0;
    let role = null;
    for (const p of [...PAGES].sort((a, b) => a.role.localeCompare(b.role))) {
      if (p.role !== role) { await setRole(page, p.role); role = p.role; }
      await go(page, p.route);
      await page.waitForTimeout(300); // a page that draws its lists after its frame
      for (const r of [p.route, ...(await screensOf(page, p.route.slice(2)))]) {
        if (r !== p.route) { await go(page, r); await page.waitForTimeout(300); }
        assert.equal(await ribbonShown(page), true, `${r}: the ribbon shows`);
        const { n, bad } = await page.evaluate(covered);
        checked += n;
        for (const b of bad) faults.push(`${r} (${p.role}): ${b}`);
      }
    }
    assert.ok(checked > 200, `${checked} controls checked`);
    assert.deepEqual(faults, [], `${faults.length} control(s) cannot be scrolled clear of the ribbon and dock`);
    assert.deepEqual(errors, []);
    await context.close();
  });
}

// ---------------------------------------------------------------- 3. one-row ribbon, plain message
test('360x640: the ribbon is one row beside its button, keeps the step words, and its message is plain and brief', async () => {
  const { page, context, errors } = await openPage(env, { width: 360, height: 640, touch: true, department: 'imaging', clock: '2026-11-17T09:00:00Z' });
  await startWalk(page);
  await go(page, '#/journey');
  const look = await page.evaluate(() => {
    const box = (s) => document.querySelector(s).getBoundingClientRect();
    const w = document.querySelector('[data-test="ribbon-words"]');
    const line = document.querySelector('.wr-now');
    return { band: box('#walk-ribbon').height, act: box('[data-test="ribbon-act"]'), now: box('.wr-now'), words: w.textContent, wordsShown: w.checkVisibility(),
      step: document.querySelector('[data-test="ribbon-n"]')?.textContent || '', stepShown: !!document.querySelector('[data-test="ribbon-n"]')?.checkVisibility(),
      cut: line.scrollWidth > line.clientWidth + 1, f: parseFloat(getComputedStyle(w).fontSize) };
  });
  assert.ok(look.band <= 80, `the ribbon is ${look.band} px tall on a short screen (one row)`);
  assert.ok(look.now.top >= look.act.top - 1 && look.now.bottom <= look.act.bottom + 1, 'the words sit beside the button, in its row');
  assert.equal(look.words, 'Waiting'); assert.ok(look.wordsShown, 'the step words are shown');
  assert.equal(look.step, 'Step 1'); assert.ok(look.stepShown, 'the step number is shown');
  assert.equal(look.cut, false, 'no words are cut off');
  assert.ok(look.f >= 15);
  // The message after a tap on the ribbon: plain words, then gone within 3 s.
  await page.clock.fastForward(30000);
  await page.locator('[data-test="ribbon-act"]').tap();
  await page.waitForFunction(() => document.querySelector('#toast').classList.contains('show'));
  const said = await page.textContent('#toast');
  assert.doesNotMatch(said, /Undo is on the walk|Saved: step starts/);
  assert.equal(said, 'Step 1 started. Wrong tap? Open Walk to undo it.');
  await page.clock.fastForward(2600);
  await page.waitForFunction(() => !document.querySelector('#toast').classList.contains('show'));
  assert.deepEqual(errors, []);
  await context.close();
});

test('390x844: the ribbon keeps its full two lines on a taller phone', async () => {
  const { page, context, errors } = await openPage(env, { width: 390, height: 844, touch: true, department: 'imaging', clock: '2026-11-17T09:00:00Z' });
  await startWalk(page);
  await go(page, '#/journey');
  assert.equal(await page.locator('[data-test="ribbon-title"]').isVisible(), true);
  assert.equal(await page.locator('[data-test="ribbon-n"]').isVisible(), false, 'the step number is in the title line there');
  assert.deepEqual(errors, []);
  await context.close();
});

// ---------------------------------------------------------------- 4. coming later
test('a coming-later page: "Back to Journey" is a 44 px target', async () => {
  const { page, context, errors } = await openPage(env, { width: 360, height: 640, touch: true });
  for (const m of MODULES.filter((x) => !x.load)) {
    await go(page, `#/${m.id}`);
    const b = await page.locator('[data-test="soon-back"]').evaluate((e) => { const r = e.getBoundingClientRect(); return { w: r.width, h: r.height, text: e.textContent.trim(), href: e.getAttribute('href') }; });
    assert.ok(b.h >= 44 && b.w >= 44, `${m.id}: ${b.w}x${b.h} px`);
    assert.equal(b.text, 'Back to Journey'); assert.equal(b.href, '#/journey');
  }
  assert.deepEqual(errors, []);
  await context.close();
});

for (const [id, role] of [['diagnostics', 'diagnostics-manager'], ['diagnostics', 'lab-reception'], ['facilities', 'facilities-manager'], ['facilities', 'facilities-assistant']]) {
  test(`${id} (${role}): every "planned, not built yet" line is under one closed "Coming later (n)"`, async () => {
    const { page, context, errors } = await openPage(env, { width: 360, height: 640, touch: true, clock: '2026-11-17T09:00:00Z' });
    await setRole(page, role);
    await go(page, `#/${id}`);
    await page.waitForSelector('[data-test="page-coming-later"]');
    const look = await page.evaluate(() => {
      const box = document.querySelector('[data-test="page-coming-later"]');
      const lines = [...document.querySelectorAll('#main *')].filter((e) => [...e.childNodes].some((c) => c.nodeType === 3 && /planned, not built yet/i.test(c.textContent)));
      return { boxes: document.querySelectorAll('[data-test="page-coming-later"]').length, open: box.open, summary: box.querySelector('summary').textContent.trim(),
        items: box.querySelectorAll('li').length, outside: lines.filter((e) => !box.contains(e)).map((e) => e.textContent.slice(0, 60)),
        summaryH: box.querySelector('summary').getBoundingClientRect().height };
    });
    assert.equal(look.boxes, 1);
    assert.equal(look.open, false, 'closed until opened');
    assert.ok(look.items >= 1);
    assert.equal(look.summary, `Coming later (${look.items})`);
    assert.deepEqual(look.outside, [], 'no planned line outside the box');
    assert.ok(look.summaryH >= 44);
    await page.locator('[data-test="page-coming-later"] summary').tap();
    assert.equal(await page.locator('[data-test="page-coming-later"] li').first().isVisible(), true);
    assert.deepEqual(errors, []);
    await context.close();
  });
}
