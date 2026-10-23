import { FileDown } from 'lucide';
import type { PDFFont, PDFImage, PDFPage } from 'pdf-lib';
import { h, icon, toast, togglePopover } from './dom';
import { bitmap, blobOf, imageBox, loadAll } from './images';
import {
  dashArray,
  hatch,
  shapeBox,
  svgPath as shapeSvgPath,
  byId as shapesById,
} from './shape-geom';
import { codeAsText, isBox, notebook, type Page, page, sheetOf } from './store';
import { bbox, type FONTS, fontCss, inkColor, LINE_HEIGHT, svgPath, wrapLines } from './stroke';
import { isTemplate, type Template, templateLines } from './template-lines';
import { drawPage, isDark, pageColor } from './viewport';

// Export to PDF (vector strokes, real text) or PNG. pdf-lib is loaded only when exporting.

type Format = 'pdf' | 'png' | 'svg';
type Scope = 'page' | 'pages' | 'notebook';
type Size = 'fit' | 'a4' | 'letter';

const PT_PER_PX = 0.75; // 96 CSS px per inch, 72 pt per inch
const MARGIN_PT = 36;
const PNG_SCALE = 2;
const PNG_MARGIN = 24;
const SIZES = { a4: [595.28, 841.89], letter: [612, 792] } as const;
const WHITE = '#ffffff';

const measureCtx = document.createElement('canvas').getContext('2d')!;

// pdf-lib is big, so it isn't in the startup bundle — but loading it only on Export broke export
// offline. Warm it up once the app is idle: after that it's in memory (and the service worker's
// cache), so Export works without internet.
let pdfLib: Promise<typeof import('pdf-lib')> | null = null;
const loadPdfLib = () => {
  pdfLib ??= import('pdf-lib').catch((e) => {
    pdfLib = null; // allow a retry once back online
    throw e;
  });
  return pdfLib;
};
const idle = window.requestIdleCallback ?? ((fn: () => void) => setTimeout(fn, 2000));
idle(() => {
  loadPdfLib().catch(() => {});
});

/** World-space box around everything on the page; a default canvas if it's empty. */
function contentBox(p: Page) {
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const im of p.images) {
    const k = imageBox(im);
    x0 = Math.min(x0, k[0]);
    y0 = Math.min(y0, k[1]);
    x1 = Math.max(x1, k[2]);
    y1 = Math.max(y1, k[3]);
  }
  const shapeMap = shapesById(p.shapes ?? []);
  for (const sh of p.shapes ?? []) {
    const k = shapeBox(sh, shapeMap);
    x0 = Math.min(x0, k[0]);
    y0 = Math.min(y0, k[1]);
    x1 = Math.max(x1, k[2]);
    y1 = Math.max(y1, k[3]);
  }
  for (const s of p.strokes) {
    const b = bbox(s);
    x0 = Math.min(x0, b[0]);
    y0 = Math.min(y0, b[1]);
    x1 = Math.max(x1, b[2]);
    y1 = Math.max(y1, b[3]);
  }
  for (const t of p.texts) {
    measureCtx.font = fontCss(t);
    const lines = wrapLines(t, (s) => measureCtx.measureText(s).width).length;
    x0 = Math.min(x0, t.x);
    y0 = Math.min(y0, t.y);
    x1 = Math.max(x1, t.x + t.w);
    y1 = Math.max(y1, t.y + lines * t.size * LINE_HEIGHT);
  }
  if (x0 === Infinity) return { x: 0, y: 0, w: 800, h: 600 };
  return { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) };
}

