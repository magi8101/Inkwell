import { Gauge, X } from 'lucide';
import { fitSettings, median, type PenSample, sampleRate } from './calibration';
import { capture, h, IS_MAC, icon, toast } from './dom';
import { inkStats, inkTrailAvailable, lowLatencyCanvas, pressLog } from './ink';
import { bridge } from './linux-pen';
import { type Tuning, update } from './store';

// "Calibrate my pen": a guided series of tasks with the user's own stylus. Each step measures
// something real (sensor noise, pressure range, speed, palm size, buttons, delay) and the result
// is turned into settings, plus a diagnostic report the user can send to the app's admin.

interface Measurements {
  hover: boolean | null;
  hoverRate: number;
  still: PenSample[];
  light: PenSample[];
  firm: PenSample[];
  fast: PenSample[][];
  /** Quick straight lines, one entry per stroke. */
  lines: PenSample[][];
  palms: number[];
  fingers: number[];
  sideButton: boolean;
  eraserEnd: boolean;
  tilt: boolean;
  penType: string;
  /** Pen-down → the frame that shows it (double-rAF), ms. */
  downToFrame: number[];
  /** Pen-down → next paint as reported by the Event Timing API (Chromium/Firefox), ms. */
  eventTiming: number[];
  /** Pen sample timestamp → our handler, ms. */
  queueDelay: number[];
  frameMs: number[];
  /** Raw input while the wizard is open: "pointermove pen hover" → count, buttons values, sizes. */
  raw: Map<string, number>;
  rawButtons: Set<number>;
  rawMaxContact: number;
}

interface Step {
  title: string;
  text: string;
  guide: 'circle' | 'dot' | 'line' | 'ring' | 'palm' | 'finger' | 'buttons';
  optional?: boolean;
  /** Which line step this is (the light and firm steps share the line guide). */
  id?: 'light' | 'firm' | 'lines';
  /** Returns true once enough data has been collected. */
  done: (m: Measurements) => boolean;
}

const STEPS: Step[] = [
  {
    title: 'Hover',
    text: 'Hold your pen just above the circle without touching the screen, and move it slowly.',
    guide: 'circle',
    optional: true,
    done: (m) => m.hover === true,
  },
  {
    title: 'Hold still',
    text: 'Press the pen tip on the dot and keep it perfectly still for 2 seconds.',
    guide: 'dot',
    done: (m) => m.still.length >= 40 && m.still.at(-1)!.t - m.still[0]!.t >= 2000,
  },
  {
    title: 'Light writing',
    text: 'Write a word along the line using a very light touch.',
    guide: 'line',
    id: 'light',
    done: (m) => m.light.length >= 150,
  },
  {
    title: 'Firm writing',
    text: 'Now write it again, pressing firmly.',
    guide: 'line',
    id: 'firm',
    done: (m) => m.firm.length >= 150,
  },
  {
    title: 'Fast circles',
    text: 'Trace around the ring quickly a few times — as fast as you would write.',
    guide: 'ring',
    done: (m) => m.fast.reduce((n, s) => n + s.length, 0) >= 300,
  },
  {
    title: 'Fast lines',
    text: 'Draw quick straight lines along the line, left to right and back, as fast as you like. Do about six.',
    guide: 'line',
    id: 'lines',
    done: (m) => m.lines.length >= 6,
  },
  {
    title: 'Palm',
    text: 'Put the pen down and rest the side of your hand on the box, as if writing. Hold it for a second.',
    guide: 'palm',
    optional: true,
    done: (m) => m.palms.length >= 10,
  },
  {
    title: 'Finger',
    text: 'Tap the box a few times with one fingertip.',
    guide: 'finger',
    optional: true,
    done: (m) => m.fingers.length >= 3,
  },
  {
    title: 'Pen buttons',
    text: 'If your pen has a side button, hold it while touching the box. If it has an eraser end, flip the pen and touch the box. Skip if neither.',
    guide: 'buttons',
    optional: true,
    done: (m) => m.sideButton && m.eraserEnd,
  },
];

function fresh(): Measurements {
  return {
    hover: null,
    hoverRate: 0,
    still: [],
    light: [],
    firm: [],
    fast: [],
    lines: [],
    palms: [],
    fingers: [],
    sideButton: false,
    eraserEnd: false,
    tilt: false,
    penType: 'none',
    downToFrame: [],
    eventTiming: [],
    queueDelay: [],
    frameMs: [],
    raw: new Map(),
    rawButtons: new Set(),
    rawMaxContact: 0,
  };
}

