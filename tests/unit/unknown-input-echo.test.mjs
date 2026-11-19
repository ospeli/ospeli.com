// Finding (minor): the "unknown input" answer repeats the name of the unknown field as the caller typed
// it, at any length, and since #135 adds the full list of allowed names once per unknown field. The
// audit entry is sound (fixed words, fields: []); this is about the answer itself: typed text comes
// back in the message and in detail.errors, and 2,000 unknown fields give an answer over 100,000
// characters long. Synthetic data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validate } from '../../web/app/core/schema.js';
import { commandByName } from '../../web/app/core/commands.js';

const schema = commandByName('ospeli_transfers_board').input;

test('the unknown-input message does not repeat the field name the caller typed', () => {
  const typed = 'Mr Test Person 07700 900123';
  const errs = validate(schema, { [typed]: 1 });
  assert.equal(errs.length, 1);
  assert.ok(errs[0].includes('This takes: days, format, limit.'), 'it says what the command takes');
  assert.ok(!errs[0].includes('07700'), `the message repeats what was typed: "${errs[0]}"`);
});

test('many unknown fields give one short answer, not one copy of the allowed list each', () => {
  const errs = validate(schema, Object.fromEntries(Array.from({ length: 2000 }, (_, i) => [`k${i}`, 1])));
  assert.ok(errs.join('; ').length < 2000, `the answer is ${errs.join('; ').length} characters long`);
});
