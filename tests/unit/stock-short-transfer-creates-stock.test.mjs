// deriveStock: "a movement never takes a balance below zero", but a transfer (or an issue) whose
// source is short takes what is there and still adds the full line at the destination.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ROLES } from '../../web/app/core/model.js';
import { stockCatalogue, deriveStock, usableOf } from '../../web/app/core/stock.js';

const CAT = stockCatalogue([{ id: 't', STOCK_CATEGORIES: { supplies: { name: 'Supplies', roles: Object.fromEntries(['count', 'request', 'issue', 'receive', 'transfer', 'use', 'writeOff', 'hold', 'release', 'levels', 'itemAdd'].map((v) => [v, []])) } },
  STOCK_ITEMS: [{ id: 'gloves-m', name: 'Examination gloves, medium', unit: 'box of 100', category: 'supplies' }] }], ROLES.map((r) => r.id));
const ev = (seq, type, subject, data) => ({ seq, type: `stock.${type}`, subject, actorRole: 'ward-nurse', at: new Date(Date.parse('2026-10-01T00:00:00Z') + seq * 36e5).toISOString(), data });
const total = (s, now) => usableOf(s, 'gloves-m', 'ward-a1', now) + usableOf(s, 'gloves-m', 'ward-a2', now) + usableOf(s, 'gloves-m', 'store-main', now);

test('a transfer of more than the source holds moves only what is there', () => {
  const s = deriveStock([ev(1, 'received', 'ward-a1', { lines: [{ itemId: 'gloves-m', qty: 3 }], source: 'Purchase' }),
    ev(2, 'transferred', 'trf-00001', { fromPlaceId: 'ward-a1', toPlaceId: 'ward-a2', lines: [{ itemId: 'gloves-m', qty: 10 }] })], CAT);
  assert.equal(s.problems, 1, 'the short line is counted as a problem');
  assert.equal(total(s, '2026-10-02T00:00:00Z'), 3, '3 were received on the whole site; after the transfer the site holds');
});
test('an issue of more than the supplier holds moves only what is there', () => {
  const s = deriveStock([ev(1, 'received', 'store-main', { lines: [{ itemId: 'gloves-m', qty: 3 }], source: 'Purchase' }),
    ev(2, 'requested', 'req-00001', { placeId: 'ward-a1', fromPlaceId: 'store-main', lines: [{ itemId: 'gloves-m', qty: 10 }], raisedBy: 'request' }),
    ev(3, 'issued', 'req-00001', { lines: [{ itemId: 'gloves-m', qty: 10 }] })], CAT);
  assert.equal(total(s, '2026-10-02T00:00:00Z'), 3, '3 were received on the whole site; after the issue the site holds');
});
