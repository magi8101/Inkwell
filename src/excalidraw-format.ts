import { byId, ends } from './shape-geom.ts';
import type { ImageItem, Shape, Stroke, TextBox } from './store.ts';

// Excalidraw's file format (.excalidraw, JSON) ↔ an Inkwell page. Pure conversion, no browser code
// (pictures arrive and leave as data URLs, passed in and out by the caller), so it runs in Node.
//
//   rectangle, ellipse, diamond  ↔ box shapes        (fill, hatching, dashes, groups, locks, turn)
//   arrow, line (2 points)       ↔ arrows and lines   (bindings to shapes kept)
//   freedraw, longer lines       ↔ ink strokes        (pressure kept)
//   text                         ↔ text boxes
//   image                        ↔ pictures
// Anything else (frames, embeds…) is left out. Excalidraw's hand-drawn "roughness" isn't kept.

type El = Record<string, unknown>;
const HEX6 = /^#[\da-f]{6}$/i;
const HEX3 = /^#([\da-f])([\da-f])([\da-f])$/i;

/** A colour as #rrggbb, or the fallback (for "transparent", names, anything else). */
export function hexOf(c: unknown, fallback: string): string {
  if (typeof c !== 'string') return fallback;
  if (HEX6.test(c)) return c.toLowerCase();
  const m = HEX3.exec(c);
  return m ? `#${m[1]}${m[1]}${m[2]}${m[2]}${m[3]}${m[3]}`.toLowerCase() : fallback;
}
const n = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const str = (v: unknown) => (typeof v === 'string' ? v : '');

export interface ImportedImage {
  item: Omit<ImageItem, 'blob'>;
  /** The picture file as a data URL (from the file's `files` table). */
  dataUrl: string;
}
export interface Imported {
  strokes: Stroke[];
  texts: TextBox[];
  shapes: Shape[];
  images: ImportedImage[];
  /** The canvas colour when it isn't white. */
  background?: string;
  /** How many elements were left out. */
  skipped: number;
}

const FONT: Record<number, TextBox['font']> = { 1: 'hand', 2: 'sans', 3: 'mono' };

