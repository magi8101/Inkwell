// Files dropped anywhere in the window (the sidebar included) are taken by Inkwell, not opened by the
// browser. Uses Chromium's own drag pipeline with real files from disk, not synthetic DOM events.
// Usage: npm run web:build && npx vite preview --port 4173, then npm run e2e:drop
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zipSync } from 'fflate';
import { chromium } from 'playwright';

const URL = process.env.INKWELL_URL ?? 'http://localhost:4173/';
const dir = mkdtempSync(join(tmpdir(), 'inkwell-drop-'));
const zip = join(dir, 'notes.zip');
writeFileSync(zip, zipSync({ 'notes/a.md': new TextEncoder().encode('# A\n') }));
const md = join(dir, 'dropped.md');
writeFileSync(md, '# Dropped note\n');
const png = join(dir, 'dot.png');
writeFileSync(png, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));

const browser = await chromium.launch();
const R = {};
const errors = [];
const fresh = async () => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errors.push(e.message));
  await p.goto(URL);
  await p.waitForSelector('#toolbar .tb-btn');
  // Records whether the page ever saw a drop (the browser only sends one when dragover was accepted).
  await p.evaluate(() => {
    window.__drops = 0;
    addEventListener('drop', () => window.__drops++);
  });
  return { ctx, p, cdp: await ctx.newCDPSession(p) };
};
const drop = async (cdp, file, x, y) => {
  const data = { items: [], files: [file], dragOperationsMask: 1 };
  for (const type of ['dragEnter', 'dragOver', 'drop']) await cdp.send('Input.dispatchDragEvent', { type, x, y, data });
};
const spots = { 'page area': [800, 450], 'sidebar list': [120, 300], 'sidebar top': [120, 40], 'sidebar bottom': [120, 800] };

for (const [name, [x, y]] of Object.entries(spots)) {
  const t = await fresh();
  await drop(t.cdp, zip, x, y);
  await t.p.waitForTimeout(1200);
  R[`zip on ${name} opens the import dialog`] = (await t.p.locator('.bundle-card').count()) > 0;
  await t.ctx.close();

  const m = await fresh();
  const before = await m.p.locator('.sb-page, [data-page-id]').count();
  await drop(m.cdp, md, x, y);
  await m.p.waitForTimeout(1500);
  const isNote = await m.p.evaluate(() => !!document.querySelector('#md:not([hidden]) .tiptap'));
  R[`.md on ${name} becomes a note`] = isNote || (await m.p.locator('.sb-page, [data-page-id]').count()) > before;
  await m.ctx.close();

  const i = await fresh();
  await drop(i.cdp, png, x, y);
  await i.p.waitForTimeout(1200);
  R[`picture on ${name} is not left to the browser`] = (await i.p.evaluate(() => window.__drops)) === 1;
  await i.ctx.close();
}

// A drag of something that is not a file (text, a link) is left alone.
{
  const t = await fresh();
  const claimed = await t.p.evaluate(() => {
    const dt = new DataTransfer();
    dt.setData('text/plain', 'just words');
    const e = new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true, clientX: 800, clientY: 450 });
    document.body.dispatchEvent(e);
    return e.defaultPrevented;
  });
  R['a text drag is not claimed'] = claimed === false;
  await t.ctx.close();
}

R.noErrors = errors.length === 0;
await browser.close();
const bad = Object.entries(R).filter(([, v]) => !v).map(([k]) => k);
console.log(bad.length ? `FAIL (${bad.length} of ${Object.keys(R).length}):` : `ok (${Object.keys(R).length} checks)`);
for (const k of bad) console.log('  ✗', k);
process.exit(bad.length ? 1 : 0);
