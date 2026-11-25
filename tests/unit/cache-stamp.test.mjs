// check.py rule: the service worker cache VERSION must be bumped when a precached file changes.
// Also: --stamp-cache cannot silence the rule, and an empty or unreadable PRECACHE never passes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const scripts = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts');
const py = process.platform === 'win32' ? 'python' : 'python3';

function run(dir, code) {
  const prog = `import sys, pathlib, json; sys.path.insert(0, ${JSON.stringify(scripts)}); import cache_stamp as c
app = pathlib.Path(${JSON.stringify(dir)}) / 'app'; stamp = pathlib.Path(${JSON.stringify(dir)}) / 'stamp.json'
${code}`;
  return execFileSync(py, ['-I', '-c', prog], { encoding: 'utf8' }).trim();
}

const swSrc = (v, list = `[\n  './',\n  'app.js',\n]`) => `const VERSION = '${v}';\nconst PRECACHE = ${list};\n`;
const setSw = (dir, v, list) => writeFileSync(join(dir, 'app', 'sw.js'), swSrc(v, list));

function site(version, appJs, list) {
  const dir = mkdtempSync(join(tmpdir(), 'cache-stamp-'));
  mkdirSync(join(dir, 'app'));
  setSw(dir, version, list);
  writeFileSync(join(dir, 'app', 'index.html'), '<!doctype html><title>t</title>');
  writeFileSync(join(dir, 'app', 'app.js'), appJs);
  return dir;
}

const errs = (dir) => JSON.parse(run(dir, 'print(json.dumps(c.stamp_errors(app, stamp)))'));
const stampIt = (dir) => JSON.parse(run(dir, 'print(json.dumps(c.write_stamp(app, stamp)))'));
const stampFile = (dir) => readFileSync(join(dir, 'stamp.json'), 'utf8');

test('missing stamp fails', () => {
  assert.equal(errs(site('v1', 'a')).length, 1);
});

test('unchanged files with a fresh stamp pass', () => {
  const dir = site('v1', 'a');
  assert.deepEqual(stampIt(dir), []);
  assert.deepEqual(errs(dir), []);
});

test('a cached file changed without a VERSION bump fails', () => {
  const dir = site('v1', 'a');
  stampIt(dir);
  writeFileSync(join(dir, 'app', 'app.js'), 'b');
  const e = errs(dir);
  assert.equal(e.length, 1);
  assert.match(e[0], /VERSION is still v1/);
});

test('a cached file changed with a VERSION bump asks only for a re-stamp, then passes', () => {
  const dir = site('v1', 'a');
  stampIt(dir);
  writeFileSync(join(dir, 'app', 'app.js'), 'b');
  setSw(dir, 'v2');
  assert.match(errs(dir)[0], /stale/);
  assert.deepEqual(stampIt(dir), []);
  assert.deepEqual(errs(dir), []);
});

// Review gap 1: --stamp-cache must not record a new digest under the old VERSION.
test('--stamp-cache refuses when cached files changed but VERSION did not, and leaves the stamp alone', () => {
  const dir = site('v1', 'a');
  stampIt(dir);
  const before = stampFile(dir);
  writeFileSync(join(dir, 'app', 'app.js'), 'b');
  const refused = stampIt(dir);
  assert.equal(refused.length, 1);
  assert.match(refused[0], /refused/);
  assert.match(refused[0], /VERSION is still v1/);
  assert.equal(stampFile(dir), before);
  assert.match(errs(dir)[0], /VERSION is still v1/);
});

test('--stamp-cache with nothing changed is allowed and changes nothing', () => {
  const dir = site('v1', 'a');
  stampIt(dir);
  const before = stampFile(dir);
  assert.deepEqual(stampIt(dir), []);
  assert.equal(stampFile(dir), before);
});

test('--stamp-cache refuses to overwrite a stamp that is not valid JSON', () => {
  const dir = site('v1', 'a');
  writeFileSync(join(dir, 'stamp.json'), '{not json');
  assert.match(stampIt(dir)[0], /not valid JSON/);
  assert.equal(stampFile(dir), '{not json');
  assert.match(errs(dir)[0], /not valid JSON/);
});

// Review gap 2: an empty or unreadable PRECACHE must fail, not pass for ever.
for (const [name, list, pattern] of [
  ['empty', '[]', /PRECACHE list is empty/],
  ['empty with only a comment', '[\n  // nothing yet\n]', /PRECACHE list is empty/],
  ['built from a variable', '[\n  SHELL,\n]', /entry not understood: SHELL/],
  ['a template string', '[\n  `app.js`,\n]', /entry not understood/],
  ['a spread', '[...SHELL]', /entry not understood/],
  ['not an array literal', 'SHELL.concat([])', /PRECACHE list not found/],
]) {
  test(`PRECACHE ${name} fails the check and blocks --stamp-cache`, () => {
    const dir = site('v1', 'a', list);
    const e = errs(dir);
    assert.ok(e.some((m) => pattern.test(m)), JSON.stringify(e));
    const refused = stampIt(dir);
    assert.ok(refused.some((m) => pattern.test(m)), JSON.stringify(refused));
    assert.ok(refused.some((m) => /not written/.test(m)));
    assert.equal(existsSync(join(dir, 'stamp.json')), false);
  });
}

test('a renamed PRECACHE fails', () => {
  const dir = site('v1', 'a');
  writeFileSync(join(dir, 'app', 'sw.js'), "const VERSION = 'v1';\nconst SHELL = [\n  'app.js',\n];\n");
  assert.match(errs(dir)[0], /PRECACHE list not found/);
});

test('double-quoted entries are read, so a change to them is still caught', () => {
  const dir = site('v1', 'a', '[\n  "./",\n  "app.js", // the app\n]');
  assert.deepEqual(stampIt(dir), []);
  writeFileSync(join(dir, 'app', 'app.js'), 'b');
  assert.match(errs(dir)[0], /VERSION is still v1/);
});

test('a missing VERSION fails and blocks --stamp-cache', () => {
  const dir = site('v1', 'a');
  writeFileSync(join(dir, 'app', 'sw.js'), "const PRECACHE = [\n  'app.js',\n];\n");
  assert.match(errs(dir)[0], /VERSION not found/);
  assert.ok(stampIt(dir).length > 0);
});

test('CRLF line endings give the same digest as LF', () => {
  const lf = site('v1', 'a\nb\n');
  const crlf = site('v1', 'a\r\nb\r\n');
  const d = (dir) => run(dir, 'print(c.current(app)[0]["digest"])');
  assert.equal(d(lf), d(crlf));
});

test('the repo stamp matches the shipped app', () => {
  const out = execFileSync(py, ['-I', '-c', `import sys, pathlib; sys.path.insert(0, ${JSON.stringify(scripts)}); import cache_stamp as c
r = pathlib.Path(${JSON.stringify(scripts)}).parent
print(len(c.stamp_errors(r / 'web' / 'app', r / 'scripts' / 'sw-cache-stamp.json')))`], { encoding: 'utf8' }).trim();
  assert.equal(out, '0');
});
