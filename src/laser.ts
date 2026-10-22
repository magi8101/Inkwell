import { capture } from './dom';
import { state, subscribe } from './store';
import { isPalm, penSeen, touchCount } from './viewport';

// Laser pointer (K): a glowing red trail for presenting that fades from its tail, plus a dot that
// follows a hovering pen or mouse. Screen-space only — never saved, never in undo history.

// ponytail: fixed colour and fade; make them settings if presenters ask.
const COLOR = '255, 45, 45';
const FADE_MS = 1000;
const WIDTH = 5;
const DOT = 7;

const bg = document.querySelector<HTMLCanvasElement>('#bg')!;
const canvas = document.querySelector<HTMLCanvasElement>('#laser')!;
const ctx = canvas.getContext('2d')!;
let dpr = devicePixelRatio;
new ResizeObserver(() => {
  dpr = devicePixelRatio;
  canvas.width = Math.round(canvas.clientWidth * dpr);
  canvas.height = Math.round(canvas.clientHeight * dpr);
}).observe(canvas);

type Pt = { x: number; y: number; t: number; gap: boolean };
let trail: Pt[] = [];
let head: { x: number; y: number; t: number } | null = null;
let drawingId: number | null = null;
let frame = 0;

function paint() {
  frame = 0;
  const now = performance.now();
  trail = trail.filter((p) => now - p.t < FADE_MS);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.lineCap = 'round';
  ctx.shadowColor = `rgba(${COLOR}, 0.9)`;
  ctx.shadowBlur = 12;
  // Each segment fades and thins with its own age, so the tail dissolves smoothly.
  for (let i = 1; i < trail.length; i++) {
    const a = trail[i - 1]!;
    const b = trail[i]!;
    if (b.gap) continue;
    const life = 1 - (now - b.t) / FADE_MS;
    ctx.strokeStyle = `rgba(${COLOR}, ${life})`;
    ctx.lineWidth = WIDTH * (0.35 + 0.65 * life);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }
  const showDot = head && (drawingId !== null || now - head.t < 1500);
  if (showDot && head) {
    ctx.fillStyle = `rgba(${COLOR}, 1)`;
    ctx.beginPath();
    ctx.arc(head.x, head.y, DOT / 2 + 1, 0, Math.PI * 2);
    ctx.fill();
  }
  if (trail.length || showDot) frame = requestAnimationFrame(paint);
}

const kick = () => {
  if (!frame) frame = requestAnimationFrame(paint);
};

const allowed = (e: PointerEvent) =>
  e.pointerType !== 'touch' || (!penSeen && !isPalm(e) && touchCount() === 1);

bg.addEventListener('pointerdown', (e) => {
  if (state.tool !== 'laser' || e.button !== 0 || !allowed(e)) return;
  capture(bg, e.pointerId);
  drawingId = e.pointerId;
  trail.push({ x: e.offsetX, y: e.offsetY, t: performance.now(), gap: true });
  head = { x: e.offsetX, y: e.offsetY, t: performance.now() };
  kick();
});

bg.addEventListener('pointermove', (e) => {
  if (state.tool !== 'laser' || (e.pointerType === 'touch' && drawingId !== e.pointerId)) return;
  const now = performance.now();
  if (drawingId === e.pointerId) {
    const evs = e.getCoalescedEvents?.();
    for (const ev of evs?.length ? evs : [e])
      trail.push({ x: ev.offsetX, y: ev.offsetY, t: now, gap: false });
  }
  head = { x: e.offsetX, y: e.offsetY, t: now };
  kick();
});

const end = (e: PointerEvent) => {
  if (drawingId === e.pointerId) drawingId = null;
};
bg.addEventListener('pointerup', end);
bg.addEventListener('pointercancel', end);
bg.addEventListener('pointerleave', () => {
  head = null;
  kick();
});

subscribe(() => {
  if (state.tool !== 'laser' && (trail.length || head)) {
    trail = [];
    head = null;
    kick();
  }
});
