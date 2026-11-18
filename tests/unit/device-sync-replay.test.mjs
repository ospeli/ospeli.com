// A connected device takes any sync answer as true: an older answer, replayed or changed on the
// way, overwrites an event the device already holds, and nothing is checked (security sweep of
// 17 Nov 2026, finding 1; confirmed and closed by the security run of 18 Nov). Now such an answer
// is not taken: the copy is dropped and asked for again in full. Made-up data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryAdapter } from '../../web/app/core/db.js';
import { MirrorAdapter } from '../../web/app/core/site.js';

const T = '2026-11-06T18:00:00.000Z';
const ev = (seq) => ({ seq, type: 'bed.cleaned', subject: 'bed-a1-01', actorRole: 'system', at: T, data: {} });

test('an older sync answer cannot rewrite an event the device already holds', async () => {
  const m = new MirrorAdapter(new MemoryAdapter());
  await m.apply({ full: true, epoch: 'e1', rev: 2, entities: [], events: [ev(1), ev(2)], audit: [], meta: {} }, T);
  const out = await m.apply({ epoch: 'e1', rev: 1, entities: [], events: [{ ...ev(2), type: 'bed.vacated' }], audit: [], meta: {} }, T);
  assert.equal(out, 'again', 'the answer is not taken: the device asks again from nothing');
  assert.notEqual((await m.get('events', 2))?.type, 'bed.vacated', 'the changed event was not stored');
  assert.equal(await m.syncState(), null);
});

test('an answer that skips ahead, or whose audit entries do not link to the last one held, is dropped and asked for again', async () => {
  const au = (seq, prev, hash) => ({ seq, at: T, actorRole: 'system', action: 'x.y', target: null, detail: null, prev, hash });
  const start = async () => {
    const m = new MirrorAdapter(new MemoryAdapter());
    await m.apply({ full: true, epoch: 'e1', rev: 2, entities: [], events: [ev(1), ev(2)], audit: [au(1, 'genesis', 'h1')], meta: {} }, T);
    return m;
  };
  let m = await start();
  assert.equal(await m.apply({ epoch: 'e1', rev: 3, entities: [], events: [ev(4)], audit: [], meta: {} }, T), 'again', 'a gap in the events');
  assert.equal(await m.syncState(), null, 'the copy was dropped, so the next ask is from nothing');
  m = await start();
  assert.equal(await m.apply({ epoch: 'e1', rev: 3, entities: [], events: [], audit: [au(2, 'not-h1', 'h2')], meta: {} }, T), 'again', 'an audit entry that does not follow the last one held');
  m = await start();
  assert.equal(await m.apply({ epoch: 'e1', rev: 3, entities: [], events: [ev(3)], audit: [au(2, 'h1', 'h2'), au(3, 'h2', 'h3')], meta: {} }, T), 'events', 'an answer that carries on is taken');
  assert.equal((await m.syncState()).events, 3);
});
