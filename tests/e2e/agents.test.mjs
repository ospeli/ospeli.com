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

test('issue #17: an agent proposes, the patient flow coordinator accepts on the board, and the audit shows who did what', async () => {
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

  // The ward nurse role is the default; switch to patient flow coordinator and see the proposal at the top.
  await page.selectOption('#role-select', 'bed-manager');
  const item = page.locator(`[data-proposal="${prop.id}"]`);
  await item.waitFor();
  assert.match(await page.locator('#prop-h').textContent(), /Suggested changes \(1\)/);
  assert.match(await item.textContent(), /Agent flow-bot for Patient flow coordinator/);
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
  const { context, page, errors } = await openPage(env, { width: 390, path: '#/beds', clock: '2026-11-10T10:00:00Z' });
  // The clock is pinned: the synthetic hospital is generated from the current hour, and at some hours
  // nobody is waiting for a bed, so the journey had nothing to allocate (seen red at 07:54 UTC, 12 Nov).
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
    const pair = { bedId: found.beds[0].bedId, encounter: found.waiting[0].encounter, expectedState: 'available' };
    const res = await window.ospeli.run('ospeli_beds_allocate', found.nextStep ? found.nextStep.input : pair, who);
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
  const bed = await page.evaluate(async (id) => (await window.ospeli.run('ospeli_beds_get', { bedId: id }, { agent: 'flow-bot', role: 'bed-manager' })).bed.state, out.found.beds[0].bedId);
  assert.equal(bed, 'allocated');
  assert.deepEqual(errors, []);
  await context.close();
});

// Issue #65: the audit table says in words what an agent read, where, what it proposed and why a
// call was refused. The raw action id stays on the cell (data-action and title) for people who want it.
test('issue #65: the audit table names what an agent read, proposed and was refused, in words', async () => {
  const { context, page, errors } = await openPage(env, { width: 390, path: '#/beds', clock: '2026-11-10T10:00:00Z' });
  await page.waitForSelector('.bed');
  await page.evaluate(async () => {
    const { runCommand } = await import('./core/commands.js');
    const core = window.ospeli.core;
    const coo = { type: 'human', role: 'coo' };
    await runCommand(core, 'ospeli_agents_set_access', { allowed: true, wards: { 'ward-a1': true } }, coo);
    await runCommand(core, 'ospeli_agents_add', { name: 'flow-bot', role: 'bed-manager', wards: ['ward-a1'], days: 30 }, coo);
    const who = { agent: 'flow-bot', role: 'bed-manager' };
    await window.ospeli.run('ospeli_beds_board', { wardId: 'ward-a1', format: 'short' }, who);
    await window.ospeli.run('ospeli_kpi_get', { id: 'occupancy' }, who);
    await window.ospeli.run('ospeli_workorders_list', { overdue: true, format: 'short' }, who);
    await window.ospeli.run('ospeli_beds_board', { wardId: 'ward-b1' }, who).catch(() => {}); // a ward that is off for agents
    await window.ospeli.run('ospeli_agents_set_access', { allowed: true }, who).catch(() => {}); // people only
    const board = await runCommand(core, 'ospeli_beds_board', { wardId: 'ward-a1', limit: 500 }, coo);
    const bed = board.beds.find((b) => b.state === 'occupied');
    await window.ospeli.run('ospeli_beds_flag_expected_discharge', { bedId: bed.id, expectedState: 'occupied' }, who);
  });
  await page.goto(`${env.appUrl}#/data`);
  await page.waitForSelector('[data-test="audit-actor"]');
  await page.selectOption('[data-test="audit-actor"]', 'agent');
  await page.waitForFunction(() => document.querySelectorAll('tbody td[data-action]').length >= 6);
  const rows = await page.$$eval('tbody td[data-action]', (tds) => tds.map((td) => ({ action: td.dataset.action, title: td.title, text: td.textContent })));
  const text = (action, rx) => rows.filter((r) => r.action === action).map((r) => r.text).find((t) => rx.test(t));
  const all = rows.map((r) => `${r.action}: ${r.text}`).join(' | ');
  assert.ok(text('agent.read', /^Read the bed board: Ward A1/), all);
  assert.ok(text('agent.read', /^Read a KPI: Bed occupancy/), all);
  assert.ok(text('agent.read', /^Read the work-order queue: overdue only/), all);
  assert.ok(text('agent.refused', /^Refused: the bed board\. .*(ward|Ward)/), all);
  assert.ok(text('agent.refused', /^Refused: .*people/i), all);
  assert.ok(text('agent.proposed', /^Proposed: Flag that the patient in this bed is expected to go home today \(Ward A1, Bed \d+\) · prop-\d+/), all);
  assert.ok(rows.every((r) => r.title === r.action), 'the raw action id stays on the cell');
  assert.ok(rows.every((r) => !/^agent\.(read|refused|proposed)/.test(r.text)), all);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'no sideways scroll');
  assert.deepEqual(errors, []);
  await context.close();
});

