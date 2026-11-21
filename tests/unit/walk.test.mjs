// Walk mode (backlog PM2): the commands run without the UI; every time on the map is recomputed
// from the stored tap times; people only; no names; one walk is labelled as one walk.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Core } from '../../web/app/core/core.js';
import { MemoryAdapter } from '../../web/app/core/db.js';
import { loadSyntheticHospital } from '../../web/app/core/generator.js';
import { runCommand, commandByName, listCommands, CommandError } from '../../web/app/core/commands.js';
import { validate } from '../../web/app/core/schema.js';
import { analyse } from '../../web/app/core/processmap.js';
import { fmtSeconds, fmtClock, stepsInSeconds, walkSteps, suggestWalk, dropStaleSeconds } from '../../web/app/core/walk.js';

const START = '2026-11-16T09:00:00.000Z';
const human = (role = 'ops-manager') => ({ type: 'human', role });
const code = (c) => (err) => err instanceof CommandError && err.code === c;

// A clock the test moves by hand: every core.now() reads it, so a tap's time is exactly known.
async function setup() {
  let t = Date.parse(START);
  const core = await Core.open({ adapter: new MemoryAdapter(), clock: () => new Date(t) });
  await loadSyntheticHospital(core, { end: START });
  const tick = (seconds) => { t += seconds * 1000; };
  const tap = (name, input = {}, who = human()) => runCommand(core, name, input, who);
  return { core, tick, tap };
}

// The staged walk used below: wait 40 s, work 75 s; wait 0 (hand-over), work 30 s; wait 200 s, work 12 s.
async function walkThree({ tick, tap }) {
  await tap('ospeli_walks_start', { title: 'Morning clinic visit' });
  tick(40); await tap('ospeli_walks_step_start');
  tick(75); await tap('ospeli_walks_step_done');
  tick(9); await tap('ospeli_walks_step_name', { name: 'Checked in at reception', role: 'Reception', nextStarted: true }); // naming took 9 s: not a wait
  tick(21); await tap('ospeli_walks_step_done');
  await tap('ospeli_walks_step_name', { name: 'Seen by a nurse', role: 'Nurse' });
  tick(200); await tap('ospeli_walks_step_start');
  tick(12); await tap('ospeli_walks_step_done', { interrupted: true });
  tick(50); // the person looks at the phone for a while before finishing: not part of the walk
  return tap('ospeli_walks_finish');
}

