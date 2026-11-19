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

// The transfer writes take expectedState, but none has a snapshot(), so an agent's proposal never
// records the state it saw (commands.js lines 392-470; the accept step in core/commands.js only
// adds expectedState when the proposal carries seenState). A proposal made while a journey was
// waiting is carried out unchanged whatever happened since.
test('an agent\'s proposal to cancel a waiting journey is refused as out of date once the vehicle is at pickup', async () => {
  const { core, run } = await site();
  await run('ospeli_agents_set_access', { allowed: true, wards: { 'ward-a3': true } }, 'coo');
  await run('ospeli_agents_add', { name: 'transfer-bot', role: 'transport-coordinator', wards: ['ward-a3'], days: 30 }, 'coo');
  const req = await run('ospeli_transfers_request', ASK, 'ward-nurse');
  const p = await run('ospeli_transfers_cancel', { transferId: req.transferId, reason: 'no-vehicle' }, agent('transport-coordinator'));
  assert.equal(p.status, 'proposed'); // proposed while the journey was "waiting for a vehicle"
  await run('ospeli_transfers_assign', { transferId: req.transferId, vehicleId: 'asset-vehicle-3' }, 'transport-coordinator');
  await run('ospeli_transfers_step', { transferId: req.transferId, step: 'arrived-pickup' }, 'driver');
  const res = await run('ospeli_proposals_accept', { id: p.proposal.id }, 'transport-coordinator');
  assert.equal(res.status, 'expired', 'the journey changed since the agent looked: the proposal is out of date and nothing is done');
  assert.equal(deriveTransfers(await core.events()).get(req.transferId).state, 'at-pickup');
});

test('an agent\'s proposal to give a waiting journey to vehicle 1 does not undo the coordinator\'s later choice of vehicle 3', async () => {
  const { core, run } = await site();
  await run('ospeli_agents_set_access', { allowed: true, wards: { 'ward-a3': true } }, 'coo');
  await run('ospeli_agents_add', { name: 'transfer-bot', role: 'transport-coordinator', wards: ['ward-a3'], days: 30 }, 'coo');
  const req = await run('ospeli_transfers_request', ASK, 'ward-nurse');
  const p = await run('ospeli_transfers_assign', { transferId: req.transferId, vehicleId: 'asset-vehicle-1' }, agent('transport-coordinator'));
  await run('ospeli_transfers_assign', { transferId: req.transferId, vehicleId: 'asset-vehicle-3' }, 'transport-coordinator');
  assert.equal((await run('ospeli_proposals_accept', { id: p.proposal.id }, 'transport-coordinator')).status, 'expired');
  assert.equal(deriveTransfers(await core.events()).get(req.transferId).vehicleId, 'asset-vehicle-3');
});
