import type { PDFPageProxy } from 'pdfjs-dist';
import { progressToast, toast } from './dom';
import { storePicture } from './images';
import {
  type ImageItem,
  newPage,
  newSection,
  notebook,
  type Page,
  type Section,
  state,
  uid,
  update,
} from './store';

// Opening a PDF: the whole PDF becomes one long notebook page (or one page per PDF page), with the
// PDF pages as pictures under the ink, in a new folder named after the file, ready to write on.
// Drawn with pdf.js (loaded only when a PDF is opened). ponytail: pages are stored as pictures, so
// exports are raster and the PDF's own text isn't searchable; keep the original and its text layer
// if that's needed.
//
// The long page opens at once: the page appears as soon as the first PDF page has a size, and the
// pictures are added at their final places as they are drawn (four at a time), so writing can start
// while the rest fills in. A PDF opened as separate notebook pages, or found inside a zip, is
// drawn all at once as before (those callers need finished pages).

const PX_PER_PT = 96 / 72; // the page's world px are CSS px; PDF sizes are in points
const SHARPNESS = 2; // rendered at twice the page size, so zooming in stays crisp
const GAP = 24; // between PDF pages stacked on one page, in px
/** Browsers draw nothing on a canvas bigger than this many pixels (iOS Safari: 16.7 million). */
const MAX_CANVAS_PX = 16_000_000;
/** Pages drawn at the same time: measured about 1.3 times faster than one at a time, same pixels. */
const AT_ONCE = 4;

async function openDocument(file: Blob) {
  const pdfjs = await import('pdfjs-dist');
  pdfjs.GlobalWorkerOptions.workerSrc = (
    await import('pdfjs-dist/build/pdf.worker.min.mjs?url')
  ).default;
  const task = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) });
  return { doc: await task.promise, destroy: () => task.destroy() };
}

/** One PDF page drawn to a stored picture: its id, and its size in world px. */
async function pagePicture(pg: PDFPageProxy): Promise<{ blob: string; w: number; h: number }> {
  const size = pg.getViewport({ scale: PX_PER_PT });
  let scale = PX_PER_PT * SHARPNESS;
  // A huge page (a poster) is drawn smaller rather than not at all.
  const pixels = size.width * SHARPNESS * size.height * SHARPNESS;
  if (pixels > MAX_CANVAS_PX) scale *= Math.sqrt(MAX_CANVAS_PX / pixels);
  const view = pg.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(view.width);
  canvas.height = Math.ceil(view.height);
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#fff'; // PDFs assume white paper
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await pg.render({ canvas, canvasContext: ctx, viewport: view }).promise;
  const jpeg = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', 0.9));
  if (!jpeg) throw new Error('couldn’t draw a page');
  const { blob } = await storePicture(jpeg);
  pg.cleanup();
  return { blob, w: size.width, h: size.height };
}

/**
 * A PDF as notebook pages, each with the PDF page as a picture to write on, all drawn before it
 * returns. By default the whole PDF is ONE long page (the PDF pages stacked top to bottom on the
 * infinite canvas, so it scrolls like a document); `single: false` makes one notebook page per PDF
 * page.
 */
type Bar = ReturnType<typeof progressToast>;

export async function pdfPages(
  file: Blob,
  name: string,
  single = true,
  bar?: Bar,
): Promise<Page[]> {
  const say = bar ?? progressToast(`Opening “${name}”…`);
  try {
    return await drawAll(file, name, single, say);
  } finally {
    if (!bar) say.close();
  }
}

