import { X } from 'lucide';
import { isLocked, unlock, unpackBackup } from './backup';
import { h, icon, toast } from './dom';
import { storePicture } from './images';
import { cleanNotebooks } from './notebook-clean';
import { state, uid, update } from './store';

// Back up everything to one .inkw file, and restore from one. Old backups (.inkbackup, backup.ts)
// still restore: files are told apart by their content, never their name. Restoring never replaces
// anything: the notebooks in the file are added next to yours, with fresh ids, and everything in
// the file is checked on the way in.

async function restoreFrom(file: File, password: () => Promise<string | null>) {
  let bytes: Uint8Array = new Uint8Array(await file.arrayBuffer());
  if (isLocked(bytes)) {
    const pw = await password();
    if (pw === null) return;
    bytes = await unlock(bytes, pw);
  }
  const { doc, pictures } = unpackBackup(bytes);
  // Pictures go into this device's storage under new ids.
  const pic = new Map<string, string>();
  for (const p of pictures) {
    try {
      pic.set(p.id, (await storePicture(new Blob([p.bytes as BlobPart], { type: p.type }))).blob);
    } catch {
      // A picture that cannot be read is skipped; the pages still come back.
    }
  }
  const notebooks = cleanNotebooks(doc.notebooks, pic, uid);
  if (!notebooks.length) throw new Error('The backup has no notebooks');
  const have = new Set(state.notebooks.map((n) => n.name));
  for (const n of notebooks) if (have.has(n.name)) n.name = `${n.name} (restored)`;
  update((s) => {
    s.notebooks.push(...notebooks);
  });
  const pages = notebooks.reduce(
    (n, nb) => n + nb.sections.reduce((m, s) => m + s.pages.length, 0),
    0,
  );
  toast(
    `Restored ${notebooks.length} notebook${notebooks.length === 1 ? '' : 's'} (${pages} pages), added next to yours.`,
    5000,
  );
}

/** A small dialog asking for a password (optional when `optional`), resolving to it or null. */
export function askPassword(
  title: string,
  text: string,
  optional: boolean,
): Promise<string | null> {
  return new Promise((resolve) => {
    const box = h('input', {
      class: 'share-url',
      type: 'password',
      autocomplete: 'off',
      'aria-label': 'Password',
    });
    const done = (v: string | null) => {
      overlay.remove();
      resolve(v);
    };
    const go = () => done(box.value);
    box.addEventListener('keydown', (e) => e.key === 'Enter' && go());
    const overlay = h(
      'div',
      { class: 'cal-overlay', onclick: (e: Event) => e.target === overlay && done(null) },
      h(
        'div',
        { class: 'cal-card', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
        h(
          'header',
          { class: 'cal-head' },
          h('span', { style: 'flex: 1' }, title),
          h(
            'button',
            { class: 'tb-btn cal-close', 'aria-label': 'Close', onclick: () => done(null) },
            icon(X, 18),
          ),
        ),
        h(
          'div',
          { class: 'cal-body' },
          h('p', { class: 'cal-text' }, text),
          box,
          h(
            'div',
            { class: 'share-actions' },
            h('button', { class: 'primary', onclick: go }, optional ? 'Continue' : 'Unlock'),
          ),
        ),
      ),
    );
    document.body.append(overlay);
    box.focus();
  });
}

export async function backUpEverything() {
  const pw = await askPassword(
    'Back up everything',
    'Saves every notebook, with its pictures, into one .inkw file. Type a password to lock it (there is no way to recover it), or leave it empty for an unlocked file.',
    true,
  );
  if (pw === null) return;
  // Everything goes to one .inkw file (the dialogs and the writer live in inkw-ui.ts, loaded here so the
  // two modules do not depend on each other at start-up).
  const { saveInkw } = await import('./inkw-ui');
  await saveInkw('all', pw, 'Inkwell backup');
}

const picker = h('input', { type: 'file', hidden: true });
document.body.append(picker);
picker.addEventListener('change', async () => {
  const f = picker.files?.[0];
  picker.value = '';
  if (!f) return;
  try {
    const inkw = await import('./inkw-ui');
    if (await inkw.sniffInkw(f)) {
      await inkw.openInkw(f);
      return;
    }
    toast('Reading the backup…', 60_000);
    await restoreFrom(f, () =>
      askPassword('Locked backup', 'This backup is locked. Type its password.', false),
    );
  } catch (e) {
    toast(`Couldn’t restore: ${(e as Error).message}`, 6000);
  }
});
export const restoreFromBackup = () => picker.click();
