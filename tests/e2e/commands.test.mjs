// Command layer in the browser (A2), stale tabs (issue #9) and the synthetic-only import (issue #5).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startApp, openPage } from './helpers.mjs';

let env;
before(async () => { env = await startApp(); });
after(async () => { await env.close(); });

const bedState = (page, id) => page.evaluate(async (bedId) => {
  const { runCommand } = await import('./core/commands.js');
  return (await runCommand(window.ospeli.core, 'bed.get', { bedId }, { type: 'human', role: 'coo' })).bed.state;
}, id);

test('window.ospeli lists and describes commands; agents are off by default and audited', async () => {
  const { context, page, errors } = await openPage(env, { width: 390, path: '#/beds/ward-a1' });
  await page.waitForSelector('.bed');
  const names = await page.evaluate(() => window.ospeli.commands().map((c) => c.name));
  assert.ok(names.includes('beds.board') && names.includes('bed.allocate'));
  const d = await page.evaluate(() => window.ospeli.describe('bed.allocate'));
  assert.equal(d.humanApproval, true);
  assert.deepEqual(d.input.required, ['bedId', 'encounter']);
  const refused = await page.evaluate(() => window.ospeli.run('beds.board', {}, { agent: 'e2e-agent' }).then(() => 'ran', (e) => e.code));
  assert.equal(refused, 'agents-off');
  const last = await page.evaluate(async () => (await window.ospeli.core.auditLog()).at(-1));
  assert.equal(last.action, 'agent.refused');
  assert.equal(last.actorType, 'agent');
  // The name of a caller nobody has put on the site's list is agent-typed text: it is not stored (#27).
  assert.equal(last.agent, 'unlisted');

  // Every action control on the board names the command it runs, and that command exists.
  await page.click('.bed');
  await page.waitForSelector('dialog[open]');
  const cmds = await page.evaluate(() => [...document.querySelectorAll('main [data-cmd]')].map((b) => b.dataset.cmd));
  assert.ok(cmds.length > 20);
  for (const c of new Set(cmds)) assert.ok(names.includes(c), `${c} is a listed command`);
  const actions = await page.locator('dialog[open] [data-action]').count();
  assert.equal(await page.locator('dialog[open] [data-action][data-cmd]').count(), actions);

  // The commands.json spec is served next to the app and matches the registry.
  const spec = await page.evaluate(async () => (await fetch('./api/commands.json')).json());
  assert.deepEqual(spec.commands.map((c) => c.name), names);
  assert.deepEqual(errors, []);
  await context.close();
});

test('an agent with access switched on reads one ward and its change waits for a person', async () => {
  const { context, page, errors } = await openPage(env, { path: '#/beds/ward-a1' });
  await page.waitForSelector('.bed');
  const out = await page.evaluate(async () => {
    const core = window.ospeli.core;
    const { runCommand } = await import('./core/commands.js');
    await runCommand(core, 'agents.set-access', { allowed: true, wards: { 'ward-a1': true } }, { type: 'human', role: 'coo' });
    // Each agent is on the site's list for one role (issues #20, #25).
    await runCommand(core, 'agent.add', { name: 'e2e-agent', role: 'bed-manager', wards: ['ward-a1'], days: 30 }, { type: 'human', role: 'coo' });
    await runCommand(core, 'agent.add', { name: 'e2e-ward-agent', role: 'ward-nurse', wards: ['ward-a1'], days: 30 }, { type: 'human', role: 'coo' });
    const board = await window.ospeli.run('beds.board', {}, { agent: 'e2e-agent', role: 'bed-manager' });
    const bed = board.beds.find((b) => b.state === 'available' || b.state === 'vacated' || b.state === 'cleaning') || board.beds[0];
    const before = await core.eventCount();
    const res = await window.ospeli.run('bed.take-out-of-service', { bedId: bed.id, reason: 'Electrical' }, { agent: 'e2e-ward-agent', role: 'ward-nurse' });
    return { wards: board.wards.map((w) => w.id), res, same: before === await core.eventCount(), last: (await core.auditLog()).at(-1) };
  });
  assert.deepEqual(out.wards, ['ward-a1']);
  assert.equal(out.res.status, 'proposed');
  assert.ok(out.same, 'nothing changed in the event log');
  assert.equal(out.last.action, 'agent.proposed');
  assert.equal(out.last.actorType, 'agent');
  assert.deepEqual(errors, []);
  await context.close();
});

