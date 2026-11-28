// Issue #22 (point 1 and "done when"): the home page leads with process mapping ("Healthcare
// operations, starting with process mapping"), so the texts an agent reads first (llms.txt and
// agents.md) say the same: their "Built today" list starts with the timed walk, and the bed board is
// one module among the rest, never first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../../web/${p}`, import.meta.url), 'utf8');
const firstModule = (text) => {
  const at = text.indexOf('In the app today'); // was "Built today" (#195: eight are first versions)
  assert.ok(at >= 0, 'says what is built today');
  return text.slice(at).match(/app\/#\/([a-z-]+)/)[1];
};

test('#22: the home page leads with process mapping', () => {
  const page = read('index.html');
  assert.match(page, /<title>[^<]*starting with process mapping/i);
  assert.match(page, /<h1[^>]*>Walk one patient visit/);
});

for (const file of ['llms.txt', 'agents.md']) {
  test(`#22: ${file} lists the timed walk first among what is built, as the home page does`, () => {
    assert.equal(firstModule(read(file)), 'process');
  });
}