// --- Results: settings + report ---

interface Result {
  patch: Partial<Tuning>;
  notes: string[];
}

function settingsFrom(m: Measurements): Result {
  const { patch, notes } = fitSettings({
    still: m.still,
    light: m.light,
    firm: m.firm,
    fast: m.fast,
    lines: m.lines,
    fingers: m.fingers,
    palms: m.palms,
    frame: m.frameMs.length ? median(m.frameMs) : inkStats.frameMs,
  });
  // Hover and buttons are reported, not changed: a skipped step doesn't prove the pen lacks them.
  return { patch, notes };
}

const round1 = (v: number) => Math.round(v * 10) / 10;

function latency(m: Measurements) {
  const frame = m.frameMs.length ? median(m.frameMs) : inkStats.frameMs;
  const toFrame = m.downToFrame.length ? median(m.downToFrame) : Number.NaN;
  const et = m.eventTiming.length ? median(m.eventTiming) : Number.NaN;
  const queue = m.queueDelay.length ? median(m.queueDelay) : Number.NaN;
  // Not measurable from inside a browser: the digitiser (typically ~5–15 ms for active pens) and the
  // panel's scan-out/response (~half a frame + a few ms). Stated as an estimate, never as fact.
  const measured = Number.isFinite(et) ? et : toFrame;
  const estimate = Number.isFinite(measured)
    ? [measured + 5 + frame / 2, measured + 15 + frame / 2 + 5]
    : null;
  return { frame, toFrame, et, queue, estimate };
}

function advice(m: Measurements, l: ReturnType<typeof latency>): string[] {
  const out: string[] = [];
  const ua = navigator.userAgent;
  const windows = /Windows/.test(ua);
  const linux = /Linux/.test(ua) && !/Android/.test(ua);
  const brave = 'brave' in navigator;
  const rate = sampleRate(m.fast.flat());
  if (!inkStats.rawEvents) {
    out.push(
      'This browser gives pen samples once per frame. Chrome or Edge deliver them as they happen (pointerrawupdate), which lowers lag.',
    );
  }
  if (windows && !inkTrailAvailable()) {
    out.push(
      'On Windows, Edge (or Chrome) enables the Windows Ink trail, which draws ink under the pen tip ahead of the page.',
    );
  }
  if (brave)
    out.push(
      'Brave: its shields and extensions add work on every frame; Edge usually feels faster with a pen.',
    );
  if (Number.isFinite(l.queue) && l.queue > 4) {
    out.push(
      `Pen samples wait ${round1(l.queue)} ms before the app sees them — the browser is busy. Close other tabs, disable battery saver, plug in.`,
    );
  }
  if (l.frame > 18) {
    out.push(
      `The screen is updating at ${Math.round(1000 / l.frame)} Hz, below 60 Hz — battery saver or power throttling is likely on.`,
    );
  }
  if (rate && rate < 100)
    out.push(
      `The pen reports ${Math.round(rate)} times a second; most active pens do 120–240. Check the pen driver.`,
    );
  if (linux) {
    out.push(
      'Linux: run the browser natively on Wayland (chrome://flags → Preferred Ozone platform → Wayland), use Performance power mode, and on KDE Plasma set the compositor to prefer lower latency.',
    );
  }
  if (!lowLatencyCanvas() && !windows)
    out.push(
      'This browser does not use the low-latency canvas path; ink relies on prediction to hide the delay.',
    );
  if (!out.length)
    out.push('No problems found — this setup is already on the fastest path Inkwell has.');
  return out;
}

let appVersion = '';
if ('__TAURI_INTERNALS__' in window)
  void import('@tauri-apps/api/app').then(async (m) => {
    appVersion = await m.getVersion();
  });

