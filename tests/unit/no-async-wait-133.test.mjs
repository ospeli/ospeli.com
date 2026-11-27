// Issue #133, point 2: Playwright's page.waitForFunction takes the promise an async predicate returns
// as "true" and goes on at once, so `waitForFunction(async …)` waits for nothing and the next line can
// run before the page has caught up. Browser tests wait on an async check with waitUntil() from
// tests/e2e/helpers.mjs, which polls the answer itself. This guard keeps the pattern from coming back.
// A check without the async word that still hands back a promise (`… .then(…)`) is the same fault.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

const dir = new URL('../e2e/', import.meta.url);
const scan = (bad) => {
  const found = [];
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.mjs'))) {
    readFileSync(new URL(f, dir), 'utf8').split('\n').forEach((line, i) => {
      if (bad.test(line)) found.push(`${f}:${i + 1}`);
    });
  }
  return found;
};
test('#133: no browser test waits with waitForFunction(async …), which never waits', () => {
  const found = scan(/waitForFunction\(\s*async\b/);
  assert.deepEqual(found, [], `use waitUntil(page, async () => …) from helpers.mjs instead:\n${found.join('\n')}`);
});
test('#133: no browser test waits with waitForFunction on a check that hands back a promise (.then), which never waits either', () => {
  const found = scan(/waitForFunction\(.*\.then\(.*\)\s*,|waitForFunction\([^)]*=>[^;]*\.then\(/);
  assert.deepEqual(found, [], `use waitUntil(page, async () => …) from helpers.mjs instead:\n${found.join('\n')}`);
});
