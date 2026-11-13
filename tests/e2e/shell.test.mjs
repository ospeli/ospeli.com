import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startApp, openPage } from './helpers.mjs';

let env;
before(async () => { env = await startApp(); });
after(async () => { await env.close(); });

for (const width of [360, 390, 1024, 1280]) {
  test(`shell loads cleanly at ${width}px with no horizontal scroll`, async () => {
    const { context, page, errors } = await openPage(env, { width });
    assert.equal(await page.locator('.badge-synthetic').isVisible(), true);
    assert.equal(await page.locator('.brand img').evaluate((img) => img.complete && img.naturalWidth > 0), true);
    assert.equal(await page.locator('h1').textContent(), 'Ward nurse');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(overflow <= 0, `page scrolls sideways by ${overflow}px`);
    for (const route of ['data', 'beds', 'engineering']) {
      await page.goto(`${env.appUrl}#/${route}`);
      await page.waitForSelector('main h1');
      const o = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      assert.ok(o <= 0, `${route} scrolls sideways by ${o}px`);
    }
    assert.deepEqual(errors, []);
    await context.close();
  });
}

test('every role can be chosen; the choice persists and is audited', async () => {
  const { context, page, errors } = await openPage(env);
  const options = await page.locator('#role-select option').allTextContents();
  assert.deepEqual(options, ['Ward nurse', 'Bed manager', 'Estates tech', 'A&E nurse in charge', 'Ops manager', 'COO']);
  await page.selectOption('#role-select', 'estates-tech');
  await page.waitForFunction(() => document.querySelector('main h1')?.textContent === 'Estates tech');
  const first = await page.locator('[data-test="role-shortcuts"] h3').first().textContent();
  assert.match(first, /^Engineering/);
  await page.reload();
  await page.waitForSelector('html[data-ready="true"]');
  assert.equal(await page.inputValue('#role-select'), 'estates-tech');
  assert.equal(await page.locator('main h1').textContent(), 'Estates tech');
  const audit = await page.evaluate(() => window.ospeli.core.auditLog());
  assert.equal(audit.at(-1).action, 'role.changed');
  assert.equal(audit.at(-1).actorRole, 'estates-tech');
  assert.deepEqual(errors, []);
  await context.close();
});

test('phone menu opens the module list and marks the current page', async () => {
  const { context, page } = await openPage(env, { width: 390 });
  assert.equal(await page.locator('#nav').isVisible(), false);
  await page.click('#menu-btn');
  assert.equal(await page.getAttribute('#menu-btn', 'aria-expanded'), 'true');
  // A module not built yet (Engineering was built on night 4, so A&E flow stands in).
  await page.click('#nav a[data-module="ae"]');
  await page.waitForFunction(() => document.querySelector('main h1')?.textContent === 'A&E flow');
  assert.equal(await page.locator('#nav').isVisible(), false);
  assert.equal(await page.getAttribute('#nav a[data-module="ae"]', 'aria-current'), 'page');
  assert.match(await page.locator('main').textContent(), /Planned, not built yet/); // was "Coming in week 2" (issue #53: no build-month labels)
  await context.close();
});

test('keyboard: the first Tab reaches the skip link, and controls are labelled', async () => {
  const { context, page } = await openPage(env);
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.className), 'skip');
  const unlabelled = await page.evaluate(() => [...document.querySelectorAll('button, select, input, a')]
    .filter((el) => !(el.getAttribute('aria-label') || el.textContent.trim() || el.labels?.length || el.querySelector('img[alt]')))
    .map((el) => el.outerHTML.slice(0, 80)));
  assert.deepEqual(unlabelled, []);
  await context.close();
});

test('data persists in IndexedDB across reloads', async () => {
  const { context, page } = await openPage(env);
  assert.equal(await page.evaluate(() => window.ospeli.core.db.kind), 'indexeddb');
  const before = await page.evaluate(async () => (await window.ospeli.core.events()).length);
  await page.evaluate(() => window.ospeli.core.appendEvent({ type: 'bed.vacated', subject: 'bed-x', actorRole: 'ward-nurse' }));
  await page.reload();
  await page.waitForSelector('html[data-ready="true"]');
  const after = await page.evaluate(async () => (await window.ospeli.core.events()).length);
  assert.equal(after, before + 1);
  assert.equal(await page.evaluate(async () => (await window.ospeli.core.listEntities('bed')).length), 120, 'the hospital is not loaded twice');
  await context.close();
});

