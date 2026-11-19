// Issue ospeli/ospeli#136: the two newest modules used words from one health system or one country:
// "Care home", "off the road", one country's standby power standard as the only one named, and a
// Monday-to-Sunday week on every weekly check. The stored ids ('care-home', 'off-road') stay, so
// journeys and vehicle events already saved still load. scripts/check.py guards the words in every
// public text; this test holds the module's own lists and notes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TYPES, OUTSIDE } from '../../web/app/modules/transfers/logic.js';
import { SCHEDULE_NOTE, everyText } from '../../web/app/modules/facilities/logic.js';

const ONE_SYSTEM = /\bcare homes?\b|\b(?:off|on) the road\b|\bNFPA\b|Monday[- ]to[- ]Sunday/i;

test('#136: transfer destinations and types use system-neutral words; the stored id is kept', () => {
  const words = [...TYPES, ...OUTSIDE].flatMap((x) => [x.name, x.hint || '']);
  assert.deepEqual(words.filter((w) => ONE_SYSTEM.test(w)), []);
  assert.equal(OUTSIDE.find((x) => x.id === 'care-home')?.name, 'Residential or nursing care');
});

test('#136: the facilities schedule names no one country\'s standard and says the week\'s first day once', () => {
  assert.doesNotMatch(SCHEDULE_NOTE, ONE_SYSTEM);
  assert.match(SCHEDULE_NOTE, /a national or insurer's standard for standby power/);
  assert.match(SCHEDULE_NOTE, /week starts on Monday/, 'the periods are counted from Monday, so that is said once');
  assert.equal(everyText(7), 'Every week');
  assert.equal(everyText(1), 'Every day');
});
