// A locked export: this device's export file, sealed with a passphrase the person chooses, so a
// copy that travels (a USB stick, an email to yourself) cannot be read by whoever finds it
// (issue ospeli/ospeli#93, the browser step). The browser's own WebCrypto only, and only
// well-known constructions, used as their documentation describes:
//   - the key comes from the passphrase through PBKDF2 with HMAC-SHA-256, 600,000 rounds and a
//     random 16-byte salt for every file (WebCrypto has no scrypt, which the site server uses);
//   - the data is sealed with AES-256-GCM (a random 12-byte nonce for every file); the first two
//     lines of the file (format name and settings) are covered by the same seal;
//   - the file ends with a SHA-256 of everything before it. That is not a secret and adds no
//     protection: it is how "this file was damaged" is told apart from "wrong passphrase".
// Nothing here is home-made cryptography. There is no back door: without the passphrase the file
// cannot be opened, by the site or by Ospeli. The passphrase is never stored.
//
// File layout, the same as the site server's locked backup (tools/ospeli-server/locked-copy.mjs):
//   "OSPELI-LOCKED-1\n"  one line of JSON settings "\n"  sealed bytes  16-byte tag  32-byte SHA-256
//
// What this does not do: it does not protect the copy the browser itself keeps on this device
// (a page cannot hide that from someone who unlocks the device), and it is only as strong as
// the passphrase.

const MAGIC = new TextEncoder().encode('OSPELI-LOCKED-1\n');
const TAG = 16; const SUM = 32; const SALT = 16; const NONCE = 12;
export const ROUNDS_NEW = 600000; // for new files
const ROUNDS_MIN = 600000; const ROUNDS_MAX = 5000000; // what a file may ask of this device when it is opened
export const MIN_PASSPHRASE = 12;
export const MAX_EXPORT_BYTES = 256 * 1024 * 1024; // the file is sealed in memory

export class NotLockedFileError extends Error {}
export class DamagedFileError extends Error {}
export class WrongPassphraseError extends Error {}

const subtle = () => globalThis.crypto?.subtle;
// WebCrypto exists only on a page loaded over https or from this computer itself. Over plain
// http (a phone on the site's network before #92) there is none, and the app says so.
export const canLock = () => !!subtle() && typeof globalThis.crypto.getRandomValues === 'function';

const b64 = (bytes) => btoa(String.fromCharCode(...bytes));
const unb64 = (text) => { try { return Uint8Array.from(atob(text), (c) => c.charCodeAt(0)); } catch { return new Uint8Array(0); } };
const concat = (...parts) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let at = 0; for (const p of parts) { out.set(p, at); at += p.length; } return out; };
const same = (a, b) => { if (a.length !== b.length) return false; let diff = 0; for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]; return diff === 0; };
const sha256 = async (bytes) => new Uint8Array(await subtle().digest('SHA-256', bytes));
// The passphrase as typed, in one Unicode form, so the same words typed on another keyboard open the file.
const passBytes = (passphrase) => new TextEncoder().encode(String(passphrase).normalize('NFKC'));

async function keyFrom(passphrase, salt, rounds) {
  const base = await subtle().importKey('raw', passBytes(passphrase), 'PBKDF2', false, ['deriveKey']);
  return subtle().deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: rounds }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

// The same rule as the site server's locked backup.
export function passphraseProblem(passphrase) {
  const p = String(passphrase ?? '').normalize('NFKC');
  if ([...p].length < MIN_PASSPHRASE) return `A passphrase needs at least ${MIN_PASSPHRASE} characters. Four or five unrelated words work well.`;
  if (/^(.)\1*$/u.test(p) || /^(0123456789|1234567890|123456789012|abcdefghijkl)/i.test(p)) return 'That passphrase is too easy to guess. Four or five unrelated words work well.';
  return null;
}

export const isLockedFile = (bytes) => bytes instanceof Uint8Array && bytes.length >= MAGIC.length && same(bytes.subarray(0, MAGIC.length), MAGIC);

