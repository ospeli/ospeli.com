// Security and audit, 26 Nov (follow-up to issue #109). A change whose answer was lost keeps its
// key so a retry is not made twice. That key must not outlive the next sync: once the device has
// heard from the server again its copy shows whether the change was made, so the same change tapped
// after that is a new change. Before this test the second change was answered "saved" from the
// server's memory and never made (a second identical step, issue or count silently lost).
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
const dir = mkdtempSync(join(tmpdir(), 'ospeli-audit-second-'));
const sites = [];
after(async () => { for (const s of sites) await s.close().catch(() => {}); rmSync(dir, { recursive: true, force: true }); });

let n = 0;
async function device() {
  const t = { now: Date.parse(END) };
  const site = await startServer({ file: join(dir, `site-${++n}.db`), port: 0, end: END, clock: () => new Date(t.now += 1000) });
  sites.push(site);
  await site.consoleLine('add device'); await site.consoleLine('ward phone');
  const code = /^ {4}([A-Z0-9]{4}-[A-Z0-9]{4})$/m.exec(await site.consoleLine('2'))[1];
  const res = await fetch(`${site.url}/api/v1/devices/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: site.url }, body: JSON.stringify({ code }) });
  const cookie = res.headers.get('set-cookie').split(';')[0];
  const line = { dropAnswerOfNextChange: false, holdNextSync: null };
  const fetchAs = async (url, init = {}) => {
    if (init.method !== 'POST' && line.holdNextSync && String(url).includes('/sync')) { const hold = line.holdNextSync; line.holdNextSync = null; await hold; }
    const answer = await fetch(new URL(url, `${site.url}/app/`), { ...init, headers: { ...(init.headers || {}), Cookie: cookie, ...(init.method === 'POST' ? { Origin: site.url } : {}) } });
    if (init.method === 'POST' && line.dropAnswerOfNextChange) {
      line.dropAnswerOfNextChange = false;
      await answer.arrayBuffer();
      throw new TypeError('Failed to fetch');
    }
    return answer;
  };
  const mirror = new MirrorAdapter(new MemoryAdapter());
  const link = new SiteLink({ mirror, fetch: fetchAs });
  const who = await link.session();
  await mirror.put('meta', { id: 'site-device', value: who.device });
  link.core = await Core.open({ adapter: mirror });
  assert.equal(await link.pull(), true);
  const made = await link.run('ospeli_maps_create', { from: 'discharge' }, who.device.role);
  const mapId = made.map?.id || made.mapId || made.id;
  const step = { mapId, version: 'today', name: 'Audit step', role: 'Housekeeping', wait: 30, work: 20 };
  const steps = async () => JSON.stringify(await site.core.getMeta('process-maps')).split('"Audit step"').length - 1;
  return { site, link, line, role: who.device.role, step, steps };
}

test('after a lost answer and then a sync, the same change tapped again is a new change and is made', async () => {
  const d = await device();
  d.line.dropAnswerOfNextChange = true;
  const first = await d.link.run('ospeli_maps_step_add', d.step, d.role).then(() => null, (e) => e);
  assert.equal(first?.code, 'offline');
  // The connection is back: the device syncs and its copy now shows the step was saved after all.
  assert.equal(await d.link.pull(), true);
  assert.equal(JSON.stringify(await d.link.core.getMeta('process-maps')).split('"Audit step"').length - 1, 1, 'the device can see the first one was saved');
  // The person adds a second step of the same name on purpose.
  await d.link.run('ospeli_maps_step_add', d.step, d.role);
  assert.equal(await d.steps(), 2, 'the second, deliberate change must reach the site');
});

test('a sync that began before the change was sent does not count: the retry still is not made twice', async () => {
  const d = await device();
  let release;
  d.line.holdNextSync = new Promise((r) => { release = r; });
  const slowSync = d.link.pull(); // on its way before the change is sent
  d.line.dropAnswerOfNextChange = true;
  const first = await d.link.run('ospeli_maps_step_add', d.step, d.role).then(() => null, (e) => e);
  assert.equal(first?.code, 'offline');
  release();
  await slowSync;
  await d.link.run('ospeli_maps_step_add', d.step, d.role);
  assert.equal(await d.steps(), 1, 'the retry is answered from the first time');
});
