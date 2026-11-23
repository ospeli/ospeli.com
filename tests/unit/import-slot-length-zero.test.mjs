// Deep pass, import and export. One number in one imported event stops the app. A planned
// session carries its length and its slot length in minutes. Ospeli's own commands hold both to
// sensible values; the import check does not look inside module events. slotGrid() in
// core/slots.js loops "while (k + 1) * slotMinutes <= minutes": with a slot length of 0 (or less)
// that is true for ever, and the list it builds grows until the page runs out of memory. Every
// page and command that reads sessions does this again each time it is opened, until the device
// is reset. The read runs in a child process here so the test itself cannot hang.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const child = `
import { Core } from './web/app/core/core.js';
import { MemoryAdapter } from './web/app/core/db.js';
import { loadSyntheticHospital } from './web/app/core/generator.js';
import { runCommand } from './web/app/core/commands.js';
const END = '2026-11-06T18:00:00.000Z';
let t = Date.parse(END); const clock = () => new Date(t += 1000);
const src = await Core.open({ adapter: new MemoryAdapter(), clock });
await loadSyntheticHospital(src, { end: END });
const file = JSON.parse(JSON.stringify(await src.exportData()));
const planned = file.events.findLast((e) => e.type === 'session.planned' && e.data.slotMinutes != null);
planned.data.slotMinutes = 0;
const core = await Core.open({ adapter: new MemoryAdapter(), clock });
const errs = await core.validateImport(file);
if (errs.length) { console.log('REFUSED'); process.exit(0); }
await core.importData(file, 'coo');
console.log('IMPORTED');
await runCommand(core, 'ospeli_slots_sessions', {}, { type: 'human', role: 'coo' });
console.log('READ');
`;

test('a session with a slot length of 0 in an imported file does not hang the reads', () => {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const out = spawnSync(process.execPath, ['--max-old-space-size=256', '--input-type=module', '-e', child], { cwd: root, encoding: 'utf8', timeout: 60000 });
  const said = out.stdout.trim().split('\n');
  assert.ok(said.includes('REFUSED') || said.includes('READ'),
    `the file was ${said.includes('IMPORTED') ? 'imported' : 'not imported'} and the read never came back (child ended with ${out.signal || out.status}: ${(out.stderr.match(/FATAL ERROR[^\n]*/) || [out.error?.code || ''])[0]})`);
});
