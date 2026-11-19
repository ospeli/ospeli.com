// Walk mode, third slice (ospeli/ospeli#124 items 2 and 3): a pause while the person walking
// steps out, a wait a person marks as planned or required, and the before-you-walk points.
// Every number here is recomputed from the stored tap times. Synthetic taps; the clock is moved by hand.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Core } from '../../web/app/core/core.js';
import { MemoryAdapter } from '../../web/app/core/db.js';
import { runCommand, commandByName } from '../../web/app/core/commands.js';
import { validate } from '../../web/app/core/schema.js';
import { WALK_BEFORE, longestWaits, stepsInSeconds, waitShareOf } from '../../web/app/core/walk.js';

const START = '2026-11-16T09:00:00.000Z';
const human = { type: 'human', role: 'ops-manager' };
const code = (c) => (e) => e.code === c;
async function setup() {
  let t = Date.parse(START);
  const core = await Core.open({ adapter: new MemoryAdapter(), clock: () => new Date(t) });
  const tick = (s) => { t += s * 1000; };
  const tap = (name, input = {}) => runCommand(core, name, input, human);
  return { core, tick, tap };
}
const stored = async (core) => (await core.getMeta('process-walks')).walks;
const secs = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 1000);

test('before you walk: the points come from the command layer, the stop rule first, and only a time is kept', async () => {
  const { core, tap } = await setup();
  const got = await tap('ospeli_walks_get');
  assert.deepEqual(got.before, WALK_BEFORE);
  assert.match(got.before[0], /^If care is affected or the patient looks unwell, stop/);
  assert.equal(got.before.length, 6);
  const out = await tap('ospeli_walks_start', { guidanceSeen: true });
  assert.equal(out.walk.guidanceSeenAt, START);
  const w = (await stored(core))[0];
  assert.equal(w.guidanceSeenAt, START);
  // Nothing about a patient or a member of staff: no consent field, no name, no device.
  assert.deepEqual(Object.keys(w).sort(), ['createdByRole', 'current', 'finishedAt', 'guidanceSeenAt', 'id', 'last', 'mapId', 'pauses', 'startedAt', 'status', 'steps', 'title']);
  const audit = (await core.auditLog()).find((a) => a.action === 'walk.started');
  assert.deepEqual(audit.detail, { guidanceSeen: true });
});

test('a walk started without the points says so on its map; one started with them says that', async () => {
  for (const seen of [false, true]) {
    const { tick, tap } = await setup();
    await tap('ospeli_walks_start', seen ? { guidanceSeen: true } : {});
    tick(40); await tap('ospeli_walks_step_start'); tick(60); await tap('ospeli_walks_step_done');
    const { mapId } = await tap('ospeli_walks_finish');
    const map = await tap('ospeli_maps_get', { mapId });
    assert.equal(map.walk.guidanceSeen, seen);
    assert.deepEqual(validate(commandByName('ospeli_maps_get').output, map, 'output'), []);
  }
});

