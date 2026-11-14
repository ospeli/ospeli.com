// Devices on the site server (backlog A8, second part): a phone or laptop a person connected at
// the server's console with a one-time code shows the site's data and sends changes to it.
// These tests are the acceptance picture and the attack tests for the door:
// - only a device connected with a code is recorded as a person (via "app", with its label);
//   an agent key never is, and no body, header or query can claim it (ospeli/ospeli#64);
// - the code works once, for 30 minutes, and is cancelled after five wrong tries;
// - a removed or idle device is shut out; a page on another site cannot make a device act;
// - what a device is sent holds no key, token or hash; the app's files cannot be used to read
//   other files on the computer.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const emit = process.emitWarning;
process.emitWarning = (w, ...rest) => (/SQLite/i.test(String(w?.message || w)) ? undefined : emit.call(process, w, ...rest));
const { startServer, SITE_MARKER } = await import('../../tools/ospeli-server/site-server.mjs');
const { MirrorAdapter, SiteLink, SITE_META, READ_ONLY, OFFLINE } = await import('../../web/app/core/site.js');
const { MemoryAdapter } = await import('../../web/app/core/db.js');
const { Core } = await import('../../web/app/core/core.js');
const { verifyChain } = await import('../../web/app/core/audit.js');

const END = '2026-11-08T12:00:00.000Z';
const dir = mkdtempSync(join(tmpdir(), 'ospeli-devices-'));
const sites = [];
after(async () => { for (const s of sites) await s.close().catch(() => {}); rmSync(dir, { recursive: true, force: true }); });

