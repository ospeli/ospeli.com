// Issue ospeli/ospeli#192 (point 2), after #184: a patient code or a patient timeline that the site
// can link back to a person is pseudonymous, never "anonymous" (decision record 20 Nov). The agent
// files describe the emergency department flow preview as "a patient timeline with no names".
// scripts/check.py guards the same words in every public page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

const ANON_PATIENT = /\banonymous\s+(?:patient|record)s?\b/i;

test('#192: the agent files never call a patient timeline or code "anonymous"', () => {
  for (const name of ['llms.txt', 'agents.md']) {
    const url = new URL(`../../web/${name}`, import.meta.url);
    if (!existsSync(url)) continue;
    const text = readFileSync(url, 'utf8').replace(/\s+/g, ' ');
    assert.doesNotMatch(text, ANON_PATIENT, `${name}: say "a patient timeline with no names" or "patient code"`);
  }
});

test('#192: llms.txt describes the emergency department flow preview as a patient timeline with no names', () => {
  const text = readFileSync(new URL('../../web/llms.txt', import.meta.url), 'utf8');
  const line = text.split('\n').find((l) => l.includes('/demo/ed-flow/'));
  assert.ok(line, 'the preview is still listed');
  assert.match(line, /a patient timeline with no names/);
});
