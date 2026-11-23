// Issue #95 (and #133 point 3's browser side): the example hospital is made from the current hour, so
// a browser test that opens the app on the real clock can pass at one hour and fail at another (the
// red pipeline run 122 on 22 Nov was one). Every openPage in the files #95 names now pins the clock.
// The two two-tab tests are left on the real clock on purpose: their second tab cannot share a pinned
// clock, so pinning only the first would make the tabs disagree about the time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const FILES = ['engineering', 'agents', 'commands', 'hospital', 'kpi', 'shell', 'agents-screen'];
const TWO_TABS = ['commands.test.mjs:openPage(env, { path: \'#/beds\' })', 'shell.test.mjs:openPage(env)'];
test('#95: the browser tests named in #95 open the app on a pinned clock', () => {
  const loose = [];
  for (const f of FILES) {
    const name = `${f}.test.mjs`;
    readFileSync(new URL(`../e2e/${name}`, import.meta.url), 'utf8').split('\n').forEach((line, i) => {
      const m = line.match(/openPage\(env(?:, \{[^}]*\})?\)/);
      if (!m || /clock:/.test(m[0])) return;
      if (/page: a\b/.test(line) && TWO_TABS.includes(`${name}:${m[0]}`)) return;
      loose.push(`${name}:${i + 1}`);
    });
  }
  assert.deepEqual(loose, [], 'open the app with clock: ... (for example \'2026-11-10T10:00:00Z\')');
});
