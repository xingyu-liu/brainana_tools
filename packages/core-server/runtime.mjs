// Tool-agnostic HTTP runtime: an unbound server that manages a registry of data sources.
//
//   - Binds 127.0.0.1 only (never 0.0.0.0/::) — fixes finding R5.
//   - Guards every /api/* and /brainana-data route with a per-launch session token
//     (timing-safe) — the launcher generates it and it is templated into index.html at
//     serve time, so it never appears in a URL or history.
//   - Source-scoped data routes: /brainana-data/<sourceId>/<encoded rel>, so subjects from
//     multiple sources coexist without path collisions.
//   - Optional legacy-compat: an unscoped, token-exempt data route + a single implicit
//     source, so the reference dist/ bundle keeps working during the transition (§6.4).
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { SourceRegistry, SOURCE_ID_PATTERN } from './dataSource.mjs'
import { LocalDataSource } from './localSource.mjs'
import { SftpDataSource } from './sftpSource.mjs'
import { SftpClient } from './sftpClient.mjs'
import { createTokenGuard, isWithin, TOKEN_COOKIE } from './security.mjs'
import { versionInfo } from './version.mjs'

function exists(p) {
  try {
    return fs.existsSync(p)
  } catch {
    return false
  }
}

// Data-route matchers, built from the single SOURCE_ID_PATTERN so they can't drift from the
// registry's id generator (#nextId): one captures the source id, one just tests for a scoped path.
const SCOPED_DATA_RE = new RegExp(`^/brainana-data/(${SOURCE_ID_PATTERN})/(.*)$`)
const SCOPED_DATA_PREFIX_RE = new RegExp(`^/brainana-data/${SOURCE_ID_PATTERN}/`)

// List subdirectories of an absolute path for the folder picker. Defaults to the server
// user's home directory when no path (or a non-absolute one) is given. Directories only,
// dotfiles skipped, sorted naturally — mirrors localSource.listDirectories in spirit but
// operates on absolute paths since there is no source root to scope against yet.
function browseDir(requested) {
  const current = requested && path.isAbsolute(requested) ? path.resolve(requested) : os.homedir()
  if (!exists(current)) throw Object.assign(new Error('Directory not found'), { statusCode: 404 })
  let stat
  try {
    stat = fs.statSync(current)
  } catch (error) {
    // Permission denied on the target itself, broken symlink, etc.
    throw Object.assign(new Error(error instanceof Error ? error.message : String(error)), { statusCode: 400 })
  }
  if (!stat.isDirectory()) throw Object.assign(new Error('Not a directory'), { statusCode: 400 })
  let dirents
  try {
    dirents = fs.readdirSync(current, { withFileTypes: true })
  } catch (error) {
    // e.g. EACCES on a directory we can stat but not read — surface it rather than 500.
    throw Object.assign(new Error(error instanceof Error ? error.message : String(error)), { statusCode: 403 })
  }
  const entries = dirents
    .filter((entry) => !entry.name.startsWith('.'))
    // Resolve symlinks so linked directories are still offered as navigable folders.
    .filter((entry) => {
      if (entry.isDirectory()) return true
      if (!entry.isSymbolicLink()) return false
      try {
        return fs.statSync(path.join(current, entry.name)).isDirectory()
      } catch {
        return false
      }
    })
    .map((entry) => ({ name: entry.name, path: path.join(current, entry.name), isDir: true }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }))
  const parent = path.dirname(current)
  return { path: current, parent: parent === current ? null : parent, entries }
}

function sendJson(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(value))
}

async function jsonBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
}

function staticContentType(absPath) {
  const lower = absPath.toLowerCase()
  if (lower.endsWith('.html')) return 'text/html; charset=utf-8'
  if (lower.endsWith('.js')) return 'text/javascript; charset=utf-8'
  if (lower.endsWith('.css')) return 'text/css; charset=utf-8'
  if (lower.endsWith('.json')) return 'application/json; charset=utf-8'
  if (lower.endsWith('.svg')) return 'image/svg+xml'
  if (lower.endsWith('.png')) return 'image/png'
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg'
  if (lower.endsWith('.ico')) return 'image/x-icon'
  if (lower.endsWith('.wasm')) return 'application/wasm'
  return 'application/octet-stream'
}