test('a pause in a wait and a pause in a step: not seen is neither waiting nor hands-on, and stays inside start to finish', async () => {
  const { core, tick, tap } = await setup();
  await tap('ospeli_walks_start', { guidanceSeen: true });
  tick(100); let out = await tap('ospeli_walks_pause');          // 100 s of waiting seen
  assert.equal(out.walk.state, 'paused'); assert.equal(out.walk.under, 'waiting');
  tick(300); out = await tap('ospeli_walks_resume');             // 300 s not seen
  assert.equal(out.walk.state, 'waiting'); assert.equal(out.walk.sinceNotSeenSec, 300);
  tick(50); await tap('ospeli_walks_step_start');               // 50 s more waiting: wait 150, not seen 300
  tick(60); out = await tap('ospeli_walks_pause');               // 60 s hands-on seen
  assert.equal(out.walk.under, 'step');
  tick(120); out = await tap('ospeli_walks_resume');             // 120 s not seen inside the step
  assert.equal(out.walk.state, 'step');
  tick(30); await tap('ospeli_walks_step_done');                // 30 s more: work 90, not seen 120
  await tap('ospeli_walks_step_name', { name: 'Seen by a nurse', role: 'Nurse' });
  tick(200); await tap('ospeli_walks_step_start');              // a plain wait of 200 s
  tick(40); await tap('ospeli_walks_step_done');
  await tap('ospeli_walks_step_name', { name: 'Seen by a doctor', role: 'Doctor' });
  const done = await tap('ospeli_walks_finish');
  assert.deepEqual(validate(commandByName('ospeli_walks_finish').output, done, 'output'), []);

  // Recomputed here from the stored taps, not from the command's own output.
  const w = (await stored(core))[0];
  assert.equal(w.pauses.length, 2);
  const paused = w.pauses.map((p) => secs(p.startAt, p.endAt));
  assert.deepEqual(paused, [300, 120]);
  const gap1 = secs(w.startedAt, w.steps[0].startAt); const work1 = secs(w.steps[0].startAt, w.steps[0].endAt);
  assert.equal(gap1 - paused[0], 150); assert.equal(work1 - paused[1], 90);
  assert.deepEqual(done.walk.steps.map((s) => [s.waitSec, s.workSec, s.waitNotSeenSec ?? 0, s.workNotSeenSec ?? 0]), [[150, 90, 300, 120], [200, 40, 0, 0]]);
  assert.deepEqual(done.walk.totals, { steps: 2, workSec: 130, waitSec: 350, notSeenSec: 420, elapsedSec: 900 });
  assert.equal(done.walk.totals.workSec + done.walk.totals.waitSec + done.walk.totals.notSeenSec, done.walk.totals.elapsedSec, 'the three parts add up to start to finish');

  const map = await tap('ospeli_maps_get', { mapId: done.mapId });
  assert.deepEqual(validate(commandByName('ospeli_maps_get').output, map, 'output'), []);
  assert.equal(map.walk.notSeenSec, 420);
  const sec = map.today.statsSec;
  assert.equal(sec.wait, 350); assert.equal(sec.work, 130); assert.equal(sec.notSeenSec, 420);
  assert.equal(sec.elapsed + sec.notSeenSec, 900, 'start to finish keeps the time not seen');
  // The waiting share is of the observed time only: 350 of 480, not 350 of 900 and not 650 of 900.
  assert.equal(sec.waitShare, 73); assert.equal(waitShareOf(350, 130), 73);
  // The first wait (150 s seen) was partly not seen, so it is never the longest wait; the 200 s one is.
  const top = longestWaits(stepsInSeconds(map.today.steps));
  assert.deepEqual(top.map((x) => x.name), ['Seen by a doctor']);
  const sum = await tap('ospeli_maps_summary', { mapId: done.mapId });
  assert.equal(sum.biggestWait.name, 'Seen by a doctor');
  const notes = (await tap('ospeli_maps_suggest', { mapId: done.mapId, version: 'today' })).suggestions;
  const seen = notes.find((n) => n.id === 'walk-not-seen');
  assert.match(seen.title, /^7 min of this walk was not seen$/);
  assert.match(seen.basis, /^Local definition/);
});

test('a wait that was partly not seen is not named even when it is the only long wait', async () => {
  const { tick, tap } = await setup();
  await tap('ospeli_walks_start');
  tick(400); await tap('ospeli_walks_pause'); tick(10); await tap('ospeli_walks_resume');
  tick(5); await tap('ospeli_walks_step_start'); tick(20); await tap('ospeli_walks_step_done');
  const { mapId } = await tap('ospeli_walks_finish');
  const sum = await tap('ospeli_maps_summary', { mapId });
  assert.equal(sum.biggestWait, null);
  assert.ok(!sum.suggestions.some((s) => /^Longest wait/.test(s.title)));
});

test('while paused nothing else can be tapped, and a pause or a coming back can be undone', async () => {
  const { tick, tap } = await setup();
  await tap('ospeli_walks_start');
  await assert.rejects(tap('ospeli_walks_resume'), code('conflict'));
  tick(10); await tap('ospeli_walks_step_start');
  tick(10); await tap('ospeli_walks_pause');
  await assert.rejects(tap('ospeli_walks_pause'), code('conflict'));
  await assert.rejects(tap('ospeli_walks_step_done'), (e) => e.code === 'conflict' && e.detail.state === 'paused' && /paused/.test(e.message));
  await assert.rejects(tap('ospeli_walks_finish'), (e) => e.code === 'conflict' && e.detail.state === 'paused');
  // Undo the pause: the step runs on as if Pause had not been tapped.
  let out = await tap('ospeli_walks_undo');
  assert.equal(out.undone, 'pause'); assert.equal(out.walk.state, 'step');
  tick(10); await tap('ospeli_walks_pause'); tick(30); await tap('ospeli_walks_resume');
  // Undo the coming back: paused again, from the same moment.
  out = await tap('ospeli_walks_undo');
  assert.equal(out.undone, 'resume'); assert.equal(out.walk.state, 'paused');
  tick(30); await tap('ospeli_walks_resume');
  tick(10); out = await tap('ospeli_walks_step_done');
  // Step: 10 + 10 seen, 60 not seen, 10 seen.
  assert.deepEqual([out.walk.steps[0].workSec, out.walk.steps[0].workNotSeenSec], [30, 60]);
});

