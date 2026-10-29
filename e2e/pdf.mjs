// A PDF opens at once and fills in: the first picture shows quickly, every page ends up at its place
// (stacked, same sizes as when drawn all at once), you can write while it fills in, and deleting the
// folder mid-way stops it quietly. Chromium, Firefox, WebKit.
// Usage: npm run web:build && npx vite preview --port 4173, then npm run e2e:pdf
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { chromium, firefox, webkit } from 'playwright';

const URL = process.env.INKWELL_URL ?? 'http://localhost:4173/';
const dir = mkdtempSync(join(tmpdir(), 'inkwell-pdf-'));
const make = async (n, name) => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const sizes = [[300, 400], [612, 792], [500, 300]]; // portrait, Letter, landscape
  for (let i = 0; i < n; i++) {
    const [w, h] = sizes[i % 3];
    const pg = doc.addPage([w, h]);
    pg.drawText(`Page ${i + 1} of ${n}`, { x: 30, y: h - 60, size: 28, font });
    for (let k = 0; k < 12; k++) pg.drawText(`line ${k} of lorem ipsum dolor sit amet`, { x: 30, y: h - 100 - k * 18, size: 11, font });
  }
  const path = join(dir, name);
  writeFileSync(path, await doc.save());
  return { path, sizes: Array.from({ length: n }, (_, i) => sizes[i % 3]) };
};
const small = await make(60, 'sixty.pdf');
const big = await make(600, 'many.pdf');
const fails = [];

for (const [engine, type] of [['Chromium', chromium], ['Firefox', firefox], ['WebKit', webkit]]) {
  const browser = await type.launch();
  const errors = [];
  const R = {};
  const open = async () => {
    const p = await (await browser.newContext({ viewport: { width: 1280, height: 860 } })).newPage();
    p.setDefaultTimeout(20000);
    p.on('pageerror', (e) => errors.push(e.message.slice(0, 120)));
    await p.goto(URL);
    await p.waitForSelector('#toolbar .tb-btn');
    return p;
  };
  /** The section with this name, as saved. */
  const sectionOf = (p, name) =>
    p.evaluate(async (name) => {
      dispatchEvent(new Event('pagehide'));
      await new Promise((r) => setTimeout(r, 120));
      return new Promise((res) => {
        const rq = indexedDB.open('inkwell');
        rq.onsuccess = () => {
          const g = rq.result.transaction('kv').objectStore('kv').get('inkwell:state');
          g.onsuccess = () => {
            const sec = g.result?.notebooks.flatMap((n) => n.sections).find((x) => x.name === name);
            res(sec ? { pages: sec.pages.length, images: sec.pages.flatMap((q) => q.images), strokes: sec.pages.reduce((n, q) => n + q.strokes.length, 0) } : null);
          };
        };
      });
    }, name);
  const start = async (p, file, label = 'PDF (to write on)…') => {
    await p.locator('[aria-label="Insert"]').click();
    const chooser = p.waitForEvent('filechooser');
    await p.getByText(label, { exact: true }).click();
    const t0 = Date.now();
    await (await chooser).setFiles(file);
    return t0;
  };

  // 1. Quick first picture, then everything in place.
  let p = await open();
  const t0 = await start(p, small.path);
  let first = null;
  let seenPartial = false;
  let sec = null;
  for (let i = 0; i < 200; i++) {
    sec = await sectionOf(p, 'sixty');
    if (sec?.images.length && first === null) first = Date.now() - t0;
    if (sec && sec.images.length > 0 && sec.images.length < 60) seenPartial = true;
    if (sec?.images.length === 60) break;
    await p.waitForTimeout(120);
  }
  R.finishedWithNoProgressLeftOver = (await p.locator('.toast', { hasText: 'Drawing' }).count()) === 0;
  R.firstPictureQuickly = first !== null && first < 4000;
  R.fillsInGradually = seenPartial;
  R.allSixtyPagesDrawn = sec?.images.length === 60 && sec.pages === 1;
  const imgs = [...(sec?.images ?? [])].sort((a, b) => a.cy - b.cy);
  const px = 96 / 72;
  R.sizesMatchThePdf = imgs.length === 60 && imgs.every((im, i) => Math.abs(im.w - small.sizes[i][0] * px) < 0.01 && Math.abs(im.h - small.sizes[i][1] * px) < 0.01);
  R.pagesAreStackedWithAGap = imgs.length === 60 && imgs.slice(1).every((im, i) => Math.abs(im.cy - im.h / 2 - (imgs[i].cy + imgs[i].h / 2) - 24) < 0.01);
  R.pagesShareACentreLine = imgs.length === 60 && imgs.every((im) => Math.abs(im.cx - imgs[0].cx) < 0.01);
  await p.close();

  // 2. Writing while it fills in.
  p = await open();
  await start(p, big.path);
  for (let i = 0; i < 100; i++) {
    const s = await sectionOf(p, 'many');
    if (s?.images.length) break;
    await p.waitForTimeout(100);
  }
  await p.mouse.move(700, 400);
  await p.mouse.down();
  for (let i = 1; i <= 12; i++) await p.mouse.move(700 + i * 15, 400 + (i % 3) * 6);
  await p.mouse.up();
  const progressToasts = await p.locator('.toast').count();
  R.oneProgressToastNotAPileOfThem = progressToasts <= 2;
  const midway = await sectionOf(p, 'many');
  R.canWriteWhileItFillsIn = midway?.strokes === 1 && midway.images.length < 600;

  // 3. Deleting the folder mid-way stops it, with no error and nothing left behind.
  await p.locator('.row.section[aria-current="true"] [aria-label="Folder options"]').click();
  const beforeDelete = await sectionOf(p, 'many');
  await p.getByText('Delete folder', { exact: true }).click();
  await p.getByText('Tap again to delete').click(); // a dangerous menu item asks twice
  await p.waitForTimeout(300);
  const gone = await sectionOf(p, 'many');
  await p.waitForTimeout(4000);
  const later = await sectionOf(p, 'many');
  // It really was deleted while still filling in, and nothing came back afterwards.
  R.progressStopsWhenTheFolderIsDeleted = (await p.locator('.toast', { hasText: 'Drawing' }).count()) === 0;
  R.deletedMidwayAndStaysDeleted = !!beforeDelete && beforeDelete.images.length < 600 && gone === null && later === null;
  await p.close();

  // 4. One notebook page per PDF page still works as before.
  p = await open();
  await start(p, small.path, 'PDF, one notebook page per PDF page…');
  let per = null;
  for (let i = 0; i < 100 && !per; i++) {
    const s = await sectionOf(p, 'sixty');
    if (s?.pages === 60) per = s;
    await p.waitForTimeout(200);
  }
  R.perPageModeStillWorks = !!per && per.images.length === 60;

  R.noErrors = errors.length === 0;
  await browser.close();
  const bad = Object.entries(R).filter(([, v]) => !v).map(([k]) => k);
  console.log(`${engine}: ${bad.length ? 'FAIL' : 'ok'} (first picture after ${first} ms)`, bad.length ? bad : '', errors.length ? errors : '');
  if (bad.length) fails.push(engine);
}
process.exit(fails.length ? 1 : 0);
