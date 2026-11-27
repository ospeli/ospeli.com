// Issue ospeli/ospeli#56 (last part): "theatre(s)" is one health system's word. The visible titles
// and headings of the operating room area and demo, the front page link and preview title, and the
// app's service lists in Patient feedback and Cleaning and transport say "operating room(s)". URLs,
// slugs, ids ('dept-theatres', 'theatres-and-procedures', /demo/theatres/) and stored names stay;
// a department name stored as "Theatres" reads with the new word.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Core } from '../../web/app/core/core.js';
import { MemoryAdapter } from '../../web/app/core/db.js';
import { loadSyntheticHospital } from '../../web/app/core/generator.js';
import { runCommand } from '../../web/app/core/commands.js';
import { currentWords } from '../../web/app/core/model.js';
import '../../web/app/modules/feedback/commands.js';
import '../../web/app/modules/support/commands.js';

const END = '2026-11-06T18:00:00.000Z';
const web = (p) => readFileSync(new URL(`../../web/${p}`, import.meta.url), 'utf8');
const all = (src, re) => [...src.matchAll(re)].map((m) => m[1].replace(/<[^>]+>/g, '').trim());
const OLD = /\btheatres?\b/i;
const FIRST = 'Operating rooms (theatres) and procedure lists';

test('#56: the area page, the demo, the demo index and the front page use "operating rooms" in titles and headings', () => {
  const area = web('areas/theatres-and-procedures/index.html');
  assert.deepEqual(all(area, /<title>([^<]*)<\/title>/g), [`${FIRST} · Ospeli`]);
  assert.deepEqual(all(area, /<h1>(.*?)<\/h1>/g), [FIRST]);
  assert.match(area, /href="\.\.\/\.\.\/demo\/theatres\/">Open the operating rooms preview</, 'the link keeps its URL');
  const demo = web('demo/theatres/index.html');
  assert.deepEqual(all(demo, /<title>([^<]*)<\/title>/g), [`${FIRST} demo · Ospeli`]);
  assert.deepEqual(all(demo, /<h1>(.*?)<\/h1>/g), [FIRST]);
  for (const h of all(demo, /<h[1-3][^>]*>(.*?)<\/h[1-3]>/g)) assert.doesNotMatch(h, /^(?!.*\(theatres\)).*\btheatres?\b/i, h);
  for (const h of all(demo, /'h3', \{ class: 'sec', text: '([^']*)'/g)) assert.doesNotMatch(h, OLD, h);
  const index = web('demo/index.html');
  assert.match(index, new RegExp(`<h2>${FIRST.replace(/[()]/g, '\\$&')}</h2><p>[^<]*</p><a class="go" href="theatres/">`));
  assert.match(web('areas/index.html'), new RegExp(`href="theatres-and-procedures/"><span class="st live">Preview</span><h3>${FIRST.replace(/[()]/g, '\\$&')}</h3>`));
  assert.match(web('overview.html'), /<a href="areas\/theatres-and-procedures\/">Operating rooms \(theatres\)<\/a>/);
});

test('#56: the service lists in Patient feedback and Cleaning and transport say "Operating rooms"; the id stays', async () => {
  const core = await Core.open({ adapter: new MemoryAdapter(), clock: () => new Date(Date.parse(END) + 60e3) });
  await loadSyntheticHospital(core, { end: END });
  const fb = await runCommand(core, 'ospeli_experience_themes_get', {}, { type: 'human', role: 'quality-lead' });
  const svc = fb.options.services.find((s) => s.id === 'dept-theatres');
  assert.equal(svc?.name, 'Operating rooms');
  for (const s of fb.options.services) assert.doesNotMatch(s.name, OLD, s.name);
  const sp = await runCommand(core, 'ospeli_support_places', { limit: 500 }, { type: 'human', role: 'ward-nurse' });
  assert.equal(sp.departments.find((d) => d.id === 'dept-theatres')?.name, 'Operating rooms');
  for (const d of sp.departments) assert.doesNotMatch(d.name, OLD, d.name);
  // Stored values are unchanged: the id, and an id or slug is never rewritten on read.
  for (const id of ['dept-theatres', 'theatres-and-procedures']) assert.equal(currentWords(id), id);
});
