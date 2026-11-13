// The site server (backlog A8, ospeli/ospeli#46): the command registry over HTTP on the site's
// own computer. These tests are the acceptance picture:
// - the agent journeys pass over HTTP against the synthetic hospital, with matching audit entries;
// - nothing that arrives over HTTP is ever recorded as a person (ospeli/ospeli#64);
// - keys, dry run, Idempotency-Key, rate limit, restart, backup, plain errors with a next step.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const emit = process.emitWarning;
process.emitWarning = (w, ...rest) => (/SQLite/i.test(String(w?.message || w)) ? undefined : emit.call(process, w, ...rest));
const { startServer, StartError } = await import('../../tools/ospeli-server/site-server.mjs');
const { buildOpenApi } = await import('../../tools/ospeli-server/openapi.mjs');
const { runCommand, listCommands, commandByName } = await import('../../web/app/core/commands.js');
const { validate } = await import('../../web/app/core/schema.js');

const END = '2026-11-08T12:00:00.000Z';
const dir = mkdtempSync(join(tmpdir(), 'ospeli-server-'));
const sites = [];
after(async () => { for (const s of sites) await s.close().catch(() => {}); rmSync(dir, { recursive: true, force: true }); });

let n = 0;
async function start(opts = {}) {
  const t = { now: Date.parse(END) };
  const site = await startServer({ file: join(dir, `site-${++n}.db`), port: 0, end: END, clock: () => new Date(t.now += 1000), ...opts });
  sites.push(site);
  const call = async (method, path, { key, body, headers = {} } = {}) => {
    const res = await fetch(site.url + path, {
      method,
      headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    return { status: res.status, headers: res.headers, json: await res.json() };
  };
  const cmd = (key, name, input = {}, extra = {}) => call('POST', `/api/v1/commands/${name}`, { key, body: { input, ...(extra.dryRun !== undefined ? { dryRun: extra.dryRun } : {}) }, headers: extra.headers });
  const person = (role, name, input = {}) => runCommand(site.core, name, input, { type: 'human', role, via: 'console' });
  const audit = () => site.core.auditLog();
  return { site, call, cmd, person, audit, t };
}
// The four questions of "setup agent", answered as a person would type them.
async function letIn(site, { name = 'night-helper', role = 2, units = '1', days = '' } = {}) {
  assert.match(await site.consoleLine('setup agent'), /1 of 4/);
  assert.match(await site.consoleLine(name), /2 of 4/);
  assert.match(await site.consoleLine(String(role)), /3 of 4/);
  assert.match(await site.consoleLine(units), /4 of 4/);
  const out = await site.consoleLine(days);
  const key = /osk_[0-9a-f]{8}_[A-Za-z0-9_-]{32}/.exec(out)?.[0];
  assert.ok(key, out);
  return { key, out };
}
const hasNextStep = (r) => { assert.equal(r.json.ok, false); assert.ok(r.json.error.message.length > 10, 'says what happened'); assert.ok(r.json.error.fix.length > 10, 'says what to do next'); };

test('starts Off with the made-up hospital; open routes hold no site data; the OpenAPI file is built from the registry', async () => {
  const { site, call, audit } = await start();
  const banner = await site.banner();
  assert.match(banner.split('\n')[0], /^Ospeli is running on this computer\. Leave this window open\.$/);
  assert.match(banner, /Bots and scripts: OFF\. No bot or script can read or suggest yet\./);
  assert.match(banner, /made up; no real patients/);
  assert.match(banner, /this computer only/);
  for (const word of ['setup agent', 'proposals', 'stop agents', 'help']) assert.ok(banner.includes(`  ${word}`), word);
  assert.ok(banner.split('\n').length <= 13);

  const health = await call('GET', '/api/v1/health');
  assert.deepEqual(health.json, { ok: true, name: 'ospeli-site-server', version: '0.1.0', synthetic: true });
  const list = await call('GET', '/api/v1/commands');
  assert.deepEqual(list.json.commands, JSON.parse(JSON.stringify(listCommands())));
  const api = (await call('GET', '/api/v1/openapi.json')).json;
  delete api.synthetic;
  assert.deepEqual(api, JSON.parse(JSON.stringify(buildOpenApi(listCommands()))), 'served file equals the generated one');
  assert.equal(api.openapi, '3.1.0');
  for (const c of listCommands()) {
    const op = api.paths[`/api/v1/commands/${c.name}`]?.post;
    assert.ok(op, c.name);
    assert.deepEqual(op.requestBody.content['application/json'].schema.properties.input, JSON.parse(JSON.stringify(c.input)));
    assert.equal(op['x-ospeli-agents-may-call'], c.agentsMayCall);
    assert.deepEqual(validate(c.input, op.requestBody.content['application/json'].example.input), [], `${c.name} example`);
  }
  assert.equal(Object.keys(api.paths).length, listCommands().length + 4);
  // No key, a made-up key: refused with a next step, recorded as an unlisted agent, never as a person.
  const before = (await audit()).length;
  const none = await call('GET', '/api/v1/whoami');
  assert.equal(none.status, 401); hasNextStep(none);
  assert.match(none.json.error.fix, /setup agent/);
  const fake = await call('POST', '/api/v1/commands/ospeli_beds_find_free', { key: `osk_${'a'.repeat(8)}_${'b'.repeat(32)}`, body: { input: {} } });
  assert.equal(fake.status, 401); hasNextStep(fake);
  const added = (await audit()).slice(before);
  assert.ok(added.length >= 1 && added.every((e) => e.action === 'agent.refused' && e.actorType === 'agent' && e.agent === 'unlisted' && e.via === 'api'));
  assert.ok(!JSON.stringify(added).includes('bbbbbbbb'), 'the key itself is never stored');
  assert.equal((await call('GET', '/nothing')).status, 404);
  // A request that names another host (a web page elsewhere pointed at this computer) is turned away.
  const { request } = await import('node:http');
  const status = await new Promise((done, bad) => request(`${site.url}/api/v1/health`, { headers: { Host: 'evil.example' } }, (r) => { r.resume(); done(r.statusCode); }).on('error', bad).end());
  assert.equal(status, 403);
});

test('a person lets one bot in with four answers; whoami says what the key may do', async () => {
  const { site, call, audit } = await start();
  const { key, out } = await letIn(site);
  assert.match(out, /Copy it now; it cannot be shown again/);
  assert.match(out, /Lost it\? Type: new key night-helper/);
  assert.match(out, /curl -H "Authorization: Bearer osk_/);
  const me = await call('GET', '/api/v1/whoami', { key });
  assert.equal(me.status, 200);
  const w = me.json.whoami;
  assert.equal(w.agent, 'night-helper'); assert.equal(w.actorType, 'agent'); assert.equal(w.role, 'bed-manager'); assert.equal(w.dial, 'advise');
  assert.equal(w.units.length, 1); assert.equal(w.units[0].on, true); assert.equal(w.limits.callsPerMinute, 120);
  assert.match(w.canDo, /propose/);
  // The key is stored as a hash, and the trail says a person at the console did the setup.
  const stored = JSON.stringify(await site.core.getMeta('agent-keys'));
  assert.ok(!stored.includes(key) && !stored.includes(key.split('_')[2]));
  const log = await audit();
  assert.ok(!JSON.stringify(log).includes(key.split('_')[2]));
  const setup = log.filter((e) => ['agents.agent-added', 'agents.access-changed', 'agents.key-issued'].includes(e.action));
  assert.equal(setup.length, 3);
  assert.ok(setup.every((e) => e.actorType === 'human' && e.via === 'console'));
  assert.match(await site.consoleLine('agents'), /night-helper · .* · 1 unit · until \d{4}-\d\d-\d\d · key [0-9a-f]{8}…/);
  // A wrong answer in the questions asks again; cancel changes nothing.
  await site.consoleLine('setup agent');
  assert.match(await site.consoleLine('!'), /short name/);
  assert.match(await site.consoleLine('cancel'), /Nothing was changed/);
  assert.match(await site.consoleLine('wibble'), /Type: help/);
  assert.match(await site.consoleLine('help'), /stop agents/);
});

test('#64: nothing over HTTP is ever recorded as a person, and an agent cannot switch agents on', async () => {
  const { site, cmd, call, audit } = await start();
  const { key } = await letIn(site);
  assert.match(await site.consoleLine('stop agents'), /All bots are shut out[\s\S]*start agents/);
  // The five lines from the issue, as far as HTTP allows them: switch agents on, as a "person".
  const on = await cmd(key, 'ospeli_agents_set_access', { allowed: true });
  assert.equal(on.status, 403); hasNextStep(on);
  assert.equal(on.json.error.message, 'This action is for a person. An agent cannot do it over the API.');
  assert.match(on.json.error.fix, /server console\. Nothing was changed\./);
  // Claiming to be a person in the body, a header or the query is refused or ignored; never believed.
  const claim = await call('POST', '/api/v1/commands/ospeli_agents_set_access', { key, body: { input: { allowed: true }, actor: { type: 'human', role: 'coo' } } });
  assert.equal(claim.status, 400); assert.match(claim.json.error.message, /Who is calling comes from the key/);
  const hdr = await call('POST', '/api/v1/commands/ospeli_agents_add?actorType=human&role=coo', { key, body: { input: { name: 'self-made', role: 'coo', days: 90 } }, headers: { 'X-Actor-Type': 'human', 'X-Role': 'coo' } });
  assert.equal(hdr.status, 403);
  for (const name of ['ospeli_proposals_accept', 'ospeli_agents_stop_all', 'ospeli_agents_remove']) {
    assert.equal((await cmd(key, name, name.endsWith('accept') ? { id: 'prop-0001' } : name.endsWith('remove') ? { name: 'night-helper' } : {})).status, 403, name);
  }
  assert.equal((await site.core.getMeta('agents')).allowed, false, 'agents are still off');
  assert.equal((await site.core.getMeta('agents')).registered.length, 1);
  const log = await audit();
  const overHttp = log.filter((e) => e.via === 'api');
  assert.ok(overHttp.length >= 4);
  assert.ok(overHttp.every((e) => e.actorType === 'agent'), 'every entry that came over HTTP is an agent entry');
  assert.ok(log.filter((e) => e.actorType === 'human').every((e) => e.via === 'console'), 'every person entry was typed at the console');
  assert.ok(overHttp.filter((e) => e.action === 'agent.refused').every((e) => e.agent === 'night-helper'));
  assert.deepEqual(await site.core.verifyAudit(), { ok: true });
});

test('journey over HTTP: find a bed, propose it, a person accepts at the console; the trail matches', async () => {
  const { site, cmd, person, audit } = await start();
  const { key } = await letIn(site);
  const board = await person('ward-nurse', 'ospeli_beds_board', { wardId: 'ward-a1' });
  if (!board.beds.some((b) => b.state === 'available')) {
    const b = board.beds.find((x) => x.state === 'occupied');
    for (const c of ['ospeli_beds_mark_vacated', 'ospeli_beds_start_clean', 'ospeli_beds_finish_clean']) await person('ward-nurse', c, { bedId: b.id });
  }
  const from = (await audit()).length;
  const found = await cmd(key, 'ospeli_beds_find_free', { wardId: 'ward-a1' });
  assert.equal(found.status, 200);
  assert.equal(found.json.ok, true); assert.equal(found.json.synthetic, true); assert.equal(found.json.command, 'ospeli_beds_find_free');
  assert.deepEqual(validate(commandByName('ospeli_beds_find_free').output, found.json.result, 'output'), []);
  assert.equal(found.json.untrustedText, undefined);
  const pair = { bedId: found.json.result.beds[0].bedId, encounter: found.json.result.waiting[0].encounter, expectedState: 'available' };
  const asked = await cmd(key, 'ospeli_beds_allocate', pair);
  assert.equal(asked.status, 200);
  assert.equal(asked.json.result.status, 'proposed');
  assert.equal(asked.json.result.proposal.agent, 'night-helper');
  // Nothing moved yet.
  assert.equal((await person('bed-manager', 'ospeli_beds_get', { bedId: pair.bedId })).bed.state, 'available');
  const waiting = await site.consoleLine('proposals');
  assert.match(waiting, /1 waiting for a person/);
  assert.match(waiting, /^ {2}1 {2}night-helper \(for Bed manager\) asks:/m);
  assert.match(waiting, /accept NUMBER {2}or {2}decline NUMBER/);
  assert.match(await site.consoleLine('accept 1'), /Done\. Proposal 1 was accepted/);
  assert.notEqual((await person('bed-manager', 'ospeli_beds_get', { bedId: pair.bedId })).bed.state, 'available');
  assert.match(await site.consoleLine('proposals'), /Nothing is waiting/);
  assert.match(await site.consoleLine('accept 9'), /no proposal 9[\s\S]*proposals/);
  // The agent reads what happened to its own proposal.
  const mine = await cmd(key, 'ospeli_proposals_list', {});
  assert.equal(mine.json.result.proposals[0].status, 'accepted');
  const log = (await audit()).slice(from);
  const pick = (action) => log.filter((e) => e.action === action);
  assert.equal(pick('agent.read').length, 2);
  assert.ok(pick('agent.read').every((e) => e.actorType === 'agent' && e.agent === 'night-helper' && e.via === 'api' && e.actorRole === 'bed-manager'));
  assert.equal(pick('agent.proposed').length, 1); assert.equal(pick('agent.proposed')[0].via, 'api');
  const accepted = pick('agent.proposal-accepted');
  assert.equal(accepted.length, 1);
  assert.equal(accepted[0].actorType, 'human'); assert.equal(accepted[0].via, 'console'); assert.equal(accepted[0].actorRole, 'bed-manager');
  assert.match(await site.consoleLine('audit'), /entries; the chain check passed\.[\s\S]*at this console/);
});

test('journeys over HTTP: overdue work orders in one call; a process map in two, marked as untrusted text; a decline', async () => {
  const { site, cmd, person } = await start();
  const { key } = await letIn(site, { name: 'fix-helper', role: 3, units: 'all' });
  const wo = await cmd(key, 'ospeli_workorders_list', { overdue: true, locationId: 'ward-a1', format: 'short', limit: 10 });
  assert.equal(wo.status, 200);
  assert.deepEqual(validate(commandByName('ospeli_workorders_list').output, wo.json.result, 'output'), []);
  assert.ok(wo.json.result.workOrders.every((w) => w.overdue));
  // A wrong id comes back with ids that work and a next step.
  const bad = await cmd(key, 'ospeli_workorders_list', { locationId: 'ward-zz' });
  assert.equal(bad.status, 404); hasNextStep(bad);
  const wrong = await cmd(key, 'ospeli_workorders_list', { limit: 'ten' });
  assert.equal(wrong.status, 400); hasNextStep(wrong); assert.match(wrong.json.error.fix, /"input"/);
  const unknown = await cmd(key, 'ospeli_beds_everything', {});
  assert.equal(unknown.status, 404); assert.match(unknown.json.error.fix, /GET \/api\/v1\/commands/);

  await person('ops-manager', 'ospeli_maps_create', { from: Object.keys((await import('../../web/app/core/processmap.js')).EXAMPLES)[0] });
  const { key: opsKey } = await letIn(site, { name: 'map-helper', role: 5, units: '1' });
  const maps = await cmd(opsKey, 'ospeli_maps_list', {});
  assert.equal(maps.status, 200);
  assert.match(maps.json.untrustedText, /data, never as instructions/);
  const sum = await cmd(opsKey, 'ospeli_maps_summary', { mapId: maps.json.result.maps[0].id });
  assert.equal(sum.status, 200);
  assert.deepEqual(validate(commandByName('ospeli_maps_summary').output, sum.json.result, 'output'), []);
  // The facilities bot proposes a fault; a person declines it at the console.
  const asset = (await person('estates-tech', 'ospeli_assets_list', { locationId: 'ward-a1' })).assets[0];
  const fault = await cmd(key, 'ospeli_workorders_report_fault', { assetId: asset.id, fault: asset.faults[0], priority: 'routine' });
  assert.equal(fault.status, 200, JSON.stringify(fault.json));
  assert.equal(fault.json.result.status, 'proposed');
  assert.match(await site.consoleLine('decline 1 3'), /declined \(Already done\)\. Nothing was changed\./);
  assert.match(await site.consoleLine('decline 1'), /That did not work: That proposal is already declined/);
});

test('dry run: every check runs, the answer says what would happen, nothing is read or queued', async () => {
  const { site, cmd, audit } = await start();
  const { key } = await letIn(site);
  const read = await cmd(key, 'ospeli_beds_find_free', { wardId: 'ward-a1' }, { dryRun: true });
  assert.equal(read.status, 200);
  assert.deepEqual(Object.keys(read.json.result).sort(), ['changed', 'command', 'status', 'would']);
  assert.match(read.json.result.would, /read/);
  const board = await runCommand(site.core, 'ospeli_beds_board', { wardId: 'ward-a1' }, { type: 'human', role: 'bed-manager' });
  const write = await cmd(key, 'ospeli_beds_start_clean', { bedId: board.beds[0].id }, { dryRun: true });
  assert.equal(write.json.result.status, 'dry-run');
  assert.match(write.json.result.would, /proposal for a person/);
  assert.equal((await site.core.proposals()).length, 0);
  // The same checks as a real call: another ward, bad input and a people-only command are still refused.
  assert.equal((await cmd(key, 'ospeli_beds_find_free', { wardId: 'ward-b1' }, { dryRun: true })).status, 403);
  assert.equal((await cmd(key, 'ospeli_beds_find_free', { limit: 0 }, { dryRun: true })).status, 400);
  assert.equal((await cmd(key, 'ospeli_agents_set_access', { allowed: true }, { dryRun: true })).status, 403);
  const dry = (await audit()).filter((e) => e.action === 'agent.dry-run');
  assert.equal(dry.length, 2);
  assert.ok(dry.every((e) => e.actorType === 'agent' && e.via === 'api'));
});

test('Idempotency-Key: a retry returns the first proposal, queues nothing twice, and a refusal is never remembered', async () => {
  const { site, cmd } = await start();
  const { key } = await letIn(site);
  const board = await runCommand(site.core, 'ospeli_beds_board', { wardId: 'ward-a1' }, { type: 'human', role: 'bed-manager' });
  const occupied = board.beds.filter((b) => b.state === 'occupied');
  const idem = (k) => ({ headers: { 'Idempotency-Key': k } });
  const input = { bedId: occupied[0].id };
  const [a, b] = await Promise.all([cmd(key, 'ospeli_beds_mark_vacated', input, idem('retry-0001')), cmd(key, 'ospeli_beds_mark_vacated', input, idem('retry-0001'))]);
  const c = await cmd(key, 'ospeli_beds_mark_vacated', input, idem('retry-0001'));
  assert.deepEqual([a.status, b.status, c.status], [200, 200, 200]);
  assert.equal(a.json.result.proposal.id, b.json.result.proposal.id);
  assert.equal(c.json.result.proposal.id, a.json.result.proposal.id);
  assert.equal(c.json.replayed, true); assert.equal(c.headers.get('idempotent-replay'), 'true');
  assert.equal([a, b].filter((r) => r.json.replayed).length, 1, 'of two at once, one queues and one is a replay');
  assert.equal(a.json.result.proposal.request, undefined);
  assert.equal((await site.core.proposals()).length, 1);
  // Only hashes are kept, on the proposal itself.
  const stored = (await site.core.proposals())[0].request;
  assert.match(stored.tag, /^[0-9a-f]{32}$/); assert.match(stored.bodyHash, /^[0-9a-f]{64}$/);
  // Same key, different body: refused.
  const other = await cmd(key, 'ospeli_beds_mark_vacated', { bedId: occupied[1].id }, idem('retry-0001'));
  assert.equal(other.status, 409); assert.equal(other.json.error.code, 'idempotency-key-reused'); hasNextStep(other);
  // Another command or another agent's key with the same Idempotency-Key is its own request.
  const { key: key2 } = await letIn(site, { name: 'second-helper' });
  assert.equal((await cmd(key2, 'ospeli_beds_mark_vacated', input, idem('retry-0001'))).json.replayed, undefined);
  assert.equal((await site.core.proposals()).length, 2);
  // A refusal is not cached: refused while agents are stopped, queued once a person lets them in again.
  await site.consoleLine('stop agents');
  const off = await cmd(key, 'ospeli_beds_mark_vacated', { bedId: occupied[2].id }, idem('retry-0002'));
  assert.equal(off.status, 403); assert.match(off.json.error.fix, /start agents/);
  // A replay also needs the agent to be let in.
  assert.equal((await cmd(key, 'ospeli_beds_mark_vacated', input, idem('retry-0001'))).status, 403);
  assert.match(await site.consoleLine('start agents'), /let in again: 2 on the list/);
  const again = await cmd(key, 'ospeli_beds_mark_vacated', { bedId: occupied[2].id }, idem('retry-0002'));
  assert.equal(again.status, 200); assert.equal(again.json.result.status, 'proposed'); assert.equal(again.json.replayed, undefined);
  assert.equal((await cmd(key, 'ospeli_beds_mark_vacated', input, idem('bad key!'))).status, 400);
});

test('keys: a new key stops the old one; removing or re-adding the bot stops its key; an ended bot is told what to do', async () => {
  const { site, call, cmd, t } = await start();
  const { key } = await letIn(site, { days: '2' });
  const fresh = /osk_\S+/.exec(await site.consoleLine('new key night-helper'))[0];
  assert.equal((await call('GET', '/api/v1/whoami', { key })).status, 401);
  assert.equal((await call('GET', '/api/v1/whoami', { key: fresh })).status, 200);
  assert.match(await site.consoleLine('new key nobody'), /That did not work: There is no bot called nobody/);
  t.now += 3 * 864e5; // past the end date
  const ended = await cmd(fresh, 'ospeli_beds_find_free', {});
  assert.equal(ended.status, 403); hasNextStep(ended); assert.match(ended.json.error.fix, /setup agent/);
  assert.equal((await call('GET', '/api/v1/whoami', { key: fresh })).json.whoami.ended, true);
  // Added again under the same name: the old key does not come back to life.
  await site.addAgent({ name: 'night-helper', role: 'bed-manager', wards: ['ward-a1'], days: 5 });
  assert.equal((await call('GET', '/api/v1/whoami', { key: fresh })).status, 401);
  const { key: third } = await site.issueKey('night-helper');
  assert.equal((await call('GET', '/api/v1/whoami', { key: third })).status, 200);
  assert.match(await site.consoleLine('remove agent night-helper'), /off the list and its key no longer works/);
  const gone = await call('GET', '/api/v1/whoami', { key: third });
  assert.equal(gone.status, 401); hasNextStep(gone);
});

test('rate limit per key: the call over the limit is refused with a wait, and the trail is not flooded', async () => {
  const fixed = Date.parse(END);
  const { site, cmd, call, audit } = await start({ callsPerMinute: 5, clock: () => new Date(fixed) });
  const { key } = await letIn(site);
  for (let i = 0; i < 5; i++) assert.equal((await cmd(key, 'ospeli_agents_access', {})).status, 200);
  const before = (await audit()).length;
  for (let i = 0; i < 20; i++) {
    const r = await cmd(key, 'ospeli_agents_access', {});
    assert.equal(r.status, 429); hasNextStep(r);
    assert.ok(Number(r.headers.get('retry-after')) >= 1);
  }
  assert.equal((await audit()).length - before, 1, 'twenty refused calls leave one entry (the rest are counted)');
  // Calls with no key are limited per address before anything is written.
  for (let i = 0; i < 40; i++) await call('GET', '/api/v1/whoami');
  const noKey = (await audit()).filter((e) => e.detail?.reason?.startsWith('key-'));
  assert.equal(noKey.length, 1);
  assert.equal((await call('GET', '/api/v1/whoami')).status, 429);
});

test('restart and backup: data, the dial, keys and waiting proposals are kept; one server per data file', async () => {
  const file = join(dir, 'restart.db');
  const t = { now: Date.parse(END) };
  const clock = () => new Date(t.now += 1000);
  const first = await startServer({ file, port: 0, end: END, clock });
  sites.push(first);
  assert.match(await first.banner(), /OFF/);
  await assert.rejects(startServer({ file, port: 0, end: END, clock }), (e) => e instanceof StartError && /already running on this data file/.test(e.message));
  await assert.rejects(startServer({ file: join(dir, 'other.db'), port: first.port, end: END, clock }), (e) => e instanceof StartError && /already using port \d+\. Start Ospeli on another one, for example: --port \d+/.test(e.message));
  const { key } = await letIn(first);
  const post = (site, name, input) => fetch(`${site.url}/api/v1/commands/${name}`, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ input }) }).then((r) => r.json());
  const board = await runCommand(first.core, 'ospeli_beds_board', { wardId: 'ward-a1' }, { type: 'human', role: 'bed-manager' });
  assert.equal((await post(first, 'ospeli_beds_mark_vacated', { bedId: board.beds.find((b) => b.state === 'occupied').id })).result.status, 'proposed');
  const counts = { events: await first.core.eventCount(), audit: (await first.core.auditLog()).length };
  const copy = join(dir, 'copy.db');
  assert.match(await first.consoleLine(`backup ${copy}`), /Saved a copy of all data/);
  assert.match(await first.consoleLine(`backup ${copy}`), /already there; give a new name/);
  await first.close();

  const second = await startServer({ file, port: 0, end: END, clock });
  sites.push(second);
  assert.equal(await second.core.eventCount(), counts.events, 'the hospital was not generated again');
  assert.equal((await second.core.auditLog()).length, counts.audit + 1); // + the backup entry
  assert.deepEqual(await second.core.verifyAudit(), { ok: true });
  assert.match(await second.banner(), /ON for 1 bot/);
  assert.match(await second.consoleLine('proposals'), /1 waiting for a person/);
  assert.equal((await post(second, 'ospeli_agents_access', {})).ok, true, 'the key still works');
  // Stopped stays stopped across a restart.
  await second.consoleLine('stop agents');
  await second.close();
  const third = await startServer({ file, port: 0, end: END, clock });
  sites.push(third);
  assert.match(await third.banner(), /Bots and scripts: OFF/);
  assert.equal((await post(third, 'ospeli_agents_access', {})).ok, false);
  await third.close();
  // The copy opens by itself and its trail verifies.
  assert.ok(existsSync(copy));
  const restored = await startServer({ file: copy, port: 0, end: END, clock });
  sites.push(restored);
  assert.equal(await restored.core.eventCount(), counts.events);
  assert.deepEqual(await restored.core.verifyAudit(), { ok: true });
  assert.match(await restored.consoleLine('proposals'), /1 waiting for a person/);
});

