// Finding: on a map made from a walk, ospeli_maps_summary works out "biggestWait" from the
// minutes rounded for the map, not from the measured seconds the screen and the guide use. Two
// waits that round to the same minute are taken in step order, so the answer names the wrong
// step and contradicts the guide's own first line in the same answer. It also still names a
// biggest wait when the clock was set back, where the guide says none can be named.
// Synthetic taps only; the clock is moved by hand.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Core } from '../../web/app/core/core.js';
import { MemoryAdapter } from '../../web/app/core/db.js';
import { runCommand } from '../../web/app/core/commands.js';

const START = '2026-11-16T09:00:00.000Z';
const human = { type: 'human', role: 'ops-manager' };
async function setup() {
  let t = Date.parse(START);
  const core = await Core.open({ adapter: new MemoryAdapter(), clock: () => new Date(t) });
  const tick = (s) => { t += s * 1000; };
  const tap = (name, input = {}) => runCommand(core, name, input, human);
  return { tick, tap };
}

test('summary of a walked map names the same longest wait as the guide and the screen', async () => {
  const { tick, tap } = await setup();
  await tap('ospeli_walks_start', { title: 'Morning clinic visit' });
  tick(40); await tap('ospeli_walks_step_start'); // 40 s wait: rounds to 1 min
  tick(120); await tap('ospeli_walks_step_done');
  await tap('ospeli_walks_step_name', { name: 'Checked in at reception', role: 'Reception' });
  tick(80); await tap('ospeli_walks_step_start'); // 80 s wait: also rounds to 1 min, and is the longest
  tick(120); await tap('ospeli_walks_step_done');
  await tap('ospeli_walks_step_name', { name: 'Seen by a nurse', role: 'Nurse' });
  const { mapId } = await tap('ospeli_walks_finish');
  const sum = await tap('ospeli_maps_summary', { mapId });
  assert.match(sum.suggestions[0].title, /Longest wait on this walk: 1 min 20 s before “Seen by a nurse”/, 'the guide names the 80 second wait');
  assert.equal(sum.biggestWait?.name, 'Seen by a nurse', `biggestWait names "${sum.biggestWait?.name}" (40 s) while the guide in the same answer says: ${sum.suggestions[0].title}`);
});

test('summary of a walk whose clock was set back names no biggest wait', async () => {
  const { tick, tap } = await setup();
  await tap('ospeli_walks_start', { title: 'Morning clinic visit' });
  tick(600); await tap('ospeli_walks_step_start');
  tick(120); await tap('ospeli_walks_step_done');
  tick(-900); await tap('ospeli_walks_step_start'); // the phone's clock went back 15 minutes
  tick(120); await tap('ospeli_walks_step_done');
  const { mapId } = await tap('ospeli_walks_finish');
  const sum = await tap('ospeli_maps_summary', { mapId });
  assert.equal(sum.suggestions[0].id, 'walk-clock', 'the guide says these times cannot be relied on');
  assert.equal(sum.biggestWait, null, `biggestWait still names a wait of ${sum.biggestWait?.wait} min before "${sum.biggestWait?.name}" from times the guide says cannot be relied on`);
});
