// Review 21 Nov: an import file can carry patient-code events (code.*) with fields and values the
// app never writes (free text for service, place and close reason, extra keys such as a priority),
// and ospeli_codes_list then hands that text to any reader. Same theme as #138. Synthetic data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Core } from '../../web/app/core/core.js';
import { MemoryAdapter } from '../../web/app/core/db.js';
import { loadSyntheticHospital } from '../../web/app/core/generator.js';
import { runCommand } from '../../web/app/core/commands.js';

const NOW = '2026-11-06T18:00:00.000Z';

async function fileWith(extraEvents) {
  const core = await Core.open({ adapter: new MemoryAdapter(), clock: () => new Date(NOW) });
  await loadSyntheticHospital(core, { end: NOW, modules: false });
  const data = await core.exportData();
  let seq = data.events.length;
  for (const e of extraEvents) data.events.push({ ...data.events.at(-1), ...e, seq: ++seq });
  return data;
}

test('words an import file puts in a patient code event are never handed back by a list', async () => {
  const free = 'Urgent, see first please';
  const data = await fileWith([
    { type: 'code.opened', subject: 'pc-00001', actorRole: 'booking-clerk', at: NOW,
      data: { kind: 'outpatient-referral', service: free, source: free, placeId: free, priority: 'high' } },
    { type: 'code.stage', subject: 'pc-00001', actorRole: 'booking-clerk', at: NOW, data: { stage: 'referral.accepted', placeId: 'made-up-place', appointmentId: free } },
    { type: 'code.closed', subject: 'pc-00001', actorRole: 'booking-clerk', at: NOW, data: { reason: free } },
    { type: 'code.opened', subject: 'pc-00002', actorRole: 'booking-clerk', at: NOW, data: { kind: free, service: 'diabetes', source: 'referral' } },
  ]);
  const target = await Core.open({ adapter: new MemoryAdapter(), clock: () => new Date(NOW) });
  // The import itself still takes the file: one rule for what an imported module event may hold is #138.
  // If the import refuses the file, that is the right answer only when it refuses it for the four
  // events added above, so say which (issue #95, 23 Nov: a bare return here checked nothing).
  const errs = await target.validateImport(data);
  if (errs.length) {
    const first = data.events.length - 3;
    assert.ok(errs.every((e) => Number(/^event (\d+):/.exec(e)?.[1]) >= first), `refused, but not for the added events: ${errs.join(' | ')}`);
    return;
  }
  await target.importData(data, 'ops-manager');
  const person = { type: 'human', role: 'booking-clerk' };
  const list = await runCommand(target, 'ospeli_codes_list', { state: 'all' }, person);
  const one = await runCommand(target, 'ospeli_codes_get', { code: 'pc-00001' }, person);
  const text = JSON.stringify([list, one]);
  assert.ok(!text.includes('Urgent'), `the typed words came back: ${text.match(/.{0,60}Urgent.{0,40}/)?.[0]}`);
  assert.ok(!text.includes('made-up-place') || !/"placeName":"made-up-place"/.test(text), 'an unknown place id is not shown as a place name');
  const c = list.codes.find((x) => x.code === 'pc-00001');
  assert.equal(c.service, null); assert.equal(c.source, null); assert.equal(c.placeName, null); assert.equal(c.closeReason, null);
  assert.equal(list.codes.some((x) => x.code === 'pc-00002'), false, 'a code whose kind is a sentence is not a code');
});

test('a code written by the app reads back exactly as before', async () => {
  const core = await Core.open({ adapter: new MemoryAdapter(), clock: () => new Date(NOW) });
  await loadSyntheticHospital(core, { end: NOW, modules: false });
  const person = { type: 'human', role: 'booking-clerk' };
  const kinds = await runCommand(core, 'ospeli_codes_kinds', {}, person);
  const k = kinds.kinds[0];
  const made = await runCommand(core, 'ospeli_codes_open', { kind: k.id, service: k.services[0].id, source: k.sources[0] }, person);
  const closed = await runCommand(core, 'ospeli_codes_close', { code: made.code, reason: kinds.closeReasons[0] }, { type: 'human', role: 'outpatient-manager' }).catch((e) => e);
  const list = await runCommand(core, 'ospeli_codes_list', { state: 'all' }, person);
  const c = list.codes.find((x) => x.code === made.code);
  assert.equal(c.service, k.services[0].id); assert.equal(c.source, k.sources[0]);
  if (!(closed instanceof Error)) assert.equal(c.closeReason, kinds.closeReasons[0]);
});
