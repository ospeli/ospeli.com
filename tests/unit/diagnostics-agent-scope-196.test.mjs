// Issue #196 (Critic, 28 Nov): an agent with every ward is given a different rejection rate and
// turnaround from the manager's screen, because requests from a department (the emergency
// department) are left out of every figure it gets, and nothing in the answer says so.
// The fix says it in words: each agent read names the places it leaves out, and the measures it
// returns are named "wards only". A person's answer is unchanged. Synthetic data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { site, agent } from './sec-diagnostics-helper.mjs';
import { commandByName } from '../../web/app/core/commands.js';

async function withAgent() {
  const s = await site();
  const wards = (await s.core.listEntities('ward')).map((w) => w.id);
  await s.run('ospeli_agents_set_access', { allowed: true, wards: Object.fromEntries(wards.map((w) => [w, true])) }, 'coo');
  await s.run('ospeli_agents_add', { name: 'dx-bot', role: 'lab-reception', wards, days: 30 }, 'coo');
  return s;
}

test('#196: an agent\'s diagnostics overview names the places it leaves out and calls its measures "wards only"; a person\'s is unchanged', async () => {
  const { run } = await withAgent();
  const person = await run('ospeli_diagnostics_overview', {}, 'diagnostics-manager');
  const bot = await run('ospeli_diagnostics_overview', {}, agent('lab-reception'));
  const pr = person.kpis.find((k) => k.id === 'specimen-rejection-rate');
  const br = bot.kpis.find((k) => k.id === 'specimen-rejection-rate');
  assert.ok(br.denominator < pr.denominator, 'the example has department requests the agent is not given (the cause stays: #117)');
  assert.equal(person.scope, undefined, 'a person sees every place: no scope line');
  assert.equal(pr.name.includes('wards only'), false);
  assert.ok(bot.scope, 'the agent is told its figures are narrower');
  assert.equal(bot.scope.wardsOnly, true);
  assert.ok(bot.scope.leftOut.includes('Emergency department'), `left out: ${JSON.stringify(bot.scope.leftOut)}`);
  assert.match(bot.scope.note, /wards you were given/);
  assert.match(bot.scope.note, /Emergency department/);
  for (const k of bot.kpis) assert.match(k.name, /\(wards only\)$/, `${k.id} is named for what it covers`);
  const schema = commandByName('ospeli_diagnostics_overview').output;
  assert.ok(schema.properties.scope, 'the schema says what scope is');
});

test('#196: the agent\'s request list and specimen log say the same; with nothing left out there is no scope line', async () => {
  const { run } = await withAgent();
  for (const name of ['ospeli_diagnostics_requests_list', 'ospeli_diagnostics_specimen_log']) {
    const out = await run(name, {}, agent('lab-reception'));
    assert.ok(out.scope?.leftOut.includes('Emergency department'), `${name}: ${JSON.stringify(out.scope)}`);
    assert.equal((await run(name, {}, 'lab-reception')).scope, undefined, `${name}: a person sees no scope line`);
    assert.ok(commandByName(name).output.properties.scope, `${name}: in the schema`);
  }
  // Asking for one ward: nothing of that ward is left out, so nothing is said.
  const one = await run('ospeli_diagnostics_requests_list', { sourceId: 'ward-a2' }, agent('lab-reception'));
  assert.equal(one.scope, undefined);
});
