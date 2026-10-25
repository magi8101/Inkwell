import { Gauge } from 'lucide';
import { openAbout } from './about';
import { openCalibration } from './calibrate';
import { cursorFromFile } from './cursor';
import { h, icon, toast, togglePopover } from './dom';
import {
  type CanvasMode,
  canvasMode,
  inkStats,
  inkTrailAvailable,
  lowLatencyCanvas,
  setCanvasMode,
} from './ink';
import { DEFAULT_TUNING, state, subscribe, type Tuning, update } from './store';

type NumKey = { [K in keyof Tuning]: Tuning[K] extends number ? K : never }[keyof Tuning];

const SLIDERS: {
  key: NumKey;
  label: string;
  min: number;
  max: number;
  step: number;
  unit?: string;
  hint: string;
}[] = [
  {
    key: 'smoothing',
    label: 'Follow',
    min: 0.2,
    max: 1,
    step: 0.05,
    hint: 'Lower smooths wobble but trails the pen; 1 is raw.',
  },
  {
    key: 'speedGain',
    label: 'Speed boost',
    min: 0,
    max: 1,
    step: 0.05,
    hint: 'Smoothing backs off when you write fast, so quick lines do not lag or round off. 0 = same smoothing at every speed.',
  },
  {
    key: 'pressureLo',
    label: 'Pressure floor',
    min: 0,
    max: 0.5,
    step: 0.01,
    hint: 'The lightest pressure this pen reports while writing; lighter than this counts as 0. Set by calibration.',
  },
  {
    key: 'pressureHi',
    label: 'Pressure ceiling',
    min: 0.5,
    max: 1,
    step: 0.01,
    hint: 'The firmest pressure this pen reaches; this and above counts as full pressure. Set by calibration.',
  },
  {
    key: 'startWarmup',
    label: 'Start fix',
    min: 0,
    max: 6,
    step: 1,
    hint: 'Some pens report a pressure spike at the start of a stroke (a blob). This many first samples take the pressure the stroke settles at.',
  },
  {
    key: 'thinning',
    label: 'Pressure',
    min: 0,
    max: 0.9,
    step: 0.05,
    hint: 'How much pressing harder thickens the line.',
  },
  {
    key: 'pressureGamma',
    label: 'Curve',
    min: 0.4,
    max: 2.5,
    step: 0.1,
    hint: 'Below 1: light touch already thick. Above 1: need to press harder.',
  },
  {
    key: 'predictMs',
    label: 'Predict',
    min: 0,
    max: 40,
    step: 2,
    unit: 'ms',
    hint: 'Used when "Match prediction to screen refresh" is off. More hides lag; too much overshoots on sharp turns.',
  },
  {
    key: 'palmPx',
    label: 'Palm size',
    min: 40,
    max: 300,
    step: 5,
    unit: 'px',
    hint: 'Touches bigger than this are palms. Touch with a finger, then rest your palm, and read "contact" below; set it between the two.',
  },
  {
    key: 'penGraceMs',
    label: 'Pen grace',
    min: 0,
    max: 1500,
    step: 50,
    unit: 'ms',
    hint: 'Touch is ignored this long after the pen leaves the screen.',
  },
];

// Live readings of the last input, so tuning is based on what the hardware actually reports.
const readout = h('pre', { class: 'tune-readout' });
let lastEvent = '';
let samples = 0;
let rate = 0;
let windowStart = performance.now();
addEventListener(
  'pointermove',
  (e) => {
    const n = e.getCoalescedEvents?.().length || 1;
    samples += n;
    const now = performance.now();
    if (now - windowStart >= 500) {
      rate = Math.round((samples * 1000) / (now - windowStart));
      samples = 0;
      windowStart = now;
    }
    lastEvent = [
      `input     ${e.pointerType}${e.buttons ? ` (buttons ${e.buttons})` : ' (hover)'}`,
      `pressure  ${e.pressure.toFixed(3)}`,
      `tilt      ${e.tiltX}°, ${e.tiltY}°`,
      `contact   ${Math.round(e.width)} × ${Math.round(e.height)} px`,
      `samples   ${rate}/s (${n} per event)`,
    ].join('\n');
    if (readout.isConnected) requestAnimationFrame(paint);
  },
  { capture: true, passive: true },
);
function paint() {
  readout.textContent = [
    lastEvent || 'Move the pen or a finger over the page…',
    `ink trail ${inkTrailAvailable() ? 'OS ink trail API on' : 'not available here'}`,
    `pen path  ${inkStats.rawEvents ? 'raw samples (fastest)' : 'frame-aligned events'}`,
    `predict   ${inkStats.predictor}`,
    `tip draw  ${inkStats.tipMs < 0.1 ? '< 0.1' : inkStats.tipMs.toFixed(2)} ms`,
    `frame     ${inkStats.frameMs.toFixed(1)} ms (${Math.round(1000 / inkStats.frameMs)} Hz)`,
    `latency   pen→draw ${inkStats.inputToDrawMs.toFixed(1)} ms · pen→frame ${inkStats.inputToFrameMs.toFixed(1)} ms`,
    `canvas    ${lowLatencyCanvas() ? 'low-latency (desynchronized)' : 'standard'}`,
  ].join('\n');
}

