// Issue #184: the public area page and the app gave the same measure two definitions, and the A1
// page said reminders go out (not built). A measure named on a public area page and in a built
// module must carry the app's words: definition, numerator ("Counts"), denominator ("Out of") and
// exclusions ("Leaves out"). Measures that still differ are listed in tests/area-measures-known.json;
// that list only shrinks (a line that now matches fails until it is taken off).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ROLES } from '../../web/app/core/model.js';

const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
const AREAS = JSON.parse(read('web/areas/areas.json'));
const KNOWN = JSON.parse(read('tests/area-measures-known.json'));
const MODULES = ['clinics', 'diagnostics', 'facilities', 'feedback', 'pharmacy', 'stores', 'support', 'transfers'];

async function pairs() {
  const out = [];
  for (const m of MODULES) {
    const { KPIS = [] } = await import(new URL(`../../web/app/modules/${m}/commands.js`, import.meta.url));
    for (const k of KPIS) for (const a of AREAS) for (const ak of a.kpis) {
      if (ak.name.toLowerCase() === k.name.toLowerCase()) out.push({ key: `${a.id}: ${ak.name}`, app: k, page: ak });
    }
  }
  return out;
}
const differs = ({ app, page }) => ['definition:definition', 'counts:numerator', 'outOf:denominator', 'leavesOut:exclusions']
  .filter((pair) => { const [x, y] = pair.split(':'); return app[x] !== page[y]; }).map((pair) => pair.split(':')[1]);

test('#184: a measure on a public area page and in a built module has one definition, the app\'s', async () => {
  const bad = [];
  for (const p of await pairs()) {
    const fields = differs(p);
    if (fields.length && !KNOWN.includes(p.key)) bad.push(`${p.key} (${fields.join(', ')})`);
  }
  assert.deepEqual(bad, [], 'copy the app\'s definition, counts, out of and leaves out into web/areas/areas.json');
});

test('#184: the list of measures that still differ only shrinks', async () => {
  const all = await pairs();
  const stale = KNOWN.filter((key) => { const p = all.find((x) => x.key === key); return !p || !differs(p).length; });
  assert.deepEqual(stale, [], 'take these lines off tests/area-measures-known.json');
});

test('#184: the A1 page uses the app\'s words and says reminders are planned, not built', () => {
  const a1 = AREAS.find((a) => a.id === 'A1');
  const text = JSON.stringify(a1);
  assert.doesNotMatch(text, /no-show/i, 'the app says "Missed appointment"');
  // Every role on the page that the app's clinics use is named as the app names it.
  for (const id of ['clinic-receptionist', 'clinic-nurse', 'booking-clerk', 'outpatient-manager']) {
    const name = ROLES.find((r) => r.id === id).name;
    assert.ok(a1.people.some((p) => p.role === name), `the page names the app's role "${name}"`);
  }
  assert.doesNotMatch(text, /anonymous/i, 'a patient code is pseudonymous, never "anonymous" (decision record 20 Nov)');
  // Every line of the page that names reminders says, in the same line, that they are planned.
  const lines = [];
  const walk = (v) => (typeof v === 'string' ? lines.push(v) : Object.values(v || {}).forEach(walk));
  walk(a1);
  const named = lines.filter((s) => /reminder/i.test(s));
  assert.ok(named.length, 'reminders are still named, as planned');
  for (const s of named) assert.match(s, /planned/i, `reminders are not built: ${s}`);
});

test('#184: no public area page calls a patient code "anonymous"', () => {
  const bad = AREAS.filter((a) => /anonymous code/i.test(JSON.stringify(a))).map((a) => a.id);
  assert.deepEqual(bad, []);
});
