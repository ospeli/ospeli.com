// Shared set-up for the review proofs: the example hospital (synthetic), no module history, a clock the test moves.
import { Core } from '../../web/app/core/core.js';
import { MemoryAdapter } from '../../web/app/core/db.js';
import { loadHospital } from './hospital-clock.mjs';
import { runCommand } from '../../web/app/core/commands.js';
export const END = '2026-11-06T18:00:00.000Z';
export async function site() {
  let t = Date.parse(END);
  const core = await Core.open({ adapter: new MemoryAdapter(), clock: () => new Date(t += 1000) });
  await loadHospital(core, { end: END, modules: false });
  const run = (name, input, who) => runCommand(core, name, input, typeof who === 'string' ? { type: 'human', role: who } : who);
  return { core, run, skip: (ms) => { t += ms; } };
}
// Agents on for ward-a2 only; ward-a1 stays switched off. Every bot is listed for ward-a2 alone.
export async function agentsOnA2(run) {
  await run('ospeli_agents_set_access', { allowed: true, wards: { 'ward-a2': true } }, 'coo');
  const bot = {};
  for (const role of ['supply-manager', 'storekeeper', 'ward-nurse']) {
    await run('ospeli_agents_add', { name: `${role}-bot`, role, wards: ['ward-a2'], days: 30 }, 'coo');
    bot[role] = { type: 'agent', agent: `${role}-bot`, role };
  }
  return bot;
}