// Issue #72: a queue worth reading. The card says how many are waiting, shows the newest three,
// and the rest are one tap away. An impossible proposal never reaches the card.
test('issue #72: five proposals show a count, the newest three and "See all"; an impossible one is refused (390px)', async () => {
  const { context, page, errors } = await openPage(env, { width: 390, path: '#/beds' });
  await page.waitForSelector('.bed');
  const out = await page.evaluate(async () => {
    const { runCommand } = await import('./core/commands.js');
    const core = window.ospeli.core;
    const coo = { type: 'human', role: 'coo' };
    const all = await runCommand(core, 'ospeli_beds_board', {}, coo);
    const ward = all.wards.find((w) => all.beds.filter((b) => b.wardId === w.id && b.state === 'occupied').length >= 5).id;
    await runCommand(core, 'ospeli_agents_set_access', { allowed: true, wards: { [ward]: true } }, coo);
    await runCommand(core, 'ospeli_agents_add', { name: 'flow-bot', role: 'ward-nurse', wards: [ward], days: 30 }, coo);
    const who = { agent: 'flow-bot', role: 'ward-nurse' };
    const beds = all.beds.filter((b) => b.wardId === ward && b.state === 'occupied').slice(0, 5);
    const ids = [];
    for (const b of beds) ids.push((await window.ospeli.run('ospeli_beds_flag_expected_discharge', { bedId: b.id }, who)).proposal.id);
    const twice = (await window.ospeli.run('ospeli_beds_flag_expected_discharge', { bedId: beds[0].id }, who)).proposal.id;
    const impossible = await window.ospeli.run('ospeli_beds_start_clean', { bedId: beds[0].id }, who).then(() => 'queued', (e) => e.code);
    const noBed = await window.ospeli.run('ospeli_beds_start_clean', { bedId: 'ward-zz-bed-99' }, who).then(() => 'queued', (e) => e.code);
    return { ids, twice, impossible, noBed, pending: (await core.proposals()).filter((p) => p.status === 'pending').length };
  });
  assert.equal(out.twice, out.ids[0], 'the same proposal comes back');
  assert.equal(out.impossible, 'conflict');
  assert.equal(out.noBed, 'not-found');
  assert.equal(out.pending, 5);
  await page.reload();
  await page.waitForSelector('[data-proposal]');
  assert.match(await page.locator('#prop-h').textContent(), /Suggested changes \(5\)/);
  assert.equal(await page.locator('[data-proposal]').count(), 3, 'the newest three');
  assert.deepEqual(await page.locator('[data-proposal]').evaluateAll((els) => els.map((e) => e.dataset.proposal)), out.ids.slice(-3).reverse());
  const more = page.locator('[data-test="proposals-more"]');
  assert.match(await more.textContent(), /^See all 5$/);
  const box = await more.boundingBox();
  assert.ok(box.height >= 44, `"See all" is a 44 px target (${box.height})`);
  await more.click();
  await page.waitForFunction(() => document.querySelectorAll('[data-proposal]').length === 5);
  const o = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(o <= 0, 'no sideways scroll');
  assert.deepEqual(errors, []);
  await context.close();
});

