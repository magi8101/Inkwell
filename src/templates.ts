import { bitmap } from './images';
import type { Page } from './store';
import { isTemplate, type Template, templateLines } from './template-lines';

// Page templates: ruled layouts for a sheet of paper (they need one, so choosing a template sets
// A4 when the page is on the infinite canvas). The ruling is described once, as line segments in
// sheet coordinates, and drawn from that description on screen, in thumbnails, in PNGs and in PDFs,
// so all of them show exactly the same lines. "picture" lays the page's own background picture,
// scaled to cover the sheet.

/**
 * Draws the template inside the sheet's clip. The context already has the page transform (sheet
 * coordinates); `hair` is the thickness of a thin line in those units.
 */
export function drawTemplate(
  c: CanvasRenderingContext2D,
  p: Page,
  sheet: [number, number],
  dark: boolean,
  hair: number,
) {
  const [w, h] = sheet;
  if (p.background === 'picture') {
    const d = p.backdrop ? bitmap(p.backdrop) : null; // loads it; the canvas redraws when it's ready
    if (!d) return;
    const iw = 'naturalWidth' in d ? d.naturalWidth : d.width;
    const ih = 'naturalHeight' in d ? d.naturalHeight : d.height;
    const k = Math.max(w / iw, h / ih);
    c.drawImage(d, (w - iw * k) / 2, (h - ih * k) / 2, iw * k, ih * k);
    return;
  }
  if (!isTemplate(p.background)) return;
  const ink = dark ? '255,255,255' : '0,0,0';
  const lines = templateLines(p.background as Exclude<Template, 'picture'>, w, h);
  for (const strong of [false, true]) {
    c.beginPath();
    for (const s of lines) {
      if (!!s.strong !== strong) continue;
      c.moveTo(s.x1, s.y1);
      c.lineTo(s.x2, s.y2);
    }
    c.strokeStyle = `rgba(${ink},${strong ? 0.3 : 0.12})`;
    c.lineWidth = strong ? hair * 1.2 : hair;
    c.stroke();
  }
}
