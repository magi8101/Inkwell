import { Gauge } from 'lucide';
import { h, icon, togglePopover } from './dom';
import { inkTrailAvailable, lowLatencyCanvas } from './ink';
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
  const toggle = (key: 'prediction' | 'inkTrail', label: string) => {
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
    toggle('inkTrail', 'Windows Ink trail'),
  ];
  const all = [...rows, ...toggles];
  const refresh = () => {
    for (const r of all) r.sync();
  };
  const el = h(
    'div',
    { class: 'style-panel tune-panel' },
    h('div', { class: 'panel-title' }, 'Pen feel'),
    ...rows.map((r) => r.el),
    ...toggles.map((t) => t.el),
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
