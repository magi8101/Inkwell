// Cross-engine smoke test: runs the core features in Chromium, Firefox and WebKit (Safari's engine,
// also used by the macOS and Linux desktop apps), plus an iPad-sized WebKit with touch.
// Usage: npm run web:build && npm run preview (in another terminal), then npm run e2e
import { chromium, devices, firefox, webkit } from 'playwright';

const URL = process.env.INKWELL_URL ?? 'http://localhost:4173/';

// Runs inside the page. Uses synthetic pointer events; returns { check: boolean } plus errors.
async function suite() {
  const errors = [];
  addEventListener('error', (e) => errors.push(e.message));
  addEventListener('unhandledrejection', (e) => errors.push(String(e.reason)));
  const bg = document.querySelector('#bg');
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const pg = () => {
    dispatchEvent(new Event('pagehide')); // flush the idle autosave
    return JSON.parse(localStorage.getItem('inkwell:state')).notebooks[0].sections[0].pages[0];
  };
  const btn = (l) => document.querySelector(`[aria-label="${l}"]`);
  let pid = 100;
  const ev = (type, x, y, o = {}) =>
    bg.dispatchEvent(
      new PointerEvent(type, {
        pointerId: o.id ?? pid,
        pointerType: o.type ?? 'pen',
        clientX: x,
        clientY: y,
        button: type === 'pointermove' ? -1 : (o.button ?? 0),
        buttons: type === 'pointerup' ? 0 : (o.buttons ?? 1),
        pressure: 0.5,
        width: o.size ?? 1,
        height: o.size ?? 1,
        bubbles: true,
        cancelable: true,
      }),
    );
  const stroke = (pts, o = {}) => {
    pid++;
    ev('pointerdown', ...pts[0], o);
    for (const p of pts.slice(1)) ev('pointermove', ...p, o);
    ev('pointerup', ...pts.at(-1), o);
  };
  const line = (x0, y0, x1, y1, n = 20) =>
    Array.from({ length: n + 1 }, (_, i) => [x0 + ((x1 - x0) * i) / n, y0 + ((y1 - y0) * i) / n]);
  const R = {};
  btn('Pen').click();
  btn('Pen').click();
  stroke(line(400, 200, 700, 220));
  btn('Highlighter').click();
  stroke(line(400, 260, 700, 260));
  R.penAndHighlighter = pg().strokes.map((s) => s.tool).join(',') === 'pen,highlighter';
  // A frame later the wet layers must be clear again (strokes moved to the page).
  await wait(400);
  btn('Pen').click();
  pid++;
  const tri = [[450, 500], [530, 360], [610, 500], [452, 498]];
  ev('pointerdown', ...tri[0]);
  for (let i = 0; i < 3; i++) for (const p of line(...tri[i], ...tri[i + 1], 20).slice(1)) ev('pointermove', ...p);
  await wait(650);
  ev('pointerup', ...tri[3]);
  R.shapeSnapped = pg().strokes.at(-1).pressure === false && pg().strokes.length === 3;
  btn('Ruler and straight line').click();
  stroke(line(800, 300, 1000, 303));
  const rl = pg().strokes.at(-1).points;
  R.rulerLevel = Math.abs(rl[1] - rl.at(-2)) < 0.01;
  btn('Stroke eraser').click();
  stroke(line(900, 260, 900, 340));
  R.strokeEraser = pg().strokes.length === 3;
  btn('Pixel eraser').click();
  stroke(line(550, 170, 550, 240));
  R.pixelEraserSplit = pg().strokes.filter((s) => s.tool === 'pen' && s.pressure).length === 2;
  btn('Undo').click();
  R.undo = pg().strokes.filter((s) => s.tool === 'pen' && s.pressure).length === 1;
  btn('Redo').click();
  R.redo = pg().strokes.filter((s) => s.tool === 'pen' && s.pressure).length === 2;
  btn('Undo').click();
  btn('Text box').click();
  pid++;
  ev('pointerdown', 800, 450, { type: 'mouse' });
  ev('pointerup', 800, 450, { type: 'mouse' });
  document.execCommand('insertText', false, 'regression note');
  document.activeElement.blur();
  R.textBox = pg().texts.length === 1 && pg().texts[0].text === 'regression note';
  btn('Lasso select').click();
  stroke([[380, 180], [720, 180], [720, 290], [380, 290], [382, 182]], { type: 'mouse', id: 1 });
  const frame = document.querySelector('.sel-frame');
  const fr = frame.getBoundingClientRect();
  const before = pg().strokes[0].points[0];
  const F = (el, t, x, y) =>
    el.dispatchEvent(
      new PointerEvent(t, {
        pointerId: 1,
        pointerType: 'mouse',
        clientX: x,
        clientY: y,
        button: t === 'pointermove' ? -1 : 0,
        buttons: t === 'pointerup' ? 0 : 1,
        bubbles: true,
      }),
    );
  F(frame, 'pointerdown', fr.left + 20, fr.top + 20);
  F(frame, 'pointermove', fr.left + 70, fr.top + 20);
  F(frame, 'pointerup', fr.left + 70, fr.top + 20);
  R.lassoMoved = Math.round(pg().strokes[0].points[0] - before) === 50;
  // Resize from the top-left handle: the bottom-right corner must stay put.
  const nw = document.querySelector('.sel-handle.nw');
  const h = nw.getBoundingClientRect();
  const widthBefore = pg().strokes[0].width;
  F(nw, 'pointerdown', h.left + 14, h.top + 14);
  F(nw, 'pointermove', h.left - 40, h.top - 40);
  F(nw, 'pointerup', h.left - 40, h.top - 40);
  R.lassoResizeCorner = pg().strokes[0].width > widthBefore;
  btn('Undo').click();
  const n10 = pg().strokes.length;
  btn('Laser pointer').click();
  stroke(line(500, 600, 800, 650));
  R.laserNotSaved = pg().strokes.length === n10;
  btn('Pen').click();
  await wait(400);
  const x11 = pg().strokes[0].points[0];
  const T = (t, id, x) =>
    bg.dispatchEvent(
      new PointerEvent(t, {
        pointerId: id,
        pointerType: 'touch',
        clientX: x,
        clientY: 700,
        width: 40,
        height: 40,
        button: t === 'pointermove' ? -1 : 0,
        buttons: t === 'pointerup' ? 0 : 1,
        bubbles: true,
      }),
    );
  T('pointerdown', 301, 600);
  T('pointerdown', 302, 660);
  await wait(60);
  T('pointerup', 301, 600);
  T('pointerup', 302, 660);
  R.twoFingerTapUndo = Math.round(x11 - pg().strokes[0].points[0]) === 50;
  await wait(50);
  pid++;
  ev('pointerdown', 900, 650, { button: 2, buttons: 2 });
  ev('pointerup', 900, 650, { button: 2, buttons: 2 });
  R.sideButtonRing = !!document.querySelector('.radial');
  document.querySelector('.radial')?.remove();
  // Zoom: Firefox-style line-mode Ctrl+wheel, and Safari pinch gestures.
  const chip = document.querySelector('#zoom');
  bg.dispatchEvent(new WheelEvent('wheel', { clientX: 700, clientY: 400, deltaY: -3, deltaMode: 1, ctrlKey: true, bubbles: true, cancelable: true }));
  await wait(200);
  R.zoomWheelLines = chip.textContent !== '100%';
  // iPad-style flood: 240 Pencil samples as separate pointermoves must stay cheap.
  btn('Pen').click();
  pid++;
  ev('pointerdown', 300, 760);
  const t0 = performance.now();
  for (let i = 1; i <= 240; i++) ev('pointermove', 300 + i * 2, 760 + Math.sin(i / 10) * 20);
  R.floodMsPerSample = +((performance.now() - t0) / 240).toFixed(3);
  ev('pointerup', 780, 760);
  R.floodCheap = R.floodMsPerSample < 0.5;
  let blob = null;
  const realClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    blob = this.href;
  };
  btn('Export').click();
  await wait(200);
  document.querySelector('.export-panel button.primary').click();
  await wait(4000);
  HTMLAnchorElement.prototype.click = realClick;
  const b = blob && (await (await fetch(blob)).blob());
  R.pdfExport = !!b && b.type === 'application/pdf';
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  btn('New page (Ctrl+N)')?.click() ?? btn('New page (⌘N)')?.click();
  await wait(1500);
  const search = document.querySelector('.sb-search input');
  search.value = 'regression';
  search.dispatchEvent(new Event('input'));
  await wait(1500);
  R.searchFindsText = document.querySelectorAll('.row.result').length === 1;
  R.errors = errors;
  return R;
}

