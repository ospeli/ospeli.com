// Domain lead, 27 Nov: a step whose role nobody has said ("Not set", a walk step named later) is
// not a change of role, so it never adds a handover or tips the map into the "handoffs" question.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyse } from '../../web/app/core/processmap.js';

const st = (role) => ({ name: 'x', role, wait: 1, work: 1 });
test('a role that is not set is not counted as a handover on either side', () => {
  assert.equal(analyse([st('Reception'), st('Nurse'), st('Not set'), st('Nurse')]).handoffs, 1);
  assert.equal(analyse([st('Reception'), st('Nurse'), st('Doctor'), st('Nurse')]).handoffs, 3);
  assert.equal(analyse([st('Not set'), st('Not set')]).handoffs, 0);
});
