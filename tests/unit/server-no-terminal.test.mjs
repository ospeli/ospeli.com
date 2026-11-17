// Issue #74: the site server started without a terminal (a service manager, a container, nohup)
// had no console at all, and its banner still said "Type a word below". Now words sent on its
// input are read one per line, the banner says there is no terminal, the end of the input is said
// once and the server keeps running; with --no-console the banner says how a person can act.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER = fileURLToPath(new URL('../../tools/ospeli-server/server.mjs', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'ospeli-noterm-'));
const kids = [];
after(() => { for (const k of kids) k.kill('SIGKILL'); rmSync(dir, { recursive: true, force: true }); });

let n = 0;
function start(args = [], stdin = 'pipe') {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const kid = spawn(process.execPath, [SERVER, '--port', String(port), '--data', join(dir, `s${++n}.db`), ...args], { stdio: [stdin, 'pipe', 'pipe'] });
  kids.push(kid);
  let out = '';
  kid.stdout.on('data', (d) => { out += d; });
  kid.stderr.on('data', (d) => { out += d; });
  const until = (re, ms = 20000) => new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => (re.test(out) ? resolve(out) : Date.now() - t0 > ms ? reject(new Error(`timed out waiting for ${re}:\n${out}`)) : setTimeout(tick, 50));
    tick();
  });
  return { kid, until, out: () => out, port };
}
const stopped = (kid) => new Promise((r) => kid.once('exit', r));

test('#74: words piped in are read, the banner says there is no terminal, and the end of the input does not stop the server', async () => {
  const s = start();
  await s.until(/Ospeli is running/);
  await s.until(/To turn Ospeli off/);
  assert.doesNotMatch(s.out(), /Type a word below/);
  assert.match(s.out(), /No terminal here\. Ospeli reads words from its input, one per line/);
  s.kid.stdin.write('proposals\n');
  await s.until(/Nothing is waiting/);
  s.kid.stdin.end();
  await s.until(/Input ended/);
  assert.match(s.out(), /Ospeli keeps running\. To let bots in or accept changes, start Ospeli in a terminal window\./);
  // Still answering after the input ended.
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(s.kid.exitCode, null, 'still running');
  const res = await fetch(`http://127.0.0.1:${s.port}/api/v1/health`).catch(() => null) || await fetch(`http://127.0.0.1:${s.port}/app/`);
  assert.ok(res.status < 500);
  const exit = stopped(s.kid);
  s.kid.kill('SIGTERM');
  await exit;
  assert.match(s.out(), /Ospeli is off\. Your data is saved\./);
});

test('#74: started with no input at all (</dev/null): one clear line instead of "Type a word below"', async () => {
  const s = start([], 'ignore');
  await s.until(/To turn Ospeli off/);
  assert.doesNotMatch(s.out(), /Type a word below/);
  await s.until(/Input ended/);
  assert.equal(s.kid.exitCode, null);
  const exit = stopped(s.kid); s.kid.kill('SIGTERM'); await exit;
});

test('#74: with --no-console the banner says there is no console and how a person can act', async () => {
  const s = start(['--no-console']);
  await s.until(/To turn Ospeli off/);
  assert.doesNotMatch(s.out(), /Type a word below/);
  assert.match(s.out(), /No console here\. Start Ospeli in a terminal window to let bots in or accept changes\./);
  const exit = stopped(s.kid); s.kid.kill('SIGTERM'); await exit;
});
