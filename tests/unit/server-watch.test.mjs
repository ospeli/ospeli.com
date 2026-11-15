// The site server's smaller guards (ospeli/ospeli issue #96, docs/SECURITY.md). Each test tries
// the bad thing against a throwaway server on this computer.
// - a refused call from a device leaves a trace, counted not listed, without what was typed;
// - a device code cancelled by wrong tries from the network is recorded and shown at the console;
// - the per-address limiter cannot be made to forget by a flood of addresses;
// - open connections are capped, in all and per address;
// - a link placed inside the app's folder cannot lead out of it.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect as netConnect } from 'node:net';

const emit = process.emitWarning;
process.emitWarning = (w, ...rest) => (/SQLite/i.test(String(w?.message || w)) ? undefined : emit.call(process, w, ...rest));
const { startServer, Limiter } = await import('../../tools/ospeli-server/site-server.mjs');
const { ROLES } = await import('../../web/app/core/model.js');

const END = '2026-11-08T12:00:00.000Z';
const dir = mkdtempSync(join(tmpdir(), 'ospeli-watch-'));
const sites = [];
after(async () => { for (const s of sites) await s.close().catch(() => {}); rmSync(dir, { recursive: true, force: true }); });

let n = 0;
async function start(opts = {}) {
  const t = { now: Date.parse(END) };
  const said = [];
  const site = await startServer({ file: join(dir, `site-${++n}.db`), port: 0, end: END, clock: () => new Date(t.now += 1), notify: (text) => said.push(text), ...opts });
  sites.push(site);
  const call = async (method, path, { cookie, body, origin = site.url } = {}) => {
    const res = await fetch(site.url + path, {
      method, redirect: 'manual',
      headers: { ...(cookie ? { Cookie: cookie } : {}), ...(origin && method !== 'GET' ? { Origin: origin } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch { /* a file */ }
    return { status: res.status, headers: res.headers, json, text };
  };
  return { site, call, t, said, audit: () => site.core.auditLog() };
}
const roleNumber = (id) => String(ROLES.findIndex((r) => r.id === id) + 1);
async function code(site, label, role) {
  await site.consoleLine('add device'); await site.consoleLine(label);
  return /^ {4}([A-Z0-9]{4}-[A-Z0-9]{4})$/m.exec(await site.consoleLine(roleNumber(role)))[1];
}
async function connect(s, label = 'ward tablet', role = 'ward-nurse') {
  const r = await s.call('POST', '/api/v1/devices/pair', { body: { code: await code(s.site, label, role) } });
  assert.equal(r.status, 200, r.text);
  return r.headers.get('set-cookie').split(';')[0];
}
const refusals = async (s) => (await s.audit()).filter((e) => e.action === 'device.refused');

test('a refused call from a device is in the trail: who, which command and why, once a minute with a count, and never what was typed', async () => {
  const s = await start();
  const cookie = await connect(s);
  // A ward tablet tries to switch agents on.
  const tryIt = () => s.call('POST', '/api/v1/commands/ospeli_agents_set_access', { cookie, body: { input: { allowed: true, wards: {} } } });
  assert.equal((await tryIt()).status, 403);
  let rows = await refusals(s);
  assert.equal(rows.length, 1, 'the refusal is recorded');
  assert.deepEqual(
    { type: rows[0].actorType, role: rows[0].actorRole, via: rows[0].via, device: rows[0].device, detail: rows[0].detail },
    { type: 'human', role: 'ward-nurse', via: 'app', device: 'ward tablet', detail: { command: 'ospeli_agents_set_access', code: 'forbidden', reason: 'forbidden' } },
  );
  // A loop does not flood the trail: five more in the same minute add nothing…
  for (let i = 0; i < 5; i += 1) assert.equal((await tryIt()).status, 403);
  assert.equal((await refusals(s)).length, 1);
  // …and the next entry, a minute later, carries the count.
  s.t.now += 61_000;
  await tryIt();
  rows = await refusals(s);
  assert.equal(rows.length, 2);
  assert.equal(rows[1].detail.repeats.count, 5);

  // What was typed is never stored: a made-up command name, a field the command does not have,
  // text in a body that is not JSON.
  assert.equal((await s.call('POST', '/api/v1/commands/drop_table_patients', { cookie, body: { input: {} } })).status, 404);
  assert.equal((await s.call('POST', '/api/v1/commands/ospeli_beds_board', { cookie, body: { input: { note: 'typed-by-the-caller-1' } } })).status, 400);
  assert.equal((await s.call('POST', '/api/v1/commands/ospeli_beds_board', { cookie, body: 'typed-by-the-caller-2 {' })).status, 400);
  assert.equal((await s.call('POST', '/api/v1/commands/ospeli_beds_board', { cookie, body: { input: {}, actor: { role: 'coo' } } })).status, 400);
  rows = await refusals(s);
  assert.deepEqual(rows.slice(2).map((e) => [e.detail.command, e.detail.code, e.detail.reason]), [
    ['(unknown)', 'unknown-command', 'unknown-command'],
    ['ospeli_beds_board', 'invalid-input', 'invalid-input'],
    ['ospeli_beds_board', 'invalid-input', 'body'],
  ], 'the two bad bodies in one minute are one entry');
  const trail = JSON.stringify(await s.audit());
  for (const typed of ['drop_table_patients', 'typed-by-the-caller-1', 'typed-by-the-caller-2']) assert.ok(!trail.includes(typed), `${typed} is not in the trail`);

  // A page on another site that makes this device's browser call the server.
  assert.equal((await s.call('POST', '/api/v1/commands/ospeli_beds_board', { cookie, origin: 'http://other.example', body: { input: {} } })).status, 403);
  assert.deepEqual((await refusals(s)).at(-1).detail, { command: 'ospeli_beds_board', code: 'forbidden', reason: 'other-site' });

  // An ordinary answer to a person ("no such bed") is not a refusal.
  const before = (await refusals(s)).length;
  const gone = await s.call('POST', '/api/v1/commands/ospeli_beds_take_out_of_service', { cookie, body: { input: { bedId: 'bed-not-here', reason: 'Electrical' } } });
  assert.ok(gone.status >= 400, gone.text);
  assert.equal((await refusals(s)).length, before);
  assert.ok((await s.site.core.auditCheck()).ok);
});

test('a made-up device cookie and a removed device are recorded; a browser with no cookie yet is not', async () => {
  const s = await start();
  const cookie = await connect(s, 'front desk tablet', 'bed-manager');
  assert.equal((await s.call('GET', '/api/v1/session')).status, 401);
  assert.equal((await refusals(s)).length, 0, 'a first visit is not a refusal');
  const fake = `ospeli_device=osd_${'ab'.repeat(4)}_${'A'.repeat(43)}`;
  assert.equal((await s.call('GET', '/api/v1/sync', { cookie: fake })).status, 401);
  assert.equal((await s.call('GET', '/api/v1/sync', { cookie: fake })).status, 401);
  let rows = await refusals(s);
  assert.equal(rows.length, 1, 'counted, not listed');
  assert.deepEqual({ type: rows[0].actorType, detail: rows[0].detail }, { type: 'system', detail: { reason: 'device-unknown' } });
  await s.site.consoleLine('remove device 1');
  assert.equal((await s.call('GET', '/api/v1/sync', { cookie })).status, 401);
  rows = await refusals(s);
  assert.equal(rows.length, 2);
  assert.equal(rows[1].detail.reason, 'device-removed');
  assert.equal(rows[1].detail.device, 'front desk tablet');
  const trail = JSON.stringify(await s.audit());
  assert.ok(!trail.includes('A'.repeat(43)) && !trail.includes(cookie.split('=')[1]), 'no cookie value is in the trail');
});

test('a device code cancelled by five wrong tries is recorded and shown at the console, with where the tries came from', async () => {
  const s = await start();
  const real = await code(s.site, 'pharmacy laptop', 'bed-manager');
  for (let i = 0; i < 4; i += 1) assert.equal((await s.call('POST', '/api/v1/devices/pair', { body: { code: `WRNG-000${i}` } })).status, 403);
  assert.equal(s.said.length, 0);
  assert.equal((await s.audit()).filter((e) => e.action === 'devices.code-cancelled').length, 0);
  assert.equal((await s.call('POST', '/api/v1/devices/pair', { body: { code: 'WRNG-0005' } })).status, 403);
  assert.equal(s.said.length, 1, 'the person at the console is told');
  assert.match(s.said[0], /^The code for "pharmacy laptop" was cancelled after 5 wrong tries; the last came from \S*127\.0\.0\.1\. No device was connected\./);
  const rows = (await s.audit()).filter((e) => e.action === 'devices.code-cancelled');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].actorType, 'system');
  assert.deepEqual({ device: rows[0].detail.device, wrongTries: rows[0].detail.wrongTries }, { device: 'pharmacy laptop', wrongTries: 5 });
  assert.match(rows[0].detail.from, /127\.0\.0\.1$/);
  assert.ok(!JSON.stringify(await s.audit()).includes('WRNG'), 'the wrong codes are not stored');
  // The real code no longer works, and no device was connected.
  assert.equal((await s.call('POST', '/api/v1/devices/pair', { body: { code: real } })).status, 410);
  assert.equal(((await s.site.core.getMeta('devices')) || []).length, 0);
});

test('the limiter cannot be made to forget: a flood of addresses does not reset anyone\'s count', () => {
  let now = Date.parse(END);
  const limiter = new Limiter(2, () => new Date(now), 50);
  assert.ok(limiter.take('first').ok);
  assert.ok(limiter.take('first').ok);
  assert.ok(!limiter.take('first').ok, 'the first address has used its two calls');
  for (let i = 0; i < 200; i += 1) limiter.take(`flood-${i}`);
  assert.ok(!limiter.take('first').ok, 'after the flood the first address is still limited');
  const late = limiter.take('never-seen');
  assert.equal(late.ok, false, 'when the table is full of this minute\'s callers, a new caller waits');
  assert.ok(late.retryAfter >= 1 && late.retryAfter <= 60);
  assert.ok(limiter.seen.size <= 50, 'the table does not grow past its cap');
  // The next minute: everyone starts again, and the table has room.
  now += 60_000;
  assert.ok(limiter.take('first').ok);
  assert.ok(limiter.take('never-seen').ok);
  assert.ok(limiter.seen.size <= 50);
});

// A connection that is opened and left idle, the way a slow-connection flood holds a server.
const hold = (site) => new Promise((done) => {
  const u = new URL(site.url);
  const socket = netConnect({ host: u.hostname, port: Number(u.port) });
  const state = { socket, closed: false };
  socket.on('error', () => {});
  socket.on('close', () => { state.closed = true; });
  socket.on('connect', () => setTimeout(() => done(state), 150));
});
const release = async (held) => { for (const h of held) h.socket.destroy(); await new Promise((r) => setTimeout(r, 150)); };

test('open connections are capped per address: the next one is closed at once, and room comes back when they close', async () => {
  const s = await start({ maxPerAddress: 3 });
  const held = [await hold(s.site), await hold(s.site), await hold(s.site)];
  assert.deepEqual(held.map((h) => h.closed), [false, false, false], 'three idle connections are held open');
  const fourth = await hold(s.site);
  assert.equal(fourth.closed, true, 'the fourth connection from the same address is closed');
  await release(held);
  assert.equal((await s.call('GET', '/api/v1/health')).status, 200, 'the server answers again');
});

test('open connections are capped in all', async () => {
  const s = await start({ maxConnections: 3, maxPerAddress: 100 });
  const held = [await hold(s.site), await hold(s.site), await hold(s.site)];
  assert.deepEqual(held.map((h) => h.closed), [false, false, false]);
  const fourth = await hold(s.site);
  assert.equal(fourth.closed, true, 'the fourth connection is dropped');
  await release(held);
  assert.equal((await s.call('GET', '/api/v1/health')).status, 200);
});

test('a link placed inside the app\'s folder cannot lead out of it', { skip: process.platform === 'win32' ? 'making a link needs special rights on Windows' : false }, async () => {
  const root = join(dir, 'web-root');
  mkdirSync(join(root, 'app'), { recursive: true });
  writeFileSync(join(root, 'app', 'index.html'), '<!doctype html><meta charset="utf-8"><title>test</title>');
  writeFileSync(join(root, 'app', 'notes.txt'), 'a file of the app');
  writeFileSync(join(dir, 'outside.txt'), 'NOT-FOR-THE-NETWORK');
  symlinkSync(join(dir, 'outside.txt'), join(root, 'app', 'leak.txt'));
  symlinkSync(join(root, 'app', 'notes.txt'), join(root, 'app', 'inner.txt'));
  symlinkSync(dir, join(root, 'app', 'up'));
  const s = await start({ webRoot: root });
  assert.equal((await s.call('GET', '/app/notes.txt')).text, 'a file of the app');
  assert.equal((await s.call('GET', '/app/inner.txt')).text, 'a file of the app', 'a link that stays inside the app is fine');
  for (const path of ['/app/leak.txt', '/app/up/outside.txt']) {
    const r = await s.call('GET', path);
    assert.equal(r.status, 404, path);
    assert.ok(!r.text.includes('NOT-FOR-THE-NETWORK'));
  }
});
