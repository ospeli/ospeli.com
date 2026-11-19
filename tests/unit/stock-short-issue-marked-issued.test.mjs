// Audit finding: the short-move fix (#128 point 3) adds at the destination only what the source gave
// up, but an issue still books the full line against the request. A request for 10 answered by an
// issue line of 10 from a store that held 3 moves 3 boxes and is then shown as fully issued (10 of 10).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ROLES } from '../../web/app/core/model.js';
import { stockCatalogue, deriveStock, usableOf } from '../../web/app/core/stock.js';

const CAT = stockCatalogue([{ id: 't', STOCK_CATEGORIES: { supplies: { name: 'Supplies', roles: Object.fromEntries(['count', 'request', 'issue', 'receive', 'transfer', 'use', 'writeOff', 'hold', 'release', 'levels', 'itemAdd'].map((v) => [v, []])) } },
  STOCK_ITEMS: [{ id: 'gloves-m', name: 'Examination gloves, medium', unit: 'box of 100', category: 'supplies' }] }], ROLES.map((r) => r.id));
const ev = (seq, type, subject, data) => ({ seq, type: `stock.${type}`, subject, actorRole: 'ward-nurse', at: new Date(Date.parse('2026-10-01T00:00:00Z') + seq * 36e5).toISOString(), data });

test('a short issue books against the request only what moved', () => {
  const s = deriveStock([ev(1, 'received', 'store-main', { lines: [{ itemId: 'gloves-m', qty: 3 }], source: 'Purchase' }),
    ev(2, 'requested', 'req-00001', { placeId: 'ward-a1', fromPlaceId: 'store-main', lines: [{ itemId: 'gloves-m', qty: 10 }], raisedBy: 'request' }),
    ev(3, 'issued', 'req-00001', { lines: [{ itemId: 'gloves-m', qty: 10 }] })], CAT);
  assert.equal(usableOf(s, 'gloves-m', 'ward-a1', '2026-10-02T00:00:00Z'), 3, 'three boxes reached the ward');
  const q = s.requests.get('req-00001');
  assert.equal(q.lines[0].issued, 3, 'the request says how many were issued');
  assert.notEqual(q.state, 'issued', 'a request for 10 that got 3 is not fully issued');
});