export function fromExcalidraw(doc: unknown, uid: () => string): Imported {
  const d = doc as {
    elements?: unknown;
    files?: Record<string, { dataURL?: string }>;
    appState?: { viewBackgroundColor?: string };
  };
  if (!d || !Array.isArray(d.elements)) throw new Error('Not an Excalidraw file');
  const out: Imported = { strokes: [], texts: [], shapes: [], images: [], skipped: 0 };
  const bg = hexOf(d.appState?.viewBackgroundColor, '#ffffff');
  if (bg !== '#ffffff') out.background = bg;
  const els = (d.elements as El[]).filter((e) => e && !e.isDeleted);
  const ids = new Map<string, string>(els.map((e) => [str(e.id), uid()]));
  const groups = new Map<string, string>();

  for (const e of els) {
    const type = str(e.type);
    const x = n(e.x);
    const y = n(e.y);
    const w = n(e.width);
    const h = n(e.height);
    const angle = n(e.angle);
    const color = hexOf(e.strokeColor, '#1e1e1e');
    const opacity = Math.min(1, Math.max(0.05, n(e.opacity, 100) / 100));
    const width = Math.max(1, n(e.strokeWidth, 2));
    const gid =
      Array.isArray(e.groupIds) && typeof e.groupIds[0] === 'string'
        ? (e.groupIds[0] as string)
        : null;
    const group = gid ? (groups.get(gid) ?? groups.set(gid, uid()).get(gid)) : undefined;
    const common = {
      color,
      width,
      opacity,
      dash:
        e.strokeStyle === 'dashed'
          ? ('dashed' as const)
          : e.strokeStyle === 'dotted'
            ? ('dotted' as const)
            : ('solid' as const),
      ...(group ? { group } : {}),
      ...(e.locked === true ? { locked: true } : {}),
    };
    const blank = { cx: 0, cy: 0, w: 0, h: 0, angle: 0, x1: 0, y1: 0, x2: 0, y2: 0 };

    if (type === 'rectangle' || type === 'ellipse' || type === 'diamond') {
      const bgc = hexOf(e.backgroundColor, '');
      const hatched = ['hachure', 'cross-hatch', 'zigzag'].includes(str(e.fillStyle));
      out.shapes.push({
        ...blank,
        ...common,
        id: ids.get(str(e.id))!,
        kind: type === 'rectangle' ? 'rect' : type,
        cx: x + w / 2,
        cy: y + h / 2,
        w: Math.abs(w) || 1,
        h: Math.abs(h) || 1,
        angle,
        fill: !bgc ? 'none' : hatched ? 'hatch' : 'solid',
        ...(bgc ? { fillColor: bgc } : {}),
      });
    } else if (type === 'arrow' || type === 'line') {
      const pts = (Array.isArray(e.points) ? e.points : []) as [number, number][];
      if (pts.length < 2) {
        out.skipped++;
        continue;
      }
      if (pts.length === 2) {
        // The two ends, turned about the element's box centre when it is rotated.
        const cx = x + w / 2;
        const cy = y + h / 2;
        const turn = (p: [number, number]) => {
          const px = x + p[0] - cx;
          const py = y + p[1] - cy;
          return {
            x: cx + px * Math.cos(angle) - py * Math.sin(angle),
            y: cy + px * Math.sin(angle) + py * Math.cos(angle),
          };
        };
        const a = turn(pts[0]!);
        const b = turn(pts[1]!);
        const link = (b: unknown) => {
          const id = (b as { elementId?: string } | null)?.elementId;
          return id && ids.has(id) ? ids.get(id) : undefined;
        };
        const bs = link(e.startBinding);
        const be = link(e.endBinding);
        out.shapes.push({
          ...blank,
          ...common,
          id: ids.get(str(e.id))!,
          kind: type === 'arrow' && e.endArrowhead ? 'arrow' : 'line',
          x1: a.x,
          y1: a.y,
          x2: b.x,
          y2: b.y,
          fill: 'none',
          ...(bs ? { bindStart: bs } : {}),
          ...(be ? { bindEnd: be } : {}),
        });
      } else {
        // A polyline or curve: kept as ink.
        out.strokes.push(
          stroke(
            ids.get(str(e.id))!,
            pts.map(([px, py]) => [x + px, y + py, 0.5]),
            color,
            width,
            opacity,
            false,
          ),
        );
      }
    } else if (type === 'freedraw') {
      const pts = (Array.isArray(e.points) ? e.points : []) as [number, number][];
      const pr = Array.isArray(e.pressures) ? (e.pressures as number[]) : [];
      if (pts.length < 2) {
        out.skipped++;
        continue;
      }
      const real = pr.length === pts.length && e.simulatePressure !== true;
      out.strokes.push(
        stroke(
          ids.get(str(e.id))!,
          pts.map(([px, py], i) => [x + px, y + py, real ? n(pr[i], 0.5) : 0.5]),
          color,
          Math.max(1, width * 1.5),
          opacity,
          real,
        ),
      );
    } else if (type === 'text') {
      out.texts.push({
        id: ids.get(str(e.id))!,
        x,
        y,
        w: Math.max(40, w),
        text: str(e.text),
        font: FONT[n(e.fontFamily)] ?? 'sans',
        size: Math.max(8, n(e.fontSize, 20)),
        color,
        bold: false,
        italic: false,
        ...(angle ? { angle } : {}),
      });
    } else if (type === 'image') {
      const file = d.files?.[str(e.fileId)];
      if (!file?.dataURL) {
        out.skipped++;
        continue;
      }
      out.images.push({
        dataUrl: file.dataURL,
        item: {
          id: ids.get(str(e.id))!,
          cx: x + w / 2,
          cy: y + h / 2,
          w: Math.abs(w) || 1,
          h: Math.abs(h) || 1,
          angle,
        },
      });
    } else out.skipped++;
  }
  return out;
}

function stroke(
  id: string,
  pts: number[][],
  color: string,
  width: number,
  opacity: number,
  pressure: boolean,
): Stroke {
  return {
    id,
    tool: 'pen',
    color,
    width,
    opacity,
    pressure,
    points: pts.flatMap(([x, y, p]) => [
      Math.round(x! * 100) / 100,
      Math.round(y! * 100) / 100,
      p!,
    ]),
  };
}

// --- Inkwell → Excalidraw ---

export interface ExportInput {
  strokes: Stroke[];
  texts: TextBox[];
  shapes: Shape[];
  images: ImageItem[];
  /** Picture files as data URLs by blob id. */
  pictures: Map<string, { dataUrl: string; mime: string }>;
  /** The page colour as #rrggbb. */
  background: string;
}

const FAMILY: Record<TextBox['font'], number> = { hand: 1, sans: 2, serif: 2, mono: 3 };
const mix = (hex: string, t: number) => {
  // `hex` blended towards white by (1 - t): a light tint of the colour.
  const v = Number.parseInt(hex.slice(1), 16);
  const c = [(v >> 16) & 255, (v >> 8) & 255, v & 255].map((x) => Math.round(255 - (255 - x) * t));
  return `#${c.map((x) => x.toString(16).padStart(2, '0')).join('')}`;
};

