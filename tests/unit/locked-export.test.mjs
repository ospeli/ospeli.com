// A locked export (ospeli/ospeli#93, the browser step): the export file sealed with a passphrase.
// Attack tests: each tries the bad thing and sees it refused. Passphrases are made at test time.
// Synthetic data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pbkdf2Sync, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { Core } from '../../web/app/core/core.js';
import { MemoryAdapter } from '../../web/app/core/db.js';
import { loadSyntheticHospital } from '../../web/app/core/generator.js';
import {
  sealText, openText, sealChecked, isLockedFile, passphraseProblem, canLock, ROUNDS_NEW,
  NotLockedFileError, DamagedFileError, WrongPassphraseError,
} from '../../web/app/core/locked-file.js';
import { seal as serverSeal } from '../../tools/ospeli-server/locked-copy.mjs';

const pass = () => `test ${randomBytes(12).toString('hex')}`;
const TEXT = JSON.stringify({ format: 'ospeli-export', note: 'synthetic ward A1 (example), café ☕' });
const sha = (b) => createHash('sha256').update(b).digest();
const headEnd = (file) => file.indexOf(0x0a, 16);
// Rewrite the settings line and put a fresh, correct SHA-256 on the end, as a careful attacker would.
function withSettings(file, change) {
  const end = headEnd(file);
  const s = change(JSON.parse(Buffer.from(file.subarray(16, end)).toString('utf8')));
  const sealed = Buffer.concat([Buffer.from(file.subarray(0, 16)), Buffer.from(`${JSON.stringify(s)}\n`), Buffer.from(file.subarray(end + 1, file.length - 32))]);
  return new Uint8Array(Buffer.concat([sealed, sha(sealed)]));
}

test('a locked export opens with its passphrase and with nothing else, and the file does not hold the text', async () => {
  assert.equal(canLock(), true);
  const p = pass();
  const file = await sealText(TEXT, p);
  assert.ok(isLockedFile(file));
  assert.ok(!Buffer.from(file).includes(Buffer.from('synthetic ward')), 'the text is not readable in the file');
  assert.equal(await openText(file, p), TEXT);
  await assert.rejects(openText(file, `${p}x`), WrongPassphraseError);
  await assert.rejects(openText(file, ''), WrongPassphraseError);
  // A new salt and nonce for every file: the same text and passphrase never give the same file.
  const again = await sealText(TEXT, p);
  assert.notDeepEqual(file, again);
  const s1 = JSON.parse(Buffer.from(file.subarray(16, headEnd(file))).toString()); const s2 = JSON.parse(Buffer.from(again.subarray(16, headEnd(again))).toString());
  assert.notEqual(s1.salt, s2.salt); assert.notEqual(s1.nonce, s2.nonce);
  assert.equal(s1.rounds, ROUNDS_NEW); assert.ok(ROUNDS_NEW >= 600000);
});

test('a second, independent reader (Node\'s own library) opens the file: the construction is the standard one, as documented', async () => {
  const p = pass();
  const file = Buffer.from(await sealText(TEXT, p));
  const end = headEnd(file);
  const s = JSON.parse(file.subarray(16, end).toString('utf8'));
  assert.deepEqual([s.kdf, s.cipher], ['pbkdf2-sha256', 'aes-256-gcm']);
  const key = pbkdf2Sync(Buffer.from(p.normalize('NFKC'), 'utf8'), Buffer.from(s.salt, 'base64'), s.rounds, 32, 'sha256');
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(s.nonce, 'base64'));
  d.setAAD(file.subarray(0, end + 1));
  d.setAuthTag(file.subarray(file.length - 32 - 16, file.length - 32));
  const plain = Buffer.concat([d.update(file.subarray(end + 1, file.length - 32 - 16)), d.final()]).toString('utf8');
  assert.equal(plain, TEXT);
  assert.deepEqual(file.subarray(file.length - 32), sha(file.subarray(0, file.length - 32)));
});

