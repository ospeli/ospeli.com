// ospeli/ospeli#133, point 3: a unit test whose clock ticks on every reading must not let that clock
// run on while the example hospital is stored, or a measure over a sliding window shifts each time a
// module adds synthetic history. The shared helper tests/unit/hospital-clock.mjs holds the clock
// still during the load; this file checks the helper and that the ticking tests use it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Core } from '../../web/app/core/core.js';
import { MemoryAdapter } from '../../web/app/core/db.js';
import { loadHospital } from './hospital-clock.mjs';

const END = '2026-11-10T14:00:00.000Z';
const here = dirname(fileURLToPath(import.meta.url));

async function afterLoad(modules) {
  let t = Date.parse(END);
  const core = await Core.open({ adapter: new MemoryAdapter(), clock: () => new Date(t += 1000) });
  const r = await loadHospital(core, { end: END, modules });
  return { events: r.events, now: core.now(), core };
}

test('with the helper, the clock after the load is the same however much history the hospital has', async () => {
  const small = await afterLoad(false);
  const large = await afterLoad(true);
  assert.ok(large.events > small.events + 1000, `the modules add history (${small.events} then ${large.events} events)`);
  // One reading held for the whole load, then the test's next tick.
  assert.equal(small.now, '2026-11-10T14:00:02.000Z');
  assert.equal(large.now, small.now, 'more synthetic history does not move the test\'s clock');
  // The test's own ticking clock is back after the load.
  assert.equal(large.core.now(), '2026-11-10T14:00:03.000Z');
  // Every record of the load carries the one held moment.
  const stamps = new Set((await large.core.events()).map((e) => e.recordedAt));
  assert.deepEqual([...stamps], ['2026-11-10T14:00:01.000Z']);
});

test('the clock is given back even when the load fails', async () => {
  let t = Date.parse(END);
  const tick = () => new Date(t += 1000);
  const core = await Core.open({ adapter: new MemoryAdapter(), clock: tick });
  await assert.rejects(loadHospital(core, { end: 'not a time' }));
  assert.equal(core.clock, tick);
});

// A clock that moves on every reading, written inline: () => new Date(t += 1000), (t.now += 1000) and the like.
const TICKS_EVERY_READING = /clock:\s*\(\)\s*=>\s*new Date\(\(?\s*[\w.]+\s*\+=/;
test('no unit test stores the example hospital under a clock that ticks on every reading, except through the helper', () => {
  const bad = [];
  for (const f of readdirSync(here).filter((n) => n.endsWith('.mjs') && n !== 'hospital-clock.mjs')) {
    const src = readFileSync(join(here, f), 'utf8');
    if (TICKS_EVERY_READING.test(src) && /\bloadSyntheticHospital\(/.test(src)) bad.push(f);
  }
  assert.deepEqual(bad, [], 'use loadHospital from ./hospital-clock.mjs in these files');
});
