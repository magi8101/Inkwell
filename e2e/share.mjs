// Encrypted read-only share links against the local Worker.
// Usage: npm run web:build && npx wrangler dev --port 8787 (other terminal), then npm run e2e:share
import { chromium } from 'playwright';

const URL = process.env.INKWELL_LIVE_URL ?? 'http://127.0.0.1:8787/';
const browser = await chromium.launch();
const errors = [];
const open = async (url = URL) => {
  const p = await (await browser.newContext({ viewport: { width: 1280, height: 860 } })).newPage();
  p.on('pageerror', (e) => errors.push(e.message));
  await p.goto(url);
  await p.waitForSelector('#toolbar .tb-btn');
  return p;
};
const R = {};
const a = await open();
for (let k = 0; k < 3; k++) {
  await a.mouse.move(400, 300 + k * 40);
  await a.mouse.down();
  for (let i = 1; i <= 20; i++) await a.mouse.move(400 + i * 12, 300 + k * 40 + (i % 4) * 6);
  await a.mouse.up();
}
let upload = null;
a.on('request', (r) => {
  if (r.method() === 'POST' && r.url().endsWith('/api/share')) upload = r.postDataBuffer();
});
await a.keyboard.press('Control+e');
await a.getByText('Share a read-only link…').click();
await a.getByText('Create a read-only link').click();
const box = a.locator('.share-url');
await box.waitFor({ timeout: 15000 });
const link = await box.inputValue();
R.link = /\/s\/[a-z2-9]{12}#[\w-]+$/.test(link);
R.uploadOpaque = !!upload && upload.length > 100 && !upload.toString('latin1').includes('"strokes"');

const b = await open(link);
await b.waitForSelector('.share-canvas', { timeout: 15000 });
await b.waitForTimeout(500);
R.viewer = await b.locator('.share-badge').innerText();
R.inked = await b.evaluate(() => {
  const c = document.querySelector('.share-canvas');
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let dark = 0;
  for (let i = 0; i < d.length; i += 4) if (d[i] < 100 && d[i + 3] > 0) dark++;
  return dark > 200;
});
R.copyMade = await (async () => {
  await b.getByText('Keep a copy in Inkwell').click();
  await b.waitForSelector('.share-view', { state: 'detached' });
  return true;
})();

const wrong = await open(link.replace(/#.*/, '#AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'));
await wrong.waitForSelector('.share-msg');
R.wrongKey = (await wrong.locator('.share-msg p').innerText()).includes('Couldn’t open');
const none = await open(link.replace(/#.*/, ''));
await none.waitForSelector('.share-msg');
R.noKey = (await none.locator('.share-msg p').innerText()).includes('incomplete');

await a.getByText('Delete', { exact: true }).click();
await a.waitForTimeout(800);
const gone = await open(link);
await gone.waitForSelector('.share-msg');
const msg = await gone.locator(".share-msg p").innerText(); console.log(msg); R.deleted = msg.includes("expired or was deleted");

console.log(R, errors);
await browser.close();
if (errors.length || Object.values(R).some((v) => v === false || v === 'Read-only' ? false : !v)) process.exit(1);