test('issue #9: a second tab refreshes, and a stale dialog cannot take an occupied bed out of service', async () => {
  const { context, page: a, errors } = await openPage(env, { path: '#/beds' });
  const b = await context.newPage();
  const errorsB = [];
  b.on('pageerror', (e) => errorsB.push(String(e)));
  b.on('console', (m) => { if (m.type() === 'error') errorsB.push(m.text()); });
  await b.goto(`${env.appUrl}#/beds`);
  await b.waitForSelector('html[data-ready="true"]');
  // Pick a free bed and a waiting patient.
  const { bedId, wardId, encounter } = await a.evaluate(async () => {
    const { runCommand } = await import('./core/commands.js');
    const board = await runCommand(window.ospeli.core, 'beds.board', {}, { type: 'human', role: 'bed-manager' });
    const bed = board.beds.find((x) => x.state === 'available');
    return { bedId: bed.id, wardId: bed.wardId, encounter: board.waiting.find((w) => !w.allocatedBed).encounter };
  });
  await b.click(`.ward-tab[data-ward="${wardId}"]`);
  await b.click(`.bed[data-bed="${bedId}"]`); // tab B opens the bed while it is available
  await b.waitForSelector('dialog[open] [data-action="out-of-service"]');

  // Tab A: allocate and admit.
  await a.evaluate(async ([bed, enc]) => {
    const { runCommand } = await import('./core/commands.js');
    await runCommand(window.ospeli.core, 'bed.allocate', { bedId: bed, encounter: enc }, { type: 'human', role: 'bed-manager' });
    await runCommand(window.ospeli.core, 'bed.admit', { bedId: bed }, { type: 'human', role: 'ward-nurse' });
  }, [bedId, encounter]);
  // Tab B's board redraws from the shared log behind the open dialog.
  await b.waitForFunction((id) => document.querySelector(`.bed[data-bed="${id}"]`)?.classList.contains('st-occupied'), bedId);
  // The stale dialog's button is refused, and the bed keeps its patient.
  await b.selectOption('dialog[open] #oos-reason', 'Electrical');
  await b.click('dialog[open] [data-action="out-of-service"]');
  await b.waitForFunction(() => /Not saved\. This bed changed since you opened it/.test(document.querySelector('#toast').textContent));
  assert.equal(await bedState(b, bedId), 'occupied');
  const oos = await b.evaluate(async (id) => (await window.ospeli.core.events({ type: 'bed.out-of-service', subject: id })).length, bedId);
  assert.equal(oos, 0);
  // Board occupancy equals the occupancy KPI numerator.
  const agree = await b.evaluate(async () => {
    const { runCommand } = await import('./core/commands.js');
    const r = { type: 'human', role: 'coo' };
    const board = await runCommand(window.ospeli.core, 'beds.board', {}, r);
    const kpi = await runCommand(window.ospeli.core, 'kpi.value', { id: 'occupancy' }, r);
    return [board.beds.filter((x) => x.state === 'occupied' || x.state === 'expected-discharge').length, kpi.numerator];
  });
  assert.equal(agree[0], agree[1]);
  assert.deepEqual([...errors, ...errorsB], []);
  await context.close();
});

test('issue #5: import refuses non-synthetic files and personal-detail fields; the badge follows the data', async () => {
  const { context, page, errors } = await openPage(env, { path: '#/data' });
  await page.waitForSelector('[data-test="audit-status"]');
  assert.equal(await page.textContent('[data-test="synthetic-badge"]'), 'Synthetic data');
  const dump = await page.evaluate(() => window.ospeli.core.exportData());
  const dir = os.tmpdir();
  const tryFile = async (name, data, pattern) => {
    const file = path.join(dir, `${name}-${Date.now()}.json`);
    await writeFile(file, JSON.stringify(data));
    await page.setInputFiles('#import-file', file);
    await page.waitForFunction((p) => new RegExp(p).test(document.querySelector('[data-test="import-status"]').textContent), pattern);
  };
  await tryFile('not-synthetic', { ...dump, synthetic: false }, 'Import refused.*synthetic data only');
  const withName = structuredClone(dump);
  withName.events[0].data = { ...(withName.events[0].data || {}), patientName: 'placeholder' };
  await tryFile('with-name', withName, 'Import refused.*personal details.*patientName');
  assert.equal(await page.evaluate(() => window.ospeli.core.eventCount()), dump.events.length, 'nothing changed');

  page.once('dialog', (d) => d.accept());
  await page.click('text=Reset device data');
  await page.waitForFunction(() => document.querySelector('[data-test="synthetic-badge"]').textContent === 'No data loaded');
  await page.waitForFunction(() => document.querySelector('#toast').textContent === 'Device data cleared');
  assert.equal(await page.locator('[data-test="generator-meta"]').count(), 0, 'issue #7: no stale seed line');
  await page.goto(`${env.appUrl}#/home`);
  await page.reload();
  await page.waitForSelector('html[data-ready="true"]');
  assert.equal(await page.textContent('[data-test="synthetic-badge"]'), 'No data loaded');
  assert.doesNotMatch(await page.textContent('main'), /\bnull\b/, 'issue #7: Today never prints "null"');
  assert.deepEqual(errors, []);
  await context.close();
});
