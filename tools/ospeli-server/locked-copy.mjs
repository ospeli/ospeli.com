// A locked copy of the site's data: a backup file that cannot be read without the passphrase
// the site chose (issue ospeli/ospeli#93, step 1 and 2). Node's standard library only, and only
// well-known constructions, used as their documentation describes:
//   - the key comes from the passphrase through scrypt (N = 2^17, r = 8, p = 1, a random
//     16-byte salt for every file);
//   - the data is sealed with AES-256-GCM (a random 12-byte nonce for every file); the first two
//     lines of the file (format name and settings) are covered by the same seal;
//   - the file ends with a SHA-256 of everything before it. That is not a secret and adds no
//     protection: it is how "this file was damaged" is told apart from "wrong passphrase".
// Nothing here is home-made cryptography. There is no back door: without the passphrase the
// copy cannot be opened, by the site or by Ospeli.
//
// File layout:  "OSPELI-LOCKED-1\n"  one line of JSON settings "\n"  sealed bytes  16-byte tag  32-byte SHA-256
import { scryptSync, randomBytes, createCipheriv, createDecipheriv, createHash, timingSafeEqual } from 'node:crypto';
import { writeFileSync, readFileSync, unlinkSync } from 'node:fs';

const MAGIC = Buffer.from('OSPELI-LOCKED-1\n', 'latin1');
const TAG = 16; const SUM = 32; const SALT = 16; const NONCE = 12;
const N_NEW = 2 ** 17; // work factor for new files (about 130 MB of memory and under a second)
const N_MIN = 2 ** 15; const N_MAX = 2 ** 18; // what a file may ask of this computer when it is opened
export const MIN_PASSPHRASE = 12;
export const MAX_COPY_BYTES = 1024 ** 3; // the copy is sealed in memory; a bigger data file needs another way

export class NotLockedCopyError extends Error {}
export class DamagedCopyError extends Error {}
export class WrongPassphraseError extends Error {}

// The passphrase as typed, in one Unicode form, so the same words typed on another keyboard open the file.
const passBytes = (passphrase) => Buffer.from(String(passphrase).normalize('NFKC'), 'utf8');
const keyFrom = (passphrase, salt, N) => scryptSync(passBytes(passphrase), salt, 32, { N, r: 8, p: 1, maxmem: 256 * N * 8 });
const sha256 = (...parts) => { const h = createHash('sha256'); for (const p of parts) h.update(p); return h.digest(); };

export function passphraseProblem(passphrase) {
  const p = String(passphrase ?? '').normalize('NFKC');
  if ([...p].length < MIN_PASSPHRASE) return `A passphrase needs at least ${MIN_PASSPHRASE} characters. Four or five unrelated words work well.`;
  if (/^(.)\1*$/u.test(p) || /^(0123456789|1234567890|123456789012|abcdefghijkl)/i.test(p)) return 'That passphrase is too easy to guess. Four or five unrelated words work well.';
  return null;
}

// Seal bytes with a passphrase. `N` is for tests of the work-factor limits only.
export function seal(plain, passphrase, { N = N_NEW, made = new Date().toISOString() } = {}) {
  const salt = randomBytes(SALT); const nonce = randomBytes(NONCE);
  const head = Buffer.concat([MAGIC, Buffer.from(`${JSON.stringify({ kdf: 'scrypt', N, r: 8, p: 1, salt: salt.toString('base64'), cipher: 'aes-256-gcm', nonce: nonce.toString('base64'), made })}\n`, 'utf8')]);
  const cipher = createCipheriv('aes-256-gcm', keyFrom(passphrase, salt, N), nonce);
  cipher.setAAD(head);
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  const sealed = Buffer.concat([head, body, cipher.getAuthTag()]);
  return Buffer.concat([sealed, sha256(sealed)]);
}

// Open sealed bytes. Throws NotLockedCopyError (some other file), DamagedCopyError (the file
// changed since it was written, or was cut short) or WrongPassphraseError. Returns the bytes
// only when the seal holds: nothing half-opened ever comes back.
export function open(file, passphrase) {
  if (!Buffer.isBuffer(file) || file.length < MAGIC.length || !file.subarray(0, MAGIC.length).equals(MAGIC)) throw new NotLockedCopyError('not a locked copy');
  if (file.length < MAGIC.length + 2 + TAG + SUM) throw new DamagedCopyError('cut short');
  const sealed = file.subarray(0, file.length - SUM);
  if (!timingSafeEqual(sha256(sealed), file.subarray(file.length - SUM))) throw new DamagedCopyError('changed since it was written');
  const lineEnd = sealed.indexOf(0x0a, MAGIC.length);
  if (lineEnd < 0 || lineEnd - MAGIC.length > 400) throw new DamagedCopyError('settings line');
  let s;
  try { s = JSON.parse(sealed.subarray(MAGIC.length, lineEnd).toString('utf8')); } catch { throw new DamagedCopyError('settings line'); }
  const salt = typeof s?.salt === 'string' ? Buffer.from(s.salt, 'base64') : Buffer.alloc(0);
  const nonce = typeof s?.nonce === 'string' ? Buffer.from(s.nonce, 'base64') : Buffer.alloc(0);
  // The settings are read from the file, so they are held to what this version writes: a file
  // cannot ask this computer for more work or memory than N_MAX, or for another cipher.
  if (s?.kdf !== 'scrypt' || s.cipher !== 'aes-256-gcm' || s.r !== 8 || s.p !== 1 || !Number.isInteger(s.N) || s.N < N_MIN || s.N > N_MAX || (s.N & (s.N - 1)) !== 0
    || salt.length !== SALT || nonce.length !== NONCE) throw new DamagedCopyError('settings');
  const head = sealed.subarray(0, lineEnd + 1);
  const body = sealed.subarray(lineEnd + 1, sealed.length - TAG);
  const decipher = createDecipheriv('aes-256-gcm', keyFrom(passphrase, salt, s.N), nonce, { authTagLength: TAG });
  decipher.setAAD(head);
  decipher.setAuthTag(sealed.subarray(sealed.length - TAG));
  try { return Buffer.concat([decipher.update(body), decipher.final()]); } catch { throw new WrongPassphraseError('wrong passphrase'); }
}

// Write a locked copy and prove at once that it opens: the file is read back from the disk,
// opened with the same passphrase and compared with what went in. A copy that does not pass is
// deleted and the call fails, so a site never learns a year later that its copies cannot be
// opened. `sealFn` exists so a test can show the check catches a bad file.
export function saveLocked(plain, to, passphrase, { sealFn = seal } = {}) {
  if (plain.length > MAX_COPY_BYTES) throw new Error('too large for a locked copy');
  writeFileSync(to, sealFn(plain, passphrase), { flag: 'wx', mode: 0o600 }); // never over a file that is already there
  try {
    const back = open(readFileSync(to), passphrase);
    if (!timingSafeEqual(sha256(back), sha256(plain))) throw new Error('the copy does not match the data');
  } catch (err) {
    try { unlinkSync(to); } catch { /* nothing to remove */ }
    throw Object.assign(new Error('The locked copy did not pass its check and was removed.'), { cause: err, code: 'check-failed' });
  }
  return { bytes: plain.length };
}
