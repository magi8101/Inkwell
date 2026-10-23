// Handwriting search: write block letters, turn "Search handwriting" on, wait for the on-device
// reader, search for the word. Needs internet once (Tesseract's language data comes from a CDN).
// Usage: npm run web:build && npm run preview (another terminal), then npm run e2e:ink
import { chromium } from 'playwright';

const URL = process.env.INKWELL_URL ?? 'http://localhost:4173/';
const b = await chromium.launch();
const p = await (await b.newContext({ viewport: { width: 1368, height: 912 } })).newPage();
const errors = [];
p.on('pageerror', (e) => errors.push(e.message));
await p.goto(URL);
await p.waitForSelector('#toolbar .tb-btn');
await p.evaluate(() => document.querySelector('[aria-label="Hide sidebar"]')?.click());

const stroke = async (pts) => {
  await p.mouse.move(pts[0][0], pts[0][1]);
  await p.mouse.down();
  for (const [x, y] of pts.slice(1)) await p.mouse.move(x, y, { steps: 4 });
  await p.mouse.up();
  await p.waitForTimeout(30);
};
// Big block capitals, 110 px tall, drawn as straight strokes (no pauses long enough to snap shapes).
const letter = async (ch, x, y) => {
  const h = 110, w = 70;
  if (ch === 'H') { await stroke([[x, y], [x, y + h]]); await stroke([[x + w, y], [x + w, y + h]]); await stroke([[x, y + h / 2], [x + w, y + h / 2]]); }
  if (ch === 'E') { await stroke([[x, y], [x, y + h]]); await stroke([[x, y], [x + w, y]]); await stroke([[x, y + h / 2], [x + w * 0.8, y + h / 2]]); await stroke([[x, y + h], [x + w, y + h]]); }
  if (ch === 'L') { await stroke([[x, y], [x, y + h]]); await stroke([[x, y + h], [x + w, y + h]]); }
  if (ch === 'O') { const pts = []; for (let i = 0; i <= 24; i++) { const a = (i / 24) * Math.PI * 2; pts.push([x + w / 2 + (Math.cos(a) * w) / 2, y + h / 2 + (Math.sin(a) * h) / 2]); } await stroke(pts); }
};
let x = 380;
for (const ch of 'HELLO') { await letter(ch, x, 300); x += 120; }

// Turn the setting on in Pen feel.
await p.locator('[aria-label="Pen feel and palm settings"]').click();
await p.locator('.tune-panel label.check', { hasText: 'Search handwriting' }).locator('input').check();
await p.keyboard.press('Escape');

const pageNow = () =>
  p.evaluate(async () => {
    dispatchEvent(new Event('pagehide'));
    await new Promise((r) => setTimeout(r, 150));
    return new Promise((res) => {
      const q = indexedDB.open('inkwell');
      q.onsuccess = () => {
        const g = q.result.transaction('kv').objectStore('kv').get('inkwell:state');
        g.onsuccess = () => {
          const s = g.result;
          res(s.notebooks.flatMap((n) => n.sections).flatMap((x) => x.pages).find((pg) => pg.id === s.pageId));
        };
      };
    });
  });
let pg = await pageNow();
for (let i = 0; i < 90 && !pg.inkText; i++) {
  await p.waitForTimeout(1000);
  pg = await pageNow();
}
console.log('read as:', JSON.stringify(pg.inkText));
const R = {};
R.readsSomething = !!pg.inkText && pg.inkText.length >= 3;
R.keepsSignature = !!pg.inkSig;
// Search finds the page by what was written.
await p.evaluate(() => document.querySelector('[aria-label="Show sidebar"]')?.click());
await p.fill('[aria-label="Search notes"]', 'hello');
await p.waitForTimeout(1500);
R.searchFindsHandwriting = (await p.locator('.row.result').count()) >= 1;
R.noErrors = errors.length === 0;
await b.close();
for (const [k, v] of Object.entries(R)) console.log(`  ${v ? '✓' : '✗'} ${k}`);
for (const e of errors) console.log(`  ! ${e}`);
process.exit(Object.values(R).every(Boolean) ? 0 : 1);
