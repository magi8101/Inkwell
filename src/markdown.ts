import type { Editor } from '@tiptap/core';
import type { IconNode } from 'lucide';
import {
  Bold,
  Code,
  Heading1,
  Heading2,
  Italic,
  List,
  ListChecks,
  ListOrdered,
  Redo2,
  Strikethrough,
  Table,
  TextQuote,
  Undo2,
} from 'lucide';
import { h, icon } from './dom';
import {
  childFolders,
  newMarkdownPage,
  notebook,
  page,
  type Section,
  section,
  subscribe,
  update,
} from './store';

// Markdown notes: typed pages that format as you type (`# ` → heading, `**bold**` → bold, `- [ ] `
// → checkbox…), saved as Markdown text so they open and save as .md files unchanged. The editor
// (Tiptap) loads on the first note shown. A note replaces the ink canvas with the editor and the
// pen toolbar with a formatting bar for touch screens. In live sessions a note is shared as a
// whole (last write wins). ponytail: no ink on notes yet.

const bar = h('div', { class: 'md-bar', role: 'toolbar', 'aria-label': 'Formatting' });
const body = h('div', { class: 'md-body' });
const view = h('div', { id: 'md', hidden: true }, bar, body);
document.querySelector('#stage')!.insertBefore(view, document.querySelector('#toolbar'));

let editor: Editor | null = null;
/** The note in the editor, and its Markdown as last loaded or saved (to spot outside changes). */
let shownId = '';
let lastMd = '';
let saveTimer = 0;

type Cmd = (e: Editor) => boolean;
const BUTTONS: [string, IconNode, Cmd, (e: Editor) => boolean][] = [
  [
    'Heading',
    Heading1,
    (e) => e.chain().focus().toggleHeading({ level: 1 }).run(),
    (e) => e.isActive('heading', { level: 1 }),
  ],
  [
    'Subheading',
    Heading2,
    (e) => e.chain().focus().toggleHeading({ level: 2 }).run(),
    (e) => e.isActive('heading', { level: 2 }),
  ],
  ['Bold (Ctrl+B)', Bold, (e) => e.chain().focus().toggleBold().run(), (e) => e.isActive('bold')],
  [
    'Italic (Ctrl+I)',
    Italic,
    (e) => e.chain().focus().toggleItalic().run(),
    (e) => e.isActive('italic'),
  ],
  [
    'Strikethrough',
    Strikethrough,
    (e) => e.chain().focus().toggleStrike().run(),
    (e) => e.isActive('strike'),
  ],
  [
    'Bulleted list',
    List,
    (e) => e.chain().focus().toggleBulletList().run(),
    (e) => e.isActive('bulletList'),
  ],
  [
    'Numbered list',
    ListOrdered,
    (e) => e.chain().focus().toggleOrderedList().run(),
    (e) => e.isActive('orderedList'),
  ],
  [
    'Checklist',
    ListChecks,
    (e) => e.chain().focus().toggleTaskList().run(),
    (e) => e.isActive('taskList'),
  ],
  [
    'Quote',
    TextQuote,
    (e) => e.chain().focus().toggleBlockquote().run(),
    (e) => e.isActive('blockquote'),
  ],
  [
    'Code block',
    Code,
    (e) => e.chain().focus().toggleCodeBlock().run(),
    (e) => e.isActive('codeBlock'),
  ],
  [
    'Table',
    Table,
    (e) => e.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(),
    () => false,
  ],
  ['Undo (Ctrl+Z)', Undo2, (e) => e.chain().focus().undo().run(), () => false],
  ['Redo (Ctrl+Shift+Z)', Redo2, (e) => e.chain().focus().redo().run(), () => false],
];
const buttons = BUTTONS.map(([label, ic, run]) =>
  h(
    'button',
    {
      class: 'tb-btn',
      'aria-label': label,
      title: label,
      // Keep the text selection: a tap on the bar mustn't take focus from the editor first.
      onpointerdown: (e: Event) => e.preventDefault(),
      onclick: () => editor && run(editor),
    },
    icon(ic, 18),
  ),
);
bar.append(...buttons);
const syncBar = () => {
  if (!editor) return;
  for (const [i, b] of BUTTONS.entries())
    buttons[i]!.setAttribute('aria-pressed', String(b[3](editor)));
};

let tiptap: Promise<typeof import('./markdown-editor')> | null = null;

/** Writes the editor's Markdown into the note it was opened for (wherever that note is now). */
function save() {
  clearTimeout(saveTimer);
  saveTimer = 0;
  if (!editor) return;
  const md = editor.getMarkdown();
  if (md === lastMd) return;
  const before = lastMd;
  lastMd = md;
  const id = shownId;
  update((s) => {
    for (const nb of s.notebooks)
      for (const sec of nb.sections)
        for (const p of sec.pages) {
          if (p.id !== id) continue;
          p.md = md;
          // A note names itself after its first line, until it's renamed by hand.
          if (p.title === UNTITLED || p.title === titleOf(before))
            p.title = titleOf(md) || UNTITLED;
        }
  });
}

