// Security and audit, 26 Nov. The site server remembers a device's change for ten minutes so a
// retry is not made twice (issue #109). It must remember changes only: a read sent with an
// Idempotency-Key was remembered too, so the same read was answered with what was true up to ten
// minutes earlier (a list without the newest step), and 500 large read answers could be parked in
// the server's memory by one connected device.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const emit = process.emitWarning;
process.emitWarning = (w, ...rest) => (/SQLite/i.test(String(w?.message || w)) ? undefined : emit.call(process, w, ...rest));
const { startServer } = await import('../../tools/ospeli-server/site-server.mjs');

const END = '2026-11-08T12:00:00.000Z';
const dir = mkdtempSync(join(tmpdir(), 'ospeli-audit-replay-'));
let site;
after(async () => { await site?.close().catch(() => {}); rmSync(dir, { recursive: true, force: true }); });

test('a read sent twice with the same key is read twice: the second answer shows a change made in between', async () => {
  const t = { now: Date.parse(END) };
  site = await startServer({ file: join(dir, 'site.db'), port: 0, end: END, clock: () => new Date(t.now += 1000) });
  await site.consoleLine('add device'); await site.consoleLine('ward phone');
  const code = /^ {4}([A-Z0-9]{4}-[A-Z0-9]{4})$/m.exec(await site.consoleLine('2'))[1];
  const res = await fetch(`${site.url}/api/v1/devices/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: site.url }, body: JSON.stringify({ code }) });
  const cookie = res.headers.get('set-cookie').split(';')[0];
  const call = (name, input, key) => fetch(`${site.url}/api/v1/commands/${name}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: site.url, ...(key ? { 'Idempotency-Key': key } : {}) }, body: JSON.stringify({ input }) });

  const before = await call('ospeli_maps_list', {}, 'same-read-key-01');
  assert.equal(before.status, 200);
  const countBefore = (await before.json()).result.maps.length;
  const made = await call('ospeli_maps_create', { from: 'discharge' });
  assert.equal(made.status, 200);
  const again = await call('ospeli_maps_list', {}, 'same-read-key-01');
  assert.equal(again.status, 200);
  assert.equal(again.headers.get('idempotent-replay'), null, 'a read is never answered from memory');
  assert.equal((await again.json()).result.maps.length, countBefore + 1, 'the second read shows the new map');
});