test('a damaged, cut or edited file is refused and nothing half-opened comes back; damage is told apart from a wrong passphrase', async () => {
  const p = pass();
  const file = await sealText(TEXT, p);
  const flipped = new Uint8Array(file); flipped[headEnd(file) + 5] ^= 1;
  await assert.rejects(openText(flipped, p), DamagedFileError);
  await assert.rejects(openText(file.subarray(0, file.length - 7), p), DamagedFileError);
  await assert.rejects(openText(file.subarray(0, 20), p), DamagedFileError);
  // An attacker who changes the sealed bytes and repairs the SHA-256 on the end: the seal itself refuses.
  const body = Buffer.from(file.subarray(0, file.length - 32)); body[headEnd(file) + 5] ^= 1;
  await assert.rejects(openText(new Uint8Array(Buffer.concat([body, sha(body)])), p), WrongPassphraseError);
  // The settings line is under the seal too: a changed date with a repaired SHA-256 does not open.
  await assert.rejects(openText(withSettings(file, (s) => ({ ...s, made: '2020-01-01T00:00:00.000Z' })), p), WrongPassphraseError);
  await assert.rejects(openText(new TextEncoder().encode(TEXT), p), NotLockedFileError);
  await assert.rejects(openText('OSPELI-LOCKED-1\n', p), NotLockedFileError);
});

test('a file cannot ask this device for more work than Ospeli uses, for less (a weaker key), or for another cipher', async () => {
  const p = pass();
  const file = await sealText(TEXT, p);
  const t0 = Date.now();
  await assert.rejects(openText(withSettings(file, (s) => ({ ...s, rounds: 2 ** 31 - 1 })), p), DamagedFileError);
  assert.ok(Date.now() - t0 < 1000, 'refused before any work is done');
  await assert.rejects(openText(withSettings(file, (s) => ({ ...s, rounds: 1000 })), p), DamagedFileError);
  await assert.rejects(openText(withSettings(file, (s) => ({ ...s, rounds: 600000.5 })), p), DamagedFileError);
  await assert.rejects(openText(withSettings(file, (s) => ({ ...s, cipher: 'aes-256-cbc' })), p), DamagedFileError);
  await assert.rejects(openText(withSettings(file, (s) => ({ ...s, kdf: 'none' })), p), DamagedFileError);
  await assert.rejects(openText(withSettings(file, (s) => ({ ...s, nonce: '' })), p), DamagedFileError);
  await assert.rejects(openText(withSettings(file, (s) => ({ ...s, salt: 'AAAA' })), p), DamagedFileError);
  // A file sealed with too few rounds is not opened even with the right passphrase.
  await assert.rejects(openText(await sealText(TEXT, p, { rounds: 1000 }), p), DamagedFileError);
});

test('the file is opened again before it is handed over: a seal that does not open is reported, not saved', async () => {
  const p = pass();
  assert.equal(await openText(await sealChecked(TEXT, p), p), TEXT);
  const broken = async (text, passphrase) => { const f = await sealText(text, passphrase); f[f.length - 40] ^= 1; return f; };
  await assert.rejects(sealChecked(TEXT, p, { sealFn: broken }), (e) => e.code === 'check-failed');
  const other = (text, passphrase) => sealText(`${text} `, passphrase);
  await assert.rejects(sealChecked(TEXT, p, { sealFn: other }), (e) => e.code === 'check-failed');
});

test('a site server backup is not taken for an export, and weak passphrases are refused by the same rule as the server', async () => {
  const p = pass();
  const backup = new Uint8Array(serverSeal(Buffer.from('not an export'), p, { N: 2 ** 15 }));
  await assert.rejects(openText(backup, p), NotLockedFileError);
  assert.match(passphraseProblem('short'), /at least 12/);
  assert.match(passphraseProblem('aaaaaaaaaaaaaaaa'), /too easy/);
  assert.match(passphraseProblem('123456789012345'), /too easy/);
  assert.equal(passphraseProblem('four unrelated words here'), null);
});

test('the way back in: a whole export, locked, opens on another device and is imported; the trail says the export was locked', async () => {
  const END = '2026-11-06T18:00:00.000Z';
  const a = await Core.open({ adapter: new MemoryAdapter(), clock: () => new Date(END) });
  await loadSyntheticHospital(a, { end: END });
  await a.record('coo', 'data.exported', null, { entities: 1, events: 1, locked: true });
  const data = await a.exportData();
  const p = pass();
  const file = await sealChecked(JSON.stringify(data), p);
  const b = await Core.open({ adapter: new MemoryAdapter(), clock: () => new Date(END) });
  const back = JSON.parse(await openText(file, p));
  assert.deepEqual(await b.validateImport(back), []);
  const res = await b.importData(back, 'coo');
  assert.equal(res.events, data.events.length);
  assert.equal((await b.eventCount()), data.events.length);
  assert.ok(data.audit.some((e) => e.action === 'data.exported' && e.detail?.locked === true));
});
