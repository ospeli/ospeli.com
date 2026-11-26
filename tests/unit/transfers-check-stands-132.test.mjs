import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Core } from '../../web/app/core/core.js';
import { MemoryAdapter } from '../../web/app/core/db.js';
import { loadSyntheticHospital } from '../../web/app/core/generator.js';
import { runCommand, CommandError } from '../../web/app/core/commands.js';
import { CHECK_ITEMS } from '../../web/app/modules/transfers/logic.js';

// Synthetic data only. Probe notes on ospeli/ospeli#132 (copied from #139): a failed daily check
// and its suggestion, and the double-tap guard on a booking, under the vehicle's later status changes
// and a device clock that was set forward.
const END = '2026-11-06T18:00:00.000Z';
const MIN = 60e3;
const code = (c) => (err) => err instanceof CommandError && err.code === c;
async function site() {
  let t = Date.parse(END); let ticking = false;
  const core = await Core.open({ adapter: new MemoryAdapter(), clock: () => new Date(ticking ? (t += 1000) : t) });
  await loadSyntheticHospital(core, { end: END });
  ticking = true;
  const run = (name, input, role) => runCommand(core, name, input, { type: 'human', role });
  return { core, run, advance: (m) => { t += m * MIN; } };
}
const ITEMS = CHECK_ITEMS.map((x) => x.id);
const failBrakes = (run) => run('ospeli_transfers_vehicle_check', { vehicleId: 'asset-vehicle-3', passed: ITEMS.filter((x) => x !== 'brakes'), failed: ['brakes'] }, 'driver');
const board = async (run) => run('ospeli_transfers_board', {}, 'fleet-supervisor');
const suggestion = (b) => b.guide.suggestions.find((x) => x.rule === 'check-failed' && x.vehicleId === 'asset-vehicle-3');
const vehicle = (b) => b.vehicles.find((v) => v.id === 'asset-vehicle-3');

test('taking a vehicle out of service keeps "Report a fault" on the failed-check suggestion while no fault is reported', async () => {
  const { run } = await site();
  await failBrakes(run);
  await run('ospeli_transfers_vehicle_status', { vehicleId: 'asset-vehicle-3', status: 'off-road', reason: 'failed-check' }, 'fleet-supervisor');
  const b = await board(run);
  const s = suggestion(b);
  assert.ok(s, 'the suggestion stays while the fault report is not sent');
  assert.deepEqual(s.actions.map((a) => a.command), ['ospeli_workorders_report_fault'], 'only the fault report is left to do');
  assert.equal(vehicle(b).checkFailing, true, 'out of service does not clear the failed check');
  // Once the fault is reported, nothing is left to do: the suggestion goes.
  await run(s.actions[0].command, { ...s.actions[0].input, priority: 'high' }, 'fleet-supervisor');
  assert.equal(suggestion(await board(run)), undefined);
});

test('bringing a vehicle back with reason "other" does not clear a failed check; repaired or checked and safe does', async () => {
  const { run } = await site();
  await failBrakes(run);
  await run('ospeli_transfers_vehicle_status', { vehicleId: 'asset-vehicle-3', status: 'off-road', reason: 'failed-check' }, 'fleet-supervisor');
  await run('ospeli_transfers_vehicle_status', { vehicleId: 'asset-vehicle-3', status: 'back', reason: 'other' }, 'fleet-supervisor');
  let b = await board(run);
  assert.equal(vehicle(b).checkFailing, true, 'the failed brakes check is still its last check');
  assert.ok(suggestion(b)?.actions.some((a) => a.command === 'ospeli_transfers_vehicle_status'), 'in service again: taking it out is suggested again');
  await run('ospeli_transfers_vehicle_status', { vehicleId: 'asset-vehicle-3', status: 'off-road', reason: 'fault' }, 'fleet-supervisor');
  await run('ospeli_transfers_vehicle_status', { vehicleId: 'asset-vehicle-3', status: 'back', reason: 'repaired' }, 'fleet-supervisor');
  b = await board(run);
  assert.equal(vehicle(b).checkFailing, false, 'repaired clears it');
  assert.equal(suggestion(b), undefined);
});

test('a request stamped in the future (clock set forward, then corrected) does not block the same request for as long as the gap lasts', async () => {
  const { run, advance } = await site();
  const ask = { type: 'between-sites', fromPlace: 'ward-a3', toSite: 'site-north', needed: 'asap', mobility: 'wheelchair', escort: 'carer', equipment: ['oxygen'] };
  advance(120); // the device clock is two hours fast
  const first = await run('ospeli_transfers_request', ask, 'ward-nurse');
  advance(-120); // corrected
  advance(10);
  const second = await run('ospeli_transfers_request', ask, 'ward-nurse');
  assert.notEqual(second.transferId, first.transferId);
  // A real double tap is still caught.
  await assert.rejects(run('ospeli_transfers_request', ask, 'ward-nurse'), code('conflict'));
});
