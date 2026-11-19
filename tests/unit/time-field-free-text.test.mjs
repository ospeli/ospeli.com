// Finding: a time field (schema format "date-time", kit.js TIME) is checked only with Date.parse and has
// no maxLength. Date.parse reads "7 Nov 2026 10:00 UTC (any words here)" as a time, so typed text of any
// length rides in a time field past the schema and past the personal-detail check (which is only asked
// to read fields with no format). New today: ospeli_transfers_request.bookedFor (the text is kept in the
// proposal queue and in the audit entry agent.proposed) and ospeli_facilities_log_list.since (kept in the
// audit entry agent.read). Everything here is made up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Core } from '../../web/app/core/core.js';
import { MemoryAdapter } from '../../web/app/core/db.js';
import { loadSyntheticHospital } from '../../web/app/core/generator.js';
import { runCommand, commandByName } from '../../web/app/core/commands.js';

const END = '2026-11-06T18:00:00.000Z';
const TYPED = 'call Mr Test Person on 07700 900123';
async function site() {
  let t = Date.parse(END);
  const core = await Core.open({ adapter: new MemoryAdapter(), clock: () => new Date(t += 1000) });
  await loadSyntheticHospital(core, { end: END });
  const run = (name, input, who) => runCommand(core, name, input, typeof who === 'string' ? { type: 'human', role: who } : who);
  await run('ospeli_agents_set_access', { allowed: true, wards: { 'ward-a2': true } }, 'coo');
  const bot = {};
  for (const role of ['ward-nurse', 'estates-tech']) {
    await run('ospeli_agents_add', { name: `${role}-bot`, role, wards: ['ward-a2'], days: 30 }, 'coo');
    bot[role] = { type: 'agent', agent: `${role}-bot`, role };
  }
  return { core, run, bot };
}

test('an agent cannot put typed text into the proposal queue or the audit trail through bookedFor', async () => {
  const { core, run, bot } = await site();
  const input = { type: 'discharge', fromPlace: 'ward-a2', toOutside: 'home', needed: 'booked', bookedFor: `7 Nov 2026 10:00 UTC (${TYPED})`, mobility: 'walks', escort: 'none', equipment: ['none'] };
  let err = null;
  try { await run('ospeli_transfers_request', input, bot['ward-nurse']); } catch (e) { err = e; }
  const queue = JSON.stringify(await core.proposals());
  const trail = JSON.stringify(await core.auditLog());
  assert.ok(!queue.includes('07700'), `the proposal queue holds the typed text: ${JSON.stringify((await core.proposals()).at(-1)?.input?.bookedFor)}`);
  assert.ok(!trail.includes('Test Person'), 'the audit trail holds the typed text');
  assert.equal(err?.code, 'invalid-input', 'a time field that is not a plain time stamp is refused');
});

test('an agent read does not store typed text in the audit trail through a time filter (since)', async () => {
  const { core, run, bot } = await site();
  let err = null;
  try { await run('ospeli_facilities_log_list', { since: `(${TYPED}) 1 Nov 2026`, limit: 1 }, bot['estates-tech']); } catch (e) { err = e; }
  const row = (await core.auditLog()).at(-1);
  assert.ok(!JSON.stringify(row).includes('07700'), `the audit row holds the typed text: ${JSON.stringify(row.detail)}`);
  assert.equal(err?.code, 'invalid-input');
});

test('the two new time inputs have a length limit', () => {
  for (const [name, field] of [['ospeli_transfers_request', 'bookedFor'], ['ospeli_facilities_log_list', 'since']]) {
    assert.ok(commandByName(name).input.properties[field].maxLength > 0, `${name}.${field} has no maxLength`);
  }
});
