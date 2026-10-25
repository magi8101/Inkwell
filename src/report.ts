import { X } from 'lucide';
import { h, IS_MAC, icon, toast } from './dom';
import { canvasMode, inkStats, lowLatencyCanvas, pressLog } from './ink';
import { bridge } from './linux-pen';
import { notebook, page, state } from './store';

// "Report a problem": a text block of facts about this device and how Inkwell is set up on it, for
// the person who made the app to read. It never contains what is written in a note (only how much
// there is) and nothing is sent anywhere: the user copies or shares it themselves.

const errors: string[] = [];
const remember = (what: string) => {
  errors.push(`${new Date().toISOString().slice(11, 19)} ${what.slice(0, 300)}`);
  if (errors.length > 10) errors.shift();
};
addEventListener('error', (e) =>
  remember(`${e.message} (${e.filename?.split('/').pop()}:${e.lineno})`),
);
addEventListener('unhandledrejection', (e) =>
  remember(`unhandled: ${e.reason instanceof Error ? e.reason.message : String(e.reason)}`),
);

let appVersion = '';
if ('__TAURI_INTERNALS__' in window)
  void import('@tauri-apps/api/app').then(async (m) => {
    appVersion = await m.getVersion();
  });

export function problemReport(): string {
  const p = page();
  const nb = notebook();
  const pages = nb.sections.reduce((n, s) => n + s.pages.length, 0);
  const t = state.tuning;
  const ua = navigator as Navigator & { userAgentData?: { platform?: string } };
  return [
    `Inkwell problem report — ${new Date().toISOString()}`,
    '',
    'APP',
    `  ${appVersion ? `Installed app ${appVersion}` : 'Website'}; theme ${document.documentElement.dataset.theme ?? '?'}`,
    '',
    'DEVICE',
    `  Browser: ${navigator.userAgent}`,
    `  Platform: ${ua.userAgentData?.platform ?? navigator.platform}${IS_MAC ? ' (Mac/iPad)' : ''}; language ${navigator.language}`,
    `  Screen: ${screen.width}×${screen.height} @${devicePixelRatio}x; window ${innerWidth}×${innerHeight}; touch points ${navigator.maxTouchPoints}`,
    `  CPU threads ${navigator.hardwareConcurrency ?? '?'}; memory ${(navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? '?'} GB`,
    '',
    'SPEED',
    `  Canvas: ${lowLatencyCanvas() ? 'low-latency' : 'standard'} (setting: ${canvasMode()}); pen samples: ${inkStats.rawEvents ? 'raw' : 'once per frame'}; predictor ${inkStats.predictor}`,
    `  Frame ${inkStats.frameMs.toFixed(1)} ms; drawing the pen tip ${inkStats.tipMs.toFixed(2)} ms; pen→draw ${inkStats.inputToDrawMs.toFixed(1)} ms; pen→frame ${inkStats.inputToFrameMs.toFixed(1)} ms`,
    `  This page: ${p.strokes.length} strokes, ${p.texts.length} text boxes, ${p.images.length} pictures, ${(p.shapes ?? []).length} shapes; notebook ${pages} pages`,
    ...(appVersion
      ? [
          `  Linux pen bridge: ${bridge.fromSystem} system pen events, ${bridge.swapped} presses seen as pen, ${bridge.unswapped} left as mouse`,
        ]
      : []),
    '',
    'PEN FEEL',
    `  ${Object.entries(t)
      .map(([k, v]) => `${k} ${typeof v === 'number' ? +v.toFixed(3) : v}`)
      .join(', ')}`,
    '',
    'RECENT PRESSES (oldest first)',
    ...pressLog
      .slice(-15)
      .map((q) => `  ${q.type}${q.took ? ' started a stroke' : ` ignored: ${q.why}`}`),
    '',
    'RECENT ERRORS',
    ...(errors.length ? errors.map((e) => `  ${e}`) : ['  none']),
  ].join('\n');
}

export function openProblemReport() {
  const text = problemReport();
  const box = h('textarea', { class: 'share-url report-text', readOnly: true, rows: 14 });
  box.value = text;
  const close = () => overlay.remove();
  const overlay = h(
    'div',
    { class: 'cal-overlay', onclick: (e: Event) => e.target === overlay && close() },
    h(
      'div',
      { class: 'cal-card', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Report a problem' },
      h(
        'header',
        { class: 'cal-head' },
        h('span', { style: 'flex: 1' }, 'Report a problem'),
        h(
          'button',
          { class: 'tb-btn cal-close', 'aria-label': 'Close', onclick: close },
          icon(X, 18),
        ),
      ),
      h(
        'div',
        { class: 'cal-body' },
        h(
          'p',
          { class: 'cal-text' },
          'Describe what went wrong, then send this along with it. It lists your device, how Inkwell is set up and how big the page is, never what you wrote. Nothing is sent from here: copy it or share it yourself.',
        ),
        box,
        h(
          'div',
          { class: 'share-actions' },
          h(
            'button',
            {
              class: 'cal-btn',
              onclick: async () => {
                try {
                  await navigator.clipboard.writeText(text);
                  toast('Copied.', 1500);
                } catch {
                  box.select();
                  toast('Press Ctrl+C to copy.', 2500);
                }
              },
            },
            'Copy',
          ),
          ...(navigator.share
            ? [
                h(
                  'button',
                  {
                    class: 'cal-btn',
                    onclick: () =>
                      void navigator
                        .share({ title: 'Inkwell problem report', text })
                        .catch(() => {}),
                  },
                  'Share…',
                ),
              ]
            : []),
        ),
      ),
    ),
  );
  document.body.append(overlay);
}
