// A locked copy of the site's data (ospeli/ospeli#93 steps 1 and 2; docs/SECURITY.md row F2).
// Each test tries the bad thing against a throwaway server on this computer:
// - the copy holds nothing readable, and two copies of the same data are different files;
// - it opens again with the passphrase, into a new file, with the same data and audit trail;
// - a wrong passphrase and a damaged file are both refused, in different plain words, and
//   nothing is half-written;
// - a file that asks this computer for far more work than Ospeli ever writes is refused at once;
// - the passphrase is never stored, recorded or echoed, and the plain working copy is removed;
// - a copy that would not open again is never reported as saved.
// Passphrases here are made at test time and thrown away. None is a real one.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';

const emit = process.emitWarning;
process.emitWarning = (w, ...rest) => (/SQLite/i.test(String(w?.message || w)) ? undefined : emit.call(process, w, ...rest));
const { startServer } = await import('../../tools/ospeli-server/site-server.mjs');
const { seal, open, saveLocked, passphraseProblem, DamagedCopyError, WrongPassphraseError, NotLockedCopyError } = await import('../../tools/ospeli-server/locked-copy.mjs');

const END = '2026-11-08T12:00:00.000Z';
const dir = mkdtempSync(join(tmpdir(), 'ospeli-locked-'));
const sites = [];
after(async () => { for (const s of sites) await s.close().catch(() => {}); rmSync(dir, { recursive: true, force: true }); });
let n = 0;
async function start() {
  const t = { now: Date.parse(END) };
  const site = await startServer({ file: join(dir, `site-${++n}.db`), port: 0, end: END, clock: () => new Date(t.now += 1000) });
  sites.push(site);
  return site;
}
// A passphrase nobody chose: random words-like text, new for every test run.
const fresh = () => `test ${randomBytes(9).toString('base64url')} only`;
async function lock(site, to, pass) {
  assert.match(await site.consoleLine(`locked backup ${to}`), /^1 of 2\. Choose a passphrase/);
  assert.match(await site.consoleLine(pass), /^2 of 2/);
  return site.consoleLine(pass);
}
async function unlock(site, from, to, pass) {
  assert.match(await site.consoleLine(`open backup ${from} ${to}`), /^Type the passphrase/);
  return site.consoleLine(pass);
}
const has = (buf, text) => buf.includes(Buffer.from(text, 'utf8'));

test('a locked copy holds nothing readable, differs every time, and opens again with the same data and trail', async () => {
  const site = await start();
  const pass = fresh();
  const a = join(dir, 'a.locked'); const b = join(dir, 'b.locked');
  const before = { entities: await site.core.listEntities(), audit: await site.core.auditLog() };
  const said = await lock(site, a, pass);
  assert.match(said, /^Saved a locked copy/);
  assert.match(said, /read back and opens with the passphrase/);
  assert.match(said, /Without the passphrase nobody can open it/);
  assert.ok(!said.includes(pass), 'the passphrase is not repeated back');
  assert.match(await lock(site, b, pass), /^Saved a locked copy/);

  // The plain data file is readable (that is what #93 is about); the locked copy is not.
  const plainFile = readFileSync(site.file); const fa = readFileSync(a); const fb = readFileSync(b);
  for (const word of ['SQLite format 3', 'ward-a1', 'synthetic']) {
    assert.ok(has(plainFile, word), `sanity: the plain data file holds "${word}"`);
    assert.ok(!has(fa, word), `the locked copy does not hold "${word}" in the clear`);
  }
  assert.ok(!fa.subarray(200).equals(fb.subarray(200)) && !fa.equals(fb), 'two copies of the same data share no sealed bytes (new salt and nonce each time)');
  if (process.platform !== 'win32') assert.equal((statSync(a).mode & 0o777).toString(8), '600');

  const opened = join(dir, 'a-opened.db');
  const out = await unlock(site, a, opened, pass);
  assert.match(out, /^Opened\./);
  assert.match(out, /NOT locked/);
  assert.ok(!out.includes(pass));
  await site.close();
  const again = await startServer({ file: opened, port: 0, end: END, clock: () => new Date(Date.parse(END) + 864e5) });
  sites.push(again);
  assert.deepEqual(await again.core.listEntities(), before.entities, 'every record came back');
  assert.deepEqual(await again.core.auditLog(), before.audit, 'the audit trail came back as it was when the copy was made');
  assert.deepEqual(await again.core.verifyAudit(), { ok: true });
});

