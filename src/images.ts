import { blobGet, blobPut } from './db';
import type { ImageItem, Page } from './store';
import { uid } from './store';

// Pictures on pages. Files are kept full-size in IndexedDB (never re-encoded or downscaled, so a
// zoomed-in screenshot stays sharp); decoded bitmaps are cached in memory for drawing.

type Decoded = ImageBitmap | HTMLImageElement;
const decoded = new Map<string, Decoded>();
const loading = new Map<string, Promise<Decoded | null>>();
const loadedListeners = new Set<() => void>();

/** Called when a picture finishes decoding, so canvases can redraw it. */
export const onImageLoaded = (fn: () => void) => loadedListeners.add(fn);

/** Bumped whenever a picture finishes loading; thumbnails use it to know they're stale. */
export let imagesVersion = 0;

async function decode(blob: Blob): Promise<Decoded> {
  if ('createImageBitmap' in window) {
    try {
      return await createImageBitmap(blob);
    } catch {
      // Some formats (e.g. SVG) can't be bitmap-decoded; fall back to an <img>.
    }
  }
  const img = new Image();
  img.src = URL.createObjectURL(blob);
  await img.decode();
  return img;
}

/** The decoded picture if ready; otherwise starts loading it and returns null for now. */
export function bitmap(id: string): Decoded | null {
  const hit = decoded.get(id);
  if (hit) return hit;
  if (!loading.has(id)) {
    loading.set(
      id,
      blobGet(id)
        .then((b) => (b ? decode(b) : null))
        .then((d) => {
          if (d) {
            decoded.set(id, d);
            imagesVersion++;
            for (const l of loadedListeners) l();
          }
          return d;
        })
        .catch(() => null),
    );
  }
  return null;
}

/** Waits until every picture on these pages is decoded (for export). */
export async function loadAll(pages: Page[]) {
  const ids = [...new Set(pages.flatMap((p) => p.images.map((i) => i.blob)))];
  await Promise.all(
    ids.map((id) => {
      bitmap(id);
      return loading.get(id) ?? Promise.resolve(decoded.get(id) ?? null);
    }),
  );
}

export const blobOf = (id: string) => blobGet(id);

/** Stores a picture file and returns its blob id and natural size. */
export async function storePicture(
  file: Blob,
): Promise<{ blob: string; width: number; height: number }> {
  const d = await decode(file);
  const id = uid();
  await blobPut(id, file);
  decoded.set(id, d);
  const width = 'naturalWidth' in d ? d.naturalWidth : d.width;
  const height = 'naturalHeight' in d ? d.naturalHeight : d.height;
  return { blob: id, width, height };
}

/** Draws a page's pictures (under the ink). Pictures still loading are skipped and redraw later. */
export function drawImages(ctx: CanvasRenderingContext2D, images: readonly ImageItem[]) {
  for (const im of images) {
    const d = bitmap(im.blob);
    if (!d) continue;
    ctx.save();
    ctx.globalAlpha = 1;
    ctx.translate(im.cx, im.cy);
    if (im.angle) ctx.rotate(im.angle);
    ctx.drawImage(d, -im.w / 2, -im.h / 2, im.w, im.h);
    ctx.restore();
  }
}

/** Axis-aligned world box of a (possibly rotated) picture. */
export function imageBox(im: ImageItem): [number, number, number, number] {
  const c = Math.abs(Math.cos(im.angle));
  const s = Math.abs(Math.sin(im.angle));
  const hw = (im.w * c + im.h * s) / 2;
  const hh = (im.w * s + im.h * c) / 2;
  return [im.cx - hw, im.cy - hh, im.cx + hw, im.cy + hh];
}
