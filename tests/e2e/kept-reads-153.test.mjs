// Issue #153 (speed): the browser keeps the last whole read of the event log and of the list of
// places in memory, and uses it only while the store has not changed (core/db.js). These tests
// check the two things that must hold: the kept answer is always what storage holds, and a page
// change no longer reads the whole log out of storage.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, openPage } from './helpers.mjs';

let env;
before(async () => { env = await startApp(); });
after(async () => { await env.close(); });

// What storage holds, read directly (never through the app's adapter).
const raw = (page, store) => page.evaluate((s) => new Promise((resolve, reject) => {
  const r = indexedDB.open('ospeli');
  r.onerror = () => reject(r.error);
  r.onsuccess = () => { const q = r.result.transaction(s).objectStore(s).getAll(); q.onsuccess = () => { r.result.close(); resolve(JSON.stringify(q.result)); }; };
}), store);
const viaApp = (page, store) => page.evaluate(async (s) => JSON.stringify(await window.ospeli.core.db.getAll(s)), store);
const reads = (page) => page.evaluate(() => ({ ...window.ospeli.core.db.reads }));
const same = async (page, why) => {
  for (const store of ['events', 'entities']) assert.ok(await viaApp(page, store) === await raw(page, store), `${store}: the app reads what storage holds (${why})`);
};

test('first load: the example site just made is not read back out of storage, and every built page then opens without a storage read of the log', async () => {
  const { context, page, errors } = await openPage(env, { width: 360, height: 740, touch: true });
  const first = await reads(page);
  assert.ok(first.storage <= 1, `at most one whole read from storage during the first load (the check that the device is empty), got ${first.storage}`);
  assert.ok(first.kept >= 1, 'the first page was drawn from the kept answer');
  await same(page, 'after the first load');
  // Navigation v2: every built page is a link on the dock, a chip on Journey (not the planned ones
  // under "Coming later"), or a row on Me (AI helpers, Data and audit).
  const drawnAt = (h) => page.waitForFunction((x) => document.documentElement.dataset.route === x.replace(/\/$/, '') && !document.querySelector('main .loading'), h);
  const linksOn = async (hash, sel) => {
    await page.evaluate((h) => { location.hash = h; }, hash);
    await drawnAt(hash);
    return page.locator(sel).evaluateAll((as) => as.filter((a) => !a.closest('details[data-test="coming-later"]') && !a.hasAttribute('data-planned') && !a.querySelector('.soon-tag')).map((a) => a.getAttribute('href')));
  };
  const dock = await page.locator('#dock a[href^="#/"]').evaluateAll((as) => as.map((a) => a.getAttribute('href')));
  const journey = await linksOn('#/journey', '#main .journey a[data-module][href^="#/"]');
  const me = await linksOn('#/me', '#main [data-test="me-agents"] a[href^="#/"], #main a[data-test="me-agents"], #main [data-test="me-data"] a[href^="#/"], #main a[data-test="me-data"]');
  assert.equal(me.length, 2, `Me has the AI helpers and the Data rows: ${me.join(', ')}`);
  const pages = [...new Set([...dock, ...journey, ...me])];
  assert.ok(pages.length >= 10, `built pages found: ${pages.length}`);
  for (const hash of pages) {
    await page.evaluate((h) => { location.hash = h; }, hash);
    await drawnAt(hash);
    await page.waitForTimeout(150);
  }
  const later = await reads(page);
  assert.equal(later.storage, first.storage, 'no page change read a whole store out of storage again');
  assert.ok(later.kept > first.kept, 'the pages read from the kept answer');
  await same(page, 'after opening every page');
  assert.deepEqual(errors, []);
  await context.close();
});

