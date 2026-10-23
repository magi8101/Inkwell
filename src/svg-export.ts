import { blobOf } from './images';
import { byId, dashArray, hatch, svgPath as shapeSvgPath } from './shape-geom';
import { isBox, type Page } from './store';
import { FONTS, fontCss, inkColor, LINE_HEIGHT, svgPath, wrapLines } from './stroke';
import { isTemplate, type Template, templateLines } from './template-lines';

// A page as an SVG file: strokes, shapes, pictures (embedded), text and the page background as real
// vector elements, so it scales and opens in any editor. The page box (an infinite canvas's
// content, or a sheet of paper) is computed by the caller, like for PNG and PDF.

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const num = (n: number) => String(Math.round(n * 100) / 100);

const dataUrl = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });

const measureCtx = document.createElement('canvas').getContext('2d')!;

export async function pageToSvg(
  p: Page,
  box: Box,
  background: string,
  dark: boolean,
): Promise<string> {
  const out: string[] = [];
  const defs: string[] = [];
  const ink = dark ? '255,255,255' : '0,0,0';

  // Page colour, then its pattern or template.
  out.push(
    `<rect x="${num(box.x)}" y="${num(box.y)}" width="${num(box.w)}" height="${num(box.h)}" fill="${background}"/>`,
  );
  if (isTemplate(p.background) && p.background !== 'picture') {
    const lines = templateLines(p.background as Exclude<Template, 'picture'>, box.w, box.h);
    out.push(
      ...lines.map(
        (s) =>
          `<line x1="${num(box.x + s.x1)}" y1="${num(box.y + s.y1)}" x2="${num(box.x + s.x2)}" y2="${num(box.y + s.y2)}" stroke="rgba(${ink},${s.strong ? 0.3 : 0.12})" stroke-width="${s.strong ? 1.2 : 1}"/>`,
      ),
    );
  } else if (p.background === 'picture' && p.backdrop) {
    const blob = await blobOf(p.backdrop);
    if (blob)
      out.push(
        `<image href="${await dataUrl(blob)}" x="${num(box.x)}" y="${num(box.y)}" width="${num(box.w)}" height="${num(box.h)}" preserveAspectRatio="xMidYMid slice"/>`,
      );
  } else if (p.background === 'lines' || p.background === 'grid' || p.background === 'dots') {
    const stroke = `rgba(${ink},0.12)`;
    const body =
      p.background === 'dots'
        ? `<circle cx="0" cy="0" r="0.9" fill="${stroke}"/>`
        : `<path d="M0 0 H32${p.background === 'grid' ? ' M0 0 V32' : ''}" stroke="${stroke}" stroke-width="1" fill="none"/>`;
    defs.push(
      `<pattern id="bgp" x="0" y="0" width="32" height="32" patternUnits="userSpaceOnUse">${body}</pattern>`,
    );
    out.push(
      `<rect x="${num(box.x)}" y="${num(box.y)}" width="${num(box.w)}" height="${num(box.h)}" fill="url(#bgp)"/>`,
    );
  }

  // Pictures sit under everything else.
  for (const im of p.images) {
    const blob = await blobOf(im.blob);
    if (!blob) continue;
    const deg = (im.angle * 180) / Math.PI;
    out.push(
      `<image href="${await dataUrl(blob)}" x="${num(im.cx - im.w / 2)}" y="${num(im.cy - im.h / 2)}" width="${num(im.w)}" height="${num(im.h)}"${deg ? ` transform="rotate(${num(deg)} ${num(im.cx)} ${num(im.cy)})"` : ''}/>`,
    );
  }

  // Shapes, above pictures, under the ink.
  const shapes = p.shapes ?? [];
  const map = byId(shapes);
  for (const s of shapes) {
    const col = inkColor(s.color, dark);
    const dash = dashArray(s.dash, s.width);
    const common = `stroke="${col}" stroke-width="${num(s.width)}" stroke-linecap="round" stroke-linejoin="round"${dash.length ? ` stroke-dasharray="${dash.map(num).join(' ')}"` : ''} opacity="${num(s.opacity)}"`;
    if (isBox(s) && s.fill === 'hatch') {
      const d = hatch(s, Math.max(7, s.width * 3.5))
        .map(([a, b]) => `M${num(a.x)} ${num(a.y)} L${num(b.x)} ${num(b.y)}`)
        .join(' ');
      out.push(
        `<path d="${d}" fill="none" stroke="${col}" stroke-width="${num(Math.max(1, s.width * 0.6))}" opacity="${num(s.opacity)}"/>`,
      );
    }
    const fill =
      isBox(s) && (s.fill === 'tint' || s.fill === 'solid')
        ? `fill="${col}" fill-opacity="${s.fill === 'tint' ? 0.18 : 1}"`
        : 'fill="none"';
    out.push(`<path d="${shapeSvgPath(s, map)}" ${fill} ${common}/>`);
  }

  // Ink: highlighter under pen, like the screen.
  const strokes = [
    ...p.strokes.filter((s) => s.tool === 'highlighter'),
    ...p.strokes.filter((s) => s.tool !== 'highlighter'),
  ];
  for (const s of strokes) {
    out.push(
      `<path d="${svgPath(s, 0, 0)}" fill="${inkColor(s.color, dark)}" opacity="${num(s.opacity)}"/>`,
    );
  }

  // Text boxes: each wrapped line placed like the page lays it out.
  for (const t of p.texts) {
    measureCtx.font = fontCss(t);
    const lines = wrapLines(t, (s) => measureCtx.measureText(s).width);
    const lh = t.size * LINE_HEIGHT;
    const deg = ((t.angle ?? 0) * 180) / Math.PI;
    const family = FONTS[t.font].css.replace(/"/g, "'");
    const tspans = lines
      .map(
        (line, i) =>
          `<tspan x="${num(t.x)}" y="${num(t.y + (lh - t.size) / 2 + i * lh + t.size * 0.8)}">${esc(line) || ' '}</tspan>`,
      )
      .join('');
    out.push(
      `<text font-family="${esc(family)}" font-size="${num(t.size)}"${t.bold ? ' font-weight="bold"' : ''}${t.italic ? ' font-style="italic"' : ''} fill="${inkColor(t.color, dark)}" xml:space="preserve"${deg ? ` transform="rotate(${num(deg)} ${num(t.x)} ${num(t.y)})"` : ''}>${tspans}</text>`,
    );
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${num(box.w)}" height="${num(box.h)}" viewBox="${num(box.x)} ${num(box.y)} ${num(box.w)} ${num(box.h)}">
${defs.length ? `<defs>${defs.join('')}</defs>\n` : ''}${out.join('\n')}
</svg>
`;
}
