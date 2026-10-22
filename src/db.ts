// IndexedDB: the app's on-device storage. Unlike localStorage (~5 MB) it holds as much as the device
// allows, stores Blobs (pictures, PDFs) directly and works offline in every browser and in the
// desktop app's webviews. Two stores: `kv` for the notebook state, `blobs` for binary files.

const NAME = 'inkwell';
const VERSION = 1;
type Store = 'kv' | 'blobs';

let opening: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  opening ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
      if (!db.objectStoreNames.contains('blobs')) db.createObjectStore('blobs');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      opening = null;
      reject(req.error);
    };
    req.onblocked = () => reject(new Error('storage is blocked by another Inkwell tab'));
  });
  return opening;
}

/** Runs one request; resolves only once the transaction commits, so a resolved write is durable. */
async function run<T>(
  store: Store,
  mode: IDBTransactionMode,
  make: (s: IDBObjectStore) => IDBRequest<T>,
) {
  const db = await open();
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const req = make(tx.objectStore(store));
    tx.oncomplete = () => resolve(req.result);
    tx.onerror = () => reject(tx.error ?? req.error);
    tx.onabort = () => reject(tx.error ?? new Error('storage transaction aborted'));
  });
}

export const kvGet = <T>(key: string) => run<T | undefined>('kv', 'readonly', (s) => s.get(key));
export const kvPut = (key: string, value: unknown) =>
  run('kv', 'readwrite', (s) => s.put(value, key));
// Files are stored as bytes + type, not as Blobs: WebKit refuses Blobs in some contexts (Safari
// private browsing, some webviews: "Error preparing Blob/File data"). Blobs saved before still read.
type Stored = Blob | { type: string; data: ArrayBuffer };
export const blobGet = async (id: string) => {
  const v = await run<Stored | undefined>('blobs', 'readonly', (s) => s.get(id));
  return v && !(v instanceof Blob) ? new Blob([v.data], { type: v.type }) : v;
};
export const blobPut = async (id: string, blob: Blob) => {
  const data = await blob.arrayBuffer();
  return run('blobs', 'readwrite', (s) => s.put({ type: blob.type, data }, id));
};
