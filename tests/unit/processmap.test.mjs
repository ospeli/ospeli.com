// Process maps (backlog PM1): every action runs as a command without the UI. The guide is
// rule-based and explainable, trying a suggestion changes only Proposed, agents only propose,
// and the guide has an off switch that leaves everything else working.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Core } from '../../web/app/core/core.js';
import { MemoryAdapter } from '../../web/app/core/db.js';
import { runCommand, commandByName, CommandError } from '../../web/app/core/commands.js';
import { validate } from '../../web/app/core/schema.js';
import { analyse, suggest, applyChange, stepsFromExample, EXAMPLES, personalDetailIn } from '../../web/app/core/processmap.js';

const NOW = '2026-11-10T09:00:00.000Z';
const clockFrom = (iso) => { let t = Date.parse(iso); return () => new Date(t += 1000); };
const human = (role) => ({ type: 'human', role });
const agent = (role, name = 'map-helper') => ({ type: 'agent', role, agent: name });
const code = (c) => (err) => err instanceof CommandError && err.code === c;
const ok = (name, out) => assert.deepEqual(validate(commandByName(name).output, out, 'output'), []);
const run = (core, name, input, actor = human('ops-manager')) => runCommand(core, name, input, actor);
const fresh = () => Core.open({ adapter: new MemoryAdapter(), clock: clockFrom(NOW) });

test('analysis: start to finish counts steps that run alongside once, waits and handoffs add up', () => {
  const steps = [
    { id: 'a', name: 'A', role: 'Nurse', wait: 0, work: 10 },
    { id: 'b', name: 'B', role: 'Doctor', wait: 20, work: 10 },
    { id: 'c', name: 'C', role: 'Lab', wait: 5, work: 30, par: true },
    { id: 'd', name: 'D', role: 'Lab', wait: 0, work: 5 },
  ];
  const a = analyse(steps);
  // A 0-10; B 30-40; C starts alongside B: 35-65; D after: 65-70.
  assert.equal(a.elapsed, 70);
  assert.equal(a.work, 55);
  assert.equal(a.wait, 25);
  assert.equal(a.handoffs, 2);
  assert.equal(a.biggestWaitStepId, 'b');
  assert.deepEqual(a.roles, ['Nurse', 'Doctor', 'Lab']);
});

test('the guide explains every suggestion, and trying one changes a copy only', () => {
  for (const key of Object.keys(EXAMPLES)) {
    const steps = stepsFromExample(key, 'map-001');
    const out = suggest(steps);
    assert.ok(out.length >= 2, key);
    for (const s of out) assert.ok(s.title && s.text && s.why, `${key}: ${s.id} explains itself`);
    const tryable = out.filter((s) => s.change);
    assert.ok(tryable.length >= 1, `${key} has something to try`);
    const before = JSON.stringify(steps);
    for (const s of tryable) {
      const next = applyChange(steps, s.change);
      assert.ok(analyse(next).elapsed <= analyse(steps).elapsed, `${key}: ${s.id} never makes the what-if longer`);
    }
    assert.equal(JSON.stringify(steps), before, 'the original list is untouched');
  }
  assert.equal(suggest([])[0].id, 'start');
});

test('free text refuses personal details', () => {
  assert.equal(personalDetailIn('Bed cleaned'), null);
  assert.equal(personalDetailIn('Call 0700 123 4567'), 'a phone or ID number');
  assert.equal(personalDetailIn('email nurse@example.org'), 'an email address');
  assert.equal(personalDetailIn('born 12/03/1970'), 'a date');
});

