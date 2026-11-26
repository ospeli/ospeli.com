// Finding: a refused call from an agent that is not on the site's list stores the name the
// agent typed, inside detail.why, although the rule (commands.js, auditRefusal) says nothing
// the agent typed is stored and an unlisted name is written as "unlisted". Synthetic data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Core } from '../../web/app/core/core.js';
import { MemoryAdapter } from '../../web/app/core/db.js';
import { loadHospital } from './hospital-clock.mjs';
import { runCommand } from '../../web/app/core/commands.js';

const END = '2026-11-08T12:00:00.000Z';

test('a refusal for an unlisted agent does not store the name it typed', async () => {
  let t = Date.parse(END);
  const core = await Core.open({ adapter: new MemoryAdapter(), clock: () => new Date(t += 1000) });
  await loadHospital(core, { end: END });
  await runCommand(core, 'ospeli_agents_set_access', { allowed: true, wards: { 'ward-a1': true } }, { type: 'human', role: 'coo' });
  const typed = 'typed-by-the-agent 555 0100';
  await assert.rejects(runCommand(core, 'ospeli_beds_board', {}, { type: 'agent', role: 'bed-manager', agent: typed }));
  const row = (await core.auditLog()).filter((e) => e.action === 'agent.refused').at(-1);
  assert.equal(row.agent, 'unlisted');
  assert.ok(!JSON.stringify(row).includes(typed), `the audit row holds the text the agent typed: ${JSON.stringify(row.detail.why)}`);
});
