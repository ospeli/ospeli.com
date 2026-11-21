// The site server's trail mark and start-up check (ospeli/ospeli issue #73, docs/SECURITY.md row A2).
// Each test does the bad thing to a throwaway data file on this computer, the way a person with
// the file would: remove the newest entries, rewrite an entry and work the check codes out again,
// or edit one entry. The self-check alone misses the first two; a mark a person wrote down does not.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const emit = process.emitWarning;
process.emitWarning = (w, ...rest) => (/SQLite/i.test(String(w?.message || w)) ? undefined : emit.call(process, w, ...rest));
const { startServer } = await import('../../tools/ospeli-server/site-server.mjs');
const { canonical } = await import('../../web/app/core/audit.js');

const END = '2026-11-08T12:00:00.000Z';
const dir = mkdtempSync(join(tmpdir(), 'ospeli-mark-'));
const sites = [];
after(async () => { for (const s of sites) await s.close().catch(() => {}); rmSync(dir, { recursive: true, force: true }); });

let n = 0;
const newFile = () => join(dir, `site-${++n}.db`);
async function start(file) {
  const t = { now: Date.parse(END) };
  const said = [];
  const site = await startServer({ file, port: 0, end: END, clock: () => new Date(t.now += 1000), notify: (text) => said.push(text) });
  sites.push(site);
  return { site, said };
}
const MARK = /Mark for the trail as it is now: (\d+ [0-9a-f]{4}(?:-[0-9a-f]{4}){4})/;
// Some entries in the trail: a bot is let in and removed, each recorded.
async function work(site, name) {
  for (const line of ['setup agent', name, '2', '1', '']) await site.consoleLine(line);
  await site.consoleLine(`remove agent ${name}`);
}
// What a person with the data file can do while the server is off.
function withFile(file, fn) { const db = new DatabaseSync(file); try { return fn(db); } finally { db.close(); } }
const body = (e) => ({ seq: e.seq, at: e.at, actorRole: e.actorRole, actorType: e.actorType, agent: e.agent, via: e.via, device: e.device, action: e.action, target: e.target, detail: e.detail, prev: e.prev });
const rehash = (e) => createHash('sha256').update(canonical(body(e))).digest('hex');