// Issue #101: an agent that believes it is rehearsing must not write to a person's queue. The
// browser door passes dryRun on, and refuses an option it does not know instead of dropping it.
test('issue #101: a dry run through window.ospeli queues nothing, an unknown option is refused, and every published example runs or says what it needs', async () => {
  const { context, page, errors } = await openPage(env, { width: 390, path: '#/beds', clock: '2026-11-10T10:00:00Z' });
  await page.waitForSelector('.bed');
  const out = await page.evaluate(async () => {
    const { runCommand } = await import('./core/commands.js');
    const core = window.ospeli.core;
    const coo = { type: 'human', role: 'coo' };
    const board = await runCommand(core, 'ospeli_beds_board', {}, coo);
    const wards = board.wards.map((w) => w.id);
    await runCommand(core, 'ospeli_agents_set_access', { allowed: true, wards: Object.fromEntries(wards.map((id) => [id, true])) }, coo);
    await runCommand(core, 'ospeli_agents_add', { name: 'rehearsal-bot', role: 'ward-nurse', wards, days: 30 }, coo);
    const who = { agent: 'rehearsal-bot', role: 'ward-nurse' };
    const bed = board.beds.find((b) => b.state === 'occupied');
    const pending = async () => (await core.proposals()).filter((p) => p.status === 'pending').length;
    const r = { before: await pending() };
    r.dry = await window.ospeli.run('ospeli_beds_mark_vacated', { bedId: bed.id }, { ...who, dryRun: true });
    r.afterDry = await pending();
    const refused = async (options) => { try { await window.ospeli.run('ospeli_beds_mark_vacated', { bedId: bed.id }, options); return 'ran'; } catch (e) { return { code: e.code, message: e.message, allowed: e.detail?.allowed }; } };
    r.unknown = await refused({ ...who, dryrun: true });
    r.notBoolean = await refused({ ...who, dryRun: 'yes' });
    r.notObject = await refused('dryRun');
    r.afterRefused = await pending();
    r.real = await window.ospeli.run('ospeli_beds_mark_vacated', { bedId: bed.id }, { ...who, dryRun: false });
    r.afterReal = await pending();
    // With no options the call is made as before: as the unlisted default agent, which is refused for that reason alone.
    r.plain = await window.ospeli.run('ospeli_kpi_list').then(() => 'ran', (e) => e.code);
    return r;
  });
  assert.equal(out.dry.status, 'dry-run');
  assert.match(out.dry.changed, /Nothing was read, queued or changed/);
  assert.equal(out.afterDry, out.before, 'a dry run queues nothing');
  assert.equal(out.unknown.code, 'invalid-input');
  assert.match(out.unknown.message, /dryrun/);
  assert.deepEqual(out.unknown.allowed, ['agent', 'role', 'dryRun']);
  assert.equal(out.notBoolean.code, 'invalid-input');
  assert.equal(out.notObject.code, 'invalid-input');
  assert.equal(out.afterRefused, out.before, 'a refused call queues nothing');
  assert.equal(out.real.status, 'proposed');
  assert.equal(out.afterReal, out.before + 1);
  assert.equal(out.plain, 'forbidden');

  // Every example from the published commands.json, as written, through the door an agent uses
  // (people-only commands are for people; they are covered in tests/unit/examples.test.mjs).
  const spec = await (await page.request.get(`${env.appUrl}api/commands.json`)).json();
  assert.match(spec.howToCall.browser, /dryRun/);
  const results = await page.evaluate(async (commands) => {
    const { runCommand } = await import('./core/commands.js');
    const core = window.ospeli.core;
    const res = [];
    for (const c of commands) {
      const name = `example-${c.roles[0]}`;
      await runCommand(core, 'ospeli_agents_add', { name, role: c.roles[0], wards: (await core.listEntities('ward')).map((w) => w.id), days: 30 }, { type: 'human', role: 'coo' }).catch(() => {});
      try { await window.ospeli.run(c.name, c.example.input, { agent: name, role: c.roles[0] }); res.push({ name: c.name, ok: true }); } catch (e) { res.push({ name: c.name, ok: false, code: e.code, needs: c.example.needs || null }); }
    }
    return res;
  }, spec.commands.filter((c) => c.agentsMayCall));
  assert.ok(results.length >= 30);
  assert.deepEqual(results.filter((r) => !r.ok && !(r.needs && ['conflict', 'not-found'].includes(r.code))).map((r) => `${r.name}: ${r.code}`), [], 'refused with no "needs" line');
  assert.ok(results.filter((r) => r.ok).length >= 15);
  assert.deepEqual(errors, []);
  await context.close();
});

