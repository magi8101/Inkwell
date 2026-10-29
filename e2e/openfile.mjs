// Insert → "Open a file…" routes each kind of file to the right importer, says so out loud for a file
// it cannot open, and handles several files at once. Chromium, Firefox, WebKit.
// Usage: npm run web:build && npx vite preview --port 4173, then npm run e2e:openfile
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zipSync } from 'fflate';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { chromium, firefox, webkit } from 'playwright';

const URL = process.env.INKWELL_URL ?? 'http://localhost:4173/';
const dir = mkdtempSync(join(tmpdir(), 'inkwell-open-'));
const F = {
  md: join(dir, 'note.md'),
  pdf: join(dir, 'doc.pdf'),
  png: join(dir, 'dot.png'),
  zip: join(dir, 'vault.zip'),
  txt: join(dir, 'readme.txt'),
  inkw: new globalThis.URL('../docs/inkw-golden/basic.inkw', import.meta.url).pathname,
  renamed: join(dir, 'renamed-without-extension'),
};
writeFileSync(F.md, '# Opened\n\nbody\n');
const pdf = await PDFDocument.create();
const font = await pdf.embedFont(StandardFonts.Helvetica);
for (let i = 1; i <= 3; i++) pdf.addPage([300, 400]).drawText(`Page ${i}`, { x: 40, y: 340, size: 24, font });
writeFileSync(F.pdf, await pdf.save());
writeFileSync(F.png, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));
writeFileSync(F.zip, zipSync({ 'vault/a.md': new TextEncoder().encode('# A\n') }));
writeFileSync(F.txt, 'plain text');
writeFileSync(F.renamed, (await import('node:fs')).readFileSync(F.inkw)); // an .inkw with no extension: recognised by content

const fails = [];
for (const [engine, type] of [['Chromium', chromium], ['Firefox', firefox], ['WebKit', webkit]]) {
  const browser = await type.launch();
  const errors = [];
  const R = {};
  const open = async () => {
    const p = await (await browser.newContext({ viewport: { width: 1280, height: 860 } })).newPage();
    p.setDefaultTimeout(15000);
    p.on('pageerror', (e) => errors.push(e.message.slice(0, 120)));
    await p.goto(URL);
    await p.waitForSelector('#toolbar .tb-btn');
    return p;
  };
  const pick = async (p, files) => {
    await p.locator('[aria-label="Insert"]').click();
    const chooser = p.waitForEvent('filechooser');
    await p.getByText('Open a file…').click();
    await (await chooser).setFiles(files);
    await p.waitForTimeout(2500);
  };
  const counts = (p) =>
    p.evaluate(async () => {
      dispatchEvent(new Event('pagehide'));
      await new Promise((r) => setTimeout(r, 200));
      return new Promise((res) => {
        const rq = indexedDB.open('inkwell');
        rq.onsuccess = () => {
          const g = rq.result.transaction('kv').objectStore('kv').get('inkwell:state');
          g.onsuccess = () => {
            const s = g.result;
            if (!s) return res({ notebooks: 1, pages: 1, md: 0, images: 0 });
            const pages = s.notebooks.flatMap((n) => n.sections.flatMap((x) => x.pages));
            res({ notebooks: s.notebooks.length, pages: pages.length, md: pages.filter((q) => q.md !== undefined).length, images: pages.reduce((n, q) => n + q.images.length, 0) });
          };
        };
      });
    });
  const toasts = (p) => p.locator('.toast').allInnerTexts();

  let p = await open();
  const base = await counts(p);
  await pick(p, F.md);
  R.markdownBecomesANote = (await counts(p)).md === base.md + 1;

  p = await open();
  await pick(p, F.pdf);
  const afterPdf = await counts(p);
  R.pdfOpens = afterPdf.images === 3;

  p = await open();
  await pick(p, F.png);
  R.pictureIsInserted = (await counts(p)).images === base.images + 1;

  p = await open();
  await pick(p, F.inkw);
  R.inkwOpens = (await counts(p)).notebooks === base.notebooks + 2;

  p = await open();
  await pick(p, F.renamed);
  R.inkwWithoutExtensionIsRecognised = (await counts(p)).notebooks === base.notebooks + 2;

  p = await open();
  await pick(p, F.zip);
  R.zipOffersTheImportDialog = (await p.locator('.bundle-card').count()) > 0;

  p = await open();
  const b4 = await counts(p);
  await p.locator('[aria-label="Insert"]').click();
  const chooser = p.waitForEvent('filechooser');
  await p.getByText('Open a file…').click();
  await (await chooser).setFiles(F.txt);
  const seen = new Set();
  for (let i = 0; i < 12; i++) {
    for (const t of await toasts(p)) seen.add(t);
    await p.waitForTimeout(250);
  }
  R.unsupportedFileIsSaidOutLoud = [...seen].some((t) => /can’t open “readme\.txt”/.test(t));
  R.unsupportedFileImportsNothing = JSON.stringify(await counts(p)) === JSON.stringify(b4);

  p = await open();
  await pick(p, [F.md, F.png]);
  const both = await counts(p);
  R.severalFilesAtOnce = both.md === base.md + 1 && both.images === base.images + 1;

  R.noErrors = errors.length === 0;
  await browser.close();
  const bad = Object.entries(R).filter(([, v]) => !v).map(([k]) => k);
  console.log(`${engine}: ${bad.length ? 'FAIL' : 'ok'}`, bad.length ? bad : '', errors.length ? errors : '');
  if (bad.length) fails.push(engine);
}
process.exit(fails.length ? 1 : 0);