const runs = [
  ['Chromium (Windows/desktop Chrome, Edge, Brave)', chromium, { viewport: { width: 1366, height: 900 } }],
  ['Firefox', firefox, { viewport: { width: 1366, height: 900 } }],
  ['WebKit (Safari, macOS/Linux desktop app)', webkit, { viewport: { width: 1366, height: 900 } }],
  ['WebKit iPad Pro (touch)', webkit, { ...devices['iPad Pro 11 landscape'] }],
];

let failed = false;
for (const [name, engine, opts] of runs) {
  let browser;
  try {
    browser = await engine.launch();
  } catch (e) {
    console.log(`\n${name}: could not start — ${String(e.message).split('\n')[0]}`);
    failed = true;
    continue;
  }
  const page = await (await browser.newContext(opts)).newPage();
  const consoleErrors = [];
  page.on('pageerror', (e) => consoleErrors.push(e.message));
  await page.goto(URL);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.waitForSelector('#toolbar .tb-btn');
  const r = await page.evaluate(suite);
  const errors = [...r.errors, ...consoleErrors];
  delete r.errors;
  const bad = Object.entries(r).filter(([k, v]) => v === false && k !== 'floodMsPerSample');
  console.log(`\n${name}: ${bad.length || errors.length ? 'FAIL' : 'ok'}`);
  for (const [k, v] of Object.entries(r)) console.log(`  ${v === false ? '✗' : '✓'} ${k}${typeof v === 'number' ? ` = ${v}` : ''}`);
  for (const e of errors) console.log(`  ! ${e}`);
  if (bad.length || errors.length) failed = true;
  await browser.close();
}
process.exit(failed ? 1 : 0);