// Issue #52: the person who has to decide is told on the first screen they open, and in the menu.
for (const width of [360, 390, 1280]) {
  test(`issue #52: Today and the menu say when an agent's proposal is waiting for this role (${width}px)`, async () => {
    const { context, page, errors } = await openPage(env, { width, path: '#/home', clock: '2026-11-10T10:00:00Z', touch: width < 500 });
    const card = page.locator('[data-test="decisions-waiting"]');
    const menuCounts = () => page.evaluate(() => Object.fromEntries([...document.querySelectorAll('#nav-list a')].filter((a) => a.querySelector('.nav-count')).map((a) => [a.dataset.module, { n: a.querySelector('.nav-count').textContent.trim(), spoken: a.querySelector('.nav-count').getAttribute('aria-label') }])));
    // Nothing waiting: no card, no count.
    assert.equal(await card.count(), 0);
    assert.deepEqual(await menuCounts(), {});
    // Three agents propose: a bed action, a work-order action and a new map.
    await page.evaluate(async () => {
      const { runCommand } = await import('./core/commands.js');
      const core = window.ospeli.core;
      const coo = { type: 'human', role: 'coo' };
      const board = await runCommand(core, 'ospeli_beds_board', {}, coo);
      const wards = board.wards.map((w) => w.id);
      await runCommand(core, 'ospeli_agents_set_access', { allowed: true, wards: Object.fromEntries(wards.map((id) => [id, true])) }, coo);
      for (const [name, role] of [['flow-bot', 'bed-manager'], ['fix-bot', 'estates-tech'], ['map-bot', 'ops-manager']]) await runCommand(core, 'ospeli_agents_add', { name, role, wards, days: 30 }, coo);
      const beds = board.beds.filter((b) => b.state === 'occupied');
      await window.ospeli.run('ospeli_beds_mark_vacated', { bedId: beds[0].id }, { agent: 'flow-bot', role: 'bed-manager' });
      await window.ospeli.run('ospeli_beds_mark_vacated', { bedId: beds[1].id }, { agent: 'flow-bot', role: 'bed-manager' });
      const open = await runCommand(core, 'ospeli_workorders_list', { state: 'open' }, { type: 'human', role: 'estates-tech' });
      await window.ospeli.run('ospeli_workorders_complete', { workOrderId: open.workOrders[0].id, outcome: 'fixed' }, { agent: 'fix-bot', role: 'estates-tech' });
      await window.ospeli.run('ospeli_maps_create', { from: 'discharge' }, { agent: 'map-bot', role: 'ops-manager' });
    });
    // Today updates without a reload. The ward nurse (the role on first open) can decide the two bed proposals and the map.
    await card.waitFor();
    const read = async () => ({
      heading: (await card.locator('h2').innerText()).trim(),
      links: await card.locator('a').evaluateAll((as) => as.map((a) => [a.getAttribute('href'), a.innerText.replace(/\s+/g, ' ').trim(), Math.round(a.getBoundingClientRect().height), parseFloat(getComputedStyle(a).fontSize)])),
    });
    // The card appears with the first proposal and draws itself again as the next ones land (issue
    // #95: reading it once saw 2 of 3). Wait for it to settle on the expected heading, then check it.
    const settle = (want) => page.waitForFunction((w) => document.querySelector('[data-test="decisions-waiting"] h2')?.innerText.trim() === w, want, { timeout: 10000 }).catch(() => {});
    await settle('Waiting for your decision (3)');
    let c = await read();
    assert.equal(c.heading, 'Waiting for your decision (3)');
    assert.deepEqual(c.links.map((l) => l.slice(0, 2)), [['#/beds', 'Bed board: 2 proposals'], ['#/process', 'Process maps: 1 proposal']]);
    for (const l of c.links) { assert.ok(l[2] >= 44, `tap target ${l[2]} px`); assert.ok(l[3] >= 15, `text ${l[3]} px`); }
    // The card is the first thing on the page after the heading, on the first screen.
    const top = await card.evaluate((e) => e.getBoundingClientRect().top);
    assert.ok(top < (width < 500 ? 780 : 860) * 0.6, `the card starts at ${Math.round(top)} px`);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), 0, 'no sideways scroll');
    assert.deepEqual(await menuCounts(), { beds: { n: '2', spoken: '2 proposals waiting for your decision' }, process: { n: '1', spoken: '1 proposal waiting for your decision' } });
    // The facilities technician sees their share: the work order and the map.
    await page.selectOption('#role-select', 'estates-tech');
    await page.waitForFunction(() => /Facilities technician/.test(document.querySelector('main h1')?.textContent || ''));
    await card.waitFor();
    await settle('Waiting for your decision (2)');
    c = await read();
    assert.equal(c.heading, 'Waiting for your decision (2)');
    assert.deepEqual(c.links.map((l) => l.slice(0, 2)), [['#/engineering', 'Engineering: 1 proposal'], ['#/process', 'Process maps: 1 proposal']]);
    assert.deepEqual(Object.keys(await menuCounts()), ['engineering', 'process']);
    // The Agents screen says, for each agent, how many of its proposals nobody has answered yet.
    await page.evaluate(() => { location.hash = '#/agents'; });
    await page.waitForSelector('.ag-agent[data-agent="flow-bot"] [data-test="agent-waiting"]');
    assert.deepEqual(await page.locator('.ag-agent').evaluateAll((rows) => rows.map((r) => [r.dataset.agent, r.querySelector('[data-test="agent-waiting"]')?.textContent || null])),
      [['flow-bot', '2 proposals waiting for a person'], ['fix-bot', '1 proposal waiting for a person'], ['map-bot', '1 proposal waiting for a person']]);
    await page.evaluate(() => { location.hash = '#/home'; });
    await card.waitFor();
    // One tap goes to the place it is decided; declining it there takes it off the menu and off Today.
    await card.locator('a[href="#/engineering"]').evaluate((a) => a.click());
    await page.waitForSelector('[data-test="proposals"] .proposal-item');
    await page.locator('[data-test="proposals"] [data-cmd="ospeli_proposals_decline"]').first().evaluate((b) => b.click());
    await page.waitForFunction(() => !document.querySelector('#nav-list a[data-module="engineering"] .nav-count'));
    await page.evaluate(() => { location.hash = '#/home'; });
    await card.waitFor();
    await settle('Waiting for your decision (1)');
    assert.equal((await read()).heading, 'Waiting for your decision (1)');
    // Nothing shows once nothing is waiting.
    await page.evaluate(async () => {
      const { runCommand } = await import('./core/commands.js');
      for (const p of (await window.ospeli.core.proposals()).filter((x) => x.status === 'pending')) await runCommand(window.ospeli.core, 'ospeli_proposals_decline', { id: p.id, reason: 'Not needed' }, { type: 'human', role: p.command.startsWith('ospeli_beds_') ? 'bed-manager' : 'ops-manager' });
    });
    await page.waitForFunction(() => !document.querySelector('[data-test="decisions-waiting"]') && !document.querySelector('#nav-list .nav-count'));
    assert.deepEqual(errors, []);
    await context.close();
  });
}

