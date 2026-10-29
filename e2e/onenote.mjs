// Opens a real OneNote section (.one) through Insert → OneNote section in Chromium, Firefox, WebKit and
// the iPad profile, and checks what came in. The sample is the maintainer's own file and is not in the
// repository: point ONE_FILE at any .one file (with ONE_EXPECT="pages,strokes,images") or leave it
// out and this test is skipped. Usage: npm run web:build && npx vite preview --port 4173, then npm run e2e:onenote
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zipSync } from 'fflate';
import { fileURLToPath } from 'node:url';
import { chromium, firefox, webkit } from 'playwright';

const URL = process.env.INKWELL_URL ?? 'http://localhost:4173/';
const FILE = process.env.ONE_FILE ?? fileURLToPath(new globalThis.URL('../Unit 4.one', import.meta.url));
const [pages, strokes, images] = (process.env.ONE_EXPECT ?? '1,1014,2').split(',').map(Number);
if (!existsSync(FILE)) {
  console.log(`OneNote sample not found (${FILE}): skipped`);
  process.exit(0);
}
const name = FILE.split('/').pop().replace(/\.one$/i, '');
const fails = [];
// A zip of a folder holding the section and a note: picked with Insert → Zip file, then Import.
const zipPath = join(mkdtempSync(join(tmpdir(), 'inkwell-one-')), 'FLA.zip');
writeFileSync(zipPath, zipSync({ 'FLA/Section.one': new Uint8Array(readFileSync(FILE)), 'FLA/readme.md': new TextEncoder().encode('# Hello\n') }));
// An empty OneNote section (optional, ONE_EMPTY): the message must be plain advice, not a parser error.
const EMPTY = process.env.ONE_EMPTY;
for (const [engine, type, opts] of [
  ['Chromium', chromium, {}],
  ['Firefox', firefox, {}],
  ['WebKit', webkit, {}],
  ['WebKit iPad', webkit, { viewport: { width: 1024, height: 1366 }, hasTouch: true, isMobile: true }],
]) {
  const browser = await type.launch();
  const errors = [];
  let got = null;
  try {
    const p = await (await browser.newContext({ viewport: { width: 1280, height: 860 }, ...opts })).newPage();
    p.on('pageerror', (e) => errors.push(e.message.slice(0, 160)));
    await p.goto(URL);
    await p.waitForSelector('#toolbar .tb-btn', { timeout: 20000 });
    await p.locator('[aria-label="Insert"]').click();
    const chooser = p.waitForEvent('filechooser');
    await p.getByText('OneNote section (.one)…').click();
    await (await chooser).setFiles(FILE);
    for (let i = 0; i < 60 && !got; i++) {
      await p.waitForTimeout(1000);
      got = await p.evaluate(async (title) => {
        dispatchEvent(new Event('pagehide'));
        await new Promise((r) => setTimeout(r, 150));
        return new Promise((done) => {
          const rq = indexedDB.open('inkwell');
          rq.onsuccess = () => {
            const g = rq.result.transaction('kv').objectStore('kv').get('inkwell:state');
            g.onsuccess = () => {
              const sec = g.result?.notebooks.flatMap((n) => n.sections).find((x) => x.name === title);
              done(sec ? { pages: sec.pages.length, strokes: sec.pages.reduce((n, q) => n + q.strokes.length, 0), images: sec.pages.reduce((n, q) => n + q.images.length, 0) } : null);
            };
          };
        });
      }, name);
    }
  } catch (e) {
    errors.push(e.message.split('\n')[0]);
  }
  let bundleOk = false;
  let emptyOk = !EMPTY || !existsSync(EMPTY);
  try {
    const p = await (await browser.newContext({ viewport: { width: 1280, height: 860 }, ...opts })).newPage();
    p.on('pageerror', (e) => errors.push(e.message.slice(0, 160)));
    await p.goto(URL);
    await p.waitForSelector('#toolbar .tb-btn', { timeout: 20000 });
    await p.locator('[aria-label="Insert"]').click();
    const chooser = p.waitForEvent('filechooser');
    await p.getByText('Zip file (notes, PDFs, pictures)…').click();
    await (await chooser).setFiles(zipPath);
    await p.getByRole('button', { name: 'Import', exact: true }).click({ timeout: 15000 });
    for (let i = 0; i < 40 && !bundleOk; i++) {
      await p.waitForTimeout(500);
      bundleOk = await p.evaluate(async () => {
        dispatchEvent(new Event('pagehide'));
        await new Promise((r) => setTimeout(r, 150));
        return new Promise((done) => {
          const rq = indexedDB.open('inkwell');
          rq.onsuccess = () => {
            const g = rq.result.transaction('kv').objectStore('kv').get('inkwell:state');
            g.onsuccess = () => {
              const secs = g.result?.notebooks.flatMap((n) => n.sections) ?? [];
              const one = secs.find((x) => x.name === 'Section');
              const note = secs.find((x) => x.name === 'FLA');
              done(!!one && one.pages.some((q) => q.strokes.length > 0) && !!note && note.pages.some((q) => q.md !== undefined));
            };
          };
        });
      });
    }
    if (EMPTY && existsSync(EMPTY)) {
      const q = await (await browser.newContext({ viewport: { width: 1280, height: 860 }, ...opts })).newPage();
      await q.goto(URL);
      await q.waitForSelector('#toolbar .tb-btn', { timeout: 20000 });
      await q.locator('[aria-label="Insert"]').click();
      const c2 = q.waitForEvent('filechooser');
      await q.getByText('OneNote section (.one)…').click();
      await (await c2).setFiles(EMPTY);
      const seen = new Set();
      for (let i = 0; i < 30; i++) {
        for (const t of await q.locator('.toast').allInnerTexts()) seen.add(t);
        await q.waitForTimeout(300);
      }
      emptyOk = [...seen].some((t) => /empty OneNote section/.test(t) && !/root_file_node_list/.test(t));
    }
  } catch (e) {
    errors.push(`bundle: ${e.message.split('\n')[0]}`);
  }
  await browser.close();
  const ok = bundleOk && emptyOk && got && got.pages === pages && got.strokes === strokes && got.images === images && !errors.length;
  console.log(`${engine}: ${ok ? 'ok' : 'FAIL'}`, got ? JSON.stringify(got) : 'nothing imported', `zip ${bundleOk ? 'ok' : 'FAILED'}`, EMPTY ? `empty message ${emptyOk ? 'ok' : 'FAILED'}` : '', errors.length ? errors : '');
  if (!ok) fails.push(engine);
}
process.exit(fails.length ? 1 : 0);