test('a person maps a process end to end with commands only', async () => {
  const core = await fresh();
  const empty = await run(core, 'maps.list', {});
  ok('maps.list', empty);
  assert.deepEqual(empty.maps, []);
  assert.equal(empty.guideOn, true);
  assert.equal(empty.examples.length, 3);

  const c = await run(core, 'map.create', { from: 'discharge' }, human('ward-nurse'));
  ok('map.create', c);
  assert.equal(c.mapId, 'map-001');
  const m = await run(core, 'map.get', { mapId: 'map-001' });
  ok('map.get', m);
  assert.equal(m.today.steps.length, 10);
  assert.equal(m.changed, false);
  assert.equal(m.today.stats.elapsed, m.proposed.stats.elapsed);

  const add = await run(core, 'map.step.add', { mapId: 'map-001', name: 'Family told the time to collect', role: 'Nurse', wait: 10, work: 3, position: 2, expectedRevision: m.revision });
  ok('map.step.add', add);
  const m2 = await run(core, 'map.get', { mapId: 'map-001' });
  assert.equal(m2.today.steps[1].id, add.stepId);
  assert.equal(m2.proposed.steps.length, 10, 'editing Today leaves Proposed alone');
  await run(core, 'map.step.update', { mapId: 'map-001', stepId: add.stepId, wait: 0 });
  await run(core, 'map.step.move', { mapId: 'map-001', stepId: add.stepId, direction: 'down' });
  const m3 = await run(core, 'map.get', { mapId: 'map-001' });
  assert.equal(m3.today.steps[2].id, add.stepId);
  assert.equal(m3.today.steps[2].wait, 0);
  await assert.rejects(run(core, 'map.step.move', { mapId: 'map-001', stepId: 'map-001-s1', direction: 'up' }), code('invalid-input'));
  await run(core, 'map.step.remove', { mapId: 'map-001', stepId: add.stepId });
  assert.equal((await run(core, 'map.get', { mapId: 'map-001', format: 'short' })).today.stats.steps, 10);

  // A stale writer is refused instead of overwriting someone else's change.
  await assert.rejects(run(core, 'map.step.update', { mapId: 'map-001', stepId: 'map-001-s2', wait: 1, expectedRevision: 1 }), code('conflict'));
  // Personal details are refused with a fix.
  await assert.rejects(run(core, 'map.step.add', { mapId: 'map-001', name: 'Ring 0700 123 4567', role: 'Nurse' }), (e) => e.code === 'invalid-input' && /personal details/.test(e.message));
  await assert.rejects(run(core, 'map.get', { mapId: 'map-099' }), (e) => e.code === 'not-found' && /maps\.list/.test(e.message));
});

test('trying a suggestion changes Proposed only; reset brings Today back', async () => {
  const core = await fresh();
  await run(core, 'map.create', { from: 'fault' });
  const s = await run(core, 'map.suggest', { mapId: 'map-001', version: 'proposed' });
  ok('map.suggest', s);
  const t = s.suggestions.find((x) => x.tryable);
  assert.ok(t);
  const before = await run(core, 'map.get', { mapId: 'map-001' });
  await run(core, 'map.try-suggestion', { mapId: 'map-001', suggestionId: t.id });
  const after = await run(core, 'map.get', { mapId: 'map-001' });
  assert.deepEqual(after.today, before.today, 'Today never changes');
  assert.ok(after.proposed.stats.elapsed < before.proposed.stats.elapsed);
  assert.equal(after.changed, true);
  assert.deepEqual(after.tried, [t.id]);
  assert.ok((await run(core, 'map.suggest', { mapId: 'map-001', version: 'proposed' })).suggestions.find((x) => x.id === t.id)?.tried !== false);
  await assert.rejects(run(core, 'map.try-suggestion', { mapId: 'map-001', suggestionId: 'questions' }), (e) => e.code === 'invalid-input' && /Try one of/.test(e.message));

  await run(core, 'map.hide-suggestion', { mapId: 'map-001', suggestionId: 'questions' });
  const hid = await run(core, 'map.suggest', { mapId: 'map-001' });
  assert.equal(hid.hidden, 1);
  assert.ok(!hid.suggestions.some((x) => x.id === 'questions'));

  await run(core, 'map.reset-proposed', { mapId: 'map-001' });
  const back = await run(core, 'map.get', { mapId: 'map-001' });
  assert.deepEqual(back.proposed, back.today);
  assert.equal(back.changed, false);
  assert.equal((await run(core, 'map.suggest', { mapId: 'map-001' })).hidden, 0);
});

test('the guide has an off switch; maps and editing work without it', async () => {
  const core = await fresh();
  await run(core, 'map.create', { from: 'ed' });
  const off = await run(core, 'map.guide.set', { on: false }, human('ward-nurse'));
  ok('map.guide.set', off);
  const s = await run(core, 'map.suggest', { mapId: 'map-001' });
  assert.deepEqual(s, { guideOn: false, hidden: 0, suggestions: [] });
  assert.equal((await run(core, 'maps.list', {})).guideOn, false);
  await run(core, 'map.step.update', { mapId: 'map-001', stepId: 'map-001-s2', work: 12 });
  assert.equal((await run(core, 'map.get', { mapId: 'map-001' })).today.steps[1].work, 12);
  await run(core, 'map.guide.set', { on: true });
  assert.ok((await run(core, 'map.suggest', { mapId: 'map-001' })).suggestions.length > 0);
});

