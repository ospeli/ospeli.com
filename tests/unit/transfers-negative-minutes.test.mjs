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

// A device clock set back between two taps gives a step an earlier time than the one before it.
// The row on the board clamps the wait at 0 (transferOut, commands.js line 85), but the two
// medians do not (logic.js lines 275, 285, 315): transfer wait and handover time come out below zero.
test('transfer wait and handover time are never below zero', () => {
  // asked 10:00, departed "09:50"; arrived at destination 10:30, handed over "10:20"
  const ev = [ask('trf-00001', at('10:00')), ...go('trf-00001', [at('10:01'), at('09:40'), at('09:50'), at('10:30'), at('10:20')])];
  const tr = deriveTransfers(ev);
  const w = transferWait(tr, PERIOD); const h = handoverTime(tr, PERIOD);
  assert.ok(w.value == null || w.value >= 0, `transfer wait median is ${w.value} min`);
  assert.ok(h.value == null || h.value >= 0, `handover time median is ${h.value} min`);
});
