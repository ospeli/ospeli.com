// Audit (#113 percentText): a small rate is kept from reading as none ("under 0.1%"), but a rate of
// 10% or more is rounded to a whole percent, so a fill rate of 99.6% (249 of 250 lines filled)
// reads "100%": every line filled, when one was not. Made-up counts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { percentText } from '../../web/app/modules/stores/logic.js';

test('percentText: 249 of 250 (99.6%) does not read as 100%', () => {
  const value = Math.round(((100 * 249) / 250) * 10) / 10; // as stores/commands.js rounds it: 99.6
  assert.notEqual(percentText(value, 249), '100%');
});

test('percentText: a count that is not all of them never reads "100%"; all of them does', () => {
  assert.equal(percentText(99.6, 249), '99.6%', 'one decimal near the top');
  // 2499 of 2500 is 99.96%, which commands.js rounds to 100: the count says it is not all.
  assert.equal(percentText(100, 2499, 2500), 'over 99.9%');
  assert.equal(percentText(100, 250, 250), '100%');
  assert.equal(percentText(100, 30), '100%', 'no count of the whole given: the value decides');
  assert.equal(percentText(12.6, 30, 238), '13%', 'a middle rate stays a whole percent');
});
