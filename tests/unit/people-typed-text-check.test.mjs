// A person's command goes through the command's typed-text check in the command layer itself,
// as an agent's does (security sweep of 17 Nov 2026, finding 5). Before, the check ran for
// people only if the command's own run remembered to repeat it: a module that forgot would let
// a phone number or a titled name into shared data. Everything here is made up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Core } from '../../web/app/core/core.js';
import { MemoryAdapter } from '../../web/app/core/db.js';
import { loadSyntheticHospital } from '../../web/app/core/generator.js';
import { runCommand, commandByName, listCommands, CommandError } from '../../web/app/core/commands.js';

const END = '2026-11-06T18:00:00.000Z';

test('a command whose run forgets the typed-text check still refuses a personal detail from a person', async () => {
  const core = await Core.open({ adapter: new MemoryAdapter(), clock: () => new Date(END) });
  await loadSyntheticHospital(core, { end: END });
  const cmd = commandByName('ospeli_experience_complaint_log');
  assert.equal(typeof cmd.check, 'function', 'the command has a typed-text check');
  const real = cmd.run; let ran = 0;
  cmd.run = async () => { ran += 1; return { status: 'done' }; }; // a run that forgot to check
  try {
    const input = { kind: 'concern', channel: 'in-person', serviceId: 'dept-outpatients', theme: 'waiting', note: 'Call Mr Test Person on 07700 900123' };
    await assert.rejects(runCommand(core, cmd.name, input, { type: 'human', role: cmd.roles[0] }), (e) => e instanceof CommandError && e.code === 'invalid-input');
    assert.equal(ran, 0, 'the command never ran');
    await runCommand(core, cmd.name, { ...input, note: 'Waited a long time at the desk' }, { type: 'human', role: cmd.roles[0] });
    assert.equal(ran, 1, 'ordinary text still goes through');
  } finally { cmd.run = real; }
});

test('every command that takes free text has a typed-text check for the command layer to run', () => {
  // Free text: a string field with no enum, no pattern and no format. Ids, picks and time stamps have one of those.
  const free = (schema) => Object.entries(schema?.properties || {}).filter(([, p]) => p.type === 'string' && !p.enum && !p.pattern && !p.format).map(([k]) => k);
  // ospeli_tasks_request.detail is a pick from the kind's own list, checked in the command (anything else is refused).
  const PICKS = new Set(['ospeli_tasks_request: detail']);
  const missing = listCommands().map((c) => commandByName(c.name)).filter((c) => c.kind !== 'read' && free(c.input).length && typeof c.check !== 'function').map((c) => `${c.name}: ${free(c.input).join(', ')}`).filter((x) => !PICKS.has(x));
  assert.deepEqual(missing, [], 'writes with a free-text field and no check');
});
