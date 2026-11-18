// Finding 6: "since" is compared as text. The schema accepts any ISO time stamp, so a caller in
// the site's own time zone may send 2026-11-06T15:00:00-04:00; the stored times end in Z, and the
// text comparison then keeps or drops the wrong rows. Same instant, two spellings, two answers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Core } from '../../web/app/core/core.js';
import { MemoryAdapter } from '../../web/app/core/db.js';
import { loadSyntheticHospital } from '../../web/app/core/generator.js';
import { runCommand } from '../../web/app/core/commands.js';

const END = '2026-11-06T18:00:00.000Z';
const human = (role) => ({ type: 'human', role });
async function site() {
  let t = Date.parse(END);
  const core = await Core.open({ adapter: new MemoryAdapter(), clock: () => new Date(t += 1000) });
  await loadSyntheticHospital(core, { end: END });
  return (name, input, role) => runCommand(core, name, input, human(role));
}
// 17:00 UTC written two ways: one hour before the end of the example data.
const Z = '2026-11-06T17:00:00.000Z';
const LOCAL = '2026-11-06T13:00:00-04:00';

test('ospeli_tasks_list: since gives the same tasks whichever way the same moment is written', async () => {
  const run = await site();
  assert.equal(Date.parse(Z), Date.parse(LOCAL));
  const a = await run('ospeli_tasks_list', { state: 'all', since: Z, limit: 500 }, 'coo');
  const b = await run('ospeli_tasks_list', { state: 'all', since: LOCAL, limit: 500 }, 'coo');
  assert.equal(b.total, a.total, `since ${LOCAL} and since ${Z} are the same moment`);
});

test('ospeli_support_audits_list: since gives the same audits whichever way the same moment is written', async () => {
  const run = await site();
  const SINCE_Z = '2026-11-03T17:00:00.000Z';
  const SINCE_LOCAL = '2026-11-03T03:00:00-14:00';
  assert.equal(Date.parse(SINCE_Z), Date.parse(SINCE_LOCAL));
  const a = await run('ospeli_support_audits_list', { since: SINCE_Z, limit: 200 }, 'coo');
  const b = await run('ospeli_support_audits_list', { since: SINCE_LOCAL, limit: 200 }, 'coo');
  assert.equal(b.total, a.total, `since ${SINCE_LOCAL} and since ${SINCE_Z} are the same moment`);
});
