// The Shapes tool in Chromium, Firefox and WebKit: drawing each kind, arrows binding to shapes and
// following them, undo/redo, copy/paste, the stroke eraser, locking, arrange, and PDF export.
// Usage: npm run web:build && npm run preview (another terminal), then npm run e2e:shapes
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
  const shapes = () =>
    p.evaluate(async () => {
      dispatchEvent(new Event('pagehide'));
      await new Promise((r) => setTimeout(r, 150));
      return new Promise((res) => {
        const q = indexedDB.open('inkwell');
        q.onsuccess = () => {
          const g = q.result.transaction('kv').objectStore('kv').get('inkwell:state');
          g.onsuccess = () => {
            const s = g.result;
            res(s.notebooks.flatMap((n) => n.sections).flatMap((x) => x.pages).find((x) => x.id === s.pageId).shapes ?? []);
          };
        };
      });
    });
  const drag = async (x1, y1, x2, y2) => {
    await p.mouse.move(x1, y1);
    await p.mouse.down();
    await p.mouse.move((x1 + x2) / 2, (y1 + y2) / 2, { steps: 3 });
    await p.mouse.move(x2, y2, { steps: 3 });
    await p.mouse.up();
    await p.waitForTimeout(150);
  };
  const pick = async (label) => {
    await p.locator('[aria-label="Shapes"]').first().click();
    await p.waitForTimeout(120);
    await p.locator(`.shape-panel [aria-label="${label}"]`).click();
    await p.keyboard.press('Escape');
    await p.waitForTimeout(100);
  };
  const loop = async (cx, cy, rx, ry) => {
    await p.keyboard.press('l');
    await p.mouse.move(cx - rx, cy - ry);
    await p.mouse.down();
    for (const [x, y] of [[cx + rx, cy - ry], [cx + rx, cy + ry], [cx - rx, cy + ry], [cx - rx, cy - ry + 2]]) await p.mouse.move(x, y, { steps: 4 });
    await p.mouse.up();
    await p.waitForTimeout(200);
  };
  const menu = async (bar, item) => {
    await p.locator(`.selbar [aria-label="${bar}"]`).click();
    await p.waitForTimeout(150);
    await p.locator('.menu .menu-item', { hasText: item }).first().click();
    await p.waitForTimeout(250);
  };

  // Every kind; the arrow starts in the rectangle and ends in the ellipse, so it binds to both.
  await pick('Rectangle');
  await drag(300, 250, 500, 350);
  R.drawsRect = (await shapes()).map((s) => s.kind).join() === 'rect';
  await pick('Ellipse');
  await drag(700, 250, 880, 350);
  await pick('Diamond');
  await drag(480, 520, 640, 640);
  await pick('Arrow');
  await drag(400, 300, 790, 300);
  await pick('Line');
  await drag(300, 700, 600, 700);
  let all = await shapes();
  R.drawsAllKinds = ['rect', 'ellipse', 'diamond', 'arrow', 'line'].every((k) => all.some((s) => s.kind === k));
  const rect = all.find((s) => s.kind === 'rect');
  const ellipse = all.find((s) => s.kind === 'ellipse');
  const arrow = all.find((s) => s.kind === 'arrow');
  R.arrowBindsBothEnds = arrow.bindStart === rect.id && arrow.bindEnd === ellipse.id;

  // Undo takes the last shape away; redo brings it back.
  await p.keyboard.press('Control+z');
  await p.waitForTimeout(200);
  R.undoRemovesShape = (await shapes()).length === 4;
  await p.keyboard.press('Control+y');
  await p.waitForTimeout(200);
  R.redoRestoresShape = (await shapes()).length === 5;

  // Moving the rectangle: it moves, the arrow keeps its binding (it follows when drawn).
  await p.keyboard.press('Escape');
  await loop(400, 300, 130, 90);
  const frame = await p.locator('.sel-frame').boundingBox();
  await p.mouse.move(frame.x + frame.width / 2, frame.y + frame.height / 2);
  await p.mouse.down();
  await p.mouse.move(frame.x + frame.width / 2, frame.y + frame.height / 2 + 120, { steps: 6 });
  await p.mouse.up();
  await p.waitForTimeout(250);
  all = await shapes();
  R.moveKeepsBinding = Math.round(all.find((s) => s.kind === 'rect').cy - rect.cy) === 120 && all.find((s) => s.kind === 'arrow').bindStart === rect.id;

  // Copy and paste duplicate it; the copy is a new shape.
  await p.keyboard.press('Control+c');
  await p.keyboard.press('Control+v');
  await p.waitForTimeout(400);
  all = await shapes();
  R.pasteDuplicates = all.length === 6 && new Set(all.map((s) => s.id)).size === 6;
  await p.keyboard.press('Control+z');
  await p.waitForTimeout(200);
  R.undoPaste = (await shapes()).length === 5;

  // Style from the selection bar.
  await p.keyboard.press('Escape');
  await loop(790, 300, 110, 75);
  await menu('Shape style', 'Hatched');
  R.styleHatch = (await shapes()).find((s) => s.kind === 'ellipse').fill === 'hatch';
  await menu('Shape style', 'Dashed line');
  R.styleDash = (await shapes()).find((s) => s.kind === 'ellipse').dash === 'dashed';

  // Arrange: group, lock. A locked shape can't be selected or erased.
  await p.keyboard.press('Escape');
  await loop(560, 580, 100, 90);
  await menu('Arrange', 'Group');
  R.grouped = !!(await shapes()).find((s) => s.kind === 'diamond').group;
  await menu('Arrange', 'Lock');
  R.locked = (await shapes()).find((s) => s.kind === 'diamond').locked === true;
  await loop(560, 580, 100, 90);
  R.lockedNotSelectable = await p.locator('.sel-frame').isHidden();
  await p.keyboard.press('e');
  await drag(470, 580, 650, 580);
  R.eraserSkipsLocked = (await shapes()).some((s) => s.kind === 'diamond');

  // The stroke eraser removes an unlocked shape it touches, and undo brings it back.
  const before = (await shapes()).length;
  await drag(280, 700, 620, 700);
  R.eraserRemovesLine = (await shapes()).length === before - 1 && !(await shapes()).some((s) => s.kind === 'line');
  await p.keyboard.press('Control+z');
  await p.waitForTimeout(250);
  R.undoEraser = (await shapes()).length === before;

  // Unlock from the Shapes panel.
  await p.locator('[aria-label="Shapes"]').first().click();
  await p.getByText(/Unlock all/).click();
  await p.waitForTimeout(250);
  R.unlocks = !(await shapes()).some((s) => s.locked);
  await p.keyboard.press('Escape');

  // The shortcut sheet opens with ? and closes with Escape.
  await p.keyboard.press('?');
  R.shortcutSheetOpens = await p.locator('[aria-label="Keyboard shortcuts"]').isVisible();
  R.shortcutSheetListsShapes = (await p.locator('[aria-label="Keyboard shortcuts"]').textContent()).includes('Shapes');
  await p.keyboard.press('Escape');
  R.shortcutSheetCloses = (await p.locator('[aria-label="Keyboard shortcuts"]').count()) === 0;

  // The eyedropper (its tap-to-sample path): draw a red stroke, switch to blue, pick the red back.
  await p.evaluate(() => {
    delete window.EyeDropper;
  });
  const penColor = () =>
    p.evaluate(async () => {
      dispatchEvent(new Event('pagehide'));
      await new Promise((r) => setTimeout(r, 150));
      return new Promise((res) => {
        const q = indexedDB.open('inkwell');
        q.onsuccess = () => {
          const g = q.result.transaction('kv').objectStore('kv').get('inkwell:state');
          g.onsuccess = () => res(g.result.styles.pen.color);
        };
      });
    });
  const colour = async (hexValue) => {
    await p.locator('[aria-label="Colour and size"]').click();
    await p.waitForTimeout(150);
    await p.locator(`.pal[data-color="${hexValue}"]`).click();
    await p.keyboard.press('Escape');
    await p.waitForTimeout(100);
  };
  await p.keyboard.press('p');
  await colour('#e5484d');
  await p.mouse.move(900, 780);
  await p.mouse.down();
  await p.mouse.move(960, 780, { steps: 5 });
  await p.mouse.move(1020, 780, { steps: 5 });
  await p.mouse.up();
  await colour('#0090ff');
  await p.locator('[aria-label="Colour and size"]').click();
  await p.waitForTimeout(150);
  await p.locator('[aria-label="Pick a colour from the page"]').click();
  await p.mouse.click(960, 780);
  await p.waitForTimeout(300);
  const picked = String(await penColor());
  const near = (a, b) => Math.abs(Number.parseInt(a, 16) - Number.parseInt(b, 16)) < 48;
  R.eyedropperPicksInk = near(picked.slice(1, 3), 'e5') && near(picked.slice(3, 5), '48') && near(picked.slice(5, 7), '4d');

  // PDF export carries the shapes as vector paths.
  await p.locator('[aria-label="Export"]').click();
  await p.waitForTimeout(250);
  const [dl] = await Promise.all([p.waitForEvent('download'), p.locator('.export-panel .primary').click()]);
  const path = await dl.path();
  const bytes = fs.readFileSync(path);
  R.pdfExports = bytes.slice(0, 5).toString() === '%PDF-' && bytes.length > 1500;
  if (name === 'Chromium') fs.copyFileSync(path, process.env.SHAPES_PDF ?? '/tmp/shapes-export.pdf');
  // Arrow head size: the next arrow takes the chosen size, and the selection menu can change it.
  await p.locator('[aria-label="Shapes"]').first().click();
  await p.waitForTimeout(120);
  await p.locator('.shape-panel [aria-label="Large"]').click();
  await p.keyboard.press('Escape');
  await pick('Arrow');
  await drag(300, 780, 560, 780);
  const bigArrow = (await shapes()).filter((s) => s.kind === 'arrow').at(-1);
  R.arrowHeadSizeChosen = bigArrow?.head === 1.6;
  await menu('Shape style', 'Huge arrow head');
  R.arrowHeadSizeEdited = (await shapes()).filter((s) => s.kind === 'arrow').at(-1)?.head === 2.4;
  await menu('Shape style', 'Normal arrow head');
  R.arrowHeadSizeReset = (await shapes()).filter((s) => s.kind === 'arrow').at(-1)?.head === undefined;
  R.noErrors = errors.length === 0;

  await browser.close();
  console.log(`${name}: ${Object.values(R).every(Boolean) ? 'ok' : 'FAIL'}`);
  for (const [k, v] of Object.entries(R)) if (!v) console.log(`  ✗ ${k}`);
  for (const e of errors) console.log(`  ! ${e}`);
  if (!Object.values(R).every(Boolean)) failed++;
}
process.exit(failed ? 1 : 0);
