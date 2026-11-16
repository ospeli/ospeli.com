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

// ospeli/ospeli#94: an ordinary place or asset name was refused as "a person's name".
test('ordinary place and asset names do not stop an import', async () => {
  for (const name of ['Day Surgery', 'Main Building', 'Blood Bank', 'Car Park', 'Plant Room', 'Water Cooler']) {
    const { core, data } = await exported();
    const e = data.entities.find((x) => x.type === (name === 'Water Cooler' ? 'asset' : 'department'));
    e.name = name;
    assert.deepEqual(await core.validateImport(data), [], `an entity called "${name}" is refused as a person's name`);
  }
  // every place and asset type, not only departments
  for (const type of ['site', 'building', 'department', 'ward', 'bed', 'asset']) {
    const { core, data } = await exported();
    const e = data.entities.find((x) => x.type === type);
    if (!e) continue;
    e.name = 'Plant Room';
    assert.deepEqual(await core.validateImport(data), [], `a ${type} called "Plant Room" is refused`);
  }
});

test('a place still cannot carry a titled name or a phone number, and a role still cannot be a bare name', async () => {
  const errsFor = async (type, name) => {
    const { core, data } = await exported();
    const e = data.entities.find((x) => x.type === type);
    e.name = name;
    return core.validateImport(data);
  };
  assert.ok((await errsFor('department', 'Dr Sarah Jones Suite')).some((x) => /personal details/.test(x)));
  assert.ok((await errsFor('asset', 'Pump, call 07700 900123')).some((x) => /personal details/.test(x)));
  assert.ok((await errsFor('role', 'Sarah Jones')).some((x) => /personal details/.test(x)));
  assert.ok((await errsFor('department', 'Jane Placeholder')).some((x) => /personal details/.test(x)), 'a bare name on a place is still refused');
  assert.ok((await errsFor('asset', 'Anita Khan Pump')).some((x) => /personal details/.test(x)), 'a name beside a thing word is still refused');
});
