// Shared set-up for the 23 Nov review tests of the pharmacy module. Synthetic data only; the clock
// is pinned (14:00 at the example site) and moves only when a test moves it.
import { Core } from '../../web/app/core/core.js';
import { MemoryAdapter } from '../../web/app/core/db.js';
import { loadSyntheticHospital } from '../../web/app/core/generator.js';
import { runCommand } from '../../web/app/core/commands.js';
export const END = '2026-11-20T18:00:00.000Z';
export const MIN = 60e3;
const runner = (core) => (name, input, who) => runCommand(core, name, input, typeof who === 'string' ? { type: 'human', role: who } : who);
export async function site() {
  let t = Date.parse(END);
  const core = await Core.open({ adapter: new MemoryAdapter(), clock: () => new Date(t) });
  await loadSyntheticHospital(core, { end: END });
  return { core, run: runner(core), advance: (m) => { t += m * MIN; } };
}
// A site made by importing an export file to which `extra(add)` added events (an edited import).
export async function importedSite(extra) {
  const clock = () => new Date(END);
  const src = await Core.open({ adapter: new MemoryAdapter(), clock });
  await loadSyntheticHospital(src, { end: END, modules: false });
  const data = JSON.parse(JSON.stringify(await src.exportData()));
  extra((type, subject, actorRole, d, at = END) => data.events.push({ seq: data.events.length + 1, type, subject, actorRole, at, recordedAt: END, data: d }));
  const core = await Core.open({ adapter: new MemoryAdapter(), clock });
  const refused = await core.validateImport(data);
  if (refused.length) throw new Error(`the import was refused: ${refused.join('; ')}`);
  await core.importData(data, 'ops-manager');
  return { core, run: runner(core) };
}
// Agents on for ward-a1 only; each bot is listed for ward-a1 alone.
export async function botsOnA1(run) {
  await run('ospeli_agents_set_access', { allowed: true, wards: { 'ward-a1': true } }, 'coo');
  const bot = {};
  for (const role of ['ward-nurse', 'pharmacy-technician']) {
    await run('ospeli_agents_add', { name: `rev-${role}-bot`, role, wards: ['ward-a1'], days: 30 }, 'coo');
    bot[role] = { type: 'agent', agent: `rev-${role}-bot`, role };
  }
  return bot;
}
export const bedWithPatient = async (run, wardId) => (await run('ospeli_pharmacy_ward_requests', { wardId }, 'ward-nurse')).beds.find((b) => !b.request).bedId;
