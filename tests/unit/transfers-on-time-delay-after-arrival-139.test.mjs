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

// On-time pickup measures the vehicle's arrival at pickup against the booked time, but it reads
// every delay on the journey whenever it was recorded (logic.js lines 300-303), so a delay marked
// after the vehicle arrived rewrites the result in both directions.
test('a vehicle that arrived 90 minutes late is not left out because the patient was not ready afterwards', () => {
  const ev = [ask('trf-00001', at('08:00'), { needed: 'booked', bookedFor: at('10:00') }), ...go('trf-00001', [at('09:00'), at('11:30')]),
    e('transfers.delayed', 'trf-00001', at('11:35'), { reason: 'patient-not-ready' }, 'transport-coordinator')];
  const o = onTimePickup(deriveTransfers(ev), PERIOD);
  assert.deepEqual([o.numerator, o.denominator, o.leftOut], [0, 1, 0], 'arrived 90 min after the booked time: due and not on time');
});

test('a vehicle that arrived 5 minutes early is on time even if a fault is recorded later on the road', () => {
  const ev = [ask('trf-00001', at('08:00'), { needed: 'booked', bookedFor: at('10:00') }), ...go('trf-00001', [at('09:00'), at('09:55'), at('10:05')]),
    e('transfers.delayed', 'trf-00001', at('10:20'), { reason: 'vehicle-fault' }, 'transport-coordinator')];
  const o = onTimePickup(deriveTransfers(ev), PERIOD);
  assert.deepEqual([o.value, o.numerator, o.denominator], [100, 1, 1]);
});
