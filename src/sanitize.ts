import type { Background, CodeBlock, Shape, Stroke, TextBox } from './store';
import { FONTS } from './stroke';

// What arrives from other people (live sessions, shared links) is data, not code: each function here
// keeps only well-formed items, with sizes capped, and builds fresh objects from known fields.

export const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
export const hex = (v: unknown) => typeof v === 'string' && /^#[\da-f]{6}$/i.test(v);
export function cleanStroke(s: unknown): Stroke | null {
  const x = s as Stroke;
  if (!x || typeof x.id !== 'string' || x.id.length > 64) return null;
  if (x.tool !== 'pen' && x.tool !== 'highlighter') return null;
  if (!hex(x.color) || !num(x.width) || !num(x.opacity) || typeof x.pressure !== 'boolean')
    return null;
  if (!Array.isArray(x.points) || x.points.length % 3 || !x.points.every(num)) return null;
  return {
    id: x.id,
    tool: x.tool,
    color: x.color,
    width: x.width,
    opacity: x.opacity,
    pressure: x.pressure,
    points: x.points,
  };
}
export function cleanText(t: unknown): TextBox | null {
  const x = t as TextBox;
  if (!x || typeof x.id !== 'string' || typeof x.text !== 'string' || !(x.font in FONTS))
    return null;
  if (![x.x, x.y, x.w, x.size].every(num) || !hex(x.color)) return null;
  return {
    id: x.id,
    x: x.x,
    y: x.y,
    w: x.w,
    text: x.text.slice(0, 20_000),
    font: x.font,
    size: x.size,
    color: x.color,
    bold: !!x.bold,
    italic: !!x.italic,
    ...(num(x.angle) ? { angle: x.angle } : {}),
  };
}
export function cleanCode(c: unknown): CodeBlock | null {
  const x = c as CodeBlock;
  if (!x || typeof x.id !== 'string' || x.id.length > 64) return null;
  if (![x.x, x.y, x.w].every(num)) return null;
  if (![x.lang, x.compiler, x.code].every((v) => typeof v === 'string')) return null;
  const libs = (Array.isArray(x.libs) ? x.libs : [])
    .filter((l) => typeof l?.id === 'string' && typeof l?.version === 'string')
    .slice(0, 30)
    .map((l) => ({ id: l.id.slice(0, 64), version: l.version.slice(0, 64) }));
  return {
    id: x.id,
    x: x.x,
    y: x.y,
    w: x.w,
    lang: x.lang.slice(0, 32),
    compiler: x.compiler.slice(0, 64),
    code: x.code.slice(0, 100_000),
    libs,
    output: typeof x.output === 'string' ? x.output.slice(0, 100_000) : '',
    ...(typeof x.stdin === 'string' ? { stdin: x.stdin.slice(0, 20_000) } : {}),
  };
}
const SHAPE_KINDS = ['rect', 'ellipse', 'diamond', 'line', 'arrow'];
export function cleanShape(v: unknown): Shape | null {
  const x = v as Shape;
  if (!x || typeof x.id !== 'string' || x.id.length > 64 || !SHAPE_KINDS.includes(x.kind))
    return null;
  if (![x.cx, x.cy, x.w, x.h, x.angle, x.x1, x.y1, x.x2, x.y2, x.width, x.opacity].every(num))
    return null;
  if (!hex(x.color) || !['none', 'tint', 'solid', 'hatch'].includes(x.fill)) return null;
  if (!['solid', 'dashed', 'dotted'].includes(x.dash)) return null;
  const id = (s: unknown) => (typeof s === 'string' && s.length <= 64 ? s : undefined);
  return {
    id: x.id,
    kind: x.kind,
    cx: x.cx,
    cy: x.cy,
    w: x.w,
    h: x.h,
    angle: x.angle,
    x1: x.x1,
    y1: x.y1,
    x2: x.x2,
    y2: x.y2,
    color: x.color,
    width: Math.min(200, Math.max(0.1, x.width)),
    opacity: Math.min(1, Math.max(0, x.opacity)),
    fill: x.fill,
    ...(hex(x.fillColor) ? { fillColor: x.fillColor } : {}),
    dash: x.dash,
    ...(typeof x.head === 'number' && Number.isFinite(x.head)
      ? { head: Math.min(4, Math.max(0.3, x.head)) }
      : {}),
    ...(id(x.bindStart) ? { bindStart: id(x.bindStart) } : {}),
    ...(id(x.bindEnd) ? { bindEnd: id(x.bindEnd) } : {}),
    ...(id(x.group) ? { group: id(x.group) } : {}),
    ...(x.locked === true ? { locked: true } : {}),
  };
}
export const cleanShapes = (v: unknown) =>
  (Array.isArray(v) ? v : []).map(cleanShape).filter((s): s is Shape => !!s);
export const cleanCodes = (v: unknown) =>
  (Array.isArray(v) ? v : []).map(cleanCode).filter((c): c is CodeBlock => !!c);
export const cleanMd = (v: unknown) => (typeof v === 'string' ? v.slice(0, 500_000) : undefined);
export const BACKGROUNDS: Background[] = [
  'blank',
  'dots',
  'grid',
  'lines',
  'cornell',
  'staff',
  'graph',
];
export const PAPERS = ['a4', 'a3', 'letter'];