test('after each kind of write the kept answer is what storage holds: one event, a place changed, many events, a reset', async () => {
  const { context, page, errors } = await openPage(env);
  await page.evaluate(async () => {
    const { core } = window.ospeli;
    await core.events(); await core.listEntities();
    await core.appendEvent({ type: 'bed.cleaning-started', subject: 'bed-a1-01', actorRole: 'ward-nurse' });
  });
  await same(page, 'one event added');
  await page.evaluate(async () => {
    const { core } = window.ospeli;
    const bed = (await core.listEntities('bed'))[0];
    await core.putEntity({ ...bed, name: `${bed.name} (side room)` }, 'ops-manager');
  });
  await same(page, 'a place changed');
  await page.evaluate(async () => {
    const { core } = window.ospeli;
    await core.appendEvents(Array.from({ length: 1200 }, (_, i) => ({ type: 'bed.cleaning-started', subject: `bed-a1-${String((i % 9) + 1).padStart(2, '0')}`, actorRole: 'system' })), 'system', 'test batch');
  });
  await same(page, '1,200 events added at once');
  const before = await reads(page);
  await page.evaluate(() => window.ospeli.core.events());
  assert.equal((await reads(page)).storage, before.storage, 'the read after these writes still came from the kept answer');
  await page.evaluate(() => window.ospeli.core.reset('ops-manager'));
  await same(page, 'reset');
  assert.equal(await page.evaluate(async () => (await window.ospeli.core.events()).length), 0);
  assert.deepEqual(errors, []);
  await context.close();
});

test('a write that is refused (a key that exists) changes nothing, in storage or in the kept answer', async () => {
  const { context, page, errors } = await openPage(env);
  const out = await page.evaluate(async () => {
    const { db } = window.ospeli.core;
    const all = await db.getAll('events');
    const last = all[all.length - 1];
    let name = null;
    try { await db.addMany('events', [{ ...last, seq: last.seq + 1 }, { ...last }]); } catch (e) { name = e.name; }
    return { name, before: all.length, after: (await db.getAll('events')).length };
  });
  assert.equal(out.name, 'ConstraintError');
  assert.equal(out.after, out.before, 'all or nothing: the first record of the refused batch is not kept either');
  await same(page, 'a refused batch');
  assert.deepEqual(errors, []);
  await context.close();
});

test('a record handed out cannot be changed by the caller, and a sorted or filtered list does not change the next read', async () => {
  const { context, page, errors } = await openPage(env);
  const out = await page.evaluate(async () => {
    'use strict'; // as in the app's own files (modules), where changing a frozen record is an error
    const { core } = window.ospeli;
    const list = await core.db.getAll('events');
    let refused = false;
    try { list[0].type = 'changed.by-a-caller'; } catch { refused = true; }
    let nested = false;
    const withData = list.find((e) => e.data && typeof e.data === 'object');
    try { withData.data.added = true; } catch { nested = true; }
    list.reverse(); list.length = 3;
    const again = await core.db.getAll('events');
    return { refused, nested, firstSeq: again[0].seq, length: again.length, type: again[0].type };
  });
  assert.equal(out.refused, true, 'a record is frozen');
  assert.equal(out.nested, true, 'and so is what is inside it');
  assert.equal(out.firstSeq, 1);
  assert.ok(out.length > 5000);
  assert.notEqual(out.type, 'changed.by-a-caller');
  assert.deepEqual(errors, []);
  await context.close();
});

test('two tabs: what one tab writes, the other reads on its very next read (no wait for a message between tabs)', async () => {
  const { context, page, errors } = await openPage(env);
  const other = await context.newPage();
  await other.goto(env.appUrl);
  await other.waitForSelector('html[data-ready="true"]');
  const n = await page.evaluate(async () => (await window.ospeli.core.events()).length);
  assert.equal(await other.evaluate(async () => (await window.ospeli.core.events()).length), n);
  // The second tab writes through its own adapter only: no message is sent to the first tab.
  await other.evaluate(async () => {
    const { db } = window.ospeli.core;
    const last = await db.last('events');
    await db.addMany('events', [{ ...last, seq: last.seq + 1, type: 'bed.cleaning-started' }]);
  });
  assert.equal(await page.evaluate(async () => (await window.ospeli.core.db.getAll('events')).length), n + 1, 'the first tab sees the new event at once');
  await same(page, 'another tab added an event');
  // The same for a place changed in the other tab (same number of records, same last key).
  await other.evaluate(async () => {
    const { db } = window.ospeli.core;
    const bed = (await db.getAll('entities')).find((e) => e.type === 'bed');
    await db.put('entities', { ...bed, name: 'Changed in the other tab' });
  });
  assert.ok(await page.evaluate(async () => (await window.ospeli.core.db.getAll('entities')).some((e) => e.name === 'Changed in the other tab')), 'the first tab sees the changed place at once');
  await same(page, 'another tab changed a place');
  await same(other, 'the writing tab');
  assert.deepEqual(errors, []);
  await context.close();
});

