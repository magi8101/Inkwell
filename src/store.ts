export type Tool = 'pen' | 'highlighter' | 'eraser' | 'pixelEraser' | 'lasso' | 'text' | 'ruler';
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
export interface Page {
  id: string;
  title: string;
  strokes: Stroke[];
  background: Background;
  /** Hex, or 'auto' to follow the theme. */
  pageColor: string;
}
export interface Section {
  id: string;
  name: string;
  color: string;
  pages: Page[];
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
  inkTrail: boolean;
}

export const DEFAULT_TUNING: Tuning = {
  smoothing: 0.75,
  thinning: 0.55,
  pressureGamma: 1,
  palmPx: 100,
  penGraceMs: 300,
  prediction: true,
  inkTrail: true,
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
  snap: boolean;
  theme: 'system' | 'light' | 'dark';
  /** x < 0 means "centre it". */
  toolbar: { x: number; y: number; collapsed: boolean };
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

export const uid = () => crypto.randomUUID();

export const newPage = (title = 'Untitled page'): Page => ({
  id: uid(),
  title,
  strokes: [],
  background: 'blank',
  pageColor: 'auto',
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
    snap: true,
    theme: 'system',
    toolbar: { x: -1, y: 16, collapsed: false },
    sidebarOpen: true,
    query: '',
    tuning: { ...DEFAULT_TUNING },
  };
}

// ponytail: localStorage (~5 MB) keeps everything until file autosave lands; then notebooks move to disk.
function load(): State {
  const base = defaults();
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<State> | null;
    if (saved?.notebooks?.length) {
      const favorites =
        JSON.stringify(saved.favorites) === OLD_DEFAULT_FAVORITES
          ? base.favorites
          : saved.favorites;
      return {
        ...base,
        ...saved,
        favorites: favorites ?? base.favorites,
        query: '',
        tuning: { ...DEFAULT_TUNING, ...saved.tuning },
      };
    }
  } catch {
    // Corrupt or blocked storage: start fresh rather than crash.
  }
  return base;
}

export const state: State = load();
fixSelection(state);

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

export function update(fn: (s: State) => void) {
  fn(state);
  fixSelection(state);
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...state, query: undefined }));
    saveFailed = false;
  } catch {
    // Storage full or blocked. Say so once, loudly: silently dropping notes is the worst outcome.
    if (!saveFailed) {
      saveFailed = true;
      for (const l of saveErrorListeners) l();
    }
  }
  applyTheme();
  for (const l of listeners) l();
}

systemDark.addEventListener('change', () => update(() => {}));

/** Keeps the selected notebook/section/page pointing at something that exists. */
function fixSelection(s: State) {
  if (!s.notebooks.length) s.notebooks.push(newNotebook('My Notebook'));
  for (const n of s.notebooks)
    for (const x of n.sections) for (const p of x.pages) p.strokes ??= [];
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
export const page = () => section().pages.find((p) => p.id === state.pageId)!;