test('the mark: a trail that only grew is "the same"; the mark is not stored anywhere', async () => {
  const file = newFile();
  const { site } = await start(file);
  await work(site, 'night-helper');
  const shown = await site.consoleLine('audit');
  const mark = MARK.exec(shown)?.[1];
  assert.ok(mark, `audit shows a mark to write down:\n${shown}`);
  assert.match(shown, /Ospeli keeps no copy/);
  assert.match(await site.consoleLine(`audit check ${mark}`), /^The same\. Entries 1 to \d+ .* Nothing has been added since\./);
  await work(site, 'day-helper');
  const later = await site.consoleLine(`audit check ${mark}`);
  assert.match(later, /^The same\..* \d+ entries have been added since\. \(This says nothing about the event log/);
  // Typed the way a person copies it: capitals, spaces for dashes.
  assert.match(await site.consoleLine(`AUDIT CHECK ${mark.toUpperCase().replace(/-/g, ' ')}`), /^The same\./);
  // One character copied wrongly is not "the same".
  const [seq, hex] = mark.split(' ');
  const wrong = `${seq} ${hex.slice(0, -1)}${hex.endsWith('0') ? '1' : '0'}`;
  assert.match(await site.consoleLine(`audit check ${wrong}`), /^NOT THE SAME\. Entry \d+ is not the entry this mark was taken from/);
  assert.match(await site.consoleLine('audit check soon'), /^Type audit to check the trail/);
  assert.match(await site.consoleLine('audit check 0 0000-0000-0000-0000-0000'), /entry number, 1 or more/);
  await site.close();
  const stored = withFile(file, (db) => db.prepare('SELECT v FROM meta').all().map((r) => r.v).join('\n'));
  assert.ok(!stored.includes(hex) && !stored.includes(hex.replace(/-/g, '')), 'the mark is not kept in the data file');
});

test('attack: the newest entries are removed from the data file; the self-check passes, the mark says they are gone', async () => {
  const file = newFile();
  let { site } = await start(file);
  await work(site, 'night-helper');
  const mark = MARK.exec(await site.consoleLine('audit'))[1];
  const seq = Number(mark.split(' ')[0]);
  await site.close();
  withFile(file, (db) => db.prepare('DELETE FROM audit WHERE k > ?').run(seq - 3));
  let said;
  ({ site, said } = await start(file));
  assert.equal(said.filter((s) => /BROKEN/.test(s)).length, 0, 'the self-check alone does not notice (issue #79 says so)');
  assert.match(await site.consoleLine('audit'), /Self-check passed/);
  const answer = await site.consoleLine(`audit check ${mark}`);
  assert.match(answer, new RegExp(`^NOT THE SAME\\. The mark was taken at entry ${seq}, and the trail now has ${seq - 3} entries: entries were removed\\.`));
});

test('attack: one entry is rewritten and every check code after it worked out again; the self-check passes, the mark does not', async () => {
  const file = newFile();
  let { site } = await start(file);
  await work(site, 'night-helper');
  const mark = MARK.exec(await site.consoleLine('audit'))[1];
  await site.close();
  withFile(file, (db) => {
    const rows = db.prepare('SELECT k, v FROM audit ORDER BY k').all().map((r) => JSON.parse(r.v));
    const i = rows.findIndex((e) => e.action === 'agents.added' || /agent/.test(e.action));
    assert.ok(i >= 0, 'there is an agent entry to rewrite');
    rows[i].actorRole = 'coo';
    for (let j = i; j < rows.length; j += 1) { rows[j].prev = j ? rows[j - 1].hash : '0'.repeat(64); rows[j].hash = rehash(rows[j]); }
    const put = db.prepare('UPDATE audit SET v = ? WHERE k = ?');
    for (const e of rows.slice(i)) put.run(JSON.stringify(e), e.seq);
  });
  let said;
  ({ site, said } = await start(file));
  assert.equal(said.length, 0);
  assert.match(await site.consoleLine('audit'), /Self-check passed/, 'a re-coded trail passes the self-check, as the published table says');
  assert.match(await site.consoleLine(`audit check ${mark}`), /^NOT THE SAME\. Entry \d+ is not the entry this mark was taken from: the trail was changed/);
});

test('attack: one entry is edited and the check codes left alone; Ospeli says so when it starts, not only when asked', async () => {
  const file = newFile();
  let { site } = await start(file);
  await work(site, 'night-helper');
  const mark = MARK.exec(await site.consoleLine('audit'))[1];
  assert.doesNotMatch(await site.banner(), /audit trail did not pass/);
  await site.close();
  withFile(file, (db) => {
    const row = db.prepare('SELECT k, v FROM audit ORDER BY k LIMIT 1 OFFSET 2').get();
    const e = JSON.parse(row.v); e.actorRole = 'coo';
    db.prepare('UPDATE audit SET v = ? WHERE k = ?').run(JSON.stringify(e), row.k);
  });
  let said;
  ({ site, said } = await start(file));
  assert.equal(said.length, 1);
  assert.match(said[0], /^Audit trail: BROKEN at entry 3 \(entry was changed\)\. Tell the person who looks after this server\. Found when Ospeli started\.$/);
  assert.match(await site.banner(), /Warning: the audit trail did not pass its self-check when Ospeli started \(entry 3\)\. Type: audit/);
  const shown = await site.consoleLine('audit');
  assert.match(shown, /^Audit trail: BROKEN at entry 3/);
  assert.doesNotMatch(shown, /Mark for the trail/, 'no mark is offered for a trail that does not hold together');
  assert.match(await site.consoleLine(`audit check ${mark}`), /^Audit trail: BROKEN at entry 3/, 'a mark is never called the same on a broken trail');
});
