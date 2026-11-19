// Issue ospeli/ospeli#135: four small things on the agent surface. Synthetic hospital only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { site } from './review-helper.mjs';
import { validate } from '../../web/app/core/schema.js';
import { commandByName } from '../../web/app/core/commands.js';

// Two agents, for the patient flow coordinator and the emergency department nurse in charge, both
// listed for the one ward that has a free bed in the synthetic hospital.
async function twoAgentsOnAFreeWard() {
  const s = await site();
  const all = await s.run('ospeli_beds_board', { format: 'detailed' }, 'bed-manager');
  const bed = all.beds.find((b) => b.state === 'available');
  const enc = all.waiting.find((w) => !w.allocatedBed)?.encounter;
  assert.ok(bed && enc, 'a free bed and a waiting patient in the synthetic hospital');
  await s.run('ospeli_agents_set_access', { allowed: true, wards: { [bed.wardId]: true } }, 'coo');
  const bot = {};
  for (const role of ['bed-manager', 'ae-nic']) {
    await s.run('ospeli_agents_add', { name: `${role}-agent`, role, wards: [bed.wardId], days: 30 }, 'coo');
    bot[role] = { type: 'agent', agent: `${role}-agent`, role };
  }
  return { ...s, bot, input: { bedId: bed.id, encounter: enc, expectedState: 'available' } };
}

test('#135.1: a refused unknown input says what the command does take', async () => {
  const { run } = await site();
  await assert.rejects(run('ospeli_beds_find_free', { format: 'short' }, 'bed-manager'), (e) => {
    assert.equal(e.code, 'invalid-input');
    assert.match(e.message, /input\.format is not allowed/);
    const takes = Object.keys(commandByName('ospeli_beds_find_free').input.properties);
    assert.match(e.message, new RegExp(`This takes: ${takes.join(', ')}\\.`), e.message);
    return true;
  });
  // The same for a nested object: the stock line names what a line takes.
  const errs = validate({ type: 'object', additionalProperties: false, properties: { a: { type: 'integer' }, b: { type: 'string' } } }, { c: 1 });
  assert.deepEqual(errs, ['input.c is not allowed. This takes: a, b.']);
  assert.deepEqual(validate({ type: 'object', additionalProperties: false, properties: {} }, { c: 1 }), ['input.c is not allowed. This takes no input.']);
});

test('#135.2: the short bed board says the bed list was left out, and how to get it', async () => {
  const { run } = await site();
  const out = await run('ospeli_beds_board', { wardId: 'ward-a1', format: 'short' }, 'bed-manager');
  assert.deepEqual(out.beds, []);
  assert.equal(out.bedsOmitted, true, 'a short answer with total 20 and no beds says why');
  assert.match(out.note, /format "detailed"/);
  assert.deepEqual(validate(commandByName('ospeli_beds_board').output, out, 'output'), []);
  const full = await run('ospeli_beds_board', { wardId: 'ward-a1' }, 'bed-manager');
  assert.equal(full.bedsOmitted, undefined);
  assert.equal(full.beds.length, full.total);
});

// Not changed tonight: the #72 rule (and its tests, and the site server's Idempotency-Key test) says
// "another agent may still propose for the same bed: the limit is per agent". Changing it is a choice
// about the decision line (#47), so this waits; see the comment on #135.
test('#135.3: a second agent asking for the same bed for the same patient gets the proposal already waiting', { todo: 'needs a decision: the #72 per-agent rule says another agent may propose for the same bed (#135, #47)' }, async () => {
  const { run, bot, core, input } = await twoAgentsOnAFreeWard();
  const a = await run('ospeli_beds_allocate', input, bot['bed-manager']);
  const b = await run('ospeli_beds_allocate', input, bot['ae-nic']);
  assert.equal(a.status, 'proposed');
  assert.equal(b.status, 'proposed');
  assert.equal(b.existing, true, 'the second agent is told it is already waiting');
  assert.equal(b.proposal.id, a.proposal.id);
  assert.equal(b.proposal.agent, 'bed-manager-agent', 'with the first agent\'s name');
  const pending = (await core.proposals()).filter((p) => p.status === 'pending');
  assert.equal(pending.length, 1, 'a person answers once');
  const trail = (await core.auditLog()).filter((x) => x.action === 'agent.proposed-again');
  assert.equal(trail.length, 1, 'the second call still leaves a trace');
});

test('#135.4: people meet one word, "agent", never "bot"', () => {
  const src = readFileSync(new URL('../../web/app/modules/proposals.js', import.meta.url), 'utf8');
  const strings = src.match(/(['`])(?:(?!\1)[^\\]|\\.)*\1/g) || [];
  assert.deepEqual(strings.filter((s) => /\bbots?\b/i.test(s)), []);
});