test('a walk of three steps becomes a map; every time is recomputed from the tap times', async () => {
  const env = await setup();
  const { core, tap } = env;
  const done = await walkThree(env);
  assert.equal(done.status, 'done');
  assert.deepEqual(validate(commandByName('ospeli_walks_finish').output, done, 'output'), []);
  assert.match(done.mapId, /^map-\d{3}$/);
  assert.equal(done.walk.status, 'finished');
  assert.deepEqual(done.walk.steps.map((s) => [s.name, s.role, s.waitSec, s.workSec, s.named]), [
    ['Checked in at reception', 'Reception', 40, 75, true],
    ['Seen by a nurse', 'Nurse', 0, 30, true],
    ['Step 3', 'Not set', 200, 12, false],
  ]);
  assert.deepEqual(done.walk.totals, { steps: 3, workSec: 117, waitSec: 240, notSeenSec: 0, elapsedSec: 357 });

  // Recompute from what is stored, without the commands: the raw tap times give the same numbers.
  const stored = (await core.getMeta('process-walks')).walks[0];
  const at = (iso) => (Date.parse(iso) - Date.parse(START)) / 1000;
  assert.deepEqual(stored.steps.map((s) => [at(s.startAt), at(s.endAt)]), [[40, 115], [115, 145], [345, 357]]);
  assert.deepEqual(walkSteps(stored).map((s) => [s.waitSec, s.workSec]), [[40, 75], [0, 30], [200, 12]]);
  assert.equal(stored.finishedAt, stored.steps[2].endAt, 'the walk ends at its last step, not at the Finish tap');

  // The map: measured seconds beside rounded minutes; the KPIs in seconds add up exactly.
  const map = await tap('ospeli_maps_get', { mapId: done.mapId });
  assert.deepEqual(validate(commandByName('ospeli_maps_get').output, map, 'output'), []);
  assert.equal(map.title, 'Morning clinic visit');
  assert.deepEqual(map.walk, { id: 'walk-001', startedAt: START, finishedAt: stored.finishedAt, guidanceSeen: false }); // started here without the before-you-walk points (issue #124)
  assert.deepEqual(map.today.steps.map((s) => [s.wait, s.work, s.waitSec, s.workSec]), [[1, 1, 40, 75], [0, 1, 0, 30], [3, 0, 200, 12]]);
  assert.equal(map.today.steps[2].interrupted, true);
  const k = map.today.statsSec;
  assert.equal(k.elapsed, 357, 'total elapsed time: walk start to last step done');
  assert.equal(k.work, 117); assert.equal(k.wait, 240);
  assert.equal(k.workShare, Math.round((100 * 117) / 357), 'share of the time that is hands-on work');
  assert.equal(k.handoffs, 2, 'the role changes twice');
  assert.equal(k.biggestWaitStepId, `${done.mapId}-s3`);
  assert.deepEqual(analyse(stepsInSeconds(map.today.steps)).elapsed, k.elapsed);
  assert.equal(map.changed, false, 'Proposed starts as a copy');
  const row = (await tap('ospeli_maps_list')).maps.find((m) => m.id === done.mapId);
  assert.equal(row.walk, true); assert.equal(row.elapsedSecToday, 357);

  // The guide for a walked map asks; it never offers to change a time measured once.
  const sugg = (await tap('ospeli_maps_suggest', { mapId: done.mapId })).suggestions;
  assert.match(sugg[0].title, /^Longest wait on this walk: 3 min 20 s before “Step 3”$/);
  assert.ok(sugg.every((s) => s.tryable === false), 'no "try" on a single walk');
  assert.ok(sugg.some((s) => /no name or role yet/.test(s.title)));
  assert.ok(sugg.some((s) => /happened once/.test(s.text)));

  // The audit trail has every tap, with ids and counts only: no step name, role or title.
  const audit = await core.auditLog();
  const acts = audit.filter((a) => a.action.startsWith('walk.')).map((a) => a.action);
  assert.deepEqual(acts, ['walk.started', 'walk.step-started', 'walk.step-done', 'walk.step-named', 'walk.step-done', 'walk.step-named', 'walk.step-started', 'walk.step-done', 'walk.finished']);
  assert.ok(audit.filter((a) => a.action.startsWith('walk.')).every((a) => a.actorType === 'human'));
  for (const text of ['Checked in', 'Reception', 'Morning clinic', 'Seen by']) assert.ok(!JSON.stringify(audit).includes(text), `the audit does not hold "${text}"`);
  assert.equal((await core.verifyAudit()).ok, true);
});

test('a measured time changed by hand is no longer measured; the step says it was edited', async () => {
  const env = await setup();
  const done = await walkThree(env);
  const id = done.mapId;
  await env.tap('ospeli_maps_step_update', { mapId: id, stepId: `${id}-s3`, name: 'Medicines collected', role: 'Pharmacy' });
  let s3 = (await env.tap('ospeli_maps_get', { mapId: id })).today.steps[2];
  assert.equal(s3.waitSec, 200, 'naming a step keeps its measured times');
  assert.equal(s3.edited, undefined);
  await env.tap('ospeli_maps_step_update', { mapId: id, stepId: `${id}-s3`, wait: 10 });
  const map = await env.tap('ospeli_maps_get', { mapId: id });
  s3 = map.today.steps[2];
  assert.equal(s3.wait, 10); assert.equal(s3.waitSec, undefined); assert.equal(s3.edited, true);
  assert.equal(s3.workSec, 12, 'the time that was not changed stays measured');
  assert.equal(map.today.statsSec.wait, 40 + 0 + 600, 'the edited step counts as its minutes');
  assert.deepEqual(dropStaleSeconds([{ wait: 1, work: 1, waitSec: 40, workSec: 75 }]), [{ wait: 1, work: 1, waitSec: 40, workSec: 75 }]);
});

