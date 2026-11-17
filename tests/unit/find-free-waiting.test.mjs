// Issue #76: ospeli_beds_find_free listed only the three longest waits, with no way to see more,
// and a wardId did not bring forward the patients waiting for that ward, so the one match an agent
// asked for was missing and nextStep was null.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Core } from '../../web/app/core/core.js';
import { MemoryAdapter } from '../../web/app/core/db.js';
import { loadSyntheticHospital } from '../../web/app/core/generator.js';
import { runCommand, commandByName } from '../../web/app/core/commands.js';
import { validate } from '../../web/app/core/schema.js';

const END = '2026-11-08T12:00:00.000Z';
const human = (role) => ({ type: 'human', role });
const ok = (out) => assert.deepEqual(validate(commandByName('ospeli_beds_find_free').output, out, 'output'), []);

async function setup() {
  let t = Date.parse(END);
  const core = await Core.open({ adapter: new MemoryAdapter(), clock: () => new Date(t += 1000) });
  await loadSyntheticHospital(core, { end: END });
  const find = (input) => runCommand(core, 'ospeli_beds_find_free', input, human('bed-manager'));
  const board = await runCommand(core, 'ospeli_beds_board', {}, human('bed-manager'));
  const queue = board.waiting.filter((x) => !x.allocatedBed).sort((a, b) => (a.decisionAt < b.decisionAt ? -1 : 1));
  const free = new Set(board.beds.filter((b) => b.state === 'available').map((b) => b.wardId));
  return { core, find, queue, free };
}

test('#76: wardId lists the patients waiting for that ward first and offers the next step for them', async () => {
  const { find, queue, free } = await setup();
  // A ward with a free bed whose waiting patient is not among the three longest waits.
  const late = queue.slice(3).find((x) => x.wardId && free.has(x.wardId));
  assert.ok(late, 'the seeded hospital has a patient beyond the first three, waiting for a ward with a free bed');
  const out = await find({ wardId: late.wardId });
  ok(out);
  assert.equal(out.waiting[0].encounter, late.encounter, 'the patient waiting for this ward comes first');
  assert.equal(out.beds[0].wardId, late.wardId);
  assert.deepEqual(out.nextStep, { command: 'ospeli_beds_allocate', input: { bedId: out.beds[0].bedId, encounter: late.encounter, expectedState: 'available' } });
  assert.match(out.order, /requested for this ward/);
  // Within each group, longest wait first.
  const rest = out.waiting.filter((x) => x.wardId !== late.wardId);
  for (let i = 1; i < rest.length; i++) assert.ok(rest[i - 1].decisionAt <= rest[i].decisionAt);
});

test('#76: waitingLimit shows more of the queue, and waitingTruncated says when the list was cut', async () => {
  const { find, queue } = await setup();
  assert.ok(queue.length > 3, 'more than three patients waiting');
  const short = await find({});
  ok(short);
  assert.equal(short.waiting.length, 3, 'three by default, as before');
  assert.equal(short.waitingTruncated, true);
  assert.match(short.note, /waitingLimit/);
  const all = await find({ waitingLimit: 20 });
  ok(all);
  assert.equal(all.waiting.length, queue.length);
  assert.equal(all.totalWaiting, queue.length);
  assert.equal(all.waitingTruncated, false);
  assert.deepEqual(all.waiting.map((x) => x.encounter), queue.map((x) => x.encounter), 'longest wait first');
  const one = await find({ forEncounter: queue[0].encounter });
  assert.equal(one.waitingTruncated, false, 'one patient asked for: nothing cut');
  // The schema names the new input with its bounds.
  const p = commandByName('ospeli_beds_find_free').input.properties.waitingLimit;
  assert.deepEqual([p.type, p.minimum, p.maximum], ['integer', 1, 20]);
  assert.ok(p.description.length > 20);
});

test('#76: nextStep uses the first listed patient a listed bed fits, not only the longest wait', async () => {
  const { find, queue, free } = await setup();
  // With no ward given, the longest wait may have no free bed on their ward; a later patient may.
  const out = await find({ limit: 20, waitingLimit: 20 });
  ok(out);
  const fit = out.waiting.find((x) => !x.wardId || out.beds.some((b) => b.wardId === x.wardId));
  if (!fit) { assert.equal(out.nextStep, null); return; }
  const bed = out.beds.find((b) => !fit.wardId || b.wardId === fit.wardId);
  assert.deepEqual(out.nextStep, { command: 'ospeli_beds_allocate', input: { bedId: bed.bedId, encounter: fit.encounter, expectedState: 'available' } });
  assert.ok(queue.some((x) => free.has(x.wardId)));
});

test('#76 journey: an agent on one ward finds the patient waiting for it and proposes the bed, in 2 calls', async () => {
  const { core, queue, free } = await setup();
  const late = queue.slice(3).find((x) => x.wardId && free.has(x.wardId));
  const ward = late.wardId;
  await runCommand(core, 'ospeli_agents_set_access', { allowed: true, wards: { [ward]: true } }, human('ops-manager'));
  await runCommand(core, 'ospeli_agents_add', { name: 'flow-helper', role: 'bed-manager', wards: [ward], days: 30 }, human('ops-manager'));
  const agent = (cmd, input) => runCommand(core, cmd, input, { type: 'agent', agent: 'flow-helper', role: 'bed-manager' });
  const out = await agent('ospeli_beds_find_free', { wardId: ward });
  ok(out);
  assert.equal(out.waiting[0].encounter, late.encounter);
  const res = await agent(out.nextStep.command, out.nextStep.input);
  assert.equal(res.status, 'proposed', 'a person still decides');
});
