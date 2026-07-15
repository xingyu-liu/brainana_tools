// Tool-agnostic DataSource contract + in-process registry.
//
// The server starts UNBOUND and holds a Map<sourceId, DataSource>. Each loaded subject
// carries its sourceId, so the browser can hold subjects from several sources at once.
//
// A DataSource implements:
//   async listMonkeys()                      -> [{ id, label, relativePath, session? }]
//   async buildManifest(subjectId)           -> manifest object (source-scoped URLs)
//   async listDirectories(rel)               -> { path, displayPath, parent, selectable, entries }
//   async listImportFiles(rel, q)            -> { path, displayPath, parent, entries }
//   async openFile(rel, rangeHeader)         -> { total, contentType, start, end, partial, stream }
//   async saveList(rel)                      -> { path, entries }
//   async mkdir(rel)                         -> { path }
//   async saveFile(rel, readable, { overwrite }) -> { exists } | { bytes }
//   fileUrl(absOrRel)                        -> source-scoped URL string | null
//   async close()                            -> release resources (ssh connection, etc.)
import crypto from 'node:crypto'

// Extension → content type. NiiVue selects mesh/overlay parsers by URL suffix, so the
// real extension must survive into the served response (see server.mjs serveFile notes).
export function contentTypeFor(name) {
  const lower = String(name).toLowerCase()
  if (lower.endsWith('.gii')) return 'application/gifti+xml'
  if (lower.endsWith('.nii')) return 'application/octet-stream'
  if (lower.endsWith('.nii.gz')) return 'application/gzip'
  if (lower.endsWith('.json')) return 'application/json'
  return 'application/octet-stream'
}

// Parse an HTTP Range header against a known total size.
// Returns { start, end } (inclusive) or null when there is no/!satisfiable range.
export function parseRange(rangeHeader, totalSize) {
  if (!rangeHeader) return null
  const m = /bytes=(\d*)-(\d*)/.exec(rangeHeader)
  if (!m) return null
  const start = m[1] ? Number(m[1]) : 0
  const end = m[2] ? Number(m[2]) : totalSize - 1
  if (Number.isNaN(start) || Number.isNaN(end) || start > end || start < 0) return null
  return { start, end: Math.min(end, totalSize - 1) }
}

// In-process registry of live data sources.
export class SourceRegistry {
  #sources = new Map()

  // Generate a short, collision-resistant id (kept out of file paths' way).
  #nextId(type) {
    return `${type}-${crypto.randomBytes(6).toString('hex')}`
  }

  add(source, { type }) {
    const id = source.id || this.#nextId(type)
    source.id = id
    this.#sources.set(id, source)
    return source
  }

  get(id) {
    return this.#sources.get(id) ?? null
  }

  has(id) {
    return this.#sources.has(id)
  }

  list() {
    return [...this.#sources.values()].map((s) => ({ id: s.id, type: s.type, label: s.label }))
  }

  async remove(id) {
    const source = this.#sources.get(id)
    if (!source) return false
    this.#sources.delete(id)
    try {
      await source.close?.()
    } catch {
      // Teardown is best-effort; never throw out of removal.
    }
    return true
  }

  async closeAll() {
    const ids = [...this.#sources.keys()]
    for (const id of ids) await this.remove(id)
  }
}
