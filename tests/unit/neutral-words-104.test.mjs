// Issue ospeli/ospeli#104: everyday words from one English ("lift", "nurse in charge") in the app's
// own lists. The ids stay (asset-lift-a, asset kind 'lift', role 'ae-nic'), so stored data still
// loads; names stored before the change read with the new words. scripts/check.py guards the words
// in every public text; this test holds the core lists and the read-out of stored names.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { roleById, currentWords } from '../../web/app/core/model.js';
import { generateHospital } from '../../web/app/core/generator.js';
import { FAULT_TYPES, faultsFor } from '../../web/app/core/workorders.js';

test('#104: the elevator assets, their fault and the emergency role use neutral words; the ids stay', () => {
  assert.equal(roleById('ae-nic').name, 'Emergency department charge nurse');
  assert.deepEqual(FAULT_TYPES.lift, [['Elevator out of service', 'estates']]);
  assert.ok(faultsFor('lift').includes('Elevator out of service'));
  const { entities } = generateHospital({ end: '2026-11-10T10:00:00Z', days: 1, modules: false });
  const names = Object.fromEntries(entities.filter((e) => /^asset-lift-/.test(e.id)).map((e) => [e.id, e.name]));
  assert.deepEqual(names, { 'asset-lift-a': 'Bed elevator, Building A', 'asset-lift-b': 'Bed elevator, Building B' });
  assert.equal(entities.find((e) => e.id === 'role-ae-nic')?.name, 'Emergency department charge nurse');
});

test('#104: names and faults stored with the old words read with the new ones; ids are untouched', () => {
  assert.equal(currentWords(['Bed', 'lift, Building A'].join(' ')), 'Bed elevator, Building A');
  assert.equal(currentWords(['Lift', 'out of service'].join(' ')), 'Elevator out of service');
  assert.equal(currentWords(['Emergency department nurse', 'in charge'].join(' ')), 'Emergency department charge nurse');
  for (const id of ['asset-lift-a', 'lift', 'ae-nic']) assert.equal(currentWords(id), id);
});
