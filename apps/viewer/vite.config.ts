import { readFileSync } from 'node:fs'
import { defineConfig } from 'vite'

// Per-app Vite config. `root` is pinned to this app dir via import.meta.dirname so the build
// works no matter which CWD invokes it (root script passes --config apps/viewer/vite.config.ts).
// The API server runs separately on 127.0.0.1. In dev, proxy the API + data routes to it
// (set BRAINANA_DEV_PORT to match `node apps/viewer/server.mjs --port <n>`).
// In production the same Node server serves the built dist/ and templates the token in.
const devApiPort = Number(process.env.BRAINANA_DEV_PORT) || 5174

// Single source of the displayed version: the root package.json — the same file
// scripts/generate-version.mjs and electron-builder read. Baked in as a compile-time constant
// (__APP_VERSION__) so the toolbar badge always matches the release with no second hardcoded copy.
const appVersion = (
  JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
    version: string
  }
).version

export default defineConfig({
  root: import.meta.dirname,
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2023',
  },
  server: {
    proxy: {
      '/api': { target: `http://127.0.0.1:${devApiPort}`, changeOrigin: true },
      '/brainana-data': { target: `http://127.0.0.1:${devApiPort}`, changeOrigin: true },
    },
  },
})
