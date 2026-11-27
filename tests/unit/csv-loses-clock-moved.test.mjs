// Audit: the Result tab marks a walk whose phone clock moved back "(may be wrong)" and leaves it
// out of every range, and a walk stopped early "(stopped early)". The CSV, which "holds all of
// them", has no column for either: the rows of a walk whose times cannot be trusted are the same,
// byte for byte, as those of a good walk, so a spreadsheet adds them in. Made-up steps and times.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { csvOf } from '../../web/app/modules/result-data.js';

const list = [{ id: 'm-s1', name: 'Arrived', role: 'Patient' }, { id: 'm-s2', name: 'Scan', role: 'Imaging staff' }];
const base = { id: 'w2', startedAt: '2026-11-18T09:00:00Z', steps: [{ stepId: 'm-s1', waitSec: 60, workSec: 120 }, { stepId: 'm-s2', waitSec: 900, workSec: 600 }] };
const csv = (rec) => csvOf({ title: 'Outpatient scan', department: 'Imaging', list, records: [rec], dateOf: (iso) => iso.slice(0, 10) });

test('CSV: a walk whose clock moved back can be told from a good walk', () => {
  assert.notEqual(csv({ ...base, clockMoved: true }), csv(base), 'the CSV of a clock-moved walk is identical to a good walk\'s');
});
test('CSV: a walk stopped early can be told from a walk walked to the end', () => {
  assert.notEqual(csv({ ...base, stoppedEarly: true }), csv(base), 'the CSV of a walk stopped early is identical to a full walk\'s');
});