let n = 0;
async function start(opts = {}) {
  const t = { now: Date.parse(END) };
  const site = await startServer({ file: join(dir, `site-${++n}.db`), port: 0, end: END, clock: () => new Date(t.now += 1000), ...opts });
  sites.push(site);
  const call = async (method, path, { cookie, key, body, origin = site.url, headers = {} } = {}) => {
    const res = await fetch(site.url + path, {
      method, redirect: 'manual',
      headers: { ...(cookie ? { Cookie: cookie } : {}), ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(origin && method !== 'GET' ? { Origin: origin } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch { /* a file, not JSON */ }
    return { status: res.status, headers: res.headers, json, text };
  };
  return { site, call, t, audit: () => site.core.auditLog() };
}
// "add device" as a person types it; returns the code as printed.
async function addDevice(site, { label = 'front desk tablet', role = 2 } = {}) {
  assert.match(await site.consoleLine('add device'), /^1 of 2\./);
  assert.match(await site.consoleLine(label), /^2 of 2\./);
  const out = await site.consoleLine(String(role));
  const code = /^ {4}([A-Z0-9]{4}-[A-Z0-9]{4})$/m.exec(out)?.[1];
  assert.ok(code, out);
  return { code, out };
}
async function connect(s, opts) {
  const { code } = await addDevice(s.site, opts);
  const r = await s.call('POST', '/api/v1/devices/pair', { body: { code } });
  assert.equal(r.status, 200, r.text);
  return { cookie: r.headers.get('set-cookie').split(';')[0], setCookie: r.headers.get('set-cookie'), device: r.json.device };
}
async function letBotIn(site) {
  for (const line of ['setup agent', 'night-helper', '2', 'all']) await site.consoleLine(line);
  return /osk_[0-9a-f]{8}_[A-Za-z0-9_-]{32}/.exec(await site.consoleLine(''))[0];
}

test('a person connects a device with a code from the console; it is then a person in that role, via app, with the device label', async () => {
  const s = await start();
  const { code, out } = await addDevice(s.site);
  assert.match(out, /Code for "front desk tablet" \(Patient flow coordinator\)/);
  assert.match(out, /works once, for 30 minutes/);
  assert.match(out, /\/app\/$/m, 'the address to open is printed');
  // Lower case and no dash is the same code.
  const r = await s.call('POST', '/api/v1/devices/pair', { body: { code: code.toLowerCase().replace('-', ' ') } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.device, { label: 'front desk tablet', role: 'bed-manager', roleName: 'Patient flow coordinator' });
  const setCookie = r.headers.get('set-cookie');
  assert.match(setCookie, /^ospeli_device=osd_[0-9a-f]{8}_[A-Za-z0-9_-]{43}; Path=\/api\/v1; HttpOnly; SameSite=Strict; Max-Age=2592000$/);
  assert.ok(!r.text.includes('osd_'), 'the token is in the cookie only, never in the body a script can read');
  const cookie = setCookie.split(';')[0];
  const me = await s.call('GET', '/api/v1/session', { cookie });
  assert.equal(me.status, 200);
  assert.equal(me.json.device.role, 'bed-manager');
  // The server keeps the token's hash only.
  const stored = await s.site.core.getMeta('devices');
  assert.equal(stored.length, 1);
  assert.ok(!JSON.stringify(stored).includes(cookie.split('=')[1]));
  assert.match(stored[0].hash, /^[0-9a-f]{64}$/);
  const log = await s.audit();
  const issued = log.find((e) => e.action === 'devices.code-issued');
  assert.deepEqual({ type: issued.actorType, via: issued.via, detail: issued.detail }, { type: 'human', via: 'console', detail: { device: 'front desk tablet', role: 'bed-manager' } });
  const joined = log.find((e) => e.action === 'devices.connected');
  assert.deepEqual({ type: joined.actorType, role: joined.actorRole, via: joined.via, device: joined.device }, { type: 'human', role: 'bed-manager', via: 'app', device: 'front desk tablet' });
  assert.ok(!JSON.stringify(log).includes(code.replace('-', '')), 'the code is not in the trail');
  assert.deepEqual(await verifyChain(log), { ok: true });
  assert.match(await s.site.consoleLine('devices'), /1 {2}front desk tablet · Patient flow coordinator · last used/);
  assert.match(await s.site.consoleLine('audit'), /person, Patient flow coordinator \(on front desk tablet\) {2}devices\.connected/);
});

test('the code: works once, 30 minutes, cancelled after five wrong tries, one at a time; tries are limited per address', async () => {
  const s = await start();
  const pair = (code, extra) => s.call('POST', '/api/v1/devices/pair', { body: { code }, ...extra });
  // No code was asked for.
  let r = await pair('ABCD-2345');
  assert.equal(r.status, 410); assert.equal(r.json.error.code, 'code-old');
  assert.match(r.json.error.message, /^That code is too old\. Ask for a new one\.$/);
  // Single use.
  const a = await addDevice(s.site);
  assert.equal((await pair(a.code)).status, 200);
  assert.equal((await pair(a.code)).status, 410);
  // A new code replaces the one before it.
  const b = await addDevice(s.site, { label: 'ward phone' });
  const c = await addDevice(s.site, { label: 'stores laptop' });
  r = await pair(b.code);
  assert.equal(r.status, 403); assert.equal(r.json.error.code, 'code-wrong');
  assert.match(r.json.error.message, /^That code is not right\. Check it and try again\.$/);
  // Too old.
  s.t.now += 31 * 60000;
  assert.equal((await pair(c.code)).status, 410);
  // Five wrong tries cancel the code, so the right one no longer works either.
  const d = await addDevice(s.site, { label: 'stores laptop' });
  for (let i = 0; i < 5; i += 1) assert.equal((await pair('ZZZZ-ZZZZ')).status, 403);
  assert.equal((await pair(d.code)).status, 410);
  // More than ten tries a minute from one address are turned away before the code is looked at.
  const e = await addDevice(s.site, { label: 'stores laptop' });
  s.t.now = Math.ceil(s.t.now / 60000) * 60000; // the start of a minute on the server's clock
  for (let i = 0; i < 4; i += 1) assert.equal((await pair('ZZZZ-ZZZZ')).status, 403);
  for (let i = 0; i < 6; i += 1) await pair('', { body: {} });
  r = await pair(e.code);
  assert.equal(r.status, 429, 'this was the eleventh try in the same minute');
  assert.match(r.json.error.message, /^Too many tries\. Wait a minute, then try again\.$/);
  s.t.now += 61000;
  assert.equal((await pair(e.code)).status, 200, 'the turned-away try did not use up the code');
  assert.equal((await s.site.core.getMeta('devices')).length, 2);
  // Bad bodies.
  for (const body of [{}, { code: 7 }, { code: 'ABCD2345', role: 'coo' }, '[]', 'not json']) {
    r = await pair(undefined, { body });
    assert.equal(r.status, 400, JSON.stringify(body));
  }
});

test('device labels say where a device is, never whose it is; labels are unique; Enter gives a plain label', async () => {
  const s = await start();
  await s.site.consoleLine('add device');
  assert.match(await s.site.consoleLine('Dr Khan phone'), /not whose it is/);
  assert.match(await s.site.consoleLine(''), /^2 of 2\./);
  assert.match(await s.site.consoleLine('1'), /Code for "Device 1" \(Ward nurse\)/);
  await addDevice(s.site, { label: 'ward phone' }).then(({ code }) => s.call('POST', '/api/v1/devices/pair', { body: { code } }));
  await s.site.consoleLine('add device');
  assert.match(await s.site.consoleLine('Ward Phone'), /already a device called Ward Phone/);
  assert.equal(await s.site.consoleLine('cancel'), 'Cancelled. Nothing was changed.');
  assert.match(await s.site.consoleLine('remove device'), /remove device 1/);
});

test('what a device does is recorded as a person via app; it can accept an agent\'s proposal; its role is the one set at the console', async () => {
  const s = await start();
  const key = await letBotIn(s.site);
  const { cookie } = await connect(s);
  const free = (await s.call('POST', '/api/v1/commands/ospeli_beds_find_free', { key, body: { input: {} }, origin: null })).json.result;
  const pick = free.waiting[0]; const bed = free.beds[0];
  const prop = await s.call('POST', '/api/v1/commands/ospeli_beds_allocate', { key, body: { input: { bedId: bed.bedId, encounter: pick.encounter } }, origin: null });
  assert.equal(prop.json.result.status, 'proposed', JSON.stringify(prop.json));
  const before = await s.site.core.eventCount();
  // The device reads the queue and says yes.
  const acc = await s.call('POST', '/api/v1/commands/ospeli_proposals_accept', { cookie, body: { input: { id: prop.json.result.proposal.id } } });
  assert.equal(acc.status, 200, acc.text);
  assert.equal(acc.json.result.status, 'accepted');
  assert.equal(await s.site.core.eventCount(), before + 1);
  const entry = (await s.audit()).find((e) => e.action === 'agent.proposal-accepted');
  assert.deepEqual({ type: entry.actorType, role: entry.actorRole, via: entry.via, device: entry.device, agent: entry.agent }, { type: 'human', role: 'bed-manager', via: 'app', device: 'front desk tablet', agent: undefined });
  // The role comes from the device's entry. A patient flow coordinator's device cannot change agent access.
  const no = await s.call('POST', '/api/v1/commands/ospeli_agents_set_access', { cookie, body: { input: { allowed: false, wards: {} } } });
  assert.equal(no.status, 403);
  assert.match(no.json.error.message, /Patient flow coordinator cannot run/);
  // A body that says who is acting is refused, not ignored.
  for (const extra of [{ role: 'coo' }, { actor: { type: 'human', role: 'coo' } }, { device: 'other' }, { dryRun: true }]) {
    const r = await s.call('POST', '/api/v1/commands/ospeli_beds_board', { cookie, body: { input: {}, ...extra } });
    assert.equal(r.status, 400, JSON.stringify(extra));
  }
  assert.deepEqual(await verifyChain(await s.audit()), { ok: true });
});

test('attack tests: no cookie, a made-up cookie, a removed device, an idle device, another site\'s page, a key and a cookie together', async () => {
  const s = await start();
  const key = await letBotIn(s.site);
  const { cookie } = await connect(s);
  const board = (extra) => s.call('POST', '/api/v1/commands/ospeli_beds_board', { body: { input: {} }, ...extra });
  assert.equal((await board({ cookie })).status, 200);
  // No cookie: these addresses give nothing.
  for (const path of ['/api/v1/session', '/api/v1/sync']) {
    const r = await s.call('GET', path);
    assert.equal(r.status, 401, path); assert.equal(r.json.error.code, 'not-connected');
    assert.ok(!('entities' in r.json));
  }
  // A cookie of the right shape that this server never gave out, and another device's id with a made-up secret.
  const id = cookie.split('_')[2];
  for (const fake of [`ospeli_device=osd_00000000_${'A'.repeat(43)}`, `ospeli_device=osd_${id}_${'A'.repeat(43)}`, 'ospeli_device=1', 'ospeli_device=osk_x']) {
    assert.equal((await s.call('GET', '/api/v1/sync', { cookie: fake })).status, 401, fake);
    assert.equal((await board({ cookie: fake })).status, 401, fake);
  }
  // An agent key cannot use a device's addresses, and a key with a cookie is refused: never both.
  for (const path of ['/api/v1/session', '/api/v1/sync']) assert.equal((await s.call('GET', path, { key })).status, 400, path);
  assert.equal((await s.call('POST', '/api/v1/devices/pair', { key, body: { code: 'ABCD-2345' } })).status, 400);
  const both = await board({ cookie, key });
  assert.equal(both.status, 400);
  assert.match(both.json.error.message, /an agent key and a device cookie/);
  // An agent key alone is still an agent, and people-only commands stay refused for it (#64).
  const agentTry = await s.call('POST', '/api/v1/commands/ospeli_proposals_accept', { key, body: { input: { id: 'prop-0001' } }, origin: null });
  assert.equal(agentTry.status, 403);
  // A page on another site (or no Origin at all) cannot make the device act or connect one.
  for (const origin of ['http://evil.example', 'null', null, `${s.site.url}.evil.example`]) {
    const r = await board({ cookie, origin });
    assert.equal(r.status, 403, String(origin));
    assert.match(r.json.error.message, /did not come from the Ospeli app on this server/);
  }
  const { code } = await addDevice(s.site, { label: 'ward phone' });
  assert.equal((await s.call('POST', '/api/v1/devices/pair', { body: { code }, origin: 'http://evil.example' })).status, 403);
  assert.equal((await s.call('POST', '/api/v1/devices/pair', { body: { code } })).status, 200, 'the refused try did not use up the code');
  // The body must be JSON (a plain form post from another page is not).
  assert.equal((await board({ cookie, body: 'input=1', headers: { 'Content-Type': 'text/plain' } })).status, 400);
  // Unused for more than 30 days: shut out.
  const idle = await start();
  const dev = await connect(idle);
  idle.t.now += 31 * 864e5;
  const late = await idle.call('GET', '/api/v1/session', { cookie: dev.cookie });
  assert.equal(late.status, 401);
  assert.match(late.headers.get('set-cookie'), /Max-Age=0/, 'the browser is told to drop the cookie');
  // Removed at the console: shut out on the next call.
  assert.match(await s.site.consoleLine('remove device 1'), /"front desk tablet" is disconnected/);
  assert.equal((await board({ cookie })).status, 401);
  assert.equal((await s.call('GET', '/api/v1/sync', { cookie })).status, 401);
  assert.ok((await s.audit()).some((e) => e.action === 'devices.removed' && e.via === 'console' && e.detail.device === 'front desk tablet'));
  // Nothing in the trail was recorded as a person over HTTP except through a connected device.
  for (const e of await s.audit()) if (e.actorType === 'human') assert.ok(e.via === 'console' || (e.via === 'app' && e.device), `${e.seq} ${e.action}`);
});

test('what a device is sent: the site\'s data and no key, token or hash; then only what changed; a new history starts again', async () => {
  const s = await start();
  const key = await letBotIn(s.site);
  const { cookie } = await connect(s);
  const sync = (q = '') => s.call('GET', `/api/v1/sync${q}`, { cookie });
  const first = (await sync()).json;
  assert.equal(first.full, true);
  assert.equal(first.entities.length, (await s.site.core.listEntities()).length);
  assert.equal(first.events.length, await s.site.core.eventCount());
  assert.equal(first.audit.length, (await s.audit()).length);
  assert.deepEqual(Object.keys(first.meta).sort(), [...SITE_META].sort());
  const sent = JSON.stringify(first);
  assert.ok(!sent.includes(key) && !sent.includes(key.split('_')[2]), 'no agent key');
  assert.ok(!sent.includes(cookie.split('=')[1]), 'no device token');
  for (const secret of [...(await s.site.core.getMeta('agent-keys')), ...(await s.site.core.getMeta('devices'))]) assert.ok(!sent.includes(secret.hash), 'no hash of a key or token');
  const q = (x) => `?epoch=${x.epoch}&rev=${x.rev}&events=${x.events.at(-1)?.seq ?? 0}&audit=${x.audit.at(-1)?.seq ?? 0}`;
  // An idempotency hash on a proposal stays on the server.
  await s.call('POST', '/api/v1/commands/ospeli_workorders_report_fault', { key, origin: null, headers: { 'Idempotency-Key': 'abcdefgh-1' }, body: { input: { assetId: 'asset-a1-sink-1', fault: 'Tap leaking', priority: 'high' } } });
  const second = (await sync(`?epoch=${first.epoch}&rev=${first.rev}&events=${first.events.at(-1).seq}&audit=${first.audit.at(-1).seq}`)).json;
  assert.equal(second.full, false);
  assert.equal(second.events.length, 0);
  assert.ok(second.audit.length >= 1 && second.audit.every((e) => e.seq > first.audit.at(-1).seq), 'only the new entries');
  assert.equal(second.meta['agent-proposals'].length, 1);
  assert.ok(!('request' in second.meta['agent-proposals'][0]));
  assert.ok((await s.site.core.proposals())[0].request, 'the server still has it');
  const third = (await sync(`?epoch=${second.epoch}&rev=${second.rev}&events=0&audit=0`)).json;
  assert.deepEqual({ unchanged: third.unchanged, keys: Object.keys(third).sort() }, { unchanged: true, keys: ['epoch', 'ok', 'rev', 'synthetic', 'unchanged'] });
  // A device that says it has another history is sent everything.
  const other = (await sync('?epoch=someone-else.0&rev=3&events=999999&audit=999999')).json;
  assert.equal(other.full, true);
  assert.equal(other.events.length, first.events.length);
  void q;
});

test('the device\'s copy: reads work with no connection, the core cannot change it, a change with no connection is refused and not kept', async () => {
  const s = await start();
  const { cookie } = await connect(s);
  let online = true;
  const fetchAs = (url, init = {}) => {
    if (!online) return Promise.reject(new TypeError('Failed to fetch'));
    return fetch(new URL(url, `${s.site.url}/app/`), { ...init, headers: { ...(init.headers || {}), Cookie: cookie, ...(init.method === 'POST' ? { Origin: s.site.url } : {}) } });
  };
  const inner = new MemoryAdapter();
  const mirror = new MirrorAdapter(inner);
  const link = new SiteLink({ mirror, fetch: fetchAs });
  const states = [];
  link.onState((st) => states.push(st.connected));
  assert.deepEqual((await link.session()).device.role, 'bed-manager');
  const core = await Core.open({ adapter: mirror });
  link.core = core;
  assert.equal(await link.pull(), true);
  assert.equal(await core.eventCount(), await s.site.core.eventCount());
  assert.deepEqual(await core.verifyAudit(), { ok: true });
  // The copy is read-only for the core: nothing can be written to the site's data from here.
  await assert.rejects(core.appendEvent({ type: 'bed.vacated', subject: 'ward-a1-bed-01', actorRole: 'bed-manager' }), new RegExp(READ_ONLY.slice(0, 30)));
  await assert.rejects(core.record('bed-manager', 'x.y'), /saved on the site/);
  await assert.rejects(core.reset('bed-manager'), /saved on the site/);
  await assert.rejects(core.setMeta('agents', { allowed: true }), /saved on the site/);
  await core.setMeta('my-ward', 'ward-a1'); // a setting of this device alone is fine
  // A read runs on the copy; a change goes to the server and comes back in the copy.
  const board = await link.run('ospeli_beds_board', { format: 'short' }, 'bed-manager');
  assert.ok(board.wards.length >= 6);
  const free = await link.run('ospeli_beds_find_free', {}, 'bed-manager');
  const before = await core.eventCount();
  const out = await link.run('ospeli_beds_allocate', { bedId: free.beds[0].bedId, encounter: free.waiting[0].encounter }, 'bed-manager');
  assert.ok(out);
  assert.equal(await core.eventCount(), before + 1, 'the copy has the new event');
  assert.equal(await s.site.core.eventCount(), before + 1);
  assert.equal((await core.events()).at(-1).actorRole, 'bed-manager');
  // A refusal from the server arrives with its code and message, as the screens expect.
  await assert.rejects(link.run('ospeli_beds_allocate', { bedId: free.beds[0].bedId, encounter: free.waiting[0].encounter }, 'bed-manager'), (err) => err.name === 'CommandError' && err.code !== 'offline' && err.message.length > 5);
  // No connection: reads still answer from the copy, a change is refused in plain words, nothing is kept for later.
  online = false;
  assert.ok((await link.run('ospeli_beds_board', { format: 'short' }, 'bed-manager')).wards.length >= 6);
  const serverBefore = await s.site.core.eventCount();
  await assert.rejects(link.run('ospeli_beds_allocate', { bedId: free.beds[1].bedId, encounter: free.waiting[1].encounter }, 'bed-manager'), (err) => err.code === 'offline' && err.message === OFFLINE);
  assert.equal(await link.pull(), false);
  online = true;
  assert.equal(await link.pull(), true);
  assert.equal(await s.site.core.eventCount(), serverBefore, 'the refused change was not sent later');
  assert.deepEqual(states.filter((v, i, a) => i === 0 || v !== a[i - 1]), [true, false, true]);
  // Disconnected at the console: the copy is wiped and the device must ask for a code.
  await s.site.consoleLine('remove device 1');
  assert.equal(await link.pull(), false);
  assert.equal(await inner.count('events'), 0);
  assert.equal(await inner.count('entities'), 0);
  assert.equal((await link.session()).needsCode, true);
});

test('the server restarts: a device\'s copy starts again from the server\'s data, and the device stays connected', async () => {
  const file = join(dir, 'restart.db');
  const t = { now: Date.parse(END) };
  const clock = () => new Date(t.now += 1000);
  let site = await startServer({ file, port: 0, end: END, clock });
  await site.consoleLine('add device'); await site.consoleLine('ward phone');
  const code = /^ {4}(\S+)$/m.exec(await site.consoleLine('1'))[1];
  let res = await fetch(`${site.url}/api/v1/devices/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: site.url }, body: JSON.stringify({ code }) });
  const cookie = res.headers.get('set-cookie').split(';')[0];
  const a = await (await fetch(`${site.url}/api/v1/sync`, { headers: { Cookie: cookie } })).json();
  await site.close();
  site = await startServer({ file, port: 0, end: END, clock });
  sites.push(site);
  res = await fetch(`${site.url}/api/v1/sync?epoch=${a.epoch}&rev=${a.rev}&events=${a.events.at(-1).seq}&audit=${a.audit.at(-1).seq}`, { headers: { Cookie: cookie } });
  assert.equal(res.status, 200, 'still connected after a restart');
  const b = await res.json();
  assert.notEqual(b.epoch, a.epoch);
  assert.equal(b.full, true);
  assert.equal(b.events.length, a.events.length);
  // A code asked for before the restart is gone (codes are kept in memory only).
  await site.consoleLine('add device'); await site.consoleLine('desk');
  const code2 = /^ {4}(\S+)$/m.exec(await site.consoleLine('1'))[1];
  await site.close(); sites.pop();
  site = await startServer({ file, port: 0, end: END, clock });
  sites.push(site);
  res = await fetch(`${site.url}/api/v1/devices/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: site.url }, body: JSON.stringify({ code: code2 }) });
  assert.equal(res.status, 410);
});

test('the app\'s files: served with the site marker and safe headers; nothing outside the app can be read', async () => {
  const s = await start();
  const page = await s.call('GET', '/app/');
  assert.equal(page.status, 200);
  assert.ok(page.text.includes(SITE_MARKER));
  assert.match(page.headers.get('content-type'), /^text\/html/);
  assert.match(page.headers.get('content-security-policy'), /default-src 'self'.*frame-ancestors 'none'/);
  assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
  assert.equal((await s.call('GET', '/')).status, 302);
  for (const ok of ['/app/app.js', '/app/core/site.js', '/app/sw.js', '/app/fonts/nunito-latin-400-normal.woff2', '/brand/ospeli_horizontal_color.svg', '/favicon.svg', '/app/api/commands.json']) {
    assert.equal((await s.call('GET', ok)).status, 200, ok);
  }
  // Raw request lines, so the client cannot tidy the path first.
  const { request } = await import('node:http');
  const raw = (path) => new Promise((done, bad) => {
    const u = new URL(s.site.url);
    const req = request({ host: u.hostname, port: u.port, path, method: 'GET' }, (res) => { let body = ''; res.on('data', (c) => { body += c; }); res.on('end', () => done({ status: res.statusCode, body })); });
    req.on('error', bad); req.end();
  });
  for (const path of ['/app/../../package.json', '/app/..%2f..%2fpackage.json', '/app/%2e%2e/%2e%2e/package.json', '/app/..\\..\\package.json', '/../tools/ospeli-server/data/site.db', '/app/%00', '/index.html', '/llms.txt', '/demo/', '/app/.git/config', '//etc/passwd', '/app/core/%2e%2e/%2e%2e/%2e%2e/tools/ospeli-server/server.mjs', '/brand/../../tools/ospeli-server/README.md']) {
    const r = await raw(path);
    assert.ok([400, 404].includes(r.status), `${path} gave ${r.status}`);
    assert.ok(!/"name": "ospeli-web"|node:sqlite|SQLite format/.test(r.body), path);
  }
  assert.equal((await s.call('POST', '/app/')).status, 405);
  // The public demo's page has no marker: the marker is added by the server, not kept in the file.
  const { readFileSync } = await import('node:fs');
  assert.ok(!readFileSync(new URL('../../web/app/index.html', import.meta.url), 'utf8').includes('ospeli-site-server'));
});
