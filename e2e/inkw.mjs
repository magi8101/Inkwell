// Save a page / a whole notebook (locked) as .inkw in one browser and open it in a fresh one, in
// Chromium, Firefox and WebKit. Usage: npm run web:build && npx vite preview --port 4173, then npm run e2e:inkw
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, firefox, webkit } from 'playwright';

const URL = process.env.INKWELL_URL ?? 'http://localhost:4173/';
const dir = mkdtempSync(join(tmpdir(), 'inkw-e2e-'));
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
writeFileSync(join(dir, 'dot.png'), png);
writeFileSync(join(dir, 'notes.txt'), 'not an inkw');
writeFileSync(join(dir, 'fake.inkw'), 'PK this is not really one');
const fails = [];

for (const [name, type] of [['Chromium', chromium], ['Firefox', firefox], ['WebKit', webkit]]) {
  const browser = await type.launch();
  const errors = [];
  const R = {};
  const open = async () => {
    const p = await (await browser.newContext({ viewport: { width: 1280, height: 860 }, acceptDownloads: true })).newPage();
    p.setDefaultTimeout(15000);
    p.on('pageerror', (e) => errors.push(e.message));
    await p.goto(URL);
    await p.waitForSelector('#toolbar .tb-btn');
    return p;
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
            if (!s) return res({ notebooks: 1, pages: 1, strokes: 0, images: 0 });
            const pages = s.notebooks.flatMap((n) => n.sections.flatMap((x) => x.pages));
            res({ notebooks: s.notebooks.length, pages: pages.length, strokes: pages.reduce((n, q) => n + q.strokes.length, 0), images: pages.reduce((n, q) => n + q.images.length, 0) });
          };
        };
      });
    });
  const save = async (p, scope, password) => {
    await p.keyboard.press('Control+e');
    await p.getByText('Save as .inkw (page, folder or notebook)…').click();
    await p.waitForSelector('[aria-label="Save as .inkw"]');
    await p.locator('[aria-label="Save as .inkw"] .seg', { hasText: scope }).click();
    if (password) await p.fill('[aria-label="Save as .inkw"] input[type=password]', password);
    const [dl] = await Promise.all([p.waitForEvent('download'), p.locator('[aria-label="Save as .inkw"] .primary').click()]);
    const path = join(dir, `${scope.replace(/\W/g, '')}-${password ? 'locked' : 'plain'}-${dl.suggestedFilename()}`);
    await dl.saveAs(path);
    return { path, name: dl.suggestedFilename() };
  };
  const openFile = async (p, path, password) => {
    await p.locator('[aria-label="Insert"]').click();
    const chooser = p.waitForEvent('filechooser');
    await p.getByText('Inkwell file (.inkw)…').click();
    await (await chooser).setFiles(path);
    if (password !== undefined) {
      await p.waitForSelector('input[type=password]');
      await p.fill('input[type=password]', password);
      await p.keyboard.press('Enter');
    }
    await p.waitForTimeout(1500);
  };

  const a = await open();
  for (let k = 0; k < 3; k++) {
    await a.mouse.move(400, 300 + k * 40);
    await a.mouse.down();
    for (let i = 1; i <= 15; i++) await a.mouse.move(400 + i * 12, 300 + k * 40 + (i % 3) * 5);
    await a.mouse.up();
  }
  await a.setInputFiles('input[accept="image/*"] >> nth=0', join(dir, 'dot.png'));
  await a.waitForTimeout(600);
  R.sourceHasInk = (await counts(a)).strokes === 3 && (await counts(a)).images === 1;

  // One page: it opens as one new page after the current one.
  const pageFile = await save(a, 'This page');
  R.pageFileNamed = pageFile.name.endsWith('.inkw');
  const b = await open();
  const b0 = await counts(b);
  await openFile(b, pageFile.path);
  const b1 = await counts(b);
  R.pageOpensAsOnePage = b1.pages === b0.pages + 1 && b1.notebooks === b0.notebooks && b1.strokes === 3 && b1.images === 1;

  // Everything, locked: wrong password imports nothing, the right one adds a notebook.
  const lockedFile = await save(a, 'Everything', 'sesame');
  const c = await open();
  const c0 = await counts(c);
  await openFile(c, lockedFile.path, 'wrong');
  R.wrongPasswordImportsNothing = (await counts(c)).notebooks === c0.notebooks;
  await openFile(c, lockedFile.path, 'sesame');
  const c1 = await counts(c);
  R.lockedOpensAsNotebook = c1.notebooks === c0.notebooks + 1 && c1.strokes === 3 && c1.images === 1;

  // Things that are not .inkw files are refused with a message and import nothing.
  const d = await open();
  const d0 = await counts(d);
  for (const f of ['notes.txt', 'fake.inkw']) await openFile(d, join(dir, f));
  R.notInkwImportsNothing = JSON.stringify(await counts(d)) === JSON.stringify(d0);

  R.noErrors = errors.length === 0;
  await browser.close();
  const bad = Object.entries(R).filter(([, v]) => !v).map(([k]) => k);
  console.log(`${name}: ${bad.length ? 'FAIL' : 'ok'}`, bad.length ? bad : '', errors);
  if (bad.length) fails.push(name);
}
process.exit(fails.length ? 1 : 0);
