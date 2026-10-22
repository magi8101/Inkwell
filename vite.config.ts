import { defineConfig, type Plugin } from 'vite';

// Lists every built file so the service worker (public/sw.js) can cache the whole app on install,
// including lazily loaded chunks like the PDF library, for offline use.
const precacheList = (): Plugin => ({
  name: 'precache-list',
  apply: 'build',
  generateBundle(_, bundle) {
    const files = Object.keys(bundle).map((f) => `/${f}`);
    this.emitFile({ type: 'asset', fileName: 'precache.json', source: JSON.stringify(files) });
  },
});

// Tauri expects a fixed port and fails if it is taken.
export default defineConfig({
  clearScreen: false,
  plugins: [precacheList()],
  server: { port: 1420, strictPort: true, watch: { ignored: ['**/src-tauri/**'] } },
  // Lets `npm run share` serve through the localtunnel hostname.
  preview: { port: 4173, strictPort: true, allowedHosts: ['.loca.lt'] },
  build: { target: 'chrome120', sourcemap: false },
});