test('a tab still on the last release (it writes no mark): an event it adds, or a log it clears, is still seen at once', async () => {
  const { context, page, errors } = await openPage(env);
  const n = await page.evaluate(async () => (await window.ospeli.core.db.getAll('events')).length);
  // Written straight to storage, as the release before this one did: no new mark.
  const add = (records) => page.evaluate((recs) => new Promise((resolve, reject) => {
    const r = indexedDB.open('ospeli');
    r.onsuccess = () => { const tx = r.result.transaction('events', 'readwrite'); const os = tx.objectStore('events'); if (recs) for (const x of recs) os.add(x); else os.clear(); tx.oncomplete = () => { r.result.close(); resolve(); }; tx.onabort = () => reject(tx.error); };
  }), records);
  await add([{ seq: n + 1, type: 'bed.cleaning-started', subject: 'bed-a1-01', actorRole: 'ward-nurse', at: '2026-11-18T10:00:00.000Z', recordedAt: '2026-11-18T10:00:00.000Z', data: null }]);
  assert.equal(await page.evaluate(async () => (await window.ospeli.core.db.getAll('events')).length), n + 1);
  await same(page, 'an old tab added an event');
  await add(null);
  assert.equal(await page.evaluate(async () => (await window.ospeli.core.db.getAll('events')).length), 0);
  assert.deepEqual(errors, []);
  await context.close();
});

test('a device that stored its data before this release gets its marks on the next open and reads correctly', async () => {
  const { context, page, errors } = await openPage(env);
  // Take the marks away, as on a device set up by the release before this one.
  await page.evaluate(() => new Promise((resolve) => {
    const r = indexedDB.open('ospeli');
    r.onsuccess = () => { const tx = r.result.transaction('meta', 'readwrite'); tx.objectStore('meta').delete('_rev:events'); tx.objectStore('meta').delete('_rev:entities'); tx.oncomplete = () => { r.result.close(); resolve(); }; };
  }));
  // With no mark the app does not trust what it kept.
  const before = await reads(page);
  await page.evaluate(() => window.ospeli.core.db.getAll('events'));
  assert.equal((await reads(page)).storage, before.storage + 1, 'no mark: read from storage');
  await page.reload();
  await page.waitForSelector('html[data-ready="true"]');
  const marks = await page.evaluate(async () => [(await window.ospeli.core.db.get('meta', '_rev:events'))?.value, (await window.ospeli.core.db.get('meta', '_rev:entities'))?.value]);
  assert.ok(marks.every((m) => typeof m === 'string' && m.length >= 10), 'both marks are back');
  await same(page, 'after the reload');
  assert.deepEqual(errors, []);
  await context.close();
});

test('a batch with a record the storage refuses at once stores nothing, and the next read is still what storage holds', async () => {
  const { context, page, errors } = await openPage(env);
  const out = await page.evaluate(async () => {
    const { db } = window.ospeli.core;
    const places = await db.getAll('entities');
    const [a, b] = places;
    let refused = false;
    // The second record cannot be copied into storage (it holds a function).
    try { await db.putMany('entities', [{ ...a, name: 'Half of a refused batch' }, { ...b, broken: () => {} }]); } catch { refused = true; }
    return { refused, name: (await db.getAll('entities')).find((e) => e.id === a.id).name, was: a.name };
  });
  assert.equal(out.refused, true);
  assert.equal(out.name, out.was, 'the first record of the refused batch was not stored');
  await same(page, 'a batch refused at once');
  assert.deepEqual(errors, []);
  await context.close();
});
