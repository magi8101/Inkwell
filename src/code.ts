import { GripVertical, Library, Play, X } from 'lucide';
import { capture, h, icon, toast, togglePopover } from './dom';
import { commitSnapshot, snapshot } from './ink';
import { type CodeBlock, page, subscribe, uid, update } from './store';
import { toWorld, view } from './viewport';

// Code blocks: write code on the page and run it on Compiler Explorer (godbolt.org), which
// compiles and runs it on its servers for free. Libraries (Compiler Explorer's stand-in for package
// managers: fmt, Boost, Eigen… for C++) are picked per block. Blocks sit on the text layer, so they
// pan, zoom and turn with the page. ponytail: not in undo history or live sessions yet.

const API = 'https://godbolt.org/api';
const LANGS: [id: string, label: string, starter: string][] = [
  ['python', 'Python', 'print("Hello from Inkwell")\n'],
  [
    'c++',
    'C++',
    '#include <iostream>\n\nint main() {\n    std::cout << "Hello from Inkwell\\n";\n}\n',
  ],
  ['c', 'C', '#include <stdio.h>\n\nint main(void) {\n    puts("Hello from Inkwell");\n}\n'],
  ['rust', 'Rust', 'fn main() {\n    println!("Hello from Inkwell");\n}\n'],
  [
    'go',
    'Go',
    'package main\n\nimport "fmt"\n\nfunc main() {\n\tfmt.Println("Hello from Inkwell")\n}\n',
  ],
  [
    'java',
    'Java',
    'class Main {\n    public static void main(String[] a) {\n        System.out.println("Hello from Inkwell");\n    }\n}\n',
  ],
  ['kotlin', 'Kotlin', 'fun main() {\n    println("Hello from Inkwell")\n}\n'],
  ['csharp', 'C#', 'System.Console.WriteLine("Hello from Inkwell");\n'],
  ['typescript', 'TypeScript', 'console.log("Hello from Inkwell");\n'],
];

const layer = document.querySelector<HTMLDivElement>('#texts')!;
const json = async <T>(url: string): Promise<T> => {
  const r = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error(`Compiler Explorer said ${r.status}`);
  return r.json() as Promise<T>;
};

// --- Compilers and libraries, fetched once per language ---

interface Compiler {
  id: string;
  name: string;
  semver?: string;
  supportsExecute?: boolean;
}
const compilers = new Map<string, Promise<Compiler[]>>();
function compilersFor(lang: string) {
  if (!compilers.has(lang)) {
    compilers.set(
      lang,
      json<Compiler[]>(
        `${API}/compilers/${encodeURIComponent(lang)}?fields=id,name,semver,supportsExecute`,
      )
        // Only ones that can run the program, newest first.
        .then((list) => list.filter((c) => c.supportsExecute).sort(byVersion))
        .catch((e) => {
          compilers.delete(lang);
          throw e;
        }),
    );
  }
  return compilers.get(lang)!;
}
const ver = (s = '') => s.split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
function byVersion(a: Compiler, b: Compiler) {
  // Mainstream x86-64 builds first (gcc for C/C++), then by version, newest first.
  const main = (c: Compiler) =>
    /^x86-64 gcc \d|^rustc \d|^Python 3|^x86-64 gc|^jdk|^kotlinc|^\.NET|^TypeScript/i.test(c.name)
      ? 0
      : 1;
  if (main(a) !== main(b)) return main(a) - main(b);
  const [x, y] = [ver(a.semver), ver(b.semver)];
  for (let i = 0; i < Math.max(x.length, y.length); i++)
    if ((y[i] ?? 0) !== (x[i] ?? 0)) return (y[i] ?? 0) - (x[i] ?? 0);
  return 0;
}

interface Lib {
  id: string;
  name: string;
  versions: { id: string; version: string }[];
}
const libraries = new Map<string, Promise<Lib[]>>();
const librariesFor = (lang: string) => {
  if (!libraries.has(lang))
    libraries.set(
      lang,
      json<Lib[]>(`${API}/libraries/${encodeURIComponent(lang)}`).catch(() => []),
    );
  return libraries.get(lang)!;
};

// --- Running ---

interface CompileResult {
  code: number;
  didExecute?: boolean;
  stdout?: { text: string }[];
  stderr?: { text: string }[];
  buildResult?: { code: number; stderr?: { text: string }[] };
  execResult?: { code: number; stdout?: { text: string }[]; stderr?: { text: string }[] };
}
const lines = (v?: { text: string }[]) => (v ?? []).map((l) => l.text).join('\n');

