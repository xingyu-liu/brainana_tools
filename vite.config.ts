import { defineConfig } from 'vite'

// The API server runs separately on 127.0.0.1. In dev, proxy the API + data routes to it
// (set BRAINANA_DEV_PORT to match `node core/server/main.mjs --port <n>`).
// In production the same Node server serves the built dist/ and templates the token in.
const devApiPort = Number(process.env.BRAINANA_DEV_PORT) || 5174

export default defineConfig({
  root: '.',
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
