// orderRef on ospeli_stock_receive is 40 characters of typed text (pattern only): it is not checked
// against any order and not checked for personal details, and it is copied into the event and the audit trail.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { site } from './review-helper.mjs';
import { personalDetailIn } from '../../web/app/core/processmap.js';

test('a phone number typed as orderRef is not saved in the log or the audit trail', async () => {
  const { core, run } = await site();
  const typed = '07700-900123'; // a made-up number from a range kept for fiction
  assert.ok(personalDetailIn(typed), 'the typed-text check itself knows this is a phone or ID number');
  try { await run('ospeli_stock_receive', { placeId: 'store-main', lines: [{ itemId: 'aprons', qty: 1 }], source: 'Purchase', orderRef: typed }, 'storekeeper'); } catch { /* refused: good */ }
  const data = await core.exportData();
  const kept = [...data.events, ...data.audit].filter((r) => JSON.stringify(r).includes(typed)).map((r) => r.type || r.action || 'row');
  assert.deepEqual(kept, [], 'the number was kept in');
});