async function run(b: CodeBlock): Promise<string> {
  const res = await fetch(`${API}/compiler/${encodeURIComponent(b.compiler)}/compile`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      source: b.code,
      lang: b.lang,
      options: {
        userArguments: '',
        executeParameters: { args: [], stdin: b.stdin ?? '' },
        compilerOptions: { executorRequest: true },
        filters: { execute: true },
        tools: [],
        libraries: b.libs,
      },
      allowStoreCodeDebug: false,
    }),
  });
  if (!res.ok) throw new Error(`Compiler Explorer said ${res.status}`);
  const r = (await res.json()) as CompileResult;
  const exec = r.execResult ?? r;
  const build = r.buildResult;
  if (build && build.code !== 0)
    return `✗ Didn't compile (exit ${build.code})\n${lines(build.stderr)}`.trim();
  if (!r.didExecute) return `✗ Didn't run\n${lines(r.stderr) || lines(build?.stderr)}`.trim();
  const out = [lines(exec.stdout), lines(exec.stderr)].filter(Boolean).join('\n');
  return `${out || '(no output)'}\n— exit ${exec.code}`;
}

// --- Blocks on the page ---

const codesOf = () => page().codes ?? [];
/** Changes a block as an undo step (typing in one block keeps merging into the same step). */
function change(id: string, patch: Partial<CodeBlock>) {
  const key = 'code' in patch || 'stdin' in patch ? `code:${id}` : undefined;
  commitSnapshot(
    snapshot(),
    {
      strokes: page().strokes,
      texts: page().texts,
      codes: codesOf().map((c) => (c.id === id ? { ...c, ...patch } : c)),
    },
    key,
  );
}
/** A change that isn't an edit and stays out of the undo history: a run's output, the compiler
 * picked automatically for a new block. */
function quiet(id: string, patch: Partial<CodeBlock>) {
  update(() => {
    page().codes = codesOf().map((c) => (c.id === id ? { ...c, ...patch } : c));
  });
}
const setCodes = (codes: CodeBlock[]) =>
  commitSnapshot(snapshot(), { strokes: page().strokes, texts: page().texts, codes });

/** Insert → Code block: a new block in the middle of the screen. */
export async function addCodeBlock() {
  const r = layer.parentElement!.getBoundingClientRect();
  const at = toWorld(r.left + r.width / 2 - 260, r.top + r.height / 3);
  const [lang, , starter] = LANGS[0]!;
  const block: CodeBlock = {
    id: uid(),
    x: at.x,
    y: at.y,
    w: 520 / Math.max(view.scale, 0.25),
    lang,
    compiler: '',
    code: starter,
    libs: [],
    output: '',
  };
  setCodes([...codesOf(), block]);
  try {
    const best = (await compilersFor(lang))[0];
    if (best) quiet(block.id, { compiler: best.id });
  } catch {
    toast('Compiler Explorer is unreachable: code blocks need the internet to run.', 4000);
  }
}

const els = new Map<
  string,
  {
    root: HTMLElement;
    code: HTMLTextAreaElement;
    stdin: HTMLTextAreaElement;
    out: HTMLElement;
    compiler: HTMLSelectElement;
    run: HTMLButtonElement;
    libs: HTMLButtonElement;
    lang: HTMLSelectElement;
  }
>();

