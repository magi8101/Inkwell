import { toast } from './dom';
import { storePicture } from './images';
import { type ImageItem, newPage, newSection, notebook, type Page, uid, update } from './store';

// Opening a PDF: the whole PDF becomes one long notebook page (or one page per PDF page), with the
// PDF pages as pictures under the ink, in a new folder named after the file, ready to write on. Drawn with pdf.js (loaded only
// when a PDF is opened). ponytail: pages are stored as pictures, so exports are raster and
// the PDF's own text isn't searchable; keep the original and its text layer if that's needed.

const PX_PER_PT = 96 / 72; // the page's world px are CSS px; PDF sizes are in points
const SHARPNESS = 2; // rendered at twice the page size, so zooming in stays crisp

const GAP = 24; // between PDF pages stacked on one page, in px

/**
 * A PDF as notebook pages, each with the PDF page as a picture to write on. By default the whole
 * PDF is ONE long page (the PDF pages stacked top to bottom on the infinite canvas, so it scrolls
 * like a document); `single: false` makes one notebook page per PDF page.
 */
export async function pdfPages(file: Blob, name: string, single = true): Promise<Page[]> {
  const pdfjs = await import('pdfjs-dist');
  pdfjs.GlobalWorkerOptions.workerSrc = (
    await import('pdfjs-dist/build/pdf.worker.min.mjs?url')
  ).default;
  const task = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) });
  const doc = await task.promise;
  const pages: Page[] = [];
  const stacked: { blob: string; w: number; h: number }[] = [];
  for (let n = 1; n <= doc.numPages; n++) {
    toast(`Opening “${name}”: page ${n} of ${doc.numPages}…`, 60_000);
    const pg = await doc.getPage(n);
    const size = pg.getViewport({ scale: PX_PER_PT });
    const view = pg.getViewport({ scale: PX_PER_PT * SHARPNESS });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(view.width);
    canvas.height = Math.ceil(view.height);
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#fff'; // PDFs assume white paper
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await pg.render({ canvas, canvasContext: ctx, viewport: view }).promise;
    const jpeg = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', 0.9));
    if (!jpeg) throw new Error(`couldn't draw page ${n}`);
    const { blob } = await storePicture(jpeg);
    if (single) stacked.push({ blob, w: size.width, h: size.height });
    else {
      const picture: ImageItem = {
        id: uid(),
        blob,
        cx: size.width / 2,
        cy: size.height / 2,
        w: size.width,
        h: size.height,
        angle: 0,
      };
      const page = newPage(doc.numPages > 1 ? `${name} · ${n}` : name);
      page.images = [picture];
      page.pageColor = '#ffffff'; // the paper around the PDF page matches it, in dark mode too
      pages.push(page);
    }
    pg.cleanup();
  }
  await task.destroy();
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

export async function importPdf(file: File, single = true) {
  const name = file.name.replace(/\.pdf$/i, '') || 'PDF';
  toast(`Opening “${name}”…`, 60_000);
  try {
    const pages = await pdfPages(file, name, single);
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
  }
}
