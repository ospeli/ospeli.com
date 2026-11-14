// Security hardening of the site server (ospeli/ospeli docs/SECURITY.md). Each test tries the
// bad thing against a throwaway server on this computer and expects it to be refused.
// - the data file and every backup can be read only by the account that runs Ospeli;
// - every answer carries headers that stop another site framing, loading or guessing at it;
// - with the site's own certificate the server answers over https only, the device cookie is
//   marked Secure, and a page served over plain http cannot make a device act;
// - every command refuses fields it does not know and text or lists without a limit.
// Keys and certificates here are made at test time and thrown away. None is in the repository.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { fileURLToPath } from 'node:url';

const emit = process.emitWarning;
process.emitWarning = (w, ...rest) => (/SQLite/i.test(String(w?.message || w)) ? undefined : emit.call(process, w, ...rest));
const { startServer, StartError } = await import('../../tools/ospeli-server/site-server.mjs');
const { listCommands, commandByName } = await import('../../web/app/core/commands.js');

const END = '2026-11-08T12:00:00.000Z';
const dir = mkdtempSync(join(tmpdir(), 'ospeli-hardening-'));
const sites = [];
after(async () => { for (const s of sites) await s.close().catch(() => {}); rmSync(dir, { recursive: true, force: true }); });

let n = 0;
async function start(opts = {}) {
  const t = { now: Date.parse(END) };
  const site = await startServer({ file: join(dir, `site-${++n}.db`), port: 0, end: END, clock: () => new Date(t.now += 1000), ...opts });
  sites.push(site);
  return site;
}
// One raw request, so nothing tidies the headers. `ca` makes it an https request that checks
// the server's certificate against that authority (never "accept anything").
const raw = (site, { method = 'GET', path = '/', headers = {}, body, ca, plain = false } = {}) => new Promise((done) => {
  const u = new URL(site.url);
  const req = (ca && !plain ? httpsRequest : httpRequest)({ host: u.hostname, port: u.port, path, method, headers, ...(ca && !plain ? { ca } : {}) }, (res) => {
    let text = ''; res.on('data', (c) => { text += c; });
    res.on('end', () => { let json = null; try { json = JSON.parse(text); } catch { /* a file */ } done({ status: res.statusCode, headers: res.headers, text, json }); });
  });
  req.on('error', (err) => done({ status: 0, error: err }));
  if (body !== undefined) req.write(typeof body === 'string' ? body : JSON.stringify(body));
  req.end();
});
async function deviceCode(site) {
  await site.consoleLine('add device'); await site.consoleLine('front desk tablet');
  return /^ {4}([A-Z0-9]{4}-[A-Z0-9]{4})$/m.exec(await site.consoleLine('2'))[1];
}
const modeOf = (path) => (statSync(path).mode & 0o777).toString(8);

test('the data file, a folder Ospeli makes for it and every backup are for the account that runs Ospeli only', { skip: process.platform === 'win32' ? 'Windows has no owner-only file mode; see docs/SECURITY.md' : false }, async () => {
  const file = join(dir, 'made-by-ospeli', 'data', 'site.db');
  const site = await startServer({ file, port: 0, end: END });
  sites.push(site);
  assert.equal(modeOf(file), '600', 'another account on this computer cannot read the data file');
  assert.equal(modeOf(join(dir, 'made-by-ospeli', 'data')), '700', 'a folder Ospeli made is closed to other accounts');
  assert.ok(!/other accounts on this computer can read/.test(await site.banner()));
  // A change is written, and the file stays closed.
  await site.consoleLine('stop agents');
  assert.equal(modeOf(file), '600');
  const copy = join(dir, 'copy.db');
  assert.match(await site.consoleLine(`backup ${copy}`), /^Saved a copy/);
  assert.equal(modeOf(copy), '600', 'a backup holds the same data, so it is closed the same way');
  // A file that was left open by an older version is closed when the server starts on it.
  await site.close();
  const { chmodSync } = await import('node:fs');
  chmodSync(file, 0o644);
  const again = await startServer({ file, port: 0, end: END });
  sites.push(again);
  assert.equal(modeOf(file), '600');
});

