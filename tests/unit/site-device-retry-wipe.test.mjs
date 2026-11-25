// Issue #109 (weekly audit, 15 Nov): a connected device (web/app/core/site.js) when the connection
// drops at a bad moment, and what stays on a device after it is removed.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const emit = process.emitWarning;
process.emitWarning = (w, ...rest) => (/SQLite/i.test(String(w?.message || w)) ? undefined : emit.call(process, w, ...rest));
const { startServer } = await import('../../tools/ospeli-server/site-server.mjs');
const { MirrorAdapter, SiteLink } = await import('../../web/app/core/site.js');
const { MemoryAdapter } = await import('../../web/app/core/db.js');
const { Core } = await import('../../web/app/core/core.js');

const END = '2026-11-08T12:00:00.000Z';
const dir = mkdtempSync(join(tmpdir(), 'ospeli-audit-site-'));
const sites = [];
after(async () => { for (const s of sites) await s.close().catch(() => {}); rmSync(dir, { recursive: true, force: true }); });

let n = 0;
// A site server with one connected device, and that device's link with a line that can drop.
async function device() {
  const t = { now: Date.parse(END) };
  const site = await startServer({ file: join(dir, `site-${++n}.db`), port: 0, end: END, clock: () => new Date(t.now += 1000) });
  sites.push(site);
  await site.consoleLine('add device'); await site.consoleLine('ward phone');
  const code = /^ {4}([A-Z0-9]{4}-[A-Z0-9]{4})$/m.exec(await site.consoleLine('2'))[1];
  const res = await fetch(`${site.url}/api/v1/devices/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: site.url }, body: JSON.stringify({ code }) });
  const cookie = res.headers.get('set-cookie').split(';')[0];
  const line = { dropAnswerOfNextChange: false };
  const fetchAs = async (url, init = {}) => {
    const answer = await fetch(new URL(url, `${site.url}/app/`), { ...init, headers: { ...(init.headers || {}), Cookie: cookie, ...(init.method === 'POST' ? { Origin: site.url } : {}) } });
    if (init.method === 'POST' && line.dropAnswerOfNextChange) {
      // The request reached the server and was carried out; the answer never reached the device.
      line.dropAnswerOfNextChange = false;
      await answer.arrayBuffer();
      throw new TypeError('Failed to fetch');
    }
    return answer;
  };
  const inner = new MemoryAdapter();
  const mirror = new MirrorAdapter(inner);
  const link = new SiteLink({ mirror, fetch: fetchAs });
  const who = await link.session();
  await mirror.put('meta', { id: 'site-device', value: who.device }); // as web/app/app.js does
  link.core = await Core.open({ adapter: mirror });
  assert.equal(await link.pull(), true);
  return { site, link, inner, mirror, line, role: who.device.role };
}

test('a change whose answer is lost on the way back is not made twice when the person tries again', async () => {
  const d = await device();
  const made = await d.link.run('ospeli_maps_create', { from: 'discharge' }, d.role);
  const mapId = made.map?.id || made.mapId || made.id;
  assert.ok(mapId, JSON.stringify(made).slice(0, 200));
  const step = { mapId, version: 'today', name: 'Audit step', role: 'Housekeeping', wait: 30, work: 20 };
  const steps = async () => JSON.stringify(await d.site.core.getMeta('process-maps')).split('"Audit step"').length - 1;
  assert.equal(await steps(), 0);
  d.line.dropAnswerOfNextChange = true;
  const first = await d.link.run('ospeli_maps_step_add', step, d.role).then(() => null, (e) => e);
  // What the person is told, and what they then do: "Not saved … Try again", so they try again.
  assert.equal(first?.code, 'offline');
  assert.match(first.message, /Try again/);
  await d.link.run('ospeli_maps_step_add', step, d.role);
  assert.equal(await steps(), 1, 'the step is on the site\'s map once');
});

test('a device that is removed keeps nothing from its connection: not its name, role or own settings', async () => {
  const d = await device();
  await d.link.core.setMeta('my-ward', 'ward-a1');
  await d.site.consoleLine('remove device 1');
  assert.equal(await d.link.pull(), false);
  assert.equal(await d.inner.count('events'), 0);
  const left = (await d.inner.getAll('meta')).filter((r) => r.value !== null && r.value !== undefined).map((r) => r.id);
  assert.deepEqual(left, [], 'still on the device after it was removed');
});

test('the server answers a change sent again with the same key from memory, and only for the same device, change and input', async () => {
  const d = await device();
  const made = await d.link.run('ospeli_maps_create', { from: 'discharge' }, d.role);
  const mapId = made.map?.id || made.mapId || made.id;
  const cookie = d.link.fetch; // the device's own line (carries its cookie)
  const send = (input, key) => cookie('../api/v1/commands/ospeli_maps_step_add', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) }, body: JSON.stringify({ input }) });
  const steps = async (name) => JSON.stringify(await d.site.core.getMeta('process-maps')).split(`"${name}"`).length - 1;
  const step = { mapId, version: 'today', name: 'Key step', role: 'Housekeeping', wait: 30, work: 20 };
  const one = await send(step, 'retry-key-0001');
  assert.equal(one.status, 200);
  assert.equal(one.headers.get('idempotent-replay'), null);
  const two = await send(step, 'retry-key-0001');
  assert.equal(two.status, 200);
  assert.equal(two.headers.get('idempotent-replay'), 'true');
  assert.deepEqual(await two.json(), await one.json());
  assert.equal(await steps('Key step'), 1);
  // Another input under the same key is a new change, carried out.
  assert.equal((await send({ ...step, name: 'Other step' }, 'retry-key-0001')).status, 200);
  assert.equal(await steps('Other step'), 1);
  // No key: carried out each time, as before.
  await send({ ...step, name: 'Plain step' }); await send({ ...step, name: 'Plain step' });
  assert.equal(await steps('Plain step'), 2);
  // A key the server does not accept is refused and nothing is changed.
  const bad = await send({ ...step, name: 'Bad key step' }, 'no');
  assert.equal(bad.status, 400);
  assert.equal(await steps('Bad key step'), 0);
});
