import { kvGet, kvPut } from './db';

export type Tool =
  | 'pen'
  | 'highlighter'
  | 'eraser'
  | 'pixelEraser'
  | 'lasso'
  | 'text'
  | 'ruler'
  | 'laser';
export type InkTool = 'pen' | 'highlighter';
export type Background = 'blank' | 'grid' | 'dots' | 'lines';

export interface Style {
  color: string;
  width: number;
  opacity: number;
}
export interface Favorite extends Style {
  tool: InkTool;
}
export interface Stroke {
  id: string;
  tool: InkTool;
  color: string;
  width: number;
  opacity: number;
  /** True when the points carry real pen pressure; otherwise it is simulated from speed. */
  pressure: boolean;
  /** Flat world-space [x, y, pressure, x, y, pressure, ...]. Strokes are never mutated. */
  points: number[];
}
export type TextFont = 'sans' | 'serif' | 'mono' | 'hand';
export interface TextBox {
  id: string;
  /** World-space top-left corner and wrap width. */
  x: number;
  y: number;
  w: number;
  text: string;
  font: TextFont;
  /** Font size in world px. */
  size: number;
  color: string;
  bold: boolean;
  italic: boolean;
  /** Rotation in radians around the top-left corner (set by turning a lasso selection). */
  angle?: number;
}
/** A picture on the page. Its file lives in IndexedDB ('blobs') under `blob`. */
export interface ImageItem {
  id: string;
  blob: string;
  /** World-space centre, size and rotation (radians), so lasso transforms stay simple. */
  cx: number;
  cy: number;
  w: number;
  h: number;
  angle: number;
}
/** Code that runs on Compiler Explorer (godbolt.org), sitting on the page like a text box. */
export interface CodeBlock {
  id: string;
  /** World-space top-left corner and width. */
  x: number;
  y: number;
  w: number;
  /** Compiler Explorer language id (e.g. 'c++', 'python') and compiler id (e.g. 'g142'). */
  lang: string;
  compiler: string;
  code: string;
  /** Libraries from Compiler Explorer's list, e.g. { id: 'fmt', version: '1100' }. */
  libs: { id: string; version: string }[];
  /** The last run's output, kept with the note. */
  output: string;
}
/** A code block as printable text (code, then its last output), for export. */
export const codeAsText = (c: CodeBlock): TextBox => ({
  id: c.id,
  x: c.x + 12,
  y: c.y + 48,
  w: c.w - 24,
  text: c.output ? `${c.code.trimEnd()}\n\n${c.output}` : c.code.trimEnd(),
  font: 'mono',
  size: 14,
  color: '#1c1c1e',
  bold: false,
  italic: false,
});
export interface Page {
  id: string;
  title: string;
  strokes: Stroke[];
  texts: TextBox[];
  images: ImageItem[];
  /** Absent in notes from before code blocks existed. */
  codes?: CodeBlock[];
  /** Markdown source: set only on Markdown notes (typed pages), which show an editor, not ink. */
  md?: string;
  background: Background;
  /** Hex, or 'auto' to follow the theme. */
  pageColor: string;
}
/** A folder of pages. Folders nest (Obsidian-style) through `parent`; the list stays flat. */
export interface Section {
  id: string;
  name: string;
  color: string;
  pages: Page[];
  /** Id of the folder this one sits in; absent for top-level folders. */
  parent?: string;
  collapsed?: boolean;
}
export interface Notebook {
  id: string;
  name: string;
  sections: Section[];
}

