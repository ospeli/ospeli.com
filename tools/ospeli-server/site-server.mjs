// The Ospeli site server, first version (backlog A8, docs/AGENT-API-SPEC.md section 3).
// The same core and command registry as the browser app, on the site's own computer, with an
// HTTP API so the site's own bots and scripts can read and propose.
//
// The rules this file keeps:
// - Who is calling comes from the key or the device cookie and nothing else. A call made with
//   an agent key is recorded as that agent, with via "api", and can never be recorded as a person.
// - People act at the server's own console (the window it runs in), recorded as a person in a
//   role with via "console", or from a device a person connected at that console with a one-time
//   code, recorded as a person in that device's role with via "app" and the device's label.
//   Neither is a named sign-in.
// - Agent access is Off until a person switches it on. Agents read and propose; a person
//   accepts or declines. Refused calls are recorded without storing what the agent typed.
// - Nothing leaves the site: the server listens on this computer only unless told otherwise,
//   and it calls nobody.
import { createServer } from 'node:http';
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { mkdirSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { dirname, resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Core } from '../../web/app/core/core.js';
import { canonical } from '../../web/app/core/audit.js';
import { ROLES, roleById } from '../../web/app/core/model.js';
import { loadSyntheticHospital, setupUnfinished, currentHour, HOSPITAL_NAME } from '../../web/app/core/generator.js';
import {
  runCommand, commandByName, describeCommand, listCommands, agentAccess, agentList, auditRefusal, CommandError, DECLINE_REASONS, MAX_AGENT_DAYS,
} from '../../web/app/core/commands.js';
import { personNameIn, personalDetailIn } from '../../web/app/core/processmap.js';
import { SITE_META } from '../../web/app/core/site.js';
import { SqliteAdapter, StoreInUseError } from './store.mjs';
import { buildOpenApi } from './openapi.mjs';

// What the console may say about the trail (issue #79): a self-check on a plain chain of check
// codes catches accidental damage. It cannot show removed or rewritten entries, so say so, and
// never report a pass on an empty or replaced trail without saying that too.
const auditLine = (check) => {
  const replaced = check.replaced ? ` The history on this computer was replaced on ${String(check.replaced.at).slice(0, 10)}.` : '';
  if (!check.entries) return `Audit trail: no entries yet, so there is nothing to check.${replaced}`;
  return `Audit trail: ${check.entries} ${check.entries === 1 ? 'entry' : 'entries'}. Self-check passed (this does not show whether the newest entries were removed).${replaced}`;
};

export const SERVER_VERSION = '0.1.0';
export const DEFAULT_PORT = 8787;
const MAX_BODY = 64 * 1024;
const IDEMPOTENCY_MS = 24 * 3600 * 1000;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,128}$/;
const KEY_SHAPE = /^osk_([0-9a-f]{8})_([A-Za-z0-9_-]{32})$/;
// Devices: a phone or laptop a person connected at the console with a one-time code.
const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'web');
const STATIC_TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8' };
const STATIC_HEADERS = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" };
export const SITE_MARKER = '<meta name="ospeli-site-server" content="1">';
const CODE_LETTERS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0 O 1 I L: they are misread on a phone
const CODE_MINUTES = 30;
const CODE_WRONG_TRIES = 5;
const DEVICE_IDLE_DAYS = 30;
const DEVICE_COOKIE = 'ospeli_device';
const DEVICE_SHAPE = /^osd_([0-9a-f]{8})_([A-Za-z0-9_-]{43})$/;
const DEVICE_LABEL = /^[A-Za-z0-9][A-Za-z0-9 ._-]{1,30}$/;
const cleanCode = (text) => String(text ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const CONSOLE_ADMIN = 'ops-manager'; // the role console actions on agent access are recorded under

const sha = (text) => createHash('sha256').update(text).digest('hex');
const agentKey = (name) => String(name).trim().toLowerCase();
const STATUS = { 'code-wrong': 403, 'code-old': 410, 'not-connected': 401, 'invalid-input': 400, unauthorized: 401, forbidden: 403, 'agents-off': 403, 'unknown-command': 404, 'not-found': 404, conflict: 409, 'idempotency-key-reused': 409, 'rate-limited': 429 };

// A fixed window per minute, per key (or per address for calls without a valid key).
class Limiter {
  constructor(perMinute, clock) { this.per = perMinute; this.clock = clock; this.seen = new Map(); }
  take(id) {
    const now = this.clock().getTime();
    const win = Math.floor(now / 60000);
    const rec = this.seen.get(id);
    if (!rec || rec.win !== win) {
      if (this.seen.size > 5000) this.seen.clear();
      this.seen.set(id, { win, n: 1 });
      return { ok: true };
    }
    rec.n += 1;
    return rec.n <= this.per ? { ok: true } : { ok: false, retryAfter: Math.max(1, Math.ceil(((win + 1) * 60000 - now) / 1000)) };
  }
}

export class StartError extends Error {}

export async function startServer({
  file, host = '127.0.0.1', port = DEFAULT_PORT, clock = () => new Date(), callsPerMinute = 120, allowHosts = [], end = null,
} = {}) {
  if (!file) throw new StartError('The server needs a data file.');
  mkdirSync(dirname(resolve(file)), { recursive: true });
  let adapter;
  try {
    adapter = SqliteAdapter.open(file);
  } catch (err) {
    if (err instanceof StoreInUseError) throw new StartError(`Ospeli is already running on this data file (${file}). Use the window it is running in, or close it first.`);
    throw err;
  }
  const core = await Core.open({ adapter, clock });
  // Synthetic data only in this version: an empty (or half-loaded) store gets the made-up hospital.
  if ((await core.listEntities()).length === 0 || await setupUnfinished(core)) {
    if ((await core.listEntities()).length) await core.reset('system');
    await loadSyntheticHospital(core, { end: end || currentHour(clock().getTime()) });
  }
  const keyLimiter = new Limiter(callsPerMinute, clock);
  const deviceLimiter = new Limiter(600, clock);
  const pairLimiter = new Limiter(10, clock);
  const anonLimiter = new Limiter(30, clock);
  const synthetic = async () => (await core.getMeta('synthetic', true)) !== false;
  const person = (role) => ({ type: 'human', role, via: 'console' });
  const asPerson = (name, input, role = CONSOLE_ADMIN) => runCommand(core, name, input, person(role));

  // ---- keys: shown once, stored as a hash, tied to the agent's entry on the site's list ----
  const keys = async () => (await core.getMeta('agent-keys', [])) || [];
  async function issueKey(agentName) {
    const listed = (await agentList(core)).find((r) => agentKey(r.name) === agentKey(agentName));
    if (!listed) throw new CommandError('not-found', `There is no bot called ${agentName}.`);
    const id = randomBytes(4).toString('hex');
    const key = `osk_${id}_${randomBytes(24).toString('base64url')}`;
    const now = core.now();
    await core.updateMeta('agent-keys', (raw) => [
      ...(raw || []).map((k) => (k.agent === agentKey(listed.name) && !k.revokedAt ? { ...k, revokedAt: now } : k)),
      { id, hash: sha(key), agent: agentKey(listed.name), agentAddedAt: listed.addedAt, createdAt: now, revokedAt: null },
    ], []);
    await core.recordAs(person(CONSOLE_ADMIN), 'agents.key-issued', null, { agent: listed.name, keyId: id });
    return { key, id, agent: listed };
  }
  async function revokeKeys(agentName) {
    const now = core.now();
    await core.updateMeta('agent-keys', (raw) => (raw || []).map((k) => (k.agent === agentKey(agentName) && !k.revokedAt ? { ...k, revokedAt: now } : k)), []);
  }
  // Returns { rec, listed } or { fail: reason }. The end date and the dial are checked on every
  // call by the command layer itself.
  async function authenticate(req) {
    const m = /^Bearer (\S+)$/.exec(req.headers.authorization || '');
    if (!m) return { fail: 'missing' };
    const parts = KEY_SHAPE.exec(m[1]);
    if (!parts) return { fail: 'unknown' };
    const rec = (await keys()).find((k) => k.id === parts[1]);
    // Compare hashes in constant time, also when there is no such key id.
    const given = Buffer.from(sha(m[1]), 'hex');
    const stored = Buffer.from(rec ? rec.hash : sha('no such key'), 'hex');
    if (!timingSafeEqual(given, stored) || !rec) return { fail: 'unknown' };
    if (rec.revokedAt) return { fail: 'revoked' };
    const listed = (await agentList(core)).find((r) => agentKey(r.name) === rec.agent);
    if (!listed || listed.addedAt !== rec.agentAddedAt) return { fail: 'removed' };
    return { rec, listed };
  }

  // ---- devices: a one-time code typed at the console connects a phone or laptop ----
  // The code lives in memory only, one at a time, for 30 minutes, and is cancelled after five
  // wrong tries from anywhere. The device then holds a random token in a cookie scripts cannot
  // read; the server keeps only the token's hash. A device unused for 30 days must connect again.
  const devices = async () => (await core.getMeta('devices', [])) || [];
  const liveDevices = async () => (await devices()).filter((d) => !d.removedAt);
  let pending = null; // { hash, label, role, expiresAt, wrong }
  async function deviceCode({ label, role }) {
    const all = await liveDevices();
    const name = (label || '').trim() || `Device ${(await devices()).length + 1}`;
    if (!DEVICE_LABEL.test(name)) throw new CommandError('invalid-input', 'Give the device a short label that says where it is, for example front desk tablet (letters, digits, spaces, dots, dashes).');
    if (personNameIn(name) || personNameIn(name, { roleField: true }) || personalDetailIn(name)) throw new CommandError('invalid-input', 'That label looks like it names a person. Say where the device is or what it is for, for example front desk tablet.');
    if (all.some((d) => d.label.toLowerCase() === name.toLowerCase())) throw new CommandError('conflict', `There is already a device called ${name}. Pick another label, or type: devices`);
    if (!roleById(role)) throw new CommandError('invalid-input', 'Unknown role.');
    let code = '';
    for (let i = 0; i < 8; i += 1) code += CODE_LETTERS[randomInt(CODE_LETTERS.length)];
    pending = { hash: sha(code), label: name, role, expiresAt: Date.parse(core.now()) + CODE_MINUTES * 60000, wrong: 0 };
    await core.recordAs(person(CONSOLE_ADMIN), 'devices.code-issued', null, { device: name, role });
    return { code: `${code.slice(0, 4)}-${code.slice(4)}`, label: name, role };
  }
  // Returns { device, cookie } or throws a CommandError with code 'code-wrong' or 'code-old'.
  async function pairDevice(codeText) {
    const now = Date.parse(core.now());
    if (!pending || now > pending.expiresAt) {
      pending = null;
      throw new CommandError('code-old', 'That code is too old. Ask for a new one.');
    }
    const given = Buffer.from(sha(cleanCode(codeText)), 'hex');
    if (!timingSafeEqual(given, Buffer.from(pending.hash, 'hex'))) {
      pending.wrong += 1;
      if (pending.wrong >= CODE_WRONG_TRIES) pending = null; // the code is cancelled; a person asks for a new one
      throw new CommandError('code-wrong', 'That code is not right. Check it and try again.');
    }
    const { label, role } = pending;
    pending = null; // single use
    const id = randomBytes(4).toString('hex');
    const token = `osd_${id}_${randomBytes(32).toString('base64url')}`;
    const at = core.now();
    await core.updateMeta('devices', (raw) => [...(raw || []), { id, label, role, hash: sha(token), addedAt: at, lastSeenAt: at, removedAt: null }], []);
    await core.recordAs({ type: 'human', role, via: 'app', device: label }, 'devices.connected', null, { device: label, deviceId: id });
    return { device: { id, label, role }, token };
  }
  async function removeDevice(which) {
    const all = await liveDevices();
    const d = /^\d+$/.test(which) ? all[Number(which) - 1] : all.find((x) => x.label.toLowerCase() === String(which).trim().toLowerCase());
    if (!d) throw new CommandError('not-found', `There is no device ${which}. To see the list, type: devices`);
    const at = core.now();
    await core.updateMeta('devices', (raw) => (raw || []).map((x) => (x.id === d.id ? { ...x, removedAt: at } : x)), []);
    await core.recordAs(person(CONSOLE_ADMIN), 'devices.removed', null, { device: d.label, deviceId: d.id });
    return d;
  }
  const cookieOf = (req) => {
    for (const part of String(req.headers.cookie || '').split(';')) {
      const i = part.indexOf('=');
      if (i > 0 && part.slice(0, i).trim() === DEVICE_COOKIE) return part.slice(i + 1).trim();
    }
    return null;
  };
  const deviceCookie = (token, maxAge) => `${DEVICE_COOKIE}=${token}; Path=/api/v1; HttpOnly; SameSite=Strict; Max-Age=${maxAge}`;
  // Returns { device } or { fail: reason }. Nothing a caller sends besides the cookie counts.
  async function authenticateDevice(req) {
    const value = cookieOf(req);
    if (!value) return { fail: 'missing' };
    const parts = DEVICE_SHAPE.exec(value);
    if (!parts) return { fail: 'unknown' };
    const rec = (await devices()).find((d) => d.id === parts[1]);
    const given = Buffer.from(sha(value), 'hex');
    const stored = Buffer.from(rec ? rec.hash : sha('no such device'), 'hex');
    if (!timingSafeEqual(given, stored) || !rec) return { fail: 'unknown' };
    if (rec.removedAt) return { fail: 'removed' };
    const now = Date.parse(core.now());
    if (now - Date.parse(rec.lastSeenAt) > DEVICE_IDLE_DAYS * 864e5) return { fail: 'idle' };
    if (now - Date.parse(rec.lastSeenAt) > 3600e3) {
      const at = core.now();
      await core.updateMeta('devices', (raw) => (raw || []).map((x) => (x.id === rec.id ? { ...x, lastSeenAt: at } : x)), []);
    }
    return { device: rec };
  }
  // A page on another site must not be able to make this browser act: a request that changes
  // anything must come from a page this server served (Origin's host equals the Host it was
  // called by, which hostAllowed has already checked). A missing or "null" Origin is refused.
  const sameOrigin = (req) => {
    try { return new URL(String(req.headers.origin)).host.toLowerCase() === String(req.headers.host || '').toLowerCase(); } catch { return false; }
  };

  // ---- what a connected device is sent: the site's data, never a key, a token or their hashes ----
  const bootId = randomBytes(6).toString('hex');
  let resets = 0; let rev = 1;
  core.onChange(({ kind }) => { rev += 1; if (kind === 'reset') resets += 1; });
  async function syncAnswer(query) {
    const epoch = `${bootId}.${resets}`;
    const same = query.get('epoch') === epoch;
    if (same && Number(query.get('rev')) === rev) return { ok: true, epoch, rev, unchanged: true };
    const after = (name) => { const n = Number(query.get(name)); return same && Number.isInteger(n) && n > 0 ? n : 0; };
    const [ev, au] = [after('events'), after('audit')];
    const atRev = rev;
    const meta = {};
    for (const id of SITE_META) meta[id] = await core.getMeta(id, null);
    if (Array.isArray(meta['agent-proposals'])) meta['agent-proposals'] = meta['agent-proposals'].map(({ request, ...p }) => p);
    return {
      ok: true, epoch, rev: atRev, full: !same,
      entities: await core.listEntities(),
      events: (await core.events()).filter((e) => e.seq > ev),
      audit: (await core.auditLog()).filter((e) => e.seq > au),
      meta,
    };
  }

  // ---- the app's own files, so a phone can open it from this computer ----
  async function serveStatic(req, res, path) {
    const plain = (status, text, headers = {}) => { res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', ...STATIC_HEADERS, ...headers }); res.end(text); };
    if (req.method !== 'GET' && req.method !== 'HEAD') return plain(405, 'This address takes GET.');
    if (path === '/' || path === '/app') return plain(302, 'The app is at /app/', { Location: '/app/' });
    let rel;
    try { rel = decodeURIComponent(path); } catch { return plain(400, 'Bad address.'); }
    if (rel.includes('\0') || rel.split('/').some((seg) => seg === '..' || seg.startsWith('.'))) return plain(404, 'Not found.');
    if (rel.endsWith('/')) rel += 'index.html';
    const file = resolve(WEB_ROOT, `.${rel}`);
    const allowed = ['app', 'brand'].some((d) => file.startsWith(resolve(WEB_ROOT, d) + sep)) || ['favicon.svg', 'favicon.ico'].some((f) => file === resolve(WEB_ROOT, f));
    const type = STATIC_TYPES[extname(file)];
    if (!allowed || !type) return plain(404, 'Not found.');
    const info = await stat(file).catch(() => null);
    if (!info?.isFile()) return plain(404, 'Not found.');
    let body = await readFile(file);
    // The app's page is told it came from a site server, so it asks for a code instead of
    // loading the made-up hospital into the browser (web/app/app.js).
    if (file === resolve(WEB_ROOT, 'app', 'index.html')) body = Buffer.from(body.toString('utf8').replace('<meta charset="utf-8">', `<meta charset="utf-8">\n${SITE_MARKER}`));
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache', ...STATIC_HEADERS });
    res.end(req.method === 'HEAD' ? undefined : body);
  }

  // ---- answers ----
  const fixFor = (err, cmd, who) => {
    switch (err.reason || err.code) {
      case 'people-only': return 'Ask a person at the site to do it at the server console. Nothing was changed.';
      case 'dial-off': return 'Ask a person at the site to switch agent access on at the server console (they type: start agents). Nothing was changed.';
      case 'not-listed': case 'ended': return 'Ask a person at the site to add this agent again at the server console (they type: setup agent).';
      case 'ward-off': case 'ward-not-listed': return 'Use one of your own units (GET /api/v1/whoami lists them), or ask a person at the site to switch this unit on for agents.';
      case 'other-role': case 'role-cannot': return `This key works for ${who ? roleById(who.role)?.name : 'one role'}. GET /api/v1/commands shows the roles each command needs.`;
      case 'invalid-input': return cmd ? `Send a JSON body like ${JSON.stringify({ input: cmd.example?.input ?? {} })}.` : 'Send a JSON body like { "input": { } }.';
      case 'unknown-command': return 'GET /api/v1/commands lists every command.';
      case 'not-found': return 'Use an id from the message, or list first.';
      case 'conflict': case 'already-open': return 'Read the current state again before you send a new request.';
      case 'personal-detail': return 'Take the personal detail out of the text and send it again.';
      default: return 'GET /api/v1/whoami shows what this key may do.';
    }
  };
  async function send(res, status, body, headers = {}) {
    const text = JSON.stringify({ ...body, synthetic: await synthetic() });
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers });
    res.end(text);
  }
  const fail = (res, code, message, fix, extra = {}, headers = {}) => send(res, STATUS[code] || 400, { ok: false, error: { code, message, fix, ...extra } }, headers);

  function hostAllowed(req) {
    const name = String(req.headers.host || '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();
    if (['127.0.0.1', 'localhost', '::1', host, ...allowHosts.map((h) => h.toLowerCase())].includes(name)) return true;
    return host !== '127.0.0.1' && Object.values(networkInterfaces()).flat().some((a) => a.address === name);
  }
  const readBody = (req) => new Promise((done, bad) => {
    let size = 0; const chunks = [];
    // Over the limit: stop keeping it, let it finish, then answer plainly.
    req.on('data', (c) => { size += c.length; if (size <= MAX_BODY) chunks.push(c); else chunks.length = 0; });
    req.on('end', () => (size > MAX_BODY ? bad(new CommandError('invalid-input', 'The request body is larger than 64 KB.')) : done(Buffer.concat(chunks).toString('utf8'))));
    req.on('error', bad);
  });

  // One request at a time per Idempotency-Key, so two copies of the same retry cannot both queue.
  const inFlight = new Map();
  const oneAtATime = (tag, fn) => {
    const run = (inFlight.get(tag) || Promise.resolve()).then(fn, fn);
    const tail = run.catch(() => {}).finally(() => { if (inFlight.get(tag) === tail) inFlight.delete(tag); });
    inFlight.set(tag, tail);
    return run;
  };

  async function whoami(listed, rec) {
    const access = await agentAccess(core);
    const wards = new Map((await core.listEntities('ward')).map((w) => [w.id, w.name]));
    const ended = Date.parse(listed.until) <= Date.parse(core.now());
    return {
      agent: listed.name, keyId: rec.id, actorType: 'agent',
      role: listed.role, roleName: roleById(listed.role)?.name || listed.role,
      units: listed.wards.map((id) => ({ id, name: wards.get(id) || id, on: access.wards[id] === true })),
      until: listed.until, ended,
      dial: access.allowed ? 'advise' : 'off',
      canDo: access.allowed && !ended ? 'Read, and propose changes for a person to accept or decline.' : ended ? 'Nothing: this agent passed its end date. A person at the site can add it again.' : 'Nothing yet: agent access is Off for this site. A person at the site can switch it on at the server console.',
      limits: { callsPerMinute, maxBodyBytes: MAX_BODY, idempotencyKeyHours: 24 },
      next: { list: 'GET /api/v1/commands', call: 'POST /api/v1/commands/ospeli_beds_find_free', body: { input: listed.wards[0] ? { wardId: listed.wards[0] } : {} } },
    };
  }

  async function handleCommand(req, res, name, auth) {
    const who = { type: 'agent', agent: auth.listed.name, role: auth.listed.role, via: 'api' };
    const cmd = commandByName(name);
    const refuseInput = async (message) => {
      const err = Object.assign(new CommandError('invalid-input', message), { refusal: true, reason: 'invalid-input' });
      await auditRefusal(core, name, null, who, err);
      return fail(res, 'invalid-input', message, fixFor(err, cmd, who));
    };
    if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) return refuseInput('The body must be JSON, with the header Content-Type: application/json.');
    let body;
    try { body = JSON.parse(await readBody(req) || '{}'); } catch (err) { return refuseInput(err instanceof CommandError ? err.message : 'The body is not valid JSON.'); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return refuseInput('The body must be a JSON object.');
    // Who is calling comes from the key. A body that tries to say otherwise is refused, not ignored.
    const extra = Object.keys(body).filter((k) => k !== 'input' && k !== 'dryRun');
    if (extra.length) return refuseInput('The body may hold only "input" and "dryRun". Who is calling comes from the key.');
    if ('dryRun' in body && typeof body.dryRun !== 'boolean') return refuseInput('"dryRun" must be true or false.');
    const input = body.input ?? {};
    const idem = req.headers['idempotency-key'];
    if (idem !== undefined && !IDEMPOTENCY_KEY.test(idem)) return refuseInput('Idempotency-Key must be 8 to 128 letters, digits, dots, dashes, underscores or colons.');

    const answer = (result, extraBody = {}, headers = {}) => {
      const lean = result?.proposal?.request ? { ...result, proposal: (({ request, ...p }) => p)(result.proposal) } : result;
      return send(res, 200, { ok: true, command: cmd?.name || name, result: lean, ...extraBody, ...(cmd?.freeText ? { untrustedText: describeCommand(cmd.name).freeText } : {}) }, headers);
    };
    const run = async (request) => answer(await runCommand(core, name, input, who, { dryRun: body.dryRun === true, request }));
    if (idem === undefined || body.dryRun === true || !cmd || cmd.kind === 'read') return run();

    // A retried write: the same key and body gets the proposal queued the first time. Only a
    // queued proposal is remembered (never a refusal), and only as two hashes on the proposal itself.
    const tag = sha(`${auth.rec.id}|${cmd.name}|${idem}`).slice(0, 32);
    const bodyHash = sha(canonical(input));
    return oneAtATime(tag, async () => {
      const now = Date.parse(core.now());
      const earlier = (await core.proposals()).find((p) => p.request?.tag === tag && now - Date.parse(p.at) < IDEMPOTENCY_MS);
      if (!earlier) return run({ tag, bodyHash });
      if (earlier.request.bodyHash !== bodyHash) {
        const err = Object.assign(new CommandError('conflict', 'This Idempotency-Key was already used with a different body.'), { refusal: true, reason: 'idempotency' });
        await auditRefusal(core, name, null, who, err);
        return fail(res, 'idempotency-key-reused', err.message, 'Use a new Idempotency-Key for a new request. Nothing was queued.');
      }
      // The agent must still be allowed in: reading its own proposals runs every check and leaves a trace.
      await runCommand(core, 'ospeli_proposals_list', { limit: 1 }, who);
      const current = (await core.proposals()).find((p) => p.id === earlier.id);
      return answer({ status: 'proposed', proposal: current }, { replayed: true }, { 'Idempotent-Replay': 'true' });
    });
  }

  // Calls from a connected device: a person in the device's role, via "app".
  async function handleDevice(req, res, path, m, from) {
    const notConnected = (reason) => fail(res, 'not-connected', 'This device is not connected.', 'Ask the person who looks after Ospeli here for a code (they type: add device).', { reason }, reason === 'missing' ? {} : { 'Set-Cookie': deviceCookie('gone', 0) });
    const jsonBody = async () => {
      if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) throw new CommandError('invalid-input', 'The body must be JSON, with the header Content-Type: application/json.');
      let body;
      try { body = JSON.parse(await readBody(req) || '{}'); } catch (err) { throw err instanceof CommandError ? err : new CommandError('invalid-input', 'The body is not valid JSON.'); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new CommandError('invalid-input', 'The body must be a JSON object.');
      return body;
    };
    try {
      if (path === '/api/v1/devices/pair') {
        if (req.method !== 'POST') return fail(res, 'invalid-input', 'This address takes POST.', 'Open the app in a browser and type the code there.');
        if (!sameOrigin(req)) return fail(res, 'forbidden', 'This call did not come from the Ospeli app on this server.', 'Open the app from the address the server printed.');
        const slot = pairLimiter.take(`pair|${from}`);
        if (!slot.ok) return fail(res, 'rate-limited', 'Too many tries. Wait a minute, then try again.', `Wait ${slot.retryAfter} seconds.`, {}, { 'Retry-After': String(slot.retryAfter) });
        const body = await jsonBody();
        if (typeof body.code !== 'string' || Object.keys(body).length !== 1) throw new CommandError('invalid-input', 'Send { "code": "…" } and nothing else.');
        const { device, token } = await pairDevice(body.code);
        return send(res, 200, { ok: true, device: { label: device.label, role: device.role, roleName: roleById(device.role).name } }, { 'Set-Cookie': deviceCookie(token, DEVICE_IDLE_DAYS * 86400) });
      }
      const auth = await authenticateDevice(req);
      if (auth.fail) {
        const slot = anonLimiter.take(`nodevice|${from}`);
        if (!slot.ok) return fail(res, 'rate-limited', 'Too many calls from a device that is not connected.', `Wait ${slot.retryAfter} seconds.`, {}, { 'Retry-After': String(slot.retryAfter) });
        return notConnected(auth.fail);
      }
      const d = auth.device;
      if (!deviceLimiter.take(d.id).ok) return fail(res, 'rate-limited', 'Too many calls from this device in a minute.', 'Wait a minute, then go on.', {}, { 'Retry-After': '60' });
      if (path === '/api/v1/session') {
        if (req.method !== 'GET') return fail(res, 'invalid-input', 'session takes GET.', 'Send a GET request.');
        return send(res, 200, { ok: true, device: { label: d.label, role: d.role, roleName: roleById(d.role).name }, site: HOSPITAL_NAME });
      }
      if (path === '/api/v1/sync') {
        if (req.method !== 'GET') return fail(res, 'invalid-input', 'sync takes GET.', 'Send a GET request.');
        return send(res, 200, await syncAnswer(new URL(req.url, 'http://site').searchParams));
      }
      if (req.method !== 'POST') return fail(res, 'invalid-input', 'Commands take POST.', 'Send POST with a JSON body like { "input": { } }.');
      if (!sameOrigin(req)) return fail(res, 'forbidden', 'This call did not come from the Ospeli app on this server.', 'Open the app from the address the server printed.');
      const body = await jsonBody();
      // Who is acting comes from the cookie. A body that says anything else is refused.
      if (Object.keys(body).some((k) => k !== 'input')) throw new CommandError('invalid-input', 'The body may hold only "input". Who is acting comes from the connected device.');
      const who = { type: 'human', role: d.role, via: 'app', device: d.label };
      const result = await runCommand(core, m[1], body.input ?? {}, who);
      return send(res, 200, { ok: true, command: commandByName(m[1])?.name || m[1], result });
    } catch (err) {
      if (!(err instanceof CommandError)) throw err;
      return fail(res, err.code, err.message, err.code === 'code-old' || err.code === 'code-wrong' ? 'Ask the person who looks after Ospeli here for a code (they type: add device).' : 'Nothing was changed.', err.detail && typeof err.detail === 'object' ? { detail: err.detail } : {});
    }
  }

  const openapi = () => buildOpenApi(listCommands(), { serverVersion: SERVER_VERSION });

  async function handle(req, res) {
    let path;
    try { path = new URL(req.url, 'http://site').pathname.replace(/\/+$/, '') || '/'; } catch { path = '/'; }
    if (!hostAllowed(req)) return fail(res, 'forbidden', 'This address is not one the server answers to.', 'Call the server by the address it printed when it started.');
    const open = { '/api/v1/health': () => ({ ok: true, name: 'ospeli-site-server', version: SERVER_VERSION }), '/api/v1/commands': () => ({ ok: true, commands: listCommands() }), '/api/v1/openapi.json': () => openapi() };
    const from = req.socket.remoteAddress || 'unknown';
    if (open[path]) {
      if (req.method !== 'GET') return fail(res, 'invalid-input', `${path} takes GET.`, 'Send a GET request.');
      const slot = anonLimiter.take(`open|${from}`);
      // The three open routes hold no site data; they share a generous limit per address.
      if (!slot.ok && !anonLimiter.take(`open2|${from}`).ok && !anonLimiter.take(`open3|${from}`).ok && !anonLimiter.take(`open4|${from}`).ok) {
        return fail(res, 'rate-limited', 'Too many calls from this address.', `Wait ${slot.retryAfter} seconds, then go on.`, {}, { 'Retry-After': String(slot.retryAfter) });
      }
      return send(res, 200, open[path]());
    }
    // The app's own files (and nothing else on this computer): /, /app/…, /brand/…, the icon.
    let rawPath = null;
    try { rawPath = new URL(req.url, 'http://site').pathname; } catch { /* an address the parser rejects: the plain 404 below */ }
    if (rawPath !== null && (rawPath === '/' || rawPath === '/app' || rawPath.startsWith('/app/') || rawPath.startsWith('/brand/') || /^\/favicon\.(svg|ico)$/.test(rawPath))) return serveStatic(req, res, rawPath);
    const m = /^\/api\/v1\/commands\/([^/]{1,80})$/.exec(path);
    const hasKey = req.headers.authorization !== undefined;
    const hasCookie = cookieOf(req) !== null;
    if (['/api/v1/devices/pair', '/api/v1/session', '/api/v1/sync'].includes(path) || (m && hasCookie)) {
      // One door per call: an agent key and a device cookie together are refused, so a call can
      // never be read as both an agent and a person.
      if (hasKey) return fail(res, 'invalid-input', hasCookie ? 'This call carries an agent key and a device cookie. Send one of them.' : 'This address is for a connected device, not an agent key.', 'Agents use GET /api/v1/whoami and POST /api/v1/commands/<name> with their key, and no cookie.');
      return handleDevice(req, res, path, m, from);
    }
    if (path !== '/api/v1/whoami' && !m) return fail(res, 'not-found', 'There is nothing at this address.', 'Start with GET /api/v1/health, then GET /api/v1/whoami with your key.');

    // The key decides who is calling. Calls without a valid key are limited per address before
    // anything is written, then recorded as "unlisted" (counted, not one entry each).
    const auth = await authenticate(req);
    if (auth.fail) {
      const slot = anonLimiter.take(`nokey|${from}`);
      if (!slot.ok) return fail(res, 'rate-limited', 'Too many calls without a valid key.', `Wait ${slot.retryAfter} seconds. Then send the header "Authorization: Bearer osk_…".`, {}, { 'Retry-After': String(slot.retryAfter) });
      const message = { missing: 'This call has no key.', unknown: 'This key is not one this site gave out.', revoked: 'This key was replaced or switched off.', removed: 'The agent this key belonged to was removed or added again.' }[auth.fail];
      await auditRefusal(core, '(http)', null, { via: 'api' }, Object.assign(new CommandError('unauthorized', 'A call arrived without a valid key.'), { reason: `key-${auth.fail}` }));
      return fail(res, 'unauthorized', message, 'Send the header "Authorization: Bearer osk_…". A person at the site gets a key at the server console (they type: setup agent, or: new key <name>).', {}, { 'WWW-Authenticate': 'Bearer' });
    }
    const who = { type: 'agent', agent: auth.listed.name, role: auth.listed.role, via: 'api' };
    const slot = keyLimiter.take(auth.rec.id);
    if (!slot.ok) {
      await auditRefusal(core, m ? m[1] : '(http)', null, who, Object.assign(new CommandError('rate-limited', `More than ${callsPerMinute} calls in a minute.`), { reason: 'rate-limit' }));
      return fail(res, 'rate-limited', `This key may make ${callsPerMinute} calls a minute.`, `Wait ${slot.retryAfter} seconds, then go on.`, {}, { 'Retry-After': String(slot.retryAfter) });
    }
    if (path === '/api/v1/whoami') {
      if (req.method !== 'GET') return fail(res, 'invalid-input', 'whoami takes GET.', 'Send a GET request.');
      await core.recordAs(who, 'agent.read', null, { command: 'whoami' });
      return send(res, 200, { ok: true, whoami: await whoami(auth.listed, auth.rec) });
    }
    if (req.method !== 'POST') return fail(res, 'invalid-input', 'Commands take POST.', `Send POST ${path} with a JSON body like { "input": { } }.`);
    try {
      return await handleCommand(req, res, m[1], auth);
    } catch (err) {
      if (!(err instanceof CommandError)) throw err;
      const cmd = commandByName(m[1]);
      const peopleOnly = err.reason === 'people-only';
      return fail(res, err.code, peopleOnly ? 'This action is for a person. An agent cannot do it over the API.' : err.message, fixFor(err, cmd, who), err.detail && typeof err.detail === 'object' ? { detail: err.detail } : {});
    }
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      // Never the Authorization header, never the body: only what went wrong.
      process.stderr.write(`ospeli-server: ${err?.stack || err}\n`);
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: { code: 'server-error', message: 'The server could not finish this call.', fix: 'Try again. If it keeps happening, tell the person who looks after this server.' } }));
    });
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  try {
    await new Promise((ok, bad) => { server.once('error', bad); server.listen(port, host, ok); });
  } catch (err) {
    await adapter.close();
    if (err.code === 'EADDRINUSE') throw new StartError(`Something else on this computer is already using port ${port}. Start Ospeli on another one, for example: --port ${port + 1}`);
    if (err.code === 'EACCES') throw new StartError(`This computer does not let Ospeli use port ${port}. Try: --port ${DEFAULT_PORT}`);
    throw err;
  }
  const actualPort = server.address().port;
  const lan = Object.values(networkInterfaces()).flat().find((a) => a && a.family === 'IPv4' && !a.internal)?.address;
  const url = `http://${host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host}:${actualPort}`;
  const shareUrl = host === '127.0.0.1' || host === 'localhost' ? null : `http://${host === '0.0.0.0' || host === '::' ? (lan || '<this computer>') : host}:${actualPort}`;

  // ---- the console: where people act (recorded as a person, via "console") ----
  const wardsList = async () => (await core.listEntities('ward')).sort((a, b) => (a.name < b.name ? -1 : 1));
  const ago = (at) => { const m = Math.max(0, Math.round((Date.parse(core.now()) - Date.parse(at)) / 60000)); return m < 60 ? `${m} min ago` : m < 2880 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`; };
  const propNumber = (id) => Number(String(id).replace(/^prop-0*/, ''));
  const propId = (n) => `prop-${String(n).padStart(4, '0')}`;

  async function addAgent({ name, role, wards, days = 30 }) {
    // If bots were stopped while others are on the list, adding one more must not quietly let
    // them all back in: the new bot is listed and gets its key, and the person types "start agents".
    const before = await agentAccess(core);
    const others = (await agentList(core)).filter((r) => agentKey(r.name) !== agentKey(name) && Date.parse(r.until) > Date.parse(core.now()));
    const stayOff = !before.allowed && others.length > 0;
    const out = await asPerson('ospeli_agents_add', { name, role, wards, days });
    if (!stayOff) await asPerson('ospeli_agents_set_access', { allowed: true, wards: { ...before.wards, ...Object.fromEntries(wards.map((w) => [w, true])) } });
    const { key } = await issueKey(out.agent.name);
    const names = new Map((await wardsList()).map((w) => [w.id, w.name]));
    return { key, agent: out.agent, text: [
      ...(stayOff ? [`Bots and scripts are still OFF (${others.length} other bot${others.length === 1 ? ' is' : 's are'} on the list). "${out.agent.name}" is on the list but shut out until you type: start agents`] : []),
      `Bot "${out.agent.name}" ${stayOff ? 'will' : 'may now'} read and suggest as ${out.agent.roleName}${wards.length ? ` on: ${wards.map((w) => names.get(w)).join(', ')}` : ' (no units)'}. It ends in ${days} days.`,
      'Its key. Copy it now; it cannot be shown again:',
      `  ${key}`,
      `Lost it? Type: new key ${out.agent.name}`,
      'Try it from this computer:',
      `  curl -H "Authorization: Bearer ${key}" ${url}/api/v1/whoami`,
      'Anything the bot suggests waits here. Type: proposals',
    ].join('\n') };
  }

  const HELP = [
    'Type a word and press Enter:',
    '  setup agent          let one bot in (4 questions)',
    '  proposals            see changes waiting for a person',
    '  accept 3             say yes to proposal 3',
    `  decline 3            say no to proposal 3 (add a reason number: ${DECLINE_REASONS.map((r, i) => `${i + 1} ${r}`).join(', ')})`,
    '  stop agents          shut out every bot now',
    '  start agents         let the listed bots in again',
    '  agents               the bots on this site\'s list',
    '  new key NAME         a new key for a bot (the old one stops working)',
    '  remove agent NAME    take a bot off the list',
    '  add device           connect a phone or laptop (2 questions, then a code to type on it)',
    '  devices              the phones and laptops connected to this site',
    '  remove device 2      disconnect device 2 on that list',
    '  audit                check the audit trail and show the last entries',
    '  backup FILE          save a copy of all data to FILE',
    '  status               the address and whether bots are on',
    'To turn Ospeli off: press Ctrl and C together.',
  ].join('\n');

  async function banner() {
    const access = await agentAccess(core);
    const now = Date.parse(core.now());
    const live = (await agentList(core)).filter((r) => Date.parse(r.until) > now).length;
    return [
      'Ospeli is running on this computer. Leave this window open.',
      `Data: DEMO (${HOSPITAL_NAME}, made up; no real patients). Do not load real records.`,
      shareUrl ? `Address for other computers here: ${shareUrl}` : `Address: ${url} (this computer only)`,
      ...(shareUrl ? ['Warning: keys and device links travel unencrypted on your network. Use this only on a network you trust.'] : []),
      access.allowed ? `Bots and scripts: ON for ${live} bot${live === 1 ? '' : 's'}. They read and suggest; a person here says yes or no.` : 'Bots and scripts: OFF. No bot or script can read or suggest yet.',
      `On a phone or laptop: ${appUrl} (first type here: add device)`,
      `Data file: ${resolve(file)}`,
      '',
      'Type a word below and press Enter:',
      '  add device    connect a phone or laptop to this site',
      '  setup agent   let one bot in (4 questions)',
      '  proposals     see changes waiting for a person',
      '  stop agents   shut out every bot now',
      '  help          everything else',
      'To turn Ospeli off: press Ctrl and C together.',
    ].join('\n');
  }

  const appUrl = `${shareUrl || url}/app/`;
  const deviceText = (out) => [
    `Code for "${out.label}" (${roleById(out.role).name}):`,
    '',
    `    ${out.code}`,
    '',
    'On the phone or laptop:',
    ...(shareUrl ? ['  1. Join the same Wi-Fi or network as this computer.', `  2. Open a browser and go to: ${appUrl}`, '  3. Type the code.'] : [`  1. Open a browser on this computer and go to: ${appUrl}`, '  2. Type the code.', '  (Other devices cannot reach Ospeli yet. To let them, start it with: --host 0.0.0.0)']),
    `The code works once, for ${CODE_MINUTES} minutes. What is done on that device is recorded as a person in that role, from "${out.label}".`,
    ...(shareUrl ? ['Warning: this network link is not encrypted. Use it only on a network you trust.'] : []),
  ].join('\n');

  let wizard = null; // the "setup agent" and "add device" questions, one line at a time
  async function wizardStep(line) {
    const w = wizard; const text = line.trim();
    if (/^stop (agents|bots)$/i.test(text)) { wizard = null; return consoleLine('stop agents'); }
    if (/^(cancel|stop|quit)$/i.test(text)) { wizard = null; return 'Cancelled. Nothing was changed.'; }
    if (w.step === 'device-label') {
      if (text && (!DEVICE_LABEL.test(text) || personNameIn(text) || personNameIn(text, { roleField: true }))) return 'Say where the device is or what it is for, not whose it is, for example front desk tablet (letters, digits, spaces, dots, dashes). Or press Enter to skip.';
      if (text && (await liveDevices()).some((d) => d.label.toLowerCase() === text.toLowerCase())) return `There is already a device called ${text}. Pick another label, or press Enter to skip.`;
      w.label = text; w.step = 'device-role';
      return `2 of 2. Which role will use it? It can see and do what that role can.\n${ROLES.map((r, i) => `  ${i + 1}  ${r.name}`).join('\n')}\nType a number.`;
    }
    if (w.step === 'device-role') {
      const r = ROLES[Number(text) - 1];
      if (!r) return `Type a number from 1 to ${ROLES.length}. Or type: cancel`;
      wizard = null;
      const out = await deviceCode({ label: w.label, role: r.id });
      return deviceText(out);
    }
    if (w.step === 'name') {
      if (!/^[A-Za-z0-9][A-Za-z0-9 ._-]{1,40}$/.test(text)) return 'Give the bot a short name that says what it does, for example night-helper (letters, digits, spaces, dots, dashes). Or type: cancel';
      if ((await agentList(core)).some((r) => agentKey(r.name) === agentKey(text))) return `There is already a bot called ${text}. Pick another name, or type cancel and then: remove agent ${text}`;
      w.name = text; w.step = 'role';
      return `2 of 4. Which role does it work for? It can read and suggest what that role can.\n${ROLES.map((r, i) => `  ${i + 1}  ${r.name}`).join('\n')}\nType a number.`;
    }
    if (w.step === 'role') {
      const r = ROLES[Number(text) - 1];
      if (!r) return `Type a number from 1 to ${ROLES.length}. Or type: cancel`;
      w.role = r.id; w.step = 'units'; w.wards = await wardsList();
      return `3 of 4. Which units may it see?\n${w.wards.map((x, i) => `  ${i + 1}  ${x.name}`).join('\n')}\nType numbers like 1,3 or the word all.`;
    }
    if (w.step === 'units') {
      const picks = /^all$/i.test(text) ? w.wards : text.split(/[ ,]+/).filter(Boolean).map((n) => w.wards[Number(n) - 1]);
      if (!picks.length || picks.some((p) => !p)) return `Type numbers from 1 to ${w.wards.length}, like 1,3, or the word all. Or type: cancel`;
      w.units = [...new Set(picks.map((p) => p.id))]; w.step = 'days';
      return `4 of 4. For how many days? Press Enter for 30 (${MAX_AGENT_DAYS} at most).`;
    }
    const days = text === '' ? 30 : Number(text);
    if (!Number.isInteger(days) || days < 1 || days > MAX_AGENT_DAYS) return `Type a number of days from 1 to ${MAX_AGENT_DAYS}, or press Enter for 30.`;
    wizard = null;
    return (await addAgent({ name: w.name, role: w.role, wards: w.units, days })).text;
  }

  async function consoleLine(line) {
    try {
      if (wizard) return await wizardStep(line);
      // "bot" and "agent" are the same word here.
      const text = line.trim().replace(/\s+/g, ' ').replace(/^(setup|stop|start|remove) bots?\b/i, (m0, v) => `${v} agent${/^(stop|start)$/i.test(v) ? 's' : ''}`).replace(/^bots$/i, 'agents');
      const low = text.toLowerCase();
      const bare = { accept: 'Type accept and the number, for example: accept 1', decline: 'Type decline and the number, for example: decline 1', 'new key': 'Type new key and the bot\'s name, for example: new key night-helper', 'remove agent': 'Type remove agent and the bot\'s name, for example: remove agent night-helper', 'remove device': 'Type remove device and its number on the list, for example: remove device 1. To see the list, type: devices', backup: 'Type backup and a file name, for example: backup ospeli-copy.db' }[low];
      if (bare) return bare;
      if (!text) return '';
      if (low === 'help' || low === '?') return HELP;
      if (low === 'status') return banner();
      if (low === 'setup agent' || low === 'setup') { wizard = { step: 'name' }; return '1 of 4. What is the bot called? A short name that says what it does, for example night-helper. (Type cancel to stop.)'; }
      if (low === 'stop agents' || low === 'stop') {
        await asPerson('ospeli_agents_stop_all', {});
        return 'All bots are shut out. No bot can read or suggest.\nTo let the listed bots in again, type: start agents';
      }
      if (low === 'start agents') {
        // Stopping switches every unit off. Starting again switches on the units a person already
        // gave to the bots still on the list, and nothing more.
        const now = Date.parse(core.now());
        const live = (await agentList(core)).filter((r) => Date.parse(r.until) > now);
        const units = [...new Set(live.flatMap((r) => r.wards))];
        await asPerson('ospeli_agents_set_access', { allowed: true, wards: Object.fromEntries(units.map((w) => [w, true])) });
        return live.length ? `Bots are let in again: ${live.length} on the list, on the units they were given. To see them, type: agents` : 'Bots may come in, but none is on the list yet. Type: setup agent';
      }
      if (low === 'agents') {
        const out = await asPerson('ospeli_agents_list', {});
        const ks = await keys();
        if (!out.agents.length) return `No bots on the list. Bots and scripts: ${out.allowed ? 'ON' : 'OFF'}.\nTo let one in, type: setup agent`;
        return [`Bots and scripts: ${out.allowed ? 'ON' : 'OFF'}.`, ...out.agents.map((a) => {
          const k = ks.find((x) => x.agent === agentKey(a.name) && !x.revokedAt && x.agentAddedAt === a.addedAt);
          return `  ${a.name} · ${a.roleName} · ${a.wards.length} unit${a.wards.length === 1 ? '' : 's'} · ${a.ended ? 'ENDED' : `until ${a.until.slice(0, 10)}`} · ${k ? `key ${k.id}…` : 'no key (type: new key ' + a.name + ')'}`;
        }), out.allowed ? 'To shut every bot out now, type: stop agents' : 'To let them in again, type: start agents'].join('\n');
      }
      let m;
      if (low === 'add device' || low === 'add a device') { wizard = { step: 'device-label' }; return '1 of 2. Where is this device, or what is it for? For example: front desk tablet. (Press Enter to skip. Type cancel to stop.)'; }
      if (low === 'devices') {
        const all = await liveDevices();
        if (!all.length) return 'No phone or laptop is connected. To connect one, type: add device';
        return ['Connected devices:', ...all.map((d, i) => `  ${i + 1}  ${d.label} · ${roleById(d.role)?.name || d.role} · last used ${ago(d.lastSeenAt)}`), 'To disconnect one, type: remove device NUMBER'].join('\n');
      }
      if ((m = /^remove device (.+)$/i.exec(text))) {
        const d = await removeDevice(m[1]);
        return `"${d.label}" is disconnected. It will ask for a new code.`;
      }
      if ((m = /^new key (.+)$/i.exec(text))) {
        const { key, agent } = await issueKey(m[1]);
        return `New key for "${agent.name}". The old one no longer works. Copy it now; it cannot be shown again:\n  ${key}`;
      }
      if ((m = /^remove agent (.+)$/i.exec(text))) {
        const out = await asPerson('ospeli_agents_remove', { name: m[1] });
        await revokeKeys(out.name);
        return `"${out.name}" is off the list and its key no longer works.`;
      }
      if (low === 'proposals') {
        const out = await asPerson('ospeli_proposals_list', { status: 'pending', limit: 20 });
        if (!out.total) return 'Nothing is waiting for a person.';
        return [`${out.total} waiting for a person${out.truncated ? ' (first 20 shown)' : ''}:`, ...out.proposals.map((p) => `  ${propNumber(p.id)}  ${p.agent} (for ${roleById(p.role)?.name}) asks: ${commandByName(p.command)?.summary.split('. ')[0] || p.command}\n     ${JSON.stringify(p.input)} · ${ago(p.at)}${p.agentOnList ? '' : ' · this bot is no longer on the list'}`),
          'Nothing changes until you say so. Type: accept NUMBER  or  decline NUMBER'].join('\n');
      }
      if ((m = /^(accept|decline) #?(\d+)(?: (\d))?$/i.exec(text))) {
        const id = propId(m[2]);
        const p = (await core.proposals()).find((x) => x.id === id);
        if (!p) return `There is no proposal ${m[2]}. To see what is waiting, type: proposals`;
        // Recorded under the role the bot works for: a person at this console acting in that role.
        if (m[1].toLowerCase() === 'accept') {
          const out = await asPerson('ospeli_proposals_accept', { id }, p.role);
          return out.status === 'accepted' ? `Done. Proposal ${m[2]} was accepted and the change is made.` : `Proposal ${m[2]} could not be done any more: ${out.message} Nothing was changed.`;
        }
        const reason = DECLINE_REASONS[m[3] ? Number(m[3]) - 1 : 0];
        if (!reason) return `Reason numbers: ${DECLINE_REASONS.map((r, i) => `${i + 1} ${r}`).join(', ')}. For example: decline ${m[2]} 1`;
        await asPerson('ospeli_proposals_decline', { id, reason }, p.role);
        return `Proposal ${m[2]} was declined (${reason}). Nothing was changed.`;
      }
      if (low === 'audit') {
        const log = await core.auditLog();
        const check = await core.auditCheck();
        const who = (e) => (e.actorType === 'agent' ? `agent ${e.agent}${e.via === 'api' ? ' (over the API)' : ''}` : e.actorType === 'system' ? 'system' : `person, ${roleById(e.actorRole)?.name || e.actorRole}${e.via === 'console' ? ' (at this console)' : e.via === 'app' ? ` (on ${e.device})` : ''}`);
        return [check.ok ? auditLine(check) : `Audit trail: BROKEN at entry ${check.at} (${check.reason}). Tell the person who looks after this server.`,
          ...log.slice(-8).map((e) => `  ${e.seq}  ${e.at.slice(0, 16).replace('T', ' ')}  ${who(e)}  ${e.action}${e.detail?.command ? ` ${e.detail.command}` : ''}`)].join('\n');
      }
      if ((m = /^backup (.+)$/i.exec(text))) {
        const to = resolve(m[1]);
        try { adapter.backupTo(to); } catch (err) { return `The copy could not be saved to ${to} (${/exist/i.test(err.message) ? 'a file with that name is already there; give a new name' : err.message}).`; }
        await core.recordAs(person(CONSOLE_ADMIN), 'data.backup', null, null);
        return `Saved a copy of all data to ${to}. To use it later, start Ospeli with: --data ${to}`;
      }
      return `"${text.slice(0, 40)}" is not a word Ospeli knows. Type: help`;
    } catch (err) {
      wizard = null;
      if (err instanceof CommandError) return `That did not work: ${err.message}\nNothing was changed. For the list of words, type: help`;
      throw err;
    }
  }

  return {
    core, url, shareUrl, port: actualPort, file,
    banner, consoleLine, addAgent, issueKey, openapi, deviceCode, appUrl,
    async close() {
      await new Promise((r) => { server.close(r); server.closeAllConnections?.(); });
      await core.queue;
      await adapter.close();
    },
  };
}