function makeBlock(b: CodeBlock) {
  const grip = h(
    'button',
    { class: 'code-grip', 'aria-label': 'Move code block', title: 'Drag to move' },
    icon(GripVertical, 16),
  );
  const lang = h(
    'select',
    { class: 'code-lang', 'aria-label': 'Language' },
    ...LANGS.map(([id, label]) => h('option', { value: id }, label)),
  );
  const compiler = h('select', { class: 'code-compiler', 'aria-label': 'Compiler' });
  const libs = h(
    'button',
    { class: 'tb-btn code-libs', 'aria-label': 'Libraries', title: 'Libraries (packages)' },
    icon(Library, 16),
  );
  const runBtn = h(
    'button',
    { class: 'code-run', title: 'Run on Compiler Explorer (godbolt.org) — sends this code there' },
    icon(Play, 14),
    h('span', {}, 'Run'),
  );
  const del = h(
    'button',
    { class: 'tb-btn', 'aria-label': 'Delete code block', title: 'Delete code block' },
    icon(X, 16),
  );
  const code = h('textarea', {
    class: 'code-src',
    spellcheck: false,
    autocapitalize: 'off',
    autocomplete: 'off',
    'aria-label': 'Code',
  });
  const stdin = h('textarea', {
    class: 'code-stdin',
    rows: 1,
    spellcheck: false,
    autocapitalize: 'off',
    placeholder: 'Input for the program — one line per input()',
    'aria-label': 'Program input (stdin)',
  });
  const out = h('pre', { class: 'code-out', 'aria-live': 'polite' });
  const root = h(
    'div',
    { class: 'codeblock', 'data-id': b.id },
    h('div', { class: 'code-head' }, grip, lang, compiler, libs, runBtn, del),
    code,
    h('label', { class: 'code-stdin-row' }, h('span', {}, 'Input'), stdin),
    out,
  );
  // Typing, picking and tapping stay inside the block (no drawing, no app shortcuts).
  for (const t of ['pointerdown', 'keydown', 'wheel'] as const)
    root.addEventListener(t, (e) => e.stopPropagation());
  const id = b.id;
  const cur = () => codesOf().find((c) => c.id === id);

  let typing = 0;
  code.addEventListener('input', () => {
    fit(code);
    clearTimeout(typing);
    typing = window.setTimeout(() => change(id, { code: code.value }), 400);
  });
  code.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      code.setRangeText('    ', code.selectionStart, code.selectionEnd, 'end');
      code.dispatchEvent(new Event('input'));
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') runBtn.click();
  });
  stdin.addEventListener('input', () => {
    fit(stdin);
    change(id, { stdin: stdin.value });
  });
  stdin.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') runBtn.click();
  });
  code.addEventListener('blur', () => {
    clearTimeout(typing);
    if (cur()?.code !== code.value) change(id, { code: code.value });
  });
  lang.addEventListener('change', async () => {
    const [, , starter] = LANGS.find(([l]) => l === lang.value)!;
    const keep = cur()?.code.trim() && !LANGS.some(([, , s]) => s === cur()!.code);
    change(id, {
      lang: lang.value,
      compiler: '',
      libs: [],
      output: '',
      ...(keep ? {} : { code: starter }),
    });
    try {
      const best = (await compilersFor(lang.value))[0];
      if (best) quiet(id, { compiler: best.id });
    } catch {
      toast('Compiler Explorer is unreachable.', 3000);
    }
  });
  compiler.addEventListener('change', () => change(id, { compiler: compiler.value }));
  del.addEventListener('click', () => setCodes(codesOf().filter((c) => c.id !== id)));
  runBtn.addEventListener('click', async () => {
    const b2 = cur();
    if (!b2) return;
    if (code.value !== b2.code) change(id, { code: code.value });
    if (!b2.compiler) {
      toast('Still loading compilers… try again in a moment.', 2500);
      return;
    }
    runBtn.disabled = true;
    out.textContent = 'Running on Compiler Explorer…';
    let result: string;
    try {
      result = await run({ ...b2, code: code.value, stdin: stdin.value });
      // Ran out of input: say where it goes (the most common surprise with input()).
      if (/EOFError|EOF when reading|NoSuchElementException/.test(result) && !stdin.value.trim()) {
        stdin.dataset.asked = '1';
        stdin.parentElement!.hidden = false;
        result +=
          '\n\nThe program asked for input. Type it in the Input box above (one line per input()), then Run again.';
      }
    } catch (e) {
      result = `✗ ${(e as Error).message}. Code blocks need the internet to run.`;
    }
    runBtn.disabled = false;
    quiet(id, { output: result });
  });
  libs.addEventListener('click', () => togglePopover(libs, libraryPanel(id)));
  grip.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    capture(grip, e.pointerId);
    const b0 = cur();
    if (!b0) return;
    const start = toWorld(e.clientX, e.clientY);
    const move = (m: PointerEvent) => {
      const w = toWorld(m.clientX, m.clientY);
      root.style.left = `${b0.x + w.x - start.x}px`;
      root.style.top = `${b0.y + w.y - start.y}px`;
    };
    const up = (u: PointerEvent) => {
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', up);
      const w = toWorld(u.clientX, u.clientY);
      change(id, { x: b0.x + w.x - start.x, y: b0.y + w.y - start.y });
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', up);
  });
  layer.append(root);
  const el = { root, code, stdin, out, compiler, run: runBtn, libs, lang };
  els.set(id, el);
  return el;
}