test('a wrong passphrase and a damaged file are refused in different words, and nothing is written', async () => {
  const site = await start();
  const pass = fresh();
  const good = join(dir, 'c.locked');
  await lock(site, good, pass);
  const out1 = join(dir, 'c-wrong.db');
  const wrong = await unlock(site, good, out1, fresh());
  assert.match(wrong, /^Wrong passphrase\. The file itself is whole\./);
  assert.ok(!existsSync(out1), 'nothing is written for a wrong passphrase');

  const bytes = readFileSync(good);
  const cases = {
    'one byte changed in the sealed data': (b) => { const x = Buffer.from(b); x[Math.floor(x.length / 2)] ^= 0x01; return x; },
    'one byte changed in the settings line': (b) => { const x = Buffer.from(b); x[40] ^= 0x01; return x; },
    'the end cut off': (b) => b.subarray(0, b.length - 100),
    'cut down to the first line': (b) => b.subarray(0, 20),
  };
  for (const [what, damage] of Object.entries(cases)) {
    const bad = join(dir, `bad-${Object.keys(cases).indexOf(what)}.locked`); const to = join(dir, `bad-${Object.keys(cases).indexOf(what)}.db`);
    writeFileSync(bad, damage(bytes));
    const said = await unlock(site, bad, to, pass);
    assert.match(said, /^This file is damaged/, `${what}: said to be damaged, even with the right passphrase`);
    assert.ok(!existsSync(to), `${what}: nothing is written`);
  }
  // Someone who changes the sealed data and also repairs the checksum at the end gets no further:
  // the seal itself fails, and nothing comes out.
  const forged = Buffer.from(bytes); forged[forged.length - 60] ^= 0x01;
  const sealed = forged.subarray(0, forged.length - 32);
  createHash('sha256').update(sealed).digest().copy(forged, forged.length - 32);
  assert.throws(() => open(forged, pass), WrongPassphraseError, 'a changed file with a repaired checksum still does not open');

  const notOne = join(dir, 'plain.db');
  assert.match(await site.consoleLine(`backup ${notOne}`), /This copy is not locked/);
  assert.match(await unlock(site, notOne, join(dir, 'plain-out.db'), pass), /is not a locked copy made by Ospeli/);
  assert.ok(!existsSync(join(dir, 'plain-out.db')));
  // An opened copy never lands on a file that is already there (the running data file least of all).
  assert.match(await site.consoleLine(`open backup ${good} ${site.file}`), /already there\. Nothing was written/);
  assert.match(await site.consoleLine(`locked backup ${good}`), /already there\. Nothing was saved/);
});

test('a file cannot make this computer do more work than Ospeli asks for, or use another cipher', () => {
  const pass = fresh();
  const plain = Buffer.from('made-up bytes for the test');
  const ok = seal(plain, pass, { N: 2 ** 15 });
  assert.deepEqual(open(ok, pass), plain);
  const withSettings = (change) => {
    const end = ok.indexOf(0x0a, 16);
    const s = JSON.parse(ok.subarray(16, end).toString('utf8'));
    const sealed = Buffer.concat([ok.subarray(0, 16), Buffer.from(`${JSON.stringify({ ...s, ...change })}\n`), ok.subarray(end + 1, ok.length - 32)]);
    return Buffer.concat([sealed, createHash('sha256').update(sealed).digest()]);
  };
  for (const change of [{ N: 2 ** 30 }, { N: 2 ** 14 }, { N: 100000 }, { N: '131072' }, { r: 64 }, { p: 16 }, { kdf: 'none' }, { cipher: 'aes-256-ctr' }, { salt: '' }, { nonce: 'AAAA' }]) {
    const started = Date.now();
    assert.throws(() => open(withSettings(change), pass), DamagedCopyError, `settings ${JSON.stringify(change)} are refused`);
    assert.ok(Date.now() - started < 1000, `settings ${JSON.stringify(change)} are refused before any heavy work`);
  }
  assert.throws(() => open(Buffer.from('SQLite format 3\0 and so on'), pass), NotLockedCopyError);
  assert.throws(() => open(seal(plain, pass, { N: 2 ** 15 }), `${pass}x`), WrongPassphraseError);
});

