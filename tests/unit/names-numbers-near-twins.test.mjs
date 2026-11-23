// Review finding on the free-text check of 22 Nov (#150): "Dr K Patel" and "Hosp no 44871" are
// refused, but the same text with a spelt-out or capital title, or with the number written the
// way many sites write it, is saved with no refusal and no question. Each line below is the
// control (refused today) next to its near twin (accepted today). Made-up names and numbers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './sec-core-helper.mjs';

const refused = async (x, name) => {
  try { await x.tap('ospeli_walks_step_name', { name, role: 'Reception' }); return false; } catch (e) { return e.code === 'invalid-input'; }
};

test('a title and an initial, and a hospital number, are refused or asked about however they are typed', async () => {
  const x = await setup();
  await x.tap('ospeli_walks_start', { guidanceSeen: true });
  x.tick(10); await x.tap('ospeli_walks_step_start'); x.tick(10); await x.tap('ospeli_walks_step_done');
  for (const control of ['Seen by Dr K Patel', 'Mr J. Smith to sign', 'Hosp no 44871 checked']) assert.equal(await refused(x, control), true, `control: "${control}" is refused`);
  const twins = ['Seen by Doctor K Patel', 'Seen by Professor K Patel', 'Seen by Sister K Patel', 'MR J. SMITH to sign', 'Hosp No44871 checked', 'Hosp no 44 871 checked', 'Hosp no A44871 checked'];
  const saved = [];
  for (const t of twins) if (!(await refused(x, t))) saved.push(t);
  assert.deepEqual(saved, [], `saved with no refusal and no question: ${saved.join(' | ')}`);
});
