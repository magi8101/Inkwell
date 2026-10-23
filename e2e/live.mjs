// Live sessions with two separate browsers (creator and guest) against the Worker.
// Usage: npm run web:build && npx wrangler dev --port 8787 (in another terminal), then npm run e2e:live
import { chromium } from 'playwright';

const URL = process.env.INKWELL_LIVE_URL ?? 'http://127.0.0.1:8787/';
const browser = await chromium.launch();
const open = async () => {
  const p = await (await browser.newContext({ viewport: { width: 1280, height: 860 } })).newPage();
  p.on('pageerror', (e) => errors.push(e.message));
  await p.goto(URL);
  await p.waitForSelector('#toolbar .tb-btn');
  return p;
};
const errors = [];
const R = {};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Strokes on the page that's open, as stored. */
const strokesOf = (p) =>
  p.evaluate(async () => {
    dispatchEvent(new Event('pagehide'));
    await new Promise((r) => setTimeout(r, 100));
    return new Promise((resolve) => {
      const req = indexedDB.open('inkwell');
      req.onsuccess = () => {
        const g = req.result.transaction('kv').objectStore('kv').get('inkwell:state');
        g.onsuccess = () => {
          const s = g.result;
          const pages = s.notebooks.flatMap((n) => n.sections.flatMap((x) => x.pages));
          resolve(pages.find((pg) => pg.id === s.pageId).strokes.length);
        };
      };
    });
  });
const draw = async (p, y) => {
  await p.mouse.move(400, y);
  await p.mouse.down();
  for (let i = 1; i <= 15; i++) await p.mouse.move(400 + i * 15, y + (i % 3) * 4);
  await p.mouse.up();
};
const openLive = (p) => p.click('[aria-label="Live session"]');

const host = await open();
await draw(host, 300);
await openLive(host);
await host.click('text=Start a live session');
await host.waitForFunction(() => document.querySelector('.live-code output')?.textContent?.length === 7);
const code = await host.textContent('.live-code output');
R.codeShown = /^[A-Z2-9]{3}-[A-Z2-9]{3}$/.test(code);
await host.keyboard.press('Escape');

const guest = await open();
await openLive(guest);
await guest.fill('.live-input', code.replace('-', '').toLowerCase()); // forgiving input
await guest.click('.live-panel .cal-btn');
await guest.waitForFunction(() => document.querySelector('.live-panel .panel-title')?.textContent === 'Live session' && document.querySelectorAll('.live-people li').length === 2, null, { timeout: 10000 });
const names = await guest.$$eval('.live-people li', (lis) => lis.map((l) => l.textContent));
R.anonymousNames = names.length === 2 && names.every((n) => /^[A-Z][a-z]+ [A-Z][a-z]+/.test(n)) && names.some((n) => n.includes('creator'));
await guest.keyboard.press('Escape');
await wait(500);
R.guestGetsCopy = (await strokesOf(guest)) === 1 && (await guest.$$eval('.row.section', (r) => r.some((x) => x.textContent.includes('Live sessions'))));

await draw(guest, 420);
await wait(800);
R.guestInkReachesCreator = (await strokesOf(host)) === 2;
await draw(host, 520);
await wait(800);
R.creatorInkReachesGuest = (await strokesOf(guest)) === 3;

// The guest's undo takes back only the guest's own stroke, for everyone.
await guest.keyboard.press('Control+z');
await wait(800);
R.undoIsPersonal = (await strokesOf(host)) === 2 && (await strokesOf(guest)) === 2;

await host.mouse.move(700, 600);
await host.mouse.move(720, 610);
await wait(500);
R.cursorsShown = await guest.$$eval('.live-cursor', (c) => c.length === 1 && !c[0].hidden);

// Code blocks are shared: one added and typed into by the creator appears for the guest, and the
// guest's edit reaches the creator.
await host.click('[aria-label="Insert"]');
await host.getByText('Code block (runs on Compiler Explorer)').click();
await host.waitForSelector('.codeblock');
await host.fill('.codeblock .code-src', 'print("from the creator")');
await host.locator('.codeblock .code-src').blur();
await guest.waitForSelector('.codeblock', { timeout: 10000 });
await wait(800);
R.codeBlockReachesGuest = (await guest.inputValue('.codeblock .code-src')) === 'print("from the creator")';
await guest.fill('.codeblock .code-src', 'print("from the guest")');
await guest.locator('.codeblock .code-src').blur();
await wait(1000);
R.codeEditReachesCreator = (await host.inputValue('.codeblock .code-src')) === 'print("from the guest")';
await host.click('[aria-label="Delete code block"]');
await wait(900);
R.codeDeleteReachesGuest = (await guest.$$('.codeblock')).length === 0;

