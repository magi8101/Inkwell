import { arrowHead, byId, dashArray, ends, hatch, headSize } from './shape-geom';
import { isBox, type Shape } from './store';
import { inkColor } from './stroke';

// Draws shapes on a canvas whose transform is already the page's. Below the ink, above pictures.

export function drawShapes(c: CanvasRenderingContext2D, shapes: readonly Shape[], dark: boolean) {
  if (!shapes.length) return;
  const map = byId(shapes);
  for (const s of shapes) drawShape(c, s, map, dark);
}

function drawShape(
  c: CanvasRenderingContext2D,
  s: Shape,
  map: ReadonlyMap<string, Shape>,
  dark: boolean,
) {
  const color = inkColor(s.color, dark);
  const fillColor = inkColor(s.fillColor ?? s.color, dark);
  c.save();
  c.lineWidth = s.width;
  c.lineCap = 'round';
  c.lineJoin = 'round';
  c.strokeStyle = color;
  c.fillStyle = color;
  if (!isBox(s)) {
    const { a, b } = ends(s, map);
    c.globalAlpha = s.opacity;
    c.setLineDash(dashArray(s.dash, s.width));
    c.beginPath();
    c.moveTo(a.x, a.y);
    c.lineTo(b.x, b.y);
    c.stroke();
    if (s.kind === 'arrow') {
      const [h1, h2] = arrowHead(a, b, headSize(s));
      c.setLineDash([]);
      c.beginPath();
      c.moveTo(h1.x, h1.y);
      c.lineTo(b.x, b.y);
      c.lineTo(h2.x, h2.y);
      c.stroke();
    }
    c.restore();
    return;
  }
  // A box: draw it in its own frame (centre at the origin), so rotation needs no special case.
  const path = () => {
    c.beginPath();
    if (s.kind === 'ellipse') c.ellipse(0, 0, s.w / 2, s.h / 2, 0, 0, Math.PI * 2);
    else if (s.kind === 'diamond') {
      c.moveTo(0, -s.h / 2);
      c.lineTo(s.w / 2, 0);
      c.lineTo(0, s.h / 2);
      c.lineTo(-s.w / 2, 0);
      c.closePath();
    } else c.rect(-s.w / 2, -s.h / 2, s.w, s.h);
  };
  if (s.fill === 'tint' || s.fill === 'solid') {
    c.save();
    c.fillStyle = fillColor;
    c.translate(s.cx, s.cy);
    c.rotate(s.angle);
    c.globalAlpha = s.opacity * (s.fill === 'tint' ? 0.18 : 1);
    path();
    c.fill();
    c.restore();
  } else if (s.fill === 'hatch') {
    // Hatch lines are worked out already clipped to the shape (world coordinates).
    c.globalAlpha = s.opacity;
    c.strokeStyle = fillColor;
    c.lineWidth = Math.max(1, s.width * 0.6);
    c.beginPath();
    for (const [p, q] of hatch(s, Math.max(7, s.width * 3.5))) {
      c.moveTo(p.x, p.y);
      c.lineTo(q.x, q.y);
    }
    c.stroke();
    c.lineWidth = s.width;
    c.strokeStyle = color;
  }
  c.translate(s.cx, s.cy);
  c.rotate(s.angle);
  c.globalAlpha = s.opacity;
  c.setLineDash(dashArray(s.dash, s.width));
  path();
  c.stroke();
  c.restore();
}