test('a planned or required wait still counts as waiting, is left out of the longest wait, and is kept on both versions', async () => {
  const { core, tick, tap } = await setup();
  await tap('ospeli_walks_start');
  tick(600); await tap('ospeli_walks_step_start'); tick(60); await tap('ospeli_walks_step_done');
  await tap('ospeli_walks_step_name', { name: 'Test or scan done', role: 'Laboratory' });
  tick(240); await tap('ospeli_walks_step_start'); tick(60); await tap('ospeli_walks_step_done');
  await tap('ospeli_walks_step_name', { name: 'Seen by a doctor', role: 'Doctor' });
  const { mapId } = await tap('ospeli_walks_finish');
  let map = await tap('ospeli_maps_get', { mapId });
  assert.equal((await tap('ospeli_maps_summary', { mapId })).biggestWait.name, 'Test or scan done');
  const stepId = map.today.steps[0].id;
  const out = await tap('ospeli_maps_step_update', { mapId, version: 'today', stepId, plannedWait: true, expectedRevision: map.revision });
  assert.equal(out.status, 'done');
  map = await tap('ospeli_maps_get', { mapId });
  assert.deepEqual(validate(commandByName('ospeli_maps_get').output, map, 'output'), []);
  assert.equal(map.today.steps[0].plannedWait, true);
  assert.equal(map.proposed.steps[0].plannedWait, true, 'the mark is a fact about the step, so Proposed carries it too');
  assert.equal(map.changed, false, 'marking a wait is not a proposed change');
  // Total waiting is unchanged; the measured seconds are untouched; nothing was "changed by hand".
  assert.equal(map.today.statsSec.wait, 840); assert.equal(map.today.statsSec.plannedWaitSec, 600);
  assert.equal(map.today.steps[0].waitSec, 600); assert.equal(map.today.steps[0].edited, undefined);
  const sum = await tap('ospeli_maps_summary', { mapId });
  assert.equal(sum.biggestWait.name, 'Seen by a doctor', 'the longest wait is now the longest one nobody planned');
  const notes = (await tap('ospeli_maps_suggest', { mapId, version: 'today' })).suggestions;
  const planned = notes.find((n) => n.id === 'walk-planned');
  assert.match(planned.title, /^1 wait is marked planned or required: 10 min$/);
  assert.match(planned.text, /Waiting is not always waste/);
  assert.match(planned.basis, /Ospeli keeps no list of such waits/);
  // The mark comes off again, and the audit trail has both changes as a person's.
  map = await tap('ospeli_maps_get', { mapId });
  await tap('ospeli_maps_step_update', { mapId, version: 'today', stepId, plannedWait: false, expectedRevision: map.revision });
  map = await tap('ospeli_maps_get', { mapId });
  assert.equal(map.today.steps[0].plannedWait, undefined); assert.equal(map.proposed.steps[0].plannedWait, undefined);
  assert.equal((await tap('ospeli_maps_summary', { mapId })).biggestWait.name, 'Test or scan done');
  const audit = (await core.auditLog()).filter((a) => a.action === 'map.step-updated');
  assert.equal(audit.length, 2); assert.ok(audit.every((a) => a.actorType === 'human'));
});

test('pause and resume are people only, like every tap on a walk; an agent may propose a planned-wait mark but a person decides', async () => {
  const { core, tick, tap } = await setup();
  await runCommand(core, 'ospeli_agents_set_access', { allowed: true }, { type: 'human', role: 'coo' });
  await runCommand(core, 'ospeli_agents_add', { name: 'flow-bot', role: 'ops-manager', days: 30 }, { type: 'human', role: 'coo' });
  const bot = { type: 'agent', role: 'ops-manager', agent: 'flow-bot' };
  await tap('ospeli_walks_start');
  for (const name of ['ospeli_walks_pause', 'ospeli_walks_resume']) {
    assert.equal(commandByName(name).agents, false);
    await assert.rejects(runCommand(core, name, {}, bot), code('forbidden'));
  }
  tick(100); await tap('ospeli_walks_step_start'); tick(20); await tap('ospeli_walks_step_done');
  const { mapId } = await tap('ospeli_walks_finish');
  const map = await tap('ospeli_maps_get', { mapId });
  const res = await runCommand(core, 'ospeli_maps_step_update', { mapId, version: 'today', stepId: map.today.steps[0].id, plannedWait: true, expectedRevision: map.revision }, bot).catch((e) => e);
  const after = await tap('ospeli_maps_get', { mapId });
  assert.equal(after.today.steps[0].plannedWait, undefined, `an agent's call records nothing by itself (${res.status || res.code})`);
});
