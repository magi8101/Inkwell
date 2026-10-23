import { SERVER } from './dom';
import { type Stroke, state } from './store';
import { bbox, drawStroke } from './stroke';

// Handwriting → text. Optionally online (Pen feel → "read handwriting online": a vision model on
// Inkwell's Cloudflare Worker, free daily allowance), otherwise on this device. Where the browser has the Handwriting Recognition API
// (Chrome on ChromeOS, some Android) it reads the pen strokes themselves, which is the most
// accurate. Everywhere else the ink is drawn black on white and read by Tesseract (open-source
// OCR, loaded on first use; the notes never leave the device). Tesseract is built for print, so
// clear, separated handwriting works best.

type HWPoint = { x: number; y: number; t: number };
interface HWNavigator {
  queryHandwritingRecognizer?: (c: { languages: string[] }) => Promise<unknown>;
  createHandwritingRecognizer?: (c: { languages: string[] }) => Promise<{
    startDrawing(h: { recognitionType: string }): {
      addStroke(s: unknown): void;
      getPrediction(): Promise<{ text: string }[]>;
    };
    finish(): void;
  }>;
}

async function withHandwritingApi(strokes: Stroke[]): Promise<string | null> {
  const nav = navigator as Navigator & HWNavigator;
  const Ctor = (
    window as unknown as { HandwritingStroke?: new () => { addPoint(p: HWPoint): void } }
  ).HandwritingStroke;
  if (!nav.createHandwritingRecognizer || !Ctor) return null;
  try {
    if (
      nav.queryHandwritingRecognizer &&
      !(await nav.queryHandwritingRecognizer({ languages: ['en'] }))
    )
      return null;
    const rec = await nav.createHandwritingRecognizer({ languages: ['en'] });
    const drawing = rec.startDrawing({ recognitionType: 'text' });
    let t = 0;
    for (const s of strokes) {
      const hs = new Ctor();
      // Point times aren't stored; an even pace keeps the order, which is what matters.
      for (let i = 0; i < s.points.length; i += 3) {
        t += 8;
        hs.addPoint({ x: s.points[i]!, y: s.points[i + 1]!, t });
      }
      drawing.addStroke(hs);
      t += 200;
    }
    const best = (await drawing.getPrediction())[0]?.text.trim() ?? '';
    rec.finish();
    return best || null;
  } catch {
    return null;
  }
}

/** The strokes drawn black on white, big enough for OCR. */
function render(strokes: Stroke[]): HTMLCanvasElement {
  const boxes = strokes.map(bbox);
  const x0 = Math.min(...boxes.map((b) => b[0]));
  const y0 = Math.min(...boxes.map((b) => b[1]));
  const x1 = Math.max(...boxes.map((b) => b[2]));
  const y1 = Math.max(...boxes.map((b) => b[3]));
  const scale = Math.min(4, Math.max(1, 900 / Math.max(x1 - x0, y1 - y0)));
  const pad = 40;
  const c = document.createElement('canvas');
  c.width = Math.ceil((x1 - x0) * scale + pad * 2);
  c.height = Math.ceil((y1 - y0) * scale + pad * 2);
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.setTransform(scale, 0, 0, scale, pad - x0 * scale, pad - y0 * scale);
  for (const s of strokes) drawStroke(ctx, { ...s, color: '#000000', opacity: 1 }, false);
  return c;
}

let tesseract: Promise<import('tesseract.js').Worker> | null = null;
async function withTesseract(strokes: Stroke[]): Promise<string> {
  tesseract ??= import('tesseract.js').then(async ({ createWorker }) => {
    const w = await createWorker('eng');
    await w.setParameters({ tessedit_pageseg_mode: '6' as never }); // one block of text
    return w;
  });
  try {
    const { data } = await (await tesseract).recognize(render(strokes));
    return data.text.replace(/\s+\n/g, '\n').trim();
  } catch (e) {
    tesseract = null; // e.g. offline the first time: try again next time
    throw e;
  }
}

/** Opt-in: a picture of the ink, read by a vision model on Inkwell's Cloudflare Worker. */
async function online(strokes: Stroke[]): Promise<string | null> {
  try {
    const png = await new Promise<Blob | null>((r) => render(strokes).toBlob(r, 'image/png'));
    if (!png) return null;
    const res = await fetch(`${SERVER}/api/ocr`, {
      method: 'POST',
      headers: { 'Content-Type': 'image/png' },
      body: png,
    });
    if (!res.ok) return null;
    return ((await res.json()) as { text?: string }).text?.trim() ?? null;
  } catch {
    return null; // offline, or the free daily allowance is used up: read on the device instead
  }
}

/**
 * Reads handwriting. Highlighter marks are ignored. `allowOnline: false` always reads on this
 * device, whatever the online setting says (background indexing never sends anything anywhere).
 */
export async function recognizeInk(strokes: Stroke[], allowOnline = true): Promise<string> {
  const ink = strokes.filter((s) => s.tool === 'pen');
  if (!ink.length) return '';
  if (allowOnline && state.tuning.ocrOnline) {
    const text = await online(ink);
    if (text !== null) return text;
  }
  return (await withHandwritingApi(ink)) ?? (await withTesseract(ink));
}