// Seal text with a passphrase. Returns the bytes of the file. `rounds` is for tests of the limits only.
export async function sealText(text, passphrase, { rounds = ROUNDS_NEW, made = new Date().toISOString() } = {}) {
  if (!canLock()) throw new Error('This page cannot lock a file: the browser offers its encryption only over https or on this computer.');
  const plain = new TextEncoder().encode(text);
  if (plain.length > MAX_EXPORT_BYTES) throw new Error('too large for a locked export');
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(SALT));
  const nonce = globalThis.crypto.getRandomValues(new Uint8Array(NONCE));
  const head = concat(MAGIC, new TextEncoder().encode(`${JSON.stringify({ kdf: 'pbkdf2-sha256', rounds, salt: b64(salt), cipher: 'aes-256-gcm', nonce: b64(nonce), made })}\n`));
  const key = await keyFrom(passphrase, salt, rounds);
  // WebCrypto returns the sealed bytes with the 16-byte tag at the end, which is the layout above.
  const body = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv: nonce, additionalData: head, tagLength: TAG * 8 }, key, plain));
  const sealed = concat(head, body);
  return concat(sealed, await sha256(sealed));
}

// Open a locked file. Throws NotLockedFileError (some other file), DamagedFileError (the file
// changed since it was written, or was cut short) or WrongPassphraseError. Returns the text only
// when the seal holds: nothing half-opened ever comes back.
export async function openText(file, passphrase) {
  if (!isLockedFile(file)) throw new NotLockedFileError('not a locked file');
  if (!canLock()) throw new Error('This page cannot open a locked file: the browser offers its encryption only over https or on this computer.');
  if (file.length < MAGIC.length + 2 + TAG + SUM) throw new DamagedFileError('cut short');
  const sealed = file.subarray(0, file.length - SUM);
  if (!same(await sha256(sealed), file.subarray(file.length - SUM))) throw new DamagedFileError('changed since it was written');
  const lineEnd = sealed.indexOf(0x0a, MAGIC.length);
  if (lineEnd < 0 || lineEnd - MAGIC.length > 400) throw new DamagedFileError('settings line');
  let s;
  try { s = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(sealed.subarray(MAGIC.length, lineEnd))); } catch { throw new DamagedFileError('settings line'); }
  // A copy made at the site server's window uses another way to make the key, which a browser
  // does not have. It is a whole data file, not an export, and opens at the server window.
  if (s?.kdf === 'scrypt') throw new NotLockedFileError('a site server backup');
  const salt = typeof s?.salt === 'string' ? unb64(s.salt) : new Uint8Array(0);
  const nonce = typeof s?.nonce === 'string' ? unb64(s.nonce) : new Uint8Array(0);
  // The settings are read from the file, so they are held to what this version writes: a file
  // cannot ask this device for more work than ROUNDS_MAX, for fewer rounds than Ospeli uses, or
  // for another cipher.
  if (s?.kdf !== 'pbkdf2-sha256' || s.cipher !== 'aes-256-gcm' || !Number.isInteger(s.rounds) || s.rounds < ROUNDS_MIN || s.rounds > ROUNDS_MAX
    || salt.length !== SALT || nonce.length !== NONCE) throw new DamagedFileError('settings');
  const head = sealed.subarray(0, lineEnd + 1);
  const key = await keyFrom(passphrase, salt, s.rounds);
  let plain;
  try { plain = await subtle().decrypt({ name: 'AES-GCM', iv: nonce, additionalData: head, tagLength: TAG * 8 }, key, sealed.subarray(lineEnd + 1)); } catch { throw new WrongPassphraseError('wrong passphrase'); }
  return new TextDecoder('utf-8', { fatal: true }).decode(plain);
}

// Seal and prove at once that the file opens: the sealed bytes are opened again with the same
// passphrase and compared with what went in, before anything is handed to the person. A site
// never learns a year later that its locked exports cannot be opened. `sealFn` exists so a test
// can show the check catches a bad file.
export async function sealChecked(text, passphrase, { sealFn = sealText } = {}) {
  const file = await sealFn(text, passphrase);
  let back = null;
  try { back = await openText(file, passphrase); } catch { /* reported below */ }
  if (back !== text) throw Object.assign(new Error('The locked export did not open again when checked. Nothing was saved.'), { code: 'check-failed' });
  return file;
}
