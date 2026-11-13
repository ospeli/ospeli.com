// The Ospeli site server, first version (backlog A8, docs/AGENT-API-SPEC.md section 3).
// The same core and command registry as the browser app, on the site's own computer, with an
// HTTP API so the site's own bots and scripts can read and propose.
//
// The rules this file keeps:
// - Who is calling comes from the key and nothing else. Everything that arrives over HTTP is
//   recorded as an agent, with via "api". No HTTP route can be recorded as a person.
// - People act at the server's own console (the window it runs in). Those entries are recorded
//   as a person in a role, with via "console": typed at the server, not a named sign-in.
// - Agent access is Off until a person switches it on. Agents read and propose; a person
//   accepts or declines. Refused calls are recorded without storing what the agent typed.
// - Nothing leaves the site: the server listens on this computer only unless told otherwise,
//   and it calls nobody.
import { createServer } from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Core } from '../../web/app/core/core.js';
import { canonical } from '../../web/app/core/audit.js';
import { ROLES, roleById } from '../../web/app/core/model.js';
import { loadSyntheticHospital, setupUnfinished, currentHour, HOSPITAL_NAME } from '../../web/app/core/generator.js';
import {
  runCommand, commandByName, describeCommand, listCommands, agentAccess, agentList, auditRefusal, CommandError, DECLINE_REASONS, MAX_AGENT_DAYS,
} from '../../web/app/core/commands.js';
import { SqliteAdapter, StoreInUseError } from './store.mjs';
import { buildOpenApi } from './openapi.mjs';

export const SERVER_VERSION = '0.1.0';
export const DEFAULT_PORT = 8787;
const MAX_BODY = 64 * 1024;
const IDEMPOTENCY_MS = 24 * 3600 * 1000;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,128}$/;
const KEY_SHAPE = /^osk_([0-9a-f]{8})_([A-Za-z0-9_-]{32})$/;
const CONSOLE_ADMIN = 'ops-manager'; // the role console actions on agent access are recorded under

const sha = (text) => createHash('sha256').update(text).digest('hex');
const agentKey = (name) => String(name).trim().toLowerCase();
const STATUS = { 'invalid-input': 400, unauthorized: 401, forbidden: 403, 'agents-off': 403, 'unknown-command': 404, 'not-found': 404, conflict: 409, 'idempotency-key-reused': 409, 'rate-limited': 429 };

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
    const m = /^\/api\/v1\/commands\/([^/]{1,80})$/.exec(path);
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
      ...(shareUrl ? ['Warning: keys travel unencrypted on your network. Use this only on a network you trust.'] : []),
      access.allowed ? `Bots and scripts: ON for ${live} bot${live === 1 ? '' : 's'}. They read and suggest; a person here says yes or no.` : 'Bots and scripts: OFF. No bot or script can read or suggest yet.',
      `Data file: ${resolve(file)}`,
      '',
      'Type a word below and press Enter:',
      '  setup agent   let one bot in (4 questions)',
      '  proposals     see changes waiting for a person',
      '  stop agents   shut out every bot now',
      '  help          everything else',
      'To turn Ospeli off: press Ctrl and C together.',
    ].join('\n');
  }

  let wizard = null; // the "setup agent" questions, one line at a time
  async function wizardStep(line) {
    const w = wizard; const text = line.trim();
    if (/^stop (agents|bots)$/i.test(text)) { wizard = null; return consoleLine('stop agents'); }
    if (/^(cancel|stop|quit)$/i.test(text)) { wizard = null; return 'Cancelled. Nothing was changed.'; }
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
      const bare = { accept: 'Type accept and the number, for example: accept 1', decline: 'Type decline and the number, for example: decline 1', 'new key': 'Type new key and the bot\'s name, for example: new key night-helper', 'remove agent': 'Type remove agent and the bot\'s name, for example: remove agent night-helper', backup: 'Type backup and a file name, for example: backup ospeli-copy.db' }[low];
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
        const check = await core.verifyAudit();
        const who = (e) => (e.actorType === 'agent' ? `agent ${e.agent}${e.via === 'api' ? ' (over the API)' : ''}` : e.actorType === 'system' ? 'system' : `person, ${roleById(e.actorRole)?.name || e.actorRole}${e.via === 'console' ? ' (at this console)' : ''}`);
        return [check.ok ? `Audit trail: ${log.length} entries; the chain check passed.` : `Audit trail: BROKEN at entry ${check.at} (${check.reason}). Tell the person who looks after this server.`,
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
    banner, consoleLine, addAgent, issueKey, openapi,
    async close() {
      await new Promise((r) => { server.close(r); server.closeAllConnections?.(); });
      await core.queue;
      await adapter.close();
    },
  };
}
