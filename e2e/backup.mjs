// Back up everything and restore it into a fresh browser, plain and locked, in Chromium.
// Usage: npm run web:build && npx vite preview --port 4173, then npm run e2e:backup
import { chromium } from 'playwright';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL = process.env.INKWELL_URL ?? 'http://localhost:4173/';
const browser = await chromium.launch();
const errors = [];
const open = async () => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, acceptDownloads: true });
  const p = await ctx.newPage();
  p.setDefaultTimeout(10000);
  p.on('pageerror', (e) => errors.push(e.message));
  await p.goto(URL);
  await p.waitForSelector('#toolbar .tb-btn');
  return p;
};
const R = {};
const dir = mkdtempSync(join(tmpdir(), 'inkwell-backup-'));
// A tiny PNG to be the page's picture.
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
writeFileSync(join(dir, 'dot.png'), png);

const a = await open();
for (let k = 0; k < 3; k++) {
  await a.mouse.move(400, 300 + k * 40);
  await a.mouse.down();
  for (let i = 1; i <= 15; i++) await a.mouse.move(400 + i * 12, 300 + k * 40 + (i % 3) * 5);
  await a.mouse.up();
}
await a.setInputFiles('input[accept="image/*"] >> nth=0', join(dir, 'dot.png'));
await a.waitForTimeout(500);

const say = (m) => console.error('·', m);
const about = async (p) => {
  say('about');
  await p.locator('[aria-label="Pen feel and palm settings"]').click();
  await p.waitForTimeout(150);
  await p.getByText('About Inkwell', { exact: false }).first().click().catch(() => {});
  await p.waitForSelector('.cal-card');
};
const backup = async (p, password) => {
  say('backup');
  await about(p);
  await p.getByText('Back up everything…').click();
  await p.waitForSelector('input[type=password]');
  if (password) await p.fill('input[type=password]', password);
  const [dl] = await Promise.all([p.waitForEvent('download'), p.getByText('Continue').click()]);
  const path = join(dir, `${password ? 'locked' : 'plain'}-${dl.suggestedFilename()}`);
  await dl.saveAs(path);
  return path;
};
const plain = await backup(a, '');
R.plainBackupNamed = plain.endsWith('.inkw');
await a.keyboard.press('Escape');
await a.reload();
await a.waitForSelector('#toolbar .tb-btn');
const locked = await backup(a, 'sesame');
R.lockedHidesNames = !require_includes(locked, 'Quick Notes');
function require_includes(path, text) {
  return Buffer.from(Buffer.from(readFileSync(path))).includes(text);
}

const counts = (p) =>
  p.evaluate(async () => {
    dispatchEvent(new Event('pagehide'));
    await new Promise((r) => setTimeout(r, 150));
    return new Promise((res) => {
      const rq = indexedDB.open('inkwell');
      rq.onsuccess = () => {
        const g = rq.result.transaction('kv').objectStore('kv').get('inkwell:state');
        g.onsuccess = () => {
          const s = g.result;
          if (!s) return res({ notebooks: 1, strokes: 0, images: 0 }); // nothing was ever changed or saved
          const pages = s.notebooks.flatMap((n) => n.sections.flatMap((x) => x.pages));
          res({ notebooks: s.notebooks.length, strokes: pages.reduce((n, q) => n + q.strokes.length, 0), images: pages.reduce((n, q) => n + q.images.length, 0), blobs: 0 });
        };
      };
    });
  });
R.sourceHasInk = (await counts(a)).strokes === 3 && (await counts(a)).images === 1;

const restore = async (p, path, password) => {
  say('restore');
  await about(p);
  const chooser = p.waitForEvent('filechooser');
  await p.getByText('Restore from a backup…').click();
  await (await chooser).setFiles(path);
  if (password !== undefined) {
    await p.waitForSelector('input[type=password]');
    await p.fill('input[type=password]', password);
    await p.keyboard.press('Enter');
  }
  await p.waitForTimeout(1500);
};
const b = await open();
await restore(b, plain);
say('count');
const afterPlain = await counts(b);
say(JSON.stringify(afterPlain));
R.plainRestoresInk = afterPlain.notebooks === 2 && afterPlain.strokes === 3 && afterPlain.images === 1;
const c = await open();
await restore(c, locked, 'sesame');
say('count locked');
const afterLocked = await counts(c);
say(JSON.stringify(afterLocked));
R.lockedRestoresInk = afterLocked.notebooks === 2 && afterLocked.strokes === 3 && afterLocked.images === 1;
const d = await open();
await restore(d, locked, 'wrong');
say('count wrong');
R.wrongPasswordRestoresNothing = (await counts(d)).notebooks === 1;

// A backup made before backups became .inkw files still restores (picked by content, not name).
const e = await open();
const legacyPath = new globalThis.URL('../docs/inkw-golden/legacy.inkbackup', import.meta.url).pathname;
await restore(e, legacyPath);
const afterLegacy = await counts(e);
R.legacyBackupRestores = afterLegacy.notebooks === 2 && afterLegacy.strokes === 6;

R.noErrors = errors.length === 0;
console.log(R, errors);
await browser.close();
if (Object.values(R).some((v) => !v)) process.exit(1);