function reportText(m: Measurements, r: Result, applied: boolean): string {
  const l = latency(m);
  const fast = m.fast.flat();
  const lines = [
    `Inkwell pen report — ${new Date().toISOString()}`,
    '',
    'DEVICE',
    `  Browser: ${navigator.userAgent}`,
    `  Platform: ${(navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.platform}${IS_MAC ? ' (Mac/iPad)' : ''}`,
    `  Screen: ${screen.width}×${screen.height} @${devicePixelRatio}x, refresh ≈ ${Math.round(1000 / l.frame)} Hz, touch points ${navigator.maxTouchPoints}`,
    `  CPU threads: ${navigator.hardwareConcurrency ?? '?'}`,
    ...(appVersion
      ? [
          `  App: Inkwell ${appVersion}; pen bridge: ${bridge.fromSystem} pen events from the system, ${bridge.swapped} presses seen as pen, ${bridge.unswapped} presses left as mouse`,
        ]
      : []),
    '',
    'PEN',
    `  Type reported: ${m.penType}; pressure: ${m.light.length ? `${median(m.light.map((s) => s.p)).toFixed(2)} light / ${median(m.firm.map((s) => s.p)).toFixed(2)} firm` : 'n/a'}; tilt: ${m.tilt ? 'yes' : 'no'}`,
    `  Hover: ${m.hover === null ? 'not tested' : m.hover ? `yes (${Math.round(m.hoverRate)} Hz)` : 'no'}; side button: ${m.sideButton ? 'yes' : 'not detected'}; eraser end: ${m.eraserEnd ? 'yes' : 'not detected'}`,
    `  Sample rate while writing: ${Math.round(sampleRate(fast))} Hz`,
    '',
    'RAW INPUT (what the browser delivered during calibration)',
    `  ${[...m.raw].map(([k, n]) => `${k} ×${n}`).join(', ') || 'nothing'}`,
    `  buttons values: ${[...m.rawButtons].sort((a, b) => a - b).join(', ') || 'none'}; largest touch contact: ${Math.round(m.rawMaxContact)} px; pointerrawupdate: ${'onpointerrawupdate' in window ? 'yes' : 'no'}`,
    '',
    'RECENT PRESSES ON THE PAGE (oldest first; write a few letters before running this)',
    ...(pressLog.length
      ? pressLog.map(
          (p) =>
            `  ${p.type} ${p.took ? 'started a stroke' : `ignored: ${p.why}`}${p.sinceLift >= 0 ? `, ${p.sinceLift} ms after the last lift` : ''}`,
        )
      : ['  none yet']),
    '',
    'DELAY (stylus → screen)',
    `  Pen-down → frame on screen (measured): ${Number.isFinite(l.toFrame) ? `${round1(l.toFrame)} ms` : 'n/a'}`,
    `  Pen-down → next paint (Event Timing API): ${Number.isFinite(l.et) ? `${round1(l.et)} ms` : 'not available in this browser (or under 16 ms)'}`,
    `  Pen sample → app (queueing): ${Number.isFinite(l.queue) ? `${round1(l.queue)} ms` : 'n/a'}`,
    `  Estimated end-to-end incl. digitiser and display (not measurable in a browser): ${l.estimate ? `${Math.round(l.estimate[0]!)}–${Math.round(l.estimate[1]!)} ms` : 'n/a'}`,
    `  Pipeline: ${inkStats.rawEvents ? 'raw pen samples' : 'frame-aligned events'}, ${lowLatencyCanvas() ? 'low-latency canvas' : 'standard canvas'}, OS ink trail ${inkTrailAvailable() ? 'on' : 'off'}`,
    '',
    `CALIBRATION (${applied ? 'applied' : 'not applied'})`,
    ...r.notes.map((n) => `  • ${n}`),
    '',
    'HOW TO MAKE IT FASTER',
    ...advice(m, l).map((a) => `  • ${a}`),
    '',
    'RAW',
    `  ${JSON.stringify({ patch: r.patch, latency: l, still: m.still.length, light: m.light.length, firm: m.firm.length, fast: fast.length, palms: m.palms.length, fingers: m.fingers.length })}`,
  ];
  return lines.join('\n');
}

async function shareReport(text: string) {
  const file = new File([text], 'inkwell-pen-report.txt', { type: 'text/plain' });
  try {
    if (navigator.canShare?.({ files: [file] })) {
      await navigator.share({ title: 'Inkwell pen report', files: [file] });
      return;
    }
    if (navigator.share) {
      await navigator.share({ title: 'Inkwell pen report', text });
      return;
    }
  } catch (e) {
    if ((e as Error).name === 'AbortError') return; // user closed the share sheet
  }
  try {
    await navigator.clipboard.writeText(text);
    toast('Report copied — paste it into a message to the admin.', 3500);
  } catch {
    const a = h('a', { href: URL.createObjectURL(file), download: file.name });
    document.body.append(a);
    a.click();
    a.remove();
    toast('Report downloaded.', 2500);
  }
}

