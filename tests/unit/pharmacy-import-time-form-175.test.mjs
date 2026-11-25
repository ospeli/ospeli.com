// Finding: an imported event's "at" only has to parse as a time. The pharmacy measures and lists
// compare times as text (inPeriod and the sorts in logic.js), so a correct time written with an
// offset ("...+09:00") is placed wrongly: a request collected four hours ago is missing from the
// last seven days.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { importedSite } from './rev-a-helper.mjs';

test('a request whose imported times are written with an offset is still counted in the period it happened in', async () => {
  const at = (hm) => `2026-11-20T${hm}:00+09:00`; // 22:00+09:00 is 13:00Z, five hours before the pinned clock
  const { run } = await importedSite((add) => {
    add('pharmacy.request-raised', 'rx-00001', 'ward-nurse', { wardId: 'ward-a1', kind: 'other', priority: 'routine', items: 2 }, at('22:00'));
    add('pharmacy.request-started', 'rx-00001', 'pharmacy-technician', {}, at('22:10'));
    add('pharmacy.request-checked', 'rx-00001', 'pharmacist', {}, at('22:20'));
    add('pharmacy.request-ready', 'rx-00001', 'pharmacy-technician', {}, at('22:30'));
    add('pharmacy.request-collected', 'rx-00001', 'ward-nurse', {}, at('22:50'));
  });
  const ward = await run('ospeli_pharmacy_ward_requests', { wardId: 'ward-a1' }, 'ward-nurse');
  assert.equal(ward.requests[0]?.state, 'collected', 'the request is read and shown as collected in the last 24 hours (control)');
  const kpi = Object.fromEntries((await run('ospeli_pharmacy_overview', { days: 7 }, 'pharmacy-manager')).kpis.map((k) => [k.id, k]));
  assert.equal(kpi['collection-wait'].n, 1, 'collected 4 h 10 min ago, so it is in the last 7 days');
  assert.equal(kpi['collection-wait'].value, 20);
  assert.equal(kpi['stage-times'].n, 3);
});
