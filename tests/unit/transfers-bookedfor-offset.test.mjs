import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Core } from '../../web/app/core/core.js';
import { MemoryAdapter } from '../../web/app/core/db.js';
import { loadSyntheticHospital } from '../../web/app/core/generator.js';
import { runCommand, CommandError } from '../../web/app/core/commands.js';
import { deriveTransfers, transferWait, onTimePickup, handoverTime, ruleEscortCover, CHECK_ITEMS } from '../../web/app/modules/transfers/logic.js';

// Synthetic data only. The same helpers as tests/unit/transfers.test.mjs.
const END = '2026-11-06T18:00:00.000Z';
const MIN = 60e3;
const human = (role) => ({ type: 'human', role });
const agent = (role, name = 'transfer-bot') => ({ type: 'agent', role, agent: name });
const code = (c) => (err) => err instanceof CommandError && err.code === c;
async function site() {
  let t = Date.parse(END); let ticking = false;
  const core = await Core.open({ adapter: new MemoryAdapter(), clock: () => new Date(ticking ? (t += 1000) : t) });
  await loadSyntheticHospital(core, { end: END });
  ticking = true;
  const run = (name, input, who) => runCommand(core, name, input, typeof who === 'string' ? human(who) : who);
  return { core, run, advance: (m) => { t += m * MIN; } };
}
const ASK = { type: 'between-sites', fromPlace: 'ward-a3', toSite: 'site-north', needed: 'asap', mobility: 'wheelchair', escort: 'carer', equipment: ['oxygen'] };
const at = (hm, day = '06') => `2026-11-${day}T${hm}:00.000Z`;
const e = (type, subject, t, data = null, actorRole = 'driver') => ({ type, subject, actorRole, at: t, data });
const ask = (id, t, { needed = 'asap', bookedFor, type = 'discharge' } = {}) => e('transfers.requested', id, t, { type, fromPlace: 'ward-a1', toOutside: 'home', needed, ...(bookedFor ? { bookedFor } : {}), mobility: 'walks', escort: 'none', equipment: ['none'] }, 'ward-nurse');
const go = (id, times, v = 'v1') => [e('transfers.assigned', id, times[0], { vehicle: v }, 'transport-coordinator'),
  ...['arrived-pickup', 'departed', 'arrived-destination', 'handed-over'].slice(0, times.length - 1).map((s, i) => e(`transfers.${s}`, id, times[i + 1], { vehicle: v }))];
const PERIOD = { since: at('08:00'), until: at('20:00') };

// Times are compared as text (logic.js lines 186, 274). The request command stores bookedFor in
// one form (sameMoment), but deriveTransfers accepts any parseable bookedFor from the log as it is
// (line 198, 201). An event whose bookedFor is written with an offset ("06:00-04:00", which is
// 10:00Z) is then outside every period by text and silently missing from on-time pickup, and it
// sorts wrongly in the queue.
test('a booked time written with a UTC offset is counted in the period it falls in', () => {
  const ev = [ask('trf-00001', at('08:00'), { needed: 'booked', bookedFor: '2026-11-06T06:00:00-04:00' }), ...go('trf-00001', [at('09:00'), at('09:55'), at('10:05')])];
  const o = onTimePickup(deriveTransfers(ev), PERIOD); // 08:00Z to 20:00Z; booked for 10:00Z, arrived 09:55Z
  assert.deepEqual([o.numerator, o.denominator], [1, 1]);
});