const UNTITLED = 'Untitled note';
/** The first line's text, without Markdown marks, as a page name. */
export const titleOf = (md: string) =>
  (md.split('\n').find((l) => l.trim()) ?? '')
    .replace(/^\s*(#{1,6}\s+|[-*+]\s+(\[[ x]\]\s+)?|\d+[.)]\s+|>\s*)/i, '')
    .replace(/[*_`~]/g, '')
    .trim()
    .slice(0, 60);

async function open(id: string, md: string) {
  save();
  editor?.destroy(); // a fresh editor per note, so undo never steps back into another note
  editor = null;
  shownId = id;
  lastMd = md;
  tiptap ??= import('./markdown-editor');
  let createEditor: typeof import('./markdown-editor')['createEditor'];
  try {
    ({ createEditor } = await tiptap);
  } catch {
    tiptap = null; // try again next time
    body.replaceChildren(
      h(
        'p',
        { class: 'md-doc' },
        'The note editor couldn’t load. Connect to the internet once, then reopen this note.',
      ),
    );
    return;
  }
  if (shownId !== id) return; // switched again while the editor was loading
  editor = createEditor(body, md, {
    onLink: openLink,
    onUpdate: () => {
      clearTimeout(saveTimer);
      saveTimer = window.setTimeout(save, 400);
    },
    onSelection: syncBar,
  });
  syncBar();
}

function sync() {
  const p = page();
  const isNote = p.md !== undefined;
  view.hidden = !isNote;
  document.body.classList.toggle('md-page', isNote);
  if (!isNote) {
    if (shownId) {
      save();
      editor?.destroy();
      editor = null;
      shownId = '';
    }
    return;
  }
  if (p.id !== shownId) void open(p.id, p.md ?? '');
  // This note changed outside the editor (someone else in a live session, or its file on disk):
  // swap the text in place and keep the caret about where it was, rather than reopening it.
  else if (p.md !== lastMd && !saveTimer) external(p.md ?? '');
}

function external(md: string) {
  if (!editor) return; // still loading: open() reads the newest text
  const { from, to } = editor.state.selection;
  lastMd = md;
  editor.commands.setContent(md, { contentType: 'markdown', emitUpdate: false });
  const end = Math.max(1, editor.state.doc.content.size - 1);
  editor.commands.setTextSelection({ from: Math.min(from, end), to: Math.min(to, end) });
}
subscribe(sync);
sync();
addEventListener('pagehide', save);
document.addEventListener('visibilitychange', () => document.hidden && save());

/** Opens the page a [[link]] names; with no such page yet, makes a note with that name. */
function openLink(name: string) {
  save(); // the typing so far is saved first
  const want = name.trim().toLowerCase();
  if (!want) return;
  update((s) => {
    for (const nb of s.notebooks)
      for (const sec of nb.sections)
        for (const p of sec.pages)
          if (p.title.trim().toLowerCase() === want) {
            s.notebookId = nb.id;
            s.sectionId = sec.id;
            s.pageId = p.id;
            return;
          }
    const note = newMarkdownPage(name.trim());
    section().pages.push(note);
    s.pageId = note.id;
  });
}

/** A note listing a folder's pages (and its folders') as links, put first in that folder. */
export function addContentsPage(sec: Section) {
  const link = (t: string) => `[[${t.replace(/[\]|\n]/g, ' ').trim()}]]`;
  const list = (from: Section, depth: number): string[] => [
    ...from.pages.map((p) => `${'  '.repeat(depth)}- ${link(p.title)}`),
    ...childFolders(notebook(), from.id).flatMap((c) => [
      `${'  '.repeat(depth)}- **${c.name}**`,
      ...list(c, depth + 1),
    ]),
  ];
  const md = `# ${sec.name}\n\n${list(sec, 0).join('\n')}\n`;
  update((s) => {
    const note = newMarkdownPage(`${sec.name} — contents`, md);
    sec.pages.unshift(note);
    s.sectionId = sec.id;
    s.pageId = note.id;
  });
}

/** Adds a Markdown note after the current page and shows it. */
export function addMarkdownNote(title = UNTITLED, md = '') {
  update((s) => {
    const p = newMarkdownPage(title, md);
    const pages = section().pages;
    pages.splice(pages.indexOf(page()) + 1, 0, p);
    s.pageId = p.id;
  });
}

/** Opens .md files as Markdown notes (named after the file). */
export async function importMarkdown(files: File[]) {
  for (const f of files)
    addMarkdownNote(f.name.replace(/\.(md|markdown|txt)$/i, ''), await f.text());
}

export const isMarkdown = (f: File) =>
  /\.(md|markdown)$/i.test(f.name) || f.type === 'text/markdown';
