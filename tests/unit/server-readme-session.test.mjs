// Issue #70 item 3: the site server README opens with six lines of a real session (a bot's
// proposal, "accept 1", and the two audit lines). This test replays that session and checks each
// quoted line is what the server window really prints, so the README cannot drift from the build.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const emit = process.emitWarning;
process.emitWarning = (w, ...rest) => (/SQLite/i.test(String(w?.message || w)) ? undefined : emit.call(process, w, ...rest));
const { startServer } = await import('../../tools/ospeli-server/site-server.mjs');

const END = '2026-11-08T12:00:00.000Z';
const dir = mkdtempSync(join(tmpdir(), 'ospeli-readme-'));
let site;
after(async () => { await site?.close().catch(() => {}); rmSync(dir, { recursive: true, force: true }); });

const README = readFileSync(new URL('../../tools/ospeli-server/README.md', import.meta.url), 'utf8');
const TIME = /\d{4}-\d\d-\d\d \d\d:\d\d/g;
const norm = (s) => s.replace(TIME, 'TIME').trim();

test('#70: the README session lines are what the server window prints', async () => {
  const section = README.split('## What it looks like')[1];
  assert.ok(section, 'the README has the session section');
  assert.ok(README.indexOf('## What it looks like') < README.indexOf('## Start'), 'it comes before Start');
  const quoted = section.split('\n## ')[0].split('\n').filter((l) => l.startsWith('    ')).map((l) => l.slice(4));
  assert.equal(quoted.length, 6, 'six lines');

  const t = { now: Date.parse(END) };
  site = await startServer({ file: join(dir, 'site.db'), port: 0, end: END, clock: () => new Date(t.now += 1000) });
  let out;
  for (const line of ['setup agent', 'night-helper', '2', '1', '']) out = await site.consoleLine(line);
  const key = /osk_[0-9a-f]{8}_[A-Za-z0-9_-]{32}/.exec(out)[0];
  const cmd = async (name, input) => (await fetch(`${site.url}/api/v1/commands/${name}`, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ input }) })).json();
  const found = await cmd('ospeli_beds_find_free', {});
  assert.equal((await cmd(found.result.nextStep.command, found.result.nextStep.input)).result.status, 'proposed');
  const printed = [await site.consoleLine('proposals'), '> accept 1', await site.consoleLine('accept 1'), await site.consoleLine('audit')]
    .join('\n').split('\n').map(norm);
  for (const q of quoted) assert.ok(printed.includes(norm(q)), `printed by the server: ${q}`);
});