// Shapes are shared: the creator draws a rectangle with the Shapes tool and the guest gets it; when
// the creator moves it, the guest's copy moves too.
const shapesOf = (p) =>
  p.evaluate(async () => {
    dispatchEvent(new Event('pagehide'));
    await new Promise((r) => setTimeout(r, 100));
    return new Promise((resolve) => {
      const req = indexedDB.open('inkwell');
      req.onsuccess = () => {
        const g = req.result.transaction('kv').objectStore('kv').get('inkwell:state');
        g.onsuccess = () => {
          const s = g.result;
          const pages = s.notebooks.flatMap((n) => n.sections.flatMap((x) => x.pages));
          resolve(pages.find((pg) => pg.id === s.pageId).shapes ?? []);
        };
      };
    });
  });
await host.locator('[aria-label="Shapes"]').first().click();
await host.locator('.shape-panel [aria-label="Rectangle"]').click();
await host.keyboard.press('Escape');
await host.mouse.move(300, 600);
await host.mouse.down();
await host.mouse.move(380, 640, { steps: 4 });
await host.mouse.move(460, 680, { steps: 4 });
await host.mouse.up();
await wait(1000);
const gotShapes = await shapesOf(guest);
R.shapeReachesGuest = gotShapes.length === 1 && gotShapes[0].kind === 'rect';
const first = (await shapesOf(host))[0];
await host.mouse.move(380, 640); // the lasso is active with the new shape selected: drag its frame
const frame = await host.locator('.sel-frame').boundingBox();
await host.mouse.move(frame.x + frame.width / 2, frame.y + frame.height / 2);
await host.mouse.down();
await host.mouse.move(frame.x + frame.width / 2 + 100, frame.y + frame.height / 2, { steps: 5 });
await host.mouse.up();
await wait(1000);
const movedOnGuest = (await shapesOf(guest))[0];
R.shapeMoveReachesGuest = !!movedOnGuest && Math.abs(movedOnGuest.cx - first.cx - 100) < 5;

// The creator leaves: the session ends, and the guest keeps the note.
await openLive(host);
await host.click('text=End session for everyone');
await wait(1000);
R.sessionEndsForGuest = await guest.evaluate(() => !document.querySelector('[aria-label="Live session"]').classList.contains('live-on'));
R.guestKeepsCopy = (await strokesOf(guest)) === 2;

// Markdown notes are shared: a second session on a note; typing on either side reaches the other.
await host.click('[aria-label="New Markdown note"]');
await host.waitForSelector('.md-doc', { timeout: 15000 });
await host.click('.md-doc');
await host.keyboard.type('# Shared note');
await wait(900);
await openLive(host);
await host.click('text=Start a live session');
await host.waitForFunction(() => document.querySelector('.live-code output')?.textContent?.length === 7);
const code2 = await host.textContent('.live-code output');
await host.keyboard.press('Escape');
const guest2 = await open();
await openLive(guest2);
await guest2.fill('.live-input', code2.replace('-', '').toLowerCase());
await guest2.click('.live-panel .cal-btn');
await guest2.waitForSelector('.md-doc', { timeout: 15000 });
await guest2.keyboard.press('Escape');
await wait(500);
R.mdNoteReachesGuest = (await guest2.textContent('.md-doc')).includes('Shared note');
await host.click('.md-doc');
await host.keyboard.press('Control+End');
await host.keyboard.type(' from host');
await guest2.waitForFunction(() => document.querySelector('.md-doc')?.textContent.includes('from host'), null, { timeout: 10000 });
R.mdHostTypingReachesGuest = true;
await guest2.click('.md-doc');
await guest2.keyboard.press('Control+End');
await guest2.keyboard.type(' and guest');
await host.waitForFunction(() => document.querySelector('.md-doc')?.textContent.includes('and guest'), null, { timeout: 10000 });
R.mdGuestTypingReachesHost = true;

// A wrong code is refused with a clear message.
await openLive(guest);
await guest.fill('.live-input', 'ZZZ-ZZZ');
await guest.click('.live-panel .cal-btn');
await wait(1500);
R.wrongCodeRefused = (await guest.textContent('body')).includes('No live session with code ZZZ-ZZZ');

await browser.close();
const bad = Object.entries(R).filter(([, v]) => !v);
for (const [k, v] of Object.entries(R)) console.log(`  ${v ? '✓' : '✗'} ${k}`);
for (const e of errors) console.log(`  ! ${e}`);
process.exit(bad.length || errors.length ? 1 : 0);
