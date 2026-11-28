// Issue #195 point 6 (Critic, 27 and 28 Nov): the texts machines read first said "Built" for eleven
// modules while eight of them are first versions not yet checked (docs/MODULE-STATUS.md in the
// planning repo). They now say "in the app", and that eight are first versions, as overview.html does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../../web/${p}`, import.meta.url), 'utf8');

for (const file of ['llms.txt', 'agents.md']) {
  test(`#195: ${file} does not call all eleven modules built`, () => {
    const text = read(file);
    assert.doesNotMatch(text, /Built today|Built modules/);
    assert.match(text, /In the app today/);
  });
}
test('#195: llms.txt\'s app link says eight of the modules are first versions', () => {
  assert.match(read('llms.txt'), /Modules in the app \(eight of them first versions\): \[process maps/);
});
