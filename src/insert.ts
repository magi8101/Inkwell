import {
  ClipboardPaste,
  Code,
  FileArchive,
  FileText,
  FileType,
  FolderOpen,
  ImagePlus,
  Images,
  NotebookText,
  Shapes,
} from 'lucide';
import {
  offerBundle,
  readDirHandle,
  readPickedFolder,
  readZip,
  takeDroppedBundles,
} from './bundle';
import { addCodeBlock } from './code';
import { h, icon, openMenu, toast } from './dom';
import { storePicture } from './images';
import { insert, takeOverPaste } from './lasso';
import { importMarkdown, isMarkdown } from './markdown';
import { importOneNote } from './onenote';
import { importPdf } from './pdf-import';
import { openStamps } from './stamps';
import { type ImageItem, uid } from './store';
import { toWorld, view } from './viewport';

// Inserting pictures: Insert menu (files or the system clipboard — the only way to paste a photo
// on an iPad without a keyboard), drag and drop onto the page, and Ctrl/Cmd+V.

const bg = document.querySelector<HTMLCanvasElement>('#bg')!;
const stage = document.querySelector<HTMLElement>('#stage')!;
const MAX_SHARE = 0.6; // a new picture takes at most this much of the visible area
const FAN = 24; // several pictures at once fan out instead of stacking exactly

const centre = () => {
  const r = bg.getBoundingClientRect();
  return toWorld(r.left + r.width / 2, r.top + r.height / 2);
};

async function addPictures(files: Blob[], at: { x: number; y: number }) {
  const pictures = files.filter((f) => f.type.startsWith('image/'));
  if (!pictures.length) {
    toast('Only pictures can be inserted here.', 2500);
    return;
  }
  const r = bg.getBoundingClientRect();
  const maxW = (r.width / view.scale) * MAX_SHARE;
  const maxH = (r.height / view.scale) * MAX_SHARE;
  const items: ImageItem[] = [];
  for (const [i, file] of pictures.entries()) {
    try {
      const { blob, width, height } = await storePicture(file);
      // Natural size in CSS px, shrunk (never enlarged) to fit the visible area.
      const k = Math.min(1, maxW / width, maxH / height);
      items.push({
        id: uid(),
        blob,
        cx: at.x + i * FAN,
        cy: at.y + i * FAN,
        w: width * k,
        h: height * k,
        angle: 0,
      });
    } catch {
      toast(`Couldn't read ${file instanceof File ? file.name : 'that picture'}.`, 3000);
    }
  }
  // Inserted pictures arrive selected with the lasso, ready to move, resize or rotate.
  if (items.length) insert({ strokes: [], texts: [], images: items }, 0);
}

const input = h('input', { type: 'file', accept: 'image/*', multiple: true, hidden: true });
// OneNote sections (.one) open as a new, editable section; several at once each become one.
const oneInput = h('input', { type: 'file', accept: '.one', multiple: true, hidden: true });
document.body.append(oneInput);
oneInput.addEventListener('change', async () => {
  for (const f of [...(oneInput.files ?? [])]) await importOneNote(f);
  oneInput.value = '';
});
const isOneNote = (f: File) => /\.one$/i.test(f.name);
const zipInput = h('input', { type: 'file', accept: '.zip,application/zip', hidden: true });
const folderInput = h('input', { type: 'file', webkitdirectory: true, hidden: true });
document.body.append(zipInput, folderInput);
zipInput.addEventListener('change', async () => {
  const f = zipInput.files?.[0];
  zipInput.value = '';
  if (f)
    await readZip(f).then(offerBundle, () => toast(`Couldn’t open “${f.name}” as a zip.`, 4000));
});
folderInput.addEventListener('change', () => {
  const b = readPickedFolder([...(folderInput.files ?? [])]);
  folderInput.value = '';
  offerBundle(b);
});
type DirPicker = (o: { id: string; mode: 'read' }) => Promise<Parameters<typeof readDirHandle>[0]>;
/** Chrome/Edge/Brave pick a folder they can read again (live updates); others take a copy. */
async function pickFolder() {
  const picker = (window as unknown as { showDirectoryPicker?: DirPicker }).showDirectoryPicker;
  if (!picker) return folderInput.click();
  try {
    const dir = await picker({ id: 'inkwell-open', mode: 'read' });
    offerBundle({ name: dir.name, entries: await readDirHandle(dir), dir });
  } catch (e) {
    if ((e as Error).name !== 'AbortError')
      toast(`Couldn’t read that folder: ${(e as Error).message}`, 5000);
  }
}
const mdInput = h('input', {
  type: 'file',
  accept: '.md,.markdown,text/markdown',
  multiple: true,
  hidden: true,
});
document.body.append(mdInput);
mdInput.addEventListener('change', async () => {
  await importMarkdown([...(mdInput.files ?? [])]);
  mdInput.value = '';
});
const isPdf = (f: File) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name);
const pdfInput = h('input', {
  type: 'file',
  accept: 'application/pdf,.pdf',
  multiple: true,
  hidden: true,
});
document.body.append(pdfInput);
pdfInput.addEventListener('change', async () => {
  for (const f of [...(pdfInput.files ?? [])]) await importPdf(f);
  pdfInput.value = '';
});
document.body.append(input);
input.addEventListener('change', () => {
  void addPictures([...(input.files ?? [])], centre());
  input.value = '';
});

