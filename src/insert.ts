import { ClipboardPaste, ImagePlus, Images } from 'lucide';
import { h, icon, openMenu, toast } from './dom';
import { storePicture } from './images';
import { insert, takeOverPaste } from './lasso';
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
  const files = [...(e.dataTransfer?.files ?? [])];
  if (!files.length) return;
  e.preventDefault();
  void addPictures(files, toWorld(e.clientX, e.clientY));
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
