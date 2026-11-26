// Security and audit, 26 Nov (ospeli/ospeli issue #73; docs/SECURITY.md row A2, hardening plan
// item 3). A copy of the data travels, and whoever holds it can rewrite the trail inside it and
// work the check codes out again: the self-check then passes. From tonight `backup` and
// `locked backup` print the mark of the trail as the copy holds it, for a person to keep with the
// copy and off the computer. Each test does the bad thing to a throwaway copy on this computer.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const emit = process.emitWarning;
process.emitWarning = (w, ...rest) => (/SQLite/i.test(String(w?.message || w)) ? undefined : emit.call(process, w, ...rest));
const { startServer } = await import('../../tools/ospeli-server/site-server.mjs');
const { canonical } = await import('../../web/app/core/audit.js');

const END = '2026-11-08T12:00:00.000Z';
const dir = mkdtempSync(join(tmpdir(), 'ospeli-copy-mark-'));
const sites = [];
after(async () => { for (const s of sites) await s.close().catch(() => {}); rmSync(dir, { recursive: true, force: true }); });

let n = 0;
async function start(file = join(dir, `site-${++n}.db`)) {
  const t = { now: Date.parse(END) };
  const site = await startServer({ file, port: 0, end: END, clock: () => new Date(t.now += 1000) });
  sites.push(site);
  return site;
}
async function work(site, name) {
  for (const line of ['setup agent', name, '2', '1', '']) await site.consoleLine(line);
  await site.consoleLine(`remove agent ${name}`);
}
const COPY_MARK = /Mark for the audit trail in this copy: (\d+ [0-9a-f]{4}(?:-[0-9a-f]{4}){4})/;
function withFile(file, fn) { const db = new DatabaseSync(file); try { return fn(db); } finally { db.close(); } }
const body = (e) => ({ seq: e.seq, at: e.at, actorRole: e.actorRole, actorType: e.actorType, agent: e.agent, via: e.via, device: e.device, action: e.action, target: e.target, detail: e.detail, prev: e.prev });
const rehash = (e) => createHash('sha256').update(canonical(body(e))).digest('hex');
const newest = (file) => withFile(file, (db) => JSON.parse(db.prepare('SELECT v FROM audit ORDER BY k DESC LIMIT 1').get().v));

test('backup prints the mark of the trail exactly as the copy holds it, and keeps no record of it', async () => {
  const site = await start();
  await work(site, 'night-helper');
  const copy = join(dir, 'plain-copy.db');
  const said = await site.consoleLine(`backup ${copy}`);
  const mark = COPY_MARK.exec(said)?.[1];
  assert.ok(mark, `backup gives a mark for the copy:\n${said}`);
  assert.match(said, /off this computer; Ospeli keeps no record of it/);
  const last = newest(copy);
  assert.equal(mark, `${last.seq} ${last.hash.slice(0, 20).match(/.{4}/g).join('-')}`, 'the mark is of the newest entry inside the copy');
  const [, hex] = mark.split(' ');
  const kept = withFile(copy, (db) => db.prepare('SELECT v FROM meta').all().map((r) => r.v).join('\n'));
  assert.ok(!kept.includes(hex), 'the mark is not written into the copy');
  // The untouched copy, started later, is "the same".
  await site.close();
  const later = await start(copy);
  assert.match(await later.consoleLine(`audit check ${mark}`), /^The same\. Entries 1 to \d+ /);
});

test('attack: the trail inside a copy is rewritten and re-coded; its self-check passes, the mark kept with the copy does not', async () => {
  const site = await start();
  await work(site, 'night-helper');
  const copy = join(dir, 'taken-copy.db');
  const mark = COPY_MARK.exec(await site.consoleLine(`backup ${copy}`))[1];
  await site.close();
  withFile(copy, (db) => {
    const rows = db.prepare('SELECT k, v FROM audit ORDER BY k').all().map((r) => JSON.parse(r.v));
    const i = rows.findIndex((e) => /agent/.test(e.action));
    assert.ok(i >= 0);
    rows[i].actorRole = 'coo';
    for (let j = i; j < rows.length; j += 1) { rows[j].prev = j ? rows[j - 1].hash : '0'.repeat(64); rows[j].hash = rehash(rows[j]); }
    const put = db.prepare('UPDATE audit SET v = ? WHERE k = ?');
    for (const e of rows.slice(i)) put.run(JSON.stringify(e), e.seq);
  });
  const later = await start(copy);
  assert.match(await later.consoleLine('audit'), /Self-check passed/, 'the re-coded copy passes the self-check');
  assert.match(await later.consoleLine(`audit check ${mark}`), /^NOT THE SAME\./);
});

test('attack: the newest entries are cut from a copy; the mark kept with the copy says they are gone', async () => {
  const site = await start();
  await work(site, 'night-helper');
  const copy = join(dir, 'cut-copy.db');
  const mark = COPY_MARK.exec(await site.consoleLine(`backup ${copy}`))[1];
  const seq = Number(mark.split(' ')[0]);
  await site.close();
  withFile(copy, (db) => db.prepare('DELETE FROM audit WHERE k > ?').run(seq - 2));
  const later = await start(copy);
  assert.match(await later.consoleLine(`audit check ${mark}`), /^NOT THE SAME\. The mark was taken at entry \d+, and the trail now has \d+ entries: entries were removed\./);
});

test('locked backup prints the same kind of mark, and it holds for the copy once opened', async () => {
  const site = await start();
  await work(site, 'night-helper');
  const locked = join(dir, 'copy.locked'); const opened = join(dir, 'opened.db');
  const pass = `${randomBytes(9).toString('base64url')} made at test time`;
  await site.consoleLine(`locked backup ${locked}`);
  await site.consoleLine(pass);
  const said = await site.consoleLine(pass);
  const mark = COPY_MARK.exec(said)?.[1];
  assert.ok(mark, `locked backup gives a mark for the copy:\n${said.replace(pass, '…')}`);
  assert.ok(!said.includes(pass), 'the passphrase is not said back');
  await site.consoleLine(`open backup ${locked} ${opened}`);
  assert.match(await site.consoleLine(pass), /^Opened\./);
  const last = newest(opened);
  assert.equal(mark, `${last.seq} ${last.hash.slice(0, 20).match(/.{4}/g).join('-')}`);
});
