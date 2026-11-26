// Security and audit, 26 Nov. The CSV of a walked map put a ' before a cell that begins with = + - @,
// a tab or a carriage return, but not before one that begins with spaces (or a no-break space) and
// then a formula. A map title is stored as typed and is written on every row; some spreadsheets
// drop leading spaces before they read a formula. Made-up text only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { csvCell, csvOf } from '../../web/app/modules/result-data.js';

test('csvCell defuses a formula after leading whitespace', () => {
  for (const bad of [' =HYPERLINK("http://example.invalid","open")', ' =1+1', '  +1+1', ' @SUM(A1)']) {
    const cell = csvCell(bad);
    assert.ok(cell.startsWith('"\''), `csvCell(${JSON.stringify(bad)}) gave ${cell}`);
  }
});

test('csvOf: a map title " =HYPERLINK(...)" reaches every row without the apostrophe', () => {
  const list = [{ id: 'm-s1', name: 'Arrived', role: 'Patient' }];
  const rec = { id: 'w1', startedAt: '2026-11-17T09:00:00Z', steps: [{ stepId: 'm-s1', waitSec: 60, workSec: 60 }] };
  const csv = csvOf({ title: ' =HYPERLINK("http://example.invalid","open")', department: '', list, records: [rec], dateOf: (iso) => iso.slice(0, 10) });
  const row = csv.split('\r\n')[1];
  assert.ok(row.startsWith('"\''), `first data row: ${row}`);
});
