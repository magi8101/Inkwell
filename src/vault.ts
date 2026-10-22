import { blobGet, blobPut, kvGet, kvPut } from './db';
import { toast } from './dom';
import { newNotebook, newSection, state, subscribe, update } from './store';
import { applyDisk, type Backend, readDisk, syncOut, type Written } from './vault-core';

// Keeping a notebook in a folder on disk (see vault-core.ts for the format and sync rules).
// Desktop app: the Rust side owns the folder path and checks every path. Chrome/Edge: the File
// System Access API. Safari, Firefox and iPad have no way to write to a chosen folder.

const IN_DESKTOP_APP = '__TAURI_INTERNALS__' in window;

// Not yet in TypeScript's DOM types.
interface DirHandle {
  kind: 'directory';
  name: string;
  entries(): AsyncIterable<[string, DirHandle | FileHandle]>;
  getDirectoryHandle(name: string, o?: { create?: boolean }): Promise<DirHandle>;
  getFileHandle(name: string, o?: { create?: boolean }): Promise<FileHandle>;
  removeEntry(name: string): Promise<void>;
  queryPermission(o: { mode: 'readwrite' }): Promise<PermissionState>;
  requestPermission(o: { mode: 'readwrite' }): Promise<PermissionState>;
}
interface FileHandle {
  kind: 'file';
  getFile(): Promise<File>;
  createWritable(): Promise<{ write(d: Blob | string): Promise<void>; close(): Promise<void> }>;
}
type Picker = (o: { mode: 'readwrite'; id: string }) => Promise<DirHandle>;
const showDirectoryPicker = (window as unknown as { showDirectoryPicker?: Picker })
  .showDirectoryPicker;

// The Android app has no folder picker that gives a real path, so the option is hidden there.
export const vaultSupported =
  (IN_DESKTOP_APP && !/Android/.test(navigator.userAgent)) || !!showDirectoryPicker;

function webBackend(root: DirHandle): Backend {
  const split = (path: string) => {
    const parts = path.split('/').filter(Boolean);
    return { dirs: parts.slice(0, -1), name: parts.at(-1)! };
  };
  const dir = async (parts: string[], create: boolean) => {
    let d = root;
    for (const p of parts) d = await d.getDirectoryHandle(p, { create });
    return d;
  };
  return {
    async list() {
      const out: string[] = [];
      const walk = async (d: DirHandle, prefix: string) => {
        for await (const [name, child] of d.entries()) {
          // ponytail: capped walk; a huge folder (e.g. a whole home folder) isn't a notebook.
          if (name.startsWith('.') || out.length > 20_000) continue;
          if (child.kind === 'directory') {
            out.push(`${prefix}${name}/`);
            await walk(child, `${prefix}${name}/`);
          } else out.push(prefix + name);
        }
      };
      await walk(root, '');
      return out;
    },
    async read(path) {
      const { dirs, name } = split(path);
      return (await (await dir(dirs, false)).getFileHandle(name)).getFile();
    },
    async write(path, data) {
      const { dirs, name } = split(path);
      const file = await (await dir(dirs, true)).getFileHandle(name, { create: true });
      const w = await file.createWritable();
      await w.write(data);
      await w.close();
    },
    async mkdir(path) {
      await dir(path.split('/').filter(Boolean), true);
    },
    async remove(path) {
      const { dirs, name } = split(path);
      try {
        await (await dir(dirs, false)).removeEntry(name); // a non-empty directory refuses: fine
      } catch {}
    },
  };
}

async function desktopBackend(): Promise<Backend> {
  const { invoke } = await import('@tauri-apps/api/core');
  return {
    list: () => invoke<string[]>('vault_list'),
    read: async (path) => new Blob([await invoke<ArrayBuffer>('vault_read', { path })]),
    write: async (path, data) => {
      const bytes = new Uint8Array(await new Blob([data]).arrayBuffer());
      await invoke('vault_write', bytes, { headers: { 'x-path': encodeURIComponent(path) } });
    },
    mkdir: (path) => invoke('vault_mkdir', { path }),
    remove: (path) => invoke('vault_remove', { path }),
  };
}

// --- Which notebook lives where (kept in IndexedDB; a folder handle can be stored there) ---

interface Link {
  notebookId: string;
  name: string;
  handle?: DirHandle;
  written: Written;
}
const KEY = 'inkwell:vault';
let link: Link | null = (await kvGet<Link>(KEY).catch(() => undefined)) ?? null;
let disk: Backend | null = null;
const types = new Map<string, string>();
const statusListeners = new Set<() => void>();
export const onVaultChange = (fn: () => void) => statusListeners.add(fn);
const changed = () => {
  for (const l of statusListeners) l();
};

