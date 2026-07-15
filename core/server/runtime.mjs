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
import { SourceRegistry } from './dataSource.mjs'
import { LocalDataSource } from './localSource.mjs'
import { SftpDataSource } from './sftpSource.mjs'
import { createTokenGuard, isWithin, TOKEN_COOKIE } from './security.mjs'
import { versionInfo } from './version.mjs'

function exists(p) {
  try {
    return fs.existsSync(p)
  } catch {
    return false
  }
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
export function createServer({ token = null, distRoot = null, initialSources = [], legacyCompat = false, cacheRoot = null } = {}) {
  const registry = new SourceRegistry()
  const guard = createTokenGuard(token)
  // Base cache dir for remote sources when the client does not specify one.
  const serverCacheRoot = cacheRoot || path.join(os.tmpdir(), 'brainana-viewer-cache')

  // Open any startup sources synchronously enough that /api/sources reflects them.
  const ready = (async () => {
    for (const spec of initialSources) {
      const source = await openSource(spec)
      registry.add(source, { type: source.type })
    }
  })()

  async function openSource(spec) {
    if (spec.type === 'local') {
      return new LocalDataSource({ root: spec.path, label: spec.label })
    }
    if (spec.type === 'remote') {
      // Default a per-source cache dir under the server cache root when unspecified,
      // keyed by host+root so re-adding the same remote reuses its cache.
      const digest = crypto.createHash('sha256').update(`${spec.connection?.host}\0${spec.remoteRoot}`).digest('hex').slice(0, 16)
      const resolvedCacheRoot = spec.cacheRoot || path.join(serverCacheRoot, 'remote', digest)
      const source = new SftpDataSource({
        label: spec.label,
        connection: spec.connection,
        remoteRoot: spec.remoteRoot,
        cacheRoot: resolvedCacheRoot,
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
      const isLegacyData = legacyCompat && pathname.startsWith('/brainana-data/') && !/^\/brainana-data\/[^/]+-[0-9a-f]{12}\//.test(pathname)
      if (guarded && !isLegacyData && !guard(req, url)) {
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

      // ---- Source registry ----
      if (pathname === '/api/sources' && req.method === 'GET') return sendJson(res, 200, registry.list())
      if (pathname === '/api/sources' && req.method === 'POST') {
        try {
          const spec = await jsonBody(req)
          const source = await openSource(spec)
          registry.add(source, { type: source.type })
          return sendJson(res, 200, { id: source.id, type: source.type, label: source.label })
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
      const dataScoped = pathname.match(/^\/brainana-data\/([^/]+-[0-9a-f]{12})\/(.*)$/)
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
  })
  return { server, registry, ready, openSource }
}

// Convenience: create + listen on 127.0.0.1. Never binds a public interface.
export function startServer(options = {}) {
  const { server, registry, ready } = createServer(options)
  const port = options.port ?? 0
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      resolve({ server, registry, ready, address: server.address() })
    })
  })
}