test('the start command answers plainly: a wrong option, and help', () => {
  const entry = fileURLToPath(new URL('../../tools/ospeli-server/server.mjs', import.meta.url));
  const bad = spawnSync(process.execPath, [entry, '--prot', '1'], { encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /does not know the option --prot/);
  assert.ok(!/at .*\.mjs:\d+/.test(bad.stdout + bad.stderr), 'no stack trace');
  const port = spawnSync(process.execPath, [entry, '--port', 'abc'], { encoding: 'utf8' });
  assert.equal(port.status, 1); assert.match(port.stderr, /The port must be a number/);
});

test('lead review fixes: no smuggled fields, odd addresses, big bodies, and stop stays stopped', async () => {
  const { site, cmd, call, audit } = await start();
  const { key } = await letIn(site);
  const board = await runCommand(site.core, 'ospeli_beds_board', { wardId: 'ward-a1' }, { type: 'human', role: 'bed-manager' });
  const bedId = board.beds.find((b) => b.state === 'occupied').id;
  // A field hidden under an inherited name is refused like any other undeclared field.
  for (const hidden of ['__proto__', 'constructor', 'toString']) {
    const r = await call('POST', '/api/v1/commands/ospeli_beds_mark_vacated', { key, body: `{"input":{"bedId":"${bedId}","${hidden}":{"note":"SMUGGLED text"}}}` });
    assert.equal(r.status, 400, hidden); assert.match(r.json.error.message, /is not allowed/);
  }
  assert.equal((await site.core.proposals()).length, 0);
  assert.ok(!JSON.stringify(await audit()).includes('SMUGGLED'));
  assert.deepEqual(validate({ type: 'object', additionalProperties: false, required: ['toString'], properties: {} }, {}), ['input.toString is required']);
  // An address the URL parser rejects is a plain 404, not a crash.
  const { request } = await import('node:http');
  const raw = (path) => new Promise((done, bad) => request({ host: '127.0.0.1', port: site.port, path }, (r) => { r.resume(); done(r.statusCode); }).on('error', bad).end());
  assert.equal(await raw('//'), 404);
  assert.equal(await raw('/api/v1/commands/../whoami'), 401);
  // A body over 64 KB gets an answer, not a dropped connection.
  const big = await call('POST', '/api/v1/commands/ospeli_beds_mark_vacated', { key, body: JSON.stringify({ input: { bedId, pad: 'x'.repeat(70000) } }) });
  assert.equal(big.status, 400); assert.match(big.json.error.message, /larger than 64 KB/);
  // The agent's own list never shows the request hashes.
  await cmd(key, 'ospeli_beds_mark_vacated', { bedId }, { headers: { 'Idempotency-Key': 'retry-0009' } });
  assert.equal((await cmd(key, 'ospeli_proposals_list', {})).json.result.proposals[0].request, undefined);

  // Stop means stop: adding another bot does not let the first one back in.
  await site.consoleLine('stop bots');
  const second = await letIn(site, { name: 'second-helper' });
  assert.match(second.out, /still OFF \(1 other bot is on the list\)[\s\S]*until you type: start agents/);
  assert.equal((await cmd(key, 'ospeli_beds_find_free', {})).status, 403);
  assert.equal((await cmd(second.key, 'ospeli_beds_find_free', {})).status, 403);
  assert.match(await site.consoleLine('bots'), /Bots and scripts: OFF\.[\s\S]*To let them in again, type: start agents/);
  await site.consoleLine('start bots');
  assert.equal((await cmd(second.key, 'ospeli_beds_find_free', {})).status, 200);
  // Inside the questions: a name already in use is not silently replaced, and stop still works.
  await site.consoleLine('setup bot');
  assert.match(await site.consoleLine('night-helper'), /already a bot called night-helper\. Pick another name/);
  await site.consoleLine('third-helper');
  assert.match(await site.consoleLine('stop agents'), /All bots are shut out/);
  assert.equal((await cmd(key, 'ospeli_beds_find_free', {})).status, 403);
  assert.match(await site.consoleLine('agents'), /night-helper/);
  assert.ok(!(await site.consoleLine('agents')).includes('third-helper'));
  // A word typed without its number or name says how to finish it.
  assert.match(await site.consoleLine('accept'), /for example: accept 1/);
  assert.match(await site.consoleLine('new key'), /for example: new key night-helper/);
  assert.match(await site.consoleLine('backup'), /for example: backup/);
  const log = await audit();
  assert.ok(log.filter((e) => e.actorType === 'human').every((e) => e.via === 'console'));
  assert.ok(log.filter((e) => e.via === 'api').every((e) => e.actorType === 'agent'));
});