test('every answer says: do not guess the type, do not frame it, other sites may not load it; an API answer may load nothing', async () => {
  const site = await start();
  const api = [
    await raw(site, { path: '/api/v1/health' }),
    await raw(site, { path: '/api/v1/whoami' }), // 401
    await raw(site, { path: '/nothing-here' }), // 404
    await raw(site, { path: '/api/v1/health', headers: { Host: 'other-site.example' } }), // 403
    await raw(site, { method: 'POST', path: '/api/v1/devices/pair', headers: { 'Content-Type': 'application/json', Origin: site.url }, body: '{not json' }), // 400
  ];
  assert.deepEqual(api.map((r) => r.status), [200, 401, 404, 403, 400]);
  for (const r of api) {
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
    assert.equal(r.headers['x-frame-options'], 'DENY');
    assert.equal(r.headers['cross-origin-resource-policy'], 'same-origin');
    assert.equal(r.headers['referrer-policy'], 'no-referrer');
    assert.equal(r.headers['content-security-policy'], "default-src 'none'; frame-ancestors 'none'");
    assert.equal(r.headers['cache-control'], 'no-store');
    assert.equal(r.headers['access-control-allow-origin'], undefined, 'no other site is given leave to read an answer');
    assert.ok(!/at .*\.m?js:\d+|node:internal/.test(r.text), 'no stack trace or file path in an answer');
  }
  for (const path of ['/app/', '/app/app.js', '/app/does-not-exist.js']) {
    const r = await raw(site, { path });
    assert.equal(r.headers['x-frame-options'], 'DENY', path);
    assert.equal(r.headers['cross-origin-resource-policy'], 'same-origin', path);
    assert.equal(r.headers['cross-origin-opener-policy'], 'same-origin', path);
    const csp = r.headers['content-security-policy'];
    assert.match(csp, /default-src 'self'/); assert.match(csp, /object-src 'none'/); assert.match(csp, /frame-ancestors 'none'/); assert.match(csp, /base-uri 'none'/);
    assert.ok(!/script-src[^;]*unsafe-inline|unsafe-eval/.test(csp), 'no inline or evaluated script is allowed');
  }
  // A cross-site preflight gets no permission.
  const pre = await raw(site, { method: 'OPTIONS', path: '/api/v1/commands/ospeli_beds_board', headers: { Origin: 'http://other-site.example', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization' } });
  assert.equal(pre.status, 401);
  assert.equal(pre.headers['access-control-allow-origin'], undefined);
  assert.equal(pre.headers['access-control-allow-headers'], undefined);
});

// A certificate for 127.0.0.1 made for this test run only, with the openssl program.
function testCertificate(name) {
  const key = join(dir, `${name}-key.pem`); const cert = join(dir, `${name}-cert.pem`);
  const made = spawnSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', key, '-out', cert, '-days', '2', '-subj', '/CN=ospeli-test', '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost'], { encoding: 'utf8' });
  return made.status === 0 && existsSync(cert) ? { cert: readFileSync(cert), key: readFileSync(key), certFile: cert, keyFile: key } : null;
}
const haveOpenssl = spawnSync('openssl', ['version']).status === 0;

test('https with the site\'s own certificate: plain http is not answered, the device cookie is Secure, a plain-http page cannot make a device act', { skip: haveOpenssl ? false : 'the openssl program is not on this computer' }, async () => {
  const pem = testCertificate('site');
  assert.ok(pem, 'a test certificate was made');
  const site = await start({ tls: { cert: pem.cert, key: pem.key } });
  assert.match(site.url, /^https:\/\/127\.0\.0\.1:\d+$/);
  assert.match(site.appUrl, /^https:/);
  const ca = pem.cert;

  // The certificate is checked, and the answer arrives over https.
  const health = await raw(site, { path: '/api/v1/health', ca });
  assert.equal(health.status, 200);
  assert.equal(health.json.ok, true);
  // The same port spoken to in plain http: no answer with data, ever.
  const plain = await raw(site, { path: '/api/v1/health', ca, plain: true });
  assert.ok(plain.status === 0 || plain.status >= 400, `plain http got ${plain.status}`);
  assert.ok(!plain.text || !/ospeli-site-server/.test(plain.text));
  // A caller that does not trust this certificate does not connect.
  const other = testCertificate('other');
  const wrongCa = await raw(site, { path: '/api/v1/health', ca: other.cert });
  assert.equal(wrongCa.status, 0);
  // Old protocol versions are refused.
  const old = await new Promise((done) => {
    const u = new URL(site.url);
    const req = httpsRequest({ host: u.hostname, port: u.port, path: '/api/v1/health', ca, minVersion: 'TLSv1', maxVersion: 'TLSv1.1' }, (res) => { res.resume(); done(res.statusCode); });
    req.on('error', () => done(0)); req.end();
  });
  assert.equal(old, 0, 'TLS 1.0 and 1.1 are not accepted');

  // A device connects: its cookie is HttpOnly, SameSite=Strict and now Secure.
  const code = await deviceCode(site);
  // A page that was served over plain http (same host and port in its Origin) is not this server's page.
  const fromHttp = await raw(site, { method: 'POST', path: '/api/v1/devices/pair', ca, headers: { 'Content-Type': 'application/json', Origin: site.url.replace('https:', 'http:') }, body: { code } });
  assert.equal(fromHttp.status, 403);
  const pair = await raw(site, { method: 'POST', path: '/api/v1/devices/pair', ca, headers: { 'Content-Type': 'application/json', Origin: site.url }, body: { code } });
  assert.equal(pair.status, 200, pair.text);
  const setCookie = String(pair.headers['set-cookie']);
  assert.match(setCookie, /; HttpOnly; SameSite=Strict; Max-Age=\d+; Secure$/);
  const cookie = setCookie.split(';')[0];
  const session = await raw(site, { path: '/api/v1/session', ca, headers: { Cookie: cookie } });
  assert.equal(session.status, 200);
  assert.match(String(session.headers['set-cookie']), /; Secure$/, 'the renewed cookie is Secure too');
  const stop = await raw(site, { method: 'POST', path: '/api/v1/commands/ospeli_agents_stop_all', ca, headers: { Cookie: cookie, 'Content-Type': 'application/json', Origin: site.url.replace('https:', 'http:') }, body: { input: {} } });
  assert.equal(stop.status, 403, 'the plain-http page is refused');
  const ok = await raw(site, { method: 'POST', path: '/api/v1/commands/ospeli_agents_stop_all', ca, headers: { Cookie: cookie, 'Content-Type': 'application/json', Origin: site.url }, body: { input: {} } });
  assert.equal(ok.status, 200, ok.text);

  // The window says https and drops the "unencrypted" warning only when that is true.
  const shared = await start({ host: '0.0.0.0', tls: { cert: pem.cert, key: pem.key } });
  const banner = await shared.banner();
  assert.match(banner, /Address for other computers here: https:\/\//);
  assert.match(banner, /uses https with the certificate you gave/);
  assert.ok(!/unencrypted|not encrypted/.test(banner));
  const sharedPlain = await start({ host: '0.0.0.0' });
  assert.match(await sharedPlain.banner(), /travel unencrypted/);

  // A key that does not belong to the certificate, or one file without the other: a plain refusal to start.
  await assert.rejects(startServer({ file: join(dir, 'bad-pair.db'), port: 0, end: END, tls: { cert: pem.cert, key: other.key } }), StartError);
  await assert.rejects(startServer({ file: join(dir, 'half.db'), port: 0, end: END, tls: { cert: pem.cert } }), StartError);
  // After a refused start the data file is free again (not left locked).
  sites.push(await startServer({ file: join(dir, 'bad-pair.db'), port: 0, end: END }));

  // The start command: one file without the other, and a file that is not there.
  const entry = fileURLToPath(new URL('../../tools/ospeli-server/server.mjs', import.meta.url));
  const half = spawnSync(process.execPath, [entry, '--tls-cert', pem.certFile, '--data', join(dir, 'cli.db')], { encoding: 'utf8' });
  assert.equal(half.status, 1); assert.match(half.stderr, /give both files: --tls-cert FILE --tls-key FILE/);
  const missing = spawnSync(process.execPath, [entry, '--tls-cert', pem.certFile, '--tls-key', join(dir, 'no-such-key.pem'), '--data', join(dir, 'cli.db')], { encoding: 'utf8' });
  assert.equal(missing.status, 1); assert.match(missing.stderr, /could not read the certificate or key file/);
  assert.ok(!/at .*\.mjs:\d+|BEGIN [A-Z ]*PRIVATE KEY/.test(half.stderr + missing.stderr + half.stdout + missing.stdout), 'no stack trace and no key material in the window');
});

test('without a certificate nothing changes: http on this computer only, and the cookie is not marked Secure (it would never be sent)', async () => {
  const site = await start();
  assert.match(site.url, /^http:\/\/127\.0\.0\.1:\d+$/);
  const code = await deviceCode(site);
  const pair = await raw(site, { method: 'POST', path: '/api/v1/devices/pair', headers: { 'Content-Type': 'application/json', Origin: site.url }, body: { code } });
  assert.equal(pair.status, 200);
  assert.match(String(pair.headers['set-cookie']), /; HttpOnly; SameSite=Strict; Max-Age=\d+$/);
  // An https Origin on a plain-http server is not this server's page either.
  const code2 = await deviceCode(site).catch(() => null);
  const cross = await raw(site, { method: 'POST', path: '/api/v1/devices/pair', headers: { 'Content-Type': 'application/json', Origin: site.url.replace('http:', 'https:') }, body: { code: code2 || 'AAAA-AAAA' } });
  assert.equal(cross.status, 403);
});

test('the command registry is closed: every input refuses unknown fields, and every text and list has a limit', async () => {
  const problems = [];
  const walk = (s, where) => {
    if (!s || typeof s !== 'object') { problems.push(`${where}: no schema`); return; }
    const types = [].concat(s.type || []);
    if (!types.length && !s.enum && !('const' in s)) problems.push(`${where}: no type`);
    if (types.includes('object')) {
      if (s.additionalProperties !== false && typeof s.additionalProperties !== 'object') problems.push(`${where}: unknown fields are not refused`);
      for (const [k, v] of Object.entries(s.properties || {})) walk(v, `${where}.${k}`);
      if (typeof s.additionalProperties === 'object') walk(s.additionalProperties, `${where}.*`);
    }
    if (types.includes('string') && s.maxLength == null && !s.enum && !('const' in s) && !s.format && !(s.pattern && /^\^.*(\{\d+(,\d+)?\}|\])\$$/.test(s.pattern) && !/[*+]\)?\$$|[*+][^{]*\$$/.test(s.pattern.replace(/\[[^\]]*\]/g, 'x')))) problems.push(`${where}: text with no limit`);
    if (types.includes('array')) { if (s.maxItems == null) problems.push(`${where}: a list with no limit`); walk(s.items, `${where}[]`); }
  };
  // The check itself is checked first: an open, unlimited input must be reported.
  walk({ type: 'object', properties: { note: { type: 'string' }, tags: { type: 'array', items: { type: 'string', pattern: '^[a-z]+$' } }, any: {} } }, 'bad');
  assert.deepEqual(problems, ['bad: unknown fields are not refused', 'bad.note: text with no limit', 'bad.tags: a list with no limit', 'bad.tags[]: text with no limit', 'bad.any: no type']);
  problems.length = 0;
  const commands = listCommands();
  assert.ok(commands.length >= 44);
  for (const c of commands) walk(commandByName(c.name).input, c.name);
  assert.deepEqual(problems, []);

  // Over HTTP, as an agent: fields the command does not know are refused and recorded, never passed on.
  const site = await start();
  for (const line of ['setup agent', 'night-helper', '2', 'all']) await site.consoleLine(line);
  const key = /osk_[0-9a-f]{8}_[A-Za-z0-9_-]{32}/.exec(await site.consoleLine(''))[0];
  const post = (name, body) => raw(site, { method: 'POST', path: `/api/v1/commands/${name}`, headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body });
  for (const body of ['{"input":{"__proto__":{"allowed":true}}}', '{"input":{"constructor":{"prototype":{"allowed":true}}}}', '{"input":{"wardId":"ward-a1","role":"coo"}}', '{"input":{"wardId":{"$ne":""}}}', `{"input":{"wardId":"${'a'.repeat(5000)}"}}`, '{"input":{"wardId":"ward-a1\'; DROP TABLE audit;--"}}']) {
    const r = await post('ospeli_beds_board', body);
    assert.equal(r.status, 400, body.slice(0, 60));
    assert.equal(r.json.error.code, 'invalid-input');
  }
  for (const name of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) assert.equal((await post(name, '{}')).status, 404, name);
  assert.equal({}.allowed, undefined, 'nothing reached the prototype every object shares');
  const trail = await site.core.auditLog();
  assert.ok(trail.some((e) => e.action === 'agent.refused' && e.detail.code === 'invalid-input'), 'the refusals are in the trail');
  assert.ok(!JSON.stringify(trail).includes('DROP TABLE'), 'what the caller typed is not stored');
  assert.equal((await site.core.verifyAudit()).ok, true);
  assert.equal((await site.core.listEntities('ward')).length > 0, true, 'the data is still there');
});
