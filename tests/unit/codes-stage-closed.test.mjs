// Review 21 Nov: ospeli_codes_stage answers "done" on a closed code when the stage sent is the one
// the code was closed at, instead of refusing as every other write on a closed code does; an agent's
// precheck therefore passes and a proposal for a closed code is queued. Synthetic data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Core } from '../../web/app/core/core.js';
import { MemoryAdapter } from '../../web/app/core/db.js';
import { loadSyntheticHospital } from '../../web/app/core/generator.js';
import { CommandError } from '../../web/app/core/commands.js';
import { codeCommands } from '../../web/app/core/code-commands.js';

const END = '2026-11-06T18:00:00.000Z';
const PACK = { id: 'testcodes', CODE_KINDS: [
  { id: 'test-referral', word: 'Outpatient referral', services: { 'test-eyes': 'Eye clinic' }, sources: ['referral'], placeTypes: ['department'],
    openRoles: ['receptionist'], stageRoles: ['receptionist'], closeRoles: ['receptionist'],
    stages: [{ id: 'referral.accepted', word: 'Referral accepted', after: [] }, { id: 'on-hold', word: 'On hold', after: ['referral.accepted'] }],
    openStage: 'referral.accepted' }] };
const CMDS = Object.fromEntries(codeCommands([PACK]).map((c) => [c.name, c]));

test('a stage sent for a closed code is refused (conflict), not answered done', async () => {
  const core = await Core.open({ adapter: new MemoryAdapter(), clock: () => new Date(END) });
  await loadSyntheticHospital(core, { end: END, modules: false });
  const actor = { type: 'human', role: 'receptionist' };
  const o = await CMDS.ospeli_codes_open.run(core, { kind: 'test-referral', service: 'test-eyes', source: 'referral' }, { actor });
  await CMDS.ospeli_codes_close.run(core, { code: o.code, reason: 'Opened in error' }, { actor });
  let err = null; let out = null;
  try { out = await CMDS.ospeli_codes_stage.precheck(core, { code: o.code, stage: 'referral.accepted' }, { actor: { type: 'agent', role: 'receptionist', agent: 'bot' } }); } catch (e) { err = e; }
  assert.ok(err instanceof CommandError && err.code === 'conflict', `an agent's stage on a closed code fails the precheck (got ${err ? err.code : 'no error: the proposal would be queued'})`);
  err = null;
  try { out = await CMDS.ospeli_codes_stage.run(core, { code: o.code, stage: 'referral.accepted' }, { actor }); } catch (e) { err = e; }
  assert.ok(err instanceof CommandError && err.code === 'conflict', `a person's stage on a closed code is refused (got ${err ? err.code : JSON.stringify(out)})`);
});