// --- Wizard UI ---

export function openCalibration() {
  const m = fresh();
  let index = 0;
  const pad = h('canvas', { class: 'cal-pad', 'aria-label': 'Calibration area' });
  const ctx = pad.getContext('2d')!;
  const title = h('h2', { class: 'cal-title' });
  const text = h('p', { class: 'cal-text' });
  const status = h('p', { class: 'cal-status', 'aria-live': 'polite' });
  const dots = h(
    'div',
    { class: 'cal-dots', 'aria-hidden': 'true' },
    ...STEPS.map(() => h('span')),
  );
  const skip = h('button', { class: 'cal-btn', onclick: () => go(index + 1) }, 'Skip');
  const close = h(
    'button',
    { class: 'tb-btn cal-close', 'aria-label': 'Close calibration', onclick: () => finish() },
    icon(X, 18),
  );
  const body = h('div', { class: 'cal-body' }, title, text, pad, status);
  const card = h(
    'div',
    { class: 'cal-card', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Calibrate your pen' },
    h(
      'header',
      { class: 'cal-head' },
      icon(Gauge, 18),
      h('span', {}, 'Calibrate your pen'),
      dots,
      close,
    ),
    body,
    h('footer', { class: 'cal-foot' }, skip),
  );
  const overlay = h('div', { class: 'cal-overlay' }, card);
  document.body.append(overlay);

  // Everything that arrives, wherever it lands: if a step can't see the pen, this says why.
  const log = (e: Event) => {
    const p = e as PointerEvent;
    const kind = 'pointerType' in p ? p.pointerType || '?' : '';
    const hover = p.type === 'pointermove' && p.buttons === 0 ? ' hover' : '';
    const key = `${e.type}${kind ? ` ${kind}` : ''}${hover}`;
    m.raw.set(key, (m.raw.get(key) ?? 0) + 1);
    if ('buttons' in p) m.rawButtons.add(p.buttons);
    if (kind === 'touch') m.rawMaxContact = Math.max(m.rawMaxContact, p.width, p.height);
  };
  const RAW = [
    'pointerdown',
    'pointermove',
    'pointerup',
    'pointercancel',
    'mousedown',
    'touchstart',
    'contextmenu',
  ];
  for (const t of RAW) addEventListener(t, log, { capture: true, passive: true });
  new MutationObserver((_, obs) => {
    if (overlay.isConnected) return;
    for (const t of RAW) removeEventListener(t, log, { capture: true });
    obs.disconnect();
  }).observe(document.body, { childList: true });

  // Frame interval while calibrating (refresh rate), measured continuously.
  let raf = 0;
  let lastT = 0;
  const tick = (t: number) => {
    if (lastT && t - lastT < 50) m.frameMs.push(t - lastT);
    lastT = t;
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);

  // Event Timing API: real pen-down → next-paint durations where the browser supports it.
  let observer: PerformanceObserver | null = null;
  try {
    observer = new PerformanceObserver((list) => {
      // Only touches on the pad: taps on the wizard's own buttons aren't pen input.
      for (const e of list.getEntries())
        if (e.name === 'pointerdown' && (e as PerformanceEventTiming).target === pad) {
          m.eventTiming.push(e.duration);
        }
    });
    observer.observe({
      type: 'event',
      durationThreshold: 16,
      buffered: false,
    } as PerformanceObserverInit);
  } catch {
    observer = null;
  }

  const size = () => {
    const r = pad.getBoundingClientRect();
    pad.width = Math.round(r.width * devicePixelRatio);
    pad.height = Math.round(r.height * devicePixelRatio);
    drawGuide();
  };
  const ro = new ResizeObserver(size);
  ro.observe(pad);

  function drawGuide() {
    const w = pad.width / devicePixelRatio;
    const hh = pad.height / devicePixelRatio;
    ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
    ctx.clearRect(0, 0, w, hh);
    ctx.strokeStyle = 'rgba(127,127,127,0.55)';
    ctx.fillStyle = 'rgba(127,127,127,0.25)';
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 6]);
    const g = STEPS[index]?.guide;
    ctx.beginPath();
    if (g === 'circle') ctx.arc(w / 2, hh / 2, 50, 0, Math.PI * 2);
    if (g === 'dot') {
      ctx.setLineDash([]);
      ctx.arc(w / 2, hh / 2, 8, 0, Math.PI * 2);
      ctx.fill();
    }
    if (g === 'line') {
      ctx.moveTo(30, hh * 0.65);
      ctx.lineTo(w - 30, hh * 0.65);
    }
    if (g === 'ring') ctx.arc(w / 2, hh / 2, Math.min(w, hh) * 0.35, 0, Math.PI * 2);
    if (g === 'palm' || g === 'finger' || g === 'buttons') ctx.rect(20, 20, w - 40, hh - 40);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  const local = (e: PointerEvent) => {
    const r = pad.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const samplesOf = (e: PointerEvent): PenSample[] => {
    const list = e.getCoalescedEvents?.() ?? [];
    return (list.length ? list : [e]).map((ev) => ({
      ...local(ev),
      t: ev.timeStamp,
      p: ev.pressure > 0 ? ev.pressure : e.pressure > 0 ? e.pressure : 0.5,
    }));
  };
  const ink = (s: PenSample[], color = 'rgba(37,99,235,0.85)') => {
    ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
    ctx.strokeStyle = color;
    ctx.lineCap = 'round';
    for (let i = 1; i < s.length; i++) {
      ctx.lineWidth = 1 + s[i]!.p * 5;
      ctx.beginPath();
      ctx.moveTo(s[i - 1]!.x, s[i - 1]!.y);
      ctx.lineTo(s[i]!.x, s[i]!.y);
      ctx.stroke();
    }
  };

  let current: PenSample[] | null = null;
  let downId = -1;

  pad.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const step = STEPS[index];
    if (!step) return;
    if (e.pointerType !== 'touch') m.penType = e.pointerType;
    if (e.pointerType === 'pen' && (e.button === 2 || e.buttons & 2)) m.sideButton = true;
    if (e.pointerType === 'pen' && (e.button === 5 || e.buttons & 32)) m.eraserEnd = true;
    if (e.tiltX || e.tiltY) m.tilt = true;
    // A stylus with a rubber tip (no pressure, no pen type) reaches the browser as a finger. With no
    // real pen seen, a touch in a drawing step is that stylus: measure it like a pen (flat pressure).
    const drawStep = step.guide === 'dot' || step.guide === 'line' || step.guide === 'ring';
    const stylusAsTouch =
      e.pointerType === 'touch' &&
      drawStep &&
      (m.penType === 'none' || m.penType.startsWith('touch'));
    if (stylusAsTouch) m.penType = 'touch (rubber-tip stylus)';
    if (e.pointerType === 'touch' && !stylusAsTouch) {
      const sz = Math.max(e.width, e.height);
      if (step.guide === 'palm') m.palms.push(sz);
      if (step.guide === 'finger') m.fingers.push(sz);
      progress();
      return;
    }
    // Delay: from the pen-down's hardware timestamp to the frame that will show the response.
    const t0 = e.timeStamp;
    requestAnimationFrame(() => requestAnimationFrame((t) => m.downToFrame.push(t - t0)));
    m.queueDelay.push(performance.now() - e.timeStamp);
    capture(pad, e.pointerId);
    downId = e.pointerId;
    current = samplesOf(e);
  });
  pad.addEventListener('pointermove', (e) => {
    const step = STEPS[index];
    if (!step) return;
    if (e.pointerType === 'pen' && e.buttons === 0 && step.guide === 'circle') {
      const r = pad.getBoundingClientRect();
      if (e.clientX > r.left && e.clientX < r.right) {
        m.hover = true;
        m.hoverRate = Math.max(m.hoverRate, sampleRate(samplesOf(e)) || m.hoverRate);
        progress();
      }
      return;
    }
    if (e.pointerType === 'touch' && e.buttons && e.pointerId !== downId) {
      const sz = Math.max(e.width, e.height);
      if (step.guide === 'palm') m.palms.push(sz);
      progress();
      return;
    }
    if (e.pointerId !== downId || !current) return;
    if (e.tiltX || e.tiltY) m.tilt = true;
    const s = samplesOf(e);
    m.queueDelay.push(performance.now() - e.timeStamp);
    ink([current.at(-1)!, ...s]);
    current.push(...s);
    if (step.guide === 'dot') m.still = current;
    progress();
  });
  const up = (e: PointerEvent) => {
    if (e.pointerId !== downId || !current) return;
    downId = -1;
    const step = STEPS[index];
    if (step?.id === 'light') m.light.push(...current);
    else if (step?.id === 'firm') m.firm.push(...current);
    else if (step?.id === 'lines' && current.length >= 8) m.lines.push(current);
    if (step?.guide === 'ring') m.fast.push(current);
    current = null;
    progress();
  };
  pad.addEventListener('pointerup', up);
  pad.addEventListener('pointercancel', up);
  pad.addEventListener('contextmenu', (e) => e.preventDefault());

  let advancing = 0;
  function progress() {
    const step = STEPS[index];
    if (!step) return;
    const ok = step.done(m);
    status.textContent = ok ? 'Got it ✓' : statusFor(step);
    if (ok && !advancing) advancing = window.setTimeout(() => go(index + 1), 700);
  }
  function statusFor(step: Step) {
    if (step.guide === 'dot' && m.still.length) {
      return `Hold still… ${Math.min(2, (m.still.at(-1)!.t - m.still[0]!.t) / 1000).toFixed(1)} s`;
    }
    if (step.id === 'lines') return `${m.lines.length} of 6 lines`;
    if (step.guide === 'line')
      return `Keep writing… ${Math.min(100, Math.round(((step.id === 'light' ? m.light : m.firm).length / 150) * 100))}%`;
    if (step.guide === 'ring')
      return `Keep going… ${Math.min(100, Math.round((m.fast.flat().length / 300) * 100))}%`;
    return '';
  }

  function go(i: number) {
    clearTimeout(advancing);
    advancing = 0;
    // A step left without the hover it asked for means this pen/screen has no hover.
    if (STEPS[index]?.guide === 'circle' && m.hover === null && i > index) m.hover = false;
    index = i;
    if (index >= STEPS.length) {
      showResult();
      return;
    }
    const step = STEPS[index]!;
    title.textContent = `${index + 1}. ${step.title}`;
    text.textContent = step.text;
    status.textContent = '';
    skip.textContent = step.optional ? 'Skip' : 'Skip step';
    for (const [k, d] of [...dots.children].entries()) d.classList.toggle('on', k <= index);
    drawGuide();
  }

  function showResult() {
    cancelAnimationFrame(raf);
    observer?.disconnect();
    const r = settingsFrom(m);
    const l = latency(m);
    const tips = advice(m, l);
    const delay = Number.isFinite(l.et) ? l.et : l.toFrame;
    let applied = false;
    const list = h('ul', { class: 'cal-list' }, ...r.notes.map((n) => h('li', {}, n)));
    const tipList = h('ul', { class: 'cal-list' }, ...tips.map((n) => h('li', {}, n)));
    const apply = h(
      'button',
      {
        class: 'primary',
        onclick: () => {
          update((s) => {
            s.tuning = { ...s.tuning, ...r.patch };
          });
          applied = true;
          apply.disabled = true;
          apply.textContent = 'Applied ✓';
        },
      },
      'Apply these settings',
    );
    const share = h(
      'button',
      { class: 'cal-btn', onclick: () => void shareReport(reportText(m, r, applied)) },
      'Share report with admin',
    );
    body.replaceChildren(
      h(
        'h2',
        { class: 'cal-title' },
        Object.keys(r.patch).length ? 'Your pen is calibrated' : 'Nothing to calibrate',
      ),
      h(
        'p',
        { class: 'cal-text' },
        Number.isFinite(delay)
          ? `Measured delay from pen-down to the screen: ${round1(delay)} ms in software${l.estimate ? ` (≈ ${Math.round(l.estimate[0]!)}–${Math.round(l.estimate[1]!)} ms end-to-end, estimated)` : ''}.`
          : 'Delay could not be measured on this device.',
      ),
      h('h3', { class: 'cal-sub' }, 'Settings'),
      r.notes.length ? list : h('p', { class: 'cal-text' }, 'Nothing to change.'),
      h('h3', { class: 'cal-sub' }, 'How to make it faster'),
      tipList,
    );
    card.querySelector('.cal-foot')!.replaceChildren(share, apply);
  }

  function finish() {
    cancelAnimationFrame(raf);
    observer?.disconnect();
    ro.disconnect();
    overlay.remove();
  }
  overlay.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') finish();
  });

  go(0);
  close.focus();
}
