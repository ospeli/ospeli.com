// Code review, 14 Nov: the import check that reads values for personal details (ospeli/ospeli#19).
// A titled name or a phone number is refused wherever the file puts it, not only under some keys.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Core } from '../../web/app/core/core.js';
import { MemoryAdapter } from '../../web/app/core/db.js';
import { loadSyntheticHospital } from '../../web/app/core/generator.js';
import { personalDetailIn } from '../../web/app/core/processmap.js';

const END = '2026-11-06T18:00:00.000Z';
async function exported() {
  let t = Date.parse(END);
  const core = await Core.open({ adapter: new MemoryAdapter(), clock: () => new Date(t += 1000) });
  await loadSyntheticHospital(core, { end: END });
  return { core, data: JSON.parse(JSON.stringify(await core.exportData())) };
}

test('false negative: a titled name or a phone number is refused wherever the file puts it', async () => {
  const refused = async (change, where) => {
    const { core, data } = await exported();
    change(data);
    const errs = await core.validateImport(data);
    assert.ok(errs.some((x) => /personal details/.test(x)), `${where} was let through (errors: ${JSON.stringify(errs)})`);
  };
  // the control: the same text under a neutral key is refused today
  await refused((d) => { d.events[0].data = { ...d.events[0].data, note: 'Seen by Dr Sarah Jones' }; }, 'data.note');
  // keys the check skips as "an id or a time", whatever they hold
  await refused((d) => { d.events[0].data = { ...d.events[0].data, seenAt: 'Seen by Dr Sarah Jones' }; }, 'data.seenAt');
  await refused((d) => { d.events[0].data = { ...d.events[0].data, end: 'call 07700 900123' }; }, 'data.end');
  await refused((d) => { d.entities.at(-1).kind = 'Mrs Jane Brown'; }, 'entity.kind');
  // an event's subject is never read
  await refused((d) => { d.events[0].subject = 'Mrs Jane Brown 07700 900123'; }, 'event.subject');
});

test('a phone number after a calling word is found even when a shorter number comes first', () => {
  assert.equal(personalDetailIn('ring 555123'), 'a phone or ID number'); // the control
  assert.equal(personalDetailIn('Call ext 204 31 or ring 555123'), 'a phone or ID number');
});
