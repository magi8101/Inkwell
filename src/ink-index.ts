import { toast } from './dom';
import { bandStrokes, inkSignature } from './ink-bands';
import { recognizeInk } from './ocr';
import { type Page, state, subscribe, update, whenIdle } from './store';

// Handwriting search: with Pen feel → "Search handwriting" on, each page's ink is read as text on
// this device while the app is idle (never online, whatever the Convert-to-text setting says), and
// the text is kept with the page (inkText) so the sidebar search finds written words. A page is
// read again only when its ink changed (inkSig). One page at a time, a few seconds after the last
// change, so writing is never slowed. ponytail: Tesseract is built for print, so tidy writing is
// found best; the first read downloads its language data once.

const QUIET_MS = 4000;
let timer = 0;
let busy = false;
let told = false;
let failedAt = 0;

/** The next page whose ink isn't indexed yet: the open page first. */
function stale(): Page | null {
  const all = state.notebooks.flatMap((n) => n.sections.flatMap((s) => s.pages));
  const open = all.find((p) => p.id === state.pageId);
  for (const p of open ? [open, ...all] : all) {
    if (p.md !== undefined || !p.strokes.some((s) => s.tool === 'pen')) continue;
    if (p.inkSig !== inkSignature(p.strokes)) return p;
  }
  return null;
}

async function readPage(p: Page): Promise<string> {
  const rows: string[] = [];
  for (const band of bandStrokes(p.strokes)) {
    rows.push(await recognizeInk(band, false));
    await new Promise((r) => setTimeout(r, 30)); // let the page breathe between bands
  }
  return rows
    .join('\n')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

async function run() {
  if (busy || !state.tuning.indexInk || document.hidden) return;
  if (Date.now() - failedAt < 60_000) return; // offline the first time: try again in a minute
  const p = stale();
  if (!p) return;
  busy = true;
  const sig = inkSignature(p.strokes);
  try {
    if (!told) {
      told = true;
      toast('Reading your handwriting for search (on this device)…', 3000);
    }
    const text = await readPage(p);
    update(() => {
      p.inkText = text;
      p.inkSig = sig;
    });
  } catch {
    failedAt = Date.now();
  } finally {
    busy = false;
  }
}

/** Waits for a quiet moment, then reads one page; each finished page schedules the next. */
function schedule() {
  clearTimeout(timer);
  if (!state.tuning.indexInk) return;
  timer = window.setTimeout(() => whenIdle(() => void run()), QUIET_MS);
}

subscribe(schedule);
schedule();
