// Issue #95 item 3 (seen by reading, not proven before): assigning a job that is in progress sets
// it back to Assigned and clears its start time with no warning; and the operations manager is
// offered Start with no way to close the job. The dialog now says both before the person acts.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, openPage, setRole } from './helpers.mjs';

let env;
before(async () => { env = await startApp(); });
after(async () => { await env.close(); });

for (const width of [360, 1280]) {
  test(`work-order dialog: a job in progress warns before Assign, and Start says who closes (${width}px)`, async () => {
    const { context, page, errors } = await openPage(env, { width, height: 780, path: '#/engineering', clock: '2026-11-10T10:00:00Z', touch: width < 500 });
    await setRole(page, 'ops-manager');
    await page.waitForSelector('[data-test="wo-queue"][data-role="ops-manager"] [data-test="wo-list"] [data-wo]');
    const [started, open] = await page.evaluate(async () => {
      const { runCommand } = await import('./core/commands.js');
      const core = window.ospeli.core; const ops = { type: 'human', role: 'ops-manager' };
      const list = (await runCommand(core, 'ospeli_workorders_list', { state: 'open', limit: 500 }, ops)).workOrders.filter((w) => w.state !== 'started');
      await runCommand(core, 'ospeli_workorders_start', { workOrderId: list[0].id }, ops);
      return [list[0].id, list[1].id];
    });
    const openDialog = async (id) => {
      await page.waitForSelector(`[data-test="wo-list"] [data-wo="${id}"]`);
      await page.locator(`[data-test="wo-list"] [data-wo="${id}"]`).evaluate((b) => b.click());
      await page.waitForSelector('dialog[open]');
      return page.locator('dialog[open]');
    };
    // In progress: the warning sits above the buttons, in words, at phone size. (Wait for the list
    // to show the job as in progress first.)
    await page.waitForFunction((id) => /In progress/.test(document.querySelector(`[data-test="wo-list"] [data-wo="${id}"]`)?.textContent || ''), started);
    let dlg = await openDialog(started);
    const warn = dlg.locator('[data-test="assign-resets"]');
    assert.equal(await warn.textContent(), 'This job is in progress. Assigning it puts it back to Assigned and clears its start time.');
    assert.ok(parseFloat(await warn.evaluate((e) => getComputedStyle(e).fontSize)) >= 15);
    assert.equal(await dlg.locator('[data-cmd="ospeli_workorders_start"]').count(), 0);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('dialog[open]'));
    // Not started: Start is offered, with who closes the job, since this role cannot.
    dlg = await openDialog(open);
    assert.equal(await dlg.locator('[data-test="assign-resets"]').count(), 0);
    assert.equal(await dlg.locator('[data-cmd="ospeli_workorders_start"]').count(), 1);
    assert.equal(await dlg.locator('[data-cmd="ospeli_workorders_complete"]').count(), 0);
    assert.equal(await dlg.locator('[data-test="who-closes"]').textContent(), 'Closing a work order is for the Facilities technician.');
    await page.keyboard.press('Escape');
    // The facilities technician, who can close, is not told that.
    await setRole(page, 'estates-tech');
    await page.waitForSelector('[data-test="wo-queue"][data-role="estates-tech"] [data-test="wo-list"] [data-wo]');
    dlg = await openDialog(open);
    assert.equal(await dlg.locator('[data-test="who-closes"]').count(), 0);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), 0);
    assert.deepEqual(errors, []);
    await context.close();
  });
}
