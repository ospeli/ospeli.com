// ospeli/ospeli#150, the critic's re-test of 22 Nov: "Mr J. Smith waiting" (a title, an initial and a
// surname) and "Hosp no 44871" (a hospital number label with five digits) were saved in a map title,
// a walk title and a complaint note; "S. Jones" was saved with no question. Synthetic strings only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { personalDetailIn, personNameIn, possibleNameIn } from '../../web/app/core/processmap.js';

test('#150: a hospital or patient number with its number word is refused', () => {
  for (const s of ['Hosp no 44871', 'hosp. no. 4487 checked', 'Hospital number 512 pulled', 'Patient # 9981', 'Pt no: 30412'])
    assert.equal(personalDetailIn(s), 'a record or ID number', s);
});

test('#150: hospitals, patients and counts with numbers still pass', () => {
  for (const s of ['Hospital 2 car park', 'Patient 3 of 12 seen', 'Patient P12 arrives', 'Patient no 3 in the queue', 'Bed 14B', 'Room 12', 'Hospital site, step 4'])
    assert.equal(personalDetailIn(s), null, s);
});

test('#150: a personal title with an initial is a person', () => {
  for (const s of ['Mr J. Smith waiting', 'Dr K Patel to sign', 'Ms A. waits', 'Mrs. B. Jones called', 'Miss T Lee'])
    assert.equal(personNameIn(s), true, s);
});

test('#150: roles and plain words after a title still pass', () => {
  for (const s of ['Nurse Manager signs', 'Doctor reviews the chart', 'Dr on call phones back', 'Nurse in charge checks', 'Step A done', 'Wait in area B'])
    assert.equal(personNameIn(s), false, s);
});

test('#150: an initial and a capitalised word is asked about once', () => {
  assert.equal(possibleNameIn('S. Jones to sign'), 'S. Jones');
  assert.equal(possibleNameIn('Form signed by K. Patel'), 'K. Patel');
  for (const s of ['Plan B. Ward round', 'Step 4. Bed made', 'Option A. Room 12']) assert.equal(possibleNameIn(s), null, s);
});
