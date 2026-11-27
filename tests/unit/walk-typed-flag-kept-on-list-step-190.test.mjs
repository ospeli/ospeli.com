// Audit: on a repeat walk, a typed name later replaced by "it was list step N" (listStep) keeps
// typed: true, so the list's own words are exported as "step name typed: yes".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './walk-177-helper.mjs';

test('a step given a list step\'s name with listStep is not marked typed', async () => {
  const x = await setup();
  // A first walk with two named steps, finished into a map.
  await x.tap('ospeli_walks_start', { guidanceSeen: true });
  x.tick(30); await x.tap('ospeli_walks_step_start'); x.tick(60); await x.tap('ospeli_walks_step_done');
  await x.tap('ospeli_walks_step_name', { name: 'Checked in at reception', role: 'Reception' });
  x.tick(30); await x.tap('ospeli_walks_step_start'); x.tick(60); await x.tap('ospeli_walks_step_done');
  await x.tap('ospeli_walks_step_name', { name: 'Seen in the clinic room', role: 'Clinic staff' });
  const { mapId } = await x.tap('ospeli_walks_finish');
  // A repeat walk: the first step is first said to be off the list and typed, then put right.
  x.tick(60); await x.tap('ospeli_walks_start', { guidanceSeen: true, mapId });
  x.tick(30); await x.tap('ospeli_walks_step_start'); x.tick(60); await x.tap('ospeli_walks_step_done');
  await x.tap('ospeli_walks_step_name', { offList: true, name: 'Waited at the desk again', role: 'Reception', typed: true });
  const w = (await x.tap('ospeli_walks_step_name', { listStep: 1 })).walk;
  assert.equal(w.steps[0].name, 'Checked in at reception');
  assert.equal(w.steps[0].typed, undefined, 'the list\'s own name was not typed on this walk');
});
