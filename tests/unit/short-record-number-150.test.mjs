// ospeli/ospeli#150 point 3: a labelled record number of three to five digits ("MRN 44871 checked")
// passed the free-text check, which wanted six or more digits. Many small sites use short numbers.
// Places and things with numbers must still pass. Synthetic strings only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { personalDetailIn } from '../../web/app/core/processmap.js';

test('#150: a strong record label with three or more digits is refused', () => {
  for (const s of ['MRN 44871 checked', 'mrn: 4487', 'ID 512 verified', 'Record no. 7731 pulled', 'Chart 0042 found', 'Case #9981 reviewed', 'Check NHS 123'])
    assert.equal(personalDetailIn(s), 'a record or ID number', s);
});

test('#150: places, rooms, forms and times with numbers still pass', () => {
  for (const s of ['Bed 14B', 'Room 12', 'Seen in room 204', 'Form 22 filled in', 'Bay 3, bed 101', 'Wait for lift 2', 'Step 12 of 40', 'No 12 bus stop', 'Ref 512 form', 'Ward A1, bed 04'])
    assert.equal(personalDetailIn(s), null, s);
});
