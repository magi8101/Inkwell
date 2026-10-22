// Runs the OneNote importer (Rust → WebAssembly, see onenote/) off the main thread, so parsing a
// large notebook never blocks drawing. Receives the file's bytes, replies with the parsed pages.
import wasmUrl from './onenote-import.wasm?url';

interface Exports {
  memory: WebAssembly.Memory;
  alloc(len: number): number;
  dealloc(ptr: number, cap: number): void;
  parse_section(ptr: number, len: number): number;
}

let exportsPromise: Promise<Exports> | null = null;
const load = () => {
  // Not instantiateStreaming: it needs an application/wasm content type, which the desktop
  // app's built-in file server doesn't promise.
  exportsPromise ??= fetch(wasmUrl)
    .then((r) => r.arrayBuffer())
    .then((bytes) => WebAssembly.instantiate(bytes, {}))
    .then((r) => r.instance.exports as unknown as Exports);
  return exportsPromise;
};

self.onmessage = async (e: MessageEvent<ArrayBuffer>) => {
  try {
    const w = await load();
    const input = new Uint8Array(e.data);
    const ptr = w.alloc(input.length);
    new Uint8Array(w.memory.buffer, ptr, input.length).set(input);
    const out = w.parse_section(ptr, input.length);
    const len = new DataView(w.memory.buffer).getUint32(out, true);
    const json = new TextDecoder().decode(new Uint8Array(w.memory.buffer, out + 4, len));
    w.dealloc(out, len + 4);
    w.dealloc(ptr, input.length);
    self.postMessage(JSON.parse(json));
  } catch (err) {
    self.postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};