test('works offline after the first load', async () => {
  const { context, page, errors } = await openPage(env);
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  // Wait until the service worker controls the page (first visit is uncontrolled).
  await page.reload();
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  await context.setOffline(true);
  await page.goto(`${env.appUrl}#/data`);
  await page.waitForSelector('html[data-ready="true"]');
  assert.equal(await page.locator('main h1').textContent(), 'Your data stays on this device');
  const faces = await page.evaluate(async () => (await document.fonts.load('800 16px Nunito')).length);
  assert.ok(faces >= 1, 'Nunito 800 did not load from the offline cache');
  assert.deepEqual(errors, []);
  await context.close();
});

test('export, refuse a tampered file, then import a good one', async () => {
  const { context, page, errors } = await openPage(env, { path: '#/data' });
  const count = await page.evaluate(async () => (await window.ospeli.core.events()).length);
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('text=Export JSON')]);
  const file = path.join(os.tmpdir(), `ospeli-e2e-${Date.now()}.json`);
  await download.saveAs(file);
  const data = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(data.format, 'ospeli-export');
  assert.equal(data.events.length, count);
  assert.equal(data.entities.filter((e) => e.type === 'bed').length, 120);
  assert.equal(data.audit.at(-1).action, 'data.exported');

  const bad = structuredClone(data); bad.audit[0].actorRole = 'coo';
  const badFile = `${file}.bad.json`;
  await writeFile(badFile, JSON.stringify(bad));
  await page.setInputFiles('#import-file', badFile);
  await page.waitForFunction(() => /Import refused/.test(document.querySelector('[data-test="import-status"]').textContent));
  assert.match(await page.textContent('[data-test="import-status"]'), /audit trail broken/);

  await page.evaluate(() => window.ospeli.core.appendEvent({ type: 'bed.cleaned', subject: 'bed-x', actorRole: 'ward-nurse' }));
  page.once('dialog', (d) => d.accept());
  await page.setInputFiles('#import-file', file);
  await page.waitForFunction(() => /Imported/.test(document.querySelector('[data-test="import-status"]').textContent));
  const n = await page.evaluate(async () => (await window.ospeli.core.events()).length);
  assert.equal(n, count, 'the event added after export is gone after import');
  // An import replaces the history, so the pill says so and is never a clean green state (issue #79).
  assert.match(await page.textContent('[data-test="audit-status"]'), /^History replaced on /);
  assert.equal(await page.locator('[data-test="audit-status"].pill-ok').count(), 0);
  assert.deepEqual(errors, []);
  await context.close();
});

test('two tabs on one device keep one unbroken audit trail (issue #2)', async () => {
  const { context, page: a } = await openPage(env);
  const b = await context.newPage();
  await b.goto(env.appUrl);
  await b.waitForSelector('html[data-ready="true"]');
  const before = await a.evaluate(async () => (await window.ospeli.core.auditLog()).length);
  await a.selectOption('#role-select', 'bed-manager');
  await a.waitForFunction(() => document.querySelector('main h1')?.textContent === 'Bed manager');
  await b.selectOption('#role-select', 'coo');
  await b.waitForFunction(() => document.querySelector('main h1')?.textContent === 'COO');
  await a.selectOption('#role-select', 'estates-tech');
  await a.waitForFunction(() => document.querySelector('main h1')?.textContent === 'Estates tech');
  await a.goto(`${env.appUrl}#/data`);
  await a.waitForFunction(() => /^Self-check passed: \d+ entries$/.test(document.querySelector('[data-test="audit-status"]')?.textContent || ''));
  const audit = await a.evaluate(() => window.ospeli.core.auditLog());
  assert.equal(audit.length, before + 3);
  assert.deepEqual(audit.slice(-3).map((e) => e.detail.to), ['bed-manager', 'coo', 'estates-tech']);
  await context.close();
});

