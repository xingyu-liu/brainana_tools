// Cross-platform launcher (replaces the macOS-only AppleScript launcher, finding R2).
//   1. Generate a per-launch session token.
//   2. Scan for a free port on 127.0.0.1.
//   3. Start the server (loopback bind + token).
//   4. Open the default browser (open / start / xdg-open by platform).
// All mode/profile pickers move into the browser UI (Phase 2); this just boots the app.
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { startServer } from '../server/runtime.mjs'
import { generateSessionToken } from '../server/security.mjs'
import { versionInfo } from '../server/version.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..', '..')
const argv = process.argv.slice(2)
const hasFlag = (name) => argv.includes(name)

// Per-OS cache directory (fixes the hardcoded ~/Library/Caches, finding R2 / §6.3).
export function cacheDir() {
  const app = 'BrainanaViewer'
  if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), app)
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Caches', app)
  return path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), app)
}

// Find a free port starting near `preferred`, walking upward.
async function findFreePort(preferred = 5173, attempts = 50) {
  for (let p = preferred; p < preferred + attempts; p++) {
    const free = await new Promise((resolve) => {
      const srv = net.createServer()
      srv.once('error', () => resolve(false))
      srv.once('listening', () => srv.close(() => resolve(true)))
      srv.listen(p, '127.0.0.1')
    })
    if (free) return p
  }
  return 0 // let the OS choose
}

// Open a URL in the default browser without blocking.
function openBrowser(url) {
  const platform = process.platform
  const [cmd, args] = platform === 'darwin' ? ['open', [url]] : platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]]
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true })
    child.on('error', () => console.log(`Open your browser to: ${url}`))
    child.unref()
  } catch {
    console.log(`Open your browser to: ${url}`)
  }
}

async function main() {
  const token = generateSessionToken()
  const port = await findFreePort(Number(process.env.PORT) || 5173)
  const distRoot = fs.existsSync(path.join(repoRoot, 'dist')) ? path.join(repoRoot, 'dist') : null
  const legacyCompat = hasFlag('--legacy') || Boolean(distRoot) // serve the reference bundle until the rebuild lands
  const cache = cacheDir()
  fs.mkdirSync(cache, { recursive: true })

  const { server, address } = await startServer({ token, distRoot, legacyCompat, port, cacheRoot: cache })
  const url = `http://127.0.0.1:${address.port}/`
  console.log(`Brainana Viewer ${versionInfo.version} (${versionInfo.buildId})`)
  console.log(`Serving on ${url} (loopback only, session token active)`)
  console.log(`Cache: ${cache}`)

  if (!hasFlag('--no-open') && !hasFlag('--dev')) openBrowser(url)

  const shutdown = () => server.close(() => process.exit(0))
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch((error) => {
  console.error('Launcher failed:', error)
  process.exit(1)
})
