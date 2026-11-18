// The shared stock item (core/stock.js, core/stock-commands.js): things held at places, moved by a
// few plain movements, derived from the event log. Operations only: no price, no dose, no person.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Core, findIdentifierFields, findIdentifierValues } from '../../web/app/core/core.js';
import { MemoryAdapter } from '../../web/app/core/db.js';
import { loadSyntheticHospital, generateHospital } from '../../web/app/core/generator.js';
import { CommandError } from '../../web/app/core/commands.js';
import { validate } from '../../web/app/core/schema.js';
import { ROLES, validateEntity } from '../../web/app/core/model.js';
import { stockCommands, STOCK_EVENT_TYPES } from '../../web/app/core/stock-commands.js';
import {
  STOCK_VERBS, stockCatalogue, deriveStock, balance, holdingOf, usableOf, batchList, nearExpiry, daysOfStockLeft, zeroIntervals, stockOutRate, tracerAvailability,
  fillRate, requestWait, toDoses, toVials, expiryMs, validDate,
} from '../../web/app/core/stock.js';

const END = '2026-11-06T18:00:00.000Z';
const DAY = 864e5; const HOUR = 36e5;
const human = (role) => ({ type: 'human', role });
const code = (c) => (err) => err instanceof CommandError && err.code === c;
const ROLE_IDS = ROLES.map((r) => r.id);
const all = (roles) => Object.fromEntries(STOCK_VERBS.map((v) => [v, roles[v] || roles.rest]));

// Two modules' stock, written the way a module's commands.js would, with roles every build has.
// Ward nurse counts and asks; the facilities technician stands in for a storekeeper; the
// operations manager for a supply manager. The second category belongs to other roles entirely.
const PACK = {
  id: 'teststores',
  STOCK_CATEGORIES: {
    supplies: { name: 'Supplies', roles: all({ rest: ['estates-tech'], count: ['ward-nurse', 'estates-tech'], request: ['ward-nurse'], use: ['ward-nurse'], transfer: ['estates-tech', 'ward-nurse'], release: ['ops-manager'], levels: ['ops-manager'], itemAdd: ['ops-manager'] }) },
  },
  STOCK_ITEMS: [
    { id: 'gloves-m', name: 'Examination gloves, medium', unit: 'box of 100', category: 'supplies', tracer: true },
    { id: 'syringe-5', name: 'Syringe 5 ml', unit: 'box of 100', category: 'supplies' },
    { id: 'saline-500', name: 'Saline 500 ml', unit: 'bag', category: 'supplies', batched: true },
  ],
};
const PACK2 = {
  id: 'testph',
  STOCK_CATEGORIES: { vaccine: { name: 'Vaccines', roles: all({ rest: ['ae-nic'], release: ['coo'], levels: ['coo'], itemAdd: ['coo'] }) } },
  STOCK_ITEMS: [{ id: 'vac-a', name: 'Example vaccine A', unit: 'vial', category: 'vaccine', batched: true, coldChain: true, dosesPerVial: 10, tracer: true }],
};
const CAT = stockCatalogue([PACK, PACK2], ROLE_IDS);
const CMDS = Object.fromEntries(stockCommands([PACK, PACK2]).map((c) => [c.name, c]));

// Run a command the way the command layer does for a person: schema, typed-text check, role list, command.
async function run(core, name, input, role, opts = {}) {
  const c = CMDS[`ospeli_stock_${name}`];
  const errs = validate(c.input, input);
  if (errs.length) throw new CommandError('invalid-input', errs.join('; '));
  if (c.check) c.check(input);
  if (!c.roles.includes(role)) throw new CommandError('forbidden', `${role} cannot run ${name}`);
  return c.run(core, input, { actor: human(role), wards: opts.wards ?? null });
}
// A site with a clock the test moves: each reading is one second later; site.skip(ms) jumps ahead.
async function site() {
  let t = Date.parse(END);
  const core = await Core.open({ adapter: new MemoryAdapter(), clock: () => new Date(t += 1000) });
  // No module history: these tests bring their own items and check exact balances.
  await loadSyntheticHospital(core, { end: END, modules: false });
  core.skip = (ms) => { t += ms; };
  return core;
}
const WARD = 'ward-a1'; const STORE = 'store-main';
const levels = async (core, input = {}) => (await run(core, 'levels', input, 'ward-nurse')).levels;
const usableAt = async (core, itemId, placeId) => (await levels(core, { placeId, itemId }))[0]?.usable ?? 0;

// Events by hand for the pure functions: day numbers from a fixed start.
const D0 = Date.parse('2026-10-01T00:00:00.000Z');
const at = (days) => new Date(D0 + days * DAY).toISOString();
const log = (rows) => rows.map(([day, type, subject, data], i) => ({ seq: i + 1, type: `stock.${type}`, subject, actorRole: 'ward-nurse', at: at(day), data }));
const derive = (rows, offsetMinutes = 0) => deriveStock(log(rows), { ...CAT, offsetMinutes });

test('the example hospital has one store, and a store is a valid place', () => {
  const { entities } = generateHospital({ end: END });
  const stores = entities.filter((e) => e.type === 'store');
  assert.deepEqual(stores.map((s) => [s.id, s.name]), [['store-main', 'Main store']]);
  assert.deepEqual(validateEntity(stores[0]), []);
});

test('a module\'s stock configuration is refused at load when it is wrong; no category means no commands', () => {
  const cat = (roles) => ({ supplies: { name: 'Supplies', roles } });
  const ok = all({ rest: ['ward-nurse'] });
  const item = { id: 'thing-1', name: 'Thing', unit: 'pack', category: 'supplies' };
  assert.throws(() => stockCatalogue([{ id: 'm', STOCK_CATEGORIES: cat({ ...ok, count: ['nobody-role'] }) }], ROLE_IDS), /unknown role/);
  assert.throws(() => stockCatalogue([{ id: 'm', STOCK_CATEGORIES: cat({ count: ['ward-nurse'] }) }], ROLE_IDS), /roles\.request is required/);
  assert.throws(() => stockCatalogue([{ id: 'm', STOCK_CATEGORIES: cat({ ...ok, approve: [] }) }], ROLE_IDS), /unknown verb/);
  assert.throws(() => stockCatalogue([PACK, { id: 'm', STOCK_CATEGORIES: cat(ok) }], ROLE_IDS), /already used/);
  const bad = (it, why) => assert.throws(() => stockCatalogue([{ id: 'm', STOCK_CATEGORIES: cat(ok), STOCK_ITEMS: [it] }], ROLE_IDS), why);
  bad({ ...item, category: 'gadgets' }, /unknown category/);
  bad({ ...item, dosesPerVial: 10 }, /dosesPerVial/);
  bad({ ...item, price: 3 }, /no price, brand or supplier/);
  bad({ ...item, supplier: 'x' }, /no price, brand or supplier/);
  bad({ ...item, id: 'item-00001' }, /kept for items a site adds/);
  bad({ ...item, name: 'x'.repeat(61) }, /60 characters/);
  assert.throws(() => stockCatalogue([PACK, { id: 'm', STOCK_ITEMS: [{ ...item, id: 'gloves-m' }] }], ROLE_IDS), /already used/);
  assert.deepEqual(stockCommands([]), []);
  assert.deepEqual(stockCommands([{ id: 'm', COMMANDS: [] }]), []);
});

