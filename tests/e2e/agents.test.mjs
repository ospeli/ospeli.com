// Agents in the browser: no way round the command layer (issue #16), and proposals that a
// person accepts or declines, with the audit trail telling them apart (issue #17).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, openPage } from './helpers.mjs';

let env;
before(async () => { env = await startApp(); });
after(async () => { await env.close(); });

// Read the stored data directly, as a test may (the app itself never exposes this).
const stored = (page) => page.evaluate(() => new Promise((resolve, reject) => {
  const req = indexedDB.open('ospeli');
  req.onerror = () => reject(req.error);
  req.onsuccess = () => {
    const tx = req.result.transaction(['events', 'audit', 'meta'], 'readonly');
    const out = {};
    tx.objectStore('events').count().onsuccess = (e) => { out.events = e.target.result; };
    tx.objectStore('audit').count().onsuccess = (e) => { out.audit = e.target.result; };
    tx.objectStore('meta').get('agents').onsuccess = (e) => { out.agents = e.target.result?.value ?? null; };
    tx.oncomplete = () => { req.result.close(); resolve(out); };
  };
}));

async function waitForStatus(page, id, ok, ms = 5000) {
  const end = Date.now() + ms;
  let status;
  while (Date.now() < end) {
    status = await page.evaluate(async (pid) => (await window.ospeli.core.proposals()).find((x) => x.id === pid)?.status, id);
    if (ok(status)) return status;
    await page.waitForTimeout(100);
  }
  throw new Error(`proposal ${id} stayed ${status}; toast: ${await page.locator('#toast').textContent()}`);
}

test('issue #16: without the test flag a page script gets no core and cannot change agent access or the log', async () => {
  const { context, page, errors } = await openPage(env, { path: '#/beds', testHook: false });
  await page.waitForSelector('.bed');
  const before = await stored(page);
  const probe = await page.evaluate(async () => {
    const o = window.ospeli;
    const r = { core: o.core === undefined, frozen: Object.isFrozen(o), keys: Object.keys(o).sort() };
    try { o.core = {}; } catch { /* strict mode would throw; the app is frozen either way */ }
    try { o.run = () => 'hijacked'; } catch { /* ignore */ }
    try { window.ospeli = { run: () => 'hijacked' }; } catch { /* ignore */ }
    r.stillNoCore = window.ospeli.core === undefined;
    r.runIntact = window.ospeli.run !== undefined && window.ospeli.run.toString().includes('runCommand');
    r.setAccess = await window.ospeli.run('ospeli_agents_set_access', { allowed: true, wards: { 'ward-a1': true } }, { agent: 'sneaky', role: 'coo' }).then(() => 'ran', (e) => e.code);
    r.read = await window.ospeli.run('ospeli_beds_board', {}, { agent: 'sneaky', role: 'bed-manager' }).then(() => 'ran', (e) => e.code);
    return r;
  });
  assert.deepEqual(probe, { core: true, frozen: true, keys: ['commands', 'describe', 'run', 'version'], stillNoCore: true, runIntact: true, setAccess: 'agents-off', read: 'agents-off' });
  const afterwards = await stored(page);
  assert.equal(afterwards.events, before.events, 'no event was written');
  assert.equal(afterwards.agents?.allowed === true, false, 'agent access is still off');
  assert.equal(afterwards.audit, before.audit + 2, 'both refusals are in the audit trail');
  assert.deepEqual(errors, []);
  await context.close();
});

