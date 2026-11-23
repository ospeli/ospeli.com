// Shared by the review tests of 23 Nov: a core on a pinned clock, moved only by the test.
import { Core } from '../../web/app/core/core.js';
import { MemoryAdapter } from '../../web/app/core/db.js';
import { runCommand } from '../../web/app/core/commands.js';

export const human = { type: 'human', role: 'radiographer' };
export async function setup(start = '2026-11-16T09:00:00.000Z') {
  let t = Date.parse(start);
  const core = await Core.open({ adapter: new MemoryAdapter(), clock: () => new Date(t) });
  const tick = (s) => { t += s * 1000; };
  const tap = (name, input = {}) => runCommand(core, name, input, human);
  return { core, tick, tap };
}
