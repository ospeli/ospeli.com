// Issue #152 (words only): the handover citation is no wider than the paper (a review of emergency
// ambulance offload at emergency departments, definitions from 15 to 60 minutes or more; nothing
// found for planned transfers); Transfers says it is not for critical care transfers; the generator
// test tile is named for what it counts (tests carried out on time, a failed test included). The
// public area pages carry the same words (#184). Synthetic data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { KPIS as TRF } from '../../web/app/modules/transfers/commands.js';
import { KPIS as FAC } from '../../web/app/modules/facilities/commands.js';

const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
const AREAS = JSON.parse(read('web/areas/areas.json'));
const areaKpis = AREAS.flatMap((a) => a.kpis || []);

test('#152 transfers point 2: the handover source says what the paper covers, and that nothing was found for planned transfers', () => {
  const k = TRF.find((x) => /handover/i.test(x.name));
  assert.ok(k, 'a handover measure');
  assert.match(k.source, /emergency ambulance offload at emergency departments/);
  assert.match(k.source, /15 to 60 minutes or more/);
  assert.match(k.source, /PMID 42242732/);
  assert.match(k.source, /no published definition for planned transfers was found/);
  const page = areaKpis.find((x) => x.name === k.name);
  assert.ok(page && /no published definition for planned transfers was found/.test(page.source), 'the area page says the same');
  assert.doesNotMatch(read('web/areas/patient-transport/index.html'), /handover delay vary widely/);
});

test('#152 transfers point 7: not for critical care transfers', () => {
  const src = read('web/app/modules/transfers/commands.js');
  assert.match(src, /const NOT_FOR = '[^\n]*Not for critical care transfers, which follow their own clinical procedure\./);
});

test('#152 facilities point 2: the generator tile is named for what it counts', () => {
  const k = FAC.find((x) => x.id === 'generator-test-compliance');
  assert.equal(k.name, 'Generator tests carried out on time');
  assert.ok(areaKpis.some((x) => x.name === 'Generator tests carried out on time'), 'the area page uses the same name');
  assert.ok(!areaKpis.some((x) => x.name === 'Generator test compliance'));
});