function panel(): HTMLElement {
  const rows = SLIDERS.map((s) => {
    const out = h('output');
    const input = h('input', {
      type: 'range',
      min: s.min,
      max: s.max,
      step: s.step,
      'aria-label': s.label,
      oninput: () =>
        update((st) => {
          st.tuning[s.key] = Number(input.value);
        }),
    });
    const sync = () => {
      input.value = String(state.tuning[s.key]);
      out.textContent = `${state.tuning[s.key]}${s.unit ?? ''}`;
    };
    return {
      el: h('label', { class: 'slider tune', title: s.hint }, h('span', {}, s.label), input, out),
      sync,
    };
  });
  type BoolKey =
    | 'prediction'
    | 'predictAuto'
    | 'inkTrail'
    | 'hoverPreview'
    | 'tapGestures'
    | 'ocrOnline'
    | 'stylusTouchCancel'
    | 'indexInk';
  const toggle = (key: BoolKey, label: string) => {
    const box = h('input', {
      type: 'checkbox',
      onchange: () =>
        update((st) => {
          st.tuning[key] = box.checked;
        }),
    });
    return {
      el: h('label', { class: 'check' }, box, h('span', {}, label)),
      sync: () => {
        box.checked = state.tuning[key];
      },
    };
  };
  const toggles = [
    toggle('prediction', 'Draw predicted points'),
    toggle('predictAuto', 'Match prediction to screen refresh'),
    toggle('inkTrail', 'Windows Ink trail'),
    toggle('hoverPreview', 'Show pen tip while hovering'),
    toggle(
      'ocrOnline',
      'Convert to text: read handwriting online (Cloudflare AI, more accurate; sends a picture of the selected ink)',
    ),
    toggle(
      'indexInk',
      'Search handwriting: read your pages in the background, on this device, so search finds what you wrote',
    ),
    toggle('tapGestures', 'Two-finger tap undo, three-finger tap redo'),
    toggle(
      'stylusTouchCancel',
      'iPad: keep Scribble from interfering with the Pencil (turn on only if the next letter is slow to write)',
    ),
  ];
  /** A labelled row of choices for one setting. */
  const choice = <K extends 'sideButton' | 'eraserEnd' | 'cursor'>(
    key: K,
    title: string,
    options: readonly (readonly [Tuning[K], string])[],
  ) => {
    const btns = options.map(([v, label]) =>
      h(
        'button',
        {
          class: 'seg',
          onclick: () =>
            update((st) => {
              st.tuning[key] = v;
            }),
        },
        h('span', {}, label),
      ),
    );
    return {
      el: h(
        'div',
        { class: 'tune-side' },
        h('div', { class: 'panel-sub' }, title),
        h(
          'div',
          { class: 'segmented', style: `grid-template-columns:repeat(${options.length},1fr)` },
          ...btns,
        ),
      ),
      sync: () => {
        for (const [i, b] of btns.entries()) {
          b.setAttribute('aria-pressed', String(options[i]![0] === state.tuning[key]));
        }
      },
    };
  };
  const side = choice('sideButton', 'Pen side button: tap for tool ring, hold and drag to…', [
    ['eraser', 'Erase'],
    ['pixelEraser', 'Pixel erase'],
    ['menu', 'Menu only'],
  ]);
  const eraserEnd = choice('eraserEnd', 'Pen eraser end (back of the pen):', [
    ['eraser', 'Erase strokes'],
    ['pixelEraser', 'Pixel erase'],
  ]);
  const cursorChoice = choice('cursor', 'Pen cursor over the page:', [
    ['dot', 'Dot'],
    ['crosshair', 'Crosshair'],
    ['none', 'None'],
    ['custom', 'Custom'],
  ]);
  // Custom: pick any picture; it becomes a 32 px cursor.
  const cursorFile = h('input', { type: 'file', accept: 'image/*', hidden: true });
  cursorFile.addEventListener('change', async () => {
    const f = cursorFile.files?.[0];
    if (!f) return;
    try {
      const url = await cursorFromFile(f);
      update((st) => {
        st.tuning.cursorImage = url;
        st.tuning.cursor = 'custom';
      });
    } catch {
      toast("Couldn't read that picture.", 2500);
    }
    cursorFile.value = '';
  });
  const pickCursor = h(
    'button',
    { class: 'menu-item', onclick: () => cursorFile.click() },
    'Choose cursor picture…',
  );
  cursorChoice.el.append(cursorFile, pickCursor);
  const cursorSync = cursorChoice.sync;
  cursorChoice.sync = () => {
    cursorSync();
    pickCursor.hidden = state.tuning.cursor !== 'custom';
  };
  // Choosing Custom without a picture yet asks for one.
  cursorChoice.el.querySelectorAll('button.seg')[3]!.addEventListener('click', () => {
    if (!state.tuning.cursorImage) cursorFile.click();
  });
  // The canvas type is fixed when the page starts, so this one needs a reload.
  const canvasOptions: readonly (readonly [CanvasMode, string])[] = [
    ['auto', 'Auto'],
    ['on', 'Low-latency'],
    ['off', 'Standard'],
  ];
  const canvasBtns = canvasOptions.map(([v, label]) =>
    h(
      'button',
      {
        class: 'seg',
        onclick: () => {
          if (v === canvasMode()) return;
          setCanvasMode(v);
          toast('Reloading to apply the canvas…', 1500);
          setTimeout(() => location.reload(), 600);
        },
      },
      h('span', {}, label),
    ),
  );
  const canvasChoice = {
    el: h(
      'div',
      {
        class: 'tune-side',
        title:
          'Low-latency draws ink straight to the screen, skipping a frame of delay (Chrome, Edge, Brave; Safari ignores it). Auto avoids it where it is slower or misdraws: Windows (its own ink trail is faster) and Android (it can paint the page black). If your device shows ink fine, choose Low-latency.',
      },
      h('div', { class: 'panel-sub' }, 'Canvas (reloads the page):'),
      h('div', { class: 'segmented', style: 'grid-template-columns:repeat(3,1fr)' }, ...canvasBtns),
    ),
    sync: () => {
      for (const [i, b] of canvasBtns.entries())
        b.setAttribute('aria-pressed', String(canvasOptions[i]![0] === canvasMode()));
    },
  };
  const all = [...rows, ...toggles, side, eraserEnd, cursorChoice, canvasChoice];
  const refresh = () => {
    for (const r of all) r.sync();
  };
  const el = h(
    'div',
    { class: 'style-panel tune-panel' },
    h('div', { class: 'panel-title' }, 'Pen feel'),
    h(
      'button',
      {
        class: 'primary',
        onclick: () => {
          openTuning(); // closes this panel
          openCalibration();
        },
      },
      'Calibrate my pen…',
    ),
    ...rows.map((r) => r.el),
    ...toggles.map((t) => t.el),
    side.el,
    eraserEnd.el,
    cursorChoice.el,
    canvasChoice.el,
    readout,
    h(
      'button',
      {
        class: 'menu-item',
        onclick: () =>
          update((st) => {
            st.tuning = { ...DEFAULT_TUNING };
          }),
      },
      'Reset to defaults',
    ),
    h(
      'button',
      {
        class: 'menu-item',
        onclick: () => {
          openTuning(); // closes this panel
          openAbout();
        },
      },
      'About Inkwell — how it works',
    ),
  );
  const unsub = subscribe(refresh);
  new MutationObserver((_, obs) => {
    if (!el.isConnected) {
      unsub();
      obs.disconnect();
    }
  }).observe(document.body, { childList: true });
  refresh();
  paint();
  return el;
}

export const tuneButton = h(
  'button',
  {
    class: 'tb-btn',
    'aria-label': 'Pen feel and palm settings',
    title: 'Pen feel and palm settings (Ctrl+Shift+D)',
  },
  icon(Gauge),
);
export const openTuning = () => togglePopover(tuneButton, panel());
tuneButton.addEventListener('click', openTuning);