test('the passphrase is never kept: not in the data file, the audit trail, the copy or a file left behind', async () => {
  const site = await start();
  const pass = fresh();
  const to = join(dir, 'd.locked');
  const filesBefore = new Set(readdirSync(dir));
  await lock(site, to, pass);
  const made = readdirSync(dir).filter((f) => !filesBefore.has(f));
  assert.deepEqual(made, ['d.locked'], 'only the locked copy is left: the plain working copy is gone');
  const audit = await site.core.auditLog();
  const entry = audit.at(-1);
  assert.equal(entry.action, 'data.backup');
  assert.deepEqual(entry.detail, { locked: true, checked: true });
  assert.ok(!JSON.stringify(audit).includes(pass), 'not in the audit trail');
  await site.core.queue;
  assert.ok(!has(readFileSync(site.file), pass), 'not in the data file');
  assert.ok(!has(readFileSync(to), pass), 'not in the copy');
  assert.equal(site.secretNext(), false);
  await site.consoleLine(`locked backup ${join(dir, 'e.locked')}`);
  assert.equal(site.secretNext(), true, 'the window is told the next line is a passphrase, so it can keep it out of its history');
  assert.match(await site.consoleLine('cancel'), /Cancelled/);
  assert.equal(site.secretNext(), false);
});

test('a weak or mistyped passphrase saves nothing', async () => {
  const site = await start();
  const to = join(dir, 'f.locked');
  await site.consoleLine(`locked backup ${to}`);
  assert.match(await site.consoleLine('short'), /at least 12 characters/);
  assert.match(await site.consoleLine('aaaaaaaaaaaaaaaa'), /too easy to guess/);
  const pass = fresh();
  assert.match(await site.consoleLine(pass), /^2 of 2/);
  assert.match(await site.consoleLine(`${pass}?`), /did not match\. Nothing was saved/);
  assert.ok(!existsSync(to));
  assert.equal(passphraseProblem(pass), null);
  assert.equal((await site.core.auditLog()).filter((e) => e.action === 'data.backup').length, 0, 'no backup is recorded when none was made');
});

test('a copy that would not open again is removed and never reported as saved', () => {
  const pass = fresh();
  const plain = randomBytes(4000);
  const to = join(dir, 'g.locked');
  // A seal that goes wrong on the way to the disk (one byte off).
  const faulty = (p, w) => { const x = seal(p, w, { N: 2 ** 15 }); x[x.length - 50] ^= 0x01; return x; };
  assert.throws(() => saveLocked(plain, to, pass, { sealFn: faulty }), (e) => e.code === 'check-failed');
  assert.ok(!existsSync(to), 'the bad copy is not left on the disk');
  // A seal made with a different passphrase from the one the person typed.
  assert.throws(() => saveLocked(plain, to, pass, { sealFn: (p) => seal(p, fresh(), { N: 2 ** 15 }) }), (e) => e.code === 'check-failed');
  assert.ok(!existsSync(to));
  // The honest one passes, and never overwrites.
  saveLocked(plain, to, pass);
  assert.deepEqual(open(readFileSync(to), pass), plain);
  assert.throws(() => saveLocked(plain, to, pass), (e) => e.code === 'EEXIST');
});
