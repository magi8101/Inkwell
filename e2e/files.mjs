// Sharing and files in Chromium, Firefox and WebKit: SVG export, copy as picture, (more below).
// Usage: npm run web:build && npm run preview (another terminal), then npm run e2e:files
import fs from 'node:fs';
import { chromium, firefox, webkit } from 'playwright';

const URL = process.env.INKWELL_URL ?? 'http://localhost:4173/';
let failed = 0;
for (const [name, engine] of [['Chromium', chromium], ['Firefox', firefox], ['WebKit', webkit]]) {
  const browser = await engine.launch();
  const p = await (await browser.newContext({ viewport: { width: 1368, height: 912 }, acceptDownloads: true })).newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  await p.goto(URL);
  await p.waitForSelector('#toolbar .tb-btn');
  await p.evaluate(() => document.querySelector('[aria-label="Hide sidebar"]')?.click());
  const R = {};
  const drag = async (x1, y1, x2, y2) => {
    await p.mouse.move(x1, y1);
    await p.mouse.down();
    await p.mouse.move((x1 + x2) / 2, (y1 + y2) / 2, { steps: 3 });
    await p.mouse.move(x2, y2, { steps: 3 });
    await p.mouse.up();
    await p.waitForTimeout(150);
  };
  const pickShape = async (label) => {
    await p.locator('[aria-label="Shapes"]').first().click();
    await p.waitForTimeout(120);
    await p.locator(`.shape-panel [aria-label="${label}"]`).click();
    await p.keyboard.press('Escape');
  };
  const loop = async (cx, cy, rx, ry) => {
    await p.keyboard.press('l');
    await p.mouse.move(cx - rx, cy - ry);
    await p.mouse.down();
    for (const [x, y] of [[cx + rx, cy - ry], [cx + rx, cy + ry], [cx - rx, cy + ry], [cx - rx, cy - ry + 2]]) await p.mouse.move(x, y, { steps: 4 });
    await p.mouse.up();
    await p.waitForTimeout(200);
  };
  const colour = async (hexValue) => {
    await p.locator('[aria-label="Colour and size"]').click();
    await p.waitForTimeout(120);
    await p.locator(`.pal[data-color="${hexValue}"]`).click();
    await p.keyboard.press('Escape');
  };

  // A solid red rectangle, a blue pen line.
  await colour('#e5484d');
  await pickShape('Rectangle');
  await p.locator('[aria-label="Shapes"]').first().click();
  await p.locator('.shape-panel [aria-label="Solid"]').first().click();
  await p.keyboard.press('Escape');
  await drag(400, 300, 600, 420);
  await p.keyboard.press('Escape');
  await p.keyboard.press('p');
  await colour('#0090ff');
  await drag(400, 520, 700, 520);

  // --- SVG export ---
  await p.locator('[aria-label="Export"]').click();
  await p.waitForTimeout(250);
  await p.locator('.export-panel .seg', { hasText: 'SVG' }).click();
  const [dl] = await Promise.all([p.waitForEvent('download'), p.locator('.export-panel .primary').click()]);
  const svg = fs.readFileSync(await dl.path(), 'utf8');
  R.svgFilename = dl.suggestedFilename().endsWith('.svg');
  R.svgIsXml = await p.evaluate((s) => !new DOMParser().parseFromString(s, 'image/svg+xml').querySelector('parsererror'), svg);
  R.svgHasShapeAndInk = (svg.match(/<path /g) ?? []).length >= 2;
  // Render it and look at colours: red where the rectangle is, white page around, blue ink.
  const px = await p.evaluate(async (s) => {
    const img = new Image();
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(s)}`;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
    // Find the box of non-white pixels in rows to locate shapes without knowing the offset.
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let red = 0;
    let blue = 0;
    let white = 0;
    for (let i = 0; i < d.length; i += 4) {
      const [r, g, b, a] = [d[i], d[i + 1], d[i + 2], d[i + 3]];
      if (a > 200 && r > 200 && g < 110 && b < 110) red++;
      else if (a > 200 && b > 200 && r < 60) blue++;
      else if (a > 200 && r > 245 && g > 245 && b > 245) white++;
    }
    return { red, blue, white, w: c.width, h: c.height };
  }, svg);
  R.svgRendersRedShape = px.red > 4000;
  R.svgRendersBlueInk = px.blue > 100;
  R.svgPageIsWhite = px.white > px.red;

  // --- Copy as picture: the selection lands on the clipboard as a PNG ---
  await p.evaluate(() => {
    if (!window.ClipboardItem) window.ClipboardItem = class { constructor(o) { this.o = o; } async getType(t) { return this.o[t]; } };
    navigator.clipboard.write = async (items) => {
      window.__copied = await items[0].getType('image/png');
    };
  });
  await p.keyboard.press('Escape');
  await loop(500, 360, 160, 100);
  await p.locator('.selbar [aria-label="Copy as a picture"]').click();
  await p.waitForFunction(() => window.__copied, null, { timeout: 8000 });
  const copied = await p.evaluate(async () => {
    const b = window.__copied;
    const bytes = new Uint8Array(await b.slice(0, 8).arrayBuffer());
    return { size: b.size, png: [...bytes].join(',') === '137,80,78,71,13,10,26,10' };
  });
  R.copiesPng = copied.png && copied.size > 300;

  // --- Stamps: save the selection, insert it from the Insert menu, it survives a reload ---
  const shapeCount = () =>
    p.evaluate(async () => {
      dispatchEvent(new Event('pagehide'));
      await new Promise((r) => setTimeout(r, 150));
      return new Promise((res) => {
        const q = indexedDB.open('inkwell');
        q.onsuccess = () => {
          const g = q.result.transaction('kv').objectStore('kv').get('inkwell:state');
          g.onsuccess = () => {
            const s = g.result;
            res((s.notebooks.flatMap((n) => n.sections).flatMap((x) => x.pages).find((x) => x.id === s.pageId).shapes ?? []).length);
          };
        };
      });
    });
  const before = await shapeCount();
  await p.locator('.selbar [aria-label="Save as stamp"]').click(); // the rectangle is still selected
  await p.waitForTimeout(600);
  await p.keyboard.press('Escape');
  await p.locator('[aria-label="Insert"]').click();
  await p.locator('.menu .menu-item', { hasText: 'Stamps' }).click();
  await p.waitForSelector('.stamp-use');
  R.stampSaved = (await p.locator('.stamp-use').count()) === 1;
  await p.locator('.stamp-use').first().click();
  await p.waitForTimeout(400);
  R.stampInserts = (await shapeCount()) === before + 1;
  R.stampInsertedSelected = await p.locator('.sel-frame').isVisible();
  await p.keyboard.press('Escape');
  await p.reload();
  await p.waitForSelector('#toolbar .tb-btn');
  await p.locator('[aria-label="Insert"]').click();
  await p.locator('.menu .menu-item', { hasText: 'Stamps' }).click();
  await p.waitForSelector('.stamp-use');
  R.stampSurvivesReload = (await p.locator('.stamp-use').count()) === 1;
  await p.locator('.stamp-del').click();
  await p.waitForTimeout(300);
  R.stampDeletes = (await p.locator('.stamp-use').count()) === 0;
  await p.keyboard.press('Escape');

  R.noErrors = errors.length === 0;
  await browser.close();
  console.log(`${name}: ${Object.values(R).every(Boolean) ? 'ok' : 'FAIL'}`);
  for (const [k, v] of Object.entries(R)) if (!v) console.log(`  ✗ ${k}`);
  for (const e of errors) console.log(`  ! ${e}`);
  if (!Object.values(R).every(Boolean)) failed++;
}
process.exit(failed ? 1 : 0);