test('issue #17: an agent proposes, the bed manager accepts on the board, and the audit shows who did what', async () => {
  const { context, page, errors } = await openPage(env, { width: 390, path: '#/beds' });
  await page.waitForSelector('.bed');
  // COO switches agents on for a ward with a free bed; the agent proposes an allocation.
  const prop = await page.evaluate(async () => {
    const { runCommand } = await import('./core/commands.js');
    const core = window.ospeli.core;
    const coo = { type: 'human', role: 'coo' };
    const all = await runCommand(core, 'ospeli_beds_board', {}, coo);
    const ward = all.wards.find((w) => w.counts.available > 0).id;
    await runCommand(core, 'ospeli_agents_set_access', { allowed: true, wards: { [ward]: true } }, coo);
    await runCommand(core, 'ospeli_agents_add', { name: 'flow-bot', role: 'bed-manager', wards: [ward], days: 30 }, coo);
    const bed = all.beds.find((b) => b.wardId === ward && b.state === 'available');
    const wait = all.waiting.find((w) => !w.allocatedBed);
    const res = await window.ospeli.run('ospeli_beds_allocate', { bedId: bed.id, encounter: wait.encounter }, { agent: 'flow-bot', role: 'bed-manager' });
    return { ...res.proposal, events: await core.eventCount() };
  });
  assert.equal(prop.status, 'pending');

  // The ward nurse role is the default; switch to bed manager and see the proposal at the top.
  await page.selectOption('#role-select', 'bed-manager');
  const item = page.locator(`[data-proposal="${prop.id}"]`);
  await item.waitFor();
  assert.match(await page.locator('#prop-h').textContent(), /Agent proposals \(1\)/);
  assert.match(await item.textContent(), /Agent flow-bot for Bed manager/);
  const box = await item.locator('[data-cmd="ospeli_proposals_accept"]').boundingBox();
  assert.ok(box.height >= 44, 'Accept is a full-size tap target');
  assert.ok(box.y < 1400, 'the proposal is near the top of the board');
  await item.locator('[data-cmd="ospeli_proposals_accept"]').click();
  await page.waitForFunction(() => !document.querySelector('[data-proposal]'));
  await waitForStatus(page, prop.id, (s) => s === 'accepted');

  const after = await page.evaluate(async (id) => {
    const core = window.ospeli.core;
    const p = (await core.proposals()).find((x) => x.id === id);
    const last = (await core.auditLog()).at(-1);
    return { status: p.status, events: await core.eventCount(), lastAction: last.action, lastType: last.actorType, lastRole: last.actorRole,
      bedEvent: (await core.events({ type: 'bed.allocated' })).at(-1) };
  }, prop.id);
  assert.equal(after.status, 'accepted');
  assert.ok(after.events > prop.events);
  assert.deepEqual([after.lastAction, after.lastType, after.lastRole], ['agent.proposal-accepted', 'human', 'bed-manager']);
  assert.equal(after.bedEvent.subject, prop.input.bedId);
  const seen = await page.evaluate(async () => (await window.ospeli.run('ospeli_proposals_list', {}, { agent: 'flow-bot', role: 'bed-manager' })).proposals.map((p) => p.status));
  assert.deepEqual(seen, ['accepted'], 'the agent learns its proposal was accepted');

  // Data and audit: an Actor column and a filter.
  await page.goto(`${env.appUrl}#/data`);
  await page.waitForSelector('[data-test="audit-actor"]');
  await page.selectOption('[data-test="audit-actor"]', 'agent');
  await page.waitForFunction(() => [...document.querySelectorAll('tbody td[data-actor-type]')].every((td) => td.dataset.actorType === 'agent'));
  const agentRows = await page.locator('tbody td[data-actor-type]').allTextContents();
  assert.ok(agentRows.length >= 2);
  assert.ok(agentRows.every((t) => /^Agent flow-bot for /.test(t)), agentRows.join(' | '));
  await page.selectOption('[data-test="audit-actor"]', 'human');
  await page.waitForFunction(() => [...document.querySelectorAll('tbody td[data-actor-type]')].every((td) => td.dataset.actorType === 'human'));
  const people = await page.locator('tbody td[data-actor-type]').allTextContents();
  assert.ok(people.length >= 2 && people.every((t) => t.startsWith('Person · ')), people.join(' | '));
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'no sideways scroll');
  assert.deepEqual(errors, []);
  await context.close();
});

