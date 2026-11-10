// Patient feedback and complaints demo (web/demo/feedback/): each role renders on a phone and a
// laptop, a patient's feedback card changes the measures, staff actions change the KPIs, guide
// proposals wait for a person, and the guide can be switched off. Fictional data only.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './helpers.mjs';

let env;
before(async () => { env = await startApp(); });
after(async () => { await env.close(); });

async function open(width, role) {
  const context = await env.browser.newContext({ viewport: { width, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(env.base + '/demo/feedback/');
  await page.waitForSelector('#view > *');
  if (role) await page.click('#r-' + role);
  return { context, page, errors };
}
const api = (page, fn, arg) => page.evaluate(([f, a]) => window.ospeliFeedbackDemo[f](a), [fn, arg]);
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

for (const width of [360, 390, 1280]) {
  test(`feedback demo renders every role at ${width}px with no sideways scroll`, async () => {
    const { context, page, errors } = await open(width);
    for (const role of ['patient', 'lead', 'manager']) {
      await page.click('#r-' + role);
      assert.equal(await page.locator('#r-' + role).getAttribute('aria-pressed'), 'true');
      const o = await overflow(page);
      assert.ok(o <= 0, `${role} view scrolls sideways by ${o}px`);
      if (role === 'patient') assert.equal(await page.locator('.face svg').count(), 5, 'five drawn faces');
      else {
        assert.equal(await page.locator('#kpis .stat').count(), 4);
        assert.ok(await page.locator('.sugg').count() >= 2, `${role} guide shows suggestions`);
      }
    }
    assert.deepEqual(errors, []);
    await context.close();
  });
}

test('on a phone the patient card opens first, with large tap targets and text', async () => {
  const { context, page, errors } = await open(360);
  assert.equal(await page.locator('#r-patient').getAttribute('aria-pressed'), 'true');
  for (const sel of ['#face-1', '#face-5', '#send', '#contact + *', '#quick-0']) {
    const box = await page.locator(sel === '#contact + *' ? 'label.check' : sel).boundingBox();
    assert.ok(box.height >= 44, `${sel} is at least 44px tall`);
  }
  const small = await page.evaluate(() => Array.from(document.querySelectorAll('.pv *')).filter((n) => n.childNodes.length && Array.from(n.childNodes).some((c) => c.nodeType === 3 && c.textContent.trim()) && parseFloat(getComputedStyle(n).fontSize) < 15).map((n) => n.textContent.slice(0, 30)));
  assert.deepEqual(small, [], 'no text under 15px in the patient view');
  assert.deepEqual(errors, []);
  await context.close();
});

test('a patient sends a card; the department measures update and the lead can sort it', async () => {
  const { context, page, errors } = await open(390, 'patient');
  const before = await api(page, 'kpis', 'w4');
  assert.ok(await page.locator('#send').isDisabled(), 'send waits for a face');
  await page.click('#face-2');
  await page.fill('#fix', 'Hard to sleep, Nurse Example was lovely but the noise was loud');
  await page.check('#contact');
  await page.fill('#contact-how', 'someone@example.org');
  await page.click('#send');
  const ref = await page.locator('#refcode').textContent();
  assert.match(ref, /^FB-\d+$/);
  const afterK = await api(page, 'kpis', 'w4');
  assert.equal(afterK.feedbackLast30Days, before.feedbackLast30Days + 1);
  assert.equal(afterK.commentsToSort, before.commentsToSort + 1);
  const stored = await page.evaluate(() => localStorage.getItem('ospeli.feedback.v1'));
  assert.ok(!stored.includes('someone@example.org'), 'contact details are not kept');
  assert.ok(stored.includes('Nurse [name hidden]'), 'names are hidden from the comment');
  await page.click('#r-lead');
  assert.match(await page.locator('#kpi-sort b').textContent(), new RegExp('^' + afterK.commentsToSort + '$'));
  const sel = page.locator(`select[id^="sort-n${ref}"]`);
  await sel.selectOption('noise');
  assert.equal((await api(page, 'kpis', 'w4')).commentsToSort, before.commentsToSort);
  assert.deepEqual(errors, []);
  await context.close();
});

test('staff actions change the KPIs: respond late, close an action, log a complaint', async () => {
  const { context, page, errors } = await open(1280, 'manager');
  const k0 = await api(page, 'kpis');
  await page.click('#f-over');
  const first = await page.locator('#queue .crow').first().getAttribute('data-ref');
  assert.ok(first, 'there is an overdue item');
  const overdueRef = (await api(page, 'get')).complaints.find((c) => c.overdue && c.stage === 'Acknowledged').ref;
  await page.click('#adv-' + overdueRef);
  const k1 = await api(page, 'kpis');
  assert.equal(k1.respondedCount, k0.respondedCount + 1);
  assert.equal(k1.responsesDue, k0.responsesDue, 'it was already due');
  assert.equal(k1.overdue, k0.overdue - 1);
  await page.click('#f-open');
  await page.selectOption('#l-svc', 'rad');
  await page.click('#l-save');
  assert.equal((await api(page, 'kpis')).openComplaints, k1.openComplaints + 1);
  await page.click('#r-lead');
  await page.selectOption('#t-dept', 'ed');
  const e0 = await api(page, 'kpis', 'ed');
  await page.click('#done-A-16');
  const e1 = await api(page, 'kpis', 'ed');
  assert.equal(e1.actionsDue, e0.actionsDue + 1);
  assert.equal(e1.actionsClosedOnTime, e0.actionsClosedOnTime + 1);
  assert.deepEqual(errors, []);
  await context.close();
});

test('guide proposals wait for a person, and drafted cards wait to be published', async () => {
  const { context, page, errors } = await open(1280, 'lead');
  const toSort = (await api(page, 'kpis', 'w4')).commentsToSort;
  await page.locator('.sugg[data-id^="group-"] button.primary').click();
  assert.equal((await api(page, 'kpis', 'w4')).commentsToSort, toSort, 'proposing changes nothing');
  await page.locator('#pending button', { hasText: 'Confirm' }).click();
  assert.ok((await api(page, 'kpis', 'w4')).commentsToSort < toSort, 'confirming groups the comments');
  const published = (await api(page, 'get')).cards.filter((c) => c.status === 'published').length;
  await page.locator('.sugg[data-id^="card-"] button.primary').click();
  const cards = (await api(page, 'get')).cards;
  assert.equal(cards.filter((c) => c.status === 'published').length, published, 'a draft is not published');
  assert.equal(cards.filter((c) => c.status === 'draft').length, 1);
  await page.locator('.yc.draft textarea').first().fill('Nights on the ward were too noisy.');
  await page.locator('[id^="pub-"]').click();
  assert.equal((await api(page, 'get')).cards.filter((c) => c.status === 'published').length, published + 1);
  await page.click('#r-patient');
  assert.ok(await page.getByText('Nights on the ward were too noisy.').isVisible(), 'patients see the published card');
  assert.deepEqual(errors, []);
  await context.close();
});

test('the guide has an off switch and everything still works without it', async () => {
  const { context, page, errors } = await open(390, 'lead');
  await page.uncheck('#guide-on');
  assert.equal(await page.locator('.sugg').count(), 0);
  assert.equal(await page.locator('#kpis .stat').count(), 4);
  await page.click('#r-manager');
  assert.equal(await page.locator('.sugg').count(), 0);
  assert.ok(await page.locator('#queue .crow').count() > 0);
  assert.deepEqual(errors, []);
  await context.close();
});

test('the agent object is read-only and returns data', async () => {
  const { context, page, errors } = await open(1280);
  assert.match(await api(page, 'describe'), /Read-only/);
  const g = await api(page, 'get');
  assert.ok(g.complaints.length > 10);
  assert.ok(g.complaints[0].overdue, 'overdue first');
  assert.ok(g.themes.some((t) => t.aboveUsualRange));
  const k = await api(page, 'kpis');
  for (const key of ['acknowledgementMedianDays', 'responseMedianDays', 'responsesOnTimePct', 'actionsClosedPct']) assert.equal(typeof k[key], 'number', key);
  const s = await api(page, 'suggestions');
  assert.ok(s.length >= 2 && s.every((x) => x.why));
  assert.ok(await page.evaluate(() => Object.isFrozen(window.ospeliFeedbackDemo)));
  assert.deepEqual(errors, []);
  await context.close();
});

test('Ward 4 patients see a published "You said, we did" card from the start', async () => {
  const { context, page, errors } = await open(1280, 'patient');
  assert.ok(await page.getByText('It was noisy at night.').isVisible(), 'the seeded Ward 4 card is shown to patients');
  assert.deepEqual(errors, []);
  await context.close();
});
