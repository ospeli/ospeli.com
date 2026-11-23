// Issue #163: at a weekend the example clinics do not run. The queue says so truthfully, names the
// next and the last clinic, and no longer blames an old hospital or tells the person to reload the
// example data (which would wipe what they recorded and change nothing). Clock pinned to a Sunday.
// Synthetic data only.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, openPage, setRole } from './helpers.mjs';

let env;
before(async () => { env = await startApp(); });
after(async () => { await env.close(); });

const SUNDAY = '2026-11-22T14:00:00Z'; // Sunday 10:00 at the example site

for (const width of [360, 390, 1280]) {
  test(`Sunday at ${width} px: the clinic receptionist's queue names the next and last clinic, with no advice to reload`, async () => {
    const { context, page, errors } = await openPage(env, { width, height: 800, clock: SUNDAY, touch: width < 1000, path: '#/clinics' });
    await setRole(page, 'clinic-receptionist');
    await page.evaluate(() => { location.hash = '#/clinics/_'; location.hash = '#/clinics'; });
    await page.waitForFunction(() => document.querySelector('.cl')?.dataset.role === 'clinic-receptionist' && document.querySelector('[data-test="no-clinic"]'));
    const text = await page.textContent('[data-test="no-clinic"]');
    assert.match(text, /No clinic today \(Sun 22 Nov\)\./);
    assert.match(await page.textContent('[data-test="next-clinic"]'), /^Next clinic: General medicine, Mon 23 Nov, 08:30\.$/);
    assert.match(await page.textContent('[data-test="last-clinic"]'), /^Last clinic: .+, Fri 20 Nov, \d\d:\d\d\.$/);
    assert.doesNotMatch(text, /loaded before clinics|Load Example General Hospital again/);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), 0, 'no sideways scroll');
    if (width < 1000) {
      const small = await page.$$eval('[data-test="no-clinic"] p', (ps) => ps.filter((p) => parseFloat(getComputedStyle(p).fontSize) < 15).length);
      assert.equal(small, 0, 'text at least 15 px on a phone');
    }
    assert.deepEqual(errors, []);
    await context.close();
  });
}

test('Sunday: an agent reading the queue is told the next and last clinic, and that the site has clinics', async () => {
  const { context, page, errors } = await openPage(env, { clock: SUNDAY });
  const q = await page.evaluate(async () => {
    const m = await import('./modules/clinics/commands.js');
    const cmd = m.COMMANDS.find((c) => c.name === 'ospeli_clinics_queue');
    return cmd.run(window.ospeli.core, {});
  });
  assert.equal(q.clinic, null);
  assert.equal(q.hasClinics, true);
  assert.equal(q.nextClinic.date, '2026-11-23');
  assert.equal(q.nextClinic.start, '08:30');
  assert.ok(q.lastClinic && q.lastClinic.date === '2026-11-20', `last clinic: ${JSON.stringify(q.lastClinic)}`);
  assert.deepEqual(errors, []);
  await context.close();
});