/** Feel settings, adjustable live from the tuning panel (Ctrl+Shift+D). */
export interface Tuning {
  /** 0..1: how far each captured point moves toward the raw pen position (1 = raw). */
  smoothing: number;
  /** 0..1: how much pen pressure changes stroke width. */
  thinning: number;
  /** Pressure curve exponent: below 1 is softer (thick sooner), above 1 is firmer. */
  pressureGamma: number;
  /**
   * Touch contacts wider or taller than this (CSS px) are palms. A fingertip on a Surface at 200%
   * scaling reports ~50 px, a resting palm 150+. (Renamed from palmSize, whose 40 px default
   * rejected real fingers, so old saved values are dropped.)
   */
  palmPx: number;
  /** Ignore touch for this long after the pen was last seen (ms). */
  penGraceMs: number;
  prediction: boolean;
  /** How far ahead the built-in predictor guesses the pen tip, ms (when not automatic). */
  predictMs: number;
  /** Predict one measured display frame ahead (adapts to 60/90/120 Hz screens). */
  predictAuto: boolean;
  inkTrail: boolean;
  /** Show the pen's mark (size and colour) under a hovering pen tip. */
  hoverPreview: boolean;
  /** Two-finger tap undoes, three-finger tap redoes. */
  tapGestures: boolean;
  /** Pen side button: tap opens the tool ring; hold + drag does this (or 'menu': ring on press). */
  sideButton: 'eraser' | 'pixelEraser' | 'menu';
  /** The pen's back (eraser) end: removes whole strokes, or rubs out just what it touches. */
  eraserEnd: 'eraser' | 'pixelEraser';
  /** Pointer over the page for pen and erasers. */
  cursor: 'dot' | 'crosshair' | 'none' | 'custom';
  /** The custom cursor: a 32 px PNG data URL. */
  cursorImage: string;
  /** Convert to text: read handwriting with Cloudflare AI online (more accurate) instead of on the device. */
  ocrOnline: boolean;
}

export const DEFAULT_TUNING: Tuning = {
  smoothing: 0.75,
  thinning: 0.55,
  pressureGamma: 1,
  palmPx: 100,
  penGraceMs: 300,
  prediction: true,
  predictMs: 14,
  predictAuto: true,
  inkTrail: true,
  hoverPreview: true,
  tapGestures: true,
  sideButton: 'eraser',
  eraserEnd: 'eraser',
  cursor: 'dot',
  cursorImage: '',
  ocrOnline: false,
};

export interface State {
  notebooks: Notebook[];
  notebookId: string;
  sectionId: string;
  pageId: string;
  tool: Tool;
  styles: Record<InkTool, Style>;
  eraserWidth: number;
  favorites: Favorite[];
  /** The favourite pen being used; colour/width edits are saved back into it (like OneNote). */
  activeFavorite: number | null;
  snap: boolean;
  /** Concepts-style locks: stop two fingers (and the wheel) from zooming / rotating the page. */
  viewLock: { zoom: boolean; rotate: boolean };
  theme: 'system' | 'light' | 'dark';
  /** x < 0 means "centre it". */
  /** Floating at (x, y), or docked as a vertical bar on one side of the page. */
  toolbar: { x: number; y: number; collapsed: boolean; dock?: 'left' | 'right' };
  sidebarOpen: boolean;
  query: string;
  tuning: Tuning;
}

export const PALETTE = [
  '#1c1c1e',
  '#8e8e93',
  '#e5484d',
  '#f76b15',
  '#ffc53d',
  '#30a46c',
  '#12a594',
  '#0090ff',
  '#3e63dd',
  '#8e4ec6',
  '#d6409f',
  '#ad7f58',
];
const SECTION_COLORS = ['#3e63dd', '#30a46c', '#f76b15', '#8e4ec6', '#d6409f', '#12a594'];

// randomUUID only exists in secure contexts (https/localhost); a LAN-IP visit would crash.
export const uid = (): string =>
  typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;

export const newPage = (title = 'Untitled page'): Page => ({
  id: uid(),
  title,
  strokes: [],
  texts: [],
  images: [],
  background: 'blank',
  pageColor: 'auto',
});

export const newMarkdownPage = (title = 'Untitled note', md = ''): Page => ({
  ...newPage(title),
  md,
});

export const newSection = (name: string, index = 0): Section => ({
  id: uid(),
  name,
  color: SECTION_COLORS[index % SECTION_COLORS.length]!,
  pages: [newPage()],
});

export const newNotebook = (name: string): Notebook => ({
  id: uid(),
  name,
  sections: [newSection('Quick Notes')],
});

export const inkTool = (t: Tool): InkTool => (t === 'highlighter' ? 'highlighter' : 'pen');

/** Changes a pen's style; if a favourite of that pen type is selected, it's updated too. */
export function editStyle(s: State, tool: InkTool, patch: Partial<Style>) {
  Object.assign(s.styles[tool], patch);
  const i = s.activeFavorite;
  if (i !== null && s.favorites[i]?.tool === tool) s.favorites[i] = { tool, ...s.styles[tool] };
}