const rgbOf = (hex: string) => {
  const n = Number.parseInt(hex.slice(1, 7), 16);
  return [(n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255] as const;
};

const fileName = (name: string, ext: string) =>
  `${name.replace(/[\\/:*?"<>|]+/g, '-').trim() || 'Inkwell'}.${ext}`;

/** Running inside the Tauri desktop app (any OS)? */
const IN_DESKTOP_APP = '__TAURI_INTERNALS__' in window;

/**
 * Hands the file to the user. Browsers download it; the desktop app's webviews don't reliably
 * honour download links, so there it goes to a Rust command that shows the native "Save as"
 * dialog. Returns false if the user cancelled.
 */
async function download(blob: Blob, name: string): Promise<boolean> {
  if (IN_DESKTOP_APP) {
    const { invoke } = await import('@tauri-apps/api/core');
    const bytes = new Uint8Array(await blob.arrayBuffer());
    return invoke<boolean>('save_export', bytes, {
      headers: { 'x-file-name': encodeURIComponent(name) },
    });
  }
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return true;
}

// --- PNG: the page rendered by the same code that draws the canvas ---

/** Code blocks print as monospace text (code and output) along with the page's text boxes. */
const withCode = (p: Page): Page =>
  p.codes?.length ? { ...p, texts: [...p.texts, ...p.codes.map(codeAsText)] } : p;

async function exportPng(raw: Page, paper: boolean) {
  const p = withCode(raw);
  await loadAll([p]); // pictures must be decoded before they can be drawn
  const target = paper ? { ...p, pageColor: WHITE } : p;
  const b = contentBox(p);
  const c = document.createElement('canvas');
  c.width = Math.ceil((b.w + PNG_MARGIN * 2) * PNG_SCALE);
  c.height = Math.ceil((b.h + PNG_MARGIN * 2) * PNG_SCALE);
  const v = {
    x: (PNG_MARGIN - b.x) * PNG_SCALE,
    y: (PNG_MARGIN - b.y) * PNG_SCALE,
    scale: PNG_SCALE,
  };
  drawPage(c.getContext('2d')!, c.width, c.height, target, v, PNG_SCALE);
  const blob = await new Promise<Blob | null>((r) => c.toBlob(r, 'image/png'));
  if (!blob) throw new Error('Could not encode PNG');
  return download(blob, fileName(p.title, 'png'));
}

/** The page as an SVG file (see svg-export.ts). */
async function exportSvg(raw: Page, paper: boolean) {
  const p = withCode(raw);
  const sheet = sheetOf(p);
  const b = sheet ? { x: 0, y: 0, w: sheet[0], h: sheet[1] } : contentBox(p);
  const margin = sheet ? 0 : PNG_MARGIN;
  const box = { x: b.x - margin, y: b.y - margin, w: b.w + margin * 2, h: b.h + margin * 2 };
  const color = paper ? WHITE : pageColor(p.pageColor);
  const { pageToSvg } = await import('./svg-export');
  const svg = await pageToSvg(p, box, color, isDark(color));
  return download(new Blob([svg], { type: 'image/svg+xml' }), fileName(p.title, 'svg'));
}

// --- PDF: vector strokes via SVG paths, text with the standard PDF fonts ---

async function exportPdf(
  pages: Page[],
  size: Size,
  paper: boolean,
  name: string,
  numbers: boolean,
) {
  const { PDFDocument, StandardFonts, rgb, degrees } = await loadPdfLib();
  await loadAll(pages);
  const embeddedPictures = new Map<string, PDFImage | null>();
  /** PNG and JPEG embed as-is; other formats (WebP, GIF, HEIC...) are converted to PNG first. */
  const embedPicture = async (id: string) => {
    if (embeddedPictures.has(id)) return embeddedPictures.get(id)!;
    let result: PDFImage | null = null;
    const blob = await blobOf(id);
    if (blob) {
      const bytes = new Uint8Array(await blob.arrayBuffer());
      try {
        if (blob.type === 'image/png') result = await doc.embedPng(bytes);
        else if (blob.type === 'image/jpeg') result = await doc.embedJpg(bytes);
      } catch {
        result = null;
      }
      if (!result) {
        const d = bitmap(id);
        if (d) {
          const c = document.createElement('canvas');
          c.width = 'naturalWidth' in d ? d.naturalWidth : d.width;
          c.height = 'naturalHeight' in d ? d.naturalHeight : d.height;
          c.getContext('2d')!.drawImage(d, 0, 0);
          const png = await new Promise<Blob | null>((r) => c.toBlob(r, 'image/png'));
          if (png) result = await doc.embedPng(new Uint8Array(await png.arrayBuffer()));
        }
      }
    }
    embeddedPictures.set(id, result);
    return result;
  };
  const doc = await PDFDocument.create();
  doc.setTitle(name);
  doc.setCreator('Inkwell');
  const fonts = new Map<string, PDFFont>();
  const fontFor = async (font: keyof typeof FONTS, bold: boolean, italic: boolean) => {
    const family = { sans: 'Helvetica', serif: 'TimesRoman', mono: 'Courier', hand: 'Helvetica' }[
      font
    ];
    const slanted = italic || font === 'hand';
    const style =
      family === 'TimesRoman'
        ? `${bold ? 'Bold' : ''}${slanted ? 'Italic' : ''}`
        : `${bold ? 'Bold' : ''}${slanted ? 'Oblique' : ''}`;
    const key = `${family}${style}` as keyof typeof StandardFonts;
    let f = fonts.get(key);
    if (!f) {
      f = await doc.embedFont(StandardFonts[key]);
      fonts.set(key, f);
    }
    return f;
  };
  // ponytail: standard PDF fonts only cover Western European text; others print as "?". Embed a
  // Unicode font (e.g. via @pdf-lib/fontkit) when non-Latin notes matter.
  const printable = (f: PDFFont, s: string) =>
    [...s]
      .map((ch) => {
        try {
          f.encodeText(ch);
          return ch;
        } catch {
          return '?';
        }
      })
      .join('');

  // A Markdown note prints as text pages (as many as it needs); it has no ink or page numbers.
  const noteFonts = async () => {
    const set = {
      regular: await fontFor('sans', false, false),
      bold: await fontFor('sans', true, false),
      italic: await fontFor('sans', false, true),
      boldItalic: await fontFor('sans', true, true),
      mono: await fontFor('mono', false, false),
    };
    return {
      get: (o: { bold?: boolean; italic?: boolean; mono?: boolean }) =>
        o.mono
          ? set.mono
          : o.bold && o.italic
            ? set.boldItalic
            : o.bold
              ? set.bold
              : o.italic
                ? set.italic
                : set.regular,
      printable,
    };
  };

  for (const [index, raw] of pages.entries()) {
    if (raw.md !== undefined) {
      const { drawMarkdown } = await import('./md-pdf');
      await drawMarkdown(
        doc,
        raw.md,
        await noteFonts(),
        rgb,
        size === 'letter' ? [612, 792] : [595.28, 841.89],
      );
      continue;
    }
    const p = withCode(raw);
    const sheet = sheetOf(p);
    // A sheet of paper prints as itself, at its real size; anything beyond its edges is cut off.
    const b = sheet ? { x: 0, y: 0, w: sheet[0], h: sheet[1] } : contentBox(p);
    let pageW: number;
    let pageH: number;
    let scale: number;
    if (sheet) {
      scale = PT_PER_PX;
      pageW = sheet[0] * scale;
      pageH = sheet[1] * scale;
    } else if (size === 'fit') {
      scale = PT_PER_PX;
      pageW = b.w * scale + MARGIN_PT * 2;
      pageH = b.h * scale + MARGIN_PT * 2;
    } else {
      const [w, hgt] = SIZES[size];
      [pageW, pageH] = b.w > b.h ? [hgt, w] : [w, hgt];
      scale = Math.min(PT_PER_PX, (pageW - MARGIN_PT * 2) / b.w, (pageH - MARGIN_PT * 2) / b.h);
    }
    const ox = (pageW - b.w * scale) / 2;
    const oy = (pageH - b.h * scale) / 2;
    const pg = doc.addPage([pageW, pageH]);
    const color = paper ? WHITE : pageColor(p.pageColor);
    const dark = isDark(color);
    const toRgb = (hex: string) => rgb(...rgbOf(hex));
    if (color !== WHITE)
      pg.drawRectangle({ x: 0, y: 0, width: pageW, height: pageH, color: toRgb(color) });
    // A background picture covers the sheet (the page edge cuts off what overflows).
    if (p.background === 'picture' && p.backdrop && sheet) {
      const bg = await embedPicture(p.backdrop);
      if (bg) {
        const k = Math.max(pageW / bg.width, pageH / bg.height);
        pg.drawImage(bg, {
          x: (pageW - bg.width * k) / 2,
          y: (pageH - bg.height * k) / 2,
          width: bg.width * k,
          height: bg.height * k,
        });
      }
    }
    drawPattern(pg, p, b, scale, ox, oy, pageW, pageH, dark, rgb);
    // Pictures go under the ink, embedded at their original quality.
    for (const im of p.images) {
      const embedded = await embedPicture(im.blob);
      if (!embedded) continue;
      const w = im.w * scale;
      const h = im.h * scale;
      // pdf-lib rotates about the image's bottom-left corner; find where that corner lands.
      // World y points down, so the corner is at (-w/2, +h/2) from the centre before rotating.
      const cos = Math.cos(im.angle);
      const sin = Math.sin(im.angle);
      const blx = im.cx + cos * (-im.w / 2) - sin * (im.h / 2);
      const bly = im.cy + sin * (-im.w / 2) + cos * (im.h / 2);
      pg.drawImage(embedded, {
        x: ox + (blx - b.x) * scale,
        y: pageH - (oy + (bly - b.y) * scale),
        width: w,
        height: h,
        rotate: degrees((-im.angle * 180) / Math.PI),
      });
    }
    // Shapes: vector paths in page coordinates (the path origin sits at the page's origin).
    const shapeList = p.shapes ?? [];
    const shapeMap = shapesById(shapeList);
    for (const sh of shapeList) {
      const col = toRgb(inkColor(sh.color, dark));
      const at = { x: ox - b.x * scale, y: pageH - (oy - b.y * scale) };
      const dash = dashArray(sh.dash, sh.width);
      if (isBox(sh) && sh.fill === 'hatch') {
        for (const [a, z] of hatch(sh, Math.max(7, sh.width * 3.5))) {
          pg.drawLine({
            start: { x: at.x + a.x * scale, y: at.y - a.y * scale },
            end: { x: at.x + z.x * scale, y: at.y - z.y * scale },
            thickness: Math.max(1, sh.width * 0.6) * scale,
            color: col,
            opacity: sh.opacity,
          });
        }
      }
      const filled = isBox(sh) && (sh.fill === 'tint' || sh.fill === 'solid');
      pg.drawSvgPath(shapeSvgPath(sh, shapeMap), {
        ...at,
        scale,
        ...(filled ? { color: col, opacity: sh.opacity * (sh.fill === 'tint' ? 0.18 : 1) } : {}),
        borderColor: col,
        borderWidth: sh.width * scale,
        borderOpacity: sh.opacity,
        borderLineCap: 1,
        ...(dash.length ? { borderDashArray: dash.map((d) => d * scale) } : {}),
      });
    }
    // PDF y grows upward; SVG paths are drawn downward from (x, y), so anchor at the top-left.
    const ordered = [
      ...p.strokes.filter((s) => s.tool === 'highlighter'),
      ...p.strokes.filter((s) => s.tool !== 'highlighter'),
    ];
    for (const s of ordered) {
      pg.drawSvgPath(svgPath(s, -b.x, -b.y), {
        x: ox,
        y: pageH - oy,
        scale,
        color: toRgb(inkColor(s.color, dark)),
        opacity: s.opacity,
        borderWidth: 0,
      });
    }
    for (const t of p.texts) {
      const font = await fontFor(t.font, t.bold, t.italic);
      const text = printable(font, t.text);
      const lh = t.size * LINE_HEIGHT;
      const lines = wrapLines({ ...t, text }, (s) => font.widthOfTextAtSize(s, t.size));
      // A rotated box turns around its top-left corner, so each line's start turns with it.
      const cos = Math.cos(t.angle ?? 0);
      const sin = Math.sin(t.angle ?? 0);
      lines.forEach((line, i) => {
        const down = (lh - t.size) / 2 + i * lh + t.size * 0.8;
        pg.drawText(line, {
          x: ox + (t.x - sin * down - b.x) * scale,
          y: pageH - (oy + (t.y + cos * down - b.y) * scale),
          size: t.size * scale,
          font,
          color: toRgb(inkColor(t.color, dark)),
          rotate: degrees((-(t.angle ?? 0) * 180) / Math.PI),
        });
      });
    }
    if (numbers && pages.length > 1) {
      const label = `${index + 1} / ${pages.length}`;
      const f = await fontFor('sans', false, false);
      const sizePt = 9;
      pg.drawText(label, {
        x: (pageW - f.widthOfTextAtSize(label, sizePt)) / 2,
        y: Math.min(18, MARGIN_PT / 2),
        size: sizePt,
        font: f,
        color: dark ? rgb(0.75, 0.75, 0.78) : rgb(0.45, 0.45, 0.5),
      });
    }
  }
  const bytes = await doc.save();
  return download(new Blob([bytes.slice()], { type: 'application/pdf' }), fileName(name, 'pdf'));
}

/** Grid, dots or ruled lines across the whole sheet, aligned to the page's world grid. */
function drawPattern(
  pg: PDFPage,
  p: Page,
  b: { x: number; y: number },
  scale: number,
  ox: number,
  oy: number,
  pageW: number,
  pageH: number,
  dark: boolean,
  rgb: typeof import('pdf-lib').rgb,
) {
  if (p.background === 'blank' || p.background === 'picture') return;
  if (isTemplate(p.background)) {
    // Ruled templates are exactly the lines the screen draws, in sheet coordinates.
    const sheet = sheetOf(p);
    if (!sheet) return;
    const color = dark ? rgb(1, 1, 1) : rgb(0, 0, 0);
    for (const s of templateLines(
      p.background as Exclude<Template, 'picture'>,
      sheet[0],
      sheet[1],
    )) {
      pg.drawLine({
        start: { x: ox + (s.x1 - b.x) * scale, y: pageH - (oy + (s.y1 - b.y) * scale) },
        end: { x: ox + (s.x2 - b.x) * scale, y: pageH - (oy + (s.y2 - b.y) * scale) },
        thickness: s.strong ? 0.9 : 0.5,
        color,
        opacity: s.strong ? 0.3 : 0.12,
      });
    }
    return;
  }
  const step = 32 * scale;
  const startX = ox - (((b.x % 32) + 32) % 32) * scale;
  const startY = oy - (((b.y % 32) + 32) % 32) * scale;
  const color = dark ? rgb(1, 1, 1) : rgb(0, 0, 0);
  const opacity = 0.12;
  const xs: number[] = [];
  const ys: number[] = [];
  for (let x = startX - step * Math.ceil(startX / step); x < pageW; x += step) xs.push(x);
  for (let y = startY - step * Math.ceil(startY / step); y < pageH; y += step) ys.push(y);
  if (p.background === 'dots') {
    for (const x of xs)
      for (const y of ys) pg.drawCircle({ x, y: pageH - y, size: 0.9, color, opacity });
    return;
  }
  for (const y of ys) {
    pg.drawLine({
      start: { x: 0, y: pageH - y },
      end: { x: pageW, y: pageH - y },
      thickness: 0.5,
      color,
      opacity,
    });
  }
  if (p.background === 'grid') {
    for (const x of xs) {
      pg.drawLine({ start: { x, y: 0 }, end: { x, y: pageH }, thickness: 0.5, color, opacity });
    }
  }
}

// --- Panel ---

/** A Markdown note exports as its .md file. */
function markdownPanel(p: Page): HTMLElement {
  return h(
    'div',
    { class: 'style-panel export-panel' },
    h('div', { class: 'panel-title' }, 'Export'),
    h('p', { class: 'panel-sub' }, 'A Markdown note saves as a .md file, or prints as PDF pages.'),
    h(
      'button',
      {
        class: 'primary',
        onclick: async () => {
          const blob = new Blob([p.md ?? ''], { type: 'text/markdown' });
          if (await download(blob, fileName(p.title, 'md')))
            toast(IN_DESKTOP_APP ? 'Saved.' : 'Saved — check your Downloads folder.', 3000);
        },
      },
      'Save as .md',
    ),
    h(
      'button',
      {
        class: 'menu-item',
        onclick: async () => {
          try {
            if (await exportPdf([p], 'a4', true, p.title, false))
              toast(IN_DESKTOP_APP ? 'Saved.' : 'Saved — check your Downloads folder.', 3000);
          } catch (e) {
            toast(`Export failed: ${e instanceof Error ? e.message : e}`, 6000);
          }
        },
      },
      'Save as PDF',
    ),
  );
}

function panel(): HTMLElement {
  if (page().md !== undefined) return markdownPanel(page());
  let format: Format = 'pdf';
  let scope: Scope = 'page';
  let size: Size = 'fit';
  let paper = true;
  let numbers = true;
  const chosen = new Set([page().id]);

  const seg = <T extends string>(options: [T, string][], get: () => T, set: (v: T) => void) => {
    const btns = options.map(([v, label]) =>
      h(
        'button',
        {
          class: 'seg',
          onclick: () => {
            set(v);
            refresh();
          },
        },
        h('span', {}, label),
      ),
    );
    const sync = () => {
      for (const [i, b] of btns.entries())
        b.setAttribute('aria-pressed', String(options[i]![0] === get()));
    };
    return { el: h('div', { class: 'segmented' }, ...btns), sync };
  };
  const fmt = seg<Format>(
    [
      ['pdf', 'PDF'],
      ['png', 'PNG'],
      ['svg', 'SVG'],
    ],
    () => format,
    (v) => {
      format = v;
    },
  );
  const scp = seg<Scope>(
    [
      ['page', 'This page'],
      ['pages', 'Choose'],
      ['notebook', 'Notebook'],
    ],
    () => scope,
    (v) => {
      scope = v;
    },
  );
  const sz = seg<Size>(
    [
      ['fit', 'Fit content'],
      ['a4', 'A4'],
      ['letter', 'Letter'],
    ],
    () => size,
    (v) => {
      size = v;
    },
  );
  const list = h(
    'div',
    { class: 'export-pages' },
    ...notebook().sections.flatMap((sec) => [
      h('div', { class: 'panel-sub' }, sec.name),
      ...sec.pages.map((p) => {
        const box = h('input', {
          type: 'checkbox',
          checked: chosen.has(p.id),
          onchange: () => {
            if (box.checked) chosen.add(p.id);
            else chosen.delete(p.id);
          },
        });
        return h('label', { class: 'check' }, box, h('span', {}, p.title));
      }),
    ]),
  );
  const paperBox = h('input', {
    type: 'checkbox',
    checked: paper,
    onchange: () => {
      paper = paperBox.checked;
    },
  });
  const numbersBox = h('input', {
    type: 'checkbox',
    checked: numbers,
    onchange: () => {
      numbers = numbersBox.checked;
    },
  });
  const pdfOnly = h(
    'div',
    { class: 'export-pdf' },
    h('div', { class: 'panel-sub' }, 'Pages'),
    scp.el,
    list,
    h('div', { class: 'panel-sub' }, 'Page size'),
    sz.el,
    h('p', { class: 'export-note' }, 'Pages set to A4, A3 or Letter export at their own size.'),
    h('label', { class: 'check' }, numbersBox, h('span', {}, 'Page numbers')),
  );
  const go = h('button', { class: 'primary', onclick: run }, 'Export');

  function refresh() {
    fmt.sync();
    scp.sync();
    sz.sync();
    pdfOnly.hidden = format !== 'pdf';
    list.hidden = scope !== 'pages';
  }

  async function run() {
    go.disabled = true;
    go.textContent = 'Exporting…';
    try {
      let saved: boolean;
      if (format === 'png') saved = await exportPng(page(), paper);
      else if (format === 'svg') saved = await exportSvg(page(), paper);
      else {
        const all = notebook().sections.flatMap((s) => s.pages);
        const picked =
          scope === 'page'
            ? [page()]
            : scope === 'notebook'
              ? all
              : all.filter((p) => chosen.has(p.id));
        const pages = picked;
        if (!pages.length) {
          toast('Choose at least one page.', 2500);
          return;
        }
        saved = await exportPdf(
          pages,
          size,
          paper,
          scope === 'page' ? page().title : notebook().name,
          numbers,
        );
      }
      if (saved) toast(IN_DESKTOP_APP ? 'Saved.' : 'Exported — check your Downloads folder.', 3000);
    } catch (e) {
      console.error(e);
      const msg = e instanceof Error ? e.message : String(e);
      toast(
        /fetch|import|network/i.test(msg)
          ? 'PDF export needs a one-time download. Connect to the internet once, reopen Inkwell, then it works offline.'
          : `Export failed: ${msg}`,
        8000,
      );
    } finally {
      go.disabled = false;
      go.textContent = 'Export';
    }
  }

  const el = h(
    'div',
    { class: 'style-panel export-panel' },
    h('div', { class: 'panel-title' }, 'Export'),
    fmt.el,
    pdfOnly,
    h(
      'label',
      { class: 'check' },
      paperBox,
      h('span', {}, 'Print-friendly (white paper, black ink)'),
    ),
    go,
  );
  refresh();
  return el;
}

export const exportButton = h(
  'button',
  { class: 'tb-btn', 'aria-label': 'Export', title: 'Export PDF or PNG (Ctrl+E)' },
  icon(FileDown),
);
export const openExport = () => togglePopover(exportButton, panel());
exportButton.addEventListener('click', openExport);
