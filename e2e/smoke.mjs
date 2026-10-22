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
  // Notes live in IndexedDB; flush the idle autosave, then read what was stored.
  const stored = async () => {
    dispatchEvent(new Event('pagehide'));
    await wait(80);
    return new Promise((resolve) => {
      const req = indexedDB.open('inkwell');
      req.onsuccess = () => {
        const get = req.result.transaction('kv').objectStore('kv').get('inkwell:state');
        get.onsuccess = () => resolve(get.result);
      };
    });
  };
  const pg = async () => (await stored()).notebooks[0].sections[0].pages[0];
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
  // Light page: the black pen is black (a minified "#fff" page colour once made it draw white).
  R.lightPageBlackPen =
    document.documentElement.dataset.theme !== 'light' ||
    document.querySelector('.fav').style.getPropertyValue('--c') === '#1c1c1e';
  btn('Pen').click();
  btn('Pen').click();
  stroke(line(400, 200, 700, 220));
  btn('Highlighter').click();
  stroke(line(400, 260, 700, 260));
  R.penAndHighlighter = (await pg()).strokes.map((s) => s.tool).join(',') === 'pen,highlighter';
  // A frame later the wet layers must be clear again (strokes moved to the page).
  await wait(400);
  btn('Pen').click();
  pid++;
  const tri = [[450, 500], [530, 360], [610, 500], [452, 498]];
  ev('pointerdown', ...tri[0]);
  for (let i = 0; i < 3; i++) for (const p of line(...tri[i], ...tri[i + 1], 20).slice(1)) ev('pointermove', ...p);
  await wait(650);
  ev('pointerup', ...tri[3]);
  R.shapeSnapped = (await pg()).strokes.at(-1).pressure === false && (await pg()).strokes.length === 3;
  btn('Ruler and straight line').click();
  stroke(line(800, 300, 1000, 303));
  const rl = (await pg()).strokes.at(-1).points;
  R.rulerLevel = Math.abs(rl[1] - rl.at(-2)) < 0.01;
  btn('Stroke eraser').click();
  stroke(line(900, 260, 900, 340));
  R.strokeEraser = (await pg()).strokes.length === 3;
  btn('Pixel eraser').click();
  stroke(line(550, 170, 550, 240));
  R.pixelEraserSplit = (await pg()).strokes.filter((s) => s.tool === 'pen' && s.pressure).length === 2;
  btn('Undo').click();
  R.undo = (await pg()).strokes.filter((s) => s.tool === 'pen' && s.pressure).length === 1;
  btn('Redo').click();
  R.redo = (await pg()).strokes.filter((s) => s.tool === 'pen' && s.pressure).length === 2;
  btn('Undo').click();
  // The pen's eraser end follows its setting: pixel erase splits the line, stroke erase removes it.
  const eraserEnd = async (label) => {
    btn('Pen feel and palm settings').click();
    await wait(50);
    const group = [...document.querySelectorAll('.tune-side')].find((g) => g.textContent.includes('eraser end'));
    [...group.querySelectorAll('button')].find((b) => b.textContent === label).click();
    btn('Pen feel and palm settings').click();
  };
  btn('Pen').click();
  const penLines = async () => (await pg()).strokes.filter((s) => s.tool === 'pen' && s.pressure).length;
  await eraserEnd('Pixel erase');
  stroke(line(550, 170, 550, 240), { button: 5, buttons: 32 });
  R.eraserEndPixel = (await penLines()) === 2;
  btn('Undo').click();
  await eraserEnd('Erase strokes');
  stroke(line(550, 170, 550, 240), { button: 5, buttons: 32 });
  R.eraserEndStroke = (await penLines()) === 0;
  btn('Undo').click();
  R.eraserEndUndo = (await penLines()) === 1;
  btn('Text box').click();
  pid++;
  ev('pointerdown', 800, 450, { type: 'mouse' });
  ev('pointerup', 800, 450, { type: 'mouse' });
  // A new box doesn't summon the on-screen keyboard; on touch screens the bar's button does.
  R.textNoAutoKeyboard = document.activeElement.inputMode === 'none';
  if (navigator.maxTouchPoints > 0) {
    btn('On-screen keyboard').click();
    R.textKeyboardButton = document.activeElement.inputMode === 'text' && document.activeElement.classList.contains('tbox-body');
    btn('On-screen keyboard').click();
  }
  document.execCommand('insertText', false, 'regression note');
  document.activeElement.blur();
  R.textBox = (await pg()).texts.length === 1 && (await pg()).texts[0].text === 'regression note';
  btn('Lasso select').click();
  stroke([[380, 180], [720, 180], [720, 290], [380, 290], [382, 182]], { type: 'mouse', id: 1 });
  const frame = document.querySelector('.sel-frame');
  const fr = frame.getBoundingClientRect();
  const before = (await pg()).strokes[0].points[0];
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
  R.lassoMoved = Math.round((await pg()).strokes[0].points[0] - before) === 50;
  // Resize from the top-left handle: the bottom-right corner must stay put.
  const nw = document.querySelector('.sel-handle.nw');
  const h = nw.getBoundingClientRect();
  const widthBefore = (await pg()).strokes[0].width;
  F(nw, 'pointerdown', h.left + 14, h.top + 14);
  F(nw, 'pointermove', h.left - 40, h.top - 40);
  F(nw, 'pointerup', h.left - 40, h.top - 40);
  R.lassoResizeCorner = (await pg()).strokes[0].width > widthBefore;
  btn('Undo').click();
  // Rotate with a finger after the pen has been used (the pen wrote everything above): the ink
  // and the text box turn together.
  stroke([[300, 150], [1150, 150], [1150, 620], [300, 620], [302, 152]], { type: 'mouse', id: 1 });
  const rot = document.querySelector('.sel-handle.rotate');
  const rr = rot.getBoundingClientRect();
  const fr2 = document.querySelector('.sel-frame').getBoundingClientRect();
  const finger = (t, x, y) =>
    rot.dispatchEvent(new PointerEvent(t, { pointerId: 60, pointerType: 'touch', isPrimary: true, clientX: x, clientY: y, width: 20, height: 20, button: t === 'pointermove' ? -1 : 0, buttons: t === 'pointerup' ? 0 : 1, bubbles: true }));
  const rx = rr.left + 14;
  const ry = rr.top + 14;
  finger('pointerdown', rx, ry);
  finger('pointermove', fr2.right + 40, fr2.top + fr2.height / 2 - 5); // a quarter turn clockwise
  finger('pointerup', fr2.right + 40, fr2.top + fr2.height / 2 - 5);
  const turned = await pg();
  R.fingerRotatesAfterPen = turned.strokes[0].points[0] !== before + 0 && Math.abs((turned.texts[0].angle ?? 0) - Math.PI / 2) < 0.2;
  btn('Undo').click();
  R.rotateUndo = !(await pg()).texts[0].angle;
  document.querySelector('.selbar [aria-label^="Deselect"]').click();
  stroke([[380, 180], [720, 180], [720, 290], [380, 290], [382, 182]], { type: 'mouse', id: 1 });
  // Copy with the selection bar, deselect, then the on-screen Paste button (touch devices have no Ctrl+V).
  document.querySelector('.selbar [aria-label^="Copy"]').click();
  document.querySelector('.selbar [aria-label^="Deselect"]').click();
  const nBeforePaste = (await pg()).strokes.length;
  const pasteChip = document.querySelector('.chip.paste');
  R.pasteButtonShown = !!pasteChip && !pasteChip.hidden;
  pasteChip?.click();
  R.pasteButtonPastes = (await pg()).strokes.length === nBeforePaste + 2;
  btn('Undo').click();
  const n10 = (await pg()).strokes.length;
  btn('Laser pointer').click();
  stroke(line(500, 600, 800, 650));
  R.laserNotSaved = (await pg()).strokes.length === n10;
  btn('Pen').click();
  await wait(400);
  const x11 = (await pg()).strokes[0].points[0];
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
  R.twoFingerTapUndo = Math.round(x11 - (await pg()).strokes[0].points[0]) === 50;
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
  // Pictures: drop a PNG onto the page; it is stored, arrives selected, moves with the lasso.
  const pngCanvas = document.createElement('canvas');
  pngCanvas.width = 400;
  pngCanvas.height = 200;
  const pctx = pngCanvas.getContext('2d');
  pctx.fillStyle = '#e5484d';
  pctx.fillRect(0, 0, 400, 200);
  const png = await new Promise((r) => pngCanvas.toBlob(r, 'image/png'));
  const dt = new DataTransfer();
  dt.items.add(new File([png], 'test.png', { type: 'image/png' }));
  document.querySelector('#stage').dispatchEvent(
    new DragEvent('drop', { clientX: 700, clientY: 450, dataTransfer: dt, bubbles: true, cancelable: true }),
  );
  await wait(800);
  const imgs = (await pg()).images;
  // Natural size (400×200), shrunk to fit smaller screens (iPad) but never stretched or distorted.
  R.pictureInserted =
    imgs.length === 1 && imgs[0].w <= 400 && imgs[0].w > 200 && Math.abs(imgs[0].w / imgs[0].h - 2) < 0.01;
  R.pictureSelected = !document.querySelector('.sel-frame').hidden;
  const blobCount = await new Promise((resolve) => {
    const req = indexedDB.open('inkwell');
    req.onsuccess = () => {
      const c = req.result.transaction('blobs').objectStore('blobs').count();
      c.onsuccess = () => resolve(c.result);
    };
  });
  R.pictureFileStored = blobCount === 1;
  const pf = document.querySelector('.sel-frame').getBoundingClientRect();
  const cx0 = imgs[0].cx;
  F(document.querySelector('.sel-frame'), 'pointerdown', pf.left + 30, pf.top + 30);
  F(document.querySelector('.sel-frame'), 'pointermove', pf.left + 90, pf.top + 30);
  F(document.querySelector('.sel-frame'), 'pointerup', pf.left + 90, pf.top + 30);
  const zoomNow = Number.parseInt(document.querySelector('#zoom').textContent, 10) / 100;
  R.pictureMovesWithLasso = Math.abs((await pg()).images[0].cx - cx0 - 60 / zoomNow) < 1;
  btn('Undo').click();
  R.pictureUndoMove = Math.round((await pg()).images[0].cx - cx0) === 0;
  btn('Pen').click();
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
  R.pdfIncludesPicture = !!b && b.size > 2000; // the embedded PNG makes it clearly larger
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  btn('New page (Ctrl+N)')?.click() ?? btn('New page (⌘N)')?.click();
  await wait(1500);
  // Page numbers: the corner shows "2 / 2", previous goes back, the page list is numbered.
  const pageNo = () => document.querySelector('.page-no').textContent;
  R.pagerShowsNumber = pageNo() === '2 / 2';
  btn('Previous page').click();
  await wait(100);
  R.pagerPrevious = pageNo() === '1 / 2' && btn('Previous page').disabled;
  btn('Next page').click();
  await wait(1200);
  R.pageListNumbered = [...document.querySelectorAll('.row.page .num')].map((n) => n.textContent).join() === '1,2';
  const search = document.querySelector('.sb-search input');
  search.value = 'regression';
  search.dispatchEvent(new Event('input'));
  await wait(1500);
  R.searchFindsText = document.querySelectorAll('.row.result').length === 1;
  search.value = '';
  search.dispatchEvent(new Event('input'));
  // Add a pen, give it a new colour: the new pen changes, the default pen it was copied from doesn't.
  const favs0 = (await stored()).favorites;
  btn('Pen').click();
  document.querySelector('.fav').click(); // default black pen
  btn('Add a new pen').click();
  await wait(100);
  document.querySelector('.pal[data-color="#e5484d"]').click();
  const favs1 = (await stored()).favorites;
  R.addPenAddsOne = favs1.length === favs0.length + 1;
  R.newPenGetsColour = favs1.at(-1).color === '#e5484d';
  R.defaultPenUnchanged = favs1[0].color === favs0[0].color;
  // Folders nest like Obsidian: a folder inside a folder, collapse it, drag a page into it,
  // move it back to the top level, delete a folder with what's inside it.
  const menuItem = (label) =>
    [...document.querySelectorAll('.menu-item')].find((b) => b.textContent.trim() === label);
  const folders = async () => (await stored()).notebooks[0].sections;
  const rowOf = (id) => document.querySelector(`.row.section[data-id="${id}"]`);
  await wait(300);
  const top = (await folders())[0];
  rowOf(top.id).querySelector('.more').click();
  await wait(50);
  menuItem('New folder inside').click();
  await wait(400);
  let fs = await folders();
  const sub = fs.find((x) => x.parent === top.id);
  R.folderNests = !!sub && getComputedStyle(rowOf(sub.id)).getPropertyValue('--depth').trim() === '1';
  rowOf(top.id).querySelector('button.twisty').click();
  await wait(400);
  R.folderCollapses = !rowOf(sub.id);
  rowOf(top.id).querySelector('button.twisty').click();
  await wait(400);
  // Back in the top folder, drag its first page onto the sub-folder.
  rowOf(top.id).click();
  await wait(400);
  const movedId = (await folders())[0].pages[0].id;
  const li = document.querySelector(`.row.page[data-id="${movedId}"]`);
  const lr = li.getBoundingClientRect();
  const sr = rowOf(sub.id).getBoundingClientRect();
  const pe = (type, x, y) =>
    li.dispatchEvent(new PointerEvent(type, { pointerId: 77, clientX: x, clientY: y, button: 0, buttons: type === 'pointerup' ? 0 : 1, bubbles: true }));
  pe('pointerdown', lr.left + 20, lr.top + 10);
  pe('pointermove', sr.left + 60, lr.top + 30);
  pe('pointermove', sr.left + 60, sr.top + sr.height / 2);
  pe('pointerup', sr.left + 60, sr.top + sr.height / 2);
  await wait(400);
  fs = await folders();
  R.pageDragsIntoFolder = fs.find((x) => x.id === sub.id).pages.some((p) => p.id === movedId);
  rowOf(sub.id).querySelector('.more').click();
  await wait(50);
  menuItem('Move to…').click();
  await wait(50);
  menuItem('Top level').click();
  await wait(400);
  R.folderMovesToTop = !(await folders()).find((x) => x.id === sub.id).parent;
  // Nest it again and delete the parent: both go, the notebook keeps at least one folder.
  rowOf(sub.id).querySelector('.more').click();
  await wait(50);
  menuItem('Move to…').click();
  await wait(50);
  [...document.querySelectorAll('.menu-item')].find((b) => b.textContent.trim() === top.name).click();
  await wait(400);
  const extra = document.querySelector('[aria-label="New folder"]');
  extra.click();
  await wait(400);
  rowOf(top.id).querySelector('.more').click();
  await wait(50);
  const del = menuItem('Delete folder and its folders');
  del.click();
  del.click();
  await wait(400);
  fs = await folders();
  R.folderDeleteTakesSubfolders = fs.length === 1 && !fs.some((x) => x.id === top.id || x.id === sub.id);
  // Pen calibration: run every step with synthetic pen/touch input, apply, and share the report.
  btn('Pen feel and palm settings').click();
  await wait(100);
  [...document.querySelectorAll('.tune-panel button')].find((b) => b.textContent === 'Calibrate my pen…').click();
  const pad = document.querySelector('.cal-pad');
  await wait(100);
  const at = (fx, fy) => {
    const r = pad.getBoundingClientRect();
    return [r.left + r.width * fx, r.top + r.height * fy];
  };
  const calEv = (type, [x, y], o = {}) =>
    pad.dispatchEvent(
      new PointerEvent(type, {
        pointerId: o.id ?? pid,
        pointerType: o.type ?? 'pen',
        clientX: x,
        clientY: y,
        button: type === 'pointermove' ? -1 : (o.button ?? 0),
        buttons: type === 'pointerup' ? 0 : (o.buttons ?? 1),
        pressure: o.p ?? 0.5,
        width: o.size ?? 1,
        height: o.size ?? 1,
        bubbles: true,
        cancelable: true,
      }),
    );
  const calStroke = async (pts, o = {}, gap = 0) => {
    pid++;
    calEv('pointerdown', pts[0], o);
    for (const p of pts.slice(1)) {
      calEv('pointermove', p, o);
      if (gap) await wait(gap);
    }
    calEv('pointerup', pts.at(-1), o);
  };
  // Waits until the wizard shows step n (or the result), so slow browsers don't race it.
  const step = async (n) => {
    for (let i = 0; i < 100; i++) {
      const t = document.querySelector('.cal-title')?.textContent ?? '';
      if (n === 'done' ? !/^\d+\./.test(t) : t.startsWith(n)) return;
      await wait(50);
    }
  };
  calEv('pointermove', at(0.5, 0.5), { buttons: 0 }); // 1. hover
  await step('2.');
  const stillPts = Array.from({ length: 220 }, (_, i) => at(0.5 + (i % 2) * 0.0005, 0.5)); // 2. hold still
  await calStroke(stillPts, {}, 10);
  await step('3.');
  const writing = Array.from({ length: 170 }, (_, i) => at(0.1 + i * 0.004, 0.6 + Math.sin(i / 3) * 0.05));
  await calStroke(writing, { p: 0.2 }); // 3. light
  await step('4.');
  await calStroke(writing, { p: 0.8 }); // 4. firm
  await step('5.');
  const ring = Array.from({ length: 320 }, (_, i) => at(0.5 + 0.3 * Math.cos(i / 20), 0.5 + 0.3 * Math.sin(i / 20)));
  await calStroke(ring, {}, 4); // 5. fast circles
  await step('6.');
  for (let i = 0; i < 10; i++) calEv('pointerdown', at(0.5, 0.5), { type: 'touch', id: 900 + i, size: 180 }); // 6. palm
  await step('7.');
  for (let i = 0; i < 3; i++) calEv('pointerdown', at(0.5, 0.5), { type: 'touch', id: 950 + i, size: 40 }); // 7. finger
  await step('8.');
  await calStroke([at(0.4, 0.4), at(0.41, 0.4)], { button: 2, buttons: 2 }); // 8. side button…
  await calStroke([at(0.4, 0.4), at(0.41, 0.4)], { button: 5, buttons: 32 }); // …and eraser end
  await step('done');
  R.calibrationFinishes = document.querySelector('.cal-title')?.textContent === 'Your pen is calibrated';
  let report = '';
  Object.defineProperty(navigator, 'canShare', { value: undefined, configurable: true });
  Object.defineProperty(navigator, 'share', { value: undefined, configurable: true });
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: async (t) => (report = t) },
    configurable: true,
  });
  document.querySelector('.cal-foot button.primary').click();
  [...document.querySelectorAll('.cal-foot button')].find((b) => b.textContent.startsWith('Share')).click();
  await wait(100);
  const tuning = (await stored()).tuning;
  R.calibrationSetsPalm = tuning.palmPx === 110;
  R.calibrationSetsPressure = tuning.thinning !== 0.55 || tuning.pressureGamma !== 1;
  R.calibrationSetsPrediction = tuning.predictAuto === false;
  R.calibrationReport = report.includes('DELAY (stylus → screen)') && report.includes('CALIBRATION (applied)');
  document.querySelector('.cal-close').click();
  R.calibrationCloses = !document.querySelector('.cal-overlay');
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
  // Upgrade check: plant old-style localStorage notes before the app starts (as after an update),
  // with no IndexedDB yet, and check they move across. Runs once per context.
  await page.context().addInitScript(() => {
    if (sessionStorage.getItem('seeded')) return;
    sessionStorage.setItem('seeded', '1');
    localStorage.clear();
    indexedDB.deleteDatabase('inkwell'); // queued ahead of the app's own open request
    const pg = { id: 'p1', title: 'Migrated page', strokes: [], texts: [], background: 'blank', pageColor: 'auto' };
    const nb = { id: 'n1', name: 'Old notebook', sections: [{ id: 's1', name: 'Old section', color: '#3e63dd', pages: [pg] }] };
    localStorage.setItem('inkwell:state', JSON.stringify({ notebooks: [nb], notebookId: 'n1', sectionId: 's1', pageId: 'p1' }));
  });
  // The folder picker needs a person; hand the app the browser's sandbox folder instead.
  if (engine === chromium) {
    await page.context().addInitScript(() => {
      window.showDirectoryPicker = async () =>
        (await navigator.storage.getDirectory()).getDirectoryHandle('vault', { create: true });
    });
  }
  await page.goto(URL);
  await page.waitForSelector('#toolbar .tb-btn');
  const migration = await page.evaluate(async () => {
    await new Promise((r) => setTimeout(r, 1500));
    const inDb = await new Promise((resolve) => {
      const req = indexedDB.open('inkwell');
      req.onsuccess = () => {
        const get = req.result.transaction('kv').objectStore('kv').get('inkwell:state');
        get.onsuccess = () => resolve(get.result);
      };
    });
    return {
      shown: document.querySelector('.nb-name')?.textContent === 'Old notebook',
      inIndexedDb: inDb?.notebooks?.[0]?.name === 'Old notebook',
      oldCopyKeptAsBackup:
        localStorage.getItem('inkwell:state') === null &&
        localStorage.getItem('inkwell:state:backup-before-indexeddb') !== null,
    };
  });
  // Then start the feature checks from a fresh page.
  await page.evaluate(async () => {
    await new Promise((r) => {
      const del = indexedDB.deleteDatabase('inkwell');
      del.onsuccess = del.onerror = del.onblocked = () => r();
    });
  });
  await page.reload();
  await page.waitForSelector('#toolbar .tb-btn');
  const r = { ...Object.fromEntries(Object.entries(migration).map(([k, v]) => [`migration_${k}`, v])), ...(await page.evaluate(suite)) };
  // Dark page: the black pen draws white, and the hex box and picker say so too (not #1c1c1e).
  await page.emulateMedia({ colorScheme: 'dark' });
  Object.assign(
    r,
    await page.evaluate(async () => {
      const wait = (ms) => new Promise((res) => setTimeout(res, ms));
      document.querySelector('[aria-label="Pen"]').click();
      await wait(100);
      document.querySelector('[aria-label^="Colour and size"]').click();
      await wait(100);
      document.querySelector('.pal[data-color="#1c1c1e"]').click();
      await wait(50);
      const hex = document.querySelector('.hex');
      const picker = document.querySelector('hex-color-picker');
      const out = { darkHexShowsWhite: hex.value === '#f4f4f5' && picker.color === '#f4f4f5' };
      document.querySelector('.custom-color').click();
      out.customPickerOpens = !picker.hidden && picker.getBoundingClientRect().height > 100;
      picker.dispatchEvent(new CustomEvent('color-changed', { detail: { value: '#123456' } }));
      await wait(50);
      out.customPickerSetsColour = hex.value === '#123456';
      hex.value = '#f4f4f5';
      hex.dispatchEvent(new Event('input'));
      await wait(50);
      out.darkWhiteHexKeepsBlackPen =
        document.querySelector('.pal[data-color="#1c1c1e"]').getAttribute('aria-pressed') === 'true';
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      return out;
    }),
  );
  // Notebook in a folder on disk (Chromium only: other engines have no folder picker). The
  // browser's private sandbox folder (OPFS) stands in for the folder the user would pick.
  if (engine === chromium) {
    const opfs = () =>
      page.evaluate(async () => {
        const out = {};
        const walk = async (d, prefix) => {
          for await (const [name, h] of d.entries()) {
            if (h.kind === 'directory') await walk(h, `${prefix}${name}/`);
            else out[prefix + name] = await (await h.getFile()).text();
          }
        };
        await walk(await (await navigator.storage.getDirectory()).getDirectoryHandle('vault', { create: true }), '');
        return out;
      });
    await page.evaluate(async () => {
      await (await navigator.storage.getDirectory()).removeEntry('vault', { recursive: true }).catch(() => {});
      document.querySelector('.nb-switch').click();
      await new Promise((res) => setTimeout(res, 100));
      [...document.querySelectorAll('.menu-item')].find((b) => b.textContent.includes('Save this notebook to a folder')).click();
    });
    await page.waitForTimeout(1500);
    let files = await opfs();
    const pageFiles = Object.keys(files).filter((f) => f.endsWith('.inkwell'));
    r.vaultWritesPages = pageFiles.length > 0 && pageFiles.every((f) => JSON.parse(files[f]).inkwell === 1);
    r.vaultShowsFolder = await page.evaluate(() => !document.querySelector('.sb-vault').hidden && document.querySelector('.sb-vault').textContent.includes('vault'));
    // Draw on the current page: its file updates by itself shortly after.
    const current = await page.evaluate(() => {
      const bg = document.querySelector('#bg');
      const r = bg.getBoundingClientRect();
      const ev = (type, x) =>
        bg.dispatchEvent(new PointerEvent(type, { pointerId: 555, pointerType: 'pen', clientX: r.left + x, clientY: r.top + 300, pressure: 0.5, buttons: type === 'pointerup' ? 0 : 1, bubbles: true, cancelable: true }));
      document.querySelector('[aria-label="Pen"]').click();
      ev('pointerdown', 200);
      for (let x = 210; x < 400; x += 10) ev('pointermove', x);
      ev('pointerup', 400);
      return document.querySelector('.row.page[aria-current="true"]').dataset.id;
    });
    await page.waitForTimeout(3000);
    files = await opfs();
    const mine = Object.entries(files).find(([f, t]) => f.endsWith('.inkwell') && JSON.parse(t).id === current);
    r.vaultSavesEdits = !!mine && JSON.parse(mine[1]).strokes.length > 0;
    // A page added to the folder from outside (another device via OneDrive, say) appears on reload.
    await page.evaluate(async () => {
      const v = await (await navigator.storage.getDirectory()).getDirectoryHandle('vault');
      const d = await v.getDirectoryHandle('External', { create: true });
      const w = await (await d.getFileHandle('From outside.inkwell', { create: true })).createWritable();
      await w.write(JSON.stringify({ inkwell: 1, id: 'ext1', title: 'x', strokes: [] }));
      await w.close();
    });
    await page.reload();
    await page.waitForSelector('#toolbar .tb-btn');
    await page.waitForTimeout(2000);
    r.vaultReadsOutsideChanges = await page.evaluate(() => {
      const ext = [...document.querySelectorAll('.row.section')].find((x) => x.textContent.includes('External'));
      if (!ext) return false;
      ext.click();
      return new Promise((res) =>
        setTimeout(() => res([...document.querySelectorAll('.row.page')].some((x) => x.textContent.includes('From outside'))), 500),
      );
    });
    await page.evaluate(async () => {
      document.querySelector('.nb-switch').click();
      await new Promise((res) => setTimeout(res, 100));
      [...document.querySelectorAll('.menu-item')].find((b) => b.textContent.includes('Stop saving')).click();
    });
    await page.waitForTimeout(500);
    r.vaultStops = await page.evaluate(() => document.querySelector('.sb-vault').hidden);
  }
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
