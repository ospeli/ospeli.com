// Issue #70 item 2: the phone row "18 more ..." and the desktop card "And 18 more" must say the
// same true thing. The 18 are previews that exist as demos, so the phone link says "previews",
// and the number is checked against the demo folders.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';

const web = new URL('../../web/', import.meta.url);
const html = readFileSync(new URL('index.html', web), 'utf8');
const demos = readdirSync(new URL('demo/', web)).filter((d) => statSync(new URL(`demo/${d}`, web)).isDirectory());
// The old standalone pages of the areas that are built in the app are not previews (the last three
// since 17 and 18 Nov, issue #118: their pages now link into the app).
const OLD_PAGES_OF_BUILT = ['bed-board', 'process-map', 'support-tasks', 'stores-stock', 'feedback'];

test('#70: the phone previews row and the desktop "And N more" card name the same number of real previews', () => {
  const list = html.split('<nav class="pv-list"')[1].split('</nav>')[0];
  const named = [...list.matchAll(/href="demo\/([a-z-]+)\/"/g)].map((m) => m[1]);
  const previews = demos.filter((d) => !OLD_PAGES_OF_BUILT.includes(d));
  for (const d of named) assert.ok(previews.includes(d), `${d} is a preview`);
  const more = previews.length - named.length;
  const phone = /<a href="demo\/">(\d+) more ([a-z]+): see all demos<\/a>/.exec(list);
  assert.ok(phone, 'the last phone row links to all demos');
  assert.equal(Number(phone[1]), more);
  assert.equal(phone[2], 'previews', 'says what the rest are: previews, each with a demo');
  const desk = /<h3>And (\d+) more<\/h3><p>Every area now has a preview/.exec(html);
  assert.ok(desk);
  assert.equal(Number(desk[1]), more);
});
