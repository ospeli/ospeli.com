// Issue #44, point (c): the Stores and supplies demo page described order cycle time and the tracer
// stock-out rate in older words than the app ("Request raised → goods received ... (local
// definition)"). A measure the demo shares with the built module carries the app's definition, and
// no measure on the page says "local definition" (the public word for a default a site sets is
// "editable default"). Synthetic data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { KPIS } from '../../web/app/modules/stores/commands.js';

const html = readFileSync(new URL('../../web/demo/stores-stock/index.html', import.meta.url), 'utf8');

test('#44 (c): the stores demo gives order cycle time and the tracer stock-out rate the app\'s definition', () => {
  const shared = KPIS.filter((k) => ['Order cycle time', 'Stock-out rate on tracer items'].includes(k.name));
  assert.equal(shared.length, 2, 'both measures are in the built module');
  for (const k of shared) {
    const at = html.indexOf(`def: ['${k.name}', `);
    assert.ok(at > 0, `${k.name}: the demo has a tile definition for it`);
    const text = html.slice(at, html.indexOf("'] }", at));
    assert.ok(text.includes(k.definition.replace(/'/g, "\\'")), `${k.name}: the demo uses the app's words: ${k.definition}`);
  }
});

test('#44 (c): no measure on the stores demo page says "local definition"', () => {
  assert.deepEqual(html.match(/local definition/gi) || [], []);
});
