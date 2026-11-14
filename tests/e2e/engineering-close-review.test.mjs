// Code review, 14 Nov: the "do next" card while "How did it end?" is open and the job under it changes.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, openPage } from './helpers.mjs';

let env;
before(async () => { env = await startApp(); });
after(async () => { await env.close(); });

test('"How did it end?" never moves on to a job the person did not choose to close', async () => {
  const { context, page } = await openPage(env, { width: 390, height: 800, clock: '2026-11-10T10:00:00Z', path: '#/engineering' });
  await page.evaluate(async () => {
    const { runCommand } = await import('/app/core/commands.js');
    const nurse = { type: 'human', role: 'ward-nurse' };
    for (const [assetId, fault, priority] of [['asset-a1-sink-1', 'Tap leaking', 'urgent'], ['asset-a1-light-1', 'Tripped breaker', 'urgent'], ['asset-b1-sink-1', 'Tap leaking', 'high']]) await runCommand(window.ospeli.core, 'ospeli_workorders_report_fault', { assetId, fault, priority }, nurse);
  });
  await page.selectOption('#role-select', 'estates-tech');
  const card = page.locator('[data-test="next-card"]');
  await page.waitForSelector('[data-test="next-card"][data-mode="suggest"]');
  // Start job A, look at the next suggestion, start job B: two jobs in progress, B on the card.
  const a = await card.getAttribute('data-job');
  await card.locator('[data-cmd="ospeli_workorders_start"]').click();
  await page.waitForSelector(`[data-test="next-card"][data-mode="started"][data-job="${a}"]`);
  await card.locator('[data-test="see-suggestion"]').click();
  await page.waitForSelector('[data-test="next-card"][data-mode="suggest"]');
  const b = await card.getAttribute('data-job');
  assert.notEqual(a, b);
  await card.locator('[data-cmd="ospeli_workorders_start"]').click();
  await page.waitForSelector(`[data-test="next-card"][data-mode="started"][data-job="${b}"]`);
  // The person taps Close job on B: the three outcomes are on the card.
  await card.locator('[data-test="close-job"]').click();
  await page.waitForSelector('[data-test="outcomes"]');
  // Someone else (another technician, on another tab) closes B at that moment.
  await page.evaluate(async (id) => {
    const { runCommand } = await import('/app/core/commands.js');
    await runCommand(window.ospeli.core, 'ospeli_workorders_complete', { workOrderId: id, outcome: 'fixed' }, { type: 'human', role: 'estates-tech' });
  }, b);
  await page.waitForFunction((id) => document.querySelector('[data-test="next-card"]').dataset.job !== id, b);
  // The card now shows another job. Its outcome buttons must not be under the person's finger.
  const now = await card.getAttribute('data-job');
  const outcomes = await card.locator('[data-test="outcomes"]').count();
  assert.equal(outcomes, 0, `the card moved from ${b} to ${now} and still asks "How did it end?": one tap would close ${now}, which nobody chose to close`);
  await context.close();
});
