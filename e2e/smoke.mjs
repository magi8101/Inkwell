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
  const menuItemNow = (label) =>
    [...document.querySelectorAll('.menu-item')].find((b) => b.textContent.trim() === label);
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
        pressure: o.p ?? 0.5,
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
  // Pen cursor: a dot the colour of the pen by default; crosshair and none on request.
  const cursorAfterMove = () => {
    ev('pointermove', 700, 500, { type: 'mouse', buttons: 0 });
    return bg.style.cursor;
  };
  const setCursor = async (label) => {
    btn('Pen feel and palm settings').click();
    await wait(50);
    const group = [...document.querySelectorAll('.tune-side')].find((g) => g.textContent.includes('Pen cursor'));
    [...group.querySelectorAll('button')].find((b) => b.textContent === label).click();
    btn('Pen feel and palm settings').click();
  };
  R.cursorDot = cursorAfterMove().includes('data:image/svg+xml');
  await setCursor('Crosshair');
  R.cursorCrosshair = cursorAfterMove() === 'crosshair';
  await setCursor('None');
  R.cursorNone = cursorAfterMove() === 'none';
  await setCursor('Dot');
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
  // Paper sizes: A4 landscape on this page; the next page comes on the same paper; back to infinite.
  btn('Page style').click();
  await wait(100);
  const seg = (label) => [...document.querySelectorAll('.style-panel .seg')].find((b) => b.textContent.trim() === label);
  seg('A4').click();
  seg('Landscape').click();
  const st = await stored();
  const onPaper = st.notebooks.flatMap((n) => n.sections).flatMap((x) => x.pages).find((x) => x.id === st.pageId);
  R.paperSizeSet = onPaper.paper === 'a4' && onPaper.landscape === true;
  document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await wait(100);
  btn('Page style').click();
  await wait(100);
  seg('Infinite').click();
  const st2 = await stored();
  R.paperInfiniteAgain =
    st2.notebooks.flatMap((n) => n.sections).flatMap((x) => x.pages).find((x) => x.id === st2.pageId)?.paper === undefined;
  document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await wait(100);
  // Templates: Cornell and music paper put an infinite page on A4 with that ruling; Blank and
  // Infinite put it back.
  const curPage = async () => {
    const s = await stored();
    return s.notebooks.flatMap((n) => n.sections).flatMap((x) => x.pages).find((x) => x.id === s.pageId);
  };
  btn('Page style').click();
  await wait(100);
  seg('Cornell').click();
  await wait(150);
  const cornell = await curPage();
  R.templateCornellSetsSheet = cornell.background === 'cornell' && cornell.paper === 'a4';
  seg('Music').click();
  await wait(150);
  R.templateMusic = (await curPage()).background === 'staff';
  seg('Blank').click();
  seg('Infinite').click();
  await wait(150);
  const plain = await curPage();
  R.templateBackToPlain = plain.background === 'blank' && plain.paper === undefined;
  document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await wait(100);
  // Reported on iPad: after one stroke the next one only worked 1–2 seconds later. A pen whose lift
  // was never delivered must not block the next press: the new press ends the old stroke and draws.
  const nowPage = async () => {
    const s = await stored();
    return s.notebooks.flatMap((n) => n.sections).flatMap((x) => x.pages).find((x) => x.id === s.pageId);
  };
  const strokesBefore = (await nowPage()).strokes.length;
  ev('pointerdown', 200, 700, { id: 801 });
  for (let i = 1; i <= 8; i++) ev('pointermove', 200 + i * 6, 700 + i, { id: 801 });
  await wait(350); // the lift never came: the stroke has gone quiet
  ev('pointerdown', 320, 700, { id: 802 }); // no pointerup for 801
  for (let i = 1; i <= 8; i++) ev('pointermove', 320 + i * 6, 700 + i, { id: 802 });
  ev('pointerup', 372, 708, { id: 802 });
  await wait(150);
  R.lostLiftDoesNotBlockNextStroke = (await nowPage()).strokes.length === strokesBefore + 2;
  // An echo: a second pen press while the stroke is still being written must not cut it in two.
  const s2 = (await nowPage()).strokes.length;
  ev('pointerdown', 200, 640, { id: 811 });
  for (let i = 1; i <= 6; i++) ev('pointermove', 200 + i * 6, 640 + i, { id: 811 });
  ev('pointerdown', 236, 646, { id: 812 }); // echo, right in the middle of the stroke
  for (let i = 7; i <= 12; i++) ev('pointermove', 200 + i * 6, 640 + i, { id: 811 });
  ev('pointerup', 272, 652, { id: 811 });
  await wait(150);
  R.echoPressDoesNotSplitStroke = (await nowPage()).strokes.length === s2 + 1;
  // Renaming: a redraw of the sidebar (queued by any change) must not delete the box being typed
  // in — that closed the on-screen keyboard. Open the rename box, cause a change, wait, type.
  document.querySelector('.row.page [aria-label="Page options"]').click();
  await wait(100);
  menuItemNow('Rename').click();
  await wait(100);
  btn('Theme: system')?.click(); // any change that redraws the sidebar
  document.querySelector('[aria-label^="Theme"]')?.click();
  await wait(1500);
  const box = document.querySelector('input.rename');
  R.renameBoxSurvivesRedraw = !!box && document.activeElement === box;
  if (box) {
    box.value = 'Chemistry';
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  }
  await wait(300);
  R.renameSaves = (await pg()).title === 'Chemistry' && !document.querySelector('input.rename');
  // Reported: pick pen 1, open the colour changer, pick a colour → pen 1 changed too. Now only the
  // current pen changes, and the panel offers to keep it as a new pen or update pen 1.
  document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); // closes the "new pen" panel
  await wait(100);
  document.querySelector('.fav').click(); // pen 1
  btn('Colour and size').click();
  await wait(100);
  document.querySelector('.pal[data-color="#f76b15"]').click();
  const favs2 = (await stored()).favorites;
  const saveBtn = menuItemNow('Save as new pen');
  const updateBtn = menuItemNow('Update pen 1');
  R.pickedPenNotOverwritten = favs2[0].color === favs0[0].color && favs2.length === favs1.length;
  R.changedPenOffersSave = !!saveBtn && !saveBtn.hidden && !!updateBtn && !updateBtn.hidden;
  saveBtn?.click();
  const favs3 = (await stored()).favorites;
  R.saveAsNewPenAdds = favs3.length === favs2.length + 1 && favs3.at(-1).color === '#f76b15' && favs3[0].color === favs0[0].color;
  document.querySelector('.pal[data-color="#8e8e93"]').click();
  menuItemNow(`Update pen ${favs3.length}`)?.click();
  const favs4 = (await stored()).favorites;
  R.updatePenUpdatesIt = favs4.at(-1).color === '#8e8e93' && favs4.length === favs3.length && favs4[0].color === favs0[0].color;
  document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await wait(100);
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
  // Canvas rotation (two-finger twist, like Concepts) and the rotation lock.
  const chipText = () => document.querySelector('#zoom').title;
  const twistBy = async (deg) => {
    await wait(400); // past the pen grace period, so fingers aren't palms
    const t = (type, id, x, y) =>
      bg.dispatchEvent(new PointerEvent(type, { pointerId: id, pointerType: 'touch', isPrimary: id === 81, clientX: x, clientY: y, width: 20, height: 20, button: type === 'pointermove' ? -1 : 0, buttons: type === 'pointerup' ? 0 : 1, bubbles: true }));
    t('pointerdown', 81, 600, 450);
    t('pointerdown', 82, 800, 450);
    for (let a = 2; a <= deg; a += 2) {
      const r = (a * Math.PI) / 180;
      t('pointermove', 82, 600 + 200 * Math.cos(r), 450 + 200 * Math.sin(r));
    }
    const r = (deg * Math.PI) / 180;
    t('pointerup', 82, 600 + 200 * Math.cos(r), 450 + 200 * Math.sin(r));
    t('pointerup', 81, 600, 450);
    await wait(100);
  };
  await twistBy(40);
  R.twoFingerRotate = /\b(3[6-9]|4[0-4])°/.test(chipText());
  // A level pen line drawn on the turned page is stored turned back, in page coordinates.
  btn('Pen').click();
  await wait(400);
  stroke(line(500, 300, 700, 300));
  const pts = (await pg()).strokes.at(-1).points;
  const slope = (Math.atan2(pts.at(-2) - pts[1], pts.at(-3) - pts[0]) * 180) / Math.PI;
  R.inkOnRotatedPage = Math.abs(slope + 40) < 5;
  btn('Undo').click();
  document.querySelector('#zoom').click();
  await wait(50);
  [...document.querySelectorAll('.menu-item')].find((b) => b.textContent.includes('Lock rotation')).click();
  const chipBefore = chipText();
  await twistBy(40);
  R.rotationLock = chipText() === chipBefore;
  document.querySelector('#zoom').click();
  await wait(50);
  [...document.querySelectorAll('.menu-item')].find((b) => b.textContent.includes('Unlock rotation')).click();
  document.querySelector('#zoom').click();
  await wait(50);
  [...document.querySelectorAll('.menu-item')].find((b) => b.textContent.includes('Upright')).click();
  await wait(50);
  R.uprightResets = !chipText().includes('°');
  // Toolbar docking: drop the grip at the left edge → a vertical bar there; drag away → floating.
  const tb = document.querySelector('#toolbar');
  const grip = document.querySelector('.tb-grip');
  const gripDrag = (toX, toY) => {
    const g = grip.getBoundingClientRect();
    const o = (t, x, y) => grip.dispatchEvent(new PointerEvent(t, { pointerId: 70, pointerType: 'mouse', clientX: x, clientY: y, button: t === 'pointermove' ? -1 : 0, buttons: t === 'pointerup' ? 0 : 1, bubbles: true }));
    o('pointerdown', g.left + 5, g.top + 5);
    o('pointermove', toX, toY);
    o('pointerup', toX, toY);
  };
  const stageBox = document.querySelector('#stage').getBoundingClientRect();
  gripDrag(stageBox.left + 10, stageBox.top + 300);
  await wait(200);
  const tr = tb.getBoundingClientRect();
  R.toolbarDocksLeft = tb.classList.contains('vertical') && tr.height > tr.width && tr.left - stageBox.left < 20;
  gripDrag(stageBox.left + 400, stageBox.top + 200);
  await wait(200);
  R.toolbarFloatsAgain = !tb.classList.contains('vertical');
  // PDF import: a two-page PDF dropped on the page becomes a folder of two pages to write on.
  {
    // A minimal valid PDF, written by hand: two blank 300×200 pt pages.
    const minimal = (n) => {
      const objs = ['<< /Type /Catalog /Pages 2 0 R >>', `<< /Type /Pages /Kids [${Array.from({ length: n }, (_, i) => `${3 + i} 0 R`).join(' ')}] /Count ${n} >>`];
      for (let i = 0; i < n; i++) objs.push('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] >>');
      let out = '%PDF-1.4\n';
      const offs = [];
      objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
      const xref = out.length;
      out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
      return new TextEncoder().encode(out);
    };
    const bytes = minimal(2);
    const dtp = new DataTransfer();
    dtp.items.add(new File([bytes], 'Lecture 5.pdf', { type: 'application/pdf' }));
    document.querySelector('#stage').dispatchEvent(new DragEvent('drop', { clientX: 600, clientY: 400, dataTransfer: dtp, bubbles: true, cancelable: true }));
    let folder = null;
    for (let i = 0; i < 40 && !folder; i++) {
      await wait(250);
      folder = (await stored()).notebooks[0].sections.find((x) => x.name === 'Lecture 5');
    }
    R.pdfImportPages = !!folder && folder.pages.length === 2 && folder.pages.every((p) => p.images.length === 1);
    R.pdfImportSize = !!folder && Math.round(folder.pages[0].images[0].w) === 400 && Math.round(folder.pages[0].images[0].h) === 267;
    document.querySelector('.row.section').click(); // back to an ordinary page
    await wait(400);
  }
  // Code block: inserting one puts it on the page; what's typed is saved with the page.
  btn('Insert').click();
  await wait(50);
  [...document.querySelectorAll('.menu-item')].find((b) => b.textContent.startsWith('Code block')).click();
  await wait(300);
  const src = document.querySelector('.codeblock .code-src');
  src.value = 'print(6 * 7)';
  src.dispatchEvent(new Event('input'));
  src.dispatchEvent(new Event('blur'));
  await wait(200);
  const savedCode = (await pg()).codes ?? (await stored()).notebooks[0].sections.flatMap((x) => x.pages).find((p) => p.codes?.length)?.codes;
  R.codeBlockSaved = !!document.querySelector('.codeblock') && savedCode?.some((c) => c.code === 'print(6 * 7)');
  document.querySelector('[aria-label="Delete code block"]').click();
  await wait(200);
  R.codeBlockDeletes = !document.querySelector('.codeblock');
  // Code blocks are part of undo: undo brings the deleted block back (with its code), a second
  // undo takes the typing back to the starter code, a third removes the block; redo replays.
  const blockCode = () => document.querySelector('.codeblock .code-src')?.value;
  btn('Undo').click();
  await wait(200);
  R.codeUndoRestoresDeleted = blockCode() === 'print(6 * 7)';
  btn('Undo').click();
  await wait(200);
  R.codeUndoRevertsTyping = !!document.querySelector('.codeblock') && blockCode() !== 'print(6 * 7)';
  btn('Undo').click();
  await wait(200);
  R.codeUndoRemovesAdd = !document.querySelector('.codeblock');
  btn('Redo').click();
  btn('Redo').click();
  btn('Redo').click();
  await wait(200);
  R.codeRedoReplays = !document.querySelector('.codeblock');
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
  // 6. fast lines: straight, quick, and a pressure spike on the first three samples (a blob)
  for (let n = 0; n < 6; n++) {
    pid++;
    const pts = Array.from({ length: 40 }, (_, i) => at(0.05 + i * 0.022, 0.6));
    calEv('pointerdown', pts[0], { p: 0.95 });
    for (const [i, pt] of pts.slice(1).entries()) {
      calEv('pointermove', pt, { p: i + 1 < 3 ? 0.95 : 0.35 });
      await wait(2);
    }
    calEv('pointerup', pts.at(-1), { p: 0.35 });
  }
  await step('7.');
  for (let i = 0; i < 10; i++) calEv('pointerdown', at(0.5, 0.5), { type: 'touch', id: 900 + i, size: 180 }); // 7. palm
  await step('8.');
  for (let i = 0; i < 3; i++) calEv('pointerdown', at(0.5, 0.5), { type: 'touch', id: 950 + i, size: 40 }); // 8. finger
  await step('9.');
  await calStroke([at(0.4, 0.4), at(0.41, 0.4)], { button: 2, buttons: 2 }); // 9. side button…
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
  R.calibrationFindsStartSpike = tuning.startWarmup === 3;
  R.calibrationSetsSpeedGain = tuning.speedGain > 0;
  R.calibrationReport = report.includes('DELAY (stylus → screen)') && report.includes('CALIBRATION (applied)');
  // The raw input log saw the simulated pen (down and hover) and touches.
  R.calibrationRawInput = /pointerdown pen ×\d/.test(report) && /pointermove pen hover ×\d/.test(report) && /pointerdown touch ×\d/.test(report);
  if (!R.calibrationRawInput) console.log(report.split('RAW INPUT')[1]?.split('DELAY')[0]);
  document.querySelector('.cal-close').click();
  R.calibrationCloses = !document.querySelector('.cal-overlay');
  // The calibrated start fix is used: a pressure spike on the first samples is flattened.
  btn('Pen').click();
  pid++;
  const spiked = line(300, 700, 700, 700, 30);
  ev('pointerdown', ...spiked[0], { p: 0.95 });
  for (const [i, pt] of spiked.slice(1).entries()) ev('pointermove', ...pt, { p: i + 1 < 3 ? 0.95 : 0.35 });
  ev('pointerup', ...spiked.at(-1), { p: 0.35 });
  const spikedPts = (await pg()).strokes.at(-1).points;
  R.startFixFlattensSpike = [2, 5, 8].every((k) => Math.abs(spikedPts[k] - 0.35) < 0.02);
  // A Markdown note exports as PDF pages: capture the file the export hands to the browser.
  let pdfBlob = null;
  const realCreate = URL.createObjectURL.bind(URL);
  URL.createObjectURL = (b) => {
    if (b.type === 'application/pdf') pdfBlob = b;
    return realCreate(b);
  };
  document.querySelector('[aria-label="New Markdown note"]').click();
  await wait(2500);
  document.querySelector('.md-doc')?.focus();
  document.execCommand('insertText', false, 'A note that becomes a PDF');
  await wait(700);
  btn('Export').click();
  await wait(200);
  [...document.querySelectorAll('.export-panel .menu-item')].find((b) => b.textContent === 'Save as PDF')?.click();
  for (let i = 0; i < 40 && !pdfBlob; i++) await wait(150);
  URL.createObjectURL = realCreate;
  R.markdownNoteExportsPdf = !!pdfBlob && pdfBlob.size > 400 && (await pdfBlob.slice(0, 5).text()) === '%PDF-';
  // Clean up: delete the note (its menu asks twice) so later steps see an ordinary notebook.
  document.querySelector('.row.page[aria-current="true"] [aria-label="Page options"]').click();
  await wait(100);
  const delNote = menuItemNow('Delete page');
  delNote.click();
  delNote.click();
  await wait(300);
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
