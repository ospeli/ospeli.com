// Deep pass, import and export. Where the site server's `backup FILE` writes, tried
// against a throwaway server on this computer only (127.0.0.1, a port the system picks):
//  1. a copy is written readable by other accounts and only narrowed afterwards. SQLite makes the
//     file with the account's default permissions; the owner-only setting is applied when the
//     whole copy is on disk. The plain working copy of a `locked backup` is made the same way;
//  2. `backup FILE` writes into a file that is already there when it is empty, and through a link
//     that points somewhere else, where `locked backup` refuses both;
//  3. a copy saved into the folder the server hands out to browsers is then handed out to any
//     browser on the network, with no code and no key.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const emit = process.emitWarning;
process.emitWarning = (w, ...rest) => (/SQLite/i.test(String(w?.message || w)) ? undefined : emit.call(process, w, ...rest));
const { startServer } = await import('../../tools/ospeli-server/site-server.mjs');
const { SqliteAdapter } = await import('../../tools/ospeli-server/store.mjs');

const END = '2026-11-08T12:00:00.000Z';
const dir = mkdtempSync(join(tmpdir(), 'ospeli-backup-paths-'));
const sites = [];
after(async () => { for (const s of sites) await s.close().catch(() => {}); rmSync(dir, { recursive: true, force: true }); });
let n = 0;
async function start(more = {}) {
  const t = { now: Date.parse(END) };
  const site = await startServer({ file: join(dir, `site-${++n}.db`), port: 0, end: END, clock: () => new Date(t.now += 1000), ...more });
  sites.push(site);
  return site;
}
const unix = process.platform !== 'win32';

test('a copy of the data is never on disk readable by other accounts, even while it is being written', { skip: !unix }, () => {
  const was = process.umask(0o022); // the usual default on a shared computer
  try {
    const adapter = SqliteAdapter.open(join(dir, 'mode-src.db'));
    const to = join(dir, 'mode-copy.db');
    adapter.backupTo(to); // exactly what `backup FILE` and `locked backup FILE` call; the server narrows the file only after this returns
    const mode = statSync(to).mode & 0o777;
    adapter.close();
    assert.equal(mode & 0o077, 0, `the finished copy has permissions ${mode.toString(8)} when the writer returns: other accounts could open it all the while it was written`);
  } finally { process.umask(was); }
});

test('backup FILE does not write into a file that is already there, or through a link', { skip: !unix }, async () => {
  const site = await start();
  // the control: the locked copy refuses both
  const emptyL = join(dir, 'there-already.locked'); writeFileSync(emptyL, '');
  assert.match(await site.consoleLine(`locked backup ${emptyL}`), /already there/);

  const empty = join(dir, 'there-already.db'); writeFileSync(empty, '');
  const saidEmpty = await site.consoleLine(`backup ${empty}`);
  const elsewhere = join(dir, 'elsewhere'); mkdirSync(elsewhere);
  const link = join(dir, 'link.db'); symlinkSync(join(elsewhere, 'landed.db'), link);
  const saidLink = await site.consoleLine(`backup ${link}`);
  const wrong = [];
  if (/^Saved a copy/.test(saidEmpty) || statSync(empty).size !== 0) wrong.push(`an existing (empty) file was written over: now ${statSync(empty).size} bytes`);
  if (/^Saved a copy/.test(saidLink) || existsSync(join(elsewhere, 'landed.db'))) wrong.push('the copy was written through a link, into another folder');
  assert.deepEqual(wrong, []);
});

test('a copy saved inside the folder the server hands out is not handed out', async () => {
  const webRoot = join(dir, 'web'); mkdirSync(join(webRoot, 'app'), { recursive: true });
  writeFileSync(join(webRoot, 'app', 'index.html'), '<!doctype html><meta charset="utf-8"><title>test page</title>');
  const site = await start({ webRoot });
  const said = await site.consoleLine(`backup ${join(webRoot, 'app', 'copy.json')}`);
  const res = await fetch(`${site.url}/app/copy.json`); // no cookie, no key, no code
  const body = Buffer.from(await res.arrayBuffer());
  assert.ok(!(res.status === 200 && body.subarray(0, 15).toString('latin1') === 'SQLite format 3'),
    `the console said "${said.split('\n')[0]}" and the whole data file (${body.length} bytes) is then given to anyone who asks for /app/copy.json`);
});
