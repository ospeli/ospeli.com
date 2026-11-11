// The Agents screen (issues #25, #20, #27; spec A9 first step), exactly as a visitor to the live
// app gets it: no test hook, so every change goes through the screen and window.ospeli.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, openPage } from './helpers.mjs';

let env;
before(async () => { env = await startApp(); });
after(async () => { await env.close(); });

const asAgent = (page, name, input, who) => page.evaluate(([n, i, w]) => window.ospeli.run(n, i, w).then((r) => ({ ok: true, wards: r.wards?.map((x) => x.id), status: r.status }), (e) => ({ ok: false, code: e.code, message: e.message })), [name, input, who]);
const helper = { agent: 'night-flow-helper', role: 'bed-manager' };

// Count taps (and one confirm) so the main tasks stay short.
function counter(page) {
  const c = { taps: 0, confirms: 0 };
  page.on('dialog', (d) => { c.confirms += 1; d.accept(); });
  c.tap = async (sel) => { c.taps += 1; await page.locator(sel).tap(); };
  return c;
}
async function openPhone(width = 360) {
  const context = await env.browser.newContext({ viewport: { width, height: 780 }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(`${env.appUrl}#/agents`);
  await page.waitForSelector('html[data-ready="true"]');
  await page.waitForSelector('[data-test="agents-dial"]');
  return { context, page, errors };
}

test('first-time user at 360 px: an operations manager turns agents on in 2 taps, and any role stops them in 1', async () => {
  const { context, page, errors } = await openPhone(360);
  const c = counter(page);
  // Default role (ward nurse): sees the state, cannot change it, and is told who can.
  assert.equal(await page.getAttribute('[data-test="agents-dial"]', 'data-dial-now'), 'off');
  assert.equal(await page.isDisabled('[data-dial="advise"]'), true);
  assert.match(await page.textContent('[data-test="agents-readonly"]'), /Only the Ops manager or COO can change these settings/);
  assert.equal(await page.locator('[data-test="agents-stop"]').count(), 0, 'nothing to stop while off');

  await page.selectOption('#role-select', 'ops-manager');
  await page.waitForSelector('[data-dial="advise"]:not([disabled])');
  // Main task for the operations lead: turn agents on. One tap and one confirm.
  await c.tap('[data-dial="advise"]');
  await page.waitForSelector('[data-test="agents-dial"][data-dial-now="advise"]');
  assert.deepEqual([c.taps, c.confirms], [1, 1]);
  assert.match(await page.textContent('[data-test="agents-status"]'), /Agents are on: Advise/);

  // Still refused: on the dial is not enough, the agent must be on the list.
  const r1 = await asAgent(page, 'beds.board', {}, helper);
  assert.deepEqual([r1.ok, r1.code], [false, 'forbidden']);
  assert.match(r1.message, /not on this site's list/);

  // Switch one ward on, add the agent: name, role, ward, save.
  // Nothing is on yet, so the ward list is already open: the next step is in view.
  assert.equal(await page.locator('[data-test="agents-wards"]').getAttribute('open') !== null, true);
  await c.tap('[data-ward="ward-a1"]');
  await page.waitForSelector('[data-ward="ward-a1"][aria-pressed="true"]');
  assert.match(await page.textContent('[data-test="agents-wards"] summary'), /1 of 6 wards on/);
  await c.tap('[data-test="agents-add"]');
  // Errors appear under the Name field, in view, in plain words.
  const errInView = () => page.evaluate(() => { const r = document.querySelector('.ag-err').getBoundingClientRect(); return r.height > 0 && r.top >= 0 && r.bottom <= innerHeight; });
  await c.tap('[data-cmd="agent.add"]');
  await page.waitForFunction(() => /Give the agent a name/.test(document.querySelector('.ag-err')?.textContent || ''));
  assert.equal(await errInView(), true, 'the empty-name error is visible');
  await page.fill('#ag-name', 'Bed helper!');
  await c.tap('[data-cmd="agent.add"]');
  await page.waitForFunction(() => /Use 2 to 41 letters/.test(document.querySelector('.ag-err')?.textContent || ''));
  await page.fill('#ag-name', 'Dr Sarah Jones');
  await c.tap('[data-cmd="agent.add"]');
  await page.waitForFunction(() => /person's name/.test(document.querySelector('.ag-err')?.textContent || ''));
  assert.equal(await errInView(), true);
  await page.fill('#ag-name', 'night-flow-helper');
  await page.selectOption('#ag-role', 'bed-manager');
  await c.tap('.ag-tick input[value="ward-a1"]');
  await c.tap('[data-cmd="agent.add"]');
  await page.waitForSelector('[data-agent="night-flow-helper"]');
  assert.ok(c.taps <= 9, `setting up one agent, with three mistakes on the way, took ${c.taps} taps`);
  // The same name again is refused in words instead of silently replacing the entry.
  await c.tap('[data-test="agents-add"]');
  await page.fill('#ag-name', 'Night-Flow-Helper');
  await c.tap('[data-cmd="agent.add"]');
  await page.waitForFunction(() => /already on the list/.test(document.querySelector('.ag-err')?.textContent || ''));
  await page.locator('.ag-dialog button:has-text("Cancel")').tap();
  assert.match(await page.textContent('[data-agent="night-flow-helper"]'), /Works for Bed manager · Ward A1 \(acute medicine\) · ends .*Not used in the last 7 days/s);
  assert.match(await page.textContent('[data-test="agents-strangers"]'), /Not on the list.*1 refused/s, 'the call made before it was listed is counted, without a name');

  // The agent journey the issue could not complete: a read works, scoped to its ward and role.
  const r2 = await asAgent(page, 'beds.board', {}, helper);
  assert.deepEqual([r2.ok, r2.wards], [true, ['ward-a1']]);
  assert.equal((await asAgent(page, 'beds.board', {}, { agent: 'night-flow-helper', role: 'coo' })).code, 'forbidden', 'cannot claim another role');
  assert.equal((await asAgent(page, 'beds.board', { wardId: 'ward-b1' }, helper)).code, 'agents-off', 'a ward that is off stays off');
  assert.equal((await asAgent(page, 'agent.add', { name: 'self-made', role: 'coo', days: 90 }, helper)).code, 'agents-off', 'an agent cannot add agents');
  assert.equal((await asAgent(page, 'beds.board', {}, { agent: 'stranger', role: 'coo' })).code, 'forbidden');

  // Controls are at least 44 px tall and nothing runs off the side of a 360 px phone.
  const small = await page.evaluate(() => [...document.querySelectorAll('.page button, .page a.btn, main button, main summary')]
    .filter((b) => b.offsetParent !== null).map((b) => ({ t: b.textContent.trim().slice(0, 30), h: Math.round(b.getBoundingClientRect().height) })).filter((b) => b.h < 44));
  assert.deepEqual(small, []);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
  const tiny = await page.evaluate(() => [...document.querySelectorAll('main *')].filter((n) => n.offsetParent !== null && [...n.childNodes].some((k) => k.nodeType === 3 && k.textContent.trim()))
    .map((n) => ({ t: n.textContent.trim().slice(0, 30), px: parseFloat(getComputedStyle(n).fontSize) })).filter((n) => n.px < 15 && !/^(You set the dial|Now|Ended)$/.test(n.t)));
  assert.deepEqual(tiny, []);

  // Any other member of staff: stop everything in one tap.
  await page.selectOption('#role-select', 'ward-nurse');
  await page.waitForSelector('[data-test="agents-readonly"]');
  assert.equal(await page.isDisabled('[data-ward="ward-a1"]').catch(() => true), true);
  const before = c.taps;
  await c.tap('[data-test="agents-stop"]');
  await page.waitForSelector('[data-test="agents-stopped"]');
  assert.equal(c.taps - before, 1);
  assert.match(await page.textContent('[data-test="agents-stopped"]'), /All agents stopped by Ward nurse/);
  assert.equal(await page.getAttribute('[data-test="agents-dial"]', 'data-dial-now'), 'off');
  assert.equal((await asAgent(page, 'beds.board', {}, helper)).code, 'agents-off');
  assert.equal(await page.isDisabled('[data-dial="advise"]'), true, 'a ward nurse cannot start agents again');

  // Stop cleared every ward: turning the dial back on does not quietly reopen ward A1.
  await page.selectOption('#role-select', 'coo');
  await page.waitForSelector('[data-dial="advise"]:not([disabled])');
  await c.tap('[data-dial="advise"]');
  await page.waitForSelector('[data-test="agents-wards"]');
  assert.match(await page.textContent('[data-test="agents-wards"] summary'), /0 of 6 wards on/);
  assert.match(await page.textContent('[data-agent="night-flow-helper"]'), /Ward A1 \(acute medicine\) \(ward off\)/);
  assert.equal((await asAgent(page, 'beds.board', { wardId: 'ward-a1' }, helper)).code, 'agents-off');

  // The trail: every change by a person, every agent call (allowed or refused) by an agent.
  await page.goto(`${env.appUrl}#/data`);
  await page.waitForSelector('[data-test="audit-status"]');
  await page.waitForFunction(() => /^Intact/.test(document.querySelector('[data-test="audit-status"]').textContent));
  await page.selectOption('[data-test="audit-actor"]', 'agent');
  const rows = await page.$$eval('tbody tr', (trs) => trs.map((tr) => tr.children[3].textContent));
  // 7 calls were refused. Two repeats came within a minute of the same refusal (a second call from
  // a name not on the list, a second "ward is off"), so they are counted on the screen instead of
  // written as new entries (#27): 5 entries.
  assert.equal(rows.filter((r) => r.startsWith('agent.refused')).length, 5, rows.join(' | '));
  assert.equal(rows.filter((r) => r.startsWith('agent.read')).length, 1);
  await page.selectOption('[data-test="audit-actor"]', 'human');
  const people = (await page.$$eval('tbody tr', (trs) => trs.map((tr) => tr.children[3].textContent))).join(' | ');
  for (const a of ['agents.access-changed', 'agents.agent-added', 'agents.stopped']) assert.ok(people.includes(a), `${a} in: ${people}`);
  assert.deepEqual(errors, []);
  await context.close();
});

test('remove an agent: it is refused at once, shows under "Refused", and the list survives a reload; works offline', async () => {
  const { context, page, errors } = await openPage(env, { width: 1280, path: '#/agents', testHook: false });
  page.on('dialog', (d) => d.accept());
  await page.selectOption('#role-select', 'coo');
  await page.waitForSelector('[data-dial="advise"]:not([disabled])');
  await page.click('[data-dial="advise"]');
  await page.click('[data-test="agents-add"]');
  await page.fill('#ag-name', 'map-reader');
  await page.selectOption('#ag-role', 'ops-manager');
  await page.selectOption('#ag-days', '7');
  await page.click('[data-cmd="agent.add"]');
  await page.waitForSelector('[data-agent="map-reader"]');
  const who = { agent: 'map-reader', role: 'ops-manager' };
  assert.equal((await asAgent(page, 'maps.list', {}, who)).ok, true, 'an agent with no wards can still read process maps');

  // Offline: the service worker has the screen, and the settings are on the device.
  await page.evaluate(() => navigator.serviceWorker.ready);
  await context.setOffline(true);
  await page.reload();
  await page.waitForSelector('[data-agent="map-reader"]');
  assert.match(await page.textContent('[data-agent="map-reader"]'), /Last active (just now|.* ago): 1 read, 0 suggestions, 0 refused/);
  await page.click('[data-agent="map-reader"] [data-cmd="agent.remove"]');
  await page.waitForFunction(() => !document.querySelector('[data-agent="map-reader"]'));
  const r = await asAgent(page, 'maps.list', {}, who);
  assert.deepEqual([r.ok, r.code], [false, 'forbidden']);
  await page.reload();
  await page.waitForSelector('[data-test="agents-strangers"]');
  assert.match(await page.textContent('[data-test="agents-strangers"]'), /Not on the list.*1 refused/s);
  assert.equal((await page.textContent('[data-test="agents-strangers"]')).includes('map-reader'), false);
  assert.match(await page.textContent('[data-test="agents"]'), /named, not verified/);
  await context.setOffline(false);
  assert.deepEqual(errors, []);
  await context.close();
});
