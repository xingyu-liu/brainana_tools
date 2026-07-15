// Tool-agnostic security primitives: per-launch session token and path containment.
// No Viewer-domain knowledge lives here so core/ can be lifted into a shared package later.
import crypto from 'node:crypto'
import path from 'node:path'

// ---------------------------------------------------------------------------
// Session token
// ---------------------------------------------------------------------------

// A fresh, high-entropy token minted once per launch. The launcher generates it and
// the server templates it into index.html at serve time (loopback only), so it never
// appears in a URL or browser history.
export function generateSessionToken() {
  return crypto.randomBytes(32).toString('hex')
}

// Constant-time comparison. Never short-circuits on length or content, so the caller
// leaks no timing signal about how much of a guessed token was correct.
export function timingSafeEqual(a, b) {
  const bufA = Buffer.from(String(a ?? ''), 'utf8')
  const bufB = Buffer.from(String(b ?? ''), 'utf8')
  // crypto.timingSafeEqual throws on length mismatch; hash both to a fixed width first
  // so even the length comparison is constant-time.
  const hA = crypto.createHash('sha256').update(bufA).digest()
  const hB = crypto.createHash('sha256').update(bufB).digest()
  return crypto.timingSafeEqual(hA, hB)
}

// Name of the loopback session cookie set on index.html so same-origin data fetches
// (NiiVue volume/mesh loaders, which cannot set request headers) authenticate implicitly.
export const TOKEN_COOKIE = 'brainana_token'

function cookieToken(req) {
  const raw = req.headers['cookie']
  if (typeof raw !== 'string') return null
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    if (part.slice(0, eq).trim() === TOKEN_COOKIE) return decodeURIComponent(part.slice(eq + 1).trim())
  }
  return null
}

// Pull the token from a request, in priority order: `Authorization: Bearer <t>`,
// `X-Brainana-Token`, the loopback cookie, or a `token` query param (last resort).
export function extractToken(req, url) {
  const auth = req.headers['authorization']
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) return auth.slice('Bearer '.length).trim()
  const header = req.headers['x-brainana-token']
  if (typeof header === 'string' && header) return header.trim()
  const cookie = cookieToken(req)
  if (cookie) return cookie
  if (url && url.searchParams.has('token')) return url.searchParams.get('token')
  return null
}

// Guard factory. Returns a predicate `(req, url) => boolean`. When `token` is null
// (e.g. legacy-compat loopback mode) the guard is disabled and always passes.
export function createTokenGuard(token) {
  if (!token) return () => true
  return (req, url) => {
    const presented = extractToken(req, url)
    return presented != null && timingSafeEqual(presented, token)
  }
}

// ---------------------------------------------------------------------------
// Path containment (ported from server.mjs isWithin / cleanRelative)
// ---------------------------------------------------------------------------

// True when `candidate` is `root` itself or lives inside it — rejects `..` escapes
// and absolute-path breakouts.
export function isWithin(root, candidate) {
  const rel = path.relative(root, candidate)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

// Normalise a client-supplied relative path to forward-slash segments, rejecting
// `.`/`..`/NUL. Returns '' for the root. Throws on traversal attempts.
export function cleanRelative(raw = '') {
  const value = String(raw).replace(/\\/g, '/').replace(/^\/+/, '')
  const parts = value.split('/').filter(Boolean)
  if (parts.some((part) => part === '.' || part === '..' || part.includes('\0'))) {
    throw new Error('Invalid path')
  }
  return parts.join('/')
}

// Resolve a clean relative path against an absolute root, asserting containment.
export function resolveWithin(root, raw) {
  const clean = cleanRelative(raw)
  const resolved = path.resolve(root, ...clean.split('/').filter(Boolean))
  if (!isWithin(root, resolved)) throw new Error('Path is outside the configured root')
  return { clean, resolved }
}
