// Security and audit, 21 Nov: a list step is recorded as timed or as "did not happen", never both.
// Synthetic taps only; the clock is moved by hand; no screen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Core } from '../../web/app/core/core.js';
import { MemoryAdapter } from '../../web/app/core/db.js';
import { runCommand } from '../../web/app/core/commands.js';

const human = { type: 'human', role: 'ops-manager' };
async function setup(start = '2026-11-16T09:00:00.000Z', adapter = new MemoryAdapter()) {
  let t = Date.parse(start);
  const clock = () => new Date(t);
  const core = await Core.open({ adapter, clock });
  const tick = (s) => { t += s * 1000; };
  const at = (iso) => { t = Date.parse(iso); };
  const tap = (name, input = {}, c = core) => runCommand(c, name, input, human);
  const step = async (wait, work) => { tick(wait); await tap('ospeli_walks_step_start'); tick(work); return tap('ospeli_walks_step_done'); };
  return { core, adapter, clock, tick, at, tap, step };
}
async function firstWalk(x, names = [['Checked in at reception', 'Reception'], ['Seen by a nurse', 'Nurse'], ['Seen by a doctor', 'Doctor']]) {
  await x.tap('ospeli_walks_start', { title: 'Morning clinic visit', guidanceSeen: true });
  for (const [n, r] of names) { await x.step(120, 180); await x.tap('ospeli_walks_step_name', { name: n, role: r }); }
  return (await x.tap('ospeli_walks_finish')).mapId;
}

test('a list step marked "did not happen" and then picked as the step that ended is not recorded as both', async () => {
  const x = await setup();
  const mapId = await firstWalk(x);
  x.at('2026-11-18T14:00:00.000Z');
  await x.tap('ospeli_walks_start', { mapId });
  await x.step(60, 60);                       // list step 1
  await x.tap('ospeli_walks_step_skip');      // list step 2 marked "did not happen"
  await x.step(60, 60);                       // offered as list step 3...
  await x.tap('ospeli_walks_step_name', { listStep: 2 }); // ...but it was step 2 after all ("Change")
  await x.step(60, 60);                       // list step 3
  await x.tap('ospeli_walks_finish');
  const map = (await x.core.getMeta('process-maps')).maps.find((m) => m.id === mapId);
  const rec = map.walks.at(-1);
  const step2 = `${mapId}-s2`;
  assert.ok(rec.steps.some((s) => s.stepId === step2), 'step 2 was timed');
  assert.ok(!rec.didNotHappen.includes(step2), `the record says ${step2} was timed and also that it did not happen: ${JSON.stringify(rec.didNotHappen)}`);
});
