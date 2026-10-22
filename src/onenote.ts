import { toast } from './dom';
import { storePicture } from './images';
import {
  type ImageItem,
  newSection,
  type Page,
  type Stroke,
  type TextBox,
  type TextFont,
  uid,
  update,
} from './store';

// Opens a OneNote section (.one, desktop or OneDrive format) as a new Inkwell section: ink with
// pressure, colour and pen size, text as text boxes, pictures as pictures — all editable. Parsing
// runs in a worker (onenote-worker.ts → the Rust/WebAssembly importer in onenote/).

const MAX_BYTES = 300 * 1024 * 1024; // refuse absurd inputs before handing them to the parser

interface ParsedStroke {
  color: string;
  opacity: number;
  width: number;
  pressure: boolean;
  points: number[];
}
interface ParsedText {
  x: number;
  y: number;
  w: number;
  text: string;
  style: {
    font: string | null;
    size: number;
    bold: boolean;
    italic: boolean;
    color: string | null;
  } | null;
}
interface ParsedImage {
  ext: string;
  data: string;
  x: number;
  y: number;
  w: number;
  h: number;
}
interface Parsed {
  ok: boolean;
  error?: string;
  name?: string;
  pages?: { title: string; strokes: ParsedStroke[]; texts: ParsedText[]; images: ParsedImage[] }[];
}

function parseInWorker(bytes: ArrayBuffer): Promise<Parsed> {
  return new Promise((resolve) => {
    const worker = new Worker(new URL('./onenote-worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<Parsed>) => {
      worker.terminate();
      resolve(e.data);
    };
    worker.onerror = (e) => {
      worker.terminate();
      resolve({ ok: false, error: e.message || 'the importer failed to start' });
    };
    worker.postMessage(bytes, [bytes]);
  });
}

const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  bmp: 'image/bmp',
  webp: 'image/webp',
  tif: 'image/tiff',
  tiff: 'image/tiff',
};

function fontFor(name: string | null): TextFont {
  const n = (name ?? '').toLowerCase();
  if (/mono|consol|courier|cascadia/.test(n)) return 'mono';
  if (/times|georgia|cambria|garamond|serif/.test(n) && !/sans/.test(n)) return 'serif';
  if (/ink free|segoe print|comic|hand|script/.test(n)) return 'hand';
  return 'sans';
}

export async function importOneNote(file: File) {
  if (file.size > MAX_BYTES) {
    toast('That OneNote file is too large to import.', 4000);
    return;
  }
  toast(`Opening ${file.name}…`, 2500);
  const parsed = await parseInWorker(await file.arrayBuffer());
  if (!parsed.ok || !parsed.pages) {
    toast(`Couldn't open ${file.name}: ${parsed.error ?? 'unknown error'}`, 6000);
    return;
  }
  let skippedPictures = 0;
  const pages: Page[] = [];
  for (const p of parsed.pages) {
    const strokes: Stroke[] = p.strokes
      .filter((s) => s.points.length >= 3)
      .map((s) => ({
        id: uid(),
        tool: s.opacity < 0.9 ? 'highlighter' : 'pen',
        color: s.color,
        opacity: s.opacity,
        width: Math.max(0.5, s.width),
        pressure: s.pressure,
        points: s.points.map((v) => Math.round(v * 100) / 100),
      }));
    const texts: TextBox[] = p.texts.map((t) => ({
      id: uid(),
      x: t.x,
      y: t.y,
      w: Math.max(80, t.w),
      text: t.text,
      font: fontFor(t.style?.font ?? null),
      size: t.style?.size ?? 15,
      color: t.style?.color ?? '#1c1c1e',
      bold: t.style?.bold ?? false,
      italic: t.style?.italic ?? false,
    }));
    const images: ImageItem[] = [];
    for (const im of p.images) {
      const type = MIME[im.ext.toLowerCase()];
      if (!type) {
        skippedPictures++; // e.g. EMF/WMF vector pictures, which browsers can't display
        continue;
      }
      try {
        const bytes = Uint8Array.from(atob(im.data), (c) => c.charCodeAt(0));
        const { blob } = await storePicture(new Blob([bytes], { type }));
        images.push({
          id: uid(),
          blob,
          cx: im.x + im.w / 2,
          cy: im.y + im.h / 2,
          w: im.w,
          h: im.h,
          angle: 0,
        });
      } catch {
        skippedPictures++;
      }
    }
    pages.push({
      id: uid(),
      title: p.title,
      strokes,
      texts,
      images,
      background: 'blank',
      pageColor: 'auto',
    });
  }
  // OneNote names a section after its file (the parser only sees the bytes).
  const sectionName = file.name.replace(/\.one$/i, '') || parsed.name || 'OneNote';
  update((s) => {
    const nb = s.notebooks.find((n) => n.id === s.notebookId)!;
    const section = { ...newSection(sectionName, nb.sections.length), pages };
    if (!pages.length) section.pages = newSection(sectionName).pages;
    nb.sections.push(section);
    s.sectionId = section.id;
    s.pageId = section.pages[0]!.id;
  });
  const strokeCount = pages.reduce((n, p) => n + p.strokes.length, 0);
  toast(
    `Opened “${sectionName}”: ${pages.length} page${pages.length === 1 ? '' : 's'}, ${strokeCount} strokes` +
      (skippedPictures
        ? ` (${skippedPictures} picture${skippedPictures === 1 ? '' : 's'} in a format browsers can't show)`
        : ''),
    5000,
  );
}
