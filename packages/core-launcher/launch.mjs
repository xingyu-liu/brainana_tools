// Cross-platform launcher (replaces the macOS-only AppleScript launcher, finding R2).
//   1. Generate a per-launch session token.
//   2. Scan for a free port on 127.0.0.1.
//   3. Start the server (loopback bind + token).
//   4. Open the default browser (open / start / xdg-open by platform).
//
// TOOL-AGNOSTIC: `launch(options)` is a reusable function every brainana tool calls with its
// own identity (manifest provider, banner label, dist dir, cache namespace, default port).
// It imports no tool's domain — the app entry (apps/<tool>/launch.mjs) supplies that.
import net from 'node:net'
import fs from 'node:fs'
import { spawn } from 'node:child_process'
import { startServer } from '@brainana/core-server/runtime.mjs'
import { generateSessionToken } from '@brainana/core-server/security.mjs'
import { versionInfo } from '@brainana/core-server/version.mjs'
import { cacheDir } from '@brainana/core-server/paths.mjs'

const argv = process.argv.slice(2)
const hasFlag = (name) => argv.includes(name)

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

// Start the server, tolerating the TOCTOU gap between probing a free port and binding it:
// if the port was taken in between (EADDRINUSE), walk to the next candidate and retry, and
// finally fall back to an OS-chosen ephemeral port. Prevents a silent hang on a busy box.
async function startOnFreePort(options, preferred) {
  let port = await findFreePort(preferred)
  for (let attempt = 0; attempt < 12; attempt++) {
    try {
      return await startServer({ ...options, port })
    } catch (error) {
      if (error?.code !== 'EADDRINUSE') throw error
      port = port === 0 ? 0 : await findFreePort(port + 1)
    }
  }
  return startServer({ ...options, port: 0 }) // last resort: ephemeral port
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

// Boot the core server WITHOUT choosing a frontend surface: mint a token, find a free loopback
// port, start the server with the app's injected manifest provider, and log. It deliberately does
// NOT open a browser or install signal handlers — those are the caller's concern. This is the
// shared core reused by both the browser launcher (`launch()`, below) and the desktop shell
// (`@brainana/core-desktop`), which loads the same URL in an Electron BrowserWindow instead.
export async function bootServer({ manifestProvider, appLabel = 'Brainana', distRoot = null, cacheApp = 'Brainana', preferredPort = 5173, legacyCompat = false }) {
  const token = generateSessionToken()
  const cache = cacheDir(cacheApp)
  fs.mkdirSync(cache, { recursive: true })

  const { server, address } = await startOnFreePort({ token, distRoot, legacyCompat, cacheRoot: cache, manifestProvider }, Number(process.env.PORT) || preferredPort)
  const url = `http://127.0.0.1:${address.port}/`
  console.log(`${appLabel} ${versionInfo.version} (${versionInfo.buildId})`)
  console.log(`Serving on ${url} (loopback only, session token active)`)
  console.log(`Cache: ${cache}`)

  return { server, address, url, token, cache }
}

// Boot a brainana tool: mint a token, find a free loopback port, start the core server with the
// app's injected manifest provider, and open the browser. The app supplies its own identity.
export async function launch({ manifestProvider, appLabel = 'Brainana', distRoot = null, cacheApp = 'Brainana', preferredPort = 5173 }) {
  // The built dist/ IS the source-scoped, token-guarded frontend — it does NOT use the
  // unscoped, token-exempt legacy route. So legacy-compat is an explicit opt-in (--legacy),
  // never implied by the mere presence of a build.
  const boot = await bootServer({ manifestProvider, appLabel, distRoot, cacheApp, preferredPort, legacyCompat: hasFlag('--legacy') })
  const { server, address, url } = boot

  if (!hasFlag('--no-open') && !hasFlag('--dev')) openBrowser(url)

  const shutdown = () => server.close(() => process.exit(0))
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
  return { server, address, url }
}