// Create (but do not start) the HTTP server.
//   token        — per-launch session token; null/'' disables the guard (legacy loopback).
//   distRoot     — directory of built static assets to serve (optional).
//   initialSources — [{ type:'local', path, label? }] opened at startup (optional).
//   legacyCompat — when true, also expose an unscoped /brainana-data/<rel> route bound to
//                  the first source, token-exempt, for the old dist/ bundle.
export function createServer({ token = null, distRoot = null, initialSources = [], legacyCompat = false, cacheRoot = null, manifestProvider = null } = {}) {
  const registry = new SourceRegistry()
  const guard = createTokenGuard(token)
  // Base cache dir for remote sources when the client does not specify one. Neutral name —
  // core is tool-agnostic; the real per-OS cache dir is passed in by the app's launcher.
  const serverCacheRoot = cacheRoot || path.join(os.tmpdir(), 'brainana-cache')

  // Pre-add remote connections held open between a /api/remote/connect and the subsequent
  // /api/remote/browse calls, so the SFTP handshake is paid once per browse session (not per click).
  // token -> { client, lastUsed }. Cleaned up on disconnect, on idle timeout, and on server close.
  // These are the viewer server's own sockets — unrelated to any pipeline process/scratch cleanup.
  const remoteBrowsers = new Map()
  const REMOTE_BROWSE_TTL_MS = 10 * 60 * 1000
  const sweepRemoteBrowsers = () => {
    const now = Date.now()
    for (const [tok, entry] of remoteBrowsers) {
      if (now - entry.lastUsed > REMOTE_BROWSE_TTL_MS) {
        remoteBrowsers.delete(tok)
        entry.client.close().catch(() => {})
      }
    }
  }
  // List directories under an absolute remote path, mirroring browseDir's shape for the shared picker.
  async function remoteListing(client, absPath) {
    const entries = (await client.list(absPath))
      .filter((e) => e.type === 'directory' && !e.name.startsWith('.'))
      .map((e) => ({ name: e.name, path: path.posix.join(absPath, e.name), isDir: true }))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }))
    const parent = path.posix.dirname(absPath)
    return { path: absPath, parent: parent === absPath ? null : parent, entries }
  }

  // Open any startup sources synchronously enough that /api/sources reflects them.
  // A source that fails to open is logged and skipped — one bad startup source must not
  // reject `ready` and 500 every subsequent request.
  const ready = (async () => {
    for (const spec of initialSources) {
      try {
        const source = await openSource(spec)
        registry.add(source, { type: source.type })
      } catch (error) {
        console.error(`Failed to open startup source (${spec?.type} ${spec?.path || spec?.remoteRoot || ''}):`, error instanceof Error ? error.message : error)
      }
    }
  })()

  async function openSource(spec) {
    if (spec.type === 'local') {
      return new LocalDataSource({ root: spec.path, label: spec.label, customLabel: spec.customLabel, manifest: manifestProvider })
    }
    if (spec.type === 'remote') {
      // Default a per-source cache dir under the server cache root when unspecified,
      // keyed by host+root so re-adding the same remote reuses its cache.
      const digest = crypto.createHash('sha256').update(`${spec.connection?.host}\0${spec.remoteRoot}`).digest('hex').slice(0, 16)
      const resolvedCacheRoot = spec.cacheRoot || path.join(serverCacheRoot, 'remote', digest)
      const source = new SftpDataSource({
        label: spec.label,
        customLabel: spec.customLabel,
        connection: spec.connection,
        remoteRoot: spec.remoteRoot,
        cacheRoot: resolvedCacheRoot,
        manifest: manifestProvider,
      })
      await source.open()
      return source
    }
    throw new Error(`Unknown source type: ${spec.type}`)
  }

  // The single implicit source used by legacy-compat unscoped routes.
  function legacySource() {
    return registry.list()[0] ? registry.get(registry.list()[0].id) : null
  }

  function serveStatic(res, pathname) {
    if (!distRoot) return false
    let decoded
    try {
      decoded = decodeURIComponent(pathname)
    } catch {
      return false
    }
    const rel = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '')
    let abs = path.resolve(distRoot, rel)
    if (!isWithin(distRoot, abs) || !exists(abs) || !fs.statSync(abs).isFile()) {
      abs = path.join(distRoot, 'index.html')
    }
    if (!exists(abs) || !fs.statSync(abs).isFile()) return false
    // Template the session token into index.html so the client can read it from a meta tag.
    if (abs.endsWith('index.html') && token) {
      let html = fs.readFileSync(abs, 'utf8')
      const meta = `<meta name="brainana-token" content="${token}" />`
      html = html.includes('name="brainana-token"') ? html : html.replace(/<head(\s[^>]*)?>/i, (m) => `${m}\n    ${meta}`)
      // Loopback cookie so NiiVue's own fetch loaders (which cannot set headers)
      // authenticate on same-origin data requests. HttpOnly + SameSite=Strict; the JS
      // client uses the meta-tag token for /api calls, so the cookie need not be readable.
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache',
        'Content-Length': Buffer.byteLength(html),
        'Set-Cookie': `${TOKEN_COOKIE}=${encodeURIComponent(token)}; Path=/; SameSite=Strict; HttpOnly`,
      })
      res.end(html)
      return true
    }
    const stat = fs.statSync(abs)
    res.writeHead(200, {
      'Content-Type': staticContentType(abs),
      'Content-Length': stat.size,
      'Cache-Control': abs.endsWith('index.html') ? 'no-cache' : 'public, max-age=3600',
    })
    fs.createReadStream(abs).pipe(res)
    return true
  }

  async function serveData(req, res, source, rel) {
    try {
      const opened = await source.openFile(rel, req.headers.range)
      const headers = { 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=3600', 'Content-Type': opened.contentType }
      if (opened.partial) {
        res.writeHead(206, { ...headers, 'Content-Range': `bytes ${opened.start}-${opened.end}/${opened.total}`, 'Content-Length': opened.end - opened.start + 1 })
      } else {
        res.writeHead(200, { ...headers, 'Content-Length': opened.total })
      }
      opened.stream.on('error', () => res.destroy())
      // NiiVue fires many aborted range requests; release the source stream (fd / cached
      // remote read) as soon as the client disconnects instead of leaking it until GC.
      res.on('close', () => opened.stream.destroy())
      opened.stream.pipe(res)
    } catch (error) {
      const status = error?.statusCode || 404
      if (!res.headersSent) sendJson(res, status, { error: error instanceof Error ? error.message : String(error) })
      else res.destroy()
    }
  }

  const server = http.createServer(async (req, res) => {
    try {
      await ready
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
      const pathname = url.pathname

      // ---- Unauthenticated: health/version (no data, safe to expose on loopback) ----
      if (pathname === '/api/health') return sendJson(res, 200, { ok: true, ...versionInfo })
      if (pathname === '/api/version') return sendJson(res, 200, versionInfo)

      // ---- Everything else under /api or /brainana-data requires the token ----
      const guarded = pathname.startsWith('/api/') || pathname.startsWith('/brainana-data/')
      const isLegacyData = legacyCompat && pathname.startsWith('/brainana-data/') && !SCOPED_DATA_PREFIX_RE.test(pathname)
      if (guarded && !isLegacyData && !guard(req)) {
        return sendJson(res, 401, { error: 'Missing or invalid session token' })
      }

      if (pathname === '/api/runtime') {
        return sendJson(res, 200, {
          ...versionInfo,
          unbound: true,
          capabilities: { serverSideExport: true, multiSource: true, remoteRuntime: false },
          sources: registry.list(),
        })
      }

      // ---- Filesystem browse: list subdirectories of an absolute path so the Sources dialog
      // can offer a folder picker for the local-source form (no source exists yet, so this is
      // deliberately unscoped). Grants no more reach than the "Add local dataset" form already does —
      // that form accepts any absolute path as a readable root — and rides the same loopback
      // bind + token guard as every other /api route above.
      if (pathname === '/api/fs/browse' && req.method === 'GET') {
        try {
          return sendJson(res, 200, browseDir(url.searchParams.get('path') || ''))
        } catch (error) {
          const status = error?.statusCode || 400
          return sendJson(res, status, { error: error instanceof Error ? error.message : String(error) })
        }
      }

      // ---- Remote browse: connect once, then list arbitrary remote directories before adding the
      // source (the SftpDataSource is locked to a fixed remoteRoot and cannot browse above it).
      // Same loopback bind + token guard as every other /api route; passwords are never stored. ----
      if (pathname === '/api/remote/connect' && req.method === 'POST') {
        sweepRemoteBrowsers()
        let client
        try {
          const { connection } = await jsonBody(req)
          client = new SftpClient(connection)
          await client.connect()
          const token = `remote-${crypto.randomBytes(9).toString('hex')}`
          remoteBrowsers.set(token, { client, lastUsed: Date.now() })
          return sendJson(res, 200, { token })
        } catch (error) {
          if (client) client.close().catch(() => {})
          return sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
        }
      }
      if (pathname === '/api/remote/browse' && req.method === 'GET') {
        sweepRemoteBrowsers()
        const entry = remoteBrowsers.get(url.searchParams.get('token') || '')
        if (!entry) return sendJson(res, 404, { error: 'Not connected (session expired). Reconnect and try again.' })
        entry.lastUsed = Date.now()
        try {
          const requested = url.searchParams.get('path') || ''
          const abs = requested || (await entry.client.realpath('.').catch(() => '/'))
          return sendJson(res, 200, await remoteListing(entry.client, abs))
        } catch (error) {
          return sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
        }
      }
      if (pathname === '/api/remote/disconnect' && req.method === 'POST') {
        const { token } = await jsonBody(req).catch(() => ({}))
        const entry = token && remoteBrowsers.get(token)
        if (entry) {
          remoteBrowsers.delete(token)
          entry.client.close().catch(() => {})
        }
        return sendJson(res, 200, { ok: true })
      }

      // ---- Source registry ----
      if (pathname === '/api/sources' && req.method === 'GET') return sendJson(res, 200, registry.list())
      if (pathname === '/api/sources' && req.method === 'POST') {
        try {
          const spec = await jsonBody(req)
          const source = await openSource(spec)
          registry.add(source, { type: source.type })
          return sendJson(res, 200, { id: source.id, type: source.type, label: source.label, customLabel: source.customLabel ?? null })
        } catch (error) {
          return sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
        }
      }
      // Rename a source's display label (RAM-only). Matched before the scoped `:id/<action>`
      // routes below because a bare `/api/sources/:id` has no trailing action segment.
      if (pathname.startsWith('/api/sources/') && !pathname.slice('/api/sources/'.length).includes('/') && req.method === 'PATCH') {
        const id = decodeURIComponent(pathname.slice('/api/sources/'.length))
        const source = registry.get(id)
        if (!source) return sendJson(res, 404, { error: 'Source not found' })
        try {
          const body = await jsonBody(req)
          const trimmed = typeof body.customLabel === 'string' ? body.customLabel.trim() : ''
          source.customLabel = trimmed || null
          return sendJson(res, 200, { id: source.id, type: source.type, label: source.label, customLabel: source.customLabel })
        } catch (error) {
          return sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
        }
      }
      if (pathname.startsWith('/api/sources/') && req.method === 'DELETE') {
        const id = decodeURIComponent(pathname.slice('/api/sources/'.length))
        const removed = await registry.remove(id)
        return sendJson(res, removed ? 200 : 404, removed ? { id } : { error: 'Source not found' })
      }

      // ---- Source-scoped data endpoints: /api/sources/:id/... ----
      const scoped = pathname.match(/^\/api\/sources\/([^/]+)\/(monkeys|manifest|directories|import-files|save-list|save-mkdir|save-file)(?:\/(.*))?$/)
      if (scoped) {
        const [, id, action, tail] = scoped
        const source = registry.get(decodeURIComponent(id))
        if (!source) return sendJson(res, 404, { error: 'Source not found' })
        try {
          if (action === 'monkeys') return sendJson(res, 200, await source.listMonkeys())
          if (action === 'manifest') return sendJson(res, 200, await source.buildManifest(decodeURIComponent(tail || '')))
          if (action === 'directories') return sendJson(res, 200, await source.listDirectories(url.searchParams.get('path') || ''))
          if (action === 'import-files') return sendJson(res, 200, await source.listImportFiles(url.searchParams.get('path') || '', url.searchParams.get('q') || ''))
          if (action === 'save-list') return sendJson(res, 200, await source.saveList(url.searchParams.get('path') || ''))
          if (action === 'save-mkdir' && req.method === 'POST') {
            const body = await jsonBody(req)
            return sendJson(res, 200, await source.mkdir(body.path || ''))
          }
          if (action === 'save-file' && req.method === 'POST') {
            const result = await source.saveFile(url.searchParams.get('path') || '', req, { overwrite: url.searchParams.get('overwrite') === '1' })
            if (result.exists) return sendJson(res, 409, { error: 'File already exists', path: result.path })
            return sendJson(res, 200, result)
          }
          return sendJson(res, 405, { error: 'Method not allowed' })
        } catch (error) {
          const status = error?.statusCode || (error?.code === 'EEXIST' ? 409 : 400)
          return sendJson(res, status, { error: error instanceof Error ? error.message : String(error) })
        }
      }

      // ---- Data bytes: source-scoped ----
      const dataScoped = pathname.match(SCOPED_DATA_RE)
      if (dataScoped) {
        const source = registry.get(decodeURIComponent(dataScoped[1]))
        if (!source) return sendJson(res, 404, { error: 'Source not found' })
        const rel = dataScoped[2].split('/').map(decodeURIComponent).join('/')
        return serveData(req, res, source, rel)
      }

      // ---- Legacy-compat unscoped data bytes → first source ----
      if (isLegacyData) {
        const source = legacySource()
        if (!source) return sendJson(res, 400, { error: 'No data source configured' })
        const rel = pathname.slice('/brainana-data/'.length).split('/').map(decodeURIComponent).join('/')
        return serveData(req, res, source, rel)
      }

      if (serveStatic(res, pathname)) return
      res.statusCode = 404
      res.end('Not found')
    } catch (error) {
      console.error(error)
      if (!res.headersSent) sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
    }
  })

  // Expose the registry + a graceful close for tests and the launcher.
  server.on('close', () => {
    registry.closeAll().catch(() => {})
    for (const [tok, entry] of remoteBrowsers) {
      remoteBrowsers.delete(tok)
      entry.client.close().catch(() => {})
    }
  })
  return { server, registry, ready, openSource }
}

// Convenience: create + listen on 127.0.0.1. Never binds a public interface.
// Rejects (rather than hanging) if the port is unavailable, so callers can retry or report.
export function startServer(options = {}) {
  const { server, registry, ready } = createServer(options)
  const port = options.port ?? 0
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.removeListener('listening', onListening)
      reject(error)
    }
    const onListening = () => {
      server.removeListener('error', onError)
      resolve({ server, registry, ready, address: server.address() })
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, '127.0.0.1')
  })
}