test('every stock command: a closed input with a description on each field; writes need a person; three are people only', () => {
  const names = Object.keys(CMDS);
  assert.equal(names.length, 18);
  for (const c of Object.values(CMDS)) {
    assert.equal(c.input.additionalProperties, false, c.name);
    for (const [k, v] of Object.entries(c.input.properties)) assert.ok(v.description && v.description.length >= 15, `${c.name}.${k} has a description`);
    assert.ok(c.summary.length > 60 && c.example?.input, c.name);
    assert.equal(c.approval, c.kind === 'write', `${c.name}: a write waits for a person when an agent asks`);
    for (const r of c.roles) assert.ok(ROLE_IDS.includes(r));
    if (c.kind === 'write') assert.equal(typeof c.precheck, 'function', `${c.name} is checked before it becomes a proposal`);
  }
  const peopleOnly = Object.values(CMDS).filter((c) => c.agents === false).map((c) => c.name).sort();
  assert.deepEqual(peopleOnly, ['ospeli_stock_item_add', 'ospeli_stock_level_set', 'ospeli_stock_release']);
  // No command takes or returns a price, value, brand or supplier.
  assert.equal(/price|currency|brand"|supplierName|"value"/i.test(JSON.stringify(Object.values(CMDS).map((c) => [c.input, c.output]))), false);
  // A verb nobody may do has no command.
  const none = { id: 'm', STOCK_CATEGORIES: { supplies: { name: 'Supplies', roles: all({ rest: ['ward-nurse'], use: [], hold: [], release: [] }) } } };
  const got = stockCommands([none]).map((c) => c.name);
  for (const n of ['use', 'hold', 'release']) assert.ok(!got.includes(`ospeli_stock_${n}`), n);
  assert.ok(got.includes('ospeli_stock_count'));
});

test('receive, count, request, issue, transfer, use and write-off: the balances at each place, checked by hand', async () => {
  const core = await site();
  await run(core, 'receive', { placeId: STORE, lines: [{ itemId: 'gloves-m', qty: 50 }, { itemId: 'syringe-5', qty: 30 }], source: 'Purchase', orderRef: 'ord-00001' }, 'estates-tech');
  await run(core, 'level_set', { itemId: 'gloves-m', placeId: WARD, level: 12 }, 'ops-manager');
  await run(core, 'level_set', { itemId: 'syringe-5', placeId: WARD, level: 6 }, 'ops-manager');
  // The ward counts 4 gloves and 6 syringes: gloves are 8 under their level, syringes are at it.
  const seen = await run(core, 'levels', { placeId: WARD }, 'ward-nurse');
  const counted = await run(core, 'count', { placeId: WARD, lines: [{ itemId: 'gloves-m', qty: 4 }, { itemId: 'syringe-5', qty: 6 }], seenSeq: seen.asOfSeq }, 'ward-nurse');
  assert.deepEqual(counted.underLevel, [{ itemId: 'gloves-m', level: 12, usable: 4, shortBy: 8 }]);
  assert.deepEqual(counted.requested, [{ itemId: 'gloves-m', qty: 8 }], 'one request for exactly level minus count; nothing for the item at its level');
  assert.match(counted.requestId, /^req-\d{5}$/);
  let reqs = (await run(core, 'requests', { fromPlaceId: STORE }, 'estates-tech')).requests;
  assert.equal(reqs.length, 1);
  assert.deepEqual([reqs[0].placeId, reqs[0].raisedBy, reqs[0].state, reqs[0].canIssueInFull, reqs[0].lines[0].usableAtSupplier], [WARD, 'count', 'open', true, 50]);
  // The store issues 5 now (part), then the rest.
  const part = await run(core, 'issue', { requestId: counted.requestId, lines: [{ itemId: 'gloves-m', qty: 5 }] }, 'estates-tech');
  assert.deepEqual([part.state, part.left], ['part', [{ itemId: 'gloves-m', left: 3 }]]);
  assert.deepEqual([await usableAt(core, 'gloves-m', STORE), await usableAt(core, 'gloves-m', WARD)], [45, 9]);
  await assert.rejects(run(core, 'issue', { requestId: counted.requestId, lines: [{ itemId: 'gloves-m', qty: 4 }] }, 'estates-tech'), code('conflict'), 'more than is still owed');
  await assert.rejects(run(core, 'issue', { requestId: counted.requestId, lines: [{ itemId: 'syringe-5', qty: 1 }] }, 'estates-tech'), code('invalid-input'), 'an item that is not on the request');
  const rest = await run(core, 'issue', { requestId: counted.requestId, expectedState: 'part' }, 'estates-tech');
  assert.deepEqual([rest.state, rest.left], ['issued', []]);
  assert.deepEqual([await usableAt(core, 'gloves-m', STORE), await usableAt(core, 'gloves-m', WARD)], [42, 12]);
  await assert.rejects(run(core, 'issue', { requestId: counted.requestId }, 'estates-tech'), code('conflict'), 'a second tap on Issue finds it already issued');
  // Transfer, use and write-off.
  await run(core, 'transfer', { fromPlaceId: WARD, toPlaceId: 'ward-a2', lines: [{ itemId: 'gloves-m', qty: 2 }] }, 'ward-nurse');
  await run(core, 'use', { placeId: WARD, lines: [{ itemId: 'gloves-m', qty: 3 }] }, 'ward-nurse');
  await run(core, 'write_off', { placeId: WARD, lines: [{ itemId: 'gloves-m', qty: 1 }], reason: 'Damaged or broken' }, 'estates-tech');
  assert.deepEqual([await usableAt(core, 'gloves-m', WARD), await usableAt(core, 'gloves-m', 'ward-a2'), await usableAt(core, 'gloves-m', STORE)], [6, 2, 42]);
  // Nothing leaves a place that is not there.
  await assert.rejects(run(core, 'use', { placeId: WARD, lines: [{ itemId: 'gloves-m', qty: 7 }] }, 'ward-nurse'), code('conflict'));
  await assert.rejects(run(core, 'transfer', { fromPlaceId: 'ward-a2', toPlaceId: WARD, lines: [{ itemId: 'gloves-m', qty: 3 }] }, 'ward-nurse'), code('conflict'));
  await assert.rejects(run(core, 'transfer', { fromPlaceId: WARD, toPlaceId: WARD, lines: [{ itemId: 'gloves-m', qty: 1 }] }, 'ward-nurse'), code('invalid-input'));
  // The same record through the pure functions, and nothing but stock.* events with a role, never a person.
  const evs = await core.events({ type: STOCK_EVENT_TYPES });
  const stock = deriveStock(evs, CAT);
  assert.equal(stock.problems, 0);
  assert.equal(usableOf(stock, 'gloves-m', WARD, core.now()), 6);
  assert.ok(evs.every((e) => ROLE_IDS.includes(e.actorRole)));
  reqs = (await run(core, 'requests', { state: 'issued' }, 'estates-tech')).requests;
  assert.equal(reqs[0].state, 'issued');
  // One audit entry per write, holding ids and picks only.
  const trail = (await core.auditLog()).filter((e) => e.action.startsWith('stock.'));
  assert.equal(trail.length, evs.filter((e) => e.type !== 'stock.requested').length, 'one entry per write (the count and the request it raised are one write)');
  assert.deepEqual(await core.verifyAudit(), { ok: true });
});

test('a count: at or over the level raises nothing; an open request is not raised twice; a stale count is refused', async () => {
  const core = await site();
  await run(core, 'level_set', { itemId: 'gloves-m', placeId: WARD, level: 10 }, 'ops-manager');
  const over = await run(core, 'count', { placeId: WARD, lines: [{ itemId: 'gloves-m', qty: 10 }] }, 'ward-nurse');
  assert.deepEqual([over.requestId, over.underLevel, over.requestNote], [null, [], null]);
  const quiet = await run(core, 'count', { placeId: WARD, lines: [{ itemId: 'gloves-m', qty: 3 }], raiseRequest: false }, 'ward-nurse');
  assert.equal(quiet.requestId, null);
  assert.match(quiet.requestNote, /raiseRequest was false/);
  const first = await run(core, 'count', { placeId: WARD, lines: [{ itemId: 'gloves-m', qty: 3 }] }, 'ward-nurse');
  assert.deepEqual(first.requested, [{ itemId: 'gloves-m', qty: 7 }]);
  const again = await run(core, 'count', { placeId: WARD, lines: [{ itemId: 'gloves-m', qty: 2 }] }, 'ward-nurse');
  assert.equal(again.requestId, null, 'the request already open stands; no second one');
  assert.match(again.requestNote, /already open/);
  assert.equal((await run(core, 'requests', {}, 'ward-nurse')).total, 1);
  await assert.rejects(run(core, 'request', { placeId: WARD, lines: [{ itemId: 'gloves-m', qty: 5 }] }, 'ward-nurse'), (e) => code('conflict')(e) && e.detail.existing === first.requestId);
  // A count made against an old reading is refused when stock for that item moved since.
  const seen = await run(core, 'levels', { placeId: WARD }, 'ward-nurse');
  await run(core, 'receive', { placeId: WARD, lines: [{ itemId: 'gloves-m', qty: 20 }], source: 'Donation' }, 'estates-tech');
  await assert.rejects(run(core, 'count', { placeId: WARD, lines: [{ itemId: 'gloves-m', qty: 2 }], seenSeq: seen.asOfSeq }, 'ward-nurse'), (e) => code('conflict')(e) && e.detail.changed[0] === 'gloves-m');
  assert.equal(await usableAt(core, 'gloves-m', WARD), 22, 'the delivery was not overwritten');
  // Another item at the same place did not move, so its count still goes through.
  await run(core, 'count', { placeId: WARD, lines: [{ itemId: 'syringe-5', qty: 1 }], seenSeq: seen.asOfSeq }, 'ward-nurse');
  // Cancelling the open request, with a picked reason.
  const gone = await run(core, 'request_cancel', { requestId: first.requestId, reason: 'No longer needed', expectedState: 'open' }, 'ward-nurse');
  assert.equal(gone.state, 'cancelled');
  await assert.rejects(run(core, 'request_cancel', { requestId: first.requestId, reason: 'Other' }, 'ward-nurse'), code('conflict'));
  await assert.rejects(run(core, 'issue', { requestId: first.requestId }, 'estates-tech'), code('conflict'));
});

test('batches: every line names its batch; balances add up; expiry is carried, and expired stock cannot move', async () => {
  const core = await site();
  await assert.rejects(run(core, 'receive', { placeId: STORE, lines: [{ itemId: 'saline-500', qty: 10 }], source: 'Purchase' }, 'estates-tech'), code('invalid-input'), 'a batched item with no batch');
  await assert.rejects(run(core, 'receive', { placeId: STORE, lines: [{ itemId: 'gloves-m', qty: 10, batch: 'LOT1' }], source: 'Purchase' }, 'estates-tech'), code('invalid-input'), 'a batch on an item that has none');
  await assert.rejects(run(core, 'receive', { placeId: STORE, lines: [{ itemId: 'saline-500', qty: 10, batch: 'LOT1', expiresOn: '2027-02-30' }], source: 'Purchase' }, 'estates-tech'), code('invalid-input'), 'not a real date');
  await run(core, 'receive', { placeId: STORE, lines: [{ itemId: 'saline-500', qty: 10, batch: 'LOT1', expiresOn: '2026-11-08' }, { itemId: 'saline-500', qty: 6, batch: 'LOT2', expiresOn: '2027-06-30' }], source: 'Purchase' }, 'estates-tech');
  await assert.rejects(run(core, 'receive', { placeId: STORE, lines: [{ itemId: 'saline-500', qty: 1, batch: 'LOT1', expiresOn: '2026-12-01' }], source: 'Purchase' }, 'estates-tech'), code('conflict'), 'one batch has one date');
  let row = (await run(core, 'levels', { placeId: STORE, itemId: 'saline-500' }, 'estates-tech')).levels[0];
  assert.equal(row.usable, 16);
  assert.deepEqual(row.batches.map((b) => [b.batch, b.qty, b.expiresOn]), [['LOT1', 10, '2026-11-08'], ['LOT2', 6, '2027-06-30']], 'earliest expiry first; the batches sum to the balance');
  assert.equal(row.nearExpiry, 1);
  await assert.rejects(run(core, 'write_off', { placeId: STORE, lines: [{ itemId: 'saline-500', qty: 7, batch: 'LOT2' }], reason: 'Lost' }, 'estates-tech'), code('conflict'), 'above the batch balance');
  // A transfer carries the batch's expiry date with it.
  await run(core, 'transfer', { fromPlaceId: STORE, toPlaceId: WARD, lines: [{ itemId: 'saline-500', qty: 4, batch: 'LOT1' }] }, 'estates-tech');
  row = (await run(core, 'levels', { placeId: WARD, itemId: 'saline-500' }, 'ward-nurse')).levels[0];
  assert.deepEqual(row.batches.map((b) => [b.batch, b.qty, b.expiresOn]), [['LOT1', 4, '2026-11-08']]);
  // A request for a batched item is issued by naming the batch; the answer says which batches are there.
  const q = await run(core, 'request', { placeId: WARD, lines: [{ itemId: 'saline-500', qty: 3 }] }, 'ward-nurse');
  await assert.rejects(run(core, 'issue', { requestId: q.requestId }, 'estates-tech'), (e) => code('invalid-input')(e) && /LOT1 \(6, expires 2026-11-08\); LOT2 \(6/.test(e.message));
  // Three days on, LOT1 is past its date: not usable, cannot be issued or moved, can be written off.
  core.skip(3 * DAY);
  row = (await run(core, 'levels', { placeId: STORE, itemId: 'saline-500' }, 'estates-tech')).levels[0];
  assert.deepEqual([row.usable, row.expired], [6, 6]);
  await assert.rejects(run(core, 'issue', { requestId: q.requestId, lines: [{ itemId: 'saline-500', qty: 3, batch: 'LOT1' }] }, 'estates-tech'), (e) => code('conflict')(e) && /expiry date/.test(e.message));
  await assert.rejects(run(core, 'transfer', { fromPlaceId: STORE, toPlaceId: WARD, lines: [{ itemId: 'saline-500', qty: 1, batch: 'LOT1' }] }, 'estates-tech'), code('conflict'));
  await run(core, 'issue', { requestId: q.requestId, lines: [{ itemId: 'saline-500', qty: 3, batch: 'LOT2' }] }, 'estates-tech');
  await run(core, 'write_off', { placeId: STORE, lines: [{ itemId: 'saline-500', qty: 6, batch: 'LOT1' }], reason: 'Expired' }, 'estates-tech');
  row = (await run(core, 'levels', { placeId: STORE, itemId: 'saline-500' }, 'estates-tech')).levels[0];
  assert.deepEqual([row.usable, row.expired, row.batches.map((b) => b.batch)], [3, 0, ['LOT2']]);
  assert.equal(deriveStock(await core.events({ type: STOCK_EVENT_TYPES }), CAT).problems, 0);
});

test('an expiry date is read at the end of that day in the site\'s own time zone', () => {
  assert.equal(new Date(expiryMs('2026-11-10', 0)).toISOString(), '2026-11-11T00:00:00.000Z');
  assert.equal(new Date(expiryMs('2026-11-10', -240)).toISOString(), '2026-11-11T04:00:00.000Z', 'four hours behind UTC: the day ends four hours later');
  assert.equal(new Date(expiryMs('2026-11-10', 330)).toISOString(), '2026-11-10T18:30:00.000Z');
  assert.ok(validDate('2028-02-29') && !validDate('2027-02-29') && !validDate('2027-13-01') && !validDate('27-01-01'));
  const stock = derive([[0, 'received', 'ward-a1', { lines: [{ itemId: 'saline-500', qty: 5, batch: 'B1', expiresOn: '2026-10-10' }], source: 'Purchase' }]], -240);
  const h = holdingOf(stock, 'saline-500', 'ward-a1');
  const edge = Date.parse('2026-10-11T04:00:00.000Z');
  assert.deepEqual(balance(h, edge - 1, -240), { usable: 5, onHold: 0, expired: 0 });
  assert.deepEqual(balance(h, edge, -240), { usable: 0, onHold: 0, expired: 5 });
  assert.equal(nearExpiry(h, D0, 30, -240).length, 1);
  assert.equal(nearExpiry(h, D0, 5, -240).length, 0, 'ten days off is not within five');
  assert.equal(batchList(h, D0, -240)[0].daysToExpiry, 10);
  // With nothing else there, the item has nothing usable from that moment on.
  assert.deepEqual(zeroIntervals(h, edge + DAY, -240), [[edge, edge + DAY]]);
});

test('stock on hold is not usable; a person releases it; held stock can be written off', async () => {
  const core = await site();
  await run(core, 'receive', { placeId: STORE, lines: [{ itemId: 'gloves-m', qty: 10 }], source: 'Purchase' }, 'estates-tech');
  await run(core, 'hold', { placeId: STORE, lines: [{ itemId: 'gloves-m', qty: 6 }], reason: 'Damaged packaging' }, 'estates-tech');
  let row = (await levels(core, { placeId: STORE, itemId: 'gloves-m' }))[0];
  assert.deepEqual([row.usable, row.onHold], [4, 6]);
  await assert.rejects(run(core, 'transfer', { fromPlaceId: STORE, toPlaceId: WARD, lines: [{ itemId: 'gloves-m', qty: 5 }] }, 'estates-tech'), code('conflict'), 'held stock cannot move');
  await assert.rejects(run(core, 'hold', { placeId: STORE, lines: [{ itemId: 'gloves-m', qty: 5 }], reason: 'Other' }, 'estates-tech'), code('conflict'), 'only 4 are left to hold');
  await assert.rejects(run(core, 'release', { placeId: STORE, lines: [{ itemId: 'gloves-m', qty: 2 }] }, 'estates-tech'), code('forbidden'), 'the role that held it does not release it here');
  await assert.rejects(run(core, 'release', { placeId: STORE, lines: [{ itemId: 'gloves-m', qty: 7 }] }, 'ops-manager'), code('conflict'));
  await run(core, 'release', { placeId: STORE, lines: [{ itemId: 'gloves-m', qty: 2 }] }, 'ops-manager');
  await run(core, 'write_off', { placeId: STORE, lines: [{ itemId: 'gloves-m', qty: 4 }], reason: 'Damaged or broken', fromHold: true }, 'estates-tech');
  row = (await levels(core, { placeId: STORE, itemId: 'gloves-m' }))[0];
  assert.deepEqual([row.usable, row.onHold], [6, 0]);
  // A count sets what is usable and leaves held stock alone.
  await run(core, 'hold', { placeId: STORE, lines: [{ itemId: 'gloves-m', qty: 1 }], reason: 'Recall notice' }, 'estates-tech');
  await run(core, 'count', { placeId: STORE, lines: [{ itemId: 'gloves-m', qty: 9 }] }, 'estates-tech');
  row = (await levels(core, { placeId: STORE, itemId: 'gloves-m' }))[0];
  assert.deepEqual([row.usable, row.onHold], [9, 1]);
});

test('a double tap writes once: the same movement within two minutes is refused unless it is sent as a second one', async () => {
  const core = await site();
  const delivery = { placeId: STORE, lines: [{ itemId: 'gloves-m', qty: 10 }], source: 'Purchase' };
  await run(core, 'receive', delivery, 'estates-tech');
  await assert.rejects(run(core, 'receive', delivery, 'estates-tech'), (e) => code('conflict')(e) && e.detail.confirm === 'again');
  assert.equal(await usableAt(core, 'gloves-m', STORE), 10);
  await run(core, 'receive', { ...delivery, again: true }, 'estates-tech');
  assert.equal(await usableAt(core, 'gloves-m', STORE), 20);
  core.skip(3 * 60e3);
  await run(core, 'receive', delivery, 'estates-tech');
  assert.equal(await usableAt(core, 'gloves-m', STORE), 30, 'three minutes later it is a new delivery');
  const move = { fromPlaceId: STORE, toPlaceId: WARD, lines: [{ itemId: 'gloves-m', qty: 5 }] };
  await run(core, 'transfer', move, 'estates-tech');
  await assert.rejects(run(core, 'transfer', move, 'estates-tech'), code('conflict'));
  // Two taps at the same moment (two tabs): the checked append lets one through.
  const use = { placeId: WARD, lines: [{ itemId: 'gloves-m', qty: 2 }] };
  const both = await Promise.allSettled([run(core, 'use', use, 'ward-nurse'), run(core, 'use', use, 'ward-nurse')]);
  assert.deepEqual(both.map((r) => r.status).sort(), ['fulfilled', 'rejected']);
  assert.equal(await usableAt(core, 'gloves-m', WARD), 3);
  const two = await Promise.allSettled([run(core, 'out_start', { itemId: 'syringe-5', placeId: WARD, cause: 'Not delivered' }, 'ward-nurse'), run(core, 'out_start', { itemId: 'syringe-5', placeId: WARD, cause: 'Not delivered' }, 'ward-nurse')]);
  assert.deepEqual(two.map((r) => r.status).sort(), ['fulfilled', 'rejected']);
});

test('attack: a role outside the list, a made-up id, an unknown field, and another category\'s stock are all refused', async () => {
  const core = await site();
  await run(core, 'receive', { placeId: STORE, lines: [{ itemId: 'gloves-m', qty: 10 }], source: 'Purchase' }, 'estates-tech');
  await assert.rejects(run(core, 'receive', { placeId: STORE, lines: [{ itemId: 'gloves-m', qty: 1 }], source: 'Purchase' }, 'bed-manager'), code('forbidden'), 'a role with no stock rights');
  await assert.rejects(run(core, 'write_off', { placeId: STORE, lines: [{ itemId: 'gloves-m', qty: 1 }], reason: 'Lost' }, 'ward-nurse'), code('forbidden'), 'a ward nurse does not write stock off here');
  await assert.rejects(run(core, 'level_set', { itemId: 'gloves-m', placeId: WARD, level: 500 }, 'ward-nurse'), code('forbidden'));
  // The emergency nurse in charge holds vaccine rights only: the supplies line is refused inside the command.
  await assert.rejects(run(core, 'receive', { placeId: STORE, lines: [{ itemId: 'gloves-m', qty: 1 }], source: 'Purchase' }, 'ae-nic'), (e) => code('forbidden')(e) && /supplies stock/.test(e.message));
  await assert.rejects(run(core, 'level_set', { itemId: 'vac-a', placeId: STORE, level: 5 }, 'ops-manager'), code('forbidden'));
  await assert.rejects(run(core, 'count', { placeId: WARD, lines: [{ itemId: 'vac-a', qty: 0, batch: 'V1' }] }, 'ward-nurse'), code('forbidden'));
  // Made-up ids: refused, and the made-up text is never sent back.
  const madeUp = async (name, input, role) => {
    const err = await run(core, name, input, role).then(() => null, (e) => e);
    assert.ok(code('not-found')(err), `${name}: ${err?.code}`);
    assert.ok(!/zz-made-up|req-99999|so-99999/.test(JSON.stringify([err.message, err.detail])), `${name} does not echo the id`);
  };
  await madeUp('count', { placeId: WARD, lines: [{ itemId: 'zz-made-up', qty: 1 }] }, 'ward-nurse');
  await madeUp('count', { placeId: 'zz-made-up', lines: [{ itemId: 'gloves-m', qty: 1 }] }, 'ward-nurse');
  await madeUp('issue', { requestId: 'req-99999' }, 'estates-tech');
  await madeUp('out_end', { stockOutId: 'so-99999', careAffected: false }, 'ward-nurse');
  await madeUp('levels', { placeId: 'zz-made-up' }, 'ward-nurse');
  // A bed is not a place that holds stock.
  await assert.rejects(run(core, 'count', { placeId: 'ward-a1-bed-01', lines: [{ itemId: 'gloves-m', qty: 1 }] }, 'ward-nurse'), code('not-found'));
  // Fields the command does not know, and values outside its limits, stop at the schema.
  for (const input of [
    { placeId: WARD, lines: [{ itemId: 'gloves-m', qty: 1, price: 4 }] }, { placeId: WARD, lines: [{ itemId: 'gloves-m', qty: 1 }], note: 'for Mr Example' },
    { placeId: WARD, lines: [{ itemId: 'gloves-m', qty: -1 }] }, { placeId: WARD, lines: [{ itemId: 'gloves-m', qty: 1.5 }] }, { placeId: WARD, lines: [{ itemId: 'gloves-m', qty: 100001 }] },
    { placeId: WARD, lines: [] }, { placeId: WARD, lines: Array.from({ length: 101 }, () => ({ itemId: 'gloves-m', qty: 1 })) },
    { placeId: WARD, lines: [{ itemId: 'saline-500', qty: 1, batch: 'lot one; DROP' }] }, { placeId: WARD, lines: [{ itemId: 'Gloves<script>', qty: 1 }] },
  ]) await assert.rejects(run(core, 'count', input, 'ward-nurse'), code('invalid-input'), JSON.stringify(input).slice(0, 80));
  await assert.rejects(run(core, 'count', { placeId: WARD, lines: [{ itemId: 'gloves-m', qty: 1 }, { itemId: 'gloves-m', qty: 2 }] }, 'ward-nurse'), code('invalid-input'), 'one item twice');
  await assert.rejects(run(core, 'receive', { placeId: STORE, lines: [{ itemId: 'gloves-m', qty: 1 }], source: 'Gift from a friend' }, 'estates-tech'), code('invalid-input'));
  await assert.rejects(run(core, 'write_off', { placeId: STORE, lines: [{ itemId: 'gloves-m', qty: 1 }], reason: 'Stolen by a named person' }, 'estates-tech'), code('invalid-input'));
  assert.equal(await usableAt(core, 'gloves-m', STORE), 10, 'nothing above changed the balance');
});

test('adding an item: people only, a thing and never a person, no price or supplier; the log still passes the import guard', async () => {
  const core = await site();
  const made = await run(core, 'item_add', { name: 'Examination gloves, large', unit: 'box of 100', category: 'supplies', tracer: true }, 'ops-manager');
  assert.equal(made.itemId, 'item-00001');
  const items = await run(core, 'items', { category: 'supplies' }, 'ward-nurse');
  assert.ok(items.items.some((it) => it.id === 'item-00001' && it.name === 'Examination gloves, large' && it.siteAdded && it.tracer));
  assert.ok(items.items.every((it) => it.category === 'supplies'), 'the supplies read shows no vaccines');
  assert.deepEqual((await run(core, 'items', { coldChain: true }, 'ward-nurse')).items.map((it) => it.id), ['vac-a']);
  assert.deepEqual(items.stores, [{ id: 'store-main', name: 'Main store' }]);
  await run(core, 'receive', { placeId: STORE, lines: [{ itemId: 'item-00001', qty: 5 }], source: 'Donation' }, 'estates-tech');
  assert.equal(await usableAt(core, 'item-00001', STORE), 5);
  await assert.rejects(run(core, 'item_add', { name: 'examination gloves, LARGE', unit: 'box', category: 'supplies' }, 'ops-manager'), (e) => code('conflict')(e) && e.detail.existing === 'item-00001');
  await assert.rejects(run(core, 'item_add', { name: 'Dr Jane Placeholder', unit: 'box', category: 'supplies' }, 'ops-manager'), code('invalid-input'), 'a titled name');
  await assert.rejects(run(core, 'item_add', { name: 'Call 555 0100 for more', unit: 'box', category: 'supplies' }, 'ops-manager'), code('invalid-input'), 'a phone number');
  const asked = await run(core, 'item_add', { name: 'Jane Placeholder', unit: 'box', category: 'supplies' }, 'ops-manager').then(() => null, (e) => e);
  assert.ok(code('invalid-input')(asked) && asked.detail?.confirm === 'notAName', 'a name with no title is asked about once');
  await assert.rejects(run(core, 'item_add', { name: 'Thing', unit: 'box', category: 'supplies', price: 2 }, 'ops-manager'), code('invalid-input'));
  await assert.rejects(run(core, 'item_add', { name: 'Thing', unit: 'box', category: 'supplies', supplier: 'A company' }, 'ops-manager'), code('invalid-input'));
  await assert.rejects(run(core, 'item_add', { name: 'Tablets', unit: 'box', category: 'supplies', dosesPerVial: 10 }, 'ops-manager'), code('invalid-input'), 'doses per vial only for a vial');
  await assert.rejects(run(core, 'item_add', { name: 'Thing', unit: 'box', category: 'supplies' }, 'ward-nurse'), code('forbidden'));
  await assert.rejects(run(core, 'item_add', { name: 'Example vaccine B', unit: 'vial', category: 'vaccine' }, 'ops-manager'), code('forbidden'), 'not this role\'s category');
  // The typed name is in the event (as label) and nowhere in the audit trail; no event field is called name.
  const evs = await core.events({ type: STOCK_EVENT_TYPES });
  assert.equal(evs.find((e) => e.type === 'stock.item-added').data.label, 'Examination gloves, large');
  assert.equal(JSON.stringify((await core.auditLog()).filter((e) => e.action.startsWith('stock.'))).includes('gloves, large'), false);
  assert.deepEqual(findIdentifierFields({ events: evs }), [], 'an export of this log is accepted back (rule 1 key guard)');
  assert.deepEqual(findIdentifierValues({ events: evs }), []);
  assert.equal(/"(price|value|currency|brand|supplier)"/.test(JSON.stringify(evs)), false);
});

test('stock-outs: a person declares one with a cause and closes it with a yes or no; the log shows what is out and not declared', async () => {
  const core = await site();
  await run(core, 'level_set', { itemId: 'gloves-m', placeId: WARD, level: 10 }, 'ops-manager');
  await run(core, 'count', { placeId: WARD, lines: [{ itemId: 'gloves-m', qty: 0 }], raiseRequest: false }, 'ward-nurse');
  let outs = await run(core, 'outs', { placeId: WARD }, 'ward-nurse');
  assert.deepEqual([outs.stockOuts.length, outs.notDeclared.map((x) => x.itemId)], [0, ['gloves-m']], 'a zero count starts nothing by itself; it is listed for a person');
  const so = await run(core, 'out_start', { itemId: 'gloves-m', placeId: WARD, cause: 'Not delivered' }, 'ward-nurse');
  assert.equal(so.stockOutId, 'so-00001');
  await assert.rejects(run(core, 'out_start', { itemId: 'gloves-m', placeId: WARD, cause: 'Other' }, 'ward-nurse'), (e) => code('conflict')(e) && e.detail.existing === 'so-00001');
  await assert.rejects(run(core, 'out_start', { itemId: 'gloves-m', placeId: WARD, cause: 'Somebody forgot' }, 'ward-nurse'), code('invalid-input'));
  outs = await run(core, 'outs', { state: 'open' }, 'ward-nurse');
  assert.deepEqual([outs.stockOuts.map((s) => [s.id, s.open, s.cause]), outs.notDeclared], [[['so-00001', true, 'Not delivered']], []]);
  core.skip(5 * HOUR);
  const ended = await run(core, 'out_end', { stockOutId: 'so-00001', careAffected: true }, 'ward-nurse');
  assert.ok(ended.hours >= 5 && ended.hours < 5.1);
  await assert.rejects(run(core, 'out_end', { stockOutId: 'so-00001', careAffected: false }, 'ward-nurse'), code('conflict'));
  await assert.rejects(run(core, 'out_end', { stockOutId: 'so-00001', careAffected: 'the patient in bed 4 waited' }, 'ward-nurse'), code('invalid-input'), 'a yes or no only');
  outs = await run(core, 'outs', { state: 'ended' }, 'ward-nurse');
  assert.deepEqual(outs.stockOuts.map((s) => [s.open, s.careAffected]), [[false, true]]);
});

test('stock-out rate (D-17): declared and worked-out time with nothing usable are joined, never counted twice, across a period edge', () => {
  const W = 'ward-a1';
  const stock = derive([
    [0, 'received', W, { lines: [{ itemId: 'gloves-m', qty: 10 }], source: 'Purchase' }],
    [1, 'received', W, { lines: [{ itemId: 'syringe-5', qty: 10 }], source: 'Purchase' }],
    [2, 'counted', W, { lines: [{ itemId: 'gloves-m', qty: 0 }] }], // nothing usable from day 2
    [3, 'stock-out-started', 'so-00001', { itemId: 'gloves-m', placeId: W, cause: 'Not delivered' }], // declared from day 3
    [5, 'received', W, { lines: [{ itemId: 'gloves-m', qty: 5 }], source: 'Purchase' }], // usable again on day 5
    [6, 'stock-out-ended', 'so-00001', { careAffected: false }], // closed a day late, on day 6
  ]);
  assert.equal(stock.problems, 0);
  assert.deepEqual(zeroIntervals(holdingOf(stock, 'gloves-m', W), D0 + 10 * DAY), [[D0 + 2 * DAY, D0 + 5 * DAY]]);
  // Days 0 to 10. Gloves: 10 item-days, out from day 2 to day 6 = 4 (declared 3, worked out 3, joined 4). Syringes: 9 item-days, never out.
  const whole = stockOutRate(stock, { since: at(0), until: at(10) });
  assert.deepEqual([whole.numerator, whole.denominator, whole.holdings, whole.declaredDays, whole.derivedDays], [4, 19, 2, 3, 3]);
  assert.equal(Math.round(whole.value * 100) / 100, 21.05);
  // Days 4 to 10: gloves out from day 4 to day 6 = 2 of 6; syringes 6: 2 of 12.
  const late = stockOutRate(stock, { since: at(4), until: at(10) });
  assert.deepEqual([late.numerator, late.denominator], [2, 12]);
  // Tracer items only (gloves): 4 of 10.
  const tracer = stockOutRate(stock, { since: at(0), until: at(10), pick: (it) => it.tracer });
  assert.deepEqual([tracer.numerator, tracer.denominator, tracer.value], [4, 10, 40]);
  // A stock-out still open runs to the end of the period; an end before its start, or a second start, is not read.
  const open = derive([
    [0, 'received', W, { lines: [{ itemId: 'gloves-m', qty: 1 }], source: 'Purchase' }],
    [4, 'stock-out-started', 'so-00001', { itemId: 'gloves-m', placeId: W, cause: 'Other' }],
    [4, 'stock-out-started', 'so-00001', { itemId: 'gloves-m', placeId: W, cause: 'Other' }],
  ]);
  assert.equal(open.problems, 1);
  assert.deepEqual([stockOutRate(open, { since: at(0), until: at(10) }).numerator, stockOutRate(open, { since: at(0), until: at(10) }).denominator], [6, 10]);
  assert.equal(stockOutRate(derive([]), { since: at(0), until: at(10) }).value, null, 'no holdings: no rate, not zero');
  // Tracer availability now: gloves have a level and stock, so 1 of 1; the syringes have no level and are not counted.
  const lv = derive([[0, 'level-set', W, { itemId: 'gloves-m', level: 5 }], [0, 'level-set', 'ward-a2', { itemId: 'gloves-m', level: 5 }], [1, 'received', W, { lines: [{ itemId: 'gloves-m', qty: 2 }], source: 'Purchase' }]]);
  assert.deepEqual(tracerAvailability(lv, { now: at(2) }), { value: 50, numerator: 1, denominator: 2 });
});

test('fill rate, request wait and days of stock left, checked by hand; open requests are shown, never dropped', () => {
  const W = 'ward-a1'; const S = 'store-main';
  const hours = (d, h) => d + h / 24;
  const stock = derive([
    [0, 'received', S, { lines: [{ itemId: 'gloves-m', qty: 100 }, { itemId: 'syringe-5', qty: 100 }], source: 'Purchase' }],
    [0, 'requested', 'req-00001', { placeId: W, fromPlaceId: S, lines: [{ itemId: 'gloves-m', qty: 4 }, { itemId: 'syringe-5', qty: 2 }], raisedBy: 'count' }],
    [hours(0, 6), 'issued', 'req-00001', { lines: [{ itemId: 'gloves-m', qty: 4 }, { itemId: 'syringe-5', qty: 2 }] }], // in full after 6 hours
    [1, 'requested', 'req-00002', { placeId: 'ward-a2', fromPlaceId: S, lines: [{ itemId: 'gloves-m', qty: 6 }] }],
    [hours(1, 4), 'issued', 'req-00002', { lines: [{ itemId: 'gloves-m', qty: 2 }] }], // part: the clock keeps running
    [hours(1, 10), 'issued', 'req-00002', { lines: [{ itemId: 'gloves-m', qty: 4 }] }], // in full after 10 hours
    [2, 'requested', 'req-00003', { placeId: 'ward-a3', fromPlaceId: S, lines: [{ itemId: 'syringe-5', qty: 9 }] }],
    [hours(2, 1), 'issued', 'req-00003', { lines: [{ itemId: 'syringe-5', qty: 3 }] }], // part only, still open
    [2, 'requested', 'req-00004', { placeId: 'ward-b1', fromPlaceId: S, lines: [{ itemId: 'syringe-5', qty: 1 }] }],
    [hours(2, 2), 'request-cancelled', 'req-00004', { reason: 'No longer needed' }],
    [hours(2, 3), 'issued', 'req-00004', { lines: [{ itemId: 'syringe-5', qty: 1 }] }], // an issue against a cancelled request is not read
  ]);
  assert.equal(stock.problems, 1);
  assert.deepEqual([...stock.requests.values()].map((q) => q.state), ['issued', 'issued', 'part', 'cancelled']);
  // Lines raised on live requests: 2 + 1 + 1 = 4; issued in full: 3. The cancelled request is counted apart.
  assert.deepEqual(fillRate(stock, { since: at(0), until: at(3) }), { value: 75, numerator: 3, denominator: 4, requests: 3, cancelled: 1 });
  // Waits of 6 and 10 hours: median 8. One request still open, raised on day 2: 24 hours so far on day 3.
  const wait = requestWait(stock, { since: at(0), until: at(3) });
  assert.deepEqual([wait.value, wait.n, wait.open, wait.longestOpenHours], [8, 2, 1, 24]);
  assert.equal(usableOf(stock, 'gloves-m', S, at(3)), 90);
  assert.equal(usableOf(stock, 'syringe-5', S, at(3)), 95);
  assert.equal(usableOf(stock, 'syringe-5', 'ward-a3', at(3)), 3);
  // Days of stock left: 10 used and a count that found 4 fewer, over 28 days = 0.5 a day; 6 usable = 12 days.
  const use = derive([
    [0, 'received', W, { lines: [{ itemId: 'gloves-m', qty: 20 }], source: 'Purchase' }],
    [5, 'used', W, { lines: [{ itemId: 'gloves-m', qty: 10 }] }],
    [9, 'counted', W, { lines: [{ itemId: 'gloves-m', qty: 6 }] }],
    [9, 'written-off', 'ward-a2', { lines: [{ itemId: 'gloves-m', qty: 1 }], reason: 'Lost' }], // nothing there: not read
  ]);
  const h = holdingOf(use, 'gloves-m', W);
  assert.equal(balance(h, at(10)).usable, 6);
  assert.equal(daysOfStockLeft(h, at(10)), 12);
  assert.equal(daysOfStockLeft(h, at(40)), null, 'no use in the last 28 days: no rate and no guess');
  assert.equal(daysOfStockLeft(holdingOf(stock, 'gloves-m', S), at(3)), null);
  assert.equal(use.problems, 1, 'a movement that would take a balance below zero is counted as a problem and stops at zero');
  assert.equal(usableOf(use, 'gloves-m', 'ward-a2', at(10)), 0);
});

test('doses and vials, for counting only; the vaccine category stays apart from ward supplies', async () => {
  const vac = CAT.items.get('vac-a');
  assert.deepEqual([toDoses(vac, 3), toVials(vac, 30), toVials(vac, 31), toVials(vac, 1)], [30, 3, 4, 1]);
  assert.deepEqual([toDoses(CAT.items.get('gloves-m'), 3), toVials(CAT.items.get('gloves-m'), 3)], [null, null]);
  const core = await site();
  await run(core, 'receive', { placeId: STORE, lines: [{ itemId: 'vac-a', qty: 20, batch: 'V1', expiresOn: '2027-03-31' }], source: 'Purchase' }, 'ae-nic');
  await run(core, 'receive', { placeId: STORE, lines: [{ itemId: 'gloves-m', qty: 5 }], source: 'Purchase' }, 'estates-tech');
  // A session: 8 vials out to a ward, 5 opened (used), 1 written off for heat exposure, 2 come back usable.
  await run(core, 'transfer', { fromPlaceId: STORE, toPlaceId: 'ward-c1', lines: [{ itemId: 'vac-a', qty: 8, batch: 'V1' }], ref: { module: 'publichealth', id: 'session-00001' } }, 'ae-nic');
  await run(core, 'use', { placeId: 'ward-c1', lines: [{ itemId: 'vac-a', qty: 5, batch: 'V1' }], ref: { module: 'publichealth', id: 'session-00001' } }, 'ae-nic');
  await run(core, 'write_off', { placeId: 'ward-c1', lines: [{ itemId: 'vac-a', qty: 1, batch: 'V1' }], reason: 'Heat exposure' }, 'ae-nic');
  await run(core, 'transfer', { fromPlaceId: 'ward-c1', toPlaceId: STORE, lines: [{ itemId: 'vac-a', qty: 2, batch: 'V1' }], ref: { module: 'publichealth', id: 'session-00001' } }, 'ae-nic');
  const stock = deriveStock(await core.events({ type: STOCK_EVENT_TYPES }), CAT);
  assert.deepEqual([usableOf(stock, 'vac-a', STORE, core.now()), usableOf(stock, 'vac-a', 'ward-c1', core.now())], [14, 0]);
  const session = stock.transfers.filter((t) => t.ref?.id === 'session-00001');
  assert.deepEqual(session.map((t) => [t.fromPlaceId, t.toPlaceId, t.lines[0].qty]), [[STORE, 'ward-c1', 8], ['ward-c1', STORE, 2]], 'what went out and what came back usable, for the module that owns dose wastage');
  assert.equal(holdingOf(stock, 'vac-a', 'ward-c1').use.reduce((s, u) => s + u.qty, 0), 5, 'vials opened are use, not waste');
  // Each module's screens ask for their own category.
  const supplies = await levels(core, { category: 'supplies' });
  const vaccines = await levels(core, { category: 'vaccine' });
  assert.ok(supplies.length && supplies.every((r) => r.category === 'supplies'));
  assert.ok(vaccines.length && vaccines.every((r) => r.category === 'vaccine'));
  assert.ok((await levels(core, { coldChain: false })).every((r) => r.itemId !== 'vac-a'));
});

test('an agent limited to some wards reads those wards and the stores, and no other ward', async () => {
  const core = await site();
  await run(core, 'receive', { placeId: WARD, lines: [{ itemId: 'gloves-m', qty: 3 }], source: 'Purchase' }, 'estates-tech');
  await run(core, 'receive', { placeId: 'ward-a2', lines: [{ itemId: 'gloves-m', qty: 4 }], source: 'Purchase' }, 'estates-tech');
  await run(core, 'receive', { placeId: STORE, lines: [{ itemId: 'gloves-m', qty: 9 }], source: 'Purchase' }, 'estates-tech');
  await run(core, 'request', { placeId: 'ward-a2', lines: [{ itemId: 'gloves-m', qty: 1 }] }, 'ward-nurse');
  const mine = { wards: new Set([WARD]) };
  assert.deepEqual((await run(core, 'levels', {}, 'ward-nurse', mine)).levels.map((r) => r.placeId).sort(), [STORE, WARD]);
  assert.equal((await run(core, 'requests', {}, 'ward-nurse', mine)).total, 0);
  assert.equal((await run(core, 'requests', {}, 'ward-nurse')).total, 1);
  assert.equal(await CMDS.ospeli_stock_count.wardOf(core, { placeId: WARD }), WARD, 'a ward count is the ward\'s own business for the agent ward switch');
  assert.equal(await CMDS.ospeli_stock_count.wardOf(core, { placeId: STORE }), null);
});

test('a proposal is checked before it waits and again when a person accepts it', async () => {
  const core = await site();
  await run(core, 'receive', { placeId: STORE, lines: [{ itemId: 'gloves-m', qty: 5 }], source: 'Purchase' }, 'estates-tech');
  const move = { fromPlaceId: STORE, toPlaceId: WARD, lines: [{ itemId: 'gloves-m', qty: 4 }] };
  const agent = { actor: { type: 'agent', agent: 'stock-bot', role: 'estates-tech' } };
  // What the command layer runs before an agent's call becomes a proposal: nothing is written.
  await CMDS.ospeli_stock_transfer.precheck(core, move, agent);
  await assert.rejects(CMDS.ospeli_stock_transfer.precheck(core, { ...move, lines: [{ itemId: 'gloves-m', qty: 6 }] }, agent), code('conflict'));
  await assert.rejects(CMDS.ospeli_stock_transfer.precheck(core, move, { actor: { type: 'agent', agent: 'stock-bot', role: 'bed-manager' } }), code('forbidden'));
  assert.equal(await usableAt(core, 'gloves-m', STORE), 5);
  // Meanwhile a person uses the stock; the acceptance runs the command again and is refused.
  await run(core, 'write_off', { placeId: STORE, lines: [{ itemId: 'gloves-m', qty: 3 }], reason: 'Damaged or broken' }, 'estates-tech');
  await assert.rejects(run(core, 'transfer', move, 'estates-tech'), code('conflict'));
  assert.deepEqual([await usableAt(core, 'gloves-m', STORE), await usableAt(core, 'gloves-m', WARD)], [2, 0]);
});