/** Code that reads input: Python, C/C++, Java/Kotlin, C#, Go, Rust, TypeScript (Node). */
const READS_INPUT =
  /\binput\s*\(|\bcin\s*>>|\bscanf\s*\(|\bgetline\s*\(|\bgets\s*\(|\bScanner\b|readLine|ReadLine|read_line|stdin|fmt\.Scan|readline/;

/** The textarea grows with its code, so the whole block is visible on the page. */
function fit(t: HTMLTextAreaElement) {
  t.style.height = 'auto';
  t.style.height = `${t.scrollHeight + 2}px`;
}

async function fillCompilers(sel: HTMLSelectElement, b: CodeBlock) {
  if (sel.dataset.lang === b.lang && sel.value === b.compiler) return;
  sel.dataset.lang = b.lang;
  try {
    const list = await compilersFor(b.lang);
    sel.replaceChildren(...list.slice(0, 40).map((c) => h('option', { value: c.id }, c.name)));
    sel.value = b.compiler;
  } catch {
    sel.replaceChildren(h('option', { value: b.compiler }, b.compiler || 'offline'));
  }
}

function libraryPanel(id: string): HTMLElement {
  const b = codesOf().find((c) => c.id === id)!;
  const list = h(
    'div',
    { class: 'code-lib-list' },
    h('p', { class: 'panel-sub' }, 'Loading libraries…'),
  );
  const search = h('input', {
    class: 'hex',
    placeholder: 'Search libraries',
    'aria-label': 'Search libraries',
  });
  const panel = h(
    'div',
    { class: 'style-panel code-lib-panel' },
    h('div', { class: 'panel-title' }, 'Libraries'),
    h('p', { class: 'panel-sub' }, 'Ready-made packages on Compiler Explorer for this language.'),
    search,
    list,
  );
  search.addEventListener('keydown', (e) => e.stopPropagation());
  void librariesFor(b.lang).then((all) => {
    const draw = () => {
      const q = search.value.toLowerCase();
      const chosen = new Map(
        (codesOf().find((c) => c.id === id)?.libs ?? []).map((l) => [l.id, l.version]),
      );
      const shown = all
        .filter((l) => !q || l.name.toLowerCase().includes(q) || l.id.includes(q))
        .slice(0, 60);
      list.replaceChildren(
        ...(shown.length
          ? shown.map((l) => {
              const latest = l.versions.filter((v) => v.id !== 'trunk').at(-1) ?? l.versions.at(-1);
              const box = h('input', { type: 'checkbox', checked: chosen.has(l.id) });
              box.addEventListener('change', () => {
                const libs = (codesOf().find((c) => c.id === id)?.libs ?? []).filter(
                  (x) => x.id !== l.id,
                );
                if (box.checked && latest) libs.push({ id: l.id, version: latest.id });
                change(id, { libs });
              });
              return h(
                'label',
                { class: 'check' },
                box,
                h('span', {}, `${l.name}${latest ? ` ${latest.version}` : ''}`),
              );
            })
          : [
              h(
                'p',
                { class: 'panel-sub' },
                all.length ? 'No match.' : 'No libraries for this language.',
              ),
            ]),
      );
    };
    search.addEventListener('input', draw);
    draw();
  });
  return panel;
}

export function renderCodes() {
  const blocks = codesOf();
  const live = new Set(blocks.map((b) => b.id));
  for (const [id, el] of els) {
    if (!live.has(id)) {
      el.root.remove();
      els.delete(id);
    }
  }
  for (const b of blocks) {
    const el = els.get(b.id) ?? makeBlock(b);
    el.root.style.cssText = `left:${b.x}px;top:${b.y}px;width:${b.w}px`;
    if (document.activeElement !== el.code && el.code.value !== b.code) el.code.value = b.code;
    el.lang.value = b.lang;
    if (document.activeElement !== el.stdin && el.stdin.value !== (b.stdin ?? ''))
      el.stdin.value = b.stdin ?? '';
    // Shown when the program reads input (or already has some), so blocks stay compact otherwise.
    el.stdin.parentElement!.hidden = !(
      b.stdin ||
      READS_INPUT.test(b.code) ||
      el.stdin.dataset.asked
    );
    el.out.textContent = b.output;
    el.out.hidden = !b.output;
    el.libs.title = b.libs.length
      ? `Libraries: ${b.libs.map((l) => l.id).join(', ')}`
      : 'Libraries (packages)';
    el.libs.classList.toggle('on', b.libs.length > 0);
    void fillCompilers(el.compiler, b);
    requestAnimationFrame(() => fit(el.code));
  }
}

let shownPage = '';
subscribe(() => {
  if (page().id !== shownPage) {
    for (const el of els.values()) el.root.remove();
    els.clear();
    shownPage = page().id;
  }
  renderCodes();
});
shownPage = page().id;
renderCodes();
