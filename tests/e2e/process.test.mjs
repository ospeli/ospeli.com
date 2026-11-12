// Process maps in the app (backlog PM1): start from an example, try a guide suggestion in
// Proposed only, edit steps, switch the guide off, and agents only propose. Phone and desktop.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, openPage } from './helpers.mjs';

let env;
before(async () => { env = await startApp(); });
after(async () => { await env.close(); });

const CLOCK = '2026-11-10T10:00:00Z';
const noSideways = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const statText = (page) => page.locator('[data-test="pm-stats"] .pm-stat b').first().textContent();

for (const width of [390, 1280]) {
  test(`map an example, try a suggestion in Proposed, Today stays the same (${width}px)`, async () => {
    const { context, page, errors } = await openPage(env, { width, path: '#/process', clock: CLOCK });
    await page.waitForSelector('[data-test="map-chooser"]');
    assert.match(await page.textContent('[data-test="map-chooser"]'), /No maps yet/);
    assert.doesNotMatch(await page.textContent('[data-test="process-body"]'), /null|undefined/);
    assert.equal(await page.getAttribute('[data-test="guide-switch"]', 'aria-pressed'), 'true');
    await page.click('[data-from="discharge"]');
    await page.waitForSelector('[data-test="pm-stats"]');
    assert.match(page.url(), /#\/process\/map-001$/);
    const today = await statText(page);
    assert.equal(await page.locator('[data-test="bar-proposed"]').count(), 0, 'one bar until Proposed differs');
    // The answer comes first on a phone: the guide sits above the steps.
    const order = await page.evaluate(() => {
      const y = (sel) => document.querySelector(sel).getBoundingClientRect().top;
      return { guide: y('[data-test="guide"]'), steps: y('.steps-box') };
    });
    if (width < 641) assert.ok(order.guide < order.steps, 'guide before steps on a phone');

    await page.click('[data-cmd="ospeli_maps_try_suggestion"] >> nth=0');
    await page.waitForSelector('[data-test="bar-proposed"]');
    assert.match(await page.textContent('[data-test="map-title"]'), /Proposed/);
    assert.match(await page.textContent('[data-test="whatif-note"]'), /not a prediction/);
    assert.match(await page.textContent('.bars'), /Proposed [0-9 hmin]+ · [0-9 hmin]+ shorter/);
    assert.match(await page.textContent('[data-test="process-body"]'), /Changed in Proposed: wait /);
    const proposed = await statText(page);
    assert.notEqual(proposed, today, 'Proposed is shorter');
    await page.click('[data-test="v-today"]');
    await page.waitForFunction(() => /Today/.test(document.querySelector('[data-test="map-title"]').textContent));
    assert.equal(await statText(page), today, 'Today has not changed');

    // The page shows what the command layer says.
    const viaCommand = await page.evaluate(async () => {
      const { runCommand } = await import('./core/commands.js');
      return runCommand(window.ospeli.core, 'ospeli_maps_get', { mapId: 'map-001', format: 'short' }, { type: 'human', role: 'ops-manager' });
    });
    assert.equal(viaCommand.changed, true);
    assert.ok(viaCommand.proposed.stats.elapsed < viaCommand.today.stats.elapsed);
    assert.ok(await noSideways(page) <= 0, 'no sideways scroll');
    assert.deepEqual(errors, []);
    await context.close();
  });
}

test('add, change and remove a step; the numbers follow (390px)', async () => {
  const { context, page, errors } = await openPage(env, { width: 390, path: '#/process', clock: CLOCK });
  await page.waitForSelector('[data-test="map-chooser"]');
  await page.click('[data-from="blank"]');
  await page.waitForSelector('[data-test="steps-empty"]');
  assert.match(await page.textContent('[data-test="steps-empty"]'), /Add the first step/);
  await page.fill('#st-name', 'Patient checks in');
  await page.fill('#st-role', 'Reception');
  await page.fill('#st-work', '5');
  await page.click('[data-cmd="ospeli_maps_step_add"]');
  await page.waitForSelector('[data-test="step-list"] li');
  await page.fill('#st-name', 'Seen by a nurse');
  await page.fill('#st-role', 'Nurse');
  await page.fill('#st-wait', '20');
  await page.fill('#st-work', '10');
  await page.click('[data-cmd="ospeli_maps_step_add"]');
  await page.waitForFunction(() => document.querySelectorAll('[data-test="step-list"] li').length === 2);
  assert.equal(await statText(page), '35 min');
  // Personal details are refused with a reason.
  await page.fill('#st-name', 'Call 0700 123 4567');
  await page.fill('#st-role', 'Nurse');
  await page.click('[data-cmd="ospeli_maps_step_add"]');
  await page.waitForFunction(() => /personal details/.test(document.getElementById('toast').textContent));
  assert.equal(await page.locator('[data-test="step-list"] li').count(), 2);
  // Change the second step, then remove it.
  await page.click('[aria-label="Change step 2"]');
  await page.waitForFunction(() => document.getElementById('st-h')?.textContent === 'Change step 2');
  await page.fill('#st-wait', '0');
  await page.click('[data-cmd="ospeli_maps_step_update"]');
  await page.waitForFunction(() => document.querySelector('[data-test="pm-stats"] .pm-stat b').textContent === '15 min');
  await page.click('[aria-label="Change step 2"]');
  await page.waitForFunction(() => document.getElementById('st-h')?.textContent === 'Change step 2');
  await page.click('[data-cmd="ospeli_maps_step_remove"]');
  await page.waitForFunction(() => document.querySelectorAll('[data-test="step-list"] li').length === 1);
  assert.ok(await noSideways(page) <= 0);
  assert.deepEqual(errors, []);
  await context.close();
});

test('the guide switches off and the map still works; the choice is audited', async () => {
  const { context, page, errors } = await openPage(env, { width: 1280, path: '#/process', clock: CLOCK });
  await page.waitForSelector('[data-test="map-chooser"]');
  await page.click('[data-from="fault"]');
  await page.waitForSelector('[data-test="guide"] .sg');
  await page.click('[data-test="guide-switch"]');
  await page.waitForFunction(() => document.querySelector('[data-test="guide-switch"]').getAttribute('aria-pressed') === 'false');
  assert.match(await page.textContent('[data-test="guide"]'), /The guide is off/);
  assert.equal(await page.locator('[data-test="guide"] .sg').count(), 0);
  assert.equal(await page.textContent('[data-test="guide-switch"]'), 'Guide: Off');
  await page.click('[data-test="view-list"]');
  await page.click('[aria-label="Move step 2 up"]');
  await page.waitForFunction(() => document.querySelector('[data-test="step-list"] li .what b').textContent === 'Fault phoned through to the helpdesk');
  const audit = await page.evaluate(async () => (await window.ospeli.core.auditLog()).map((a) => a.action));
  for (const a of ['map.created', 'map.guide-off', 'map.step-moved']) assert.ok(audit.includes(a), a);
  assert.deepEqual(errors, []);
  await context.close();
});

test('an agent only proposes a map change; a person accepts it on the page', async () => {
  const { context, page, errors } = await openPage(env, { width: 1280, path: '#/process', clock: CLOCK });
  await page.waitForSelector('[data-test="map-chooser"]');
  await page.click('[data-from="ed"]');
  await page.waitForSelector('[data-test="pm-stats"]');
  // People switch agent access on (people-only command, through the test hook's core).
  await page.evaluate(async () => {
    const { runCommand } = await import('./core/commands.js');
    await runCommand(window.ospeli.core, 'ospeli_agents_set_access', { allowed: true }, { type: 'human', role: 'ops-manager' });
    await runCommand(window.ospeli.core, 'ospeli_agents_add', { name: 'flow-helper', role: 'ops-manager', days: 30 }, { type: 'human', role: 'ops-manager' });
  });
  const p = await page.evaluate(() => window.ospeli.run('ospeli_maps_reset_proposed', { mapId: 'map-001' }, { agent: 'flow-helper', role: 'ops-manager' }));
  assert.equal(p.status, 'proposed');
  await page.reload();
  await page.waitForSelector('[data-test="proposals"] [data-cmd="ospeli_proposals_accept"]');
  assert.match(await page.textContent('[data-test="proposals"]'), /map-001: Reset Proposed/);
  await page.click('[data-test="proposals"] [data-cmd="ospeli_proposals_accept"]');
  await page.waitForFunction(() => !document.querySelector('[data-test="proposals"] [data-cmd="ospeli_proposals_accept"]'));
  const audit = await page.evaluate(async () => (await window.ospeli.core.auditLog()).map((a) => `${a.actorType}:${a.action}`));
  assert.ok(audit.includes('agent:agent.proposed'));
  assert.ok(audit.includes('human:map.proposed-reset'));
  assert.deepEqual(errors, []);
  await context.close();
});