test('Escape closes the phone menu and returns focus to the Menu button (issue #8)', async () => {
  const { context, page } = await openPage(env, { width: 390 });
  await page.focus('#menu-btn');
  await page.keyboard.press('Enter');
  assert.equal(await page.locator('#nav').isVisible(), true);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#nav').isVisible(), false);
  assert.equal(await page.getAttribute('#menu-btn', 'aria-expanded'), 'false');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'menu-btn');
  await context.close();
});

// Issue #53: a role's shortcuts open things that role can use today. Pages that are not built are
// listed under one "Planned" heading, and no build-month label ("Week 3") is shown anywhere.
test('Today at 390px: every role gets at least three shortcuts and all of them are built; unbuilt pages sit under Planned (issue #53)', async () => {
  const { context, page, errors } = await openPage(env, { width: 390, height: 844 });
  const roles = await page.evaluate(() => [...document.querySelector('#role-select').options].map((o) => o.value));
  for (const role of roles) {
    await page.selectOption('#role-select', role);
    await page.waitForFunction(async (r) => (await window.ospeli.core.getMeta('role')) === r, role);
    await page.goto(`${env.appUrl}#/home`);
    await page.reload();
    await page.waitForSelector('html[data-ready="true"]');
    await page.waitForSelector('[data-test="role-shortcuts"] a');
    const seen = await page.evaluate(() => ({
      shortcuts: [...document.querySelectorAll('[data-test="role-shortcuts"] a')].map((a) => ({ href: a.getAttribute('href'), soon: a.classList.contains('is-soon'), h: a.getBoundingClientRect().height })),
      planned: [...document.querySelectorAll('[data-test="planned-modules"] a')].map((a) => a.textContent),
      elsewhere: [...document.querySelectorAll('main a.is-soon')].filter((a) => !a.closest('[data-test="planned-modules"]')).length,
      plannedBelow: document.querySelector('[data-test="planned-modules"]').getBoundingClientRect().top > document.querySelector('[data-test="role-shortcuts"]').getBoundingClientRect().bottom,
      text: document.querySelector('main').innerText + ' ' + document.querySelector('#nav').textContent,
    }));
    assert.ok(seen.shortcuts.length >= 3, `${role} has ${seen.shortcuts.length} shortcuts`);
    assert.ok(seen.shortcuts.every((s) => !s.soon), `${role}: a shortcut opens a page that is not built`);
    assert.ok(seen.shortcuts.every((s) => s.h >= 44));
    assert.ok(seen.planned.length >= 1 && seen.planned.every((t) => /Planned/.test(t)), `${role}: unbuilt pages are marked Planned`);
    assert.equal(seen.elsewhere, 0, `${role}: an unbuilt page is listed outside Planned`);
    assert.ok(seen.plannedBelow);
    assert.doesNotMatch(seen.text, /week \d/i, `${role}: a build-month label is shown`);
    // The first shortcut opens a real page.
    await page.locator('[data-test="role-shortcuts"] a').first().click();
    await page.waitForFunction(() => document.querySelector('main h1') && !/^Planned/.test(document.querySelector('main .eyebrow')?.textContent || ''));
  }
  // An unbuilt page says Planned, not a week.
  await page.goto(`${env.appUrl}#/dashboard`);
  await page.waitForFunction(() => document.querySelector('main h1')?.textContent === 'Operations dashboard');
  assert.match(await page.locator('main .eyebrow').textContent(), /^Planned/);
  assert.doesNotMatch(await page.locator('main').innerText(), /week \d/i);
  assert.deepEqual(errors, []);
  await context.close();
});