test('the taps follow the walk: wrong order is refused in plain words, undo takes back one tap, one walk at a time', async () => {
  const { core, tick, tap } = await setup();
  await assert.rejects(tap('ospeli_walks_step_start'), code('not-found'));
  assert.equal((await tap('ospeli_walks_get')).walk, null);
  const started = await tap('ospeli_walks_start');
  assert.equal(started.walk.title, 'Walk 1');
  assert.equal(started.walk.state, 'waiting');
  await assert.rejects(tap('ospeli_walks_start'), (e) => e.code === 'conflict' && e.detail.existing === 'walk-001');
  await assert.rejects(tap('ospeli_walks_step_done'), code('conflict'));
  await assert.rejects(tap('ospeli_walks_undo'), code('conflict'));
  await assert.rejects(tap('ospeli_walks_finish'), code('conflict'));
  await assert.rejects(tap('ospeli_walks_step_name', { name: 'Checked in', role: 'Reception' }), code('conflict'));
  tick(30); assert.equal((await tap('ospeli_walks_step_start')).walk.state, 'step');
  await assert.rejects(tap('ospeli_walks_step_start'), code('conflict'));
  await assert.rejects(tap('ospeli_walks_finish'), (e) => e.code === 'conflict' && /still running/.test(e.message));
  // A mistaken "step starts": undo, and the wait carries on from where it was.
  tick(5); assert.equal((await tap('ospeli_walks_undo')).undone, 'step-start');
  tick(25); await tap('ospeli_walks_step_start');
  tick(60); await tap('ospeli_walks_step_done');
  // A mistaken "step done": undo, and the step runs on from its own start.
  tick(4); const back = await tap('ospeli_walks_undo');
  assert.equal(back.undone, 'step-done'); assert.equal(back.walk.state, 'step'); assert.equal(back.walk.steps.length, 0);
  tick(16); const end = await tap('ospeli_walks_step_done');
  assert.deepEqual(end.walk.steps.map((s) => [s.waitSec, s.workSec]), [[60, 80]]);
  await assert.rejects(tap('ospeli_walks_step_name', { name: 'Seen by a nurse', role: 'Nurse', nextStarted: true, extra: 1 }), code('invalid-input'));
  // The read: state, when the present wait began, and short lists to tap.
  const get = await tap('ospeli_walks_get');
  assert.deepEqual(validate(commandByName('ospeli_walks_get').output, get, 'output'), []);
  assert.equal(get.walk.state, 'waiting');
  assert.equal(get.walk.since, (await core.getMeta('process-walks')).walks[0].steps[0].endAt);
  assert.equal(get.stepChips.length, 6); assert.equal(get.roleChips.length, 6);
  await tap('ospeli_walks_step_name', { name: 'Blood sample taken', role: 'Laboratory' });
  const chips = await tap('ospeli_walks_get');
  assert.equal(chips.stepChips[0], 'Blood sample taken', 'the site\'s own words come first');
  assert.equal(chips.roleChips[0], 'Laboratory');
  // Delete: no map is made, the taps are gone, and a new walk can start.
  const maps = (await tap('ospeli_maps_list')).total;
  const gone = await tap('ospeli_walks_discard');
  assert.equal(gone.walk.status, 'discarded'); assert.equal(gone.walk.steps.length, 0);
  assert.equal((await tap('ospeli_maps_list')).total, maps);
  assert.equal((await tap('ospeli_walks_start')).walk.id, 'walk-002');
});