async function pasteFromClipboard() {
  try {
    const items = await navigator.clipboard.read();
    const blobs: Blob[] = [];
    for (const item of items) {
      const type = item.types.find((t) => t.startsWith('image/'));
      if (type) blobs.push(await item.getType(type));
    }
    if (blobs.length) await addPictures(blobs, centre());
    else toast('No picture on the clipboard — copy one first.', 2500);
  } catch {
    toast('The browser blocked reading the clipboard. Try Ctrl/⌘+V or drag the picture in.', 4000);
  }
}

export const insertButton = h(
  'button',
  {
    class: 'tb-btn',
    'aria-label': 'Insert',
    title: 'Insert a picture (or drag one onto the page)',
  },
  icon(ImagePlus),
);
insertButton.addEventListener('click', () =>
  openMenu(insertButton, [
    { label: 'Picture from files…', icon: Images, run: () => input.click() },
    { label: 'Paste picture', icon: ClipboardPaste, run: () => void pasteFromClipboard() },
    { label: 'Stamps (saved selections)…', icon: Shapes, run: () => openStamps(insertButton) },
    'sep',
    { label: 'PDF (to write on)…', icon: FileText, run: () => pdfInput.click() },
    { label: 'Markdown file (.md)…', icon: FileType, run: () => mdInput.click() },
    { label: 'Zip file (notes, PDFs, pictures)…', icon: FileArchive, run: () => zipInput.click() },
    ...(/Android/.test(navigator.userAgent)
      ? []
      : [
          {
            label: 'Folder (notes, PDFs, pictures)…',
            icon: FolderOpen,
            run: () => void pickFolder(),
          },
        ]),
    { label: 'Code block (runs on Compiler Explorer)', icon: Code, run: () => void addCodeBlock() },
    { label: 'OneNote section (.one)…', icon: NotebookText, run: () => oneInput.click() },
  ]),
);

// Drag and drop: the picture lands where it's dropped.
stage.addEventListener('dragover', (e) => {
  if (e.dataTransfer?.types.includes('Files')) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  }
});
stage.addEventListener('drop', (e) => {
  const dt = e.dataTransfer;
  if (!dt) return;
  // Folders and zips are listed and offered for import or viewing; taken now, while readable.
  const bundles = takeDroppedBundles(dt);
  const files = [...dt.items]
    .filter((i) => i.kind === 'file' && !i.webkitGetAsEntry?.()?.isDirectory)
    .map((i) => i.getAsFile())
    .filter((f): f is File => !!f && !/\.zip$/i.test(f.name));
  if (!files.length && !bundles) return;
  e.preventDefault();
  for (const b of bundles ?? [])
    b.then(offerBundle, (err) =>
      toast(`Couldn’t read that: ${(err as Error).message ?? err}`, 5000),
    );
  void (async () => {
    for (const f of files.filter(isOneNote)) await importOneNote(f);
    for (const f of files.filter(isPdf)) await importPdf(f);
    await importMarkdown(files.filter(isMarkdown));
    const pictures = files.filter((f) => !isOneNote(f) && !isPdf(f) && !isMarkdown(f));
    if (pictures.length) await addPictures(pictures, toWorld(e.clientX, e.clientY));
  })();
});

// Ctrl/Cmd+V with a picture on the system clipboard (a copied screenshot or photo).
addEventListener('paste', (e) => {
  if (
    (e.target as HTMLElement).closest(
      'input, textarea, [contenteditable="true"], [contenteditable="plaintext-only"]',
    )
  ) {
    return;
  }
  const files = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith('image/'));
  if (!files.length) return;
  e.preventDefault();
  takeOverPaste(); // a picture wins over ink copied earlier in the app
  void addPictures(files, centre());
});