/** The linked folder: its name, whether it's connected, and which notebook it holds. */
export const vault = () =>
  link && { name: link.name, connected: !!disk, notebookId: link.notebookId };

const remember = () => kvPut(KEY, link).catch(() => {});

let failed = false;
function report(e: unknown) {
  console.error(e);
  if (failed) return;
  failed = true; // once, not on every save
  toast(`Couldn't save to the folder “${link?.name}”: ${(e as Error).message ?? e}`, 6000);
}

// One sync at a time; changes made while one runs get another pass afterwards.
let running: Promise<void> | null = null;
let again = false;
async function syncNow(fromDisk = false) {
  if (running) {
    again = true;
    return running;
  }
  running = (async () => {
    try {
      do {
        again = false;
        const nb = link && disk && state.notebooks.find((n) => n.id === link!.notebookId);
        if (!link || !disk || !nb) return;
        if (fromDisk) {
          const plan = await readDisk(disk, link.written, hasBlob, putBlob);
          update(() => applyDisk(nb, plan, link!.written, folder));
          fromDisk = false;
        }
        await syncOut(nb, disk, link.written, blobGet, types);
        await remember();
        failed = false;
      } while (again);
    } catch (e) {
      report(e);
    } finally {
      running = null;
    }
  })();
  return running;
}

const folder = (name: string, parent?: string) => ({
  ...newSection(name, state.notebooks.length),
  pages: [],
  ...(parent ? { parent } : {}),
});

let timer = 0;
subscribe(() => {
  if (!disk || !link) return;
  clearTimeout(timer);
  timer = window.setTimeout(() => void syncNow(), 1500);
});

async function pick(): Promise<{ name: string; handle?: DirHandle } | null> {
  if (IN_DESKTOP_APP) {
    const { invoke } = await import('@tauri-apps/api/core');
    const name = await invoke<string | null>('vault_pick');
    return name ? { name } : null;
  }
  try {
    const handle = await showDirectoryPicker!({ mode: 'readwrite', id: 'inkwell-notebook' });
    return { name: handle.name, handle };
  } catch {
    return null; // cancelled
  }
}

async function connect(l: Link, fromDisk = true) {
  disk = l.handle ? webBackend(l.handle) : await desktopBackend();
  link = l;
  await remember();
  changed();
  await syncNow(fromDisk);
}

const hasBlob = async (id: string) => !!(await blobGet(id));
const putBlob = async (id: string, b: Blob) => void (await blobPut(id, b));

/** Opens a folder as a notebook: what's in it becomes the notebook, and changes save back to it. */
export async function openFolder() {
  const picked = await pick();
  if (!picked) return;
  try {
    const backend = picked.handle ? webBackend(picked.handle) : await desktopBackend();
    const written: Written = {};
    const plan = await readDisk(backend, written, hasBlob, putBlob);
    const nb = newNotebook(picked.name);
    // A folder with notes in it becomes exactly those; an empty one starts with "Quick Notes".
    if (plan.pages.length || plan.dirs.length) nb.sections = [];
    applyDisk(nb, plan, written, folder);
    update((s) => {
      s.notebooks.push(nb);
      s.notebookId = nb.id;
    });
    await connect({ notebookId: nb.id, name: picked.name, handle: picked.handle, written }, false);
    toast(`Opened “${picked.name}”. Changes save to the folder.`, 3000);
  } catch (e) {
    report(e);
  }
}

/** Saves the current notebook into a folder and keeps it there. */
export async function saveToFolder() {
  const picked = await pick();
  if (!picked) return;
  try {
    await connect({
      notebookId: state.notebookId,
      name: picked.name,
      handle: picked.handle,
      written: {},
    });
  } catch (e) {
    report(e);
    return;
  }
  toast(`Saving to “${picked.name}”.`, 3000);
}

/** Stops saving to the folder; the notes stay both in the app and in the folder. */
export async function forgetFolder() {
  if (IN_DESKTOP_APP) {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('vault_forget').catch(() => {});
  }
  link = null;
  disk = null;
  await kvPut(KEY, null).catch(() => {});
  changed();
}

/** After a restart the browser asks again before the folder can be used (needs a tap). */
export async function reconnect() {
  if (!link?.handle) return;
  if ((await link.handle.requestPermission({ mode: 'readwrite' })) === 'granted')
    await connect(link);
}

// On start, in the background: reconnect if allowed without asking (the desktop app, or a browser
// that kept the permission); otherwise the sidebar offers "Reconnect folder".
if (link) {
  const l = link;
  void (async () => {
    try {
      if (!l.handle || (await l.handle.queryPermission({ mode: 'readwrite' })) === 'granted') {
        await connect(l);
      }
    } catch (e) {
      report(e);
    }
  })();
}