const KEY = 'inkwell:state';

const pen = (color: string): Favorite => ({ tool: 'pen', color, width: 3, opacity: 1 });
const DEFAULT_FAVORITES: Favorite[] = [
  pen('#1c1c1e'),
  pen('#0090ff'),
  pen('#e5484d'),
  pen('#30a46c'),
  pen('#8e4ec6'),
  { tool: 'highlighter', color: '#ffc53d', width: 18, opacity: 0.4 },
];
// The first release shipped only three pens; upgrade anyone who never changed them.
const OLD_DEFAULT_FAVORITES = JSON.stringify([
  pen('#1c1c1e'),
  pen('#0090ff'),
  pen('#e5484d'),
  { tool: 'highlighter', color: '#ffc53d', width: 18, opacity: 0.4 },
]);

function defaults(): State {
  const nb = newNotebook('My Notebook');
  return {
    notebooks: [nb],
    notebookId: nb.id,
    sectionId: nb.sections[0]!.id,
    pageId: nb.sections[0]!.pages[0]!.id,
    tool: 'pen',
    styles: {
      pen: { color: '#1c1c1e', width: 3, opacity: 1 },
      highlighter: { color: '#ffc53d', width: 18, opacity: 0.4 },
    },
    eraserWidth: 20,
    favorites: DEFAULT_FAVORITES.map((f) => ({ ...f })),
    activeFavorite: null,
    snap: true,
    viewLock: { zoom: false, rotate: false },
    theme: 'system',
    toolbar: { x: -1, y: 16, collapsed: false },
    sidebarOpen: true,
    query: '',
    tuning: { ...DEFAULT_TUNING },
  };
}

// Notes live in IndexedDB (see db.ts). Older versions used localStorage; that copy is read once,
// moved across, and kept under a backup key after the move has committed. If IndexedDB is unavailable (some private
// browsing modes) the app keeps working on localStorage.
let useIdb = true;
let migrated = false;

async function readSaved(): Promise<Partial<State> | null> {
  try {
    const fromDb = await kvGet<Partial<State>>(KEY);
    if (fromDb) return fromDb;
  } catch {
    useIdb = false;
  }
  try {
    const legacy = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<State> | null;
    if (legacy && useIdb) migrated = true;
    return legacy;
  } catch {
    return null; // corrupt or blocked storage: start fresh rather than crash
  }
}

function load(saved: Partial<State> | null): State {
  const base = defaults();
  if (saved?.notebooks?.length) {
    const favorites =
      JSON.stringify(saved.favorites) === OLD_DEFAULT_FAVORITES ? base.favorites : saved.favorites;
    return {
      ...base,
      ...saved,
      favorites: favorites ?? base.favorites,
      query: '',
      tuning: { ...DEFAULT_TUNING, ...saved.tuning },
    };
  }
  return base;
}

// Top-level await: every module that reads the state waits for storage, so nothing renders with
// the wrong notes. Reading IndexedDB takes a few milliseconds.
export const state: State = load(await readSaved());
fixSelection(state);
// Ask the browser not to evict our data under storage pressure (Safari otherwise may for sites
// that aren't installed to the home screen).
navigator.storage?.persist?.().catch(() => {});

// Applied here, before any module renders, so theme-dependent colours resolve correctly.
const systemDark = matchMedia('(prefers-color-scheme: dark)');
const applyTheme = () => {
  document.documentElement.dataset.theme =
    state.theme === 'system' ? (systemDark.matches ? 'dark' : 'light') : state.theme;
};
applyTheme();

const listeners = new Set<() => void>();
const saveErrorListeners = new Set<() => void>();
let saveFailed = false;
export const onSaveError = (fn: () => void) => saveErrorListeners.add(fn);
export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// Saving serialises the whole notebook, which grows with every stroke. Like Windows Ink drying
// ink off the input path, it runs when the app is idle instead of on every pen lift, so the next
// stroke's first samples are never held up. It is flushed immediately when the page is hidden or
// closed, so nothing is lost.
export const whenIdle: (fn: () => void) => void =
  'requestIdleCallback' in window
    ? (fn) => requestIdleCallback(fn, { timeout: 1000 })
    : (fn) => setTimeout(fn, 300);
