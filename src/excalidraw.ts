import { toast } from './dom';
import { fromExcalidraw } from './excalidraw-format';
import { storePicture } from './images';
import { type ImageItem, newPage, page, section, uid, update } from './store';
import { fitContent } from './viewport';

// Opening an Excalidraw drawing (.excalidraw) as a new page: shapes, arrows (bindings kept), ink,
// text and pictures become the matching Inkwell items. See excalidraw-format.ts for the mapping.
// Saving goes the other way from the Export panel.

export const isExcalidraw = (f: File) => /\.excalidraw$/i.test(f.name);

export async function importExcalidraw(file: File) {
  const name = file.name.replace(/\.excalidraw$/i, '') || 'Excalidraw drawing';
  try {
    const conv = fromExcalidraw(JSON.parse(await file.text()), uid);
    const images: ImageItem[] = [];
    for (const im of conv.images) {
      try {
        const blob = await (await fetch(im.dataUrl)).blob();
        images.push({ ...im.item, blob: (await storePicture(blob)).blob });
      } catch {
        conv.skipped++; // a picture that can't be read
      }
    }
    const p = newPage(name);
    p.strokes = conv.strokes;
    p.texts = conv.texts;
    p.shapes = conv.shapes;
    p.images = images;
    if (conv.background) p.pageColor = conv.background;
    update((s) => {
      const pages = section().pages;
      pages.splice(pages.indexOf(page()) + 1, 0, p);
      s.pageId = p.id;
    });
    setTimeout(fitContent, 150); // show the whole drawing
    toast(
      `Opened “${name}”: ${conv.shapes.length} shapes, ${conv.strokes.length} strokes, ${conv.texts.length} texts, ${images.length} pictures` +
        (conv.skipped ? ` (${conv.skipped} things Inkwell can't show were left out)` : '.'),
      5000,
    );
  } catch (e) {
    toast(
      e instanceof SyntaxError
        ? `“${name}” isn't a valid Excalidraw file.`
        : `Couldn't open “${name}”: ${(e as Error).message}`,
      5000,
    );
  }
}
