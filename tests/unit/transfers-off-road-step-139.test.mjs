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

// A vehicle fails its daily check (brakes) and is taken out of service. The crew screen hides the
// step buttons and says "Do not use it" (view.js lines 162, 174), but the command does not check:
// ospeli_transfers_step still times "arrived at pickup" and "departed" for a journey on that
// vehicle (checkStep, commands.js lines 243-250), for any other client, an agent's accepted
// proposal or a stale screen. The board then shows a vehicle that is out of service and on the way.
test('a journey cannot be started in a vehicle that is out of service', async () => {
  const { core, run } = await site();
  const req = await run('ospeli_transfers_request', ASK, 'ward-nurse');
  await run('ospeli_transfers_assign', { transferId: req.transferId, vehicleId: 'asset-vehicle-3' }, 'transport-coordinator');
  const items = CHECK_ITEMS.map((x) => x.id);
  await run('ospeli_transfers_vehicle_check', { vehicleId: 'asset-vehicle-3', passed: items.filter((x) => x !== 'brakes'), failed: ['brakes'] }, 'driver');
  await run('ospeli_transfers_vehicle_status', { vehicleId: 'asset-vehicle-3', status: 'off-road', reason: 'failed-check' }, 'fleet-supervisor');
  await assert.rejects(run('ospeli_transfers_step', { transferId: req.transferId, step: 'arrived-pickup' }, 'driver'), code('conflict'), 'arrived at pickup in a vehicle that is out of service');
  assert.equal(deriveTransfers(await core.events()).get(req.transferId).state, 'assigned');
});