test('no names and no personal details: a step, a role or a title that names a person is refused or asked about', async () => {
  const { tick, tap } = await setup();
  await assert.rejects(tap('ospeli_walks_start', { title: 'Dr Sarah Jones clinic' }), code('invalid-input'));
  await tap('ospeli_walks_start', { title: 'Morning clinic visit' });
  tick(10); await tap('ospeli_walks_step_start'); tick(10); await tap('ospeli_walks_step_done');
  await assert.rejects(tap('ospeli_walks_step_name', { name: 'Seen by Dr Sarah Jones', role: 'Doctor' }), code('invalid-input'));
  await assert.rejects(tap('ospeli_walks_step_name', { name: 'Seen by a doctor', role: 'Mary Brown' }), code('invalid-input'));
  await assert.rejects(tap('ospeli_walks_step_name', { name: 'Call 0700 123 4567', role: 'Nurse' }), code('invalid-input'));
  await assert.rejects(tap('ospeli_walks_step_name', { name: 'Yellow Sticker put on the chart', role: 'Nurse' }), (e) => e.code === 'invalid-input' && e.detail?.confirm === 'notAName');
  assert.equal((await tap('ospeli_walks_step_name', { name: 'Yellow Sticker put on the chart', role: 'Nurse', notAName: true })).walk.steps[0].name, 'Yellow Sticker put on the chart');
});

test('a walk is for people only: an agent may read it, never start, tap, finish or delete it', async () => {
  const { core, tick, tap } = await setup();
  await runCommand(core, 'ospeli_agents_set_access', { allowed: true }, human('coo'));
  await runCommand(core, 'ospeli_agents_add', { name: 'flow-bot', role: 'ops-manager', days: 30 }, human('coo'));
  const bot = { type: 'agent', role: 'ops-manager', agent: 'flow-bot' };
  for (const name of ['ospeli_walks_start', 'ospeli_walks_step_start', 'ospeli_walks_step_done', 'ospeli_walks_step_name', 'ospeli_walks_undo', 'ospeli_walks_finish', 'ospeli_walks_discard', 'ospeli_walks_pause', 'ospeli_walks_resume', 'ospeli_walks_step_skip']) {
    const cmd = commandByName(name);
    assert.equal(cmd.agents, false, `${name} is people only`);
    assert.equal(cmd.input.additionalProperties, false);
    await assert.rejects(runCommand(core, name, {}, bot), code('forbidden'), name);
  }
  await tap('ospeli_walks_start'); tick(5); await tap('ospeli_walks_step_start');
  const read = await runCommand(core, 'ospeli_walks_get', {}, bot);
  assert.equal(read.walk.state, 'step');
  assert.equal((await core.proposals()).length, 0, 'nothing was queued');
  const audit = await core.auditLog();
  assert.ok(audit.some((a) => a.action === 'agent.read' && a.detail.command === 'ospeli_walks_get'));
  assert.equal(audit.filter((a) => a.action === 'agent.refused').length >= 1, true);
  // Every walk command is listed for agents and people with an example.
  const listed = listCommands().filter((c) => c.name.startsWith('ospeli_walks_'));
  assert.equal(listed.length, 11); // pause and resume added with issue #124; step_skip with repeat walks (#124 item 1)
  assert.ok(listed.every((c) => c.example && c.summary.length > 40));
});

test('times read plainly: seconds under a minute, minutes and seconds after, a clock for the walk screen', () => {
  assert.equal(fmtSeconds(0), '0 s'); assert.equal(fmtSeconds(45), '45 s'); assert.equal(fmtSeconds(60), '1 min');
  assert.equal(fmtSeconds(200), '3 min 20 s'); assert.equal(fmtSeconds(3900), '1 h 05'); assert.equal(fmtSeconds(7200), '2 h');
  assert.equal(fmtClock(7), '0:07'); assert.equal(fmtClock(760), '12:40'); assert.equal(fmtClock(3725), '1:02:05');
  assert.deepEqual(suggestWalk([]).map((s) => s.id), ['walk-limits']);
});
