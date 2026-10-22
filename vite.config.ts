import { defineConfig } from 'vite';

// Tauri expects a fixed port and fails if it is taken.
export default defineConfig({
  clearScreen: false,
  server: { port: 1420, strictPort: true, watch: { ignored: ['**/src-tauri/**'] } },
  // Lets `npm run share` serve through the localtunnel hostname.
  preview: { port: 4173, strictPort: true, allowedHosts: ['.loca.lt'] },
  build: { target: 'chrome120', sourcemap: false },
});
