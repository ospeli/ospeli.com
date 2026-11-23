// Deep pass, import and export. Three places in an imported file that the personal-detail
// check never reads, each with a control that shows the same text is caught where it does read:
//  1. an event whose `data` is itself a string (the walk returns at once on a string);
//  2. the name of a field (only values are read; key names are only matched against a short list
//     of words such as "name" or "phone");
//  3. a number (a phone, record or ID number written as a JSON number, not as text).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { personalDetailIn } from '../../web/app/core/processmap.js';
import { exportedFile, empty, TITLED } from './sec-import-helper.mjs';

const check = async (change) => {
  const file = await exportedFile();
  change(file);
  return (await (await empty()).validateImport(file)).join(' ');
};

test('control: the text and the number are caught as values under an ordinary key', async () => {
  assert.match(await check((d) => { d.events[0].data = { ...d.events[0].data, note: TITLED }; }), /personal details/);
  assert.match(await check((d) => { d.events[0].data = { ...d.events[0].data, note: 'ring 7700900123' }; }), /personal details/);
  assert.ok(personalDetailIn('7700900123'), 'the digits alone, as text, read as a phone or ID number');
});

test('an event whose data is a bare string is read', async () => {
  assert.match(await check((d) => { d.events[0].data = TITLED; }), /personal details|must be an object/, 'a titled name and phone number as the whole of event.data were let through');
  assert.doesNotMatch(await check((d) => { d.events[0].data = TITLED; }), /Sarah|Jones|07700/, 'the refusal does not repeat what was typed');
});

test('the name of a field is read, in an event and in a place', async () => {
  assert.match(await check((d) => { d.events[0].data = { ...d.events[0].data, [TITLED]: true }; }), /personal details/, 'personal details used as a field name in event.data were let through');
  assert.match(await check((d) => { d.entities.at(-1)[TITLED] = true; }), /personal details/, 'personal details used as a field name on a place were let through');
});

test('a phone or record number written as a number is read', async () => {
  assert.match(await check((d) => { d.events[0].data = { ...d.events[0].data, note: 7700900123 }; }), /personal details/, 'a ten-digit number in event.data was let through');
});