test('agents read and propose; a person accepts; every change is audited', async () => {
  const core = await fresh();
  await run(core, 'map.create', { from: 'discharge' });
  await assert.rejects(run(core, 'maps.list', {}, agent('ops-manager')), code('agents-off'));
  await run(core, 'agents.set-access', { allowed: true }, human('ops-manager'));
  await run(core, 'agent.add', { name: 'map-helper', role: 'ops-manager', days: 30 }, human('ops-manager'));
  const read = await run(core, 'map.suggest', { mapId: 'map-001', version: 'proposed' }, agent('ops-manager'));
  const t = read.suggestions.find((x) => x.tryable);
  const p = await run(core, 'map.try-suggestion', { mapId: 'map-001', suggestionId: t.id }, agent('ops-manager'));
  assert.equal(p.status, 'proposed');
  assert.equal(p.mapId, 'map-001');
  assert.equal((await run(core, 'map.get', { mapId: 'map-001' })).changed, false, 'nothing changes until a person accepts');
  await assert.rejects(run(core, 'map.guide.set', { on: false }, agent('ops-manager')), code('agents-off'));

  const acc = await run(core, 'proposal.accept', { id: p.proposal.id }, human('ops-manager'));
  assert.equal(acc.status, 'accepted');
  assert.equal((await run(core, 'map.get', { mapId: 'map-001' })).changed, true);

  // A proposal made against an older revision expires instead of acting on a changed map.
  const p2 = await run(core, 'map.step.update', { mapId: 'map-001', stepId: 'map-001-s1', work: 9 }, agent('ops-manager'));
  await run(core, 'map.step.update', { mapId: 'map-001', stepId: 'map-001-s1', work: 7 });
  const exp = await run(core, 'proposal.accept', { id: p2.proposal.id }, human('ops-manager'));
  assert.equal(exp.status, 'expired');
  assert.equal((await run(core, 'map.get', { mapId: 'map-001' })).today.steps[0].work, 7);

  const audit = await core.auditLog();
  const actions = audit.map((a) => `${a.actorType}:${a.action}`);
  for (const a of ['human:map.created', 'agent:agent.read', 'agent:agent.proposed', 'human:map.suggestion-tried', 'human:map.step-updated', 'agent:agent.refused']) {
    assert.ok(actions.includes(a), `audit has ${a}`);
  }
  assert.ok(!JSON.stringify(audit).includes('Senior doctor'), 'the audit holds ids, not free text');
  assert.equal((await core.verifyAudit()).ok, true);
});

test('reset removes maps from the device', async () => {
  const core = await fresh();
  await run(core, 'map.create', { from: 'blank', title: 'Clinic check-in' });
  assert.equal((await run(core, 'maps.list', {})).maps[0].title, 'Clinic check-in');
  await core.reset();
  assert.deepEqual((await run(core, 'maps.list', {})).maps, []);
});

test('maps time steps, never people: a named person is refused as a step, a role or a title (#38)', async () => {
  const core = await fresh();
  await run(core, 'map.create', { from: 'blank', title: 'Clinic visit' });
  const id = (await run(core, 'maps.list', {})).maps[0].id;
  const step = { mapId: id, name: 'Reviews the patient', role: 'Doctor', wait: 5, work: 10 };
  const named = (err) => code('invalid-input')(err) && /role, not a person/.test(err.message);
  for (const actor of [human('ops-manager')]) {
    await assert.rejects(run(core, 'map.step.add', { ...step, name: 'Dr Sarah Jones reviews the patient' }, actor), named);
    await assert.rejects(run(core, 'map.step.add', { ...step, role: 'Sister Mary Brown' }, actor), named);
    await assert.rejects(run(core, 'map.step.add', { ...step, role: 'Mary Brown' }, actor), named);
  }
  await assert.rejects(run(core, 'map.create', { from: 'blank', title: 'Mr Patel\'s clinic' }), named);
  // Roles in the site's own words still pass, in any capitals.
  for (const role of ['Doctor', 'Charge Nurse', 'Nurse Manager', 'Patient Transport', 'Reception', 'Senior Doctor', 'Patient and family']) {
    assert.equal((await run(core, 'map.step.add', { ...step, role })).status, 'done', role);
  }
  const added = (await run(core, 'map.get', { mapId: id })).today.steps[0];
  await assert.rejects(run(core, 'map.step.update', { mapId: id, stepId: added.id, name: 'Nurse Amina checks in' }), named);
  await assert.rejects(run(core, 'map.step.update', { mapId: id, stepId: added.id, role: 'Dr. O\'Neil' }), named);
  // An agent's proposal is checked the same way before it is ever queued.
  await run(core, 'agents.set-access', { allowed: true }, human('ops-manager'));
  await run(core, 'agent.add', { name: 'map-helper', role: 'ops-manager', days: 30 }, human('ops-manager'));
  await assert.rejects(run(core, 'map.step.add', { ...step, role: 'Sister Mary Brown' }, agent('ops-manager')), named);
  assert.equal((await run(core, 'proposals.list', {})).proposals.length, 0);
});