// Issue #79: the words and the pill say what the check proves and no more.
for (const width of [360, 390, 1280]) {
  test(`audit trail at ${width} px: the pill says "Self-check passed", the limits are one tap away, and a reset never shows a clean state`, async () => {
    const { context, page, errors } = await openPage(env, { path: '#/data', width, height: 800, touch: width < 1000 });
    const act = (sel) => (width < 1000 ? page.tap(sel) : page.click(sel));
    await page.waitForFunction(() => /^Self-check passed: \d+ entries$/.test(document.querySelector('[data-test="audit-status"]').textContent));
    assert.equal(await page.locator('[data-test="audit-status"].pill-ok').count(), 1);
    assert.match(await page.textContent('[data-test="audit-note"]'), /^No outside copy to compare with yet\.$/);
    const section = page.locator('section[aria-labelledby="audit-h"]');
    const words = await section.innerText();
    assert.match(words, /catches accidental damage/);
    assert.match(words, /does not yet show whether history was rewritten or shortened on purpose/);
    assert.doesNotMatch(await page.locator('main').innerText(), /Intact|so edits show up|tamper|append-only/i);
    // "What does this check?" opens the five published cases; only the first is caught.
    const summary = page.locator('[data-test="audit-what"] > summary');
    assert.ok((await summary.boundingBox()).height >= 44, 'the row is a 44 px tap target');
    await act('[data-test="audit-what"] > summary');
    const rows = await page.locator('[data-test="audit-what"] li').allInnerTexts();
    assert.equal(rows.length, 5);
    assert.deepEqual(rows.map((r) => /: Caught$/.test(r)), [true, false, false, false, false]);
    assert.ok(rows.slice(1).every((r) => /: Not caught$/.test(r)));
    if (width < 1000) {
      const sizes = await page.evaluate(() => [...document.querySelectorAll('[data-test="audit-what"] li, [data-test="audit-what"] summary, [data-test="audit-note"], section[aria-labelledby="audit-h"] .page-head p')].map((n) => parseFloat(getComputedStyle(n).fontSize)));
      assert.ok(sizes.every((px) => px >= 15), `new audit text is 15 px or more on a phone: ${sizes}`);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), 0, 'no sideways scroll');
    }
    // After a reset the pill says the history was replaced, in a neutral colour, and stays so after a reload.
    page.on('dialog', (d) => d.accept());
    await page.getByRole('button', { name: 'Reset device data' }).scrollIntoViewIfNeeded();
    await act('text=Reset device data');
    await page.waitForFunction(() => /^History replaced on .*20\d\d$/.test(document.querySelector('[data-test="audit-status"]').textContent));
    assert.equal(await page.locator('[data-test="audit-status"].pill-ok').count(), 0);
    assert.match(await page.textContent('[data-test="audit-note"]'), /replaced by a reset or a fresh copy\. Self-check passed on the 1 entry here now\. No outside copy to compare with yet\./);
    await Promise.all([page.waitForEvent('load'), act('text=Load a fresh copy')]);
    await page.waitForSelector('html[data-ready="true"]');
    await page.goto(`${env.appUrl}#/data`);
    await page.waitForFunction(() => /^History replaced on .*20\d\d$/.test(document.querySelector('[data-test="audit-status"]')?.textContent || ''));
    assert.deepEqual(errors, []);
    await context.close();
  });
}

// Issue #10: on a phone the role's shortcuts come before the key numbers; desktop keeps its order.
test('Today: shortcuts come before Key numbers on phones (360 and 390 px) and after them at 1280 px (issue #10)', async () => {
  for (const [width, height] of [[360, 780], [390, 844], [1280, 860]]) {
    const { context, page, errors } = await openPage(env, { width, height, touch: width < 1000 });
    await page.selectOption('#role-select', 'ward-nurse');
    await page.waitForSelector('[data-test="role-shortcuts"] a');
    await page.waitForSelector('#kpi-h');
    const y = await page.evaluate(() => ({ shortcuts: document.querySelector('[data-test="role-shortcuts"] a').getBoundingClientRect(), kpi: document.querySelector('#kpi-h').getBoundingClientRect().top }));
    if (width < 1000) {
      assert.ok(y.shortcuts.top < y.kpi, `${width}: shortcuts above Key numbers`);
      assert.ok(y.shortcuts.bottom <= height, `${width}: the first shortcut is on the first screen (ends at ${Math.round(y.shortcuts.bottom)})`);
    } else assert.ok(y.kpi < y.shortcuts.top, 'desktop: Key numbers first, as before');
    assert.deepEqual(errors, []);
    await context.close();
  }
});
