// Viewer desktop entry (`npm run dev:desktop` / packaged app). Composition root: it hands the
// generic, tool-agnostic Electron shell the Viewer's identity + domain manifest provider. This is
// the ONLY place the Viewer domain meets the desktop platform — packages/core-* stay domain-free.
// Structurally identical to apps/viewer/launch.mjs (the browser entry); only the shell differs.
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { runDesktop } from '@brainana/core-desktop/main.mjs'
import { viewerManifestProvider } from './server/manifest.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const dist = path.join(here, 'dist')
const distRoot = fs.existsSync(dist) ? dist : null

runDesktop({
  manifestProvider: viewerManifestProvider,
  appLabel: 'Brainana Viewer',
  cacheApp: 'BrainanaViewer',
  distRoot,
  preferredPort: 5173,
}).catch((error) => {
  console.error('Desktop launch failed:', error)
  process.exit(1)
})