async function drawAll(file: Blob, name: string, single: boolean, say: Bar): Promise<Page[]> {
  const { doc, destroy } = await openDocument(file);
  const pages: Page[] = [];
  const stacked: { blob: string; w: number; h: number }[] = [];
  for (let n = 1; n <= doc.numPages; n++) {
    say.set(`Opening “${name}”: page ${n} of ${doc.numPages}…`);
    const pic = await pagePicture(await doc.getPage(n));
    if (single) stacked.push(pic);
    else {
      const picture: ImageItem = {
        id: uid(),
        blob: pic.blob,
        cx: pic.w / 2,
        cy: pic.h / 2,
        w: pic.w,
        h: pic.h,
        angle: 0,
      };
      const page = newPage(doc.numPages > 1 ? `${name} · ${n}` : name);
      page.images = [picture];
      page.pageColor = '#ffffff'; // the paper around the PDF page matches it, in dark mode too
      pages.push(page);
    }
  }
  await destroy();
  if (single) {
    // Pages stacked top to bottom, centred on the widest one.
    const width = Math.max(...stacked.map((p) => p.w));
    let y = 0;
    const page = newPage(name);
    page.images = stacked.map((p) => {
      const img: ImageItem = {
        id: uid(),
        blob: p.blob,
        cx: width / 2,
        cy: y + p.h / 2,
        w: p.w,
        h: p.h,
        angle: 0,
      };
      y += p.h + GAP;
      return img;
    });
    page.pageColor = '#ffffff';
    pages.push(page);
  }
  return pages;
}

/** The long page opens as soon as the first PDF page is known; the pictures arrive as they are drawn. */
async function importLongPage(file: File, name: string, bar: Bar) {
  const { doc, destroy } = await openDocument(file);
  const total = doc.numPages;
  if (!total) {
    await destroy();
    toast(`“${name}” has no pages.`, 4000);
    return;
  }
  let section: Section | null = null;
  let page: Page | null = null;
  // Gone (deleted by the user while it was filling in): stop quietly.
  const alive = () =>
    !!page &&
    state.notebooks.some((n) =>
      n.sections.some((s) => s.id === section?.id && s.pages.some((p) => p.id === page?.id)),
    );
  let top = 0;
  let centre = 0;
  let done = 0;
  let failed = 0;
  const running = new Set<Promise<void>>();
  const draw = async (pg: PDFPageProxy, y: number, w: number, h: number) => {
    try {
      const pic = await pagePicture(pg);
      if (alive()) {
        update(() => {
          page!.images = [
            ...page!.images,
            { id: uid(), blob: pic.blob, cx: centre, cy: y + h / 2, w, h, angle: 0 },
          ];
        });
      }
    } catch (e) {
      console.error(`${name}: a page could not be drawn`, e);
      failed++;
    }
    done++;
    bar.set(`Drawing “${name}”: ${done} of ${total} pages…`);
  };
  for (let n = 1; n <= total; n++) {
    if (page && !alive()) break;
    const pg = await doc.getPage(n);
    const size = pg.getViewport({ scale: PX_PER_PT });
    if (!page) {
      // The page exists from the first PDF page on, empty until its pictures are drawn.
      centre = size.width / 2;
      page = newPage(name);
      page.pageColor = '#ffffff'; // the paper around the PDF page matches it, in dark mode too
      const nb = notebook();
      section = { ...newSection(name, nb.sections.length), pages: [page] };
      update((s) => {
        nb.sections.push(section!);
        s.sectionId = section!.id;
        s.pageId = page!.id;
      });
    }
    const y = top;
    top += size.height + GAP;
    while (running.size >= AT_ONCE) await Promise.race(running);
    const job: Promise<void> = draw(pg, y, size.width, size.height).finally(() => {
      running.delete(job);
    });
    running.add(job);
  }
  await Promise.all(running);
  await destroy();
  if (!alive()) return;
  toast(
    `Opened “${name}”: ${total} page${total === 1 ? '' : 's'}${failed ? `, ${failed} couldn’t be drawn` : ''}, ready to write on.`,
    3500,
  );
}

export async function importPdf(file: File, single = true) {
  const name = file.name.replace(/\.pdf$/i, '') || 'PDF';
  const bar = progressToast(`Opening “${name}”…`);
  try {
    if (single) {
      await importLongPage(file, name, bar);
      return;
    }
    const pages = await pdfPages(file, name, false, bar);
    update((s) => {
      const nb = notebook();
      const folder = { ...newSection(name, nb.sections.length), pages };
      nb.sections.push(folder);
      s.sectionId = folder.id;
      s.pageId = pages[0]!.id;
    });
    toast(
      `Opened “${name}”: ${pages.length} page${pages.length === 1 ? '' : 's'}, ready to write on.`,
      3500,
    );
  } catch (e) {
    console.error(e);
    toast(`Couldn't open “${name}”: ${(e as Error).message ?? e}`, 6000);
  } finally {
    bar.close();
  }
}