let savePending = false;

function reportSaveFailure() {
  // Say so once, loudly: silently dropping notes is the worst outcome.
  if (!saveFailed) {
    saveFailed = true;
    for (const l of saveErrorListeners) l();
  }
}

/** Writes the notes now. The returned promise settles when the write is durable. */
export async function saveNow(): Promise<void> {
  savePending = false;
  const snapshot = { ...state, query: undefined };
  if (useIdb) {
    try {
      await kvPut(KEY, snapshot);
      saveFailed = false;
      if (migrated) {
        // The IndexedDB copy is committed. Keep the old copy as a backup rather than deleting it,
        // so even a migration that raced a just-written save can never lose notes.
        migrated = false;
        const old = localStorage.getItem(KEY);
        if (old !== null) {
          localStorage.removeItem(KEY);
          try {
            localStorage.setItem(`${KEY}:backup-before-indexeddb`, old);
          } catch {
            // No room for the backup; the notes themselves are safe in IndexedDB.
          }
        }
      }
      return;
    } catch {
      useIdb = false; // fall through to localStorage
    }
  }
  try {
    localStorage.setItem(KEY, JSON.stringify(snapshot));
    saveFailed = false;
  } catch {
    reportSaveFailure();
  }
}

function scheduleSave() {
  if (savePending) return;
  savePending = true;
  whenIdle(() => {
    if (savePending) void saveNow();
  });
}
const flush = () => {
  if (savePending) void saveNow();
};
addEventListener('pagehide', flush);
// Notes just read from the old localStorage copy are written to IndexedDB straight away.
if (migrated) scheduleSave();
addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flush();
});

export function update(fn: (s: State) => void) {
  fn(state);
  fixSelection(state);
  scheduleSave();
  applyTheme();
  for (const l of listeners) l();
}

systemDark.addEventListener('change', () => update(() => {}));

/** Keeps the selected notebook/section/page pointing at something that exists. */
function fixSelection(s: State) {
  // A favourite stays selected until it's removed or the other ink tool is picked.
  const fav = s.activeFavorite === null ? undefined : s.favorites[s.activeFavorite];
  const otherInk = (s.tool === 'pen' || s.tool === 'highlighter') && fav?.tool !== s.tool;
  if (!fav || otherInk) s.activeFavorite = null;
  if (!s.notebooks.length) s.notebooks.push(newNotebook('My Notebook'));
  for (const n of s.notebooks)
    for (const x of n.sections) {
      // A folder whose parent is gone moves to the top level instead of vanishing from the tree.
      if (x.parent && !n.sections.some((y) => y.id === x.parent)) delete x.parent;
      for (const p of x.pages) {
        p.strokes ??= [];
        p.texts ??= [];
        p.images ??= [];
      }
    }
  const nb = s.notebooks.find((n) => n.id === s.notebookId) ?? s.notebooks[0]!;
  s.notebookId = nb.id;
  if (!nb.sections.length) nb.sections.push(newSection('Quick Notes'));
  const sec = nb.sections.find((x) => x.id === s.sectionId) ?? nb.sections[0]!;
  s.sectionId = sec.id;
  if (!sec.pages.length) sec.pages.push(newPage());
  s.pageId = (sec.pages.find((p) => p.id === s.pageId) ?? sec.pages[0]!).id;
}

export const notebook = () => state.notebooks.find((n) => n.id === state.notebookId)!;
export const section = () => notebook().sections.find((x) => x.id === state.sectionId)!;
/** The folders directly inside `parent` (top level when undefined), in list order. */
export const childFolders = (nb: Notebook, parent?: string) =>
  nb.sections.filter((x) => x.parent === parent);
/** A folder and everything nested inside it. */
export function folderTree(nb: Notebook, root: Section): Section[] {
  return [root, ...childFolders(nb, root.id).flatMap((c) => folderTree(nb, c))];
}
/** Names from the top-level folder down to this one. */
export function folderPath(nb: Notebook, sec: Section): string[] {
  const up = sec.parent && nb.sections.find((x) => x.id === sec.parent);
  return up ? [...folderPath(nb, up), sec.name] : [sec.name];
}
export const page = () => section().pages.find((p) => p.id === state.pageId)!;
