// Shared set-up for the import and export deep pass: the example hospital (synthetic),
// a pinned clock, and a parsed copy of its export file to tamper with.
import { Core } from '../../web/app/core/core.js';
import { MemoryAdapter } from '../../web/app/core/db.js';
import { loadSyntheticHospital } from '../../web/app/core/generator.js';
export const END = '2026-11-06T18:00:00.000Z';
export function pinnedClock() { let t = Date.parse(END); return () => new Date(t += 1000); }
export async function loaded({ adapter = new MemoryAdapter(), clock = pinnedClock(), modules = false } = {}) {
  const core = await Core.open({ adapter, clock });
  await loadSyntheticHospital(core, { end: END, modules });
  return core;
}
let cached = null;
export async function exportedFile() {
  cached ||= JSON.stringify(await (await loaded()).exportData());
  return JSON.parse(cached);
}
export const empty = (clock = pinnedClock()) => Core.open({ adapter: new MemoryAdapter(), clock });
// Made-up text of the kinds the import check exists to stop. Nobody real.
export const TITLED = 'Seen by Dr Sarah Jones, call 07700 900123';