test('issue #17: declining needs a listed reason and changes nothing', async () => {
  const { context, page, errors } = await openPage(env, { path: '#/beds' });
  await page.waitForSelector('.bed');
  const prop = await page.evaluate(async () => {
    const { runCommand } = await import('./core/commands.js');
    const core = window.ospeli.core;
    const coo = { type: 'human', role: 'coo' };
    const all = await runCommand(core, 'ospeli_beds_board', {}, coo);
    const bed = all.beds.find((b) => b.state === 'occupied');
    await runCommand(core, 'ospeli_agents_set_access', { allowed: true, wards: { [bed.wardId]: true } }, coo);
    await runCommand(core, 'ospeli_agents_add', { name: 'flow-bot', role: 'ward-nurse', wards: [bed.wardId], days: 30 }, coo);
    const res = await window.ospeli.run('ospeli_beds_flag_expected_discharge', { bedId: bed.id }, { agent: 'flow-bot', role: 'ward-nurse' });
    return { ...res.proposal, events: await core.eventCount() };
  });
  const item = page.locator(`[data-proposal="${prop.id}"]`);
  await item.waitFor();
  await item.locator('select').selectOption('Already done');
  await item.locator('[data-cmd="ospeli_proposals_decline"]').click();
  await page.waitForFunction(() => !document.querySelector('[data-proposal]'));
  await waitForStatus(page, prop.id, (s) => s === 'declined');
  const after = await page.evaluate(async (id) => ({
    p: (await window.ospeli.core.proposals()).find((x) => x.id === id), events: await window.ospeli.core.eventCount(),
  }), prop.id);
  assert.equal(after.p.status, 'declined');
  assert.equal(after.p.reason, 'Already done');
  assert.equal(after.events, prop.events);
  assert.deepEqual(errors, []);
  await context.close();
});

// Agent journey in the browser (backlog A7, issue #39): the flow coordinator's top task through
// window.ospeli only, in two calls, and the person still decides on the board.
test('agent journey: find a free bed and propose it in two window.ospeli calls; a person accepts on the board (issue #39)', async () => {
  const { context, page, errors } = await openPage(env, { width: 390, path: '#/beds' });
  await page.waitForSelector('.bed');
  const out = await page.evaluate(async () => {
    const { runCommand } = await import('./core/commands.js');
    const core = window.ospeli.core;
    const coo = { type: 'human', role: 'coo' };
    const all = await runCommand(core, 'ospeli_beds_board', { format: 'short' }, coo);
    const ward = all.wards.find((w) => w.counts.available > 0).id;
    await runCommand(core, 'ospeli_agents_set_access', { allowed: true, wards: { [ward]: true } }, coo);
    await runCommand(core, 'ospeli_agents_add', { name: 'flow-bot', role: 'bed-manager', wards: [ward], days: 30 }, coo);
    // The agent: two calls.
    const who = { agent: 'flow-bot', role: 'bed-manager' };
    const found = await window.ospeli.run('ospeli_beds_find_free', { wardId: ward }, who);
    const res = await window.ospeli.run(found.nextStep.command, found.nextStep.input, who);
    // The old name still answers, and commands() lists only the new names.
    const old = await window.ospeli.run('beds.board', { wardId: ward, format: 'short' }, who);
    const names = window.ospeli.commands().map((c) => c.name);
    return { ward, found, status: res.status, id: res.proposal.id, command: res.proposal.command, oldTotal: old.total, names,
      described: window.ospeli.describe('bed.allocate').name };
  });
  assert.equal(out.status, 'proposed');
  assert.equal(out.command, 'ospeli_beds_allocate');
  assert.ok(out.found.beds.length >= 1 && out.found.beds.every((b) => b.wardId === out.ward));
  assert.ok(out.oldTotal > 0);
  assert.ok(out.names.every((n) => /^ospeli_[a-z]+(_[a-z]+)+$/.test(n)), 'only new names are listed');
  assert.equal(out.described, 'ospeli_beds_allocate');

  await page.selectOption('#role-select', 'bed-manager');
  const item = page.locator(`[data-proposal="${out.id}"]`);
  await item.waitFor();
  await item.locator('[data-cmd="ospeli_proposals_accept"]').click();
  await page.waitForFunction(() => !document.querySelector('[data-proposal]'));
  await waitForStatus(page, out.id, (s) => s === 'accepted');
  const bed = await page.evaluate(async (id) => (await window.ospeli.run('ospeli_beds_get', { bedId: id }, { agent: 'flow-bot', role: 'bed-manager' })).bed.state, out.found.nextStep.input.bedId);
  assert.equal(bed, 'allocated');
  assert.deepEqual(errors, []);
  await context.close();
});