export function toExcalidraw(
  input: ExportInput,
  now = Date.now(),
  rand: () => number = Math.random,
): object {
  const elements: El[] = [];
  const files: Record<string, object> = {};
  const seed = () => Math.floor(rand() * 2 ** 31);
  const common = (id: string, type: string, extra: El) => ({
    id,
    type,
    angle: 0,
    strokeColor: '#1e1e1e',
    backgroundColor: 'transparent',
    fillStyle: 'solid',
    strokeWidth: 2,
    strokeStyle: 'solid',
    roughness: 0,
    opacity: 100,
    groupIds: [] as string[],
    frameId: null,
    roundness: null,
    seed: seed(),
    version: 1,
    versionNonce: seed(),
    isDeleted: false,
    boundElements: null as { id: string; type: string }[] | null,
    updated: now,
    link: null,
    locked: false,
    ...extra,
  });

  const map = byId(input.shapes);
  const bound = new Map<string, { id: string; type: string }[]>();
  for (const s of input.shapes) {
    if (s.kind !== 'arrow' && s.kind !== 'line') continue;
    for (const target of [s.bindStart, s.bindEnd])
      if (target && map.has(target))
        bound.set(target, [...(bound.get(target) ?? []), { id: s.id, type: 'arrow' }]);
  }

  for (const s of input.shapes) {
    const base = {
      strokeColor: s.color,
      strokeWidth: Math.max(1, Math.round(s.width)),
      strokeStyle: s.dash,
      opacity: Math.round(s.opacity * 100),
      groupIds: s.group ? [s.group] : [],
      locked: !!s.locked,
    };
    if (s.kind === 'rect' || s.kind === 'ellipse' || s.kind === 'diamond') {
      const fillBase = s.fillColor ?? s.color;
      elements.push(
        common(s.id, s.kind === 'rect' ? 'rectangle' : s.kind, {
          ...base,
          x: s.cx - s.w / 2,
          y: s.cy - s.h / 2,
          width: s.w,
          height: s.h,
          angle: s.angle,
          backgroundColor:
            s.fill === 'none' ? 'transparent' : s.fill === 'tint' ? mix(fillBase, 0.18) : fillBase,
          fillStyle: s.fill === 'hatch' ? 'hachure' : 'solid',
          boundElements: bound.get(s.id) ?? null,
        }),
      );
    } else {
      const { a, b } = ends(s, map);
      const link = (id?: string) =>
        id && map.has(id) ? { elementId: id, focus: 0, gap: 4 } : null;
      elements.push(
        common(s.id, s.kind === 'arrow' ? 'arrow' : 'line', {
          ...base,
          x: a.x,
          y: a.y,
          width: Math.abs(b.x - a.x),
          height: Math.abs(b.y - a.y),
          points: [
            [0, 0],
            [b.x - a.x, b.y - a.y],
          ],
          lastCommittedPoint: null,
          startBinding: link(s.bindStart),
          endBinding: link(s.bindEnd),
          startArrowhead: null,
          endArrowhead: s.kind === 'arrow' ? 'arrow' : null,
        }),
      );
    }
  }

  for (const st of input.strokes) {
    const xs = st.points.filter((_, i) => i % 3 === 0);
    const ys = st.points.filter((_, i) => i % 3 === 1);
    const x0 = Math.min(...xs);
    const y0 = Math.min(...ys);
    const pts: number[][] = [];
    const pressures: number[] = [];
    for (let i = 0; i < st.points.length; i += 3) {
      pts.push([st.points[i]! - x0, st.points[i + 1]! - y0]);
      pressures.push(st.points[i + 2]!);
    }
    elements.push(
      common(st.id, 'freedraw', {
        strokeColor: st.color,
        strokeWidth: Math.max(1, Math.round(st.width / 1.5)),
        opacity: Math.round(st.opacity * (st.tool === 'highlighter' ? 0.4 : 1) * 100),
        x: x0,
        y: y0,
        width: Math.max(...xs) - x0,
        height: Math.max(...ys) - y0,
        points: pts,
        pressures: st.pressure ? pressures : [],
        simulatePressure: !st.pressure,
        lastCommittedPoint: null,
      }),
    );
  }

  for (const t of input.texts) {
    const lines = t.text.split('\n').length;
    elements.push(
      common(t.id, 'text', {
        strokeColor: t.color,
        x: t.x,
        y: t.y,
        width: t.w,
        height: lines * t.size * 1.25,
        angle: t.angle ?? 0,
        text: t.text,
        originalText: t.text,
        fontSize: t.size,
        fontFamily: FAMILY[t.font],
        textAlign: 'left',
        verticalAlign: 'top',
        baseline: Math.round(t.size * 0.9),
        containerId: null,
        lineHeight: 1.25,
        autoResize: true,
      }),
    );
  }

  for (const im of input.images) {
    const pic = input.pictures.get(im.blob);
    if (!pic) continue;
    const fileId = `file-${im.id}`;
    files[fileId] = {
      mimeType: pic.mime,
      id: fileId,
      dataURL: pic.dataUrl,
      created: now,
      lastRetrieved: now,
    };
    elements.push(
      common(im.id, 'image', {
        x: im.cx - im.w / 2,
        y: im.cy - im.h / 2,
        width: im.w,
        height: im.h,
        angle: im.angle,
        fileId,
        status: 'saved',
        scale: [1, 1],
        crop: null,
      }),
    );
  }

  return {
    type: 'excalidraw',
    version: 2,
    source: 'https://inkwell.sharmamagi0.workers.dev',
    elements,
    appState: { gridSize: null, viewBackgroundColor: input.background },
    files,
  };
}
