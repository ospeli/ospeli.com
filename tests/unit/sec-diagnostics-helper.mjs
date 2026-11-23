// Shared by the review tests of 23 Nov. Synthetic data only; the clock is pinned.
import { Core } from '../../web/app/core/core.js';
import { MemoryAdapter } from '../../web/app/core/db.js';
import { loadSyntheticHospital } from '../../web/app/core/generator.js';
import { runCommand, CommandError } from '../../web/app/core/commands.js';

export const END = '2026-11-19T14:00:00.000Z'; // 10:00 on the example site's clock
export const MIN = 60e3;
export const human = (role) => ({ type: 'human', role });
export const agent = (role, name = 'dx-bot') => ({ type: 'agent', role, agent: name });
export const code = (...cs) => (err) => err instanceof CommandError && cs.includes(err.code);
export async function site() {
  let t = Date.parse(END);
  const core = await Core.open({ adapter: new MemoryAdapter(), clock: () => new Date(t) });
  await loadSyntheticHospital(core, { end: END });
  const run = (name, input, who) => runCommand(core, name, input, typeof who === 'string' ? human(who) : who);
  return { core, run, advance: (m) => { t += m * MIN; } };
}
export const newRequest = async (run, extra = {}, who = 'unit-clerk') => (await run('ospeli_diagnostics_request_record', { sourceId: 'ward-a2', testGroup: 'chemistry', urgency: 'routine', again: true, ...extra }, who)).requestId;
