// J1 swarm check (17 Nov 2026): what #102, #99 and #107 still need after the walk-mode fixes patch.
// Each test fails on the patched code and says which issue it belongs to. Synthetic taps only:
// every time comes from a clock the test moves by hand; no real walk is ever read.
// The atomic Finish and walks_get freeText proofs are in docs/audit/2026-11-15/ and still fail too.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Core } from '../../web/app/core/core.js';
import { MemoryAdapter } from '../../web/app/core/db.js';
import { runCommand } from '../../web/app/core/commands.js';
import { suggestWalk } from '../../web/app/core/walk.js';

const START = '2026-11-16T09:00:00.000Z';
const human = { type: 'human', role: 'ops-manager' };
async function setup() {
  let t = Date.parse(START);
  const core = await Core.open({ adapter: new MemoryAdapter(), clock: () => new Date(t) });
  const tick = (s) => { t += s * 1000; };
  const tap = (name, input = {}) => runCommand(core, name, input, human);
  return { core, tick, tap };
}

// #102: the flag lives on the walk view only. The map is what is kept and shown afterwards,
// so a map made from a walk whose clock moved back must say so too.
test('#102: a map made from a walk whose clock moved back carries the warning', async () => {
  const { tick, tap } = await setup();
  await tap('ospeli_walks_start', {});
  tick(40); await tap('ospeli_walks_step_start');
  tick(-3600); // the phone corrects its clock back by an hour
  tick(60); await tap('ospeli_walks_step_done');
  const out = await tap('ospeli_walks_finish');
  assert.equal(out.walk.clockMoved, true, 'the walk view has the flag (patch fix 3)');
  const map = await tap('ospeli_maps_get', { mapId: out.mapId });
  assert.equal(map.walk?.clockMoved, true, `the map's walk record has no clockMoved: ${JSON.stringify(map.walk)}`);
});

// #102 (design question): a clock that jumps FORWARD mid-step makes a false hour of hands-on time,
// and nothing says so. Tap times alone cannot tell this from a real hour; the screen would need
// to send the elapsed time it measured itself (for example performance.now) with each tap.
// Not built (18 Nov 2026): tap times alone cannot tell a forward jump from a real hour, and a
// timer that pauses while a phone sleeps would flag honest long waits. The screen says so instead
// ("A clock that jumps forward cannot be detected"). Kept as a to-do until there is a decision.
test('#102 (design question): a clock jump forward of an hour mid-step is flagged, not saved as an hour', { todo: 'needs a decision: see issue #102' }, async () => {
  const { tick, tap } = await setup();
  await tap('ospeli_walks_start', {});
  tick(40); await tap('ospeli_walks_step_start');
  tick(3600); // the phone corrects its clock forward by an hour
  tick(60); await tap('ospeli_walks_step_done');
  const { walk } = await tap('ospeli_walks_finish');
  assert.ok(walk.steps[0].workSec < 3600 || walk.clockMoved === true,
    `step 1 reads ${walk.steps[0].workSec} s hands-on (60 s really) and clockMoved is ${walk.clockMoved}`);
});

// #99 ("a floor for very short waits, with ties named"): two equal longest waits are both named.
test('#99: two equal longest waits above the floor are both named', () => {
  const list = [
    { id: 's1', name: 'Checked in at reception', role: 'Reception', wait: 1, work: 0, waitSec: 45, workSec: 20 },
    { id: 's2', name: 'Seen by a nurse', role: 'Nurse', wait: 1, work: 0, waitSec: 45, workSec: 20 },
  ];
  const wait = suggestWalk(list).filter((s) => /Longest wait/.test(s.title));
  const text = wait.map((s) => s.title).join(' | ');
  assert.ok(/Checked in at reception/.test(text) && /Seen by a nurse/.test(text), `only one is named: ${text}`);
});

// 18 Nov 2026 (builder): the Domain lead's points and definition-of-done item 5.
test('a double tap on "Step done" does not open a phantom step: a start under a second after a step ended is refused', async () => {
  const { tick, tap } = await setup();
  await tap('ospeli_walks_start', {});
  tick(40); await tap('ospeli_walks_step_start');
  tick(60); await tap('ospeli_walks_step_done');
  tick(0.4);
  await assert.rejects(() => tap('ospeli_walks_step_start'), (err) => err.code === 'conflict' && /less than a second/.test(err.message));
  tick(1); const out = await tap('ospeli_walks_step_start');
  assert.equal(out.walk.state, 'step', 'a start a second or more later is a step');
  // A hand-over with no wait is still recorded on purpose.
  tick(30); await tap('ospeli_walks_step_done');
  const named = await tap('ospeli_walks_step_name', { name: 'Seen by a nurse', role: 'Nurse', nextStarted: true });
  assert.equal(named.walk.state, 'step');
  assert.equal(named.walk.steps.length, 2);
});

test('a walk whose clock moved back names no longest wait; the guide says the times cannot be relied on', async () => {
  const { tick, tap } = await setup();
  await tap('ospeli_walks_start', {});
  tick(120); await tap('ospeli_walks_step_start');
  tick(-3600); tick(60); await tap('ospeli_walks_step_done');
  const out = await tap('ospeli_walks_finish');
  const sugg = (await tap('ospeli_maps_suggest', { mapId: out.mapId })).suggestions;
  assert.equal(sugg.some((s) => /Longest wait/.test(s.title)), false);
  assert.match(sugg[0].title, /clock changed during this walk/);
  assert.match(sugg[0].text, /may be wrong\. Your steps are kept\. Walk it again/); // wording only (marketer, 20 Nov): says what happened, and why to walk again
});

test('every guide rule says what it rests on: walked maps and drawn maps (definition of done, item 5)', async () => {
  const { suggest, EXAMPLES } = await import('../../web/app/core/processmap.js');
  const walked = [
    { id: 's1', name: 'Step 1', role: 'Not set', wait: 1, work: 0, waitSec: 45, workSec: 20 },
    { id: 's2', name: 'Seen by a nurse', role: 'Nurse', wait: 0, work: 0, waitSec: 5, workSec: 20 },
  ];
  const all = [...suggestWalk(walked), ...suggestWalk(walked, { clockMoved: true }), ...suggest([])];
  for (const ex of Object.values(EXAMPLES)) all.push(...suggest(ex.steps.map(([name, role, wait, work, msg], i) => ({ id: `s${i + 1}`, name, role, wait, work, msg: !!msg, par: false }))));
  for (const id of ['wait-', 'msgs', 'handoffs', 'par-', 'questions']) assert.ok(all.some((sg) => sg.id.startsWith(id)), `the examples reach the "${id}" rule`);
  assert.ok(all.length > 8, `${all.length} suggestions checked`);
  for (const sg of all) assert.ok(typeof sg.basis === 'string' && sg.basis.length > 10, `no basis on "${sg.title}"`);
  assert.ok(all.some((sg) => /^Example setting, not a standard/.test(sg.basis)));
});
