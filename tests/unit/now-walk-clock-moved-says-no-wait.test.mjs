// Audit: the Now page's "From your walks" line (home.js latestWalk) reads ospeli_maps_summary's
// biggestWait. On a walk whose phone clock moved back, biggestWait is null on purpose (no wait is
// named), and latestWalk then says "no wait of 30 seconds or more" - a statement about the walk
// that is not true; the Result tab says the clock changed instead. Synthetic taps only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Core } from '../../web/app/core/core.js';
import { MemoryAdapter } from '../../web/app/core/db.js';
import { runCommand } from '../../web/app/core/commands.js';
import { latestWalk } from '../../web/app/modules/home.js';

test('Now: a walk with a 20-minute wait on a clock that moved back is not said to have "no wait of 30 seconds or more"', async () => {
  let t = Date.parse('2026-11-16T09:00:00.000Z');
  const core = await Core.open({ adapter: new MemoryAdapter(), clock: () => new Date(t) });
  const tick = (s) => { t += s * 1000; };
  const run = (name, input = {}) => runCommand(core, name, input, { type: 'human', role: 'ops-manager' });
  await run('ospeli_walks_start');
  tick(60); await run('ospeli_walks_step_start');
  tick(300); await run('ospeli_walks_step_done');
  tick(1200); await run('ospeli_walks_step_start');   // a 20-minute wait before step 2
  tick(300); await run('ospeli_walks_step_done');
  tick(-600);                                          // the phone's clock is set back ten minutes
  tick(30); await run('ospeli_walks_step_start');
  tick(60); await run('ospeli_walks_step_done');
  const done = await run('ospeli_walks_finish');
  const map = await run('ospeli_maps_get', { mapId: done.mapId });
  assert.equal(map.walk.clockMoved, true, 'setup: the walk is marked clock moved');
  const line = await latestWalk(run);
  assert.ok(line, 'a line is drawn');
  assert.doesNotMatch(line.text, /no wait of 30 seconds or more/, `Now says: "${line.title}: ${line.text}"`);
});
