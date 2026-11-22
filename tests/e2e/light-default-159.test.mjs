// Issue #159: the site and the app stay light on a phone set to dark, and on a browser that
// repaints pages dark by itself (Chrome's "auto dark theme for web contents", Samsung Internet's
// dark mode for sites). A page opts out by declaring `only light`.
// The repaint happens when the page is drawn and never shows in computed styles, so each page is
// photographed in a plain browser and in one that forces dark, and the pictures must match (less than
// half a percent of the picture may differ; a repaint to dark changes most of it).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readdirSync, existsSync } from 'node:fs';
import { createServer } from '../../scripts/serve.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

let server, base, plain, forced;
before(async () => {
  server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  plain = await chromium.launch();
  forced = await chromium.launch({ args: ['--blink-settings=forceDarkModeEnabled=true'] });
});
after(async () => { await plain.close(); await forced.close(); await new Promise((r) => server.close(r)); });

// The top of the page as a phone draws it. Animations are stopped and the clock stands still, so the pictures show the same moment.
async function shot(browser, path, { colorScheme }) {
  const context = await browser.newContext({ viewport: { width: 390, height: 700 }, colorScheme, reducedMotion: 'reduce' });
  const page = await context.newPage();
  await page.clock.setFixedTime(new Date('2026-11-18T10:00:00Z'));
  await page.goto(base + path, { waitUntil: 'networkidle' });
  if (path.startsWith('/app/')) await page.waitForSelector('html[data-ready="true"]');
  // Every font file in use has arrived and the page has been drawn with it (two frames), so the first picture is not taken in the stand-in font.
  await page.evaluate(async () => { await document.fonts.ready; await Promise.all([...document.fonts].filter((f) => f.status === 'loading').map((f) => f.loaded)); await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); });
  const declared = await page.evaluate(() => ({
    meta: document.querySelector('meta[name="color-scheme"]')?.content || '',
    css: getComputedStyle(document.documentElement).colorScheme,
    background: getComputedStyle(document.body).backgroundColor,
  }));
  // The picture is taken once the page has stopped changing: two pictures in a row, 100 ms apart, that match.
  let picture = await page.screenshot({ animations: 'disabled', caret: 'hide' });
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(100);
    const next = await page.screenshot({ animations: 'disabled', caret: 'hide' });
    const settled = next.equals(picture);
    picture = next;
    if (settled) break;
  }
  await context.close();
  return { declared, picture };
}

// The share of the picture that differs clearly (a colour channel off by more than 24 of 255), in percent.
// A repaint to dark changes most of a page; the edge of a rounded card drawn one shade apart on two
// loads changes a few pixels. The pictures are read in a browser page, so no image library is needed.
async function differs(one, two) {
  const context = await plain.newContext();
  const page = await context.newPage();
  const share = await page.evaluate(async ([a, b]) => {
    const read = async (b64) => { const img = new Image(); img.src = `data:image/png;base64,${b64}`; await img.decode(); const c = document.createElement('canvas'); c.width = img.width; c.height = img.height; const g = c.getContext('2d'); g.drawImage(img, 0, 0); return g.getImageData(0, 0, c.width, c.height); };
    const [x, y] = [await read(a), await read(b)];
    if (x.width !== y.width || x.height !== y.height) return 100;
    let off = 0;
    for (let i = 0; i < x.data.length; i += 4) if (Math.abs(x.data[i] - y.data[i]) > 24 || Math.abs(x.data[i + 1] - y.data[i + 1]) > 24 || Math.abs(x.data[i + 2] - y.data[i + 2]) > 24) off += 1;
    return (off * 100) / (x.data.length / 4);
  }, [one.toString('base64'), two.toString('base64')]);
  await context.close();
  return share;
}

const web = new URL('../../web/', import.meta.url);
const folders = (dir) => readdirSync(new URL(dir, web), { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(new URL(`${dir}${d.name}/index.html`, web))).map((d) => `/${dir}${d.name}/`);
const everyPage = ['/', '/app/', '/areas/', '/demo/', ...folders('areas/'), ...folders('demo/')];

test('the browser used for this test really repaints a page that does not opt out (the check can fail)', async () => {
  const html = 'data:text/html,<meta name="viewport" content="width=device-width"><body style="background:%23F6F1E7;color:%230B2F4E"><h1>Plain page</h1>';
  const pictures = [];
  for (const browser of [plain, forced]) {
    const context = await browser.newContext({ viewport: { width: 390, height: 300 }, colorScheme: 'dark' });
    const page = await context.newPage();
    await page.goto(html);
    pictures.push(await page.screenshot());
    await context.close();
  }
  const share = await differs(pictures[0], pictures[1]);
  assert.ok(share > 50, `a page with no colour-scheme line is repainted dark by the forcing browser (${share.toFixed(1)}% of it changed)`);
});

test('every public page and the app declare "only light", in the page head and in the root style', async () => {
  assert.ok(everyPage.length >= 62, `found ${everyPage.length} pages`);
  const context = await plain.newContext({ colorScheme: 'dark' });
  const page = await context.newPage();
  const wrong = [];
  for (const path of everyPage) {
    await page.goto(base + path, { waitUntil: 'domcontentloaded' });
    const d = await page.evaluate(() => ({
      meta: document.querySelector('meta[name="color-scheme"]')?.content || '',
      css: getComputedStyle(document.documentElement).colorScheme,
    }));
    // The browser reads the style back as "light only": the same two words, in its own order.
    if (d.meta !== 'only light' || d.css.split(' ').sort().join(' ') !== 'light only') wrong.push(`${path} meta "${d.meta}" css "${d.css}"`);
  }
  await context.close();
  assert.deepEqual(wrong, []);
});

for (const path of ['/', '/app/', '/areas/', '/areas/process-mapping/', '/demo/', '/demo/bed-board/', '/demo/clinics/']) {
  test(`${path} looks the same on a phone set to dark, and in a browser that forces dark, as on a phone set to light`, async () => {
    const light = await shot(plain, path, { colorScheme: 'light' });
    const dark = await shot(plain, path, { colorScheme: 'dark' });
    const repainted = await shot(forced, path, { colorScheme: 'dark' });
    assert.ok(['rgb(246, 241, 231)', 'rgb(255, 255, 255)'].includes(light.declared.background), `page background is sand or white, got ${light.declared.background}`);
    assert.equal(dark.declared.background, light.declared.background, 'same background with the phone set to dark');
    const [whenDark, whenForced] = [await differs(light.picture, dark.picture), await differs(light.picture, repainted.picture)];
    assert.ok(whenDark < 0.5, `phone set to dark: the page is drawn the same (${whenDark.toFixed(2)}% of it differs)`);
    assert.ok(whenForced < 0.5, `browser forcing dark: the page is drawn the same (${whenForced.toFixed(2)}% of it differs)`);
  });
}