// Issue #106: a person can tell proposals apart, and is offered reasons that fit what is proposed.
test('issue #106: map and fault proposals show their title, and the reasons to decline fit the kind of proposal (390px)', async () => {
  const { context, page, errors } = await openPage(env, { width: 390, path: '#/home', clock: '2026-11-10T10:00:00Z' });
  const made = await page.evaluate(async () => {
    const { runCommand } = await import('./core/commands.js');
    const core = window.ospeli.core;
    const coo = { type: 'human', role: 'coo' };
    const board = await runCommand(core, 'ospeli_beds_board', {}, coo);
    const wards = board.wards.map((w) => w.id);
    await runCommand(core, 'ospeli_agents_set_access', { allowed: true, wards: Object.fromEntries(wards.map((id) => [id, true])) }, coo);
    await runCommand(core, 'ospeli_agents_add', { name: 'map-bot', role: 'ops-manager', wards, days: 30 }, coo);
    await runCommand(core, 'ospeli_agents_add', { name: 'ward-bot', role: 'ward-nurse', wards, days: 30 }, coo);
    const bot = { agent: 'map-bot', role: 'ops-manager' };
    const out = [];
    for (const n of [1, 2, 3]) out.push(await window.ospeli.run('ospeli_maps_create', { from: 'blank', title: `Clinic visit ${n}` }, bot));
    out.push(await window.ospeli.run('ospeli_maps_create', { from: 'discharge' }, bot));
    // The same request again is the proposal already waiting, not a new one.
    const again = await window.ospeli.run('ospeli_maps_create', { title: 'Clinic visit 2', from: 'blank' }, bot);
    const assets = await runCommand(core, 'ospeli_assets_list', {}, coo);
    // A fault this asset can have: one it cannot have is refused before it is queued (15 Nov).
    await window.ospeli.run('ospeli_workorders_report_fault', { assetId: assets.assets[0].id, fault: assets.assets[0].faults[0], priority: 'routine' }, { agent: 'ward-bot', role: 'ward-nurse' });
    await window.ospeli.run('ospeli_beds_mark_vacated', { bedId: board.beds.find((b) => b.state === 'occupied').id }, { agent: 'ward-bot', role: 'ward-nurse' });
    return { ids: out.map((o) => o.proposal.id), again: { id: again.proposal.id, existing: again.existing }, pending: (await core.proposals()).filter((p) => p.status === 'pending').length };
  });
  assert.equal(made.again.existing, true);
  assert.equal(made.again.id, made.ids[1]);
  assert.equal(made.pending, 6);
  const cardOn = async (route, n) => {
    await page.evaluate((r) => { location.hash = r; }, route);
    // The new page is in place (something only that page has), then its card.
    const own = { '#/process': '[data-test="walk-card"]', '#/engineering': '[data-test="wo-queue"]', '#/beds': '.bed' }[route];
    await page.waitForFunction(([want, sel]) => document.querySelector(`main ${sel}`)
      && [...document.querySelectorAll('main [data-test="proposals"] h2')].some((x) => x.textContent.trim() === `Suggested changes (${want})`), [n, own]);
    const more = page.locator('[data-test="proposals-more"]');
    if (await more.count()) await more.evaluate((b) => b.click());
    return page.evaluate(() => ({
      lines: [...document.querySelectorAll('[data-test="proposals"] .proposal-item b')].map((b) => b.textContent.trim()),
      reasons: [...new Set([...document.querySelectorAll('[data-test="proposals"] select')].map((s) => [...s.options].map((o) => o.value).join(' | ')))],
    }));
  };
  await page.selectOption('#role-select', 'ops-manager');
  const maps = await cardOn('#/process', 4);
  assert.deepEqual([...maps.lines].sort(), [
    'Start a blank map called "Clinic visit 1"', 'Start a blank map called "Clinic visit 2"', 'Start a blank map called "Clinic visit 3"',
    'Start a map from the example "Discharge home from a medical ward"',
  ]);
  assert.equal(new Set(maps.lines).size, maps.lines.length, 'every line is different');
  assert.deepEqual(maps.reasons, ['Not needed | Already done | Needs a conversation first | Other']);
  const faults = await cardOn('#/engineering', 1);
  assert.equal(faults.lines.length, 1);
  assert.deepEqual(faults.reasons, ['Not needed | Already done | Needs a conversation first | Other']);
  await page.selectOption('#role-select', 'ward-nurse');
  const beds = await cardOn('#/beds', 1);
  assert.deepEqual(beds.reasons, ['Not needed | Wrong bed or patient | Already done | Needs a conversation first | Other']);
  // Declining a map proposal with one of its own reasons works.
  await page.selectOption('#role-select', 'ops-manager');
  await cardOn('#/process', 4);
  await page.locator('[data-test="proposals"] [data-cmd="ospeli_proposals_decline"]').first().evaluate((b) => b.click());
  await page.waitForFunction(() => document.querySelectorAll('[data-test="proposals"] .proposal-item').length === 3);
  assert.deepEqual(errors, []);
  await context.close();
});
