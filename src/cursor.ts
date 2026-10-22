import { inkTool, state } from './store';
import { inkColor } from './stroke';
import { pageIsDark, view } from './viewport';

// The pointer over the page (Pen feel → Pen cursor). Without this, Linux shows the mouse arrow
// for a pen and Windows only its own small dot. A CSS cursor is drawn by the system, so it never
// lags behind the pen the way a page element would.

const bg = document.querySelector<HTMLCanvasElement>('#bg')!;
const MAX = 64; // browsers ignore cursors much bigger than this

/** A cursor image from SVG, with its hotspot in the middle. */
function svgCursor(size: number, body: string, fallback: string) {
  const s = Math.ceil(size);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}">${body}</svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") ${s / 2} ${s / 2}, ${fallback}`;
}

function cursorFor(): string {
  const tool = state.tool;
  const mode = state.tuning.cursor;
  const inks = tool === 'pen' || tool === 'highlighter' || tool === 'ruler';
  const erases = tool === 'eraser' || tool === 'pixelEraser';
  if (!inks && !erases) return '';
  if (mode === 'none') return 'none';
  if (mode === 'crosshair') return 'crosshair';
  if (mode === 'custom' && state.tuning.cursorImage) {
    return `url("${state.tuning.cursorImage}") 16 16, crosshair`;
  }
  const edge = pageIsDark() ? 'rgba(255,255,255,0.7)' : 'rgba(0,0,0,0.55)';
  if (erases) {
    const d = Math.min(MAX, Math.max(8, state.eraserWidth));
    return svgCursor(
      d + 2,
      `<circle cx="${(d + 2) / 2}" cy="${(d + 2) / 2}" r="${d / 2}" fill="none" stroke="${edge}" stroke-width="1.5"/>`,
      'crosshair',
    );
  }
  // The dot is the mark the pen will make: its colour, and its width at this zoom.
  const st = state.styles[inkTool(tool)];
  const d = Math.min(MAX - 4, Math.max(4, st.width * view.scale));
  const s = d + 4;
  return svgCursor(
    s,
    `<circle cx="${s / 2}" cy="${s / 2}" r="${d / 2}" fill="${inkColor(st.color, pageIsDark())}" fill-opacity="${Math.max(st.opacity, 0.5)}" stroke="${edge}" stroke-width="1"/>`,
    'crosshair',
  );
}

// Re-checked on pointer movement (a string compare), so zooming or changing pens updates it too.
let shown = '';
const refresh = () => {
  const c = cursorFor();
  if (c !== shown) bg.style.cursor = shown = c;
};
bg.addEventListener('pointerenter', refresh);
bg.addEventListener('pointermove', (e) => {
  if (e.pointerType !== 'touch') refresh();
});

/** Shrinks a picked image to a 32 px cursor (bigger ones are ignored by some systems). */
export async function cursorFromFile(file: Blob): Promise<string> {
  const bmp = await createImageBitmap(file);
  const c = document.createElement('canvas');
  c.width = c.height = 32;
  const k = Math.min(32 / bmp.width, 32 / bmp.height);
  c.getContext('2d')!.drawImage(
    bmp,
    (32 - bmp.width * k) / 2,
    (32 - bmp.height * k) / 2,
    bmp.width * k,
    bmp.height * k,
  );
  return c.toDataURL('image/png');
}
