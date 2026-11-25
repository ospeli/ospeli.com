// Issue #44 (remainder): the A3 long-stay measure names where its 7-day threshold comes from
// (checked 25 Nov against the guide's own words, "more than six days"), and does not present the
// 21-day threshold as a published definition until one is confirmed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const AREAS = JSON.parse(readFileSync(new URL('../../web/areas/areas.json', import.meta.url), 'utf8'));
test('#44: A3 long-stay patients cites the 7-day threshold and says the 21-day one is an editable default', () => {
  const k = AREAS.find((a) => a.id === 'A3').kpis.find((x) => x.name === 'Long-stay patients');
  assert.match(k.source, /Guide to reducing long hospital stays \(NHS Improvement, June 2018\)/);
  assert.match(k.source, /more than six days/);
  assert.match(k.source, /21 days: editable default/);
  const page = readFileSync(new URL('../../web/areas/beds-and-patient-flow/index.html', import.meta.url), 'utf8');
  assert.match(page, /Guide to reducing long hospital stays/, 'the built page carries it (built from areas.json)');
});
