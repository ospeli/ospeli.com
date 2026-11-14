// Code review, 14 Nov: a change sent from a connected device while a background sync is still in flight.
// SiteLink.run() must leave the device's copy holding the change it just saved.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Core } from '../../web/app/core/core.js';
import { MemoryAdapter } from '../../web/app/core/db.js';
import { MirrorAdapter, SiteLink } from '../../web/app/core/site.js';

const START = Date.parse('2026-11-08T12:00:00.000Z');

test('a change saved while a sync is in flight is in the copy when run() returns', async () => {
  // A stand-in for the site server: a real core, answering /sync the way the server does.
  let t = START;
  const server = await Core.open({ adapter: new MemoryAdapter(), clock: () => new Date(t += 1000) });
  await server.putEntity({ id: 'site-x', type: 'site', name: 'Example site' }, 'system');
  let rev = 1;
  server.onChange(() => { rev += 1; });
  const answer = async (url) => {
    const q = new URL(url, 'http://site').searchParams;
    if (q.get('epoch') === 'e.0' && Number(q.get('rev')) === rev) return { ok: true, epoch: 'e.0', rev, unchanged: true };
    return { ok: true, epoch: 'e.0', rev, full: true, entities: await server.listEntities(), events: await server.events(), audit: await server.auditLog(), meta: {} };
  };
  const json = (body) => ({ ok: true, status: 200, json: async () => body });
  let hold = null; // when set, the next /sync answer is worked out now but delivered later
  const fetch = async (url, init = {}) => {
    if (url.includes('/sync')) {
      const body = await answer(url); // what the server knew when the request arrived
      if (hold) { const gate = hold; hold = null; await gate.promise; }
      return json(body);
    }
    // a command: the server saves one event
    await server.appendEvent({ type: 'workorder.started', subject: 'wo-00001', actorRole: 'estates-tech', data: { asset: 'asset-x' } });
    return json({ ok: true, result: { status: 'done' } });
  };
  const mirror = new MirrorAdapter(new MemoryAdapter());
  const link = new SiteLink({ mirror, fetch, clock: () => new Date(t) });
  link.core = await Core.open({ adapter: mirror });
  assert.equal(await link.pull(), true);
  assert.equal((await link.core.events()).length, 0);

  // The 4-second background sync starts, and its answer is slow to arrive.
  let release; hold = { promise: new Promise((r) => { release = r; }) };
  const background = link.pull();
  await new Promise((r) => setImmediate(r));
  // The person taps "Start job" meanwhile.
  const saving = link.run('ospeli_workorders_start', { workOrderId: 'wo-00001' }, 'estates-tech');
  await new Promise((r) => setImmediate(r));
  release();
  await saving; await background;
  assert.equal((await server.events()).length, 1, 'the server saved the change');
  assert.equal((await link.core.events()).length, 1, 'the device\'s copy shows the change it just saved');
});
