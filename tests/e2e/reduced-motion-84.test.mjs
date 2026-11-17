// Issue #84 item 4: motion stays minimal and honours the phone's reduce-motion setting. With
// "reduce" on, no preview page and not the app has a running animation, and no element keeps a
// transition. (scripts/check.py guards the source; this checks what the browser actually does.)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startApp } from './helpers.mjs';

let env;
before(async () => { env = await startApp(); });
after(async () => { await env.close(); });

const demoDir = fileURLToPath(new URL('../../web/demo/', import.meta.url));
const demos = readdirSync(demoDir).filter((d) => existsSync(join(demoDir, d, 'index.html')));
const paths = ['/', '/app/', ...demos.map((d) => `/demo/${d}/`)];

async function motionLeft(page) {
  return page.evaluate(() => {
    const moving = [];
    for (const a of document.getAnimations()) if (a.playState === 'running') moving.push(`animation on ${a.effect?.target?.tagName || '?'}`);
    for (const el of document.querySelectorAll('*')) {
      for (const pseudo of [null, '::before', '::after']) {
        const s = getComputedStyle(el, pseudo);
        const dur = (v) => v.split(',').some((x) => parseFloat(x) > 0);
        if (dur(s.transitionDuration)) moving.push(`transition on ${el.tagName}.${el.className}${pseudo || ''}`);
        if (s.animationName !== 'none' && dur(s.animationDuration)) moving.push(`animation ${s.animationName} on ${el.tagName}${pseudo || ''}`);
      }
    }
    return [...new Set(moving)].slice(0, 5);
  });
}

test('#84: with reduce motion on, the front page, the app and every preview have no motion', async () => {
  assert.ok(demos.length >= 20, `found ${demos.length} previews`);
  const context = await env.browser.newContext({ viewport: { width: 390, height: 800 }, reducedMotion: 'reduce' });
  const page = await context.newPage();
  const problems = [];
  for (const p of paths) {
    await page.goto(env.base + p);
    await page.waitForLoadState('load');
    if (p === '/app/') await page.waitForSelector('html[data-ready="true"]');
    const left = await motionLeft(page);
    if (left.length) problems.push(`${p}: ${left.join('; ')}`);
  }
  await context.close();
  assert.deepEqual(problems, []);
});

test('#84: with reduce motion off, the previews keep their small motion (the check is not empty)', async () => {
  const context = await env.browser.newContext({ viewport: { width: 390, height: 800 }, reducedMotion: 'no-preference' });
  const page = await context.newPage();
  let withMotion = 0;
  for (const d of demos) {
    await page.goto(`${env.base}/demo/${d}/`);
    await page.waitForLoadState('load');
    if ((await motionLeft(page)).length) withMotion++;
  }
  await context.close();
  assert.ok(withMotion >= 10, `only ${withMotion} previews have any motion with the setting off`);
});
